// What comes into the Minecraft window from outside: files and folders dropped on it (a server made elsewhere, a
// world, a resource pack, plugin and mod jars) and modpacks (.mrpack, a file or a Modrinth project) that become a
// server. The feature module (main/features/minecraft.js) passes in what these steps share with it.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openZip, readEntry } = require('./zipfile');
const { KINDS, neoforgeMc, HEADERS } = require('./sources');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const inside = (root, rel) => { const p = path.resolve(root, rel); return p.startsWith(path.resolve(root) + path.sep) ? p : null; };
// A free folder name under parent, from a name made safe for a server name.
function freeName(parent, raw) {
  const base = (raw.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 32) || 'server').replace(/-+$/, '') || 'server';
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
    const items = paths.map(classify);
    const done = [];
    const skipped = [];
    const modpacks = [];
    const all = servers();
    const target = (fits) => {
      if (serverDir) { const s = all.find((x) => x.dir.toLowerCase() === serverDir.toLowerCase()); return s && fits(s) ? s : null; }
      const fitting = all.filter(fits);
      return fitting.length === 1 ? fitting[0] : null;
    };
    for (const it of items) {
      try {
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
          if (it.zip) {
            const zip = openZip(it.path);
            try {
              for (const n of zip.names.filter((x) => !x.endsWith('/'))) {
                const out = inside(dest, n);
                if (!out) continue;
                fs.mkdirSync(path.dirname(out), { recursive: true });
                fs.writeFileSync(out, zip.read(n));
              }
            } finally { zip.close(); }
          } else await fs.promises.cp(it.path, dest, { recursive: true, force: true });
          done.push({ name: it.name, what: 'resourcepack', to: dest, server: s.name });
        } else if (it.kind === 'world') {
          const s = target((x) => !x.proxy);
          if (!s) { skipped.push({ name: it.name, why: 'target' }); continue; }
          const name = freeName(s.dir, it.name);
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
  // A Modrinth project (its address or slug) -> the newest version's .mrpack, downloaded with its SHA-1 checked.
  async function fromModrinth(ref, log) {
    const slug = /modrinth\.com\/modpack\/([\w.-]+)/.exec(ref)?.[1] || (/^[\w.-]+$/.test(ref) ? ref : null);
    if (!slug) throw fail('Give a Modrinth modpack address (https://modrinth.com/modpack/…) or its name');
    const api = (() => { try { return JSON.parse(process.env.PYIDE_MC_SOURCES || '{}').modrinth; } catch { return null; } })() || 'https://api.modrinth.com/v2';
    const res = await fetch(`${api}/project/${slug}/version`, { headers: HEADERS });
    if (!res.ok) throw fail(`Modrinth has no modpack ${slug} (HTTP ${res.status})`);
    const versions = await res.json();
    const file = versions.flatMap((v) => v.files.filter((f) => /\.mrpack$/.test(f.filename)).map((f) => ({ ...f, version: v }))).find((f) => f.primary) || versions[0]?.files?.[0];
    if (!file) throw fail(`${slug} has no .mrpack to download`);
    const dest = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-${file.filename}`);
    await fetchFile(file.url, dest, {}, log);
    if (file.hashes?.sha1 && crypto.createHash('sha1').update(fs.readFileSync(dest)).digest('hex') !== file.hashes.sha1) throw fail(`Checksum mismatch for ${file.filename}`);
    return dest;
  }
  // What a .mrpack holds: {name, version, mc, kind, loader, serverFiles, clientOnly}.
  function modpackInfo(file) {
    const raw = readEntry(file, 'modrinth.index.json');
    if (!raw) throw fail(`${path.basename(file)} is not a Modrinth modpack (no modrinth.index.json)`);
    const index = JSON.parse(raw.toString('utf8'));
    const deps = index.dependencies || {};
    const loaderKey = Object.keys(LOADERS).find((k) => deps[k]);
    if (!loaderKey) throw fail(deps['quilt-loader'] ? 'Quilt modpacks are not supported yet' : 'The modpack names no mod loader PyIDE runs (Fabric, Forge, NeoForge)');
    const files = index.files || [];
    return { file, name: index.name || path.basename(file, '.mrpack'), version: index.versionId || '', mc: deps.minecraft, kind: LOADERS[loaderKey], loader: deps[loaderKey],
      serverFiles: files.filter((f) => f.env?.server !== 'unsupported').length, clientOnly: files.filter((f) => f.env?.server === 'unsupported').length, index };
  }
  // A server for the modpack: its Minecraft and exact loader version, the files the pack lists for servers (each
  // checked against its SHA-1 or SHA-512), its overrides and server-overrides; the .mrpack itself becomes the server's
  // client pack, since players need its client mods too.
  async function createFromModpack({ file, url, name, memory, port, eula }, log) {
    const pack = modpackInfo(file || await fromModrinth(url, log));
    log(`${pack.name} ${pack.version}: Minecraft ${pack.mc}, ${KINDS[pack.kind].title} ${pack.loader}, ${pack.serverFiles} files for the server\n`);
    const srv = await create({ root, name: name || freeName(path.join(root, 'servers'), pack.name), kind: pack.kind, mc: pack.mc, loader: pack.loader, memory, port, eula }, log);
    try {
      let n = 0;
      for (const f of pack.index.files || []) {
        if (f.env?.server === 'unsupported') continue;
        const dest = inside(srv.dir, f.path);
        if (!dest) { log(`Skipped ${f.path}: outside the server folder\n`); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        log(`(${++n}/${pack.serverFiles}) ${f.path}\n`);
        await fetchFile(f.downloads[0], dest, { size: f.fileSize }, () => {});
        const sum = f.hashes?.sha512 ? ['sha512', f.hashes.sha512] : f.hashes?.sha1 ? ['sha1', f.hashes.sha1] : null;
        if (sum && crypto.createHash(sum[0]).update(fs.readFileSync(dest)).digest('hex') !== sum[1]) throw fail(`Checksum mismatch for ${f.path}`);
      }
      const zip = openZip(pack.file);
      try {
        for (const prefix of ['overrides/', 'server-overrides/']) {
          for (const entry of zip.names.filter((x) => x.startsWith(prefix) && !x.endsWith('/'))) {
            const dest = inside(srv.dir, entry.slice(prefix.length));
            if (!dest) continue;
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, zip.read(entry));
          }
        }
      } finally { zip.close(); }
      const clientPack = path.join(srv.dir, 'client-pack', path.basename(pack.file).replace(/^pyide-[0-9a-f]{8}-/, ''));
      fs.mkdirSync(path.dirname(clientPack), { recursive: true });
      fs.copyFileSync(pack.file, clientPack);
      const desc = { ...readServer(srv.dir), modpack: { name: pack.name, version: pack.version, clientPack: path.relative(srv.dir, clientPack).replace(/\\/g, '/') } };
      writeServer(srv.dir, desc);
      log(`${pack.name} is installed in ${path.relative(root, srv.dir)}\n`);
      return { ...srv, ...desc };
    } catch (err) {
      fs.rmSync(srv.dir, { recursive: true, force: true });
      throw err;
    }
  }

  return { importServer, drop, modpackInfo, fromModrinth, createFromModpack };
}

module.exports = { createImports, classify, detectServer };
