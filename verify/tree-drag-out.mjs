// Dragging rows out of the project tree: a drag the user starts with the mouse becomes a system drag of the selected
// files (main's tree:startDrag, intercepted here so no real drag takes the mouse), which Explorer, the desktop and other
// apps take as files. Back over the window that drag arrives as files, and the tree still moves the row onto a folder,
// an editor opens a file, and a dragged folder never opens as a project. Port 9789.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-tree-drag-out-')), 'project');
mkdirSync(path.join(project, 'docs'), { recursive: true });
writeFileSync(path.join(project, 'notes.txt'), 'notes\n');
writeFileSync(path.join(project, 'todo.txt'), 'todo\n');
writeFileSync(path.join(project, 'docs', 'readme.txt'), 'readme\n');

const t = await launch({ name: 'tree-drag-out', port: 9789, projectDir: project });
const { js, until, check, cdp, sleep } = t;
const S = JSON.stringify;
const row = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n._entry && n._entry.path.endsWith(${S('\\' + name)}))`;
const centerOf = (expr) => js(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }; })()`);
// A real mouse gesture: press, then move with the button held until Blink starts the drag.
async function mouseDrag(name, modifiers = 0) {
  const p = await centerOf(row(name));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  for (let i = 1; i <= 6; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + i * 4, y: p.y + i * 3, button: 'left', buttons: 1, modifiers });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 24, y: p.y + 18, button: 'left', clickCount: 1, modifiers });
}
// The system drag coming back over the window, as Windows delivers it: files, copy only.
async function systemDrop(targetExpr, files) {
  const p = await centerOf(targetExpr);
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data });
}

try {
  await until(`!!${row('notes.txt')} && !!${row('docs')}`, 'tree rows');
  await js(`(() => {
    window.__drags = [];
    const send = ide.api.send;
    ide.api.send = (channel, payload) => (channel === 'tree:startDrag' ? window.__drags.push(payload) : send(channel, payload));
    ide.ui.confirm = async () => true;
    ide.treeMoveHandlers.length = 0;
    return true;
  })()`);

  await mouseDrag('notes.txt');
  await until(`window.__drags.length === 1`, 'system drag asked for');
  check(S(await js('window.__drags[0]')) === S([path.join(project, 'notes.txt')]), 'dragging a row with the mouse starts a system drag of that file, so other apps can take it');

  await js(`(ide.treeDrag = null, true)`);
  await js(`${row('notes.txt')}.click()`);
  const p2 = await centerOf(row('todo.txt'));
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p2.x, y: p2.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', clickCount: 1, modifiers: 2 });
  await sleep(200);
  await mouseDrag('todo.txt');
  await until(`window.__drags.length === 2`, 'second system drag');
  const two = await js('window.__drags[1]');
  check(two.length === 2 && two.some((p) => p.endsWith('notes.txt')) && two.some((p) => p.endsWith('todo.txt')), `a drag from a multiple selection takes every selected file (${S(two)})`);

  await js(`(ide.treeDrag = null, ${row('notes.txt')}.click(), true)`);
  await mouseDrag('notes.txt');
  await until(`window.__drags.length === 3 && !!ide.treeDrag`, 'third system drag');
  await systemDrop(row('docs'), [path.join(project, 'notes.txt')]);
  for (let i = 0; i < 40 && !existsSync(path.join(project, 'docs', 'notes.txt')); i++) await sleep(250);
  check(existsSync(path.join(project, 'docs', 'notes.txt')) && !existsSync(path.join(project, 'notes.txt')), 'dropped back on a folder of the tree, the row is moved, not copied');
  check(await js('ide.treeDrag === null'), 'the drop ends the drag');

  await mouseDrag('docs');
  await until(`window.__drags.length === 4`, 'folder drag');
  const root = await js('ide.root');
  await systemDrop(`document.querySelector('.editor-group .group-body')`, [path.join(project, 'docs')]);
  await sleep(1500);
  check(await js('ide.root') === root, 'a folder dragged from the tree onto the editor does not open as a project');

  await mouseDrag('todo.txt');
  await until(`window.__drags.length === 5`, 'file drag to the editor');
  await systemDrop(`document.querySelector('.editor-group .group-body')`, [path.join(project, 'todo.txt')]);
  await until(`ide.activeTab()?.title === 'todo.txt'`, 'todo.txt opened', 10000);
  check(true, 'a file dragged from the tree onto the editor opens there');

  // Main's real handler, with no mouse button held: Windows ends the drag at once, and the renderer hears it ended.
  await mouseDrag('todo.txt');
  await until(`window.__drags.length === 6 && !!ide.treeDrag`, 'drag for main');
  await js(`(window.api.send('tree:startDrag', window.__drags[5]), true)`);
  await until(`ide.treeDrag === null`, 'the drag ends', 15000);
  check(true, "main starts the system drag (file icon, startDrag) and reports its end, which clears the renderer's drag");

  // Main reports the end before the drop on an editor arrives; then files from Explorer onto a folder are copied, and
  // the row dragged before stays where it is. Main reports the end even when it starts no drag (no files here).
  await mouseDrag('todo.txt');
  await until(`window.__drags.length === 7 && !!ide.treeDrag`, 'drag to the editor again');
  await js(`(window.api.send('tree:startDrag', []), true)`);
  await sleep(200);
  await systemDrop(`document.querySelector('.editor-group .group-body')`, [path.join(project, 'todo.txt')]);
  await sleep(2500);
  const outside = path.join(path.dirname(project), 'from-explorer.txt');
  writeFileSync(outside, 'from explorer\n');
  await systemDrop(row('docs'), [outside]);
  for (let i = 0; i < 40 && !existsSync(path.join(project, 'docs', 'from-explorer.txt')); i++) await sleep(250);
  check(existsSync(path.join(project, 'docs', 'from-explorer.txt')) && existsSync(outside) && existsSync(path.join(project, 'todo.txt')) && !existsSync(path.join(project, 'docs', 'todo.txt')),
    'after a drag ends on an editor, files from Explorer are copied into the folder and the earlier row is not moved');
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.finish();
