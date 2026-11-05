// Project files (.ncut), autosaves and the session markers that tell a crash from a clean close.
//
// Autosaves are <autosave>/<name>-<hash>-<stamp>.ncut: <name> is the project's file name (or the untitled key), <hash>
// the first 8 hex digits of the SHA-1 of the key (a project path in lower case, or the untitled key), so two projects
// of one name in different folders keep their own 20, and <stamp> the UTC time to the millisecond, kept increasing
// within a run. A session marker is <autosave>/.sessions/<pid>-<run>-<hash>.json ({pid, run, started, key, since,
// saved, crashed}); it is removed when the session ends, when its window closes normally, or when the user dismisses
// the recovery. A marker whose run is gone (or whose window's renderer crashed) is a session that never ended:
// recovery offers its newest autosave when that autosave is newer than both the session's start and its last save.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NCUT_TEXT_LIMIT } = require('./limits');
const { fail, localPath, realFile, writableFile } = require('./paths');

const KEEP = 20;
const NCUT = new Set(['ncut']);
const AUTOSAVE = /-([0-9a-f]{8})-(\d{8}-\d{6}-\d{3})\.ncut$/;
const MARKER = /^\d+-[0-9a-f]+-[0-9a-f]{8}\.json$/;
const MAX_AGE_MS = 30 * 24 * 3600000;
const MAX_KEY = 1024;
const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Windows refuses a rename for a moment while another program (a virus scanner, the search indexer) has the target open.
async function renameOver(from, to) {
  for (let i = 0; ; i++) {
    try { return await fs.promises.rename(from, to); } catch (err) {
      if (!RETRY.has(err.code) || i >= 8) throw err;
      await sleep(50 * (i + 1));
    }
  }
}
async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await renameOver(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
const readJson = async (file) => { try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; } };
const list = async (dir) => { try { return await fs.promises.readdir(dir); } catch { return []; } };
const versionOf = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v.version ?? null : undefined; } catch { return undefined; } };

const keyId = (key) => {
  const local = localPath(key);
  return local.error ? key : local.path.toLowerCase();
};
const hashOf = (key) => crypto.createHash('sha1').update(keyId(key)).digest('hex').slice(0, 8);
const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 60) || 'project';
const nameOf = (key) => safeName(localPath(key).error ? key : path.basename(key).replace(/\.ncut$/i, ''));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stampOf = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${pad(d.getUTCMilliseconds(), 3)}`;
};
const timeOfStamp = (s) => {
  const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-(\d{3})$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : NaN;
};

function createProjects({ autosaveDir, run, log }) {
  const sessionsDir = path.join(autosaveDir, '.sessions');
  const own = new Map(); // key hash -> {key, file, owners: Set of webContents ids, since, saved}
  let lastStamp = 0;
  const nextStamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));
  const badKey = (key) => typeof key !== 'string' || !key || key.length > MAX_KEY;
  const badText = (text) => typeof text !== 'string' || text.length > NCUT_TEXT_LIMIT;

  async function projectRead(p) {
    const file = await realFile(p, NCUT);
    if (file.code === 'missing') return { missing: true };
    if (file.error) return file;
    if (file.stat.size > NCUT_TEXT_LIMIT) return fail('tooLarge', 'the project file is too large');
    try {
      return { text: (await fs.promises.readFile(file.real, 'utf8')).replace(/^﻿/, ''), path: file.real, mtime: file.stat.mtimeMs };
    } catch (err) {
      return err.code === 'ENOENT' ? { missing: true } : fail('io', err.message);
    }
  }

  // The previous file is kept as <name>.ncut.bak when the new text has another format version than it (a migration
  // the user may want to undo), or when it is not a project this version can read.
  async function projectWrite(p, text) {
    if (badText(text)) return fail('badArgs', 'not a project text');
    const version = versionOf(text);
    if (version === undefined) return fail('badArgs', 'not a project text');
    const target = await writableFile(p, NCUT);
    if (target.error) return target;
    let bak = null;
    try {
      const st = await fs.promises.stat(target.path);
      const old = st.size <= NCUT_TEXT_LIMIT ? await fs.promises.readFile(target.path, 'utf8').catch(() => null) : null;
      if (old === null || versionOf(old.replace(/^﻿/, '')) !== version) {
        bak = `${target.path}.bak`;
        const tmp = `${bak}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fs.promises.copyFile(target.path, tmp);
        await renameOver(tmp, bak);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') return fail('io', `the previous version could not be kept: ${err.message}`);
    }
    try { await writeAtomic(target.path, text); } catch (err) { return fail('io', err.message); }
    const session = own.get(hashOf(target.path)) || own.get(hashOf(p));
    if (session) {
      session.saved = Date.now();
      await writeMarker(session).catch(() => {});
    }
    return { ok: true, path: target.path, bak };
  }

  // Autosaves of one key (by its hash), newest first: [{file, time}].
  async function autosavesOf(hash) {
    const out = [];
    for (const name of await list(autosaveDir)) {
      const m = AUTOSAVE.exec(name);
      if (m && m[1] === hash) out.push({ file: path.join(autosaveDir, name), time: timeOfStamp(m[2]) });
    }
    return out.sort((a, b) => b.time - a.time);
  }

  async function autosave(key, text) {
    if (badKey(key) || badText(text)) return fail('badArgs', 'autosave takes a key and the project text');
    const hash = hashOf(key);
    const file = path.join(autosaveDir, `${nameOf(key)}-${hash}-${stampOf(nextStamp())}.ncut`);
    try {
      await fs.promises.mkdir(autosaveDir, { recursive: true });
      await writeAtomic(file, text);
    } catch (err) { return fail('io', err.message); }
    for (const old of (await autosavesOf(hash)).slice(KEEP)) await fs.promises.rm(old.file, { force: true }).catch(() => {});
    return { ok: true, file };
  }

  const markerFile = (hash) => path.join(sessionsDir, `${run.pid}-${run.run}-${hash}.json`);
  async function writeMarker(s) {
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    await writeAtomic(s.file, JSON.stringify(run.mark({ key: s.key, since: s.since, saved: s.saved, crashed: !!s.crashed })));
  }
  // Markers of other runs, with their file: [{file, marker}].
  async function markers() {
    const out = [];
    for (const name of await list(sessionsDir)) {
      if (!MARKER.test(name)) continue;
      const file = path.join(sessionsDir, name);
      const marker = await readJson(file);
      if (marker && typeof marker.key === 'string') out.push({ file, marker });
      else await fs.promises.rm(file, { force: true }).catch(() => {});
    }
    return out;
  }
  const ended = (m) => !run.alive(m) || (m.run === run.run && m.crashed);

  async function sessionStart(key, owner) {
    if (badKey(key)) return fail('badArgs', 'a session takes a key');
    const hash = hashOf(key);
    // The user is back in this project: an older session of it that never ended has nothing more to offer.
    for (const { file, marker } of await markers()) {
      if (marker.run !== run.run && hashOf(marker.key) === hash && ended(marker)) await fs.promises.rm(file, { force: true }).catch(() => {});
    }
    const s = own.get(hash) || { key, file: markerFile(hash), owners: new Set(), since: Date.now(), saved: null };
    s.owners.add(owner);
    s.crashed = false;
    own.set(hash, s);
    try { await writeMarker(s); } catch (err) { return fail('io', err.message); }
    return { ok: true };
  }

  async function sessionEnd(key, owner) {
    if (badKey(key)) return fail('badArgs', 'a session takes a key');
    const hash = hashOf(key);
    const s = own.get(hash);
    if (!s) return { ok: true };
    s.owners.delete(owner);
    if (s.owners.size) return { ok: true };
    own.delete(hash);
    await fs.promises.rm(s.file, { force: true }).catch(() => {});
    return { ok: true };
  }

  // A window closed: its sessions end. A window whose renderer crashed keeps them, marked so this run offers them too.
  async function ownerGone(owner, { crashed }) {
    for (const [hash, s] of [...own]) {
      if (!s.owners.delete(owner)) continue;
      if (crashed) {
        s.crashed = true;
        await writeMarker(s).catch(() => {});
        own.delete(hash);
      } else if (!s.owners.size) {
        own.delete(hash);
        await fs.promises.rm(s.file, { force: true }).catch(() => {});
      }
    }
  }

  async function recovery() {
    const byKey = new Map();
    for (const { file, marker } of await markers()) {
      if (!ended(marker)) continue;
      const hash = hashOf(marker.key);
      const newest = (await autosavesOf(hash))[0];
      const since = Number(marker.since) || 0;
      const stale = Date.now() - (Number(marker.started) || 0) > MAX_AGE_MS;
      if (!newest || stale || newest.time < since || (marker.saved && marker.saved >= newest.time)) {
        await fs.promises.rm(file, { force: true }).catch(() => {});
        continue;
      }
      const prev = byKey.get(hash);
      if (!prev || prev.time < newest.time) byKey.set(hash, { key: marker.key, file: newest.file, time: newest.time });
    }
    return [...byKey.values()].sort((a, b) => b.time - a.time);
  }

  async function dismiss(key) {
    if (badKey(key)) return fail('badArgs', 'dismiss takes a key');
    const hash = hashOf(key);
    for (const { file, marker } of await markers()) if (hashOf(marker.key) === hash && ended(marker)) await fs.promises.rm(file, { force: true }).catch(() => {});
    return { ok: true };
  }

  // Autosaves older than 30 days go, whatever their key: untitled projects never reopened would pile up otherwise.
  async function prune() {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const name of await list(autosaveDir)) {
      const m = AUTOSAVE.exec(name);
      if (m && timeOfStamp(m[2]) < cutoff) await fs.promises.rm(path.join(autosaveDir, name), { force: true }).catch(() => {});
    }
  }
  prune().catch((err) => log?.warn?.(`autosave cleanup: ${err.message}`));

  return { projectRead, projectWrite, autosave, autosavesOf: (key) => autosavesOf(hashOf(key)), sessionStart, sessionEnd, ownerGone, recovery, dismiss };
}

module.exports = { createProjects, writeAtomic, renameOver, KEEP };
