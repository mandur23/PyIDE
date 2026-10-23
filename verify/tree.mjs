// Project tree: virtualized rows, incremental expand/collapse, keyboard navigation, drag and drop, decorators,
// context menu, reveal, and open folders restored after a restart.
import { launch } from './lib.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const BIG = 3000;
const t = await launch({ fixture: 'tree', port: 9760 });
const { js, until, press, check, sleep } = t;
const q = JSON.stringify;
// Project rows only: top-level nodes after the project (Scratches and Consoles) are left out.
const names = `[...document.querySelectorAll('#tree .node:not(.tree-extra) .name')].map((n) => n.textContent)`;
const row = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name').textContent === ${q(name)})`;
const selectedName = `document.querySelector('#tree .node.selected .name')?.textContent`;

try {
  mkdirSync(path.join(t.project, 'big'));
  for (let i = 0; i < BIG; i++) writeFileSync(path.join(t.project, 'big', `f${String(i).padStart(4, '0')}.py`), `x = ${i}\n`);
  await js(`ide.refreshTree()`);
  await until(`${names}.includes('big')`, 'big folder listed');
  check(await js(`${names}.join(',') === 'project,big,docs,pkg,main.py'`), 'folders first, then files');

  await js(`${row('big')}.click()`);
  await until(`${names}.includes('f0000.py')`, 'big folder expanded');
  check(await js(`document.querySelectorAll('#tree .node').length < 120`), `a ${BIG}-file folder draws only the rows in view (${await js(`document.querySelectorAll('#tree .node').length`)})`);
  await js(`document.getElementById('tree').scrollTop = 1e9`);
  await until(`${names}.includes('main.py') && ${names}.includes('f2999.py')`, 'scrolled to the end');
  check(true, 'scrolling to the end draws the last rows');
  await js(`document.getElementById('tree').scrollTop = 0`);
  await until(`!!${row('big')}`, 'scrolled back to the top');
  await js(`${row('big')}.click()`);
  await until(`!${names}.includes('f0000.py')`, 'big folder collapsed');
  check(await js(`${names}.join(',') === 'project,big,docs,pkg,main.py'`), "collapsing removes only that folder's rows");

  // Keyboard: pkg was clicked open; Down enters it, Right opens and enters sub, Enter opens b.py.
  await js(`${row('pkg')}.click()`);
  await until(`${names}.includes('a.py')`, 'pkg expanded');
  await js(`document.getElementById('tree').focus()`);
  await press('ArrowDown');
  check(await js(`${selectedName} === 'sub'`), 'Down selects the next row');
  await press('ArrowRight');
  await until(`${names}.includes('b.py')`, 'Right opens a folder');
  check(await js(`${selectedName} === 'sub'`), 'Right on a closed folder opens it and keeps the selection');
  await press('ArrowRight');
  check(await js(`${selectedName} === 'b.py'`), 'Right on an open folder moves into it');
  await press('ArrowLeft');
  check(await js(`${selectedName} === 'sub'`), 'Left on a file moves to its folder');
  await press('ArrowLeft');
  await until(`!${names}.includes('b.py')`, 'Left closes a folder');
  check(true, 'Left on an open folder closes it');
  await press('ArrowUp');
  check(await js(`${selectedName} === 'pkg'`), 'Up selects the previous row');
  // The last row is main.py, or Scratches and Consoles (a sibling of the project root) with the scratches plugin.
  const extraRoot = await js(`!!document.querySelector('#tree .node.tree-extra')`);
  await press('End');
  check(await js(`${selectedName} === ${q(extraRoot ? 'Scratches and Consoles' : 'main.py')}`), 'End selects the last row');
  await press('Home');
  check(await js(`${selectedName} === 'project'`), 'Home selects the root');
  await press('End');
  if (extraRoot) await press('ArrowUp');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'main.py'`, 'Enter opens the file');
  check(true, 'Enter on a file opens it');
  await js(`ide.activeTab().model.setValue('print("edited")\\n')`);

  // Decorators and the context menu.
  await js(`ide.registerTreeDecorator((e) => (e.name === 'a.py' ? { color: 'rgb(1, 2, 3)', badge: 'deco' } : null)), ide.refreshTree()`);
  await until(`getComputedStyle(${row('a.py')}.querySelector('.name')).color === 'rgb(1, 2, 3)'`, 'decorator color');
  check(await js(`${row('a.py')}.querySelector('.tree-badge')?.textContent === 'deco'`), 'decorators color rows and add badges');
  await js(`(() => { const n = ${row('a.py')}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await until(`!!document.querySelector('.context-menu')`, 'tree context menu');
  check(await js(`[...document.querySelectorAll('.context-menu .menu-label')].some((l) => l.textContent === 'Rename…') && ${selectedName} === 'a.py'`), 'right-click selects the row and opens its menu');
  await press('Escape');

  // Drag main.py onto docs: moves it after the confirmation. Drag a.py onto the editor: opens it there.
  // The core's plain move: the refactor plugin's Move dialog for Python modules is verify/rename-module.mjs's.
  await js(`(() => {
    ide.ui.confirm = async () => true;
    ide.treeMoveHandlers.length = 0;
    const dt = new DataTransfer();
    const fire = (type, node) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire('dragstart', ${row('main.py')});
    fire('dragover', ${row('docs')});
    fire('drop', ${row('docs')});
    fire('dragend', document.getElementById('tree'));
  })()`);
  await until(`${names}.includes('notes.md') && ${names}.includes('main.py') && ${names}.indexOf('main.py') < ${names}.indexOf('pkg')`, 'main.py under docs');
  check(existsSync(path.join(t.project, 'docs', 'main.py')) && !existsSync(path.join(t.project, 'main.py')), 'dropping a file on a folder moves it on disk');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('docs\\\\main.py')`, 'moved file reopened');
  check(readFileSync(path.join(t.project, 'docs', 'main.py'), 'utf8') === 'print("edited")\n', 'unsaved edits are saved before the move and the file reopens from its new place');

  writeFileSync(path.join(t.project, 'docs', 'a.py'), 'KEEP = 1\n');
  await js(`ide.refreshTree()`);
  // Messages use the IDE's own dialog (window.alert would block the renderer until dismissed).
  await js(`(ide.ui.alert('<b>x</b> & y'), true)`);
  check(await js(`document.querySelector('.dialog-message')?.textContent === '<b>x</b> & y'`), 'ide.ui.alert shows the message as text in an IDE dialog');
  await press('Escape');
  await until(`!document.querySelector('.dialog-message')`, 'message dialog closed');
  await js(`(() => {
    window.alerts = [];
    ide.ui.alert = (m) => window.alerts.push(m);
    const dt = new DataTransfer();
    const fire = (type, node) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    const pkgA = [...document.querySelectorAll('#tree .node')].find((n) => n._entry.path.toLowerCase().endsWith('pkg\\\\a.py'));
    fire('dragstart', pkgA);
    fire('dragover', ${row('docs')});
    fire('drop', ${row('docs')});
    fire('dragend', document.body);
  })()`);
  await until(`window.alerts.length > 0`, 'overwrite refused');
  check(readFileSync(path.join(t.project, 'docs', 'a.py'), 'utf8') === 'KEEP = 1\n' && existsSync(path.join(t.project, 'pkg', 'a.py')), 'a move onto an existing file is refused, nothing is overwritten');
  await js(`(() => {
    const dt = new DataTransfer();
    const target = document.querySelector('.editor-group .group-body');
    ${row('a.py')}.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = target.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    target.dispatchEvent(new DragEvent('dragover', at));
    target.dispatchEvent(new DragEvent('drop', at));
  })()`);
  await until(`ide.activeTab()?.title === 'a.py'`, 'a.py opened by drop');
  await sleep(300);
  check(await js(`!ide.tabs.some((t) => ide.isDirty(t))`), 'dropping a tree row on the editor opens the file without typing into any document');

  // Reveal a file deep in the big folder: it is listed, drawn, selected and scrolled into view.
  await js(`ide.revealInTree(ide.util.joinPath(ide.root, 'big\\\\f2500.py'))`);
  await until(`${selectedName} === 'f2500.py'`, 'revealed row selected');
  check(await js(`(() => { const n = document.querySelector('#tree .node.selected'); const r = n.getBoundingClientRect(); const v = document.getElementById('tree').getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom; })()`), 'revealing a file opens its folders and scrolls it into view');

  // Cut rows are dimmed until a paste, Escape, or another cut; the mark survives scrolling and refreshes.
  const at = (rel) => `[...document.querySelectorAll('#tree .node')].find((n) => !n._entry.treeRoot && n._entry.path.toLowerCase() === ${q(path.join(t.project, rel).toLowerCase())})`;
  const cutRows = `[...document.querySelectorAll('#tree .node.cut')].map((n) => n._entry.name).join(',')`;
  const pick = async (rel) => {
    await js(`ide.revealInTree(${q(path.join(t.project, rel))})`);
    await until(`!!${at(rel)}?.classList.contains('selected')`, `${rel} selected`);
    await js(`(document.getElementById('tree').focus(), true)`);
  };
  await pick('docs\\notes.md');
  check(await js(`${cutRows} === ''`), 'no row is dimmed before a cut');
  await press('Ctrl+X');
  check(await js(`${cutRows} === 'notes.md' && getComputedStyle(${at('docs\\notes.md')}.querySelector('.name')).opacity === '0.5'`), 'Ctrl+X dims the cut row');
  await js(`document.getElementById('tree').scrollTop = 0`);
  await js(`ide.refreshTree()`);
  await js(`document.getElementById('tree').scrollTop = 1e9`);
  await pick('docs\\notes.md');
  check(await js(`${cutRows} === 'notes.md'`), 'the cut row stays dimmed after scrolling and a tree refresh');
  await press('Escape');
  const afterEsc = await js(`[${cutRows}, document.activeElement?.id || document.activeElement?.className]`);
  check(afterEsc[0] === '' && afterEsc[1] === 'tree', `Escape in the tree cancels the cut and the tree keeps the keyboard (${afterEsc})`);
  await press('Ctrl+X');
  await pick('docs\\main.py');
  await js(`(() => { const n = ${at('docs\\main.py')}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await until(`!!document.querySelector('.context-menu')`, 'tree context menu for Cut');
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Cut').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true`);
  await until(`!document.querySelector('.context-menu')`, 'menu closed');
  check(await js(`${cutRows} === 'main.py'`), 'Cut in the context menu dims its row and a new cut replaces the old one');
  await pick('pkg');
  await press('Ctrl+V');
  await until(`(async () => await ide.api.exists(${q(path.join(t.project, 'pkg', 'main.py'))}))()`, 'pasted into pkg');
  await until(`!!${at('pkg\\main.py')}`, 'moved row drawn');
  check(await js(`${cutRows} === ''`), 'pasting moves the file and the dimming is gone');
  await sleep(1500);
} catch (err) {
  check(false, err.message);
}

// Open folders come back after a restart.
t.close();
const t2 = await launch({ fixture: 'tree', port: 9761, userData: t.userData, projectDir: t.project });
const bigOpen = await t2.until(`${names}.includes('f0000.py')`, 'big folder open after restart').then(() => true, () => false);
await t2.js(`document.getElementById('tree').scrollTop = 1e9`);
const pkgOpen = await t2.until(`${names}.includes('a.py')`, 'pkg open after restart').then(() => true, () => false);
t2.check(bigOpen && pkgOpen, 'open folders are restored when the project opens again');

// Files and a folder dragged in from Explorer (a real drag through CDP, with file paths) are copied into the folder under
// the pointer, or into the project root below the rows; names that exist there ask first.
try {
  const outside = path.join(path.dirname(t2.project), 'outside');
  mkdirSync(path.join(outside, 'assets'), { recursive: true });
  writeFileSync(path.join(outside, 'notes.txt'), 'first\n');
  writeFileSync(path.join(outside, 'assets', 'logo.svg'), '<svg/>');
  writeFileSync(path.join(outside, 'setup.cfg'), '[metadata]\n');
  const inProject = (p) => path.join(t2.project, p);
  const lastDialog = `[...document.querySelectorAll('.dialog')].pop()`;
  const press = (label) => t2.js(`([...${lastDialog}.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${q(label)}).click(), true)`);
  const drop = async (target, files) => {
    const box = await t2.js(`(() => { const r = (${target}).getBoundingClientRect(); return { x: r.x + 30, y: r.bottom - 6 }; })()`);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await t2.cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
  };
  await t2.js(`(document.getElementById('tree').scrollTop = 0, true)`);
  await t2.until(`!!${row('big')}`, 'top of the tree');
  await t2.js(`(${row('big')}.click(), true)`);
  await t2.until(`!${names}.includes('f0000.py')`, 'big folder collapsed');
  const root = await t2.js('ide.root');

  await drop(row('docs'), [path.join(outside, 'notes.txt'), path.join(outside, 'assets')]);
  const copied = await t2.until(`${names}.includes('notes.txt') && ${names}.includes('assets')`, 'copied rows').then(() => true, () => false);
  t2.check(copied && readFileSync(inProject('docs/notes.txt'), 'utf8') === 'first\n' && readFileSync(inProject('docs/assets/logo.svg'), 'utf8') === '<svg/>',
    'a file and a folder dropped on docs are copied into it (nested files too) and shown in the tree');
  t2.check(existsSync(path.join(outside, 'notes.txt')) && existsSync(path.join(outside, 'assets', 'logo.svg')), 'the dropped originals stay where they were (a copy, not a move)');
  t2.check(await t2.js('ide.root') === root && !(await t2.js(`!!document.querySelector('.dialog')`)), 'dropping a folder on the tree does not open it as the project');

  writeFileSync(path.join(outside, 'notes.txt'), 'second\n');
  await drop(row('docs'), [path.join(outside, 'notes.txt')]);
  await t2.until(`${lastDialog}?.textContent.includes('notes.txt already exist')`, 'conflict dialog');
  t2.check((await t2.js(`${lastDialog}.querySelector('.dialog-title').textContent`)) === 'Copy', 'a name that exists asks before copying (Copy: Overwrite, Skip, Cancel)');
  await press('Skip');
  await t2.sleep(500);
  t2.check(readFileSync(inProject('docs/notes.txt'), 'utf8') === 'first\n', 'Skip keeps the file in the project');
  await drop(row('docs'), [path.join(outside, 'notes.txt')]);
  await t2.until(`${lastDialog}?.textContent.includes('notes.txt already exist')`, 'conflict dialog again');
  await press('Overwrite');
  const overwritten = await t2.until(`ide.api.read(${q(inProject('docs/notes.txt'))}).then((s) => s === 'second\\n')`, 'overwritten').then(() => true, () => false);
  t2.check(overwritten, 'Overwrite replaces it with the dropped file');

  await drop(`document.getElementById('tree')`, [path.join(outside, 'setup.cfg')]);
  const atRoot = await t2.until(`${names}.includes('setup.cfg')`, 'copied to the root').then(() => true, () => false);
  t2.check(atRoot && existsSync(inProject('setup.cfg')), 'dropped below the rows, a file is copied into the project root');
} catch (err) {
  t2.check(false, err.message);
}
t2.results.unshift(...t.results);
t2.consoleErrors.unshift(...t.consoleErrors);
t2.finish();
