// What using Code as a user turned up (2026-11-23), in one window on the core fixture. Every press is a CDP mouse or
// key event at the control's own place.
// Checks: the tree's menu keeps Run and Debug together and its groups apart, has Copy Path and Show in Explorer, and
// New HTTP Request and New Jupyter Notebook are in New ›; F2 renames the tree's row; the New Python File prompt says
// the folder and offers main.py only where there is none; Search Everywhere's Enter opens the first row though a
// slower group arrived above the first answer; in Find in Files the arrows choose a row and Enter opens it, and
// without a choice Enter still opens the Find window; a click on a line number sets and removes a breakpoint and
// leaves the caret, a drag over the numbers still selects lines; a problem's row copies its description. Port 9769.
// Usage: node verify/code-comfort.mjs
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'core', port: 9769 });
const { js, until, check, cdp, sleep, press, type, shot } = t;

const spotOf = async (expr) => {
  const spot = await js(`(() => {
    const n = ${expr};
    if (!n) return null;
    n.scrollIntoView?.({ block: 'nearest' });
    const r = n.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 60), y: r.y + r.height / 2 };
  })()`);
  if (!spot) throw new Error(`nothing at ${expr}`);
  return spot;
};
const mouseAt = async (x, y, button = 'left') => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  await sleep(80);
};
const mouse = async (expr, button) => { const { x, y } = await spotOf(expr); await mouseAt(x, y, button); };
const treeRow = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n._entry?.name === ${S(name)})`;
// the rows of an open menu: a label, or '---' for a line
const menuRows = (level = 0) => js(`[...document.querySelectorAll('.context-menu[data-level="${level}"] > *')].filter((n) => n.getClientRects().length)
  .map((n) => (n.classList.contains('menu-item') ? n.querySelector('.menu-label')?.textContent ?? n.firstChild.textContent : '---'))`);
const menuItem = (label, level = 0) => `[...document.querySelectorAll('.context-menu[data-level="${level}"] > .menu-item')].find((n) => (n.querySelector('.menu-label')?.textContent ?? n.firstChild.textContent) === ${S(label)})`;
const closeMenus = async () => { await js(`(ide.ui.closeMenus(), true)`); await sleep(80); };
const prompt = `(() => { const i = document.activeElement; return i?.tagName === 'INPUT' ? { value: i.value, hint: document.getElementById('popup')?.innerText || '' } : null; })()`;
const where = () => js(`({ file: ide.editor?.getModel()?.uri.path.split('/').pop() || null, line: ide.editor?.getPosition()?.lineNumber || 0, col: ide.editor?.getPosition()?.column || 0 })`);

try {
  await js(`(ide.toolWindows.get('Project').show(), true)`);
  await until(`!!(${treeRow('hello.py')})`, 'the tree', 10000);

  // ---------- the tree's menu ----------
  await mouse(treeRow('hello.py'), 'right');
  await until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'the menu of hello.py', 5000);
  const rows = await menuRows();
  const at = (label) => rows.findIndex((r) => r === label || r.startsWith(label));
  const run = at("Run '");
  const debug = at("Debug '");
  check(run >= 0 && debug === run + 1 && rows[run - 1] === '---', `Run and Debug are next to each other, after a line (${S(rows.slice(0, 6))})`);
  // the rows between two lines belong to one group
  const groupOf = (label) => (/^(Run|Debug) '/.test(label) ? 'run' : /^(Move…|Reformat Code|Optimize Imports)$/.test(label) ? 'edit' : /^(Compare|Git: Compare)/.test(label) ? 'compare'
    : /^(Git: |Local History: )/.test(label) ? 'vcs' : /^(Copy Path|Copy Relative Path|Show in Explorer|Open in Terminal)$/.test(label) ? 'open' : /^(Cut|Copy|Paste|Rename…|Delete)$/.test(label) ? 'clipboard' : /^New$/.test(label) ? 'new' : 'tools');
  const blocks = rows.join('\n').split('\n---\n').map((b) => [...new Set(b.split('\n').map(groupOf))]);
  check(blocks.every((b) => b.length === 1) && new Set(blocks.map((b) => b[0])).size === blocks.length, `every block of the menu is one group, and no group is in two blocks (${S(blocks)})`);
  check(['Copy Path', 'Copy Relative Path', 'Show in Explorer'].every((l) => rows.includes(l)), `a file's menu has Copy Path, Copy Relative Path and Show in Explorer (${S(rows.filter((r) => /Copy|Explorer/.test(r)))})`);
  check(!rows.includes('New HTTP Request') && !rows.includes('New Jupyter Notebook'), 'New HTTP Request and New Jupyter Notebook are not rows of the menu itself');
  await mouse(menuItem('New'));
  await until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'New ›', 5000);
  const made = await menuRows(1);
  check(made.includes('HTTP Request') && made.includes('Jupyter Notebook') && made.includes('Python File') && made.includes('Directory'), `they are in New › (${S(made)})`);
  await closeMenus();
  await mouse(treeRow('hello.py'), 'right');
  await until(`!!(${menuItem('Copy Relative Path')})`, 'the menu again', 5000);
  await mouse(menuItem('Copy Relative Path'));
  await until(`ide.api.invoke('clipboard:readText').then((x) => x === 'hello.py')`, 'the path on the clipboard', 5000).catch(() => {});
  check(await js(`ide.api.invoke('clipboard:readText')`) === 'hello.py', `Copy Relative Path copies the file's path in the project (${S(await js(`ide.api.invoke('clipboard:readText')`))})`);

  // ---------- F2 renames ----------
  await mouse(treeRow('hello.py'));
  await js(`(document.getElementById('tree').focus(), true)`);
  await press('F2');
  await until(`document.activeElement?.tagName === 'INPUT' && document.activeElement.value === 'hello.py'`, 'the rename field', 5000).catch(() => {});
  const renaming = await js(`({ tag: document.activeElement?.tagName, value: document.activeElement?.value, dialog: document.querySelector('.dialog-title')?.textContent || '' })`);
  check(renaming.tag === 'INPUT' && renaming.value === 'hello.py' && /Rename/.test(renaming.dialog), `F2 on the tree's row asks for its new name (${S(renaming)})`);
  await press('Escape');
  await until(`!document.querySelector('.dialog')`, 'the rename dialog closed', 5000);

  // ---------- the New Python File prompt ----------
  await mouse(treeRow('hello.py'));
  await js(`(ide.runAction('NewPythonFile'), true)`);
  await until(`!!(${prompt})`, 'the prompt at the root', 5000);
  const atRoot = await js(prompt);
  check(atRoot.value === 'main.py' && !/\(in /.test(atRoot.hint), `in the project folder without a main.py the prompt offers main.py and names no folder (${S(atRoot)})`);
  await press('Escape');
  writeFileSync(path.join(t.project, 'pkg', 'main.py'), 'print(1)\n');
  await js(`ide.refreshTree().then(() => ide.revealInTree(ide.util.joinPath(ide.root, 'pkg\\\\util.py'))).then(() => true)`);
  await until(`!!(${treeRow('util.py')})`, 'pkg open', 5000);
  await mouse(treeRow('util.py'));
  await js(`(ide.runAction('NewPythonFile'), true)`);
  await until(`!!(${prompt})`, 'the prompt in pkg', 5000);
  const inPkg = await js(prompt);
  check(inPkg.value === '' && /\(in pkg\)/.test(inPkg.hint), `in a folder the prompt says which, and offers no main.py where one is (${S(inPkg)})`);
  await type('extra');
  await press('Enter');
  await until(`ide.editor?.getModel()?.uri.path.endsWith('/pkg/extra.py')`, 'the new file open', 8000).catch(() => {});
  check(existsSync(path.join(t.project, 'pkg', 'extra.py')), 'and the file is made there');

  // ---------- Search Everywhere: Enter opens the first row ----------
  await openFile(t, 'hello.py');
  await js(`(ide.editor.focus(), true)`);
  await js(`(ide.runAction('SearchEverywhere'), true)`);
  await until(`document.activeElement?.closest('.se-popup')`, 'Search Everywhere', 5000);
  await type('greet');
  // the symbols come after the actions; the rows are complete when nothing is pending
  await until(`!document.querySelector('.se-indexing') && [...document.querySelectorAll('.se-row .se-label')].filter((r) => /greet/i.test(r.textContent)).length >= 2`, 'the rows for greet', 15000);
  await sleep(600);
  const active = await js(`(() => { const all = [...document.querySelectorAll('.se-row')]; return { index: all.findIndex((r) => r.classList.contains('active')), first: all[0].querySelector('.se-label').textContent, rows: all.slice(0, 4).map((r) => r.textContent.slice(0, 30)) }; })()`);
  check(active.index === 0, `the first row is the active one once every group has answered (${S(active)})`);
  await press('ArrowDown');
  const moved = await js(`[...document.querySelectorAll('.se-row')].findIndex((r) => r.classList.contains('active'))`);
  check(moved === 1, `the arrow keys move it (${moved})`);
  await press('ArrowUp');
  await press('Enter');
  await until(`!document.querySelector('.se-popup')`, 'Search Everywhere closed', 5000);
  await sleep(400);
  const word = await js(`ide.editor.getModel().getWordAtPosition(ide.editor.getPosition())?.word || null`);
  check(word === active.first, `Enter opens the first row (${S(active.first)}; the caret is on ${S(word)} in ${S((await where()).file)})`);

  // ---------- Find in Files: the arrows choose, Enter opens ----------
  await js(`(ide.editor.setPosition({ lineNumber: 1, column: 1 }), ide.editor.focus(), true)`);
  await js(`(ide.runAction('FindInPath'), true)`);
  await until(`document.activeElement?.id === 'snQuery'`, 'Find in Files', 5000);
  await press('Ctrl+a');
  await type('greet');
  await until(`document.querySelectorAll('#snPreview .sn-prow').length >= 3`, 'the matches', 10000);
  const list = await js(`[...document.querySelectorAll('#snPreview .sn-prow')].map((n) => n.querySelector('.sn-ploc').textContent)`);
  check(await js(`!document.querySelector('#snPreview .sn-prow.active')`), 'no row is chosen until an arrow key is pressed');
  await press('ArrowDown');
  await press('ArrowDown');
  const chosen = await js(`[...document.querySelectorAll('#snPreview .sn-prow')].findIndex((n) => n.classList.contains('active'))`);
  check(chosen === 1 && await js(`document.activeElement?.id === 'snQuery'`), `two presses of the down arrow choose the second row, the keyboard staying in the field (${chosen})`);
  await press('Enter');
  await until(`!document.querySelector('.dialog')`, 'the dialog closed', 5000);
  await sleep(300);
  const [file, line] = list[1].split(' ');
  const hit = await where();
  check(hit.file === file && hit.line === Number(line), `Enter opens the chosen match (${S(hit)}, the row was ${list[1]})`);
  check(await js(`!ide.toolWindows.get('FindInFiles')?.isVisible()`), 'and the Find window is not opened for it');
  await js(`(ide.editor.focus(), ide.runAction('FindInPath'), true)`);
  await until(`document.activeElement?.id === 'snQuery'`, 'Find in Files again', 5000);
  await until(`document.querySelectorAll('#snPreview .sn-prow').length >= 3`, 'the matches again', 10000);
  await press('Enter');
  await until(`!document.querySelector('.dialog') && ide.toolWindows.get('FindInFiles')?.isVisible()`, 'the Find window', 5000).catch(() => {});
  check(await js(`!!ide.toolWindows.get('FindInFiles')?.isVisible()`), 'without a chosen row Enter still opens the Find window');

  // ---------- a breakpoint by a click on the line number ----------
  await openFile(t, 'hello.py');
  await js(`(ide.editor.setPosition({ lineNumber: 2, column: 3 }), ide.editor.focus(), true)`);
  const number = (n) => js(`(() => { const e = ide.editor; const r = e.getDomNode().getBoundingClientRect(); const li = e.getLayoutInfo();
    return { x: r.x + li.lineNumbersLeft + li.lineNumbersWidth / 2, y: r.y + e.getTopForLineNumber(${n}) - e.getScrollTop() + 10 }; })()`);
  const bps = () => js(`window.__debugger.breakpoints().filter((b) => /hello\\.py$/.test(b.path)).map((b) => b.line)`);
  const p7 = await number(7);
  await mouseAt(p7.x, p7.y);
  await sleep(200);
  const set = { lines: await bps(), caret: await where() };
  check(S(set.lines) === '[7]' && set.caret.line === 2 && set.caret.col === 3, `a click on the number of line 7 sets a breakpoint there and leaves the caret (${S(set)})`);
  await mouseAt(p7.x, p7.y);
  await sleep(200);
  check(S(await bps()) === '[]', `a second click removes it (${S(await bps())})`);
  const p12 = await number(12);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p7.x, y: p7.y, button: 'none', buttons: 0 });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p7.x, y: p7.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p12.x, y: p12.y, button: 'left', buttons: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p12.x, y: p12.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  const dragged = { lines: await bps(), selection: await js(`(() => { const s = ide.editor.getSelection(); return [s.startLineNumber, s.endLineNumber]; })()`) };
  check(S(dragged.lines) === '[]' && dragged.selection[0] === 7 && dragged.selection[1] >= 12, `a drag over the numbers selects the lines and sets no breakpoint (${S(dragged)})`);

  // ---------- a problem's row copies its description ----------
  await openFile(t, 'broken.py');
  await js(`(ide.toolWindows.get('Problems').show(), true)`);
  await until(`!!document.querySelector('.problem .problem-msg')`, 'a problem of broken.py', 30000);
  const problem = await js(`(() => { const r = document.querySelector('.problem'); return { msg: r.querySelector('.problem-msg').textContent, at: r.querySelector('.problem-at').textContent.trim() }; })()`);
  await mouse(`document.querySelector('.problem .problem-msg')`, 'right');
  await until(`!!(${menuItem('Copy Problem Description')})`, "the problem's menu", 5000);
  await mouse(menuItem('Copy Problem Description'));
  await until(`ide.api.invoke('clipboard:readText').then((x) => x.startsWith('broken.py:'))`, 'the description on the clipboard', 5000).catch(() => {});
  const copied = await js(`ide.api.invoke('clipboard:readText')`);
  check(copied.startsWith(`broken.py:${problem.at}: ${problem.msg}`), `a problem's row copies where it is and what it says (${S(copied)})`);

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
  const internal = await js(`ide.api.invoke('diagnostics:errors')`);
  check(!internal.length, `no IDE internal errors${internal.length ? ` ${S(internal).slice(0, 1500)}` : ''}`);
} catch (err) {
  check(false, `code-comfort crashed: ${err.stack || err}`);
  await shot('crash.png').catch(() => {});
}
await t.finish();
