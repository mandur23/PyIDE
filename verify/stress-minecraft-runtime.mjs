// Craft's Minecraft servers at run time under hostile use (minecraft plugin in a craft window), offline and without
// accepting the real Minecraft EULA. Stand-ins as in verify/minecraft.mjs: a local web server plays Mojang, PaperMC and
// Adoptium; a small Java program plays the server (with flag files that make it crash at start, quit at once or ignore
// "stop"). Each stand-in process writes its pid to pids/, so the suite can tell that none is left running. Checks:
// hostile server names (invalid, Korean, emoji, too long, CON/NUL, duplicates), bad and busy game ports, Start, Stop and
// Restart clicked 20 times, a server that crashes, quits at once or hangs on "stop" (killed 60 s later, also on a
// Rerun), Restart to Update with a server running (asked first; Cancel keeps it; the server saves and exits before the
// installer is started; one that ignores "stop" is not installed over), its folder deleted or renamed while it runs, a
// damaged pyide-server.json, a wrong Java, the resource pack sent with none made, the Minecraft screen's pages switched many times, 50 servers in the project, and a server whose Java
// is missing and cannot be downloaded. CDP ports 8620-8621; game ports 25800-25899.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
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
routes.set('/modrinth/search', { total_hits: 0, hits: [] });
routes.set('/fabric/versions/game', [{ version: '1.20.1', stable: true }]);
const SOURCES = S({ mojang: `${base}/mojang/manifest.json`, paper: `${base}/paper`, purpur: `${base}/purpur`, velocity: `${base}/velocity`, forge: `${base}/forge`,
  forgePromos: `${base}/forge/promos.json`, fabric: `${base}/fabric`, neoforge: `${base}/neoforge`,
  adoptium: `${base}/adoptium`, modrinth: `${base}/modrinth` });

// ---------- processes ----------
// A pid file can outlive its process, and Windows reuses pids: this says what holds one now.
const image = (pid) => { try { return /"([^"]+)"/.exec(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }))?.[1] || 'gone'; } catch { return 'unknown'; } };
const alive = (pid) => {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return ['java.exe', 'unknown'].includes(image(pid));
};
const pidFiles = () => readdirSync(pidsDir).map((f) => ({ kind: f.split('-')[0], pid: Number(f.split('-')[1]), info: readFileSync(path.join(pidsDir, f), 'utf8') }));
writeFileSync(path.join(pidsDir, `server-${process.pid}`), 'a stand-in that died, its pid given to this process');
// The runner's %TEMP% has an 8.3 name (RUNNER~1) that Java's getCanonicalPath expands, and a stand-in server's folder may
// be gone by the time it is compared, so `work`'s long form is put in by hand.
const workLower = path.resolve(work).toLowerCase();
const workLong = realpathSync.native(work).toLowerCase();
const longForm = (p) => { const low = path.resolve(p).toLowerCase(); return low === workLower || low.startsWith(`${workLower}\\`) ? workLong + low.slice(workLower.length) : low; };
const sameDir = (a, b) => longForm(a) === longForm(b);
const aliveServers = (dir) => pidFiles().filter((p) => p.kind === 'server' && (!dir || sameDir(p.info, dir)) && alive(p.pid));
const waitFor = async (fn, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return !!(await fn()); };

const project = path.join(work, 'project');
mkdirSync(project);
const t = await launch({ name: 'stress-minecraft-runtime', port: 8620, mode: 'craft', projectDir: project, env: { PYIDE_CRAFT_HOME: project, PYIDE_MC_LAUNCHER_IMAGE: 'nano-no-such-launcher.exe', PYIDE_MC_JAVA: javaHome, PYIDE_MC_SOURCES: SOURCES, PYIDE_UPDATE_TEST: '1' } });
const { js, until, check } = t;
const root = await js('ide.root');
const card = (name) => `document.querySelector('#minecraftScreen .mc-server[data-name="${name}"]')`;
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
const stopped = (name) => waitFor(() => js(`!(${runTab(name)})?.running`), 75000);
const section = async (label, fn) => {
  try { await fn(); } catch (err) { check(false, `${label}: ${(err.message.split('\n').find((l) => l.startsWith('=>')) || err.message).slice(0, 300)}`); await closeDialogs().catch(() => {}); }
};

try {
  await js(`(ide.settings.set('ports.confirmShare', false), ide.settings.set('ports.confirmShareTcp', false), ide.minecraft.screen.show('servers'), true)`);
  await until(`!!document.querySelector('#minecraftScreen .mcc-empty')`, 'empty server list');

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
    check(ended && /Ignoring stop/.test(await tabText('gamma')) && Date.now() - t0 > 55000 && !aliveServers(serverDir('gamma')).length,
      `a server that ignores "stop" is killed about 60 s later (${Math.round((Date.now() - t0) / 1000)} s)`);
    // Rerun of a hung server: the old process must not be left running.
    check(await startCard('gamma'), 'it starts again');
    const old = aliveServers(serverDir('gamma')).map((p) => p.pid);
    const t1 = Date.now();
    await js(`(ide.run.runConfig(${runTab('gamma')}.cfg, { confirm: false }), true)`);
    const ok = await waitFor(async () => old.every((p) => !alive(p)) && await js(`(() => { const s = ${runTab('gamma')}; return s.running && !s.starting && s.host.textContent.includes('Done (0.4s)!'); })()`), 100000, 500);
    check(ok && aliveServers(serverDir('gamma')).length === 1,
      `Rerun of a server that ignores "stop" kills the old one 60 s later and the new one starts (${Math.round((Date.now() - t1) / 1000)} s, old alive: ${old.filter(alive).length}, running: ${S(aliveServers(serverDir('gamma')).map((p) => `${p.pid} ${image(p.pid)}`))})`);
    rmSync(path.join(serverDir('gamma'), 'hang.flag'));
    await js(`(${runTab('gamma')}.stop(), true)`);
    await stopped('gamma');
  });

  // ---------- Restart to Update with a server running ----------
  // A source run cannot install (no downloaded installer), so the install step logs "starting the installer", fails
  // and the window stays: what the suite checks is that the server got "stop" and exited before that line.
  await section('restart to update', async () => {
    const logText = () => { try { return readFileSync(path.join(t.userData, 'logs', 'pyide.log'), 'utf8'); } catch { return ''; } };
    const buttons = () => js(`[...[...document.querySelectorAll('.dialog')].pop()?.querySelectorAll('.dialog-buttons button') || []].map((b) => b.textContent)`);
    const lastDialog = () => js(`[...document.querySelectorAll('.dialog')].pop()?.textContent || ''`);
    const press = (label) => js(`(${dialogButton(label)}.click(), true)`);
    const phase = () => js(`ide.api.invoke('updater:state').then((s) => s.phase)`);
    const askRestart = async () => {
      await js(`(document.getElementById('updateStatus').click(), true)`);
      await t.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('has been downloaded')`, 'Update Ready');
      await press('Restart to Update');
      await t.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('Servers Are Running')`, 'the question about running servers');
    };
    check((await create({ name: 'upd', port: 25807 })).ok, 'a server for Restart to Update');
    await refresh();
    check(await startCard('upd'), 'it starts');
    const pid = aliveServers(serverDir('upd')).map((p) => p.pid)[0];
    await js(`ide.api.invoke('updater:testPhase', { phase: 'downloaded', available: '9.9.9', signature: 'verified' })`);
    await t.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('has been downloaded')`, 'Update Ready after the download');
    await press('Later');
    await askRestart();
    const asked = await lastDialog();
    check(/These servers are running\. Updating stops them, and each saves its world first/.test(asked) && /upd/.test(asked) && S(await buttons()) === S(['Stop Servers and Update', 'Cancel']),
      `Restart to Update with a server running asks first, naming it (${asked.slice(0, 160)}; ${S(await buttons())})`);
    await press('Cancel');
    await sleep(1500);
    check(alive(pid) && await js(`(${runTab('upd')}).running`) && !/Stopping the server/.test(await tabText('upd')) && !/starting the installer/.test(logText()),
      'Cancel leaves the server running and sends it nothing');
    check(await phase() === 'downloaded' && await js(`document.getElementById('updateStatus').textContent === 'Restart to Update'`), 'after Cancel the update is still offered (status bar: Restart to Update)');

    await askRestart();
    await js(`(() => { window.__sawStopping = false; new MutationObserver(() => { if (document.getElementById('updateStopping')) window.__sawStopping = true; }).observe(document.body, { childList: true, subtree: true }); return true; })()`);
    await press('Stop Servers and Update');
    check(await waitFor(() => /starting the installer/.test(logText()), 30000), 'Stop Servers and Update reaches the install step');
    const log = logText();
    const wait = log.slice(log.lastIndexOf('asked to stop'));
    const exitAt = wait.search(/#\d+ exited with code 0/);
    const installAt = wait.indexOf('starting the installer');
    check(/Stopping the server/.test(await tabText('upd')) && existsSync(path.join(serverDir('upd'), 'world.saved')), 'the server got its "stop" and saved its world');
    check(exitAt >= 0 && installAt > exitAt && !alive(pid), `the server process exited before the installer was started (exit at ${exitAt}, installer at ${installAt} in the log after "asked to stop")`);
    check(await js('window.__sawStopping'), 'a dialog says the servers are stopping while they do');
    await t.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('could not be started')`, 'the installer failure of a source run');
    check(true, 'a source run cannot start the installer, says so and stays open');
    await press('Close');

    // A server that ignores "stop": nothing is installed over it.
    write(path.join(serverDir('upd'), 'hang.flag'), '');
    check(await startCard('upd'), 'it starts again, now ignoring stop');
    const hung = aliveServers(serverDir('upd')).map((p) => p.pid)[0];
    const before = (logText().match(/starting the installer/g) || []).length;
    await askRestart();
    const t0 = Date.now();
    await press('Stop Servers and Update');
    await sleep(1000);
    check(await js(`!!document.getElementById('updateStopping')`), 'the stopping dialog shows while the server keeps running');
    await t.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('did not stop in time')`, 'the not-installed message', 90000);
    const said = await lastDialog();
    check(/1 of them did not stop in time, so Nano Studio was not updated/.test(said) && Date.now() - t0 > 55000, `a server that ignores "stop" for the quit gate's minute is reported (${Math.round((Date.now() - t0) / 1000)} s: ${said.slice(0, 140)})`);
    check((logText().match(/starting the installer/g) || []).length === before && /not installing 9\.9\.9/.test(logText()), 'and the installer is not started over it');
    check(alive(hung) && await phase() === 'downloaded', 'the server is left running and the update is still offered');
    await press('Close');
    rmSync(path.join(serverDir('upd'), 'hang.flag'));
    await js(`(${runTab('upd')}.stop(), true)`);
    check(await stopped('upd') && !alive(hung), 'the server stops normally afterwards');
    await js(`ide.api.invoke('updater:testPhase', { phase: 'idle', available: null, signature: null })`);
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
    check(/no pyide-server\.json/.test(await tabText('zeta')), 'Start with no pyide-server.json says it is not a Nano Studio server');
    check(await js(`!${card('zeta')}`), 'a folder without pyide-server.json is not listed');
    writeFileSync(desc, good);
    await refresh();
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
  await section('screen', async () => {
    await js(`(async () => { for (let i = 0; i < 30; i++) { ide.minecraft.screen.show(i % 3 ? 'servers' : 'market'); await new Promise((r) => setTimeout(r, 15)); } ide.minecraft.screen.show('servers'); return true; })()`);
    await sleep(500);
    check(await js(`document.querySelectorAll('#minecraftScreen').length === 1 && document.querySelectorAll('#minecraftScreen .mc-server').length === ide.minecraft.servers().length`),
      'switched between its pages 30 times, the screen shows the servers once');
    const renders = await js(`(async () => { let n = 0; const orig = Element.prototype.replaceChildren; Element.prototype.replaceChildren = function (...a) { if (this.classList?.contains('mc-tool')) n++; return orig.apply(this, a); };
      await ide.minecraft.refresh(); Element.prototype.replaceChildren = orig; return n; })()`);
    check(renders === 1, `a refresh renders the server list once (${renders} renders)`);
  });
  await section('50 servers', async () => {
    for (let i = 0; i < 50; i++) {
      const d = serverDir(`bulk${String(i).padStart(2, '0')}`);
      write(path.join(d, 'pyide-server.json'), S({ kind: i % 2 ? 'paper' : 'forge', mc: '1.20.1', loader: i % 2 ? null : '47.9.9', java: 17, memory: '1G', launch: { jar: 'server.jar' } }));
      write(path.join(d, 'server.properties'), `server-port=${25840 + i}\n`);
    }
    const ms = await js(`(async () => { const t0 = performance.now(); await ide.minecraft.refresh(); return performance.now() - t0; })()`);
    const cards = await js(`document.querySelectorAll('#minecraftScreen .mc-server').length`);
    const total = readdirSync(path.join(project, 'servers')).length;
    check(cards === total && ms < 2000, `${cards} cards for ${total} servers, refreshed in ${Math.round(ms)} ms`);
    const ui = await js(`(async () => { const t0 = performance.now(); for (let i = 0; i < 10; i++) { ide.minecraft.screen.show('servers'); await new Promise((r) => requestAnimationFrame(r)); } return performance.now() - t0; })()`);
    check(ui < 3000, `the screen stays responsive with them (${Math.round(ui)} ms for 10 frames)`);
    const scroll = await js(`(() => { const s = document.querySelector('#minecraftScreen'); return s.scrollHeight > s.clientHeight || getComputedStyle(s).overflowY; })()`);
    check(scroll === true || /auto|scroll/.test(String(scroll)), `the screen's server list scrolls (${scroll})`);
    for (let i = 0; i < 50; i++) rmSync(serverDir(`bulk${String(i).padStart(2, '0')}`), { recursive: true, force: true });
    await refresh();
  });

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
await js(`ide.run.sessions().forEach((s) => s.running && s.stop())`).catch(() => {});
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
  const t2 = await launch({ name: 'stress-minecraft-runtime-2', port: 8621, mode: 'craft', projectDir: project2, env: { PYIDE_CRAFT_HOME: project2, PYIDE_MC_LAUNCHER_IMAGE: 'nano-no-such-launcher.exe', PYIDE_MC_SOURCES: SOURCES, PYIDE_INSTALL_ROOT: path.join(work, 'install'), PYIDE_TOOLCHAINS: toolchains } });
  await t2.js(`(ide.minecraft.screen.show('servers'), true)`);
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
const holders = new Map(left.map((p) => [p.pid, image(p.pid)]));
for (const p of left) if (holders.get(p.pid) === 'java.exe') try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
check(!left.length, `no stand-in process is left running (${S(left.map((p) => `${p.kind} ${p.pid} ${holders.get(p.pid)} ${p.info}`))})`);
server.close();
t.finish();
