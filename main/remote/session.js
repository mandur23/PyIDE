// Per-target sessions for remote interpreters: the local client command line (wsl.exe / ssh.exe / docker) that runs
// a POSIX shell script in the target, the target's PathMap, and what must exist there before a Python process
// starts: IDE helper scripts and debugpy (WSL reads them under /mnt, Docker bind-mounts them, SSH gets an upload),
// the project (WSL and Docker see the folder itself; SSH gets an rsync-style upload), and Docker's dev container.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const T = require('./target');
const askpass = require('./askpass');
const { M } = require('./messages');

const APP_DIR = path.resolve(__dirname, '..', '..');
const UNPACKED = APP_DIR.replace(/\.asar$/, '.asar.unpacked');
const FEATURES = path.join(UNPACKED, 'renderer', 'features');
const VENDOR = path.join(UNPACKED, 'vendor');
const HELPER = fs.readFileSync(path.join(__dirname, 'pyide_remote.py'), 'utf8');
const DOCKER_HELPERS = '/opt/pyide';
const DOCKER_MOUNT = '/opt/project';
const DEBUG_PORTS = [5678, 5679, 5680];
// Keeps a dev container alive without a long-running program of its own; SIGTERM (docker stop) ends it at once.
const KEEPALIVE = 'trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done';
const SKIP = new Set(['.git', '__pycache__', 'node_modules', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.venv', 'venv', 'env']);
const BINARY = /\.(exe|dll|pyd|pdb|so|dylib)$/i;

const sha = (s, n = 12) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

function tool(kind) {
  const name = kind === 'wsl' ? 'wsl.exe' : kind === 'ssh' ? 'ssh' : 'docker';
  const found = T.findTool(name);
  if (!found) {
    throw new Error(M(kind === 'wsl' ? 'WSL is not installed (wsl.exe was not found).'
      : kind === 'ssh' ? 'The OpenSSH client is not installed (ssh was not found on PATH).'
        : 'Docker is not installed (docker was not found on PATH).'));
  }
  return found;
}

// Runs a local program and collects its output. input: Buffer|string written to stdin.
function runRaw(cmd, args, { env = {}, input, timeout = 120000, binary = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    } catch (err) {
      return resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: err.message });
    }
    const out = [];
    const err = [];
    let done = false;
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {});
    const finish = (code, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      resolve({ code, stdout: binary ? stdout : stdout.toString('utf8'), stderr: (message || Buffer.concat(err).toString('utf8')).trim() });
    };
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code ?? -1));
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Files under dir as rel (with '/') -> {size, mtime (whole seconds), abs}, skipping caches and virtualenvs.
function walkLocal(dir, accept = () => true, limit = 20000) {
  const out = new Map();
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !fs.existsSync(path.join(p, 'pyvenv.cfg'))) walk(p);
      } else if (e.isFile() && accept(e.name, p)) {
        const st = fs.statSync(p);
        out.set(path.relative(dir, p).split(path.sep).join('/'), { size: st.size, mtime: Math.floor(st.mtimeMs / 1000), abs: p });
      }
    }
  };
  walk(dir);
  return out;
}

// The transfer stream of pyide_remote.py: header line + bytes per file, {"d": rel} for deletions, gzip-compressed.
function packStream(files, deleted = []) {
  const parts = [];
  for (const [rel, f] of files) {
    const data = fs.readFileSync(f.abs);
    parts.push(Buffer.from(`${JSON.stringify({ p: rel, n: data.length, m: f.mtime })}\n`), data);
  }
  for (const rel of deleted) parts.push(Buffer.from(`${JSON.stringify({ d: rel })}\n`));
  return zlib.gzipSync(Buffer.concat(parts));
}
function unpackStream(buf, dest) {
  const data = zlib.gunzipSync(buf);
  let i = 0;
  let n = 0;
  while (i < data.length) {
    const nl = data.indexOf(0x0a, i);
    if (nl < 0) break;
    const h = JSON.parse(data.subarray(i, nl).toString('utf8'));
    i = nl + 1;
    if (h.d) continue;
    if (h.p.split('/').includes('..')) throw new Error(`unsafe path ${h.p}`);
    const file = path.join(dest, ...h.p.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data.subarray(i, i + h.n));
    fs.utimesSync(file, h.m, h.m);
    i += h.n;
    n++;
  }
  return n;
}

// A version for the helper upload, so an IDE update re-uploads changed scripts into a fresh folder.
let helpersVersion = null;
function helperFiles() {
  return [
    ...[...walkLocal(FEATURES, (n) => n.endsWith('.py'))].map(([rel, f]) => [`features/${rel}`, f]),
    ...[...walkLocal(path.join(VENDOR, 'debugpy'), (n) => !BINARY.test(n), 100000)].map(([rel, f]) => [`vendor/debugpy/${rel}`, f]),
  ];
}
function getHelpersVersion() {
  if (!helpersVersion) helpersVersion = sha(helperFiles().map(([rel, f]) => `${rel}:${f.size}:${f.mtime}`).join('\n'));
  return helpersVersion;
}

const sessions = new Map(); // `${id}|${root}` -> Session
const initListeners = []; // fn(session) once a session knows its PathMap

class Session {
  constructor(t) {
    this.t = t;
    this.root = t.root ? T.normWin(t.root) : null;
    this.lock = Promise.resolve();
    this.busyPorts = new Set();
    this.container = `pyide-${sha(`${t.id}|${this.root || ''}|${UNPACKED}`)}`;
  }

  // The local command line that runs `script` with sh in the target.
  client(script, { tty = false, forwards = [], secrets } = {}) {
    const t = this.t;
    if (t.kind === 'wsl') return { cmd: tool('wsl'), args: ['-d', t.distro, '--exec', 'sh', '-c', script], env: {} };
    if (t.kind === 'ssh') {
      const ssh = this.sshArgs({ tty, forwards, secrets });
      return { cmd: tool('ssh'), args: [...ssh.args, `exec sh -c ${T.q(script)}`], env: ssh.env, release: ssh.release };
    }
    return { cmd: tool('docker'), args: ['exec', '-i', ...(tty ? ['-t'] : []), this.container, 'sh', '-c', script], env: {} };
  }

  sshArgs({ tty = false, forwards = [], secrets } = {}) {
    const t = this.t;
    const args = ['-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new'];
    if (t.port && Number(t.port) !== 22) args.push('-p', String(t.port));
    if (t.user) args.push('-l', t.user);
    if (t.keyFile) args.push('-i', t.keyFile, '-o', 'IdentitiesOnly=yes');
    for (const f of forwards) args.push('-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${f.local}:127.0.0.1:${f.remote}`);
    const ask = askpass.sshEnv(t.id, secrets);
    args.push('-o', ask ? 'NumberOfPasswordPrompts=1' : 'BatchMode=yes');
    args.push(tty ? '-tt' : '-T', t.host);
    return { args, env: ask?.env || {}, release: ask?.release };
  }

  async run(script, opts = {}) {
    const c = this.client(script, opts);
    try {
      return await runRaw(c.cmd, c.args, { ...opts, env: c.env });
    } finally {
      c.release?.();
    }
  }

  // Runs pyide_remote.py in the target's interpreter.
  helper(args, opts = {}) {
    return this.run(`exec ${T.q(this.t.python)} -c ${T.q(HELPER)} ${args.map(T.q).join(' ')}`, opts);
  }

  async checked(promise, what) {
    const r = await promise;
    if (r.code !== 0) {
      const detail = r.stderr ? r.stderr.split('\n').slice(-3).join(' ') : '';
      throw new Error(M(detail ? '{what} failed (exit code {code}): {detail}' : '{what} failed (exit code {code})', { what, code: r.code, detail }));
    }
    return r;
  }

  async init() {
    const t = this.t;
    if (t.kind === 'wsl') {
      // The project stays on /mnt/<drive>; the helpers and debugpy are copied into the distribution, because
      // importing a few thousand files over WSL's /mnt file sharing takes many seconds per process.
      const r = await this.checked(this.run(`printf '%s\\n' "$HOME"; wslpath -u 'C:\\' 2>/dev/null || echo /mnt/c/`), M('Connecting to {target}', { target: T.describe(t) }));
      const [home, mnt = '/mnt/c/'] = r.stdout.trim().split('\n').map((s) => s.trim());
      const am = mnt.replace(/c\/?$/i, '') || '/mnt/';
      this.helpersDir = `${home}/.cache/pyide/helpers/${getHelpersVersion()}`;
      this.map = new T.PathMap([
        { local: FEATURES, remote: `${this.helpersDir}/features` },
        { local: VENDOR, remote: `${this.helpersDir}/vendor` },
      ], { automount: am.endsWith('/') ? am : `${am}/`, distro: t.distro });
    } else if (t.kind === 'ssh') {
      const r = await this.checked(this.run(`printf '%s\\n' "$HOME"`), M('Connecting to {target}', { target: T.describe(t) }));
      const home = r.stdout.trim().split('\n').pop() || '/tmp';
      const dirOf = (p) => (p.startsWith('~/') ? `${home}/${p.slice(2)}` : p === '~' ? home : p);
      this.remoteRoot = this.root ? dirOf(t.remoteDir || `~/pyide-projects/${path.basename(this.root)}-${sha(this.root.toLowerCase(), 6)}`) : null;
      this.helpersDir = `${home}/.cache/pyide/helpers/${getHelpersVersion()}`;
      this.map = new T.PathMap([
        ...(this.root ? [{ local: this.root, remote: this.remoteRoot }] : []),
        { local: FEATURES, remote: `${this.helpersDir}/features` },
        { local: VENDOR, remote: `${this.helpersDir}/vendor` },
      ]);
      this.home = home;
    } else {
      this.map = new T.PathMap([
        ...(this.root ? [{ local: this.root, remote: t.mountPath || DOCKER_MOUNT }] : []),
        { local: FEATURES, remote: `${DOCKER_HELPERS}/features` },
        { local: VENDOR, remote: `${DOCKER_HELPERS}/vendor` },
      ]);
    }
    this.defaultCwd = (this.root && this.map.toRemote(this.root)) || this.home || '/';
    for (const fn of initListeners) fn(this);
  }

  // Serializes preparation per session so two runs started together do not upload the same files twice.
  ready({ sync = true } = {}) {
    const next = this.lock.then(async () => {
      if (!this.map) await this.init();
      if (this.t.kind === 'docker' || this.t.kind === 'compose') await this.ensureContainer();
      if (this.helpersDir && !this.helpersUploaded) {
        await this.push(new Map(helperFiles()), this.helpersDir, { remove: true, what: M('Uploading IDE helpers') });
        this.helpersUploaded = true;
      }
      if (this.t.kind === 'ssh' && sync && this.root) await this.syncProject();
      return this;
    });
    this.lock = next.catch(() => {});
    return next;
  }

  // rsync-style upload: compares sizes and mtimes with the target's files and sends only what changed. Remote files
  // that are not here are kept for the project (the program may have written them) and removed for helpers.
  async push(files, remoteDir, { remove = false, what }) {
    const m = await this.checked(this.helper(['manifest', remoteDir]), what);
    let remote = {};
    try { remote = JSON.parse(m.stdout || '{}'); } catch {}
    const changed = [...files].filter(([rel, f]) => !remote[rel] || remote[rel][0] !== f.size || remote[rel][1] !== f.mtime);
    const deleted = remove ? Object.keys(remote).filter((rel) => !files.has(rel)) : [];
    if (!changed.length && !deleted.length) return 0;
    await this.checked(this.helper(['unpack', remoteDir], { input: packStream(changed, deleted), timeout: 600000 }), what);
    return changed.length;
  }

  async syncProject() {
    const files = walkLocal(this.root, (_n, p) => fs.statSync(p).size <= 50 * 1024 * 1024);
    this.lastUpload = await this.push(files, this.remoteRoot, { what: M('Uploading the project') });
  }

  // A long-lived container per (interpreter, project) with the project and the IDE helpers bind-mounted and a few
  // debug ports published; every process is a `docker exec` into it, so pip installs last until it is recreated.
  async ensureContainer() {
    const docker = tool('docker');
    const t = this.t;
    const st = await runRaw(docker, ['inspect', '-f', '{{.State.Running}}', this.container], { timeout: 30000 });
    if (st.code === 0 && st.stdout.trim() === 'true') return;
    if (st.code === 0) {
      if ((await runRaw(docker, ['start', this.container], { timeout: 60000 })).code === 0) return;
      await runRaw(docker, ['rm', '-f', this.container]);
    }
    const opts = [
      '-d', '--name', this.container, '--label', `dev.pyide.target=${t.id}`,
      ...(this.root ? ['-v', `${this.root}:${t.mountPath || DOCKER_MOUNT}`] : []),
      '-v', `${FEATURES}:${DOCKER_HELPERS}/features:ro`,
      '-v', `${VENDOR}:${DOCKER_HELPERS}/vendor:ro`,
      ...DEBUG_PORTS.flatMap((p) => ['--publish', `127.0.0.1::${p}`]),
      '-w', this.defaultCwd, '--entrypoint', 'sh',
    ];
    const args = t.kind === 'docker'
      ? ['run', '--init', ...opts, t.image, '-c', KEEPALIVE]
      : ['compose', '-f', t.composeFile, 'run', ...opts, t.service, '-c', KEEPALIVE];
    await this.checked(runRaw(docker, args, { timeout: 600000 }), M('Starting a container for {target}', { target: T.describe(t) }));
    started.add(this.container);
  }

  // The host port docker published for a container port.
  async publishedPort(port) {
    const r = await this.checked(runRaw(tool('docker'), ['port', this.container, `${port}/tcp`]), 'docker port');
    const m = /(?:^|\n)(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/.exec(r.stdout) || /:(\d+)\s*$/m.exec(r.stdout);
    if (!m) throw new Error(M('Port {port} of {container} is not published', { port, container: this.container }));
    return Number(m[1]);
  }
}

const started = new Set(); // dev containers this IDE started or reused

function session(t) {
  const key = `${t.id}|${t.root ? T.normWin(t.root).toLowerCase() : ''}`;
  let s = sessions.get(key);
  if (!s || JSON.stringify(s.t) !== JSON.stringify(t)) sessions.set(key, (s = new Session(t)));
  return s;
}

// Containers keep their state (installed packages) but stop when the IDE quits.
function stopContainers() {
  if (!started.size) return;
  try {
    spawn(tool('docker'), ['stop', '-t', '2', ...started], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
  started.clear();
}

const onSessionInit = (fn) => initListeners.push(fn);

module.exports = { session, onSessionInit, runRaw, tool, unpackStream, walkLocal, stopContainers, FEATURES, VENDOR, DEBUG_PORTS };
