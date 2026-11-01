// Nano Studio Craft's launcher core (main/minecraft/launcher.js) through its launcher:* IPC in a code-mode window,
// against stand-ins only: a local web server plays Mojang, Fabric's and Quilt's meta, the Forge Maven, Modrinth and a
// server's client pack; small Java programs play the Forge installer (its headless --installClient, and an old one
// without it); a Node script plays the official Minecraft Launcher (it records its arguments and a copy of
// launcher_profiles.json). No real launcher, no game, no sign-in, no EULA. Checks: versions and loader versions,
// instances (Fabric, Quilt, Forge, Vanilla) with their loader versions installed, the profile merged into the
// launcher's own file, the instance's version with Quick Play (1.20+), --server/--port (1.13-1.19) or a full argument
// line (before 1.13), Play starting the launcher with --workDir, a join code parsed and joined, the server's pack
// synced (added, updated, removed, a user's mod and a disabled pack mod kept, a bad hash changing nothing, Minecraft
// and the loader following the pack), modpacks from a file and from Modrinth, mods turned off and on, Remove, the
// servers list, and noLauncher, and the code-mode Minecraft screen's Play and Servers to Join pages. Port 9895. Then
// the same through Nano Studio Craft's UI in craft mode (craftUi, below; ports 9897-9898; screenshots craft-play.png,
// craft-join-error.png, craft-servers.png, craft-my-servers.png, craft-settings.png, craft-play-900.png,
// craft-no-launcher.png and craft-unreachable.png).
// MC_LAUNCHER_LIVE=1 instead installs the real Fabric, Quilt, Forge and NeoForge client loaders into a temporary
// .launcher (Mojang, Maven and Adoptium downloads, several hundred MB; not in CI) and prints what the real Forge and
// NeoForge installers accept on their command line. Port 9896.
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const work = mkdtempSync(path.join(tmpdir(), 'pyide-mclauncher-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');
const javaHome = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME_17_X64 || process.env.JAVA_HOME
  || path.dirname(path.dirname(execFileSync('where', ['javac'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()));
const bin = (t) => path.join(javaHome, 'bin', `${t}.exe`);

// The stand-in launcher: each start appends {args, cwd} to the log and copies the profiles it was given.
const launcherLog = path.join(work, 'launcher', 'starts.jsonl');
const fakeLauncher = path.join(work, 'launcher', 'fake-launcher.cjs');
write(fakeLauncher, `const fs = require('fs');
const path = require('path');
const [log, ...args] = process.argv.slice(2);
const dir = args[args.indexOf('--workDir') + 1];
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length + 1 : 1;
fs.copyFileSync(path.join(dir, 'launcher_profiles.json'), log + '.' + n + '.json');
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
`);
const LAUNCHER = S([process.execPath, fakeLauncher, launcherLog]);
const starts = () => (existsSync(launcherLog) ? readFileSync(launcherLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// The launcher is started detached: its record comes a moment after Play returns.
const startsReach = async (n) => {
  for (let i = 0; i < 100 && starts().length < n; i++) await new Promise((r) => setTimeout(r, 100));
  return starts();
};

if (process.env.MC_LAUNCHER_LIVE === '1') await live();

// ---------- stand-in Forge installers ----------
// One that installs a client headlessly as the real one does (refusing a folder without launcher_profiles.json), and
// an old one whose only client install is its window.
const installer = (dir, id, body) => {
  write(path.join(dir, 'src', 'net', 'minecraftforge', 'installer', 'SimpleInstaller.java'), `package net.minecraftforge.installer;
import java.nio.file.*;
public class SimpleInstaller {
  public static void main(String[] a) throws Exception {
${body}
  }
}`);
  execFileSync(bin('javac'), ['--release', '8', '-nowarn', '-d', path.join(dir, 'classes'), path.join(dir, 'src', 'net', 'minecraftforge', 'installer', 'SimpleInstaller.java')]);
  write(path.join(dir, 'res', 'install_profile.json'), S({ spec: 1, profile: 'forge', version: id, minecraft: '1.20.1' }));
  const jar = path.join(dir, 'installer.jar');
  execFileSync(bin('jar'), ['--create', '--file', jar, '--main-class', 'net.minecraftforge.installer.SimpleInstaller', '-C', path.join(dir, 'classes'), '.', '-C', path.join(dir, 'res'), '.']);
  return readFileSync(jar);
};
const headlessInstall = (id, mc) => `
    if (a.length < 2 || !a[0].equals("--installClient")) { System.out.println("usage: --installClient <dir>"); System.exit(2); }
    Path target = Paths.get(a[1]);
    if (!Files.exists(target.resolve("launcher_profiles.json"))) { System.out.println("There is no minecraft launcher profile"); System.exit(1); }
    Path v = target.resolve("versions").resolve("${id}");
    Files.createDirectories(v);
    Files.write(v.resolve("${id}.json"), "{\\"id\\": \\"${id}\\", \\"inheritsFrom\\": \\"${mc}\\", \\"mainClass\\": \\"cpw.mods.bootstraplauncher.BootstrapLauncher\\"}".getBytes());
    Files.write(Paths.get("installer.log"), "ok".getBytes());
    System.out.println("Successfully installed client profile forge");`;
const FORGE_ID = '1.20.1-forge-47.9.9';
const forgeJar = installer(path.join(work, 'forge'), FORGE_ID, headlessInstall(FORGE_ID, '1.20.1'));
const NEO_ID = 'neoforge-20.4.237';
const neoJar = installer(path.join(work, 'neoforge'), NEO_ID, headlessInstall(NEO_ID, '1.20.4'));
const oldForgeJar = installer(path.join(work, 'forge-old'), '1.12.2-forge-14.23.5.2860', `
    System.out.println("This installer only has a window");
    System.exit(3);`);

// A stand-in Minecraft server for My Servers: it listens on server.properties' port and quits at "stop", or after two
// minutes when a failed run leaves it behind.
const gameServerDir = path.join(work, 'game-server');
write(path.join(gameServerDir, 'StandInServer.java'), `import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
public class StandInServer {
  public static void main(String[] a) throws Exception {
    Properties p = new Properties();
    try (InputStream in = Files.newInputStream(Paths.get("server.properties"))) { p.load(in); }
    ServerSocket s = new ServerSocket(Integer.parseInt(p.getProperty("server-port")));
    System.out.println("Done (0.1s)!");
    Thread limit = new Thread(() -> { try { Thread.sleep(120000); } catch (Exception e) {} System.exit(0); });
    limit.setDaemon(true);
    limit.start();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    for (String l; (l = in.readLine()) != null; ) if (l.trim().equals("stop")) break;
    System.exit(0);
  }
}`);
execFileSync(bin('javac'), ['--release', '8', '-nowarn', '-d', path.join(gameServerDir, 'classes'), path.join(gameServerDir, 'StandInServer.java')]);
const gameServerJar = path.join(gameServerDir, 'server.jar');
execFileSync(bin('jar'), ['--create', '--file', gameServerJar, '--main-class', 'StandInServer', '-C', path.join(gameServerDir, 'classes'), '.']);
const fakeTunnel = path.join(work, 'fake-cloudflared.cjs');
writeFileSync(fakeTunnel, `const port = (process.argv.join(' ').match(/:(\\d+)/) || [])[1];
setTimeout(() => process.stderr.write('INF |  https://fake-port-' + port + '.trycloudflare.com  |\\nINF Registered tunnel connection\\n'), 200);
setInterval(() => {}, 1000);
`);
const fakeBore = path.join(work, 'fake-bore.cjs');
writeFileSync(fakeBore, `const port = Number(process.argv[process.argv.indexOf('local') + 1]);
setTimeout(() => console.log('INFO bore_cli::client: listening at bore.pub:' + (40000 + port % 1000)), 200);
setInterval(() => {}, 1000);
`);

// ---------- client packs (.mrpack, written by Python's zipfile) ----------
const mrpack = (index, entries = {}) => {
  const file = path.join(work, 'packs', `${crypto.randomBytes(4).toString('hex')}.mrpack`);
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('py', ['-3', '-I', '-c', `import zipfile, sys, json, base64
z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED)
z.writestr('modrinth.index.json', sys.argv[2])
for name, data in json.loads(sys.argv[3]).items():
    z.writestr(name, base64.b64decode(data))
z.close()`, file, S(index), S(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v).toString('base64')])))]);
  return readFileSync(file);
};

// ---------- stand-in services ----------
const routes = new Map();
const requests = [];
const HANG = Symbol('a download that starts and then says nothing');
const server = http.createServer((q, r) => {
  requests.push(q.url);
  const route = routes.get(q.url.split('?')[0]);
  const body = typeof route === 'function' ? route(q.url) : route;
  if (body === undefined) { r.writeHead(404); return r.end(); }
  if (body === HANG) { r.writeHead(200, { 'Content-Length': 100000 }); return r.write('x'); }
  r.writeHead(200);
  r.end(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : S(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const file = (name, data) => { routes.set(`/files/${name}`, Buffer.from(data)); return `${base}/files/${name}`; };
const OLD_LINE = '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory}';
routes.set('/mojang/manifest.json', { latest: { release: '1.20.4' }, versions: ['1.20.4', '1.20.1', '1.19.4', '1.12.2'].map((id) => ({ id, type: 'release', url: `${base}/mojang/${id}.json` })) });
for (const id of ['1.20.4', '1.20.1', '1.19.4']) routes.set(`/mojang/${id}.json`, { id, javaVersion: { majorVersion: 17 } });
routes.set('/mojang/1.12.2.json', { id: '1.12.2', javaVersion: { majorVersion: 8 }, minecraftArguments: OLD_LINE });
routes.set('/fabric/versions/game', [{ version: '1.20.4', stable: true }, { version: '1.20.1', stable: true }, { version: '24w03a', stable: false }]);
for (const mc of ['1.20.1', '1.20.4']) {
  routes.set(`/fabric/versions/loader/${mc}`, [{ loader: { version: '0.16.0', stable: false } }, { loader: { version: '0.15.11', stable: true } }]);
  for (const v of ['0.15.11', '0.16.0']) {
    routes.set(`/fabric/versions/loader/${mc}/${v}/profile/json`, { id: `fabric-loader-${v}-${mc}`, inheritsFrom: mc, type: 'release', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] }, libraries: [{ name: `net.fabricmc:fabric-loader:${v}`, url: 'https://maven.fabricmc.net/' }] });
  }
}
routes.set('/quilt/versions/game', [{ version: '1.20.1', stable: true }, { version: '23w31a', stable: false }]);
routes.set('/quilt/versions/loader/1.20.1', [{ loader: { version: '0.26.0-beta.1' } }, { loader: { version: '0.25.0' } }]);
routes.set('/quilt/versions/loader/1.20.1/0.25.0/profile/json', { id: 'quilt-loader-0.25.0-1.20.1', inheritsFrom: '1.20.1', mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient', libraries: [] });
routes.set('/forge/promos.json', { promos: { '1.20.1-recommended': '47.9.9', '1.20.1-latest': '47.9.10', '1.12.2-recommended': '14.23.5.2860' } });
routes.set('/forge/maven-metadata.xml', '<metadata><versioning><versions><version>1.12.2-14.23.5.2860</version><version>1.20.1-47.9.9</version><version>1.20.1-47.9.10</version></versions></versioning></metadata>');
routes.set('/forge/1.20.1-47.9.9/forge-1.20.1-47.9.9-installer.jar', forgeJar);
routes.set('/forge/1.20.1-47.9.9/forge-1.20.1-47.9.9-installer.jar.sha256', sha('sha256', forgeJar));
routes.set('/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar', oldForgeJar);
routes.set('/neoforge/maven-metadata.xml', '<metadata><versioning><versions><version>20.4.200-beta</version><version>20.4.237</version></versions></versioning></metadata>');
routes.set('/neoforge/20.4.237/neoforge-20.4.237-installer.jar', neoJar);
routes.set('/neoforge/20.4.237/neoforge-20.4.237-installer.jar.sha256', sha('sha256', neoJar));

// The server's pack: v1, then v2 (Minecraft 1.20.4; mod-a updated, mod-b gone, mod-c new, the client overrides gone),
// then v3 (a file whose hash does not match).
const modFile = (name, data, { hashes = ['sha512'], env } = {}) => ({ path: `mods/${name}`, downloads: [file(name, data)], fileSize: Buffer.byteLength(data),
  hashes: Object.fromEntries(hashes.map((h) => [h, sha(h, Buffer.from(data))])), ...(env ? { env } : {}) });
const deps = (mc, extra = { 'fabric-loader': '0.15.11' }) => ({ minecraft: mc, ...extra });
const PACKS = {
  v1: mrpack({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Test Server', dependencies: deps('1.20.1'), files: [
    modFile('mod-a.jar', 'mod a 1'), modFile('mod-b.jar', 'mod b 1', { hashes: ['sha1'] }),
    modFile('server-only.jar', 'server only', { env: { client: 'unsupported', server: 'required' } }),
  ] }, { 'overrides/config/a.toml': 'v = 1', 'client-overrides/options.txt': 'guiScale:2', 'server-overrides/server.txt': 'server' }),
  v2: mrpack({ formatVersion: 1, game: 'minecraft', versionId: '2', name: 'Test Server', dependencies: deps('1.20.4'), files: [
    modFile('mod-a-v2.jar', 'mod a 2'), modFile('mod-c.jar', 'mod c 1'),
  ].map((f) => (f.path === 'mods/mod-a-v2.jar' ? { ...f, path: 'mods/mod-a.jar' } : f)) }, { 'overrides/config/a.toml': 'v = 2' }),
  v3: mrpack({ formatVersion: 1, game: 'minecraft', versionId: '3', name: 'Test Server', dependencies: deps('1.20.4'), files: [
    modFile('mod-a-v2.jar', 'mod a 2'), { ...modFile('mod-d.jar', 'mod d'), hashes: { sha1: '0'.repeat(40) } },
  ].map((f) => (f.path === 'mods/mod-a-v2.jar' ? { ...f, path: 'mods/mod-a.jar' } : f)) }),
};
let served = 'v1';
routes.set('/packs/server.mrpack', () => PACKS[served]);
const packUrl = `${base}/packs/server.mrpack`;
const packFetches = () => requests.filter((u) => u.startsWith('/packs/server.mrpack')).length;
// A Quilt modpack as a file, and a Fabric one on Modrinth.
const quiltPack = path.join(work, 'Quilt Pack.mrpack');
writeFileSync(quiltPack, mrpack({ formatVersion: 1, game: 'minecraft', versionId: '0.3', name: 'Quilt Pack', dependencies: deps('1.20.1', { 'quilt-loader': '0.25.0' }), files: [modFile('q.jar', 'quilt mod')] }));
const market = mrpack({ formatVersion: 1, game: 'minecraft', versionId: '5.0', name: '모드팩 Market', dependencies: deps('1.20.1'), files: [modFile('m.jar', 'market mod')] });
routes.set('/files/market.mrpack', market);
routes.set('/modrinth/project/market-pack/version', [{ id: 'mv', version_number: '5.0', files: [{ filename: 'market.mrpack', url: `${base}/files/market.mrpack`, primary: true, size: market.length, hashes: { sha512: sha('sha512', market) } }] }]);

const SOURCES = S({ mojang: `${base}/mojang/manifest.json`, fabric: `${base}/fabric`, quilt: `${base}/quilt`, forge: `${base}/forge`, forgePromos: `${base}/forge/promos.json`,
  neoforge: `${base}/neoforge`, modrinth: `${base}/modrinth`, adoptium: `${base}/adoptium` });
const project = path.join(work, 'project');
const launcherDir = path.join(project, '.launcher');
// The launcher's own profiles and settings, there before Nano Studio's.
write(path.join(launcherDir, 'launcher_profiles.json'), S({ profiles: { abc123: { name: 'Latest release', type: 'latest-release', lastVersionId: 'latest-release', icon: 'Furnace' } },
  settings: { enableSnapshots: true, locale: 'ko-kr' }, version: 3 }, null, 2));
const t = await launch({ name: 'minecraft-launcher', port: 9895, projectDir: project, env: { PYIDE_MC_JAVA: javaHome, PYIDE_MC_LAUNCHER: LAUNCHER, PYIDE_MC_SOURCES: SOURCES } });
const { js, check, shot } = t;
const call = (ch, ...args) => js(`ide.api.invoke(${S(ch)}, ${args.map((a) => (a === undefined ? 'undefined' : S(a))).join(', ')}).then((r) => ({ ok: r }), (e) => ({ err: String(e.message || e) }))`);
const ok = async (ch, ...args) => {
  const r = await call(ch, ...args);
  if (r.err) throw new Error(`${ch}: ${r.err}`);
  return r.ok;
};
const inst = (name) => path.join(project, 'instances', name);
const version = (id) => readJson(path.join(launcherDir, 'versions', id, `${id}.json`));
const profiles = () => readJson(path.join(launcherDir, 'launcher_profiles.json'));
const has = (p) => existsSync(p);
const text = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

try {
  await js(`(window.__mcLog = [], ide.api.on('minecraft:log', (m) => window.__mcLog.push(m)), true)`);
  const logOf = (job) => js(`window.__mcLog.filter((m) => m.job === ${S(job)}).map((m) => m.text).join('')`);

  // ---------- status and versions ----------
  const status = await ok('launcher:status', project);
  check(status.launcher === process.execPath && path.resolve(status.workDir) === launcherDir && path.resolve(status.instancesDir) === path.join(project, 'instances') && status.method === 'official',
    `launcher:status names the launcher (PYIDE_MC_LAUNCHER first), its work folder and the instances folder (${S(status)})`);
  check(S(await ok('launcher:versions', 'fabric')) === S(['1.20.4', '1.20.1']) && S(await ok('launcher:versions', 'quilt')) === S(['1.20.1'])
    && S(await ok('launcher:versions', 'vanilla')) === S(['1.20.4', '1.20.1', '1.19.4', '1.12.2']), 'launcher:versions lists the stable Minecraft versions of each loader');
  const fl = await ok('launcher:loaderVersions', 'fabric', '1.20.1');
  const ql = await ok('launcher:loaderVersions', 'quilt', '1.20.1');
  const fg = await ok('launcher:loaderVersions', 'forge', '1.20.1');
  check(fl.recommended === '0.15.11' && fl.versions[0] === '0.16.0' && ql.recommended === '0.25.0' && fg.recommended === '47.9.9' && S(fg.versions) === S(['47.9.10', '47.9.9']),
    `loader versions come newest first with the stable or recommended one to pick (${S({ fl, ql, fg })})`);

  // ---------- create ----------
  const fab = await ok('launcher:create', project, { name: 'fab', mc: '1.20.1', loader: 'fabric' }, 'job-fab');
  const fabDesc = readJson(path.join(inst('fab'), 'nano-instance.json'));
  check(fab.name === 'fab' && fab.loaderVersion === '0.15.11' && fab.loaderId === 'fabric-loader-0.15.11-1.20.1' && fabDesc.loader === 'fabric' && fabDesc.mc === '1.20.1'
    && has(path.join(inst('fab'), 'mods')) && version('fabric-loader-0.15.11-1.20.1').mainClass === 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  `create (Fabric) writes nano-instance.json and saves Fabric's profile JSON from its meta service into .launcher/versions (${S(fabDesc)})`);
  check(/Fabric 0\.15\.11/.test(await logOf('job-fab')), 'the create job streams minecraft:log');
  const again = await call('launcher:create', project, { name: 'fab', mc: '1.20.1', loader: 'fabric' }, 'x');
  check(/already exists/.test(again.err || ''), `a second instance of the same name is refused (${again.err})`);
  const korean = await ok('launcher:create', project, { name: '내 월드', mc: '1.20.1', loader: 'vanilla' }, 'x');
  check(korean.name === 'instance' && korean.title === '내 월드' && korean.loaderId === '1.20.1', `a name that is no folder name becomes the title of a made-up folder (${korean.name}, ${korean.title})`);
  const quilt = await ok('launcher:fromPack', project, { file: quiltPack }, 'job-quilt');
  check(quilt.loader === 'quilt' && quilt.loaderId === 'quilt-loader-0.25.0-1.20.1' && quilt.title === 'Quilt Pack' && text(path.join(quilt.dir, 'mods', 'q.jar')) === 'quilt mod' && has(quiltPack),
    'fromPack (a file) makes a Quilt instance with the pack\'s mods and Quilt\'s profile, and leaves the file');
  const forge = await ok('launcher:create', project, { name: 'forgey', mc: '1.20.1', loader: 'forge' }, 'job-forge');
  check(forge.loaderVersion === '47.9.9' && forge.loaderId === FORGE_ID && has(path.join(launcherDir, 'versions', FORGE_ID, `${FORGE_ID}.json`))
    && !readdirSync(launcherDir).some((n) => /^installer-/.test(n)),
  'create (Forge) runs the installer headlessly (--installClient .launcher, after launcher_profiles.json exists) and removes it afterwards');
  const old = await call('launcher:create', project, { name: 'oldforge', mc: '1.12.2', loader: 'forge' }, 'x');
  check(/installClient/.test(old.err || '') && !has(inst('oldforge')), `an installer without a headless client install is a clear error, and leaves no instance (${old.err})`);

  // ---------- play ----------
  const p1 = await ok('launcher:play', project, 'fab', {}, 'job-play');
  const s1 = await startsReach(1);
  const at = s1[0]?.args.indexOf('--workDir');
  check(p1.launched && p1.versionId === 'nano-fab' && s1.length === 1 && at >= 0 && path.resolve(s1[0].args[at + 1]) === launcherDir,
    `Play starts the launcher with --workDir .launcher (${S(s1[0]?.args)})`);
  const pf = readJson(`${launcherLog}.1.json`);
  const mine = pf.profiles['nano-fab'];
  check(mine && mine.type === 'custom' && mine.lastVersionId === 'nano-fab' && path.resolve(mine.gameDir) === inst('fab') && mine.javaArgs === '-Xmx4G' && mine.icon === 'Grass' && mine.name === 'fab (Nano Studio)' && mine.lastUsed,
    `the launcher is given a custom profile for the instance (${S(mine)})`);
  check(pf.profiles.abc123?.icon === 'Furnace' && pf.settings?.locale === 'ko-kr' && pf.version === 3, 'the launcher\'s own profiles and settings are kept: the file is merged');
  const v1 = version('nano-fab');
  check(v1.inheritsFrom === 'fabric-loader-0.15.11-1.20.1' && !v1.arguments && !v1.minecraftArguments, `the instance's version inherits from the loader's, with no server to join (${S(v1)})`);
  const playLog = await logOf('job-play');
  check(/Starting the Minecraft Launcher/.test(playLog) && !/Sign in/.test(playLog), `Play's job log names the start; the sign-in hint is the renderer's, in the UI's language (${S(playLog.slice(-120))})`);
  await ok('launcher:play', project, 'fab', { server: 'play.example.test:25570' }, 'x');
  check(S(version('nano-fab').arguments) === S({ game: ['--quickPlayMultiplayer', 'play.example.test:25570'] }) && readJson(path.join(inst('fab'), 'nano-instance.json')).server?.address === 'play.example.test:25570',
    'joining a server on Minecraft 1.20+ adds --quickPlayMultiplayer host:port');
  await ok('launcher:play', project, 'fab', {}, 'x');
  check(!version('nano-fab').arguments, 'a later Play without a server writes the version without it again');
  await ok('launcher:create', project, { name: 'old119', mc: '1.19.4' }, 'x');
  await ok('launcher:play', project, 'old119', { server: { address: 'old.example.test' } }, 'x');
  check(version('nano-old119').inheritsFrom === '1.19.4' && S(version('nano-old119').arguments) === S({ game: ['--server', 'old.example.test', '--port', '25565'] }),
    'Minecraft before 1.20 gets --server host --port port');
  await ok('launcher:create', project, { name: 'old112', mc: '1.12.2' }, 'x');
  await ok('launcher:play', project, 'old112', { server: 'legacy.example.test:25599' }, 'x');
  check(version('nano-old112').minecraftArguments === `${OLD_LINE} --server legacy.example.test --port 25599`, `before 1.13 the whole argument line is written, Mojang's first (${version('nano-old112').minecraftArguments})`);
  const lastUsed = profiles().profiles['nano-old112'].lastUsed;
  check(Object.values(profiles().profiles).every((p) => !p.lastUsed || p.lastUsed <= lastUsed), 'the instance just played is the profile used last, which the launcher preselects');

  // ---------- join code, servers and the pack ----------
  const code = await ok('launcher:joinCode', { address: 'mc.example.test:25580', pack: packUrl, name: 'Test Server' });
  const parsed = await ok('launcher:parseJoinCode', `친구가 보낸 코드: ${code} 입니다`);
  check(code.startsWith('nanostudio:join?addr=mc.example.test:25580&pack=') && parsed.address === 'mc.example.test:25580' && parsed.pack === packUrl && parsed.name === 'Test Server',
    `a join code is made and read back from pasted text (${code})`);
  const bad = await call('launcher:parseJoinCode', 'nanostudio:join?addr=exa_mple:1');
  check(/not a server address/.test(bad.err || ''), `a join code with a bad address is refused (${bad.err})`);
  const asked = await ok('launcher:join', project, { code }, 'job-join');
  check(asked.needsApproval?.sha1 === sha('sha1', PACKS.v1) && asked.needsApproval.mods.some((m) => m.file === 'mods/mod-a.jar') && !asked.needsApproval.mods.some((m) => /server-only/.test(m.file)) && !has(path.join(project, 'servers-list.json')),
    `a join code's pack waits for the user's yes, and nothing is saved before it (${S(asked.needsApproval?.mods)})`);
  const joined = await ok('launcher:join', project, { code, approve: asked.needsApproval.sha1 }, 'job-join');
  const tdir = joined.instance.dir;
  const tdesc = readJson(path.join(tdir, 'nano-instance.json'));
  check(joined.server.address === 'mc.example.test:25580' && joined.server.pack === packUrl && joined.instance.title === 'Test Server'
    && tdesc.mc === '1.20.1' && tdesc.loader === 'fabric' && tdesc.loaderVersion === '0.15.11' && tdesc.loaderId === 'fabric-loader-0.15.11-1.20.1',
  `join (code) makes the instance from the server's pack: Minecraft and the loader are the pack's (${S(tdesc)})`);
  check(text(path.join(tdir, 'mods', 'mod-a.jar')) === 'mod a 1' && text(path.join(tdir, 'mods', 'mod-b.jar')) === 'mod b 1' && text(path.join(tdir, 'config', 'a.toml')) === 'v = 1'
    && text(path.join(tdir, 'options.txt')) === 'guiScale:2' && !has(path.join(tdir, 'mods', 'server-only.jar')) && !has(path.join(tdir, 'server.txt'))
    && S([...tdesc.pack.files].sort()) === S(['config/a.toml', 'mods/mod-a.jar', 'mods/mod-b.jar', 'options.txt']) && tdesc.pack.sha1 === sha('sha1', PACKS.v1),
  `the pack's client files and overrides are installed, server-only ones are not, and pack.files records them (${S(tdesc.pack)})`);
  const saved = await ok('launcher:servers', project);
  check(saved.length === 1 && saved[0].instance === joined.instance.name && saved[0].name === 'Test Server', `the server is saved to servers-list.json (${S(saved)})`);
  const fetchesBefore = packFetches();
  await ok('launcher:play', project, joined.instance.name, { server: 'mc.example.test:25580' }, 'x');
  check(packFetches() === fetchesBefore && S(version(`nano-${joined.instance.name}`).arguments.game) === S(['--quickPlayMultiplayer', 'mc.example.test:25580']),
    'the first Play right after joining does not download the pack again, and joins the server');
  // The user's own mod, and a pack mod the user turned off.
  write(path.join(tdir, 'mods', 'user-mod.jar'), 'mine');
  const off = await ok('launcher:setMod', project, joined.instance.name, 'mod-a.jar', false);
  check(off.find((m) => m.name === 'mod-a.jar')?.enabled === false && off.find((m) => m.name === 'mod-a.jar').fromPack && off.find((m) => m.name === 'user-mod.jar')?.fromPack === false
    && has(path.join(tdir, 'mods', 'mod-a.jar.disabled')), 'launcher:setMod turns a mod off with .disabled; launcher:mods says which mods are the pack\'s');
  served = 'v2';
  const changed = await ok('launcher:play', project, joined.instance.name, { server: 'mc.example.test:25580' }, 'x');
  check(changed.launched === false && changed.needsApproval?.update === true && text(path.join(tdir, 'config', 'a.toml')) === 'v = 1', 'a changed pack waits for the user\'s yes too, with nothing touched and the launcher not started');
  await ok('launcher:play', project, joined.instance.name, { server: 'mc.example.test:25580', approve: changed.needsApproval.sha1 }, 'job-sync');
  const t2 = readJson(path.join(tdir, 'nano-instance.json'));
  check(text(path.join(tdir, 'mods', 'mod-a.jar.disabled')) === 'mod a 2' && !has(path.join(tdir, 'mods', 'mod-a.jar')) && !has(path.join(tdir, 'mods', 'mod-b.jar'))
    && text(path.join(tdir, 'mods', 'mod-c.jar')) === 'mod c 1' && text(path.join(tdir, 'mods', 'user-mod.jar')) === 'mine' && text(path.join(tdir, 'config', 'a.toml')) === 'v = 2'
    && !has(path.join(tdir, 'options.txt')) && S([...t2.pack.files].sort()) === S(['config/a.toml', 'mods/mod-a.jar', 'mods/mod-c.jar']),
  'a changed pack is synced at Play: updated, added and removed files; the user\'s mod and the disabled pack mod stay as the user left them');
  check(t2.mc === '1.20.4' && t2.loaderId === 'fabric-loader-0.15.11-1.20.4' && version(`nano-${joined.instance.name}`).inheritsFrom === 'fabric-loader-0.15.11-1.20.4'
    && has(path.join(launcherDir, 'versions', 'fabric-loader-0.15.11-1.20.4')), `the instance follows the pack to Minecraft 1.20.4, and its loader is installed for it (${t2.mc}, ${t2.loaderId})`);
  check(/Removed mods.mod-b\.jar/.test(await logOf('job-sync')), 'the sync says what it removed');
  const fetches = packFetches();
  await ok('launcher:play', project, joined.instance.name, { server: 'mc.example.test:25580' }, 'job-same');
  check(packFetches() === fetches + 1 && /has not changed/.test(await logOf('job-same')), 'an unchanged pack (same SHA-1) is checked and left alone');
  served = 'v3';
  const v3 = await ok('launcher:play', project, joined.instance.name, { server: 'mc.example.test:25580' }, 'x');
  const broken = await call('launcher:play', project, joined.instance.name, { server: 'mc.example.test:25580', approve: v3.needsApproval?.sha1 }, 'x');
  const t3 = readJson(path.join(tdir, 'nano-instance.json'));
  check(/Checksum mismatch for mods\/mod-d\.jar/.test(broken.err || '') && t3.pack.sha1 === sha('sha1', PACKS.v2) && text(path.join(tdir, 'mods', 'mod-c.jar')) === 'mod c 1'
    && !has(path.join(tdir, 'mods', 'mod-d.jar')) && !readdirSync(tdir).some((n) => n.startsWith('.pack-')), `a pack file with a bad hash fails the sync and changes nothing (${broken.err})`);
  // Eight Plays have started it so far.
  const started = (await startsReach(9)).length;
  check(!broken.ok && started === 8, `the launcher is not started after a failed sync (${started} starts)`);

  // ---------- join by address ----------
  const needs = await ok('launcher:join', project, { address: 'plain.example.test', name: 'Plain' }, 'x');
  check(needs.needsVersion === true && needs.server.address === 'plain.example.test', 'joining an address without a pack asks for the version and loader (needsVersion)');
  const plain = await ok('launcher:join', project, { address: 'plain.example.test', name: 'Plain', mc: '1.20.1', loader: 'fabric' }, 'x');
  check(plain.instance.name === 'Plain' && plain.instance.loader === 'fabric' && plain.instance.server.address === 'plain.example.test' && (await ok('launcher:servers', project)).length === 2,
    'with them it makes the instance and saves the server');
  const list = await ok('launcher:saveServers', project, [...await ok('launcher:servers', project), { name: 'Dup', address: 'PLAIN.example.test', instance: 'Plain' }]);
  check(list.length === 2 && list[1].name === 'Dup' && S(readJson(path.join(project, 'servers-list.json'))) === S(list), 'saveServers keeps one entry per address (the last given)');
  const badList = await call('launcher:saveServers', project, [{ name: 'x', address: 'no spaces allowed' }]);
  check(/not a server address/.test(badList.err || ''), 'saveServers checks each address');

  // ---------- Modrinth modpack, remove ----------
  const mk = await ok('launcher:fromPack', project, { url: 'https://modrinth.com/modpack/market-pack' }, 'x');
  check(mk.title === '모드팩 Market' && mk.name === 'Market' && text(path.join(mk.dir, 'mods', 'm.jar')) === 'market mod' && mk.pack.url === 'https://modrinth.com/modpack/market-pack',
    `fromPack (a Modrinth modpack's address) downloads its newest .mrpack and makes the instance (${mk.name})`);
  const all = await ok('launcher:instances', project);
  check(all.length === 9 && all[0].name === 'Market' && all.find((i) => i.name === 'fab')?.mods === 0 && all.find((i) => i.name === 'Quilt-Pack')?.mods === 1,
    `launcher:instances lists them, the one played or made last first, with their mod counts (${all.map((i) => i.name).join(', ')})`);
  check(await ok('launcher:remove', project, 'Plain') && !profiles().profiles['nano-Plain'] && profiles().profiles.abc123 && !has(path.join(launcherDir, 'versions', 'nano-Plain'))
    && (await ok('launcher:servers', project)).find((s) => s.address.toLowerCase() === 'plain.example.test').instance === null,
  'launcher:remove drops the profile and version (the launcher\'s own profiles stay) and the server forgets the instance');
  const unknown = await call('launcher:play', project, 'nope', {}, 'x');
  check(/no instance nope/.test(unknown.err || ''), 'Play of an instance that does not exist fails cleanly');

  // ---------- plain Node: the launcher's places, the arguments, noLauncher ----------
  const L = require('../main/minecraft/launcher.js');
  const fake = path.join(work, 'fakeroots');
  const exe = (d) => { write(path.join(fake, d, 'Minecraft Launcher', 'MinecraftLauncher.exe'), ''); return path.join(fake, d, 'Minecraft Launcher', 'MinecraftLauncher.exe'); };
  const env = { 'ProgramFiles(x86)': path.join(fake, 'x86'), ProgramFiles: path.join(fake, 'pf'), LOCALAPPDATA: path.join(fake, 'local') };
  const local = exe(path.join('local', 'Programs'));
  const found = [L.findLauncher(env)?.[0]];
  const programFiles = exe('pf');
  found.push(L.findLauncher(env)?.[0]);
  const x86 = exe('x86');
  found.push(L.findLauncher(env)?.[0], L.findLauncher({ ...env, PYIDE_MC_LAUNCHER: S(['a.exe', '1']) })?.join(' '), L.findLauncher({ ...env, PYIDE_MC_LAUNCHER: 'off' }));
  check(S(found) === S([local, programFiles, x86, 'a.exe 1', null]) && L.findLauncher({}) === null,
    'the launcher is found in Program Files (x86), then Program Files, then %LOCALAPPDATA%\\Programs; PYIDE_MC_LAUNCHER replaces all of them');
  check(S(L.serverArgs('26.1', { address: 'a.test' })) === S({ arguments: { game: ['--quickPlayMultiplayer', 'a.test'] } })
    && S(L.serverArgs('1.20', { address: '[::1]:25566' })) === S({ arguments: { game: ['--quickPlayMultiplayer', '[::1]:25566'] } })
    && S(L.serverArgs('1.13', { address: '[::1]:25566' })) === S({ arguments: { game: ['--server', '::1', '--port', '25566'] } }), 'Quick Play for 26.x and 1.20; --server takes an IPv6 host without its brackets');
  process.env.PYIDE_MC_LAUNCHER = 'off';
  const never = () => { throw new Error('nothing is downloaded without a launcher'); };
  const offline = L.createLauncher({ fetchFile: never, ensureJava: never, javaFor: never, run: never, retried: never });
  const none = await offline.play(project, 'fab', { server: 'x.test' }, () => {});
  check(none.launched === false && none.code === 'noLauncher' && /minecraft\.net/.test(none.download) && starts().length === started,
    `without the launcher Play returns {code: 'noLauncher'} with Mojang's download page, before any download (${S(none)})`);
  check(offline.status(project).launcher === null, 'launcher:status says when there is no launcher');

  // ---------- the code-mode Minecraft screen's new pages ----------
  await js(`(ide.minecraft.screen.show('play'), true)`);
  await t.until(`document.querySelectorAll('.mcs-play .mcc-card').length === ${all.length}`, 'Play page cards', 10000);
  const codeScreen = await js(`({ tab: ide.activeTab()?.path, pages: [...document.querySelectorAll('.mcs-page')].map((p) => p.dataset.page), first: document.querySelector('.mcs-play .mcc-card')?.dataset.name,
    plugin: !!document.querySelector('.mcs-new-plugin'), market: document.querySelector('.mcs-market').classList.contains('hidden') })`);
  await js(`(document.querySelector('.mcs-page[data-page="join"]').click(), true)`);
  await t.until(`document.querySelectorAll('.mcs-join .mcc-joined').length === 2`, 'Servers to Join cards', 10000);
  check(codeScreen.tab === 'minecraft:home' && S(codeScreen.pages) === S(['play', 'join', 'servers', 'market']) && codeScreen.first === 'Market' && codeScreen.plugin && codeScreen.market,
    `in code mode the Minecraft editor tab has Play and Servers to Join too, beside My Servers and the Market (${S(codeScreen)})`);
  await shot('launcher-ipc.png');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
t.close();
await craftUi(t);

// The WCAG contrast ratio of an element's text on what is behind it, as an expression for the page.
function contrastOf(sel) {
  return `(() => {
    const parse = (c) => {
      const srgb = /color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?\\)/.exec(c);
      if (srgb) return { r: srgb[1] * 255, g: srgb[2] * 255, b: srgb[3] * 255, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
      const m = c.match(/[\\d.]+/g).map(Number);
      return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
    };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const n = document.querySelector(${S(sel)});
    if (!n) return null;
    const stack = [];
    for (let e = n; e; e = e.parentElement) stack.push(parse(getComputedStyle(e).backgroundColor));
    const bg = stack.reverse().reduce((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
    const fg = over(parse(getComputedStyle(n).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
  })()`;
}

// ---------- Nano Studio Craft's pages in craft mode (--mode=craft) ----------
// The craft window on its own workspace (PYIDE_CRAFT_HOME) with the same stand-ins and a stand-in launcher of its
// own: a new instance played, an address main refuses (its error under the field, the text kept through a refresh), a
// server added by its join code and joined (its pack synced, Quick Play, progress as Korean phases, one launcher
// balloon), a server added by its address, mods turned off, an editor tab over the app, My Servers' head, craft's
// Settings, the Market's Install as Instance, the cards at 900 px; then a window without the launcher or the version
// services (the banner, Play offering Mojang's download page through a stub, a cannot-connect message). Ports 9897-9898.
async function craftUi(first) {
  const home = path.join(work, 'Nano Studio Craft');
  const uiLog = path.join(work, 'launcher', 'craft-starts.jsonl');
  const uiStarts = () => (existsSync(uiLog) ? readFileSync(uiLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const uiStartsReach = async (n) => {
    for (let i = 0; i < 100 && uiStarts().length < n; i++) await new Promise((r) => setTimeout(r, 100));
    return uiStarts();
  };
  const craftPack = (v, mods) => mrpack({ formatVersion: 1, game: 'minecraft', versionId: v, name: '친구 서버', dependencies: deps('1.20.1'),
    files: Object.entries(mods).map(([n, d]) => ({ ...modFile(`craft${v}-${n}`, d), path: `mods/${n}` })) }, { 'overrides/config/craft.toml': `v = ${v}` });
  const CRAFT = { 1: craftPack('1', { 'craft-a.jar': 'craft a 1', 'craft-b.jar': 'craft b 1' }), 2: craftPack('2', { 'craft-a.jar': 'craft a 2', 'craft-c.jar': 'craft c 1' }) };
  let craftServed = 1;
  routes.set('/packs/craft.mrpack', () => CRAFT[craftServed]);
  const craftFetches = () => requests.filter((q) => q.startsWith('/packs/craft.mrpack')).length;
  const hit = { project_id: 'MKT', slug: 'market-pack', project_type: 'modpack', title: '모드팩 Market', author: 'tester', description: 'A modpack', icon_url: null,
    downloads: 1200, follows: 30, display_categories: ['adventure'], date_modified: '2026-10-01' };
  routes.set('/modrinth/search', () => ({ total_hits: 1, hits: [hit] }));
  const env = { PYIDE_CRAFT_HOME: home, PYIDE_MC_JAVA: javaHome, PYIDE_MC_SOURCES: SOURCES };
  let u;
  try {
    u = await launch({ name: 'minecraft-launcher', port: 9897, mode: 'craft', lang: 'ko', projectDir: home, env: { ...env, PYIDE_MC_LAUNCHER: S([process.execPath, fakeLauncher, uiLog]),
      PYIDE_BORE: S([process.execPath, fakeBore]), PYIDE_CLOUDFLARED: S([process.execPath, fakeTunnel]) } });
  } catch (err) {
    first.check(false, `the craft window: ${err.message}`);
    return first.finish();
  }
  u.results.unshift(...first.results);
  const { js, until, check, shot } = u;
  const homeInst = (name) => path.join(home, 'instances', name);
  const dialogButton = (label) => `[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${S(label)})`;
  const setValue = (sel, value) => js(`(() => { const i = document.querySelector(${S(sel)}); i.value = ${S(value)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const balloon = (re) => `[...document.querySelectorAll('.ide-balloon')].some((n) => ${re}.test(n.textContent))`;
  // Open Folder and the download page go to a list instead of Explorer and the browser.
  const stubShell = `(() => { window.__shell = []; window.__clip = []; const real = ide.api.invoke;
    ide.api.invoke = (ch, ...a) => (/^shell:/.test(ch) ? (window.__shell.push([ch, ...a]), Promise.resolve(true)) : ch === 'clipboard:writeText' ? (window.__clip.push(a[0]), Promise.resolve(true)) : real(ch, ...a)); return true; })()`;
  try {
    await js(stubShell);
    await until(`!!document.querySelector('#craftHost .mcs-nav') && document.querySelector('.mcs-page.selected')?.dataset.page === 'play' && !!document.querySelector('.mcs-play .mcc-empty')`, 'craft app', 15000);
    const shell = await js(`({ pages: [...document.querySelectorAll('#craftHost .mcs-page')].map((p) => [p.dataset.page, p.textContent.trim()]), actions: [...document.querySelectorAll('#craftHost .mcs-action')].map((p) => p.textContent.trim()),
      banner: !!document.querySelector('.mcc-banner'), editor: getComputedStyle(document.getElementById('editorArea')).display })`);
    check(S(shell.pages) === S([['play', '플레이'], ['join', '서버 참여'], ['servers', '내 서버'], ['market', '마켓']]) && !shell.actions.some((a) => /플러그인|모드…/.test(a)) && shell.actions.includes('새 인스턴스…')
      && !shell.banner && shell.editor === 'none', `craft mounts the Minecraft screen as the app, in Korean, on Play, without plugin or mod making and with no launcher banner (${S(shell)})`);

    // ---------- New Instance, Play ----------
    await js(`(document.querySelector('.mcc-new').click(), true)`);
    await until(`[...document.querySelectorAll('#mccVersion option')].some((o) => o.value === '1.20.1') && !!document.querySelector('#mccLoaderVersion')?.value`, 'versions in New Instance', 10000);
    check(S(await js(`[...document.querySelectorAll('#mccLoader option')].map((o) => o.value)`)) === S(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']),
      'New Instance offers Vanilla, Fabric, Quilt, Forge and NeoForge');
    await setValue('#mccVersion', '1.20.1');
    await until(`document.querySelector('#mccLoaderVersion')?.value === '0.15.11' && /권장/.test(document.querySelector('#mccLoaderVersion').selectedOptions[0].textContent)`, 'loader version for 1.20.1', 10000);
    await setValue('#mccName', '테스트 월드');
    await js(`(${dialogButton('생성')}).click()`);
    await until(`document.querySelector('.mcs-play .mcc-card .mcc-name')?.textContent === '테스트 월드'`, 'instance card', 20000);
    const made = readJson(path.join(homeInst('instance'), 'nano-instance.json'));
    const cardText = await js(`document.querySelector('.mcs-play .mcc-card').textContent`);
    check(made.title === '테스트 월드' && made.loader === 'fabric' && made.loaderVersion === '0.15.11' && /Minecraft 1\.20\.1/.test(cardText) && /Fabric 0\.15\.11/.test(cardText) && /모드 0개/.test(cardText) && /아직 플레이 안 함/.test(cardText),
      `New Instance (the recommended loader version chosen) makes the instance in the craft workspace and shows its card (${S(made)}; ${cardText})`);
    await js(`(document.querySelector('.mcc-card[data-name="instance"] .mcc-play').click(), true)`);
    const s1 = await uiStartsReach(1);
    const at = s1[0]?.args.indexOf('--workDir');
    check(s1.length === 1 && path.resolve(s1[0].args[at + 1]) === path.join(home, '.launcher') && path.resolve(readJson(`${uiLog}.1.json`).profiles['nano-instance']?.gameDir || '') === homeInst('instance'),
      `Play starts the stand-in launcher with --workDir <workspace>\\.launcher and the instance's profile (${S(s1[0]?.args)})`);
    await until(balloon(/Minecraft Launcher를 열었어요.*런처에서 로그인하고 플레이를 누르세요/), 'launcher balloon', 10000);
    await until(`!/아직 플레이 안 함/.test(document.querySelector('.mcc-card[data-name="instance"]').textContent) && !document.querySelector('.mcc-play').disabled`, 'card after Play', 10000);
    const runLog = await js(`ide.run.sessions().find((s) => s.title === 'Minecraft: 테스트 월드 플레이')?.host.textContent || ''`);
    check(/Starting the Minecraft Launcher/.test(runLog) && /런처에서 로그인하고 플레이를 누르세요/.test(runLog), `Play shows its job log in a Run tab, ending with the Korean sign-in hint (${runLog.slice(-160)})`);
    await shot('craft-play.png');

    // ---------- Servers to Join: a join code, Join ----------
    const code = await js(`ide.api.invoke('launcher:joinCode', { address: 'craft.example.test:25590', pack: ${S(`${base}/packs/craft.mrpack`)}, name: '친구 서버' })`);
    await js(`(document.querySelector('.mcs-page[data-page="join"]').click(), true)`);
    await until(`!!document.querySelector('.mcs-join #mccAddServer') && !!document.querySelector('.mcs-join .mcc-empty')`, 'join page', 10000);
    await js(`(document.querySelector('#mccAddServer').value = 'nanostudio:join?addr=bad_host:1', document.querySelector('.mcc-add').requestSubmit(), true)`);
    await until(`/서버 주소가 아니에요/.test(document.querySelector('.mcc-add-error').textContent)`, 'bad code refused', 10000);
    check(true, 'a join code with a bad address is refused under the field, in Korean');
    await js(`(document.querySelector('#mccAddServer').value = 'bad host:1', document.querySelector('.mcc-add').requestSubmit(), true)`);
    await until(`/서버 주소가 아니에요/.test(document.querySelector('.mcc-add-error').textContent) && !document.querySelector('.mcc-add-btn').disabled`, 'address main refuses', 10000);
    const refused = await js(`({ value: document.querySelector('#mccAddServer').value, error: document.querySelector('.mcc-add-error').textContent, button: document.querySelector('.mcc-add-btn').textContent.trim() })`);
    check(refused.value === 'bad host:1' && refused.button === '서버 추가', `an address main refuses (Add Server's busy state drawn in between) shows the Korean error under the field and keeps the typed text (${S(refused)})`);
    await shot('craft-join-error.png');
    await js(`(window.__field = document.querySelector('#mccAddServer'), window.__field.value = 'typed.example.test', true)`);
    await js(`ide.minecraft.craft.refresh().then(() => true)`);
    const kept = await js(`({ same: document.querySelector('#mccAddServer') === window.__field, value: window.__field.value, error: document.querySelector('.mcc-add-error').textContent })`);
    check(kept.same && kept.value === 'typed.example.test' && /서버 주소가 아니에요/.test(kept.error), `a refresh (as after Play or Join) keeps the field, what is typed in it and the error (${S(kept)})`);
    await js(`(document.querySelector('#mccAddServer').value = ${S(`친구가 보낸 코드: ${code}`)}, document.querySelector('.mcc-add').requestSubmit(), true)`);
    const install = dialogButton('설치');
    await until(`!!${install}`, 'join code question', 10000);
    const asked = await js(`document.querySelector('.dialog').textContent`);
    const packDefault = await js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.classList.contains('primary'))?.textContent`);
    await shot('craft-pack-review.png');
    await js(`(${dialogButton('취소')}).click()`);
    await until(`!document.querySelector('.dialog') && !document.querySelector('.mcc-add-btn').disabled`, 'join code declined', 10000);
    check(asked.includes(new URL(base).host) && /craft-a\.jar/.test(asked) && /내 계정 권한/.test(asked) && packDefault === '취소' && !has(path.join(home, 'servers-list.json')) && await js(`document.querySelector('#mccAddServer').value.includes('nanostudio:join')`),
      `a join code's pack shows its host and its mods, says they run with the user's rights, defaults to Cancel, and declining adds nothing (${asked.slice(0, 120)})`);
    await js(`(document.querySelector('.mcc-add').requestSubmit(), true)`);
    await until(`!!${install}`, 'join code question again', 10000);
    await js(`(${install}).click()`);
    await until(`!!document.querySelector('.mcc-joined[data-address="craft.example.test:25590"]')`, 'joined server card', 20000);
    const listed = readJson(path.join(home, 'servers-list.json'));
    const joinedInst = listed[0]?.instance;
    check(listed.length === 1 && listed[0].pack === `${base}/packs/craft.mrpack` && joinedInst && text(path.join(homeInst(joinedInst), 'mods', 'craft-a.jar')) === 'craft a 1'
      && /모드 자동 동기화/.test(await js(`document.querySelector('.mcc-joined').textContent`)) && await js(`document.querySelector('#mccAddServer').value === ''`),
    `Add Server with a pasted join code saves the server and makes its instance from the pack (${S(listed)})`);
    const fetched = craftFetches();
    await js(`(document.querySelector('.mcc-joined .mcc-join').click(), true)`);
    const s2 = await uiStartsReach(2);
    const vjson = () => readJson(path.join(home, '.launcher', 'versions', `nano-${joinedInst}`, `nano-${joinedInst}.json`));
    check(s2.length === 2 && S(vjson().arguments?.game) === S(['--quickPlayMultiplayer', 'craft.example.test:25590']) && craftFetches() === fetched,
      `Join plays the server's instance with Quick Play to the server, reusing the pack Add Server downloaded (${S(vjson().arguments)})`);
    craftServed = 2;
    await until(`!document.querySelector('.mcc-joined .mcc-join').disabled`, 'join button back', 10000);
    // The progress balloon's text follows the job's log.
    await js(`(window.__progress = [], new MutationObserver(() => { for (const n of document.querySelectorAll('.ide-balloon')) if (/참여하도록/.test(n.textContent)) window.__progress.push(n.querySelector('.ide-balloon-text').textContent); })
      .observe(document.getElementById('balloons'), { subtree: true, childList: true, characterData: true }), true)`);
    await js(`(document.querySelector('.mcc-joined .mcc-join').click(), true)`);
    await until(`!!${install}`, 'changed pack question', 10000);
    const changedAsked = await js(`document.querySelector('.dialog').textContent`);
    check(uiStarts().length === 2 && /craft-c\.jar/.test(changedAsked) && /새 모드/.test(changedAsked) && text(path.join(homeInst(joinedInst), 'mods', 'craft-a.jar')) === 'craft a 1',
      `when the pack changes Join asks again, marks what is new, and has changed nothing yet (${changedAsked.slice(0, 120)})`);
    await js(`(${install}).click()`);
    await uiStartsReach(3);
    await until(`ide.notifications.list().some((e) => /참여하도록/.test(e.title) && e.expired)`, 'progress balloon gone', 10000);
    const progressed = [...new Set(await js('window.__progress'))];
    check(progressed.some((x) => /^모드 받는 중 \(2\/2\)…$/.test(x)) && progressed.includes('팩 확인 중…') && !progressed.some((x) => /https?:|sha256|mods\/|\.jar|Downloading|Starting/.test(x)),
      `Join shows its progress in a balloon as Korean phases of the log (not its raw lines), gone when the launcher starts (${S(progressed.slice(0, 8))})`);
    await until(balloon(/Minecraft Launcher를 열었어요/), 'launcher balloon after the second Join', 10000);
    const opened = await js(`({ shown: [...document.querySelectorAll('.ide-balloon')].filter((n) => /Minecraft Launcher를 열었어요/.test(n.textContent)).length,
      kept: ide.notifications.list().filter((e) => /Minecraft Launcher를 열었어요/.test(e.title)).length })`);
    check(opened.shown === 1 && opened.kept === 3, `each Play replaces the last "launcher is open" balloon instead of stacking another; all stay in the Notifications list (${S(opened)})`);
    const mods = readdirSync(path.join(homeInst(joinedInst), 'mods')).sort();
    check(uiStarts().length === 3 && S(mods) === S(['craft-a.jar', 'craft-c.jar']) && text(path.join(homeInst(joinedInst), 'mods', 'craft-a.jar')) === 'craft a 2'
      && text(path.join(homeInst(joinedInst), 'config', 'craft.toml')) === 'v = 2', `Join after the server's pack changed syncs it before the launcher starts (${S(mods)})`);
    await until(`!document.querySelector('.mcc-joined .mcc-join').disabled`, 'join button back', 10000);
    await shot('craft-servers.png');

    await js(`(document.querySelector('.mcc-joined .mcc-copy-code').click(), true)`);
    await until('window.__clip.length === 1', 'join code copied', 10000);
    const copied = await js(`ide.api.invoke('launcher:parseJoinCode', window.__clip[0])`);
    check(copied.address === 'craft.example.test:25590' && copied.pack === `${base}/packs/craft.mrpack` && copied.name === '친구 서버', `Copy Join Code on a server to join copies its code (${S(copied)})`);

    // ---------- an address alone asks for the version ----------
    await js(`(document.querySelector('#mccAddServer').value = 'plain.example.test', document.querySelector('.mcc-add').requestSubmit(), true)`);
    await until(`[...document.querySelectorAll('#mccJoinVersion option')].some((o) => o.value === '1.20.1') && !!document.querySelector('#mccJoinLoaderVersion')?.value`, 'server version dialog', 15000);
    await setValue('#mccJoinVersion', '1.20.1');
    await until(`document.querySelector('#mccJoinLoaderVersion')?.value === '0.15.11'`, 'loader for the server', 10000);
    await js(`(${dialogButton('추가')}).click()`);
    await until(`!!document.querySelector('.mcc-joined[data-address="plain.example.test"]')`, 'plain server card', 20000);
    const plain = readJson(path.join(home, 'servers-list.json')).find((x) => x.address === 'plain.example.test');
    check(plain && !plain.pack && readJson(path.join(homeInst(plain.instance), 'nano-instance.json')).loader === 'fabric', `an address without a pack asks for the version and loader, then adds the server (${S(plain)})`);

    // ---------- mods ----------
    await js(`(document.querySelector('.mcs-page[data-page="play"]').click(), true)`);
    const modsBtn = `.mcc-card[data-name="${joinedInst}"] .mcc-mods-btn`;
    await until(`!!document.querySelector(${S(modsBtn)})`, 'server instance card', 10000);
    await js(`(document.querySelector(${S(modsBtn)}).click(), true)`);
    await until(`document.querySelectorAll('.mcc-mod').length === 2`, 'mods dialog', 10000);
    const rows = await js(`[...document.querySelectorAll('.mcc-mod')].map((r) => [r.dataset.file, r.querySelector('input').checked, !!r.querySelector('.mcc-chip'), !!r.querySelector('.mcc-mod-remove')])`);
    await js(`(() => { const box = document.querySelector('.mcc-mod[data-file="craft-c.jar"] input'); box.checked = false; box.dispatchEvent(new Event('change')); return true; })()`);
    await until(`document.querySelector('.mcc-mod[data-file="craft-c.jar"]')?.classList.contains('off')`, 'mod off', 10000);
    check(S(rows) === S([['craft-a.jar', true, true, false], ['craft-c.jar', true, true, false]]) && has(path.join(homeInst(joinedInst), 'mods', 'craft-c.jar.disabled')),
      `Mods lists the instance's mods (the pack's marked, not removable) and a switch turns one off with .disabled (${S(rows)})`);
    await js(`(${dialogButton('닫기')}).click()`);
    await js(`(document.querySelector('.mcc-card[data-name="instance"] .mcc-folder').click(), true)`);
    check(S(await js('window.__shell')) === S([['shell:openPath', homeInst('instance')]]), 'Open Folder opens the instance folder (stubbed)');

    // ---------- an editor tab over the app; My Servers; the Market ----------
    writeFileSync(path.join(home, 'notes.txt'), 'notes');
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'notes.txt'))`);
    await until(`document.body.classList.contains('mc-craft-tab') && getComputedStyle(document.getElementById('editorArea')).display !== 'none' && getComputedStyle(document.getElementById('craftHost')).display === 'none'`, 'tab over the app', 10000);
    await js(`(ide.closeTab(ide.activeTab().path, true), true)`);
    await until(`!document.body.classList.contains('mc-craft-tab') && getComputedStyle(document.getElementById('craftHost')).display !== 'none'`, 'app back', 10000);
    check(true, 'an editor tab opened in craft covers the app, and closing it brings the app back');
    await js(`(document.querySelector('.mcs-page[data-page="servers"]').click(), true)`);
    await until(`!!document.querySelector('#minecraftScreen .mcc-empty') && !!document.querySelector('#minecraftScreen').offsetParent`, 'my servers', 10000);
    const mine = await js(`({ title: document.querySelector('.mcs-servers-page .mcc-title')?.textContent, tools: [...document.querySelectorAll('.mcs-servers-page .mcc-tools button')].map((b) => b.textContent.trim()),
      empty: [...document.querySelectorAll('#minecraftScreen .mcc-empty > *')].map((n) => n.textContent), bar: !!document.querySelector('#minecraftScreen .mc-bar')?.offsetParent })`);
    check(mine.title === '내 서버' && S(mine.tools) === S(['새 서버…', '모드팩으로 서버 만들기…']) && mine.empty[0] === '아직 서버가 없어요' && /요\.$/.test(mine.empty[1]) && !mine.bar,
      `My Servers in craft has the head of Play and Servers to Join, with New Server and Server from Modpack, and an empty card in -요 speech (${S(mine)})`);
    await shot('craft-my-servers.png');
    await js(`(document.querySelector('.mcc-new-server').click(), true)`);
    await until(`!!${dialogButton('취소')} && !!document.querySelector('.dialog')`, 'New Server from My Servers', 10000);
    const newServerLabels = await js(`[...document.querySelectorAll('.dialog .mc-dialog-label')].map((n) => n.textContent)`);
    await js(`(${dialogButton('취소')}).click()`);
    check(newServerLabels.includes('유형:') && newServerLabels.includes('포트:'), `the page's New Server opens its dialog, its labels in Korean (${S(newServerLabels)})`);
    const navEnd = await js(`[...document.querySelectorAll('#craftHost .mcs-nav > .mcs-action')].slice(-2).map((n) => n.textContent.trim())`);
    await js(`(document.querySelector('#craftHost .mcs-settings').click(), true)`);
    await until(`!!document.querySelector('.settings-pages .settings-nav-row[data-page]')`, 'settings from the craft list', 10000);
    const settingsPages = await js(`[...document.querySelectorAll('.settings-pages .settings-nav-row[data-page]')].map((r) => r.dataset.page)`);
    check(S(navEnd) === S(['설정…', 'Nano Studio 정보']) && S(settingsPages) === S(['appearance', 'language', 'plugins', 'updates']),
      `craft's list ends with Settings and About; its Settings shows only Appearance, Language, Plugins and Updates (${S({ navEnd, settingsPages })})`);
    await shot('craft-settings.png');
    await js(`(${dialogButton('취소')}).click()`);
    await until(`!document.querySelector('.settings-pages')`, 'settings closed', 10000);
    await js(`(document.querySelector('.mcs-page[data-page="market"]').click(), true)`);
    await until(`!!document.querySelector('.mcm-card[data-slug="market-pack"] .mcm-instance')`, 'market modpack card', 15000);
    check(await js(`document.querySelector('.mcm-card[data-slug="market-pack"] .mcm-instance').textContent === '인스턴스로 설치' && !!document.querySelector('.mcm-card[data-slug="market-pack"] .mcm-create')`),
      'in craft a modpack in the Market offers Install as Instance, beside Create Server');
    await js(`(document.querySelector('.mcm-card[data-slug="market-pack"] .mcm-instance').click(), true)`);
    await until(`ide.minecraft.screen.page() === 'play' && [...document.querySelectorAll('.mcs-play .mcc-name')].some((n) => n.textContent === '모드팩 Market')`, 'modpack instance', 20000);
    check(text(path.join(homeInst('Market'), 'mods', 'm.jar')) === 'market mod', 'Install as Instance makes an instance from the Modrinth modpack and shows it on Play');
    await js(`(document.querySelectorAll('.ide-balloon').forEach((b) => b.remove()), true)`);
    await u.cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    // Hangul falls back to whatever font the machine has: on the CI runner a card's labels are about 8 px wider than in
    // Malgun Gothic, and that cut them short.
    await js(`(document.head.appendChild(Object.assign(document.createElement('style'), { id: 'wider-font', textContent: '.mcc-actions button { letter-spacing: 0.8px; }' })), true)`);
    const oneRow = (page) => js(`[...document.querySelectorAll('${page} .mcc-actions')].map((a) => {
      const r = [...a.children].map((b) => b.getBoundingClientRect());
      return { row: r.every((x) => x.top < r[0].bottom && x.bottom > r[0].top), fits: a.scrollWidth <= a.clientWidth,
        whole: [...a.querySelectorAll(':scope > button > span:last-child')].every((s) => s.scrollWidth <= s.clientWidth),
        cols: getComputedStyle(a.closest('.mcc-grid')).gridTemplateColumns.split(' ').length };
    })`);
    await until(`document.querySelectorAll('.mcs-play .mcc-card').length === 4 && innerWidth === 900`, 'Play at 900 px', 10000);
    const playRows = await oneRow('.mcs-play');
    await shot('craft-play-900.png');
    await js(`(document.querySelector('.mcs-page[data-page="join"]').click(), true)`);
    await until(`document.querySelectorAll('.mcs-join .mcc-joined').length === 2`, 'Servers to Join at 900 px', 10000);
    const joinRows = await oneRow('.mcs-join');
    await js(`(document.getElementById('wider-font').remove(), true)`);
    await u.cdp('Emulation.clearDeviceMetricsOverride');
    check([...playRows, ...joinRows].every((r) => r.row && r.fits && r.whole && r.cols === 2),
      `at 900 px the cards are two columns, and each card's actions are one row inside it with no label cut short (${S({ playRows, joinRows })})`);

    // ---------- Forge and NeoForge through New Instance ----------
    const showPage = (id) => js(`(document.querySelector('.mcs-page[data-page="${id}"]').click(), true)`);
    const throughDialog = async (loader, mc, version, name) => {
      await showPage('play');
      await js(`(document.querySelector('.mcc-new').click(), true)`);
      await until(`document.querySelectorAll('#mccVersion option').length > 0 && !document.querySelector('#mccVersion').disabled`, `${loader}: dialog`, 10000);
      await setValue('#mccLoader', loader);
      await until(`[...document.querySelectorAll('#mccVersion option')].some((o) => o.value === ${S(mc)}) && !document.querySelector('#mccVersion').disabled`, `${loader}: versions`, 10000);
      await setValue('#mccVersion', mc);
      await until(`document.querySelector('#mccLoaderVersion')?.value === ${S(version)} && /권장/.test(document.querySelector('#mccLoaderVersion').selectedOptions[0].textContent)`, `${loader}: loader version`, 10000);
      await setValue('#mccName', name);
      await js(`(${dialogButton('생성')}).click()`);
      await until(`!!document.querySelector('.mcc-card[data-name="${name}"]')`, `${loader}: card`, 30000);
      return readJson(path.join(homeInst(name), 'nano-instance.json'));
    };
    const forgeInst = await throughDialog('forge', '1.20.1', '47.9.9', 'forge-world');
    check(forgeInst.loaderId === FORGE_ID && has(path.join(home, '.launcher', 'versions', FORGE_ID, `${FORGE_ID}.json`)), `Forge through New Instance runs its installer into the launcher's folder (${S(forgeInst)})`);
    const neoInst = await throughDialog('neoforge', '1.20.4', '20.4.237', 'neo-world');
    check(neoInst.loaderId === NEO_ID && has(path.join(home, '.launcher', 'versions', NEO_ID, `${NEO_ID}.json`)), `NeoForge through New Instance too, its stable version recommended over its beta (${S(neoInst)})`);
    await js(`(document.querySelector('.mcc-card[data-name="neo-world"] .mcc-play').click(), true)`);
    const neoStarts = await uiStartsReach(4);
    const neoVersion = readJson(path.join(home, '.launcher', 'versions', 'nano-neo-world', 'nano-neo-world.json'));
    check(neoStarts.length === 4 && neoVersion.inheritsFrom === NEO_ID, `Play of a NeoForge instance starts the launcher on a version inheriting from it (${S(neoVersion.inheritsFrom)})`);
    await until(`!document.querySelector('.mcc-card[data-name="neo-world"] .mcc-play').disabled`, 'NeoForge Play done', 10000);

    // ---------- the server list ping fills in the version ----------
    const pinged = net.createServer((c) => {
      c.on('error', () => {});
      c.once('data', () => {
        const text = Buffer.from(S({ version: { name: '1.20.1', protocol: 763 }, forgeData: { fmlNetworkVersion: 3, mods: [], channels: [] }, players: { online: 2, max: 8 } }));
        const body = Buffer.concat([Buffer.from([0]), Buffer.from([(text.length & 0x7f) | 0x80, text.length >> 7]), text]);
        c.end(Buffer.concat([Buffer.from([(body.length & 0x7f) | 0x80, body.length >> 7]), body]));
      });
    });
    await new Promise((resolve) => { pinged.listen(0, '127.0.0.1', resolve); });
    await showPage('join');
    await js(`(document.querySelector('#mccAddServer').value = '127.0.0.1:${pinged.address().port}', document.querySelector('.mcc-add').requestSubmit(), true)`);
    await until(`document.querySelector('#mccJoinLoader')?.value === 'forge' && document.querySelector('#mccJoinVersion')?.value === '1.20.1' && document.querySelector('#mccJoinLoaderVersion')?.value === '47.9.9'`, 'ping preselects Forge 1.20.1', 15000);
    const pingNote = await js(`document.querySelector('.mcc-ping').textContent`);
    check(/Minecraft 1\.20\.1, Forge/.test(pingNote), `a server added by its address alone preselects what its ping says (${pingNote})`);
    await js(`(${dialogButton('취소')}).click()`);
    await until(`!document.querySelector('.dialog') && !document.querySelector('.mcc-add-btn').disabled`, 'server version dialog closed', 10000);
    pinged.close();

    // ---------- a job cancelled ----------
    routes.set('/packs/hang.mrpack', HANG);
    const hangCode = await js(`ide.api.invoke('launcher:joinCode', { address: 'hang.example.test:25591', pack: ${S(`${base}/packs/hang.mrpack`)}, name: '멈춘 서버' })`);
    await js(`(document.querySelector('#mccAddServer').value = ${S(hangCode)}, document.querySelector('.mcc-add').requestSubmit(), true)`);
    const hangBalloon = `[...document.querySelectorAll('.ide-balloon')].find((n) => /멈춘 서버/.test(n.textContent))`;
    await until(`!!${hangBalloon}?.querySelector('.ide-balloon-action')`, 'progress balloon with Cancel', 10000);
    await js(`(${hangBalloon}.querySelector('.ide-balloon-action').click(), true)`);
    await until(`!document.querySelector('.mcc-add-btn').disabled && !${hangBalloon}`, 'cancelled job gone', 15000);
    const afterCancel = await js(`({ error: document.querySelector('.mcc-add-error').textContent, errors: ide.notifications.list().filter((n) => n.kind === 'error').length, value: document.querySelector('#mccAddServer').value.length > 0 })`);
    check(afterCancel.errors === 0 && afterCancel.error === '' && afterCancel.value && !readJson(path.join(home, 'servers-list.json')).some((x) => /hang/.test(x.address)) && !readdirSync(path.join(home, 'instances')).some((n) => /멈춘|hang/.test(n)),
      `Cancel in the balloon stops a download that hangs: no error, no server, no half-made instance (${S(afterCancel)})`);
    await js(`(document.querySelector('#mccAddServer').value = '', true)`);

    // ---------- the pack's tunnel is down ----------
    routes.delete('/packs/craft.mrpack');
    const startsBefore = uiStarts().length;
    await js(`(document.querySelector('.mcc-joined[data-address="craft.example.test:25590"] .mcc-join').click(), true)`);
    await uiStartsReach(startsBefore + 1);
    await until(balloon(/서버 팩을 확인하지 못했어요/), 'stale pack warning', 10000);
    check(uiStarts().length === startsBefore + 1, 'a server whose pack cannot be fetched still plays with the last synced mods, with a warning');
    routes.set('/packs/craft.mrpack', () => CRAFT[craftServed]);
    await until(`!document.querySelector('.mcc-joined[data-address="craft.example.test:25590"] .mcc-join').disabled`, 'join button after stale', 10000);

    // ---------- a launcher already open ----------
    await js(`(window.__realInvoke = ide.api.invoke, ide.api.invoke = (ch, ...a) => window.__realInvoke(ch, ...a).then((r) => (ch === 'launcher:play' ? { ...r, alreadyOpen: true } : r)), true)`);
    const startsOpen = uiStarts().length;
    await js(`(document.querySelector('.mcc-joined[data-address="craft.example.test:25590"] .mcc-join').click(), true)`);
    await uiStartsReach(startsOpen + 1);
    await until(balloon(/런처가 이미 열려 있어요/), 'launcher already open hint', 10000);
    await js(`(ide.api.invoke = window.__realInvoke, true)`);
    check(true, 'a launcher that was already open gets its own hint');
    await until(`!document.querySelector('.mcc-joined[data-address="craft.example.test:25590"] .mcc-join').disabled`, 'join button back again', 10000);

    // ---------- Join pressed twice before the instance exists ----------
    const twiceAddress = 'twice.example.test:25592';
    await js(`ide.api.invoke('launcher:saveServers', ide.root, [...ide.minecraft.craft.state().servers, { name: 'twice', address: ${S(twiceAddress)}, pack: ${S(`${base}/packs/craft.mrpack`)} }]).then(() => ide.minecraft.craft.refresh()).then(() => true)`);
    const instancesBefore = readdirSync(path.join(home, 'instances')).length;
    const startsTwice = uiStarts().length;
    await js(`(() => { const b = document.querySelector('.mcc-joined[data-address="${twiceAddress}"] .mcc-join'); b.click(); b.click(); return true; })()`);
    await until(`!!${install}`, 'twice: pack question', 10000);
    await js(`(${install}).click()`);
    await uiStartsReach(startsTwice + 1);
    await until(`!document.querySelector('.mcc-joined[data-address="${twiceAddress}"] .mcc-join').disabled`, 'double Join done', 15000);
    check(readdirSync(path.join(home, 'instances')).length === instancesBefore + 1 && uiStarts().length === startsTwice + 1, 'Join pressed twice makes one instance and starts the launcher once');

    // ---------- a damaged instance ----------
    write(path.join(homeInst('hurt'), 'nano-instance.json'), '{ "mc": ');
    write(path.join(homeInst('hurt'), 'saves', 'world', 'level.dat'), 'a world');
    await showPage('play');
    await js(`ide.minecraft.craft.refresh().then(() => true)`);
    await until(`!!document.querySelector('.mcc-damaged[data-name="hurt"]')`, 'damaged card', 10000);
    const hurt = await js(`({ text: document.querySelector('.mcc-damaged').textContent, play: !!document.querySelector('.mcc-damaged .mcc-play'), folder: !!document.querySelector('.mcc-damaged .mcc-folder') })`);
    check(/손상됨/.test(hurt.text) && !hurt.play && hurt.folder, `a damaged instance has its own card, with Open Folder and Delete and no Play (${hurt.text})`);
    await shot('craft-damaged.png');
    await js(`(ide.api.trash = (p) => ide.api.rename(p, ${S(path.join(work, 'trashed-hurt'))}), document.querySelector('.mcc-damaged .mcc-delete').click(), true)`);
    await until(`!!${dialogButton('삭제')}`, 'delete question', 10000);
    await js(`(${dialogButton('삭제')}).click()`);
    await until(`!document.querySelector('.mcc-damaged')`, 'damaged card gone', 10000);
    check(has(path.join(work, 'trashed-hurt', 'saves', 'world', 'level.dat')) && !has(homeInst('hurt')), 'Delete moves it aside with its worlds');

    // ---------- My Servers: Copy Join Code on a shared server, without Python ----------
    const friends = path.join(home, 'servers', 'friends');
    write(path.join(friends, 'pyide-server.json'), S({ kind: 'fabric', mc: '1.20.1', loader: '0.15.11', java: 21, memory: '256M', launch: { jar: 'server.jar' } }));
    write(path.join(friends, 'server.jar'), readFileSync(gameServerJar));
    write(path.join(friends, 'server.properties'), 'server-port=25611\n');
    write(path.join(friends, 'mods', 'friend-mod.jar'), 'a mod');
    await js(`(ide.settings.set('ports.confirmShare', false), ide.settings.set('ports.confirmShareTcp', false), ide.currentInterp = () => null, true)`);
    await showPage('servers');
    await js(`ide.minecraft.refresh().then(() => true)`);
    await until(`!!document.querySelector('#minecraftScreen .mc-server[data-name="friends"] .mc-start')`, 'server card', 10000);
    await js(`(document.querySelector('#minecraftScreen .mc-start').click(), true)`);
    await until(`!!document.querySelector('#minecraftScreen .mc-server .mc-share')`, 'server running', 20000);
    await js(`(document.querySelector('#minecraftScreen .mc-share').click(), true)`);
    await until(`!!${dialogButton('켜고 공유')}`, 'whitelist offer', 10000);
    const offered = await js(`document.querySelector('.dialog').textContent`);
    await js(`(${dialogButton('켜고 공유')}).click()`);
    await until(`document.querySelector('#minecraftScreen .mc-public-addr')?.textContent === 'bore.pub:40611' && !!document.querySelector('#minecraftScreen .mc-join-code')`, 'shared server', 30000);
    const props = text(path.join(friends, 'server.properties'));
    const typed = await js(`ide.run.sessions().find((s) => s.cfg?.type === 'minecraft-server')?.host.textContent || ''`);
    check(/화이트리스트/.test(offered) && /^white-list=true$/m.test(props) && /^enforce-whitelist=true$/m.test(props) && /> whitelist on/.test(typed) && await js(`[...document.querySelectorAll('.ide-balloon')].some((n) => /화이트리스트를 켰어요/.test(n.textContent))`),
      `sharing a game server offers the whitelist, and Turn On writes it, tells the running server and says to add players (${props.replace(/\n/g, ' ')})`);
    const clipsBefore = (await js('window.__clip')).length;
    await js(`(document.querySelector('#minecraftScreen .mc-join-code').click(), true)`);
    await until(`window.__clip.length === ${clipsBefore + 1}`, 'server join code copied', 30000);
    const friendCode = await js(`ide.api.invoke('launcher:parseJoinCode', window.__clip.at(-1))`);
    const packPort = /fake-port-(\d+)\./.exec(friendCode.pack)?.[1];
    const servedPack = await fetch(`http://127.0.0.1:${packPort}/friends-1.20.1.mrpack`);
    const servedBytes = Buffer.from(await servedPack.arrayBuffer());
    check(friendCode.address === 'bore.pub:40611' && friendCode.name === 'friends' && /^https:\/\/fake-port-\d+\.trycloudflare\.com\/friends-1\.20\.1\.mrpack$/.test(friendCode.pack)
      && servedPack.status === 200 && servedBytes.includes('modrinth.index.json'),
    `Copy Join Code on a shared modded server gives its public address and its pack's link, served by the app with no Python interpreter (${S(friendCode)})`);
    const addedKept = await js(`ide.settings.get('ports.added', [])`);
    check(!addedKept.includes(Number(packPort)), `the pack server's port is not saved among the user's added ports (${S(addedKept)})`);
    await js(`(document.querySelector('#minecraftScreen .mc-public-stop').click(), true)`);
    await until(`!!document.querySelector('#minecraftScreen .mc-share')`, 'sharing stopped', 15000);
    await js(`(document.querySelector('#minecraftScreen .mc-share').click(), true)`);
    await until(`document.querySelector('#minecraftScreen .mc-public-addr')?.textContent === 'bore.pub:40611'`, 'shared again', 30000);
    check(!(await js(`document.querySelector('.dialog')?.textContent || ''`)), 'with the whitelist on, sharing again asks nothing');
    await js(`(document.querySelector('#minecraftScreen .mc-stop').click(), true)`);
    await until(`!!document.querySelector('#minecraftScreen .mc-server .mc-start')`, 'server stopped', 40000);

    // ---------- light theme, narrow windows ----------
    await js(`(document.querySelectorAll('.ide-balloon').forEach((b) => b.remove()), ide.settings.set('appearance.theme', 'light'), true)`);
    await until(`ide.theme.current() === 'light'`, 'light theme', 10000);
    const contrast = (sel) => js(contrastOf(sel));
    await showPage('play');
    await until(`!!document.querySelector('.mcs-play .mcc-card .mcc-name')`, 'Play in light', 10000);
    const lightPlay = {};
    for (const sel of ['.mcs-play .mcc-title', '.mcs-play .mcc-sub', '.mcs-play .mcc-name', '.mcs-play .mcc-chip', '.mcs-play .mcc-facts', '.mcs-nav .mcs-page:not(.selected)', '.mcs-nav .mcs-title']) lightPlay[sel] = await contrast(sel);
    await shot('craft-light-play.png');
    await showPage('join');
    await until(`!!document.querySelector('.mcs-join .mcc-chip.sync')`, 'Servers to Join in light', 10000);
    const lightJoin = {};
    for (const sel of ['.mcs-join .mcc-address', '.mcs-join .mcc-chip.sync', '.mcs-join .mcc-facts']) lightJoin[sel] = await contrast(sel);
    await shot('craft-light-join.png');
    check(Object.values({ ...lightPlay, ...lightJoin }).every((r) => r >= 4.5), `in the light theme Craft's text reads at WCAG AA, 4.5:1 or more (${S({ ...lightPlay, ...lightJoin })})`);
    await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
    await until(`ide.theme.current() === 'dark'`, 'dark theme', 10000);
    const narrow = {};
    for (const width of [760, 560, 420]) {
      await u.cdp('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
      await until(`innerWidth === ${width}`, `width ${width}`, 10000);
      for (const id of ['play', 'join', 'servers', 'market']) {
        await js(`(document.querySelector('.mcs-page[data-page="${id}"]').click(), true)`);
        narrow[`${id}@${width}`] = await js(`(() => {
          const page = [...document.querySelectorAll('#craftHost .mcs-body > *')].find((n) => n.offsetParent);
          const nav = document.querySelector('#craftHost .mcs-nav').getBoundingClientRect();
          const box = page.getBoundingClientRect();
          const clipped = [...page.querySelectorAll('button, input, .mcc-title')].filter((n) => n.offsetParent && n.getBoundingClientRect().right > innerWidth + 1).length;
          return { room: Math.round(box.width), side: Math.round(page.scrollWidth - page.clientWidth), doc: document.documentElement.scrollWidth - innerWidth, clipped, nav: Math.round(nav.width) };
        })()`);
      }
      await js(`(document.querySelector('.mcs-page[data-page="play"]').click(), true)`);
      await shot(`craft-narrow-${width}.png`);
    }
    await u.cdp('Emulation.clearDeviceMetricsOverride');
    check(Object.values(narrow).every((r) => r.side <= 0 && r.doc <= 0 && r.clipped === 0 && r.room >= 200), `at 760, 560 and 420 px nothing runs off the window (${S(narrow)})`);
    check(u.consoleErrors.length === 0, `no renderer exceptions in craft${u.consoleErrors.length ? ` ${S(u.consoleErrors)}` : ''}`);
  } catch (err) {
    check(false, err.message);
    await shot('craft-failure.png').catch(() => {});
  }
  u.close();
  const startsWithLauncher = uiStarts().length;

  // ---------- no launcher ----------
  let w;
  try {
    // Its version services are unreachable too (port 1, which fetch refuses as a bad port).
    const unreachable = S(Object.fromEntries(Object.keys(JSON.parse(SOURCES)).map((k) => [k, 'http://127.0.0.1:1/x'])));
    w = await launch({ name: 'minecraft-launcher', port: 9898, mode: 'craft', lang: 'ko', projectDir: home, env: { ...env, PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_SOURCES: unreachable } });
  } catch (err) {
    check(false, `the craft window without the launcher: ${err.message}`);
    return u.finish();
  }
  w.results.unshift(...u.results);
  try {
    await w.js(stubShell);
    await w.until(`!!document.querySelector('.mcs-play .mcc-banner') && document.querySelectorAll('.mcs-play .mcc-card').length === ${readdirSync(path.join(home, 'instances')).length}`, 'launcher banner', 15000);
    w.check(/공식 Minecraft Launcher가 필요해요/.test(await w.js(`document.querySelector('.mcc-banner').textContent`)), 'without the official launcher, Play shows the banner "공식 Minecraft Launcher가 필요해요"');
    await w.shot('craft-no-launcher.png');
    await w.js(`(document.querySelector('.mcc-banner .mcc-download').click(), true)`);
    await w.js(`(document.querySelector('.mcc-card[data-name="instance"] .mcc-play').click(), true)`);
    await w.until(`!!${dialogButton('다운로드 페이지 열기')}`, 'no launcher dialog', 10000);
    await w.js(`(${dialogButton('다운로드 페이지 열기')}).click()`);
    const opened = await w.js('window.__shell');
    w.check(opened.length === 2 && opened.every(([ch, url]) => ch === 'shell:openExternal' && url === 'https://www.minecraft.net/download') && uiStarts().length === startsWithLauncher,
      `the banner and Play's dialog open Mojang's download page (stubbed), and nothing is started (${S(opened)})`);
    await w.js(`([...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === '닫기')?.click(), document.querySelector('.mcc-new').click(), true)`);
    await w.until(`/연결할 수 없어요/.test(document.querySelector('.dialog .mc-dialog-error')?.textContent || '')`, 'New Instance without the version service', 15000);
    const unreachableText = await w.js(`[document.querySelector('.dialog .mc-dialog-error').textContent, document.querySelector('#mccVersion').selectedOptions[0]?.textContent]`);
    w.check(/^127\.0\.0\.1:1에 연결할 수 없어요\. 인터넷 연결을 확인하고 다시 시도하세요\.$/.test(unreachableText[0]) && unreachableText[1] === '버전 목록을 불러오지 못했어요',
      `a version service that cannot be reached is a Korean cannot-connect message in New Instance, not fetch's own (${S(unreachableText)})`);
    await w.shot('craft-unreachable.png');
    await w.js(`(${dialogButton('취소')}).click()`);
    await w.js(`(ide.settings.set('appearance.theme', 'light'), true)`);
    await w.until(`ide.theme.current() === 'light'`, 'light theme without the launcher', 10000);
    const bannerLight = [await w.js(contrastOf('.mcc-banner-title')), await w.js(contrastOf('.mcc-banner-sub'))];
    await w.shot('craft-no-launcher-light.png');
    w.check(bannerLight.every((r) => r >= 4.5), `the launcher banner reads in the light theme too (${S(bannerLight)})`);
    w.check(w.consoleErrors.length === 0, `no renderer exceptions without the launcher${w.consoleErrors.length ? ` ${S(w.consoleErrors)}` : ''}`);
  } catch (err) {
    w.check(false, err.message);
    await w.shot('craft-nolauncher-failure.png').catch(() => {});
  }
  server.close();
  w.finish();
}

// ---------- MC_LAUNCHER_LIVE=1 ----------
async function live() {
  const liveProject = path.join(work, 'live');
  mkdirSync(liveProject, { recursive: true });
  // What the real installers take on their command line, asked with --help (they print jopt-simple's option list).
  const forgeVer = (await (await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).json()).promos['1.20.1-recommended'];
  const neoXml = await (await fetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')).text();
  const neoVer = [...neoXml.matchAll(/<version>(21\.1\.\d+)<\/version>/g)].map((m) => m[1]).sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2]))[0];
  const help = {};
  for (const [name, url] of [['forge', `https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-${forgeVer}/forge-1.20.1-${forgeVer}-installer.jar`],
    ['neoforge', `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoVer}/neoforge-${neoVer}-installer.jar`]]) {
    const dir = path.join(work, 'help', name);
    mkdirSync(dir, { recursive: true });
    const jar = path.join(dir, 'installer.jar');
    writeFileSync(jar, Buffer.from(await (await fetch(url)).arrayBuffer()));
    const r = spawnSync(bin('java'), ['-jar', jar, '--help'], { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true });
    help[name] = `${r.stdout || ''}${r.stderr || ''}`;
    console.log(`----- ${name} installer (${url}) --help, exit ${r.status}${r.error ? ` ${r.error.message}` : ''} -----\n${help[name].trim()}\n`);
  }
  const t = await launch({ name: 'minecraft-launcher-live', port: 9896, projectDir: liveProject, env: { PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: LAUNCHER } });
  const { js, check } = t;
  const call = (ch, ...args) => js(`ide.api.invoke(${S(ch)}, ${args.map(S).join(', ')}).then((r) => ({ ok: r }), (e) => ({ err: String(e.message || e) }))`);
  const work2 = path.join(liveProject, '.launcher');
  try {
    check(/installClient/.test(help.forge) && /installClient/.test(help.neoforge), 'the real Forge and NeoForge installers list --installClient');
    await js(`(window.__mcLog = [], ide.api.on('minecraft:log', (m) => window.__mcLog.push(m)), true)`);
    for (const [name, loader, mc] of [['fabric', 'fabric', '1.21.1'], ['quilt', 'quilt', '1.21.1'], ['forge', 'forge', '1.20.1'], ['neoforge', 'neoforge', '1.21.1']]) {
      const began = Date.now();
      const r = await call('launcher:create', liveProject, { name, mc, loader }, `live-${name}`);
      const id = r.ok?.loaderId;
      const json = id && existsSync(path.join(work2, 'versions', id, `${id}.json`)) ? readJson(path.join(work2, 'versions', id, `${id}.json`)) : null;
      check(r.ok && json && json.id === id && (loader === 'fabric' || loader === 'quilt' || existsSync(path.join(work2, 'versions', mc, `${mc}.jar`))),
        `${loader} ${mc}: ${r.ok ? `${r.ok.loaderVersion} installed as ${id} (inheritsFrom ${json?.inheritsFrom}) in ${Math.round((Date.now() - began) / 1000)} s` : r.err}`);
      if (!r.ok) console.log(await js(`window.__mcLog.filter((m) => m.job === 'live-${name}').map((m) => m.text).join('').slice(-4000)`));
    }
    const p = await call('launcher:play', liveProject, 'forge', { server: 'localhost:25565' }, 'x');
    const forgeId = readJson(path.join(liveProject, 'instances', 'forge', 'nano-instance.json')).loaderId;
    check(p.ok?.launched && readJson(path.join(work2, 'versions', 'nano-forge', 'nano-forge.json')).inheritsFrom === forgeId
      && Object.keys(readJson(path.join(work2, 'launcher_profiles.json')).profiles).includes('nano-forge'),
    `Play of the real Forge instance writes its version and profile and starts the stand-in launcher (${S(p.ok || p.err)})`);
  } catch (err) {
    check(false, err.message);
  }
  t.finish();
}
