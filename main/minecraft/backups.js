// World backups of a Craft server, and putting one back ("restore"). A backup is one .zip in <server>/backups/, named by
// its time and why it was made, holding the server's worlds and the small files that define it, with nano-backup.json
// first (what was in it, what was left out, the versions). The jars, mods, libraries and logs are not in it: they are
// large and can be downloaded again, and a restore never touches them.
//
// A running server is asked to stop writing its world first (save-off, then save-all flush, packed once it says it has
// saved, and save-on again afterwards whatever happens), so a backup never holds half-written region files. A restore
// needs the server stopped, checks every entry of the archive, makes a "before restore" backup of what is there now,
// unpacks beside the world and swaps the folders by renaming, so a failure half-way puts the old world back. A
// journal (.nano-restore/journal.json) lets the next run finish that undo if the app itself died during the swap.
//
// API for main (main/features/minecraft.js holds the one instance as `backups`):
//   list(dir) -> {items: [Backup], used, policy, busy}      Backup: {file, name, created, reason, auto, keep, size,
//                                                            mc, kind, levelName, app, worlds}
//   newest(dir) -> Backup | null                            the newest whose archive opens and lists its files
//   backup(dir, {reason, job}) -> Backup                    reason: a key of REASONS
//   restore(dir, file, {worldOnly, job}) -> {restored, kept, safety, levelName}
//   cancel(job), remove(dir, file), keep(dir, file, on), policy(dir), setPolicy(dir, p)
//   attach(dir, proc), beforeStart(dir), shutdown()          lifecycle hooks: the schedule, a backup at stop
// Progress and outcome go to the window as minecraft:backup {dir, job, op, reason, phase, done, total, state}.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { createZipWriter, prepare, SMALL, openArchive } = require('./zip64');
const { canonical } = require('./zipfile');
const { split } = require('./players/logparse');

const FOLDER = 'backups';
const MANIFEST = 'nano-backup.json';
const WORK = '.nano-restore';
const SERVER = 'pyide-server.json';
const fail = (message, code, extra) => Object.assign(new Error(message), { expected: true, code, ...extra });
// What a failure's message says, as values the window words in its own language.
const details = (err) => Object.fromEntries(['entry', 'need', 'free', 'cause'].filter((k) => err[k] != null).map((k) => [k, err[k]]));

// Why a backup was made. auto: made by the app, so retention may delete it once newer ones come (unless kept).
const REASONS = {
  manual: { auto: false },
  market: { auto: true }, // before a Market mod or plugin install, update or removal
  world: { auto: true }, // before a dropped world replaces the level
  settings: { auto: true }, // before a change of level-name or account checks (the players' UUIDs)
  repair: { auto: true }, // before Repair rewrites pyide-server.json
  schedule: { auto: true }, // every N hours while it runs
  stop: { auto: true }, // when it stops and the last backup is more than a day old
  restore: { auto: true }, // what was there before a restore
};
const POLICY = { every: 6, keep: 10, maxGB: 20 };
const DAY = 24 * 3600 * 1000;

// What a backup holds besides the worlds: the files that say what the server is and who may play on it, and the config
// folders. Files at the top of the server folder with these extensions and under 1 MB are taken; plugins/<name>/ is
// taken without its jars.
const TOP_FILES = /\.(properties|json|ya?ml|toml|txt|conf|cfg)$/i;
const TOP_LIMIT = 1 << 20;
const CONFIG_DIRS = ['config', 'defaultconfigs'];
// What is never packed: the lock a running server holds on its world (Windows refuses to read it), and our own files.
const SKIP = /(^|\/)session\.lock$/i;
const LEFT_OUT_NOTE = { mods: 'mods/', libraries: 'libraries/', logs: 'logs/', cache: 'cache/', versions: 'versions/', 'crash-reports': 'crash-reports/' };
const leftOutJar = (rel) => /\.jar$/i.test(rel);

// 2026-11-10_14-03-22_market.zip, -2 when a second one lands in the same second, _keep when the user marked it.
const NAME = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(?:-\d+)?_([a-z]+)(_keep)?\.zip$/;
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };
const keyOf = (dir) => path.resolve(dir).toLowerCase();
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const mb = (n) => `${Math.ceil(n / 1048576).toLocaleString('en-US')} MB`;

// Windows refuses a rename for a moment while a virus scanner or the indexer has a file of the folder open.
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; } catch (err) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => { setTimeout(r, 100); });
    }
  }
}

// ---------- what a server's backup holds ----------
// The world folder level-name names, when it is a plain relative path inside the server.
function levelOf(dir, props) {
  const name = String(props['level-name'] ?? 'world').replace(/\\/g, '/') || 'world';
  if (!canonical(name)) throw fail(`server.properties names the world "${name}", which is not a plain folder name, so it cannot be backed up`, 'badWorld');
  return name;
}
// The units a restore swaps, each a file or a folder: [{rel, kind: 'world' | 'config', dir}].
function itemsOf(dir, levelName) {
  const items = [];
  for (const rel of [levelName, `${levelName}_nether`, `${levelName}_the_end`]) if (isDir(path.join(dir, rel))) items.push({ rel, kind: 'world', dir: true });
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isFile() && TOP_FILES.test(d.name) && !/^pyide-server\.(running|unfinished)$/.test(d.name)) {
      try { if (fs.statSync(path.join(dir, d.name)).size <= TOP_LIMIT) items.push({ rel: d.name, kind: 'config', dir: false }); } catch {}
    }
  }
  for (const rel of CONFIG_DIRS) if (isDir(path.join(dir, rel))) items.push({ rel, kind: 'config', dir: true });
  const plugins = path.join(dir, 'plugins');
  if (isDir(plugins)) for (const d of fs.readdirSync(plugins, { withFileTypes: true })) if (d.isDirectory()) items.push({ rel: `plugins/${d.name}`, kind: 'config', dir: true });
  return items;
}
// What the folder has that the backup does not, said in the manifest.
function leftOutOf(dir, items) {
  const taken = new Set(items.map((i) => i.rel.split('/')[0].toLowerCase()));
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const n = d.name;
    if (n === FOLDER || n === WORK || taken.has(n.toLowerCase()) && n !== 'plugins') continue;
    if (n === 'plugins') {
      const jars = fs.readdirSync(path.join(dir, n)).filter((x) => /\.jar$/i.test(x));
      if (jars.length) out.push(`plugins/*.jar (${jars.length})`);
      continue;
    }
    out.push(LEFT_OUT_NOTE[n] || (d.isDirectory() ? `${n}/` : n));
  }
  return out;
}
// Every file and folder under the items: [{name (forward slashes), abs, size, mtime, dir}]. Links are not followed: a
// junction in a world could point anywhere.
async function walk(dir, items, signal) {
  const out = [];
  const visit = async (rel) => {
    if (signal?.aborted) throw fail('Cancelled', 'cancelled');
    const abs = path.join(dir, rel);
    const st = await fs.promises.lstat(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      out.push({ name: `${rel}/`, abs, size: 0, mtime: st.mtimeMs, dir: true });
      for (const d of await fs.promises.readdir(abs, { withFileTypes: true })) {
        const sub = `${rel}/${d.name}`;
        if (SKIP.test(sub) || (rel.startsWith('plugins/') && leftOutJar(sub))) continue;
        await visit(sub);
      }
    } else if (st.isFile()) out.push({ name: rel, abs, size: st.size, mtime: st.mtimeMs, dir: false });
  };
  for (const item of items) await visit(item.rel);
  return out;
}

async function freeSpace(dir) {
  try { const s = await fs.promises.statfs(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

// The manifest is the archive's first entry, stored: read from the start of the file without its directory.
async function manifestOf(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, 0);
    if (head.readUInt32LE(0) !== 0x04034b50 || head.readUInt16LE(8) !== 0) return null;
    const nameLen = head.readUInt16LE(26);
    const size = head.readUInt32LE(18);
    if (size > 1 << 20) return null;
    const rest = Buffer.alloc(nameLen + head.readUInt16LE(28) + size);
    await fh.read(rest, 0, rest.length, 30);
    if (rest.toString('utf8', 0, nameLen) !== MANIFEST) return null;
    const m = JSON.parse(rest.toString('utf8', rest.length - size));
    return m && typeof m === 'object' ? m : null;
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
}

// ---------- a running server's saves held off ----------
// Lines of a process's output as they come, to whoever listens.
function linesOf(proc) {
  const listeners = new Set();
  const decoder = new StringDecoder('utf8');
  let partial = '';
  const onData = (d) => {
    partial += decoder.write(d);
    for (let i; (i = partial.indexOf('\n')) >= 0;) {
      const line = partial.slice(0, i);
      partial = partial.slice(i + 1);
      for (const l of [...listeners]) l(line);
    }
  };
  proc.stdout?.on('data', onData);
  return { on: (l) => { listeners.add(l); return () => listeners.delete(l); }, close: () => proc.stdout?.off('data', onData) };
}
// The server's own answers, by the message after the log's prefix: a player cannot write a line that starts so.
const said = (line, ...messages) => { const head = split(line); return !!head?.server && messages.includes(head.msg.trim()); };
const ANSWERS = {
  off: ['Automatic saving is now disabled'], alreadyOff: ['Saving is already turned off'],
  on: ['Automatic saving is now enabled', 'Saving is already turned on'],
  saving: ['Saving the game (this may take a moment!)'], saved: ['Saved the game'], failed: ['Unable to save the game (is there enough disk space?)'],
  stopping: ['Stopping the server', 'Stopping server'],
};
const TIMES = { answer: 30000, flush: 10 * 60000, on: 15000 };

// Sends save-off and save-all flush and resolves once the server says it has saved: {release(), wasOff, watch(onStop)}.
// release() sends save-on (unless saving was off before we came) and must be called whatever happens next, which the
// caller's finally does.
async function holdSaves(proc, { signal, phase, times = TIMES }) {
  const out = linesOf(proc);
  let sent = false;
  let wasOff = false;
  const send = (line) => { proc.stdin.write(`${line}\n`); };
  const waitFor = (accept, ms, why) => new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); off(); signal?.removeEventListener('abort', onAbort); proc.off?.('close', onClose); proc.off?.('stopAsked', onClose); fn(v); };
    const timer = setTimeout(() => done(reject, fail(why, 'noAnswer')), ms);
    const onAbort = () => done(reject, fail('Cancelled', 'cancelled'));
    const onClose = () => done(reject, fail('The server stopped while it was being backed up', 'stopped'));
    const off = out.on((line) => { const r = accept(line); if (r !== undefined) done(r instanceof Error ? reject : resolve, r); });
    signal?.addEventListener('abort', onAbort);
    proc.once?.('close', onClose);
    proc.once?.('stopAsked', onClose);
    if (proc.stopAsked) onClose();
  });
  // A stopping server is sent nothing more: its stop saves the world whether saving is off or not.
  const release = async () => {
    try {
      if (sent && !wasOff && proc.exitCode === null && !proc.killed && !proc.stopAsked) {
        send('save-on');
        await waitFor((l) => (said(l, ...ANSWERS.on) ? true : undefined), times.on, 'no answer to save-on').catch(() => {});
      }
    } finally { out.close(); }
  };
  try {
    phase('pausing');
    send('save-off');
    sent = true;
    const first = await waitFor((l) => (said(l, ...ANSWERS.off) ? 'off' : said(l, ...ANSWERS.alreadyOff) ? 'already' : undefined), times.answer,
      'The server did not answer save-off, so its world was not backed up: it may still be starting, or busy');
    wasOff = first === 'already';
    phase('flushing');
    send('save-all flush');
    let saving = false;
    await waitFor((l) => {
      if (said(l, ...ANSWERS.failed)) return fail('The server could not save its world (is the disk full?), so it was not backed up', 'saveFailed');
      if (said(l, ...ANSWERS.saved)) return true;
      if (said(l, ...ANSWERS.saving)) saving = true;
      return undefined;
    }, times.flush, 'The server did not say it had saved its world, so nothing was packed: half-written files would make a broken backup')
      .catch(async (err) => { if (err.code === 'noAnswer' && !saving) err.message = 'The server did not answer save-all, so its world was not backed up'; throw err; });
  } catch (err) {
    await release();
    throw err;
  }
  // While the files are read, a stop (from anyone) means the server writes them again.
  const watch = (onStop) => {
    const offLine = out.on((l) => { if (said(l, ...ANSWERS.stopping)) onStop(); });
    proc.once?.('close', onStop);
    proc.once?.('stopAsked', onStop);
    if (proc.stopAsked) onStop();
    return () => { offLine(); proc.off?.('close', onStop); proc.off?.('stopAsked', onStop); };
  };
  return { release, wasOff, watch };
}

// ---------- the module ----------
// deps: {readServer(dir) -> pyide-server.json or null, writeServer(dir, desc), readProps(file), writeProps(file, changes),
// isRunning(dir), leftOver(dir) -> Promise<truthy when another process holds it>, appVersion(), now?, times?}
function createBackups(deps) {
  const now = deps.now || Date.now;
  let send = () => {};
  let trash = async (file) => { await fs.promises.rm(file, { force: true }); };
  let quitting = false;
  const jobs = new Map(); // server folder (lower case) -> {op, job, reason, ctl, phase, done, total, dir}
  const live = new Map(); // server folder (lower case) -> {proc, timer}
  const byJob = new Map(); // job -> the jobs entry
  let seq = 0;

  const folderOf = (dir) => path.join(dir, FOLDER);
  const policy = (dir) => {
    const p = deps.readServer(dir)?.backups;
    const num = (v, lo, hi, d) => (Number.isFinite(v) && v >= lo && v <= hi ? v : d);
    return { every: num(p?.every, 0, 168, POLICY.every), keep: num(p?.keep, 1, 1000, POLICY.keep), maxGB: num(p?.maxGB, 1e-6, 100000, POLICY.maxGB) };
  };
  function setPolicy(dir, p) {
    const desc = deps.readServer(dir);
    if (!desc) throw fail(`${SERVER} of ${path.basename(dir)} cannot be read`, 'damaged');
    const next = { ...policy(dir), ...Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => k in POLICY && Number.isFinite(v))) };
    deps.writeServer(dir, { ...desc, backups: next });
    if (live.has(keyOf(dir))) arm(dir);
    return policy(dir);
  }

  // ---------- the list ----------
  async function list(dir) {
    const folder = folderOf(dir);
    const names = fs.existsSync(folder) ? await fs.promises.readdir(folder) : [];
    await sweep(dir, names);
    const items = [];
    for (const name of names) {
      const m = NAME.exec(name);
      if (!m && !/\.zip$/i.test(name)) continue;
      const file = path.join(folder, name);
      let st;
      try { st = await fs.promises.stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      const man = await manifestOf(file);
      const reason = m && REASONS[m[7]] ? m[7] : 'manual';
      const created = man?.created ? Date.parse(man.created) : m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : st.mtimeMs;
      items.push({
        file, name, created, reason, auto: !!m && REASONS[reason].auto, keep: !!m?.[8], size: st.size, damaged: !man,
        mc: man?.mc ?? null, kind: man?.kind ?? null, levelName: man?.levelName ?? null, app: man?.app ?? null, worlds: man?.worlds ?? [],
      });
    }
    items.sort((a, b) => b.created - a.created);
    const j = jobs.get(keyOf(dir));
    return { items, used: items.reduce((s, i) => s + i.size, 0), policy: policy(dir), busy: j ? { op: j.op, job: j.job, reason: j.reason, phase: j.phase, done: j.done, total: j.total } : null };
  }
  // What a run that ended without finishing left: a backup's temporary file, a restore's work folder.
  async function sweep(dir, names) {
    const busy = jobs.has(keyOf(dir));
    if (busy) return;
    for (const n of names) if (/\.zip\.\d+\.tmp$/.test(n)) await fs.promises.rm(path.join(folderOf(dir), n), { force: true }).catch(() => {});
    await recover(dir);
  }
  async function newest(dir) {
    for (const b of (await list(dir)).items) {
      if (b.damaged) continue;
      try { const a = await openArchive(b.file); await a.close(); return b; } catch {}
    }
    return null;
  }

  // ---------- jobs ----------
  function claim(dir, op, reason, job) {
    const k = keyOf(dir);
    const held = jobs.get(k);
    if (held) {
      throw fail(held.op === 'restore' ? `${path.basename(dir)} is being restored: wait for it to finish` : `${path.basename(dir)} is being backed up already: wait for it to finish, or cancel it`, 'busy');
    }
    const j = { op, job: job || `backup-${now()}-${++seq}`, reason, ctl: new AbortController(), phase: 'starting', done: 0, total: 0, dir, sentAt: 0 };
    jobs.set(k, j);
    byJob.set(j.job, j);
    return j;
  }
  function release(j) {
    if (jobs.get(keyOf(j.dir)) === j) jobs.delete(keyOf(j.dir));
    byJob.delete(j.job);
  }
  const report = (j, extra = {}) => send('minecraft:backup', { dir: j.dir, job: j.job, op: j.op, reason: j.reason, phase: j.as || j.phase, done: j.done, total: j.total, state: 'running', ...extra });
  const tick = (j, force) => { if (force || Date.now() - j.sentAt > 200) { j.sentAt = Date.now(); report(j); } };
  const phaseOf = (j) => (p) => { j.phase = p; tick(j, true); };
  const cancel = (job) => { const j = byJob.get(job); if (!j) return false; j.ctl.abort(); return true; };

  // ---------- making one ----------
  async function backup(dir, { reason = 'manual', job } = {}) {
    if (!REASONS[reason]) throw fail(`Unknown backup reason ${reason}`);
    const j = claim(dir, 'backup', reason, job);
    try {
      const made = await packServer(dir, j, reason);
      report(j, { state: 'done', file: made.file });
      await prune(dir, made.file).catch(() => {});
      return made;
    } catch (err) {
      const cancelled = err.code === 'cancelled';
      report(j, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : err.message, code: cancelled ? 'cancelled' : err.code || null, ...details(err) });
      if (cancelled) throw fail('Cancelled', 'cancelled');
      throw err;
    } finally { release(j); }
  }
  // The pack itself, holding the claim j: saves held off while a running server's files are read.
  async function packServer(dir, j, reason) {
    const { signal } = j.ctl;
    const desc = deps.readServer(dir);
    if (desc && desc.kind === 'velocity') throw fail('A proxy has no world to back up', 'proxy');
    if (await deps.leftOver?.(dir)) throw fail(`${path.basename(dir)} is running outside this window, so its world cannot be held still for a backup: stop it first`, 'leftOver');
    const props = deps.readProps(path.join(dir, 'server.properties'));
    const levelName = levelOf(dir, props);
    const live1 = live.get(keyOf(dir));
    const proc = live1 && live1.proc.exitCode === null ? live1.proc : null;
    if (proc?.stopAsked) throw fail(`${path.basename(dir)} is stopping, and a stopping server writes its world: make a backup once it has stopped`, 'stopping');
    let hold = null;
    let unwatch = () => {};
    let stopped = false;
    try {
      if (proc) {
        hold = await holdSaves(proc, { signal, phase: phaseOf(j), times: deps.times });
        unwatch = hold.watch(() => { stopped = true; j.ctl.abort(); });
      }
      const items = itemsOf(dir, levelName);
      if (!items.some((i) => i.kind === 'world')) throw fail(`${path.basename(dir)} has no world yet (no ${levelName} folder): start it once first`, 'noWorld');
      j.phase = 'scanning';
      tick(j, true);
      const files = await walk(dir, items, signal);
      const total = files.reduce((s, f) => s + f.size, 0);
      const folder = folderOf(dir);
      await fs.promises.mkdir(folder, { recursive: true });
      const free = await freeSpace(folder);
      if (free < total + 64 * 1048576) throw fail(`There is not enough free space for a backup of ${path.basename(dir)}: it needs up to ${mb(total)}, and the disk has ${mb(free)} free`, 'space', { need: total, free });
      const created = now();
      let name = `${stampOf(created)}_${reason}.zip`;
      for (let i = 2; exists(path.join(folder, name)); i++) name = `${stampOf(created)}-${i}_${reason}.zip`;
      const file = path.join(folder, name);
      const manifest = {
        format: 1, app: deps.appVersion?.() ?? null, created: new Date(created).toISOString(), reason,
        mc: desc?.mc ?? null, kind: desc?.kind ?? null, loader: desc?.loader ?? null, levelName,
        worlds: items.filter((i) => i.kind === 'world').map((i) => i.rel), items: items.map(({ rel, kind, dir: d }) => ({ rel, kind, dir: d })),
        files: files.filter((f) => !f.dir).length, bytes: total, leftOut: leftOutOf(dir, items), running: !!proc, savingWasOff: !!hold?.wasOff,
      };
      j.phase = 'packing';
      j.total = total;
      j.done = 0;
      tick(j, true);
      const zip = await createZipWriter(file, { level: 1 });
      try {
        await zip.add({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)), store: true });
        // The next few small files are read and deflated while this one is written.
        const ahead = new Map(); // index -> Promise of prepare()
        const start = (i) => {
          const f = files[i];
          if (!f || f.dir || f.size >= SMALL || ahead.has(i)) return;
          const p = prepare({ file: f.abs }, { level: 1 });
          p.catch(() => {});
          ahead.set(i, p);
        };
        for (let i = 0; i < files.length; i++) {
          for (let k = i; k < i + 8; k++) start(k);
          const f = files[i];
          const prepared = ahead.has(i) ? await ahead.get(i) : undefined;
          ahead.delete(i);
          await zip.add({ name: f.name, file: f.dir || prepared ? undefined : f.abs, prepared, dir: f.dir, mtime: f.mtime }, { signal, onBytes: (n) => { j.done += n; tick(j); } });
        }
        if (stopped) throw fail(`${path.basename(dir)} stopped while it was being backed up, and a stopping server writes its world: the backup was thrown away. Make one when it has stopped.`, 'stopped');
        await zip.finish();
      } catch (err) {
        await zip.abort();
        if (stopped) throw fail(`${path.basename(dir)} stopped while it was being backed up, and a stopping server writes its world: the backup was thrown away. Make one when it has stopped.`, 'stopped');
        if (err.code === 'ENOENT' || err.code === 'EBUSY' || err.code === 'EPERM') throw fail(`${err.path ? path.relative(dir, err.path) : 'A file'} could not be read (${err.code}), so the backup was not made`, 'unreadable', { entry: err.path ? path.relative(dir, err.path) : null });
        throw err;
      }
      const st = fs.statSync(file);
      return { file, name, created, reason, auto: REASONS[reason].auto, keep: false, size: st.size, mc: manifest.mc, kind: manifest.kind, levelName, app: manifest.app, worlds: manifest.worlds };
    } finally {
      unwatch();
      if (hold) { j.phase = 'resuming'; tick(j, true); await hold.release(); }
    }
  }

  // ---------- retention ----------
  // The newest `keep` automatic backups stay, and the oldest automatic ones go while the folder is over its size; a
  // backup the user made or marked, and the one just made, always stay.
  async function prune(dir, justMade) {
    const p = policy(dir);
    const { items } = await list(dir);
    const limit = p.maxGB * 1024 ** 3;
    let used = items.reduce((s, i) => s + i.size, 0);
    let autos = items.filter((i) => i.auto && !i.keep).length;
    const removed = [];
    for (const b of [...items].reverse()) {
      if (!b.auto || b.keep || b.file === justMade) continue;
      if (autos <= p.keep && used <= limit) break;
      try { await trash(b.file); } catch { continue; }
      removed.push(b.name);
      autos--;
      used -= b.size;
    }
    return removed;
  }
  const inFolder = (dir, file) => {
    const rel = path.relative(folderOf(dir), path.resolve(file));
    if (!rel || rel.includes(path.sep) || rel.startsWith('..') || path.isAbsolute(rel) || !/\.zip$/i.test(rel)) throw fail('That is not a backup of this server', 'notBackup');
    return path.join(folderOf(dir), rel);
  };
  async function remove(dir, file) {
    const f = inFolder(dir, file);
    if (jobs.get(keyOf(dir))?.file === f) throw fail('That backup is being used', 'busy');
    await trash(f);
    return true;
  }
  async function keep(dir, file, on) {
    const f = inFolder(dir, file);
    const m = NAME.exec(path.basename(f));
    if (!m) throw fail('Only a backup Nano Studio made can be marked', 'notBackup');
    const to = path.join(folderOf(dir), path.basename(f).replace(/(_keep)?\.zip$/, on ? '_keep.zip' : '.zip'));
    if (to !== f) await rename(f, to);
    return to;
  }

  // ---------- restoring one ----------
  // Every entry read and checked against its CRC and size. -> {entries, manifest}
  async function verify(file, j) {
    const a = await openArchive(file, path.basename(file));
    try {
      const manifestEntry = a.entries[0]?.name === MANIFEST ? a.entries[0] : null;
      if (!manifestEntry) throw fail(`${path.basename(file)} is not a Nano Studio backup (no ${MANIFEST})`, 'notBackup');
      j.phase = 'verifying';
      j.total = a.entries.reduce((s, e) => s + e.packed, 0);
      j.done = 0;
      tick(j, true);
      let manifest = null;
      for (const e of a.entries) {
        const parts = e === manifestEntry ? [] : null;
        await a.stream(e, async (c) => { parts?.push(c); }, { signal: j.ctl.signal, onBytes: (n) => { j.done += n; tick(j); } });
        if (parts) manifest = JSON.parse(Buffer.concat(parts).toString('utf8'));
      }
      return { entries: a.entries, manifest };
    } finally { await a.close(); }
  }
  // The journal of a restore's swap, so that one cut off (the app died) is undone by the next run: what was moved where.
  const workOf = (dir) => path.join(dir, WORK);
  const journalOf = (dir) => path.join(workOf(dir), 'journal.json');
  const writeJournal = (dir, j) => fs.writeFileSync(journalOf(dir), JSON.stringify(j));
  // Puts every item back as it was before the swap: the new copy back into new/, the old one back in place.
  async function undoSwap(dir, journal) {
    const work = workOf(dir);
    for (const rel of [...journal.swapped].reverse()) {
      const live1 = path.join(dir, rel);
      const fresh = path.join(work, 'new', rel);
      const old = path.join(work, 'old', rel);
      if (exists(live1) && !exists(fresh) && (journal.had.includes(rel) ? exists(old) : true)) {
        await fs.promises.mkdir(path.dirname(fresh), { recursive: true });
        await rename(live1, fresh);
      }
      if (exists(old) && !exists(live1)) await rename(old, live1);
    }
  }
  // A restore cut off before it ended: its swap undone, its work folder gone. Nothing to do when there is none.
  async function recover(dir) {
    const work = workOf(dir);
    if (!exists(work) || jobs.has(keyOf(dir))) return false;
    const journal = readJson(journalOf(dir));
    if (journal?.stage === 'swapping') await undoSwap(dir, journal);
    await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 5 });
    return true;
  }

  async function restore(dir, file, { worldOnly = false, job } = {}) {
    const f = inFolder(dir, file);
    if (deps.isRunning(dir) || live.has(keyOf(dir))) throw fail(`Stop ${path.basename(dir)} first: a running server keeps writing the world it would be given back`, 'running');
    if (await deps.leftOver?.(dir)) throw fail(`${path.basename(dir)} is running outside this window: stop it first`, 'leftOver');
    await recover(dir);
    const j = claim(dir, 'restore', null, job);
    j.file = f;
    let safety = null;
    try {
      const { entries, manifest } = await verify(f, j);
      const wanted = (manifest.items || []).filter((i) => i && typeof i.rel === 'string' && canonical(i.rel) && (!worldOnly || i.kind === 'world'));
      if (!wanted.some((i) => i.kind === 'world')) throw fail(`${path.basename(f)} holds no world`, 'noWorld');
      // pyide-server.json describes the jars, which a backup leaves out: only the memory and Java options come back.
      const items = wanted.filter((i) => i.rel !== SERVER);
      const serverDesc = !worldOnly && wanted.some((i) => i.rel === SERVER);
      const itemOf = (name) => items.find((i) => name === i.rel || (i.dir && name.startsWith(`${i.rel}/`))) || null;
      const take = entries.filter((e) => e.name !== MANIFEST && canonical(e.name.replace(/\/$/, '')) && (itemOf(e.name.replace(/\/$/, '')) || (serverDesc && e.name === SERVER)));
      const need = take.reduce((s, e) => s + e.size, 0);
      const free = await freeSpace(dir);
      // Room for the unpacked copy beside the world and for the backup of what is there now.
      if (free < need * 2 + 64 * 1048576) throw fail(`There is not enough free space to restore ${path.basename(f)}: it needs about ${mb(need * 2)} (the restored files and a backup of the current ones), and the disk has ${mb(free)} free`, 'space', { need: need * 2, free });

      // What is there now, kept first: a restore that turns out wrong can itself be undone.
      j.phase = 'safety';
      tick(j, true);
      try { safety = await packServer(dir, { ...j, as: 'safety', done: 0, total: 0, sentAt: 0 }, 'restore'); } catch (err) {
        if (err.code !== 'noWorld') throw fail(`The current world could not be backed up first, so nothing was restored: ${err.message}`, err.code === 'cancelled' ? 'cancelled' : 'safety', { cause: err.code || null, entry: err.entry, need: err.need, free: err.free });
      }
      report(j, { safety: safety?.file ?? null });

      const work = workOf(dir);
      await fs.promises.rm(work, { recursive: true, force: true });
      await fs.promises.mkdir(path.join(work, 'new'), { recursive: true });
      await fs.promises.mkdir(path.join(work, 'old'), { recursive: true });
      const journal = { backup: path.basename(f), stage: 'unpacking', items: items.map((i) => i.rel), swapped: [], had: [] };
      writeJournal(dir, journal);
      j.phase = 'unpacking';
      j.total = take.reduce((s, e) => s + e.packed, 0);
      j.done = 0;
      tick(j, true);
      const a = await openArchive(f, path.basename(f));
      try {
        for (const e of take) {
          const out = path.join(work, 'new', ...e.name.replace(/\/$/, '').split('/'));
          if (e.dir) { await fs.promises.mkdir(out, { recursive: true }); continue; }
          await fs.promises.mkdir(path.dirname(out), { recursive: true });
          const fh = await fs.promises.open(out, 'w');
          try {
            let at = 0;
            await a.stream(e, async (c) => { await fh.write(c, 0, c.length, at); at += c.length; }, { signal: j.ctl.signal, onBytes: (n) => { j.done += n; tick(j); } });
          } finally { await fh.close(); }
          await fs.promises.utimes(out, new Date(e.mtime), new Date(e.mtime)).catch(() => {});
        }
      } finally { await a.close(); }
      // A folder that only became an item when the backup was made may have no entries of its own (an empty world).
      for (const i of items) if (i.dir) await fs.promises.mkdir(path.join(work, 'new', i.rel), { recursive: true });
      // Jars the backup left out of a plugin's folder go on living in it.
      for (const i of items.filter((x) => x.dir && x.rel.startsWith('plugins/'))) await carryJars(path.join(dir, i.rel), path.join(work, 'new', i.rel));

      j.phase = 'swapping';
      tick(j, true);
      journal.stage = 'swapping';
      writeJournal(dir, journal);
      try {
        for (const i of items) {
          if (j.ctl.signal.aborted) throw fail('Cancelled', 'cancelled');
          const live1 = path.join(dir, i.rel);
          const fresh = path.join(work, 'new', i.rel);
          if (!exists(fresh)) continue;
          const had = exists(live1);
          if (had) {
            await fs.promises.mkdir(path.dirname(path.join(work, 'old', i.rel)), { recursive: true });
            journal.had.push(i.rel);
          }
          journal.swapped.push(i.rel);
          writeJournal(dir, journal);
          if (had) await rename(live1, path.join(work, 'old', i.rel));
          await fs.promises.mkdir(path.dirname(live1), { recursive: true });
          await rename(fresh, live1);
        }
      } catch (err) {
        await undoSwap(dir, journal);
        await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
        if (err.code === 'cancelled') throw err;
        throw fail(`The restore stopped half-way (${err.code || err.message}), and everything was put back as it was`, 'swap');
      }
      journal.stage = 'done';
      writeJournal(dir, journal);
      const kept = [];
      if (serverDesc) {
        const was = JSON.parse(fs.readFileSync(path.join(work, 'new', SERVER), 'utf8'));
        const desc = deps.readServer(dir);
        if (desc) deps.writeServer(dir, { ...desc, ...(was.memory && { memory: was.memory }), ...('jvmArgs' in was ? { jvmArgs: was.jvmArgs } : {}) });
        kept.push(SERVER);
      }
      // World only: the server opens the world the backup had, under its own name.
      if (worldOnly && manifest.levelName && deps.readProps(path.join(dir, 'server.properties'))['level-name'] !== manifest.levelName) {
        deps.writeProps(path.join(dir, 'server.properties'), { 'level-name': manifest.levelName });
      }
      await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      const r = { restored: items.filter((i) => journal.swapped.includes(i.rel)).map((i) => i.rel), kept, safety: safety?.file ?? null, levelName: manifest.levelName, mc: manifest.mc };
      report(j, { state: 'done', ...r });
      // The Players tab reads the lists (whitelist, operators, bans) again.
      send('minecraft:players', { dir, kind: 'roster' });
      return r;
    } catch (err) {
      const cancelled = err.code === 'cancelled';
      report(j, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : err.message, code: cancelled ? 'cancelled' : err.code || null, safety: safety?.file ?? null, ...details(err) });
      if (cancelled) throw fail('Cancelled', 'cancelled');
      throw err;
    } finally { release(j); }
  }
  async function carryJars(from, to) {
    if (!isDir(from)) return;
    for (const d of await fs.promises.readdir(from, { withFileTypes: true })) {
      const a = path.join(from, d.name);
      const b = path.join(to, d.name);
      if (d.isDirectory()) await carryJars(a, b);
      else if (d.isFile() && leftOutJar(d.name) && !exists(b)) {
        await fs.promises.mkdir(to, { recursive: true });
        await fs.promises.copyFile(a, b);
      }
    }
  }

  // ---------- while it runs, and when it stops ----------
  const lastAt = async (dir) => (await list(dir)).items.find((b) => !b.damaged)?.created ?? 0;
  const quiet = (p) => p.catch(() => null);
  function arm(dir) {
    const k = keyOf(dir);
    const held = live.get(k);
    if (!held) return;
    clearTimeout(held.timer);
    const p = policy(dir);
    if (!p.every) return;
    const check = async () => {
      if (live.get(k) !== held || quitting || held.proc.stopAsked) return;
      const due = (await lastAt(dir)) + p.every * 3600 * 1000;
      if (now() >= due && !jobs.has(k)) await quiet(backup(dir, { reason: 'schedule' }));
      if (live.get(k) === held) {
        held.timer = setTimeout(check, Math.max(60000, Math.min(due - now(), 3600 * 1000)));
        held.timer.unref?.();
      }
    };
    held.timer = setTimeout(check, deps.firstCheckMs ?? 60000);
    held.timer.unref?.();
  }
  // A server process started for dir: the schedule runs while it lives, and a backup follows its end when the last one is
  // more than a day old (not when the app is quitting, and not when the folder starts again at once: a restart).
  function attach(dir, proc) {
    const k = keyOf(dir);
    const held = { proc, timer: null };
    live.set(k, held);
    arm(dir);
    proc.once?.('stopAsked', () => clearTimeout(held.timer));
    proc.once('close', () => {
      if (live.get(k) !== held) return;
      clearTimeout(held.timer);
      live.delete(k);
      if (quitting || !policy(dir).every) return;
      const later = setTimeout(async () => {
        if (quitting || live.has(k) || jobs.has(k)) return;
        if (now() - (await lastAt(dir)) > DAY) await quiet(backup(dir, { reason: 'stop' }));
      }, deps.stopDelayMs ?? 20000);
      later.unref?.();
    });
  }
  // Before a start: a restore cut off is undone; a backup made because the server stopped gives way (it is a restart); any
  // other backup or restore holds the folder, and the start is refused saying why.
  async function beforeStart(dir) {
    const j = jobs.get(keyOf(dir));
    if (j?.op === 'backup' && j.reason === 'stop') {
      j.ctl.abort();
      for (let i = 0; i < 100 && jobs.get(keyOf(dir)) === j; i++) await new Promise((r) => { setTimeout(r, 50); });
    } else if (j) {
      throw fail(j.op === 'restore' ? `${path.basename(dir)} is being restored: start it once that is done` : `${path.basename(dir)} is being backed up${j.total ? ` (${Math.floor((j.done / j.total) * 100)}%)` : ''}: start it once that is done, or cancel the backup`, 'busy');
    }
    await recover(dir);
  }
  function shutdown() {
    quitting = true;
    for (const held of live.values()) clearTimeout(held.timer);
    for (const j of jobs.values()) j.ctl.abort();
  }
  function connect(ctx) {
    if (ctx.send) send = ctx.send;
    if (ctx.trash) trash = ctx.trash;
  }

  return { list, newest, backup, restore, cancel, remove, keep, policy, setPolicy, attach, beforeStart, shutdown, connect, prune, recover, verify: (file) => verify(file, { ctl: new AbortController(), sentAt: 0 }) };
}

// The IPC of the Backups tab. at(root, dir) throws unless dir is a trusted project's server.
function registerIpc(ipcMain, backups, at) {
  const h = (name, fn) => ipcMain.handle(`minecraft:${name}`, fn);
  // A backup or restore that does not happen is an answer the window words itself ({ok: false, code, error, ...}): an
  // IPC error would arrive as English text only.
  const answer = (step) => step().then((r) => ({ ok: true, ...r }), (err) => {
    if (!err.expected) throw err;
    return { ok: false, code: err.code || null, error: err.message, ...details(err) };
  });
  h('backups', (_e, root, dir) => { at(root, dir); return backups.list(dir); });
  h('backupNow', (_e, root, dir, opts) => { at(root, dir); return answer(() => backups.backup(dir, { reason: REASONS[opts?.reason] ? opts.reason : 'manual', job: opts?.job })); });
  h('backupRestore', (_e, root, dir, file, opts) => { at(root, dir); return answer(() => backups.restore(dir, file, { worldOnly: !!opts?.worldOnly, job: opts?.job })); });
  h('backupCancel', (_e, job) => backups.cancel(job));
  h('backupDelete', (_e, root, dir, file) => { at(root, dir); return backups.remove(dir, file); });
  h('backupKeep', (_e, root, dir, file, on) => { at(root, dir); return backups.keep(dir, file, !!on); });
  h('backupPolicy', (_e, root, dir, p) => { at(root, dir); return p ? backups.setPolicy(dir, p) : backups.policy(dir); });
}

module.exports = { createBackups, registerIpc, holdSaves, REASONS, POLICY, MANIFEST };
