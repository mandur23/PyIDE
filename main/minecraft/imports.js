// What comes into the Minecraft window from outside: files and folders dropped on it (a server made elsewhere, a
// world, a resource pack, plugin and mod jars) and modpacks (.mrpack, a file or a Modrinth project) that become a
// server. The feature module (main/features/minecraft.js) passes in what these steps share with it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openZip, readEntry, unpackZip } = require('./zipfile');
const { KINDS, neoforgeMc, getJson, modrinthApi } = require('./sources');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
// A .mrpack fromModrinth downloaded (into the temporary folder, under a pyide-<hex>- name) is removed once the server
// has its copy or the dialog is cancelled; any other file, the user's own, is left alone.
function discardDownload(file) {
  if (file && path.dirname(path.resolve(file)) === path.resolve(os.tmpdir()) && /^pyide-[0-9a-f]{8}-.*\.mrpack$/.test(path.basename(file))) fs.rmSync(file, { force: true });
}
// rel under root, or null when it names a path outside it or an alternate data stream (a colon).
const inside = (root, rel) => {
  if (typeof rel !== 'string') return null;
  const p = path.resolve(root, rel);
  return p.startsWith(path.resolve(root) + path.sep) && !p.slice(path.resolve(root).length).includes(':') ? p : null;
};
// A free folder name under parent, from a name made safe for a server name (fallback when nothing of it is).
function freeName(parent, raw, fallback = 'server') {
  const base = (raw.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32) || fallback).replace(/-+$/, '') || fallback;
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
    } catch { return { path: p, name, kind: 'unknown' }; } finally { zip?.close(); }
  }
  return { path: p, name, kind: 'unknown' };
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

function createImports({ root, servers, create, javaFor, javaOfJar, fetchFile, writeServer, readServer }) {
  // A server folder made elsewhere becomes one of the project's: copied into servers/ (left where it is when it is
  // there already) and described. Its eula.txt is left as it is: agreeing is the user's.
  async function importServer(src, log) {
    const found = detectServer(src, javaOfJar);
    if (!found) throw fail(`${path.basename(src)} does not look like a Minecraft server PyIDE knows (Paper, Purpur, Velocity, Vanilla, Fabric, Forge or NeoForge)`);
    const parent = path.join(root, 'servers');
    const already = path.resolve(path.dirname(src)).toLowerCase() === path.resolve(parent).toLowerCase();
    if (already && readServer(src)) throw fail(`${path.basename(src)} is one of the project's servers already`);
    const dir = already ? src : path.join(parent, freeName(parent, path.basename(src)));
    if (!already) {
      log(`Copying ${src} to ${dir}…\n`);
      fs.mkdirSync(parent, { recursive: true });
      await fs.promises.cp(src, dir, { recursive: true, errorOnExist: true });
    }
    const java = found.java || (found.mc && /^\d/.test(found.mc) ? await javaFor(found.mc).catch(() => null) : null)
      || javaOfJar(path.join(dir, found.launch.jar || ''));
    const desc = { kind: found.kind, mc: found.mc || 'unknown', loader: found.loader || null, build: null, java, memory: '2G', launch: found.launch, mdk: null, imported: true };
    if (KINDS[found.kind]?.mods && found.mc) {
      try { desc.mdk = (await KINDS[found.kind].resolve(found.mc, found.loader || undefined)).mdk || null; } catch {}
    }
    writeServer(dir, desc);
    log(`Imported ${path.basename(dir)}: ${KINDS[found.kind].title} ${desc.mc}${desc.loader ? ` (${desc.loader})` : ''}, Java ${java}\n`);
    return { name: path.basename(dir), dir, ...desc };
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
          modpacks.push(it.path);
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
          const dest = path.join(s.dir, 'resourcepack');
          if (it.zip) unpackZip(it.path, dest);
          else await fs.promises.cp(it.path, dest, { recursive: true, force: true });
          done.push({ name: it.name, what: 'resourcepack', to: dest, server: s.name });
        } else if (it.kind === 'world') {
          const s = target((x) => !x.proxy);
          if (!s) { skipped.push({ name: it.name, why: 'target' }); continue; }
          const name = freeName(s.dir, it.name, 'world');
          await fs.promises.cp(it.path, path.join(s.dir, name), { recursive: true, errorOnExist: true });
          setLevelName(s.dir, name);
          done.push({ name: it.name, what: 'world', to: path.join(s.dir, name), server: s.name });
        } else skipped.push({ name: it.name, why: 'unknown' });
      } catch (err) {
        skipped.push({ name: it.name, why: 'error', message: err.message });
      }
    }
    return { done, skipped, modpacks };
  }

  function setLevelName(dir, level) {
    const file = path.join(dir, 'server.properties');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, /^level-name=.*$/m.test(text) ? text.replace(/^level-name=.*$/m, `level-name=${level}`) : `${text.replace(/\n?$/, '\n')}level-name=${level}\n`);
  }

  // ---------- modpacks ----------
  const LOADERS = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' };
  const VERSION = (v) => typeof v === 'string' && /^[\w.+-]+$/.test(v) && !/^\.+$/.test(v);
  // A Modrinth project (its address or slug) -> the newest version's .mrpack, downloaded with its SHA-512 or SHA-1 checked.
  async function fromModrinth(ref, log) {
    const slug = /modrinth\.com\/modpack\/([\w.-]+)/.exec(ref)?.[1] || (/^[\w.-]+$/.test(ref) ? ref : null);
    if (!slug || /^\.+$/.test(slug)) throw fail('Give a Modrinth modpack address (https://modrinth.com/modpack/…) or its name');
    const versions = await getJson(`${modrinthApi()}/project/${slug}/version`).catch((err) => { throw err.status ? fail(`Modrinth has no modpack ${slug} (HTTP ${err.status})`) : err; });
    const packs = (Array.isArray(versions) ? versions : []).flatMap((v) => (Array.isArray(v?.files) ? v.files : []).filter((f) => /\.mrpack$/i.test(f?.filename || '') && f.url));
    const file = packs.find((f) => f.primary) || packs[0];
    if (!file) throw fail(`${slug} has no .mrpack to download`);
    const sum = file.hashes?.sha512 ? ['sha512', file.hashes.sha512] : file.hashes?.sha1 ? ['sha1', file.hashes.sha1] : null;
    if (!sum) throw fail(`Modrinth publishes no checksum for ${file.filename}`);
    // Modrinth's name for the file is only a name in the temporary folder: no folders, nothing Windows refuses.
    const name = path.basename(file.filename.replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '-');
    const dest = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-${name}`);
    await fetchFile(file.url, dest, { size: file.size }, log);
    if (crypto.createHash(sum[0]).update(fs.readFileSync(dest)).digest('hex') !== sum[1]) {
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
      if (!loaderKey) throw fail(deps['quilt-loader'] ? 'Quilt modpacks are not supported yet' : 'The modpack names no mod loader PyIDE runs (Fabric, Forge, NeoForge)');
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
        const from = (Array.isArray(f.downloads) ? f.downloads : []).find((u) => /^https?:\/\//i.test(u));
        const sum = f.hashes?.sha512 ? ['sha512', f.hashes.sha512] : f.hashes?.sha1 ? ['sha1', f.hashes.sha1] : null;
        if (!from) throw fail(`The modpack gives no download address for ${f.path}`);
        if (!sum) throw fail(`The modpack gives no checksum for ${f.path}`);
        return { path: f.path, from, sum, size: f.fileSize };
      });
      log(`${pack.name} ${pack.version}: Minecraft ${pack.mc}, ${KINDS[pack.kind].title} ${pack.loader}, ${pack.serverFiles} files for the server\n`);
      srv = await create({ root, name: name || freeName(path.join(root, 'servers'), pack.name), kind: pack.kind, mc: pack.mc, loader: pack.loader, memory, port, eula }, log);
      // What create described: a file of the pack named pyide-server.json does not replace it.
      const created = readServer(srv.dir);
      let n = 0;
      for (const f of files) {
        const dest = inside(srv.dir, f.path);
        if (!dest) { log(`Skipped ${f.path}: outside the server folder\n`); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        log(`(${++n}/${pack.serverFiles}) ${f.path}\n`);
        await fetchFile(f.from, dest, { size: f.size }, () => {});
        if (crypto.createHash(f.sum[0]).update(fs.readFileSync(dest)).digest('hex') !== f.sum[1]) throw fail(`Checksum mismatch for ${f.path}`);
      }
      for (const prefix of ['overrides/', 'server-overrides/']) unpackZip(pack.file, srv.dir, prefix);
      const clientPack = path.join(srv.dir, 'client-pack', path.basename(pack.file).replace(/^pyide-[0-9a-f]{8}-/, ''));
      fs.mkdirSync(path.dirname(clientPack), { recursive: true });
      fs.copyFileSync(pack.file, clientPack);
      discardDownload(pack.file);
      const desc = { ...created, modpack: { name: pack.name, version: pack.version, clientPack: path.relative(srv.dir, clientPack).replace(/\\/g, '/') } };
      writeServer(srv.dir, desc);
      log(`${pack.name} is installed in ${path.relative(root, srv.dir)}\n`);
      return { ...srv, ...desc };
    } catch (err) {
      if (srv) fs.rmSync(srv.dir, { recursive: true, force: true });
      discardDownload(pack.file);
      throw err;
    }
  }

  return { importServer, drop, modpackInfo, fromModrinth, createFromModpack };
}

module.exports = { createImports, classify, detectServer, discardDownload };
