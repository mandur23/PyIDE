// Portable, per-user database servers: pinned vendor zips extracted under <root>/servers/<name>-<version>, a data
// directory initialized with a generated password, and a server process owned by the IDE.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const tarExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const SERVERS = {
  postgresql: {
    kind: 'postgres',
    title: 'PostgreSQL',
    version: '18.6',
    url: 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip',
    size: 384620317,
    // EDB publishes no checksum for the binaries zip; this is the sha256 of the file it served when this version was pinned.
    sha256: 'e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2',
    // pgAdmin and StackBuilder make up most of the archive and are not needed to run a server.
    exclude: ['pgsql/pgAdmin 4', 'pgsql/StackBuilder', 'pgsql/doc'],
    bin: 'pgsql/bin',
    exe: 'postgres.exe',
    defaultPort: 5432,
    user: 'postgres',
    database: 'postgres',
    initialized: (data) => fs.existsSync(path.join(data, 'PG_VERSION')),
    pidFile: (data) => path.join(data, 'postmaster.pid'),
    async init({ bin, data, password, exec }) {
      const pwfile = path.join(path.dirname(data), `pw-${crypto.randomBytes(6).toString('hex')}.txt`);
      fs.writeFileSync(pwfile, password);
      try {
        await exec(path.join(bin, 'initdb.exe'), ['-D', data, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${pwfile}`, '-E', 'UTF8', '--no-locale']);
      } finally {
        fs.rmSync(pwfile, { force: true });
      }
    },
    start: ({ bin, data, port }) => [path.join(bin, 'postgres.exe'), ['-D', data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1']],
    // The port opens before startup finishes; until then connections fail with "the database system is starting up".
    ready: async ({ bin, port, run }) => (await run(path.join(bin, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', String(port)])).code === 0,
    stop: ({ bin, data, exec }) => exec(path.join(bin, 'pg_ctl.exe'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '30']),
  },
  mariadb: {
    kind: 'mariadb',
    title: 'MariaDB',
    version: '11.8.9',
    url: 'https://archive.mariadb.org/mariadb-11.8.9/winx64-packages/mariadb-11.8.9-winx64.zip',
    size: 97016251,
    sha256: '830c46727d9278eae212ae3eca44eeb9e71b2a68704e95f344a64fba7b1963f5',
    exclude: [],
    bin: 'mariadb-11.8.9-winx64/bin',
    exe: 'mariadbd.exe',
    defaultPort: 3306,
    user: 'root',
    database: 'mysql',
    initialized: (data) => fs.existsSync(path.join(data, 'mysql')),
    pidFile: (data) => (fs.existsSync(data) ? fs.readdirSync(data).filter((f) => f.endsWith('.pid')).map((f) => path.join(data, f))[0] : null),
    init: ({ bin, data, password, port, exec }) => exec(path.join(bin, 'mariadb-install-db.exe'), [`--datadir=${data}`, `--password=${password}`, `--port=${port}`]),
    start: ({ bin, data, port }) => [path.join(bin, 'mariadbd.exe'), [`--defaults-file=${path.join(data, 'my.ini')}`, `--port=${port}`, '--bind-address=127.0.0.1', '--console']],
    stop: ({ bin, port, password, exec }) => exec(path.join(bin, 'mariadb-admin.exe'), ['-h', '127.0.0.1', '-P', String(port), '-u', 'root', `--password=${password}`, 'shutdown']),
  },
};

const portOpen = (port) => new Promise((resolve) => {
  const sock = net.connect({ host: '127.0.0.1', port });
  const done = (ok) => { sock.destroy(); resolve(ok); };
  sock.setTimeout(400, () => done(false));
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
});

const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});

async function freePort(from) {
  for (let p = from; p < from + 200; p++) if (await portFree(p)) return p;
  throw new Error(`No free port near ${from}`);
}

async function download(url, dest, { sha256, size, signal, progress, log }) {
  log(`Downloading ${url}\n`);
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || size;
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  const hash = crypto.createHash('sha256');
  let got = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      progress(got / total);
      const pct = Math.floor((got / total) * 10);
      if (pct !== shown) { shown = pct; log(`  ${Math.round(got / 1048576)} / ${Math.round(total / 1048576)} MB\n`); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }
  const digest = hash.digest('hex');
  log(`sha256 ${digest}\n`);
  if (sha256 && digest !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(dest)}: expected ${sha256}, got ${digest}`);
  }
  fs.renameSync(part, dest);
}

// root: install root (~/.pyide); store: {get(name), set(name, value)} persisted credentials; spawnServer starts the
// long-running server process; run(cmd, args) -> {code} probes quietly. Job steps get exec(cmd, args), which streams
// to the job log and throws on a non-zero exit.
function createServers({ root, store, spawnServer, run }) {
  const owned = new Map(); // name -> child process started by this IDE
  const dirOf = (name) => path.join(root, 'servers', `${name}-${SERVERS[name].version}`);
  const paths = (name) => {
    const dir = dirOf(name);
    return { dir, bin: path.join(dir, SERVERS[name].bin), data: path.join(dir, 'data'), logFile: path.join(dir, 'server.log') };
  };
  const extracted = (name) => fs.existsSync(path.join(paths(name).bin, SERVERS[name].exe));

  async function running(name) {
    const s = SERVERS[name];
    const saved = store.get(name);
    if (!saved) return false;
    const child = owned.get(name);
    if (child && child.exitCode === null) return portOpen(saved.port);
    // Started by an earlier session (e.g. after a relaunch): the server left its pid file and still answers.
    const pid = s.pidFile(paths(name).data);
    return !!pid && fs.existsSync(pid) && portOpen(saved.port);
  }

  async function status(name) {
    const s = SERVERS[name];
    const p = paths(name);
    const saved = store.get(name);
    const installed = extracted(name) && s.initialized(p.data) && !!saved;
    return {
      name, kind: s.kind, title: s.title, version: s.version, size: s.size, dir: p.dir,
      installed, running: installed && (await running(name)), port: saved?.port ?? null, owned: owned.has(name),
    };
  }

  async function install(name, { log, progress, signal, exec }) {
    const s = SERVERS[name];
    const p = paths(name);
    fs.mkdirSync(path.join(root, 'servers'), { recursive: true });
    if (!extracted(name)) {
      const zip = path.join(root, 'servers', path.basename(new URL(s.url).pathname));
      if (!fs.existsSync(zip)) await download(s.url, zip, { sha256: s.sha256, size: s.size, signal, log, progress: (f) => progress(f * 0.8) });
      progress(0.8);
      const staging = `${p.dir}.extract`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      log(`Extracting to ${p.dir}\n`);
      await exec(tarExe(), ['-xf', zip, '-C', staging, ...s.exclude.flatMap((x) => ['--exclude', x])]);
      fs.rmSync(p.dir, { recursive: true, force: true });
      fs.renameSync(staging, p.dir);
      fs.rmSync(zip, { force: true });
    }
    progress(0.9);
    if (!s.initialized(p.data) || !store.get(name)) {
      fs.rmSync(p.data, { recursive: true, force: true });
      const password = crypto.randomBytes(18).toString('base64url');
      const port = await freePort(s.defaultPort);
      log(`Initializing the data directory (port ${port})\n`);
      try {
        await s.init({ bin: p.bin, data: p.data, password, port, exec });
      } catch (err) {
        fs.rmSync(p.data, { recursive: true, force: true });
        throw err;
      }
      store.set(name, { version: s.version, port, user: s.user, database: s.database, password });
    }
    progress(1);
  }

  async function start(name, { log, exec, signal }) {
    if (await running(name)) { log('Already running\n'); return; }
    const s = SERVERS[name];
    const p = paths(name);
    const saved = store.get(name);
    if (!saved) throw new Error(`${s.title} is not installed`);
    if (!(await portFree(saved.port))) {
      const port = await freePort(saved.port + 1);
      log(`Port ${saved.port} is in use; using ${port}\n`);
      store.set(name, { ...saved, port });
    }
    const { port, password } = store.get(name);
    const [cmd, args] = s.start({ bin: p.bin, data: p.data, port });
    log(`> ${path.basename(cmd)} ${args.join(' ')}\n`);
    const child = spawnServer(cmd, args, { cwd: p.dir, logFile: p.logFile });
    owned.set(name, child);
    child.once('exit', () => { if (owned.get(name) === child) owned.delete(name); });
    for (let i = 0; i < 120; i++) {
      if (signal.aborted) { await stop(name, { log, exec }); throw new Error('Cancelled'); }
      if (child.exitCode !== null) {
        const tail = fs.existsSync(p.logFile) ? fs.readFileSync(p.logFile, 'utf8').split('\n').slice(-15).join('\n') : '';
        log(tail);
        throw new Error(`${s.title} exited with code ${child.exitCode}`);
      }
      if (await portOpen(port) && (!s.ready || await s.ready({ bin: p.bin, port, run }))) {
        log(`${s.title} is accepting connections on 127.0.0.1:${port}\n`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${s.title} did not start within 60 seconds`);
  }

  async function stop(name, { log, exec }) {
    const s = SERVERS[name];
    const p = paths(name);
    const saved = store.get(name);
    if (!saved || !(await running(name))) { owned.delete(name); return; }
    try {
      await s.stop({ bin: p.bin, data: p.data, port: saved.port, password: saved.password, exec });
    } catch (err) {
      log(`${err.message}\n`);
    }
    const child = owned.get(name);
    for (let i = 0; i < 40 && (await portOpen(saved.port)); i++) await new Promise((r) => setTimeout(r, 250));
    if (child && child.exitCode === null) {
      log('Server did not stop; ending the process\n');
      child.kill();
    }
    owned.delete(name);
  }

  async function uninstall(name, ctx) {
    await stop(name, ctx);
    ctx.log(`Removing ${dirOf(name)}\n`);
    fs.rmSync(dirOf(name), { recursive: true, force: true });
    fs.rmSync(`${dirOf(name)}.extract`, { recursive: true, force: true });
    store.set(name, null);
  }

  const connection = (name) => {
    const saved = store.get(name);
    if (!saved) return null;
    return { kind: SERVERS[name].kind, name: `${SERVERS[name].title} ${SERVERS[name].version} (PyIDE)`, host: '127.0.0.1', port: saved.port, user: saved.user, password: saved.password, database: saved.database };
  };

  const ownedNames = () => [...owned.keys()];

  return { status, install, start, stop, uninstall, connection, ownedNames, names: () => Object.keys(SERVERS) };
}

module.exports = { SERVERS, createServers, portOpen };
