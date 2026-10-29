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
  return {
    total: r.total_hits,
    hits: r.hits.map((h) => ({
      id: h.project_id, slug: h.slug, type: h.project_type, title: h.title, author: h.author, description: h.description, icon: h.icon_url || null,
      downloads: h.downloads, follows: h.follows, categories: h.display_categories || h.categories || [], updated: h.date_modified,
      page: `https://modrinth.com/${h.project_type}/${h.slug}`,
    })),
  };
}

function createMarket({ readServer, writeServer, fetchFile }) {
  const api = () => modrinthApi();
  // The newest version of a project for the server (a release before a beta), or the version a dependency names.
  async function versionFor(id, target, versionId) {
    const list = await getJson(`${api()}/project/${id}/version?loaders=${q(target.loaders)}${target.versions ? `&game_versions=${q(target.versions)}` : ''}`);
    const v = list.find((x) => x.version_type === 'release') || list[0];
    return v || (versionId ? getJson(`${api()}/version/${versionId}`) : null);
  }
  async function download(file, dest, log) {
    await fetchFile(file.url, dest, { size: file.size }, log);
    const sum = file.hashes?.sha512 ? ['sha512', file.hashes.sha512] : file.hashes?.sha1 ? ['sha1', file.hashes.sha1] : null;
    if (sum && crypto.createHash(sum[0]).update(fs.readFileSync(dest)).digest('hex') !== sum[1]) {
      fs.rmSync(dest, { force: true });
      throw fail(`Checksum mismatch for ${file.filename}`);
    }
  }

  // {id, type} installed into the server at dir -> {installed: [{title, version, file}], skipped: [title]}.
  async function install(dir, { id: ref, type }, log) {
    const desc = readServer(dir);
    const target = targetOf(desc, type);
    const market = { ...(desc.market || {}) };
    const plan = new Map(); // project id -> {project, version, file}
    const skipped = [];
    async function resolve(pid, versionId, dependency) {
      if (plan.has(pid) || (dependency && market[pid])) return;
      const project = await getJson(`${api()}/project/${pid}`);
      if (type === 'mod' && project.server_side === 'unsupported') {
        if (dependency) { skipped.push(project.title); return; }
        throw fail(`${project.title} is a client-only mod: players add it to their own game, the server does not run it`);
      }
      const version = await versionFor(pid, target, versionId);
      if (!version) throw fail(`${project.title} has no version for ${KINDS[desc.kind].title} ${desc.mc}`);
      const file = version.files.find((f) => f.primary) || version.files[0];
      if (!file) throw fail(`${project.title} ${version.version_number} has no file to download`);
      if (dependency && fs.existsSync(path.join(dir, target.folder, file.filename))) return;
      plan.set(project.id, { project, version, file, dependency });
      if (type === 'resourcepack') return;
      for (const d of version.dependencies || []) if (d.dependency_type === 'required' && d.project_id) await resolve(d.project_id, d.version_id, true);
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

    if (type === 'resourcepack') {
      const owner = Object.keys(market).find((k) => market[k].files.includes('resourcepack'));
      if (fs.existsSync(path.join(dir, 'resourcepack', 'pack.mcmeta')) && !owner) {
        throw fail('The server has its own resource pack in resourcepack/: move it away first, a server sends one pack');
      }
      if (owner) { fs.rmSync(path.join(dir, 'resourcepack'), { recursive: true, force: true }); delete market[owner]; }
    }

    const installed = [];
    for (const [pid, { project, version, file, dependency }] of plan) {
      log(`${project.title} ${version.version_number}: ${file.filename}\n`);
      let rel;
      if (type === 'resourcepack') {
        const tmp = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-${file.filename}`);
        try {
          await download(file, tmp, log);
          unpackZip(tmp, path.join(dir, 'resourcepack'));
        } finally { fs.rmSync(tmp, { force: true }); }
        if (!fs.existsSync(path.join(dir, 'resourcepack', 'pack.mcmeta'))) throw fail(`${file.filename} is not a resource pack (no pack.mcmeta)`);
        rel = 'resourcepack';
      } else {
        fs.mkdirSync(path.join(dir, target.folder), { recursive: true });
        await download(file, path.join(dir, target.folder, file.filename), log);
        rel = `${target.folder}/${file.filename}`;
      }
      const needs = (version.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id);
      market[pid] = { title: project.title, version: version.version_number, versionId: version.id, files: [rel], needs, dependency: !!dependency };
      installed.push({ title: project.title, version: version.version_number, file: rel, dependency: !!dependency });
    }
    // An update replaces the old version's file once the new one is in place.
    for (const f of old) if (!market[id].files.includes(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    writeServer(dir, { ...readServer(dir), market });
    return { installed, skipped };
  }

  // Removes what the Market installed for a project, then the dependencies no remaining project needs.
  function remove(dir, id) {
    const desc = readServer(dir);
    const market = { ...(desc.market || {}) };
    if (!market[id]) throw fail('The Market did not install that project on this server');
    const removed = [];
    const take = (pid) => {
      for (const f of market[pid].files) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      removed.push(market[pid].title);
      delete market[pid];
    };
    take(id);
    for (let more = true; more;) {
      more = false;
      for (const [pid, e] of Object.entries(market)) {
        if (e.dependency && !Object.values(market).some((o) => o.needs?.includes(pid))) { take(pid); more = true; }
      }
    }
    writeServer(dir, { ...desc, market });
    return { removed };
  }

  return { install, remove };
}

module.exports = { search, createMarket, targetOf };
