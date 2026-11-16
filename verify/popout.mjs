// Code's tool windows in windows of their own (renderer/core/popout.js): the Terminal goes to a new window from its
// stripe button's menu and keeps its shell (typed into in that window, the output shows there), its shortcut works from
// that window, a Find Action shortcut opens its chooser in the window it was pressed in, a menu opened there shows
// there, the theme follows the main window, closing the window puts the Terminal back with the same shell, Return
// Tool Window to Main Window brings back the Problems window, and after a restart the windows that were out come out
// again where they were (one saved on a screen that is gone comes back on the main window's screen). Closing the main
// window closes them. Clicks and keys go through each window's own CDP session, as a user's do. Port 9944.
// Usage: node verify/popout.mjs
import { attachPage, launch, menuRow } from './lib.mjs';

const PORT = 9944;
const S = JSON.stringify;
let t = await launch({ fixture: 'core', port: PORT, name: 'popout' });
let { js, until, check, cdp, press, type, sleep } = t;
const record = (ok, label) => check(ok, label);
const titled = (title) => (target) => target.title.startsWith(`${title} - `);
const pop = (id) => `ide.popout.windowOf(${S(id)})`;
const inPop = (id, sel) => `${pop(id)}?.document.querySelector(${S(sel)})`;
const rectIn = (expr) => js(`(() => { const n = ${expr}; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 60), y: r.y + Math.min(r.height / 2, 14) }; })()`);
const mouse = async (send, spot, button = 'left') => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, button: 'none' });
  for (const kind of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: kind, x: spot.x, y: spot.y, button, buttons: kind === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
  await sleep(80);
};
const choose = async (label) => {
  const row = await rectIn(menuRow(label));
  if (!row) throw new Error(`no menu row ${label}`);
  await mouse(cdp, row);
};
const terminalPid = () => js(`ide.terminal.sessions()[0]?.pid ?? null`);
const outputLine = (word) => `ide.terminal.text().split('\\n').some((l) => l.trim() === ${S(word)})`;

try {
  await js(`(ide.settings.set('terminal.shell', 'cmd'), true)`);
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length === 1 && /project>/.test(ide.terminal.text())`, 'a terminal session at its prompt', 30000);
  const pid = await terminalPid();

  // ---------- out through the stripe button's menu ----------
  await mouse(cdp, await rectIn(`document.querySelector('.stripe-btn[data-tool="Terminal"]')`), 'right');
  await until(menuRow('Open Panel in New Window'), 'the stripe button menu', 5000);
  await choose('Open Panel in New Window');
  await until(`ide.popout.isOpen('Terminal')`, 'the Terminal in a window of its own', 10000);
  const placed = await js(`({
    there: !!${inPop('Terminal', '.term-session')},
    here: !!document.getElementById('bottomBody').querySelector('.term-session'),
    visible: ide.toolWindows.get('Terminal').isVisible(),
    title: ${pop('Terminal')}.document.title,
  })`);
  record(placed.there && !placed.here && placed.visible && placed.title === 'Terminal - Nano Studio Code',
    `Open Panel in New Window moves the Terminal into a window titled "Terminal - Nano Studio Code" (${S(placed)})`);
  const term = await attachPage(PORT, titled('Terminal'));
  record(true, 'the new window is a window of its own');

  // ---------- the shell works there ----------
  await mouse(term.cdp, await rectIn(inPop('Terminal', '.term-session:not(.hidden) .xterm-screen')));
  await term.type('echo POPOUT_42');
  await term.press('Enter');
  await until(outputLine('POPOUT_42'), 'the echo in the detached terminal', 15000).catch(() => {});
  record(await js(outputLine('POPOUT_42')) && await terminalPid() === pid, `typed in the new window, the same shell (pid ${pid}) answers there`);
  // Fitted before the window's stylesheets applied, the terminal had a few columns and cmd wrapped the prompt line.
  record(await js(`ide.terminal.text().split('\\n').some((l) => /^[A-Z]:\\\\.*project>echo POPOUT_42$/.test(l.trim()))`), 'the prompt line is not wrapped: the terminal took the new window\'s width');
  await term.shot(`${t.outDir}/terminal-window.png`);

  // ---------- its shortcut from that window ----------
  await term.press('Alt+F12');
  await until(`ide.popout.activeWindow() === window`, 'Alt+F12 gave the keyboard back', 5000).catch(() => {});
  record(await js(`ide.popout.activeWindow() === window && ide.popout.isOpen('Terminal')`), 'Alt+F12 in the Terminal\'s window gives the keyboard back to the main window and the window stays');
  await press('Alt+F12');
  await until(`ide.popout.activeWindow() === ${pop('Terminal')}`, 'Alt+F12 brought the window forward', 5000).catch(() => {});
  record(await js(`ide.popout.activeWindow() === ${pop('Terminal')} && !!document.activeElement?.closest('[data-terminal]')`),
    'Alt+F12 in the main window brings the Terminal\'s window forward with the keyboard in the terminal');

  // ---------- a menu opened there shows there ----------
  await mouse(term.cdp, await rectIn(inPop('Terminal', '.popout-title')), 'right');
  await until(`!!${inPop('Terminal', '#menuHost .context-menu')}`, 'the menu in the Terminal window', 5000).catch(() => {});
  const menu = await js(`({ there: [...(${pop('Terminal')}.document.querySelectorAll('#menuHost .menu-label') || [])].map((n) => n.textContent), here: Node.prototype.contains.call(document, document.querySelector('#menuHost .context-menu')) })`);
  record(menu.there.includes('Return to Main Window') && !menu.here, `the header's menu opens in the Terminal's window with Return to Main Window (${S(menu)})`);
  await term.press('Escape');
  await until(`!document.querySelector('.context-menu')`, 'the menu closed', 5000).catch(() => {});

  // ---------- the theme follows ----------
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`${pop('Terminal')}.document.documentElement.dataset.theme === 'light'`, 'the light theme in the window', 5000).catch(() => {});
  const light = await js(`getComputedStyle(${inPop('Terminal', '.popout-root')}).backgroundColor`);
  record(await js(`${pop('Terminal')}.document.documentElement.dataset.theme === 'light'`) && light !== 'rgb(30, 31, 34)', `switching to Light switches the Terminal's window too (${light})`);
  await term.shot(`${t.outDir}/terminal-window-light.png`);
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);

  // ---------- a shortcut in another tool window's window: Find Action there, then Return Tool Window ----------
  await js(`(ide.toolWindows.get('Problems').show(), true)`);
  await mouse(cdp, await rectIn(`[...document.querySelectorAll('.bottom-tab')].find((n) => n.firstChild.textContent === 'Problems')`), 'right');
  await until(menuRow('Open Panel in New Window'), 'the Problems tab menu', 5000);
  await choose('Open Panel in New Window');
  await until(`ide.popout.isOpen('Problems')`, 'Problems in a window of its own', 10000);
  const problems = await attachPage(PORT, titled('Problems'));
  await mouse(problems.cdp, await rectIn(inPop('Problems', '.popout-body')));
  await problems.press('Ctrl+Shift+A');
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'Find Action', 5000).catch(() => {});
  record(await js(`document.getElementById('popup').ownerDocument === ${pop('Problems')}.document && !document.getElementById('popup').classList.contains('hidden')`),
    'Ctrl+Shift+A pressed in the Problems window opens Find Action in that window');
  await problems.type('Return Tool Window');
  await sleep(300);
  await problems.press('Enter');
  await until(`!ide.popout.isOpen('Problems')`, 'Problems back', 8000).catch(() => {});
  record(await js(`!ide.popout.isOpen('Problems') && document.getElementById('bottomBody').contains(ide.toolWindows.get('Problems').container) && ide.toolWindows.get('Problems').isVisible()`),
    'Return Tool Window to Main Window from that window puts Problems back in the bottom panel and shows it');
  problems.close();

  // ---------- the Project tree from its own window ----------
  await js(`ide.popout.open('Project')`);
  const tree = await attachPage(PORT, titled('Project'));
  await until(`!!${pop('Project')}?.document.querySelector('#tree .node')`, 'the tree in its window', 10000);
  const row = await rectIn(`[...${pop('Project')}.document.querySelectorAll('#tree .node')].find((n) => n._entry?.path.endsWith('hello.py'))`);
  await mouse(tree.cdp, row);
  await until(`ide.activeTab()?.path.endsWith('hello.py')`, 'hello.py opened from the detached tree', 8000).catch(() => {});
  record(await js(`ide.activeTab()?.path.endsWith('hello.py') && document.getElementById('tree') === ${pop('Project')}.document.getElementById('tree')`),
    'a file clicked in the Project tree in its own window opens in the main window\'s editor');
  tree.close();
  await js(`(ide.popout.close('Project'), true)`);

  // ---------- every tool window goes out and comes back ----------
  const errorsAt = t.consoleErrors.length;
  const ids = await js(`[...ide.toolWindows.values()].filter((tw) => tw.available() && !tw.popout).map((tw) => tw.id)`);
  const failed = [];
  for (const id of ids) {
    const ok = await js(`ide.popout.open(${S(id)}).then((out) => out && !!${pop(id)}?.document.querySelector('.popout-body > .tool.active'))`).catch(() => false);
    await js(`(ide.popout.close(${S(id)}), true)`);
    const home = await js(`!ide.popout.isOpen(${S(id)}) && ide.toolWindows.get(${S(id)}).container.closest('#sideBody, #bottomBody, #rightBody') !== null`);
    if (!ok || !home) failed.push(id);
  }
  record(!failed.length && t.consoleErrors.length === errorsAt, `each of the ${ids.length} tool windows goes to a window of its own and back without an error (${failed.join(', ') || 'all'}; ${t.consoleErrors.slice(errorsAt).join(' | ')})`);

  // ---------- closing the window puts the Terminal back, same shell ----------
  await term.cdp('Runtime.evaluate', { expression: 'window.close()' });
  await until(`!ide.popout.isOpen('Terminal')`, 'the Terminal back', 8000).catch(() => {});
  await sleep(300);
  const back = await js(`({ home: document.getElementById('bottomBody').contains(ide.toolWindows.get('Terminal').container), kept: (ide.settings.get('popout.windows', {}).code || {}).Terminal })`);
  record(back.home && back.kept?.open === false && back.kept.bounds?.width >= 200 && await terminalPid() === pid,
    `closing the Terminal's window puts it back in the bottom panel with the same shell, its place kept for next time (${S(back)})`);
  term.close();
  await js(`(ide.toolWindows.get('Terminal').show(), true)`);
  await js(`document.querySelector('.term-session:not(.hidden) textarea').focus()`);
  await type('echo BACK_7');
  await press('Enter');
  await until(outputLine('BACK_7'), 'the echo back in the main window', 15000).catch(() => {});
  record(await js(outputLine('BACK_7')), 'back in the main window the terminal still takes typing');

  // ---------- remembered across a restart ----------
  await js(`document.querySelector('.term-session:not(.hidden) textarea').focus()`);
  await js(`(ide.runAction('PopoutToolWindow'), true)`);
  await until(`ide.popout.isOpen('Terminal')`, 'the Terminal out again by the action', 10000);
  record(true, 'Window › Open Tool Window in New Window… takes out the tool window that has the keyboard');
  const firstBounds = await js(`JSON.stringify((ide.settings.get('popout.windows', {}).code || {}).Terminal?.bounds)`);
  await js(`(() => { const w = ${pop('Terminal')}; w.moveTo(140, 120); w.resizeTo(820, 430); return true; })()`);
  await until(`JSON.stringify((ide.settings.get('popout.windows', {}).code || {}).Terminal?.bounds) !== ${S(firstBounds)}`, 'the new place remembered', 5000).catch(() => {});
  await sleep(800);
  const want = await js(`(() => { const w = ${pop('Terminal')}; return { x: w.screenX, y: w.screenY, width: w.outerWidth, height: w.outerHeight }; })()`);
  // Problems remembered on a monitor that is not there any more.
  await js(`(() => { const all = ide.settings.get('popout.windows', {}); ide.settings.set('popout.windows', { ...all, code: { ...all.code, Problems: { open: true, bounds: { x: -40000, y: -40000, width: 520, height: 300 } } } }); ide.settings.flush(); return true; })()`);
  await sleep(500);
  const { userData, project, results: before, consoleErrors: errorsBefore } = t;
  t.close();
  await sleep(1500);
  t = await launch({ fixture: 'core', port: PORT, name: 'popout', userData, projectDir: project });
  t.results.unshift(...before);
  t.consoleErrors.unshift(...errorsBefore);
  ({ js, until, check, cdp, press, type, sleep } = t);
  await until(`ide.popout.isOpen('Terminal') && ide.popout.isOpen('Problems')`, 'the windows back after the restart', 20000).catch(() => {});
  const again = await js(`(() => { const w = ${pop('Terminal')}; const p = ${pop('Problems')}; return w && p && {
    terminal: { x: w.screenX, y: w.screenY, width: w.outerWidth, height: w.outerHeight },
    problems: { x: p.screenX, y: p.screenY, width: p.outerWidth, height: p.outerHeight },
    screen: { left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight },
  }; })()`);
  const near = (a, b) => Math.abs(a - b) <= 2;
  record(!!again && near(again.terminal.x, want.x) && near(again.terminal.y, want.y) && near(again.terminal.width, want.width) && near(again.terminal.height, want.height),
    `after a restart the Terminal comes out again where it was, at its size (${S(want)} -> ${S(again?.terminal)})`);
  const sc = again?.screen;
  record(!!again && again.problems.x >= sc.left && again.problems.y >= sc.top && again.problems.x < sc.left + sc.width && again.problems.y < sc.top + sc.height,
    `a window saved on a screen that is gone comes back on the main window's screen (${S(again?.problems)} in ${S(sc)})`);
  record(await js(`!ide.toolWindows.get('Terminal').container.closest('#bottomBody')`), 'and its panel is in that window, not in the main one');
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length === 1 && /project>/.test(ide.terminal.text())`, 'a new shell in the restored window', 30000).catch(() => {});
  const term2 = await attachPage(PORT, titled('Terminal'));
  // Another bottom window shown since (the layout, a run) must not have hidden it: .active is the bottom panel's.
  record(await js(`!!${inPop('Terminal', '.popout-body > .tool')}?.getClientRects().length`), 'the restored window still shows its panel after the bottom panel switched windows');
  await mouse(term2.cdp, await rectIn(inPop('Terminal', '.term-session:not(.hidden) .xterm-screen')));
  await until(`${pop('Terminal')}.document.activeElement?.classList.contains('xterm-helper-textarea')`, 'the keyboard in the restored terminal', 5000).catch(() => {});
  await term2.type('echo AGAIN_9');
  await term2.press('Enter');
  await until(outputLine('AGAIN_9'), 'the echo in the restored window', 15000).catch(() => {});
  const restoredTerm = await js(`({ sessions: ide.terminal.sessions().length, there: !!${inPop('Terminal', '.term-session')}, focus: ${pop('Terminal')}.document.activeElement?.className, tail: ide.terminal.text().trimEnd().slice(-160) })`);
  record(await js(outputLine('AGAIN_9')) && restoredTerm.there, `a terminal opened after the restart runs in the restored window and takes typing there (${S(restoredTerm)})`);
  term2.close();

  // ---------- closing the main window closes them ----------
  const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'page').length;
  await js(`ide.api.invoke('window:closeNow')`).catch(() => {});
  let left = -1;
  for (let i = 0; i < 40; i++) {
    left = await pages().catch(() => 0);
    if (!left) break;
    await sleep(250);
  }
  record(left === 0, `closing the main window closes the tool windows' windows with it (${left} left)`);
} catch (err) {
  check(false, err.stack || err.message);
}
t.finish();
