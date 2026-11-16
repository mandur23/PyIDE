// Craft's tool windows in windows of their own (renderer/core/popout.js), in a Korean window, against a stand-in server
// (a Node script started through the real run type, card and Run console, as verify/craft-polish.mjs does; no real
// server, game, launcher, EULA or network): the Run window with a server's console goes to a new window from its
// bottom tab's menu (새 창으로 열기), the console shows the server's lines there and takes a command typed there, Find
// Action's shortcut opens in that window, the window's 기본 창으로 되돌리기 button brings the console back with its lines
// and input, closing the window brings it back too, and after a restart the Run window comes out again and a server
// started then writes its lines there. Closing the main window closes it. Port 9945.
// Usage: node verify/popout-craft.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { attachPage, launch, menuRow } from './lib.mjs';

const PORT = 9945;
const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-popout-craft-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const server = (...rest) => path.join(project, 'servers', 'survival', ...rest);
write(server('pyide-server.json'), S({ kind: 'paper', mc: '26.3', loader: null, build: 1, java: 21, memory: '1G', launch: { jar: 'server.jar' }, mdk: null }));
write(server('server.properties'), 'server-port=25691\nmotd=survival\n');
const standIn = path.join(work, 'stand-in.cjs');
write(standIn, `console.log('Done (0.1s)! For help, type "help"');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0;) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'stop') { console.log('Stopping the server'); setTimeout(() => process.exit(0), 500); }
    else if (line) console.log('Unknown command: ' + line);
  }
});
setInterval(() => {}, 1000);
`);
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');
const CLOSED = 'http://127.0.0.1:1';
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, paper: `${CLOSED}/paper`, velocity: `${CLOSED}/velocity`, purpur: `${CLOSED}/purpur`, modrinth: `${CLOSED}/modrinth` }) };

let t = await launch({ name: 'popout-craft', port: PORT, mode: 'craft', projectDir: project, env, lang: 'ko-KR' });
let { js, until, check, cdp, sleep } = t;
const titled = (title) => (target) => target.title === title;
const pop = `ide.popout.windowOf('Run')`;
const inPop = (sel) => `${pop}?.document.querySelector(${S(sel)})`;
const card = `document.querySelector('#minecraftScreen .mc-server[data-name="survival"]')`;
const consoleText = `(${inPop('.console')}?.textContent || document.querySelector('#bottomBody .tool.active .console')?.textContent || '')`;
const rectIn = (expr) => js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + Math.min(r.height / 2, 12) }; })()`);
const mouse = async (send, spot, button = 'left') => {
  if (!spot) throw new Error('nothing to press');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, button: 'none' });
  for (const kind of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: kind, x: spot.x, y: spot.y, button, buttons: kind === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
  await sleep(80);
};
// minecraft:launch answers from main as for a real server, with the stand-in's command line.
const standInLaunch = () => js(`(() => {
  const invoke = ide.api.invoke;
  ide.api.invoke = (ch, ...a) => ch !== 'minecraft:launch' ? invoke(ch, ...a) : invoke(ch, ...a).then((spec) => ({ ...spec, cmd: ${S(process.execPath)}, args: [${S(standIn)}] }));
  return true;
})()`);
const startServer = async () => {
  await js(`(ide.minecraft.screen.show('servers'), ide.minecraft.refresh().then(() => true))`);
  await until(`!!${card}?.querySelector('.mc-start')`, 'Start on the survival card', 15000);
  await mouse(cdp, await rectIn(`${card}.querySelector('.mc-start')`));
  await until(`!!${card}?.querySelector('.mc-stop')`, 'the server running', 20000);
};

try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 15000);
  if (path.resolve(await js('ide.root')).toLowerCase() !== path.resolve(project).toLowerCase()) throw new Error('the window is not on the test project');
  await standInLaunch();
  await startServer();
  await until(`${consoleText}.includes('Done (0.1s)')`, 'the server\'s first line in the Run console', 15000);
  const runTitle = await js(`ide.toolWindows.get('Run').title`);

  // ---------- out through the bottom tab's menu ----------
  await mouse(cdp, await rectIn(`ide.toolWindows.get('Run').tab`), 'right');
  await until(menuRow('새 창으로 열기'), 'the tab menu with 새 창으로 열기', 5000);
  await mouse(cdp, await rectIn(menuRow('새 창으로 열기')));
  await until(`ide.popout.isOpen('Run')`, 'the Run window in a window of its own', 10000);
  const placed = await js(`({ title: ${pop}.document.title, lines: ${inPop('.console')}?.textContent.includes('Done (0.1s)'), here: !!document.getElementById('bottomBody').querySelector('.console') })`);
  check(placed.title === `${runTitle} - Nano Studio Craft` && placed.lines && !placed.here,
    `새 창으로 열기 moves the Run console, with the server's lines, into a window titled "${runTitle} - Nano Studio Craft" (${S(placed)})`);
  const run = await attachPage(PORT, titled(`${runTitle} - Nano Studio Craft`));
  await run.shot(path.join(t.outDir, 'run-window.png'));

  // ---------- a command typed there ----------
  await mouse(run.cdp, await rectIn(inPop('.console-in')));
  await run.type('list');
  await run.press('Enter');
  await until(`${consoleText}.includes('Unknown command: list')`, 'the answer in the detached console', 10000).catch(() => {});
  check(await js(`${inPop('.console')}?.textContent.includes('Unknown command: list')`), 'a command typed in the new window reaches the server and its answer shows there');

  // ---------- a shortcut there ----------
  await run.press('Ctrl+Shift+A');
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'Find Action', 5000).catch(() => {});
  check(await js(`document.getElementById('popup').ownerDocument === ${pop}.document && !document.getElementById('popup').classList.contains('hidden')`),
    'Ctrl+Shift+A in the Run window opens Find Action in that window');
  await run.press('Escape');
  await until(`document.getElementById('popup').classList.contains('hidden')`, 'Find Action closed', 5000).catch(() => {});

  // ---------- 기본 창으로 되돌리기 ----------
  const dock = await js(`${inPop('.popout-dock')}?.title`);
  await mouse(run.cdp, await rectIn(inPop('.popout-dock')));
  await until(`!ide.popout.isOpen('Run')`, 'the Run window back', 8000).catch(() => {});
  run.close();
  const home = await js(`({ home: document.getElementById('bottomBody').contains(ide.toolWindows.get('Run').container), shown: ide.toolWindows.get('Run').isVisible(), lines: ${consoleText}.includes('Unknown command: list') })`);
  check(dock === '기본 창으로 되돌리기' && home.home && home.shown && home.lines, `the window's 기본 창으로 되돌리기 button brings the console back to the bottom panel with its lines (${S({ dock, ...home })})`);
  await mouse(cdp, await rectIn(`document.querySelector('#bottomBody .tool.active .console-in')`));
  await t.type('help');
  await t.press('Enter');
  await until(`${consoleText}.includes('Unknown command: help')`, 'a command in the main window again', 10000).catch(() => {});
  check(await js(`${consoleText}.includes('Unknown command: help')`), 'back in the main window the console still takes commands');

  // ---------- out by the action, closed by its window ----------
  await js(`(ide.runAction('PopoutToolWindow'), true)`);
  await until(`ide.popout.isOpen('Run')`, 'the Run window out by the action', 10000);
  check(true, 'Find Action\'s 도구 창을 새 창으로 열기… takes out the window that has the keyboard');
  const again = await attachPage(PORT, titled(`${runTitle} - Nano Studio Craft`));
  await again.cdp('Runtime.evaluate', { expression: 'window.close()' });
  await until(`!ide.popout.isOpen('Run')`, 'the Run window back on close', 8000).catch(() => {});
  again.close();
  check(await js(`document.getElementById('bottomBody').contains(ide.toolWindows.get('Run').container) && ide.settings.get('popout.windows', {}).craft?.Run?.open === false`),
    'closing the window brings the console back, and it is remembered as back');

  // ---------- every Craft tool window goes out and comes back ----------
  const errorsAt = t.consoleErrors.length;
  check(await js(`ide.popout.open('Project').then((out) => !out && !ide.popout.isOpen('Project'))`), 'Code\'s Project window, hidden in Craft, is not taken out');
  const ids = await js(`[...ide.toolWindows.values()].filter((tw) => tw.available() && !tw.popout && tw.area.panel.id !== 'sidePanel').map((tw) => tw.id)`);
  const failed = [];
  for (const id of ids) {
    const ok = await js(`ide.popout.open(${S(id)}).then((out) => out && !!ide.popout.windowOf(${S(id)})?.document.querySelector('.popout-body > .tool'))`).catch(() => false);
    await js(`(ide.popout.close(${S(id)}), true)`);
    if (!ok || await js(`ide.popout.isOpen(${S(id)})`)) failed.push(id);
  }
  check(!failed.length && t.consoleErrors.length === errorsAt, `each of Craft's tool windows (${ids.join(', ')}) goes to a window of its own and back without an error (${failed.join(', ') || 'all'})`);

  // ---------- remembered across a restart ----------
  await js(`ide.popout.open('Run')`);
  await until(`ide.popout.isOpen('Run')`, 'the Run window out again', 10000);
  await js(`(() => { const s = ide.run.sessions().find((x) => x.cfg?.type === 'minecraft-server'); s.con.input.value = 'stop'; s.con.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await until(`!!${card}?.querySelector('.mc-start')`, 'the server stopped', 20000).catch(() => {});
  await sleep(600);
  const { userData, results: before, consoleErrors: errorsBefore } = t;
  t.close();
  await sleep(1500);
  t = await launch({ name: 'popout-craft', port: PORT, mode: 'craft', projectDir: project, env, lang: 'ko-KR', userData });
  t.results.unshift(...before);
  t.consoleErrors.unshift(...errorsBefore);
  ({ js, until, check, cdp, sleep } = t);
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app again', 15000);
  await until(`ide.popout.isOpen('Run')`, 'the Run window back out after the restart', 15000).catch(() => {});
  check(await js(`ide.popout.isOpen('Run') && !document.getElementById('bottomBody').contains(ide.toolWindows.get('Run').container)`), 'after a restart the Run window comes out again in a window of its own');
  await standInLaunch();
  await startServer();
  await until(`${inPop('.console')}?.textContent.includes('Done (0.1s)')`, 'the new server\'s lines in the restored window', 15000).catch(() => {});
  check(await js(`!!${inPop('.console')}?.textContent.includes('Done (0.1s)')`), 'a server started after the restart writes its console in the restored window');

  // ---------- closing the main window closes it ----------
  const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page').length;
  await js(`(() => { const s = ide.run.sessions().find((x) => x.cfg?.type === 'minecraft-server'); s.con.input.value = 'stop'; s.con.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await until(`!!${card}?.querySelector('.mc-start')`, 'the server stopped again', 20000).catch(() => {});
  await js(`ide.api.invoke('window:closeNow')`).catch(() => {});
  let left = -1;
  for (let i = 0; i < 40; i++) {
    left = await pages().catch(() => 0);
    if (!left) break;
    await sleep(250);
  }
  check(left === 0, `closing the main window closes the Run window's window with it (${left} left)`);
} catch (err) {
  check(false, err.stack || err.message);
}
t.finish();
