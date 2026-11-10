// Crashes, freezes and lag on the server card, in a Korean craft window, against the stand-in server process
// (verify/fixtures/craft-health/stand-in-server.cjs, which the page puts in place of the java command), with
// PYIDE_MC_HEALTH_MS shortening the clock. No real server, game, launcher, EULA or network. Presses go through
// Input.dispatchMouseEvent at a spot elementFromPoint says is the control.
// Checks: a server that runs out of memory shows why on its card in Korean, with Restart, the log and the memory fix,
// and the fix writes the memory; automatic restart restarts a crash that does not come back once and the server runs
// on, and a server that keeps crashing is restarted twice and then left with the reason; a frozen stand-in is reported
// as not responding, and Restart from its card stops it and starts it again; "Can't keep up" lines turn the card's
// state to overloaded, the suggestion writes the distances and Undo puts them back; the settings tab's section has the
// three switches with their defaults. Screenshots in both themes. Port 9744; the stand-ins listen on 25731-25735.
// Usage: node verify/craft-health.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-craft-health-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const serverDir = (name) => path.join(project, 'servers', name);
const starts = (name) => read(path.join(serverDir(name), 'starts.log')).trim().split('\n').filter(Boolean).length;
const server = (name, cfg) => {
  write(path.join(serverDir(name), 'pyide-server.json'), S({ kind: 'fabric', mc: '26.3', loader: '0.17.0', build: null, java: 21, memory: '2G', launch: { jar: 'server.jar' } }));
  write(path.join(serverDir(name), 'server.properties'), `server-port=${cfg.port}\nview-distance=12\nsimulation-distance=10\nmotd=${name}\n`);
  write(path.join(serverDir(name), 'stand-in.json'), S(cfg));
};
server('crashy', { port: 25731, exitMs: 1200, code: 1, oom: true });
server('onceler', { port: 25732, exitMs: 1200, code: 1, onceOnly: true });
server('looper', { port: 25733, exitMs: 700, code: 1 });
server('frozen', { port: 25734, freezeMs: 600 });
server('laggy', { port: 25735, lag: 10, lagEveryMs: 60 });
const standIn = path.resolve('verify/fixtures/craft-health/stand-in-server.cjs');
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');
const CLOSED = 'http://127.0.0.1:1';
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, paper: `${CLOSED}/paper`, modrinth: `${CLOSED}/modrinth` }),
  PYIDE_MC_HEALTH_MS: S({ tick: 100, quiet: 1500, firstPing: 300, every: 200, recheck: 200, failing: 700, baseline: 200, pingTimeout: 300, evaluate: 300, sustain: 600, cpu: 3_600_000, tps: 200, delays: [1500, 2500] }) };

const t = await launch({ name: 'craft-health', port: 9744, mode: 'craft', lang: 'ko-KR', projectDir: project, env });
const { js, until, check, shot, cdp, sleep } = t;
const card = (name) => `document.querySelector('#minecraftScreen .mc-server[data-name="${name}"]')`;
const inCard = (name, sel) => `${card(name)}?.querySelector(${S(sel)})`;
const tr = (key, params) => js(`tr(${S(key)}, ${S(params || {})})`);
// Balloons of earlier steps sit in the lower right, over cards a step presses later.
const pressAt = async (expr) => {
  const spot = await js(`(() => {
    document.querySelectorAll('.ide-balloon').forEach((b) => b.remove());
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
const seen = (expr) => js(`(() => { const n = ${expr}; if (!n || !n.getClientRects().length) return false; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && (hit === n || n.contains(hit)); })()`);
const buttonByText = (name, text) => `[...(${card(name)}?.querySelectorAll('.mc-health button') || [])].find((b) => b.textContent === ${S(text)})`;
const toCards = () => js(`(ide.tabs.slice().forEach((x) => ide.closeTabObject(x, true)), document.querySelectorAll('.ide-balloon').forEach((n) => n.remove()), ide.minecraft.screen.show('servers'), true)`);
const notes = (re) => js(`ide.notifications.list().filter((e) => new RegExp(${S(re)}).test(e.title)).map((e) => e.title)`);
const props = (name) => Object.fromEntries(read(path.join(serverDir(name), 'server.properties')).split(/\r?\n/).filter((l) => l.includes('=')).map((l) => l.split('=')));
const panelText = (name) => js(`${inCard(name, '.mc-health')}?.innerText ?? ''`);
const views = async (label) => {
  await shot(`${label}-dark.png`);
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`ide.theme.current() === 'light'`, 'light theme', 10000);
  await shot(`${label}-light.png`);
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`ide.theme.current() === 'dark'`, 'dark theme', 10000);
};
// No button text of a panel is cut off at this width.
const clipped = (name) => js(`[...(${card(name)}?.querySelectorAll('.mc-health button, .mc-load-chip') || [])].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent)`);

try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 20000);
  if (path.resolve(await js('ide.root')).toLowerCase() !== path.resolve(project).toLowerCase()) throw new Error('the window is not on the test project');
  await js(`(() => {
    const invoke = ide.api.invoke;
    ide.api.invoke = (ch, ...a) => ch !== 'minecraft:launch' ? invoke(ch, ...a) : invoke(ch, ...a).then((spec) => ({ ...spec, cmd: ${S(process.execPath)}, args: [${S(standIn)}] }));
    return true;
  })()`);
  await js('ide.minecraft.refresh()');
  await toCards();
  await until(`!!${card('crashy')}?.offsetParent`, 'the crashy card', 10000);
  const width = await js('innerWidth');

  // ---------- out of memory: the cause, in Korean, with what can be done ----------
  await pressAt(inCard('crashy', '.mc-start'));
  await until(`!!${inCard('crashy', '.mc-health-crash')}`, 'the crash panel', 20000);
  const title = await tr('Stopped unexpectedly: {title}', { title: await tr('It ran out of memory') });
  const memoryFix = await tr('Set Memory to {memory}', { memory: '4G' });
  const crash = await js(`(() => { const p = ${inCard('crashy', '.mc-health-crash')}; return { cause: p.dataset.cause, title: p.querySelector('.mc-health-title').textContent, text: p.innerText,
    buttons: [...p.querySelectorAll('button')].map((b) => b.textContent) }; })()`);
  check(crash.cause === 'memory' && crash.title === title && /[가-힣]/.test(title) && crash.buttons.includes(await tr('Restart')) && crash.buttons.includes(memoryFix)
    && crash.buttons.includes(await tr('Open Log')) && /2G/.test(crash.text) && await seen(inCard('crashy', '.mc-health-crash .mc-health-title')),
  `a server that ran out of memory says so on its card in Korean, with its memory, Restart, the log and the fix (${S(crash)})`);
  check(!!(await notes(await tr('{name} stopped unexpectedly: {title}', { name: 'crashy', title: await tr('It ran out of memory') }))).length, 'and a notification says the same');
  check(!(await clipped('crashy')).length, `no button of the panel is cut off at ${width} px (${S(await clipped('crashy'))})`);
  await views(`crash-${width}`);
  await pressAt(buttonByText('crashy', memoryFix));
  for (let i = 0; i < 50 && !/"memory": "4G"/.test(read(path.join(serverDir('crashy'), 'pyide-server.json'))); i++) await sleep(100);
  check(/"memory": "4G"/.test(read(path.join(serverDir('crashy'), 'pyide-server.json'))), 'the memory fix writes 4G into pyide-server.json');
  await toCards();

  // ---------- automatic restart: a crash that does not come back is restarted once ----------
  await js(`ide.api.invoke('minecraft:setHealth', ide.root, ${S(serverDir('onceler'))}, { autoRestart: true }).then(() => ide.minecraft.refresh())`);
  await pressAt(inCard('onceler', '.mc-start'));
  await until(`!!${inCard('onceler', '.mc-health-count')}`, 'the countdown on the card', 20000).catch(() => {});
  const countdown = await js(`${inCard('onceler', '.mc-health-count')}?.textContent ?? ''`);
  await until(`ide.minecraft.runningAt(${S(serverDir('onceler'))}) && !${inCard('onceler', '.mc-health-crash')}`, 'running again', 20000).catch(() => {});
  await sleep(2500);
  const once = { starts: starts('onceler'), running: await js(`ide.minecraft.runningAt(${S(serverDir('onceler'))})`), told: await notes(await tr('{name} restarted automatically', { name: 'onceler' })) };
  check(/[가-힣]/.test(countdown) && once.starts === 2 && once.running && once.told.length === 1,
    `with automatic restart on, a crash after Done counts down on the card, restarts once and the server runs on (${S({ countdown, ...once })})`);

  // ---------- automatic restart: a crash loop stops after the limit ----------
  await js(`ide.api.invoke('minecraft:setHealth', ide.root, ${S(serverDir('looper'))}, { autoRestart: true }).then(() => ide.minecraft.refresh())`);
  await toCards();
  await pressAt(inCard('looper', '.mc-start'));
  const loopLine = await tr('It stopped {count} times in 10 minutes, so automatic restart has stopped. Fix the cause first.', { count: 3 });
  await until(`(${inCard('looper', '.mc-health-crash')}?.innerText || '').includes(${S(loopLine)})`, 'the loop stopped', 30000).catch(() => {});
  await sleep(2000);
  const loop = { starts: starts('looper'), text: await panelText('looper'), told: (await notes(await tr('{name} restarted automatically', { name: 'looper' }))).length, running: await js(`ide.minecraft.runningAt(${S(serverDir('looper'))})`) };
  check(loop.starts === 3 && loop.told === 2 && !loop.running && loop.text.includes(loopLine),
    `a server that keeps crashing is restarted twice, then left stopped with the reason on its card (${S(loop)})`);
  await shot(`loop-${width}.png`);

  // ---------- a frozen server ----------
  await toCards();
  await pressAt(inCard('frozen', '.mc-start'));
  await until(`!!${inCard('frozen', '.mc-health-frozen')}`, 'the not responding panel', 20000).catch(() => {});
  const frozen = { panel: await panelText('frozen'), chip: await js(`${inCard('frozen', '.mc-load-chip.frozen')}?.textContent ?? ''`), told: await notes(await tr('{name} is not responding', { name: 'frozen' })),
    running: await js(`ide.minecraft.runningAt(${S(serverDir('frozen'))})`) };
  check(frozen.chip === await tr('Not responding') && frozen.panel.includes(await tr('Not responding')) && frozen.told.length === 1 && frozen.running,
    `a stand-in that goes silent and stops answering pings is reported as not responding, and left running (${S(frozen)})`);
  await shot(`frozen-${width}.png`);
  await pressAt(`${inCard('frozen', '.mc-health-frozen .mc-health-restart')}`);
  for (let i = 0; i < 100 && starts('frozen') < 2; i++) await sleep(100);
  check(starts('frozen') === 2, `Restart on its card stops it and starts it again (${starts('frozen')} starts)`);
  await js(`(ide.run.sessions().find((s) => s.cfg?.dir === 'servers/frozen')?.stop(), true)`);

  // ---------- overload ----------
  await toCards();
  await pressAt(inCard('laggy', '.mc-start'));
  await until(`${inCard('laggy', '.mc-load-chip')}?.classList.contains('overloaded') && !!${inCard('laggy', '.mc-health-load')}`, 'overloaded on the card', 20000).catch(() => {});
  const lower = await tr('Lower View and Simulation Distance');
  const lag = { chip: await js(`${inCard('laggy', '.mc-load-chip')}?.textContent ?? ''`), title: await js(`${inCard('laggy', '.mc-load-chip')}?.title ?? ''`), panel: await panelText('laggy') };
  check(lag.chip === await tr('Overloaded') && /Can't keep up/.test(lag.title) && lag.panel.includes('12 → 8') && lag.panel.includes('10 → 6') && !!(await js(`${buttonByText('laggy', lower)}`)),
    `"Can't keep up" lines turn the card's state to overloaded, the numbers on hover, the distances to lower from and to (${S(lag)})`);
  await until(`ide.notifications.list().some((e) => e.title === ${S(await tr('{name} cannot keep up', { name: 'laggy' }))})`, 'the overload notification', 10000).catch(() => {});
  check((await notes(await tr('{name} cannot keep up', { name: 'laggy' }))).length === 1, 'a sustained overload is said once');
  await views(`overload-${width}`);
  check(!(await clipped('laggy')).length, `no button of the overload panel is cut off at ${width} px (${S(await clipped('laggy'))})`);
  await pressAt(buttonByText('laggy', lower));
  for (let i = 0; i < 50 && props('laggy')['view-distance'] !== '8'; i++) await sleep(100);
  const applied = props('laggy');
  check(applied['view-distance'] === '8' && applied['simulation-distance'] === '6', `the suggestion writes view-distance 8 and simulation-distance 6 (${S(applied)})`);
  await until(`!!${inCard('laggy', '.mc-health-undo')}`, 'Undo on the card', 5000).catch(() => {});
  await pressAt(inCard('laggy', '.mc-health-undo'));
  for (let i = 0; i < 50 && props('laggy')['view-distance'] !== '12'; i++) await sleep(100);
  check(props('laggy')['view-distance'] === '12' && props('laggy')['simulation-distance'] === '10', `Undo puts them back (${S(props('laggy'))})`);

  // ---------- the settings tab's section ----------
  await toCards();
  await pressAt(inCard('laggy', '.mc-settings'));
  await until(`!!document.querySelector('.custom-tab.mcset:not(.hidden) .mcset-health')`, 'the section in the settings tab', 10000);
  await sleep(500);
  const section = await js(`(() => { const tab = document.querySelector('.custom-tab.mcset:not(.hidden)'); const box = tab.querySelector('.mcset-health');
    return { page: [...tab.querySelectorAll('.mcset-page')].map((p) => p.textContent), switches: Object.fromEntries([...box.querySelectorAll('input[data-health]')].map((c) => [c.dataset.health, c.checked])),
      numbers: box.querySelector('.mcset-health-numbers').textContent }; })()`);
  check(section.page.includes(await tr('Crashes and Lag')) && S(section.switches) === S({ autoRestart: false, hang: true, overload: true }) && section.numbers.includes(await tr('Overloaded')),
    `the settings tab has the section with automatic restart off and the two notices on, and the numbers behind the state (${S(section)})`);
  await js(`(document.querySelector('.custom-tab.mcset:not(.hidden) .mcset-section[data-section="health"]').scrollIntoView(), true)`);
  await views(`settings-${width}`);
  await js(`(ide.run.sessions().filter((s) => s.cfg?.type === 'minecraft-server' && s.running).forEach((s) => s.stop()), true)`);

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
  const internal = await js(`ide.api.invoke('diagnostics:errors')`);
  check(!internal.length, `no IDE internal errors${internal.length ? ` ${S(internal).slice(0, 1500)}` : ''}`);
} catch (err) {
  check(false, `craft-health crashed: ${err.stack || err}`);
  await shot('crash.png').catch(() => {});
}
await t.finish();
