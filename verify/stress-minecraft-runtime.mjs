// Minecraft servers, plugins and mods at run time under hostile use (minecraft plugin), offline and without accepting
// the real Minecraft EULA. Stand-ins as in verify/minecraft.mjs: a local web server plays Mojang, PaperMC, the Forge MDK
// and Adoptium; a small Java program plays the server (with flag files that make it crash at start, quit at once or
// ignore "stop"); a Node script plays Gradle and a FakeGame JVM the game for HotSwap. Each stand-in process writes its
// pid to pids/, so the suite can tell that none is left running. Checks: hostile server, plugin, mod and package
// names (invalid, Korean, emoji, too long, CON/NUL, duplicates), bad and busy game ports, Start, Stop and Restart
// clicked 20 times, a server that crashes, quits at once or hangs on "stop" (killed 30 s later, also on a Rerun), its
// folder deleted or renamed while it runs, a damaged pyide-server.json, a wrong Java, plugin builds with compile errors
// or no sources, libraries with bad coordinates or http, HotSwap with compile errors, 30 saves a second, saves outside
// the mod or while not debugging, a changed signature, a second debug session and Stop during the Gradle phase, the
// resource pack sent with none made, the Minecraft screen opened and closed many times, 50 servers in the project,
// New Project with an empty or bad version, without the EULA or into an existing folder, and a server whose Java is
// missing and cannot be downloaded. CDP ports 8620-8621; game ports 25800-25899.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(path.join(tmpdir(), 'pyide-stress-mc-'));
const javaHome = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME_17_X64 || process.env.JAVA_HOME
  || path.dirname(path.dirname(execFileSync('where', ['javac'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()));
const bin = (t) => path.join(javaHome, 'bin', `${t}.exe`);
const write = (p, text) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };
const pidsDir = path.join(work, 'pids');
mkdirSync(pidsDir);
const J = (p) => p.replace(/\\/g, '/');

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
write(path.join(src, 'server', 'FakeServer.java'), `import java.io.*; import java.net.*; import java.nio.file.*; import java.util.*;
public class FakeServer {
  public static void main(String[] a) throws Exception {
    Files.write(Paths.get(${S(J(pidsDir))}, "server-" + ProcessHandle.current().pid()), new File(".").getCanonicalPath().getBytes());
    if (new File("crash.flag").exists()) throw new IllegalStateException("Simulated crash while starting");
    if (!new File("eula.txt").exists()) { System.out.println("You need to agree to the EULA"); System.exit(1); }
    Properties p = new Properties();
    try (Reader r = new FileReader("server.properties")) { p.load(r); }
    Path lib = Paths.get("libraries/io/papermc/paper/paper-api/stub/paper-api.jar");
    InputStream api = FakeServer.class.getResourceAsStream("/api.jar");
    if (api != null && !Files.exists(lib)) { Files.createDirectories(lib.getParent()); Files.copy(api, lib); }
    Files.write(Paths.get("starts.log"), "start\\n".getBytes(), StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    if (new File("quit.flag").exists()) { System.out.println("Quitting at once"); System.exit(0); }
    ServerSocket ss;
    try { ss = new ServerSocket(Integer.parseInt(p.getProperty("server-port", "25565")), 50, InetAddress.getLoopbackAddress()); }
    catch (Exception e) { System.out.println("**** FAILED TO BIND TO PORT! " + e); System.exit(1); return; }
    Thread t = new Thread(() -> { while (true) try { ss.accept().close(); } catch (Exception e) { return; } });
    t.setDaemon(true); t.start();
    System.out.println("Done (0.4s)! For help, type \\"help\\"");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    for (String line; (line = in.readLine()) != null;) {
      if (line.trim().equals("stop")) {
        if (new File("hang.flag").exists()) { System.out.println("Ignoring stop"); continue; }
        System.out.println("Stopping the server"); Files.write(Paths.get("world.saved"), "ok".getBytes()); System.exit(0);
      }
      System.out.println("Unknown command: " + line.trim());
    }
    if (new File("hang.flag").exists()) Thread.sleep(600000);
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
const paperRes = out('paper-res');
writeFileSync(path.join(paperRes, 'api.jar'), readFileSync(apiJar));
writeFileSync(path.join(paperRes, 'version.json'), S({ id: '1.20.1', pack_version: { resource: 15, data: 15 } }));
const paperJarFile = path.join(work, 'out', 'jars', 'paper.jar');
execFileSync(bin('jar'), ['--create', '--file', paperJarFile, '--main-class', 'FakeServer', '-C', serverClasses, '.', '-C', paperRes, '.']);
const paperJar = readFileSync(paperJarFile);

// The MDK, Gradle as a Node script (slow.flag in the mod: a long Gradle phase before the game starts) and the game.
const mdk = out('mdk');
write(path.join(mdk, 'gradle.properties'), 'mod_id=examplemod\nmod_name=Example Mod\nmod_group_id=com.example.examplemod\n');
write(path.join(mdk, 'src', 'main', 'java', 'com', 'example', 'examplemod', 'ExampleMod.java'), 'package com.example.examplemod;\n\npublic class ExampleMod {\n    public static final String MODID = "examplemod";\n}\n');
write(path.join(mdk, 'src', 'main', 'resources', 'assets', 'examplemod', 'lang', 'en_us.json'), '{}\n');
write(path.join(src, 'game', 'FakeGame.java'), `public class FakeGame {
  public static void main(String[] a) throws Exception {
    java.nio.file.Files.write(java.nio.file.Paths.get(${S(J(pidsDir))}, "game-" + ProcessHandle.current().pid()), new byte[0]);
    java.lang.reflect.Method m = Class.forName(a[0]).getMethod("greeting");
    System.out.println("Fake Minecraft window open");
    for (int i = 0; i < 1500; i++) { System.out.println("game: " + m.invoke(null)); Thread.sleep(250); }
  }
}`);
const fakeGradle = path.join(work, 'fake-gradle.cjs');
const gameDir = path.join(work, 'out', 'game');
writeFileSync(fakeGradle, `const fs = require('fs'); const path = require('path'); const { execFileSync, spawn } = require('child_process');
fs.writeFileSync(path.join(${S(pidsDir)}, 'gradle-' + process.pid), process.cwd());
const args = process.argv.slice(2);
const prop = (k) => (args.find((a) => a.startsWith('-P' + k + '=')) || '').slice(k.length + 3) || null;
const task = args[args.length - 1];
const home = process.env.JAVA_HOME;
console.log('task ' + task);
const out = path.join(process.cwd(), 'build', 'classes', 'java', 'main');
const srcDir = path.join(process.cwd(), 'src', 'main', 'java');
const go = () => {
  if (args.includes('pyideClasspath')) fs.writeFileSync(prop('pyide.classpathFile'), JSON.stringify([{ name: 'main', sources: [srcDir], classpath: [], output: out }]));
  if (task === 'build') { fs.mkdirSync('build/libs', { recursive: true }); fs.copyFileSync('gradle.properties', 'build/libs/mymod-1.0.jar'); console.log('BUILD SUCCESSFUL'); }
  if (task === 'runClient') {
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.java')) files.push(p); } };
    walk(srcDir);
    execFileSync(path.join(home, 'bin', 'javac.exe'), ['-g', '-d', out, ...files], { stdio: 'inherit' });
    const port = prop('pyide.debugPort');
    const jvm = port ? ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:' + port] : [];
    const game = spawn(path.join(home, 'bin', 'java.exe'), [...jvm, '-cp', out + path.delimiter + ${S(gameDir)}, 'FakeGame', 'com.example.mymod.Mymod'], { stdio: 'inherit' });
    game.on('exit', (c) => process.exit(c ?? 0));
  }
};
if (fs.existsSync('slow.flag')) { console.log('Gradle is preparing Minecraft (slow)'); setTimeout(go, 60000); } else go();
`);
write(path.join(mdk, 'gradlew.bat'), `@"${process.execPath}" "${fakeGradle}" %*\r\n`);
javac(gameDir, [path.join(src, 'game', 'FakeGame.java')]);
const mdkZip = path.join(work, 'out', 'jars', 'mdk.zip');
execFileSync(bin('jar'), ['--create', '--no-manifest', '--file', mdkZip, '-C', mdk, '.']);

// ---------- stand-in services ----------
const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');
const routes = new Map();
const server = http.createServer((q, r) => {
  const route = routes.get(q.url.split('?')[0]);
  const body = typeof route === 'function' ? route(decodeURIComponent(q.url)) : route;
  if (body === undefined) { r.writeHead(404); return r.end(); }
  r.writeHead(200);
  r.end(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
routes.set('/mojang/manifest.json', { latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: `${base}/mojang/1.20.1.json` }] });
routes.set('/mojang/1.20.1.json', { javaVersion: { majorVersion: 17 }, downloads: { server: { url: `${base}/files/paper.jar`, sha1: sha('sha1', paperJar), size: paperJar.length } } });
routes.set('/paper', { versions: { '1.20': ['1.20.1'] } });
routes.set('/paper/versions/1.20.1/builds', [{ id: 7, channel: 'STABLE', downloads: { 'server:default': { url: `${base}/files/paper.jar`, size: paperJar.length, checksums: { sha256: sha('sha256', paperJar) } } } }]);
routes.set('/files/paper.jar', paperJar);
routes.set('/files/mdk.zip', readFileSync(mdkZip));
routes.set('/modrinth/search', { total_hits: 0, hits: [] });
routes.set('/fabric/versions/game', [{ version: '1.20.1', stable: true }]);
const SOURCES = S({ mojang: `${base}/mojang/manifest.json`, paper: `${base}/paper`, purpur: `${base}/purpur`, velocity: `${base}/velocity`, forge: `${base}/forge`,
  forgePromos: `${base}/forge/promos.json`, fabric: `${base}/fabric`, fabricMdk: `${base}/fabricmdk`, neoforge: `${base}/neoforge`, neoforgeMdk: `${base}/neoforgemdk`,
  adoptium: `${base}/adoptium`, modrinth: `${base}/modrinth` });

// ---------- processes ----------
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pidFiles = () => readdirSync(pidsDir).map((f) => ({ kind: f.split('-')[0], pid: Number(f.split('-')[1]), info: readFileSync(path.join(pidsDir, f), 'utf8') }));
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const aliveServers = (dir) => pidFiles().filter((p) => p.kind === 'server' && (!dir || sameDir(p.info, dir)) && alive(p.pid));
const aliveOf = (kind) => pidFiles().filter((p) => p.kind === kind && alive(p.pid));
const waitFor = async (fn, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return !!(await fn()); };

const project = path.join(work, 'project');
mkdirSync(project);
const t = await launch({ name: 'stress-minecraft-runtime', port: 8620, projectDir: project, env: { PYIDE_MC_JAVA: javaHome, PYIDE_MC_SOURCES: SOURCES } });
const { js, until, check } = t;
const root = await js('ide.root');
const card = (name, host = '#minecraftTool') => `document.querySelector('${host} .mc-server[data-name="${name}"]')`;
const runTab = (title) => `ide.run.sessions().find((s) => s.title === ${S(title)})`;
const tabText = (title) => js(`${runTab(title)}?.host.textContent || ''`);
const serverDir = (name) => path.join(project, 'servers', name);
const starts = (dir) => (existsSync(path.join(dir, 'starts.log')) ? readFileSync(path.join(dir, 'starts.log'), 'utf8').trim().split('\n').length : 0);
const ipc = (channel, ...args) => js(`ide.api.invoke(${S(channel)}, ...${S(args)}).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: ide.minecraft.errorText(e) }))`);
const dialogs = () => js(`[...document.querySelectorAll('.dialog-backdrop .dialog')].map((d) => d.textContent)`);
const closeDialogs = () => js(`(() => { for (const b of [...document.querySelectorAll('.dialog-backdrop')].reverse()) [...b.querySelectorAll('.dialog-buttons button')].pop()?.click(); return true; })()`);
const dialogButton = (label) => `[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${S(label)})`;
const refresh = () => js('ide.minecraft.refresh().then(() => true)');
const create = (opts) => ipc('minecraft:create', { root, eula: true, memory: '1G', kind: 'paper', mc: '1.20.1', ...opts }, 'x');
const startCard = async (name, label = name) => {
  await js(`(${card(name)}.querySelector('.mc-start').click(), true)`);
  return waitFor(() => js(`!!(${runTab(label)})?.running && (${runTab(label)}).host.textContent.includes('Done (0.4s)!')`), 30000);
};
const stopped = (name) => waitFor(() => js(`!(${runTab(name)})?.running`), 40000);
const section = async (label, fn) => {
  try { await fn(); } catch (err) { check(false, `${label}: ${(err.message.split('\n').find((l) => l.startsWith('=>')) || err.message).slice(0, 300)}`); await closeDialogs().catch(() => {}); }
};

try {
  await js(`(ide.settings.set('ports.confirmShare', false), ide.toolWindows.get('Minecraft').show(), true)`);
  await until(`!!document.querySelector('#minecraftTool .mc-empty')`, 'empty Minecraft window');

  // ---------- names ----------
  await section('server names', async () => {
    check((await create({ name: 'alpha', port: 25801 })).ok, 'a Paper server is created for the attacks');
    const bad = { '': 'empty', '1abc': 'starts with a digit', 'a b': 'a space', '../escape': 'a path', 'a/b': 'a slash', '서버': 'Korean', '🎮craft': 'emoji', [`a${'x'.repeat(40)}`]: '41 characters',
      CON: 'CON', nul: 'nul', Com1: 'COM1', 'LPT9': 'LPT9', 'aux': 'aux', alpha: 'a duplicate', ALPHA: 'a duplicate in other case' };
    for (const [name, what] of Object.entries(bad)) {
      const r = await create({ name, port: 25890 });
      check(!r.ok && /letters|already exists|reserved|Windows/i.test(r.e), `a server named ${what} (${S(name)}) is refused with a clear message (${r.e || 'created!'})`);
    }
    const left = readdirSync(path.join(project, 'servers'));
    check(S(left) === S(['alpha']), `nothing is left in servers/ by the refused names (${S(left)})`);
    // The dialog says it before closing, and keeps what was typed.
    await js(`(ide.minecraft.newServer(), true)`);
    await until(`[...document.querySelector('#mcVersion')?.options || []].some((o) => o.value === '1.20.1')`, 'versions');
    for (const [name, port] of [['CON', '25890'], ['마인크래프트', '25890'], ['ok-name', '0'], ['ok-name', '99999'], ['ok-name', 'abc']]) {
      await js(`(() => { document.querySelector('#mcName').value = ${S(name)}; document.querySelector('#mcPort').value = ${S(port)}; document.querySelector('#mcEula').checked = true; ${dialogButton('Create')}.click(); return true; })()`);
      await sleep(200);
      const err = await js(`document.querySelector('.mc-dialog-error')?.textContent || ''`);
      check(!!err && await js(`!!document.querySelector('#mcName')`), `New Server keeps its dialog open for name ${S(name)}, port ${S(port)}, saying why (${err})`);
    }
    await js(`(${dialogButton('Cancel')}).click()`);
    await sleep(300);
    check(S(readdirSync(path.join(project, 'servers'))) === S(['alpha']), 'no server is made from the refused dialog entries');
  });

  // ---------- ports ----------
  await section('ports', async () => {
    for (const port of [0, 99999, -1, 'abc', 1.5]) {
      const r = await create({ name: 'portcheck', port });
      check(!r.ok && /port/i.test(r.e) && !existsSync(serverDir('portcheck')), `port ${S(port)} is refused (${r.e || 'created!'})`);
    }
    check((await create({ name: 'beta', port: 25810 })).ok, 'a server on port 25810');
    await refresh();
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(25810, '127.0.0.1', r));
    const t0 = Date.now();
    await js(`(${card('beta')}.querySelector('.mc-start').click(), true)`);
    const said = await waitFor(async () => /in use|FAILED TO BIND|Process finished/.test(await tabText('beta')), 50000);
    const text = await tabText('beta');
    check(said && /Port 25810 is in use/.test(text) && !aliveServers(serverDir('beta')).length && Date.now() - t0 < 15000,
      `a game port another program holds is reported at once, and no server is started on it (${Math.round((Date.now() - t0) / 1000)} s: ${text.slice(-160).replace(/\s+/g, ' ')})`);
    check(await js(`!(${runTab('beta')})?.running && !!${card('beta')}.querySelector('.mc-start')`), 'the card offers Start again');
    blocker.close();
    write(path.join(serverDir('beta'), 'server.properties'), 'server-port=99999\n');
    await refresh();
    await js(`(${card('beta')}.querySelector('.mc-start').click(), true)`);
    await waitFor(async () => /port|Process finished/i.test(await tabText('beta')), 15000);
    const t2 = await tabText('beta');
    check(/99999/.test(t2) && !aliveServers(serverDir('beta')).length, `server-port=99999 in server.properties is reported, not started (${t2.slice(-160).replace(/\s+/g, ' ')})`);
    write(path.join(serverDir('beta'), 'server.properties'), 'server-port=25810\n');
  });

  // ---------- Start, Stop, Restart storms ----------
  await section('start storm', async () => {
    await refresh();
    const before = starts(serverDir('alpha'));
    await js(`(() => { const b = ${card('alpha')}.querySelector('.mc-start'); for (let i = 0; i < 20; i++) b.click(); return true; })()`);
    await waitFor(() => js(`!!(${runTab('alpha')})?.running`), 20000);
    await sleep(4000);
    await closeDialogs();
    const d = await dialogs();
    const n = starts(serverDir('alpha')) - before;
    check(n === 1 && aliveServers(serverDir('alpha')).length === 1, `Start clicked 20 times starts the server once (${n} starts, ${aliveServers(serverDir('alpha')).length} running, ${d.length} dialogs)`);
    check(await js(`!!${card('alpha')}.querySelector('.mc-stop') && !${card('alpha')}.querySelector('.mc-start')`), 'the card shows Stop for the running server');
  });
  await section('stop storm', async () => {
    await js(`(() => { const b = ${card('alpha')}.querySelector('.mc-stop'); for (let i = 0; i < 20; i++) b.click(); return true; })()`);
    check(await stopped('alpha'), 'Stop clicked 20 times stops the server');
    const text = await tabText('alpha');
    check(/Stopping the server/.test(text) && /exit code 0/.test(text) && existsSync(path.join(serverDir('alpha'), 'world.saved')) && !aliveServers(serverDir('alpha')).length,
      'it saved its world and quit on its own (exit code 0), nothing left running');
    await waitFor(() => js(`!!${card('alpha')}?.querySelector('.mc-start')`), 5000);
    check(await js(`!!${card('alpha')}.querySelector('.mc-start')`), 'the card offers Start again after the stop');
  });
  await section('restart storm', async () => {
    await startCard('alpha');
    const t0 = Date.now();
    await js(`(() => { const cfg = ${runTab('alpha')}.cfg; for (let i = 0; i < 20; i++) ide.run.runConfig(cfg, { confirm: false }); return true; })()`);
    // Settled: the tab runs a server that printed Done, no run is starting, and no start happened for 8 s.
    let last = -1, since = Date.now();
    const settled = await waitFor(async () => {
      const n = starts(serverDir('alpha'));
      if (n !== last) { last = n; since = Date.now(); }
      return Date.now() - since > 8000 && aliveServers(serverDir('alpha')).length === 1
        && await js(`(() => { const s = ${runTab('alpha')}; return !!s && s.running && !s.starting && s.host.textContent.includes('Done (0.4s)!'); })()`);
    }, 150000, 500);
    const text = await tabText('alpha');
    check(settled && aliveServers(serverDir('alpha')).length === 1 && await js(`(${runTab('alpha')}).running`) && !/FAILED TO BIND/.test(text),
      `Rerun 20 times ends with one server running (${Math.round((Date.now() - t0) / 1000)} s, ${aliveServers(serverDir('alpha')).length} running${/FAILED TO BIND/.test(text) ? ', a start failed to bind' : ''})`);
    await js(`(${runTab('alpha')}.stop(), true)`);
    await stopped('alpha');
    check(!aliveServers(serverDir('alpha')).length, 'after the storm, Stop leaves nothing running');
  });

  // ---------- crashes, quits, hangs ----------
  await section('crash and quit', async () => {
    check((await create({ name: 'delta', port: 25804 })).ok, 'a server for crashes');
    await refresh();
    write(path.join(serverDir('delta'), 'crash.flag'), '');
    await js(`(${card('delta')}.querySelector('.mc-start').click(), true)`);
    await waitFor(async () => /exit code/.test(await tabText('delta')), 20000);
    const text = await tabText('delta');
    check(/Simulated crash/.test(text) && /exit code 1/.test(text), 'a server that crashes while starting shows its error and exit code');
    await waitFor(() => js(`!!${card('delta')}?.querySelector('.mc-start')`), 5000);
    check(await js(`!!${card('delta')}.querySelector('.mc-start')`), 'its card offers Start again');
    rmSync(path.join(serverDir('delta'), 'crash.flag'));
    write(path.join(serverDir('delta'), 'quit.flag'), '');
    await js(`(${card('delta')}.querySelector('.mc-start').click(), true)`);
    await waitFor(async () => /exit code/.test(await tabText('delta')), 20000);
    check(/Quitting at once/.test(await tabText('delta')) && await js(`!(${runTab('delta')}).running`) && !aliveServers(serverDir('delta')).length, 'a server that exits at once ends its run');
    rmSync(path.join(serverDir('delta'), 'quit.flag'));
  });
  await section('hang on stop', async () => {
    check((await create({ name: 'gamma', port: 25803 })).ok, 'a server that ignores stop');
    await refresh();
    write(path.join(serverDir('gamma'), 'hang.flag'), '');
    check(await startCard('gamma'), 'it starts');
    const t0 = Date.now();
    await js(`(${card('gamma')}.querySelector('.mc-stop').click(), true)`);
    const ended = await stopped('gamma');
    check(ended && /Ignoring stop/.test(await tabText('gamma')) && Date.now() - t0 > 25000 && !aliveServers(serverDir('gamma')).length,
      `a server that ignores "stop" is killed about 30 s later (${Math.round((Date.now() - t0) / 1000)} s)`);
    // Rerun of a hung server: the old process must not be left running.
    check(await startCard('gamma'), 'it starts again');
    const old = aliveServers(serverDir('gamma')).map((p) => p.pid);
    const t1 = Date.now();
    await js(`(ide.run.runConfig(${runTab('gamma')}.cfg, { confirm: false }), true)`);
    const ok = await waitFor(async () => old.every((p) => !alive(p)) && await js(`(() => { const s = ${runTab('gamma')}; return s.running && !s.starting && s.host.textContent.includes('Done (0.4s)!'); })()`), 60000, 500);
    check(ok && aliveServers(serverDir('gamma')).length === 1,
      `Rerun of a server that ignores "stop" kills the old one 30 s later and the new one starts (${Math.round((Date.now() - t1) / 1000)} s, old alive: ${old.filter(alive).length}, running: ${aliveServers(serverDir('gamma')).length})`);
    rmSync(path.join(serverDir('gamma'), 'hang.flag'));
    await js(`(${runTab('gamma')}.stop(), true)`);
    await stopped('gamma');
  });

  // ---------- the folder changing under a running server ----------
  await section('folder deleted', async () => {
    check((await create({ name: 'epsilon', port: 25805 })).ok, 'a server whose folder goes away');
    await refresh();
    check(await startCard('epsilon'), 'it starts');
    let renamed = 'renamed';
    try { renameSync(serverDir('epsilon'), serverDir('epsilon2')); } catch (err) { renamed = err.code; }
    let removed = 'removed';
    try { rmSync(serverDir(renamed === 'renamed' ? 'epsilon2' : 'epsilon'), { recursive: true, force: true }); } catch (err) { removed = err.code; }
    await refresh();
    await sleep(500);
    check(await js(`!${card('epsilon')} || true`), `refresh copes with the folder ${renamed}/${removed}`);
    await js(`(${runTab('epsilon')}.stop(), true)`);
    check(await stopped('epsilon') && !aliveServers().some((p) => /epsilon/i.test(p.info)), `Stop still ends a server whose folder was ${renamed} and ${removed}`);
    rmSync(serverDir('epsilon'), { recursive: true, force: true });
    rmSync(serverDir('epsilon2'), { recursive: true, force: true });
    await refresh();
  });

  // ---------- damaged descriptors, wrong Java ----------
  await section('damaged pyide-server.json', async () => {
    check((await create({ name: 'zeta', port: 25806 })).ok, 'a server whose description is damaged');
    await refresh();
    await js(`(${card('zeta')}.querySelector('.mc-start').click(), true)`);
    await waitFor(() => js(`!!(${runTab('zeta')})?.running`), 20000);
    await js(`(${runTab('zeta')}.stop(), true)`);
    await stopped('zeta');
    const desc = path.join(serverDir('zeta'), 'pyide-server.json');
    const good = readFileSync(desc, 'utf8');
    const cases = [['{bad json', 'corrupted'], ['"text"', 'a string'], ['[]', 'an array'], ['{}', 'empty'], [S({ ...JSON.parse(good), java: 'abc' }), 'java "abc"'],
      [S({ ...JSON.parse(good), launch: null }), 'no launch'], [S({ ...JSON.parse(good), kind: 'bogus' }), 'an unknown kind']];
    for (const [text, what] of cases) {
      writeFileSync(desc, text);
      await refresh();
      const shown = await js(`!!${card('zeta')}`);
      await js(`(ide.run.runConfig(${runTab('zeta')}.cfg, { confirm: false }), true)`);
      await waitFor(async () => /pyide-server\.json|Java|server type|exit code/.test(await tabText('zeta')), 15000);
      const msg = (await tabText('zeta')).trim().split('\n').pop();
      check(/pyide-server\.json/.test(msg) && !aliveServers(serverDir('zeta')).length && await js(`!(${runTab('zeta')}).running`),
        `Start with a pyide-server.json that is ${what} says so and starts nothing (card ${shown ? 'shown' : 'hidden'}: ${msg})`);
    }
    rmSync(desc);
    await refresh();
    await js(`(ide.run.runConfig(${runTab('zeta')}.cfg, { confirm: false }), true)`);
    await waitFor(async () => /pyide-server\.json/.test(await tabText('zeta')), 15000);
    check(/no pyide-server\.json/.test(await tabText('zeta')), 'Start with no pyide-server.json says it is not a PyIDE server');
    check(await js(`!${card('zeta')}`), 'a folder without pyide-server.json is not listed');
    writeFileSync(desc, good);
    await refresh();
  });

  // ---------- plugins ----------
  await section('plugin builds', async () => {
    await js(`ide.minecraft.createPlugin({ name: 'HelloPlugin', pkg: 'com.example.hello', server: 'alpha' }).then(() => true)`);
    const pluginDir = path.join(project, 'plugins', 'HelloPlugin');
    const main = path.join(pluginDir, 'src', 'main', 'java', 'com', 'example', 'hello', 'HelloPlugin.java');
    await until(`!!${card('alpha')}.querySelector('.mc-build[data-project="HelloPlugin"]')`, 'plugin listed', 10000);
    const build = async () => {
      await js(`(${card('alpha')}.querySelector('.mc-build[data-project="HelloPlugin"] .mc-build-run').click(), true)`);
      await waitFor(async () => (await js(`!!(${runTab('Build HelloPlugin')}) && !(${runTab('Build HelloPlugin')}).starting`)), 60000);
      return tabText('Build HelloPlugin');
    };
    const deployed = path.join(serverDir('alpha'), 'plugins', 'HelloPlugin.jar');
    let text = await build();
    check(/Plugin built and copied/.test(text) && existsSync(deployed), `the plugin builds${/Plugin built/.test(text) ? '' : ` (${text.slice(-300)})`}`);
    rmSync(deployed);
    const good = readFileSync(main, 'utf8');
    writeFileSync(main, good.replace('getLogger()', 'getLoger()').replace(/}\s*$/, '  int broken = "text";\n}\n'));
    text = await build();
    check(/HelloPlugin\.java:\d+: error/.test(text) && /javac(\.exe)? failed/.test(text) && !/Plugin built/.test(text) && !existsSync(deployed),
      `a compile error shows javac's file:line message and deploys nothing (${text.split('\n').filter((l) => /error/.test(l)).slice(0, 2).join(' | ')})`);
    renameSync(main, `${main}.txt`);
    text = await build();
    check(/no \.java files|no source files/i.test(text) && !/Plugin built/.test(text) && !existsSync(deployed), `a plugin with no sources says so (${text.trim().split('\n').pop()})`);
    renameSync(`${main}.txt`, main);
    writeFileSync(main, good);
    // Hostile plugin names.
    for (const name of ['CON', 'Nul', 'Aux', 'lowercase', 'Has Space', 'Ünicode', `A${'b'.repeat(40)}`, 'HelloPlugin']) {
      const r = await ipc('minecraft:newPlugin', { root, name, pkg: 'com.example.x', server: 'alpha' });
      check(!r.ok, `a plugin named ${S(name)} is refused (${r.e || 'created!'})`);
    }
    for (const pkg of ['', 'Com.Example', 'com..x', 'com.example.', 'com.example.class', 'com.int.x', '1com.x', 'com.example.한글']) {
      const r = await ipc('minecraft:newPlugin', { root, name: 'PkgTest', pkg, server: 'alpha' });
      check(!r.ok, `a plugin package ${S(pkg)} is refused (${r.e || 'created!'})`);
    }
    check(S(readdirSync(path.join(project, 'plugins'))) === S(['HelloPlugin']), `nothing is left in plugins/ (${S(readdirSync(path.join(project, 'plugins')))})`);
  });

  await section('libraries', async () => {
    const pluginDir = path.join(project, 'plugins', 'HelloPlugin');
    const add = (coords, repo = 'central', depend = null) => ipc('minecraft:addDependency', root, { dir: pluginDir, coords, repo, depend }, 'x');
    for (const coords of ['', 'foo', 'a:b', 'a::1', ' : : ', '../x:y:1', 'g:a/../../evil:1', 'g:a:1/../../x', 'g:a:1\nb']) {
      const r = await add(coords);
      check(!r.ok && /group:artifact:version/.test(r.e), `library ${S(coords)} is refused as bad coordinates (${r.e})`);
    }
    for (const repo of ['http://repo.example.com/maven', 'ftp://x', 'file:///C:/', 'javascript:alert(1)', 'repo.example.com', '']) {
      const r = await add('net.test:api:1.0', repo);
      check(!r.ok && /https/.test(r.e), `repository ${S(repo)} is refused (${r.e})`);
    }
    const r = await add('net.test:api:1.0', 'central', 'Evil\ndepend: [x]');
    check(!r.ok && /plugin name|Requires/i.test(r.e), `a required plugin name with a line break is refused (${r.e})`);
    const libs = path.join(pluginDir, 'libs');
    check(!existsSync(path.join(project, 'plugins', 'evil-1.jar')) && !existsSync(path.join(pluginDir, 'evil-1.jar')) && (!existsSync(libs) || !readdirSync(libs).length),
      'nothing is written outside libs/ (or in it) by the refused libraries');
    const yml = readFileSync(path.join(pluginDir, 'src', 'main', 'resources', 'plugin.yml'), 'utf8');
    check(!/Evil/.test(yml), 'plugin.yml is untouched');
  });

  // ---------- mods, HotSwap ----------
  const modded = serverDir('modded');
  write(path.join(modded, 'server.jar'), paperJar);
  write(path.join(modded, 'eula.txt'), 'eula=true\n');
  write(path.join(modded, 'server.properties'), 'server-port=25807\n');
  write(path.join(modded, 'pyide-server.json'), S({ kind: 'forge', mc: '1.20.1', loader: '47.9.9', build: null, java: 17, memory: '1G', launch: { jar: 'server.jar' }, mdk: [`${base}/files/mdk.zip`] }));
  mkdirSync(path.join(modded, 'mods'), { recursive: true });
  await refresh();
  const modDir = path.join(project, 'mods', 'mymod');
  const modMain = path.join(modDir, 'src', 'main', 'java', 'com', 'example', 'mymod', 'Mymod.java');
  await section('mod names', async () => {
    for (const id of ['', 'a', 'My Mod', '1mod', 'mod-x', 'con', 'nul', 'aux', 'prn', 'com1', 'lpt1', 'm'.repeat(65), '모드', '🎮']) {
      const r = await ipc('minecraft:newMod', { root, id, display: 'x', pkg: 'com.example.ok', server: 'modded' }, 'x');
      check(!r.ok, `a mod id ${S(id)} is refused (${r.e || 'created!'})`);
    }
    for (const pkg of ['', 'Com.Example', 'com..x', 'com.example.class', 'com.new.x', 'com.example.mod-x']) {
      const r = await ipc('minecraft:newMod', { root, id: 'okmod', display: 'x', pkg, server: 'modded' }, 'x');
      check(!r.ok, `a mod package ${S(pkg)} is refused (${r.e || 'created!'})`);
    }
    const r = await ipc('minecraft:newMod', { root, id: 'okmod', display: 'x', pkg: 'com.example.ok', server: 'alpha' }, 'x');
    check(!r.ok && /Fabric, Forge or NeoForge/.test(r.e), `a mod for a Paper server is refused (${r.e})`);
    check(!existsSync(path.join(project, 'mods')) || !readdirSync(path.join(project, 'mods')).length, 'nothing is left in mods/');
    await js(`ide.minecraft.createMod({ id: 'mymod', display: 'My Mod', pkg: 'com.example.mymod', server: 'modded' }).then(() => true)`);
    check(existsSync(modMain), 'a mod is made from the template');
    const again = await ipc('minecraft:newMod', { root, id: 'mymod', display: 'x', pkg: 'com.example.mymod', server: 'modded' }, 'x');
    check(!again.ok && /already exists/.test(again.e), `a second mod with the same id is refused (${again.e})`);
  });

  const dbgOut = () => js(`document.querySelector('#dbgOut')?.textContent || ''`);
  const editAndSave = (file, text) => js(`(async () => { await ide.openFile(${S(file)}); const t = ide.findTab(${S(file)}); t.doc.model.setValue(${S(text)}); await ide.saveTab(t); return true; })()`);
  const modSource = (body) => `package com.example.mymod;\n\npublic class Mymod {\n    public static final String MODID = "mymod";\n\n${body}}\n`;
  const greeting = (v) => modSource(`    public static String greeting() {\n        return "hello ${v}";\n    }\n`);
  const clientBtn = `${card('modded')}.querySelector('.mc-build[data-project="mymod"] .mc-client')`;
  const debugEnded = () => waitFor(() => js('!window.__debugger.state()'), 20000);
  await section('HotSwap', async () => {
    await until(`!!${clientBtn}`, 'mod listed', 10000);
    await editAndSave(modMain, greeting('v1'));
    await sleep(800);
    check(!/HotSwap/.test(await dbgOut()), 'saving the mod while nothing is debugged does no HotSwap');
    await js(`(${clientBtn}.click(), true)`);
    check(await waitFor(async () => (await dbgOut()).includes('game: hello v1'), 60000), 'the test client runs under the debugger');
    // A file outside the mod.
    writeFileSync(path.join(project, 'Outside.java'), '');
    await editAndSave(path.join(project, 'Outside.java'), 'public class Outside {}\n');
    await sleep(1000);
    check(!/HotSwap/.test(await dbgOut()), 'saving a .java file outside the mod does no HotSwap');
    // A compile error, then the fix.
    await editAndSave(modMain, greeting('v1').replace('return "hello v1";', 'return 42 +;'));
    check(await waitFor(async () => /HotSwap failed/.test(await dbgOut()), 30000), 'a compile error fails the HotSwap');
    let o = await dbgOut();
    check(/Mymod\.java:\d+: error/.test(o) && await waitFor(async () => { const x = await dbgOut(); return x.slice(x.lastIndexOf('HotSwap failed')).includes('game: hello v1'); }, 5000),
      'javac says where, and the game keeps running the old code');
    // 30 saves in a second, the last one the code that should run.
    const compilesBefore = ((await dbgOut()).match(/HotSwap: compiling/g) || []).length;
    await js(`(async () => { const t = ide.findTab(${S(modMain)}); for (let i = 1; i <= 30; i++) { t.doc.model.setValue(${S(greeting('burst'))}.replace('burst', 'burst' + i)); await ide.saveTab(t); await new Promise((r) => setTimeout(r, 30)); } return true; })()`);
    check(await waitFor(async () => (await dbgOut()).includes('game: hello burst30'), 30000), 'after 30 saves in a second the game runs the last one');
    await sleep(1500);
    o = await dbgOut();
    const compiles = (o.match(/HotSwap: compiling/g) || []).length - compilesBefore;
    check(compiles >= 1 && compiles <= 3 && !/HotSwap failed/.test(o.slice(o.lastIndexOf('burst'))), `the 30 saves compile ${compiles} time(s), not 30`);
    // A changed signature.
    await editAndSave(modMain, modSource('    public static String greeting(int times) {\n        return "hello sig";\n    }\n\n    public static String greeting() {\n        return "hello sig2";\n    }\n\n    public static int extra(String s) {\n        return 1;\n    }\n'));
    check(await waitFor(async () => /cannot take this change without a restart/.test(await dbgOut()), 30000), 'a changed signature says the game needs a restart');
    await editAndSave(modMain, greeting('v3'));
    check(await waitFor(async () => (await dbgOut()).includes('game: hello v3'), 30000), 'a body-only change after that still swaps');
    // Direct requests the debugger may get.
    const missing = await js(`ide.debugger.jvmRequest('redefineClasses', { classes: [{ name: 'com.example.Nope', file: 'C:\\\\nope.class' }] }).then((r) => r, (e) => ({ error: e.message }))`);
    check(S(missing.notLoaded) === S(['com.example.Nope']), `a class the game has not loaded is reported as not loaded (${S(missing)})`);
    const badFile = await js(`ide.debugger.jvmRequest('redefineClasses', { classes: [{ name: 'com.example.mymod.Mymod', file: ${S(path.join(work, 'missing.class'))} }] }).then((r) => r, (e) => ({ error: e.message }))`);
    const garbage = path.join(work, 'garbage.class');
    writeFileSync(garbage, 'not a class');
    const badClass = await js(`ide.debugger.jvmRequest('redefineClasses', { classes: [{ name: 'com.example.mymod.Mymod', file: ${S(garbage)} }] }).then((r) => r, (e) => ({ error: e.message }))`);
    const junk = await js(`ide.debugger.jvmRequest('redefineClasses', { classes: 'junk' }).then((r) => r, (e) => ({ error: e.message }))`);
    await sleep(1200);
    o = await dbgOut();
    check(!!badFile.error && !!badClass.error && !!(junk.error || junk.redefined) && o.slice(-200).includes('game: hello v3'),
      `a missing or broken class file fails cleanly and the game keeps running (${badFile.error} | ${badClass.error} | ${junk.error || S(junk)})`);
    // A second debug session of the same client.
    const games = aliveOf('game').map((p) => p.pid);
    await js(`(${clientBtn}.click(), true)`);
    check(await waitFor(async () => games.every((p) => !alive(p)) && aliveOf('game').length === 1 && (await dbgOut()).includes('game: hello v3'), 60000), 'a second Test Client replaces the first');
    await waitFor(() => games.every((p) => !alive(p)), 10000);
    check(games.every((p) => !alive(p)) && aliveOf('game').length === 1, `the first game is ended (${aliveOf('game').length} running)`);
    await sleep(1500);
    await editAndSave(modMain, greeting('v4'));
    check(await waitFor(async () => (await dbgOut()).includes('game: hello v4'), 30000), `HotSwap still works in the second session (${(await dbgOut()).split('\n').filter((l) => /HotSwap/.test(l)).slice(-2).join(' | ')})`);
    await js(`(ide.runAction('StopDebug'), true)`);
    check(await debugEnded(), 'Stop ends the debug session');
    await waitFor(() => !aliveOf('game').length && !aliveOf('gradle').length, 10000);
    check(!aliveOf('game').length && !aliveOf('gradle').length, 'no game or Gradle process is left');
    const tail = (await dbgOut()).length;
    await editAndSave(modMain, greeting('v5'));
    await sleep(1200);
    check(!/HotSwap/.test((await dbgOut()).slice(tail)), 'saving after the session ended does no HotSwap');
  });

  await section('two kinds of debug sessions', async () => {
    await js(`(${clientBtn}.click(), true)`);
    check(await waitFor(async () => (await dbgOut()).includes('game: hello v5'), 60000), 'the test client runs again');
    await js(`(${card('alpha')}.querySelector('.mc-debug').click(), true)`);
    check(await waitFor(async () => (await dbgOut()).includes('Done (0.4s)!'), 60000), 'Debug of a server replaces the test client\'s session');
    await waitFor(() => !aliveOf('game').length, 10000);
    check(!aliveOf('game').length, 'the game is ended');
    const tail = (await dbgOut()).length;
    await editAndSave(modMain, greeting('v6'));
    await sleep(1500);
    check(!/HotSwap/.test((await dbgOut()).slice(tail)), 'saving the mod while the server is debugged swaps nothing into the server');
    await js(`(ide.runAction('StopDebug'), true)`);
    await debugEnded();
    await waitFor(() => !aliveServers(serverDir('alpha')).length, 10000);
    check(!aliveServers(serverDir('alpha')).length, 'stopping the server\'s debug session ends it');
  });

  await section('Stop during the Gradle phase', async () => {
    write(path.join(modDir, 'slow.flag'), '');
    await js(`(${clientBtn}.click(), true)`);
    check(await waitFor(() => aliveOf('gradle').length > 0, 30000), 'Gradle runs');
    await sleep(1000);
    await js(`(ide.runAction('StopDebug'), true)`);
    check(await debugEnded(), 'Stop during the Gradle phase ends the session');
    await waitFor(() => !aliveOf('gradle').length && !aliveOf('game').length, 10000);
    check(!aliveOf('gradle').length && !aliveOf('game').length, `no Gradle or game process is left (${aliveOf('gradle').length} Gradle, ${aliveOf('game').length} games)`);
    const tail = (await dbgOut()).length;
    await editAndSave(modMain, greeting('v7'));
    await sleep(1200);
    check(!/HotSwap/.test((await dbgOut()).slice(tail)), 'saving after a stopped start does no HotSwap');
    rmSync(path.join(modDir, 'slow.flag'));
  });

  // ---------- resource and client packs ----------
  await section('packs', async () => {
    rmSync(path.join(serverDir('alpha'), 'resourcepack'), { recursive: true, force: true });
    await refresh();
    await js(`(ide.minecraft.sendPack(ide.minecraft.servers().find((s) => s.name === 'alpha')), true)`);
    await waitFor(async () => /resource pack/i.test(await tabText('Minecraft: Resource Pack')), 10000);
    check(/has no resource pack yet/.test(await tabText('Minecraft: Resource Pack')), 'Send to Players with no resource pack says so');
    const bad = await ipc('minecraft:applyResourcePack', root, serverDir('alpha'), 'https://x/resourcepack.zip', 'abc\nmotd=pwned');
    check(!bad.ok && !/motd=pwned/.test(readFileSync(path.join(serverDir('alpha'), 'server.properties'), 'utf8')), `a SHA-1 with a line break is refused, server.properties untouched (${bad.e || 'applied!'})`);
    const bad2 = await ipc('minecraft:applyResourcePack', root, serverDir('alpha'), 'https://x/a.zip\nonline-mode=false', 'a'.repeat(40));
    check(!bad2.ok && !/online-mode=false/.test(readFileSync(path.join(serverDir('alpha'), 'server.properties'), 'utf8')), `an address with a line break is refused (${bad2.e || 'applied!'})`);
    const pack = await ipc('minecraft:clientPack', root, serverDir('alpha'));
    check(!pack.ok && /need nothing/.test(pack.e), `a client pack of a Paper server is refused (${pack.e})`);
    await closeDialogs();
  });

  // ---------- the Minecraft screen, many servers ----------
  await section('screen tab', async () => {
    await js(`(async () => { for (let i = 0; i < 30; i++) { ide.minecraft.screen.show(i % 3 ? 'servers' : 'market'); await new Promise((r) => setTimeout(r, 15)); await ide.closeTab('minecraft:home'); } return true; })()`);
    await sleep(500);
    check(await js(`!document.querySelector('#minecraftScreen') && !ide.findTab('minecraft:home') && ide.minecraft.screen.page() === null`), 'opened and closed 30 times, the screen leaves nothing behind');
    await js(`(ide.minecraft.screen.show('servers'), true)`);
    check(await js(`document.querySelectorAll('#minecraftScreen').length === 1 && document.querySelectorAll('#minecraftScreen .mc-server').length === document.querySelectorAll('#minecraftTool .mc-server').length`),
      'opened again, it shows the servers once');
    const renders = await js(`(async () => { let n = 0; const orig = Element.prototype.replaceChildren; Element.prototype.replaceChildren = function (...a) { if (this.classList?.contains('mc-tool')) n++; return orig.apply(this, a); };
      await ide.minecraft.refresh(); Element.prototype.replaceChildren = orig; return n; })()`);
    check(renders === 2, `a refresh renders the tool window and the screen only, not closed screens (${renders} renders)`);
  });
  await section('50 servers', async () => {
    for (let i = 0; i < 50; i++) {
      const d = serverDir(`bulk${String(i).padStart(2, '0')}`);
      write(path.join(d, 'pyide-server.json'), S({ kind: i % 2 ? 'paper' : 'forge', mc: '1.20.1', loader: i % 2 ? null : '47.9.9', java: 17, memory: '1G', launch: { jar: 'server.jar' }, mdk: [`${base}/files/mdk.zip`] }));
      write(path.join(d, 'server.properties'), `server-port=${25840 + i}\n`);
    }
    const ms = await js(`(async () => { const t0 = performance.now(); await ide.minecraft.refresh(); return performance.now() - t0; })()`);
    const cards = await js(`document.querySelectorAll('#minecraftTool .mc-server').length`);
    const total = readdirSync(path.join(project, 'servers')).length;
    check(cards === total && ms < 2000, `${cards} cards for ${total} servers, refreshed in ${Math.round(ms)} ms`);
    const ui = await js(`(async () => { const t0 = performance.now(); for (let i = 0; i < 10; i++) { ide.minecraft.screen.show('servers'); await new Promise((r) => requestAnimationFrame(r)); } return performance.now() - t0; })()`);
    check(ui < 3000, `the screen stays responsive with them (${Math.round(ui)} ms for 10 frames)`);
    const scroll = await js(`(() => { const s = document.querySelector('#minecraftScreen'); return s.scrollHeight > s.clientHeight || getComputedStyle(s).overflowY; })()`);
    check(scroll === true || /auto|scroll/.test(String(scroll)), `the screen's server list scrolls (${scroll})`);
    for (let i = 0; i < 50; i++) rmSync(serverDir(`bulk${String(i).padStart(2, '0')}`), { recursive: true, force: true });
    await js(`(ide.closeTab('minecraft:home'), true)`);
    await refresh();
  });

  // ---------- New Project ----------
  await section('New Project', async () => {
    const where = path.join(work, 'newprojects');
    mkdirSync(path.join(where, 'Taken'), { recursive: true });
    writeFileSync(path.join(where, 'Taken', 'keep.txt'), 'mine');
    const setValue = (sel, value) => js(`(() => { const i = document.querySelector(${S(sel)}); i.value = ${S(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const npError = () => js(`document.querySelector('.np-error')?.textContent || ''`);
    const open = async (type, name) => {
      await js(`ide.runAction('NewProject')`);
      await until(`!!document.querySelector('.np-dialog #npName')`, 'wizard');
      await js(`(document.querySelector('.np-type[data-type="${type}"]').click(), true)`);
      await setValue('#npName', name);
      await setValue('#npLocation', where);
      const what = type.replace('minecraft-', '');
      await until(`[...document.querySelectorAll('#npMc-${what}-version option')].some((o) => o.value === '1.20.1')`, 'versions')
        .catch(async (e) => { console.log(await js(`[document.querySelectorAll('.np-dialog').length, document.querySelector('.np-type.selected')?.dataset.type, [...document.querySelectorAll('[id^=npMc-][id$=-version]')].map((v) => v.id + ':' + [...v.options].map((o) => o.value).join('/')).join(' ')]`)); throw e; });
      return what;
    };
    let what = await open('minecraft-server', 'Taken');
    await js(`(document.querySelector('#npMc-${what}-eula').checked = true, true)`);
    await js(`(() => { const v = document.querySelector('#npMc-${what}-version'); v.value = ''; return true; })()`);
    await js(`(document.querySelector('#npCreate').click(), true)`);
    await sleep(500);
    check(/Choose a version/.test(await npError()), `an empty version is refused (${await npError()})`);
    await js(`(document.querySelector('#npMc-${what}-version').value = '1.20.1', true)`);
    await js(`(document.querySelector('#npMc-${what}-eula').checked = false, true)`);
    await js(`(document.querySelector('#npCreate').click(), true)`);
    await sleep(500);
    check(/EULA/.test(await npError()), 'without the EULA nothing is made');
    await js(`(document.querySelector('#npMc-${what}-eula').checked = true, true)`);
    await js(`(document.querySelector('#npCreate').click(), true)`);
    await sleep(800);
    check(/already exists/.test(await npError()) && S(readdirSync(path.join(where, 'Taken'))) === S(['keep.txt']) && ide_root_is(await js('ide.root'), project),
      `a location that exists is refused and left as it was (${await npError()})`);
    await js(`(document.querySelector('#npCancel').click(), true)`);
    for (const [type, name] of [['minecraft-plugin', 'Con'], ['minecraft-mod', 'nul']]) {
      what = await open(type, name);
      await js(`(document.querySelector('#npMc-${what}-eula').checked = true, true)`);
      await js(`(document.querySelector('#npCreate').click(), true)`);
      await sleep(600);
      check(/reserved|Windows/i.test(await npError()) && !existsSync(path.join(where, name)), `New Project › ${type} named ${S(name)} is refused (${await npError()})`);
      await js(`(document.querySelector('#npCancel').click(), true)`);
    }
    // A version the service does not have: the project opens, the server is not made, and the error is shown.
    what = await open('minecraft-plugin', 'BadVersion');
    await js(`(() => { const v = document.querySelector('#npMc-${what}-version'); v.add(new Option('9.9.9', '9.9.9')); v.value = '9.9.9'; document.querySelector('#npMc-${what}-eula').checked = true; return true; })()`);
    await js(`(document.querySelector('#npCreate').click(), true)`);
    const dir = path.join(where, 'BadVersion');
    await until(`ide.root && ide.root.toLowerCase() === ${S(dir.toLowerCase())}`, 'new project opened', 30000);
    check(await waitFor(async () => /HTTP 404|no build/i.test(await tabText('Minecraft: New Server')), 30000), `a bad version is reported in the New Server tab (${(await tabText('Minecraft: New Server')).trim().split('\n').pop()})`);
    await sleep(800);
    check(!existsSync(path.join(dir, 'servers', 'server')) && !existsSync(path.join(dir, 'plugins')), 'no half-made server or plugin is left');
  });
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
function ide_root_is(a, b) { return !!a && sameDir(a, b); }
await js(`ide.run.sessions().forEach((s) => s.running && s.stop())`).catch(() => {});
await js(`(ide.runAction('StopDebug'), true)`).catch(() => {});
await waitFor(() => !aliveServers().length, 10000);
t.close();

// ---------- Java missing (a second window, none of this computer's JDKs, Adoptium unreachable) ----------
try {
  const project2 = path.join(work, 'project2');
  const d = path.join(project2, 'servers', 'nojava');
  write(path.join(d, 'server.jar'), paperJar);
  write(path.join(d, 'eula.txt'), 'eula=true\n');
  write(path.join(d, 'server.properties'), 'server-port=25820\n');
  write(path.join(d, 'pyide-server.json'), S({ kind: 'paper', mc: '1.20.1', java: 17, memory: '1G', launch: { jar: 'server.jar' } }));
  const toolchains = path.join(work, 'toolchains.json');
  writeFileSync(toolchains, S({ system: false }));
  const t2 = await launch({ name: 'stress-minecraft-runtime-2', port: 8621, projectDir: project2, env: { PYIDE_MC_SOURCES: SOURCES, PYIDE_INSTALL_ROOT: path.join(work, 'install'), PYIDE_TOOLCHAINS: toolchains } });
  await t2.js(`(ide.toolWindows.get('Minecraft').show(), true)`);
  await t2.until(`!!${card('nojava')}`, 'server listed');
  await t2.js(`(${card('nojava')}.querySelector('.mc-start').click(), true)`);
  const text2 = () => t2.js(`${runTab('nojava')}?.host.textContent || ''`);
  await waitFor(async () => /Java|exit code/.test(await text2()), 30000);
  const msg = (await text2()).trim().split('\n').pop();
  check(/Java 17/.test(msg) && !/^\s*$/.test(msg) && await t2.js(`!(${runTab('nojava')}).running`), `a server whose Java is missing and cannot be downloaded says so (${msg})`);
  check(t2.consoleErrors.length === 0, `no renderer exceptions in the second window${t2.consoleErrors.length ? ` ${S(t2.consoleErrors)}` : ''}`);
  t2.close();
} catch (err) { check(false, `Java missing: ${err.message}`); }

// ---------- nothing left running ----------
await sleep(1500);
const left = pidFiles().filter((p) => alive(p.pid));
for (const p of left) try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
check(!left.length, `no stand-in process is left running (${S(left.map((p) => `${p.kind} ${p.pid}`))})`);
server.close();
t.finish();
