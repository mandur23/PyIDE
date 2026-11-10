// What comes into the Minecraft window from outside: files and folders dropped on it (a server made elsewhere, a
// world, a resource pack, plugin and mod jars) and modpacks (.mrpack, a file or a Modrinth project) that become a
// server. The feature module (main/features/minecraft.js) passes in what these steps share with it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openZip, readEntry, unpackZip, canonical } = require('./zipfile');
const { KINDS, PACK_HOSTS, neoforgeMc, getJson, modrinthApi, packFile } = require('./sources');
const { swapPack, packOwner } = require('./market');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
// Windows keeps these names for devices: no folder can have one, whatever its case (main/features/minecraft.js).
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
// The most a file a pack lists may be when it names no size.
const FILE_LIMIT = 1024 * 1024 * 1024;
// Streamed: a pack's mods are hashed at every Play, in the process that also answers the window.
async function hashOf(algo, file) {
  const hash = crypto.createHash(algo);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
// A file a pack lists ({rel, from: its allowed addresses, sum: [algo, lower-case hex], size}) at dest, from the first
// of its addresses that gives it whole and with its checksum: a pack may name mirrors.
async function fetchChecked(fetchFile, f, dest, log) {
  const quiet = Object.assign(() => {}, { signal: log.signal });
  let last = null;
  for (const url of f.from) {
    try {
      await fetchFile(url, dest, { size: f.size, limit: f.size || FILE_LIMIT }, quiet);
      if (await hashOf(f.sum[0], dest) === f.sum[1]) return;
      last = fail(`Checksum mismatch for ${f.rel}`);
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'ENOSPC') throw err;
      last = err;
    }
  }
  throw last;
}
// A pack's entry for a file -> {rel, from, sum, size}, or a reason it cannot be had: no allowed address or no checksum.
function packEntry(f, rel) {
  const from = (Array.isArray(f.downloads) ? f.downloads : []).filter(packFile);
  const sum = f.hashes?.sha512 ? ['sha512', f.hashes.sha512] : f.hashes?.sha1 ? ['sha1', f.hashes.sha1] : null;
  if (!from.length) return { why: `gives no https download address on ${PACK_HOSTS.join(', ')} for ${rel}` };
  if (!sum) return { why: `gives no checksum for ${rel}` };
  return { rel, from, sum: [sum[0], String(sum[1]).toLowerCase()], size: Number.isSafeInteger(f.fileSize) && f.fileSize > 0 ? f.fileSize : null };
}
// A .mrpack fromModrinth downloaded (into the temporary folder, under a pyide-<hex>- name) is removed once the server
// has its copy or the dialog is cancelled; any other file, the user's own, is left alone.
function discardDownload(file) {
  if (file && path.dirname(path.resolve(file)) === path.resolve(os.tmpdir()) && /^pyide-[0-9a-f]{8}-.*\.mrpack$/.test(path.basename(file))) fs.rmSync(file, { force: true });
}
// rel under root, or null when it names a path outside it or is not written where its text says (zipfile.js canonical).
const inside = (root, rel) => {
  if (!canonical(rel)) return null;
  const p = path.resolve(root, rel);
  return p.startsWith(path.resolve(root) + path.sep) && !p.slice(path.resolve(root).length).includes(':') ? p : null;
};
// A free folder name under parent, from a name made safe for a server name (fallback when nothing of it is).
function freeName(parent, raw, fallback = 'server') {
  let base = (raw.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32) || fallback).replace(/-+$/, '') || fallback;
  if (RESERVED.test(base)) base = `${base}-mc`;
  let name = base;
  for (let i = 2; fs.existsSync(path.join(parent, name)); i++) name = `${base}-${i}`;
  return name;
}

// The loader a mod jar is for, or the API a plugin jar is for, from the descriptor it carries.
const JAR_DESCRIPTORS = [
  ['plugin.yml', { kind: 'plugin', api: 'paper' }], ['paper-plugin.yml', { kind: 'plugin', api: 'paper' }],
  ['velocity-plugin.json', { kind: 'plugin', api: 'velocity' }],
  ['fabric.mod.json', { kind: 'mod', loaders: ['fabric-loader'] }],
  ['META-INF/neoforge.mods.toml', { kind: 'mod', loaders: ['neoforge'] }],
  // Forge's, and NeoForge's before 1.20.5.
  ['META-INF/mods.toml', { kind: 'mod', loaders: ['forge', 'neoforge'] }],
];

// What a dropped path is: {path, name, kind: 'server'|'world'|'resourcepack'|'plugin'|'mod'|'modpack'|'curseforge'|
// 'unknown', api?, loaders?, zip?}.
function classify(p) {
  const name = path.basename(p);
  if (isDir(p)) {
    if (isFile(path.join(p, 'level.dat'))) return { path: p, name, kind: 'world' };
    if (isFile(path.join(p, 'pack.mcmeta'))) return { path: p, name, kind: 'resourcepack' };
    const looksLikeServer = ['server.properties', 'eula.txt', 'run.bat', 'velocity.toml'].some((f) => fs.existsSync(path.join(p, f)))
      && (fs.readdirSync(p).some((n) => n.endsWith('.jar')) || isDir(path.join(p, 'libraries')));
    return { path: p, name, kind: looksLikeServer ? 'server' : 'unknown' };
  }
  if (/\.mrpack$/i.test(name)) return { path: p, name, kind: 'modpack' };
  if (/\.zip$/i.test(name)) {
    if (readEntry(p, 'pack.mcmeta')) return { path: p, name, kind: 'resourcepack', zip: true };
    const manifest = readEntry(p, 'manifest.json');
    if (manifest && /minecraftModpack/.test(manifest.toString('utf8'))) return { path: p, name, kind: 'curseforge' };
    return { path: p, name, kind: 'unknown' };
  }
  if (/\.jar$/i.test(name)) {
    let zip;
    try {
      zip = openZip(p);
      const hit = JAR_DESCRIPTORS.find(([entry]) => zip.names.includes(entry));
      return hit ? { path: p, name, ...hit[1] } : { path: p, name, kind: 'unknown' };
    } catch (err) {
      if (err.bomb) throw err;
      return { path: p, name, kind: 'unknown' };
    } finally { zip?.close(); }
  }
  return { path: p, name, kind: 'unknown' };
}

// 'nether' or 'the_end' for a Paper world's dimension folder (<world>_nether holding DIM-1, <world>_the_end holding
// DIM1), else null.
function dimensionOf(p) {
  const m = /_(nether|the_end)$/i.exec(path.basename(p));
  if (!m || !isFile(path.join(p, 'level.dat'))) return null;
  const dim = m[1].toLowerCase();
  return isDir(path.join(p, dim === 'nether' ? 'DIM-1' : 'DIM1')) ? dim : null;
}

// What kind of server a folder made outside PyIDE is, from what it runs: the Forge and NeoForge installers' libraries,
// else the jar at its root (Paper's and Purpur's launcher, Velocity, Fabric's server launcher, Mojang's server).
function detectServer(dir, javaOfJar) {
  for (const [kind, lib] of [['forge', 'libraries/net/minecraftforge/forge'], ['neoforge', 'libraries/net/neoforged/neoforge']]) {
    const base = path.join(dir, lib);
    for (const v of isDir(base) ? fs.readdirSync(base) : []) {
      const args = path.join(base, v, 'win_args.txt');
      if (!isFile(args)) continue;
      const [mc, loader] = kind === 'forge' ? [v.split('-')[0], v.split('-').slice(1).join('-')] : [neoforgeMc(v), v];
      return { kind, mc, loader, launch: { argsFile: path.relative(dir, args).replace(/\\/g, '/') } };
    }
  }
  for (const jar of fs.readdirSync(dir).filter((n) => n.endsWith('.jar') && !/installer/i.test(n))) {
    let zip;
    try {
      zip = openZip(path.join(dir, jar));
      const has = (n) => zip.names.includes(n);
      if (has('com/velocitypowered/proxy/Velocity.class')) {
        const version = /^Implementation-Version:\s*(\S+)/m.exec(zip.read('META-INF/MANIFEST.MF')?.toString('utf8') || '')?.[1] || 'unknown';
        return { kind: 'velocity', mc: version, java: javaOfJar(path.join(dir, jar)), launch: { jar } };
      }
      const versions = zip.read('META-INF/versions.list')?.toString('utf8');
      if (versions) {
        const [, id, file] = versions.trim().split('\n').pop().split('\t');
        return { kind: /purpur/i.test(file || '') ? 'purpur' : 'paper', mc: id, launch: { jar } };
      }
      const fabric = /fabric-server-mc\.([^-]+)-loader\.([^-]+)-launcher/.exec(jar);
      if (fabric || has('net/fabricmc/installer/ServerLauncher.class')) {
        return { kind: 'fabric', mc: fabric?.[1] || null, loader: fabric?.[2] || null, launch: { jar } };
      }
      const version = zip.read('version.json');
      if (version) return { kind: 'vanilla', mc: JSON.parse(version.toString('utf8')).id, launch: { jar } };
    } catch {} finally { zip?.close(); }
  }
  return null;
}

// unfinished (main/features/minecraft.js): claim(dir) makes a server folder marked as being made, done(dir) unmarks it,
// undo(dir) removes it.
function createImports({ root, servers, create, unfinished, javaFor, javaOfJar, fetchFile, writeServer, readServer }) {
  // A server folder made elsewhere becomes one of the project's: copied into servers/ (left where it is when it is
  // there already) and described. Its eula.txt is left as it is: agreeing is the user's.
  async function importServer(src, log) {
    const found = detectServer(src, javaOfJar);
    if (!found) throw fail(`${path.basename(src)} does not look like a Minecraft server Nano Studio knows (Paper, Purpur, Velocity, Vanilla, Fabric, Forge or NeoForge)`);
    const parent = path.join(root, 'servers');
    const already = path.resolve(path.dirname(src)).toLowerCase() === path.resolve(parent).toLowerCase();
    if (already && readServer(src)) throw fail(`${path.basename(src)} is one of the project's servers already`);
    const dir = already ? src : path.join(parent, freeName(parent, path.basename(src)));
    if (!already) unfinished.claim(dir);
    try {
      if (!already) {
        log(`Copying ${src} to ${dir}…\n`);
        await fs.promises.cp(src, dir, { recursive: true, errorOnExist: true });
      }
      // A folder that was a Nano Studio server elsewhere keeps the memory and JVM options it was given.
      const desc = await describe(dir, found, readServer(dir) || {});
      if (!already) unfinished.done(dir);
      log(`Imported ${path.basename(dir)}: ${KINDS[found.kind].title} ${desc.mc}${desc.loader ? ` (${desc.loader})` : ''}, Java ${desc.java}\n`);
      return { name: path.basename(dir), dir, ...desc };
    } catch (err) {
      // A copy cut off half-way is not left to look like the user's folder.
      if (!already) unfinished.undo(dir);
      throw err;
    }
  }

  // found: detectServer's. had: what a description the folder has gave it. -> the description written.
  async function describe(dir, found, had) {
    const java = found.java || (found.mc && /^\d/.test(found.mc) ? await javaFor(found.mc).catch(() => null) : null)
      || javaOfJar(path.join(dir, found.launch.jar || ''));
    const desc = { kind: found.kind, mc: found.mc || 'unknown', loader: found.loader || null, build: null, java,
      memory: /^\d+[MG]$/i.test(had.memory || '') ? had.memory.toUpperCase() : '2G', launch: found.launch, imported: true,
      ...(Array.isArray(had.jvmArgs) && had.jvmArgs.every((a) => typeof a === 'string' && /^-\S+$/.test(a) && !/^-Xmx/i.test(a)) && { jvmArgs: had.jvmArgs }) };
    writeServer(dir, desc);
    return desc;
  }
  // A server whose pyide-server.json is damaged, described again from what it runs as an import is.
  async function redescribe(dir) {
    const found = detectServer(dir, javaOfJar);
    if (!found) throw fail(`Nano Studio cannot tell from its files what ${path.basename(dir)} runs: fix pyide-server.json by hand`);
    return { name: path.basename(dir), dir, ...(await describe(dir, found, {})) };
  }

  // Files and folders dropped on the window (serverDir null) or on one server's card.
  async function drop(serverDir, paths, log) {
    const done = [];
    const skipped = [];
    const modpacks = [];
    const all = servers();
    const target = (fits) => {
      if (serverDir) { const s = all.find((x) => x.dir.toLowerCase() === serverDir.toLowerCase()); return s && fits(s) ? s : null; }
      const fitting = all.filter(fits);
      return fitting.length === 1 ? fitting[0] : null;
    };
    for (const p of paths) {
      const it = { name: path.basename(p) };
      try {
        Object.assign(it, classify(p));
        if (it.kind === 'server') {
          const s = await importServer(it.path, log);
          done.push({ name: it.name, what: 'server', to: s.dir });
        } else if (it.kind === 'modpack') {
          // New Server from Modpack makes one server at a time: the first opens it, the others are said.
          if (modpacks.length) skipped.push({ name: it.name, why: 'modpack' });
          else modpacks.push(it.path);
        } else if (it.kind === 'curseforge') {
          skipped.push({ name: it.name, why: 'curseforge' });
        } else if (it.kind === 'plugin' || it.kind === 'mod') {
          const s = target((x) => (it.kind === 'plugin' ? x.plugins === it.api : it.loaders.includes(x.mods)));
          if (!s) { skipped.push({ name: it.name, why: it.kind === 'plugin' ? `plugin:${it.api}` : `mod:${it.loaders[0]}` }); continue; }
          const dest = path.join(s.dir, it.kind === 'plugin' ? 'plugins' : 'mods', it.name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(it.path, dest);
          done.push({ name: it.name, what: it.kind, to: dest, server: s.name });
        } else if (it.kind === 'resourcepack') {
          const s = target((x) => !x.proxy);
          if (!s) { skipped.push({ name: it.name, why: 'target' }); continue; }
          // The pack dropped is the server's pack now: as the Market's, it replaces the old one whole once it is unpacked,
          // keeps the translations, and the Market no longer claims the folder.
          const dest = path.join(s.dir, 'resourcepack');
          const desc = readServer(s.dir);
          const owner = packOwner(desc?.market);
          // Not the Market's resourcepack.part: an install may be using it.
          const staging = path.join(s.dir, 'resourcepack.drop');
          fs.rmSync(staging, { recursive: true, force: true });
          try {
            if (it.zip) unpackZip(it.path, staging);
            else await fs.promises.cp(it.path, staging, { recursive: true });
            if (!isFile(path.join(staging, 'pack.mcmeta'))) throw fail(`${it.name} is not a resource pack (no pack.mcmeta)`);
            swapPack(s.dir, staging, owner ? desc.market[owner].packLang : null);
          } finally { fs.rmSync(staging, { recursive: true, force: true }); }
          if (owner) {
            const market = { ...desc.market };
            delete market[owner];
            writeServer(s.dir, { ...desc, market });
          }
          done.push({ name: it.name, what: 'resourcepack', to: dest, server: s.name });
        } else if (it.kind === 'world') {
          // Paper keeps a world's Nether and End beside it (world_nether, world_the_end, each with a level.dat): they go
          // with the world dropped with them, and are no world of their own.
          const dim = dimensionOf(it.path);
          if (dim) {
            const base = it.name.slice(0, -(dim.length + 1)).toLowerCase();
            if (!paths.some((q) => path.basename(q).toLowerCase() === base && isFile(path.join(q, 'level.dat')))) skipped.push({ name: it.name, why: 'dimension' });
            continue;
          }
          const s = target((x) => !x.proxy);
          if (!s) { skipped.push({ name: it.name, why: 'target' }); continue; }
          const dims = paths.map((q) => ({ path: q, dim: dimensionOf(q) }))
            .filter((d) => d.dim && path.basename(d.path).toLowerCase() === `${it.name}_${d.dim}`.toLowerCase());
          const free = (n) => [n, ...dims.map((d) => `${n}_${d.dim}`)].every((x) => !fs.existsSync(path.join(s.dir, x)));
          let name = freeName(s.dir, it.name, 'world');
          for (let i = 2; !free(name); i++) name = freeName(s.dir, `${it.name}-${i}`, 'world');
          await fs.promises.cp(it.path, path.join(s.dir, name), { recursive: true, errorOnExist: true });
          // Paper finds them by the level name; any other server reads a world's Nether and End from inside it.
          for (const d of dims) {
            const inner = d.dim === 'nether' ? 'DIM-1' : 'DIM1';
            await (s.plugins === 'paper' ? fs.promises.cp(d.path, path.join(s.dir, `${name}_${d.dim}`), { recursive: true, errorOnExist: true })
              : fs.promises.cp(path.join(d.path, inner), path.join(s.dir, name, inner), { recursive: true, errorOnExist: true }));
            done.push({ name: path.basename(d.path), what: 'dimension', to: path.join(s.dir, name), server: s.name });
          }
          setLevelName(s.dir, name);
          done.push({ name: it.name, what: 'world', to: path.join(s.dir, name), server: s.name });
        } else skipped.push({ name: it.name, why: 'unknown' });
      } catch (err) {
        skipped.push(err.bomb ? { name: it.name, why: 'bomb' } : { name: it.name, why: 'error', message: err.message });
      }
    }
    return { done, skipped, modpacks };
  }

  // As Java reads the file: the line may be written `level-name = x`, or twice (the last one counts).
  function setLevelName(dir, level) {
    require('./templates').setProperty(path.join(dir, 'server.properties'), 'level-name', level);
  }

  // ---------- modpacks ----------
  const LOADERS = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' };
  const VERSION = (v) => typeof v === 'string' && /^[\w.+-]+$/.test(v) && !/^\.+$/.test(v);
  // A Modrinth project (its address or slug) -> the .mrpack of its newest version for one of loaders (Modrinth's names;
  // a server's by default), a release before a beta, downloaded with its SHA-512 or SHA-1 checked. A version that names
  // no loaders is not left out: modpackInfo reads the loader from the pack itself.
  async function fromModrinth(ref, log, loaders = Object.values(LOADERS)) {
    const slug = /modrinth\.com\/modpack\/([\w.-]+)/.exec(ref)?.[1] || (/^[\w.-]+$/.test(ref) ? ref : null);
    if (!slug || /^\.+$/.test(slug)) throw fail('Give a Modrinth modpack address (https://modrinth.com/modpack/…) or its name');
    const versions = await getJson(`${modrinthApi()}/project/${slug}/version`).catch((err) => { throw err.status ? fail(`Modrinth has no modpack ${slug} (HTTP ${err.status})`) : err; });
    const packsOf = (v) => (Array.isArray(v.files) ? v.files : []).filter((f) => /\.mrpack$/i.test(f?.filename || '') && f.url);
    const when = (v) => Date.parse(v.date_published) || 0;
    const packs = (Array.isArray(versions) ? versions : []).filter((v) => v && typeof v === 'object' && packsOf(v).length);
    const fitting = packs.filter((v) => !Array.isArray(v.loaders) || v.loaders.some((l) => loaders.includes(l))).sort((a, b) => when(b) - when(a));
    const version = fitting.find((v) => v.version_type === 'release') || fitting[0];
    const file = version && (packsOf(version).find((f) => f.primary) || packsOf(version)[0]);
    if (!file) throw fail(packs.length ? `${slug} has no version for ${loaders.join(', ')}` : `${slug} has no .mrpack to download`);
    const sum = file.hashes?.sha512 ? ['sha512', file.hashes.sha512] : file.hashes?.sha1 ? ['sha1', file.hashes.sha1] : null;
    if (!sum) throw fail(`Modrinth publishes no checksum for ${file.filename}`);
    // Modrinth's name for the file is only a name in the temporary folder: no folders, nothing Windows refuses.
    const name = path.basename(file.filename.replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '-');
    const dest = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-${name}`);
    await fetchFile(file.url, dest, { size: file.size }, log);
    if (await hashOf(sum[0], dest) !== String(sum[1]).toLowerCase()) {
      fs.rmSync(dest, { force: true });
      throw fail(`Checksum mismatch for ${file.filename}`);
    }
    return dest;
  }
  // What a .mrpack holds: {name, version, mc, kind, loader, serverFiles, clientOnly}. A downloaded one that is not a
  // modpack PyIDE runs is not kept.
  function modpackInfo(file) {
    try {
      const raw = readEntry(file, 'modrinth.index.json');
      if (!raw) throw fail(`${path.basename(file)} is not a Modrinth modpack (no modrinth.index.json)`);
      let index = null;
      try { index = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch {}
      if (!index || typeof index !== 'object') throw fail(`${path.basename(file)} has a damaged modrinth.index.json`);
      const deps = index.dependencies || {};
      const loaderKey = Object.keys(LOADERS).find((k) => deps[k]);
      if (!loaderKey) throw fail(deps['quilt-loader'] ? 'Quilt modpacks are not supported yet' : 'The modpack names no mod loader Nano Studio runs (Fabric, Forge, NeoForge)');
      // Both go into download addresses.
      if (!VERSION(deps.minecraft)) throw fail('The modpack names no Minecraft version');
      if (!VERSION(deps[loaderKey])) throw fail(`The modpack names no ${KINDS[LOADERS[loaderKey]].title} version`);
      const files = Array.isArray(index.files) ? index.files.filter((f) => f && typeof f === 'object') : [];
      index.files = files;
      const name = typeof index.name === 'string' && index.name.trim() ? index.name : path.basename(file, path.extname(file));
      return { file, name, version: String(index.versionId ?? ''), mc: deps.minecraft, kind: LOADERS[loaderKey], loader: deps[loaderKey],
        serverFiles: files.filter((f) => f.env?.server !== 'unsupported').length, clientOnly: files.filter((f) => f.env?.server === 'unsupported').length, index };
    } catch (err) {
      discardDownload(file);
      throw err;
    }
  }
  // A server for the modpack: its Minecraft and exact loader version, the files the pack lists for servers (each
  // checked against its SHA-512 or SHA-1), its overrides and server-overrides; the .mrpack itself becomes the server's
  // client pack, since players need its client mods too. A downloaded .mrpack is not kept when this fails.
  async function createFromModpack({ file, url, name, memory, port, eula }, log) {
    const pack = modpackInfo(file || await fromModrinth(url, log));
    let srv = null;
    try {
      // Every file has an address and a checksum before anything is made.
      const files = pack.index.files.filter((f) => f.env?.server !== 'unsupported').map((f) => {
        const e = packEntry(f, String(f.path || '').replace(/\\/g, '/'));
        if (e.why) throw fail(`The modpack ${e.why}`);
        return e;
      });
      log(`${pack.name} ${pack.version}: Minecraft ${pack.mc}, ${KINDS[pack.kind].title} ${pack.loader}, ${pack.serverFiles} files for the server\n`);
      // The folder stays marked unfinished until the pack's files are in.
      srv = await create({ root, name: name || freeName(path.join(root, 'servers'), pack.name), kind: pack.kind, mc: pack.mc, loader: pack.loader, memory, port, eula }, log, { keepUnfinished: true });
      // What create described: a file of the pack named pyide-server.json does not replace it.
      const created = readServer(srv.dir);
      let n = 0;
      for (const f of files) {
        const dest = inside(srv.dir, f.rel);
        if (!dest) { log(`Skipped ${f.rel}: outside the server folder\n`); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        log(`(${++n}/${pack.serverFiles}) ${f.rel}\n`);
        await fetchChecked(fetchFile, f, dest, log);
      }
      // The pack's server.properties and eula.txt may come with it: its settings are the pack's, but the port is the
      // one the dialog gave, and agreeing to the EULA is the user's, as create wrote it.
      const props = path.join(srv.dir, 'server.properties');
      const eulaFile = path.join(srv.dir, 'eula.txt');
      const agreed = isFile(eulaFile) ? fs.readFileSync(eulaFile) : null;
      const ownPort = /^server-port=(\d+)/m.exec(isFile(props) ? fs.readFileSync(props, 'utf8') : '')?.[1];
      for (const prefix of ['overrides/', 'server-overrides/']) unpackZip(pack.file, srv.dir, prefix);
      if (agreed) fs.writeFileSync(eulaFile, agreed);
      if (ownPort) require('./templates').setProperty(props, 'server-port', ownPort);
      const clientPack = path.join(srv.dir, 'client-pack', path.basename(pack.file).replace(/^pyide-[0-9a-f]{8}-/, ''));
      fs.mkdirSync(path.dirname(clientPack), { recursive: true });
      fs.copyFileSync(pack.file, clientPack);
      discardDownload(pack.file);
      const desc = { ...created, modpack: { name: pack.name, version: pack.version, clientPack: path.relative(srv.dir, clientPack).replace(/\\/g, '/') } };
      writeServer(srv.dir, desc);
      unfinished.done(srv.dir);
      log(`${pack.name} is installed in ${path.relative(root, srv.dir)}\n`);
      return { ...srv, ...desc };
    } catch (err) {
      if (srv) unfinished.undo(srv.dir);
      discardDownload(pack.file);
      throw err;
    }
  }

  return { importServer, redescribe, drop, modpackInfo, fromModrinth, createFromModpack };
}

module.exports = { createImports, classify, detectServer, discardDownload, fetchChecked, hashOf, packEntry };
