// The Minecraft window's Market: Modrinth's modpacks, mods, plugins and resource packs, searched for what a server
// runs (its Minecraft version and loader or plugin API) and installed into it with the dependencies the project
// requires, each file checked against the SHA-512 or SHA-1 Modrinth publishes. What the Market installed is recorded
// in the server's pyide-server.json (market: {projectId: {title, version, files, needs, dependency}}), so it shows as
// installed and Remove takes it out with the dependencies nothing else needs.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KINDS, getJson, modrinthApi } = require('./sources');
const { unpackZip } = require('./zipfile');

const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
// rel under dir, or null when it names a path outside it.
const inside = (dir, rel) => { if (typeof rel !== 'string') return null; const p = path.resolve(dir, rel); return p.startsWith(path.resolve(dir) + path.sep) ? p : null; };
const q = (v) => encodeURIComponent(JSON.stringify(v));
const SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const MODPACK_LOADERS = ['fabric', 'forge', 'neoforge'];

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

function createMarket({ readServer, writeServer, fetchFile }) {
  const api = () => modrinthApi();
  // The newest version of a project for the server (a release before a beta), or the version a dependency names.
  async function versionFor(id, target, versionId) {
    const list = await getJson(`${api()}/project/${encodeURIComponent(id)}/version?loaders=${q(target.loaders)}${target.versions ? `&game_versions=${q(target.versions)}` : ''}`);
    const ok = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object');
    const v = ok.find((x) => x.version_type === 'release') || ok[0];
    return v || (versionId ? getJson(`${api()}/version/${encodeURIComponent(versionId)}`) : null);
  }
  async function download(file, dest, log) {
    const sum = file.hashes?.sha512 ? ['sha512', file.hashes.sha512] : file.hashes?.sha1 ? ['sha1', file.hashes.sha1] : null;
    if (!sum) throw fail(`Modrinth publishes no checksum for ${file.filename}`);
    await fetchFile(file.url, dest, { size: file.size }, log);
    if (crypto.createHash(sum[0]).update(fs.readFileSync(dest)).digest('hex') !== sum[1]) {
      fs.rmSync(dest, { force: true });
      throw fail(`Checksum mismatch for ${file.filename}`);
    }
  }
  // A file Modrinth names goes into the server's folder under that name: a plain file name, nothing Windows refuses.
  const SAFE = /^(?!\.+$)(?!(con|prn|aux|nul|com\d|lpt\d)(\.|$))[^<>:"/\\|?*\x00-\x1f]+(?<![. ])$/i;
  // What the Market changes on one server happens one at a time: two installs read and write the same pyide-server.json.
  const queues = new Map(); // dir (lower case) -> the promise of its last step
  const queued = (dir, step) => {
    const key = path.resolve(dir).toLowerCase();
    const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(step);
    queues.set(key, next);
    next.catch(() => {}).then(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  };

  // {id, type} installed into the server at dir -> {installed: [{title, version, file}], skipped: [title]}.
  const install = (dir, project, log) => queued(dir, () => installNow(dir, project, log));
  async function installNow(dir, { id: ref, type }, log) {
    const desc = readServer(dir);
    const target = targetOf(desc, type);
    const market = { ...(desc.market || {}) };
    const plan = new Map(); // project id -> {project, version, file}
    const asked = new Set(); // project ids and slugs asked for, so a dependency cycle ends
    const skipped = [];
    async function resolve(pid, versionId, dependency) {
      if (asked.has(pid) || plan.has(pid) || (dependency && market[pid])) return;
      asked.add(pid);
      const project = await getJson(`${api()}/project/${encodeURIComponent(pid)}`);
      const id = typeof project?.id === 'string' && project.id ? project.id : pid;
      const title = typeof project?.title === 'string' && project.title ? project.title : id;
      if (plan.has(id) || (dependency && market[id])) return;
      asked.add(id);
      if (type === 'mod' && project.server_side === 'unsupported') {
        if (dependency) { skipped.push(title); return; }
        throw fail(`${title} is a client-only mod: players add it to their own game, the server does not run it`);
      }
      const version = await versionFor(id, target, versionId);
      if (!version) throw fail(`${title} has no version for ${KINDS[desc.kind].title} ${desc.mc}${dependency ? ', and a project being installed requires it' : ''}`);
      const files = (Array.isArray(version.files) ? version.files : []).filter((f) => f && typeof f.filename === 'string' && f.url);
      const file = files.find((f) => f.primary) || files[0];
      if (!file) throw fail(`${title} ${version.version_number ?? ''} has no file to download`);
      if (!SAFE.test(file.filename)) throw fail(`${title}'s file has a name Nano Studio does not write: ${JSON.stringify(file.filename)}`);
      if (dependency && fs.existsSync(path.join(dir, target.folder, file.filename))) return;
      plan.set(id, { project: { ...project, id, title }, version, file, dependency });
      if (type === 'resourcepack') return;
      for (const d of Array.isArray(version.dependencies) ? version.dependencies : []) {
        if (d?.dependency_type === 'required' && typeof d.project_id === 'string' && d.project_id) await resolve(d.project_id, d.version_id, true);
      }
    }
    await resolve(ref, null, false);
    const id = plan.keys().next().value;
    if (market[id]?.versionId === plan.get(id).version.id) {
      if (!market[id].dependency) throw fail(`${market[id].title} ${market[id].version} is installed already, the newest for this server`, 'current');
      market[id] = { ...market[id], dependency: false };
      writeServer(dir, { ...desc, market });
      return { installed: [], skipped };
    }
    const old = market[id]?.files || [];
    const owner = type === 'resourcepack' ? Object.keys(market).find((k) => market[k].files?.includes('resourcepack')) : null;
    if (type === 'resourcepack' && fs.existsSync(path.join(dir, 'resourcepack', 'pack.mcmeta')) && !owner) {
      throw fail('The server has its own resource pack in resourcepack/: move it away first, a server sends one pack');
    }

    const installed = [];
    for (const [pid, { project, version, file, dependency }] of plan) {
      log(`${project.title} ${version.version_number}: ${file.filename}\n`);
      let rel;
      if (type === 'resourcepack') {
        // The new pack replaces the server's only once it is downloaded, checked and unpacked.
        const tmp = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-${file.filename}`);
        const staging = path.join(dir, 'resourcepack.part');
        try {
          await download(file, tmp, log);
          fs.rmSync(staging, { recursive: true, force: true });
          unpackZip(tmp, staging);
          if (!fs.existsSync(path.join(staging, 'pack.mcmeta'))) throw fail(`${file.filename} is not a resource pack (no pack.mcmeta)`);
          if (owner) { fs.rmSync(path.join(dir, 'resourcepack'), { recursive: true, force: true }); delete market[owner]; }
          fs.renameSync(staging, path.join(dir, 'resourcepack'));
        } finally {
          fs.rmSync(tmp, { force: true });
          fs.rmSync(staging, { recursive: true, force: true });
        }
        rel = 'resourcepack';
      } else {
        // A server folder deleted since is not made again by the download.
        readServer(dir);
        fs.mkdirSync(path.join(dir, target.folder), { recursive: true });
        await download(file, path.join(dir, target.folder, file.filename), log);
        rel = `${target.folder}/${file.filename}`;
      }
      const needs = (Array.isArray(version.dependencies) ? version.dependencies : []).filter((d) => d?.dependency_type === 'required' && d.project_id).map((d) => d.project_id);
      market[pid] = { title: project.title, version: version.version_number, versionId: version.id, files: [rel], needs, dependency: !!dependency };
      installed.push({ title: project.title, version: version.version_number, file: rel, dependency: !!dependency });
    }
    // An update replaces the old version's file once the new one is in place.
    for (const f of old) if (!market[id].files.includes(f) && inside(dir, f)) fs.rmSync(inside(dir, f), { recursive: true, force: true });
    writeServer(dir, { ...readServer(dir), market });
    return { installed, skipped };
  }

  // Removes what the Market installed for a project, then the dependencies no remaining project needs (directly or
  // through other dependencies, so a cycle of dependencies goes too).
  const remove = (dir, id) => queued(dir, () => removeNow(dir, id));
  function removeNow(dir, id) {
    const desc = readServer(dir);
    const market = { ...(desc.market || {}) };
    if (!market[id]) throw fail('The Market did not install that project on this server');
    const removed = [];
    const take = (pid) => {
      // Only what lies in the server's folder, whatever pyide-server.json says.
      for (const f of Array.isArray(market[pid].files) ? market[pid].files : []) if (inside(dir, f)) fs.rmSync(inside(dir, f), { recursive: true, force: true });
      removed.push(market[pid].title);
      delete market[pid];
    };
    take(id);
    const kept = new Set();
    const keep = (pid) => { if (market[pid] && !kept.has(pid)) { kept.add(pid); for (const n of market[pid].needs || []) keep(n); } };
    for (const [pid, e] of Object.entries(market)) if (!e.dependency) keep(pid);
    for (const pid of Object.keys(market)) if (!kept.has(pid)) take(pid);
    writeServer(dir, { ...desc, market });
    return { removed };
  }

  return { install, remove };
}

module.exports = { search, createMarket, targetOf };
