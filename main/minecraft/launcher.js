// Nano Studio Craft's game side: Minecraft instances (instances/<name>, described by nano-instance.json) played through
// the official Minecraft Launcher. The launcher works in .launcher (its --workDir: versions, libraries,
// launcher_profiles.json), or in the user's .minecraft when it is the Store's, which takes no arguments. There each
// instance gets a version (nano-<name>, inheriting from its mod loader's version, with the server to join as game
// arguments) and a profile whose game folder is the instance's. The user signs in and presses Play in the launcher:
// nothing here handles Microsoft accounts. Servers the user joins (servers-list.json) may carry a client pack (.mrpack),
// checked at every Play and synced into the instance once the user has agreed to what it installs.
// PYIDE_MC_LAUNCHER (tests): a JSON array, the program and its first arguments run in place of the launcher; any
// other value (off, []) finds none. PYIDE_MC_STORE (tests): {argv, work}, the same for the Store launcher.
// PYIDE_MC_LAUNCHER_IMAGE (tests): the process name that counts as the launcher being open.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { KINDS, RELEASE, PACK_HOSTS, base, getJson, getText, mojangVersion, byVersion, neoforgeMc, packFile, standIn } = require('./sources');
const { openZip, readEntry, unpackZip } = require('./zipfile');
const { createImports, discardDownload } = require('./imports');
const { ping } = require('./ping');

const INSTANCE = 'nano-instance.json';
const SERVERS = 'servers-list.json';
const WORK = '.launcher';
const LOADERS = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const PACK_LOADERS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const DOWNLOAD_PAGE = 'https://www.minecraft.net/download';
const NAME = /^[A-Za-z0-9][\w-]{0,39}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const HTTP = /^https?:\/\/\S+$/i;
// A server's pack address is anyone's text and is fetched at every Play, so it may not point at this computer or its
// network.
const PRIVATE_HOST = /^(localhost$|.+\.local(host)?$|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[(::1?\]|::ffff:|f[cd]|fe[89ab]))/i;
// The most a download may be: a file whose pack names no size, and a pack itself (zipfile.js unpacks 2 GB at most).
const FILE_LIMIT = 1024 * 1024 * 1024;
const PACK_LIMIT = 2 * 1024 * 1024 * 1024;
const SPARE_SPACE = 64 * 1024 * 1024;
const HOUR = 3600000;
// Versions go into download addresses and folder names.
const VERSION = (v) => typeof v === 'string' && /^[\w.+-]{1,64}$/.test(v) && !/^\.+$/.test(v);
// Instances and packs are release versions only: the arguments that join a server are chosen by the version number
// (serverArgs), which a snapshot's or pre-release's id does not give.
const ONLY_RELEASES = 'Nano Studio Craft plays release versions only';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
// A file another process has open for a moment (the launcher, an antivirus scan) refuses to be replaced on Windows.
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
function renameRetried(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (attempt === 5 || !LOCKED.has(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
  renameRetried(`${p}.tmp`, p);
};
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
// Streamed: a pack's mods are hashed at every Play, in the process that also answers the window.
async function hashOf(algo, file) {
  const hash = crypto.createHash(algo);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const mb = (n) => Math.ceil(n / 1048576);
// bytes more fit on dir's disk, or a clear error before anything is written.
function roomFor(dir, bytes) {
  let free = Infinity;
  try { const s = fs.statfsSync(dir); free = s.bavail * s.bsize; } catch {}
  if (bytes + SPARE_SPACE > free) throw fail(`Not enough disk space: ${mb(bytes)} MB needed, ${mb(free)} MB free`, 'noSpace');
}
// What a job that crashed left behind. An hour's age spares the running job of another Craft window.
function sweep(dir, prefix) {
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, n);
    try {
      if (n.startsWith(prefix) && Date.now() - fs.statSync(p).mtimeMs > HOUR) fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}
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
// A pack's address, typed or from a join code: https (a shared pack is its tunnel's https address), or the test
// stand-in's origin.
const packUrl = (url) => {
  if (url == null || url === '') return null;
  if (typeof url !== 'string' || !HTTP.test(url.trim())) throw fail('The pack is not an http(s) address', 'badPack');
  const p = url.trim();
  if (standIn(p)) return p;
  if (!/^https:\/\//i.test(p)) throw fail('The pack is not an https address', 'badPack');
  let host = null;
  try { host = new URL(p).hostname; } catch { throw fail('The pack is not an https address', 'badPack'); }
  if (PRIVATE_HOST.test(host.replace(/\.$/, ''))) throw fail('The pack points at a private address', 'badPack');
  return p;
};
// A redirect is held to the same rule: it is the pack's owner who answers with one.
const allowedPack = (url) => { try { return !!packUrl(url); } catch { return false; } };
const pastable = (s) => encodeURIComponent(s).replace(/[!'()*.]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// nanostudio:join?addr=<host:port>&pack=<url-encoded url>&name=<server name>, found anywhere in the pasted text. A
// code's values are percent-encoded (pastable), so the code ends at a space, a quote, a parenthesis or <>, and
// punctuation after it ends the sentence it was pasted in.
function parseJoinCode(text) {
  const m = /nanostudio:(?:\/\/)?join\/?\?([^\s"'`()<>]+)/i.exec(String(text ?? ''));
  if (!m) throw fail('This is not a Nano Studio join code (nanostudio:join?addr=…)', 'badCode');
  const q = new URLSearchParams(m[1].replace(/[.,;:!?]+$/, ''));
  const { address } = parseAddress(q.get('addr'));
  return { address, pack: packUrl(q.get('pack')), name: oneLine(q.get('name')) || address };
}
function joinCode({ address, pack, name } = {}) {
  const parts = [`addr=${parseAddress(address).address}`];
  if (packUrl(pack)) parts.push(`pack=${pastable(pack.trim())}`);
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
// The launcher from the Microsoft Store or the Xbox app, which is what Mojang's download page gives Windows 10 and 11.
// A Store app takes no command line (Mojang's MCL-20059), so there is no --workDir: it always works in the default
// .minecraft, with its own profiles file. {argv, work}, or null.
const STORE_PACKAGE = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe';
const PROFILES = 'launcher_profiles.json';
const STORE_PROFILES = 'launcher_profiles_microsoft_store.json';
// By full path: a bare name is looked up in the folder a program starts in first, and a pack writes files.
const systemRoot = (env) => env.SystemRoot || 'C:\\Windows';
function findStore(env = process.env) {
  if (env.PYIDE_MC_STORE !== undefined) {
    try {
      const s = JSON.parse(env.PYIDE_MC_STORE);
      if (Array.isArray(s?.argv) && s.argv.length && typeof s.work === 'string') return s;
    } catch {}
    return null;
  }
  if (env.PYIDE_MC_LAUNCHER !== undefined || !env.LOCALAPPDATA || !env.APPDATA) return null;
  if (!fs.existsSync(path.join(env.LOCALAPPDATA, 'Packages', STORE_PACKAGE))) return null;
  return { argv: [path.join(systemRoot(env), 'explorer.exe'), `shell:AppsFolder\\${STORE_PACKAGE}!Minecraft`], work: path.join(env.APPDATA, '.minecraft') };
}
// How the game is started: {id, argv, work(root), profiles, args(work)}, or null. Only through an official launcher:
// starting it ourselves needs a Microsoft sign-in of our own, which Mojang has to approve first. The launcher that
// takes --workDir comes first, since it keeps Nano Studio's versions and profiles out of the user's .minecraft.
function launchMethod(env = process.env) {
  const argv = findLauncher(env);
  if (argv) return { id: 'official', argv, work: workDir, profiles: PROFILES, args: (work) => ['--workDir', work] };
  const store = findStore(env);
  return store && { id: 'store', argv: store.argv, work: () => store.work, profiles: STORE_PROFILES, args: () => [] };
}
// Detached, so it outlives Nano Studio. A stand-in is a console program whose window would only flash; the real
// launcher's window must show.
function startLauncher(how, work) {
  return new Promise((resolve, reject) => {
    const standIn = process.env.PYIDE_MC_LAUNCHER !== undefined || process.env.PYIDE_MC_STORE !== undefined;
    const child = spawn(how.argv[0], [...how.argv.slice(1), ...how.args(work)], { cwd: work, detached: true, stdio: 'ignore', windowsHide: standIn });
    child.once('error', (err) => reject(fail(`The Minecraft Launcher could not be started: ${err.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
// A launcher already open keeps the profiles it read at its start and may only come to the front: the UI says so.
const LAUNCHER_IMAGES = ['MinecraftLauncher.exe', 'Minecraft.exe'];
function launcherOpen(env = process.env) {
  const images = (env.PYIDE_MC_LAUNCHER_IMAGE ? [env.PYIDE_MC_LAUNCHER_IMAGE] : LAUNCHER_IMAGES).map((n) => n.toLowerCase());
  return new Promise((resolve) => {
    execFile(path.join(systemRoot(env), 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 16 << 20 }, (err, out) => {
      resolve(!err && out.split(/\r?\n/).some((l) => images.includes(/^"([^"]+)"/.exec(l)?.[1].toLowerCase())));
    });
  });
}

// launcher_profiles.json as the launcher keeps it; a file that cannot be read, or whose profiles are replaced, is kept
// beside the new one.
const keepBroken = (file) => fs.copyFileSync(file, `${file}.broken-${Date.now()}`);
function readProfiles(file) {
  if (!fs.existsSync(file)) return { profiles: {}, settings: {}, version: 3 };
  // An open launcher may be writing it this moment: only a file that stays unreadable is damaged.
  let data = readJson(file);
  for (let i = 0; i < 2 && !data; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    data = readJson(file);
  }
  const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const keep = () => keepBroken(file);
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

// What makes a nano-instance.json one that can be played; anything else on disk is a damaged instance.
const playable = (inst) => !!inst && typeof inst === 'object' && !Array.isArray(inst) && VERSION(inst.mc) && !!LOADERS[inst.loader];

function createLauncher({ fetchFile, ensureJava, javaFor, run, retried }) {
  // Where the launcher in use keeps versions and profiles; .launcher until there is one.
  const gameDir = (root) => (launchMethod()?.work ?? workDir)(root);

  // ---------- instances ----------
  const dirOf = (root, name) => {
    if (!NAME.test(name || '')) throw fail(`${name} is not an instance name`, 'noInstance');
    return path.join(instancesDir(root), name);
  };
  function readInstance(root, name) {
    const inst = readJson(path.join(dirOf(root, name), INSTANCE));
    if (!playable(inst)) throw fail(`There is no instance ${name}`, 'noInstance');
    return { ...inst, name };
  }
  const writeInstance = (root, inst) => writeJson(path.join(dirOf(root, inst.name), INSTANCE), inst);
  const modsOf = (dir) => { try { return fs.readdirSync(path.join(dir, 'mods')).filter((n) => /\.jar$/i.test(n)).length; } catch { return 0; } };
  const describe = (root, inst) => ({ ...inst, title: inst.title || inst.name, dir: dirOf(root, inst.name), mods: modsOf(dirOf(root, inst.name)) });

  // A folder here that is not a playable instance (nano-instance.json damaged, or a job that stopped before writing
  // it) is listed as damaged, so its name is not silently taken and the user can open or delete it.
  function instances(root) {
    const parent = instancesDir(root);
    const names = fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME.test(d.name)).map((d) => d.name) : [];
    return names.map((n) => {
      try { return describe(root, readInstance(root, n)); } catch {
        // One being made has no record yet.
        return busy.has(dirOf(root, n).toLowerCase()) ? null : { name: n, title: n, damaged: true, dir: dirOf(root, n), mods: 0 };
      }
    }).filter(Boolean).sort((a, b) => String(b.lastPlayed || b.created || '').localeCompare(String(a.lastPlayed || a.created || '')));
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
    const versions = path.join(gameDir(root), 'versions');
    const has = (id) => VERSION(id) && !!readJson(path.join(versions, id, `${id}.json`));
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
    const work = gameDir(root);
    fs.mkdirSync(work, { recursive: true });
    sweep(work, 'installer-');
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
      // The installer's Java may still hold its jar for a moment after a cancel; sweep takes what stays.
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // ---------- the instance's version and profile, written at every Play ----------
  // Before 1.13, the line of arguments of the version the instance inherits from, through its own parents and, for a
  // version the launcher has not downloaded yet, from Mojang.
  async function argumentLine(root, id, mc) {
    const seen = new Set();
    while (VERSION(id) && !seen.has(id)) {
      seen.add(id);
      const json = readJson(path.join(gameDir(root), 'versions', id, `${id}.json`));
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
    writeJson(path.join(gameDir(root), 'versions', id, `${id}.json`), json);
    return json;
  }
  // One custom profile per instance; the launcher's and the user's other profiles and settings stay as they are.
  function writeProfile(root, inst, how) {
    const file = path.join(how.work(root), how.profiles);
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
    if (/^https:\/\/(www\.)?modrinth\.com\/modpack\//i.test(url) || !/^https?:/i.test(url)) return createImports({ fetchFile }).fromModrinth(url, log);
    const dest = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-pack.mrpack`);
    await fetchFile(packUrl(url), dest, { limit: PACK_LIMIT, allow: allowedPack }, log);
    return dest;
  }
  // What the user sees before a server's pack may change an instance. A pack's mods run with the game, with the user's
  // rights, and only the files it lists are limited to PACK_HOSTS and checked: overrides are whatever its owner put in.
  function packReview(file, pack, url, inst, sha1) {
    const zip = openZip(file);
    const inner = zip.names.filter((n) => /^(client-)?overrides\/./.test(n) && !n.endsWith('/')).map((n) => n.slice(n.indexOf('/') + 1));
    zip.close();
    const listed = pack.files.filter((f) => f.env?.client !== 'unsupported').map((f) => String(f.path || '').replace(/\\/g, '/'));
    const code = (rel) => /\.jar$|^mods\/.+\.(zip|litemod)$/i.test(rel);
    const had = new Set((Array.isArray(inst.pack?.files) ? inst.pack.files : []).map((rel) => String(rel).toLowerCase()));
    const row = (rel, inPack) => ({ file: rel, inPack, added: !had.has(rel.toLowerCase()) });
    const mods = [...listed.filter(code).map((rel) => row(rel, false)), ...inner.filter(code).map((rel) => row(rel, true))];
    return { sha1, host: new URL(url).host, name: pack.name, version: pack.version, mc: pack.mc, loader: pack.loader, update: !!inst.pack, mods,
      others: listed.length + inner.length - mods.length, autoModpack: mods.some((m) => /automodpack/i.test(m.file)) };
  }
  // The file at the first of its addresses that gives it whole and with its checksum: a pack may name mirrors.
  async function fetchChecked(f, tmp, log) {
    const quiet = Object.assign(() => {}, { signal: log.signal });
    let last = null;
    for (const url of f.from) {
      try {
        await fetchFile(url, tmp, { size: f.size, limit: f.size || FILE_LIMIT }, quiet);
        if (await hashOf(f.sum[0], tmp) === f.sum[1]) return;
        last = fail(`Checksum mismatch for ${f.rel}`);
      } catch (err) {
        if (err.name === 'AbortError' || err.code === 'ENOSPC') throw err;
        last = err;
      }
    }
    throw last;
  }
  // The pack's client files into the instance: each listed file downloaded with its hash checked (all of them before
  // anything in the instance changes), then the files the previous pack installed and this one does not removed, the
  // new ones moved in and overrides/ and client-overrides/ unpacked. Files the user added are not the pack's and stay;
  // a pack mod the user disabled (.jar.disabled) stays disabled. -> the files the pack now owns.
  // A running game holds its mods open: everything that leaves or is replaced moves aside first, and a file that will
  // not move puts the others back, so the instance is never half changed. While files move the instance records those
  // of both packs and no SHA-1, so a crash or a failure is finished by the next sync, and Play stops until one succeeds.
  async function applyPack(root, inst, file, pack, log) {
    const dir = dirOf(root, inst.name);
    const files = pack.files.filter((f) => f.env?.client !== 'unsupported').map((f) => {
      const rel = String(f.path || '').replace(/\\/g, '/');
      const dest = inside(dir, rel);
      if (!dest) throw fail(`The pack names a file outside the instance: ${f.path}`, 'badPack');
      const from = (Array.isArray(f.downloads) ? f.downloads : []).filter(packFile);
      const sum = f.hashes?.sha512 ? ['sha512', f.hashes.sha512] : f.hashes?.sha1 ? ['sha1', f.hashes.sha1] : null;
      if (!from.length) throw fail(`The pack gives no https download address on ${PACK_HOSTS.join(', ')} for ${rel}`, 'badPack');
      if (!sum) throw fail(`The pack gives no checksum for ${rel}`, 'badPack');
      return { rel, dest, from, sum: [sum[0], String(sum[1]).toLowerCase()], size: Number.isSafeInteger(f.fileSize) && f.fileSize > 0 ? f.fileSize : null };
    });
    const zip = openZip(file);
    const packed = zip.names.filter((n) => /^(client-)?overrides\/./.test(n) && !n.endsWith('/'));
    const unpacked = packed.reduce((s, n) => s + zip.size(n), 0);
    zip.close();
    const overrides = [...new Set(packed.map((n) => n.slice(n.indexOf('/') + 1)).filter((rel) => inside(dir, rel)))];
    sweep(dir, '.pack-');
    const staging = fs.mkdtempSync(path.join(dir, '.pack-'));
    try {
      const has = async (f) => {
        for (const p of [f.dest, `${f.dest}.disabled`]) if (isFile(p) && await hashOf(f.sum[0], p) === f.sum[1]) return true;
        return false;
      };
      const needed = [];
      for (const [i, f] of files.entries()) if (!(await has(f))) needed.push({ ...f, i });
      roomFor(dir, needed.reduce((s, f) => s + (f.size || 0), unpacked));
      const ready = [];
      for (const f of needed) {
        log(`(${f.i + 1}/${files.length}) ${f.rel}\n`);
        const tmp = path.join(staging, String(f.i));
        await fetchChecked(f, tmp, log);
        ready.push({ tmp, dest: f.dest });
      }
      const owned = [...new Set([...files.map((f) => f.rel), ...overrides])];
      const keep = new Set(owned.map((r) => r.toLowerCase()));
      const was = (Array.isArray(inst.pack?.files) ? inst.pack.files : []).map(String);
      const gone = was.filter((rel) => !keep.has(rel.toLowerCase())).map((rel) => inside(dir, rel)).filter(Boolean);
      const disabled = (p) => isFile(`${p}.disabled`) && !isFile(p);
      const wasDisabled = new Set([...ready.map((r) => r.dest), ...overrides.map((rel) => inside(dir, rel))].filter(disabled));
      const onDisk = playable(inst); // an instance being made has no record yet, and its folder goes if this fails
      if (onDisk) writeInstance(root, { ...inst, pack: { ...inst.pack, sha1: null, files: [...new Set([...was, ...owned])] } });
      const moved = [];
      const putBack = () => {
        for (const [q, aside] of moved.reverse()) {
          try { renameRetried(aside, q); } catch (err) { log(`${q} could not be put back: ${err.message}\n`); }
        }
      };
      try {
        for (const p of [...gone, ...ready.map((r) => r.dest), ...overrides.map((rel) => inside(dir, rel))]) {
          for (const q of [p, `${p}.disabled`]) {
            if (!isFile(q)) continue;
            const aside = path.join(staging, `old-${moved.length}`);
            renameRetried(q, aside);
            moved.push([q, aside]);
          }
        }
      } catch (err) {
        putBack();
        if (onDisk) writeInstance(root, inst);
        throw LOCKED.has(err.code) ? fail(`${path.relative(dir, err.path || dir) || inst.name} is in use: close Minecraft and try again`, 'inUse') : err;
      }
      try {
        for (const { tmp, dest } of ready) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          renameRetried(tmp, wasDisabled.has(dest) ? `${dest}.disabled` : dest);
        }
        for (const prefix of ['overrides/', 'client-overrides/']) unpackZip(file, dir, prefix);
        for (const rel of overrides) {
          const p = inside(dir, rel);
          if (wasDisabled.has(p)) renameRetried(p, `${p}.disabled`);
        }
      } catch (err) {
        // The old files back over the new; the record stays, so the next sync clears up what this one added.
        putBack();
        throw Object.assign(err, { halfDone: true });
      }
      for (const [q] of moved) if (gone.some((p) => q === p || q === `${p}.disabled`)) log(`Removed ${path.relative(dir, q)}\n`);
      return owned;
    } finally {
      // A jar the game still has open may refuse to go for a moment: sweep takes what stays.
      try { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }
  // The pack could not be had, which says nothing about its mods: the instance is as the last sync left it, and the
  // server may well still accept those. A failure on this computer stays an error, and so does a checksum that does
  // not match, since a file that is not what the pack promised is no reason to play on quietly, and a sync that stopped
  // half-way, since the instance is then no longer what the last sync left.
  const packTrouble = (err) => !err.halfDone && err.name !== 'AbortError' && err.code !== 'ENOSPC' && !['inUse', 'noSpace', 'needsApproval'].includes(err.code) && !/^Checksum mismatch/.test(err.message);
  // The pack at `url` synced into the instance when it changed since the last sync (its SHA-1: a shared pack's address
  // changes with each tunnel); Minecraft and the loader become the pack's. A pack synced moments ago (Add Server, then
  // its first Play) is not downloaded again for that Play. -> {inst, stale}: stale when a pack that cannot be fetched or
  // read now left the last synced mods in place, as happens when a server's tunnel is down.
  // Nothing of a pack the user has not seen is applied: its owner can change what the address serves at any time, so
  // the SHA-1 decides, not the address. approve is the SHA-1 the user just agreed to, pinned the one saved with the
  // server; any other pack throws needsApproval with what to show, and the instance stays as it was.
  const recent = new Map(); // instance folder (lower case) + url -> when join synced it
  async function syncPack(root, inst, url, log, { reuse = false, approve = null, pinned = null } = {}) {
    const dir = dirOf(root, inst.name);
    const key = `${dir.toLowerCase()} ${url}`;
    const synced = recent.get(key) || 0;
    recent.delete(key);
    if (reuse && inst.pack?.url === url && Date.now() - synced < 120000) return { inst, stale: false };
    log(`Checking the server's pack ${url}\n`);
    let file = null;
    try {
      file = await downloadPack(url, log);
      const sha1 = await hashOf('sha1', file);
      let next = inst;
      if (inst.pack?.sha1 === sha1) {
        log('The pack has not changed.\n');
        if (inst.pack.url !== url) writeInstance(root, next = { ...inst, pack: { ...inst.pack, url } });
      } else if (sha1 === approve || sha1 === pinned) next = await fromPackFile(root, inst, file, url, log);
      else throw Object.assign(fail('The pack has not been approved', 'needsApproval'), { approval: packReview(file, readPack(file), url, inst, sha1) });
      if (!reuse) recent.set(key, Date.now());
      return { inst: next, stale: false };
    } catch (err) {
      if (!inst.pack?.sha1 || !packTrouble(err)) throw err;
      log(`The pack could not be checked (${err.message}): using the mods of the last sync.\n`);
      return { inst, stale: true };
    } finally { discardDownload(file); }
  }
  async function fromPackFile(root, inst, file, url, log) {
    const pack = readPack(file);
    const files = await applyPack(root, inst, file, pack, log);
    const next = { ...inst, mc: pack.mc, loader: pack.loader, loaderVersion: pack.loaderVersion,
      pack: { url: url || null, sha1: await hashOf('sha1', file), name: pack.name, version: pack.version, files } };
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
  // A new instance's folder, removed again when what fills it fails. Only one job makes a name, and only a name no
  // folder has: a create waits on the network between choosing the name and getting here.
  function made(root, name, step) {
    const dir = dirOf(root, name);
    return exclusive(root, name, async () => {
      if (fs.existsSync(dir)) throw fail(`instances/${name} already exists`, 'exists');
      fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
      try { return await step(); } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        throw err;
      }
    });
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

  // The instance's launcher profile and version, wherever a launcher had them; the renderer moves its folder to the
  // Recycle Bin.
  function remove(root, name) {
    if (busy.has(dirOf(root, name).toLowerCase())) throw fail(`${name} is busy with another download or Play`, 'busy');
    const store = findStore();
    for (const [work, profiles] of [[workDir(root), PROFILES], ...(store ? [[store.work, STORE_PROFILES]] : [])]) {
      const file = path.join(work, profiles);
      if (fs.existsSync(file)) {
        const data = readProfiles(file);
        if (data.profiles[versionId(name)]) { delete data.profiles[versionId(name)]; writeJson(file, data); }
      }
      fs.rmSync(path.join(work, 'versions', versionId(name)), { recursive: true, force: true });
    }
    const list = servers(root);
    if (list.some((s) => s.instance === name)) saveServers(root, list.map((s) => (s.instance === name ? { ...s, instance: null } : s)));
    return true;
  }

  // ---------- servers to join ----------
  const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  function checkServer(s) {
    if (!s || typeof s !== 'object') throw fail('A server is {name, address, pack?, instance?, approved?}', 'badAddress');
    const { address } = parseAddress(s.address);
    const instance = s.instance && NAME.test(s.instance) ? s.instance : null;
    return { name: oneLine(s.name) || address, address, pack: packUrl(s.pack), instance, approved: /^[0-9a-f]{40}$/.test(s.approved || '') ? s.approved : null };
  }
  function servers(root) {
    const list = readJson(path.join(root, SERVERS));
    return (Array.isArray(list) ? list : []).map((s) => { try { return checkServer(s); } catch { return null; } }).filter(Boolean);
  }
  // One entry per address, the last given winning. A file that cannot be read is kept beside the new one.
  function saveServers(root, list) {
    if (!Array.isArray(list)) throw fail('The server list is an array');
    const out = [];
    for (const s of list.map(checkServer)) {
      const at = out.findIndex((o) => sameAddress(o.address, s.address));
      if (at >= 0) out[at] = s; else out.push(s);
    }
    const file = path.join(root, SERVERS);
    if (fs.existsSync(file) && !Array.isArray(readJson(file))) keepBroken(file);
    writeJson(file, out);
    return out;
  }

  // A join code, or an address (with a pack, a name, or the version and loader to play it with when it has no pack) ->
  // {server, instance}: the server's instance made or brought up to date from its pack, and the server saved. Without
  // a pack, an instance or a version -> {needsVersion: true, server}. A pack the user has not approved ->
  // {needsApproval}: asked again with approve, its SHA-1, it goes through.
  const asked = (err) => {
    if (err.code === 'needsApproval') return { launched: false, needsApproval: err.approval };
    throw err;
  };
  const join = (root, req = {}, log) => joinServer(root, req, log).catch(asked);
  async function joinServer(root, req, log) {
    const target = req.code ? parseJoinCode(req.code) : (() => {
      const { address } = parseAddress(req.address);
      return { address, pack: packUrl(req.pack), name: oneLine(req.name) || address };
    })();
    const list = servers(root);
    const known = list.find((s) => sameAddress(s.address, target.address));
    const pack = target.pack || (!req.code && known?.pack) || null;
    let inst = null;
    if (known?.instance) { try { inst = readInstance(root, known.instance); } catch {} }
    let stale = false;
    // The list as it is now: a sync takes minutes, in which the user may have removed another server.
    const save = (instance) => {
      const server = { name: target.name, address: target.address, pack, instance: instance.name, approved: pack ? instance.pack?.sha1 ?? known?.approved ?? null : null };
      saveServers(root, [...servers(root), server]);
      return { server, instance: describe(root, instance), stale };
    };
    const connect = async (instance) => {
      const synced = pack ? await syncPack(root, instance, pack, log, { approve: req.approve, pinned: known?.approved }) : { inst: instance };
      stale = !!synced.stale;
      const next = { ...synced.inst, server: { name: target.name, address: target.address } };
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
  async function play(root, name, { server, approve } = {}, log) {
    const how = launchMethod();
    if (!how) return { launched: false, code: 'noLauncher', download: DOWNLOAD_PAGE };
    return exclusive(root, name, async () => {
      let inst = readInstance(root, name);
      let srv = null;
      let packStale = false;
      if (server) {
        const given = typeof server === 'string' ? { address: server } : server;
        const { address } = parseAddress(given.address);
        const saved = servers(root).find((s) => sameAddress(s.address, address));
        srv = { name: oneLine(given.name) || saved?.name || address, address, pack: packUrl(given.pack) || saved?.pack || null, approved: saved?.approved };
      }
      if (srv?.pack) {
        const synced = await syncPack(root, inst, srv.pack, log, { reuse: true, approve, pinned: srv.approved });
        inst = synced.inst;
        packStale = synced.stale;
        if (!packStale && inst.pack?.sha1 !== srv.approved) saveServers(root, servers(root).map((s) => (sameAddress(s.address, srv.address) ? { ...s, approved: inst.pack?.sha1 } : s)));
      }
      inst = { ...inst, loaderId: await installLoader(root, inst, log), lastPlayed: now() };
      if (srv) inst.server = { name: srv.name, address: srv.address };
      const version = await writeVersion(root, inst, inst.loaderId, srv);
      writeProfile(root, inst, how);
      writeInstance(root, inst);
      log(`Starting the Minecraft Launcher with the profile ${inst.title || inst.name} (Nano Studio)${srv ? `, joining ${srv.address}` : ''}\n`);
      const alreadyOpen = await launcherOpen();
      log.signal?.throwIfAborted();
      await startLauncher(how, how.work(root));
      return { launched: true, launcher: how.argv[0], method: how.id, versionId: version.id, instance: describe(root, inst), packStale, alreadyOpen };
    }).catch(asked);
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
    if (from !== to) {
      try { renameRetried(from, to); } catch (err) {
        throw LOCKED.has(err.code) ? fail(`${jar} is in use: close Minecraft and try again`, 'inUse') : err;
      }
    }
    return mods(root, name);
  }

  // What the server says it runs, for the dialog that asks for the version.
  const pingServer = (text) => {
    const { host, port } = parseAddress(text);
    return ping(host, port);
  };

  const status = (root) => {
    const how = launchMethod();
    return { launcher: how ? how.argv[0] : null, method: how?.id ?? null, download: DOWNLOAD_PAGE, workDir: gameDir(root), instancesDir: instancesDir(root) };
  };

  return { status, instances, versions: mcVersions, loaderVersions, create, fromPack, remove, servers, saveServers, join, play, mods, setMod, joinCode, parseJoinCode, ping: pingServer };
}

module.exports = { createLauncher, findLauncher, findStore, launchMethod, launcherOpen, parseJoinCode, joinCode, parseAddress, serverArgs, headlessClient, readProfiles };
