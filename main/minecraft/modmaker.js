// Mods the user makes (Craft's My Mods page): mods/<id> of the craft folder, each the example mod its loader's own
// project publishes (sources.js modTemplate), renamed to the user's mod id, name, package and class, and described by
// pyide-mod.json {id, name, loader, mc, pkg, cls, created}. A mod is built by its own Gradle wrapper with a JDK of the
// Java its build asks for, and the jar it leaves in build/libs is added to the servers and instances of its loader.
// And the plugins they make: plugins/<Name>, plain Java written here (no template, no Gradle) for one of the user's
// Paper, Purpur or Velocity servers, described by pyide-plugin.json {name, api, pkg, server, mc, created}, compiled
// with javac against that server's API and packed into build/libs/<Name>.jar.
//   list(root) -> [{kind: 'mod', id, name, loader, mc, dir, main, jar: {name, path, size, time} | null, building} |
//     {kind: 'plugin', id: name, name, api: 'paper' | 'velocity', server, against: {name, ready} | null, dir, main, jar,
//     building}]
//   create(root, {id, name, pkg, loader, mc}, log) -> the mod, as list gives it
//   createPlugin(root, {name, pkg, server}) -> the plugin, as list gives it
//   pluginServers(root) -> [{name, kind, mc, api, ready}]     ready: it has the libraries a plugin is built against
//   build(root, ref, log) -> {jar, java}         ref: a mod id, {id} or {plugin}; log.signal ends the build and
//                                                everything it started
//   targets(root, {id} | {plugin} | {file}) -> {mod: {kind, id, loaders, api, built}, list: [{type: 'server' |
//     'instance', name, title, mc, loader, sameMc, running, has: [file]}]}
//   addTo(root, {id} | {plugin} | {file}, [{type, name}]) -> [{type, name, ok, file, replaced, restart} | {type, name,
//     ok: false, code, error}]
//   openInCode(root, ref) -> {started}           Nano Studio Code, where it is edited, with its folder
// Nothing here starts the game: a mod is tried by adding it to an instance and launching that.
// PYIDE_MC_CODE (tests): a file the launch of Code is written into instead of starting it.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const programEnv = require('../program-env');
const { MOD_LOADERS, modTemplate, fabricApiJar } = require('./sources');
const { readEntry, unpackZip } = require('./zipfile');
const { describe: describeJar, BUILT_IN } = require('./mods');

const MOD = 'pyide-mod.json';
const MOD_ID = /^[a-z][a-z0-9_]{1,63}$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
// A display name goes into JSON, TOML and Java strings as it is: no quotes, backslashes or control characters.
const DISPLAY = /^[^"\\\x00-\x1f\x7f]{1,48}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final '
  + 'finally float for goto if implements import instanceof int interface long native new package private protected public return short '
  + 'static strictfp super switch synchronized this throw throws transient try void volatile while true false null').split(' '));
const TEMPLATE_LIMIT = 50 * 1024 * 1024;
const FABRIC_API_LIMIT = 20 * 1024 * 1024;
// The loader a server (KINDS[kind].mods) or an instance must have to load a mod made for each loader.
const SERVER_LOADERS = { fabric: ['fabric-loader'], forge: ['forge'], neoforge: ['neoforge'] };
const INSTANCE_LOADERS = { fabric: ['fabric', 'quilt'], forge: ['forge'], neoforge: ['neoforge'] };
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const javaPackage = (pkg) => PACKAGE.test(pkg || '') && !pkg.split('.').some((w) => KEYWORDS.has(w));
const classOf = (id) => id.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

// ---------- the template's names ----------
// The names each loader's example mod is written with: its package, mod id, main class and display name.
const TEMPLATE_NAMES = {
  forge: { pkg: 'com.example.examplemod', id: 'examplemod', cls: 'ExampleMod', display: ['Example Mod'] },
  neoforge: { pkg: 'com.example.examplemod', id: 'examplemod', cls: 'ExampleMod', display: ['Example Mod'] },
  fabric: { pkg: 'com.example', id: 'modid', cls: 'ExampleMod', display: ['Example Mod', 'Example mod'] },
};
const TEXT = /\.(java|kt|json|json5|toml|properties|gradle|kts|mcmeta|cfg|txt)$/i;
const filesUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  if (isDir(dir)) walk(dir);
  return out;
};
// Java reads a .properties file as ISO-8859-1: what is not ASCII is written as \uXXXX there.
const forProperties = (s) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// Gives a template the user's mod id, display name, package and class: the texts under src/ and the build files, the
// package folders, and files and folders named after the template's id or class (assets/examplemod, modid.mixins.json,
// ExampleModClient.java). One pass a file, longest name first: the package holds the id (com.example.examplemod), and
// a name the user chose that holds one of the template's is not replaced again.
function renameMod(dir, loader, { id, display, pkg, cls }) {
  const from = TEMPLATE_NAMES[loader];
  const to = new Map([[from.pkg, pkg], [from.pkg.replace(/\./g, '/'), pkg.replace(/\./g, '/')], ...from.display.map((d) => [d, display]), [from.cls, cls], [from.id, id]]);
  const names = [...to.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'g');
  const roots = [path.join(dir, 'src'), ...['gradle.properties', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].map((f) => path.join(dir, f))];
  for (const file of roots.flatMap((r) => (isFile(r) ? [r] : filesUnder(r)))) {
    if (!TEXT.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const properties = /\.properties$/i.test(file);
    const next = text.replace(pattern, (hit) => (properties && from.display.includes(hit) ? forProperties(display) : to.get(hit)));
    if (next !== text) fs.writeFileSync(file, next);
  }
  // Package folders: src/<set>/java/<old path> moves to <new path>, through a temporary name since the new path may lie
  // inside the old one (com/example -> com/example/mymod).
  for (const set of isDir(path.join(dir, 'src')) ? fs.readdirSync(path.join(dir, 'src')) : []) {
    const java = path.join(dir, 'src', set, 'java');
    const old = path.join(java, ...from.pkg.split('.'));
    if (!isDir(old) || from.pkg === pkg) continue;
    const tmp = path.join(java, `.nano-move-${process.pid}`);
    fs.renameSync(old, tmp);
    for (let d = path.dirname(old); d !== java && isDir(d) && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d);
    const target = path.join(java, ...pkg.split('.'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(tmp, target);
  }
  // Files and folders named after the id or the class, deepest first so a parent's rename does not move a child away.
  // Not a package folder: the user's package may hold the template's id (com.example.examplemod.two), and its folders
  // are named already.
  const named = [];
  const packageFolder = (p) => /[\\/]src[\\/][^\\/]+[\\/]java[\\/]/.test(p);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      if (e.isDirectory() && packageFolder(p)) continue;
      if (e.name.includes(from.id) || e.name.includes(from.cls)) named.push(p);
    }
  };
  if (isDir(path.join(dir, 'src'))) walk(path.join(dir, 'src'));
  for (const p of named.sort((a, b) => b.length - a.length)) {
    const base = path.basename(p).split(from.cls).join(cls).split(from.id).join(id);
    if (base !== path.basename(p)) fs.renameSync(p, path.join(path.dirname(p), base));
  }
}

// A key=value in gradle.properties, set (added when missing) and the rest left as it is.
function setProperty(file, key, value) {
  const text = isFile(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key.replace(/[.]/g, '\\.')}[ \\t]*=.*$`, 'm');
  // A function replacement: a value's $& or $1 is text, not a pattern.
  fs.writeFileSync(file, re.test(text) ? text.replace(re, () => `${key}=${value}`) : `${text.replace(/\n?$/, text ? '\n' : '')}${key}=${value}\n`);
}

// ---------- what a build needs ----------
// The Java a mod's Gradle build runs on, from its own files: the language version its build names (a toolchain of
// exactly that Java, which the JDK Gradle runs on then is), raised to what its tools need to run at all. Gradle 9 runs
// on Java 17 and later. Fabric's Loom is itself built for a newer Java than the mod (its build.gradle, read on
// 2026-11-24: Loom 1.18 and later for Java 25, 1.11 to 1.17 for 21), and every branch of the example mod has the
// newest Loom, so a mod for Minecraft 1.20.1 compiles for Java 17 (--release) on a JDK 25.
// -> {java, upTo}: a JDK from java to upTo will do (Fabric's build names no toolchain).
const NEWEST_JAVA = 25;
function loomJava(properties, gradle) {
  const m = /^\s*loom_version\s*=\s*(\d+)\.(\d+)/m.exec(properties);
  if (!m) return gradle >= 9 ? NEWEST_JAVA : 0;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 1 || minor >= 18 ? 25 : minor >= 11 ? 21 : 17;
}
function buildJava(dir, loader, fallback) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const script = read('build.gradle') || read('build.gradle.kts');
  const named = /JavaLanguageVersion\.of\((\d+)\)/.exec(script)?.[1] || /options\.release\s*=\s*(\d+)/.exec(script)?.[1] || /JavaVersion\.VERSION_(?:1_)?(\d+)/.exec(script)?.[1];
  const gradle = Number(/gradle-(\d+)[\d.]*-(?:bin|all)\.zip/.exec(read('gradle/wrapper/gradle-wrapper.properties'))?.[1]) || 0;
  const language = Number(named) || Number(fallback) || 21;
  const java = Math.max(language, gradle >= 9 ? 17 : 0, loader === 'fabric' ? loomJava(read('gradle.properties'), gradle) : 0);
  return { java, upTo: loader === 'fabric' ? Math.max(java, NEWEST_JAVA) : java };
}

// The jar a build left: the newest in build/libs that is the mod itself (not its sources, its unmapped development jar,
// or its documentation).
function builtJar(dir) {
  const libs = path.join(dir, 'build', 'libs');
  let names = [];
  try { names = fs.readdirSync(libs); } catch {}
  return names.filter((n) => /\.jar$/i.test(n) && !/-(sources|dev|dev-shadow|slim|javadoc|all-dev)\.jar$/i.test(n))
    .map((n) => { const p = path.join(libs, n); try { const s = fs.statSync(p); return s.isFile() ? { name: n, path: p, size: s.size, time: s.mtimeMs } : null; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.time - a.time)[0] || null;
}

// The mod a jar holds, by the id its loader reads: {id, loaders} or null for a jar that is no mod.
function modOfJar(file) {
  try {
    const fabric = readEntry(file, 'fabric.mod.json');
    if (fabric) return { id: String(JSON.parse(fabric.toString('utf8')).id || '') || null, loaders: ['fabric'] };
    for (const [entry, loaders] of [['META-INF/neoforge.mods.toml', ['neoforge']], ['META-INF/mods.toml', ['forge', 'neoforge']]]) {
      const toml = readEntry(file, entry);
      if (toml) return { id: /^\s*modId\s*=\s*"([^"]+)"/m.exec(toml.toString('utf8'))?.[1] || null, loaders };
    }
  } catch {}
  return null;
}

// ---------- plugins ----------
// A plugin is plain Java: no Gradle and no template to download. Its sources are compiled with javac against the API
// of one of the user's servers (the jars Paper unpacks into libraries/ and versions/ at its first start; Velocity's own
// jar holds its API) and the jars in the plugin's libs/, then packed with its resources into build/libs/<Name>.jar.
const PLUGIN = 'pyide-plugin.json';
const PLUGIN_NAME = /^[A-Z][A-Za-z0-9]{0,39}$/;
const PLUGIN_APIS = { paper: 'Paper', velocity: 'Velocity' };
const PAPER_MAIN = (pkg, name) => `package ${pkg};

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

public final class ${name} extends JavaPlugin implements Listener {
    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
        getLogger().info("${name} enabled");
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        event.getPlayer().sendMessage("Welcome! This server runs ${name}.");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        sender.sendMessage("Hello from ${name}!");
        return true;
    }
}
`;
// api-version as major.minor (1.21, 26.3): every Paper version accepts that form.
const PAPER_YML = (pkg, name, mc) => `name: ${name}\nversion: '1.0'\nmain: ${pkg}.${name}\napi-version: '${String(mc).split('.').slice(0, 2).join('.')}'\ncommands:\n  ${name.toLowerCase()}:\n    description: Says hello\n`;
const VELOCITY_MAIN = (pkg, name, id) => `package ${pkg};

import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.PostLoginEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.ProxyServer;
import net.kyori.adventure.text.Component;
import org.slf4j.Logger;

@Plugin(id = "${id}", name = "${name}", version = "1.0")
public final class ${name} {
    private final ProxyServer server;
    private final Logger logger;

    @Inject
    public ${name}(ProxyServer server, Logger logger) {
        this.server = server;
        this.logger = logger;
    }

    @Subscribe
    public void onInitialize(ProxyInitializeEvent event) {
        logger.info("${name} enabled on {} servers", server.getAllServers().size());
    }

    @Subscribe
    public void onLogin(PostLoginEvent event) {
        event.getPlayer().sendMessage(Component.text("Welcome! This network runs ${name}."));
    }
}
`;
// Velocity reads velocity-plugin.json, which its annotation processor would write; it is written here instead, so a
// build needs no processor (javac of JDK 23 and later runs none unless asked).
const VELOCITY_JSON = (pkg, name, id) => `${JSON.stringify({ id, name, version: '1.0', main: `${pkg}.${name}`, authors: [], dependencies: [] }, null, 2)}\n`;

// .project, .classpath and the compiler level: Nano Studio Code's Java language server (JDT LS, which imports Eclipse
// projects) then knows the plugin's sources, the server's API and the plugin's libs/ jars. Files that would not change
// are left alone, since the language server imports the project again when they do.
function writeEclipseProject(dir, { name, java, jars }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const writeIfChanged = (file, text) => { try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {} fs.writeFileSync(file, text); };
  writeIfChanged(path.join(dir, '.project'), `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>${esc(name)}</name>
  <comment>Written by Nano Studio for the Java language server</comment>
  <projects/>
  <buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>
  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
</projectDescription>
`);
  writeIfChanged(path.join(dir, '.classpath'), `<?xml version="1.0" encoding="UTF-8"?>
<classpath>
  <classpathentry kind="src" path="src/main/java"/>
  <classpathentry kind="src" path="src/main/resources"/>
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
${jars.map((j) => `  <classpathentry kind="lib" path="${esc(j.replace(/\\/g, '/'))}"/>`).join('\n')}
  <classpathentry kind="output" path="build/eclipse"/>
</classpath>
`);
  fs.mkdirSync(path.join(dir, '.settings'), { recursive: true });
  writeIfChanged(path.join(dir, '.settings', 'org.eclipse.jdt.core.prefs'), ['eclipse.preferences.version=1', `org.eclipse.jdt.core.compiler.codegen.targetPlatform=${java}`,
    `org.eclipse.jdt.core.compiler.compliance=${java}`, `org.eclipse.jdt.core.compiler.source=${java}`, 'org.eclipse.jdt.core.compiler.release=enabled', ''].join('\n'));
}
const jarsUnder = (dir) => filesUnder(dir).filter((f) => /\.jar$/i.test(f));
function pluginClasspath(pluginDir, serverDir, api) {
  const server = api === 'velocity' ? [path.join(serverDir, 'server.jar')].filter(isFile)
    : [...jarsUnder(path.join(serverDir, 'libraries')), ...jarsUnder(path.join(serverDir, 'versions'))];
  return { server, all: [...server, ...jarsUnder(path.join(pluginDir, 'libs'))] };
}
// The plugin a jar holds, by the name its server reads: {id, api} or null for a jar that is no plugin.
function pluginOfJar(file) {
  try {
    for (const entry of ['plugin.yml', 'paper-plugin.yml']) {
      const yml = readEntry(file, entry);
      if (yml) return { id: /^name:[ \t]*['"]?([^'"#\r\n]+)/m.exec(yml.toString('utf8'))?.[1].trim() || null, api: 'paper' };
    }
    const json = readEntry(file, 'velocity-plugin.json');
    if (json) return { id: String(JSON.parse(json.toString('utf8')).id || '') || null, api: 'velocity' };
  } catch {}
  return null;
}

// A process and everything it started (cmd.exe, the Gradle wrapper's Java, the build's own Java), ended together when
// signal aborts: ending cmd.exe alone would leave Gradle running, holding the mod's folder.
function runTree(cmd, args, opts, log) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, ...opts }); } catch (err) { reject(err); return; }
    const kill = () => { if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {}); };
    const signal = log.signal;
    if (signal?.aborted) kill(); else signal?.addEventListener('abort', kill, { once: true });
    const decoders = [new TextDecoder('utf-8'), new TextDecoder('utf-8')];
    child.stdout.on('data', (d) => log(decoders[0].decode(d, { stream: true })));
    child.stderr.on('data', (d) => log(decoders[1].decode(d, { stream: true })));
    child.on('error', (err) => { signal?.removeEventListener('abort', kill); reject(err); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      else resolve(code);
    });
    if (child.pid) runTree.running.add(child.pid);
    child.on('close', () => runTree.running.delete(child.pid));
  });
}
runTree.running = new Set(); // the process ids of the builds that have not ended

// Gradle's own output and javac's messages come as UTF-8, whatever this Windows' code page is.
const GRADLE_UTF8 = '-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8';

// The test client: an init script makes runClient's JVM wait for the debugger on the port given (Fabric's Loom,
// ForgeGradle and NeoForge's ModDevGradle all run the game as a JavaExec task of that name), and pyideClasspath writes
// each source set's sources, class path and output, which HotSwap compiles a saved file against.
const HOTSWAP_DIR = 'build/pyide';
const INIT_SCRIPT = `// Written by Nano Studio for the test client.
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
           output: s.java.destinationDirectory.get().asFile.absolutePath,
           resources: s.resources.srcDirs*.absolutePath, resourcesOutput: s.output.resourcesDir?.absolutePath]
        }
        new File(project.rootDir, out).text = groovy.json.JsonOutput.toJson(data)
      }
    }
  }
}
`;
// The game shown beside the IDE (or in its Game View) keeps running while the user types in the editor: Minecraft
// opens its pause menu when its window loses focus unless options.txt in the run folder says otherwise.
function keepPlayingUnfocused(dir) {
  const file = path.join(dir, 'run', 'options.txt');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (/^pauseOnLostFocus:false\s*$/m.test(text)) return;
    fs.writeFileSync(file, /^pauseOnLostFocus:/m.test(text) ? text.replace(/^pauseOnLostFocus:.*$/m, () => 'pauseOnLostFocus:false')
      : `${text}${text && !text.endsWith('\n') ? '\n' : ''}pauseOnLostFocus:false\n`);
  } catch { /* the game pauses as it would anyway */ }
}

// fetchFile(url, dest, opts, log); ensureJdk(java, {log, upTo}) -> a JDK's home; javaFor(mc) -> Minecraft's Java;
// servers(root) and instances(root) -> what a mod can be added to; serverRunning(dir); codeArgv -> the program and
// arguments that start Nano Studio (Code is that with --mode=code and a folder).
function createModMaker({ fetchFile, ensureJdk, javaFor, servers, instances, serverRunning, codeArgv }) {
  const building = new Set(); // mod folders (lower case) a build of this run is in
  const keyOf = (dir) => path.resolve(dir).toLowerCase();
  const modsDir = (root) => path.join(root, 'mods');
  const dirOf = (root, id) => {
    if (!MOD_ID.test(id || '')) throw fail(`${id} is not a mod id`, 'noMod');
    return path.join(modsDir(root), id);
  };
  function describe(dir, meta) {
    const id = path.basename(dir);
    const cls = typeof meta.cls === 'string' ? meta.cls : classOf(id);
    const main = filesUnder(path.join(dir, 'src', 'main', 'java')).find((f) => path.basename(f) === `${cls}.java`) || null;
    return { kind: 'mod', id, name: typeof meta.name === 'string' && meta.name ? meta.name : id, loader: meta.loader, mc: String(meta.mc || ''), pkg: meta.pkg || null,
      created: meta.created || null, dir, main, jar: builtJar(dir), building: building.has(keyOf(dir)) };
  }
  function read(root, id) {
    const dir = dirOf(root, id);
    const meta = readJson(path.join(dir, MOD));
    if (!meta || !MOD_LOADERS[meta.loader]) throw fail(`There is no mod ${id}`, 'noMod');
    return describe(dir, meta);
  }
  // The folders of mods/ holding a pyide-mod.json that names a loader and those of plugins/ holding a pyide-plugin.json
  // that names an API, newest first.
  function list(root) {
    const names = (parent, test) => { try { return fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && test.test(d.name)).map((d) => d.name); } catch { return []; } };
    const quiet = (step) => { try { return step(); } catch { return null; } };
    return [...names(modsDir(root), MOD_ID).map((n) => quiet(() => read(root, n))), ...names(pluginsDir(root), PLUGIN_NAME).map((n) => quiet(() => readPlugin(root, n)))].filter(Boolean)
      .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')) || a.id.localeCompare(b.id));
  }
  // A mod or a plugin by how the window names it: a mod id, {id}, or {plugin: name}.
  const refOf = (ref) => (typeof ref === 'string' ? { id: ref } : ref && typeof ref === 'object' ? ref : {});
  const readAny = (root, ref) => (refOf(ref).plugin ? readPlugin(root, refOf(ref).plugin) : read(root, refOf(ref).id));

  // ---------- plugins ----------
  const pluginsDir = (root) => path.join(root, 'plugins');
  const pluginDirOf = (root, name) => {
    if (!PLUGIN_NAME.test(name || '')) throw fail(`${name} is not a plugin name`, 'noPlugin');
    return path.join(pluginsDir(root), name);
  };
  // The server a plugin is compiled against: the one it was made for while that still runs its API, else another of
  // the user's that does, one whose libraries are there first.
  function serverFor(root, plugin) {
    const fitting = servers(root).filter((s) => s.plugins === plugin.api);
    const ready = (s) => pluginClasspath(plugin.dir, s.dir, plugin.api).server.length > 0;
    return fitting.find((s) => s.name === plugin.server) || fitting.find(ready) || fitting[0] || null;
  }
  function readPlugin(root, name) {
    const dir = pluginDirOf(root, name);
    const meta = readJson(path.join(dir, PLUGIN));
    if (!meta || !PLUGIN_APIS[meta.api]) throw fail(`There is no plugin ${name}`, 'noPlugin');
    const main = filesUnder(path.join(dir, 'src', 'main', 'java')).find((f) => path.basename(f) === `${name}.java`) || null;
    const plugin = { kind: 'plugin', id: name, name, api: meta.api, server: typeof meta.server === 'string' ? meta.server : null, mc: String(meta.mc || ''), pkg: meta.pkg || null,
      created: meta.created || null, dir, main, jar: builtJar(dir), building: building.has(keyOf(dir)) };
    const srv = serverFor(root, plugin);
    // What its card says before a build would: the server it is compiled against, and whether that has its API yet.
    return { ...plugin, against: srv ? { name: srv.name, ready: pluginClasspath(dir, srv.dir, plugin.api).server.length > 0 } : null };
  }
  // The servers a plugin can be made for, as New Plugin lists them.
  const pluginServers = (root) => servers(root).filter((s) => PLUGIN_APIS[s.plugins])
    .map((s) => ({ name: s.name, kind: s.kind, mc: s.mc, api: s.plugins, ready: pluginClasspath(s.dir, s.dir, s.plugins).server.length > 0 }));
  // The Eclipse files that give Code the plugin's class path; written again whenever that may have changed.
  function syncPlugin(plugin, srv) {
    writeEclipseProject(plugin.dir, { name: plugin.name, java: Number(srv.java) || 21, jars: pluginClasspath(plugin.dir, srv.dir, plugin.api).all });
  }
  function createPlugin(root, { name, pkg, server } = {}) {
    if (!PLUGIN_NAME.test(name || '')) throw fail('Use a class-style name for the plugin: a capital letter, then letters and digits (40 at most)');
    if (RESERVED.test(name)) throw fail(`${name} is a name Windows keeps for a device: choose another`);
    if (!javaPackage(pkg)) throw fail('Use a Java package of two or more parts, such as com.example.myplugin');
    const srv = servers(root).find((s) => s.name === server && PLUGIN_APIS[s.plugins]);
    if (!srv) throw fail('Choose a Paper, Purpur or Velocity server for the plugin', 'noServer');
    const dir = pluginDirOf(root, name);
    // Windows finds a folder whatever its case: MyPlugin and myplugin are one.
    if (fs.existsSync(dir)) throw fail(isFile(path.join(dir, PLUGIN)) ? `A plugin named ${name} already exists` : `plugins/${name} is a folder that is not a plugin: choose another name, or move that folder away`, 'exists');
    const javaDir = path.join(dir, 'src', 'main', 'java', ...pkg.split('.'));
    const resDir = path.join(dir, 'src', 'main', 'resources');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'libs'), { recursive: true });
    const id = name.toLowerCase();
    if (srv.plugins === 'velocity') {
      fs.writeFileSync(path.join(javaDir, `${name}.java`), VELOCITY_MAIN(pkg, name, id));
      fs.writeFileSync(path.join(resDir, 'velocity-plugin.json'), VELOCITY_JSON(pkg, name, id));
    } else {
      fs.writeFileSync(path.join(javaDir, `${name}.java`), PAPER_MAIN(pkg, name));
      fs.writeFileSync(path.join(resDir, 'plugin.yml'), PAPER_YML(pkg, name, srv.mc));
    }
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
    fs.writeFileSync(path.join(dir, PLUGIN), `${JSON.stringify({ name, api: srv.plugins, pkg, server: srv.name, mc: srv.mc, created: new Date().toISOString() }, null, 2)}\n`);
    const plugin = readPlugin(root, name);
    try { syncPlugin(plugin, srv); } catch {}
    return plugin;
  }
  // javac against the server's API and libs/, then a jar of the plugin's classes and resources (libs/ are other
  // plugins' APIs, which are on the server when it runs).
  async function buildPlugin(root, name, log) {
    const plugin = readPlugin(root, name);
    const key = keyOf(plugin.dir);
    if (building.has(key)) throw fail(`${name} is being built already`, 'building');
    const srv = serverFor(root, plugin);
    if (!srv) throw fail(`${name} needs a ${PLUGIN_APIS[plugin.api]} server to be built against: make one in My Servers`, 'noServer');
    const cp = pluginClasspath(plugin.dir, srv.dir, plugin.api);
    if (!cp.server.length) throw fail(`Start ${srv.name} once first: a server unpacks the libraries a plugin is built against at its first start`, 'notStarted');
    const sources = filesUnder(path.join(plugin.dir, 'src', 'main', 'java')).filter((f) => /\.java$/i.test(f));
    if (!sources.length) throw fail('The plugin has no .java files in src/main/java', 'noSources');
    building.add(key);
    try {
      const java = Number(srv.java) || 21;
      const home = await ensureJdk(java, { log, upTo: Math.max(java, NEWEST_JAVA) });
      if (!home || !isFile(path.join(home, 'bin', 'javac.exe'))) throw fail(`A JDK of Java ${java} was not found`, 'noJdk');
      syncPlugin(plugin, srv);
      const out = path.join(plugin.dir, 'build');
      const classes = path.join(out, 'classes');
      fs.rmSync(classes, { recursive: true, force: true });
      fs.mkdirSync(classes, { recursive: true });
      // An argument file: the class path of a Paper server is some hundred jars, more than a command line holds.
      const q = (s) => `"${s.replace(/\\/g, '/')}"`;
      const argfile = path.join(out, 'javac-args.txt');
      fs.writeFileSync(argfile, [`--release ${java}`, '-encoding UTF-8', '-proc:none', '-g', `-d ${q(classes)}`, `-cp ${q(cp.all.join(path.delimiter))}`, ...sources.map(q)].join('\n'));
      log(`javac --release ${java} against ${srv.name} (${sources.length} file${sources.length === 1 ? '' : 's'}, JDK ${home})\n`);
      // javac's messages come as UTF-8, whatever this Windows' code page is.
      const utf8 = ['-J-Dfile.encoding=UTF-8', '-J-Dstdout.encoding=UTF-8', '-J-Dstderr.encoding=UTF-8', '-J-Dsun.stdout.encoding=UTF-8', '-J-Dsun.stderr.encoding=UTF-8'];
      const env = programEnv();
      const compiled = await runTree(path.join(home, 'bin', 'javac.exe'), [...utf8, `@${argfile}`], { cwd: plugin.dir, env }, log);
      if (compiled !== 0) throw fail(`The build failed (javac ended with ${compiled})`, 'buildFailed');
      const libs = path.join(out, 'libs');
      fs.mkdirSync(libs, { recursive: true });
      const jar = path.join(libs, `${name}.jar`);
      fs.rmSync(jar, { force: true });
      const resources = path.join(plugin.dir, 'src', 'main', 'resources');
      const packed = await runTree(path.join(home, 'bin', 'jar.exe'), ['--create', '--file', jar, '-C', classes, '.', ...(isDir(resources) ? ['-C', resources, '.'] : [])], { cwd: plugin.dir, env }, log);
      if (packed !== 0) throw fail(`The build failed (jar ended with ${packed})`, 'buildFailed');
      const built = builtJar(plugin.dir);
      if (!built) throw fail('The build finished but left no jar in build/libs', 'noJar');
      log(`Built ${built.name}\n`);
      return { jar: built, java };
    } finally { building.delete(key); }
  }

  async function create(root, { id, name, pkg, loader, mc } = {}, log) {
    if (!MOD_LOADERS[loader]) throw fail('Choose Fabric, Forge or NeoForge for the mod');
    if (!MOD_ID.test(id || '')) throw fail('Use a mod id of lower-case letters, digits and _, starting with a letter (2 to 64 characters)');
    if (RESERVED.test(id)) throw fail(`${id} is a name Windows keeps for a device: choose another`);
    if (!javaPackage(pkg)) throw fail('Use a Java package of two or more parts, such as com.example.mymod');
    const display = String(name ?? '').trim() || classOf(id);
    if (!DISPLAY.test(display)) throw fail('The name may hold up to 48 characters, without " and \\');
    const dir = dirOf(root, id);
    if (fs.existsSync(dir)) throw fail(isFile(path.join(dir, MOD)) ? `A mod with the id ${id} already exists` : `mods/${id} is a folder that is not a mod: choose another id, or move that folder away`, 'exists');
    const template = await modTemplate(loader, mc);
    const tmp = `${dir}.download`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const zip = path.join(tmp, 'template.zip');
      let used = null;
      let last = null;
      // A template is some tens of kilobytes: the download's progress lines would be eleven of "0 / 0 MB".
      const quiet = Object.assign((text) => { if (!/^\s*\d+( \/ \d+)? MB\s*$/.test(text)) log(text); }, { signal: log.signal });
      for (const t of template.urls) {
        try { await fetchFile(t.url, zip, { limit: TEMPLATE_LIMIT }, quiet); used = t; break; } catch (err) {
          if (err.name === 'AbortError') throw err;
          last = err;
          log(`${t.url}: ${err.message}\n`);
        }
      }
      if (!used) throw fail(`${MOD_LOADERS[loader]} has no mod template for Minecraft ${mc}${last ? ` (${last.message})` : ''}`, 'noTemplate');
      const out = path.join(tmp, 'out');
      unpackZip(zip, out);
      // GitHub's archive has one top folder; Forge's MDK zip has none.
      const entries = fs.readdirSync(out);
      const top = entries.length === 1 && isDir(path.join(out, entries[0])) ? path.join(out, entries[0]) : out;
      if (!isFile(path.join(top, 'gradlew.bat'))) throw fail('The mod template has no gradlew.bat', 'noTemplate');
      const cls = classOf(id);
      renameMod(top, loader, { id, display, pkg, cls });
      if (used.mc !== mc) {
        // An older version's template, pointed at this one: its build may need changes the newer NeoForge asks for.
        const props = path.join(top, 'gradle.properties');
        const neo = await template.newest?.();
        if (neo) setProperty(props, 'neo_version', neo);
        setProperty(props, 'minecraft_version', mc);
        setProperty(props, 'minecraft_version_range', `[${mc}]`);
        log(`${MOD_LOADERS[loader]} has no template for ${mc} yet: this one is for ${used.mc}, set to ${mc} in gradle.properties. Its build may need changes.\n`);
      }
      const java = buildJava(top, loader, await javaFor(mc).catch(() => null)).java;
      fs.writeFileSync(path.join(top, MOD), `${JSON.stringify({ id, name: display, loader, mc, pkg, cls, java, created: new Date().toISOString() }, null, 2)}\n`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(top, dir);
      log(`Created mods/${id}: ${MOD_LOADERS[loader]} ${mc}, package ${pkg}, class ${cls}\n`);
      return read(root, id);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  async function build(root, ref, log) {
    if (refOf(ref).plugin) return buildPlugin(root, refOf(ref).plugin, log);
    const id = refOf(ref).id;
    const mod = read(root, id);
    const key = keyOf(mod.dir);
    if (building.has(key)) throw fail(`${mod.name} is being built already`, 'building');
    if (!isFile(path.join(mod.dir, 'gradlew.bat'))) throw fail(`mods/${id} has no gradlew.bat: it is not a Gradle project Nano Studio can build`, 'noGradle');
    building.add(key);
    try {
      const { java, upTo } = buildJava(mod.dir, mod.loader, readJson(path.join(mod.dir, MOD))?.java);
      const home = await ensureJdk(java, { log, upTo });
      if (!home || !isFile(path.join(home, 'bin', 'javac.exe'))) throw fail(`A JDK of Java ${java} was not found`, 'noJdk');
      log(`gradlew build with Java ${java} (${home})\nThe first build downloads Gradle and Minecraft, which takes several minutes.\n`);
      const before = builtJar(mod.dir)?.time || 0;
      const env = { ...programEnv(), JAVA_HOME: home, GRADLE_OPTS: [process.env.GRADLE_OPTS, GRADLE_UTF8].filter(Boolean).join(' ') };
      // .\ because cmd finds a program in the current folder only that way when NoDefaultCurrentDirectoryInExePath is
      // set. No daemon: one would stay for hours, holding the JDK and the mod's folder.
      const code = await runTree(process.env.ComSpec || 'cmd.exe', ['/d', '/c', '.\\gradlew.bat', '--console=plain', '--no-daemon', 'build'], { cwd: mod.dir, env }, log);
      if (code !== 0) throw fail(`The build failed (gradlew build ended with ${code})`, 'buildFailed');
      const jar = builtJar(mod.dir);
      if (!jar || jar.time < before) throw fail('The build finished but left no jar in build/libs', 'noJar');
      log(`Built ${jar.name}\n`);
      return { jar, java };
    } finally { building.delete(key); }
  }

  // ---------- adding a mod or a plugin to servers and instances ----------
  // {id}: one of the user's mods, {plugin}: one of their plugins, each by the jar it was built into. {file}: a mod's or
  // a plugin's jar from elsewhere. -> {kind, id, name, loaders | api, mc, jar, file}
  function source(root, src) {
    if (src?.plugin) {
      const p = readPlugin(root, src.plugin);
      return { kind: 'plugin', id: p.name, name: p.name, api: p.api, loaders: [], mc: null, jar: p.jar?.path || null, file: p.jar?.name || null, server: p.server };
    }
    if (src?.id) {
      const mod = read(root, src.id);
      return { kind: 'mod', id: mod.id, name: mod.name, loaders: [mod.loader], mc: mod.mc, jar: mod.jar?.path || null, file: mod.jar?.name || null };
    }
    const file = typeof src?.file === 'string' ? src.file : '';
    if (!/\.jar$/i.test(file) || !isFile(file)) throw fail('Choose a mod\'s or a plugin\'s .jar file', 'noJar');
    const mod = modOfJar(file);
    if (mod) return { kind: 'mod', id: mod.id, name: path.basename(file), loaders: mod.loaders, mc: null, jar: file, file: path.basename(file) };
    const plugin = pluginOfJar(file);
    if (plugin) return { kind: 'plugin', id: plugin.id, name: path.basename(file), api: plugin.api, loaders: [], mc: null, jar: file, file: path.basename(file) };
    throw fail(`${path.basename(file)} is not a mod or a plugin Nano Studio knows`, 'noMod');
  }
  const jarsIn = (dir) => { try { return fs.readdirSync(dir).filter((n) => /\.jar(\.disabled)?$/i.test(n) && isFile(path.join(dir, n))); } catch { return []; } };
  // The jars of a mods or plugins folder that hold the same mod or plugin, also turned off, and one of the same file
  // name whatever it holds.
  const sameMod = (dir, src) => jarsIn(dir).filter((n) => n.replace(/\.disabled$/i, '').toLowerCase() === String(src.file || '').toLowerCase()
    || (src.id && (src.kind === 'plugin' ? pluginOfJar(path.join(dir, n)) : modOfJar(path.join(dir, n)))?.id === src.id));
  function places(root, src) {
    // A plugin goes to the servers that run its API: Paper's to Paper and Purpur, Velocity's to a Velocity proxy.
    if (src.kind === 'plugin') {
      return servers(root).filter((s) => s.plugins === src.api).map((s) => ({ type: 'server', name: s.name, title: s.name, mc: s.mc, loader: s.kind, dir: path.join(s.dir, 'plugins'), running: !!serverRunning(s.dir) }));
    }
    const forServers = new Set(src.loaders.flatMap((l) => SERVER_LOADERS[l] || []));
    const forInstances = new Set(src.loaders.flatMap((l) => INSTANCE_LOADERS[l] || []));
    return [
      ...servers(root).filter((s) => forServers.has(s.mods)).map((s) => ({ type: 'server', name: s.name, title: s.name, mc: s.mc, loader: s.kind, dir: path.join(s.dir, 'mods'), running: !!serverRunning(s.dir) })),
      ...instances(root).filter((i) => !i.damaged && forInstances.has(i.loader)).map((i) => ({ type: 'instance', name: i.name, title: i.title || i.name, mc: i.mc, loader: i.loader, dir: path.join(i.dir, 'mods'), running: false })),
    ];
  }
  function targets(root, src) {
    const s = source(root, src);
    return { mod: { kind: s.kind, id: s.id, name: s.name, loaders: s.loaders, api: s.api || null, mc: s.mc, built: !!s.jar, file: s.file, server: s.server || null },
      list: places(root, s).map(({ dir, ...t }) => ({ ...t, sameMc: !s.mc || t.mc === s.mc, has: sameMod(dir, s) })) };
  }
  // One result a place: a failure on one does not stop the next. The jar is copied beside its place and renamed in, and
  // the jars of the same mod there (an earlier build, of another file name too) go first.
  function addTo(root, src, wanted) {
    const s = source(root, src);
    if (!s.jar) throw fail(`Build ${s.name} first: it has no jar yet`, 'notBuilt');
    const all = places(root, s);
    return (Array.isArray(wanted) ? wanted : []).map((w) => {
      const place = all.find((p) => p.type === w?.type && p.name === w?.name);
      if (!place) return { type: w?.type, name: w?.name, ok: false, code: 'noPlace', error: `${w?.name} does not take this file` };
      const part = path.join(place.dir, `${s.file}.part`);
      try {
        fs.mkdirSync(place.dir, { recursive: true });
        fs.copyFileSync(s.jar, part);
        const replaced = sameMod(place.dir, s);
        for (const n of replaced) fs.rmSync(path.join(place.dir, n), { force: true });
        fs.renameSync(part, path.join(place.dir, s.file));
        return { type: place.type, name: place.name, title: place.title, ok: true, file: s.file, replaced, restart: place.running };
      } catch (err) {
        fs.rmSync(part, { force: true });
        const inUse = LOCKED.has(err.code);
        return { type: place.type, name: place.name, title: place.title, ok: false, code: inUse ? 'inUse' : 'failed',
          error: inUse ? `${place.title} holds the file: ${place.type === 'server' ? 'stop the server' : 'close Minecraft'} and add it again` : err.message };
      }
    });
  }

  // ---------- the test client: the game from the mod's own Gradle, under the debugger ----------
  // The JDK a mod's Gradle runs on and the Java its code is compiled for (Minecraft's, noted when the mod was made).
  async function jdkOf(mod, log) {
    const made = Number(readJson(path.join(mod.dir, MOD))?.java) || 0;
    const { java, upTo } = buildJava(mod.dir, mod.loader, made);
    const home = await ensureJdk(java, { log, upTo });
    if (!home || !isFile(path.join(home, 'bin', 'javac.exe'))) throw fail(`A JDK of Java ${java} was not found`, 'noJdk');
    return { home, release: made || java };
  }
  // What starts `gradlew runClient` with the game's JVM waiting for the debugger on debugPort -> {cmd, args, cwd, env,
  // sourceRoots}. The init script also writes the source sets HotSwap compiles against (build/pyide/classpath.json).
  async function clientTask(root, ref, { debugPort } = {}, log) {
    const mod = read(root, refOf(ref).id);
    if (!isFile(path.join(mod.dir, 'gradlew.bat'))) throw fail(`mods/${mod.id} has no gradlew.bat: it is not a Gradle project Nano Studio can build`, 'noGradle');
    const port = Number(debugPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('No debug port');
    const { home } = await jdkOf(mod, log);
    fs.mkdirSync(path.join(mod.dir, HOTSWAP_DIR), { recursive: true });
    fs.writeFileSync(path.join(mod.dir, HOTSWAP_DIR, 'init.gradle'), INIT_SCRIPT);
    fs.rmSync(path.join(mod.dir, HOTSWAP_DIR, 'classpath.json'), { force: true });
    keepPlayingUnfocused(mod.dir);
    // .\ and no daemon as for a build; the configuration cache would keep the last run's debug port.
    return { cmd: process.env.ComSpec || 'cmd.exe', cwd: mod.dir, env: { JAVA_HOME: home, GRADLE_OPTS: [process.env.GRADLE_OPTS, GRADLE_UTF8].filter(Boolean).join(' ') },
      args: ['/d', '/c', '.\\gradlew.bat', '--console=plain', '--no-daemon', '--no-configuration-cache', '-I', `${HOTSWAP_DIR}/init.gradle`, `-Ppyide.debugPort=${port}`,
        `-Ppyide.classpathFile=${HOTSWAP_DIR}/classpath.json`, 'pyideClasspath', 'runClient'],
      sourceRoots: [['src', 'main', 'java'], ['src', 'client', 'java']].map((p) => path.join(mod.dir, ...p)).filter(isDir) };
  }
  const sourceSets = (mod) => {
    const sets = readJson(path.join(mod.dir, HOTSWAP_DIR, 'classpath.json'));
    if (!Array.isArray(sets)) throw fail('The test client is not running, or Gradle has not written its class path yet', 'noClient');
    return sets;
  };
  const under = (file, dir) => path.resolve(file).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);
  // HotSwap: the saved .java files compiled with javac against their source set's class path, the classes written
  // over the source set's output (so a class the game has not loaded yet, or a restart, has them too)
  // -> [{name, file}] for the debugger to redefine.
  async function hotswapCompile(root, ref, files, log) {
    const mod = read(root, refOf(ref).id);
    const sets = sourceSets(mod);
    const groups = new Map(); // source set -> files
    for (const f of (Array.isArray(files) ? files : []).filter((x) => typeof x === 'string' && under(x, mod.dir))) {
      const set = sets.find((s) => (s.sources || []).some((d) => under(f, d)));
      if (set) groups.set(set, [...(groups.get(set) || []), f]);
    }
    if (!groups.size) return [];
    const { home, release } = await jdkOf(mod, log);
    const classes = [];
    for (const [set, list] of groups) {
      const tmp = fs.mkdtempSync(path.join(mod.dir, HOTSWAP_DIR, 'javac-'));
      try {
        const q = (s) => `"${s.replace(/\\/g, '/')}"`;
        const argfile = path.join(tmp, 'args.txt');
        fs.writeFileSync(argfile, [`--release ${release}`, '-encoding UTF-8', '-proc:none', '-g', '-implicit:none', `-d ${q(path.join(tmp, 'out'))}`,
          `-cp ${q([...sets.map((s) => s.output), ...(set.classpath || [])].join(path.delimiter))}`, ...list.map(q)].join('\n'));
        const utf8 = ['-J-Dfile.encoding=UTF-8', '-J-Dstdout.encoding=UTF-8', '-J-Dstderr.encoding=UTF-8', '-J-Dsun.stdout.encoding=UTF-8', '-J-Dsun.stderr.encoding=UTF-8'];
        const code = await runTree(path.join(home, 'bin', 'javac.exe'), [...utf8, `@${argfile}`], { cwd: mod.dir, env: programEnv() }, log);
        if (code !== 0) throw fail('The saved code does not compile', 'compile');
        for (const f of filesUnder(path.join(tmp, 'out')).filter((n) => n.endsWith('.class'))) {
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
  // A saved texture, model, language file or other file under assets/ or data/ of a source set's resources, copied
  // over its output, which the test client reads (F3+T reloads assets/, /reload data/). Other resources
  // (fabric.mod.json, mods.toml) are filled in by Gradle's processResources, so they wait for the next start.
  function hotswapResources(root, ref, files) {
    const mod = read(root, refOf(ref).id);
    const sets = sourceSets(mod);
    const out = { copied: [], assets: false, data: false };
    for (const f of (Array.isArray(files) ? files : []).filter((x) => typeof x === 'string' && under(x, mod.dir))) {
      const file = path.resolve(f);
      for (const set of sets) {
        const base = (set.resources || []).find((d) => under(file, d));
        if (!base || !set.resourcesOutput) continue;
        const rel = path.relative(base, file);
        const top = rel.split(path.sep)[0].toLowerCase();
        if ((top !== 'assets' && top !== 'data') || rel.split(path.sep).includes('..')) break;
        const dest = path.join(set.resourcesOutput, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(file, dest);
        out.copied.push(rel.split(path.sep).join('/'));
        out[top] = true;
        break;
      }
    }
    return out;
  }

  // ---------- what a mod needs where it is tried ----------
  // The ids of the mods `src` cannot start without that a place's mods folder does not hold, by what the jars say of
  // themselves (jars inside jars count). The game, its loader and Java are never missing.
  function missingIn(root, src, wanted) {
    const s = source(root, src);
    const place = places(root, s).find((p) => p.type === wanted?.type && p.name === wanted?.name);
    if (s.kind !== 'mod' || !s.jar || !place) return [];
    const there = new Set();
    for (const n of jarsIn(place.dir).filter((f) => /\.jar$/i.test(f))) {
      const d = describeJar(path.join(place.dir, n));
      for (const m of d.mods) { there.add(m.id); for (const p of m.provides || []) there.add(p); }
      for (const p of d.provides) there.add(p.id);
    }
    const needed = describeJar(s.jar).mods.flatMap((m) => m.depends).filter((d) => d.kind === 'required').map((d) => d.id);
    return [...new Set(needed.filter((id) => !BUILT_IN.has(id) && !there.has(id)))];
  }
  // The Fabric API a Fabric mod is built with, as its gradle.properties names it (fabric_api_version; fabric_version
  // in older example mods), or null.
  function fabricApiOf(dir) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'gradle.properties'), 'utf8'); } catch {}
    const v = /^[ \t]*fabric(?:_api)?_version[ \t]*=[ \t]*(\S+)/m.exec(text)?.[1] || '';
    return /^[\w.+-]{1,64}$/.test(v) ? v : null;
  }
  // That Fabric API into a place's mods folder, from Fabric's Maven repository: the example mod requires it and a new
  // instance has none. What arrives is kept only when it is Fabric API. -> {file, version}
  async function addFabricApi(root, ref, wanted, log) {
    const mod = read(root, refOf(ref).id);
    const version = mod.loader === 'fabric' ? fabricApiOf(mod.dir) : null;
    if (!version) throw fail(`${mod.name} names no Fabric API version in gradle.properties`, 'noFabricApi');
    const place = places(root, source(root, { id: mod.id })).find((p) => p.type === wanted?.type && p.name === wanted?.name);
    if (!place) throw fail(`${wanted?.name} does not take this mod`, 'noPlace');
    const file = `fabric-api-${version}.jar`;
    const dest = path.join(place.dir, file);
    fs.mkdirSync(place.dir, { recursive: true });
    await fetchFile(fabricApiJar(version), dest, { limit: FABRIC_API_LIMIT }, log);
    if (modOfJar(dest)?.id !== 'fabric-api') {
      fs.rmSync(dest, { force: true });
      throw fail('What was downloaded is not Fabric API', 'noFabricApi');
    }
    return { file, version };
  }

  function openInCode(root, ref) {
    const mod = readAny(root, ref);
    const argv = [...codeArgv(), '--mode=code', mod.dir];
    if (process.env.PYIDE_MC_CODE) {
      fs.writeFileSync(process.env.PYIDE_MC_CODE, `${JSON.stringify({ argv: argv.slice(-2), dir: mod.dir })}\n`);
      return { started: true };
    }
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', env: programEnv() });
    child.on('error', () => {});
    child.unref();
    return { started: true };
  }

  return { list, read, create, createPlugin, pluginServers, build, targets, addTo, missingIn, fabricApiOf, addFabricApi, clientTask, hotswapCompile, hotswapResources, openInCode,
    // At quit: taskkill is waited for, since Windows ends this program's own children with it but not theirs (Gradle's Java).
    stop: () => { for (const pid of runTree.running) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } };
}

module.exports = { createModMaker, renameMod, buildJava, builtJar, modOfJar, pluginOfJar, classOf, setProperty, MOD, MOD_ID, PLUGIN, PLUGIN_NAME };
