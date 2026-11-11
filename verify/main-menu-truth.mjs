// The main menu says what is true where the user works (renderer/core/mainmenu.js): a key two actions share in
// different places (Ctrl+D, Ctrl+Shift+T) is shown only on the item it runs from where the keyboard is, Edit ›
// Bookmarks and File › Local History are where PyCharm has them, View › Tool Windows lists only the windows that apply
// to the project, and the project tree's Run and Debug items name the file. Port 9614.
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'core', port: 9614, name: 'main-menu-truth' });
const { js, until, check, click, cdp, sleep } = t;

const rows = (level) => `[...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')]`;
const items = (level) => js(`${rows(level)}.map((r) => [r.querySelector('.menu-label').textContent, r.querySelector('.hint-right')?.textContent || ''])`);
async function openMenu(path) {
  await js(`(ide.ui.closeMenus(), true)`);
  await click('#mainMenuBtn');
  await until(`!!document.querySelector('#mainMenu')`, 'main menu');
  for (let level = 0; level < path.length; level++) {
    const label = path[level];
    await js(`(${rows(level)}.find((r) => r.querySelector('.menu-label').textContent === ${S(label)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), true)`);
    await until(`!!document.querySelector('.context-menu[data-level="${level + 1}"]')`, `${label} submenu`);
  }
  return Object.fromEntries(await items(path.length));
}
// The action a combo runs from where the keyboard is (the last matching registration wins, as in the keymap).
const actionFor = (combo) => js(`ide.actions.findLast((a) => a.keys.includes(${S(combo)}) && (!a.when || a.when()) && ide.actionEnabled(a))?.id || null`);

try {
  await openFile(t, 'hello.py');
  await js(`(ide.editor.focus(), true)`);
  check(await actionFor('Ctrl+D') === 'EditorDuplicate' && await actionFor('Ctrl+Shift+T') === 'GotoTest', 'in the editor Ctrl+D duplicates the line and Ctrl+Shift+T goes to the test');

  // ---------- from the editor ----------
  const edit = await openMenu(['Edit']);
  check(await js(`!!document.activeElement?.closest('.monaco-editor')`), 'opening the main menu with the mouse leaves the keyboard in the editor');
  check(edit['Duplicate Line'] === 'Ctrl+D', `Edit › Duplicate Line shows Ctrl+D from the editor (${S(edit['Duplicate Line'])})`);
  check('Bookmarks' in edit, `Edit has Bookmarks, as in PyCharm (${Object.keys(edit).join(' | ')})`);
  const bookmarks = await openMenu(['Edit', 'Bookmarks']);
  check(bookmarks['Toggle Bookmark'] === 'F11' && bookmarks['Toggle Bookmark with Mnemonic'] === 'Ctrl+F11' && bookmarks['Show Bookmarks'] === 'Shift+F11',
    `Edit › Bookmarks: Toggle Bookmark F11, with Mnemonic Ctrl+F11, Show Bookmarks Shift+F11 (${S(bookmarks)})`);
  const history = await openMenu(['File', 'Local History']);
  check(['Show History', 'Show Project History', 'Put Label…'].every((l) => l in history), `File › Local History: Show History, Show Project History, Put Label… (${S(history)})`);
  const view = await openMenu(['View']);
  check(view['Compare With…'] === '', `View › Compare With… shows no Ctrl+D while the editor has the keyboard, where Ctrl+D duplicates (${S(view['Compare With…'])})`);
  const nav = await openMenu(['Navigate']);
  check(nav['Go to Test'] === 'Ctrl+Shift+T', `Navigate › Go to Test shows Ctrl+Shift+T in a Python editor (${S(nav['Go to Test'])})`);
  const tools = await openMenu(['Tools']);
  check('New Terminal Session' in tools && tools['New Terminal Session'] === '', `Tools › New Terminal Session shows no Ctrl+Shift+T outside the terminal (${S(tools['New Terminal Session'])})`);

  // ---------- View › Tool Windows ----------
  const windows = Object.keys(await openMenu(['View', 'Tool Windows']));
  const notHere = ['Django Structure', 'Endpoints', 'Host Output', 'Host Terminal', 'Find', 'Find in Files'].filter((w) => windows.includes(w));
  check(!notHere.length && ['Project', 'Terminal', 'Problems'].every((w) => windows.includes(w)),
    `View › Tool Windows lists what applies to a plain project, not Django, Endpoints, a guest's Host windows or empty Find results (${windows.length}: ${windows.join(', ')}; not expected: ${notHere.join(', ')})`);
  await js(`(ide.toolWindows.get('FindInFiles').show(), true)`);
  const open = Object.keys(await openMenu(['View', 'Tool Windows']));
  check(open.includes('Find in Files'), `a window that is open is listed whatever it holds (${open.join(', ')})`);
  await js(`(ide.ui.closeMenus(), ide.toolWindows.get('FindInFiles').hide(), true)`);

  // ---------- from the project tree ----------
  const row = `[...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name')?.textContent === 'hello.py')`;
  await until(`!!${row}`, 'hello.py in the tree');
  const at = await js(`(() => { const r = ${row}.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await until(`document.activeElement?.id === 'tree'`, 'the tree has the keyboard');
  check(await actionFor('Ctrl+D') === 'CompareTwoFiles', 'in the project tree Ctrl+D is Compare With');
  const viewTree = await openMenu(['View']);
  check(viewTree['Compare With…'] === 'Ctrl+D', `from the tree, View › Compare With… shows Ctrl+D (${S(viewTree['Compare With…'])})`);
  const editTree = await openMenu(['Edit']);
  check(editTree['Duplicate Line'] === '', `and Edit › Duplicate Line does not (${S(editTree['Duplicate Line'])})`);
  await js(`(ide.ui.closeMenus(), true)`);

  // ---------- the tree's Run and Debug items ----------
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', clickCount: 1, buttons: 2 });
  await until(`!!document.querySelector('.context-menu')`, 'tree menu');
  const tree = await js(`[...document.querySelectorAll('.context-menu .menu-item .menu-label')].map((n) => n.textContent)`);
  check(tree.includes("Run 'hello'") && tree.includes("Debug 'hello'") && !tree.some((l) => l.includes('…\'')),
    `the tree menu names the file it runs (${tree.join(' | ')})`);
  await js(`(ide.ui.closeMenus(), true)`);
  await sleep(100);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
t.finish();
