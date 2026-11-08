// Small Craft fixes in one Korean-free craft window, against stand-ins: a local web server plays PaperMC (slow),
// Velocity (fast), Purpur (down) and Modrinth (no hits); a Node script plays the server (prints Done, answers commands,
// takes 1.5 s to save after "stop"); minecraft:launch answers from main after a delay, and the page swaps its command for
// that script, so the real run type, minecraft:start, the card and the Run console do the rest. No real server, game,
// launcher, EULA or network. Every press goes through Input.dispatchMouseEvent at a spot elementFromPoint says is the
// control.
// Checks: New Server suggests a free name, Velocity's name and port go back with the type, a version list's error is
// cleared and a late answer does not land under another type; the Market searches again after an error once a
// modded server exists; the card says Starting… and Stopping… with nothing to press; the Run console's Up and Down
// walk the typed commands, also after a restart; an operator's level box follows the server starting and stopping;
// settings search says when nothing matches and Escape clears it; anti-xray's files go back when server.properties
// cannot be written; a start takes the port server.properties has now, not the one the list read before; a server whose
// pyide-server.json is damaged keeps a card with the reason, Open Folder and, while it runs, Stop, and its name; of
// several modpacks dropped at once the others are said in the import log. Port 9737; the server listens on 25681.
// Usage: node verify/craft-polish.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-craft-polish-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (p) => readFileSync(p, 'utf8');
const serverDir = (name) => path.join(project, 'servers', name);
const inServer = (name, ...rest) => path.join(serverDir(name), ...rest);
const desc = (kind, mc) => S({ kind, mc, loader: null, build: 1, java: 21, memory: '1G', launch: { jar: 'server.jar' }, mdk: null });

const CONFIG = `# This is the world defaults configuration file for Paper.

_version: 31
anticheat:
  anti-xray:
    enabled: false
    engine-mode: 1
    hidden-blocks:
    - copper_ore
    lava-obscures: false
    max-block-height: 64
    replacement-blocks:
    - stone
    update-radius: 2
    use-permission: false
`;
const CONFIG_FILE = path.join('config', 'paper-world-defaults.yml');
const NETHER26 = path.join('world', 'dimensions', 'minecraft', 'the_nether', 'paper-world.yml');
const STEVE = '8667ba71-b85a-4004-af54-457a9734eed7';
write(inServer('survival', 'pyide-server.json'), desc('paper', '26.3'));
write(inServer('survival', 'server.properties'), 'server-port=25681\nmotd=survival\n');
write(inServer('survival', 'ops.json'), S([{ uuid: STEVE, name: 'Steve', level: 2, bypassesPlayerLimit: false }]));
write(inServer('locked', 'pyide-server.json'), desc('paper', '26.3'));
write(inServer('locked', 'server.properties'), 'server-port=25682\nmotd=locked\n');
write(inServer('locked', CONFIG_FILE), CONFIG);
write(inServer('locked', NETHER26), '# This is a world configuration file for Paper.\n\n_version: 31\n');

const standIn = path.join(work, 'stand-in.cjs');
write(standIn, `console.log('Done (0.1s)! For help, type "help"');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'stop') { console.log('Stopping the server'); setTimeout(() => process.exit(0), 1500); }
    else if (line) console.log('Unknown command: ' + line);
  }
});
setInterval(() => {}, 1000);
`);
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');

// PaperMC answers after 1.2 s, Velocity at once, Purpur not at all, Modrinth with no hits.
const asked = [];
const web = http.createServer((req, res) => {
  asked.push(req.url);
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(S(o)); };
  if (req.url.startsWith('/paper')) setTimeout(() => json({ versions: { '1.21': ['1.21.1', '1.21.4'] } }), 1200);
  else if (req.url.startsWith('/velocity')) json({ versions: { 3: ['3.4.0'] } });
  else if (req.url.startsWith('/modrinth/search')) json({ hits: [], total_hits: 0, offset: 0, limit: 20 });
  else { res.writeHead(500); res.end('down'); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}`;
const CLOSED = 'http://127.0.0.1:1';
// PYIDE_CRAFT_HOME: without it a craft window opens the user's own ~/Nano Studio Craft, whatever projectDir says.
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, paper: `${base}/paper`, velocity: `${base}/velocity`, purpur: `${base}/purpur`, modrinth: `${base}/modrinth` }) };

const { writeZip } = createRequire(import.meta.url)('../main/minecraft/zipfile.js');
const t = await launch({ name: 'craft-polish', port: 9737, mode: 'craft', projectDir: project, env });
const { js, until, check, shot, cdp, sleep, type, press } = t;

const lastDialog = `[...document.querySelectorAll('.dialog')].at(-1)`;
const card = (name) => `document.querySelector('#minecraftScreen .mc-server[data-name="${name}"]')`;
const tab = `document.querySelector('.custom-tab.mcset:not(.hidden)')`;
const inTab = (sel) => `${tab}?.querySelector(${S(sel)})`;
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
// What a person sees of an element: it is drawn, and the spot at its middle is it.
const seen = (expr) => js(`(() => { const n = ${expr}; if (!n || !n.getClientRects().length) return false; const r = n.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && (hit === n || n.contains(hit)); })()`);
const choose = (id, value) => js(`(() => { const s = document.getElementById(${S(id)}); s.value = ${S(value)}; s.dispatchEvent(new Event('change')); return true; })()`);
const valueOf = (id) => js(`document.getElementById(${S(id)})?.value`);
const versionsShown = () => js(`[...document.getElementById('mcVersion').options].map((o) => o.value).join()`);
const dialogError = () => js(`${lastDialog}?.querySelector('.mc-dialog-error')?.textContent ?? null`);
const toCards = () => js(`(ide.tabs.slice().forEach((x) => ide.closeTabObject(x, true)), ide.minecraft.screen.show('servers'), true)`);
const sessionOf = (name) => `ide.run.sessions().find((s) => s.cfg?.type === 'minecraft-server' && s.cfg.dir === 'servers/${name}')`;

try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 15000);
  if (path.resolve(await js('ide.root')).toLowerCase() !== path.resolve(project).toLowerCase()) throw new Error('the window is not on the test project');
  await js('ide.minecraft.refresh()');
  await toCards();
  await until(`!!${card('survival')}?.offsetParent`, 'the survival card', 10000);

  // ---------- New Server: a free name, the proxy's suggestions and the version lists ----------
  await pressAt(`document.querySelector('.mcs-new-server')`);
  await until(`!!document.getElementById('mcName')`, 'the New Server dialog', 10000);
  check(await valueOf('mcName') === 'survival-2', `with a survival server already there, New Server suggests survival-2 (${await valueOf('mcName')})`);
  // Paper's list (1.2 s) is still on its way when Velocity is chosen: only Velocity's may fill the box.
  await choose('mcKind', 'velocity');
  check(await valueOf('mcName') === 'proxy' && await valueOf('mcPort') === '25577', 'Velocity suggests proxy on 25577');
  await until(`document.getElementById('mcVersion').value === '3.4.0'`, 'Velocity\'s versions', 10000);
  await sleep(1800);
  check(await versionsShown() === '3.4.0', `Paper's late answer does not land under Velocity (${await versionsShown()})`);
  await choose('mcKind', 'paper');
  check(await valueOf('mcName') === 'survival-2' && await valueOf('mcPort') === '25565', `back from Velocity the name and port are a server's again (${await valueOf('mcName')}:${await valueOf('mcPort')})`);
  await until(`document.getElementById('mcVersion').value === '1.21.4'`, 'Paper\'s versions', 10000);
  await choose('mcKind', 'purpur');
  await until(`!document.getElementById('mcVersion').disabled`, 'Purpur answered', 15000);
  const down = await dialogError();
  check(!!down, `a list that cannot be read says why (${down})`);
  await choose('mcKind', 'paper');
  check(await dialogError() === '', 'choosing another type takes the old error away at once');
  await until(`document.getElementById('mcVersion').value === '1.21.4'`, 'Paper\'s versions again', 10000);
  const good = { error: await dialogError(), list: await versionsShown() };
  check(good.error === '' && good.list.split(',').sort().join() === '1.21.1,1.21.4', `and the good list has no error under it (${S(good)})`);
  await shot('new-server.png');
  await press('Escape');
  await until(`!document.getElementById('mcName')`, 'the dialog closed', 5000);

  // ---------- Market: an error until a modded server exists ----------
  await pressAt(`document.querySelector('.mcs-page[data-page="market"]')`);
  await pressAt(`document.querySelector('.mcm-tab[data-type="mod"]')`);
  await until(`/Fabric/.test(document.querySelector('.mcm-status')?.textContent)`, 'no modded server yet', 10000);
  write(inServer('modded', 'pyide-server.json'), desc('fabric', '1.21.1'));
  write(inServer('modded', 'server.properties'), 'server-port=25683\n');
  await js('ide.minecraft.refresh()');
  await pressAt(`document.querySelector('.mcs-page[data-page="servers"]')`);
  await pressAt(`document.querySelector('.mcs-page[data-page="market"]')`);
  await until(`document.querySelector('.mcm-status')?.textContent === 'Nothing found.'`, 'the Market searched again', 10000)
    .catch(() => {});
  const market = await js(`({ status: document.querySelector('.mcm-status')?.textContent, server: document.getElementById('mcmServer')?.value || '' })`);
  check(market.status === 'Nothing found.' && /modded$/i.test(market.server) && asked.some((u) => u.startsWith('/modrinth/search')),
    `back in the Market after making a modded server, it searches for it instead of keeping the old error (${S(market)})`);
  await pressAt(`document.querySelector('.mcs-page[data-page="servers"]')`);

  // ---------- the card while starting and stopping ----------
  await js(`(() => {
    const invoke = ide.api.invoke;
    window.__launchDelay = 1500;
    ide.api.invoke = (ch, ...a) => ch !== 'minecraft:launch' ? invoke(ch, ...a)
      : new Promise((r) => setTimeout(r, window.__launchDelay)).then(() => invoke(ch, ...a)).then((spec) => ({ ...spec, cmd: ${S(process.execPath)}, args: [${S(standIn)}] }));
    return true;
  })()`);
  await until(`!!${card('survival')}?.querySelector('.mc-start')`, 'Start on the card', 5000);
  await pressAt(`${card('survival')}.querySelector('.mc-start')`);
  await until(`!!${card('survival')}?.querySelector('.mc-starting')`, 'Starting on the card', 3000).catch(() => {});
  const starting = await js(`(() => { const b = ${card('survival')}.querySelector('.mc-starting'); return { off: !!b?.disabled, text: b?.textContent, start: !!${card('survival')}.querySelector('.mc-start') }; })()`);
  check(starting.off && starting.text === 'Starting…' && !starting.start, `while it starts the card says Starting… with nothing to press (${S(starting)})`);
  await until(`!!${card('survival')}?.querySelector('.mc-stop')`, 'Stop once it runs', 15000);
  check(true, 'once it runs the card has Stop');

  // ---------- a running server whose pyide-server.json breaks keeps its card and its Stop ----------
  const survivalDesc = read(inServer('survival', 'pyide-server.json'));
  write(inServer('survival', 'pyide-server.json'), '{ "kind": "paper", ');
  await js('ide.minecraft.refresh().then(() => true)');
  const broken = await js(`(() => { const c = ${card('survival')}; return c && { damaged: c.classList.contains('mc-damaged'), why: c.querySelector('.mc-damaged-why')?.textContent, stop: !!c.querySelector('.mc-stop'), folder: !!c.querySelector('.mc-folder'), start: !!c.querySelector('.mc-start') }; })()`);
  check(broken?.damaged && /cannot be read/.test(broken.why || '') && broken.stop && broken.folder && !broken.start && await seen(`${card('survival')}.querySelector('.mc-stop')`),
    `a running server whose pyide-server.json can no longer be read keeps a card saying so, with Stop and Open Folder (${S(broken)})`);
  await shot('damaged-running.png');
  write(inServer('survival', 'pyide-server.json'), survivalDesc);
  await js('ide.minecraft.refresh().then(() => true)');
  await until(`!!${card('survival')}?.querySelector('.mc-stop') && !${card('survival')}.classList.contains('mc-damaged')`, 'the survival card whole again', 5000);

  // ---------- the Run console's history ----------
  const consoleIn = `${sessionOf('survival')}.con.input`;
  await until(`${consoleIn} && !${consoleIn}.disabled && !!${consoleIn}.offsetParent`, 'the server console takes commands', 10000);
  await pressAt(consoleIn);
  for (const line of ['say hello', 'list']) { await type(line); await press('Enter'); }
  const walk = [];
  for (const key of ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown']) { await press(key); walk.push(await js(`${consoleIn}.value`)); }
  check(S(walk) === S(['list', 'say hello', 'say hello', 'list', '']), `Up and Down walk the commands typed, newest first, back to an empty line (${S(walk)})`);
  await type('half');
  await press('ArrowUp');
  await press('ArrowDown');
  check(await js(`${consoleIn}.value`) === 'half', 'what was being typed comes back after Up and Down');
  await js(`(() => { ${consoleIn}.value = ''; return true; })()`);
  await shot('console.png');

  // ---------- Stop: the card says Stopping… while the server saves ----------
  await toCards();
  await pressAt(`${card('survival')}.querySelector('.mc-stop')`);
  await until(`!!${card('survival')}?.querySelector('.mc-stopping')`, 'Stopping on the card', 3000).catch(() => {});
  const stopping = await js(`(() => { const b = ${card('survival')}.querySelector('.mc-stopping'); return { off: !!b?.disabled, text: b?.textContent, stop: !!${card('survival')}.querySelector('.mc-stop') }; })()`);
  check(stopping.off && stopping.text === 'Stopping…' && !stopping.stop, `while it saves the card says Stopping… with nothing to press (${S(stopping)})`);
  await until(`!!${card('survival')}?.querySelector('.mc-start')`, 'Start once it has stopped', 15000);
  check(true, 'once it has stopped the card has Start again');
  // A restart keeps the console's history: the Run tab is the same. Its server-port changed on disk since the list was
  // read: the start, its game port and the card follow the file.
  await js(`(window.__launchDelay = 100, true)`);
  write(inServer('survival', 'server.properties'), 'server-port=25684\nmotd=survival\n');
  await pressAt(`${card('survival')}.querySelector('.mc-start')`);
  await until(`!!${card('survival')}?.querySelector('.mc-stop')`, 'running again', 15000);
  const moved = await js(`({ games: ide.ports?.state().games || [], kind: ${card('survival')}.querySelector('.mc-server-kind')?.textContent || '' })`);
  check(moved.games.includes(25684) && /:25684$/.test(moved.kind), `a start after server-port changed on disk records the port the server binds, not the list's (${S(moved)})`);
  await until(`${consoleIn} && !${consoleIn}.disabled && !!${consoleIn}.offsetParent`, 'the console again', 10000);
  await pressAt(consoleIn);
  await press('ArrowUp');
  check(await js(`${consoleIn}.value`) === 'list', 'after a restart Up still brings back the last command');
  await js(`(() => { ${consoleIn}.value = ''; ${sessionOf('survival')}.stop(); return true; })()`);
  await until(`!${sessionOf('survival')}?.running && !!${card('survival')}?.querySelector('.mc-start')`, 'stopped again', 15000);
  write(inServer('survival', 'server.properties'), 'server-port=25681\nmotd=survival\n');
  await js('ide.minecraft.refresh().then(() => true)');

  // ---------- Settings: an operator's level box follows the server ----------
  await pressAt(`${card('survival')}.querySelector('.mc-settings')`);
  await until(`!!${inTab('.mcset-plevel')}`, 'the operator in the settings tab', 10000);
  check(!(await js(`${inTab('.mcset-plevel')}.disabled`)), 'with the server stopped the level box takes a change');
  await js(`(ide.minecraft.startServer(ide.minecraft.servers().find((s) => s.name === 'survival')), true)`);
  await until(`${inTab('.mcset-state')}?.textContent === 'Running'`, 'the tab says Running', 15000);
  const runningBox = await js(`({ off: ${inTab('.mcset-plevel')}.disabled, title: ${inTab('.mcset-plevel')}.title })`);
  check(runningBox.off && /Stop the server/.test(runningBox.title), `once the server runs, the open tab's level box is off and says why (${S(runningBox)})`);
  await js(`(${sessionOf('survival')}.stop(), true)`);
  await until(`${inTab('.mcset-state')}?.textContent === 'Stopped'`, 'the tab says Stopped', 15000);
  check(!(await js(`${inTab('.mcset-plevel')}.disabled`)), 'and once it has stopped the box takes a change again, without Reload');

  // ---------- Settings: search with no match, and Escape ----------
  await pressAt(inTab('.mcset-search'));
  await type('zzzq');
  const none = await js(`({ text: ${inTab('.mcset-noresult')}?.textContent ?? '', shown: !!${inTab('.mcset-noresult')}?.offsetParent, sections: [...${tab}.querySelectorAll('.mcset-section:not(.hidden)')].length })`);
  check(none.shown && none.text === 'No setting matches “zzzq”.' && none.sections === 0, `a search with no match says so (${S(none)})`);
  await shot('settings-noresult.png');
  await press('Escape');
  const back = await js(`({ value: ${inTab('.mcset-search')}.value, shown: !!${inTab('.mcset-noresult')}?.offsetParent, sections: [...${tab}.querySelectorAll('.mcset-section:not(.hidden)')].length, open: !!${tab} })`);
  check(back.value === '' && !back.shown && back.sections > 2 && back.open, `Escape clears the search and every section is back, the tab still open (${S(back)})`);

  // ---------- Settings: anti-xray goes back when server.properties cannot be written ----------
  await toCards();
  await pressAt(`${card('locked')}.querySelector('.mc-settings')`);
  await until(`!!${inTab('.mcset-xray-level')}`, 'anti-xray in the locked server\'s tab', 10000);
  await pressAt(inTab('.mcset-xray-level:has(input[value="basic"])'));
  await js(`(() => { const i = ${inTab('.mcset-motd-input')}; i.value = 'changed'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const props = read(inServer('locked', 'server.properties'));
  chmodSync(inServer('locked', 'server.properties'), 0o444);
  await pressAt(inTab('.mcset-save'));
  await until(`${inTab('.mcset-status')}?.classList.contains('mcset-error')`, 'the Save fails', 10000);
  chmodSync(inServer('locked', 'server.properties'), 0o666);
  const failed = await js(`${inTab('.mcset-status')}.textContent`);
  check(read(inServer('locked', CONFIG_FILE)) === CONFIG && read(inServer('locked', 'server.properties')) === props,
    `a Save whose server.properties cannot be written leaves anti-xray's file as it was too (${failed})`);
  check(!readdirSync(serverDir('locked')).some((n) => n.endsWith('.pyide-tmp')) && !existsSync(`${inServer('locked', CONFIG_FILE)}.pyide-tmp`), 'and leaves no temporary file');
  await pressAt(inTab('.mcset-save'));
  await until(`${inTab('.mcset-status')}?.textContent === 'Saved.'`, 'saved once it can be written', 10000);
  check(/motd=changed/.test(read(inServer('locked', 'server.properties'))) && /enabled: true/.test(read(inServer('locked', CONFIG_FILE))), 'the same Save works once the file can be written');

  // ---------- a server of a type Nano Studio does not know: its card, and its name ----------
  write(inServer('odd', 'pyide-server.json'), desc('spigot', '1.20.1'));
  await js('ide.minecraft.refresh().then(() => true)');
  await toCards();
  await until(`!!${card('odd')}`, 'the odd server\'s card', 5000);
  const odd = await js(`(() => { const c = ${card('odd')}; return { why: c.querySelector('.mc-damaged-why')?.textContent, chip: c.querySelector('.mc-damaged-chip')?.textContent, buttons: [...c.querySelectorAll('button')].map((b) => b.textContent) }; })()`);
  check(/server type Nano Studio does not know \(spigot\)/.test(odd.why || '') && odd.chip === 'Damaged' && S(odd.buttons) === S(['Open Folder']) && await seen(`${card('odd')}.querySelector('.mc-damaged-why')`),
    `a server whose pyide-server.json names an unknown type is listed as damaged with the reason and Open Folder (${S(odd)})`);
  await shot('damaged-dark.png');
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`ide.theme.current() === 'light'`, 'light theme', 10000);
  await shot('damaged-light.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await pressAt(`document.querySelector('.mcs-new-server')`);
  await until(`!!document.getElementById('mcName')`, 'the New Server dialog', 10000);
  // A Velocity proxy asks for no EULA, so the name is the first thing Create checks.
  await choose('mcKind', 'velocity');
  await until(`document.getElementById('mcVersion').value === '3.4.0'`, 'Velocity\'s versions in the dialog', 10000);
  await js(`(() => { const n = document.getElementById('mcName'); n.value = 'odd'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await pressAt(`[...${lastDialog}.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Create')`);
  const taken = await dialogError();
  check(taken === 'A server named odd already exists.', `the New Server dialog says a damaged server's name is a server's (${taken})`);
  await press('Escape');
  await until(`!document.getElementById('mcName')`, 'the dialog closed', 5000);

  // ---------- several modpacks dropped at once ----------
  const packs = ['One', 'Two', 'Three'].map((name) => {
    const p = path.join(work, 'drops', `${name}.mrpack`);
    write(p, writeZip([{ name: 'modrinth.index.json', data: Buffer.from(S({ formatVersion: 1, game: 'minecraft', versionId: '1', name, dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' }, files: [] })) }]));
    return p;
  });
  await js(`(document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), true)`);
  const box = await js(`(() => { const n = document.querySelector('#minecraftScreen'); const r = n.getBoundingClientRect(); const x = r.x + 20, y = r.y + 10; return { x, y, hit: n.contains(document.elementFromPoint(x, y)) }; })()`);
  if (!box.hit) throw new Error('the drop point is not on the Minecraft screen');
  for (const kind of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type: kind, x: box.x, y: box.y, data: { items: [], files: packs, dragOperationsMask: 1 } });
  const importLog = `(ide.run.sessions().find((s) => s.title === 'Minecraft: Import')?.host.textContent || '')`;
  await until(`/Three\.mrpack/.test(${importLog}) && !!document.getElementById('mcPackName')`, 'the import log and the modpack dialog', 15000).catch(() => {});
  const many = await js(`({ log: ${importLog}, dialog: document.getElementById('mcPackName')?.value ?? null })`);
  check(/Two\.mrpack: another modpack: a server is made from one modpack at a time/.test(many.log) && /Three\.mrpack: another modpack/.test(many.log) && !/One\.mrpack/.test(many.log) && many.dialog !== null,
    `of three modpacks dropped at once the first opens New Server from Modpack and the import log says why the others were skipped (${S(many)})`);
  await press('Escape');

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
  const internal = await js(`ide.api.invoke('diagnostics:errors')`);
  check(!internal.length, `no IDE internal errors${internal.length ? ` ${S(internal).slice(0, 1500)}` : ''}`);
} catch (err) {
  check(false, `craft-polish crashed: ${err.stack || err}`);
  await shot('crash.png').catch(() => {});
}
web.close();
await t.finish();
