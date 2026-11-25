// A mod or a plugin made in Nano Studio Craft, opened in Code (main/features/craft-mods.js, renderer/features/craft-mods):
// a Korean Code window on a Fabric mod's folder inside a craft folder. No download, no real Gradle, game or launcher: a
// local web server plays Fabric's meta service, Mojang's manifest and Fabric's Maven repository, the mod's gradlew.bat
// is a Node script that writes the jar a build leaves, and the launcher is a script that records how it was started.
// Checks: only a folder Craft made counts as one; the Minecraft tool window opens with it, names the mod, its loader
// and version, and lists the files worth knowing with what each is; the file the code starts in opens by itself and a
// row opens its file; Build runs the mod's Gradle in a Run tab and the window says what was built; Test in Minecraft
// builds, puts the jar into the chosen instance, fetches the Fabric API the mod needs (once, the version its
// gradle.properties names, kept only when it is Fabric API) and opens the launcher on that instance's profile; a mod
// the instance lacks is named; Build and Add puts the jar into a server and says where it is loaded; a failed build is
// said in Korean and keeps the earlier jar; Cancel ends a build and the process it started; with no instance of the
// mod's version one is made from here; the test client runs the mod's runClient through Gradle with the debug port and
// a stand-in game (a Java window that prints the mod's greeting) starts under Code's debugger; a saved change is
// swapped into the running game, one the JVM cannot take says a restart is needed and points at Restart, one that
// does not compile says so; the game window is put beside Code; a saved resource is copied where the game reads it;
// Inside Code shows the game window's picture; Restart starts a new game and Stop ends it; a plugin's folder shows its
// own steps; any other project hides the window. The keys the app would send the game (F3+T) are never sent here:
// they would reach the desktop the user works on.
// Port 9702.
// Usage: node verify/code-mods.mjs
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { closeBalloonsOver, launch } from './lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const { writeZip } = require('../main/minecraft/zipfile.js');

const work = mkdtempSync(path.join(tmpdir(), 'pyide-code-mods-'));
const home = path.join(work, 'craft');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (p) => readFileSync(p, 'utf8');
const zipOf = (entries) => writeZip(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(typeof data === 'string' ? data : S(data)) })));

// ---------- the stand-ins ----------
// gradlew.bat as a Node script: `build` writes the mod's jar from its fabric.mod.json. A file named fail-build fails
// the build; slow-build makes it start a child and wait, as Gradle does.
const fakeGradle = path.join(work, 'fake-gradle.cjs');
const gameDir = path.join(work, 'game');
writeFileSync(fakeGradle, `const fs = require('fs'); const path = require('path'); const { execFileSync, spawn } = require('child_process');
const { writeZip } = require(${S(path.resolve('main/minecraft/zipfile.js'))});
const args = process.argv.slice(2);
const prop = (k) => (args.find((x) => x.startsWith('-P' + k + '=')) || '').slice(k.length + 3) || null;
const task = args[args.length - 1];
const home = process.env.JAVA_HOME;
console.log('JAVA_HOME=' + home);
console.log('args ' + args.join(' '));
const out = path.join(process.cwd(), 'build', 'classes', 'java', 'main');
const srcDir = path.join(process.cwd(), 'src', 'main', 'java');
if (args.includes('pyideClasspath')) fs.writeFileSync(prop('pyide.classpathFile'), JSON.stringify([{ name: 'main', sources: [srcDir], classpath: [], output: out,
  resources: [path.join(process.cwd(), 'src', 'main', 'resources')], resourcesOutput: path.join(process.cwd(), 'build', 'resources', 'main') }]));
if (task === 'runClient') {
  const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.java')) files.push(p); } };
  walk(srcDir);
  execFileSync(path.join(home, 'bin', 'javac.exe'), ['--release', '17', '-g', '-d', out, ...files], { stdio: 'inherit' });
  const port = prop('pyide.debugPort');
  const jvm = port ? ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:' + port] : [];
  const game = spawn(path.join(home, 'bin', 'java.exe'), [...jvm, '-cp', out + path.delimiter + ${S(gameDir)}, 'FakeGame', 'com.example.SkyTools'], { stdio: 'inherit' });
  game.on('exit', (c) => process.exit(c ?? 0));
} else if (fs.existsSync('fail-build')) { console.error('src/main/java/Broken.java:3: error: 세미콜론이 없습니다'); console.error('BUILD FAILED'); process.exit(1); }
else if (fs.existsSync('slow-build')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync('slow-build', String(child.pid));
  console.log('working');
  setInterval(() => {}, 1000);
} else {
  const version = /^version=(.+)$/m.exec(fs.readFileSync('gradle.properties', 'utf8'))[1].trim();
  const meta = JSON.parse(fs.readFileSync('src/main/resources/fabric.mod.json', 'utf8'));
  fs.mkdirSync('build/libs', { recursive: true });
  fs.writeFileSync(path.join('build/libs', meta.id + '-' + version + '.jar'), writeZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ ...meta, version })) }]));
  fs.writeFileSync(path.join('build/libs', meta.id + '-' + version + '-sources.jar'), writeZip([{ name: 'a.txt', data: Buffer.from('x') }]));
  console.log('BUILD SUCCESSFUL');
}
`);
// The game: a window titled like Minecraft's that prints the mod's greeting() every 300 ms (so a HotSwap shows in its
// output), its bounds when it is placed, and quits by itself after two minutes.
const FAKE_GAME = `import java.awt.*;
import java.awt.event.*;

public class FakeGame {
  public static void main(String[] a) throws Exception {
    java.lang.reflect.Method m = Class.forName(a[0]).getMethod("greeting");
    Frame f = new Frame("Minecraft* Fake 1.20.1");
    f.setBackground(new Color(40, 160, 70));
    f.setBounds(100, 100, 640, 400);
    f.addComponentListener(new ComponentAdapter() {
      public void componentMoved(ComponentEvent e) { bounds(f); }
      public void componentResized(ComponentEvent e) { bounds(f); }
    });
    f.addWindowListener(new WindowAdapter() { public void windowClosing(WindowEvent e) { System.exit(0); } });
    f.setVisible(true);
    System.out.println("Fake Minecraft window open");
    for (int i = 0; i < 400; i++) { System.out.println("game: " + m.invoke(null)); Thread.sleep(300); }
    System.exit(0);
  }
  static void bounds(Frame f) { Rectangle r = f.getBounds(); System.out.println("game: bounds " + r.x + "," + r.y + "," + r.width + "," + r.height); }
}
`;
// The launcher: each start appends its arguments to the log.
const launcherLog = path.join(work, 'launcher-starts.jsonl');
const fakeLauncher = path.join(work, 'fake-launcher.cjs');
writeFileSync(fakeLauncher, `const fs = require('fs');
const [log, ...args] = process.argv.slice(2);
const dir = args[args.indexOf('--workDir') + 1];
const profiles = JSON.parse(fs.readFileSync(require('path').join(dir, 'launcher_profiles.json'), 'utf8')).profiles;
fs.appendFileSync(log, JSON.stringify({ args, profiles: Object.values(profiles).map((p) => [p.name, p.gameDir]) }) + '\\n');
`);
const starts = () => (existsSync(launcherLog) ? read(launcherLog).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const startsReach = async (n) => { for (let i = 0; i < 100 && starts().length < n; i++) await new Promise((r) => setTimeout(r, 100)); return starts(); };

const API = '0.92.2+1.20.1';
const apiPath = `/maven/net/fabricmc/fabric-api/fabric-api/${encodeURIComponent(API)}/fabric-api-${encodeURIComponent(API)}.jar`;
const asked = [];
const routes = new Map();
const server = http.createServer((req, res) => {
  asked.push(req.url);
  const body = routes.get(req.url.split('?')[0]);
  if (body === undefined) { res.writeHead(404); return res.end(); }
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : S(body));
  res.writeHead(200, { 'content-length': data.length });
  res.end(data);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
routes.set('/mojang/manifest.json', { latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', url: `${base}/mojang/1.20.1.json` }] });
routes.set('/mojang/1.20.1.json', { id: '1.20.1', javaVersion: { majorVersion: 17 } });
routes.set('/fabric/versions/game', [{ version: '1.20.1', stable: true }]);
routes.set('/fabric/versions/loader/1.20.1', [{ loader: { version: '0.16.0', stable: false } }, { loader: { version: '0.15.11', stable: true } }]);
routes.set('/fabric/versions/loader/1.20.1/0.15.11/profile/json', { id: 'fabric-loader-0.15.11-1.20.1', inheritsFrom: '1.20.1', type: 'release', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [], jvm: [] }, libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.11', url: 'https://maven.fabricmc.net/' }] });
routes.set(apiPath, zipOf({ 'fabric.mod.json': { schemaVersion: 1, id: 'fabric-api', version: API, provides: ['fabric'] } }));
const sources = { mojang: `${base}/mojang/manifest.json`, fabric: `${base}/fabric`, fabricMaven: `${base}/maven`, quilt: `${base}/quilt`, forge: `${base}/forge`, forgePromos: `${base}/forge/promos.json`,
  neoforge: `${base}/neoforge`, adoptium: `${base}/adoptium`, modrinth: `${base}/modrinth`, paper: `${base}/paper` };

// ---------- the craft folder: a Fabric mod, a Paper plugin, instances and servers ----------
const modDir = path.join(home, 'mods', 'sky_tools');
const modSource = (body) => `package com.example;\n\npublic class SkyTools {\n\tpublic void onInitialize() { }\n\n${body}}\n`;
const modJson = (depends) => S({ schemaVersion: 1, id: 'sky_tools', version: '${version}', name: '하늘 도구', entrypoints: { main: ['com.example.SkyTools'], client: ['com.example.client.SkyToolsClient'] }, depends }, null, '\t');
const DEPENDS = { fabricloader: '>=0.15.0', minecraft: '~1.20.1', java: '>=17', 'fabric-api': '*' };
for (const [f, data] of Object.entries({
  'pyide-mod.json': S({ id: 'sky_tools', name: '하늘 도구', loader: 'fabric', mc: '1.20.1', pkg: 'com.example', cls: 'SkyTools', java: 17, created: '2026-11-25T00:00:00.000Z' }),
  'gradle.properties': `org.gradle.jvmargs=-Xmx1G\nminecraft_version=1.20.1\nloader_version=0.15.11\nloom_version=1.19-SNAPSHOT\nfabric_api_version=${API}\nversion=1.0.0\n`,
  'build.gradle': 'plugins { id \'net.fabricmc.fabric-loom\' version "${loom_version}" }\n',
  'gradlew.bat': `@"${process.execPath}" "${fakeGradle}" %*\r\n`,
  'src/main/java/com/example/SkyTools.java': modSource('\tpublic static String greeting() {\n\t\treturn "hello v1";\n\t}\n'),
  'src/client/java/com/example/client/SkyToolsClient.java': 'package com.example.client;\n\npublic class SkyToolsClient { }\n',
  'src/main/resources/fabric.mod.json': modJson(DEPENDS),
  'src/main/resources/assets/sky_tools/lang/en_us.json': '{}\n',
})) write(path.join(modDir, f), data);
const instDir = (n) => path.join(home, 'instances', n);
write(path.join(instDir('survival'), 'nano-instance.json'), S({ title: '생존 월드', mc: '1.20.1', loader: 'fabric', loaderVersion: '0.15.11', memory: '4G', created: '2026-11-01T00:00:00.000Z' }));
write(path.join(instDir('newer'), 'nano-instance.json'), S({ title: 'Newer', mc: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0', memory: '4G', created: '2026-11-02T00:00:00.000Z' }));
write(path.join(instDir('forged'), 'nano-instance.json'), S({ title: 'Forged', mc: '1.20.1', loader: 'forge', loaderVersion: '47.4.0', memory: '4G', created: '2026-11-03T00:00:00.000Z' }));
const serverDir = (n) => path.join(home, 'servers', n);
write(path.join(serverDir('modded'), 'pyide-server.json'), S({ kind: 'fabric', mc: '1.20.1', loader: '0.15.11', build: null, java: 17, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(serverDir('modded'), 'server.properties'), 'server-port=25746\n');
write(path.join(serverDir('lobby'), 'pyide-server.json'), S({ kind: 'paper', mc: '1.20.1', build: 100, java: 17, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(serverDir('lobby'), 'server.properties'), 'server-port=25749\n');
const pluginDir = path.join(home, 'plugins', 'Gate');
write(path.join(pluginDir, 'pyide-plugin.json'), S({ name: 'Gate', api: 'paper', pkg: 'net.me.gate', server: 'lobby', mc: '1.20.1', created: '2026-11-25T00:00:00.000Z' }));
write(path.join(pluginDir, 'src/main/java/net/me/gate/Gate.java'), 'package net.me.gate;\n\npublic class Gate { }\n');
write(path.join(pluginDir, 'src/main/resources/plugin.yml'), 'name: Gate\nversion: 1.0\nmain: net.me.gate.Gate\n');
const plain = path.join(work, 'plain');
write(path.join(plain, 'main.py'), 'print("hi")\n');
write(path.join(home, 'mods', 'notes', 'readme.txt'), 'not a mod\n');

// A real JDK home: a build checks that its javac is there (the stand-in Gradle only prints JAVA_HOME).
const java = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME_17_X64 || process.env.JAVA_HOME
  || path.dirname(path.dirname(execFileSync('where', ['javac'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()));
write(path.join(work, 'game-src', 'FakeGame.java'), FAKE_GAME);
mkdirSync(gameDir, { recursive: true });
execFileSync(path.join(java, 'bin', 'javac.exe'), ['-d', gameDir, path.join(work, 'game-src', 'FakeGame.java')]);
const env = { PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_JAVA: java, PYIDE_MC_LAUNCHER: S([process.execPath, fakeLauncher, launcherLog]), PYIDE_MC_LAUNCHER_IMAGE: 'nano-no-such-launcher.exe',
  PYIDE_MC_GAME_IMAGE: 'nano-no-such-game.exe', PYIDE_MC_SOURCES: S(sources), PYIDE_MC_DNS: '{}' };

const t = await launch({ name: 'code-mods', port: 9702, lang: 'ko-KR', projectDir: modDir, env });
const { js, until, check, shot, sleep } = t;
// The guide scrolls: what is pressed is brought into view first, then the balloons over it are closed.
const click = async (selector) => {
  await js(`(document.querySelector(${S(selector)})?.scrollIntoView({ block: 'center' }), true)`);
  await closeBalloonsOver(t, `document.querySelector(${S(selector)})`);
  await t.click(selector);
};
const label = (selector) => js(`${VIEW}.querySelector(${S(selector)} + ' > span:last-child').textContent`);
const header = () => js(`[...document.querySelectorAll('[data-action^="cmod"]')].map((b) => [b.dataset.action, b.title])`);
const VIEW = `document.querySelector('.cmod-view')`;
const state = () => js(`(() => { const s = ide.craftMods.state(); return { busy: s.busy, kind: s.project?.kind || null, jar: s.project?.jar?.name || null, instances: (s.project?.instances || []).map((i) => i.name), servers: (s.project?.servers || []).map((i) => i.name) }; })()`);
const shown = () => js(`ide.toolWindows.get('MinecraftMod').isVisible()`);
const idle = (what) => until(`ide.craftMods.state().busy === null`, what, 30000);
const notes = () => js(`ide.notifications.list().map((e) => [e.title, e.text || ''])`);
const lastNote = async () => (await notes()).at(-1) || [];
const runTab = (title) => js(`(ide.run.sessions().find((s) => s.title === ${S(title)})?.host.textContent) || ''`);
const modsOf = (dir) => (existsSync(path.join(dir, 'mods')) ? readdirSync(path.join(dir, 'mods')).sort() : []);
const steps = () => js(`[...${VIEW}.querySelectorAll('.cmod-step')].map((s) => [s.querySelector('.cmod-num').textContent, s.querySelector('.cmod-step-title').textContent])`);
const options = (id) => js(`[...(${VIEW}.querySelector('#${id}')?.options || [])].map((o) => [o.value, o.textContent])`);
const alive = (pid) => { try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid)); } catch { return false; } };
const apiAsks = () => asked.filter((u) => u.startsWith('/maven/'));
try {
  // ---------- what counts as a mod's folder ----------
  await until(`ide.craftMods.state().project !== null`, 'the mod recognised', 20000);
  const others = await js(`Promise.all([${S(home)}, ${S(path.join(home, 'mods'))}, ${S(path.join(home, 'mods', 'notes'))}, ${S(plain)}].map((d) => ide.api.invoke('craft-mods:project', d)))`);
  check(others.every((x) => x === null), `the craft folder itself, its mods folder, a folder there that is no mod and any other project are not mods (${S(others)})`);

  // ---------- the guide ----------
  await until(`!!${VIEW}.querySelector('.cmod-step')`, 'the guide', 8000);
  const head = await js(`[${VIEW}.querySelector('.cmod-name').textContent, ${VIEW}.querySelector('.cmod-kind').textContent, ide.toolWindows.get('MinecraftMod').title]`);
  check(await shown() && S(head) === S(['하늘 도구', 'Fabric · Minecraft 1.20.1', '마인크래프트']), `the Minecraft tool window opens with the mod's folder and names it, its loader and version (${S(head)})`);
  const rows = await js(`[...${VIEW}.querySelectorAll('.cmod-file')].map((r) => [r.dataset.role, r.querySelector('.cmod-file-name').textContent, r.querySelector('.cmod-file-what').textContent])`);
  check(S(rows.map((r) => r.slice(0, 2))) === S([['main', 'SkyTools.java'], ['client', 'SkyToolsClient.java'], ['meta', 'fabric.mod.json'], ['resources', 'resources'], ['properties', 'gradle.properties']])
    && /onInitialize/.test(rows[0][2]) && /시작되는 곳/.test(rows[0][2]) && rows.every((r) => r[2].length > 8),
  `the first step lists the files worth knowing, each with what it is (${S(rows)})`);
  check(S(await steps()) === S([['1', '코드 고치기'], ['2', '빌드하기'], ['3', '게임에서 확인하기'], ['4', '서버에 넣기']]), `the steps: change the code, build, see it in the game, put it on a server (${S(await steps())})`);
  await until(`(ide.active || '').endsWith('SkyTools.java')`, 'the main class opened by itself', 10000);
  check(true, 'the file the code starts in opens by itself when no file is open');
  await click('.cmod-file[data-role="meta"]');
  await until(`(ide.active || '').endsWith('fabric.mod.json')`, 'fabric.mod.json opened from its row', 8000);
  check(true, 'a row opens its file');
  const lists = [await options('cmodInstance'), await options('cmodServer')];
  check(S(lists) === S([[['survival', '생존 월드 · 1.20.1']], [['modded', 'modded · 1.20.1']]]), `only the instances and servers of the mod's loader and Minecraft version are offered (${S(lists)})`);
  await shot('guide.png');

  // ---------- build ----------
  const before = await js(`${VIEW}.querySelector('.cmod-built').textContent`);
  await click('.cmod-build');
  await idle('the build to end');
  await until(`${VIEW}.querySelector('.cmod-built').textContent.includes('sky_tools-1.0.0.jar')`, 'the window to name the jar', 8000);
  const buildLog = await runTab('하늘 도구 빌드');
  check(before === '아직 빌드하지 않았습니다.' && buildLog.includes(`JAVA_HOME=${java}`) && buildLog.includes('BUILD SUCCESSFUL') && buildLog.includes('sky_tools-1.0.0.jar 파일을 만들었습니다.') && (await state()).jar === 'sky_tools-1.0.0.jar',
    `Build runs the mod's Gradle in a Run tab and the window says what was built (${S([before, buildLog.slice(-120)])})`);

  // ---------- test in Minecraft ----------
  await click('.cmod-test');
  await idle('the test to end');
  const first = await startsReach(1);
  const inGame = modsOf(instDir('survival'));
  const testNote = await lastNote();
  check(S(inGame) === S([`fabric-api-${API}.jar`, 'sky_tools-1.0.0.jar']) && S(apiAsks()) === S([apiPath]), `Test puts the built jar into the instance and fetches the Fabric API the mod is built with (${S([inGame, apiAsks()])})`);
  check(first.length === 1 && first[0].profiles.some(([name, dir]) => /생존 월드/.test(name) && path.resolve(dir).toLowerCase() === instDir('survival').toLowerCase()),
    `the launcher opens with that instance's profile (${S(first)})`);
  check(/하늘 도구/.test(testNote[0]) && /플레이를 누르면/.test(testNote[1]) && testNote[1].includes(`Fabric API(${API})`) && !/[A-Za-z]{4,}/.test(testNote[1].replace(/Minecraft Launcher|Fabric API|\d[\w.+]*/g, '')),
    `and the user is told to press Play there, in Korean (${S(testNote)})`);
  const tools = await header();
  await click('[data-action="cmodTest"]');
  await idle('the second test to end');
  await startsReach(2);
  check(S(modsOf(instDir('survival'))) === S(inGame) && apiAsks().length === 1 && starts().length === 2, `a second test, from the window's toolbar, replaces the jar and fetches nothing again (${S([modsOf(instDir('survival')), apiAsks().length, starts().length])})`);
  check(S(tools) === S([['cmodClient', '테스트 클라이언트'], ['cmodTest', '게임에서 시험'], ['cmodBuild', '빌드']]), `the window's toolbar keeps the test client, Test and Build in reach (${S(tools)})`);

  write(path.join(modDir, 'src/main/resources/fabric.mod.json'), modJson({ ...DEPENDS, 'cloth-config': '>=11' }));
  await click('.cmod-test');
  await idle('the test with a missing mod to end');
  const lacking = await lastNote();
  check(/cloth-config/.test(lacking[1]) && /시작을 거부/.test(lacking[1]) && starts().length <= 3, `a mod the instance lacks is named (${S(lacking)})`);
  write(path.join(modDir, 'src/main/resources/fabric.mod.json'), modJson(DEPENDS));

  // What was downloaded as Fabric API is kept only when it is that.
  rmSync(path.join(instDir('survival'), 'mods', `fabric-api-${API}.jar`));
  routes.set(apiPath, zipOf({ 'fabric.mod.json': { schemaVersion: 1, id: 'something-else', version: '1' } }));
  await click('.cmod-test');
  await idle('the test with a wrong download to end');
  const wrong = await lastNote();
  check(!modsOf(instDir('survival')).some((n) => n.startsWith('fabric-api')) && /fabric-api/.test(wrong[1]), `a download that is not Fabric API is not kept, and the mod is said to lack it (${S([modsOf(instDir('survival')), wrong])})`);
  routes.set(apiPath, zipOf({ 'fabric.mod.json': { schemaVersion: 1, id: 'fabric-api', version: API } }));

  // ---------- a server ----------
  await click('.cmod-add');
  await idle('the add to end');
  const serverNote = await lastNote();
  check(S(modsOf(serverDir('modded'))) === S(['sky_tools-1.0.0.jar']) && /modded/.test(serverNote[0]) && /다시 시작하면/.test(serverNote[1]), `Build and Add puts the jar into the server and says where it is loaded (${S([modsOf(serverDir('modded')), serverNote])})`);

  // ---------- a failed build, a cancelled one ----------
  write(path.join(modDir, 'fail-build'), '');
  await click('.cmod-build');
  await idle('the failing build to end');
  const failedNote = await lastNote();
  const failLog = await runTab('하늘 도구 빌드');
  check(/빌드 실패/.test(failedNote[0]) && /빌드에 실패했습니다/.test(failedNote[1]) && failLog.includes('세미콜론이 없습니다') && (await state()).jar === 'sky_tools-1.0.0.jar',
    `a failed build is said in Korean with the compiler's own lines in the Run tab, and the earlier jar stays (${S([failedNote, failLog.slice(-100)])})`);
  rmSync(path.join(modDir, 'fail-build'));
  write(path.join(modDir, 'slow-build'), '');
  await click('.cmod-build');
  for (let i = 0; i < 100 && !read(path.join(modDir, 'slow-build')); i++) await sleep(100);
  const child = Number(read(path.join(modDir, 'slow-build')));
  const during = [await label('.cmod-build'), ...await js(`[${VIEW}.querySelector('.cmod-test').disabled, ${VIEW}.querySelector('.cmod-add').disabled]`), S(await header())];
  await click('.cmod-build');
  await idle('the cancelled build to end');
  for (let i = 0; i < 50 && alive(child); i++) await sleep(100);
  const after = await label('.cmod-build');
  // "Cancelled." is a phrase several plugins translate: the window's own tr() says which one shows.
  const cancelledText = await js(`tr('Cancelled.')`);
  const cancelLog = await runTab('하늘 도구 빌드');
  check(child > 0 && S(during) === S(['취소', true, true, S([['cmodCancel', '취소']])]) && !alive(child) && after === '빌드' && cancelLog.includes(cancelledText) && /취소/.test(cancelledText),
    `while a build runs its button is Cancel and the other steps wait; Cancel ends the build and the process it started (${S([during, after, child, alive(child), cancelLog.slice(-60)])})`);
  rmSync(path.join(modDir, 'slow-build'));

  // ---------- no instance of the mod's version: one is made from here ----------
  rmSync(instDir('survival'), { recursive: true, force: true });
  await js(`ide.craftMods.refresh()`);
  await until(`!!${VIEW}.querySelector('.cmod-new-instance')`, 'the offer to make an instance', 8000);
  const none = await js(`${VIEW}.querySelector('.cmod-none').textContent`);
  await click('.cmod-new-instance');
  await idle('the instance to be made');
  await until(`!!${VIEW}.querySelector('#cmodInstance')`, 'the new instance in the list', 8000);
  const made = (await state()).instances;
  const madeJson = made.length ? JSON.parse(read(path.join(instDir(made[0]), 'nano-instance.json'))) : {};
  check(/Fabric/.test(none) && /1\.20\.1/.test(none) && made.length === 1 && madeJson.loader === 'fabric' && madeJson.mc === '1.20.1' && madeJson.loaderVersion === '0.15.11' && madeJson.title === '하늘 도구 시험',
    `with no instance of the mod's loader and version, one is made from here (${S([none, made, madeJson.title, madeJson.loaderVersion])})`);

  // ---------- the test client, HotSwap, the Game View ----------
  const dbgOut = () => js(`document.querySelector('#dbgOut')?.textContent || ''`);
  const editAndSave = (file, text) => js(`(async () => { await ide.openFile(${S(file)}); const t = ide.findTab(${S(file)}); t.doc.model.setValue(${S(text)}); await ide.saveTab(t); return true; })()`);
  const outHas = (re, what, ms) => until(`${re}.test(document.querySelector('#dbgOut')?.textContent || '')`, what, ms);
  const gameState = () => js(`ide.craftMods.game.state()`);
  const GAME = `document.querySelector('.cmod-game')`;
  const modMain = path.join(modDir, 'src/main/java/com/example/SkyTools.java');
  const v = (n) => modSource(`\tpublic static String greeting() {\n\t\treturn "hello v${n}";\n\t}\n`);
  const offered = [await label('.cmod-client'), await js(`${VIEW}.querySelector('.cmod-client').disabled`), (await header()).map((x) => x[0]).join(), await js(`${GAME}.classList.contains('hidden')`)];
  check(S(offered) === S(['테스트 클라이언트', false, 'cmodClient,cmodTest,cmodBuild', true]), `a mod's guide offers the test client first, in the step and on the toolbar, and shows no Game View yet (${S(offered)})`);
  await click('.cmod-client');
  await outHas('/game: hello v1/', 'the test client running', 90000).catch(async (e) => { console.log(await dbgOut()); throw e; });
  const clientLog = await dbgOut();
  check(/gradlew runClient \(디버그 포트 \d+\)/.test(clientLog) && /--no-daemon --no-configuration-cache -I build\/pyide\/init\.gradle -Ppyide\.debugPort=\d+ -Ppyide\.classpathFile=build\/pyide\/classpath\.json pyideClasspath runClient/.test(clientLog)
    && clientLog.includes(`JAVA_HOME=${java}`) && /Fake Minecraft window open/.test(clientLog),
  `Test Client runs runClient through the mod's Gradle with the debug port, and the game starts under the debugger (${S(clientLog.slice(0, 500))})`);
  const initScript = read(path.join(modDir, 'build', 'pyide', 'init.gradle'));
  check(/tasks\.withType\(JavaExec\)\.matching \{ it\.name == 'runClient' \}/.test(initScript) && /suspend=y,address=127\.0\.0\.1:\$\{port\}/.test(initScript)
    && read(path.join(modDir, 'run', 'options.txt')).includes('pauseOnLostFocus:false'),
  'the init script gives runClient\'s JVM the JDWP agent, and the game is told to keep playing while Code has the keyboard (options.txt)');
  const while1 = [await label('.cmod-client'), await js(`${VIEW}.querySelector('.cmod-client').disabled`), await js(`${GAME}.classList.contains('hidden')`), await js(`${GAME}.querySelector('.cmod-step-title').textContent`)];
  check(S(while1) === S(['테스트 클라이언트 실행 중', true, false, '게임 화면']), `while it runs the step says so and the Game View shows at the top of the window (${S(while1)})`);

  await editAndSave(modMain, v(2));
  await outHas('/HotSwap: 클래스 1개를 게임에 반영했습니다/', 'the hot swap', 30000).catch(async (e) => { console.log(await dbgOut()); throw e; });
  await outHas('/game: hello v2/', 'the new code running', 10000)
    .then(() => check(true, 'saving the mod\'s code swaps it into the running game: its output changes without a restart'), async () => check(false, `HotSwap output: ${(await dbgOut()).slice(-800)}`));
  check(readFileSync(path.join(modDir, 'build', 'classes', 'java', 'main', 'com', 'example', 'SkyTools.class')).includes(Buffer.from('hello v2')) && /클래스 1개/.test((await gameState()).note),
    'the new class is also written over the build output, and the Game View says what was swapped');
  await editAndSave(modMain, modSource('\tpublic static String greeting() {\n\t\treturn "hello v2";\n\t}\n\n\tpublic static int added() {\n\t\treturn 1;\n\t}\n'));
  await outHas('/다시 시작해야 반영됩니다\\(a method was added\\)/', 'the refused swap', 30000)
    .then(() => check(true, 'a change the JVM cannot swap (a new method) says the game needs a restart, with the reason'), async () => check(false, `refused HotSwap: ${(await dbgOut()).slice(-800)}`));
  await until(`(() => { const t = document.querySelector('#dbgOut')?.textContent || ''; return t.slice(t.lastIndexOf('다시 시작해야')).includes('game: hello v2'); })()`, 'the game after a refused swap', 5000)
    .then(() => check(true, 'the game keeps running the last code that swapped'), async () => check(false, `after the refused swap: ${(await dbgOut()).slice(-400)}`));
  check(await js(`ide.craftMods.game.state().restart && ${GAME}.querySelector('.cmod-game-restart').classList.contains('primary') && ${GAME}.querySelector('.cmod-game-note').classList.contains('err')`),
    'the Game View says the change needs a restart and points at Restart');
  await editAndSave(modMain, 'package com.example;\n\npublic class SkyTools {\n\tpublic static String greeting() { return 1 }\n}\n');
  await outHas('/HotSwap: 저장한 코드가 컴파일되지 않습니다/', 'the compile error', 30000)
    .then(async () => check(/SkyTools\.java:4: error/.test(await dbgOut()), 'code that does not compile is said, with the compiler\'s own lines above'), async () => check(false, `compile error: ${(await dbgOut()).slice(-800)}`));
  await editAndSave(modMain, v(2));
  await sleep(1500);

  await until(`!!ide.craftMods.game.state().game?.hwnd`, 'the game window found', 20000).catch(async () => check(false, `game window: ${S(await gameState())}`));
  // The game's height is held against Code's own window, which got the same work area: with the window size emulated
  // (PYIDE_TEST_VIEWPORT) the page's screen.availHeight is the whole screen, taskbar included.
  const besideNow = `(() => { const t = document.querySelector('#dbgOut')?.textContent || ''; const m = [...t.matchAll(/game: bounds (-?\\d+),(-?\\d+),(\\d+),(\\d+)/g)].pop();
    const b = m && m.slice(1).map(Number); return { b, ide: [screenX, screenY, outerWidth, outerHeight], avail: [screen.availLeft, screen.availTop, screen.availWidth, screen.availHeight],
    ok: !!b && Math.abs(b[0] - (screen.availLeft + outerWidth)) <= 16 && Math.abs(b[2] - Math.max(480, Math.round(screen.availWidth * 0.4))) <= 16 && Math.abs(b[3] - outerHeight) <= 16 && outerWidth < screen.availWidth * 0.7 }; })()`;
  await until(`${besideNow}.ok`, 'the game beside Code', 15000).catch(() => {});
  const beside = await js(besideNow);
  const status = await js(`${GAME}.querySelector('.cmod-game-status').textContent`);
  check(beside.ok && /Code 옆에/.test(status), `Beside Code gives the game the right part of the screen and Code the rest (${S([beside, status])})`);

  const lang = path.join(modDir, 'src/main/resources/assets/sky_tools/lang/en_us.json');
  writeFileSync(lang, '{ "itemGroup.sky_tools": "Sky Tools v2" }\n');
  const copied = await js(`ide.api.invoke('craft-mods:hotswapResources', ide.root, [${S(lang)}, ${S(path.join(modDir, 'src/main/resources/fabric.mod.json'))}, ${S(path.join(home, 'servers', 'modded', 'server.properties'))}])`);
  check(S(copied) === S({ copied: ['assets/sky_tools/lang/en_us.json'], assets: true, data: false }) && read(path.join(modDir, 'build/resources/main/assets/sky_tools/lang/en_us.json')).includes('Sky Tools v2')
    && !existsSync(path.join(modDir, 'build/resources/main/fabric.mod.json')),
  `a saved file under assets/ is written over the resources the game reads; the mod's descriptor and a file outside the mod are not (${S(copied)})`);

  // Inside Code: the game's window is named for the page and its picture starts. Windows ends the capture of a window
  // on a desktop that is not the one shown (verify/on-desktop.ps1 runs the suites on such a desktop) within a moment,
  // so the picture itself is checked only where it stays; where it ends, the Game View must say so.
  await js(`((() => { const sel = ${GAME}.querySelector('.cmod-game-mode'); sel.value = 'inside'; sel.dispatchEvent(new Event('change')); })(), true)`);
  await until(`ide.craftMods.game.state().pictures >= 1`, 'the game picture to start', 30000)
    .then(() => check(true, 'Inside Code names the game window for the page, and the page gets its picture'),
      async () => check(false, `game picture: ${S(await gameState())} ${S((await dbgOut()).split('\n').filter((l) => !l.startsWith('game: ')).slice(-6))}`));
  await sleep(1500);
  const pictured = await gameState();
  if (pictured.streaming) {
    const centre = await js(`(() => { const vid = ${GAME}.querySelector('video'); if (!vid.videoWidth) return [0, 0, 0]; const c = document.createElement('canvas'); c.width = vid.videoWidth; c.height = vid.videoHeight;
      const g = c.getContext('2d'); g.drawImage(vid, 0, 0); return [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)]; })()`);
    check(centre[1] > 120 && centre[0] < 100 && centre[2] < 120, `the picture is the game window's (green at its centre: ${S(centre)})`);
  } else {
    const told = await js(`${GAME}.querySelector('.cmod-game-status').textContent`);
    console.log('SKIP the picture itself: Windows ended the capture, as it does for a window on a desktop that is not shown');
    check(pictured.lost && /화면이 멈췄습니다/.test(told) && await js(`${GAME}.querySelector('.cmod-game-screen').classList.contains('hidden')`), `a picture that ends is said, and its box goes (${S([pictured.lost, told])})`);
  }
  await js(`(${VIEW}.scrollTop = 0, true)`);
  await shot('game-view.png');
  const firstWindow = pictured.game?.hwnd;
  await click('.cmod-game-restart');
  await until(`(() => { const st = ide.craftMods.game.state(); return st.pictures >= ${pictured.pictures + 1} && st.game?.hwnd && st.game.hwnd !== ${Number(firstWindow) || 0}; })()`, 'the restarted game', 90000)
    .then(() => check(true, 'Restart debugs the test client again, and the Game View takes the new game\'s window'), async () => check(false, `restart: ${S(await gameState())} ${(await dbgOut()).slice(-600)}`));
  const gameEnglish = await js(`[...${GAME}.querySelectorAll('.cmod-step-title, .cmod-btn, option, label, .cmod-game-status, .cmod-game-note')].map((n) => n.textContent).filter((x) => /[A-Za-z]{4,}/.test(x.replace(/Minecraft\\*? Fake|Minecraft|Code|HotSwap/g, '')))`);
  check(!gameEnglish.length, `nothing of the Game View's own words is left in English (${S(gameEnglish)})`);
  await click('.cmod-game-stop');
  await until(`!ide.craftMods.game.state().client && !window.__debugger.state()`, 'the client ended', 30000);
  const after2 = [await label('.cmod-client'), await js(`${GAME}.classList.contains('hidden')`)];
  check(S(after2) === S(['테스트 클라이언트', true]), `Stop ends the game: the step offers the client again and the Game View goes (${S(after2)})`);
  await js(`(ide.settings.set('craftMods.gameView', 'beside'), true)`);

  // ---------- nothing left in English, in both themes ----------
  const english = await js(`[...${VIEW}.querySelectorAll('.cmod-guide .cmod-step-title, .cmod-sub, .cmod-note, .cmod-file-what, .cmod-guide .cmod-btn, .cmod-built')].map((n) => n.textContent).filter((x) => /[A-Za-z]{4,}/.test(x.replace(/Minecraft Launcher|Minecraft|Fabric API|Fabric|Nano Studio Craft|Gradle|Java|onInitialize|sky_tools[\\w.-]*|[\\d.+]+/g, '')))`);
  check(!english.length, `nothing of the window's own words is left in English (${S(english)})`);
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000);
  await js(`(${VIEW}.scrollTop = 0, true)`);
  await sleep(400);
  await shot('guide-light.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`document.documentElement.dataset.theme !== 'light'`, 'the dark theme', 5000);

  // ---------- a plugin's folder, then a project that is neither ----------
  await js(`ide.openProject(${S(pluginDir)})`);
  await until(`ide.craftMods.state().project?.kind === 'plugin' && !!${VIEW}.querySelector('.cmod-step')`, 'the plugin recognised', 20000);
  const plug = await js(`[${VIEW}.querySelector('.cmod-name').textContent, ${VIEW}.querySelector('.cmod-kind').textContent, [...${VIEW}.querySelectorAll('.cmod-file')].map((r) => r.dataset.role + ':' + r.querySelector('.cmod-file-name').textContent),
    [...${VIEW}.querySelectorAll('.cmod-note')].map((n) => n.textContent).join(' | '), !!${VIEW}.querySelector('.cmod-test')]`);
  check(await shown() && plug[0] === 'Gate' && plug[1] === 'Paper 플러그인' && S(plug[2]) === S(['main:Gate.java', 'meta:plugin.yml', 'resources:resources']) && /lobby 서버를 한 번 시작/.test(plug[3]) && /onEnable/.test(plug[3] + (await js(`${VIEW}.querySelector('.cmod-file-what').textContent`))) && plug[4] === false
    && S(await steps()) === S([['1', '코드 고치기'], ['2', '빌드하기'], ['3', '서버에 넣기']]) && S(await options('cmodServer')) === S([['lobby', 'lobby · 1.20.1']]),
  `a plugin's folder shows its own steps: its files, the server it is built against and the servers that take it, with no game to test in (${S(plug)})`);
  await shot('plugin-guide.png');
  await js(`ide.openProject(${S(plain)})`);
  await until(`ide.root && ide.root.toLowerCase() === ${S(plain.toLowerCase())} && ide.craftMods.state().project === null`, 'the plain project', 20000);
  await until(`!ide.toolWindows.get('MinecraftMod').isVisible()`, 'the window to hide', 8000);
  check(!(await js(`ide.toolWindows.get('MinecraftMod').available()`)), 'a project that is neither hides the window and takes it off the tool window list');
  check(!t.consoleErrors.length, `no renderer exceptions ${S(t.consoleErrors)}`);
} catch (err) {
  check(false, `code-mods crashed: ${err.stack || err}`);
}
server.close();
t.finish();
