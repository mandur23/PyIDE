// Craft's server files in plain Node: no Electron, no window, no real server, no network beyond a loopback stand-in.
// main/minecraft/server-settings.js (server.properties read and written as Java does, whitelist.json and ops.json kept
// when they cannot be read or hold names Java accounts cannot have), main/minecraft/templates.js (velocity.toml and
// Paper's forwarding files written elsewhere), and main/features/minecraft.js through its IPC handlers: the port and the
// account checks a server card shows, a proxy wired that was made elsewhere, a create cut off while a file is held.
import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const S = JSON.stringify;
let failed = 0;
const check = (ok, label) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const text = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const errOf = async (step) => { try { await step(); return null; } catch (err) { return err; } };

const work = mkdtempSync(path.join(tmpdir(), 'pyide-mcserver-core-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
const ST = require('../main/minecraft/server-settings.js');
const T = require('../main/minecraft/templates.js');

const holders = [];
try {
  // ---------- server.properties ----------
  const props = path.join(work, 'props', 'server.properties');
  write(props, '#Minecraft server properties\r\nwhite-list=false\r\nmotd=Hi\r\nwhite-list=false\r\nonline-mode = False\r\n');
  ST.writeProperties(props, { 'white-list': 'true' });
  const written = text(props);
  check(ST.readProperties(props)['white-list'] === 'true' && written.split('white-list').length === 2 && written.includes('\r\n') && written.startsWith('#Minecraft'),
    `a key given twice is written once, where it first was, in the file's line ends (${S(written)})`);
  check(ST.readProperties(props)['online-mode'] === 'False', 'a value after "key = " is read as Java reads it');
  ST.writeProperties(props, { 'resource-pack': 'https://example.com/a=b.zip' });
  check(ST.readProperties(props)['resource-pack'] === 'https://example.com/a=b.zip' && /^resource-pack=https\\:\/\/example\.com\/a\\=b\.zip$/m.test(text(props)),
    ': and = in a value are escaped as Properties.store writes them, and read back');
  T.setProperty(props, 'online-mode', 'true');
  check(ST.readProperties(props)['online-mode'] === 'true' && text(props).split('online-mode').length === 2, 'templates set a "key = value" line in place');

  // ---------- player lists ----------
  const sdir = path.join(work, 'lists');
  write(path.join(sdir, 'server.properties'), 'motd=old\n');
  write(path.join(sdir, 'whitelist.json'), '[{"uuid":"069a79f4-44e9-4726-a5be-fca90e38aaf5","name":"Notch"},]');
  const damaged = ST.read(sdir);
  check(S(damaged.damaged) === S(['whitelist.json']) && damaged.whitelist.length === 0, `a whitelist.json that cannot be read is told, not shown as empty (${S(damaged.damaged)})`);
  const refused = await errOf(() => ST.prepare(sdir, { props: { motd: 'new' }, whitelist: [{ name: 'Alex', uuid: '11111111-2222-3333-4444-555555555555' }] }));
  check(/whitelist\.json cannot be read/.test(refused?.message || '') && text(path.join(sdir, 'whitelist.json')).includes('Notch') && ST.readProperties(path.join(sdir, 'server.properties')).motd === 'old',
    `a Save of that list is refused and writes nothing, so its players stay (${refused?.message})`);

  const bedrock = { uuid: '00000000-0000-0000-0009-01f2a3b4c5d6', name: '.BedrockSteve' };
  write(path.join(sdir, 'whitelist.json'), S([bedrock]));
  write(path.join(sdir, 'ops.json'), S([{ uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch', level: 0, bypassesPlayerLimit: false }]));
  const now = ST.read(sdir);
  const alex = { name: 'Alex', uuid: '11111111-2222-3333-4444-555555555555' };
  ST.prepare(sdir, { props: { motd: 'new' }, whitelist: [...now.whitelist, alex], ops: [...now.ops, { ...alex, level: 4, bypassesPlayerLimit: false }] })();
  const wl = JSON.parse(text(path.join(sdir, 'whitelist.json')));
  const ops = JSON.parse(text(path.join(sdir, 'ops.json')));
  check(S(wl.map((e) => e.name)) === S(['.BedrockSteve', 'Alex']) && ST.readProperties(path.join(sdir, 'server.properties')).motd === 'new',
    `a player the file has already (a Floodgate name) does not block a Save that adds another (${S(wl)})`);
  check(ops.find((e) => e.name === 'Notch')?.level === 0, `an operator of level 0 stays at 0 (${S(ops)})`);
  const stranger = await errOf(() => ST.prepare(sdir, { whitelist: [...wl, { name: '.Intruder', uuid: '22222222-2222-3333-4444-555555555555' }] }));
  check(/is not a Minecraft name/.test(stranger?.message || ''), 'a new player still needs a Java name');

  // ---------- velocity.toml and Paper's forwarding ----------
  const last = T.setVelocityServers('bind = "0.0.0.0:25577"\n\n[servers]\nlobby = "127.0.0.1:30066"\ntry = ["lobby"]\n', [{ name: 'a', port: 25565 }]);
  check(last.match(/^\[servers\]/gm).length === 1 && last.includes('"a" = "127.0.0.1:25565"') && !last.includes('lobby'), `a [servers] table at the end of the file is replaced, not given a twin (${S(last)})`);
  const crlf = T.setVelocityServers('bind = "0.0.0.0:25577"\r\n[servers]\r\nx = "127.0.0.1:1"\r\n\r\n[forced-hosts]\r\n', [{ name: 'a', port: 25565 }]);
  check(crlf.match(/^\[servers\]/gm).length === 1 && crlf.includes('[forced-hosts]'), 'and in a CRLF file');
  const fwd = T.setVelocityForwarding('bind = "0.0.0.0:25577"\nplayer-info-forwarding-mode = "NONE"\n\n[servers]\n');
  check(/^player-info-forwarding-mode = "MODERN"$/m.test(fwd) && /^forwarding-secret-file = "forwarding.secret"$/m.test(fwd) && fwd.indexOf('forwarding-secret-file') < fwd.indexOf('[servers]'),
    `a proxy made elsewhere is given modern forwarding with the secret file, before its first table (${S(fwd)})`);
  const paperDir = path.join(work, 'paper');
  write(path.join(paperDir, 'config', 'paper-global.yml'), '_version: 29\r\nproxies:\r\n  bungee-cord:\r\n    online-mode: true\r\n');
  T.setPaperVelocity(paperDir, 'sec', '1.20.1');
  const yml = text(path.join(paperDir, 'config', 'paper-global.yml'));
  check(yml.match(/^proxies:/gm).length === 1 && /^ {2}velocity:\n {4}enabled: true/m.test(yml), `a CRLF paper-global.yml gets forwarding under its one proxies: (${S(yml)})`);

  // ---------- main/features/minecraft.js ----------
  process.env.PYIDE_TRUST_ALL = '1';
  process.env.PYIDE_INSTALL_ROOT = path.join(work, 'install-root');
  let answer = null;
  const stand = http.createServer((q, r) => { (answer || ((_q, res) => { res.writeHead(404); res.end(); }))(q, r); });
  await new Promise((resolve) => { stand.listen(0, '127.0.0.1', resolve); });
  const standBase = `http://127.0.0.1:${stand.address().port}`;
  process.env.PYIDE_MC_SOURCES = S({ paper: `${standBase}/paper`, mojang: `${standBase}/mojang/manifest.json`, mojangApi: `${standBase}/mojang-api`, adoptium: `${standBase}/adoptium` });
  const load = Module._load;
  const stub = new Proxy({}, { get: (_t, key) => (key === 'app' ? { getPath: () => work, on() {}, isPackaged: false, getVersion: () => '0.0.0', getName: () => 'test' } : class {}) });
  Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
  const feature = require('../main/features/minecraft.js');
  Module._load = load;
  const handlers = new Map();
  feature.register({ ipcMain: { handle: (h, fn) => handlers.set(h, fn), on() {} }, send() {}, startProcess: () => 1, procs: new Map(), diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  const proj = path.join(work, 'project');
  const srvDir = (n) => path.join(proj, 'servers', n);
  const serverAt = (dir, desc, p = '') => { write(path.join(dir, 'pyide-server.json'), S({ java: 21, memory: '1G', launch: { jar: 'server.jar' }, ...desc })); write(path.join(dir, 'server.properties'), p); return dir; };

  serverAt(srvDir('spaced'), { kind: 'paper', mc: '1.20.1' }, 'server-port = 25570\nonline-mode = False\n');
  const proxyDir = serverAt(srvDir('proxy'), { kind: 'velocity', mc: '3.4.0' }, '');
  write(path.join(proxyDir, 'velocity.toml'), 'bind = "0.0.0.0:25600"\nplayer-info-forwarding-mode = "NONE"\n\n[servers]\n');
  const listed = await call('minecraft:servers', proj);
  const spaced = listed.find((s) => s.name === 'spaced');
  check(spaced?.port === 25570 && spaced.offline === true, `the card reads "server-port = 25570" and "online-mode = False" as the server does (${S({ port: spaced?.port, offline: spaced?.offline })})`);
  check(listed.find((s) => s.name === 'proxy')?.port === 25600, 'a proxy\'s port is what velocity.toml binds');
  const wired = await errOf(() => call('minecraft:wireProxy', proj, proxyDir));
  const secret = text(path.join(proxyDir, 'forwarding.secret'));
  check(!wired && secret?.trim().length > 10 && /^player-info-forwarding-mode = "MODERN"$/m.test(text(path.join(proxyDir, 'velocity.toml'))) && /secret: '/.test(text(path.join(srvDir('spaced'), 'config', 'paper-global.yml')) || ''),
    `a proxy that never ran gets a forwarding secret, modern forwarding, and its Paper server the same secret (${wired?.message || 'wired'})`);
  const tab = await call('minecraft:settings', proj, srvDir('spaced'));
  check(tab.behindProxy === true, 'the settings tab learns that its Paper server is behind the proxy');
  const outside = serverAt(path.join(proj, 'elsewhere', 'x'), { kind: 'paper', mc: '1.20.1' }, 'motd=x\n');
  const out = await errOf(() => call('minecraft:saveSettings', proj, outside, { props: { motd: 'y' } }));
  check(/not a server of this project/.test(out?.message || '') && text(path.join(outside, 'server.properties')) === 'motd=x\n', 'settings are not written into a folder outside the project\'s servers/');

  // A create that fails while another program holds a file in its folder: the cause is what is said, and the name is free
  // once the file is.
  const held = srvDir('held');
  const holdFile = path.join(held, 'scanning.tmp');
  answer = (_q, res) => {
    if (holders.length) { res.writeHead(503); return res.end(); }
    write(holdFile, 'x');
    const ps = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${holdFile}', 'Open', 'ReadWrite', 'None'); 'held'; Start-Sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'] });
    holders.push(ps);
    ps.stdout.once('data', () => { res.writeHead(503); res.end(); });
  };
  const create = () => call('minecraft:create', { root: proj, name: 'held', kind: 'paper', mc: '1.20.1', memory: '1G', port: 25610, eula: true }, () => {});
  const first = await errOf(create);
  check(first && !/EPERM|EBUSY/.test(first.message), `the create's own failure is shown, not the folder it could not remove (${first?.message})`);
  const blocked = await call('minecraft:blockedNames', proj);
  check(!blocked.includes('held') && existsSync(path.join(held, 'pyide-server.unfinished')), `what is left is marked unfinished, and does not block the name (${S(blocked)})`);
  for (const h of holders.splice(0)) h.kill();
  await new Promise((r) => setTimeout(r, 500));
  answer = null;
  const second = await errOf(create);
  check(second && !/being made already/.test(second.message) && !existsSync(held), `once the file is let go, the next create of the name runs and cleans up (${second?.message})`);

  // ---------- a server that outlives the app ----------
  {
  // A stand-in server (java.exe, as a real one) started by one app instance; a fresh copy of the module plays the app
  // started again after a crash, which no longer holds the process.
  const javaHome = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME_17_X64 || process.env.JAVA_HOME;
  const java = path.join(javaHome, 'bin', 'java.exe');
  const idle = path.join(work, 'Idle.java');
  write(idle, 'public class Idle { public static void main(String[] a) throws Exception { var in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in)); for (String l; (l = in.readLine()) != null;) if (l.trim().equals("stop")) System.exit(0); Thread.sleep(600000); } }');
  const appInstance = () => {
    delete require.cache[require.resolve('../main/features/minecraft.js')];
    Module._load = function loadWithoutElectron(request, parent, isMain) { return request === 'electron' ? stub : load.call(this, request, parent, isMain); };
    const f = require('../main/features/minecraft.js');
    Module._load = load;
    const hs = new Map();
    const procs = new Map();
    let n = 0;
    const startProcess = (cmd, args, opts) => { const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true }); holders.push(child); procs.set(++n, child); return n; };
    f.register({ ipcMain: { handle: (h, fn) => hs.set(h, fn), on() {} }, send() {}, startProcess, procs, diagnostics: { logger: () => ({ warn() {}, info() {} }) } });
    return (name, ...args) => hs.get(name)({}, ...args);
  };
  const runner = serverAt(srvDir('runner'), { kind: 'paper', mc: '1.20.1' }, 'server-port=25620\n');
  const marker = path.join(runner, 'pyide-server.running');
  const appA = appInstance();
  await appA('minecraft:start', proj, { cmd: java, args: [idle], cwd: runner });
  const child = holders[holders.length - 1];
  const written = (() => { try { return JSON.parse(text(marker)); } catch { return null; } })();
  check(written?.pid === child.pid, `a started server leaves a run marker with its pid in its folder (${S(written)})`);
  const spawned = holders.length;
  const twice = await errOf(() => appA('minecraft:start', proj, { cmd: java, args: [idle], cwd: runner }));
  check(/running already/.test(twice?.message || '') && holders.length === spawned, `a second start of the same folder is refused while the first runs (${twice?.message})`);
  await new Promise((r) => setTimeout(r, 1500));
  const appB = appInstance();
  const stale = serverAt(srvDir('stale'), { kind: 'paper', mc: '1.20.1' }, 'server-port=25621\n');
  write(path.join(stale, 'pyide-server.running'), S({ pid: process.pid, started: Date.now(), dir: stale }));
  const seen = await appB('minecraft:servers', proj);
  check(seen.find((s) => s.name === 'runner')?.leftOver?.pid === child.pid, `after a restart the app sees the server still running from before (${S(seen.find((s) => s.name === 'runner')?.leftOver)})`);
  check(!seen.find((s) => s.name === 'stale')?.leftOver && !existsSync(path.join(stale, 'pyide-server.running')),
    'a marker whose pid now belongs to another program (not java.exe) is taken as stale and removed');
  const launchRefused = await errOf(() => appB('minecraft:launch', proj, runner, 'job'));
  const startRefused = await errOf(() => appB('minecraft:start', proj, { cmd: java, args: [idle], cwd: runner }));
  check(/still running outside this window \(process \d+\)/.test(launchRefused?.message || '') && /still running outside/.test(startRefused?.message || '') && holders.length === spawned,
    `Start is refused while it runs, saying so (${launchRefused?.message})`);
  const ended = await appB('minecraft:endLeftOver', proj, runner);
  const exited = await new Promise((r) => { if (child.exitCode !== null || child.signalCode) r(true); else { child.once('exit', () => r(true)); setTimeout(r, 10000, false); } });
  check(ended.ended && exited && !existsSync(marker) && !(await appB('minecraft:servers', proj)).find((s) => s.name === 'runner')?.leftOver,
    'End Server ends the left-over process and clears the marker');

  // ---------- settings saved while a server runs ----------
  // A stand-in dedicated server: it keeps server.properties as it read it at its start and writes that copy whole when
  // a command changes a setting ("set key=value"), as Minecraft's does.
  const propServer = path.join(work, 'prop-server.cjs');
  write(propServer, `const fs = require('fs');
const mem = {};
for (const l of fs.readFileSync('server.properties', 'utf8').split(/\\r?\\n/)) { const m = /^([^#=]+)=(.*)$/.exec(l); if (m) mem[m[1]] = m[2]; }
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (l === 'stop') process.exit(0);
  const m = /^set (\\S+)=(.*)$/.exec(l);
  if (m) { mem[m[1]] = m[2]; fs.writeFileSync('server.properties', Object.entries(mem).map(([k, v]) => k + '=' + v).join('\\n') + '\\n'); console.log('wrote'); }
});
`);
  const live = serverAt(srvDir('live'), { kind: 'paper', mc: '1.20.1' }, 'motd=old\ndifficulty=easy\nmax-players=20\n');
  const appC = appInstance();
  await appC('minecraft:start', proj, { cmd: process.execPath, args: [propServer], cwd: live });
  const liveProc = holders[holders.length - 1];
  const tell = async (line) => { liveProc.stdin.write(`${line}\n`); await new Promise((r) => setTimeout(r, 2000)); };
  const liveProps = () => ST.readProperties(path.join(live, 'server.properties'));
  await new Promise((r) => setTimeout(r, 500));
  await appC('minecraft:saveSettings', proj, live, { props: { motd: 'Saved while running', 'max-players': '8' } });
  await tell('set difficulty=hard');
  check(liveProps().motd === 'Saved while running' && liveProps().difficulty === 'hard' && liveProps()['max-players'] === '8',
    `a command that makes the server write its start-time copy of server.properties does not take back what was saved since, and keeps the server's own change (${S(liveProps())})`);
  await tell('set max-players=12');
  check(liveProps()['max-players'] === '12' && liveProps().motd === 'Saved while running', `a saved key the server itself then sets to another value (an operator's command) keeps the server's value (${S(liveProps())})`);
  liveProc.stdin.write('stop\n');
  await new Promise((r) => { liveProc.once('exit', r); setTimeout(r, 5000); });

  // ---------- a Paper world dropped with its Nether and End ----------
  const drops = path.join(work, 'drops');
  for (const [folder, inner] of [['survival', null], ['survival_nether', 'DIM-1'], ['survival_the_end', 'DIM1']]) {
    write(path.join(drops, folder, 'level.dat'), 'level');
    if (inner) write(path.join(drops, folder, inner, 'region', 'r.0.0.mca'), folder);
  }
  const paperWorlds = serverAt(srvDir('paperworlds'), { kind: 'paper', mc: '1.20.1' }, 'level-name=world\n');
  const dropAll = ['survival_nether', 'survival', 'survival_the_end'].map((n) => path.join(drops, n));
  const onPaper = await call('minecraft:drop', proj, paperWorlds, dropAll, 'job');
  check(ST.readProperties(path.join(paperWorlds, 'server.properties'))['level-name'] === 'survival' && text(path.join(paperWorlds, 'survival_nether', 'DIM-1', 'region', 'r.0.0.mca')) === 'survival_nether'
    && existsSync(path.join(paperWorlds, 'survival_the_end', 'DIM1')) && S(onPaper.done.map((d) => d.what).sort()) === S(['dimension', 'dimension', 'world']) && !onPaper.skipped.length,
  `a Paper world dropped with its Nether and End folders is one world: the level name is the world's, and its dimensions sit beside it where Paper reads them (${S(onPaper)})`);
  const again = await call('minecraft:drop', proj, paperWorlds, dropAll, 'job');
  check(ST.readProperties(path.join(paperWorlds, 'server.properties'))['level-name'] === 'survival-2' && existsSync(path.join(paperWorlds, 'survival-2_nether', 'DIM-1')),
    `dropped again, the copy and its dimensions take a free name together (${S(again.done.map((d) => d.to))})`);
  const fabricWorlds = serverAt(srvDir('fabricworlds'), { kind: 'fabric', mc: '1.20.1' }, 'level-name=world\n');
  await call('minecraft:drop', proj, fabricWorlds, dropAll, 'job');
  check(text(path.join(fabricWorlds, 'survival', 'DIM-1', 'region', 'r.0.0.mca')) === 'survival_nether' && existsSync(path.join(fabricWorlds, 'survival', 'DIM1')) && !existsSync(path.join(fabricWorlds, 'survival_nether')),
    'on a server that is not Paper, the Nether and End go inside the world, where it reads them');
  const alone = await call('minecraft:drop', proj, paperWorlds, [path.join(drops, 'survival_nether')], 'job');
  check(alone.skipped[0]?.why === 'dimension' && !alone.done.length && ST.readProperties(path.join(paperWorlds, 'server.properties'))['level-name'] === 'survival-2',
    `a Nether folder dropped without its world is not made the server's world (${S(alone)})`);

  // ---------- Mojang's version list ----------
  const { KINDS: SOURCES, javaFor } = require('../main/minecraft/sources.js');
  const sb = `http://127.0.0.1:${stand.address().port}`;
  let released = ['1.20.1'];
  let asked = 0;
  answer = (q, res) => {
    if (q.url === '/mojang/manifest.json') { asked++; res.end(S({ versions: released.map((id) => ({ id, type: 'release', url: `${sb}/mojang/${id}.json` })) })); return; }
    const v = /^\/mojang\/(.+)\.json$/.exec(q.url);
    if (v) { res.end(S({ javaVersion: { majorVersion: v[1] === '1.20.1' ? 17 : 21 } })); return; }
    res.writeHead(404); res.end();
  };
  const listed1 = await SOURCES.vanilla.versions();
  released = ['1.21.9', '1.20.1'];
  const listed2 = await SOURCES.vanilla.versions();
  check(S(listed1) === S(['1.20.1']) && S(listed2) === S(['1.20.1']) && asked === 1, `the version list is asked once and kept for a while (${asked} asks)`);
  const newJava = await javaFor('1.21.9');
  check(newJava === 21 && asked === 2, `a version released since the list was kept is found by asking again at once (Java ${newJava}, ${asked} asks)`);
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60000;
  const later = await SOURCES.vanilla.versions().finally(() => { Date.now = realNow; });
  check(S(later) === S(['1.21.9', '1.20.1']) && asked === 3, `half an hour on, the list is asked again (${S(later)})`);
  answer = null;

  // ---------- a pyide-server.json broken by hand ----------
  const broken = serverAt(srvDir('broken'), { kind: 'paper', mc: '1.20.1' }, 'server-port=25622\n');
  await call('minecraft:saveSettings', proj, broken, { memory: '3G' });
  writeFileSync(path.join(broken, 'pyide-server.json'), '{"kind": "paper", oops');
  const listedBroken = (await call('minecraft:damagedServers', proj)).some((s) => s.name === 'broken' && s.repair === 'backup');
  const repaired = await call('minecraft:repairServer', proj, broken);
  const back = JSON.parse(text(path.join(broken, 'pyide-server.json')));
  check(listedBroken && repaired.from === 'backup' && back.memory === '3G' && back.kind === 'paper' && text(path.join(broken, 'pyide-server.json.damaged')) === '{"kind": "paper", oops'
    && !(await call('minecraft:damagedServers', proj)).some((s) => s.name === 'broken'),
  'Repair puts back the copy written last (its memory too) and keeps the damaged file beside it');
  const foreign = srvDir('foreign');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(path.join(foreign, 'pyide-server.json'), S({ kind: 'spigot', mc: '1.20.1' }));
  const listedForeign = (await call('minecraft:damagedServers', proj)).find((s) => s.name === 'foreign');
  const refused = await call('minecraft:repairServer', proj, foreign).then(() => null, (err) => err.code);
  check(listedForeign?.damaged === 'kind' && listedForeign.repair === null && refused === 'notRepairable' && !existsSync(path.join(foreign, 'pyide-server.json.damaged'))
    && JSON.parse(text(path.join(foreign, 'pyide-server.json'))).kind === 'spigot',
  `a server type from elsewhere with no copy and no jar Nano Studio knows is listed as not repairable, and Repair leaves it as it is (${S(listedForeign)}, ${refused})`);
  }
  stand.close();
} catch (err) {
  check(false, `suite error: ${err.stack}`);
} finally {
  for (const h of holders) h.kill();
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
