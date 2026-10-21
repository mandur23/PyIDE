// Database plugin, main side: data sources (persisted in <userData>/database), one connection per source with a
// small state machine (disconnected -> connecting -> connected | error), queries, schema introspection, and
// on-demand npm installs of external drivers. Passwords stay here: they are encrypted with safeStorage on disk
// and the renderer only ever sees hasPassword.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DRIVERS, PACKAGES, driverDir, packageVersion } = require('../db/drivers');
const { sameConnection } = require('../settings-sync/same-connection');

function register({ ipcMain, app, send }) {
  const { safeStorage } = require('electron');
  const dataDir = path.join(app.getPath('userData'), 'database');
  const sourcesFile = path.join(dataDir, 'sources.json');
  const consoleFile = (id) => path.join(dataDir, 'consoles', `${id.replace(/[^\w-]/g, '_')}.sql`);

  const writeAtomic = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  };

  // ---------- data sources ----------
  let sources = (() => {
    // A hand-edited file keeps only the entries that are data sources at all.
    try {
      const saved = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))?.sources;
      return Array.isArray(saved) ? saved.filter((s) => s && typeof s === 'object' && typeof s.id === 'string') : [];
    } catch { return []; }
  })();
  const save = () => writeAtomic(sourcesFile, JSON.stringify({ version: 1, sources }, null, 2));
  const byId = (id) => {
    const s = sources.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown data source ${id}`);
    return s;
  };

  const encrypt = (text) => (safeStorage.isEncryptionAvailable()
    ? { enc: 'safeStorage', data: safeStorage.encryptString(text).toString('base64') }
    : { enc: 'plain', data: Buffer.from(text, 'utf8').toString('base64') });
  const decrypt = (secret) => {
    if (!secret) return undefined;
    const buf = Buffer.from(secret.data, 'base64');
    return secret.enc === 'safeStorage' ? safeStorage.decryptString(buf) : buf.toString('utf8');
  };

  const conns = new Map(); // id -> {state, message, adapter, opening}
  const stateOf = (id) => conns.get(id) || { state: 'disconnected' };
  const toPublic = (s) => {
    const { secret, ...rest } = s;
    const c = stateOf(s.id);
    return { ...rest, hasPassword: !!secret, state: c.state, message: c.message || null };
  };

  // Keeps only the fields the kind's driver uses, so a record never carries stale values from another kind.
  // The password is never stored here: it goes to the encrypted secret.
  function normalize(cfg) {
    const driver = DRIVERS[cfg.kind];
    if (!driver) throw new Error(`Unknown database kind ${cfg.kind}`);
    const out = { id: cfg.id || crypto.randomUUID(), name: String(cfg.name || '').trim() || driver.label, kind: cfg.kind };
    for (const f of fieldSpecs(driver)) {
      if (f.key === 'password') continue;
      const v = cfg[f.key];
      if (f.type === 'number') out[f.key] = Number(v) || (f.key === 'port' ? driver.defaultPort : f.default ?? null);
      else if (f.type === 'checkbox') out[f.key] = v === undefined ? !!f.default : !!v;
      else if (v !== undefined && v !== '') out[f.key] = String(v).trim();
    }
    return out;
  }

  // ---------- connections ----------
  function setState(id, state, message = null, adapter = null) {
    conns.set(id, { state, message, adapter });
    send('db:state', { id, state, message });
  }

  // An unsaved config (Test Connection) carries its own password; undefined falls back to the stored one.
  const openConfig = (cfg, secret) => ({ ...cfg, password: cfg.password !== undefined ? cfg.password : decrypt(secret) });

  async function connect(id) {
    const c = conns.get(id);
    if (c?.state === 'connected') return c.adapter;
    if (c?.state === 'connecting') return c.opening;
    const src = byId(id);
    let adapter = null;
    // A dropped connection becomes an error state; the next query reconnects.
    const onLost = (err) => {
      if (!adapter || conns.get(id)?.adapter !== adapter) return;
      conns.delete(id);
      try { adapter.close()?.catch?.(() => {}); } catch {}
      setState(id, 'error', `Connection lost: ${err?.message || err}`);
    };
    const opening = Promise.resolve().then(() => DRIVERS[src.kind].open(openConfig(src, src.secret), { onLost }));
    conns.set(id, { state: 'connecting', opening });
    send('db:state', { id, state: 'connecting', message: null });
    try {
      adapter = await opening;
      if (conns.get(id)?.opening !== opening) { await adapter.close(); throw new Error('Disconnected'); }
      setState(id, 'connected', null, adapter);
      return adapter;
    } catch (err) {
      if (conns.get(id)?.opening === opening) setState(id, 'error', err.message);
      throw err;
    }
  }

  async function disconnect(id) {
    const c = conns.get(id);
    if (!c) return;
    conns.delete(id);
    if (c.adapter) { try { await c.adapter.close(); } catch {} }
    send('db:state', { id, state: 'disconnected', message: null });
  }

  // Built-in field names as specs; kinds may also declare their own (see main/db/drivers.js).
  const BUILTIN_FIELDS = { file: { type: 'file' }, host: { type: 'text' }, port: { type: 'number' }, user: { type: 'text' }, password: { type: 'password' }, database: { type: 'text' } };
  const fieldSpecs = (d) => d.fields.map((f) => (typeof f === 'string' ? { key: f, builtin: true, ...BUILTIN_FIELDS[f] } : { type: 'text', ...f }));

  const failure = (err) => ({ ok: false, error: err.message, missingDriver: err.missingDriver || null });

  // A password typed into a connection string field (type 'url', e.g. mongodb://user:pw@host) moves to the encrypted
  // secret like a password field, so sources.json never holds it; the kind gets the URL without it plus cfg.password.
  function liftUrlPassword(cfg) {
    const driver = DRIVERS[cfg.kind];
    if (!driver) return cfg;
    const out = { ...cfg };
    for (const f of fieldSpecs(driver)) {
      if (f.type !== 'url' || typeof out[f.key] !== 'string') continue;
      const m = out[f.key].match(/^([a-z][\w+.-]*:\/\/)([^:@/]*):([^@/]*)@(.*)$/i);
      if (!m) continue;
      out[f.key] = `${m[1]}${m[2]}@${m[4]}`;
      if (out.password === undefined || out.password === '') {
        try { out.password = decodeURIComponent(m[3]); } catch { out.password = m[3]; }
      }
    }
    return out;
  }

  // ---------- drivers ----------
  const driverList = () => Object.entries(DRIVERS).map(([kind, d]) => ({
    kind, label: d.label, fields: fieldSpecs(d), ui: d.ui || null, defaultPort: d.defaultPort || null, builtin: !!d.builtin, quote: d.quote,
    implicitSchemas: d.implicitSchemas, package: d.package || null,
    installed: d.builtin || !!packageVersion(d.package), version: d.builtin ? null : packageVersion(d.package),
  }));

  const installs = new Map(); // package -> Promise, so a second click joins the running install
  function installDriver(pkg) {
    if (!PACKAGES[pkg]) return Promise.resolve({ ok: false, error: `Unknown driver package ${pkg}` });
    if (installs.has(pkg)) return installs.get(pkg);
    const dir = driverDir();
    const log = (text) => send('db:log', { package: pkg, text });
    const run = new Promise((resolve) => {
      fs.mkdirSync(dir, { recursive: true });
      const manifest = path.join(dir, 'package.json');
      if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: 'pyide-db-drivers', private: true }, null, 2));
      const args = ['install', '--prefix', `"${dir}"`, '--no-audit', '--no-fund', '--loglevel', 'http', PACKAGES[pkg]];
      log(`> npm ${args.join(' ')}\n`);
      // npm is a .cmd script on Windows, which Node only spawns through a shell.
      const child = spawn('npm', args, { shell: true, windowsHide: true, env: { ...process.env, npm_config_update_notifier: 'false' } });
      child.stdout.on('data', (d) => log(d.toString()));
      child.stderr.on('data', (d) => log(d.toString()));
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => {
        const version = packageVersion(pkg);
        resolve(code === 0 && version ? { ok: true, version } : { ok: false, error: `npm exited with code ${code}` });
      });
    }).finally(() => {
      installs.delete(pkg);
      send('db:drivers', driverList());
    });
    installs.set(pkg, run);
    return run;
  }

  // ---------- IPC ----------
  ipcMain.handle('db:drivers', () => driverList());
  ipcMain.handle('db:installDriver', (_e, pkg) => installDriver(pkg));
  ipcMain.handle('db:list', () => sources.map(toPublic));

  ipcMain.handle('db:save', async (_e, input) => {
    const cfg = liftUrlPassword(input);
    const record = normalize(cfg);
    const old = sources.find((s) => s.id === record.id);
    // No password given keeps the saved one only for the same server and user; a record pointing elsewhere (edited, or
    // imported with a matching id) has none until the user types it, so the saved password never goes to another host.
    let secret = old && sameConnection(old, record) ? old.secret : undefined;
    if (cfg.password !== undefined) secret = cfg.password ? encrypt(cfg.password) : undefined;
    if (secret) record.secret = secret;
    sources = old ? sources.map((s) => (s.id === record.id ? record : s)) : [...sources, record];
    save();
    if (old) await disconnect(record.id);
    return toPublic(record);
  });

  ipcMain.handle('db:remove', async (_e, id) => {
    await disconnect(id);
    sources = sources.filter((s) => s.id !== id);
    save();
    fs.rmSync(consoleFile(id), { force: true });
  });

  ipcMain.handle('db:test', async (_e, input) => {
    const cfg = liftUrlPassword(input);
    let adapter;
    const t0 = performance.now();
    try {
      const record = normalize(cfg);
      const stored = sources.find((s) => s.id === cfg.id);
      const secret = stored && sameConnection(stored, record) ? stored.secret : undefined;
      adapter = await DRIVERS[record.kind].open(openConfig({ ...record, password: cfg.password }, secret));
      return { ok: true, version: await adapter.version(), ms: Math.round(performance.now() - t0) };
    } catch (err) {
      return failure(err);
    } finally {
      try { await adapter?.close(); } catch {}
    }
  });

  ipcMain.handle('db:connect', async (_e, id) => {
    try { await connect(id); return { ok: true }; } catch (err) { return failure(err); }
  });
  ipcMain.handle('db:disconnect', (_e, id) => disconnect(id));

  ipcMain.handle('db:schema', async (_e, id) => {
    try { return { ok: true, schemas: await (await connect(id)).schema() }; } catch (err) { return failure(err); }
  });

  // Children of a node the kind marked lazy (a collection's sampled fields, a Redis database's keys); path is the
  // node names from the top of the tree.
  ipcMain.handle('db:children', async (_e, id, nodePath) => {
    try {
      const adapter = await connect(id);
      if (!adapter.children) throw new Error('This data source has no lazy tree nodes');
      return { ok: true, nodes: await adapter.children(nodePath) };
    } catch (err) { return failure(err); }
  });

  ipcMain.handle('db:query', async (_e, id, sql, { maxRows = 500 } = {}) => {
    try { return { ok: true, ...(await (await connect(id)).query(sql, { maxRows })) }; } catch (err) { return failure(err); }
  });

  // Opening a .db file from the project offers it as a data source only when it really is SQLite (Thumbs.db is not).
  ipcMain.handle('db:isSqlite', (_e, file) => {
    try {
      const fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      return head.subarray(0, 15).toString('latin1') === 'SQLite format 3' || fs.statSync(file).size === 0;
    } catch { return false; }
  });

  ipcMain.handle('db:consoleLoad', (_e, id) => {
    try { return fs.readFileSync(consoleFile(id), 'utf8'); } catch { return null; }
  });
  ipcMain.handle('db:consoleSave', (_e, id, text) => writeAtomic(consoleFile(id), text));

  app.on('before-quit', () => { for (const id of [...conns.keys()]) disconnect(id); });
}

module.exports = { register };
