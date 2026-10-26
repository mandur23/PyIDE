// White-box test of the editor context menu: drives each branch of ownActions (editors.js), editorMenuItems and
// pasteInto (mainmenu.js) and ide.ui.contextMenu's handler guard (ide.js) on purpose, checks what each branch should
// do, and then reports V8 block coverage of the lines changed since a git revision (`node verify/whitebox-context-menu.mjs
// [base]`, default HEAD: the uncommitted changes; after a commit pass its parent): any changed block that never ran
// fails the suite. Port 9299.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, menuRow, openFile } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['renderer/core/editors.js', 'renderer/core/mainmenu.js', 'renderer/core/ide.js'];
const J = JSON.stringify;
const BASE = process.argv[2] || 'HEAD';

const t = await launch({ fixture: 'nav-tests', port: 9299, name: 'whitebox-context-menu' });
const { js, until, check, sleep, cdp, press } = t;
await cdp('Profiler.enable');
await cdp('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

const menu = `(() => { const m = document.querySelector('.context-menu[data-level="0"]'); return m && [...m.querySelectorAll(':scope > .menu-item .menu-label')].map((n) => n.textContent); })()`;
const sub = `(() => { const m = document.querySelector('.context-menu[data-level="1"]'); return m && [...m.querySelectorAll(':scope > .menu-item .menu-label')].map((n) => n.textContent); })()`;
const at = (editor, line, column) => js(`(() => { const e = ${editor}; const p = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: ${column} }); const r = e.getDomNode().getBoundingClientRect(); return { x: r.x + p.left + 2, y: r.y + p.top + p.height / 2 }; })()`);
async function mouse(p, button = 'right') {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  if (button) for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, clickCount: 1 });
}
async function close() {
  for (let i = 0; i < 3 && await js(`!!document.querySelector('.context-menu')`); i++) { await sleep(80); await press('Escape'); }
  await until(`!document.querySelector('.context-menu')`, 'menu closed');
}
async function openSub(label) {
  const p = await js(`(() => { const r = ${menuRow(label)}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await mouse(p, null);
  await until(`!!${sub}`, `${label} submenu`);
  return js(sub);
}
const caret = () => js(`(() => { const p = ide.editor.getPosition(); return p.lineNumber + ':' + p.column; })()`);
const setSel = (sl, sc, el, ec) => js(`(ide.editor.setSelection(new ide.monaco.Selection(${sl}, ${sc}, ${el}, ${ec})), ide.editor.focus(), true)`);

try {
  await openFile(t, 'shapes/figures.py');
  await until(`ide.actions.some((a) => a.id === 'OverrideMethods') && ide.actions.some((a) => a.id === 'RenameElement')`, 'plugins loaded');
  const ED = 'ide.editor';

  // ownActions › addAction: listed with a contextMenuGroupId, not without; an unnamed listed one lands at the end.
  await js(`(ide.editor.addAction({ id: 'wb.listed', label: 'WB Listed', contextMenuGroupId: 'zz', run() { window.__wb = 'listed'; } }),
    ide.editor.addAction({ id: 'wb.hidden', label: 'WB Hidden', run() {} }), true)`);
  const listed = await js(`ide.editorMenuActions(ide.editor).map((a) => a.id)`);
  check(listed.includes('wb.listed') && !listed.includes('wb.hidden'), 'addAction records only actions with a contextMenuGroupId');
  check(J(await js(`ide.editorMenuActions({})`)) === '[]', 'editorMenuActions of an editor the core did not make is empty');

  // A row's hover timer outlives a click on it: it must not close the submenu of the menu opened next.
  await js(`(() => { const items = () => [{ label: 'plain', run() {} }, { label: 'more', submenu: [{ label: 'inner', run() {} }] }];
    ide.ui.contextMenu(100, 100, items());
    const row = (l) => [...document.querySelectorAll('.context-menu[data-level="0"] .menu-item')].find((n) => n.textContent.startsWith(l));
    row('plain').dispatchEvent(new MouseEvent('mouseenter'));
    row('plain').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    ide.ui.contextMenu(100, 100, items());
    row('more').dispatchEvent(new MouseEvent('mouseenter'));
    return true; })()`);
  await sleep(400);
  check(await js(`!!document.querySelector('.context-menu[data-level="1"]')`), "a timer left by a clicked item does not close the next menu's submenu");
  await close();

  // onContextMenu › no selection: the caret moves to the click.
  await setSel(1, 1, 1, 1);
  await mouse(await at(ED, 5, 9));
  await until(`!!${menu}`, 'menu, empty selection');
  check(await caret() === '5:9', `a right click with no selection moves the caret there (${await caret()})`);
  const top = await js(menu);
  check(top.at(-1) === 'WB Listed', `an unnamed plugin action with a group comes last (${top.at(-1)})`);
  check(!top.includes('Git'), 'needs: Git is left out outside a repository');
  check(top.includes('Show Context Actions') && top.includes('Run Context Configuration'), 'when: a Python tab shows the Python-only and tab-only actions');
  check(J(await openSub('Local History')) === J(['Show History', 'Put Label…']), 'label overrides the IDE action\'s title in Local History');
  await close();

  // onContextMenu › inside a non-empty selection: kept; outside: the caret moves.
  await setSel(1, 1, 1, 12);
  await mouse(await at(ED, 1, 5));
  await until(`!!${menu}`, 'menu inside the selection');
  check(await js(`!ide.editor.getSelection().isEmpty()`), 'a right click inside the selection keeps it');
  await close();
  await mouse(await at(ED, 4, 2));
  await until(`!!${menu}`, 'menu outside the selection');
  check(await js(`ide.editor.getSelection().isEmpty()`) && (await caret()).startsWith('4:'), 'a right click outside the selection moves the caret');
  await close();

  // onContextMenu › outside the text (the gutter): no editor menu, the gutter's right click is the debugger's.
  await mouse(await js(`(() => { const r = ide.editor.getDomNode().querySelector('.margin .line-numbers').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  await sleep(300);
  check(await js(`!document.querySelector('.context-menu')`), 'a right click in the gutter opens no editor menu');
  await js(`(document.querySelector('#dbgBpCondition') && document.querySelector('#dbgBpCondition').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), ide.ui.closeMenus(), true)`);

  // Keyboard listener › a right-button contextmenu is left to Monaco; a target outside the editor is ignored; the
  // Menu key opens the menu at the caret without moving it.
  await js(`(ide.editor.setPosition({ lineNumber: 5, column: 9 }), ide.editor.focus(), true)`);
  await js(`(ide.editor.getContainerDomNode().dispatchEvent(new MouseEvent('contextmenu', { button: 0, bubbles: true, cancelable: true })), true)`);
  await sleep(150);
  check(await js(`!document.querySelector('.context-menu')`), 'a contextmenu on the container outside the editor opens no menu');
  await js(`(ide.editor.getDomNode().querySelector('.view-lines').dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true, clientX: 1, clientY: 1 })), true)`);
  await sleep(150);
  await js(`(ide.ui.closeMenus(), true)`);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93 });
  await until(`!!${menu}`, 'menu from the Menu key');
  check(await caret() === '5:9', `the Menu key leaves the caret (${await caret()})`);
  await close();

  // run entries: Paste with an empty clipboard types nothing; with text it types it.
  await js(`ide.api.invoke('clipboard:writeText', '')`);
  const before = await js(`ide.editor.getModel().getValue()`);
  await setSel(1, 1, 1, 1);
  await mouse(await at(ED, 1, 1));
  await until(`!!${menuRow('Paste')}`, 'Paste row');
  const pasteAt = await js(`(() => { const r = ${menuRow('Paste')}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await mouse(pasteAt, 'left');
  await sleep(300);
  check(await js(`ide.editor.getModel().getValue()`) === before, 'Paste with an empty clipboard leaves the text');

  // A plain-text tab: `when` (editorPython) hides Show Context Actions and Override Methods, Generate empties out.
  await js(`ide.api.write(ide.util.joinPath(ide.root, 'notes.txt'), 'plain text\\nsecond line\\n')`);
  await openFile(t, 'notes.txt');
  await mouse(await at(ED, 1, 3));
  await until(`!!${menu}`, 'menu in a text file');
  const txt = await js(menu);
  check(!txt.includes('Show Context Actions') && !txt.includes('Find Usages'), `when false hides Python-only actions in a .txt tab (${txt.join(' | ')})`);
  check(!txt.includes('Run Context Configuration'), 'a .txt tab has nothing to run, so no Run Context Configuration');
  await close();

  // Embedded editors: a writable one runs Cut/Copy/Paste through run(editor); a read-only one leaves out Cut and Paste.
  await js(`(() => { for (const ro of [false, true]) { const host = document.createElement('div'); host.className = 'wb-host';
    host.style.cssText = 'position:fixed;left:40px;top:' + (ro ? 420 : 300) + 'px;width:420px;height:90px;z-index:50';
    document.body.append(host);
    const e = ide.createEditor(host, { model: ide.monaco.editor.createModel('abc def\\nxyz\\n', 'plaintext'), readOnly: ro });
    window[ro ? '__wbRO' : '__wbRW'] = e; } return true; })()`);
  await until(`!!window.__wbRO?.getDomNode() && !!window.__wbRW?.getDomNode()`, 'embedded editors');
  await sleep(300);
  await js(`(__wbRW.setSelection(new ide.monaco.Selection(1, 1, 1, 4)), __wbRW.focus(), true)`);
  await mouse(await at('__wbRW', 1, 2));
  await until(`!!${menu}`, 'menu in a writable embedded editor');
  const rw = await js(menu);
  check(rw[0] === 'Cut' && rw.includes('Copy') && rw.includes('Paste') && !rw.includes('Run Context Configuration'), `a writable embedded editor: Cut, Copy, Paste, no tab actions (${rw.join(' | ')})`);
  const rwSpecial = await openSub('Copy / Paste Special');
  check(rwSpecial.includes('Paste from History…'), `a writable editor keeps Paste from History (${rwSpecial.join(' | ')})`);
  await mouse(await js(`(() => { const r = ${menuRow('Copy')}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`), 'left');
  await until(`!document.querySelector('.context-menu')`, 'Copy ran');
  await js(`(__wbRW.setPosition({ lineNumber: 2, column: 4 }), __wbRW.focus(), true)`);
  await mouse(await at('__wbRW', 2, 4));
  await until(`!!${menuRow('Paste')}`, 'Paste in the writable embedded editor');
  await mouse(await js(`(() => { const r = ${menuRow('Paste')}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`), 'left');
  await until(`__wbRW.getModel().getLineContent(2) === 'xyzabc'`, 'pasted').then(() => check(true, 'run(editor): Copy then Paste act on the embedded editor'),
    async () => check(false, `run(editor): Copy then Paste (${J(await js('__wbRW.getModel().getValue()'))})`));
  await mouse(await at('__wbRO', 1, 2));
  await until(`!!${menu}`, 'menu in a read-only embedded editor');
  const ro = await js(menu);
  check(ro.includes('Copy') && !ro.includes('Cut') && !ro.includes('Paste'), `edits: a read-only embedded editor offers Copy only (${ro.join(' | ')})`);
  const roSpecial = await openSub('Copy / Paste Special');
  check(!roSpecial.includes('Paste from History…'), `a read-only editor's Copy / Paste Special has no Paste from History (${roSpecial.join(' | ')})`);
  await close();
  await js(`(document.querySelectorAll('.wb-host').forEach((h) => h.remove()), __wbRW.dispose(), __wbRO.dispose(), true)`);

  // ide.ui.contextMenu opened twice in one task: only the second menu's key handlers are added.
  await js(`(ide.ui.contextMenu(100, 100, [{ label: 'a', run() {} }, { label: 'b', run() {} }, { label: 'c', run() {} }]),
    ide.ui.contextMenu(100, 100, [{ label: 'a', run() {} }, { label: 'b', run() {} }, { label: 'c', run() {} }]), true)`);
  await sleep(100);
  await press('ArrowDown');
  await press('ArrowDown');
  check(await js(`[...document.querySelectorAll('.context-menu .menu-item')].findIndex((n) => n.classList.contains('active'))`) === 1, 'a menu opened twice in one task moves one row per key');
  await close();

  // needs passes in a repository: Git appears, with Annotate (vcsRepo) and not Close Annotations (vcsAnnotated).
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: t.project, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await until(`!document.querySelector('.vcs-branch')?.classList.contains('hidden')`, 'repository detected', 20000);
  await openFile(t, 'shapes/figures.py');
  for (let i = 0; i < 20 && !(await js(`ide.editor.getAction('vcs.showHistory')?.isSupported()`)); i++) await sleep(250);
  await mouse(await at(ED, 2, 3));
  await until(`!!${menuRow('Git')}`, 'Git in a repository').then(() => check(true, 'needs: Git appears in a repository'), () => check(false, 'needs: Git appears in a repository'));
  const gitSub = await openSub('Git').catch(() => []);
  check(gitSub.includes('Annotate with Git Blame') && !gitSub.includes('Close Annotations'), `an editor action's precondition picks Annotate, not Close Annotations (${gitSub.join(' | ')})`);
  await close();
} catch (err) {
  check(false, err.message);
}

// Block coverage of the changed lines.
const result = (await cdp('Profiler.takePreciseCoverage')).result?.result || [];
for (const file of FILES) {
  const changed = new Set();
  for (const m of execFileSync('git', ['diff', '-U0', BASE, '--', file], { cwd: ROOT, encoding: 'utf8' }).matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    for (let i = 0; i < Number(m[2] ?? 1); i++) changed.add(start + i);
  }
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const script = result.find((s) => decodeURIComponent(s.url).replace(/\\/g, '/').endsWith(file));
  if (!script) { check(false, `${file}: no coverage (script not loaded)`); continue; }
  const ranges = script.functions.flatMap((f) => f.ranges);
  const countAt = (off) => ranges.filter((r) => r.startOffset <= off && off < r.endOffset).sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0]?.count;
  const code = [...changed].filter((n) => { const s = src.slice(lineStarts[n - 1], lineStarts[n] ?? src.length).trim(); return s && !s.startsWith('//') && !s.startsWith('/*') && !s.startsWith('*') && !/^[\]})]+[;,)]*$/.test(s); });
  const missed = code.filter((n) => { const s = lineStarts[n - 1]; const first = s + src.slice(s).search(/\S/); return countAt(first) === 0; });
  if (!code.length) check(false, `${file}: no changed lines since ${BASE}`);
  console.log(`coverage ${file}: ${code.length - missed.length}/${code.length} changed code lines ran`);
  for (const n of missed) console.log(`  not run ${n}: ${src.slice(lineStarts[n - 1], lineStarts[n]).trim().slice(0, 140)}`);
  check(!missed.length, `${file}: every changed block ran (${missed.length ? missed.join(', ') : 'all'})`);
}
t.finish();
