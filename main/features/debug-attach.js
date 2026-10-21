// Run › Attach to Process: lists the local Python processes and injects the bundled debugpy into one with
// `python -m debugpy --listen 127.0.0.1:<port> --pid <pid>`. main/features/debug.js then talks DAP to it like to a
// launched program (debug:attach). Messages thrown here are English; renderer/features/debugger/index.js translates them.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('../diagnostics').logger('#debugger');

const LIST_TIMEOUT_MS = 10000;
const VERSION_TIMEOUT_MS = 5000;
const INJECT_TIMEOUT_MS = 30000;
const MIN_PYTHON = [3, 10]; // the bundled debugpy's Requires-Python

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!err?.killed && err.signal === 'SIGTERM' });
  });
});

// [{pid, ppid, name, exe, cmd, created}] for every python*.exe; exe and cmd are null for a process this user may not
// read (another user's, or an elevated one while PyIDE is not).
async function rawPythonProcesses() {
  if (process.platform === 'win32') {
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ConvertTo-Json -Compress -Depth 2 -InputObject @(" +
      "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | ForEach-Object { [pscustomobject]@{" +
      'pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name; exe=$_.ExecutablePath; cmd=$_.CommandLine; ' +
      "created=if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null } } })";
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: LIST_TIMEOUT_MS });
    if (r.timedOut) throw new Error(`Listing processes timed out after ${LIST_TIMEOUT_MS / 1000} seconds`);
    if (r.err) throw new Error(`Could not list processes: ${(r.stderr || r.err.message).trim()}`);
    const text = r.stdout.trim();
    return text ? JSON.parse(text) : [];
  }
  const r = await run('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { timeout: LIST_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } });
  if (r.timedOut) throw new Error(`Listing processes timed out after ${LIST_TIMEOUT_MS / 1000} seconds`);
  if (r.err) throw new Error(`Could not list processes: ${(r.stderr || r.err.message).trim()}`);
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const exe0 = m[4].split(/\s+/)[0];
    if (!/^python[\d.]*$/i.test(path.basename(exe0))) continue;
    let exe = null;
    try { exe = fs.readlinkSync(`/proc/${m[1]}/exe`); } catch { exe = exe0; }
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${m[1]}/cwd`); } catch {}
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(exe0), exe, cmd: m[4], cwd, created: new Date(m[3]).toISOString() });
  }
  return out;
}

// Splits a Windows (or POSIX) command line into its arguments (CommandLineToArgvW rules, close enough for display).
function splitArgs(cmd) {
  const args = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '"') { quoted = !quoted; any = true; continue; }
    if (/\s/.test(c) && !quoted) { if (any || cur) args.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (any || cur) args.push(cur);
  return args;
}

// exe -> Promise<'3.12.1' | null>. Only a successful probe stays cached: a failed or timed-out one (a busy machine,
// an interpreter being installed) is tried again next time.
const versionCache = new Map();
function pythonVersion(exe, probe = run) {
  const k = process.platform === 'win32' ? exe.toLowerCase() : exe;
  if (versionCache.has(k)) return versionCache.get(k);
  const p = Promise.resolve(probe(exe, ['-I', '-c', "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { timeout: VERSION_TIMEOUT_MS }))
    .then((r) => (r.err ? null : /^(\d+\.\d+\.\d+)/.exec(String(r.stdout).trim())?.[1] || null), () => null)
    .then((v) => {
      if (!v && versionCache.get(k) === p) versionCache.delete(k);
      return v;
    });
  versionCache.set(k, p); // concurrent callers share one probe
  return p;
}

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;

// Injector children still running (python -m debugpy --pid and the helpers it starts), killed with their whole tree on
// Stop and when PyIDE quits so no half-done injection outlives the IDE.
const injectors = new Set();
// sync: on quit, where an asynchronous taskkill might never run.
function killTree(child, { sync = false } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T', '/F'];
    if (sync) {
      try { require('child_process').execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {}
    } else execFile('taskkill', args, { windowsHide: true }, () => {});
    return;
  }
  // The injector runs in its own process group (detached), so its helpers (gdb/lldb) go with it.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}
function killInjectors() {
  for (const child of injectors) killTree(child, { sync: true });
  injectors.clear();
}
const versionTooOld = (v) => {
  const [a, b] = v.split('.').map(Number);
  return a < MIN_PYTHON[0] || (a === MIN_PYTHON[0] && b < MIN_PYTHON[1]);
};

// The processes the Attach to Process list shows: PyIDE's own Python sidecars (anything run from the app folder, the
// bundled debugpy, adapters), debugpy adapters and venv launcher stubs are left out. A process whose debugpy is already
// listening (attached before, or a program that calls debugpy.listen()) carries that port as debugPort.
async function listProcesses({ ownDirs = [] } = {}) {
  const out = filterProcesses(await rawPythonProcesses(), { ownDirs });
  await Promise.all(out.map(async (p) => { p.version = p.exe ? await pythonVersion(p.exe) : null; }));
  return out;
}

// The folders whose Python processes are PyIDE's own: the app (its sidecars and the bundled debugpy under vendor/),
// ~/.pyide (private venvs and runtimes) and the userData folders sidecars run from. Not userData as a whole: the
// user's scratch files run from <userData>/scratches and must stay attachable.
function ownDirsFor({ appDir, unpackedDir, vendorDir, userData, home }) {
  return [appDir, unpackedDir, vendorDir, home && path.join(home, '.pyide'),
    ...(userData ? ['plugins', 'semantic', 'remote-interp'].map((d) => path.join(userData, d)) : [])].filter(Boolean);
}

// listProcesses without the version probes: raw is rawPythonProcesses()'s [{pid, ppid, name, exe, cmd, cwd?, created}].
function filterProcesses(raw, { ownDirs = [] } = {}) {
  const sep = path.sep;
  const own = ownDirs.filter(Boolean).map((d) => path.resolve(d).toLowerCase().replace(/[\\/]+$/, '') + sep);
  const lowerCmd = (p) => (p.cmd || '').toLowerCase().replace(/\//g, sep === '\\' ? '\\' : '/');
  const isAdapter = (p) => /debugpy[\\/]+adapter|-m\s+debugpy\.adapter/i.test(p.cmd || '');
  const byPid = new Map(raw.map((p) => [p.pid, p]));
  const debugPorts = new Map();
  for (const p of raw) {
    if (!isAdapter(p)) continue;
    const port = Number(/--port\s+(\d+)/.exec(p.cmd)?.[1]);
    // debugpy.listen() runs its adapter as a child of the program; a venv's program is itself the launcher's child.
    if (validPort(port) && /--for-server/.test(p.cmd)) debugPorts.set(p.ppid, port);
  }
  const args = (p) => splitArgs(p.cmd || '').slice(1).join('\u0000');
  // A venv's python.exe is a launcher that starts the base interpreter with the same arguments; list only the real one.
  const launchers = new Set();
  const venvOf = new Map();
  for (const p of raw) {
    const parent = byPid.get(p.ppid);
    if (parent && parent.cmd && p.cmd && args(parent) === args(p) && parent.exe && p.exe && parent.exe.toLowerCase() !== p.exe.toLowerCase()) {
      launchers.add(parent.pid);
      venvOf.set(p.pid, parent.exe);
    }
  }
  const out = [];
  for (const p of raw) {
    if (p.pid === process.pid || launchers.has(p.pid) || isAdapter(p)) continue;
    const c = lowerCmd(p);
    if (own.some((d) => c.includes(d))) continue;
    if (/(^|\s)-m\s+debugpy(\s|$)|pydevd/i.test(p.cmd || '')) continue;
    const interpreter = venvOf.get(p.pid) || p.exe || null;
    out.push({
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      exe: p.exe || null,
      interpreter,
      cmd: p.cmd || null,
      args: p.cmd ? splitArgs(p.cmd).slice(1) : [],
      cwd: p.cwd || null,
      created: p.created || null,
      debugPort: debugPorts.get(p.pid) || null,
    });
  }
  return out;
}

// Whether `pid` is still running: true, false, or 'denied' when it runs but this user may not open it (elevated).
function pidState(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM' ? 'denied' : false; }
}

const ACCESS_DENIED = /access is denied|accessdenied|winerror 5\b|permissionerror|operation not permitted|error 5\b|0x5\b|ptrace/i;
const NO_PROCESS = /no such process|winerror 87\b|the parameter is incorrect|process .* not found|processlookuperror|does not exist|is not running/i;

// Turns the injector's output into the error the user sees.
function injectError(pid, output, state = pidState(pid)) {
  const text = String(output || '');
  if (!state) return new Error(`Process ${pid} is not running`);
  if (state === 'denied' || ACCESS_DENIED.test(text)) return new Error(`Access denied: cannot attach to process ${pid}`);
  if (NO_PROCESS.test(text)) return new Error(`Process ${pid} is not running`);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^---|^\d{4}-\d\d-\d\d|^I\+|^D\+/.test(l));
  const last = lines.slice(-3).join(' ') || 'unknown error';
  return new Error(`Could not inject the debugger into process ${pid}: ${last}`);
}

// Runs `python -m debugpy --listen 127.0.0.1:<port> --pid <pid>` with the target's own interpreter (sys.remote_exec
// needs the same Python version) and the bundled debugpy. Resolves once the code is in the target; the target starts
// listening when its interpreter next runs Python code. onChild(child) lets the caller kill it (killTree) on Stop;
// isStopped() is checked before the injector starts, so a Stop during the version probe never injects.
async function inject({ exe, pid, port, vendorDir, onChild, isStopped = () => false }) {
  if (!validPort(port)) throw new Error(`Invalid debugger port: ${port}`);
  const version = await pythonVersion(exe);
  if (isStopped()) throw new Error('Debugging stopped');
  if (!version) throw new Error(`Cannot run the interpreter of process ${pid}: ${exe}`);
  if (versionTooOld(version)) {
    throw new Error(`Python ${version} is not supported by the bundled debugpy (Python ${MIN_PYTHON.join('.')} or later is required)`);
  }
  const env = { ...process.env, PYTHONPATH: [vendorDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONIOENCODING: 'utf-8' };
  const args = ['-X', 'frozen_modules=off', '-m', 'debugpy', '--listen', `127.0.0.1:${port}`, '--pid', String(pid)];
  log.info(`injecting debugpy into pid ${pid}: ${exe} ${args.join(' ')}`);
  const r = await new Promise((resolve) => {
    let timedOut = false;
    let timer = null;
    const child = execFile(exe, args, { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024, detached: process.platform !== 'win32' },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        injectors.delete(child);
        resolve({ err, out: `${stdout || ''}\n${stderr || ''}`, timedOut });
      });
    injectors.add(child);
    timer = setTimeout(() => { timedOut = true; killTree(child); }, INJECT_TIMEOUT_MS);
    onChild?.(child);
  });
  if (r.timedOut) throw new Error(`Injecting the debugger into process ${pid} timed out after ${INJECT_TIMEOUT_MS / 1000} seconds`);
  // debugpy logs a failed sys.remote_exec() as a warning and falls back to its DLL injector, so only the exit code counts.
  if (r.err) {
    if (isStopped()) throw new Error('Debugging stopped');
    log.warn(`debugpy --pid ${pid} failed (${r.err.code}): ${r.out.trim().slice(-2000)}`);
    throw injectError(pid, r.out);
  }
  return { version };
}

module.exports = {
  listProcesses, filterProcesses, ownDirsFor, inject, injectError, pidState, splitArgs, pythonVersion, validPort,
  killTree, killInjectors, injectorCount: () => injectors.size, MIN_PYTHON,
};

// Loaded as a main module of the debugger plugin (plugin.json "main"); the IPC lives in debug.js.
module.exports.register = () => {};
