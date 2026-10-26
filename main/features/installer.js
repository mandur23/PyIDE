// Install Manager: runs install/remove/start/stop jobs for the renderer's installables. Jobs that touch the same
// target (one interpreter's pip, winget, one server) share a lane and run one at a time; different lanes run in
// parallel. Output streams as installer:log {jobId, text} and installer:progress {jobId, fraction}.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeStorage } = require('electron');
const iconv = require('iconv-lite');
const { createServers } = require('../installer/servers');
const { createPythons } = require('../installer/python');

const PIP = ['-m', 'pip', '--disable-pip-version-check', '--no-color'];
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?$/;
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
// winget's "no newer version / already installed" result.
const WINGET_ALREADY_INSTALLED = [-1978335189, 0x8a15002b];

// System tools the renderer installs with winget, keyed like its catalog. probe runs from PATH; known paths catch installs made after the IDE started.
const SYSTEM = {
  git: { probe: ['git', ['--version']], parse: /git version (\d+(?:\.\d+)+)/,
    known: () => [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe')] },
  python313: { probe: ['py', ['-3.13', '--version']], parse: /Python (3\.13(?:\.\d+)*)/,
    known: () => [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python313', 'python.exe')] },
  node: { probe: ['node', ['--version']], parse: /v(\d+(?:\.\d+)+)/,
    known: () => [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')] },
  gh: { probe: ['gh', ['--version']], parse: /gh version (\d+(?:\.\d+)+)/,
    known: () => [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')] },
};

class Cancelled extends Error {
  constructor() { super('Cancelled'); this.cancelled = true; }
}

// Python is told to write UTF-8, but native Windows tools (initdb, pg_ctl, MariaDB, tar) write the system ANSI code page,
// CP949 on Korean Windows. Text in such a code page is almost never valid UTF-8, so a stream starts as UTF-8 and
// switches to the ANSI code page for good at its first invalid sequence.
let ansiEncoding;
function systemAnsiEncoding() {
  if (ansiEncoding) return ansiEncoding;
  ansiEncoding = 'utf8';
  try {
    const acp = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { encoding: 'utf8', windowsHide: true })
      .match(/ACP\s+REG_SZ\s+(\d+)/)?.[1];
    if (acp && iconv.encodingExists(`cp${acp}`)) ansiEncoding = `cp${acp}`;
  } catch {}
  return ansiEncoding;
}
function outputDecoder() {
  let utf8 = new TextDecoder('utf-8', { fatal: true });
  let ansi = null;
  return {
    write(buf) {
      if (ansi) return ansi.write(buf);
      try { return utf8.decode(buf, { stream: true }); } catch {
        utf8 = null;
        ansi = iconv.getDecoder(systemAnsiEncoding());
        return ansi.write(buf);
      }
    },
  };
}

// Runs a process to completion: {code, out (stdout and stderr), stdout}. A spawn failure (e.g. not on PATH) is code -1, not an exception.
function runProcess(cmd, args, { signal, onData, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...env } });
    } catch (err) {
      resolve({ code: -1, out: err.message });
      return;
    }
    let out = '';
    let stdout = '';
    const take = (decoder) => (d) => { const t = decoder.write(d); out += t; if (t) onData?.(t); return t; };
    const fromOut = take(outputDecoder());
    child.stdout.on('data', (d) => { stdout += fromOut(d); });
    child.stderr.on('data', take(outputDecoder()));
    const kill = () => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => { out += err.message; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      resolve({ code: code ?? -1, out, stdout });
    });
  });
}

// Tests replace system commands (winget and the tool probes) with a fake module: {run(cmd, args, opts), exists?(p)}.
function systemRunner() {
  const injected = process.env.PYIDE_INSTALLER_RUNNER;
  if (!injected) return { run: runProcess, exists: fs.existsSync };
  const fake = require(injected);
  return { run: fake.run, exists: fake.exists || fs.existsSync };
}

function credentialStore(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const seal = (text) => (safeStorage.isEncryptionAvailable()
    ? { enc: safeStorage.encryptString(text).toString('base64') } : { plain: text });
  const open = (v) => (v?.enc ? safeStorage.decryptString(Buffer.from(v.enc, 'base64')) : v?.plain ?? '');
  return {
    get(name) {
      const v = read()[name];
      return v ? { ...v, password: open(v.password) } : null;
    },
    set(name, value) {
      const all = read();
      if (value) all[name] = { ...value, password: seal(value.password) }; else delete all[name];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

exports.register = ({ ipcMain, app, send }) => {
  const root = process.env.PYIDE_INSTALL_ROOT || path.join(os.homedir(), '.pyide');
  const system = systemRunner();
  const store = credentialStore(path.join(app.getPath('userData'), 'installer', 'servers.json'));

  function spawnServer(cmd, args, { cwd, logFile }) {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', out, out] });
    // A program that cannot start (missing, blocked) emits 'error' and 'close' but no 'exit'; its exitCode is then the
    // negative error code, which the callers' start loops report.
    child.on('error', (err) => fs.appendFile(logFile, `${err.message}\n`, () => {}));
    child.once('close', () => fs.closeSync(out));
    return child;
  }
  const servers = createServers({ root, store, spawnServer, run: runProcess });
  const pythons = createPythons({ root, run: runProcess });

  // ---------- jobs ----------
  const exec = (job) => async (cmd, args, opts = {}) => {
    job.log(`> ${path.basename(cmd)} ${args.map((a) => (/password=/i.test(a) ? a.replace(/=.*/, '=***') : a)).join(' ')}\n`);
    const r = await runProcess(cmd, args, { ...opts, signal: job.signal, onData: job.log });
    if (job.signal.aborted) throw new Cancelled();
    if (r.code !== 0) throw new Error(`${path.basename(cmd)} exited with code ${r.code}`);
    return r;
  };

  const pipArgs = { install: (p) => ['install', p], upgrade: (p) => ['install', '--upgrade', p], uninstall: (p) => ['uninstall', '-y', p] };

  // kind -> {parse(spec) validates renderer input, lane(spec), run(spec, job)}
  const KINDS = {
    pip: {
      parse: (s) => typeof s.python === 'string' && fs.existsSync(s.python) && pipArgs[s.op] && PACKAGE.test(s.package || ''),
      lane: (s) => `pip:${s.python.toLowerCase()}`,
      run: (s, job) => exec(job)(s.python, [...PIP, ...pipArgs[s.op](s.package)]),
    },
    winget: {
      parse: (s) => WINGET_ID.test(s.id || ''),
      lane: () => 'winget',
      async run(s, job) {
        const args = ['install', '--id', s.id, '-e', '--accept-source-agreements', '--accept-package-agreements'];
        job.log(`> winget ${args.join(' ')}\n`);
        const r = await system.run('winget', args, { signal: job.signal, onData: job.log });
        if (job.signal.aborted) throw new Cancelled();
        if (r.code === 0 || WINGET_ALREADY_INSTALLED.includes(r.code)) return;
        throw new Error(`winget exited with code ${r.code}`);
      },
    },
    ...Object.fromEntries(['install', 'uninstall', 'start', 'stop'].map((op) => [`server-${op}`, {
      parse: (s) => servers.names().includes(s.name),
      lane: (s) => `server:${s.name}`,
      run: (s, job) => servers[op](s.name, { ...job, exec: exec(job) }),
    }])),
    ...Object.fromEntries(['install', 'uninstall'].map((op) => [`python-${op}`, {
      parse: (s) => pythons.names().includes(s.name),
      lane: (s) => `python:${s.name}`,
      run: (s, job) => pythons[op](s.name, { ...job, exec: exec(job) }),
    }])),
  };

  const lanes = new Map(); // lane -> promise of the last job queued on it
  const controllers = new Map(); // jobId -> AbortController

  async function runJob(jobId, spec) {
    const kind = KINDS[spec?.kind];
    if (!kind || !kind.parse(spec)) return { ok: false, error: `Invalid job: ${JSON.stringify(spec)}` };
    const ctl = new AbortController();
    controllers.set(jobId, ctl);
    const job = {
      signal: ctl.signal,
      log: (text) => send('installer:log', { jobId, text }),
      progress: (fraction) => send('installer:progress', { jobId, fraction: Math.max(0, Math.min(1, fraction)) }),
    };
    const lane = kind.lane(spec);
    const before = lanes.get(lane);
    const aborted = new Promise((resolve) => ctl.signal.addEventListener('abort', resolve, { once: true }));
    const mine = (async () => {
      if (before) {
        job.log('Waiting for another job on the same target to finish…\n');
        await Promise.race([before, aborted]);
      }
      if (ctl.signal.aborted) throw new Cancelled();
      await kind.run(spec, job);
    })();
    // The lane frees up only when this job and every earlier one are done, even if this one was cancelled while queued.
    const tail = Promise.all([before, mine.catch(() => {})]);
    lanes.set(lane, tail);
    tail.then(() => { if (lanes.get(lane) === tail) lanes.delete(lane); });
    try {
      await mine;
      return { ok: true };
    } catch (err) {
      const cancelled = ctl.signal.aborted || !!err.cancelled || err.name === 'AbortError';
      return { ok: false, cancelled, error: cancelled ? 'Cancelled' : String(err.message || err) };
    } finally {
      controllers.delete(jobId);
    }
  }

  ipcMain.handle('installer:run', (_e, jobId, spec) => runJob(String(jobId), spec || {}));
  ipcMain.handle('installer:cancel', (_e, jobId) => { controllers.get(String(jobId))?.abort(); return true; });

  // ---------- status ----------
  ipcMain.handle('installer:pipList', async (_e, python, { outdated = false } = {}) => {
    if (typeof python !== 'string' || !fs.existsSync(python)) return { ok: false, error: `No interpreter at ${python}` };
    const args = [...PIP, 'list', '--format=json', ...(outdated ? ['--outdated', '--timeout', '5', '--retries', '0'] : [])];
    const r = await runProcess(python, args);
    try {
      return { ok: true, packages: JSON.parse(r.stdout).map((p) => ({ name: p.name, version: p.version, latest: p.latest_version })) };
    } catch {
      return { ok: false, error: r.out.trim().split('\n').pop() || `pip exited with code ${r.code}` };
    }
  });

  async function probeTool(t) {
    const tryRun = async (cmd, args) => {
      const r = await system.run(cmd, args, {});
      const m = r.code === 0 && r.out.match(t.parse);
      return m ? m[1] : null;
    };
    const version = await tryRun(...t.probe);
    if (version) return { installed: true, version };
    const known = t.known().find((p) => system.exists(p));
    if (known) return { installed: true, version: (await tryRun(known, t.probe[1].filter((a) => a.startsWith('--')))) || undefined, detail: known };
    return { installed: false };
  }

  ipcMain.handle('installer:system', async (_e, keys) => {
    const winget = (await system.run('winget', ['--version'], {})).code === 0;
    const out = {};
    await Promise.all(keys.filter((k) => SYSTEM[k]).map(async (k) => {
      const found = await probeTool(SYSTEM[k]);
      out[k] = { ...found, available: found.installed || winget, reason: winget ? undefined : 'no-winget' };
    }));
    return out;
  });

  ipcMain.handle('installer:servers', async () => Promise.all(servers.names().map((n) => servers.status(n))));
  ipcMain.handle('installer:pythons', async () => Promise.all(pythons.names().map((n) => pythons.status(n))));
  ipcMain.handle('installer:serverConnection', (_e, name) => (servers.names().includes(name) ? servers.connection(name) : null));
  ipcMain.handle('installer:root', () => root);

  // Servers started here belong to this IDE session: shut them down cleanly before quitting.
  let quitting = false;
  app.on('before-quit', (e) => {
    const names = servers.ownedNames();
    if (quitting || !names.length) return;
    e.preventDefault();
    quitting = true;
    const quiet = { log: () => {}, signal: new AbortController().signal };
    const stopAll = Promise.all(names.map((n) => servers.stop(n, { ...quiet, exec: exec(quiet) }).catch(() => {})));
    Promise.race([stopAll, new Promise((r) => setTimeout(r, 15000))]).then(() => app.quit());
  });
};
