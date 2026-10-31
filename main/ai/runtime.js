// The one private Python runtime behind PyIDE's local AI features (semantic search, code completion), and the
// JSON-lines sidecar protocol they talk to their Python servers with.
// The venv is shared by every PyIDE profile (like the Hugging Face model cache) and keeps the folder name of its
// first user, semantic search, so existing installs keep working. It lives under the home folder: packaged launchers
// virtualize %LOCALAPPDATA%, which would hide it from other launches.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diagnostics = require('../diagnostics');

const dir = path.join(os.homedir(), '.pyide', 'semantic');
const venv = path.join(dir, 'venv');
const python = path.join(venv, 'Scripts', 'python.exe');
const sitePackages = path.join(venv, 'Lib', 'site-packages');
const PIP = ['-m', 'pip', 'install', '--disable-pip-version-check'];

// A file check, not an import: importing torch takes seconds and callers run on the main process.
const hasPackage = (name) => fs.existsSync(path.join(sitePackages, name));
const pythonReady = () => fs.existsSync(python);

function hfCacheDir() {
  const home = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
  return process.env.HF_HUB_CACHE || path.join(home, 'hub');
}
const hfRepoDir = (repo) => path.join(hfCacheDir(), `models--${repo.replace(/\//g, '--')}`);
// Path of `file` in any downloaded snapshot of `repo`, or null.
function hfCachedFile(repo, file) {
  const snaps = path.join(hfRepoDir(repo), 'snapshots');
  try {
    for (const s of fs.readdirSync(snaps)) {
      const p = path.join(snaps, s, file);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// A setup job: runs commands one at a time, streams their output to `log`, and can be cancelled.
function createJob(log) {
  let proc = null;
  let cancelled = false;
  const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    if (cancelled) { reject(new Error('Cancelled')); return; }
    log(`> ${[cmd, ...args].join(' ')}\n`);
    proc = spawn(cmd, args, { windowsHide: true, ...opts, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1', ...opts.env } });
    proc.stdout.on('data', (d) => log(d.toString('utf8')));
    proc.stderr.on('data', (d) => log(d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => {
      proc = null;
      if (cancelled) reject(new Error('Cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
  const cancel = () => {
    cancelled = true;
    if (proc) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  };
  return { run, cancel, log };
}

// Setups from different features share one venv, so pip runs are serialized.
let queue = Promise.resolve();
function exclusive(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const exec = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)));
});

// transformers 5 turns PyTorch off below 2.6 ("Disabling PyTorch because PyTorch >= 2.6 is required"), while
// sentence-transformers accepts 2.2, so pip alone would keep an older torch the model then cannot load with.
const TORCH = 'torch>=2.6';
const torchVersion = (cmd) => exec(cmd, ['-c', 'import torch; print(torch.__version__)'], 60000).then((out) => out.trim(), () => null);
const usable = (version) => {
  const [, major, minor] = /^(\d+)\.(\d+)/.exec(version || '') || [];
  return +major > 2 || (+major === 2 && +minor >= 6);
};
const torchUsable = async () => usable(await torchVersion(python));
// For status checks, which cannot wait for an import: true only when torch's dist-info shows a version below the
// floor. The environment's own torch wins over the one reused from the interpreter it was made from; a torch found
// nowhere (a user-site or conda install) is not held against the environment.
function torchTooOld() {
  const dirs = [sitePackages];
  try {
    const cfg = fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8');
    const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1].trim();
    if (home && /^include-system-site-packages\s*=\s*true/im.test(cfg)) dirs.push(path.join(home, 'Lib', 'site-packages'));
  } catch {}
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch {}
    const version = names.map((n) => /^torch-(\d[^-]*)\.dist-info$/i.exec(n)?.[1]).find(Boolean);
    if (version) return !usable(version);
  }
  return false;
}

// pip decides whether a torch build fits the interpreter (its version, 32/64-bit, ARM64, free-threaded) and honours
// the user's index settings. pip answers "no matching distribution" offline too, so the answer counts only when the
// same index lists pip itself; an unreachable index or a pip-less interpreter proves nothing.
// A build counts only from the torch floor up: Python 3.8's newest torch is 2.4.1, which transformers would turn off.
const listed = (cmd, pkg) => exec(cmd, ['-m', 'pip', 'index', 'versions', pkg, '--disable-pip-version-check', '--retries', '1'], 60000)
  .then((out) => /\(([^)]+)\)/.exec(out)?.[1] || '', () => null);
const torchHasBuild = async (cmd) => {
  const latest = await listed(cmd, 'torch');
  return latest !== null ? usable(latest) : await listed(cmd, 'pip') === null;
};

const DESCRIBE = 'import json,platform,struct,sysconfig;print(json.dumps([platform.python_version(),struct.calcsize("P")*8,platform.machine(),bool(sysconfig.get_config_var("Py_GIL_DISABLED"))]))';
async function describe(cmd) {
  try {
    const [version, bits, machine, freeThreaded] = JSON.parse(await exec(cmd, ['-c', DESCRIBE], 15000));
    return { cmd, label: `Python ${version}${freeThreaded ? ' free-threaded' : ''} (${/arm/i.test(machine) ? machine : `${bits}-bit`})` };
  } catch { return null; }
}

// The project interpreter first, then the others the IDE lists (PyIDE's own Python among them), every interpreter the
// Python launcher lists (newest first), and PATH's python.
async function pythons(preferred, known) {
  const launcher = await exec('py', ['-0p'], 15000).then((out) => out.split(/\r?\n/).map((l) => l.match(/[A-Za-z]:\\.*\.exe/i)?.[0]), () => []);
  const seen = new Set();
  const cmds = [preferred, ...known, ...launcher, 'python'].filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
  return (await Promise.all(cmds.map(describe))).filter(Boolean);
}

// Prefers an interpreter that already has a usable torch (its packages are reused, saving a multi-hundred-MB
// download), then one torch has a build for. `torch` callers need one of those; the others take any interpreter.
async function pickPython(preferred, known, torch) {
  const found = await pythons(preferred, known);
  if (!found.length) throw new Error('No Python interpreter found');
  for (const py of found) if (usable(await torchVersion(py.cmd))) return { ...py, torch: true };
  for (const py of found) if (await torchHasBuild(py.cmd)) return py;
  if (torch) throw new Error(`PyTorch has no build for ${[...new Set(found.map((p) => p.label))].join(', ')}`);
  return found[0];
}

// `torch: true` also makes sure torch can be installed: an environment made from an interpreter torch has no build
// for (a Python newer than torch supports, 32-bit, free-threaded) is rebuilt from one it has. `interpreters` are the
// other interpreters the IDE knows.
async function ensureVenv(job, interpreter, { torch = false, interpreters = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  // Earlier environments set aside below, once nothing holds their files any more.
  for (const name of fs.readdirSync(dir)) if (/^venv\.old-\d+$/.test(name)) fs.rm(path.join(dir, name), { recursive: true, force: true }, () => {});
  if (pythonReady() && (!torch || usable(await torchVersion(python)) || await torchHasBuild(python))) return;
  const py = await pickPython(interpreter, Array.isArray(interpreters) ? interpreters.filter((c) => typeof c === 'string') : [], torch);
  if (pythonReady()) {
    job.log(`${(await describe(python))?.label || 'This Python'} has no PyTorch build; recreating the AI environment with ${py.label}. AI code completion sets up its packages again the next time it is used.\n`);
    await Promise.all([...sidecars].map((s) => s.kill()));
    // Renamed first: a file another PyIDE process holds makes the rename fail with the environment whole, where a
    // delete would stop halfway and leave that process a broken environment.
    const old = `${venv}.old-${Date.now()}`;
    try { fs.renameSync(venv, old); } catch (err) {
      throw new Error(['EBUSY', 'EPERM', 'EACCES'].includes(err.code)
        ? 'The AI environment is in use by another Nano Studio window. Close it and try again.'
        : `The AI environment could not be replaced: ${err.message}`);
    }
    fs.rm(old, { recursive: true, force: true }, () => {});
  }
  await job.run(py.cmd, ['-m', 'venv', ...(py.torch ? ['--system-site-packages'] : []), venv]);
}

const pipInstall = (job, args) => job.run(python, [...PIP, ...args]);

// torchvision is first the build paired with the installed torch (2.X.Y pairs with 0.(X+15).Y) from PyTorch's index
// for the same variant (cpu, cu128, ...); --no-deps stops pip from replacing a reused torch. That build can be
// missing for this Python (every torchvision since 0.26 excludes Python 3.14.1), so pip then resolves torch and
// torchvision together, which puts a matching pair in this environment even if its torch differs from the reused one.
const TORCH_INDEX = process.env.PYIDE_TORCH_INDEX || 'https://download.pytorch.org/whl';
async function installTorchvision(job) {
  const [, minor, patch, variant] = (await torchVersion(python))?.match(/^2\.(\d+)\.(\d+)(?:\+(\w+))?/) || [];
  if (minor) {
    try {
      await pipInstall(job, ['--no-deps', 'pillow', `torchvision==0.${+minor + 15}.${patch}${variant ? `+${variant}` : ''}`,
        '--extra-index-url', `${TORCH_INDEX}/${variant || 'cpu'}`]);
      return;
    } catch (err) {
      if (/Cancelled/.test(err.message)) throw err;
      job.log('The torchvision build paired with this torch is not available for this Python; installing a matching torch and torchvision.\n');
    }
  }
  await pipInstall(job, [TORCH, 'torchvision']);
}

// Downloads a Hugging Face repo (or only `files` of it) into the standard cache.
function hfDownload(job, repo, files) {
  const code = files
    ? `from huggingface_hub import hf_hub_download\nfor f in ${JSON.stringify(files)}: hf_hub_download(${JSON.stringify(repo)}, f)`
    : `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(repo)})`;
  return job.run(python, ['-c', code]);
}

// Models stay loaded this long after their last request before the sidecar is stopped (see startSidecar's idleMs).
// The user setting is in minutes (`ai.idleUnloadMinutes`, which the renderer plugins pass to their main side);
// 0 keeps a model loaded, unset means the default.
const IDLE_MINUTES = 10;
const idleMsOf = (minutes) => Math.round((Number.isFinite(Number(minutes)) ? Number(minutes) : IDLE_MINUTES) * 60000);

// A long-lived Python server that reads one JSON request per line on stdin and answers with JSON lines on stdout.
// Replies carry the request's id; lines without an id are events. stderr is passed through as log text.
// `idleMs()` gives the idle timeout to apply: once no request is in flight for that long, the server's stdin is
// closed and it exits on its own (both servers end on end-of-input, so the exit is clean and not a crash). From then
// on alive() is false and the caller starts a fresh server on the next request, so a request never waits on a
// server that is shutting down.
const sidecars = new Set();
function startSidecar({ script, env, onEvent = () => {}, onLog = () => {}, onExit = () => {}, idleMs = () => 0 }) {
  const proc = spawn(python, ['-u', script], {
    cwd: dir,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', ...env },
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let alive = true;
  let stopping = false;
  let idleTimer = null;
  let exited;
  const closed = new Promise((resolve) => { exited = resolve; });
  const stop = () => {
    if (!alive || stopping) return;
    stopping = true;
    proc.stdin.end();
    // A server that ignores end-of-input (stuck in the model) is killed; proc.killed keeps that off the error list.
    setTimeout(() => { if (alive) { try { proc.kill(); } catch {} } }, 10000).unref();
  };
  const idle = () => {
    clearTimeout(idleTimer);
    idleTimer = null;
    const ms = idleMs();
    if (alive && !stopping && !pending.size && ms > 0) idleTimer = setTimeout(() => { if (!pending.size) stop(); }, ms);
  };
  proc.stdout.on('data', (d) => {
    buffer += d.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        if (!pending.size) idle();
      } else if (msg.event) onEvent(msg);
    }
  });
  proc.stderr.on('data', (d) => onLog(d.toString('utf8')));
  diagnostics.watchProcess(proc, { name: path.basename(script) });
  // A write racing the process's exit fails with EPIPE; the exit handler already answers pending requests.
  proc.stdin.on('error', () => {});
  const exit = (code) => {
    if (!alive) return;
    alive = false;
    clearTimeout(idleTimer);
    for (const resolve of pending.values()) resolve({ error: `server exited (${code})` });
    pending.clear();
    sidecars.delete(handle);
    onExit(code);
    exited(code);
  };
  proc.on('exit', exit);
  // A process that never started (python.exe missing or blocked) emits 'error' and no 'exit'.
  proc.on('error', (err) => { onLog(`${err.message}\n`); if (proc.pid === undefined) exit(-1); });
  const write = (msg) => { if (alive && !stopping) proc.stdin.write(`${JSON.stringify(msg)}\n`); };
  const handle = {
    // -> {id, reply: Promise<message>}
    send(msg) {
      const id = nextId++;
      const reply = new Promise((resolve) => {
        if (!alive || stopping) { resolve({ error: 'server is not running' }); return; }
        clearTimeout(idleTimer);
        pending.set(id, resolve);
        write({ ...msg, id });
      });
      return { id, reply };
    },
    notify: write,
    alive: () => alive && !stopping,
    // Re-reads idleMs(), for when the setting changes while the server sits idle.
    idle,
    // Resolves once the process has exited and released its files.
    kill() { try { proc.kill(); } catch {} return closed; },
  };
  sidecars.add(handle);
  return handle;
}

module.exports = {
  dir, venv, python, sitePackages, hasPackage, pythonReady, TORCH, torchUsable, torchTooOld, hfCacheDir, hfRepoDir, hfCachedFile,
  createJob, exclusive, ensureVenv, pipInstall, installTorchvision, hfDownload, startSidecar, idleMsOf,
  // For verify/ai-runtime-python.mjs.
  pythons,
};
