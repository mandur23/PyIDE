// Remote interpreters for the main-process features. An interp from the renderer is remote when it has `target`
// (see target.js); consumers route through here instead of spawning interp.cmd:
//   startPython(ctx, interp, pyArgs, {cwd, env, forwards, onExit}) -> process id (output as proc:data, like startProcess)
//   execPython(interp, pyArgs, {cwd, env, input, timeout}) -> {code, stdout, stderr}
//   debugEndpoint(interp) -> {listen, port, forwards, pathMappings, ready(isAlive), release()}
//   terminal(target, cwd) -> {file, args, env, name, release?}
//   pyrightPython(executable) -> a local stand-in python for Pyright that answers from the synced libraries
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const T = require('./target');
const { M, setMessages } = require('./messages');
const { session, onSessionInit, runRaw, tool, unpackStream, walkLocal, stopContainers, DEBUG_PORTS } = require('./session');

const isRemote = (interp) => !!interp?.target;
const cacheDir = (...p) => path.join(require('electron').app.getPath('userData'), 'remote-interp', ...p);

let notify = () => {};
const setNotifier = (fn) => { notify = fn; };
// The renderer maps paths a target printed (tracebacks) back to this machine with the session's PathMap.
onSessionInit((s) => notify('remote-interp:map', { id: s.t.id, root: s.root, map: s.map.serialize() }));

// Stream markers written by the scripts below (and the test helpers) on stderr, removed before output is shown.
const MARK = '\x1e';
function markerFilter(handlers) {
  let carry = '';
  return (text, stream) => {
    if (stream !== 'err') return text;
    text = carry + text;
    carry = '';
    let out = '';
    let i = 0;
    while (i < text.length) {
      const s = text.indexOf(MARK, i);
      if (s < 0) { out += text.slice(i); break; }
      out += text.slice(i, s);
      const e = text.indexOf('\n', s);
      if (e < 0) { carry = text.slice(s); break; }
      const line = text.slice(s + 1, e).replace(/\r$/, '');
      const m = /^PYIDE-(\w+) (.*)$/.exec(line);
      if (m && handlers[m[1]]) handlers[m[1]](m[2]);
      else if (!m) out += text.slice(s, e + 1);
      i = e + 1;
    }
    return out;
  };
}

// A process that only reports why a remote one could not start, so consumers show it in their console.
const failed = (ctx, message) => ctx.startProcess(process.execPath,
  ['-e', `process.stderr.write(${JSON.stringify(`${message}\n`)}); process.exit(1)`], { env: { ELECTRON_RUN_AS_NODE: '1' } });

function programScript(s, pyArgs, { cwd, env, pid = true, fd3 = false }) {
  const map = s.map;
  const remoteEnv = T.mapEnv(map, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYDEVD_USE_CYTHON: 'NO', ...env });
  const dir = (cwd && map.toRemote(cwd)) || s.defaultCwd;
  const argv = [s.t.python, ...pyArgs.map((a) => T.mapArg(map, a))];
  const envWords = Object.entries(remoteEnv).map(([k, v]) => T.q(`${k}=${v}`)).join(' ');
  return [
    `cd ${T.q(dir)}`,
    ...(pid ? [`printf '\\036PYIDE-PID %s\\n' "$$" >&2`] : []),
    `exec ${fd3 ? '3>&2 ' : ''}env ${envWords} ${argv.map(T.q).join(' ')}`,
  ].join(' && ');
}

async function startPython(ctx, interp, pyArgs, opts = {}) {
  let s;
  try {
    s = await session(interp.target).ready({ sync: true });
  } catch (err) {
    opts.onExit?.();
    return failed(ctx, err.message);
  }
  // Test runs report through fd 3 (a copy of stderr that pytest's capture leaves alone) with marked lines, which
  // are written to the local report file the tests feature polls, with paths mapped back to this machine. The
  // reporters write to the descriptor itself: WSL refuses to reopen it as /dev/fd/3.
  const report = opts.env?.PYIDE_TEST_REPORT;
  const env = { ...opts.env };
  if (report) Object.assign(env, { PYIDE_TEST_REPORT: 'fd:3', PYIDE_TEST_REPORT_MARK: '1' });
  let c;
  try {
    c = s.client(programScript(s, pyArgs, { cwd: opts.cwd, env, fd3: !!report }), { forwards: opts.forwards });
  } catch (err) {
    opts.onExit?.();
    return failed(ctx, err.message);
  }
  let pid = null;
  const filter = markerFilter({
    PID: (p) => { pid = Number(p) || null; },
    TEST: (json) => {
      try {
        const ev = JSON.parse(json);
        for (const t of ev.tests || []) if (t.file) t.file = s.map.toLocal(t.file) || t.file;
        fs.appendFileSync(report, `${JSON.stringify(ev)}\n`);
      } catch {}
    },
  });
  const id = ctx.startProcess(c.cmd, c.args, { cwd: os.homedir(), env: c.env, filter });
  const child = ctx.procs.get(id);
  if (!child) { c.release?.(); opts.onExit?.(); return id; }
  // ctx.killProcess ends the local client; this ends the program in the target too.
  child.remoteKill = () => {
    if (pid) s.run(`kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL ${pid} 2>/dev/null; true`, { timeout: 30000 }).catch(() => {});
  };
  child.on('close', () => {
    c.release?.();
    opts.onExit?.();
    if (pyArgs.includes('pip') && pyArgs.some((a) => a === 'install' || a === 'uninstall')) notify('remote-interp:packagesChanged', interp.target.id);
  });
  return id;
}

async function execPython(interp, pyArgs, opts = {}) {
  try {
    const s = await session(interp.target).ready({ sync: !!opts.sync });
    return await s.run(programScript(s, pyArgs, { cwd: opts.cwd, env: opts.env, pid: false }), opts);
  } catch (err) {
    return { code: -1, stdout: '', stderr: err.message };
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// Where debugpy listens in the target and the local port the IDE connects to. WSL forwards localhost ports to
// Windows; SSH gets an -L tunnel; Docker publishes a few container ports when the dev container is created.
// ready() waits until debugpy listens in the target (a tunnel or docker-proxy accepts connections before that).
async function debugEndpoint(interp) {
  const s = await session(interp.target).ready({ sync: true });
  const t = s.t;
  const base = { forwards: [], pathMappings: s.map.debugMappings(t.root), release: () => {} };
  const waitFor = (addr) => async (isAlive) => {
    const end = Date.now() + 30000;
    while (Date.now() < end && isAlive()) {
      const r = await s.helper(['waitport', addr, '3'], { timeout: 20000 });
      if (r.code === 0 && r.stdout.includes('listening')) return;
    }
  };
  if (t.kind === 'wsl') {
    const port = await freePort();
    return { ...base, listen: `127.0.0.1:${port}`, port, ready: async () => {} };
  }
  if (t.kind === 'ssh') {
    const r = await s.checked(s.helper(['freeport']), M('Finding a free port in the target'));
    const remote = Number(r.stdout.trim());
    let port = await freePort();
    while (port === remote) port = await freePort();
    return { ...base, listen: `127.0.0.1:${remote}`, port, forwards: [{ local: port, remote }], ready: waitFor(`127.0.0.1:${remote}`) };
  }
  const cport = DEBUG_PORTS.find((p) => !s.busyPorts.has(p));
  if (!cport) throw new Error(M('All debug ports of the container are in use'));
  s.busyPorts.add(cport);
  try {
    const port = await s.publishedPort(cport);
    return { ...base, listen: `0.0.0.0:${cport}`, port, ready: waitFor(`127.0.0.1:${cport}`), release: () => s.busyPorts.delete(cport) };
  } catch (err) {
    s.busyPorts.delete(cport);
    throw err;
  }
}

// A login shell in the target, in the project folder (or cwd when the target can see it).
async function terminal(target, cwd) {
  const s = await session(target).ready({ sync: true });
  const dir = (cwd && s.map.toRemote(cwd)) || s.defaultCwd;
  const name = T.describe(target);
  if (target.kind === 'wsl') return { file: tool('wsl'), args: ['-d', target.distro, '--cd', dir], env: {}, name };
  if (target.kind === 'ssh') {
    const ssh = s.sshArgs({ tty: true });
    return { file: tool('ssh'), args: [...ssh.args, `exec sh -c ${T.q(`cd ${T.q(dir)} 2>/dev/null; exec "\${SHELL:-sh}" -l`)}`], env: ssh.env, name, release: ssh.release };
  }
  if (s.hasBash === undefined) s.hasBash = (await s.run('command -v bash')).code === 0;
  return { file: tool('docker'), args: ['exec', '-it', '-w', dir, s.container, s.hasBash ? 'bash' : 'sh', '-l'], env: {}, name };
}

// ---------- Pyright ----------
// Pyright runs on this machine, so it gets a copy of the target's library folders (.py, .pyi and py.typed only)
// and a stand-in python.cmd that reports those copies as sys.path and the target's version. The standard library
// comes from Pyright's bundled typeshed stubs for that version.
const libsDir = (id) => cacheDir('libs', id);

function writeShim(id, { paths = [], version = null } = {}) {
  const dir = libsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'paths.json'), JSON.stringify({ path: paths, prefix: dir }));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(version || []));
  // Pyright runs `<python> -c <sys.path script>` and `<python> -I -c <version script>`; a .cmd runs with a shell.
  const shim = path.join(dir, 'python.cmd');
  fs.writeFileSync(shim, '@echo off\r\nif "%~1"=="-I" (type "%~dp0version.json") else (type "%~dp0paths.json")\r\n');
  return shim;
}

function pyrightPython(executable) {
  const id = T.idFromExecutable(executable);
  if (!id) return executable;
  const shim = path.join(libsDir(id), 'python.cmd');
  return fs.existsSync(shim) ? shim : writeShim(id);
}

async function syncLibs(interp) {
  const id = interp.target.id;
  const s = await session(interp.target).ready({ sync: false });
  const info = JSON.parse((await s.checked(s.helper(['libs']), M('Reading the interpreter paths'))).stdout);
  const local = [];
  let files = 0;
  for (const [i, remoteDir] of info.paths.entries()) {
    const dest = path.join(libsDir(id), 'paths', `${i}-${path.posix.basename(remoteDir)}`);
    const m = await s.checked(s.helper(['manifest', remoteDir, '.py', '.pyi']), M('Listing library files'));
    const remote = JSON.parse(m.stdout || '{}');
    const have = walkLocal(dest, () => true, 500000);
    const wanted = Object.keys(remote).filter((rel) => { const h = have.get(rel); return !h || h.size !== remote[rel][0] || h.mtime !== remote[rel][1]; });
    for (const [rel, h] of have) if (!remote[rel]) fs.rmSync(h.abs, { force: true });
    for (let k = 0; k < wanted.length; k += 2000) {
      const r = await s.checked(s.helper(['pack', remoteDir], { input: JSON.stringify(wanted.slice(k, k + 2000)), binary: true, timeout: 600000 }), M('Downloading library files'));
      files += unpackStream(r.stdout, dest);
    }
    fs.mkdirSync(dest, { recursive: true });
    local.push(dest);
  }
  writeShim(id, { paths: local, version: info.version });
  return { ok: true, paths: info.paths, local, files, version: info.version.slice(0, 3).join('.') };
}

// ---------- detection and probing ----------
async function detect() {
  const out = {};
  const wsl = T.findTool('wsl.exe');
  if (!wsl) out.wsl = { available: false, reason: M('WSL is not installed (wsl.exe was not found).') };
  else {
    const r = await runRaw(wsl, ['-l', '-v'], { binary: true, timeout: 30000 });
    const distros = T.parseWslList(r.stdout);
    out.wsl = distros.length ? { available: true, distros } : { available: false, reason: M('No WSL distributions are installed.') };
  }
  const docker = T.findTool('docker');
  if (!docker) out.docker = { available: false, reason: M('Docker is not installed (docker was not found on PATH).') };
  else {
    const r = await runRaw(docker, ['version', '--format', '{{json .}}'], { timeout: 30000 });
    let v = null;
    try { v = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
    if (r.code !== 0 || !v?.Server) out.docker = { available: false, reason: M('The Docker daemon is not running.'), detail: r.stderr.split('\n')[0] || '' };
    else {
      const im = await runRaw(docker, ['images', '--format', '{{json .}}'], { timeout: 30000 });
      const images = im.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((x) => x && x.Repository !== '<none>').map((x) => `${x.Repository}:${x.Tag}`);
      const compose = await runRaw(docker, ['compose', 'version', '--short'], { timeout: 30000 });
      out.docker = { available: true, version: v.Server.Version, images, compose: compose.code === 0 };
    }
  }
  const ssh = T.findTool('ssh');
  out.ssh = ssh ? { available: true, hosts: T.sshConfigHosts() }
    : { available: false, reason: M('The OpenSSH client is not installed (ssh was not found on PATH).') };
  return out;
}

// Checks a target before it is saved: connects, finds Python (the given path, else python3 or python) and its
// version. secrets: an unsaved password/passphrase from the form. Docker runs a throwaway container.
async function probe(target, secrets) {
  const t = { ...target, root: null };
  const find = t.python ? `command -v ${T.q(t.python)}` : 'command -v python3 || command -v python';
  const version = (py) => `exec ${T.q(py)} -c 'import platform, sys; print(platform.python_version()); print(sys.executable)'`;
  try {
    let run;
    if (t.kind === 'docker' || t.kind === 'compose') {
      const docker = tool('docker');
      const base = t.kind === 'docker' ? ['run', '--rm', '--entrypoint', 'sh', t.image]
        : ['compose', '-f', t.composeFile, 'run', '--rm', '--no-deps', '--entrypoint', 'sh', t.service];
      run = (script) => runRaw(docker, [...base, '-c', script], { timeout: 600000 });
    } else {
      const s = session({ ...t, id: t.id || 'probe' });
      run = (script) => s.run(script, { secrets, timeout: 90000 });
    }
    const where = await run(find);
    const py = where.stdout.trim().split('\n').pop();
    // command -v exits 1 (or 127 in some shells) when nothing is found; anything else means the target failed.
    if (where.code !== 0 && where.code !== 1 && where.code !== 127) return { ok: false, error: where.stderr || `exit code ${where.code}` };
    if (where.code !== 0 || !py) return { ok: false, error: M('No Python interpreter was found in the target.') };
    const v = await run(version(py));
    const [ver, exe] = v.stdout.trim().split('\n');
    if (v.code !== 0 || !ver) return { ok: false, error: v.stderr || M('Python did not start.') };
    return { ok: true, python: py.startsWith('/') ? py : exe.trim(), version: ver.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  setMessages, isRemote, startPython, execPython, debugEndpoint, terminal, pyrightPython, syncLibs, detect, probe,
  setNotifier, stopContainers, session, isRemoteExecutable: T.isRemoteExecutable, executableUri: T.executableUri,
  describe: T.describe, libsDir,
};
