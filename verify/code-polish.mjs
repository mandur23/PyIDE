// Small Code fixes in one window on the core fixture. Every press goes through Input.dispatchMouseEvent or a CDP key at a
// spot elementFromPoint says is the control. Checks: Ctrl+Tab after clicking into the other split's text; Reopen Closed
// Tab after a non-file tab was closed; the status bar's selection size; a bookmark's description cleared; the tree's
// selection after Delete and Rename; Replace All pressed twice replacing once; a balloon held while the pointer is on
// it; the Run console's emulated terminal following the theme; Maven without a wrapper never running the project's
// mvn.cmd; Find in Files forgetting the last project's matches. Port 9736.
// Usage: node verify/code-polish.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'core', port: 9736 });
const { js, until, check, cdp, sleep, press, type, shot } = t;
const inProject = (...p) => path.join(t.project, ...p);
const write = (p, text) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };

const spotOf = async (expr) => {
  const spot = await js(`(() => {
    const n = ${expr};
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const x = r.x + Math.min(r.width / 2, 60);
    const y = r.y + Math.min(r.height / 2, 30);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (n === hit || n.contains(hit)), under: hit ? String(hit.className || hit.tagName) : 'nothing' };
  })()`);
  if (!spot) throw new Error(`nothing at ${expr}`);
  if (!spot.hit) throw new Error(`${spot.under} covers ${expr}`);
  return spot;
};
const mouse = async (expr, { button = 'left', twice = false } = {}) => {
  const { x, y } = await spotOf(expr);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  for (let i = 0; i < (twice ? 2 : 1); i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  }
  await sleep(80);
};
const activeName = () => js(`ide.activeTab()?.title || ''`);
const closeAll = () => js(`(() => { for (let i = 0; i < 5 && ide.tabs.length; i++) ide.tabs.slice().forEach((x) => ide.closeTabObject(x, true)); return true; })()`);
const treeRow = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n._entry?.name === ${S(name)})`;
const selectedRow = () => js(`document.querySelector('#tree .node.selected')?._entry?.name || null`);

try {
  // ---------- Ctrl+Tab after clicking into the other split ----------
  await openFile(t, 'hello.py');
  await js(`(ide.runAction('SplitVertically'), true)`);
  await until(`document.querySelectorAll('.editor-group').length === 2`, 'two splits');
  await openFile(t, 'pkg/util.py');
  await mouse(`document.querySelectorAll('.editor-group')[0].querySelector('.view-lines')`);
  await until(`document.activeElement?.closest('.editor-group') === document.querySelectorAll('.editor-group')[0]`, 'the left split has the keyboard');
  check(await activeName() === 'hello.py', 'clicking into the left split\'s text makes its hello.py the active tab');
  await press('Ctrl+Tab');
  await until(`ide.activeTab()?.title === 'util.py'`, 'Ctrl+Tab', 3000).catch(() => {});
  check(await activeName() === 'util.py', `Ctrl+Tab then goes back to util.py in the other split (${await activeName()})`);
  await js(`(ide.runAction('UnsplitAll'), true)`).catch(() => {});
  await closeAll();

  // ---------- Reopen Closed Tab after a non-file tab ----------
  await openFile(t, 'hello.py');
  // Closed at once, Monaco's editor worker can still be loading and reports a failed importScripts (seen here, not
  // caused by Reopen Closed Tab): a person reads the file a moment first.
  await sleep(1500);
  await closeAll();
  await js(`(ide.runAction('WorkspaceHome'), true)`);
  await until(`!!ide.activeTab() && ide.activeTab().kind === 'custom'`, 'the Workspace home tab', 10000);
  await closeAll();
  await js(`(ide.runAction('ReopenClosedTab'), true)`);
  await until(`ide.activeTab()?.title === 'hello.py'`, 'reopened', 5000).catch(() => {});
  check(await activeName() === 'hello.py', `Reopen Closed Tab brings back hello.py although the Workspace tab was closed after it (${await activeName()})`);

  // ---------- the status bar: the selection's size ----------
  await openFile(t, 'hello.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await sleep(100);
  check(await js(`document.getElementById('statusPos').textContent`) === '1:1', 'without a selection the status bar shows line:column');
  for (let i = 0; i < 6; i++) await press('Shift+ArrowRight');
  check(await js(`document.getElementById('statusPos').textContent`) === '1:7 (6 chars)', `a selection on one line adds its length (${await js(`document.getElementById('statusPos').textContent`)})`);
  await press('Shift+ArrowDown');
  const both = await js(`document.getElementById('statusPos').textContent`);
  const expect = await js(`(() => { const m = ide.editor.getModel(); return m.getLineLength(1) + 1 + 6; })()`);
  check(both === `2:7 (${expect} chars, 1 line break)`, `over two lines it counts the line break too (${both})`);
  await press('ArrowLeft');
  check(await js(`document.getElementById('statusPos').textContent`) === '1:1', 'and goes back to line:column when the selection goes');

  // ---------- a bookmark's description cleared ----------
  await js(`(ide.editor.setPosition({ lineNumber: 2, column: 1 }), ide.bookmarks.toggle(), ide.bookmarks.show(), true)`);
  await until(`!!document.querySelector('.bm-row')?.offsetParent`, 'the bookmark in the Bookmarks window', 5000);
  const editButton = `[...document.querySelectorAll('button')].find((b) => b.title.startsWith('Edit Description') && b.offsetParent)`;
  await mouse(`document.querySelector('.bm-row')`);
  await mouse(editButton);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'the description box', 3000);
  await type('my note');
  await press('Enter');
  await until(`ide.bookmarks.list()[0]?.description === 'my note'`, 'a description', 3000);
  check(await js(`document.querySelector('.bm-row .bm-text').textContent`) === 'my note', 'a description shows in the Bookmarks window');
  await mouse(`document.querySelector('.bm-row')`);
  await mouse(editButton);
  await until(`!document.getElementById('popup').classList.contains('hidden') && document.getElementById('popupIn').value === 'my note'`, 'the box with the description', 3000);
  await press('Ctrl+A');
  await press('Backspace');
  await press('Enter');
  await sleep(200);
  const cleared = await js(`({ d: ide.bookmarks.list()[0]?.description ?? null, row: document.querySelector('.bm-row .bm-text')?.textContent })`);
  check(cleared.d === null && cleared.row === 'from pkg.util import greet', `emptying the box and pressing Enter removes the description (${S(cleared)})`);
  await mouse(`document.querySelector('.bm-row')`);
  await mouse(editButton);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'the box again', 3000);
  await type('kept');
  await press('Escape');
  check(await js(`ide.bookmarks.list()[0]?.description ?? null`) === null, 'Escape still changes nothing');
  await js(`(ide.bookmarks.toggle(), true)`);

  // ---------- the tree after Delete and Rename ----------
  for (const n of ['x1.txt', 'x2.txt', 'x3.txt']) write(inProject('deltest', n), `${n}\n`);
  await js(`ide.refreshTree().then(() => ide.revealInTree(ide.util.joinPath(ide.root, 'deltest\\\\x2.txt'))).then(() => true)`);
  await js(`(ide.toolWindows.get('Project').show(), true)`);
  await until(`!!(${treeRow('x2.txt')})`, 'x2.txt in the tree', 5000);
  await mouse(treeRow('x2.txt'));
  await until(`document.querySelector('#tree .node.selected')?._entry?.name === 'x2.txt'`, 'x2 selected', 3000);
  await press('Delete');
  const deleteButton = `[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Delete')`;
  await until(`!!(${deleteButton})`, 'the Delete question', 5000);
  await mouse(deleteButton);
  await until(`!(${treeRow('x2.txt')})`, 'x2.txt gone', 10000);
  await sleep(200);
  check(await selectedRow() === 'x3.txt', `after Delete the next row is selected (${await selectedRow()})`);
  await press('ArrowUp');
  check(await selectedRow() === 'x1.txt', `and the arrow keys go on from there, not from the top (${await selectedRow()})`);
  await js(`ide.moveTreeEntry([...document.querySelectorAll('#tree .node')].find((n) => n._entry?.name === 'x1.txt')._entry, ide.util.joinPath(ide.root, 'deltest\\\\renamed.txt')).then(() => true)`);
  await until(`!!(${treeRow('renamed.txt')})`, 'the renamed row', 5000);
  check(await selectedRow() === 'renamed.txt', `a renamed row keeps the selection under its new name (${await selectedRow()})`);

  // ---------- Replace All pressed twice ----------
  write(inProject('rep.txt'), 'foo\n');
  await js(`(ide.editor?.focus(), true)`);
  await press('Ctrl+Shift+R');
  await until(`!!document.querySelector('#snReplace') && document.activeElement?.id === 'snQuery'`, 'Replace in Files', 5000);
  await js(`(() => { const q = document.getElementById('snQuery'); q.value = ''; return true; })()`);
  await type('foo');
  await mouse(`document.getElementById('snReplace')`);
  await type('foo_bar');
  await until(`/1 match/.test(document.querySelector('.dialog')?.textContent || '')`, 'the preview', 5000).catch(() => {});
  const replaceAll = `[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Replace All')`;
  await mouse(replaceAll, { twice: true });
  const replaceAnswer = `[...[...document.querySelectorAll('#dialogHost .dialog')].pop().querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Replace')`;
  await until(`/^Replace \\d+ occurrences? in \\d+ files?\\?$/.test([...document.querySelectorAll('#dialogHost .dialog-message')].pop()?.textContent || '')`, 'the question', 10000);
  await mouse(replaceAnswer);
  await until(`!document.querySelector('#snReplace')`, 'the dialog closed', 10000);
  await sleep(500);
  const replaced = readFileSync(inProject('rep.txt'), 'utf8');
  check(replaced === 'foo_bar\n', `two quick presses of Replace All replace once (${S(replaced)})`);

  // ---------- a balloon held while the pointer is on it ----------
  await js(`(ide.notifications.notify({ title: 'Hold me', text: 'Read this slowly.', timeout: 1500 }), true)`);
  const balloon = `[...document.querySelectorAll('.ide-balloon')].find((b) => b.textContent.includes('Hold me'))`;
  await until(`!!(${balloon})`, 'the balloon', 3000);
  const at = await spotOf(balloon);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 });
  await sleep(2500);
  check(await js(`!!(${balloon})`), 'a balloon under the pointer stays past its time');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300, button: 'none', buttons: 0 });
  await sleep(2500);
  check(!(await js(`!!(${balloon})`)), 'and goes a moment after the pointer leaves');

  // ---------- the Run console's emulated terminal follows the theme ----------
  write(inProject('waits.py'), 'import time\nprint("waiting")\ntime.sleep(60)\n');
  await js(`ide.run.runConfig({ ...ide.run.types.get('python').defaults(), id: 'cfg-term', type: 'python', name: 'waits', emulateTerminal: true, script: ide.util.joinPath(ide.root, 'waits.py') }).then(() => true)`);
  await until(`!!document.querySelector('.run-session:not(.hidden) .run-term .xterm-viewport')`, 'the emulated terminal', 20000);
  // The terminal's own background is see-through (the panel's shows), so the text and cursor colours are what changes.
  const termInk = () => js(`(() => { const box = document.querySelector('.run-session:not(.hidden) .run-term');
    return { text: getComputedStyle(box.querySelector('.xterm-rows')).color, cursor: getComputedStyle(box.querySelector('.xterm-cursor') || box).backgroundColor }; })()`);
  const textVar = () => js(`(() => { const d = document.createElement('div'); d.style.color = 'var(--text)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
  await until(`(document.querySelector('.run-session:not(.hidden) .run-term')?.textContent || '').includes('waiting')`, 'the program printed', 20000);
  const dark = await termInk();
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme', 5000);
  await sleep(400);
  const light = await termInk();
  check(light.text !== dark.text && light.text === await textVar() && light.cursor !== dark.cursor, `the Run terminal's text and cursor take the light theme's colours (${S(dark)} -> ${S(light)})`);
  await shot('run-terminal-light.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`document.documentElement.dataset.theme === 'dark'`, 'dark theme', 5000);
  await sleep(400);
  check(S(await termInk()) === S(dark), 'and the dark ones again');
  await js(`(ide.run.sessions().forEach((s) => s.stop?.()), true)`);

  // ---------- Maven without a wrapper: never the project's mvn.cmd ----------
  const proj = tempDir('code-polish-mvn');
  const tools = tempDir('code-polish-tools');
  write(path.join(proj, 'mvn.cmd'), `@echo off\r\necho ran> "${path.join(proj, 'planted-ran.txt')}"\r\n`);
  write(path.join(tools, 'mvn.cmd'), `@echo off\r\necho ran> "${path.join(tools, 'real-ran.txt')}"\r\necho REAL-MAVEN %*\r\n`);
  const build = (env) => js(`new Promise((resolve) => ide.api.invoke('toolchains:build', ${S({ tool: 'maven', cwd: proj, goals: 'clean', env })})
    .then((r) => {
      let out = '';
      ide.proc.attach(r.id, { data: (d) => { out += d; }, exit: (code) => resolve({ command: r.command, out, code }) });
      setTimeout(() => resolve({ command: r.command, out, code: 'timeout' }), 20000);
    }, (e) => resolve({ command: '', out: e.message, code: 'refused' })))`);
  const withTools = await build({ PATH: `${tools};C:\\Windows\\System32` });
  check(existsSync(path.join(tools, 'real-ran.txt')) && !existsSync(path.join(proj, 'planted-ran.txt')) && withTools.command.includes(path.join(tools, 'mvn.cmd')),
    `Maven on PATH runs, named by its full path, and the project's mvn.cmd does not (${S(withTools.command)})`);
  const none = await build({ PATH: 'C:\\Windows\\System32' });
  check(!existsSync(path.join(proj, 'planted-ran.txt')) && none.code !== 0 && none.code !== 'timeout', `with no Maven on PATH the run fails instead of running the project's mvn.cmd (exit ${none.code}, ${S(none.out.trim().slice(0, 120))})`);

  // ---------- Find in Files forgets the last project's matches ----------
  await closeAll();
  await press('Ctrl+Shift+F');
  await until(`!!document.getElementById('snQuery') && document.activeElement?.id === 'snQuery'`, 'Find in Files', 5000);
  await js(`(document.getElementById('snQuery').value = '', true)`);
  await type('greet');
  await press('Enter');
  await until(`document.querySelectorAll('#snFindResults .sn-match').length > 0`, 'matches in the core project', 10000);
  const other = tempDir('code-polish-other');
  write(path.join(other, 'other.py'), 'print("other")\n');
  await js(`ide.openProject(${S(other)}).then(() => true)`);
  await until(`ide.util.samePath(ide.root, ${S(other)})`, 'the other project', 15000);
  await js(`(ide.toolWindows.get('FindInFiles').show(), true)`);
  const after = await js(`({ matches: document.querySelectorAll('#snFindResults .sn-match').length, head: document.getElementById('snFindHead').textContent })`);
  check(after.matches === 0 && /Use .*Find in Files/.test(after.head), `in another project the Find window no longer lists the last project's matches (${S(after)})`);

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
  const internal = await js(`ide.api.invoke('diagnostics:errors')`);
  check(!internal.length, `no IDE internal errors${internal.length ? ` ${S(internal).slice(0, 1500)}` : ''}`);
} catch (err) {
  check(false, `code-polish crashed: ${err.stack || err}`);
  await shot('crash.png').catch(() => {});
}
await t.finish();
