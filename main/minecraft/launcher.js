// Nano Studio Craft's game side: Minecraft instances (instances/<name>, described by nano-instance.json) played through
// the official Minecraft Launcher. The launcher works in .launcher (its --workDir: versions, libraries,
// launcher_profiles.json), where each instance gets a version (nano-<name>, inheriting from its mod loader's version,
// with the server to join as game arguments) and a profile whose game folder is the instance's. The user signs in and
// presses Play in the launcher: nothing here handles Microsoft accounts. Servers the user joins (servers-list.json) may
// carry a client pack (.mrpack), synced into the instance at every Play.
// PYIDE_MC_LAUNCHER (tests): a JSON array, the program and its first arguments run in place of the launcher; any
// other value (off, []) finds none.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { KINDS, RELEASE, base, getJson, getText, mojangVersion, byVersion, neoforgeMc, standIn } = require('./sources');
const { openZip, readEntry, unpackZip } = require('./zipfile');
const { createImports, discardDownload } = require('./imports');

const INSTANCE = 'nano-instance.json';
const SERVERS = 'servers-list.json';
const WORK = '.launcher';
const LOADERS = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const PACK_LOADERS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const DOWNLOAD_PAGE = 'https://www.minecraft.net/download';
const NAME = /^[A-Za-z0-9][\w-]{0,39}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const HTTP = /^https?:\/\/\S+$/i;
// Modrinth's .mrpack format lets a pack download its files over https from these hosts only.
const PACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
// Versions go into download addresses and folder names.
const VERSION = (v) => typeof v === 'string' && /^[\w.+-]{1,64}$/.test(v) && !/^\.+$/.test(v);
// Instances and packs are release versions only: the arguments that join a server are chosen by the version number
// (serverArgs), which a snapshot's or pre-release's id does not give.
const ONLY_RELEASES = 'Nano Studio Craft plays release versions only';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
  fs.renameSync(`${p}.tmp`, p);
};
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const hashOf = (algo, file) => crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
const now = () => new Date().toISOString();
// A name or title as one line of at most 64 characters.
const oneLine = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 64).trim();
// rel under dir, or null when it names a path outside it or an alternate data stream (a colon).
const inside = (dir, rel) => {
  if (typeof rel !== 'string' || !rel) return null;
  const top = path.resolve(dir);
  const p = path.resolve(top, rel);
  return p.startsWith(top + path.sep) && !p.slice(top.length).includes(':') ? p : null;
};
const atLeast = (mc, v) => byVersion(mc, v) <= 0;

const workDir = (root) => path.join(root, WORK);
const instancesDir = (root) => path.join(root, 'instances');
const versionId = (name) => `nano-${name}`;

// ---------- addresses and join codes ----------
// host, host:port or [IPv6]:port -> {host, port, address}. Without a port the address stays without one: the game then
// looks up the domain's SRV record, as its own server list does.
function parseAddress(text) {
  const s = String(text ?? '').trim();
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?))(?::(\d{1,5}))?$/.exec(s);
  if (!m) throw fail(`${s ? `"${s}"` : 'An empty address'} is not a server address (host or host:port)`, 'badAddress');
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) throw fail('Use a port from 1 to 65535', 'badAddress');
  const host = m[1] || m[2];
  const shown = m[1] ? `[${host}]` : host;
  return { host, port, address: port ? `${shown}:${port}` : shown };
}
const packUrl = (url) => {
  if (url == null || url === '') return null;
  if (typeof url !== 'string' || !HTTP.test(url.trim())) throw fail('The pack is not an http(s) address', 'badPack');
  return url.trim();
};
// A join code is anyone's text: its pack comes over https (a shared pack is its tunnel's https address).
const codePack = (url) => {
  const p = packUrl(url);
  if (p && !/^https:\/\//i.test(p) && !standIn(p)) throw fail('The join code\'s pack is not an https address', 'badPack');
  return p;
};
const packFile = (u) => {
  let url = null;
  try { url = new URL(u); } catch { return false; }
  return (url.protocol === 'https:' && PACK_HOSTS.includes(url.hostname)) || standIn(url.href);
};
const pastable = (s) => encodeURIComponent(s).replace(/[!'()*.]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// nanostudio:join?addr=<host:port>&pack=<url-encoded url>&name=<server name>, found anywhere in the pasted text. A
// code's values are percent-encoded (pastable), so the code ends at a space, a quote, a parenthesis or <>, and
// punctuation after it ends the sentence it was pasted in.
function parseJoinCode(text) {
  const m = /nanostudio:(?:\/\/)?join\/?\?([^\s"'`()<>]+)/i.exec(String(text ?? ''));
  if (!m) throw fail('This is not a Nano Studio join code (nanostudio:join?addr=…)', 'badCode');
  const q = new URLSearchParams(m[1].replace(/[.,;:!?]+$/, ''));
  const { address } = parseAddress(q.get('addr'));
  return { address, pack: codePack(q.get('pack')), name: oneLine(q.get('name')) || address };
}
function joinCode({ address, pack, name } = {}) {
  const parts = [`addr=${parseAddress(address).address}`];
  if (codePack(pack)) parts.push(`pack=${pastable(pack.trim())}`);
  if (oneLine(name)) parts.push(`name=${pastable(oneLine(name))}`);
  return `nanostudio:join?${parts.join('&')}`;
}

// The game arguments that join a server: Minecraft 1.20 and later take Quick Play, older versions --server and
// --port. Before 1.13 a version names its arguments as one line (minecraftArguments), which a child version replaces
// rather than extends, so the parent's line comes first.
function serverArgs(mc, server, parentLine) {
  if (!server) return {};
  const { host, port, address } = parseAddress(server.address);
  if (atLeast(mc, '1.20')) return { arguments: { game: ['--quickPlayMultiplayer', address] } };
  const args = ['--server', host, '--port', String(port || 25565)];
  if (atLeast(mc, '1.13')) return { arguments: { game: args } };
  return { minecraftArguments: [parentLine, ...args].filter(Boolean).join(' ') };
}

// ---------- the official launcher ----------
// Where it is installed (its installer's default folders), or PYIDE_MC_LAUNCHER's program: an argv, or null.
function findLauncher(env = process.env) {
  if (env.PYIDE_MC_LAUNCHER !== undefined) {
    try {
      const argv = JSON.parse(env.PYIDE_MC_LAUNCHER);
      if (Array.isArray(argv) && argv.length && argv.every((a) => typeof a === 'string' && a)) return argv;
    } catch {}
    return null;
  }
  const dirs = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
  for (const dir of dirs) {
    const exe = dir && path.join(dir, 'Minecraft Launcher', 'MinecraftLauncher.exe');
    if (exe && isFile(exe)) return [exe];
  }
  return null;
}
// Detached, so it outlives Nano Studio. A stand-in (PYIDE_MC_LAUNCHER) is a console program whose window would only
// flash; the real launcher's window must show.
function startLauncher(argv, work) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1), '--workDir', work], { cwd: work, detached: true, stdio: 'ignore', windowsHide: process.env.PYIDE_MC_LAUNCHER !== undefined });
    child.once('error', (err) => reject(fail(`The Minecraft Launcher could not be started: ${err.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
// How the game is started. Only through the official launcher for now: starting it ourselves needs a Microsoft sign-in
// of our own, which Mojang has to approve first.
const METHODS = { official: { find: () => findLauncher(), start: startLauncher } };
const method = () => METHODS.official;

// launcher_profiles.json as the launcher keeps it; a file that cannot be read, or whose profiles are replaced, is kept
// beside the new one.
function readProfiles(file) {
  if (!fs.existsSync(file)) return { profiles: {}, settings: {}, version: 3 };
  const data = readJson(file);
  const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const keep = () => fs.copyFileSync(file, `${file}.broken-${Date.now()}`);
  if (!object(data)) {
    keep();
    return { profiles: {}, settings: {}, version: 3 };
  }
  if (!object(data.profiles)) {
    if (data.profiles != null) keep();
    data.profiles = {};
  }
  return data;
}
// Forge's and NeoForge's installers refuse a folder without launcher_profiles.json.
function ensureProfiles(work) {
  const file = path.join(work, 'launcher_profiles.json');
  if (!fs.existsSync(file)) writeJson(file, readProfiles(file));
}

// ---------- versions ----------
async function mcVersions(kind) {
  if (!LOADERS[kind]) throw fail(`Unknown mod loader ${kind}`);
  if (kind === 'quilt') return (await getJson(`${base().quilt}/versions/game`)).filter((v) => v?.stable && VERSION(v.version)).map((v) => v.version);
  return KINDS[kind].versions();
}
// The loader versions for a Minecraft version, newest first, and the one to pick when none is chosen.
async function loaderVersions(kind, mc) {
  if (!VERSION(mc)) throw fail('Choose a Minecraft version');
  if (kind === 'fabric' || kind === 'quilt') {
    const list = (await getJson(`${base()[kind]}/versions/loader/${mc}`)).filter((l) => VERSION(l?.loader?.version));
    const versions = list.map((l) => l.loader.version);
    // Fabric marks its stable loaders; Quilt names its betas.
    const stable = kind === 'fabric' ? list.find((l) => l.loader.stable)?.loader.version : versions.find((v) => !/-/.test(v));
    return { versions, recommended: stable || versions[0] || null };
  }
  if (kind === 'forge') {
    const xml = await getText(`${base().forge}/maven-metadata.xml`);
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).filter((v) => v.startsWith(`${mc}-`))
      .map((v) => v.slice(mc.length + 1)).filter(VERSION).sort(byVersion);
    const promos = (await getJson(base().forgePromos)).promos || {};
    return { versions, recommended: promos[`${mc}-recommended`] || promos[`${mc}-latest`] || versions[0] || null };
  }
  if (kind === 'neoforge') {
    const versions = (await KINDS.neoforge.allVersions()).filter((v) => VERSION(v) && neoforgeMc(v) === mc).sort(byVersion);
    return { versions, recommended: versions.find((v) => !/-/.test(v)) || versions[0] || null };
  }
  if (kind === 'vanilla') return { versions: [], recommended: null };
  throw fail(`Unknown mod loader ${kind}`);
}

// The installer's main class names its command-line options: a headless client install is --installClient.
function headlessClient(jar) {
  const manifest = readEntry(jar, 'META-INF/MANIFEST.MF')?.toString('utf8') || '';
  const main = /^Main-Class:\s*(\S+)/m.exec(manifest)?.[1];
  const cls = main && readEntry(jar, `${main.replace(/\./g, '/')}.class`);
  return !!cls && cls.includes('installClient');
}

function createLauncher({ fetchFile, ensureJava, javaFor, run, retried }) {
  // ---------- instances ----------
  const dirOf = (root, name) => {
    if (!NAME.test(name || '')) throw fail(`${name} is not an instance name`, 'noInstance');
    return path.join(instancesDir(root), name);
  };
  function readInstance(root, name) {
    const inst = readJson(path.join(dirOf(root, name), INSTANCE));
    if (!inst || typeof inst !== 'object' || Array.isArray(inst)) throw fail(`There is no instance ${name}`, 'noInstance');
    return { ...inst, name };
  }
  const writeInstance = (root, inst) => writeJson(path.join(dirOf(root, inst.name), INSTANCE), inst);
  const modsOf = (dir) => { try { return fs.readdirSync(path.join(dir, 'mods')).filter((n) => /\.jar$/i.test(n)).length; } catch { return 0; } };
  const describe = (root, inst) => ({ ...inst, title: inst.title || inst.name, dir: dirOf(root, inst.name), mods: modsOf(dirOf(root, inst.name)) });

  function instances(root) {
    const parent = instancesDir(root);
    const names = fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME.test(d.name)).map((d) => d.name) : [];
    return names.map((n) => { try { return describe(root, readInstance(root, n)); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => String(b.lastPlayed || b.created || '').localeCompare(String(a.lastPlayed || a.created || '')));
  }

  // A folder name for an instance: the title itself when it is one (an error when that folder exists and `exact`),
  // else made from it, numbered past the folders there.
  function freeInstance(root, raw, { exact } = {}) {
    const title = oneLine(raw);
    if (!title) throw fail('Give the instance a name');
    if (NAME.test(title) && !RESERVED.test(title)) {
      if (!fs.existsSync(path.join(instancesDir(root), title))) return { name: title, title };
      if (exact) throw fail(`instances/${title} already exists`, 'exists');
    }
    let stem = title.replace(/[^\w-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 32).replace(/-+$/, '') || 'instance';
    if (RESERVED.test(stem)) stem = `${stem}-mc`;
    let name = stem;
    for (let i = 2; fs.existsSync(path.join(instancesDir(root), name)); i++) name = `${stem}-${i}`;
    return { name, title };
  }

  // ---------- loaders ----------
  // The version id each loader's install writes into versions/.
  const expectedId = ({ mc, loader, loaderVersion: v }) => ({ vanilla: mc, fabric: `fabric-loader-${v}-${mc}`, quilt: `quilt-loader-${v}-${mc}`,
    forge: `${mc}-forge-${v}`, neoforge: `neoforge-${v}` })[loader];
  // The instance's loader into .launcher/versions -> the version id the instance's own version inherits from. Vanilla
  // needs nothing: the launcher downloads a version it has not got when one inherits from it.
  async function installLoader(root, inst, log) {
    const versions = path.join(workDir(root), 'versions');
    const has = (id) => VERSION(id) && isFile(path.join(versions, id, `${id}.json`));
    if (!LOADERS[inst.loader]) throw fail(`Unknown mod loader ${inst.loader}`);
    if (!VERSION(inst.mc)) throw fail('The instance names no Minecraft version');
    if (inst.loader === 'vanilla') return inst.mc;
    if (!VERSION(inst.loaderVersion)) throw fail(`The instance names no ${LOADERS[inst.loader]} version`);
    for (const id of [inst.loaderId, expectedId(inst)]) if (has(id)) return id;
    if (inst.loader === 'fabric' || inst.loader === 'quilt') {
      log(`${LOADERS[inst.loader]} ${inst.loaderVersion} for Minecraft ${inst.mc}\n`);
      const url = `${base()[inst.loader]}/versions/loader/${inst.mc}/${inst.loaderVersion}/profile/json`;
      const profile = await getJson(url);
      if (!VERSION(profile?.id)) throw fail(`${url} names no version`);
      writeJson(path.join(versions, profile.id, `${profile.id}.json`), profile);
      return profile.id;
    }
    return installForge(root, inst, has, log);
  }
  // Forge and NeoForge: the official installer in its headless client mode, which downloads Minecraft's client and the
  // libraries and runs its processors on the instance's Java.
  async function installForge(root, inst, has, log) {
    const source = KINDS[inst.loader];
    const work = workDir(root);
    fs.mkdirSync(work, { recursive: true });
    const r = await source.resolve(inst.mc, inst.loaderVersion);
    const tmp = fs.mkdtempSync(path.join(work, 'installer-'));
    try {
      const jar = path.join(tmp, r.file);
      await fetchFile(r.url, jar, { sha256: r.sha256 }, log);
      if (!headlessClient(jar)) {
        throw fail(`The ${source.title} ${inst.loaderVersion} installer has no client install without its window (--installClient), so Nano Studio cannot install it. Choose a newer ${source.title} version.`, 'noHeadless');
      }
      let id = null;
      try { id = JSON.parse(readEntry(jar, 'install_profile.json')?.toString('utf8').replace(/^﻿/, '') || 'null')?.version; } catch {}
      if (!VERSION(id)) throw fail(`${r.file} names no version in its install_profile.json`);
      ensureProfiles(work);
      const home = await ensureJava(await javaFor(inst.mc), { log });
      log(`Running the ${source.title} installer…\n`);
      // It writes installer.log into the folder it runs in, and skips what it already has on a retry.
      await retried('The installer', () => run(path.join(home, 'bin', 'java.exe'), ['-jar', jar, '--installClient', work], { cwd: tmp }, log), log);
      if (!has(id)) throw fail(`The ${source.title} installer finished without installing ${id}`);
      return id;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---------- the instance's version and profile, written at every Play ----------
  // Before 1.13, the line of arguments of the version the instance inherits from, through its own parents and, for a
  // version the launcher has not downloaded yet, from Mojang.
  async function argumentLine(root, id, mc) {
    const seen = new Set();
    while (VERSION(id) && !seen.has(id)) {
      seen.add(id);
      const json = readJson(path.join(workDir(root), 'versions', id, `${id}.json`));
      if (!json) break;
      if (typeof json.minecraftArguments === 'string') return json.minecraftArguments;
      id = json.inheritsFrom;
    }
    return (await mojangVersion(mc)).minecraftArguments || '';
  }
  async function writeVersion(root, inst, parent, server) {
    const id = versionId(inst.name);
    const line = server && !atLeast(inst.mc, '1.13') ? await argumentLine(root, parent, inst.mc) : '';
    const json = { id, inheritsFrom: parent, type: 'release', time: now(), releaseTime: now(), libraries: [], ...serverArgs(inst.mc, server, line) };
    writeJson(path.join(workDir(root), 'versions', id, `${id}.json`), json);
    return json;
  }
  // One custom profile per instance; the launcher's and the user's other profiles and settings stay as they are.
  function writeProfile(root, inst) {
    const file = path.join(workDir(root), 'launcher_profiles.json');
    const data = readProfiles(file);
    const key = versionId(inst.name);
    const old = data.profiles[key] && typeof data.profiles[key] === 'object' ? data.profiles[key] : {};
    const time = now();
    data.profiles[key] = { ...old, name: `${inst.title || inst.name} (Nano Studio)`, type: 'custom', created: old.created || time, lastVersionId: key,
      gameDir: dirOf(root, inst.name), javaArgs: `-Xmx${/^\d+[MG]$/i.test(inst.memory || '') ? inst.memory.toUpperCase() : '4G'}`, lastUsed: time, icon: old.icon || 'Grass' };
    writeJson(file, data);
    return data.profiles[key];
  }

  // ---------- packs ----------
  // A .mrpack's index: Minecraft, the loader (vanilla when it names none) and the files.
  function readPack(file) {
    const raw = readEntry(file, 'modrinth.index.json');
    if (!raw) throw fail('The pack is not a Modrinth modpack (no modrinth.index.json)', 'badPack');
    let index = null;
    try { index = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); } catch {}
    if (!index || typeof index !== 'object' || Array.isArray(index)) throw fail('The pack has a damaged modrinth.index.json', 'badPack');
    const deps = index.dependencies && typeof index.dependencies === 'object' ? index.dependencies : {};
    const key = Object.keys(PACK_LOADERS).find((k) => deps[k]);
    if (!VERSION(deps.minecraft)) throw fail('The pack names no Minecraft version', 'badPack');
    if (!RELEASE.test(deps.minecraft)) throw fail(`The pack is for Minecraft ${deps.minecraft}, a snapshot or pre-release: ${ONLY_RELEASES}`, 'badPack');
    if (key && !VERSION(deps[key])) throw fail(`The pack names no ${LOADERS[PACK_LOADERS[key]]} version`, 'badPack');
    return { mc: deps.minecraft, loader: key ? PACK_LOADERS[key] : 'vanilla', loaderVersion: key ? deps[key] : null,
      name: oneLine(index.name) || null, version: oneLine(index.versionId) || null, files: Array.isArray(index.files) ? index.files.filter((f) => f && typeof f === 'object') : [] };
  }
  // A pack address -> a local .mrpack: a Modrinth modpack's newest version, or the file at the address. Both land in
  // the temporary folder (discardDownload removes them).
  async function downloadPack(url, log) {
    if (/modrinth\.com\/modpack\//i.test(url) || !/^https?:/i.test(url)) return createImports({ fetchFile }).fromModrinth(url, log);
    const dest = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-pack.mrpack`);
    await fetchFile(url, dest, {}, log);
    return dest;
  }
  // The pack's client files into the instance: each listed file downloaded with its hash checked (all of them before
  // anything in the instance changes), then the files the previous pack installed and this one does not removed, the
  // new ones moved in and overrides/ and client-overrides/ unpacked. Files the user added are not the pack's and stay;
  // a pack mod the user disabled (.jar.disabled) stays disabled. -> the files the pack now owns.
  async function applyPack(dir, inst, file, pack, log) {
    const files = pack.files.filter((f) => f.env?.client !== 'unsupported').map((f) => {
      const rel = String(f.path || '').replace(/\\/g, '/');
      const dest = inside(dir, rel);
      if (!dest) throw fail(`The pack names a file outside the instance: ${f.path}`, 'badPack');
      const from = (Array.isArray(f.downloads) ? f.downloads : []).find(packFile);
      const sum = f.hashes?.sha512 ? ['sha512', f.hashes.sha512] : f.hashes?.sha1 ? ['sha1', f.hashes.sha1] : null;
      if (!from) throw fail(`The pack gives no https download address on ${PACK_HOSTS.join(', ')} for ${rel}`, 'badPack');
      if (!sum) throw fail(`The pack gives no checksum for ${rel}`, 'badPack');
      return { rel, dest, from, sum: [sum[0], String(sum[1]).toLowerCase()], size: f.fileSize };
    });
    const zip = openZip(file);
    const names = zip.names;
    zip.close();
    const overrides = names.filter((n) => /^(client-)?overrides\/./.test(n) && !n.endsWith('/')).map((n) => n.slice(n.indexOf('/') + 1)).filter((rel) => inside(dir, rel));
    const staging = fs.mkdtempSync(path.join(dir, '.pack-'));
    try {
      const ready = [];
      for (const [i, f] of files.entries()) {
        if ([f.dest, `${f.dest}.disabled`].some((p) => isFile(p) && hashOf(f.sum[0], p) === f.sum[1])) continue;
        log(`(${i + 1}/${files.length}) ${f.rel}\n`);
        const tmp = path.join(staging, String(i));
        await fetchFile(f.from, tmp, { size: f.size }, () => {});
        if (hashOf(f.sum[0], tmp) !== f.sum[1]) throw fail(`Checksum mismatch for ${f.rel}`);
        ready.push({ tmp, dest: f.dest });
      }
      const owned = [...new Set([...files.map((f) => f.rel), ...overrides])];
      const keep = new Set(owned.map((r) => r.toLowerCase()));
      for (const rel of Array.isArray(inst.pack?.files) ? inst.pack.files : []) {
        const p = !keep.has(String(rel).toLowerCase()) && inside(dir, rel);
        if (!p) continue;
        for (const q of [p, `${p}.disabled`]) if (isFile(q)) { fs.rmSync(q, { force: true }); log(`Removed ${path.relative(dir, q)}\n`); }
      }
      const disabled = (p) => isFile(`${p}.disabled`) && !isFile(p);
      for (const { tmp, dest } of ready) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(tmp, disabled(dest) ? `${dest}.disabled` : dest);
      }
      const wasDisabled = overrides.map((rel) => inside(dir, rel)).filter(disabled);
      for (const prefix of ['overrides/', 'client-overrides/']) unpackZip(file, dir, prefix);
      for (const p of wasDisabled) fs.renameSync(p, `${p}.disabled`);
      return owned;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  // The pack at `url` synced into the instance when it changed since the last sync (its SHA-1: a shared pack's address
  // changes with each tunnel); Minecraft and the loader become the pack's. A pack synced moments ago (Add Server, then
  // its first Play) is not downloaded again for that Play.
  const recent = new Map(); // instance folder (lower case) + url -> when join synced it
  async function syncPack(root, inst, url, log, { reuse = false } = {}) {
    const dir = dirOf(root, inst.name);
    const key = `${dir.toLowerCase()} ${url}`;
    const synced = recent.get(key) || 0;
    recent.delete(key);
    if (reuse && inst.pack?.url === url && Date.now() - synced < 120000) return inst;
    log(`Checking the server's pack ${url}\n`);
    const file = await downloadPack(url, log);
    try {
      const sha1 = hashOf('sha1', file);
      let next = inst;
      if (inst.pack?.sha1 === sha1) {
        log('The pack has not changed.\n');
        if (inst.pack.url !== url) writeInstance(root, next = { ...inst, pack: { ...inst.pack, url } });
      } else next = await fromPackFile(root, inst, file, url, log);
      if (!reuse) recent.set(key, Date.now());
      return next;
    } finally { discardDownload(file); }
  }
  async function fromPackFile(root, inst, file, url, log) {
    const pack = readPack(file);
    const files = await applyPack(dirOf(root, inst.name), inst, file, pack, log);
    const next = { ...inst, mc: pack.mc, loader: pack.loader, loaderVersion: pack.loaderVersion,
      pack: { url: url || null, sha1: hashOf('sha1', file), name: pack.name, version: pack.version, files } };
    if (next.mc !== inst.mc || next.loader !== inst.loader || next.loaderVersion !== inst.loaderVersion) {
      delete next.loaderId;
      if (inst.mc) log(`The pack is for Minecraft ${pack.mc}, ${LOADERS[pack.loader]}${pack.loaderVersion ? ` ${pack.loaderVersion}` : ''}: the instance follows it.\n`);
    }
    log(`${pack.name || 'The pack'}${pack.version ? ` ${pack.version}` : ''}: ${files.length} files\n`);
    writeInstance(root, next);
    return next;
  }

  // One job at a time per instance: two syncs into the same folder would remove each other's files.
  const busy = new Set();
  async function exclusive(root, name, step) {
    const key = dirOf(root, name).toLowerCase();
    if (busy.has(key)) throw fail(`${name} is busy with another download or Play`, 'busy');
    busy.add(key);
    try { return await step(); } finally { busy.delete(key); }
  }
  // A new instance's folder, removed again when what fills it fails.
  async function made(root, name, step) {
    const dir = dirOf(root, name);
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    try { return await exclusive(root, name, step); } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }
  const memoryOf = (m) => {
    if (m == null || m === '') return '4G';
    if (!/^\d+[MG]$/i.test(m)) throw fail('Memory is a number of M or G, such as 4G');
    return m.toUpperCase();
  };

  async function create(root, { name, mc, loader = 'vanilla', loaderVersion, memory } = {}, log) {
    if (!LOADERS[loader]) throw fail(`Unknown mod loader ${loader}`);
    if (!VERSION(mc)) throw fail('Choose a Minecraft version');
    if (!RELEASE.test(mc)) throw fail(`Minecraft ${mc} is a snapshot or pre-release: ${ONLY_RELEASES}`);
    if (loaderVersion != null && loaderVersion !== '' && !VERSION(loaderVersion)) throw fail(`${loaderVersion} is not a ${LOADERS[loader]} version`);
    const mem = memoryOf(memory);
    const slot = freeInstance(root, name, { exact: true });
    const version = loader === 'vanilla' ? null : loaderVersion || (await loaderVersions(loader, mc)).recommended;
    if (loader !== 'vanilla' && !VERSION(version)) throw fail(`${LOADERS[loader]} has no loader for Minecraft ${mc}`);
    return made(root, slot.name, async () => {
      const inst = { ...slot, mc, loader, loaderVersion: version, memory: mem, created: now(), lastPlayed: null };
      log(`${inst.title}: Minecraft ${mc}, ${LOADERS[loader]}${version ? ` ${version}` : ''}\n`);
      inst.loaderId = await installLoader(root, inst, log);
      writeInstance(root, inst);
      return describe(root, inst);
    });
  }

  // A Modrinth modpack (a Market project's address or slug, a direct .mrpack address, or a file) as a new instance.
  async function fromPack(root, { url, file, name, memory } = {}, log) {
    if (!file && !url) throw fail('Give the pack\'s address or file');
    if (file && !isFile(file)) throw fail(`${file} does not exist`);
    const local = file || await downloadPack(String(url).trim(), log);
    try {
      const pack = readPack(local);
      const slot = freeInstance(root, name || pack.name || path.basename(local, path.extname(local)));
      return await made(root, slot.name, async () => {
        let inst = { ...slot, mc: pack.mc, loader: pack.loader, loaderVersion: pack.loaderVersion, memory: memoryOf(memory), created: now(), lastPlayed: null };
        inst = await fromPackFile(root, inst, local, file ? null : String(url).trim(), log);
        inst.loaderId = await installLoader(root, inst, log);
        writeInstance(root, inst);
        return describe(root, inst);
      });
    } finally { if (!file) discardDownload(local); }
  }

  // The instance's launcher profile and version; the renderer moves its folder to the Recycle Bin.
  function remove(root, name) {
    dirOf(root, name);
    const file = path.join(workDir(root), 'launcher_profiles.json');
    if (fs.existsSync(file)) {
      const data = readProfiles(file);
      if (data.profiles[versionId(name)]) { delete data.profiles[versionId(name)]; writeJson(file, data); }
    }
    fs.rmSync(path.join(workDir(root), 'versions', versionId(name)), { recursive: true, force: true });
    const list = servers(root);
    if (list.some((s) => s.instance === name)) saveServers(root, list.map((s) => (s.instance === name ? { ...s, instance: null } : s)));
    return true;
  }

  // ---------- servers to join ----------
  const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  function checkServer(s) {
    if (!s || typeof s !== 'object') throw fail('A server is {name, address, pack?, instance?}', 'badAddress');
    const { address } = parseAddress(s.address);
    const instance = s.instance && NAME.test(s.instance) ? s.instance : null;
    return { name: oneLine(s.name) || address, address, pack: packUrl(s.pack), instance };
  }
  function servers(root) {
    const list = readJson(path.join(root, SERVERS));
    return (Array.isArray(list) ? list : []).map((s) => { try { return checkServer(s); } catch { return null; } }).filter(Boolean);
  }
  // One entry per address, the last given winning.
  function saveServers(root, list) {
    if (!Array.isArray(list)) throw fail('The server list is an array');
    const out = [];
    for (const s of list.map(checkServer)) {
      const at = out.findIndex((o) => sameAddress(o.address, s.address));
      if (at >= 0) out[at] = s; else out.push(s);
    }
    writeJson(path.join(root, SERVERS), out);
    return out;
  }

  // A join code, or an address (with a pack, a name, or the version and loader to play it with when it has no pack) ->
  // {server, instance}: the server's instance made or brought up to date from its pack, and the server saved. Without
  // a pack, an instance or a version -> {needsVersion: true, server}.
  async function join(root, req = {}, log) {
    const target = req.code ? parseJoinCode(req.code) : (() => {
      const { address } = parseAddress(req.address);
      return { address, pack: packUrl(req.pack), name: oneLine(req.name) || address };
    })();
    const list = servers(root);
    const known = list.find((s) => sameAddress(s.address, target.address));
    const pack = target.pack || (!req.code && known?.pack) || null;
    let inst = null;
    if (known?.instance) { try { inst = readInstance(root, known.instance); } catch {} }
    const save = (instance) => {
      const server = { name: target.name, address: target.address, pack, instance: instance.name };
      saveServers(root, known ? list.map((s) => (s === known ? server : s)) : [...list, server]);
      return { server, instance: describe(root, instance) };
    };
    const connect = async (instance) => {
      let next = pack ? await syncPack(root, instance, pack, log) : instance;
      next = { ...next, server: { name: target.name, address: target.address } };
      next.loaderId = await installLoader(root, next, log);
      writeInstance(root, next);
      return next;
    };
    if (inst) return save(await exclusive(root, inst.name, () => connect(inst)));
    if (pack) {
      const slot = freeInstance(root, target.name);
      return save(await made(root, slot.name, () => connect({ ...slot, mc: null, loader: 'vanilla', loaderVersion: null, memory: '4G', created: now(), lastPlayed: null })));
    }
    if (!VERSION(req.mc)) return { needsVersion: true, server: { name: target.name, address: target.address, pack: null, instance: null } };
    const created = await create(root, { name: req.name || target.name, mc: req.mc, loader: req.loader, loaderVersion: req.loaderVersion, memory: req.memory }, log);
    return save(await exclusive(root, created.name, () => connect(readInstance(root, created.name))));
  }

  // Play: the server's pack synced, the loader installed, the instance's version (with the server to join) and
  // profile written, and the official launcher started on .launcher, where the user signs in and presses Play.
  // server: an address, or {address, name?, pack?}; a saved server's pack is used when none is given. Without the
  // launcher -> {launched: false, code: 'noLauncher', download} before anything is downloaded.
  async function play(root, name, { server } = {}, log) {
    const how = method();
    const argv = how.find();
    if (!argv) return { launched: false, code: 'noLauncher', download: DOWNLOAD_PAGE };
    return exclusive(root, name, async () => {
      let inst = readInstance(root, name);
      let srv = null;
      if (server) {
        const given = typeof server === 'string' ? { address: server } : server;
        const { address } = parseAddress(given.address);
        const saved = servers(root).find((s) => sameAddress(s.address, address));
        srv = { name: oneLine(given.name) || saved?.name || address, address, pack: packUrl(given.pack) || saved?.pack || null };
      }
      if (srv?.pack) inst = await syncPack(root, inst, srv.pack, log, { reuse: true });
      inst = { ...inst, loaderId: await installLoader(root, inst, log), lastPlayed: now() };
      if (srv) inst.server = { name: srv.name, address: srv.address };
      const version = await writeVersion(root, inst, inst.loaderId, srv);
      writeProfile(root, inst);
      writeInstance(root, inst);
      log(`Starting the Minecraft Launcher with the profile ${inst.title || inst.name} (Nano Studio)${srv ? `, joining ${srv.address}` : ''}\n`);
      await how.start(argv, workDir(root));
      return { launched: true, launcher: argv[0], versionId: version.id, instance: describe(root, inst) };
    });
  }

  // ---------- mods of an instance ----------
  function mods(root, name) {
    const inst = readInstance(root, name);
    const dir = path.join(dirOf(root, name), 'mods');
    const owned = new Set((Array.isArray(inst.pack?.files) ? inst.pack.files : []).map((f) => String(f).toLowerCase()));
    return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((n) => /\.jar(\.disabled)?$/i.test(n) && isFile(path.join(dir, n))).map((file) => {
      const jar = file.replace(/\.disabled$/i, '');
      return { file, name: jar, enabled: file === jar, size: fs.statSync(path.join(dir, file)).size, fromPack: owned.has(`mods/${jar}`.toLowerCase()), path: path.join(dir, file) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  // A mod turned on or off by its .disabled ending, which the loaders skip.
  function setMod(root, name, file, enabled) {
    const dir = path.join(dirOf(root, name), 'mods');
    if (typeof file !== 'string' || path.basename(file) !== file || !/\.jar(\.disabled)?$/i.test(file)) throw fail(`${file} is not a mod of ${name}`);
    const jar = file.replace(/\.disabled$/i, '');
    const from = path.join(dir, file);
    const to = path.join(dir, enabled ? jar : `${jar}.disabled`);
    if (!isFile(from)) throw fail(`${file} is not in ${name}'s mods`);
    if (from !== to) fs.renameSync(from, to);
    return mods(root, name);
  }

  const status = (root) => {
    const argv = method().find();
    return { launcher: argv ? argv[0] : null, method: 'official', download: DOWNLOAD_PAGE, workDir: workDir(root), instancesDir: instancesDir(root) };
  };

  return { status, instances, versions: mcVersions, loaderVersions, create, fromPack, remove, servers, saveServers, join, play, mods, setMod, joinCode, parseJoinCode };
}

module.exports = { createLauncher, findLauncher, parseJoinCode, joinCode, parseAddress, serverArgs, headlessClient, readProfiles };
