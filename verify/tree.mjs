// Project tree: virtualized rows, incremental expand/collapse, keyboard navigation, drag and drop, decorators,
// context menu, reveal, and open folders restored after a restart.
import { launch } from './lib.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const BIG = 3000;
const t = await launch({ fixture: 'tree', port: 9760 });
const { js, until, press, check, sleep } = t;
const q = JSON.stringify;
const names = `[...document.querySelectorAll('#tree .node .name')].map((n) => n.textContent)`;
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
  await press('End');
  check(await js(`${selectedName} === 'main.py'`), 'End selects the last row');
  await press('Home');
  check(await js(`${selectedName} === 'project'`), 'Home selects the root');
  await press('End');
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
  await js(`(() => {
    window.confirm = () => true;
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
  await js(`(() => {
    window.alerts = [];
    window.alert = (m) => window.alerts.push(m);
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
t2.results.unshift(...t.results);
t2.consoleErrors.unshift(...t.consoleErrors);
t2.finish();
