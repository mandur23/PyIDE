// A server's mods and plugins in its settings tab (main/minecraft/mods.js, renderer/features/minecraft/mods.js): first
// the rules on jars this test writes (no download, no real mod), then a Korean craft window on a Fabric server and a
// Paper server made of such jars. No real server, game, launcher, EULA or network.
// Checks: version ranges as Fabric and Forge write them; what a jar says it is (fabric.mod.json, mods.toml,
// plugin.yml, paper-plugin.yml), a jar inside a jar included; a missing dependency, one turned off, one of another
// version, two mods that break each other, the same mod twice, a mod of another loader or another Minecraft, a
// client-only mod; the section lists the mods with switches and the problems with what to do; a switch renames the jar
// and the Market's record follows; turning a needed mod off is reported with Turn On, which puts it back; a running
// server's mods are not switched; a server that starts with problems says so. Port 9749; the stand-in listens on 25742.
// Usage: node verify/craft-mods.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const M = require('../main/minecraft/mods.js');
const { writeZip } = require('../main/minecraft/zipfile.js');
let passed = 0;
let failed = 0;
const rule = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`); if (ok) passed++; else failed++; };

const work = mkdtempSync(path.join(tmpdir(), 'pyide-craft-mods-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const jar = (entries) => writeZip(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : S(data)) })));
const fabric = (id, version, extra = {}) => ({ 'fabric.mod.json': { schemaVersion: 1, id, name: extra.name || id, version, ...extra } });

// ---------- the rules ----------
{
  const f = M.fabricMatches;
  rule(f('1.20.1', '>=1.20 <1.21') === true && f('1.21', '1.20.x') === false && f('0.92.2+1.20.1', ['^0.90.0', '>=1']) === true && f('1.2.9', '~1.2.0') === true && f('1.3.0', '~1.2.0') === false
    && f('2.0.0-beta.1', '>=2.0.0') === false && f('26.3', '*') === true && f('snapshot', '>=1') === null,
  'Fabric\'s ranges: and, or, ^, ~, x, a pre-release below its release, and a version that is not numbers is not judged');
  const m = M.mavenMatches;
  rule(m('47.2.0', '[47,)') === true && m('1.19.2', '[1.20,1.21)') === false && m('1.20.1', '[1.20.1]') === true && m('3.0', '(,2.0],[2.5,)') === true && m('2.2', '(,2.0],[2.5,)') === false && m('1.0', '1.2') === false && m('9', '') === true,
    'Forge\'s ranges: open and closed ends, one version, several joined, a bare version as a minimum');

  const dir = path.join(work, 'rules');
  const put = (name, entries) => { const p = path.join(dir, name); write(p, jar(entries)); return p; };
  const inner = jar(fabric('fabric-resource-loader-v0', '0.11.0'));
  const api = M.describe(put('fabric-api.jar', { ...fabric('fabric-api', '0.92.2+1.20.1', { jars: [{ file: 'META-INF/jars/rl.jar' }] }), 'META-INF/jars/rl.jar': inner }));
  rule(api.mods[0].id === 'fabric-api' && S(api.provides) === S([{ id: 'fabric-resource-loader-v0', version: '0.11.0' }]) && S(api.loaders) === S(['fabric']), `a Fabric jar says its id and what the jars inside it bring (${S(api.provides)})`);
  const forge = M.describe(put('create.jar', { 'META-INF/mods.toml': 'modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="create"\nversion="${file.jarVersion}"\ndisplayName="Create"\ndescription=\'\'\'\nmany\n[[mods]] lines\n\'\'\'\n[[dependencies.create]]\n  modId="flywheel"\n  mandatory=true\n  versionRange="[0.6.10,0.6.11)"\n  side="CLIENT"\n[[dependencies.create]]\n  modId="minecraft"\n  mandatory=true\n  versionRange="[1.20.1]"\n[[dependencies.create]]\n  modId="jei"\n  mandatory=false\n  versionRange="[15,)"\n',
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Version: 0.5.1\r\n' }));
  rule(forge.mods[0].name === 'Create' && forge.mods[0].version === '0.5.1' && S(forge.mods[0].depends.map((d) => [d.id, d.kind])) === S([['minecraft', 'required'], ['jei', 'optional']]),
    `a Forge jar says its name, its version from the manifest, and its dependencies without the client's (${S(forge.mods[0].depends.map((d) => [d.id, d.kind]))})`);
  const plugin = M.describe(put('shop.jar', { 'plugin.yml': 'name: Shop\nversion: "1.2"\nmain: a.B\ndepend: [Vault]\nsoftdepend:\n  - PlaceholderAPI\n' }));
  const paper = M.describe(put('land.jar', { 'paper-plugin.yml': 'name: Land\nversion: 3\ndependencies:\n  server:\n    Vault:\n      required: true\n    Dynmap:\n      required: false\n' }));
  rule(S(plugin.mods[0].depends.map((d) => [d.id, d.kind])) === S([['vault', 'required'], ['placeholderapi', 'optional']]) && S(paper.mods[0].depends.map((d) => [d.id, d.kind])) === S([['vault', 'required'], ['dynmap', 'optional']]),
    'a plugin says what it needs and what it only uses when there, in plugin.yml and paper-plugin.yml');
  rule(!!M.describe(put('broken.jar', { 'a.txt': 'x' })).mods.length === false && !!M.describe(path.join(dir, 'nothing.jar')).error, 'a jar without metadata has no mod, and one that cannot be opened says why');

  const item = (file, enabled, entries) => ({ file: `mods/${file}`, enabled, ...M.describe(put(`c-${file}`, entries)) });
  const server = { kind: 'fabric', mc: '1.20.1', java: 17, family: 'fabric', loaderVersion: '0.15.0' };
  const codes = (list) => M.check(list, server).map((p) => `${p.code}:${p.mod}${p.need ? `>${p.need}` : ''}${p.other ? `~${p.other}` : ''}`);
  const base = () => [item('api.jar', true, { ...fabric('fabric-api', '0.92.2', { jars: [{ file: 'in.jar' }] }), 'in.jar': inner }), item('lithium.jar', true, fabric('lithium', '0.11.2', { depends: { minecraft: '1.20.x', fabricloader: '>=0.14', java: '>=17' } }))];
  rule(S(codes(base())) === S([]), `mods whose needs are met have no problem (${S(codes(base()))})`);
  rule(S(codes([...base(), item('a.jar', true, fabric('addon', '1.0', { depends: { 'fabric-resource-loader-v0': '*', sodium: '>=0.5', 'fabric-api': '>=0.100' }, recommends: { modmenu: '*' } }))]))
    === S(['missing:addon>sodium', 'version:addon>fabric-api~fabric-api']), 'a missing mod and one of too old a version are named; a mod inside another jar counts as there, and a recommendation is not a need');
  rule(S(codes([...base(), item('a.jar', true, fabric('addon', '1.0', { depends: { sodium: '*' } })), item('sodium.jar.disabled', false, fabric('sodium', '0.5.3', { name: 'Sodium' }))])) === S(['disabled:addon>sodium~Sodium']),
    'a needed mod that is turned off is told apart from a missing one');
  rule(S(codes([...base(), item('a.jar', true, fabric('optifabric', '1.0', { breaks: { lithium: '<0.12' }, conflicts: { 'fabric-api': '*' } }))])) === S(['breaks:optifabric~lithium', 'conflicts:optifabric~fabric-api']),
    'two mods that do not work together are an error, a known conflict a warning, errors first');
  rule(S(codes([...base(), item('lithium-old.jar', true, fabric('lithium', '0.10.0'))])) === S(['duplicate:lithium']), 'the same mod in two jars is named once');
  rule(S(codes([...base(), item('forge.jar', true, { 'META-INF/mods.toml': '[[mods]]\nmodId="jei"\nversion="15"\n' }), item('new.jar', true, fabric('newer', '1', { depends: { minecraft: '>=1.21', java: '>=21' } })), item('hud.jar', true, fabric('hud', '1', { environment: 'client' })),
    item('junk.jar', true, { 'a.txt': 'x' })])) === S(['loader:jei', 'minecraft:newer>minecraft', 'java:newer>java', 'client:hud', 'unreadable:junk.jar']),
  'a mod of another loader, of another Minecraft, one that needs a newer Java, a client-only mod and a jar that is no mod are each said');
  rule(S(M.check([{ file: 'plugins/shop.jar', enabled: true, ...plugin }], { kind: 'paper', mc: '1.20.1', family: 'bukkit' }).map((p) => `${p.code}:${p.need}`)) === S(['missing:vault']), 'a plugin whose depend is not there is named, its softdepend not');
}

// ---------- in the app ----------
const dir = path.join(project, 'servers', 'modded');
const pdir = path.join(project, 'servers', 'papery');
write(path.join(dir, 'pyide-server.json'), S({ kind: 'fabric', mc: '1.20.1', loader: '0.15.0', build: null, java: 17, memory: '2G', launch: { jar: 'server.jar' },
  market: { P1: { title: 'Sodium', version: '0.5.3', versionId: 'v1', files: ['mods/sodium.jar'], needs: [], dependency: false } } }));
write(path.join(dir, 'server.properties'), 'server-port=25742\nmotd=modded\n');
write(path.join(dir, 'stand-in.json'), S({ port: 25742 }));
write(path.join(dir, 'mods', 'sodium.jar'), jar(fabric('sodium', '0.5.3', { name: 'Sodium', depends: { minecraft: '1.20.x' } })));
write(path.join(dir, 'mods', 'sodium-extra.jar'), jar(fabric('sodium-extra', '0.5.1', { name: 'Sodium Extra', depends: { sodium: '>=0.5' } })));
write(path.join(dir, 'mods', 'minimap.jar'), jar(fabric('minimap', '2.0', { name: 'Minimap', environment: 'client' })));
write(path.join(dir, 'mods', 'worldgen.jar.disabled'), jar(fabric('worldgen', '1.0', { name: 'World Gen' })));
write(path.join(pdir, 'pyide-server.json'), S({ kind: 'paper', mc: '1.20.1', build: 100, java: 17, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(pdir, 'server.properties'), 'server-port=25743\nmotd=papery\n');
write(path.join(pdir, 'plugins', 'shop.jar'), jar({ 'plugin.yml': 'name: Shop\nversion: 1.2\nmain: a.B\ndepend: [Vault]\n' }));
const mods = () => readdirSync(path.join(dir, 'mods')).sort();
const record = () => JSON.parse(readFileSync(path.join(dir, 'pyide-server.json'), 'utf8')).market.P1.files;
const standIn = path.resolve('verify/fixtures/craft-health/stand-in-server.cjs');
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');
const CLOSED = 'http://127.0.0.1:1';
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, paper: `${CLOSED}/paper`, modrinth: `${CLOSED}/modrinth` }) };

const t = await launch({ name: 'craft-mods', port: 9749, mode: 'craft', lang: 'ko-KR', projectDir: project, env });
const { js, until, check, shot, sleep } = t;
const SEC = `document.querySelector('.custom-tab.mcset:not(.hidden) .mcset-mods')`;
const srv = (name) => `ide.minecraft.servers().find((s) => s.name === ${S(name)})`;
const view = () => js(`(() => { const s = ${SEC}; return { summary: s.querySelector('.mcset-mods-summary').textContent, cls: s.querySelector('.mcset-mods-summary').className.split(' ').pop(),
  problems: [...s.querySelectorAll('.mcset-mods-problem')].map((p) => [p.dataset.code, p.querySelector('.mcset-mods-text').textContent, p.querySelector('.mcset-mods-fix')?.textContent || '']),
  rows: [...s.querySelectorAll('.mcset-mods-row')].map((r) => [r.dataset.file, r.querySelector('input').checked, r.querySelector('.mcset-label').firstChild.textContent, r.className.replace('mcset-mods-row', '').trim()]),
  status: s.querySelector('.mcset-mods-status').textContent }; })()`);
const flip = (file) => js(`(() => { const c = ${SEC}.querySelector('.mcset-mods-row[data-file="${file}"] input'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); return true; })()`);
const settled = (text) => until(`(${SEC}?.querySelector('.mcset-mods-status').textContent || '').includes(${S(text)})`, `status says ${text}`, 8000);
try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 20000);
  await js(`(() => {
    const invoke = ide.api.invoke;
    ide.api.invoke = (ch, ...a) => ch !== 'minecraft:launch' ? invoke(ch, ...a) : invoke(ch, ...a).then((spec) => ({ ...spec, cmd: ${S(process.execPath)}, args: [${S(standIn)}] }));
    return true;
  })()`);
  await js('ide.minecraft.refresh()');
  await until(`!!${srv('modded')} && !!${srv('papery')}`, 'the servers in the list', 10000);

  // ---------- the list and the problems ----------
  await js(`(ide.minecraft.serverSettings(${srv('modded')}), true)`);
  await until(`${SEC}?.querySelectorAll('.mcset-mods-row').length === 4`, 'the four mods listed', 10000);
  const first = await view();
  check(S(first.rows) === S([['mods/minimap.jar', true, 'Minimap', 'warn'], ['mods/sodium-extra.jar', true, 'Sodium Extra', ''], ['mods/sodium.jar', true, 'Sodium', ''], ['mods/worldgen.jar.disabled', false, 'World Gen', 'off']]),
    `the section lists every jar by its mod's name, on or off (${S(first.rows)})`);
  check(first.cls === 'warn' && first.summary === '서버를 막는 문제는 없고, 알아 둘 점이 1개 있어요.' && S(first.problems) === S([['client', 'Minimap은(는) 게임(클라이언트) 전용이에요. 서버에서는 아무 일도 하지 않고, 서버 시작을 막는 것도 있어요.', 'Minimap 끄기']]),
    `a client-only mod is said in Korean with a button that turns it off (${S([first.summary, first.problems])})`);
  await js(`(${SEC}.scrollIntoView({ block: 'center' }), true)`);

  // ---------- turning a mod off and on ----------
  await js(`(${SEC}.querySelector('.mcset-mods-fix').click(), true)`);
  await settled('minimap.jar을(를) 껐어요');
  const offed = await view();
  check(S(mods()) === S(['minimap.jar.disabled', 'sodium-extra.jar', 'sodium.jar', 'worldgen.jar.disabled']) && offed.cls === 'ok' && offed.summary === '켜진 모드 2개에서 문제를 찾지 못했어요.' && !offed.problems.length,
    `the button renames the jar to .jar.disabled and the problem is gone (${S([mods(), offed.summary])})`);
  await flip('mods/sodium.jar');
  await settled('sodium.jar을(를) 껐어요');
  const needed = await view();
  check(S(mods()).includes('sodium.jar.disabled') && needed.cls === 'bad' && S(needed.problems) === S([['disabled', 'Sodium Extra에 필요한 Sodium이(가) 꺼져 있어요.', 'Sodium 켜기']]),
    `turning off a mod another needs is reported at once, with Turn On (${S([needed.summary, needed.problems])})`);
  check(S(record()) === S(['mods/sodium.jar.disabled']), `the Market's record of the file follows the rename (${S(record())})`);
  await shot('mods-problem.png');
  await js(`(${SEC}.querySelector('.mcset-mods-problem[data-code="disabled"] .mcset-mods-fix').click(), true)`);
  await settled('sodium.jar을(를) 켰어요');
  const back = await view();
  check(mods().includes('sodium.jar') && !mods().includes('sodium.jar.disabled') && !back.problems.length && S(record()) === S(['mods/sodium.jar']), `Turn On puts it back, and the record with it (${S([mods(), record()])})`);
  await flip('mods/worldgen.jar.disabled');
  await settled('worldgen.jar을(를) 켰어요');
  check(mods().includes('worldgen.jar') && (await view()).rows.find((r) => r[2] === 'World Gen')?.[1] === true, 'a mod that was off is turned on by its switch');

  // ---------- problems that stop a start, found without starting ----------
  write(path.join(dir, 'mods', 'sodium-copy.jar'), jar(fabric('sodium', '0.4.0', { name: 'Sodium' })));
  write(path.join(dir, 'mods', 'needs.jar'), jar(fabric('needs', '1.0', { name: 'Needs', depends: { cloth: '>=11', minecraft: '>=1.21' } })));
  await js(`(${SEC}.querySelector('.mcset-mods-recheck').click(), true)`);
  await until(`${SEC}.querySelectorAll('.mcset-mods-problem').length === 3`, 'three problems after Check Again', 8000);
  const three = await view();
  check(three.cls === 'bad' && three.summary === '서버 시작을 막을 수 있는 문제가 3개 있어요.'
    && S(three.problems.map((p) => [p[0], p[2]])) === S([['missing', '마켓에서 찾기'], ['minecraft', 'Needs 끄기'], ['duplicate', 'sodium-copy.jar 끄기']]),
  `Check Again finds a missing mod, a mod of another Minecraft and a mod installed twice (the older copy is the one to turn off), each with what to do (${S(three.problems)})`);
  check(/Needs은\(는\) 마인크래프트 >=1\.21용인데 이 서버는 1\.20\.1이에요/.test(three.problems[1][1]) && /cloth >=11/.test(three.problems[0][1]) && /sodium\.jar, sodium-copy\.jar/.test(three.problems[2][1]), `in words that name the versions and the files (${S(three.problems.map((p) => p[1]))})`);
  await shot('mods-problems.png');

  // ---------- a server that starts with problems, and a running one ----------
  await js(`(ide.minecraft.startServer(${srv('modded')}), true)`);
  await until(`ide.minecraft.runningAt(${srv('modded')}.dir)`, 'the server running', 20000);
  await until(`ide.notifications.list().some((e) => e.title === 'modded: 모드 문제 3개')`, 'the notification of the problems at the start', 10000);
  const note = await js(`ide.notifications.list().find((e) => e.title === 'modded: 모드 문제 3개').text`);
  check(/Needs/.test(note) && /cloth/.test(note), `a server started with problems is told which, without being stopped (${S(note)})`);
  await js(`(ide.minecraft.serverSettings(${srv('modded')}), true)`);
  // The tab is drawn again when the list of servers is read after the start: a switch pressed on the section that is
  // about to be replaced answers into a section no longer on screen (CI), so it is pressed again on the one that is.
  const REFUSED = 'modded 서버를 먼저 멈추세요';
  for (let i = 0; i < 4; i++) {
    await until(`${SEC}?.querySelector('.mcset-mods-row[data-file="mods/needs.jar"] input')?.checked === true`, 'the Needs row, on', 8000);
    await flip('mods/needs.jar');
    if (await until(`(${SEC}?.querySelector('.mcset-mods-status').textContent || '').includes(${S(REFUSED)})`, 'the refusal', 3000).then(() => true, () => false)) break;
  }
  await settled(REFUSED);
  check(mods().includes('needs.jar') && (await view()).rows.find((r) => r[2] === 'Needs')?.[1] === true, 'a running server\'s mod is not switched: the switch goes back and says to stop the server first');
  await js(`(ide.run.sessions().find((x) => x.running)?.stop(), true)`);
  await until(`!ide.minecraft.runningAt(${srv('modded')}.dir) && !ide.minecraft.stoppingAt(${srv('modded')}.dir)`, 'the server stopped', 20000);

  // ---------- plugins ----------
  await js(`(ide.minecraft.serverSettings(${srv('papery')}), true)`);
  await until(`${SEC}?.querySelectorAll('.mcset-mods-row').length === 1`, 'the plugin listed', 10000);
  const plug = await view();
  const page = await js(`[...document.querySelectorAll('.custom-tab.mcset:not(.hidden) .mcset-page')].map((p) => p.textContent)`);
  check(page.includes('플러그인') && !page.includes('모드') && S(plug.problems) === S([['missing', 'Shop에 필요한 vault이(가) 설치되어 있지 않아요.', '마켓에서 찾기']]), `a Paper server has a Plugins section, and a plugin whose depend is missing is named (${S(plug.problems)})`);
  const english = await js(`[...(${SEC}?.querySelectorAll('.mcset-mods-summary, .mcset-mods-fix, .mcset-mods-recheck, .mcset-mods-status') || [])].map((n) => n.textContent).filter((x) => /[A-Za-z]{4,}/.test(x.replace(/Shop|vault/gi, '')))`);
  check(!english.length, `nothing of the section's own words is left in English (${S(english)})`);
  check(!t.consoleErrors.length, `no renderer exceptions ${S(t.consoleErrors)}`);
} catch (err) {
  check(false, `craft-mods crashed: ${err.stack || err}`);
}
if (failed) process.exitCode = 1;
console.log(`rules: ${passed}/${passed + failed} passed`);
t.finish();
