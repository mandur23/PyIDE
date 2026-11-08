// Nano Studio Craft's game side: Minecraft instances (instances/<name>, described by nano-instance.json) played through
// the official Minecraft Launcher. The launcher works in .launcher (its --workDir: versions, libraries,
// launcher_profiles.json), or in the user's .minecraft when it is the Store's, which takes no arguments. There each
// instance gets a version (nano-<name>, inheriting from its mod loader's version, with the server to join as game
// arguments) and a profile whose game folder is the instance's. The user signs in and presses Play in the launcher:
// nothing here handles Microsoft accounts. Servers the user joins (servers-list.json) may carry a client pack (.mrpack),
// checked at every Play and synced into the instance once the user has agreed to what it installs.
// PYIDE_MC_LAUNCHER (tests): a JSON array, the program and its first arguments run in place of the launcher; any
// other value (off, []) finds none. PYIDE_MC_STORE (tests): {argv, work}, the same for the Store launcher.
// PYIDE_MC_LAUNCHER_IMAGE (tests): the process name that counts as the launcher being open. PYIDE_MC_GAME_IMAGE (tests):
// the same for a game running. A private server (a join code with key=, docs/craft-private-share-design.md) is played
// through a local join process (private-join.js); its key is kept with the keyring given here, never in servers-list.json.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { KINDS, RELEASE, base, getJson, getText, mojangVersion, byVersion, neoforgeMc, standIn } = require('./sources');
const { openZip, readEntry, unpackZip, canonical } = require('./zipfile');
const { createImports, discardDownload, fetchChecked, hashOf, packEntry } = require('./imports');
const { ping } = require('./ping');
const { mergeServers } = require('./serversdat');
const { createPrivateJoin, freePort } = require('./private-join');
const { resolvesLocal } = require('./hosts');
const translation = require('./translate');
const { packMcmeta } = require('./templates');

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
// network: neither by its text here, nor by what its name resolves to (vetPack).
const PRIVATE_HOST = /^(localhost$|.+\.local(host)?$|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[(::1?\]|::ffff:|f[cd]|fe[89ab]))/i;
// The most a pack may be (zipfile.js unpacks 2 GB at most).
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
// rel under dir, or null when it names a path outside it or is not written where its text says (zipfile.js canonical).
const inside = (dir, rel) => {
  if (!canonical(rel)) return null;
  const top = path.resolve(dir);
  const p = path.resolve(top, rel);
  return p.startsWith(top + path.sep) && !p.slice(top.length).includes(':') ? p : null;
};
const atLeast = (mc, v) => byVersion(mc, v) <= 0;
// A pack's override files, as the paths unpackZip writes them in the instance.
const OVERRIDE = /^(client-)?overrides\/[^/]/;
const overridesOf = (zip) => zip.names.filter((n) => OVERRIDE.test(n) && !n.endsWith('/')).map((n) => n.slice(n.indexOf('/') + 1)).filter(canonical);

const workDir = (root) => path.join(root, WORK);
const instancesDir = (root) => path.join(root, 'instances');
const versionId = (name) => `nano-${name}`;

// ---------- addresses and join codes ----------
// host, host:port or [IPv6]:port -> {host, port, address}. Without a port the address stays without one: the game then
// looks up the domain's SRV record, as its own server list does.
function parseAddress(text) {
  const s = String(text ?? '').trim();
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?))(?::(\d{1,5}))?$/.exec(s);
  // Says nothing of the text: a mistyped join code is what lands here, and it holds a key.
  if (!m) throw fail('This is not a server address (host or host:port)', 'badAddress');
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
// A pack's host looked up before anything is fetched from it: a name that leads to this computer or its network
// (localtest.me is 127.0.0.1) is refused as its address would be. The test stand-in's origin is not looked up. A name
// that cannot be looked up cannot be fetched either, and says so as a download would.
async function vetPack(url) {
  if (standIn(url)) return;
  const host = new URL(url).hostname;
  const { local, failed } = await resolvesLocal(host);
  if (local) throw fail('The pack points at a private address', 'badPack');
  if (failed) throw fail(`${url}: getaddrinfo ENOTFOUND ${host}`);
}
// Whether an address is this computer or its network. Through URL, which reads the other spellings a resolver accepts
// (2130706433, 0x7f.1), then by what the name resolves to, and without a port also by the SRV record the game follows.
// A name that cannot be looked up is not local: the game cannot reach anything through it either.
async function isLocalAddress(text) {
  const { host, port, address } = parseAddress(text);
  let name = host;
  try { name = new URL(`http://${address}`).hostname; } catch {}
  if (PRIVATE_HOST.test(name)) return true;
  return (await resolvesLocal(name, { srv: !port })).local;
}
const pastable = (s) => encodeURIComponent(s).replace(/[!'()*.]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// A key as a code carries it: 32 bytes of base64url. A code that names a key and does not hold one is refused, never
// taken for a public server.
const keyIn = (text) => {
  const key = Buffer.from(text, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== text) throw fail('The join code has a damaged key', 'badCode');
  return text;
};
// nanostudio:join?addr=<host:port>&key=<base64url key>&pack=<url-encoded url>&name=<server name>, found anywhere in the
// pasted text. key means private. A code's values are percent-encoded (pastable), so the code ends at a space, a quote, a
// parenthesis or <>, and punctuation after it ends the sentence it was pasted in.
const JOIN_CODE = /nanostudio:(?:\/\/)?join\/?\?([^\s"'`()<>]+)/i;
function parseJoinCode(text) {
  const m = JOIN_CODE.exec(String(text ?? ''));
  if (!m) throw fail('This is not a Nano Studio join code (nanostudio:join?addr=…)', 'badCode');
  const raw = m[1].replace(/[.,;:!?]+$/, '');
  const q = new URLSearchParams(raw);
  // URLSearchParams decodes names too, so k%65y= is a key that redact.js, which masks key=, would leave in a log.
  if (q.getAll('key').length !== (raw.match(/(^|&)key=/g) || []).length) throw fail('The join code has a damaged key', 'badCode');
  const { address } = parseAddress(q.get('addr'));
  return { address, pack: packUrl(q.get('pack')), name: oneLine(q.get('name')) || address, key: q.has('key') ? keyIn(q.get('key')) : null };
}
function joinCode({ address, pack, name, key } = {}) {
  const parts = [`addr=${parseAddress(address).address}`];
  if (key) parts.push(`key=${keyIn(key)}`);
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
// .minecraft. It reads launcher_profiles.json like the classic launcher, and removes launcher_profiles_microsoft_store.json
// at its start (launcher core 3.42.5's own log). {argv, work}, or null.
const STORE_PACKAGE = 'Microsoft.4297127D64EC6_8wekyb3d8bbwe';
const PROFILES = 'launcher_profiles.json';
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
  return store && { id: 'store', argv: store.argv, work: () => store.work, profiles: PROFILES, args: () => [] };
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
// A launcher already open keeps the profiles it read at its start and may only come to the front.
const LAUNCHER_IMAGES = ['MinecraftLauncher.exe', 'Minecraft.exe'];
const launcherImages = (env) => (env.PYIDE_MC_LAUNCHER_IMAGE ? [env.PYIDE_MC_LAUNCHER_IMAGE] : LAUNCHER_IMAGES);
// With every core busy tasklist can take 40 s where it usually takes 0.5 s, and a slow answer is still the answer.
const SYSTEM_QUERY_MS = 60000;
// -> true or false, or null when Windows gave no answer, which says nothing about the launcher.
function launcherOpen(env = process.env) {
  const images = launcherImages(env).map((n) => n.toLowerCase());
  return new Promise((resolve) => {
    execFile(path.join(systemRoot(env), 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: SYSTEM_QUERY_MS, maxBuffer: 16 << 20 }, (err, out) => {
      resolve(err ? null : out.split(/\r?\n/).some((l) => images.includes(/^"([^"]+)"/.exec(l)?.[1].toLowerCase())));
    });
  });
}
// So that an open launcher reads the new profile, it is asked to close, as its own close button would, and never killed:
// it may be saving or updating. Not while a game runs, which it may be looking after. A game is told by its command line,
// which holds the player's access token: the script prints one word and nothing of that line.
const GAME_IMAGES = ['javaw.exe', 'java.exe'];
const GAME_ARGS = '--assetsDir|--accessToken|net\\.minecraft\\.client';
const CLOSE_WAIT_MS = 5000;
function askToClose(env) {
  const games = (env.PYIDE_MC_GAME_IMAGE ? [env.PYIDE_MC_GAME_IMAGE] : GAME_IMAGES).map((n) => `Name='${n}'`).join(' OR ');
  const names = launcherImages(env).map((n) => `'${n.replace(/\.exe$/i, '')}'`).join(',');
  const script = `$game = Get-CimInstance Win32_Process -Filter "${games}" | Where-Object { $_.CommandLine -match '${GAME_ARGS}' }
if ($game) { 'game'; exit }
$asked = $false
Get-Process -Name ${names} -ErrorAction SilentlyContinue | ForEach-Object { if ($_.CloseMainWindow()) { $asked = $true } }
if ($asked) { 'asked' } else { 'no window' }`;
  const powershell = path.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: SYSTEM_QUERY_MS }, (err, out) => resolve(!err && out.trim() === 'asked'));
  });
}
// Whether a game is running in this game folder (an instance's): its command line names it after --gameDir. -> true or
// false, or null when Windows gave no answer. The folder reaches the script through the environment, and the script
// prints one word.
function gameRunningIn(dir, env = process.env) {
  const games = (env.PYIDE_MC_GAME_IMAGE ? [env.PYIDE_MC_GAME_IMAGE] : GAME_IMAGES).map((n) => `Name='${n}'`).join(' OR ');
  const script = `$dir = '--gameDir\\s+"?' + [regex]::Escape($env:NANO_GAME_DIR) + '[\\\\/]?"?(\\s|$)'
$game = Get-CimInstance Win32_Process -Filter "${games}" | Where-Object { $_.CommandLine -match '${GAME_ARGS}' -and $_.CommandLine -match $dir }
if ($game) { 'game' } else { 'none' }`;
  const powershell = path.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: SYSTEM_QUERY_MS, env: { ...env, NANO_GAME_DIR: path.resolve(dir) } },
      (err, out) => resolve(err ? null : out.trim() === 'game' ? true : out.trim() === 'none' ? false : null));
  });
}

// ---------- options.txt ----------
// The game's own settings in the instance's folder, key:value lines; resourcePacks is a JSON list of the packs that are
// on, the bottom one first: built-in packs by name (vanilla, fabric, mod_resources), the user's as file/<name>.
const OPTIONS = 'options.txt';
const KOREAN_PACK = 'Nano Studio Korean';
const KOREAN_ENTRY = `file/${KOREAN_PACK}`;
const TURN_ON = 'nano-turn-on.txt';
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const PACKS_LINE = 'resourcePacks:';
const badOptions = (file) => fail(`${file} has a resourcePacks line that is not a list: the pack is not turned on there, so its other lines are kept. Turn on ${KOREAN_PACK} in the game's Resource Packs`, 'badOptions');
// The list as the file has it (['vanilla'] without the line or the file); a line that is not a list of names throws.
function resourcePacksOf(file) {
  const line = (readText(file) ?? '').split(/\r?\n/).find((l) => l.startsWith(PACKS_LINE));
  if (line === undefined) return ['vanilla'];
  let packs = null;
  try { packs = JSON.parse(line.slice(PACKS_LINE.length)); } catch {}
  if (!Array.isArray(packs) || !packs.every((p) => typeof p === 'string')) throw badOptions(file);
  return packs;
}
// entry put on in options.txt below the user's own packs (before the first file/ one), which so win over it; every other
// line and pack stays as and where it was. The line, and the file, are made when missing. -> whether it was added.
function enablePack(file, entry) {
  const raw = readText(file) ?? '';
  const packs = resourcePacksOf(file);
  if (packs.includes(entry)) return false;
  const at = packs.findIndex((p) => p.startsWith('file/'));
  packs.splice(at < 0 ? packs.length : at, 0, entry);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw ? raw.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const i = lines.findIndex((l) => l.startsWith(PACKS_LINE));
  const line = `${PACKS_LINE}${JSON.stringify(packs)}`;
  if (i >= 0) lines[i] = line; else lines.push(line);
  fs.writeFileSync(`${file}.tmp`, `${lines.join(eol)}${eol}`);
  renameRetried(`${file}.tmp`, file);
  return true;
}

// -> true when the launcher has gone. A test with a stand-in launcher that names no image must not reach the user's real
// one, which goes by the same names.
async function closeLauncher(env = process.env) {
  const standIn = env.PYIDE_MC_LAUNCHER !== undefined || env.PYIDE_MC_STORE !== undefined;
  if ((standIn && !env.PYIDE_MC_LAUNCHER_IMAGE) || !(await askToClose(env))) return false;
  const end = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < end) {
    if ((await launcherOpen(env)) === false) return true;
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  return (await launcherOpen(env)) === false;
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

// Where a saved private server's key is kept: seal(key) -> what goes in servers-list.json, or null when nothing here can
// protect it, and open(sealed) -> the key, or null. Without one a key lives in memory and the friend pastes the code again.
const NO_KEYRING = { seal: () => null, open: () => null };

function createLauncher({ fetchFile, ensureJava, javaFor, run, retried, keyring = NO_KEYRING, joins = createPrivateJoin() }) {
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
    const r = await source.resolve(inst.mc, inst.loaderVersion, log);
    const tmp = fs.mkdtempSync(path.join(work, 'installer-'));
    try {
      const jar = path.join(tmp, r.file);
      await fetchFile(r.url, jar, { sha256: r.sha256 }, log);
      if (r.sha1 && await hashOf('sha1', jar) !== r.sha1) throw fail(`Checksum mismatch for ${r.file}`);
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
  // the temporary folder (discardDownload removes them). Each host on the way is looked up first (vetPack). The
  // download's redirect check cannot wait for a lookup, so it lets through only hosts already looked up; one it stops at
  // is looked up, and the download starts again, to the end of a chain as long as the download's own.
  async function downloadPack(url, log) {
    if (/^https:\/\/(www\.)?modrinth\.com\/modpack\//i.test(url) || !/^https?:/i.test(url)) return createImports({ fetchFile }).fromModrinth(url, log, Object.values(PACK_LOADERS));
    const dest = path.join(os.tmpdir(), `pyide-${crypto.randomBytes(4).toString('hex')}-pack.mrpack`);
    const first = packUrl(url);
    await vetPack(first);
    const vetted = new Set([new URL(first).host.toLowerCase()]);
    for (let hop = 0; ; hop++) {
      let next = null;
      const allow = (u) => {
        if (!allowedPack(u)) return false;
        if (standIn(u) || vetted.has(new URL(u).host.toLowerCase())) return true;
        next = u;
        return false;
      };
      try {
        await fetchFile(first, dest, { limit: PACK_LIMIT, allow }, log);
        return dest;
      } catch (err) {
        if (!next || hop === 8) throw err;
        await vetPack(next);
        vetted.add(new URL(next).host.toLowerCase());
      }
    }
  }
  // What the user sees before a server's pack may change an instance. A pack's mods run with the game, with the user's
  // rights, and only the files it lists are limited to PACK_HOSTS and checked: overrides are whatever its owner put in.
  // The overrides are named as applyPack writes them: unpackZip skips what is not canonical.
  function packReview(file, pack, url, inst, sha1) {
    const zip = openZip(file);
    const inner = overridesOf(zip);
    zip.close();
    const listed = pack.files.filter((f) => f.env?.client !== 'unsupported').map((f) => String(f.path || '').replace(/\\/g, '/'));
    const code = (rel) => /\.jar$|^mods\/.+\.(zip|litemod)$/i.test(rel);
    const had = new Set((Array.isArray(inst.pack?.files) ? inst.pack.files : []).map((rel) => String(rel).toLowerCase()));
    const row = (rel, inPack) => ({ file: rel, inPack, added: !had.has(rel.toLowerCase()) });
    const mods = [...listed.filter(code).map((rel) => row(rel, false)), ...inner.filter(code).map((rel) => row(rel, true))];
    return { sha1, host: new URL(url).host, name: pack.name, version: pack.version, mc: pack.mc, loader: pack.loader, update: !!inst.pack, mods,
      others: listed.length + inner.length - mods.length, autoModpack: mods.some((m) => /automodpack/i.test(m.file)) };
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
      const e = packEntry(f, rel);
      if (e.why) throw fail(`The pack ${e.why}`, 'badPack');
      return { ...e, dest };
    });
    const zip = openZip(file);
    const unpacked = zip.names.filter((n) => OVERRIDE.test(n)).reduce((s, n) => s + zip.size(n), 0);
    const overrides = [...new Set(overridesOf(zip).filter((rel) => inside(dir, rel)))];
    zip.close();
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
        await fetchChecked(fetchFile, f, tmp, log);
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
      writeServerList(root, inst, [], log);
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
        writeServerList(root, inst, [], log);
        return describe(root, inst);
      });
    } finally { if (!file) discardDownload(local); }
  }

  // The instance's launcher profile and version, wherever a launcher had them; the renderer moves its folder to the
  // Recycle Bin. An open launcher keeps profiles in memory and writes them back over the file, which would bring the
  // profile back, so it is asked to close first, as Play does. -> {removed: true, alreadyOpen}: alreadyOpen when it
  // stayed open (a game running), and may keep the profile.
  // Exclusive: no Play of it starts while the launcher is being closed.
  const remove = (root, name) => exclusive(root, name, async () => {
    const store = findStore();
    const works = [workDir(root), ...(store ? [store.work] : [])];
    // A file that does not read (an open launcher writing it this moment) may hold it too.
    const holding = (work) => {
      if (!isFile(path.join(work, PROFILES))) return false;
      const profiles = readJson(path.join(work, PROFILES))?.profiles;
      return !profiles || typeof profiles !== 'object' || Object.hasOwn(profiles, versionId(name));
    };
    const open = works.some(holding) && !!(await launcherOpen());
    const closed = open && await closeLauncher();
    for (const work of works) {
      const file = path.join(work, PROFILES);
      if (fs.existsSync(file)) {
        const data = readProfiles(file);
        if (data.profiles[versionId(name)]) { delete data.profiles[versionId(name)]; writeJson(file, data); }
      }
      fs.rmSync(path.join(work, 'versions', versionId(name)), { recursive: true, force: true });
    }
    const list = saved(root);
    for (const s of list) if (s.instance === name && s.private) joins.stop(s.address);
    if (list.some((s) => s.instance === name)) saveServers(root, list.map((s) => (s.instance === name ? { ...s, instance: null } : s)));
    return { removed: true, alreadyOpen: open && !closed };
  });

  // ---------- servers to join ----------
  const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const isSealed = (v) => !!v && typeof v === 'object' && v.enc === 'safeStorage' && typeof v.data === 'string';
  const isPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;
  // A server's record: private, its sealed key and its local port are there only for a private server. A private server
  // without a sealed key is one this computer could not protect the key of.
  function checkServer(s) {
    if (!s || typeof s !== 'object') throw fail('A server is {name, address, pack?, instance?, approved?}', 'badAddress');
    const { address } = parseAddress(s.address);
    const instance = s.instance && NAME.test(s.instance) ? s.instance : null;
    const server = { name: oneLine(s.name) || address, address, pack: packUrl(s.pack), instance, approved: /^[0-9a-f]{40}$/.test(s.approved || '') ? s.approved : null };
    return s.private ? { ...server, private: true, secret: isSealed(s.secret) ? s.secret : null, localPort: isPort(s.localPort) ? s.localPort : null } : server;
  }
  // The list with what main alone may hold.
  function saved(root) {
    const list = readJson(path.join(root, SERVERS));
    return (Array.isArray(list) ? list : []).map((s) => { try { return checkServer(s); } catch { return null; } }).filter(Boolean);
  }
  // Keys held this session, by address (lower case): the only place one is without safeStorage.
  const held = new Map();
  function keyOf(s) {
    const id = s.address.toLowerCase();
    if (!held.has(id) && s.secret) {
      const key = keyring.open(s.secret);
      if (key) held.set(id, key);
    }
    return held.get(id) ?? null;
  }
  // A server as the window sees it: never its sealed key, only whether Join can use one.
  const shown = ({ secret, ...s }) => (s.private ? { ...s, keyMissing: !keyOf({ ...s, secret }) } : s);
  const servers = (root) => saved(root).map(shown);
  // One entry per address, the last given winning. A file that cannot be read is kept beside the new one. The window's
  // list holds no sealed keys, so a private server it gives back keeps the one on disk. A server that left the list, or is
  // no longer private, takes its key and its join process with it.
  function saveServers(root, list) {
    if (!Array.isArray(list)) throw fail('The server list is an array');
    const before = saved(root);
    const out = [];
    for (const s of list.map(checkServer)) {
      const was = before.find((o) => sameAddress(o.address, s.address));
      const entry = s.private && !s.secret && was?.secret ? { ...s, secret: was.secret } : s;
      const at = out.findIndex((o) => sameAddress(o.address, entry.address));
      if (at >= 0) out[at] = entry; else out.push(entry);
    }
    const file = path.join(root, SERVERS);
    if (fs.existsSync(file) && !Array.isArray(readJson(file))) keepBroken(file);
    writeJson(file, out);
    for (const s of before.filter((o) => o.private && !out.some((n) => n.private && sameAddress(n.address, o.address)))) {
      joins.stop(s.address);
      held.delete(s.address.toLowerCase());
    }
    return out.map(shown);
  }

  // ---------- the game's Multiplayer list ----------
  const LOCAL = '127.0.0.1';
  const listEntry = (s) => ({ ip: s.private ? `${LOCAL}:${s.localPort}` : s.address, name: s.name });
  // The instance's servers in its servers.dat, in the instance's own folder whichever launcher plays it. extra: entries
  // not saved with this instance, first, so one that moved takes its old entry's place. Join works without the list.
  function writeServerList(root, inst, extra, log) {
    const wanted = [...extra, ...saved(root).filter((s) => s.instance === inst.name && (!s.private || s.localPort)).map(listEntry)];
    if (!wanted.length) return;
    try {
      const { damaged } = mergeServers(dirOf(root, inst.name), wanted, { rename: renameRetried });
      if (damaged) log('servers.dat is damaged: it stays as it is, with a copy beside it, and the server is not in the game\'s list.\n');
    } catch (err) { log(`servers.dat could not be written: ${err.message}\n`); }
  }
  // The join process of every private server played with this instance, and of target. -> {local, moved}: local maps a
  // public address to what the game connects to, and moved holds the list entries of servers whose port had been taken.
  // Only target's failure stops Play: the others are just entries the game shows as offline.
  async function openPrivate(root, inst, target, log) {
    const local = new Map();
    const moved = [];
    for (const s of saved(root).filter((o) => o.private && (o.instance === inst.name || (target && sameAddress(o.address, target.address))))) {
      const key = keyOf(s);
      if (!key) continue;
      try {
        log(`Opening the private connection to ${s.address}\n`);
        const port = await joins.start({ address: s.address, key, port: s.localPort });
        local.set(s.address.toLowerCase(), `${LOCAL}:${port}`);
        if (port === s.localPort) continue;
        saveServers(root, saved(root).map((o) => (sameAddress(o.address, s.address) ? { ...o, localPort: port } : o)));
        moved.push({ ip: `${LOCAL}:${port}`, name: s.name, ...(s.localPort ? { was: `${LOCAL}:${s.localPort}` } : {}) });
      } catch (err) {
        if (target && sameAddress(s.address, target.address)) throw err;
        log(`The private connection to ${s.address} did not open: ${err.message}\n`);
      }
    }
    return { local, moved };
  }

  // What a pasted code may not do without a yes: aim at this computer or its network, which a typed address may, put a new
  // key on a saved private server, or make one public, which would send the next Join in the clear. A saved server that
  // has no key left asks nothing of a code with a key: pasting it again is how that server comes back.
  async function codeAsks(target, known) {
    const asks = [];
    if (!known && await isLocalAddress(target.address)) asks.push('localAddress');
    if (known?.private) {
      const key = keyOf(known);
      if (!target.key) asks.push('noKey');
      else if (key ? key !== target.key : known.secret) asks.push('newKey');
    }
    return asks;
  }

  // A join code, or an address (with a pack, a name, or the version and loader to play it with when it has no pack) ->
  // {server, instance}: the server's instance made or brought up to date from its pack, and the server saved. Without
  // a pack, an instance or a version -> {needsVersion: true, server}. A pack the user has not approved ->
  // {needsApproval}: asked again with approve, its SHA-1, it goes through. A code that needs a yes (codeAsks) ->
  // {needsConfirm: {kind, address, name}}, with nothing changed: asked again with kind in confirmed, it goes through.
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
    const list = saved(root);
    const known = list.find((s) => sameAddress(s.address, target.address));
    const ask = req.code && (await codeAsks(target, known)).find((kind) => !req.confirmed?.includes(kind));
    if (ask) return { needsConfirm: { kind: ask, address: target.address, name: known?.name || target.name } };
    const pack = target.pack || (!req.code && known?.pack) || null;
    const isPrivate = req.code ? !!target.key : !!known?.private;
    let inst = null;
    if (known?.instance) { try { inst = readInstance(root, known.instance); } catch {} }
    let stale = false;
    // The list as it is now: a sync takes minutes, in which the user may have removed another server.
    const save = async (instance) => {
      const server = { name: target.name, address: target.address, pack, instance: instance.name, approved: pack ? instance.pack?.sha1 ?? known?.approved ?? null : null };
      if (isPrivate) {
        Object.assign(server, { private: true, secret: known?.secret ?? null, localPort: known?.localPort || await freePort() });
        if (target.key) {
          held.set(target.address.toLowerCase(), target.key);
          server.secret = keyring.seal(target.key);
        }
      }
      saveServers(root, [...saved(root).filter((s) => !sameAddress(s.address, target.address)), server]);
      writeServerList(root, instance, [], log);
      return { server: shown(server), instance: describe(root, instance), stale };
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
    if (!VERSION(req.mc)) return { needsVersion: true, server: { name: target.name, address: target.address, pack: null, instance: null, private: isPrivate } };
    const created = await create(root, { name: req.name || target.name, mc: req.mc, loader: req.loader, loaderVersion: req.loaderVersion, memory: req.memory }, log);
    return save(await exclusive(root, created.name, () => connect(readInstance(root, created.name))));
  }

  // Play: the server's pack synced, the loader installed, the join process of a private server started, the instance's
  // version (with the server to join), profile and server list written, and the official launcher started on .launcher,
  // where the user signs in and presses Play. A launcher already open and looking after no game is closed first, so it
  // reads the new profile. server: an address, or {address, name?, pack?}; a saved server's pack is used when none is
  // given. Without the launcher -> {launched: false, code: 'noLauncher', download} before anything is downloaded. A
  // private server whose key this computer could not keep -> {launched: false, code: 'needsCode'}. One with no join
  // process by the time the game would start, such as a server removed during a long sync -> {launched: false, code:
  // 'privateGone'}: its public address speaks only the gate, and the game must never be sent there in the clear.
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
        const known = saved(root).find((s) => sameAddress(s.address, address));
        if (known?.private && !keyOf(known)) return { launched: false, code: 'needsCode' };
        srv = { name: oneLine(given.name) || known?.name || address, address, pack: packUrl(given.pack) || known?.pack || null, approved: known?.approved, private: !!known?.private };
      }
      if (srv?.pack) {
        const synced = await syncPack(root, inst, srv.pack, log, { reuse: true, approve, pinned: srv.approved });
        inst = synced.inst;
        packStale = synced.stale;
        if (!packStale && inst.pack?.sha1 !== srv.approved) saveServers(root, saved(root).map((s) => (sameAddress(s.address, srv.address) ? { ...s, approved: inst.pack?.sha1 } : s)));
      }
      inst = { ...inst, loaderId: await installLoader(root, inst, log), lastPlayed: now() };
      if (srv) inst.server = { name: srv.name, address: srv.address };
      const { local, moved } = await openPrivate(root, inst, srv, log);
      if (srv?.private && !local.has(srv.address.toLowerCase())) return { launched: false, code: 'privateGone' };
      const joinAt = srv && (local.get(srv.address.toLowerCase()) || srv.address);
      const version = await writeVersion(root, inst, inst.loaderId, srv && { ...srv, address: joinAt });
      // An open launcher keeps profiles in memory and rewrites the file from them, as it does at each Play, so ours goes in once it has closed.
      const open = !!(await launcherOpen());
      log.signal?.throwIfAborted();
      const reopened = open && await closeLauncher();
      log.signal?.throwIfAborted();
      writeProfile(root, inst, how);
      writeInstance(root, inst);
      writeServerList(root, inst, srv ? [...moved, { ip: joinAt, name: srv.name }] : moved, log);
      // A Korean pack translated while the game ran is turned on before the game starts again.
      if (fs.existsSync(path.join(koreanDir(root, name), TURN_ON))) {
        try { await turnKoreanOn(root, name, log); } catch (err) { log(`The Korean pack could not be turned on: ${err.message}\n`); }
      }
      log(`Starting the Minecraft Launcher with the profile ${inst.title || inst.name} (Nano Studio)${srv ? `, joining ${srv.address}` : ''}\n`);
      await startLauncher(how, how.work(root));
      return { launched: true, launcher: how.argv[0], method: how.id, versionId: version.id, instance: describe(root, inst), packStale, alreadyOpen: open && !reopened, reopened, private: local.size > 0 };
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

  // ---------- Korean translation of an instance's mods ----------
  // translate.js, as for a server, into a folder pack of the instance's own (resourcepacks/Nano Studio Korean) that its
  // options.txt turns on. The game reads options.txt when it starts and writes it back when it closes, so nothing is
  // written there while the instance is being played: the pack is then turned on at its next Play (a TURN_ON file in it).
  const koreanDir = (root, name) => path.join(dirOf(root, name), 'resourcepacks', KOREAN_PACK);
  // Mods keep their text in .lang files before 1.13, and options.txt names packs without file/.
  const koreanVersion = (inst) => {
    if (!VERSION(inst.mc) || !atLeast(inst.mc, '1.13')) throw fail(`Korean translation needs Minecraft 1.13 or later: ${inst.mc} mods keep their text in .lang files`, 'oldVersion');
  };
  // The resource pack format of the instance's Minecraft: version.json in the client jar the launcher downloaded (from
  // 1.14 on, as the server side reads the server jar's), or 4 for 1.13, whose jar has none. null before the first Play.
  function clientPackVersion(root, mc) {
    const store = findStore();
    for (const work of [...new Set([gameDir(root), workDir(root), ...(store ? [store.work] : [])])]) {
      const raw = readEntry(path.join(work, 'versions', mc, `${mc}.jar`), 'version.json');
      const v = raw && (() => { try { return JSON.parse(raw.toString('utf8')).pack_version; } catch { return null; } })();
      if (v != null) return v;
    }
    return atLeast(mc, '1.14') ? null : 4;
  }
  const koreanLines = (pack) => {
    const assets = path.join(pack, 'assets');
    let n = 0;
    for (const ns of fs.existsSync(assets) ? fs.readdirSync(assets) : []) {
      const lines = readJson(path.join(assets, ns, 'lang', 'ko_kr.json'));
      if (lines && typeof lines === 'object') n += Object.values(lines).filter((v) => typeof v === 'string').length;
    }
    return n;
  };
  // The instance's mods, the lines they lack in Korean, and whether its options.txt has the pack on (null: the file's
  // resourcePacks line cannot be read).
  function koreanStatus(root, name) {
    const inst = readInstance(root, name);
    koreanVersion(inst);
    const dir = dirOf(root, name);
    const { mods, skipped } = translation.scan(dir, koreanDir(root, name));
    const count = (m) => Object.keys(m.missing).length;
    let enabled = null;
    try { enabled = resourcePacksOf(path.join(dir, OPTIONS)).includes(KOREAN_ENTRY); } catch {}
    return { mods: mods.map((m) => ({ jar: m.jar, ns: m.ns, total: m.total, missing: count(m) })), skipped,
      missing: mods.reduce((s, m) => s + count(m), 0), lines: koreanLines(koreanDir(root, name)), enabled };
  }
  // The pack turned on in options.txt, unless this instance's game is running (or Windows cannot say), which would write
  // its own list over it when it closes: then at the next Play. -> 'added', 'on' (it was), 'pending' or 'damaged'.
  async function turnKoreanOn(root, name, log) {
    const dir = dirOf(root, name);
    const later = path.join(koreanDir(root, name), TURN_ON);
    if ((await gameRunningIn(dir)) !== false) {
      fs.writeFileSync(later, 'Nano Studio Craft turns this pack on in options.txt at the next Play.\n');
      log('The game is running: the pack is turned on at the next Play.\n');
      return 'pending';
    }
    try {
      const added = enablePack(path.join(dir, OPTIONS), KOREAN_ENTRY);
      fs.rmSync(later, { force: true });
      log(added ? `${OPTIONS}: ${KOREAN_ENTRY} turned on, from the next game start.\n` : `${OPTIONS}: ${KOREAN_ENTRY} is on already.\n`);
      return added ? 'added' : 'on';
    } catch (err) {
      if (err.code !== 'badOptions') throw err;
      log(`${err.message}\n`);
      return 'damaged';
    }
  }
  // -> {translated, rejected, failed, files, pack, enabled (turnKoreanOn's, or null with no line to turn on)}.
  const translatingNow = new Set();
  async function translateKorean(root, name, { translate, log, signal }) {
    const inst = readInstance(root, name);
    koreanVersion(inst);
    const dir = dirOf(root, name);
    const key = dir.toLowerCase();
    if (translatingNow.has(key)) throw fail(`${name} is being translated already`, 'busy');
    translatingNow.add(key);
    try {
      if (await gameRunningIn(dir)) throw fail(`${inst.title || name} is being played: close Minecraft first, since the game writes its options.txt when it closes`, 'playing');
      const pack = koreanDir(root, name);
      const { mods } = translation.scan(dir, pack);
      let result = { translated: 0, rejected: 0, failed: 0, files: [] };
      if (mods.some((m) => Object.keys(m.missing).length)) {
        const format = clientPackVersion(root, inst.mc);
        if (format == null) throw fail('Launch the instance once first: the resource pack format comes from the Minecraft the launcher downloads', 'notPlayed');
        // The instance's Minecraft may have changed since the pack was made (a server's pack moves it).
        const meta = packMcmeta(format, `Korean for the mods of ${inst.title || name}, by Nano Studio Craft (Minecraft ${inst.mc})`);
        fs.mkdirSync(pack, { recursive: true });
        if (readText(path.join(pack, 'pack.mcmeta')) !== meta) fs.writeFileSync(path.join(pack, 'pack.mcmeta'), meta);
        result = await translation.translateMods(dir, { mods, translate, log, signal, pack });
      }
      const enabled = koreanLines(pack) && fs.existsSync(path.join(pack, 'pack.mcmeta')) ? await turnKoreanOn(root, name, log) : null;
      return { ...result, pack, enabled };
    } finally { translatingNow.delete(key); }
  }

  // What the server says it runs, for the dialog that asks for the version. A private server answers only through a join
  // process: the public port speaks the gate, and a server not added yet has its key only in the code it came with.
  async function pingServer(text) {
    const code = JOIN_CODE.test(text) ? parseJoinCode(text) : null;
    if (!code?.key) {
      const { host, port } = parseAddress(code?.address ?? text);
      return ping(host, port);
    }
    // A join process already running is the game's, which start() hands back: only the one started here is stopped.
    const ours = !joins.running().includes(code.address.toLowerCase());
    try {
      return await ping(LOCAL, await joins.start({ address: code.address, key: code.key, port: 0 }));
    } finally { if (ours) joins.stop(code.address); }
  }

  const status = (root) => {
    const how = launchMethod();
    return { launcher: how ? how.argv[0] : null, method: how?.id ?? null, download: DOWNLOAD_PAGE, workDir: gameDir(root), instancesDir: instancesDir(root) };
  };

  // The window learns whether a code is private; the key stays in main.
  const readCode = (text) => {
    const { key, ...code } = parseJoinCode(text);
    return { ...code, private: !!key };
  };

  return { status, instances, versions: mcVersions, loaderVersions, create, fromPack, remove, servers, saveServers, join, play, mods, setMod, koreanStatus, translateKorean, joinCode, parseJoinCode: readCode, ping: pingServer, stopJoins: joins.stopAll };
}

module.exports = { createLauncher, findLauncher, findStore, launchMethod, launcherOpen, closeLauncher, gameRunningIn, enablePack, parseJoinCode, joinCode, parseAddress, serverArgs, headlessClient, readProfiles, KOREAN_PACK };
