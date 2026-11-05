// The app-wide cache: thumbnails, waveforms, proxies and render files, in one folder for every project (a project file
// that moves keeps its cache). cut:cacheGet/Put entries are <dir>/entries/<2 hex>/<sha1 of the key>.bin; other files
// under <dir> (proxies an export sink wrote there) count too. Above the size limit the least recently used files go
// first. Use is kept in memory and in each file's mtime, so the order survives a restart.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CACHE_ENTRY_LIMIT } = require('./limits');
const { fail, isInside } = require('./paths');
const { asBytes } = require('./sink');
const { writeAtomic } = require('./project');

const MAX_KEY = 4096;
const SKIP = /\.(part|tmp)$/i;

function createCache({ dir, limit, busy = () => [], log }) {
  const index = new Map(); // lower-case path -> {file, size, used}
  let total = 0;
  let loading = null;
  let lastUse = 0;
  const now = () => (lastUse = Math.max(Date.now(), lastUse + 1));
  const fileOf = (key) => {
    const h = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(dir, 'entries', h.slice(0, 2), `${h}.bin`);
  };
  const forget = (k) => {
    const e = index.get(k);
    if (!e) return;
    total -= e.size;
    index.delete(k);
  };
  const remember = (file, size, used) => {
    const k = file.toLowerCase();
    forget(k);
    index.set(k, { file, size, used });
    total += size;
  };

  async function walk(d, depth) {
    let ents = [];
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (ent.isFile() && !SKIP.test(ent.name)) {
        try {
          const st = await fs.promises.stat(p);
          remember(p, st.size, st.mtimeMs);
        } catch {}
      }
    }
  }
  const ready = () => (loading ||= fs.promises.mkdir(dir, { recursive: true }).then(() => walk(dir, 0)));

  async function touch(k) {
    const e = index.get(k);
    if (!e) return;
    e.used = now();
    const t = new Date(e.used);
    await fs.promises.utimes(e.file, t, t).catch(() => {});
  }

  // Oldest use first until the cache fits; `keep` (the file just added) and part files being written stay.
  async function evict(keep) {
    const max = limit();
    if (total <= max) return;
    const protectedFiles = new Set([keep, ...busy()].filter(Boolean).map((f) => f.toLowerCase()));
    for (const [k, e] of [...index].sort((a, b) => a[1].used - b[1].used)) {
      if (total <= max) break;
      if (protectedFiles.has(k)) continue;
      try { await fs.promises.rm(e.file, { force: true }); forget(k); } catch (err) { log?.warn?.(`cache: cannot remove ${e.file}: ${err.message}`); }
    }
  }

  const badKey = (key) => typeof key !== 'string' || !key || key.length > MAX_KEY;

  async function get(key) {
    if (badKey(key)) return null;
    await ready();
    const file = fileOf(key);
    const k = file.toLowerCase();
    if (!index.has(k)) return null;
    let data;
    try { data = await fs.promises.readFile(file); } catch {
      forget(k);
      return null;
    }
    await touch(k);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async function put(key, bytes) {
    if (badKey(key)) return fail('badArgs', 'a cache entry takes a key');
    const data = asBytes(bytes);
    if (!data || data.byteLength > CACHE_ENTRY_LIMIT) return fail('badArgs', 'not bytes, or too many for one entry');
    if (data.byteLength > limit()) return fail('tooLarge', 'the entry is larger than the cache limit');
    await ready();
    const file = fileOf(key);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, data);
    } catch (err) { return fail(err.code === 'ENOSPC' ? 'diskFull' : 'io', err.message); }
    remember(file, data.byteLength, now());
    const t = new Date(index.get(file.toLowerCase()).used);
    await fs.promises.utimes(file, t, t).catch(() => {});
    await evict(file);
    return { ok: true };
  }

  // A file written into the cache folder some other way (a proxy through the export sink).
  async function added(file) {
    if (!isInside(dir, file)) return;
    await ready();
    try {
      const st = await fs.promises.stat(file);
      remember(file, st.size, now());
      await touch(file.toLowerCase());
    } catch { return; }
    await evict(file);
  }
  // A cache file read through cut:read counts as a use.
  async function used(file) {
    if (!isInside(dir, file)) return;
    await ready();
    await touch(file.toLowerCase());
  }

  async function info() {
    await ready();
    return { bytes: total, files: index.size, limit: limit(), dir };
  }

  async function clear() {
    await ready();
    const keep = new Set(busy().map((f) => f.toLowerCase()));
    for (const [k, e] of [...index]) {
      if (keep.has(k)) continue;
      try { await fs.promises.rm(e.file, { force: true }); forget(k); } catch {}
    }
    return { ok: true, ...(await info()) };
  }

  return { get, put, added, used, info, clear, evict };
}

module.exports = { createCache };
