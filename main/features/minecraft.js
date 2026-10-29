// Main side of the minecraft plugin: Minecraft servers in a project (servers/<name>, described by pyide-server.json),
// plugin projects (plugins/<name>, pyide-plugin.json) and mod projects (mods/<name>, pyide-mod.json), the Java each
// needs, the client pack (.mrpack) players import to get a modded server's mods, the resource pack a server sends
// players when they join, and a Velocity proxy's wiring to the project's Paper servers. Downloads are checked against
// the checksum their source publishes; Java comes from this computer's JDKs or, when the version a server needs is
// missing, from Adoptium's Temurin into ~/.pyide/java. Nothing runs for a project the user has not trusted.
// PYIDE_MC_JAVA (tests): a Java home used for every version.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const trust = require('../trust');
const { download, tarExe } = require('../installer/servers');
const { createToolchains, installRoot } = require('../installer/toolchains');
const { KINDS, javaFor, temurin, HEADERS } = require('../minecraft/sources');
const { writeZip, readEntry } = require('../minecraft/zipfile');
const T = require('../minecraft/templates');
const { createImports, discardDownload } = require('../minecraft/imports');
const market = require('../minecraft/market');

const SERVER = 'pyide-server.json';
const PLUGIN = 'pyide-plugin.json';
const MOD = 'pyide-mod.json';
const NAME = /^[A-Za-z][\w-]{0,39}$/;
const MOD_ID = /^[a-z][a-z0-9_]{1,63}$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const run = (cmd, args, opts, log) => new Promise((resolve, reject) => {
  const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 64 << 20, ...opts }, (err) => (err ? reject(fail(`${path.basename(cmd)} failed (exit ${err.code ?? err.signal})`)) : resolve()));
  child.stdout?.on('data', (d) => log(d.toString()));
  child.stderr?.on('data', (d) => log(d.toString()));
});
const filesUnder = (dir, test) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (test(e.name)) out.push(p); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};
const jarsUnder = (dir) => filesUnder(dir, (n) => n.endsWith('.jar'));
const hashOf = (algo, file) => crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
const portOf = (dir) => Number(/^server-port=(\d+)/m.exec(fs.existsSync(path.join(dir, 'server.properties')) ? fs.readFileSync(path.join(dir, 'server.properties'), 'utf8') : '')?.[1]) || 25565;

// Mojang's and the Maven hosts' downloads break off now and then (a reset connection mid-file): a step that fetches
// over the network is tried three times, a few seconds apart. A checksum mismatch is not retried.
async function retried(what, step, log) {
  for (let attempt = 1; ; attempt++) {
    try { return await step(); } catch (err) {
      if (attempt === 3 || /Checksum mismatch|HTTP 404/.test(err.message)) throw err;
      log(`${what} failed (${err.message}); trying again (${attempt + 1} of 3)…\n`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
const fetchFile = (url, dest, opts, log) => retried('The download', () => download(url, dest, { progress: () => {}, log, ...opts }), log);
const majorOf = (v) => { const m = /^1\.(\d+)|^(\d+)/.exec(v || ''); return m ? Number(m[1] || m[2]) : 0; };

// ---------- Java ----------
const javaRoot = () => path.join(installRoot(), 'java');
// A Java home of exactly `major` (a JDK when jdk is set): this computer's JDKs, then a Temurin downloaded before.
async function findJava(major, jdk) {
  if (process.env.PYIDE_MC_JAVA) return process.env.PYIDE_MC_JAVA;
  const exe = (home) => isFile(path.join(home, 'bin', jdk ? 'javac.exe' : 'java.exe'));
  for (const t of await createToolchains().detect('jdk')) if (majorOf(t.version) === major && exe(t.home)) return t.home;
  for (const kind of jdk ? ['jdk'] : ['jre', 'jdk']) {
    const dir = path.join(javaRoot(), `temurin-${major}-${kind}`);
    const home = fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)).find(exe) : null;
    if (home) return home;
  }
  return null;
}
async function ensureJava(major, { jdk = false, log }) {
  const found = await findJava(major, jdk);
  if (found) return found;
  const kind = jdk ? 'jdk' : 'jre';
  const t = await temurin(major, jdk);
  log(`Java ${major} is not installed; downloading Temurin ${kind.toUpperCase()} ${major} from Adoptium.\n`);
  fs.mkdirSync(javaRoot(), { recursive: true });
  const archive = path.join(javaRoot(), t.name);
  await fetchFile(t.url, archive, { sha256: t.sha256, size: t.size }, log);
  const dir = path.join(javaRoot(), `temurin-${major}-${kind}`);
  const staging = `${dir}.extract`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  await run(tarExe(), ['-xf', archive, '-C', staging], {}, log);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  fs.rmSync(archive, { force: true });
  return findJava(major, jdk);
}
// javac of any JDK at least `major` compiles for it (--release); else a JDK of that version is downloaded.
async function ensureJavac(major, log) {
  if (process.env.PYIDE_MC_JAVA) return process.env.PYIDE_MC_JAVA;
  const jdks = (await createToolchains().detect('jdk')).filter((t) => majorOf(t.version) >= major && isFile(path.join(t.home, 'bin', 'javac.exe')));
  return jdks.sort((a, b) => majorOf(a.version) - majorOf(b.version))[0]?.home || ensureJava(major, { jdk: true, log });
}

// ---------- servers ----------
// Folders of `parent` holding `file`, as [{...file's JSON, name, dir}].
const described = (parent, file) => (fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }) : [])
  .filter((d) => d.isDirectory()).map((d) => {
    const dir = path.join(parent, d.name);
    const meta = readJson(path.join(dir, file));
    return meta && { ...meta, name: d.name, dir };
  }).filter(Boolean);
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The project's servers, each with what its kind runs and the plugin and mod projects that deploy to it.
function servers(root) {
  const projects = [...described(path.join(root, 'plugins'), PLUGIN).map((p) => ({ ...p, type: 'plugin' })),
    ...described(path.join(root, 'mods'), MOD).map((p) => ({ ...p, type: 'mod' }))];
  return described(path.join(root, 'servers'), SERVER).map((s) => ({
    ...s, plugins: KINDS[s.kind]?.plugins || null, mods: KINDS[s.kind]?.mods || null, proxy: !!KINDS[s.kind]?.proxy, port: portOf(s.dir),
    resourcePack: fs.existsSync(path.join(s.dir, 'resourcepack', 'pack.mcmeta')),
    projects: projects.filter((p) => sameDir(path.resolve(p.dir, p.server), s.dir)).map(({ type, name, dir }) => ({ type, name, dir })),
  }));
}
const serverOf = (dir) => {
  const desc = readJson(path.join(dir, SERVER));
  if (!desc) throw fail(`${dir} is not a PyIDE Minecraft server (no ${SERVER})`);
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

// loader: the exact mod loader version (a modpack's), else the recommended or newest.
async function create({ root, name, kind, mc, loader, memory = '2G', port = 25565, eula }, log) {
  const source = KINDS[kind];
  if (!source) throw fail(`Unknown server type ${kind}`);
  // A proxy runs no Minecraft server, so Mojang's EULA is not its to accept.
  if (!eula && !source.proxy) throw fail('The Minecraft EULA must be accepted to run a server');
  if (!NAME.test(name || '')) throw fail('Use letters, digits, - and _ for the name, starting with a letter');
  const dir = path.join(root, 'servers', name);
  if (fs.existsSync(dir)) throw fail(`${path.relative(root, dir)} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    log(`${source.title} ${mc}\n`);
    const r = await source.resolve(mc, loader);
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
      fs.writeFileSync(path.join(dir, 'velocity.toml'), T.velocityToml(Number(port) || 25565, []));
      fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${Number(port) || 25565}\n`);
    } else {
      // The user agreed in the New Server dialog, which links the EULA; the date says when.
      fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted in PyIDE on ${new Date().toISOString()}: https://aka.ms/MinecraftEULA\neula=true\n`);
      if (!fs.existsSync(path.join(dir, 'server.properties'))) fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${Number(port) || 25565}\nmotd=${name}\n`);
    }
    for (const sub of source.plugins ? ['plugins'] : source.mods ? ['mods'] : []) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const desc = { kind, mc, loader: r.loader || null, build: r.build || null, java, memory, launch, mdk: r.mdk || null };
    writeJson(path.join(dir, SERVER), desc);
    log(`Created ${path.relative(root, dir)}\n`);
    return { name, dir, ...desc };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// opts.debugPort: the JVM also listens for the debugger there, suspended until the debugger has set its breakpoints
// (a plugin's onEnable runs within moments of the start).
async function launch(dir, log, { debugPort } = {}) {
  const desc = serverOf(dir);
  const home = await ensureJava(desc.java, { log });
  const mem = /^\d+[MG]$/i.test(desc.memory || '') ? desc.memory : '2G';
  const args = [`-Xmx${mem}`];
  if (debugPort) args.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${debugPort}`);
  if (desc.launch.argsFile) {
    if (isFile(path.join(dir, 'user_jvm_args.txt'))) args.push('@user_jvm_args.txt');
    args.push(`@${desc.launch.argsFile}`);
  } else args.push('-jar', desc.launch.jar);
  if (!KINDS[desc.kind]?.proxy) args.push('nogui');
  return { cmd: path.join(home, 'bin', 'java.exe'), args, cwd: dir, java: desc.java };
}

// The source folders of the plugin and mod projects that deploy to a server, for the debugger to find .java files in.
function sourceRoots(root, dir) {
  const srv = servers(root).find((s) => sameDir(s.dir, dir));
  return (srv?.projects || []).flatMap((p) => ['main', 'client'].map((set) => path.join(p.dir, 'src', set, 'java'))).filter((d) => fs.existsSync(d));
}

// ---------- Velocity ----------
// The proxy sends players to every Paper or Purpur server of the project: its [servers] table lists them, and each of
// them takes modern forwarding with the proxy's secret. Runs before each start of the proxy.
function wireProxy(root, dir) {
  const desc = serverOf(dir);
  if (!KINDS[desc.kind]?.proxy) return { backends: [] };
  const backends = servers(root).filter((s) => s.plugins === 'paper').map((s) => ({ name: s.name, port: s.port, dir: s.dir }));
  const toml = path.join(dir, 'velocity.toml');
  fs.writeFileSync(toml, T.setVelocityServers(fs.existsSync(toml) ? fs.readFileSync(toml, 'utf8') : T.velocityToml(portOf(dir), []), backends));
  const secret = fs.readFileSync(path.join(dir, 'forwarding.secret'), 'utf8').trim();
  for (const b of backends) T.setPaperVelocity(b.dir, secret);
  return { backends: backends.map(({ name, port }) => ({ name, port })) };
}

// ---------- plugins ----------
// What a plugin compiles against: the server's API (the jars Paper unpacks into libraries/ and versions/ at its first
// start; Velocity's own jar holds its API) and the plugin's libs/.
function pluginClasspath(pluginDir, serverDir, api) {
  const server = api === 'velocity' ? [path.join(serverDir, 'server.jar')].filter(isFile)
    : [...jarsUnder(path.join(serverDir, 'libraries')), ...jarsUnder(path.join(serverDir, 'versions'))];
  return { server, all: [...server, ...jarsUnder(path.join(pluginDir, 'libs'))] };
}
function pluginContext(pluginDir) {
  const meta = readJson(path.join(pluginDir, PLUGIN));
  if (!meta) throw fail(`No ${PLUGIN} in ${pluginDir}`);
  const serverDir = path.resolve(pluginDir, meta.server);
  const desc = readJson(path.join(serverDir, SERVER));
  if (!desc) throw fail(`The plugin's server ${serverDir} is gone`);
  return { meta, serverDir, desc, api: KINDS[desc.kind]?.plugins || 'paper' };
}
// The Eclipse files that give the editor the plugin's classpath; written again whenever that may have changed (the
// server's first start, a dependency added, a build).
function syncPlugin(pluginDir) {
  const { meta, serverDir, desc, api } = pluginContext(pluginDir);
  T.writeEclipseProject(pluginDir, { name: meta.name, java: desc.java, jars: pluginClasspath(pluginDir, serverDir, api).all });
}
function syncPlugins(root, serverDir) {
  for (const p of described(path.join(root, 'plugins'), PLUGIN)) {
    if (!serverDir || sameDir(path.resolve(p.dir, p.server), serverDir)) { try { syncPlugin(p.dir); } catch {} }
  }
}

function newPlugin({ root, name, pkg, server }) {
  if (!/^[A-Z][A-Za-z0-9]{0,39}$/.test(name || '')) throw fail('Use a class-style name: a capital letter, then letters and digits');
  if (!PACKAGE.test(pkg || '')) throw fail('Use a Java package such as com.example.myplugin');
  const srv = servers(root).find((s) => s.name === server && s.plugins);
  if (!srv) throw fail('Choose a Paper, Purpur or Velocity server for the plugin');
  const dir = path.join(root, 'plugins', name);
  if (fs.existsSync(dir)) throw fail(`${path.relative(root, dir)} already exists`);
  const main = T.writePlugin(dir, { api: srv.plugins, pkg, name, mc: srv.mc });
  writeJson(path.join(dir, PLUGIN), { name, server: path.relative(dir, srv.dir).replace(/\\/g, '/') });
  syncPlugin(dir);
  return { dir, main };
}

// javac against the server's API and libs/, then a jar (the plugin's classes and resources; libs/ are other plugins'
// APIs, present on the server at run time) into the server's plugins folder.
async function buildPlugin(dir, log) {
  const { meta, serverDir, desc, api } = pluginContext(dir);
  const cp = pluginClasspath(dir, serverDir, api);
  if (!cp.server.length) throw fail('Start the server once first: Paper unpacks the libraries a plugin compiles against at its first start', 'notStarted');
  syncPlugin(dir);
  const sources = filesUnder(path.join(dir, 'src', 'main', 'java'), (n) => n.endsWith('.java'));
  const home = await ensureJavac(desc.java, log);
  const build = path.join(dir, 'build');
  const classes = path.join(build, 'classes');
  fs.rmSync(classes, { recursive: true, force: true });
  fs.mkdirSync(classes, { recursive: true });
  const argfile = path.join(build, 'javac-args.txt');
  const q = (s) => `"${s.replace(/\\/g, '/')}"`;
  fs.writeFileSync(argfile, [`--release ${desc.java}`, '-encoding UTF-8', '-proc:none', '-g', `-d ${q(classes)}`, `-cp ${q(cp.all.join(path.delimiter))}`, ...sources.map(q)].join('\n'));
  log(`javac --release ${desc.java} (${sources.length} file${sources.length === 1 ? '' : 's'})\n`);
  await run(path.join(home, 'bin', 'javac.exe'), [`@${argfile}`], { cwd: dir }, log);
  const jar = path.join(build, `${meta.name}.jar`);
  fs.rmSync(jar, { force: true });
  await run(path.join(home, 'bin', 'jar.exe'), ['--create', '--file', jar, '-C', classes, '.', '-C', path.join(dir, 'src', 'main', 'resources'), '.'], { cwd: dir }, log);
  const deployed = path.join(serverDir, 'plugins', `${meta.name}.jar`);
  fs.mkdirSync(path.dirname(deployed), { recursive: true });
  fs.copyFileSync(jar, deployed);
  log(`Copied to ${deployed}\n`);
  return { jar, deployed, server: serverDir };
}

// A library from a Maven repository into the plugin's libs/ (compile only: the plugin that provides it is installed
// on the server), and, when `depend` names that plugin, into plugin.yml's depend list (velocity-plugin.json's
// dependencies) so the server loads it first.
const REPOS = {
  central: 'https://repo.maven.apache.org/maven2',
  papermc: 'https://repo.papermc.io/repository/maven-public',
  jitpack: 'https://jitpack.io',
  codemc: 'https://repo.codemc.io/repository/maven-public',
};
async function addDependency({ dir, coords, repo, depend }, log) {
  const [group, artifact, version] = (coords || '').trim().split(':');
  if (!group || !artifact || !version) throw fail('Write the library as group:artifact:version, e.g. net.luckperms:api:5.4');
  const base = (REPOS[repo] || repo || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) throw fail('Choose a repository, or give its https address');
  const url = `${base}/${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
  const file = path.join(dir, 'libs', `${artifact}-${version}.jar`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Maven repositories publish each file's SHA-1 next to it.
  const sha1 = await fetch(`${url}.sha1`, { headers: HEADERS }).then((r) => (r.ok ? r.text() : '')).then((t) => t.trim().split(/\s/)[0], () => '');
  await fetchFile(url, file, {}, log);
  if (/^[0-9a-f]{40}$/.test(sha1) && hashOf('sha1', file) !== sha1) { fs.rmSync(file, { force: true }); throw fail(`Checksum mismatch for ${artifact}-${version}.jar`); }
  if (depend) {
    const { api } = pluginContext(dir);
    if (api === 'velocity') {
      const jsonFile = path.join(dir, 'src', 'main', 'resources', 'velocity-plugin.json');
      const json = readJson(jsonFile) || {};
      json.dependencies = [...(json.dependencies || []).filter((d) => d.id !== depend.toLowerCase()), { id: depend.toLowerCase(), optional: false }];
      writeJson(jsonFile, json);
    } else T.addToYamlList(path.join(dir, 'src', 'main', 'resources', 'plugin.yml'), 'depend', depend);
  }
  syncPlugin(dir);
  return { file };
}

// ---------- mods ----------
// The first of the server's MDK addresses that answers (NeoForge's newest versions may have none of their own yet).
async function fetchMdk(urls, zip, log) {
  let last;
  for (const url of urls) {
    try { await fetchFile(url, zip, {}, log); return url; } catch (err) { last = err; log(`${url}: ${err.message}\n`); }
  }
  throw last || fail('This server has no mod template');
}

async function newMod({ root, id, display, pkg, server }, log) {
  if (!MOD_ID.test(id || '')) throw fail('Use a mod id of lower-case letters, digits and _, starting with a letter (2-64 characters)');
  if (!PACKAGE.test(pkg || '')) throw fail('Use a Java package such as com.example.mymod');
  const srv = servers(root).find((s) => s.name === server && s.mods);
  if (!srv?.mdk) throw fail('Choose a Fabric, Forge or NeoForge server for the mod');
  const dir = path.join(root, 'mods', id);
  if (fs.existsSync(dir)) throw fail(`${path.relative(root, dir)} already exists`);
  const tmp = `${dir}.download`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const zip = path.join(tmp, 'mdk.zip');
    const used = await fetchMdk([].concat(srv.mdk), zip, log);
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    await run(tarExe(), ['-xf', zip, '-C', out], {}, log);
    // GitHub's archive has one top folder; Forge's MDK zip has none.
    const entries = fs.readdirSync(out);
    const top = entries.length === 1 && fs.statSync(path.join(out, entries[0])).isDirectory() ? path.join(out, entries[0]) : out;
    if (!isFile(path.join(top, 'gradlew.bat'))) throw fail('The mod template has no gradlew.bat');
    const cls = id.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    T.renameMod(top, srv.kind, { id, display: (display || '').trim() || cls, pkg, cls });
    // The template's loader version becomes the server's, so the mod asks for no newer loader than the server has.
    const props = path.join(top, 'gradle.properties');
    if (srv.kind === 'fabric' && srv.loader) T.setProperty(props, 'loader_version', srv.loader);
    if (srv.kind === 'neoforge') {
      T.setProperty(props, 'neo_version', srv.loader);
      T.setProperty(props, 'minecraft_version', srv.mc);
      T.setProperty(props, 'minecraft_version_range', `[${srv.mc}]`);
      if (!used.includes(`MDK-${srv.mc}-`)) log(`NeoForge has no template for ${srv.mc} yet; this one is for an older version, set to ${srv.mc} in gradle.properties. Its build may need changes.\n`);
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(top, dir);
    writeJson(path.join(dir, MOD), { name: id, server: path.relative(dir, srv.dir).replace(/\\/g, '/') });
    log(`Created ${path.relative(root, dir)}: mod id ${id}, package ${pkg}, class ${cls}\n`);
    return { dir, main: filesUnder(path.join(dir, 'src', 'main', 'java'), (n) => n === `${cls}.java`)[0] || null };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// gradlew with the JDK of the server's Java version (Forge's Gradle plugin refuses another).
// Debug of the test client: an init script makes runClient's JVM wait for the debugger on the port given (Fabric's
// Loom, ForgeGradle and NeoForge's ModDevGradle all run the game as a JavaExec task of that name), and pyideClasspath
// writes each source set's sources, class path and output, which HotSwap compiles a saved file against.
const HOTSWAP_DIR = 'build/pyide';
const INIT_SCRIPT = `// Written by PyIDE for Debug of the test client.
allprojects {
  def port = findProperty('pyide.debugPort')
  if (port) {
    tasks.withType(JavaExec).matching { it.name == 'runClient' }.configureEach {
      jvmArgs "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:\${port}"
    }
  }
  def out = findProperty('pyide.classpathFile')
  if (out) {
    tasks.register('pyideClasspath') {
      doLast {
        def sets = project.extensions.findByName('sourceSets')
        def data = (sets == null ? [] : sets.findAll { it.name != 'test' }).collect { s ->
          [name: s.name, sources: s.java.srcDirs*.absolutePath, classpath: s.compileClasspath.files*.absolutePath,
           output: s.java.destinationDirectory.get().asFile.absolutePath]
        }
        new File(project.rootDir, out).text = groovy.json.JsonOutput.toJson(data)
      }
    }
  }
}
`;

function modContext(dir) {
  const meta = readJson(path.join(dir, MOD));
  if (!meta) throw fail(`No ${MOD} in ${dir}`);
  const desc = readJson(path.join(path.resolve(dir, meta.server), SERVER));
  if (!desc) throw fail('The mod\'s server is gone');
  return { meta, desc };
}

// opts.debugPort: runClient waits for the debugger there.
async function modTask(dir, task, log, opts = {}) {
  const { desc } = modContext(dir);
  const home = await ensureJava(desc.java, { jdk: true, log });
  const debug = [];
  if (opts.debugPort) {
    fs.mkdirSync(path.join(dir, HOTSWAP_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, HOTSWAP_DIR, 'init.gradle'), INIT_SCRIPT);
    fs.rmSync(path.join(dir, HOTSWAP_DIR, 'classpath.json'), { force: true });
    debug.push('--no-configuration-cache', '-I', `${HOTSWAP_DIR}/init.gradle`, `-Ppyide.debugPort=${Number(opts.debugPort)}`,
      `-Ppyide.classpathFile=${HOTSWAP_DIR}/classpath.json`, 'pyideClasspath');
  }
  // .\ because cmd finds a program in the current folder only that way when NoDefaultCurrentDirectoryInExePath is set.
  return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', '.\\gradlew.bat', '--console=plain', ...debug, task], cwd: dir, env: { JAVA_HOME: home } };
}

// HotSwap: the saved .java files compiled with javac against their source set's class path (written when Debug
// started), the classes written over the source set's output (so a class the game has not loaded yet, or a restart,
// has them too) -> [{name, file}] for the debugger to redefine.
async function hotswapCompile(dir, files, log) {
  const { desc } = modContext(dir);
  const sets = readJson(path.join(dir, HOTSWAP_DIR, 'classpath.json'));
  if (!sets) throw fail('The test client was not started with Debug, or Gradle has not written its class path yet');
  const under = (file, d) => path.resolve(file).toLowerCase().startsWith(path.resolve(d).toLowerCase() + path.sep);
  const groups = new Map(); // source set -> files
  for (const f of files) {
    const set = sets.find((s) => s.sources.some((d) => under(f, d)));
    if (set) groups.set(set, [...(groups.get(set) || []), f]);
  }
  if (!groups.size) return [];
  const home = await ensureJavac(desc.java, log);
  const classes = [];
  for (const [set, list] of groups) {
    const tmp = fs.mkdtempSync(path.join(dir, HOTSWAP_DIR, 'javac-'));
    try {
      const outputs = sets.map((s) => s.output);
      const q = (s) => `"${s.replace(/\\/g, '/')}"`;
      const argfile = path.join(tmp, 'args.txt');
      fs.writeFileSync(argfile, [`--release ${desc.java}`, '-encoding UTF-8', '-proc:none', '-g', '-implicit:none', `-d ${q(path.join(tmp, 'out'))}`,
        `-cp ${q([...outputs, ...set.classpath].join(path.delimiter))}`, ...list.map(q)].join('\n'));
      await run(path.join(home, 'bin', 'javac.exe'), [`@${argfile}`], { cwd: dir }, log);
      for (const f of filesUnder(path.join(tmp, 'out'), (n) => n.endsWith('.class'))) {
        const rel = path.relative(path.join(tmp, 'out'), f);
        const dest = path.join(set.output, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f, dest);
        classes.push({ name: rel.replace(/\.class$/, '').split(path.sep).join('.'), file: dest });
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return classes;
}

// The built jar (not -sources, -dev, -slim or -javadoc) into the server's mods folder.
function deployMod(dir) {
  const meta = readJson(path.join(dir, MOD));
  if (!meta) throw fail(`No ${MOD} in ${dir}`);
  const libs = path.join(dir, 'build', 'libs');
  const jar = fs.existsSync(libs) && fs.readdirSync(libs).filter((n) => n.endsWith('.jar') && !/-(sources|dev|slim|javadoc)\.jar$/.test(n))
    .map((n) => path.join(libs, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!jar) throw fail('Build the mod first: build/libs has no jar', 'notBuilt');
  const serverDir = path.resolve(dir, meta.server);
  const deployed = path.join(serverDir, 'mods', path.basename(jar));
  fs.mkdirSync(path.dirname(deployed), { recursive: true });
  fs.copyFileSync(jar, deployed);
  return { jar, deployed, server: serverDir };
}

// ---------- client pack ----------
// A Modrinth modpack (.mrpack): modrinth.index.json naming Minecraft and the loader, and the server's mods as
// overrides. Prism Launcher, the Modrinth App and ATLauncher import one into a ready instance.
function clientPack(dir) {
  const desc = serverOf(dir);
  const loaderKey = KINDS[desc.kind]?.mods;
  if (!loaderKey) throw fail('Players of a server without mods need nothing but Minecraft itself');
  // A server made from a modpack hands players the modpack itself: it has the client mods the server leaves out.
  const pack = desc.modpack?.clientPack && path.join(dir, desc.modpack.clientPack);
  if (pack && isFile(pack)) return { file: pack, mods: [], modpack: desc.modpack.name, mc: desc.mc, loader: `${loaderKey} ${desc.loader}` };
  const name = path.basename(dir);
  const mods = fs.existsSync(path.join(dir, 'mods')) ? fs.readdirSync(path.join(dir, 'mods')).filter((n) => n.endsWith('.jar')) : [];
  const index = { formatVersion: 1, game: 'minecraft', versionId: new Date().toISOString().slice(0, 10), name, summary: `Mods of the ${name} server`,
    files: [], dependencies: { minecraft: desc.mc, [loaderKey]: desc.loader } };
  const outDir = path.join(dir, 'client-pack');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}-${desc.mc}.mrpack`);
  fs.writeFileSync(file, writeZip([{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2)) },
    ...mods.map((m) => ({ name: `overrides/mods/${m}`, data: fs.readFileSync(path.join(dir, 'mods', m)) }))]));
  return { file, mods, mc: desc.mc, loader: `${loaderKey} ${desc.loader}` };
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
function packResourcePack(dir) {
  const folder = path.join(dir, 'resourcepack');
  if (!fs.existsSync(path.join(folder, 'pack.mcmeta'))) throw fail('The server has no resource pack yet');
  const entries = filesUnder(folder, () => true).map((f) => ({ name: path.relative(folder, f).replace(/\\/g, '/'), data: fs.readFileSync(f) }));
  const outDir = path.join(dir, 'client-pack');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'resourcepack.zip');
  fs.writeFileSync(file, writeZip(entries));
  return { file, sha1: hashOf('sha1', file), files: entries.length };
}
// Players are sent the pack when they join: server.properties names its address and SHA-1, and requires it.
function applyResourcePack(dir, url, sha1) {
  const props = path.join(dir, 'server.properties');
  T.setProperty(props, 'resource-pack', url.replace(/[:=]/g, (c) => `\\${c}`));
  T.setProperty(props, 'resource-pack-sha1', sha1);
  T.setProperty(props, 'require-resource-pack', 'true');
  return { props };
}

const shop = market.createMarket({ readServer: serverOf, writeServer: (dir, desc) => writeJson(path.join(dir, SERVER), desc), fetchFile });

const imports = (root) => createImports({ root, servers: () => servers(root), create, javaFor, javaOfJar, fetchFile,
  writeServer: (dir, desc) => writeJson(path.join(dir, SERVER), desc), readServer: (dir) => readJson(path.join(dir, SERVER)) });

exports.register = ({ ipcMain, send, startProcess }) => {
  const guard = (root) => { if (!root || !trust.isTrusted(root)) throw fail('The project is open in Safe Mode, where PyIDE runs nothing from it', 'untrusted'); };
  // A job's output goes to the window as minecraft:log {job, text}.
  const logTo = (job) => (text) => send('minecraft:log', { job, text: String(text) });
  ipcMain.handle('minecraft:kinds', () => Object.entries(KINDS).map(([id, k]) => ({ id, title: k.title, plugins: k.plugins, mods: k.mods, proxy: !!k.proxy })));
  ipcMain.handle('minecraft:versions', (_e, kind) => KINDS[kind]?.versions() ?? []);
  ipcMain.handle('minecraft:servers', (_e, root) => (root ? servers(root) : []));
  ipcMain.handle('minecraft:create', (_e, opts, job) => { guard(opts?.root); return create(opts, logTo(job)); });
  ipcMain.handle('minecraft:launch', (_e, root, dir, job, opts) => { guard(root); return launch(dir, logTo(job), opts); });
  // Starts a launch spec ({cmd, args, cwd, env}) as an IDE process the Run window shows; -> process id.
  ipcMain.handle('minecraft:start', (_e, root, spec) => { guard(root); return startProcess(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true }); });
  // Whether nothing listens on a port (a server about to start there would fail to bind it).
  ipcMain.handle('minecraft:portFree', (_e, port) => new Promise((resolve) => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  }));
  ipcMain.handle('minecraft:sourceRoots', (_e, root, dir) => sourceRoots(root, dir));
  ipcMain.handle('minecraft:wireProxy', (_e, root, dir) => { guard(root); return wireProxy(root, dir); });
  ipcMain.handle('minecraft:newPlugin', (_e, opts) => { guard(opts?.root); return newPlugin(opts); });
  ipcMain.handle('minecraft:syncPlugins', (_e, root, serverDir) => { guard(root); syncPlugins(root, serverDir); return true; });
  ipcMain.handle('minecraft:buildPlugin', (_e, root, dir, job) => { guard(root); return buildPlugin(dir, logTo(job)); });
  ipcMain.handle('minecraft:addDependency', (_e, root, opts, job) => { guard(root); return addDependency(opts, logTo(job)); });
  ipcMain.handle('minecraft:newMod', (_e, opts, job) => { guard(opts?.root); return newMod(opts, logTo(job)); });
  ipcMain.handle('minecraft:modTask', (_e, root, dir, task, job, opts) => { guard(root); return modTask(dir, task, logTo(job), opts); });
  ipcMain.handle('minecraft:hotswapCompile', (_e, root, dir, files, job) => { guard(root); return hotswapCompile(dir, files, logTo(job)); });
  ipcMain.handle('minecraft:deployMod', (_e, root, dir) => { guard(root); return deployMod(dir); });
  ipcMain.handle('minecraft:clientPack', (_e, root, dir) => { guard(root); return clientPack(dir); });
  ipcMain.handle('minecraft:newResourcePack', (_e, root, dir) => { guard(root); return newResourcePack(dir); });
  ipcMain.handle('minecraft:packResourcePack', (_e, root, dir) => { guard(root); return packResourcePack(dir); });
  // Files and folders dropped on the window or on a server's card -> {done, skipped, modpacks}.
  ipcMain.handle('minecraft:drop', (_e, root, serverDir, paths, job) => { guard(root); return imports(root).drop(serverDir, paths, logTo(job)); });
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
  ipcMain.handle('minecraft:applyResourcePack', (_e, root, dir, url, sha1) => { guard(root); return applyResourcePack(dir, url, sha1); });
};
