// Craft's Backups tab in a Korean craft window, against stand-ins: a Node script plays the server (it prints Done,
// answers save-off, save-all flush and save-on with the game's lines and keeps writing its region file while saving is
// on; the page swaps the java command for it, so the real run type, minecraft:start and the Run console do the rest),
// and a local web server plays Modrinth's search. No real server, game, launcher, EULA or network. Presses go through
// Input.dispatchMouseEvent at a spot elementFromPoint says is the control.
// Checks: the card's Backups opens the tab; Back Up Now on a stopped server and on a running one (save-off, save-all
// flush and save-on in its console, a real fraction in the progress); Restore on a running server stops it first, puts
// the world and settings back, makes a "Before a restore" backup and the open settings tab shows the restored values;
// Restore the world only leaves the settings; a Market Update backs the server up first and Skip lets it go on at once;
// the schedule and retention fields are written to pyide-server.json; Delete asks first; nothing English in the tab;
// screenshots in both themes at 1024x720 and at 900 px wide. Port 9739; the servers listen on 25741-25742.
// Usage: node verify/minecraft-backups.mjs
import crypto from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-mc-backups-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const serverDir = (name) => path.join(project, 'servers', name);
const inServer = (name, ...rest) => path.join(serverDir(name), ...rest);
const zips = (name) => (existsSync(inServer(name, 'backups')) ? readdirSync(inServer(name, 'backups')).filter((n) => n.endsWith('.zip')) : []);

const SODIUM = 'AANobbMI';
write(inServer('survival', 'pyide-server.json'), S({ kind: 'paper', mc: '1.21.11', loader: null, build: 1, java: 21, memory: '2G', launch: { jar: 'server.jar' } }));
write(inServer('survival', 'server.properties'), 'server-port=25741\nmotd=before\nlevel-name=world\n');
write(inServer('survival', 'whitelist.json'), S([{ uuid: '8667ba71-b85a-4004-af54-457a9734eed7', name: 'Steve' }]));
write(inServer('survival', 'world', 'level.dat'), 'level v1');
write(inServer('survival', 'world', 'region', 'r.0.0.mca'), crypto.randomBytes(1 << 20));
write(inServer('survival', 'world', 'region', 'r.0.1.mca'), crypto.randomBytes(60 << 20));
write(inServer('survival', 'plugins', 'Essentials', 'config.yml'), 'essentials v1\n');
write(inServer('survival', 'plugins', 'Essentials.jar'), 'jar');
write(inServer('modded', 'pyide-server.json'), S({ kind: 'fabric', mc: '1.21.1', loader: '0.16.0', build: null, java: 21, memory: '2G', launch: { jar: 'server.jar' },
  market: { [SODIUM]: { type: 'mod', title: 'Sodium', version: '0.5.0', files: ['mods/sodium.jar'] } } }));
write(inServer('modded', 'server.properties'), 'server-port=25742\nlevel-name=world\n');
write(inServer('modded', 'world', 'level.dat'), 'modded level');
write(inServer('modded', 'mods', 'sodium.jar'), 'mod');

const standIn = path.join(work, 'stand-in.cjs');
write(standIn, `const fs = require('fs');
const log = (m) => console.log('[12:00:00] [Server thread/INFO]: ' + m);
let saving = true;
setInterval(() => { if (saving) fs.appendFileSync('world/region/r.0.0.mca', 'x'); }, 50);
log('Done (1.0s)! For help, type "help"');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    fs.appendFileSync('commands.log', line + '\\n');
    if (line === 'save-off') { saving = false; log('Automatic saving is now disabled'); }
    else if (line === 'save-all flush') { log('Saving the game (this may take a moment!)'); setTimeout(() => log('Saved the game'), 200); }
    else if (line === 'save-on') { saving = true; log('Automatic saving is now enabled'); }
    else if (line === 'stop') { log('Stopping the server'); setTimeout(() => process.exit(0), 300); }
    else if (line) log('Unknown or incomplete command, see below for error');
  }
});
`);
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');

const web = http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(S(o)); };
  if (req.url.startsWith('/modrinth/search')) {
    json({ hits: [{ project_id: SODIUM, slug: 'sodium', project_type: 'mod', title: 'Sodium', author: 'jellysquid3', description: 'A rendering engine', downloads: 1000, follows: 10, categories: ['optimization'], icon_url: '' }], total_hits: 1, offset: 0, limit: 20 });
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}`;
const CLOSED = 'http://127.0.0.1:1';
// PYIDE_CRAFT_HOME: without it a craft window opens the user's own ~/Nano Studio Craft, whatever projectDir says.
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, paper: `${CLOSED}/paper`, modrinth: `${base}/modrinth` }) };

const t = await launch({ name: 'minecraft-backups', port: 9739, mode: 'craft', lang: 'ko-KR', projectDir: project, env });
const { js, until, check, shot, cdp, sleep } = t;
const tr = (key, params) => js(`tr(${S(key)}, ${S(params || {})})`);
const card = (name) => `document.querySelector('#minecraftScreen .mc-server[data-name="${name}"]')`;
const tab = `document.querySelector('.custom-tab.mcbk:not(.hidden)')`;
const inTab = (sel) => `${tab}?.querySelector(${S(sel)})`;
const rows = () => js(`[...(${tab}?.querySelectorAll('.mcbk-item') || [])].map((r) => ({ name: r.dataset.name, text: r.innerText }))`);
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
const dialogButton = (label) => `[...([...document.querySelectorAll('.dialog')].at(-1)?.querySelectorAll('.dialog-buttons button') || [])].find((b) => b.textContent === ${S(label)})`;
const clearBalloons = () => js(`(document.querySelectorAll('.ide-balloon').forEach((b) => b.remove()), true)`);
const toCards = () => js(`(ide.tabs.slice().forEach((x) => ide.closeTabObject(x, true)), document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), ide.minecraft.screen.show('servers'), true)`);
const openBackups = async (name) => {
  await toCards();
  await until(`!!${card(name)}?.querySelector('.mc-backups')`, `the Backups button of ${name}`, 10000);
  await pressAt(`${card(name)}.querySelector('.mc-backups')`);
  await until(`!!${tab}?.querySelector('.mcbk-now') && !!${tab}.querySelector('.mcbk-summary').textContent`, 'the Backups tab', 10000);
};
const commands = () => read(inServer('survival', 'commands.log')).trim().split('\n').filter(Boolean);
const sessionOf = (name) => `ide.run.sessions().find((s) => s.cfg?.type === 'minecraft-server' && s.cfg.dir === 'servers/${name}')`;

try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 15000);
  if (path.resolve(await js('ide.root')).toLowerCase() !== path.resolve(project).toLowerCase()) throw new Error('the window is not on the test project');
  await js('ide.minecraft.refresh()');
  // The run type starts the stand-in in place of java.
  await js(`(() => {
    const invoke = ide.api.invoke;
    window.__installs = [];
    window.__deleted = [];
    ide.api.invoke = async (ch, ...a) => {
      if (ch === 'minecraft:launch') return { ...(await invoke(ch, ...a)), cmd: ${S(process.execPath)}, args: [${S(standIn)}] };
      // The Market's install itself is not under test here: what the backups folder holds when it is called is.
      if (ch === 'minecraft:marketInstall') {
        const list = await invoke('minecraft:backups', a[0], a[1]);
        window.__installs.push(list.items.map((b) => b.reason));
        return { installed: [], skipped: [], present: [] };
      }
      // Delete moves the file aside here, not to the user's Recycle Bin.
      if (ch === 'minecraft:backupDelete') { window.__deleted.push(a[2]); await ide.api.rename(a[2], a[2] + '.deleted'); return true; }
      return invoke(ch, ...a);
    };
    return true;
  })()`);

  // ---------- the tab, on a stopped server ----------
  await toCards();
  await until(`!!${card('survival')}?.querySelector('.mc-backups')`, 'the survival card', 10000);
  check(await js(`${card('survival')}.querySelector('.mc-backups').textContent`) === await tr('Backups') && !(await js(`${card('modded')}.querySelector('.mc-backups')`) === null),
    'each server card has Backups');
  await openBackups('survival');
  check(await js(`${inTab('.mcbk-summary')}.textContent`) === await tr('No backups yet. Back Up Now makes the first one.'), 'a server with no backups says how to make the first');
  await pressAt(inTab('.mcbk-now'));
  await until(`${tab}?.querySelectorAll('.mcbk-item').length === 1`, 'the first backup in the list', 30000);
  const first = await rows();
  check(zips('survival').length === 1 && /_manual\.zip$/.test(zips('survival')[0]) && first[0].text.includes(await tr('Made by you')) && first[0].text.includes(await tr('Minecraft {version}', { version: '1.21.11' })),
    `Back Up Now on a stopped server makes one backup, listed with its reason and Minecraft version (${S(first)})`);
  check(!commands().length, 'a stopped server gets no console commands');
  await shot('backups-dark.png');

  // ---------- on a running server ----------
  await toCards();
  await pressAt(`${card('survival')}.querySelector('.mc-start')`);
  await until(`!!${card('survival')}?.querySelector('.mc-stop')`, 'Stop once it runs', 20000);
  await until(`${sessionOf('survival')}?.con?.text?.includes('Done') ?? true`, 'the stand-in is up', 5000).catch(() => {});
  await sleep(1500);
  await openBackups('survival');
  await until(`${inTab('.mcset-state')}?.classList.contains('on')`, 'the tab says Running', 5000);
  await pressAt(inTab('.mcbk-now'));
  let fraction = null;
  for (let i = 0; i < 400 && (await js(`${tab}.querySelectorAll('.mcbk-item').length`)) < 2; i++) {
    const p = await js(`(() => { const b = ${inTab('.mcbk-progress')}; return b && !b.classList.contains('hidden') ? Number(${inTab('.mcbk-bar')}.dataset.percent) : null; })()`);
    if (p !== null && p > 0 && p < 100) fraction = p;
    await sleep(25);
  }
  check((await rows()).length === 2 && S(commands().slice(-3)) === S(['save-off', 'save-all flush', 'save-on']),
    `Back Up Now on a running server sends save-off, save-all flush and save-on (${S(commands())})`);
  check(fraction !== null, `the tab shows the pack's progress as a fraction while it runs (${fraction}%)`);

  // ---------- Restore on the running server: it is stopped first ----------
  write(inServer('survival', 'world', 'level.dat'), 'level v2 (griefed)');
  write(inServer('survival', 'server.properties'), 'server-port=25741\nmotd=after\nlevel-name=world\n');
  write(inServer('survival', 'whitelist.json'), '[]');
  await js(`ide.minecraft.settings.open(ide.minecraft.servers().find((s) => s.name === 'survival'))`);
  await until(`document.querySelector('.custom-tab.mcset:not(.mcbk):not(.hidden) [data-prop="motd"]')?.value === 'after'`, 'the settings tab with the new motd', 10000);
  await js(`(ide.minecraft.backups.open(ide.minecraft.servers().find((s) => s.name === 'survival')), true)`);
  await until(`${tab}?.querySelectorAll('.mcbk-item').length === 2`, 'the list again', 5000);
  const oldest = (await rows()).at(-1).name;
  await pressAt(`[...${tab}.querySelectorAll('.mcbk-item')].find((r) => r.dataset.name === ${S(oldest)}).querySelector('.mcbk-restore')`);
  const stopLabel = await tr('Stop and Restore');
  await until(`!!${dialogButton(stopLabel)}`, 'the restore dialog', 5000);
  const dialogText = await js(`[...document.querySelectorAll('.dialog')].at(-1).innerText`);
  check(dialogText.includes(await tr('Restore the world only (keep the current settings files)')) && /server\.properties/.test(dialogText) && /모드, 플러그인/.test(dialogText),
    `the dialog says what is replaced and what is not, and offers the world only (${S(dialogText.slice(0, 160))})`);
  await shot('restore-dialog-dark.png');
  await pressAt(dialogButton(stopLabel));
  await until(`!${card('survival')}?.querySelector('.mc-stop') && ide.notifications.list().some((e) => e.kind === 'ok' && /되돌렸어요/.test(e.title))`, 'the restore done', 60000);
  check(read(inServer('survival', 'world', 'level.dat')) === 'level v1' && /motd=before/.test(read(inServer('survival', 'server.properties'))) && read(inServer('survival', 'whitelist.json')).includes('Steve'),
    'Restore stopped the running server, then put back the world, server.properties and the whitelist');
  check(zips('survival').some((n) => n.endsWith('_restore.zip')) && commands().includes('stop'), `and a "before restore" backup was made first (${S(zips('survival'))})`);
  await until(`document.querySelector('.custom-tab.mcset:not(.mcbk) [data-prop="motd"]')?.value === 'before'`, 'the settings tab reloaded', 10000).catch(() => {});
  check(await js(`document.querySelector('.custom-tab.mcset:not(.mcbk) [data-prop="motd"]')?.value`) === 'before', 'the open settings tab shows the restored settings');
  await js(`(ide.minecraft.backups.open(ide.minecraft.servers().find((s) => s.name === 'survival')), true)`);
  await until(`${tab}?.querySelectorAll('.mcbk-item').length === 3`, 'three backups', 10000);
  check((await rows()).some((r) => r.text.includes('되돌리기 전')), 'the list shows the "before restore" backup');

  // ---------- Restore the world only, on the stopped server ----------
  write(inServer('survival', 'world', 'level.dat'), 'level v3');
  write(inServer('survival', 'server.properties'), 'server-port=25741\nmotd=kept\nlevel-name=world\n');
  const manual = (await rows()).find((r) => r.name === oldest);
  await pressAt(`[...${tab}.querySelectorAll('.mcbk-item')].find((r) => r.dataset.name === ${S(manual.name)}).querySelector('.mcbk-restore')`);
  const restoreLabel = await tr('Restore');
  await until(`!!${dialogButton(restoreLabel)}`, 'the restore dialog for a stopped server', 5000);
  await pressAt(`[...document.querySelectorAll('.dialog')].at(-1).querySelector('.mcbk-worldonly input')`);
  await clearBalloons();
  await pressAt(dialogButton(restoreLabel));
  await until(`${tab}?.querySelectorAll('.mcbk-item').length === 4`, 'the second restore', 60000);
  await sleep(500);
  check(read(inServer('survival', 'world', 'level.dat')) === 'level v1' && /motd=kept/.test(read(inServer('survival', 'server.properties'))),
    'Restore the world only puts the world back and leaves server.properties as it is');

  // ---------- the schedule and retention ----------
  await js(`(() => { const s = ${inTab('.mcbk-every')}; s.value = '12'; s.dispatchEvent(new Event('change')); const k = ${inTab('.mcbk-keep')}; k.value = '5'; k.dispatchEvent(new Event('change')); return true; })()`);
  await until(`${inTab('.mcbk-saved')}.textContent === ${S(await tr('Saved.'))}`, 'the policy saved', 5000);
  await sleep(300);
  const policy = JSON.parse(read(inServer('survival', 'pyide-server.json'))).backups;
  check(policy?.every === 12 && policy.keep === 5 && policy.maxGB === 20, `the schedule and the number kept are written to pyide-server.json (${S(policy)})`);

  // ---------- Delete asks first ----------
  const victim = (await rows()).at(0).name;
  await pressAt(`[...${tab}.querySelectorAll('.mcbk-item')].find((r) => r.dataset.name === ${S(victim)}).querySelector('.mcbk-delete')`);
  const del = await tr('Delete');
  await until(`!!${dialogButton(del)}`, 'the delete question', 5000);
  check(/휴지통/.test(await js(`[...document.querySelectorAll('.dialog')].at(-1).innerText`)), 'Delete asks before moving the backup to the Recycle Bin');
  await pressAt(dialogButton(del));
  await until(`![...${tab}.querySelectorAll('.mcbk-item')].some((r) => r.dataset.name === ${S(victim)})`, 'the deleted row gone', 5000);
  check(await js('window.__deleted.length') === 1, 'and the list no longer has it');

  // ---------- Korean, both themes, 900 px ----------
  const leaks = await englishLeaks(t, '.custom-tab.mcbk:not(.hidden)', ['Explorer', '7-Zip', 'Market', 'config/', 'server.properties', 'GB', 'MB', 'KB']);
  check(!leaks.length, `nothing in the Backups tab is left in English (${S(leaks.slice(0, 5))})`);
  await clearBalloons();
  await shot('backups-tab-dark.png');
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`ide.theme.current() === 'light'`, 'light theme', 10000);
  await sleep(400);
  await shot('backups-tab-light.png');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const narrow = await js(`(() => {
    const host = ${tab};
    const rowsFit = [...host.querySelectorAll('.mcbk-item')].every((r) => r.scrollWidth <= r.clientWidth + 1);
    const b = host.querySelector('.mcbk-item .mcbk-restore');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const words = [...host.querySelectorAll('.mcbk-item button, .mcset-tools button')].every((x) => x.scrollWidth <= x.clientWidth + 1);
    return { rowsFit, visible: hit === b || b.contains(hit), words, wide: host.scrollWidth <= host.clientWidth + 1 };
  })()`);
  check(narrow.rowsFit && narrow.visible && narrow.words && narrow.wide, `at 900 px the rows, their buttons and the tools fit and can be pressed (${S(narrow)})`);
  await shot('backups-tab-light-900.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`ide.theme.current() === 'dark'`, 'dark theme', 10000);
  await sleep(400);
  await shot('backups-tab-dark-900.png');
  await cdp('Emulation.clearDeviceMetricsOverride', {});
  await sleep(400);

  // ---------- a Market update backs the server up first; Skip lets it go on ----------
  await toCards();
  await pressAt(`${card('modded')}.querySelector('.mc-server-market')`);
  await until(`!!document.querySelector('.mcm-card[data-id="${SODIUM}"] .mcm-update')`, 'Sodium with Update', 15000);
  await pressAt(`document.querySelector('.mcm-card[data-id="${SODIUM}"] .mcm-update')`);
  await until('window.__installs.length === 1', 'the install after the backup', 30000);
  const saw = await js('window.__installs[0]');
  check(saw.includes('market') && zips('modded').length === 1 && /_market\.zip$/.test(zips('modded')[0]), `a Market Update backs the server up before it changes anything (the install saw ${S(saw)})`);
  write(inServer('modded', 'world', 'region', 'r.0.0.mca'), crypto.randomBytes(400 << 20));
  await until(`!document.querySelector('.mcm-card[data-id="${SODIUM}"] .mcm-update')?.disabled`, 'Update ready again', 10000);
  await pressAt(`document.querySelector('.mcm-card[data-id="${SODIUM}"] .mcm-update')`);
  const skip = await tr('Skip');
  const balloonSkip = `[...document.querySelectorAll('.ide-balloon .ide-balloon-action')].find((b) => b.textContent === ${S(skip)})`;
  await until(`!!${balloonSkip}`, 'the balloon with Skip', 10000);
  const balloonTitle = await js(`${balloonSkip}.closest('.ide-balloon').querySelector('.ide-balloon-title').textContent`);
  await pressAt(balloonSkip);
  await until('window.__installs.length === 2', 'the install after Skip', 15000);
  await sleep(500);
  check(zips('modded').length === 1 && /백업하는 중/.test(balloonTitle), `the balloon says why the update waits, and Skip goes on without the backup (${balloonTitle}; ${S(zips('modded'))})`);
} catch (err) {
  check(false, `suite error: ${err.stack}`);
  await shot('failure.png').catch(() => {});
} finally {
  web.close();
  t.finish();
}
