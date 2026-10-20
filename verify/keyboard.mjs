// Keyboard and focus, as a PyCharm user drives the IDE: dialogs (first field focused, Tab trapped, Enter presses the
// primary or the focused button, Esc cancels, focus goes back), popups and menus (arrows, Enter, Esc back to the
// editor), tool windows (shortcut opens and focuses, Esc to the editor, Shift+Esc hides), keyboard lists and trees,
// accessible names on icon buttons, and a visible focus ring in both themes. Real key events throughout.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'keyboard', port: 9843 });
const { js, until, press, type, check, sleep, cdp } = t;
const q = JSON.stringify;
// Enter as a keyboard types it (keyDown with its character), so a focused button activates natively.
const enter = async () => {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await sleep(60);
};

const editorFocused = () => js(`!!ide.editor?.hasTextFocus()`);
const inTopDialog = `!!document.activeElement?.closest('#dialogHost > :last-child .dialog')`;
const dialogs = () => js(`document.getElementById('dialogHost').childElementCount`);
// The focused element is on screen: keys never go to a hidden popup input or a removed node.
const focusShown = () => js(`(() => { const a = document.activeElement; return !!a && a !== document.body && a.isConnected && a.getClientRects().length > 0; })()`);
const toolOfFocus = () => js(`[...ide.toolWindows.values()].find(tw => tw.container.contains(document.activeElement))?.id || null`);
const backToEditor = async () => {
  for (let i = 0; i < 4 && await dialogs(); i++) await press('Escape');
  await js(`ide.editor.focus()`);
  await until(`ide.editor.hasTextFocus()`, 'editor focus');
};
// Tab and Shift+Tab never leave the topmost dialog.
async function tabTrapped(n = 25) {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < n; i++) {
      await press(key);
      if (!(await js(inTopDialog))) return `${key} #${i + 1} left the dialog for ${await js(`document.activeElement?.outerHTML.slice(0, 80)`)}`;
    }
  }
  return true;
}
const selectedText = (sel) => js(`document.querySelector(${q(`${sel} .selected`)})?.textContent || ''`);

try {
  await openFile(t, 'main.py');
  await backToEditor();

  // ---------- dialogs: the ide.ui.dialog primitive ----------
  const mainText = await js(`ide.editor.getModel().getValue()`);
  await js(`ide.ui.alert('Saved.')`);
  await enter();
  check(await dialogs() === 0 && await js(`ide.editor.getModel().getValue()`) === mainText, 'Enter on a message dialog closes it without typing into the editor');
  await backToEditor();
  await js(`ide.ui.alert('Saved.')`);
  check(await js(inTopDialog), 'a dialog without fields focuses its button, so keys do not reach the editor behind it');
  check((await tabTrapped(4)) === true, 'Tab and Shift+Tab stay inside a one-button dialog');
  await press('Escape');
  check(await dialogs() === 0 && await editorFocused(), 'Esc closes it and the editor has the keyboard again');
  check(await js(`ide.editor.getModel().getValue().startsWith('# TODO')`), 'nothing was typed into the editor behind the dialog');

  await js(`(window.__kb = {}, ide.ui.dialog({ title: 'Two', body: document.createElement('div'), buttons: [
    { label: 'Primary', primary: true, run: () => { __kb.primary = (__kb.primary || 0) + 1; } },
    { label: 'Other', run: () => { __kb.other = (__kb.other || 0) + 1; } }] }), 0)`);
  await js(`[...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Other').focus()`);
  await enter();
  check(await js(`__kb.other === 1 && !__kb.primary`) && await dialogs() === 0, 'Enter on a focused secondary button presses that button, not the primary one');
  await backToEditor();

  await js(`(() => { const body = document.createElement('div'); const ta = document.createElement('textarea'); ta.id = 'kbArea'; body.append(ta);
    window.__kb = {}; ide.ui.dialog({ title: 'Notes', body, buttons: [{ label: 'OK', primary: true, run: () => { __kb.ok = 1; } }] }); return 0; })()`);
  check(await js(`document.activeElement.id === 'kbArea'`), 'the first field gets the keyboard');
  await type('a');
  await enter();
  check(await js(`!__kb.ok && document.querySelector('#kbArea').value === 'a\\n'`) && await dialogs() === 1, 'Enter in a multi-line field is a new line, not OK');
  await js(`document.querySelector('.dialog .primary').focus()`);
  await enter();
  check(await js(`__kb.ok === 1`) && await dialogs() === 0, 'Enter on the primary button presses it once');
  await backToEditor();

  // Stacked dialogs: keys belong to the top one only.
  await js(`(() => { for (const name of ['Lower', 'Upper']) { const body = document.createElement('div'); const inp = document.createElement('input'); inp.id = 'kb' + name; body.append(inp);
    ide.ui.dialog({ title: name, body, buttons: [{ label: 'OK', primary: true, run: () => { (window.__kbOk ||= []).push(name); } }] }); } return 0; })()`);
  check((await tabTrapped(6)) === true, 'Tab stays in the top dialog of two');
  await press('Escape');
  check(await dialogs() === 1 && await js(`document.activeElement.id === 'kbLower'`), 'Esc closes only the top dialog and the keyboard goes back to the one below');
  await enter();
  check(await js(`(window.__kbOk || []).join() === 'Lower'`) && await dialogs() === 0, 'Enter then presses OK of the remaining dialog only');
  check(await editorFocused(), 'the editor has the keyboard after the last dialog closes');
  check(await js(`ide.editor.getModel().getValue()`) === mainText, 'the Enter that pressed OK is not also typed into the editor that gets the keyboard back');

  // ---------- real dialogs ----------
  await press('Ctrl+Alt+S');
  await until(`!!document.querySelector('.settings-dialog')`, 'settings');
  check(await js(inTopDialog), 'Settings (Ctrl+Alt+S) opens with the keyboard inside');
  const settingsTrap = await tabTrapped(40);
  check(settingsTrap === true, `Tab/Shift+Tab stay inside Settings (${settingsTrap})`);
  await press('Escape');
  check(await dialogs() === 0 && await editorFocused(), 'Esc cancels Settings and returns to the editor');

  await js(`(ide.newProject(), 0)`);
  await until(`!!document.querySelector('.np-dialog #npName')`, 'new project wizard');
  check(await js(`document.activeElement.id === 'npName'`), 'New Project focuses the project name');
  const npTrap = await tabTrapped(30);
  check(npTrap === true, `Tab/Shift+Tab stay inside New Project (${npTrap})`);
  await press('Escape');
  check(await dialogs() === 0 && await editorFocused(), 'Esc cancels New Project and returns to the editor');

  await js(`(ide.runAction('editRunConfigurations'), 0)`);
  await until(`!!document.querySelector('.rc-dialog')`, 'run configurations');
  check(await js(inTopDialog), 'Run/Debug Configurations opens with the keyboard inside');
  check((await tabTrapped(20)) === true, 'Tab/Shift+Tab stay inside Run/Debug Configurations');
  await js(`document.querySelector('.rc-tool[data-tool="add"]').focus()`);
  await enter();
  await until(`!!document.querySelector('.context-menu')`, 'add menu');
  check(await dialogs() === 1, 'Enter on the dialog\'s ＋ button opens its menu and leaves the dialog open');
  await press('Escape');
  check(await js(`!document.querySelector('.context-menu')`) && await dialogs() === 1, 'Esc closes the menu opened from a dialog, not the dialog');
  await press('Escape');
  check(await dialogs() === 0 && await editorFocused(), 'a second Esc cancels the dialog and returns to the editor');

  await press('Ctrl+Shift+F');
  await until(`document.activeElement?.id === 'snQuery'`, 'find in files query');
  check(true, 'Find in Files focuses the search text');
  await press('Escape');
  check(await dialogs() === 0 && await editorFocused(), 'Esc closes Find in Files and returns to the editor');

  // Database: the data source menu and dialog from the keyboard.
  await js(`(ide.runAction('Database.NewDataSource'), 0)`);
  await until(`!!document.querySelector('.context-menu')`, 'data source menu');
  await press('ArrowDown');
  await press('Enter');
  await until(`${'document.getElementById("dialogHost").childElementCount'} === 1`, 'data source dialog');
  check(await js(inTopDialog), 'arrow keys and Enter in the data source menu open the dialog with the keyboard inside');
  check((await tabTrapped(20)) === true, 'Tab/Shift+Tab stay inside the data source dialog');
  await press('Escape');
  check(await dialogs() === 0, 'Esc cancels the data source dialog');
  await js(`ide.toolWindows.get('Database').hide()`);
  await backToEditor();

  // ---------- popups and menus ----------
  await press('Ctrl+Shift+N');
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'go to file');
  await type('py');
  await until(`document.querySelectorAll('#popupList .popup-item:not(.hint)').length >= 3`, 'files listed');
  const first = await js(`document.querySelector('#popupList .popup-item.active')?.textContent`);
  await press('ArrowDown');
  const second = await js(`document.querySelector('#popupList .popup-item.active')?.textContent`);
  check(first && second && first !== second, 'Down moves the selection in Go to File');
  await press('Escape');
  check(await js(`document.getElementById('popup').classList.contains('hidden')`) && await editorFocused(), 'Esc closes Go to File and returns to the editor (not a hidden input)');

  await press('Ctrl+Shift+N');
  await type('broken');
  await until(`document.querySelector('#popupList .popup-item.active')?.textContent.includes('broken.py')`, 'broken.py found');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'broken.py'`, 'broken.py opened');
  await until(`ide.editor.hasTextFocus()`, 'editor focused after pick').then(() => check(true, 'Enter opens the picked file with the keyboard in its editor'), () => check(false, 'Enter opens the picked file with the keyboard in its editor'));
  await openFile(t, 'main.py');
  await backToEditor();

  for (const [name, key] of [['Find Action', 'Ctrl+Shift+A'], ['Recent Files', 'Ctrl+E'], ['Go to Symbol', 'Ctrl+Alt+Shift+N'], ['Run…', 'Alt+Shift+F10']]) {
    await press(key);
    await until(`!document.getElementById('popup').classList.contains('hidden')`, name);
    await press('Escape');
    check(await focusShown() && await editorFocused(), `Esc closes ${name} (${key}) and returns to the editor`);
  }
  js(`ide.ui.prompt('Name', 'x')`);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'prompt');
  await press('Escape');
  check(await editorFocused(), 'Esc cancels ide.ui.prompt and returns to the editor');
  js(`ide.ui.prompt('Name', 'x')`);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'prompt');
  await enter();
  check(await editorFocused() && await js(`ide.editor.getModel().getValue()`) === mainText, 'Enter confirms ide.ui.prompt without typing a new line into the editor');

  await press('Shift');
  await press('Shift');
  await until(`!!document.querySelector('#seInput')`, 'search everywhere');
  await press('Escape');
  check(await editorFocused(), 'Esc closes Search Everywhere and returns to the editor');

  await press('Ctrl+F12');
  await until(`!!document.getElementById('snFileStructure')`, 'file structure popup');
  await press('Escape');
  check(await editorFocused(), 'Esc closes the File Structure popup and returns to the editor');

  await js(`(window.__kbMenu = '', ide.ui.contextMenu(200, 200, [{ label: 'One', run: () => { __kbMenu = 'one'; } }, { label: 'Two', run: () => { __kbMenu = 'two'; } }]), 0)`);
  await sleep(100); // the menu takes keys from the next task on
  await press('ArrowDown');
  await press('ArrowDown');
  await press('Enter');
  check(await js(`__kbMenu === 'two' && !document.querySelector('.context-menu')`), 'Down, Down, Enter runs the second menu item');
  check(await editorFocused(), 'the editor keeps the keyboard after a menu');

  await press('Alt+\\');
  await until(`!!document.querySelector('.context-menu')`, 'main menu');
  await press('Escape');
  check(await js(`!document.querySelector('.context-menu')`) && await editorFocused(), 'Esc closes the main menu (Alt+\\) with the editor focused');

  // ---------- tool windows: shortcut opens and focuses, Esc to the editor, Shift+Esc hides ----------
  const windows = [['Project', 'Alt+1'], ['Bookmarks', 'Alt+2'], ['Run', 'Alt+4'], ['Debug', 'Alt+5'], ['Problems', 'Alt+6'],
    ['Structure', 'Alt+7'], ['PythonConsole', 'Alt+8'], ['Git', 'Alt+9'], ['Commit', 'Alt+0'], ['Terminal', 'Alt+F12'], ['Launchers', 'Alt+Shift+L']];
  for (const [id, key] of windows) {
    await js(`ide.toolWindows.get(${q(id)}).hide()`);
    await backToEditor();
    await press(key);
    await until(`ide.toolWindows.get(${q(id)}).isVisible()`, `${id} shown`);
    await sleep(150);
    const owner = await toolOfFocus();
    check(owner === id && await focusShown(), `${key} opens ${id} and moves the keyboard into it (focus in ${owner})`);
    if (id !== 'Terminal') {
      await press('Escape');
      check(await editorFocused() && await js(`ide.toolWindows.get(${q(id)}).isVisible()`), `Esc in ${id} returns to the editor and leaves it open`);
      await press(key);
      await press(key);
    }
    await until(`ide.toolWindows.get(${q(id)}).container.contains(document.activeElement)`, `${id} focused again`);
    await press('Shift+Escape');
    check(!(await js(`ide.toolWindows.get(${q(id)}).isVisible()`)) && await editorFocused(), `Shift+Esc hides ${id} and returns to the editor`);
  }

  // ---------- lists and trees ----------
  // Project tree
  await press('Alt+1');
  await until(`document.activeElement?.id === 'tree'`, 'tree focused');
  await press('Home');
  await press('ArrowDown');
  check((await selectedText('#tree')).length > 0, 'Down selects a row in the Project tree');
  await press('Shift+Escape');

  // Problems: Enter jumps to the problem
  await openFile(t, 'broken.py');
  await until(`ide.problems.all().some(p => p.path.endsWith('broken.py'))`, 'broken.py problem', 30000);
  await openFile(t, 'main.py');
  await backToEditor();
  await press('Alt+6');
  await until(`document.activeElement?.id === 'problemList'`, 'problems list focused');
  await press('ArrowDown');
  check((await selectedText('#problemList')).includes('broken.py'), 'Down selects a problem in the Problems list');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'broken.py'`, 'jumped to problem').then(() => check(true, 'Enter on a problem opens its file'), () => check(false, 'Enter on a problem opens its file'));
  await js(`ide.toolWindows.get('Problems').hide()`);
  await openFile(t, 'main.py');
  await backToEditor();

  // Structure: Left collapses a class, Right expands it, Enter moves the caret
  await press('Alt+7');
  await until(`document.activeElement?.id === 'snStructure' && document.querySelectorAll('#snStructure .sn-node[data-line]').length >= 4`, 'structure focused');
  await sleep(800); // the outline answers after the window shows and redraws the rows once
  await press('Home');
  check((await selectedText('#snStructure')).includes('Shop'), 'Home selects the first structure element (Shop)');
  const shownMethods = () => js(`[...document.querySelectorAll('#snStructure .sn-node[data-line]')].filter(n => n.textContent.includes('total')).length`);
  check(await shownMethods() === 1, 'its methods are listed');
  await press('ArrowLeft');
  check(await shownMethods() === 0 && (await selectedText('#snStructure')).includes('Shop'), 'Left collapses the class and keeps it selected');
  await press('ArrowRight');
  check(await shownMethods() === 1, 'Right expands it again');
  await press('ArrowRight');
  check((await selectedText('#snStructure')).includes('items'), 'Right on an expanded class goes to its first member');
  await press('ArrowLeft');
  check((await selectedText('#snStructure')).includes('Shop'), 'Left on a member goes to its class');
  await press('End');
  await press('Enter');
  await until(`ide.editor.getPosition().lineNumber >= 17`, 'caret moved').then(() => check(true, 'Enter on a structure element moves the caret to it'), () => check(false, 'Enter on a structure element moves the caret to it'));
  await js(`ide.toolWindows.get('Structure').hide()`);
  await backToEditor();

  // Find in Files results
  await press('Ctrl+Shift+F');
  await until(`document.activeElement?.id === 'snQuery'`, 'find dialog');
  await type('total');
  await sleep(400);
  await press('Enter');
  await until(`document.querySelectorAll('#snFindResults .sn-match').length >= 3`, 'find results');
  await js(`document.querySelector('#snFindResults').focus()`);
  await press('ArrowDown');
  const group = await js(`document.querySelector('#snFindResults .selected')?.classList.contains('sn-file')`);
  await press('ArrowLeft');
  const folded = await js(`document.querySelector('#snFindResults .sn-group')?.classList.contains('collapsed')`);
  await press('ArrowRight');
  const unfolded = await js(`!document.querySelector('#snFindResults .sn-group')?.classList.contains('collapsed')`);
  check(group && folded && unfolded, 'in Find results Down selects a file, Left folds it and Right unfolds it');
  await press('ArrowDown');
  await press('Enter');
  await until(`ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber).includes('total')`, 'jumped to match')
    .then(() => check(true, 'Enter on a match jumps to it'), () => check(false, 'Enter on a match jumps to it'));
  await js(`ide.toolWindows.get('FindInFiles').hide()`);

  // TODO
  await js(`ide.runAction('ActivateTODOToolWindow')`);
  await until(`document.querySelectorAll('#snTodo .sn-todo').length >= 1`, 'todo items');
  await sleep(800);
  await js(`document.querySelector('#snTodo').focus()`);
  await press('ArrowDown');
  await press('ArrowDown');
  await js(`ide.editor.setPosition({ lineNumber: 10, column: 1 })`);
  await press('Enter');
  await until(`ide.activeTab()?.title === 'main.py' && ide.editor.getPosition().lineNumber === 1`, 'jumped to TODO')
    .then(() => check(true, 'TODO: Down to an item and Enter jumps to it'), () => check(false, 'TODO: Down to an item and Enter jumps to it'));
  await js(`ide.toolWindows.get('TODO').hide()`);

  // Bookmarks
  await openFile(t, 'main.py');
  await js(`ide.editor.setPosition({ lineNumber: 10, column: 1 }), ide.bookmarks.toggle()`);
  await js(`ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  await backToEditor();
  await press('Alt+2');
  await until(`document.activeElement?.classList.contains('bm-list')`, 'bookmarks focused');
  await press('ArrowDown');
  await press('Enter');
  await until(`ide.editor.getPosition().lineNumber === 10`, 'bookmark').then(() => check(true, 'Bookmarks: Down and Enter go to the bookmark'), () => check(false, 'Bookmarks: Down and Enter go to the bookmark'));
  await js(`ide.toolWindows.get('Bookmarks').hide()`);

  // Database tree: Right connects and expands, Left goes back up and collapses
  const dbFile = path.join(t.project, 'shop.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();
  await js(`ide.database.addDataSource({ kind: 'sqlite', name: 'shop', file: ${q(dbFile)} })`);
  await js(`ide.toolWindows.get('Database').show()`);
  await until(`document.querySelectorAll('#dbTree .db-node[data-key]').length >= 1`, 'data source row');
  await js(`document.querySelector('#dbTree').focus()`);
  await press('ArrowDown');
  check((await selectedText('#dbTree')).includes('shop'), 'Database tree: Down selects the data source');
  await press('ArrowRight');
  await until(`document.querySelectorAll('#dbTree .db-node[data-key]').length >= 2`, 'source expanded', 20000)
    .catch(async (e) => { console.log('db tree:', await js(`document.querySelector('#dbTree').textContent`)); throw e; });
  await press('ArrowRight');
  const child = await js(`Number(document.querySelector('#dbTree .db-node.selected')?.dataset.depth)`);
  // The schema below the source opens by itself (SQLite has one): Left first closes it, then goes up, then closes the source.
  await press('ArrowLeft');
  const schemaClosed = await js(`document.querySelectorAll('#dbTree .db-node[data-key]').length`) === 2;
  await press('ArrowLeft');
  const parent = await selectedText('#dbTree');
  await press('ArrowLeft');
  const rowsLeft = await js(`document.querySelectorAll('#dbTree .db-node[data-key]').length`);
  check(child === 1 && schemaClosed && parent.includes('shop') && rowsLeft === 1, `Database tree: Right expands and enters, Left closes, goes to the parent and closes it (depth ${child}, ${rowsLeft} rows)`);
  check(await js(`document.activeElement?.id === 'dbTree'`), 'the tree keeps the keyboard while it redraws');
  await js(`ide.toolWindows.get('Database').hide()`);

  // Test results: Left/Right collapse and expand a class
  await openFile(t, 'test_shop.py');
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  await press('Ctrl+Shift+F10');
  await until(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-row[data-kind="test"]')].length === 3 && document.querySelector('.run-session:not(.hidden) .tr-status')?.dataset.state !== 'running'`, 'tests ran', 60000);
  await js(`(() => { const tree = document.querySelector('.run-session:not(.hidden) .tr-tree'); tree.focus(); [...tree.querySelectorAll('.tr-row')].find(r => r.dataset.kind === 'class').click(); tree.focus(); return 0; })()`);
  const testRows = () => js(`document.querySelectorAll('.run-session:not(.hidden) .tr-row[data-kind="test"]').length`);
  await press('ArrowLeft');
  const collapsed = await testRows();
  await press('ArrowRight');
  const expanded = await testRows();
  await press('ArrowDown');
  await press('ArrowLeft');
  const backToClass = await js(`document.querySelector('.run-session:not(.hidden) .tr-row.selected')?.dataset.kind`);
  check(collapsed === 1 && expanded === 3 && backToClass === 'class', `Test results: Left collapses a class, Right expands it, Left on a test goes to its class (${collapsed}, ${expanded}, ${backToClass})`);
  await js(`ide.toolWindows.get('Run').hide()`);

  // Debugger: frames and variables
  await openFile(t, 'main.py');
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 13, column: 9 })`);
  await press('Ctrl+F8');
  await press('Shift+F9');
  await until(`window.__debugger.state()?.state === 'suspended'`, 'suspended', 60000);
  await until(`document.querySelectorAll('#dbgFrames .dbg-frame').length >= 2 && document.querySelectorAll('#dbgVars .dbg-var').length >= 2`, 'frames and variables');
  await press('Alt+5');
  if (!(await js(`ide.toolWindows.get('Debug').isVisible()`))) await press('Alt+5');
  await until(`document.activeElement?.id === 'dbgFrames'`, 'frames focused').then(() => check(true, 'Alt+5 puts the keyboard in the Frames list'), () => check(false, 'Alt+5 puts the keyboard in the Frames list'));
  await press('ArrowDown');
  await until(`window.__debugger.state().frameIdx === 1`, 'second frame').then(() => check(true, 'Down in Frames selects the caller frame'), () => check(false, 'Down in Frames selects the caller frame'));
  await until(`[...document.querySelectorAll('#dbgVars .dbg-var')].some(r => r.textContent.startsWith('▸info'))`, 'module variables');
  await press('Tab');
  check(await js(`document.activeElement?.id === 'dbgVars'`), 'Tab moves from Frames to Variables');
  const infoIndex = await js(`[...document.querySelectorAll('#dbgVars .dbg-var:not(.muted)')].findIndex(r => r.textContent.startsWith('▸info'))`);
  await press('Home');
  for (let i = 0; i < infoIndex; i++) await press('ArrowDown');
  check((await selectedText('#dbgVars')).startsWith('▸info'), 'Down walks the variables to info');
  await press('ArrowRight');
  await until(`(document.querySelector('#dbgVars .dbg-var.selected')?.nextElementSibling?.textContent || '').includes('demo')`, 'info expanded')
    .then(() => check(true, 'Right expands a dict variable'), () => check(false, 'Right expands a dict variable'));
  await press('ArrowRight');
  check(!(await selectedText('#dbgVars')).startsWith('▾info'), 'Right again enters its first child');
  await press('ArrowLeft');
  check((await selectedText('#dbgVars')).startsWith('▾info'), 'Left goes back to the parent variable');
  await press('ArrowLeft');
  check((await selectedText('#dbgVars')).startsWith('▸info'), 'Left collapses it');
  await press('Escape');
  check(await editorFocused(), 'Esc from the debugger returns to the editor');
  await press('Ctrl+F2');
  await until(`!window.__debugger.state() || window.__debugger.state().state !== 'suspended'`, 'stopped', 20000).catch(() => {});

  // ---------- accessible names: icon-only controls have aria-label or title ----------
  const unnamed = new Set();
  const scan = async (where) => {
    for (const s of await js(`[...document.querySelectorAll('button, [role=button], select, input:not([type=hidden])')]
      .filter(b => b.getClientRects().length && !/\\p{L}{2}/u.test(b.textContent) && !b.getAttribute('aria-label') && !b.title && !b.labels?.length && !b.placeholder && !b.getAttribute('aria-labelledby'))
      .map(b => b.tagName.toLowerCase() + (b.id ? '#' + b.id : '') + (b.className ? '.' + String(b.className).trim().replace(/\\s+/g, '.') : '') + ' "' + b.textContent.trim().slice(0, 6) + '"')`)) unnamed.add(`${where}: ${s}`);
  };
  for (const id of await js(`[...ide.toolWindows.keys()]`)) {
    await js(`ide.toolWindows.get(${q(id)}).show()`);
    await sleep(150);
    await scan(id);
  }
  await press('Ctrl+Alt+S');
  await until(`!!document.querySelector('.settings-dialog')`, 'settings again');
  await scan('Settings');
  await press('Escape');
  await js(`(ide.runAction('editRunConfigurations'), 0)`);
  await until(`!!document.querySelector('.rc-dialog')`, 'run configurations again');
  await scan('Run/Debug Configurations');
  await press('Escape');
  check(unnamed.size === 0, `icon-only buttons and fields have an accessible name${unnamed.size ? `:\n    ${[...unnamed].join('\n    ')}` : ''}`);

  // ---------- focus ring in both themes ----------
  for (const theme of ['dark', 'light']) {
    await js(`ide.settings.set('appearance.theme', ${q(theme)})`);
    await until(`document.documentElement.dataset.theme === ${q(theme)} || ${q(theme)} === 'dark'`, `${theme} theme`);
    await backToEditor();
    await js(`ide.toolWindows.get('Project').hide()`);
    await press('Alt+1');
    await until(`document.activeElement?.id === 'tree'`, 'tree');
    const ring = (sel) => js(`(() => { const n = ${sel}; const s = getComputedStyle(n); return n.matches(':focus-visible') && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && s.outlineColor !== 'rgba(0, 0, 0, 0)'; })()`);
    check(await ring('document.activeElement'), `${theme}: the focused Project tree shows a focus outline`);
    await press('Escape');
    await press('Alt+6');
    await until(`document.activeElement?.id === 'problemList'`, 'problems');
    check(await ring('document.activeElement'), `${theme}: the focused Problems list shows a focus outline`);
    await press('Shift+Escape');
    await js(`ide.ui.alert('Ring')`);
    await press('Tab');
    check(await ring('document.activeElement'), `${theme}: a dialog button focused with Tab shows a focus outline`);
    await press('Escape');
    await press('Alt+4');
    await press('Shift+Escape');
  }
  await js(`ide.settings.set('appearance.theme', 'dark')`);

  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, `keyboard suite: ${err.message}`);
}
t.finish();
