// The anti-xray section end to end in the Korean Craft window: renderer/features/minecraft/server-settings.js, the real
// minecraft:saveSettings, minecraft:launch, minecraft:start and minecraft:antiXray* channels and files on disk. No real
// server, game, launcher or sign-in, no EULA and no network: a Node script plays a server's first start (it writes the
// config as Paper does, and exits on "stop"), PYIDE_MC_JAVA names a Java home that is never run, and "running" and restart
// are stubbed at ide.minecraft, so what restarting does is minecraft.mjs's to prove. Every press goes through
// Input.dispatchMouseEvent at a spot elementFromPoint says is the control. create() writing a waiting level is checked in
// minecraft.mjs, whose stand-in jars go through the New Server flow. Port 9995. Screenshots go to verify/out/minecraft-antixray-ui/.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'pyide-mcxray-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (p) => readFileSync(p, 'utf8');
const serverDir = (name) => path.join(project, 'servers', name);
const inServer = (name, ...rest) => path.join(serverDir(name), ...rest);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const dict = { ...JSON.parse(read(path.join(APP, 'renderer/locales/ko.json'))), ...JSON.parse(read(path.join(APP, 'renderer/features/minecraft/locales/ko.json'))) };
const K = (text, values = {}) => Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), dict[text] ?? `(no Korean: ${text})`);

const CONFIG = `# This is the world defaults configuration file for Paper.

_version: 31
anticheat:
  anti-xray:
    enabled: false
    engine-mode: 1
    hidden-blocks:
    - copper_ore
    - clay
    lava-obscures: false
    max-block-height: 64
    replacement-blocks:
    - stone
    update-radius: 2
    use-permission: false
chunks:
  auto-save-interval: default
`;
const WORLD = '# This is a world configuration file for Paper.\n\n_version: 31\n';
const CONFIG_FILE = path.join('config', 'paper-world-defaults.yml');
const NETHER26 = path.join('world', 'dimensions', 'minecraft', 'the_nether', 'paper-world.yml');
const END26 = path.join('world', 'dimensions', 'minecraft', 'the_end', 'paper-world.yml');
const desc = (kind, mc, extra = {}) => S({ kind, mc, loader: null, build: 1, java: 21, memory: '1G', launch: { jar: 'server.jar' }, mdk: null, ...extra });
const descOf = (name) => JSON.parse(read(inServer(name, 'pyide-server.json')));
const server = (name, kind, mc, { config, nether, extra } = {}) => {
  write(inServer(name, 'pyide-server.json'), desc(kind, mc, extra));
  write(inServer(name, 'server.properties'), `server-port=25565\nmotd=${name}\n`);
  if (config) write(inServer(name, CONFIG_FILE), config);
  if (nether) write(inServer(name, nether), WORLD);
};
server('survival', 'paper', '26.3', { config: CONFIG, nether: NETHER26 });
server('lobby', 'purpur', '1.21.1', { config: CONFIG, nether: path.join('world_nether', 'paper-world.yml') });
server('busy', 'paper', '26.3', { config: CONFIG, nether: NETHER26 });
server('fresh', 'paper', '26.3');
server('newbie', 'paper', '26.3', { extra: { antiXrayPending: 'strong' } });
server('waiter', 'paper', '26.3', { config: CONFIG, extra: { antiXrayPending: 'basic' } });
server('broken', 'paper', '26.3', { config: '_version: 31\nchunks:\n  a: 1\n' });
server('legacy', 'paper', '1.18.2');
server('plain', 'vanilla', '1.21.1');
server('modded', 'fabric', '1.21.1');
server('proxy', 'velocity', '3.4.0');

const standIn = path.join(work, 'stand-in.cjs');
write(standIn, `const fs = require('fs');
const path = require('path');
const [config, world] = process.argv.slice(2);
if (!fs.existsSync(${S(CONFIG_FILE)})) {
  fs.mkdirSync('config', { recursive: true });
  fs.copyFileSync(config, ${S(CONFIG_FILE)});
  fs.mkdirSync(path.dirname(${S(NETHER26)}), { recursive: true });
  fs.copyFileSync(world, ${S(NETHER26)});
}
console.log('Done (0.1s)! For help, type "help"');
process.stdin.on('data', (d) => { if (/stop/.test(String(d))) process.exit(0); });
`);
write(path.join(work, 'config.yml'), CONFIG);
write(path.join(work, 'world.yml'), WORLD);
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');

const CLOSED = 'http://127.0.0.1:1';
// PYIDE_CRAFT_HOME: without it a craft window opens the user's own ~/Nano Studio Craft, whatever projectDir says.
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, modrinth: CLOSED }) };

const t = await launch({ name: 'minecraft-antixray-ui', port: 9995, lang: 'ko', mode: 'craft', projectDir: project, env });
const { js, until, check, shot, cdp, sleep, userData } = t;

const tab = `document.querySelector('.custom-tab.mcset:not(.hidden)')`;
const q = (sel) => `${tab}?.querySelector(${S(sel)})`;
const lastDialog = `[...document.querySelectorAll('.dialog')].at(-1)`;
const dialogButton = (label) => `[...(${lastDialog}?.querySelectorAll('.dialog-buttons button') ?? [])].find((b) => b.textContent === ${S(label)})`;
const radio = (level) => q(`.mcset-xray-level:has(input[value="${level}"])`);
const pressAt = async (expr) => {
  const spot = await js(`(() => {
    const n = ${expr};
    if (!n) return null;
    n.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = n.getBoundingClientRect();
    const x = r.x + Math.min(r.width / 2, 40);
    const y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (n === hit || n.contains(hit)), under: hit ? String(hit.className || hit.tagName) : 'nothing', off: !!n.disabled };
  })()`);
  if (!spot) throw new Error(`nothing to press: ${expr}`);
  if (!spot.hit) throw new Error(`${spot.under} covers ${expr}`);
  if (spot.off) throw new Error(`disabled: ${expr}`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, button: 'none', buttons: 0 });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(40);
};
const openTab = async (name) => {
  await js(`(async () => { await ide.minecraft.refresh(); ide.minecraft.settings.open(ide.minecraft.servers().find((s) => s.name === ${S(name)})); return true; })()`);
  await until(`ide.activeTab()?.path.endsWith(${S(name)}) && !!${q('.mcset-section')}`, `${name} tab`, 10000);
};
const saveAndWait = async () => {
  await pressAt(q('.mcset-save'));
  await until(`${q('.mcset-status')}?.textContent === ${S(K('Saved.'))}`, 'saved', 10000)
    .catch(async (e) => { console.log(await js(`${q('.mcset-status')}?.textContent`)); throw e; });
};
const textOf = (sel) => js(`${q(sel)}?.textContent ?? ''`);
const dialogText = () => js(`${lastDialog}?.textContent ?? ''`);
const rowsOf = () => js(`Object.fromEntries([...(${lastDialog}?.querySelectorAll('.mcset-xray-server') ?? [])].map((r) => [r.dataset.server, r.textContent]))`);
const noteFor = (title) => js(`(() => { const n = ide.notifications.list().findLast((e) => e.title === ${S(title)}); return n ? { text: n.text, kind: n.kind, actions: n.actions.map((a) => a.label) } : null; })()`);
const settingsFile = () => JSON.parse(read(path.join(userData, 'settings.json')));
const startStandIn = (name) => js(`(async () => {
  const id = await ide.api.invoke('minecraft:start', ide.root, ${S({ cmd: process.execPath, args: [standIn, path.join(work, 'config.yml'), path.join(work, 'world.yml')], cwd: serverDir(name) })});
  ide.proc.attach(id, { exit: () => { (window.__exited ??= []).push(id); } });
  return id;
})()`);

// Text a person reads in the section that is still in English, apart from names that stay as they are.
const englishIn = () => js(`(() => {
  const found = [];
  const walk = document.createTreeWalker(${q('section[data-section="antixray"]')}, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const text = walk.currentNode.textContent.replace(/config\\/paper-world-defaults\\.yml|\\.nano-backup|paper\\.yml|Paper|Purpur|Market|CPU|FPS|Fabric/g, '');
    if (/[A-Za-z]{3,}/.test(text)) found.push(walk.currentNode.textContent);
  }
  return found;
})()`);

try {
  await js(`ide.minecraft.refresh()`);
  if (!samePath(await js('ide.root'), project)) throw new Error('the window is not on the test project');
  await js(`(() => {
    window.__running = new Set();
    window.__restarted = [];
    window.__started = [];
    const m = ide.minecraft;
    m.runningAt = (dir) => window.__running.has(dir.toLowerCase());
    m.restartIfRunning = async (dir) => { window.__restarted.push(dir); };
    m.startServer = async (srv) => { window.__started.push(srv.dir); };
    return true;
  })()`);

  // Several plugins translate Restart and the last one loaded wins, so the window says which it is.
  const restartLabel = await js(`tr('Restart')`);
  check(/[가-힣]/.test(restartLabel), `Restart is in Korean (${restartLabel})`);

  await openTab('survival');
  check(await js(`[...${tab}.querySelectorAll('.mcset-page')].some((p) => p.dataset.section === 'antixray')`), 'the section is listed with the others');
  check((await js(`${q('section[data-section="antixray"]')}.querySelectorAll('.mcset-xray-level').length`)) === 4, 'the section holds the levels');
  const intro = await textOf('section[data-section="antixray"] .mcset-note');
  check(/숨길 뿐/.test(intro) && /잡아내지는 않아요/.test(intro) && /다시 시작/.test(intro), `it says it hides data, catches nobody and needs a restart (${intro})`);
  const levels = await js(`[...${tab}.querySelectorAll('.mcset-xray-level input')].map((n) => n.value).join()`);
  check(levels === 'off,basic,strong,layers', `26.3 offers Off, Basic, Strong and mode 3 (${levels})`);
  check(await js(`${q('.mcset-xray-level input[value="off"]')}.checked`), 'the file says Off, and so does the tab');
  check(/강력/.test(await textOf('.mcset-xray-levels')) && /CPU/.test(await textOf('.mcset-xray-levels')) && /네트워크/.test(await textOf('.mcset-xray-levels')), 'the tradeoff is in plain Korean');
  check((await englishIn()).length === 0, `no English left in the section (${S(await englishIn())})`);
  await js(`(() => { const s = ${q('.mcset-search')}; s.value = '엑스레이'; s.dispatchEvent(new Event('input')); return true; })()`);
  const found = await js(`[...${tab}.querySelectorAll('.mcset-row:not(.hidden)')].map((r) => r.dataset.key)`);
  check(S(found) === S(['$antixray', '$antixrayNew', '$antixrayOthers']), `the search finds it by 엑스레이 (${S(found)})`);
  await js(`(() => { const s = ${q('.mcset-search')}; s.value = '광물'; s.dispatchEvent(new Event('input')); return true; })()`);
  check((await js(`[...${tab}.querySelectorAll('.mcset-row:not(.hidden)')].map((r) => r.dataset.key)`)).includes('$antixray'), 'and by 광물');
  await js(`(() => { const s = ${q('.mcset-search')}; s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);

  await pressAt(radio('basic'));
  check(await js(`${q('.mcset-row[data-key="$antixray"]')}.classList.contains('modified') && !${q('.mcset-save')}.disabled`), 'choosing a level waits for Save');
  check(read(inServer('survival', CONFIG_FILE)) === CONFIG, 'nothing is written before Save');
  await shot('ko-section.png');
  await saveAndWait();
  const saved = read(inServer('survival', CONFIG_FILE));
  check(/ {4}enabled: true\n {4}engine-mode: 1\n/.test(saved) && /^# This is the world defaults/.test(saved) && /chunks:\n {2}auto-save-interval: default\n$/.test(saved) && !/ {4}- clay\n/.test(saved) && / {4}- diamond_ore\n/.test(saved),
    'Save edits the block in the real file and keeps the rest');
  check(read(inServer('survival', `${CONFIG_FILE}.nano-backup`)) === CONFIG, 'the first write leaves a backup');
  check(/ancient_debris/.test(read(inServer('survival', NETHER26))) && /max-block-height: 128/.test(read(inServer('survival', NETHER26))) && /enabled: false/.test(read(inServer('survival', END26))), 'the Nether gets its own list and the End stays off');
  check(await js(`${q('.mcset-xray-level input[value="basic"]')}.checked && ${q('.mcset-save')}.disabled && !${q('.mcset-row.modified')}`), 'after Save the tab shows the file\'s level with nothing to save');
  check((await textOf('.mcset-xray-worlds')) === `${K('Overworld')}: ${K('Basic')} · ${K('Nether')}: ${K('Basic')} · ${K('End')}: ${K('Off')}`, `each dimension's level is shown (${await textOf('.mcset-xray-worlds')})`);

  await js(`(window.__running.add(${S(serverDir('survival').toLowerCase())}), true)`);
  await pressAt(radio('strong'));
  await saveAndWait();
  check(/ {4}engine-mode: 2\n/.test(read(inServer('survival', CONFIG_FILE))) && / {4}- tuff\n/.test(read(inServer('survival', CONFIG_FILE))), 'Strong is saved on a running server');
  const title = K('Settings of {name} saved', { name: 'survival' });
  await until(`ide.notifications.list().some((e) => e.title === ${S(title)})`, 'saved note', 5000);
  check((await noteFor(title)).actions.includes(restartLabel), 'a running server is offered Restart, as the rest of the tab does');
  await pressAt(`[...document.querySelectorAll('.ide-balloon')].find((b) => b.textContent.includes(${S(title)}))?.querySelector('.ide-balloon-actions button, .ide-balloon-actions a')`);
  await until(`window.__restarted.length === 1`, 'restart pressed', 5000);
  check(samePath(await js('window.__restarted[0]'), serverDir('survival')), 'and Restart restarts that server');
  await js(`(window.__running.clear(), document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);

  const good = read(inServer('survival', CONFIG_FILE));
  await pressAt(radio('layers'));
  write(inServer('survival', CONFIG_FILE), '_version: 31\nchunks:\n  a: 1\n');
  await pressAt(q('.mcset-save'));
  await until(`${q('.mcset-status')}?.classList.contains('mcset-error')`, 'refused save', 10000);
  const why = await textOf('.mcset-status');
  check(why === K('{file} has no anticheat: anti-xray: block, so it was left as it is. Starting the server once may write it again.', { file: 'config/paper-world-defaults.yml' }), `a file of the wrong shape is refused in Korean (${why})`);
  check(read(inServer('survival', CONFIG_FILE)) === '_version: 31\nchunks:\n  a: 1\n' && !existsSync(`${inServer('survival', CONFIG_FILE)}.nano-tmp`), 'and left as it was');
  write(inServer('survival', CONFIG_FILE), good);

  const props = read(inServer('survival', 'server.properties'));
  const serverJson = read(inServer('survival', 'pyide-server.json'));
  const blocked = `${inServer('survival', CONFIG_FILE)}.nano-tmp`;
  mkdirSync(blocked);
  await js(`(() => { const i = ${q('[data-prop="max-players"]')}; i.value = '77'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await pressAt(q('.mcset-save'));
  await until(`${q('.mcset-status')}?.textContent === ${S(K('The anti-xray files could not be written, so nothing was changed. Close whatever has them open, then try again.'))}`, 'the commit refused', 10000)
    .catch(async (e) => { console.log(await textOf('.mcset-status')); throw e; });
  check(read(inServer('survival', 'server.properties')) === props, 'a commit that fails leaves server.properties as it was');
  check(read(inServer('survival', 'pyide-server.json')) === serverJson && read(inServer('survival', CONFIG_FILE)) === good, 'and the other files too');
  rmSync(blocked, { recursive: true });
  await saveAndWait();
  check(/^max-players=77$/m.test(read(inServer('survival', 'server.properties'))) && / {4}engine-mode: 3\n/.test(read(inServer('survival', CONFIG_FILE))), 'the same Save goes through once the file is free');
  await js(`(${q('.mcset-revert')}.click(), true)`);
  await js(`(ide.closeTab(ide.minecraft.settings.tabId(${S(serverDir('survival'))}), true), true)`);

  write(inServer('survival', CONFIG_FILE), good.replace('    engine-mode: 2\n', '    engine-mode: 1\n'));
  await openTab('survival');
  check(await js(`!!${q('.mcset-xray-custom')} && !${q('.mcset-xray-level input:checked')} && ${q('.mcset-xray-others')}.disabled && ${q('.mcset-save')}.disabled`), 'a block changed by hand shows as custom, picks no level and offers nothing to spread');
  await pressAt(radio('basic'));
  await saveAndWait();
  check(!(await js(`!!${q('.mcset-xray-custom')}`)), 'choosing a level takes it back to a level');

  check(!(await js(`${q('[data-prop="$antixrayNew"]')}.checked`)), 'new servers start with nothing');
  check((await textOf('.mcset-xray-now')) === K('Now: {level}', { level: K('Off') }), 'and the tab says so');
  await pressAt(q('.mcset-row[data-key="$antixrayNew"] .mcset-switch'));
  check((await textOf('.mcset-xray-now')) === K('Now: {level}', { level: K('Basic') }), 'ticking the box shows the level it will keep');
  await saveAndWait();
  await js(`(ide.settings.flush(), true)`);
  check(settingsFile()['minecraft.antiXrayDefault'] === 'basic', 'Save stores the level as the app\'s default, in settings.json');
  check(await js(`${q('[data-prop="$antixrayNew"]')}.checked`), 'and the box stays ticked');

  await openTab('lobby');
  check((await js(`[...${tab}.querySelectorAll('.mcset-xray-level input')].map((n) => n.value).join()`)) === 'off,basic,strong', '1.21.1 is not offered mode 3');
  await js(`(() => { const i = ${q('[data-prop="motd"]')}; i.value = 'renamed'; i.dispatchEvent(new Event('input')); return true; })()`);
  await saveAndWait();
  await js(`(ide.settings.flush(), true)`);
  check(settingsFile()['minecraft.antiXrayDefault'] === 'basic' && read(inServer('lobby', CONFIG_FILE)) === CONFIG, 'another server\'s Save leaves the default and its own file alone');
  await pressAt(q('.mcset-row[data-key="$antixrayNew"] .mcset-switch'));
  await saveAndWait();
  await js(`(ide.settings.flush(), true)`);
  check(settingsFile()['minecraft.antiXrayDefault'] === 'off', 'unticking the box clears the default');

  await openTab('newbie');
  const reason = await textOf('.mcset-xray-reason');
  const waits = await textOf('.mcset-xray-pending');
  check(/config\/paper-world-defaults\.yml/.test(reason) && await js(`!${q('.mcset-xray-level')} && !${q('[data-key="$antixrayNew"]')} && !${q('[data-key="$antixrayOthers"]')}`), `a server that never started shows the section off, with the reason (${reason})`);
  check(waits === K('Level {level} goes in by itself after the first start. Start the server once more after that to turn it on.', { level: K('Strong') }), `and the level that waits (${waits})`);
  await shot('ko-not-started.png');
  await js(`ide.api.invoke('minecraft:launch', ide.root, ${S(serverDir('newbie'))}, 'test')`);
  check(descOf('newbie').antiXrayPending === 'strong' && !existsSync(inServer('newbie', CONFIG_FILE)), 'the start before the file exists leaves the level waiting');

  const id = await startStandIn('newbie');
  for (let waited = 0; waited < 10000 && !existsSync(inServer('newbie', NETHER26)); waited += 50) await sleep(50);
  await sleep(500);
  check(existsSync(inServer('newbie', CONFIG_FILE)) && read(inServer('newbie', CONFIG_FILE)) === CONFIG, 'the first run wrote the config and nothing touched it during the run');
  check(descOf('newbie').antiXrayPending === 'strong', 'the level still waits while the server runs');
  await js(`(ide.proc.input(${id}, 'stop\\n'), true)`);
  await until(`(window.__exited ?? []).includes(${id})`, 'first run ended', 10000);
  const set = K('Anti-xray is set on {name}', { name: 'newbie' });
  await until(`ide.notifications.list().some((e) => e.title === ${S(set)})`, 'set note', 10000);
  const setNote = await noteFor(set);
  check(setNote.text === K('The first start wrote the settings file, and level {level} is in it now. The server only reads it when it starts, so a restart finishes this.', { level: K('Strong') }) && setNote.actions.includes(restartLabel),
    `after the first run the owner is told a restart finishes it (${setNote.text})`);
  check(/ {4}engine-mode: 2\n/.test(read(inServer('newbie', CONFIG_FILE))) && /ancient_debris/.test(read(inServer('newbie', NETHER26))) && existsSync(inServer('newbie', END26)), 'the level is in the files, with no step by the owner');
  check(!('antiXrayPending' in descOf('newbie')) && descOf('newbie').kind === 'paper' && descOf('newbie').memory === '1G', 'pyide-server.json no longer has it, and keeps the rest');
  await until(`!${q('.mcset-xray-reason')} && ${q('.mcset-xray-level input[value="strong"]')}?.checked`, 'the open tab follows', 5000);
  check(true, 'the open tab shows the level');
  await pressAt(`[...document.querySelectorAll('.ide-balloon')].find((b) => b.textContent.includes(${S(set)}))?.querySelector('.ide-balloon-actions button, .ide-balloon-actions a')`);
  await until(`window.__started.length === 1`, 'start pressed', 5000);
  check(samePath(await js('window.__started[0]'), serverDir('newbie')), 'its Restart starts the stopped server');
  await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);

  await js(`ide.api.invoke('minecraft:launch', ide.root, ${S(serverDir('waiter'))}, 'test')`);
  const fromThis = K('Anti-xray is set on {name}', { name: 'waiter' });
  await until(`ide.notifications.list().some((e) => e.title === ${S(fromThis)})`, 'set at start', 5000);
  check((await noteFor(fromThis)).text === K('Level {level} applies from this start.', { level: K('Basic') }) && (await noteFor(fromThis)).actions.length === 0 && /engine-mode: 1/.test(read(inServer('waiter', CONFIG_FILE))) && /enabled: true/.test(read(inServer('waiter', CONFIG_FILE))) && !('antiXrayPending' in descOf('waiter')),
    'a level waiting when the file already exists goes in at the next start, which reads it, so no restart is asked for');
  const startsAgain = read(inServer('waiter', CONFIG_FILE));
  await js(`ide.api.invoke('minecraft:launch', ide.root, ${S(serverDir('waiter'))}, 'test')`);
  check(read(inServer('waiter', CONFIG_FILE)) === startsAgain, 'the next start finds nothing to do');
  await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);

  write(inServer('broken', 'pyide-server.json'), desc('paper', '26.3', { antiXrayPending: 'basic' }));
  await js(`ide.api.invoke('minecraft:launch', ide.root, ${S(serverDir('broken'))}, 'test')`);
  const notSet = K('Anti-xray was not set on {name}', { name: 'broken' });
  await until(`ide.notifications.list().some((e) => e.title === ${S(notSet)})`, 'refused note', 5000);
  check((await noteFor(notSet)).text.includes('config/paper-world-defaults.yml') && descOf('broken').antiXrayPending === 'basic' && read(inServer('broken', CONFIG_FILE)) === '_version: 31\nchunks:\n  a: 1\n',
    'a waiting level that is refused tells the owner, keeps waiting and leaves the file');
  write(inServer('broken', 'pyide-server.json'), desc('paper', '26.3'));
  await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);

  await openTab('broken');
  check((await textOf('.mcset-xray-reason')).includes('config/paper-world-defaults.yml') && await js(`!${q('.mcset-xray-level')}`), 'a file of the wrong shape turns the section off and says why');
  await openTab('legacy');
  check((await textOf('.mcset-xray-reason')) === K('This version keeps the setting in paper.yml, which this tab does not edit. Paper and Purpur 1.19 and later can use it here.'), 'Paper before 1.19 says why not');
  await openTab('plain');
  check((await textOf('.mcset-xray-reason')) === K('Vanilla has no anti-xray of its own. It is built into Paper and Purpur.') && await js(`!${q('.mcset-xray-level')}`), 'Vanilla says it has none');
  await openTab('modded');
  const modded = await textOf('.mcset-xray-reason');
  check(/Fabric/.test(modded) && /Market/.test(modded) && !/orebfuscator|xray-?plus/i.test(modded), `a mod loader says it has no built-in protection and names no mod (${modded})`);
  await js(`(${q('section[data-section="antixray"]')}.scrollIntoView({ block: 'center' }), true)`);
  await sleep(200);
  await shot('ko-modded.png');
  await pressAt(q('.mcset-xray-market'));
  await until(`ide.minecraft.market.state().query === 'anti-xray'`, 'market search', 5000);
  check(await js(`ide.minecraft.market.state().type === 'mod' && ide.minecraft.market.state().server.toLowerCase() === ${S(serverDir('modded').toLowerCase())} && !ide.findTab(ide.minecraft.settings.tabId(${S(serverDir('modded'))}))`), 'its button searches the Market for anti-xray on that server, and leaves the tab');
  const covered = K('Close the other tabs to see the Market.');
  await until(`ide.notifications.list().some((e) => e.title === ${S(covered)})`, 'covered note', 5000);
  check(true, 'other open tabs still cover the Market in Craft, and the owner is told');
  await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), [...ide.tabs].forEach((x) => ide.closeTab(x.path, true)), true)`);
  await until(`!document.body.classList.contains('mc-craft-tab')`, 'tabs closed', 5000);
  await sleep(300);
  const seen = await js(`(() => { const n = document.querySelector('#craftHost .mcm'); if (!n) return 'no market'; const r = n.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 40); return n.contains(hit) ? 'seen' : String(hit?.className || hit?.tagName); })()`);
  check(seen === 'seen', `with no tab left the Market is on screen (${seen})`);
  await shot('ko-market.png');
  await openTab('modded');
  await js(`(() => { const i = ${q('[data-prop="motd"]')}; i.value = 'edited'; i.dispatchEvent(new Event('input')); return true; })()`);
  await pressAt(q('.mcset-xray-market'));
  await until(`!!${dialogButton(K('Cancel'))}`, 'unsaved question', 5000);
  await pressAt(dialogButton(K('Cancel')));
  check(await js(`!!ide.findTab(ide.minecraft.settings.tabId(${S(serverDir('modded'))}))`), 'unsaved changes are asked about, and Cancel keeps the tab');
  await js(`(ide.closeTab(ide.minecraft.settings.tabId(${S(serverDir('modded'))}), true), ide.minecraft.settings.open(ide.minecraft.servers().find((s) => s.name === 'proxy')), true)`);
  await until(`ide.activeTab()?.path.endsWith('proxy') && !!${q('.mcset-section')}`, 'proxy tab', 10000);
  check(await js(`!${q('[data-section="antixray"]')} && ![...${tab}.querySelectorAll('.mcset-page')].some((p) => p.dataset.section === 'antixray')`), 'a proxy has no section');

  await openTab('survival');
  await js(`(window.__running.add(${S(serverDir('busy').toLowerCase())}), true)`);
  await pressAt(q('.mcset-xray-others'));
  await until(`!!${lastDialog}?.querySelector('.mcset-xray-list')`, 'the list', 5000);
  let rows = await rowsOf();
  check(S(Object.keys(rows).sort()) === S(['broken', 'busy', 'fresh', 'legacy', 'lobby', 'modded', 'newbie', 'plain', 'waiter']), `the list has the project's other servers and no proxy (${Object.keys(rows)})`);
  check(rows.busy.includes(K('Running: it needs a restart afterwards.')) && rows.lobby.includes(K('Stopped: it starts with this level next time.')) && rows.fresh.includes(K('Not started yet: the level goes in by itself after its first start.')),
    'each server says what will happen to it');
  check(rows.plain.includes(K('Vanilla has no anti-xray of its own. It is built into Paper and Purpur.')) && /Fabric/.test(rows.modded) && rows.legacy.includes('paper.yml') && rows.broken.includes('config/paper-world-defaults.yml'), 'and a server it cannot reach says why');
  await shot('ko-others-list.png');
  await pressAt(dialogButton(K('Cancel')));
  await until(`!document.querySelector('.mcset-xray-list')`, 'cancelled', 5000);
  check(read(inServer('busy', CONFIG_FILE)) === CONFIG && !('antiXrayPending' in descOf('fresh')), 'Cancel changes nothing');

  await pressAt(q('.mcset-xray-others'));
  await until(`!!${lastDialog}?.querySelector('.mcset-xray-list')`, 'the list again', 5000);
  await pressAt(dialogButton(K('Apply')));
  await until(`!!${lastDialog}?.querySelector('.mcset-xray-restart')`, 'the report', 10000);
  rows = await rowsOf();
  await shot('ko-others-result.png');
  check(rows.busy.includes(K('Done. It is running, so restart it to apply the level.')) && /enabled: true/.test(read(inServer('busy', CONFIG_FILE))) && /ancient_debris/.test(read(inServer('busy', NETHER26))), 'a running server is set and reminded to restart');
  check(rows.lobby.includes(K('Done. It starts with this level next time.')) && /enabled: true/.test(read(inServer('lobby', CONFIG_FILE))) && /ancient_debris/.test(read(inServer('lobby', 'world_nether', 'paper-world.yml'))), 'a stopped Purpur 1.21 server is set, in its older folders');
  check(rows.fresh.includes(K('Not started yet: the level goes in by itself after its first start.')) && descOf('fresh').antiXrayPending === 'basic' && !existsSync(inServer('fresh', CONFIG_FILE)), 'a server that never started keeps the level waiting');
  check(rows.waiter.includes(K('It was at this level already.')), 'a server at that level says so');
  check(rows.broken.includes('config/paper-world-defaults.yml'), 'a refused server is reported with its reason');
  check(rows.plain.includes(K('Vanilla has no anti-xray of its own. It is built into Paper and Purpur.')) && /Fabric/.test(rows.modded) && !existsSync(inServer('plain', 'config')) && !existsSync(inServer('modded', 'config')), 'other kinds stay as they are, with their reason');
  check(!existsSync(inServer('proxy', 'config')) && !('proxy' in rows), 'a proxy is not touched');
  await pressAt(`${lastDialog}.querySelector('.mcset-xray-restart')`);
  await until(`window.__restarted.length === 2`, 'restart from the report', 5000);
  check(samePath(await js('window.__restarted.at(-1)'), serverDir('busy')), 'the report\'s Restart restarts that server');
  await pressAt(dialogButton(K('Close')));
  await js(`(window.__running.clear(), true)`);

  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 640, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await pressAt(radio('off'));
  check(await js(`${q('.mcset-xray-level input[value="off"]')}.checked`), 'the levels can be pressed at 900 px');
  check(await js(`${tab}.scrollWidth <= ${tab}.clientWidth + 1`), 'nothing runs off the side at 900 px');
  await shot('ko-900.png');
  await cdp('Emulation.clearDeviceMetricsOverride');
} catch (err) {
  console.log(`failed: ${err.stack}`);
  await shot('failure.png').catch(() => {});
  check(false, err.message);
}
t.finish();
