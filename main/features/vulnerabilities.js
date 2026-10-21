// Vulnerable packages: the installed packages and the versions the project's dependency files stand for, checked
// against OSV (https://api.osv.dev; PYIDE_OSV_URL overrides the base, `off` turns lookups off) with querybatch and
// /v1/vulns/{id}. Answers are cached in <userData>/vulnerabilities/osv-cache.json for 24 hours per package@version
// and per advisory, so a package is asked about at most once a day unless the user checks by hand. Network errors
// never throw: the result carries `error` and whatever the cache knows.
const fs = require('fs');
const path = require('path');
const osv = require('../packages/osv');

const TTL = 24 * 60 * 60 * 1000;
const BATCH = 1000; // OSV's limit per querybatch
const TIMEOUT = 20000;

// The cache: {queries: {key: {at, ids: [id]}}, vulns: {id: {at, data: advisory}}}. Tables have no prototype, so an
// advisory id or a key read from the file such as "__proto__" is just a key.
const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const validQuery = (e) => isObject(e) && Number.isFinite(e.at) && Array.isArray(e.ids) && e.ids.every((id) => typeof id === 'string');
const validVuln = (e) => isObject(e) && Number.isFinite(e.at) && isObject(e.data);
const table = (from, valid) => {
  const out = Object.create(null);
  if (isObject(from)) for (const [k, v] of Object.entries(from)) if (valid(v)) out[k] = v;
  return out;
};
const emptyCache = () => ({ queries: table(), vulns: table() });

// A damaged or hand-edited file loses the entries that are not well formed (null, no `at`, no `ids`...); an
// unreadable one is an empty cache.
function loadCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { queries: table(c?.queries, validQuery), vulns: table(c?.vulns, validVuln) };
  } catch { return emptyCache(); }
}

// Entries a week past their time are dropped (expired ones still answer while offline). The file is replaced
// atomically, so a crash or a full disk mid-write leaves the previous cache, never half a file.
function saveCache(file, cache, now = Date.now()) {
  for (const t of [cache.queries, cache.vulns]) for (const [k, v] of Object.entries(t)) if (!(now - v?.at < 7 * TTL)) delete t[k];
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

exports.loadCache = loadCache;
exports.saveCache = saveCache;

exports.register = (ctx) => {
  const { ipcMain, app } = ctx;
  const base = () => (process.env.PYIDE_OSV_URL || 'https://api.osv.dev').replace(/\/+$/, '');
  const file = path.join(app.getPath('userData'), 'vulnerabilities', 'osv-cache.json');

  let cache = null;
  const load = () => (cache ||= loadCache(file));
  const save = () => saveCache(file, cache);
  const fresh = (entry) => !!entry && Number.isFinite(entry.at) && Date.now() - entry.at < TTL;
  const idsOf = (key) => (Array.isArray(cache.queries[key]?.ids) ? cache.queries[key].ids : []);

  async function request(url, init) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) throw new Error(`OSV ${r.status} ${r.statusText}`.trim());
    return r.json();
  }

  // [{name, version}] -> fills cache.queries; throws on a network or server error.
  async function queryBatch(items) {
    for (let i = 0; i < items.length; i += BATCH) {
      const part = items.slice(i, i + BATCH);
      const body = { queries: part.map((p) => ({ package: { name: p.name, ecosystem: 'PyPI' }, version: p.version })) };
      const r = await request(`${base()}/v1/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const results = Array.isArray(r?.results) ? r.results : [];
      const at = Date.now();
      part.forEach((p, j) => {
        const ids = (results[j]?.vulns || []).map((v) => v?.id).filter((id) => typeof id === 'string');
        cache.queries[osv.keyOf(p.name, p.version)] = { at, ids };
      });
    }
  }

  // Advisory details, six at a time. A failed one is left out (its id is still shown).
  async function fetchVulns(ids) {
    let failed = null;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const data = await request(`${base()}/v1/vulns/${encodeURIComponent(id)}`);
          if (!isObject(data)) throw new Error('OSV sent an advisory that is not an object');
          cache.vulns[id] = { at: Date.now(), data };
        } catch (err) { failed ??= err; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
    if (failed) throw failed;
  }

  // payload: {root, installed: [{name, version}], files: ide.dependencies files, lock: 'uv.lock'|'poetry.lock'|null,
  //           network: may ask OSV, force: ask even what the cache knows}
  // -> {packages: [{key, name, version, vulns: [summary], fixed}], requirements: [{path, kind, line, col, endCol, raw,
  //     name, version, from, key}], queried, error}
  ipcMain.handle('vulnerabilities:check', async (_e, payload = {}) => {
    load();
    let locked = null;
    if (payload.root && payload.lock && /^(uv|poetry)\.lock$/.test(payload.lock)) {
      try { locked = osv.parseLock(fs.readFileSync(path.join(payload.root, payload.lock), 'utf8')); } catch {}
    }
    const wanted = new Map(); // key -> {name, version}
    const add = (name, version) => {
      if (typeof name !== 'string' || !version || !/^[A-Za-z0-9]/.test(name)) return null;
      const key = osv.keyOf(name, version);
      if (!wanted.has(key)) wanted.set(key, { name, version: String(version).trim() });
      return key;
    };
    for (const p of payload.installed || []) add(p.name, p.version);
    const reqs = [];
    for (const f of payload.files || []) {
      for (const r of f.reqs || []) {
        const v = osv.requirementVersion(r, locked);
        if (!v) continue;
        reqs.push({ path: f.path, kind: f.kind, line: r.line, col: r.col, endCol: r.endCol, raw: r.raw, name: r.name, version: v.version, from: v.from, key: add(r.name, v.version) });
      }
    }

    let error = null;
    let queried = 0;
    // PYIDE_OSV_URL=off (the test default): never online; only a manual check says so.
    if (payload.network && /^off$/i.test(process.env.PYIDE_OSV_URL || '')) {
      if (payload.force) error = 'OSV lookups are off (PYIDE_OSV_URL=off)';
    } else if (payload.network) {
      const ask = [...wanted.entries()].filter(([k]) => payload.force || !fresh(cache.queries[k])).map(([, p]) => p);
      try {
        if (ask.length) { queried = ask.length; await queryBatch(ask); }
        const ids = new Set([...wanted.keys()].flatMap(idsOf));
        const missing = [...ids].filter((id) => payload.force || !fresh(cache.vulns[id]));
        if (missing.length) await fetchVulns(missing);
      } catch (err) {
        error = err?.name === 'TimeoutError' ? 'the request timed out' : String(err?.cause?.message || err?.message || err);
      }
      save();
    }

    const packages = [];
    for (const [key, p] of wanted) {
      const ids = idsOf(key);
      if (!ids.length) continue;
      const data = ids.map((id) => (isObject(cache.vulns[id]?.data) ? cache.vulns[id].data : { id }));
      packages.push({ key, name: p.name, version: p.version, vulns: data.map((d) => osv.summarize(d, p.name)), fixed: osv.firstFixed(data, p.name, p.version) });
    }
    const byKey = new Map(packages.map((p) => [p.key, p]));
    const requirements = reqs.filter((r) => byKey.has(r.key));
    const unknown = [...wanted.keys()].filter((k) => !cache.queries[k]).length;
    return { packages, requirements, queried, unknown, error };
  });

  // The "Upgrade to <fixed>" quick fix: {kind, text: the requirement as the editor holds it now (requirements.txt:
  // from its name to the end of its continuation lines), raw: as it was checked, fixed} -> the new text, or null when
  // there is nothing safe to offer (see osv.upgradeRequirement).
  ipcMain.handle('vulnerabilities:upgrade', (_e, p) => {
    try { return osv.upgradeSource(isObject(p) ? p : {}); } catch { return null; }
  });

  // For tests and the Settings page: forget every cached answer.
  ipcMain.handle('vulnerabilities:clearCache', () => { cache = emptyCache(); save(); return true; });
};
