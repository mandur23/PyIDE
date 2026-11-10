// Main side of the minecraft plugin, which loads in craft mode only: Minecraft servers in a project (servers/<name>,
// described by pyide-server.json), the Java each needs, the client pack (.mrpack) players import to get a modded
// server's mods, the resource pack a server sends players when they join, and a Velocity proxy's wiring to the
// project's Paper servers. Downloads are checked against the checksum their source publishes; Java comes from this
// computer's JDKs or, when the version a server needs is missing, from Adoptium's Temurin into ~/.pyide/java. Nothing
// runs for a project the user has not trusted.
// PYIDE_MC_JAVA (tests): a Java home used for every version.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const trust = require('../trust');
const { download, tarExe } = require('../installer/servers');
const { createToolchains, installRoot } = require('../installer/toolchains');
const { KINDS, javaFor, temurin, mojangProfile } = require('../minecraft/sources');
const { writeZipFile, readEntry, openZip } = require('../minecraft/zipfile');
const T = require('../minecraft/templates');
const { createImports, detectServer, discardDownload } = require('../minecraft/imports');
const market = require('../minecraft/market');
const translation = require('../minecraft/translate');
const serverSettings = require('../minecraft/server-settings');
const xray = require('../minecraft/anti-xray');
const { createLauncher } = require('../minecraft/launcher');
const fileServer = require('../minecraft/file-server');
const { createPlayers } = require('../minecraft/players');
const { forNewServer } = require('../minecraft/players/bridge');
const runMarker = require('../minecraft/run-marker');
const { createBackups, registerIpc: registerBackupIpc } = require('../minecraft/backups');
const { createHealthMonitor, markStops, GC_LOG_ARG } = require('../minecraft/health-monitor');
const { complete } = require('../ai/claude');
const { privateShare } = require('./port-sharing');
const { app, safeStorage } = require('electron');

const SERVER = 'pyide-server.json';
// The app-wide level new servers start with, in settings.json: the Server Settings tab writes it through ide.settings.
const XRAY_DEFAULT = 'minecraft.antiXrayDefault';
const NAME = /^[A-Za-z][\w-]{0,39}$/;
// Windows keeps these names for devices: no folder can have one, whatever its case.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// A server's pyide-server.json, written beside itself and renamed over: an app that dies mid-write leaves the old one.
// What was written last is kept as pyide-server.json.bak too, for Repair to put back once a hand edit has broken it.
const writeJson = (p, v) => {
  const text = `${JSON.stringify(v, null, 2)}\n`;
  serverSettings.replaceFile(p, text);
  try { fs.writeFileSync(`${p}.bak`, text); } catch {}
};
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const notReserved = (name) => { if (RESERVED.test(name)) throw fail(`${name} is a name Windows keeps for a device: choose another`); };
// A game port: 1-65535 (25565 when none is given).
const gamePort = (port) => {
  const n = port == null || port === '' ? 25565 : Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail('Use a port from 1 to 65535');
  return n;
};
const run = (cmd, args, opts, log) => new Promise((resolve, reject) => {
  const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 64 << 20, signal: log.signal, ...opts }, (err) => {
    if (!err) resolve();
    else reject(err.name === 'AbortError' ? err : fail(`${path.basename(cmd)} failed (exit ${err.code ?? err.signal})`));
  });
  child.stdout?.on('data', (d) => log(d.toString()));
  child.stderr?.on('data', (d) => log(d.toString()));
});
const filesUnder = (dir, test) => {
  const out = [];
  // A link is not followed: what it points at would go into the zips players download.
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p); else if (test(e.name)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};
const jarsUnder = (dir) => filesUnder(dir, (n) => n.endsWith('.jar'));
const hashOf = (algo, file) => crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
const propsOf = (dir) => serverSettings.readProperties(path.join(dir, 'server.properties'));
// The port a server binds: a Minecraft server's from server.properties as Java reads it (a value it cannot read is the
// default), a Velocity proxy's from velocity.toml's bind.
function portOf(dir, kind) {
  if (KINDS[kind]?.proxy) {
    const toml = path.join(dir, 'velocity.toml');
    const bind = /^[ \t]*bind[ \t]*=[ \t]*"[^"\n]*:(\d{1,5})"/m.exec(fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : '')?.[1];
    if (bind) return Number(bind);
  }
  const v = propsOf(dir)['server-port'];
  return /^\d{1,5}$/.test(v || '') ? Number(v) : 25565;
}
// Account checks off: Minecraft reads anything but "true" (any case) as false. A Velocity proxy keeps its own in
// velocity.toml, at the top level (before the first table); one imported from elsewhere may have them off.
const offlineAt = (dir) => { const v = propsOf(dir)['online-mode']; return v !== undefined && v.toLowerCase() !== 'true'; };
const proxyOfflineAt = (dir) => {
  const toml = path.join(dir, 'velocity.toml');
  const top = (fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : '').split(/^[ \t]*\[/m)[0];
  return /^[ \t]*online-mode[ \t]*=[ \t]*false[ \t]*(#.*)?$/m.test(top);
};

// Mojang's and the Maven hosts' downloads break off now and then (a reset connection mid-file): a step that fetches
// over the network is tried three times, a few seconds apart. What trying again cannot change is not retried: a
// checksum mismatch, a refusal (a 4xx other than 408 and 429), a full disk, a file over its limit, a redirect that is
// not allowed, a cancelled job.
const hopeless = (err) => err.name === 'AbortError' || ['ENOSPC', 'TOO_LARGE', 'REDIRECT'].includes(err.code) || /Checksum mismatch|HTTP 4(?!08|29)\d\d/.test(err.message);
async function retried(what, step, log) {
  for (let attempt = 1; ; attempt++) {
    try { return await step(); } catch (err) {
      if (attempt === 3 || hopeless(err)) throw err;
      log(`${what} failed (${err.message}); trying again (${attempt + 1} of 3)…\n`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
// log.signal cancels a job's downloads and installers: every step of a job already takes its log.
const fetchFile = (url, dest, opts, log) => retried('The download', () => download(url, dest, { progress: () => {}, log, signal: log.signal, ...opts }), log);
const majorOf = (v) => { const m = /^1\.(\d+)|^(\d+)/.exec(v || ''); return m ? Number(m[1] || m[2]) : 0; };

// ---------- Java ----------
const javaRoot = () => path.join(installRoot(), 'java');
// A Java home of exactly `major`: this computer's JDKs, then a Temurin downloaded before (JDKs too, which mod builds
// used to fetch).
async function findJava(major) {
  if (process.env.PYIDE_MC_JAVA) return process.env.PYIDE_MC_JAVA;
  const exe = (home) => isFile(path.join(home, 'bin', 'java.exe'));
  for (const t of await createToolchains().detect('jdk')) if (majorOf(t.version) === major && exe(t.home)) return t.home;
  for (const kind of ['jre', 'jdk']) {
    const dir = path.join(javaRoot(), `temurin-${major}-${kind}`);
    const home = fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)).find(exe) : null;
    if (home) return home;
  }
  return null;
}
// One download a version at a time: two servers starting at once would share its archive and staging folder.
const javaJobs = new Map(); // major -> Promise<home>
function ensureJava(major, { log }) {
  if (!javaJobs.has(major)) javaJobs.set(major, installJava(major, { log }).finally(() => javaJobs.delete(major)));
  else log(`Waiting for Java ${major}, which is being downloaded already…\n`);
  return javaJobs.get(major);
}
async function installJava(major, { log }) {
  const found = await findJava(major);
  if (found) return found;
  const t = await temurin(major).catch((err) => { throw fail(`Java ${major} is not installed, and Adoptium could not be asked for it: ${err.message}`); });
  log(`Java ${major} is not installed; downloading Temurin JRE ${major} from Adoptium.\n`);
  fs.mkdirSync(javaRoot(), { recursive: true });
  const archive = path.join(javaRoot(), t.name);
  await fetchFile(t.url, archive, { sha256: t.sha256, size: t.size }, log);
  const dir = path.join(javaRoot(), `temurin-${major}-jre`);
  const staging = `${dir}.extract`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  await run(tarExe(), ['-xf', archive, '-C', staging], {}, log);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  fs.rmSync(archive, { force: true });
  return findJava(major);
}

// ---------- servers ----------
// The folders of servers/ holding a pyide-server.json, as [{...its JSON, name, dir}], not one still being made. One
// whose file cannot be read, or names a server type Nano Studio does not know, is {name, dir, damaged: 'unreadable' |
// 'kind', kind}: listed so, it keeps its card (and its Stop, if it runs) and its name, instead of going without a word.
// damagedServers adds repair: what Repair would take its description from (repairSource), null when nothing can.
function serverFolders(root) {
  const parent = path.join(root, 'servers');
  return (fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }) : [])
    .filter((d) => d.isDirectory() && isFile(path.join(parent, d.name, SERVER)) && !isFile(path.join(parent, d.name, UNFINISHED))).map((d) => {
      const dir = path.join(parent, d.name);
      const meta = readJson(path.join(dir, SERVER));
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { name: d.name, dir, damaged: 'unreadable' };
      if (!KINDS[meta.kind]) return { name: d.name, dir, damaged: 'kind', kind: typeof meta.kind === 'string' ? meta.kind.slice(0, 40) : null };
      return { ...meta, name: d.name, dir };
    });
}
const usableDesc = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !!KINDS[v.kind];
// 'backup': the copy written last (.bak) is one Nano Studio can run; 'files': the folder runs a server it recognises;
// null: neither, so only a hand edit can fix it (a type from elsewhere, with no jar it knows).
const repairSource = (dir) => (usableDesc(readJson(path.join(dir, `${SERVER}.bak`))) ? 'backup' : detectServer(dir, javaOfJar) ? 'files' : null);
const damagedServers = (root) => serverFolders(root).filter((s) => s.damaged).map((s) => ({ ...s, repair: repairSource(s.dir) }));
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// AutoModpack's jar in the server's mods: players who have it get the server's mods when they join.
const autoModpackOf = (dir) => (fs.existsSync(path.join(dir, 'mods')) ? fs.readdirSync(path.join(dir, 'mods')).find((n) => /^automodpack.*\.jar$/i.test(n)) : null) || null;

// The project's servers, each with what its kind runs; not one still being made.
function servers(root) {
  return serverFolders(root).filter((s) => !s.damaged).map((s) => ({
    ...s, plugins: KINDS[s.kind]?.plugins || null, mods: KINDS[s.kind]?.mods || null, proxy: !!KINDS[s.kind]?.proxy, port: portOf(s.dir, s.kind),
    resourcePack: fs.existsSync(path.join(s.dir, 'resourcepack', 'pack.mcmeta')), autoSync: !!autoModpackOf(s.dir),
    // Account checks off (behind a proxy, which checks them; or the proxy's own): joined directly, anyone may take any
    // player's name.
    offline: KINDS[s.kind]?.proxy ? proxyOfflineAt(s.dir) : offlineAt(s.dir),
  }));
}
const serverOf = (dir) => {
  if (!fs.existsSync(path.join(dir, SERVER))) throw fail(`${dir} is not a Nano Studio Minecraft server (no ${SERVER})`);
  const desc = readJson(path.join(dir, SERVER));
  if (!desc || typeof desc !== 'object' || Array.isArray(desc)) throw fail(`${path.join(dir, SERVER)} cannot be read: fix it or create the server again`);
  return desc;
};

// The Java a jar is built for: its Main-Class's class file version (69 is Java 25), 21 when it cannot be read.
function javaOfJar(file) {
  const manifest = readEntry(file, 'META-INF/MANIFEST.MF')?.toString('utf8') || '';
  const main = /^Main-Class:\s*(\S+)/m.exec(manifest)?.[1];
  const cls = main && readEntry(file, `${main.replace(/\./g, '/')}.class`);
  return cls && cls.readUInt32BE(0) === 0xcafebabe ? cls.readUInt16BE(6) - 44 : 21;
}

// Forge and NeoForge installers leave run.bat with @argument files (1.17+), or a forge-<version>.jar (older).
function installedLaunch(dir) {
  for (const lib of ['libraries/net/minecraftforge/forge', 'libraries/net/neoforged/neoforge']) {
    const base = path.join(dir, lib);
    if (!fs.existsSync(base)) continue;
    for (const v of fs.readdirSync(base)) {
      const file = path.join(base, v, 'win_args.txt');
      if (isFile(file)) return { argsFile: path.relative(dir, file).replace(/\\/g, '/') };
    }
  }
  const jar = fs.readdirSync(dir).find((n) => /^(forge|neoforge)-.*\.jar$/.test(n) && !/installer/.test(n));
  if (jar) return { jar };
  throw fail('The installer finished but left no way to start the server');
}

// A server folder being made holds this file from its first write to its last: a folder with it is what a create or an
// import cut off half-way (the app closed) left, not the user's. It is not listed, and a new create of its name
// replaces it; a folder without it is never removed.
const UNFINISHED = 'pyide-server.unfinished';
const building = new Set(); // folders (lower case) a create or import of this run is making
const keyOf = (dir) => path.resolve(dir).toLowerCase();
const unfinished = {
  claim(dir) {
    if (building.has(keyOf(dir))) throw fail(`${path.basename(dir)} is being made already`);
    if (fs.existsSync(dir)) {
      if (!isFile(path.join(dir, UNFINISHED))) {
        throw fail(isFile(path.join(dir, SERVER)) ? `A server named ${path.basename(dir)} already exists`
          : `servers/${path.basename(dir)} is a folder that is not a Nano Studio server: choose another name, or move that folder away`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    building.add(keyOf(dir));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, UNFINISHED), '');
  },
  done(dir) { fs.rmSync(path.join(dir, UNFINISHED), { force: true }); building.delete(keyOf(dir)); },
  // Never throws, so the caller's error is the one shown. A folder a virus scanner or a Java still holds a file of is
  // marked again (the removal took the mark first), and the next create of its name replaces it.
  undo(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch {
      try { fs.writeFileSync(path.join(dir, UNFINISHED), ''); } catch {}
    } finally { building.delete(keyOf(dir)); }
  },
};
// What blocks a new server's name: entries of servers/ that are neither a server (damaged ones included, which are
// listed as such) nor an unfinished one.
function blockedNames(root) {
  const parent = path.join(root, 'servers');
  const known = new Set(serverFolders(root).map((s) => s.name.toLowerCase()));
  return (fs.existsSync(parent) ? fs.readdirSync(parent) : []).filter((n) => !known.has(n.toLowerCase()) && !isFile(path.join(parent, n, UNFINISHED)));
}

// loader: the exact mod loader version (a modpack's), else the recommended or newest. keepUnfinished: the caller adds
// more and finishes the folder itself (unfinished.done).
async function create({ root, name, kind, mc, loader, memory = '2G', port = 25565, eula }, log, { keepUnfinished = false } = {}) {
  const source = KINDS[kind];
  if (!source) throw fail(`Unknown server type ${kind}`);
  // A proxy runs no Minecraft server, so Mojang's EULA is not its to accept.
  if (!eula && !source.proxy) throw fail('The Minecraft EULA must be accepted to run a server');
  if (!NAME.test(name || '')) throw fail('Use letters, digits, - and _ for the name, starting with a letter');
  notReserved(name);
  port = gamePort(port);
  const dir = path.join(root, 'servers', name);
  if (isFile(path.join(dir, UNFINISHED)) && !building.has(keyOf(dir))) log(`Removing what an unfinished create of ${name} left…\n`);
  unfinished.claim(dir);
  try {
    log(`${source.title} ${mc}\n`);
    const r = await source.resolve(mc, loader, log);
    const file = path.join(dir, r.file);
    await fetchFile(r.url, file, { sha256: r.sha256, size: r.size }, log);
    if (r.sha1 && hashOf('sha1', file) !== r.sha1) throw fail(`Checksum mismatch for ${r.file}`);
    if (r.md5 && hashOf('md5', file) !== r.md5) throw fail(`Checksum mismatch for ${r.file}`);
    const java = source.java === 'jar' ? javaOfJar(file) : await javaFor(mc);
    let launch = { jar: r.file };
    if (r.installer) {
      const home = await ensureJava(java, { log });
      log(`Running the ${source.title} installer…\n`);
      // The installer downloads Minecraft's server and libraries itself, and skips what it already has on a retry.
      await retried('The installer', () => run(path.join(home, 'bin', 'java.exe'), ['-jar', r.file, '--installServer'], { cwd: dir }, log), log);
      for (const n of [r.file, `${r.file}.log`, 'installer.log']) fs.rmSync(path.join(dir, n), { force: true });
      launch = installedLaunch(dir);
    }
    if (source.proxy) {
      // The forwarding secret proves to the Paper servers behind the proxy that a player came through it.
      fs.writeFileSync(path.join(dir, 'forwarding.secret'), crypto.randomBytes(18).toString('base64url'));
      fs.writeFileSync(path.join(dir, 'velocity.toml'), T.velocityToml(port, []));
      fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\n`);
    } else {
      // The user agreed in the New Server dialog, which links the EULA; the date says when.
      fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted in Nano Studio on ${new Date().toISOString()}: https://aka.ms/MinecraftEULA\neula=true\n`);
      if (!fs.existsSync(path.join(dir, 'server.properties'))) fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\nmotd=${name}\n`);
    }
    for (const sub of source.plugins ? ['plugins'] : source.mods ? ['mods'] : []) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const antiXrayPending = xray.newServerLevel({ ...source, mc }, readJson(path.join(app.getPath('userData'), 'settings.json'))?.[XRAY_DEFAULT]);
    const desc = { kind, mc, loader: r.loader || null, build: r.build || null, java, memory, launch, ...(antiXrayPending && { antiXrayPending }) };
    writeJson(path.join(dir, SERVER), desc);
    forNewServer(readJson(path.join(app.getPath('userData'), 'settings.json')), dir, { kind, version: mc }, log);
    if (!keepUnfinished) unfinished.done(dir);
    log(`Created ${path.relative(root, dir)}\n`);
    return { name, dir, ...desc };
  } catch (err) {
    unfinished.undo(dir);
    throw err;
  }
}

// Garbage collector options a server starts with unless pyide-server.json gives its own jvmArgs ([] for none). A
// Minecraft server gets Aikar's flags, which PaperMC's documentation recommends (G1 sized for a game loop's short-lived
// objects: fewer and shorter pauses, the lag spikes players notice); a Velocity proxy gets Velocity's. Both leave out
// -XX:+AlwaysPreTouch and -Xms equal to -Xmx: on a development machine beside the IDE the heap grows as the server
// needs it, instead of taking all of -Xmx and touching every page of it before the server starts.
const SERVER_JVM_ARGS = ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4', '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true'];
const PROXY_JVM_ARGS = ['-XX:+UseG1GC', '-XX:G1HeapRegionSize=4M', '-XX:+UnlockExperimentalVMOptions', '-XX:+ParallelRefProcEnabled', '-XX:MaxInlineLevel=15'];
const jvmArgsOf = (desc) => (Array.isArray(desc.jvmArgs) ? desc.jvmArgs.map(String) : KINDS[desc.kind]?.proxy ? PROXY_JVM_ARGS : SERVER_JVM_ARGS);
// Output is decoded as UTF-8 and stdin is written as UTF-8, while a JVM on Korean Windows defaults to MS949 for a pipe,
// and the Players tab would store that damage for 30 days. Not part of jvmArgs, which a server may replace. System.out
// reads stdout.encoding from Java 19 and sun.stdout.encoding before it. Vanilla's console reader is fixed to UTF-8;
// Paper's uses the default charset, which is what file.encoding sets. stdin.encoding is Java 25's, for what asks it.
const ENCODING_ARGS = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dstdin.encoding=UTF-8',
  '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'];

async function launch(dir, log) {
  const desc = serverOf(dir);
  // A description edited by hand: what a start needs, said before any Java is looked for.
  if (!KINDS[desc.kind]) throw fail(`${SERVER} names no server type Nano Studio knows (kind: ${JSON.stringify(desc.kind ?? null)})`);
  if (!Number.isInteger(desc.java) || desc.java < 8) throw fail(`${SERVER} names no Java version (java: ${JSON.stringify(desc.java ?? null)})`);
  if (!desc.launch?.jar && !desc.launch?.argsFile) throw fail(`${SERVER} does not say how to start the server (launch)`);
  const port = portOf(dir, desc.kind);
  if (port > 65535) throw fail(`server.properties sets server-port=${port}: use a port from 1 to 65535`);
  const home = await ensureJava(desc.java, { log });
  if (!isFile(path.join(home, 'bin', 'java.exe'))) throw fail(`Java ${desc.java} was not found in ${home}`);
  const mem = /^\d+[MG]$/i.test(desc.memory || '') ? desc.memory : '2G';
  // The GC log health-monitor.js reads for memory pressure, to a file: the console stays as it was. Java 8 refuses -Xlog.
  const gcLog = desc.java >= 9 && !jvmArgsOf(desc).some((a) => /^-Xlog/i.test(a)) ? [GC_LOG_ARG] : [];
  const args = [...ENCODING_ARGS, ...gcLog, `-Xmx${mem}`, ...jvmArgsOf(desc)];
  if (desc.launch.argsFile) {
    if (isFile(path.join(dir, 'user_jvm_args.txt'))) args.push('@user_jvm_args.txt');
    args.push(`@${desc.launch.argsFile}`);
  } else args.push('-jar', desc.launch.jar);
  if (!KINDS[desc.kind]?.proxy) args.push('nogui');
  // The port it will bind, which the renderer's list may not know yet (server.properties edited since).
  return { cmd: path.join(home, 'bin', 'java.exe'), args, cwd: dir, java: desc.java, port };
}

// ---------- Velocity ----------
// The proxy sends players to every Paper or Purpur server of the project: its [servers] table lists them, and each of
// them takes modern forwarding with the proxy's secret. Runs before each start of the proxy. A server older than
// Minecraft 1.13 has no modern forwarding: it is left out (skipped) and keeps its own account checks.
function wireProxy(root, dir) {
  const desc = serverOf(dir);
  if (!KINDS[desc.kind]?.proxy) return { backends: [], skipped: [] };
  const paper = servers(root).filter((s) => s.plugins === 'paper');
  const backends = paper.filter((s) => T.velocityConfig(s.mc)).map((s) => ({ name: s.name, port: s.port, dir: s.dir, mc: s.mc }));
  const skipped = paper.filter((s) => !T.velocityConfig(s.mc));
  const toml = path.join(dir, 'velocity.toml');
  // An imported proxy that never ran has no secret yet.
  const secretFile = path.join(dir, 'forwarding.secret');
  if (!fs.existsSync(secretFile) || !fs.readFileSync(secretFile, 'utf8').trim()) fs.writeFileSync(secretFile, crypto.randomBytes(18).toString('base64url'));
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  const text = fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : T.velocityToml(portOf(dir, desc.kind), []);
  fs.writeFileSync(toml, T.setVelocityForwarding(T.setVelocityServers(text, backends)));
  for (const b of backends) T.setPaperVelocity(b.dir, secret, b.mc);
  // An older Nano Studio turned their account checks off too.
  for (const s of skipped) T.unsetPaperVelocity(s.dir);
  return { backends: backends.map(({ name, port }) => ({ name, port })), skipped: skipped.map(({ name, mc }) => ({ name, mc })) };
}
// After a server is deleted, each proxy sends players on to the servers left. With no proxy left, the Paper servers
// that were behind one take direct joins again: forwarding off, account checks on.
function rewireProxies(root) {
  const proxies = servers(root).filter((s) => s.proxy && fs.existsSync(path.join(s.dir, 'forwarding.secret')));
  for (const p of proxies) wireProxy(root, p.dir);
  if (!proxies.length) for (const s of servers(root).filter((x) => x.plugins === 'paper')) T.unsetPaperVelocity(s.dir);
  return proxies.map((p) => p.name);
}

// ---------- client pack ----------
// A Modrinth modpack (.mrpack): modrinth.index.json naming Minecraft and the loader, and the server's mods as
// overrides. Prism Launcher, the Modrinth App and ATLauncher import one into a ready instance.
// The packs written this run, by file -> what they were made from. Copy Join Code asks for the pack each time: one whose
// sources and own file are as they were is not zipped again.
const packsBuilt = new Map();
const statKey = (files) => JSON.stringify(files.map((f) => { try { const s = fs.statSync(f); return [f, s.size, s.mtimeMs]; } catch { return [f]; } }));
async function packOnce(file, sources, entries) {
  const key = statKey(sources);
  if (packsBuilt.get(file) === `${key}${statKey([file])}`) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeZipFile(file, entries());
  packsBuilt.set(file, `${key}${statKey([file])}`);
}
async function clientPack(dir) {
  const desc = serverOf(dir);
  const loaderKey = KINDS[desc.kind]?.mods;
  if (!loaderKey) throw fail('Players of a server without mods need nothing but Minecraft itself');
  const name = path.basename(dir);
  const modsDir = path.join(dir, 'mods');
  // A server made from a modpack hands players the modpack itself, which has the client mods the server leaves out,
  // with the mods added to the server since (the Market, dropped jars) in its overrides.
  const pack = desc.modpack?.clientPack && path.join(dir, desc.modpack.clientPack);
  if (pack && isFile(pack)) {
    const info = { modpack: desc.modpack.name, mc: desc.mc, loader: `${loaderKey} ${desc.loader}` };
    const zip = openZip(pack);
    try {
      let index = null;
      try { index = JSON.parse(zip.read('modrinth.index.json').toString('utf8').replace(/^﻿/, '')); } catch {}
      const ofPack = new Set([...(Array.isArray(index?.files) ? index.files : []).map((f) => path.posix.basename(String(f?.path || ''))),
        ...zip.names.filter((n) => /^(client-|server-)?overrides\/mods\/[^/]+$/.test(n)).map((n) => path.posix.basename(n))].map((n) => n.toLowerCase()));
      const added = (fs.existsSync(modsDir) ? fs.readdirSync(modsDir) : []).filter((n) => n.endsWith('.jar') && !ofPack.has(n.toLowerCase())).sort();
      if (!added.length) return { file: pack, mods: [], added: [], ...info };
      const file = path.join(dir, 'client-pack', `${name}-${desc.mc}.mrpack`);
      await packOnce(file, [pack, ...added.map((m) => path.join(modsDir, m))], () => [...zip.names.filter((n) => !n.endsWith('/')).map((n) => ({ name: n, read: () => zip.read(n) })),
        ...added.map((m) => ({ name: `overrides/mods/${m}`, file: path.join(modsDir, m) }))]);
      return { file, mods: added, added, ...info };
    } finally { zip.close(); }
  }
  // With AutoModpack the pack holds it alone: it fetches the server's mods into its own folder at the first join, and
  // the same mods in mods/ as well would load twice.
  const sync = autoModpackOf(dir);
  const mods = sync ? [sync] : fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((n) => n.endsWith('.jar')) : [];
  const index = { formatVersion: 1, game: 'minecraft', versionId: new Date().toISOString().slice(0, 10), name, summary: `Mods of the ${name} server`,
    files: [], dependencies: { minecraft: desc.mc, [loaderKey]: desc.loader } };
  const file = path.join(dir, 'client-pack', `${name}-${desc.mc}.mrpack`);
  await packOnce(file, [path.join(dir, SERVER), ...mods.map((m) => path.join(modsDir, m))], () => [{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2)) },
    ...mods.map((m) => ({ name: `overrides/mods/${m}`, file: path.join(modsDir, m) }))]);
  return { file, mods, autoSync: !!sync, mc: desc.mc, loader: `${loaderKey} ${desc.loader}` };
}

// ---------- resource pack ----------
// The resource pack format of the server's Minecraft: version.json in Mojang's server jar, wherever this kind keeps it
// (the jar itself, Paper's cache/ after its first start, the installers' libraries/net/minecraft).
function packVersion(dir) {
  const jars = [path.join(dir, 'server.jar'), ...jarsUnder(path.join(dir, 'cache')), ...jarsUnder(path.join(dir, 'libraries', 'net', 'minecraft')),
    ...jarsUnder(path.join(dir, 'versions')), ...jarsUnder(path.join(dir, '.fabric'))].filter(isFile);
  for (const jar of jars) {
    const raw = readEntry(jar, 'version.json');
    const v = raw && (() => { try { return JSON.parse(raw.toString('utf8')).pack_version; } catch { return null; } })();
    if (v != null) return v;
  }
  return null;
}
// A resource pack folder (resourcepack/) with its pack.mcmeta, for the user to put textures, sounds and models in.
function newResourcePack(dir) {
  const desc = serverOf(dir);
  const folder = path.join(dir, 'resourcepack');
  if (fs.existsSync(path.join(folder, 'pack.mcmeta'))) return { folder, created: false };
  const version = packVersion(dir);
  if (version == null) throw fail('Start the server once first: the resource pack format comes from the Minecraft server it downloads', 'notStarted');
  fs.mkdirSync(path.join(folder, 'assets', 'minecraft', 'textures'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'pack.mcmeta'), T.packMcmeta(version, `Resource pack of the ${path.basename(dir)} server (Minecraft ${desc.mc})`));
  return { folder, created: true };
}
// The pack zipped into client-pack/resourcepack.zip, with the SHA-1 Minecraft checks it against.
async function packResourcePack(dir) {
  const folder = path.join(dir, 'resourcepack');
  if (!fs.existsSync(path.join(folder, 'pack.mcmeta'))) throw fail('The server has no resource pack yet');
  const entries = filesUnder(folder, () => true).map((f) => ({ name: path.relative(folder, f).replace(/\\/g, '/'), file: f }));
  const outDir = path.join(dir, 'client-pack');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'resourcepack.zip');
  await writeZipFile(file, entries);
  return { file, sha1: hashOf('sha1', file), files: entries.length };
}
// Players are sent the pack when they join: server.properties names its address and SHA-1, and requires it.
function applyResourcePack(dir, url, sha1) {
  if (!/^https?:\/\/\S+$/.test(url || '') || !/^[0-9a-f]{40}$/.test(sha1 || '')) throw fail('The resource pack needs an http(s) address and a SHA-1');
  const props = path.join(dir, 'server.properties');
  T.setProperty(props, 'resource-pack', url);
  T.setProperty(props, 'resource-pack-sha1', sha1);
  T.setProperty(props, 'require-resource-pack', 'true');
  return { props };
}

// ---------- settings ----------
// The Server Settings tab: server.properties and the player lists (main/minecraft/server-settings.js), and from
// pyide-server.json the memory and the JVM options (null: the defaults above). A proxy keeps the rest in velocity.toml.
const xrayView = (desc) => ({ ...KINDS[desc.kind], mc: desc.mc, pending: desc.antiXrayPending });
function settings(dir) {
  const desc = serverOf(dir);
  const proxy = !!KINDS[desc.kind]?.proxy;
  // A proxy of the project sends its players here with their real accounts: Paper and Purpur from 1.13 (wireProxy).
  const behindProxy = KINDS[desc.kind]?.plugins === 'paper' && !!T.velocityConfig(desc.mc)
    && servers(path.dirname(path.dirname(dir))).some((s) => s.proxy);
  return { proxy, behindProxy, memory: desc.memory || '2G', jvmArgs: Array.isArray(desc.jvmArgs) ? desc.jvmArgs.map(String) : null,
    defaultJvmArgs: proxy ? PROXY_JVM_ARGS : SERVER_JVM_ARGS, schema: proxy ? [] : serverSettings.PROPERTIES,
    antiXray: xray.status(dir, xrayView(desc)), ...(proxy ? { props: {}, whitelist: [], ops: [] } : serverSettings.read(dir)) };
}
// Only what is given changes; everything is checked before anything is written. A refused anti-xray level comes back as
// a value (antiXrayRefused) with nothing written, because the tab words it from the code and IPC errors lose theirs.
function saveSettings(dir, { memory, jvmArgs, props, whitelist, ops, antiXray } = {}) {
  const desc = serverOf(dir);
  const next = { ...desc };
  const plan = antiXray === undefined ? null : xray.planned(dir, xrayView(desc), antiXray);
  if (plan?.refused) return { ...settings(dir), antiXrayRefused: plan.refused };
  if (plan) delete next.antiXrayPending;
  if (memory !== undefined) {
    if (!/^\d+[MG]$/i.test(memory || '')) throw fail('Memory is a number of M or G, such as 2G');
    next.memory = memory.toUpperCase();
  }
  if (jvmArgs === null) delete next.jvmArgs;
  else if (jvmArgs !== undefined) {
    if (!Array.isArray(jvmArgs) || jvmArgs.some((a) => typeof a !== 'string' || !/^-\S/.test(a))) throw fail('Each JVM option starts with - and has no spaces');
    if (jvmArgs.some((a) => /^-Xmx/i.test(a))) throw fail('Set the memory with Memory, not -Xmx');
    next.jvmArgs = jvmArgs;
  }
  const writeProps = KINDS[desc.kind]?.proxy ? null : serverSettings.prepare(dir, { props, whitelist, ops });
  // Anti-xray's files go first: they are the one write that can be refused whole, and a Save it refuses saves nothing.
  const refused = plan && xray.commit(plan.changes);
  if (refused) return { ...settings(dir), antiXrayRefused: refused };
  // The properties and lists failing after them (server.properties read-only, say) put anti-xray's files back, so a
  // Save that says it failed changed nothing; a file that would not go back is named.
  try { writeProps?.(); } catch (err) {
    const left = plan ? xray.rollBack(plan.changes) : [];
    if (left.length) throw fail(`${err.message}; the anti-xray settings in ${left.join(', ')} could not be put back`);
    throw err;
  }
  writeJson(path.join(dir, SERVER), next);
  return settings(dir);
}
// The other servers of the project, as "apply to my other servers" lists them.
const xrayServers = (root, except) => servers(root).filter((s) => !sameDir(s.dir, except))
  .map((s) => ({ name: s.name, dir: s.dir, kind: s.kind, mc: s.mc, ...xray.status(s.dir, xrayView(s)) }));
// One result a server: a failure on one does not stop the next.
const applyXray = (dirs, level) => dirs.map((dir) => {
  const name = path.basename(dir);
  try {
    const desc = serverOf(dir);
    const r = xray.assign(dir, xrayView(desc), level);
    if (r.pending !== undefined && r.pending !== (desc.antiXrayPending ?? null)) {
      if (r.pending) desc.antiXrayPending = r.pending; else delete desc.antiXrayPending;
      writeJson(path.join(dir, SERVER), desc);
    }
    return { name, dir, ...r };
  } catch (err) { return { name, dir, outcome: 'refused', code: 'unwritable', file: '', detail: err.message }; }
});


// ---------- Korean translation ----------
// translate.js's translate(system, prompt, signal): Claude through the user's Claude Code.
const askClaude = async (system, prompt, signal) => (await complete({ system, prompt, model: 'sonnet', signal })).text;
function langStatus(dir) {
  const { mods, skipped } = translation.scan(dir);
  const count = (m) => Object.keys(m.missing).length;
  return { mods: mods.map((m) => ({ jar: m.jar, ns: m.ns, total: m.total, missing: count(m) })), skipped,
    missing: mods.reduce((s, m) => s + count(m), 0), pack: fs.existsSync(path.join(dir, 'resourcepack', 'pack.mcmeta')) };
}
async function translateMods(dir, log, signal, progress) {
  if (!KINDS[serverOf(dir).kind]?.mods) throw fail('Only a Fabric, Forge or NeoForge server has mods to translate');
  newResourcePack(dir);
  const { mods } = translation.scan(dir);
  if (!mods.some((m) => Object.keys(m.missing).length)) return { translated: 0, rejected: 0, failed: 0, files: [] };
  return translation.translateMods(dir, { mods, translate: askClaude, log, signal, progress });
}

// Server folders (lower case) with a process minecraft:start started that has not ended -> how many: a Rerun's new
// process starts before the old one has closed.
const runningDirs = new Map();
const isRunning = (dir) => runningDirs.has(keyOf(dir));
const ownPids = new Set(); // the processes of runningDirs
// A process a folder's marker names that this app did not start (or no longer knows: it was started before a crash).
let health = null; // health-monitor.js, made in register (it tells the window)
const leftOver = async (dir) => {
  const m = runMarker.read(dir);
  if (m && ownPids.has(m.pid)) return null;
  const left = await runMarker.leftOver(dir);
  // The marker went because its process is gone: the server ended while no Nano Studio watched it.
  if (m && !left && !runMarker.read(dir)) health?.foundGone(dir, m);
  return left;
};
const refuseLeftOver = async (dir) => {
  const left = await leftOver(dir);
  if (left) throw fail(`${path.basename(dir)} is still running outside this window (process ${left.pid}): an earlier Nano Studio started it, or another one did. End it on its card, or stop it where it was started.`, 'leftOver');
};
// Settings saved while a server runs apply at its next start, but a dedicated server writes server.properties whole,
// from the copy it read when it started, whenever a command changes a setting (whitelist on, difficulty,
// defaultgamemode): what was saved since is taken back. Until the server ends, the keys saved meanwhile are watched. A
// rewrite that puts back the value a key had when it was saved is undone for that key; one that writes a third value is
// the server's own change (an operator's /difficulty), which stands.
const heldProps = new Map(); // folder (lower case) -> {file, keys: Map(key -> {was, now})}
function holdProps(dir, before, saved) {
  const k = keyOf(dir);
  const file = path.join(dir, 'server.properties');
  const held = heldProps.get(k) || { file, keys: new Map() };
  for (const key of Object.keys(saved)) if (before[key] !== saved[key]) held.keys.set(key, { was: held.keys.get(key)?.was ?? before[key], now: saved[key] });
  if (!held.keys.size || heldProps.has(k)) return;
  heldProps.set(k, held);
  let checking = false;
  held.check = async () => {
    if (checking) return;
    checking = true;
    // A moment for the server to finish writing its copy.
    await new Promise((r) => { setTimeout(r, 300); });
    try {
      const current = serverSettings.readProperties(file);
      const back = {};
      for (const [key, { was, now }] of held.keys) {
        if (current[key] === now || current[key] === undefined) continue;
        // A key the file did not have holds the server's default, unknown here: a server writes every key at its start.
        if (was === undefined || current[key] === was) back[key] = now;
        else held.keys.delete(key);
      }
      if (Object.keys(back).length) serverSettings.writeProperties(file, back);
    } catch {} finally { checking = false; }
  };
  fs.watchFile(file, { interval: 500 }, held.check);
}
async function releaseProps(dir) {
  const held = heldProps.get(keyOf(dir));
  if (!held || isRunning(dir)) return;
  heldProps.delete(keyOf(dir));
  fs.unwatchFile(held.file, held.check);
  await held.check();
}
const shop = market.createMarket({ readServer: serverOf, writeServer: (dir, desc) => writeJson(path.join(dir, SERVER), desc), fetchFile, running: isRunning });
// World backups and restores (main/minecraft/backups.js, whose header lists the API). Other main code reaches it here.
const backups = createBackups({ readServer: (dir) => readJson(path.join(dir, SERVER)), writeServer: (dir, desc) => writeJson(path.join(dir, SERVER), desc),
  readProps: serverSettings.readProperties, writeProps: serverSettings.writeProperties, isRunning, leftOver, appVersion: () => app.getVersion() });
exports.backups = backups;

// A saved private server's key, encrypted as a data source's password is, but with no plain fallback: without safeStorage
// it stays in memory and the friend pastes the code again.
const keyring = {
  seal: (key) => (safeStorage.isEncryptionAvailable() ? { enc: 'safeStorage', data: safeStorage.encryptString(key).toString('base64') } : null),
  open: (sealed) => { try { return safeStorage.decryptString(Buffer.from(sealed.data, 'base64')); } catch { return null; } },
};
const craft = createLauncher({ fetchFile, ensureJava, javaFor, run, retried, keyring });

const imports = (root) => createImports({ root, servers: () => servers(root), create, unfinished, javaFor, javaOfJar, fetchFile,
  writeServer: (dir, desc) => writeJson(path.join(dir, SERVER), desc), readServer: (dir) => readJson(path.join(dir, SERVER)) });

exports.register = ({ ipcMain, send, startProcess, procs, diagnostics, getWindow, quitAhead, killProcess, windows }) => {
  const guard = (root) => { if (!root || !trust.isTrusted(root)) throw fail('The project is open in Safe Mode, where Nano Studio runs nothing from it', 'untrusted'); };
  // Sessions live here and not in a window, so logging goes on while no window shows the tab. A folder under the
  // project's servers/ only: the files read for it are named by the renderer.
  const playersLog = diagnostics.logger('#players');
  const players = createPlayers({
    send,
    log: (text) => playersLog.warn(text),
    describe: (dir) => {
      const { mc, kind } = serverOf(dir);
      return { version: mc, kind, proxy: !!KINDS[kind]?.proxy };
    },
  });
  const inServers = (root, dir) => typeof dir === 'string' && path.resolve(dir).toLowerCase().startsWith(path.resolve(root, 'servers').toLowerCase() + path.sep);
  const ofProject = (root, dir) => { if (!root || !inServers(root, dir)) throw fail(`${dir} is not a server of this project`); };
  // What writes a server's settings and packs: a trusted project's, under its servers/. A run configuration may name a
  // server folder elsewhere, so a launch is not held to it.
  const playersAt = (root, dir) => {
    guard(root);
    ofProject(root, dir);
  };
  const playersChannel = (name, step) => ipcMain.handle(`players:${name}`, (_e, root, dir, ...args) => { playersAt(root, dir); return step(dir, ...args); });
  playersChannel('list', (dir) => players.list(dir));
  playersChannel('timeline', (dir, uuid, opts) => players.timeline(dir, uuid, opts));
  playersChannel('search', (dir, opts) => players.search(dir, opts));
  playersChannel('detail', (dir, uuid) => players.detail(dir, uuid));
  playersChannel('action', (dir, action) => players.action(dir, action));
  playersChannel('items', (dir, query) => players.items(dir, query));
  playersChannel('icons', (dir, ids) => players.icons(dir, ids));
  playersChannel('names', (dir) => players.names(dir));
  playersChannel('adminLog', (dir, opts) => players.adminLog(dir, opts));
  playersChannel('watch', (dir, on) => players.watch(dir, on));
  playersChannel('bridge', (dir) => players.bridgeStatus(dir));
  playersChannel('bridgeInstall', (dir) => players.bridgeInstall(dir));
  playersChannel('bridgeRemove', (dir) => players.bridgeRemove(dir));
  ipcMain.handle('players:bridgeServers', (_e, root) => {
    guard(root);
    return servers(root).map((s) => ({ name: s.name, dir: s.dir, kind: s.kind, mc: s.mc, ...players.bridgeStatus(s.dir) }));
  });
  app.on('will-quit', players.closeAll);
  backups.connect({ send, trash: (file) => require('electron').shell.trashItem(file) });
  registerBackupIpc(ipcMain, backups, playersAt);
  app.on('will-quit', backups.shutdown);
  const healthLog = diagnostics.logger('#minecraft');
  health = createHealthMonitor({
    send, readServer: serverOf, writeServer: (dir, desc) => writeJson(path.join(dir, SERVER), desc), log: (text) => healthLog.warn(text),
    // What an overload's suggestions start from: the distances as the server reads them, and Paper's anti-xray level.
    describe: (dir) => {
      const p = propsOf(dir);
      let antiXray = null;
      try { antiXray = xray.status(dir, xrayView(serverOf(dir))).level ?? null; } catch {}
      return { view: p['view-distance'] ?? 10, sim: p['simulation-distance'] ?? 10, antiXray };
    },
  });
  app.on('before-quit', () => health.quitting());
  ipcMain.handle('minecraft:healthOf', (_e, root, dir) => { ofProject(root, dir); return health.of(dir); });
  ipcMain.handle('minecraft:setHealth', (_e, root, dir, patch) => { playersAt(root, dir); return health.setSettings(dir, patch); });
  ipcMain.handle('minecraft:dismissHealth', (_e, root, dir) => { ofProject(root, dir); health.dismiss(dir); return true; });
  // A job's output goes to the window as minecraft:log {job, text}.
  const logTo = (job) => (text) => send('minecraft:log', { job, text: String(text) });
  // A job that knows its size says how far it is: minecraft:progress {job, done, total}.
  const progressTo = (job) => ({ done, total }) => send('minecraft:progress', { job, done, total });
  ipcMain.handle('minecraft:kinds', () => Object.entries(KINDS).map(([id, k]) => ({ id, title: k.title, plugins: k.plugins, mods: k.mods, proxy: !!k.proxy })));
  ipcMain.handle('minecraft:versions', (_e, kind) => KINDS[kind]?.versions() ?? []);
  // leftOver: {pid, started} of a process still running there that this app does not hold (see run-marker.js).
  ipcMain.handle('minecraft:servers', async (_e, root) => {
    if (!root) return [];
    const list = servers(root);
    const left = await Promise.all(list.map((s) => leftOver(s.dir).catch(() => null)));
    return list.map((s, i) => ({ ...s, ...(left[i] && { leftOver: left[i] }), health: health.of(s.dir) }));
  });
  // Ends a left-over process without saving: the window asks the user first.
  ipcMain.handle('minecraft:endLeftOver', async (_e, root, dir) => {
    playersAt(root, dir);
    if (!(await leftOver(dir))) return { ended: true };
    return { ended: await runMarker.end(dir) };
  });
  ipcMain.handle('minecraft:create', (_e, opts, job) => { guard(opts?.root); return create(opts, logTo(job)); });
  // A level waiting in pyide-server.json goes in once the server's files exist: before a start, where that start reads
  // it, and after a run, because a server's first run writes the files and only reads them at its next start (restart).
  const settleXray = (dir, restart) => {
    try {
      const desc = readJson(path.join(dir, SERVER));
      if (!desc?.antiXrayPending) return;
      const r = xray.settle(dir, xrayView(desc));
      if (r.clear) {
        delete desc.antiXrayPending;
        writeJson(path.join(dir, SERVER), desc);
      }
      if (r.outcome === 'applied' || r.outcome === 'refused') send('minecraft:antiXray', { dir, restart, ...r });
    } catch (err) { playersLog.warn(`anti-xray: ${err.message}`); }
  };
  ipcMain.handle('minecraft:launch', async (_e, root, dir, job) => {
    guard(root);
    await refuseLeftOver(dir);
    settleXray(dir, false);
    return launch(dir, logTo(job));
  });
  // Starts a launch spec ({cmd, args, cwd}) as an IDE process the Run window shows; -> process id. A process outside
  // the project's servers/ gets no players session. When the app quits, the server is asked to save and stop as Stop
  // does ("end" for a Velocity proxy) and given a big modpack's minute to do it before it is killed.
  // One process a folder: a second would open the same world. A Rerun's old process has closed by the time its new one
  // gets here (the window waits for it).
  const claimed = new Set(); // folders (lower case) between the checks below and the spawn
  ipcMain.handle('minecraft:start', async (_e, root, spec) => {
    guard(root);
    const k = keyOf(spec.cwd);
    if (isRunning(spec.cwd) || claimed.has(k)) throw fail(`${path.basename(spec.cwd)} is running already`, 'running');
    claimed.add(k);
    try { await refuseLeftOver(spec.cwd); await backups.beforeStart(spec.cwd); } finally { claimed.delete(k); }
    if (isRunning(spec.cwd)) throw fail(`${path.basename(spec.cwd)} is running already`, 'running');
    const session = inServers(root, spec.cwd) ? players.begin(spec.cwd) : null;
    let proxy = false;
    let desc = null;
    try { desc = serverOf(spec.cwd); proxy = !!KINDS[desc.kind]?.proxy; } catch {}
    if (desc) health.prepare(spec.cwd);
    const id = startProcess(spec.cmd, spec.args, { cwd: spec.cwd, windowsHide: true, filter: session?.filter, quitInput: proxy ? 'end\n' : 'stop\n', quitWaitMs: 60000 });
    const proc = procs.get(id);
    markStops(proc);
    session?.attach(proc);
    if (session && !proxy && proc) backups.attach(spec.cwd, proc);
    if (proc) {
      runningDirs.set(k, (runningDirs.get(k) || 0) + 1);
      if (proc.pid) {
        ownPids.add(proc.pid);
        runMarker.write(spec.cwd, proc.pid);
      }
      proc.once('close', () => {
        if (runningDirs.get(k) > 1) runningDirs.set(k, runningDirs.get(k) - 1); else runningDirs.delete(k);
        ownPids.delete(proc.pid);
        runMarker.clear(spec.cwd, proc.pid);
        releaseProps(spec.cwd);
      });
    }
    if (session) proc?.once('close', () => settleXray(spec.cwd, true));
    if (proc && desc) {
      // The port it binds and the address it binds it on: a server-ip of this PC's network answers there, not on loopback.
      const ip = proxy ? '' : propsOf(spec.cwd)['server-ip'] || '';
      const host = /^[\d.]+$/.test(ip) && ip !== '0.0.0.0' ? ip : '127.0.0.1';
      health.watch(proc, { dir: spec.cwd, kind: desc.kind, memory: /^\d+[MG]$/i.test(desc.memory || '') ? desc.memory : '2G', java: desc.java,
        port: Number.isInteger(spec.port) ? spec.port : portOf(spec.cwd, desc.kind), host, paper: KINDS[desc.kind]?.plugins === 'paper',
        query: session && ((command, match, ms) => session.query(command, match, ms)) });
    }
    return id;
  });
  // Whether nothing listens on a port (a server about to start there would fail to bind it).
  // A server may hold it on loopback only, which a listen on every address does not notice.
  const listenable = (port, host) => new Promise((resolve) => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(false));
    try { probe.listen(port, ...(host ? [host] : []), () => probe.close(() => resolve(true))); } catch { resolve(false); }
  });
  ipcMain.handle('minecraft:portFree', async (_e, port) => (await listenable(port, '127.0.0.1')) && listenable(port));
  ipcMain.handle('minecraft:wireProxy', (_e, root, dir) => { playersAt(root, dir); return wireProxy(root, dir); });
  ipcMain.handle('minecraft:clientPack', (_e, root, dir) => { playersAt(root, dir); return clientPack(dir); });
  ipcMain.handle('minecraft:rewireProxies', (_e, root) => { guard(root); return rewireProxies(root); });
  ipcMain.handle('minecraft:blockedNames', (_e, root) => (root ? blockedNames(root) : []));
  ipcMain.handle('minecraft:damagedServers', (_e, root) => (root ? damagedServers(root) : []));
  // A damaged pyide-server.json (unreadable, or naming a server type Nano Studio does not know) put right: from the copy
  // written last (.bak), else described again from what the folder runs. The damaged file stays beside it, .damaged.
  ipcMain.handle('minecraft:repairServer', async (_e, root, dir) => {
    playersAt(root, dir);
    const file = path.join(dir, SERVER);
    const from = repairSource(dir);
    if (!from) throw fail(`Nano Studio cannot tell from its files what ${path.basename(dir)} runs: fix pyide-server.json by hand`, 'notRepairable');
    if (isFile(file)) fs.copyFileSync(file, `${file}.damaged`);
    if (from === 'backup') writeJson(file, readJson(`${file}.bak`));
    else await imports(root).redescribe(dir);
    return { from };
  });
  // A dedicated server that runs a command changing a setting (whitelist on) saves server.properties as it read it at
  // its start, losing what was saved since. The window awaits this before it sends the command: the file is read now,
  // and once the server has written its copy (within `wait` ms) the file goes back to what it was.
  ipcMain.handle('minecraft:keepProperties', (_e, root, dir, wait = 15000) => {
    playersAt(root, dir);
    const file = path.join(dir, 'server.properties');
    const kept = fs.readFileSync(file);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (const end = Date.now() + Math.min(Number(wait) || 0, 60000); Date.now() < end;) {
        await pause(100);
        let now;
        try { now = fs.readFileSync(file); } catch { continue; }
        if (now.equals(kept)) continue;
        // A moment for the server to finish writing its copy, which is then replaced whole.
        await pause(300);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, kept);
        // A virus scanner may still have the file just written open for a moment.
        for (let i = 0; ; i++) {
          try { fs.renameSync(tmp, file); return; } catch (err) { if (i === 10) { fs.rmSync(tmp, { force: true }); throw err; } await pause(200); }
        }
      }
    })().catch((err) => playersLog.warn(`server.properties of ${dir} was not put back: ${err.message}`));
    return true;
  });
  ipcMain.handle('minecraft:settings', (_e, root, dir) => { ofProject(root, dir); return settings(dir); });
  // A new port is written into the proxies that send players to the server.
  ipcMain.handle('minecraft:saveSettings', (_e, root, dir, values) => {
    playersAt(root, dir);
    const running = isRunning(dir) && values?.props && !KINDS[serverOf(dir).kind]?.proxy;
    const before = running ? propsOf(dir) : null;
    const r = saveSettings(dir, values);
    if (running && !r.antiXrayRefused) {
      const after = propsOf(dir);
      holdProps(dir, before, Object.fromEntries(Object.keys(values.props).map((key) => [key, after[key]])));
    }
    if (values?.props?.['server-port'] !== undefined) rewireProxies(root);
    return r;
  });
  ipcMain.handle('minecraft:antiXrayServers', (_e, root, except) => { guard(root); return xrayServers(root, except); });
  ipcMain.handle('minecraft:antiXrayApply', (_e, root, dirs, level) => {
    guard(root);
    if (!Array.isArray(dirs) || !dirs.every((d) => inServers(root, d))) throw fail('Those are not servers of this project');
    return applyXray(dirs, level);
  });
  ipcMain.handle('minecraft:player', (_e, name, online) => serverSettings.player(name, online, mojangProfile));
  ipcMain.handle('minecraft:langStatus', (_e, root, dir) => { ofProject(root, dir); return langStatus(dir); });
  // A translation or a launcher job runs until it ends or minecraft:cancel names its job.
  const running = new Map(); // job -> AbortController
  const cancellable = async (job, step) => {
    const ctl = new AbortController();
    running.set(job, ctl);
    try {
      return await step(Object.assign(logTo(job), { signal: ctl.signal }));
    } catch (err) {
      throw ctl.signal.aborted ? fail('Cancelled', 'cancelled') : err;
    } finally { running.delete(job); }
  };
  ipcMain.handle('minecraft:translateMods', async (_e, root, dir, job) => {
    playersAt(root, dir);
    const ctl = new AbortController();
    running.set(job, ctl);
    try { return await translateMods(dir, logTo(job), ctl.signal, progressTo(job)); } finally { running.delete(job); }
  });
  ipcMain.handle('minecraft:cancel', (_e, job) => { running.get(job)?.abort(); return true; });
  ipcMain.handle('minecraft:newResourcePack', (_e, root, dir) => { playersAt(root, dir); return newResourcePack(dir); });
  ipcMain.handle('minecraft:packResourcePack', (_e, root, dir) => { playersAt(root, dir); return packResourcePack(dir); });
  // Files and folders dropped on the window or on a server's card -> {done, skipped, modpacks}.
  ipcMain.handle('minecraft:drop', (_e, root, serverDir, paths, job) => { guard(root); if (serverDir) ofProject(root, serverDir); return imports(root).drop(serverDir, paths, logTo(job)); });
  // A modpack's contents before it becomes a server: a .mrpack file, or a Modrinth address downloaded first.
  ipcMain.handle('minecraft:modpackInfo', async (_e, root, { file, url }, job) => {
    guard(root);
    const im = imports(root);
    const info = im.modpackInfo(file || await im.fromModrinth(url, logTo(job)));
    delete info.index;
    return info;
  });
  ipcMain.handle('minecraft:discardModpack', (_e, file) => { discardDownload(file); return true; });
  ipcMain.handle('minecraft:createFromModpack', (_e, opts, job) => { guard(opts?.root); return imports(opts.root).createFromModpack(opts, logTo(job)); });
  // The Market (Modrinth): a search for a type of project ({type, query, sort, offset, serverDir | loader, mc}), and a
  // project installed on, or removed from, a server.
  ipcMain.handle('minecraft:marketSearch', (_e, opts) => market.search({ ...opts, server: opts.serverDir ? serverOf(opts.serverDir) : null }));
  ipcMain.handle('minecraft:marketInstall', (_e, root, dir, project, job) => { guard(root); return shop.install(dir, project, logTo(job)); });
  ipcMain.handle('minecraft:marketRemove', (_e, root, dir, id) => { guard(root); return shop.remove(dir, id); });
  ipcMain.handle('minecraft:applyResourcePack', (_e, root, dir, url, sha1) => { playersAt(root, dir); return applyResourcePack(dir, url, sha1); });
  ipcMain.handle('minecraft:serveFolder', (_e, root, folder) => { guard(root); return fileServer.serve(folder); });

  // Instances played through the official Minecraft Launcher (main/minecraft/launcher.js).
  ipcMain.handle('launcher:status', (_e, root) => craft.status(root));
  ipcMain.handle('launcher:instances', (_e, root) => (root ? craft.instances(root) : []));
  ipcMain.handle('launcher:versions', (_e, kind) => craft.versions(kind));
  ipcMain.handle('launcher:loaderVersions', (_e, kind, mc) => craft.loaderVersions(kind, mc));
  ipcMain.handle('launcher:create', (_e, root, opts, job) => { guard(root); return cancellable(job, (log) => craft.create(root, opts, log)); });
  ipcMain.handle('launcher:fromPack', (_e, root, opts, job) => { guard(root); return cancellable(job, (log) => craft.fromPack(root, opts, log)); });
  ipcMain.handle('launcher:remove', (_e, root, name) => { guard(root); return craft.remove(root, name); });
  ipcMain.handle('launcher:servers', (_e, root) => (root ? craft.servers(root) : []));
  ipcMain.handle('launcher:saveServers', (_e, root, list) => { guard(root); return craft.saveServers(root, list); });
  ipcMain.handle('launcher:join', (_e, root, req, job) => { guard(root); return cancellable(job, (log) => craft.join(root, req, log)); });
  ipcMain.handle('launcher:play', (_e, root, name, opts, job) => { guard(root); return cancellable(job, (log) => craft.play(root, name, opts, log)); });
  ipcMain.handle('launcher:ping', (_e, address) => craft.ping(address));
  ipcMain.handle('launcher:mods', (_e, root, name) => craft.mods(root, name));
  ipcMain.handle('launcher:setMemory', (_e, root, name, memory) => { guard(root); return craft.setMemory(root, name, memory); });
  ipcMain.handle('launcher:setMod', (_e, root, name, file, enabled) => { guard(root); return craft.setMod(root, name, file, enabled); });
  // An instance's mods into Korean, as minecraft:langStatus and minecraft:translateMods do a server's.
  ipcMain.handle('launcher:langStatus', (_e, root, name) => { guard(root); return craft.koreanStatus(root, name); });
  ipcMain.handle('launcher:translateMods', (_e, root, name, job) => { guard(root); return cancellable(job, (log) => craft.translateKorean(root, name, { translate: askClaude, log, signal: log.signal, progress: progressTo(job) })); });
  ipcMain.handle('launcher:joinCode', (_e, server) => craft.joinCode(server));
  ipcMain.handle('launcher:parseJoinCode', (_e, text) => craft.parseJoinCode(text));
  // The join code of this server's private share, on request: ports:state never carries its key, and the window holds the
  // code only to copy it.
  // A running server is shared at the port it started with (options.port), which a saved server-port does not change.
  ipcMain.handle('minecraft:privateCode', (_e, root, dir, options) => {
    playersAt(root, dir);
    const port = Number.isInteger(options?.port) ? options.port : portOf(dir, serverOf(dir).kind);
    const share = privateShare(port);
    if (!share) throw fail('This server is not shared privately', 'notShared');
    return craft.joinCode({ ...share, pack: options?.pack, name: path.basename(dir) });
  });
  app.on('will-quit', craft.stopJoins);

  // Windows ending the session (shut down, restart, sign out) quits the app without before-quit or will-quit, so the
  // quit gate would never send "stop", and a server's java.exe gets a few seconds once the session does end. While a
  // server runs, the session is held (Windows lists the app as keeping it open) and the servers get "stop" as at a
  // quit; the app quits once they have stopped, and Windows goes on. One that does not stop in the gate's time is killed.
  const sessionLog = diagnostics.logger('#minecraft');
  let sessionEnding = false;
  getWindow?.()?.on('query-session-end', (e) => {
    if (!runningDirs.size || !quitAhead) return;
    e.preventDefault();
    if (sessionEnding) return;
    sessionEnding = true;
    sessionLog.warn(`Windows is ending the session (${(e.reasons || []).join(', ')}): stopping ${runningDirs.size} server(s) before the app quits`);
    windows?.closeWithoutAsking(true);
    quitAhead(() => { app.quit(); return true; }).then((late) => {
      if (!late) return;
      for (const id of procs.keys()) killProcess?.(id, { sync: true });
      app.quit();
    });
  });
};
