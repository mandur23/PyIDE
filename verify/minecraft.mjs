// Minecraft servers, plugins and mods (minecraft plugin) against stand-ins, offline and without accepting the real
// Minecraft EULA: a local web server plays Mojang, PaperMC (Paper, Velocity), Purpur, the Forge Maven and a Maven
// repository; a small Java program plays the server (listens on its port, prints "Done", takes console commands,
// saves on "stop", unpacks an API jar at its first start the way Paper does, and loads the plugins' jars and calls
// their onEnable) and the Velocity proxy; stub Bukkit classes stand in for the API; a stand-in cloudflared gives the
// shared resource pack its address. Checks: the New Server dialog (types, versions, the EULA), Paper and Purpur
// servers with their checksums, a bad checksum leaving nothing behind, the console and a graceful Stop, a plugin with
// the Eclipse files that give the editor its classpath, a library added from a Maven repository, the plugin built,
// deployed and run by the restarted server, a breakpoint in the plugin hit under Debug, the resource pack sent to
// players through server.properties, a Velocity proxy wired to the project's Paper servers, a Forge server through
// its installer, a mod from the MDK renamed to the user's id and package, built with the server's Java and deployed,
// and the client pack (.mrpack) read back by Python's zipfile. Port 9793; the servers listen on 25611-25614.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-minecraft-'));
const javaHome = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME_17_X64 || process.env.JAVA_HOME
  || path.dirname(path.dirname(execFileSync('where', ['javac'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()));
const bin = (t) => path.join(javaHome, 'bin', `${t}.exe`);
const write = (p, text) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };

// ---------- stand-in jars ----------
const src = path.join(work, 'src');
const stubs = {
  'org/bukkit/plugin/java/JavaPlugin.java': 'package org.bukkit.plugin.java; public abstract class JavaPlugin { private final java.util.logging.Logger log = java.util.logging.Logger.getLogger(getClass().getSimpleName()); public void onEnable() {} public org.bukkit.Server getServer() { return () -> (l, p) -> {}; } public java.util.logging.Logger getLogger() { return log; } public boolean onCommand(org.bukkit.command.CommandSender s, org.bukkit.command.Command c, String l, String[] a) { return false; } }',
  'org/bukkit/Server.java': 'package org.bukkit; public interface Server { org.bukkit.plugin.PluginManager getPluginManager(); }',
  'org/bukkit/plugin/PluginManager.java': 'package org.bukkit.plugin; public interface PluginManager { void registerEvents(org.bukkit.event.Listener l, org.bukkit.plugin.java.JavaPlugin p); }',
  'org/bukkit/event/Listener.java': 'package org.bukkit.event; public interface Listener {}',
  'org/bukkit/event/EventHandler.java': 'package org.bukkit.event; import java.lang.annotation.*; @Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD) public @interface EventHandler {}',
  'org/bukkit/event/player/PlayerJoinEvent.java': 'package org.bukkit.event.player; public class PlayerJoinEvent { public org.bukkit.entity.Player getPlayer() { return null; } }',
  'org/bukkit/entity/Player.java': 'package org.bukkit.entity; public interface Player extends org.bukkit.command.CommandSender {}',
  'org/bukkit/command/CommandSender.java': 'package org.bukkit.command; public interface CommandSender { void sendMessage(String m); }',
  'org/bukkit/command/Command.java': 'package org.bukkit.command; public class Command {}',
};
for (const [f, text] of Object.entries(stubs)) write(path.join(src, 'api', f), text);
write(path.join(src, 'server', 'FakeServer.java'), `import java.io.*; import java.net.*; import java.nio.file.*; import java.util.*; import java.util.jar.*;
public class FakeServer {
  public static void main(String[] a) throws Exception {
    boolean proxy = new File("velocity.toml").exists();
    if (!proxy && !new File("eula.txt").exists()) { System.out.println("You need to agree to the EULA"); System.exit(1); }
    Properties p = new Properties();
    try (Reader r = new FileReader("server.properties")) { p.load(r); }
    Path lib = Paths.get("libraries/io/papermc/paper/paper-api/stub/paper-api.jar");
    InputStream api = FakeServer.class.getResourceAsStream("/api.jar");
    if (api != null && !Files.exists(lib)) { Files.createDirectories(lib.getParent()); Files.copy(api, lib); }
    Files.write(Paths.get("starts.log"), "start\\n".getBytes(), StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    File[] plugins = new File("plugins").listFiles((d, n) -> n.endsWith(".jar"));
    System.out.println("Loading plugins: " + (plugins == null ? "" : String.join(",", Arrays.stream(plugins).map(File::getName).toArray(String[]::new))));
    if (plugins != null) for (File jar : plugins) {
      String main = null;
      try (JarFile jf = new JarFile(jar)) { JarEntry e = jf.getJarEntry("plugin.yml"); if (e != null) for (String line : new String(jf.getInputStream(e).readAllBytes()).split("\\n")) if (line.startsWith("main: ")) main = line.substring(6).trim(); }
      if (main == null) continue;
      URLClassLoader cl = new URLClassLoader(new URL[] { jar.toURI().toURL(), lib.toUri().toURL() }, FakeServer.class.getClassLoader());
      Object plugin = cl.loadClass(main).getDeclaredConstructor().newInstance();
      plugin.getClass().getMethod("onEnable").invoke(plugin);
      System.out.println("Enabled " + jar.getName());
    }
    ServerSocket ss = new ServerSocket(Integer.parseInt(p.getProperty("server-port", "25565")), 50, InetAddress.getLoopbackAddress());
    Thread t = new Thread(() -> { while (true) try { ss.accept().close(); } catch (Exception e) { return; } });
    t.setDaemon(true); t.start();
    System.out.println("Done (0.4s)! For help, type \\"help\\"");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    for (String line; (line = in.readLine()) != null;) {
      if (line.trim().equals(proxy ? "end" : "stop")) { System.out.println("Stopping the server"); Files.write(Paths.get("world.saved"), "ok".getBytes()); System.exit(0); }
      System.out.println("Unknown command: " + line.trim());
    }
  }
}`);
write(path.join(src, 'installer', 'FakeInstaller.java'), `import java.nio.file.*;
public class FakeInstaller {
  public static void main(String[] a) throws Exception {
    if (a.length == 0 || !a[0].equals("--installServer")) { System.exit(2); }
    Path self = Paths.get(FakeInstaller.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    Path lib = Paths.get("libraries/net/minecraftforge/forge/1.20.1-47.9.9");
    Files.createDirectories(lib);
    Files.copy(self, lib.resolve("forge-server.jar"), StandardCopyOption.REPLACE_EXISTING);
    Files.write(lib.resolve("win_args.txt"), "-cp libraries/net/minecraftforge/forge/1.20.1-47.9.9/forge-server.jar\\nFakeServer\\n".getBytes());
    Files.write(Paths.get("user_jvm_args.txt"), "# JVM arguments\\n".getBytes());
    System.out.println("The server installed successfully");
  }
}`);
const out = (d) => { const p = path.join(work, 'out', d); mkdirSync(p, { recursive: true }); return p; };
const javac = (dir, files) => execFileSync(bin('javac'), ['--release', '17', '-d', dir, ...files]);
const apiClasses = out('api');
javac(apiClasses, Object.keys(stubs).map((f) => path.join(src, 'api', f)));
const apiJar = path.join(out('jars'), 'api.jar');
execFileSync(bin('jar'), ['--create', '--file', apiJar, '-C', apiClasses, '.']);
const serverClasses = out('server');
javac(serverClasses, [path.join(src, 'server', 'FakeServer.java')]);
const jarOf = (name, dirs, main) => {
  const file = path.join(work, 'out', 'jars', name);
  execFileSync(bin('jar'), ['--create', '--file', file, '--main-class', main, ...dirs.flatMap((d) => ['-C', d, '.'])]);
  return readFileSync(file);
};
// Paper's jar holds the API it unpacks and Mojang's version.json (the resource pack format).
const paperRes = out('paper-res');
writeFileSync(path.join(paperRes, 'api.jar'), readFileSync(apiJar));
writeFileSync(path.join(paperRes, 'version.json'), S({ id: '1.20.1', pack_version: { resource: 15, data: 15 } }));
const paperJar = jarOf('paper.jar', [serverClasses, paperRes], 'FakeServer');
const vanillaJar = jarOf('vanilla.jar', [serverClasses], 'FakeServer');
const installerClasses = out('installer');
javac(installerClasses, [path.join(src, 'installer', 'FakeInstaller.java')]);
const installerJar = jarOf('installer.jar', [installerClasses, serverClasses], 'FakeInstaller');
// The MDK as Forge's: its names are the template's (examplemod, ExampleMod, com.example.examplemod).
const mdk = out('mdk');
write(path.join(mdk, 'gradle.properties'), 'mod_id=examplemod\nmod_name=Example Mod\nmod_group_id=com.example.examplemod\n');
write(path.join(mdk, 'src', 'main', 'java', 'com', 'example', 'examplemod', 'ExampleMod.java'), 'package com.example.examplemod;\n\npublic class ExampleMod {\n    public static final String MODID = "examplemod";\n}\n');
write(path.join(mdk, 'src', 'main', 'resources', 'assets', 'examplemod', 'lang', 'en_us.json'), '{ "itemGroup.examplemod": "Example Mod" }\n');
// gradlew.bat gets --console=plain then the task; cmd splits an argument at "=", so the task is taken as the last one.
write(path.join(mdk, 'gradlew.bat'), '@echo off\r\nsetlocal\r\nfor %%a in (%*) do set task=%%a\r\necho JAVA_HOME=%JAVA_HOME%\r\necho task %task%\r\nif "%task%"=="build" (\r\n  if not exist build\\libs mkdir build\\libs\r\n  copy /y gradle.properties build\\libs\\mymod-1.0.jar >nul\r\n  copy /y gradle.properties build\\libs\\mymod-1.0-sources.jar >nul\r\n  echo BUILD SUCCESSFUL\r\n)\r\n');
const mdkZip = path.join(work, 'out', 'jars', 'mdk.zip');
execFileSync(bin('jar'), ['--create', '--no-manifest', '--file', mdkZip, '-C', mdk, '.']);
// A stand-in cloudflared: the quick tunnel's banner and registration.
const fakeTunnel = path.join(work, 'fake-cloudflared.cjs');
writeFileSync(fakeTunnel, `const port = (process.argv.join(' ').match(/:(\\d+)/) || [])[1];
setTimeout(() => process.stderr.write('INF |  https://fake-port-' + port + '.trycloudflare.com  |\\nINF Registered tunnel connection\\n'), 200);
setInterval(() => {}, 1000);
`);

// ---------- stand-in services ----------
const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');
const routes = new Map();
const server = http.createServer((q, r) => {
  const body = routes.get(q.url.split('?')[0]);
  if (body === undefined) { r.writeHead(404); return r.end(); }
  r.writeHead(200);
  r.end(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
routes.set('/mojang/manifest.json', { latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: `${base}/mojang/1.20.1.json` }, { id: '1.19.4', type: 'release', url: `${base}/mojang/1.19.4.json` }] });
routes.set('/mojang/1.20.1.json', { javaVersion: { majorVersion: 17 }, downloads: { server: { url: `${base}/files/vanilla.jar`, sha1: sha('sha1', vanillaJar), size: vanillaJar.length } } });
routes.set('/mojang/1.19.4.json', { javaVersion: { majorVersion: 17 }, downloads: { server: { url: `${base}/files/vanilla.jar`, sha1: '0'.repeat(40), size: vanillaJar.length } } });
routes.set('/files/vanilla.jar', vanillaJar);
routes.set('/paper', { versions: { '1.20': ['1.20.1', '1.20.1-rc1'] } });
routes.set('/paper/versions/1.20.1/builds', [{ id: 7, channel: 'STABLE', downloads: { 'server:default': { url: `${base}/files/paper.jar`, size: paperJar.length, checksums: { sha256: sha('sha256', paperJar) } } } }]);
routes.set('/files/paper.jar', paperJar);
routes.set('/purpur', { versions: ['1.20.1'] });
routes.set('/purpur/1.20.1/latest', { build: '99', md5: sha('md5', paperJar) });
routes.set('/purpur/1.20.1/99/download', paperJar);
routes.set('/velocity', { versions: { '4.0.0': ['4.3.1', '4.3.2-SNAPSHOT'] } });
routes.set('/velocity/versions/4.3.1/builds', [{ id: 45, channel: 'STABLE', downloads: { 'server:default': { url: `${base}/files/vanilla.jar`, size: vanillaJar.length, checksums: { sha256: sha('sha256', vanillaJar) } } } }]);
routes.set('/forge/promos.json', { promos: { '1.20.1-recommended': '47.9.9', '1.20.1-latest': '47.9.9' } });
routes.set('/forge/1.20.1-47.9.9/forge-1.20.1-47.9.9-installer.jar', installerJar);
routes.set('/forge/1.20.1-47.9.9/forge-1.20.1-47.9.9-installer.jar.sha256', sha('sha256', installerJar));
routes.set('/forge/1.20.1-47.9.9/forge-1.20.1-47.9.9-mdk.zip', readFileSync(mdkZip));
const libJar = readFileSync(apiJar);
routes.set('/maven/net/test/api/1.0/api-1.0.jar', libJar);
routes.set('/maven/net/test/api/1.0/api-1.0.jar.sha1', sha('sha1', libJar));
// What is dropped on the window from outside: a plugin and a Fabric mod jar, a world, a resource pack zip, a server
// folder made elsewhere, and a Modrinth modpack (a server mod, a client-only mod, overrides).
const outside = path.join(work, 'outside');
const jarWith = (name, entry, text) => {
  const d = path.join(work, 'out', `jar-${name}`);
  write(path.join(d, entry), text);
  const file = path.join(outside, name);
  mkdirSync(outside, { recursive: true });
  execFileSync(bin('jar'), ['--create', '--no-manifest', '--file', file, '-C', d, '.']);
  return file;
};
const pluginJar = jarWith('extra-plugin.jar', 'plugin.yml', 'name: Extra\nmain: x.Extra\nversion: 1\n');
const fabricJar = jarWith('fabric-mod.jar', 'fabric.mod.json', '{"id": "x"}');
const worldDir = path.join(outside, 'MyWorld');
write(path.join(worldDir, 'level.dat'), 'level');
write(path.join(worldDir, 'region', 'r.0.0.mca'), 'region');
const packDir = path.join(work, 'out', 'droppack');
write(path.join(packDir, 'pack.mcmeta'), '{"pack": {"pack_format": 15, "description": "dropped"}}');
write(path.join(packDir, 'assets', 'minecraft', 'textures', 'item', 'apple.png'), 'png');
const packZip = path.join(outside, 'pack.zip');
execFileSync(bin('jar'), ['--create', '--no-manifest', '--file', packZip, '-C', packDir, '.']);
const oldServer = path.join(outside, 'OldServer');
write(path.join(oldServer, 'server.jar'), paperJar);
write(path.join(oldServer, 'server.properties'), 'server-port=25615\n');
write(path.join(oldServer, 'eula.txt'), 'eula=false\n');
const serverMod = Buffer.from('server mod');
const clientMod = Buffer.from('client mod');
routes.set('/files/server-mod.jar', serverMod);
routes.set('/files/client-mod.jar', clientMod);
const mrpack = path.join(outside, 'Test Pack.mrpack');
execFileSync('py', ['-3', '-I', '-c', `import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED)
z.writestr('modrinth.index.json', sys.argv[2])
z.writestr('overrides/config/pack.toml', 'shared = true')
z.writestr('server-overrides/server-only.txt', 'server')
z.writestr('client-overrides/options.txt', 'client')
z.close()`, mrpack, S({ formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Test Pack', dependencies: { minecraft: '1.20.1', forge: '47.9.9' }, files: [
  { path: 'mods/server-mod.jar', hashes: { sha1: sha('sha1', serverMod), sha512: sha('sha512', serverMod) }, env: { client: 'required', server: 'required' }, downloads: [`${base}/files/server-mod.jar`], fileSize: serverMod.length },
  { path: 'mods/client-mod.jar', hashes: { sha1: sha('sha1', clientMod) }, env: { client: 'required', server: 'unsupported' }, downloads: [`${base}/files/client-mod.jar`], fileSize: clientMod.length },
] })]);

const project = path.join(work, 'project');
mkdirSync(project);
const t = await launch({ name: 'minecraft', port: 9793, projectDir: project, env: {
  PYIDE_MC_JAVA: javaHome,
  PYIDE_CLOUDFLARED: S([process.execPath, fakeTunnel]),
  PYIDE_MC_SOURCES: S({ mojang: `${base}/mojang/manifest.json`, paper: `${base}/paper`, purpur: `${base}/purpur`, velocity: `${base}/velocity`, forge: `${base}/forge`,
    forgePromos: `${base}/forge/promos.json`, fabric: `${base}/fabric`, neoforge: `${base}/neoforge`, adoptium: `${base}/adoptium` }),
} });
const { js, until, check, sleep, shot, cdp } = t;
// A real drag of files from outside (CDP, with their paths) onto an element of the window.
const dropOn = async (target, files) => {
  // Balloons stack over the right side after many steps; a drop on one would go to the window, not the target.
  await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);
  const box = await js(`(() => { const n = ${target}; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); const x = r.x + 20, y = r.y + 10; return { x, y, hit: n.contains(document.elementFromPoint(x, y)) }; })()`);
  if (!box.hit) throw new Error(`the drop point is not on ${target}`);
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
};
const card = (name) => `document.querySelector('#minecraftTool .mc-server[data-name="${name}"]')`;
const click = (sel) => js(`(document.querySelector(${S(sel)}).click(), true)`);
const runTab = (title) => `ide.run.sessions().find((s) => s.title === ${S(title)})`;
const tabText = (title) => js(`${runTab(title)}?.host.textContent || ''`);
const dialogButton = (label) => `[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${S(label)})`;
const starts = (dir) => (existsSync(path.join(dir, 'starts.log')) ? readFileSync(path.join(dir, 'starts.log'), 'utf8').trim().split('\n').length : 0);
const serverDir = (name) => path.join(project, 'servers', name);
const create = (opts) => js(`ide.minecraft.createServer(${S(opts)}).then((r) => !!r)`);
const startServer = async (name) => {
  await js(`(${card(name)}.querySelector('.mc-start').click(), true)`);
  await until(`(${runTab(name)})?.running && (${runTab(name)}).host.textContent.includes('Done (0.4s)!')`, `${name} started`, 60000);
};
const stopServer = async (name) => {
  await js(`(${card(name)}.querySelector('.mc-stop').click(), true)`);
  await until(`!(${runTab(name)}).running`, `${name} stopped`, 40000);
};

try {
  await js(`(ide.settings.set('ports.confirmShare', false), ide.toolWindows.get('Minecraft').show(), true)`);
  await until(`!!document.querySelector('#minecraftTool .mc-empty')`, 'empty Minecraft window');
  check(true, 'the Minecraft tool window opens on a project without servers');

  // ---------- New Server ----------
  await click('#minecraftTool .mc-new');
  await until(`document.querySelectorAll('#mcKind option').length === 7`, 'server types');
  check(S(await js(`[...document.querySelectorAll('#mcKind option')].map((o) => o.textContent)`)) === S(['Paper', 'Purpur', 'Velocity', 'Vanilla', 'Fabric', 'Forge', 'NeoForge']),
    'New Server offers Paper, Purpur, Velocity, Vanilla, Fabric, Forge and NeoForge');
  await until(`[...document.querySelector('#mcVersion').options].map((o) => o.value).join() === '1.20.1'`, 'paper versions', 15000);
  check(true, "Paper's versions come from its service, release builds only");
  await js(`(${dialogButton('Create')}).click()`);
  check(/accept the Minecraft EULA/.test(await js(`document.querySelector('.mc-dialog-error').textContent`)) && !existsSync(path.join(project, 'servers')), 'nothing is created before the EULA is accepted');
  await js(`(() => { const k = document.querySelector('#mcKind'); k.value = 'velocity'; k.dispatchEvent(new Event('change')); return true; })()`);
  check(await js(`document.querySelector('#mcEula').closest('.mc-dialog-check').classList.contains('hidden')`), 'a Velocity proxy runs no Minecraft server: no EULA to accept');
  await js(`(${dialogButton('Cancel')}).click()`);

  check(await create({ name: 'survival', kind: 'paper', mc: '1.20.1', memory: '2G', port: 25611 }), 'a Paper server is created');
  const desc = JSON.parse(readFileSync(path.join(serverDir('survival'), 'pyide-server.json'), 'utf8'));
  check(desc.kind === 'paper' && desc.java === 17 && desc.build === 7 && /eula=true/.test(readFileSync(path.join(serverDir('survival'), 'eula.txt'), 'utf8')),
    `the server is described with its Java from Mojang's data, and eula.txt records the agreement (${S(desc)})`);
  check(await create({ name: 'purp', kind: 'purpur', mc: '1.20.1', memory: '2G', port: 25614 }), 'a Purpur server is created');
  check(JSON.parse(readFileSync(path.join(serverDir('purp'), 'pyide-server.json'), 'utf8')).build === 99, "Purpur's build is checked against the MD5 its service lists");
  check(!(await create({ name: 'broken', kind: 'vanilla', mc: '1.19.4', memory: '2G', port: 25612 })) && !existsSync(serverDir('broken')),
    'a download whose checksum does not match leaves no server behind');

  // ---------- running ----------
  await until(`!!${card('survival')}`, 'paper card');
  await startServer('survival');
  check(true, 'Start runs the server in a Run tab');
  await until(`ide.ports.state().ports.some((p) => p.port === 25611)`, 'port listed', 20000)
    .then(() => check(true, 'its port shows in the Ports window'), () => check(false, 'its port shows in the Ports window'));
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Port 25611 is available'))`, 'port note', 10000).catch(() => {});
  check(await js(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Port 25611 is available') && n.textContent.includes('localhost:25611') && !n.textContent.includes('Open in Browser'))`),
    'the game port is announced as TCP (host:port, no Open in Browser)');
  await js(`(() => { const s = ${runTab('survival')}; ide.proc.input(s.procId, 'list\\n'); return true; })()`);
  await until(`(${runTab('survival')}).host.textContent.includes('Unknown command: list')`, 'console command', 10000);
  check(true, 'the console sends commands to the server');
  await stopServer('survival');
  check((await tabText('survival')).includes('Stopping the server') && existsSync(path.join(serverDir('survival'), 'world.saved')), 'Stop asks the server to save and quit ("stop"), not a kill');

  // ---------- plugin ----------
  await js(`(${card('survival')}.querySelector('.mc-plugin').click(), true)`);
  await until(`!!document.querySelector('#mcPluginName')`, 'plugin dialog');
  await js(`(() => { document.querySelector('#mcPluginServer').value = 'survival'; document.querySelector('#mcPluginName').value = 'HelloPlugin'; document.querySelector('#mcPluginPkg').value = 'com.example.hello'; return true; })()`);
  await js(`(${dialogButton('Create')}).click()`);
  const pluginDir = path.join(project, 'plugins', 'HelloPlugin');
  const main = path.join(pluginDir, 'src', 'main', 'java', 'com', 'example', 'hello', 'HelloPlugin.java');
  await until(`ide.activeTab()?.path.toLowerCase() === ${S(main.toLowerCase())}`, 'plugin source open', 15000);
  check(/api-version: '1\.20'/.test(readFileSync(path.join(pluginDir, 'src', 'main', 'resources', 'plugin.yml'), 'utf8')), 'New Plugin writes the class and plugin.yml (api-version 1.20) and opens the class');
  const classpath = () => readFileSync(path.join(pluginDir, '.classpath'), 'utf8');
  check(existsSync(path.join(pluginDir, '.project')) && /kind="src" path="src\/main\/java"/.test(classpath()) && /paper-api\.jar/.test(classpath())
    && /compliance=17/.test(readFileSync(path.join(pluginDir, '.settings', 'org.eclipse.jdt.core.prefs'), 'utf8')),
  'the plugin has Eclipse project files with its sources, the server\'s API and Java 17, for the editor\'s Java support');
  await until(`!!${card('survival')}.querySelector('.mc-build[data-project="HelloPlugin"] .mc-add-lib')`, 'plugin listed', 10000);

  await js(`(${card('survival')}.querySelector('.mc-build[data-project="HelloPlugin"] .mc-add-lib').click(), true)`);
  await until(`!!document.querySelector('#mcLibCoords')`, 'library dialog');
  await js(`(() => { document.querySelector('#mcLibCoords').value = 'net.test:api:1.0'; document.querySelector('#mcLibRepo').value = 'custom'; document.querySelector('#mcLibUrl').value = ${S(`${base.replace('http:', 'https:')}/maven`)}; document.querySelector('#mcLibDepend').value = 'TestPlugin'; return true; })()`);
  await js(`(${dialogButton('Add')}).click()`);
  await until(`!!document.querySelector('.mc-dialog-error')?.textContent`, 'https required', 10000);
  check(/https|Checksum|fetch/i.test(await js(`document.querySelector('.mc-dialog-error').textContent`)), 'a repository is reached over https only');
  await js(`(${dialogButton('Cancel')}).click()`);
  const added = await js(`ide.api.invoke('minecraft:addDependency', ide.root, { dir: ${S(pluginDir)}, coords: 'net.test:api:1.0', repo: 'https://unused', depend: null }, 'x').then(() => 'ok', (e) => e.message)`);
  check(/https|fetch|failed/i.test(added), `an unreachable repository fails cleanly (${added.slice(0, 120)})`);

  await startServer('survival');
  const before = starts(serverDir('survival'));
  await js(`(${card('survival')}.querySelector('.mc-build[data-project="HelloPlugin"] .mc-build-run').click(), true)`);
  await until(`(${runTab('Build HelloPlugin')})?.host.textContent.includes('Plugin built and copied')`, 'plugin built', 60000)
    .catch(async (e) => { console.log(await tabText('Build HelloPlugin')); throw e; });
  const listing = execFileSync(bin('jar'), ['--list', '--file', path.join(serverDir('survival'), 'plugins', 'HelloPlugin.jar')], { encoding: 'utf8' });
  check(/plugin\.yml/.test(listing) && /com\/example\/hello\/HelloPlugin\.class/.test(listing), 'the plugin compiles against the server\'s libraries and its jar goes to plugins/');
  await until(`(${runTab('survival')}).host.textContent.includes('Enabled HelloPlugin.jar')`, 'plugin enabled', 60000).catch(() => {});
  check(starts(serverDir('survival')) === before + 1 && (await tabText('survival')).includes('Enabled HelloPlugin.jar'), 'the running server restarts and the plugin\'s onEnable runs');
  await stopServer('survival');

  // ---------- debugging ----------
  const line = readFileSync(main, 'utf8').split('\n').findIndex((l) => l.includes('getLogger().info')) + 1;
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 1 }), ide.runAction('ToggleLineBreakpoint'), true)`);
  await js(`(${card('survival')}.querySelector('.mc-debug').click(), true)`);
  await until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return !!f && f.path?.endsWith('HelloPlugin.java') && f.line === ${line}; })()`, 'breakpoint hit', 60000)
    .then(() => check(true, `Debug stops at a breakpoint in the plugin's onEnable (HelloPlugin.java:${line})`), async () => check(false, `Debug stops at the plugin's breakpoint: ${S(await js('window.__debugger.state()'))}`));
  await js(`(ide.runAction('StopDebug'), true)`);
  await until(`!window.__debugger.state()`, 'debug ended', 20000);
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 1 }), ide.runAction('ToggleLineBreakpoint'), true)`);

  // ---------- resource pack ----------
  await js(`(${card('survival')}.querySelector('.mc-rp').click(), true)`);
  const mcmeta = path.join(serverDir('survival'), 'resourcepack', 'pack.mcmeta');
  await until(`ide.api.exists(${S(mcmeta)})`, 'resource pack folder', 15000);
  check(JSON.parse(readFileSync(mcmeta, 'utf8')).pack.pack_format === 15, 'the resource pack gets the format of the server\'s Minecraft (version.json in its jar)');
  write(path.join(serverDir('survival'), 'resourcepack', 'assets', 'minecraft', 'textures', 'block', 'stone.png'), 'png');
  await until(`!!${card('survival')}.querySelector('.mc-rp-send')`, 'send button', 10000);
  await js(`(${card('survival')}.querySelector('.mc-rp-send').click(), true)`);
  await until(`(${runTab('Minecraft: Resource Pack')})?.host.textContent.includes('server.properties now sends players')`, 'pack sent', 60000)
    .catch(async (e) => { console.log(await tabText('Minecraft: Resource Pack')); throw e; });
  const props = readFileSync(path.join(serverDir('survival'), 'server.properties'), 'utf8');
  const zip = path.join(serverDir('survival'), 'client-pack', 'resourcepack.zip');
  const names = JSON.parse(execFileSync('py', ['-3', '-I', '-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist()))', zip], { encoding: 'utf8' }));
  check(/^resource-pack=https\\:\/\/fake-port-\d+\.trycloudflare\.com\/resourcepack\.zip$/m.test(props) && props.includes(`resource-pack-sha1=${sha('sha1', readFileSync(zip))}`)
    && /^require-resource-pack=true$/m.test(props) && names.includes('pack.mcmeta') && names.includes('assets/minecraft/textures/block/stone.png'),
  `players get the resource pack on joining: server.properties names its public address and SHA-1 and requires it (${S(names)})`);

  // ---------- Velocity ----------
  check(await create({ name: 'proxy', kind: 'velocity', mc: '4.3.1', memory: '1G', port: 25613 }), 'a Velocity proxy is created');
  await until(`!!${card('proxy')}`, 'proxy card');
  await startServer('proxy');
  const toml = readFileSync(path.join(serverDir('proxy'), 'velocity.toml'), 'utf8');
  const secret = readFileSync(path.join(serverDir('proxy'), 'forwarding.secret'), 'utf8').trim();
  const paperGlobal = readFileSync(path.join(serverDir('survival'), 'config', 'paper-global.yml'), 'utf8');
  check(/^bind = "0\.0\.0\.0:25613"$/m.test(toml) && /^"survival" = "127\.0\.0\.1:25611"$/m.test(toml) && /^"purp" = "127\.0\.0\.1:25614"$/m.test(toml)
    && /^try = \["(purp|survival)", "(purp|survival)"\]$/m.test(toml) && /player-info-forwarding-mode = "MODERN"/.test(toml),
  'the proxy lists the project\'s Paper and Purpur servers and forwards players to them (modern forwarding)');
  check(paperGlobal.includes(`secret: '${secret}'`) && /velocity:\n {4}enabled: true/.test(paperGlobal)
    && /^online-mode=false$/m.test(readFileSync(path.join(serverDir('survival'), 'server.properties'), 'utf8')),
  'each Paper server takes the proxy\'s forwarding secret, and leaves the account check to the proxy');
  check((await tabText('proxy')).includes('Players are sent on to:'), 'the proxy\'s console says where players go');
  await stopServer('proxy');
  check((await tabText('proxy')).includes('Stopping the server'), 'Stop ends the proxy with its own command ("end")');

  // ---------- Forge, mod, client pack ----------
  check(await create({ name: 'modded', kind: 'forge', mc: '1.20.1', memory: '2G', port: 25612 }), 'a Forge server is created');
  const forge = JSON.parse(readFileSync(path.join(serverDir('modded'), 'pyide-server.json'), 'utf8'));
  check(forge.loader === '47.9.9' && /win_args\.txt$/.test(forge.launch.argsFile || '') && !readdirSync(serverDir('modded')).some((n) => /installer/.test(n)),
    `Forge's installer ran and the server starts from its argument files (${S(forge.launch)})`);
  await until(`!!${card('modded')}`, 'forge card');
  await startServer('modded');
  check(/@user_jvm_args\.txt @libraries\/net\/minecraftforge\/forge\/1\.20\.1-47\.9\.9\/win_args\.txt nogui/.test(await tabText('modded')), 'the Forge server runs with -Xmx and its @argument files');
  await stopServer('modded');

  await js(`(${card('modded')}.querySelector('.mc-mod').click(), true)`);
  await until(`!!document.querySelector('#mcModId')`, 'mod dialog');
  await js(`(() => { document.querySelector('#mcModId').value = 'mymod'; document.querySelector('#mcModName').value = 'My Mod'; document.querySelector('#mcModPkg').value = 'com.example.mymod'; return true; })()`);
  await js(`(${dialogButton('Create')}).click()`);
  await until(`!!${card('modded')}.querySelector('.mc-build[data-project="mymod"]')`, 'mod listed', 30000)
    .catch(async (e) => { console.log(await tabText('Minecraft: New Mod')); throw e; });
  const modDir = path.join(project, 'mods', 'mymod');
  const modMain = path.join(modDir, 'src', 'main', 'java', 'com', 'example', 'mymod', 'Mymod.java');
  check(existsSync(modMain) && /^package com\.example\.mymod;/m.test(readFileSync(modMain, 'utf8')) && /MODID = "mymod"/.test(readFileSync(modMain, 'utf8'))
    && existsSync(path.join(modDir, 'src', 'main', 'resources', 'assets', 'mymod', 'lang', 'en_us.json'))
    && /^mod_id=mymod$/m.test(readFileSync(path.join(modDir, 'gradle.properties'), 'utf8')) && /^mod_name=My Mod$/m.test(readFileSync(path.join(modDir, 'gradle.properties'), 'utf8')),
  'New Mod renames the MDK to the mod id, name and package (class, package folders, assets, gradle.properties)');
  await until(`ide.activeTab()?.path.toLowerCase() === ${S(modMain.toLowerCase())}`, 'mod class open', 10000)
    .then(() => check(true, 'the mod\'s main class opens'), () => check(false, 'the mod\'s main class opens'));
  await js(`(${card('modded')}.querySelector('.mc-build[data-project="mymod"] .mc-build-run').click(), true)`);
  await until(`(${runTab('Deploy mymod')})?.host.textContent.includes('Mod copied to')`, 'mod deployed', 60000)
    .catch(async (e) => { console.log(await tabText('Deploy mymod')); throw e; });
  const modLog = await tabText('Deploy mymod');
  check(modLog.includes(`JAVA_HOME=${javaHome}`) && modLog.includes('task build'), 'the mod builds with gradlew and the server\'s Java (JAVA_HOME)');
  check(S(readdirSync(path.join(serverDir('modded'), 'mods'))) === S(['mymod-1.0.jar']), 'the built jar (not -sources) goes to the server\'s mods');

  await js(`(${card('modded')}.querySelector('.mc-pack').click(), true)`);
  const pack = path.join(serverDir('modded'), 'client-pack', 'modded-1.20.1.mrpack');
  await until(`ide.api.exists(${S(pack)})`, 'client pack', 20000);
  const read = JSON.parse(execFileSync('py', ['-3', '-I', '-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({"names": z.namelist(), "index": json.loads(z.read("modrinth.index.json"))}))', pack], { encoding: 'utf8' }));
  check(S(read.index.dependencies) === S({ minecraft: '1.20.1', forge: '47.9.9' }) && read.names.includes('overrides/mods/mymod-1.0.jar') && read.index.formatVersion === 1,
    `the client pack is a valid .mrpack naming Minecraft, Forge and the server's mods (${S(read)})`);
  check(await js(`${card('survival')}.querySelector('.mc-server-note').textContent`) === 'Plugins run on the server: players need nothing.', 'a Paper server says players need nothing');
  // ---------- drag and drop, modpacks ----------
  await dropOn(card('survival'), [pluginJar, fabricJar, worldDir, packZip]);
  await until(`(${runTab('Minecraft: Import')})?.host.textContent.includes('fabric-mod.jar')`, 'drop on a card', 30000);
  const importLog = await tabText('Minecraft: Import');
  check(existsSync(path.join(serverDir('survival'), 'plugins', 'extra-plugin.jar')) && /extra-plugin\.jar: plugin added → survival/.test(importLog), 'a plugin jar dropped on a Paper server goes to its plugins/');
  check(/fabric-mod\.jar: a Fabric mod: drop it on a Fabric server/.test(importLog) && !existsSync(path.join(serverDir('survival'), 'mods', 'fabric-mod.jar')), 'a Fabric mod dropped on a Paper server is refused with the reason');
  check(existsSync(path.join(serverDir('survival'), 'MyWorld', 'region', 'r.0.0.mca')) && /^level-name=MyWorld$/m.test(readFileSync(path.join(serverDir('survival'), 'server.properties'), 'utf8')),
    'a world folder dropped on a server is copied and becomes its level-name');
  check(/dropped/.test(readFileSync(path.join(serverDir('survival'), 'resourcepack', 'pack.mcmeta'), 'utf8')) && existsSync(path.join(serverDir('survival'), 'resourcepack', 'assets', 'minecraft', 'textures', 'item', 'apple.png')),
    'a resource pack zip dropped on a server is unpacked into its resourcepack/');

  await dropOn(`document.querySelector('#minecraftTool .mc-bar')`, [oldServer]);
  await until(`!!${card('OldServer')}`, 'imported server', 30000);
  const old = JSON.parse(readFileSync(path.join(serverDir('OldServer'), 'pyide-server.json'), 'utf8'));
  check(old.kind === 'vanilla' && old.mc === '1.20.1' && old.java === 17 && old.imported && readFileSync(path.join(serverDir('OldServer'), 'eula.txt'), 'utf8') === 'eula=false\n'
    && existsSync(path.join(oldServer, 'server.jar')),
  `a server folder dropped on the window is copied into servers/ and recognized, its eula.txt left as it was (${S(old)})`);

  await dropOn(`document.querySelector('#minecraftTool .mc-bar')`, [mrpack]);
  await until(`/Test Pack 1\\.0: Minecraft 1\\.20\\.1, Forge 47\\.9\\.9\\. 1 files for the server/.test(document.querySelector('#mcPackInfo')?.textContent || '')`, 'modpack dialog', 20000)
    .then(() => check(true, 'a dropped .mrpack opens New Server from Modpack with what it holds'), async () => check(false, `modpack dialog: ${await js("document.querySelector('#mcPackInfo')?.textContent")}`));
  check(await js(`document.querySelector('#mcPackName').value`) === 'Test-Pack', 'the server is named after the modpack');
  await js(`(${dialogButton('Create')}).click()`);
  check(/accept the Minecraft EULA/.test(await js(`document.querySelector('.mc-dialog-error').textContent`)), 'a modpack server also waits for the EULA');
  await js(`(document.querySelector('#mcPackEula').checked = true, true)`);
  await js(`(${dialogButton('Create')}).click()`);
  await until(`!!${card('Test-Pack')}`, 'modpack server', 60000).catch(async (e) => { console.log(await tabText('Minecraft: New Server')); throw e; });
  const packDir2 = serverDir('Test-Pack');
  const packDesc = JSON.parse(readFileSync(path.join(packDir2, 'pyide-server.json'), 'utf8'));
  check(packDesc.kind === 'forge' && packDesc.loader === '47.9.9' && packDesc.modpack?.name === 'Test Pack', `the server runs the modpack's Minecraft and exact loader (${S(packDesc.modpack)})`);
  check(readFileSync(path.join(packDir2, 'mods', 'server-mod.jar'), 'utf8') === 'server mod' && !existsSync(path.join(packDir2, 'mods', 'client-mod.jar'))
    && existsSync(path.join(packDir2, 'config', 'pack.toml')) && existsSync(path.join(packDir2, 'server-only.txt')) && !existsSync(path.join(packDir2, 'options.txt')),
  'the server gets the modpack\'s server files (checksums checked), overrides and server-overrides, not its client-only files');
  await js(`(${card('Test-Pack')}.querySelector('.mc-pack').click(), true)`);
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('The modpack Test Pack'))`, 'modpack client pack', 10000)
    .then(() => check(true, 'its client pack is the modpack itself (with the client mods)'), () => check(false, 'its client pack is the modpack itself'));
  check(existsSync(path.join(packDir2, 'client-pack', 'Test Pack.mrpack')), 'the .mrpack is kept as the server\'s client pack');
  await shot('window.png');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
await js(`ide.run.sessions().forEach((s) => s.running && s.stop())`).catch(() => {});
await sleep(1500);
server.close();
t.finish();
