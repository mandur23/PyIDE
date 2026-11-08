// The Minecraft window's Market: Modrinth's modpacks, mods, plugins and resource packs, searched for what a server
// runs (its Minecraft version and loader or plugin API) and installed into it with the dependencies the project
// requires, each file checked against the SHA-512 or SHA-1 Modrinth publishes. What the Market installed is recorded
// in the server's pyide-server.json (market: {projectId: {title, version, files, needs, dependency, packLang}}), so it
// shows as installed and Remove takes it out with the dependencies nothing else needs.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KINDS, HEADERS, getJson, modrinthApi } = require('./sources');
const { unpackZip } = require('./zipfile');

const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw fail(`${url}: HTTP ${res.status}`);
  return res.json();
}
// rel under dir, or null when it names a path outside it.
const inside = (dir, rel) => { if (typeof rel !== 'string') return null; const p = path.resolve(dir, rel); return p.startsWith(path.resolve(dir) + path.sep) ? p : null; };
const q = (v) => encodeURIComponent(JSON.stringify(v));
const SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const MODPACK_LOADERS = ['fabric', 'forge', 'neoforge'];

// The Korean that translate.js writes for the server's mods lives in its resource pack, and outlives the pack: one that
// replaces it, or Remove, keeps those files. A pack's own ko_kr.json goes with it while it is as the pack shipped it
// (own: rel -> sha1, recorded at install as packLang); one our lines were merged into differs, and stays. A record
// from before packLang keeps them all.
const LANG = /^assets\/[a-z0-9_.-]+\/lang\/ko_kr\.json$/;
const filesIn = (dir, at = '') => fs.readdirSync(path.join(dir, at), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? filesIn(dir, `${at}${e.name}/`) : [`${at}${e.name}`]));
const sha1Of = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const packLangs = (pack) => Object.fromEntries(filesIn(pack).filter((f) => LANG.test(f)).map((f) => [f, sha1Of(path.join(pack, f))]));
const shipped = (pack, rel, own) => !!own && typeof own === 'object' && Object.hasOwn(own, rel) && own[rel] === sha1Of(path.join(pack, rel));
const translations = (pack, own = null) => (fs.existsSync(pack) ? filesIn(pack).filter((f) => LANG.test(f) && !shipped(pack, f, own)) : []);
// A pack folder of translations and the pack.mcmeta that makes them a pack (translate.js makes it so) is no pack of the
// user's: another may take its place.
const onlyTranslations = (pack) => !fs.existsSync(pack) || filesIn(pack).every((f) => f === 'pack.mcmeta' || LANG.test(f));
const langOf = (file) => {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
};
// A folder another program has open (a terminal inside it, a file a scanner reads) can be neither renamed nor wholly
// deleted on Windows, and a delete that stops part-way leaves half of it. So the old folder moves aside first, and a
// move that fails has changed nothing; then staging (when given) moves in, and the old folder is deleted last. If
// staging cannot move in, the old folder goes back. A brief hold is waited out.
const LOCKED = ['EPERM', 'EBUSY', 'EACCES'];
function renameRetried(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (i === 4 || !LOCKED.includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
function replaceFolder(folder, staging) {
  const aside = fs.existsSync(folder) ? `${folder}.old-${crypto.randomBytes(4).toString('hex')}` : null;
  if (aside) {
    try { renameRetried(folder, aside); } catch (err) {
      if (!LOCKED.includes(err.code)) throw err;
      throw fail(`${folder} is in use (${err.code}): close what has it open (a terminal or a window in that folder) and try again. Nothing was changed`, 'inUse');
    }
  }
  if (staging) {
    try { renameRetried(staging, folder); } catch (err) {
      if (!aside) throw err;
      try { renameRetried(aside, folder); } catch { throw fail(`${folder} could not be replaced (${err.code || err.message}), and the old one could not be put back: it is in ${aside}`); }
      throw err;
    }
  }
  // Out of the way already: a file of it still held leaves only that folder behind.
  if (aside) try { fs.rmSync(aside, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
// The server's resource pack (dir/resourcepack) becomes the folder staging, with the translations of the old one: a
// language file the new pack has too keeps the new pack's lines and gains ours.
function swapPack(dir, staging, own = null) {
  const folder = path.join(dir, 'resourcepack');
  for (const rel of translations(folder, own)) {
    const from = path.join(folder, rel);
    const to = path.join(staging, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!fs.existsSync(to)) { fs.copyFileSync(from, to); continue; }
    const ours = langOf(from);
    if (!ours) throw fail(`${from} is not valid JSON: fix it, or move it away, before the resource pack is replaced (Nano Studio does not write over its lines)`);
    fs.writeFileSync(to, `${JSON.stringify({ ...ours, ...langOf(to) }, null, 2)}\n`);
  }
  replaceFolder(folder, staging);
}
// The server's resource pack taken out: its translations stay, with its pack.mcmeta, which is for the server's version.
function dropPack(dir, own = null) {
  const folder = path.join(dir, 'resourcepack');
  const keep = translations(folder, own);
  if (!keep.length) return replaceFolder(folder, null);
  const staging = path.join(dir, 'resourcepack.part');
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const rel of [...keep, 'pack.mcmeta'].filter((f) => fs.existsSync(path.join(folder, f)))) {
      fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
      fs.copyFileSync(path.join(folder, rel), path.join(staging, rel));
    }
    replaceFolder(folder, staging);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
// The Market's project whose file is the server's resource pack, if any.
const packOwner = (market) => Object.keys(market || {}).find((k) => market[k]?.files?.includes('resourcepack')) || null;

// The Modrinth loader names a server takes projects for: mods for its loader, plugins for its API (Paper runs Spigot
// and Bukkit plugins too, Purpur also Paper's), and resource packs for any server but a proxy; and the Minecraft
// versions they must be for (none for a Velocity proxy, whose version is Velocity's own and runs any Minecraft's).
function targetOf(desc, type) {
  const k = KINDS[desc.kind];
  if (!k) throw fail(`Unknown server kind ${desc.kind}`);
  if (type === 'resourcepack') {
    if (k.proxy) throw fail('A proxy sends no resource pack: install it on the server players play on');
    return { loaders: ['minecraft'], folder: 'resourcepack', versions: [desc.mc] };
  }
  if (type === 'mod') {
    if (!k.mods) throw fail(`${k.title} runs no mods: install mods on a Fabric, Forge or NeoForge server`);
    return { loaders: [{ 'fabric-loader': 'fabric' }[k.mods] || k.mods], folder: 'mods', versions: [desc.mc] };
  }
  if (type === 'plugin') {
    if (!k.plugins) throw fail(`${k.title} runs no plugins: install plugins on a Paper, Purpur or Velocity server`);
    return k.proxy ? { loaders: ['velocity'], folder: 'plugins', versions: null }
      : { loaders: [...(desc.kind === 'purpur' ? ['purpur'] : []), 'paper', 'spigot', 'bukkit'], folder: 'plugins', versions: [desc.mc] };
  }
  throw fail(`Projects of type ${type} are not installed on a server`);
}

// {type, query, sort, offset, server (a server's description, for mods, plugins and resource packs), loader, mc (for
// modpacks)} -> {hits, total}.
async function search({ type, query = '', sort = 'relevance', offset = 0, server, loader, mc }) {
  const facets = [];
  if (type === 'modpack') {
    // Modpacks that run on a server only (not client-only ones such as performance packs).
    facets.push(['project_type:modpack'], ['server_side:required', 'server_side:optional'], (loader ? [loader] : MODPACK_LOADERS).map((l) => `categories:${l}`));
    if (mc) facets.push([`versions:${mc}`]);
  } else {
    if (!server) throw fail('Choose the server to install on');
    const { loaders, versions } = targetOf(server, type);
    facets.push([`project_type:${type}`]);
    if (versions) facets.push(versions.map((v) => `versions:${v}`));
    if (type !== 'resourcepack') facets.push(loaders.map((l) => `categories:${l}`));
    if (type === 'mod') facets.push(['server_side:required', 'server_side:optional']);
  }
  const index = SORTS.includes(sort) ? sort : 'relevance';
  const r = await getJson(`${modrinthApi()}/search?query=${encodeURIComponent(query)}&facets=${q(facets)}&index=${index}&offset=${Number(offset) || 0}&limit=20`);
  if (!Array.isArray(r?.hits)) throw fail('Modrinth answered the search with something Nano Studio does not understand');
  // What the window shows is text and numbers, whatever the answer holds; an icon is a web address or none.
  const text = (v) => (typeof v === 'string' ? v : '');
  const hits = r.hits.filter((h) => h && typeof h === 'object' && h.project_id).map((h) => ({
    id: String(h.project_id), slug: text(h.slug), type: text(h.project_type), title: text(h.title) || text(h.slug), author: text(h.author), description: text(h.description),
    icon: /^https?:\/\//i.test(text(h.icon_url)) ? h.icon_url : null, downloads: Number(h.downloads) || 0, follows: Number(h.follows) || 0,
    categories: (Array.isArray(h.display_categories) ? h.display_categories : Array.isArray(h.categories) ? h.categories : []).filter((c) => typeof c === 'string'),
    updated: h.date_modified, page: `https://modrinth.com/${encodeURIComponent(text(h.project_type) || 'project')}/${encodeURIComponent(text(h.slug) || String(h.project_id))}`,
  }));
  return { total: Number.isFinite(r.total_hits) ? r.total_hits : hits.length, hits };
}

// running(dir): whether the server runs. Its Java holds the jars in mods/ and plugins/ open, and Windows refuses to delete
// or replace a held file: an update or a removal then waits until the server is stopped.
function createMarket({ readServer, writeServer, fetchFile, running = () => false }) {
  const api = () => modrinthApi();
  const stopFirst = (dir, what) => fail(`Stop ${path.basename(dir)} first: while it runs, Java holds its jars, and ${what} cannot be taken out`, 'running');
  // The newest version of a project for the server, a release before a beta.
  async function versionFor(id, target) {
    const list = await getJson(`${api()}/project/${encodeURIComponent(id)}/version?loaders=${q(target.loaders)}${target.versions ? `&game_versions=${q(target.versions)}` : ''}`);
    const ok = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object');
    return ok.find((x) => x.version_type === 'release') || ok[0] || null;
  }
  const fits = (v, target) => Array.isArray(v?.loaders) && v.loaders.some((l) => target.loaders.includes(l))
    && (!target.versions || (Array.isArray(v.game_versions) && v.game_versions.some((g) => target.versions.includes(g))));
  // Checked before it lands: a file of that name already there (the user's own, or the version being updated) stays as
  // it was when the download is not what Modrinth promised.
  async function download(file, dest, log) {
    const sum = file.hashes?.sha512 ? ['sha512', file.hashes.sha512] : file.hashes?.sha1 ? ['sha1', file.hashes.sha1] : null;
    if (!sum) throw fail(`Modrinth publishes no checksum for ${file.filename}`);
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.download`;
    try {
      await fetchFile(file.url, tmp, { size: file.size }, log);
      if (crypto.createHash(sum[0]).update(fs.readFileSync(tmp)).digest('hex') !== String(sum[1]).toLowerCase()) throw fail(`Checksum mismatch for ${file.filename}`);
      fs.renameSync(tmp, dest);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  // The projects of the jars in dir/folder the Market did not install (a modpack's own, the user's), by their sha1 on
  // Modrinth: a second copy under another name stops the server from starting. -> project id -> [folder/name]. A file
  // is hashed once per size and time, a hash asked once; a lookup that fails is said and the install goes on.
  const sums = new Map(); // path|size|mtime -> sha1
  const projects = new Map(); // sha1 -> project id, or null when Modrinth does not know the file
  async function sha1File(file) {
    const st = fs.statSync(file);
    const key = `${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}`;
    if (!sums.has(key)) {
      const h = crypto.createHash('sha1');
      for await (const chunk of fs.createReadStream(file)) h.update(chunk);
      sums.set(key, h.digest('hex'));
    }
    return sums.get(key);
  }
  async function jarsIn(dir, folder, market, log) {
    const owned = new Set(Object.values(market).flatMap((e) => (Array.isArray(e?.files) ? e.files : [])).map((f) => String(f).toLowerCase()));
    let names;
    try { names = fs.readdirSync(path.join(dir, folder), { withFileTypes: true }).filter((e) => e.isFile() && /\.jar$/i.test(e.name)).map((e) => e.name); } catch { return new Map(); }
    const jars = [];
    for (const name of names) {
      if (owned.has(`${folder}/${name}`.toLowerCase())) continue;
      try { jars.push([`${folder}/${name}`, await sha1File(path.join(dir, folder, name))]); } catch {}
    }
    const unknown = [...new Set(jars.map(([, h]) => h))].filter((h) => !projects.has(h));
    if (unknown.length) {
      try {
        const r = await postJson(`${api()}/version_files`, { hashes: unknown, algorithm: 'sha1' });
        for (const h of unknown) { const pid = r && typeof r === 'object' ? r[h]?.project_id : null; projects.set(h, typeof pid === 'string' && pid ? pid : null); }
      } catch (err) {
        log(`Modrinth could not say which projects the jars in ${folder}/ are (${err.message}): installing without that check, so one already there under another name may be installed twice\n`);
      }
    }
    const by = new Map();
    for (const [rel, h] of jars) { const pid = projects.get(h); if (pid) by.set(pid, [...(by.get(pid) || []), rel]); }
    return by;
  }
  // A file Modrinth names goes into the server's folder under that name: a plain file name, nothing Windows refuses.
  const SAFE =/^(?!\.+$)(?!(con|prn|aux|nul|com\d|lpt\d)(\.|$))[^<>:"/\\|?*\x00-\x1f]+(?<![. ])$/i;
  // What the Market changes on one server happens one at a time: two installs read and write the same pyide-server.json.
  const queues = new Map(); // dir (lower case) -> the promise of its last step
  const queued = (dir, step) => {
    const key = path.resolve(dir).toLowerCase();
    const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(step);
    queues.set(key, next);
    next.catch(() => {}).then(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  };

  // {id, type} installed into the server at dir -> {installed: [{title, version, file}], skipped: [title], present:
  // [{title, file}] (dependencies left out, being there under another name)}; or, the project itself being there,
  // {installed: [], duplicate: {title, file}}, a result and not an error, so the window can say it in its language.
  const install = (dir, project, log) => queued(dir, () => installNow(dir, project, log));
  async function installNow(dir, { id: ref, type }, log) {
    const desc = readServer(dir);
    const target = targetOf(desc, type);
    const market = { ...(desc.market || {}) };
    const plan = new Map(); // project id -> {project, version, file}
    const asked = new Set(); // project ids and slugs asked for, so a dependency cycle ends
    const skipped = [];
    const present = [];
    let duplicate = null;
    let jars = null;
    // -> the project's id. A dependency may name only a version (project_id null): the version names its project. A
    // version it pins is installed when it is for this server, else the project's own newest that is.
    async function resolve(ref, versionId, dependency) {
      let pinned = null;
      let pid = ref;
      if (versionId) {
        pinned = await getJson(`${api()}/version/${encodeURIComponent(versionId)}`).catch((err) => { if (err.status === 404) return null; throw err; });
        if (typeof pinned?.project_id === 'string' && pinned.project_id) pid = pinned.project_id;
        if (!fits(pinned, target)) {
          if (pid) log(`The version ${versionId} of ${pid} that a project requires is not for ${KINDS[desc.kind].title} ${desc.mc}: taking the newest that is\n`);
          pinned = null;
        }
      }
      if (typeof pid !== 'string' || !pid) {
        if (versionId) log(`A required dependency names the version ${versionId}, which Modrinth does not have: it is left out\n`);
        return null;
      }
      if (asked.has(pid) || plan.has(pid) || (dependency && market[pid])) return pid;
      asked.add(pid);
      const project = await getJson(`${api()}/project/${encodeURIComponent(pid)}`);
      const id = typeof project?.id === 'string' && project.id ? project.id : pid;
      const title = typeof project?.title === 'string' && project.title ? project.title : id;
      if (plan.has(id) || (dependency && market[id])) return id;
      asked.add(id);
      if (type === 'mod' && project.server_side === 'unsupported') {
        if (dependency) { skipped.push(title); return id; }
        throw fail(`${title} is a client-only mod: players add it to their own game, the server does not run it`);
      }
      const version = pinned || await versionFor(id, target);
      if (!version) throw fail(`${title} has no version for ${KINDS[desc.kind].title} ${desc.mc}${dependency ? ', and a project being installed requires it' : ''}`);
      const files = (Array.isArray(version.files) ? version.files : []).filter((f) => f && typeof f.filename === 'string' && f.url);
      const file = files.find((f) => f.primary) || files[0];
      if (!file) throw fail(`${title} ${version.version_number ?? ''} has no file to download`);
      if (!SAFE.test(file.filename)) throw fail(`${title}'s file has a name Nano Studio does not write: ${JSON.stringify(file.filename)}`);
      if (dependency && fs.existsSync(path.join(dir, target.folder, file.filename))) return id;
      // A jar of the same name is replaced, not doubled.
      const other = type === 'resourcepack' ? null : ((await (jars ||= jarsIn(dir, target.folder, market, log))).get(id) || [])
        .find((f) => f.toLowerCase() !== `${target.folder}/${file.filename}`.toLowerCase());
      if (other && !dependency) { duplicate = { title, file: other }; return null; }
      if (other) { present.push({ title, file: other }); return id; }
      const needs = [];
      plan.set(id, { project: { ...project, id, title }, version, file, dependency, needs });
      if (type === 'resourcepack') return id;
      for (const d of Array.isArray(version.dependencies) ? version.dependencies : []) {
        if (d?.dependency_type !== 'required') continue;
        const need = await resolve(typeof d.project_id === 'string' ? d.project_id : null, typeof d.version_id === 'string' ? d.version_id : null, true);
        if (need) needs.push(need);
      }
      return id;
    }
    await resolve(ref, null, false);
    if (duplicate) return { installed: [], skipped: [], present: [], duplicate };
    const id = plan.keys().next().value;
    if (market[id]?.versionId === plan.get(id).version.id) {
      if (!market[id].dependency) throw fail(`${market[id].title} ${market[id].version} is installed already, the newest for this server`, 'current');
      market[id] = { ...market[id], dependency: false };
      writeServer(dir, { ...desc, market });
      return { installed: [], skipped, present };
    }
    const old = market[id]?.files || [];
    const owner = type === 'resourcepack' ? packOwner(market) : null;
    if (type === 'resourcepack' && !owner && !onlyTranslations(path.join(dir, 'resourcepack'))) {
      throw fail('The server has its own resource pack in resourcepack/: move it away first, a server sends one pack');
    }
    if (type !== 'resourcepack' && old.length && running(dir)) throw stopFirst(dir, `the old ${market[id].title} ${market[id].version}`);

    const installed = [];
    // Files this install put where there was none: a later download that fails takes them out again, so no jar is left
    // that pyide-server.json does not record.
    const added = [];
    try {
      for (const [pid, { project, version, file, dependency, needs }] of plan) {
        log(`${project.title} ${version.version_number}: ${file.filename}\n`);
        let rel;
        let packLang;
        if (type === 'resourcepack') {
          // The new pack replaces the server's only once it is downloaded, checked and unpacked.
          const tmp = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-${file.filename}`);
          const staging = path.join(dir, 'resourcepack.part');
          try {
            await download(file, tmp, log);
            fs.rmSync(staging, { recursive: true, force: true });
            unpackZip(tmp, staging);
            if (!fs.existsSync(path.join(staging, 'pack.mcmeta'))) throw fail(`${file.filename} is not a resource pack (no pack.mcmeta)`);
            packLang = packLangs(staging);
            swapPack(dir, staging, owner ? market[owner].packLang : null);
            if (owner) delete market[owner];
          } finally {
            fs.rmSync(tmp, { force: true });
            fs.rmSync(staging, { recursive: true, force: true });
          }
          rel = 'resourcepack';
        } else {
          // A server folder deleted since is not made again by the download.
          readServer(dir);
          fs.mkdirSync(path.join(dir, target.folder), { recursive: true });
          const dest = path.join(dir, target.folder, file.filename);
          const fresh = !fs.existsSync(dest);
          await download(file, dest, log);
          if (fresh) added.push(dest);
          rel = `${target.folder}/${file.filename}`;
        }
        market[pid] = { title: project.title, version: version.version_number, versionId: version.id, files: [rel], needs, dependency: !!dependency, ...(packLang ? { packLang } : {}) };
        installed.push({ title: project.title, version: version.version_number, file: rel, dependency: !!dependency });
      }
    } catch (err) {
      for (const f of added) fs.rmSync(f, { force: true });
      throw err;
    }
    // An update replaces the old version's file once the new one is in place. One that cannot be deleted (held by a
    // server started outside Nano Studio) is said, since the server would load both versions.
    const stuck = [];
    for (const f of old) {
      if (market[id].files.includes(f) || !inside(dir, f)) continue;
      try { fs.rmSync(inside(dir, f), { recursive: true, force: true }); } catch (err) { stuck.push(`${f} (${err.code || err.message})`); }
    }
    writeServer(dir, { ...readServer(dir), market });
    if (stuck.length) throw fail(`${market[id].title} ${market[id].version} is installed, but the old file could not be deleted: ${stuck.join(', ')}. Delete it before the server starts again, or it loads both versions`);
    return { installed, skipped, present };
  }

  // Removes what the Market installed for a project, then the dependencies no remaining project needs (directly or
  // through other dependencies, so a cycle of dependencies goes too). A project another one left needs stays:
  // {removed: [], neededBy: [their titles]}, a result and not an error, so the window can say it in its language.
  const remove = (dir, id) => queued(dir, () => removeNow(dir, id));
  function removeNow(dir, id) {
    const desc = readServer(dir);
    const market = { ...(desc.market || {}) };
    if (!market[id]) throw fail('The Market did not install that project on this server');
    // What goes: the project, then the dependencies no project left needs. Worked out before anything is deleted.
    const kept = new Set();
    const keep = (pid) => { if (pid !== id && market[pid] && !kept.has(pid)) { kept.add(pid); for (const n of market[pid].needs || []) keep(n); } };
    for (const [pid, e] of Object.entries(market)) if (!e.dependency) keep(pid);
    const neededBy = [...kept].filter((pid) => (market[pid].needs || []).includes(id)).map((pid) => market[pid].title || pid);
    if (neededBy.length) return { removed: [], neededBy };
    const going = [id, ...Object.keys(market).filter((pid) => pid !== id && !kept.has(pid))];
    // Only what lies in the server's folder, whatever pyide-server.json says.
    const filesOf = (pid) => (Array.isArray(market[pid].files) ? market[pid].files : []).filter((f) => inside(dir, f));
    if (running(dir) && going.some((pid) => filesOf(pid).some((f) => f !== 'resourcepack'))) throw stopFirst(dir, market[id].title);
    const removed = [];
    const stuck = [];
    for (const pid of going) {
      try {
        for (const f of filesOf(pid)) {
          if (f === 'resourcepack') dropPack(dir, market[pid].packLang);
          else fs.rmSync(inside(dir, f), { recursive: true, force: true });
        }
      } catch (err) {
        // Still recorded: Remove can be tried again once what holds it lets go.
        stuck.push(`${market[pid].title} (${err.code || err.message})`);
        continue;
      }
      removed.push(market[pid].title);
      delete market[pid];
    }
    writeServer(dir, { ...desc, market });
    if (stuck.length) throw fail(`Could not delete the files of ${stuck.join(', ')}: close what holds them (a server started outside Nano Studio) and remove again`);
    return { removed };
  }

  return { install, remove };
}

module.exports = { search, createMarket, targetOf, swapPack, packOwner };
