// Paste from History (clipboard-history), Run Anything (run-anything) and File and Code Templates (file-templates).
// Instance A (port 9340): copies and cuts in Monaco with Ctrl+C / Ctrl+X, the IDE's Copy Path, order, limit and
// de-duplication, other applications' text only with the option on, Ctrl+Shift+V popup (filter, Enter, Delete),
// multi-caret paste and whole-line paste; Double Ctrl opens Run Anything while Ctrl+C, Ctrl+S, a Ctrl tap followed by
// Ctrl+S and slow taps do not, Double Shift still opens Search Everywhere, the shortcut can be removed and rebound;
// a run configuration, `python app.py`, `python -m modx` (Run tool window) and `echo` (new Terminal session) with
// their output, history and suggestions; templates through New Python File and the project tree's New submenu with
// substituted variables, a custom variable dialog, edit and reset in Settings, and settings export including them.
// Instance B (port 9341, same user data, Korean): the kept history after a restart and the Korean UI.
// Instance C (port 9342): Run Anything in a Safe Mode project asks to trust it first and runs only after trusting.
// The copies and cuts reach the real system clipboard: verify/lib.mjs saves it before the first launch and puts it
// back when the suite exits, also after a failure.
import { createRequire } from 'module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const require = createRequire(import.meta.url);
const archive = require('../main/settings-sync/archive.js');
const J = JSON.stringify;
const APP = path.resolve(import.meta.dirname, '..');

// tr('…') strings of this feature's plugins, for the Korean check.
const ownStrings = new Set();
for (const p of ['clipboard-history', 'run-anything', 'file-templates']) {
  const src = readFileSync(path.join(APP, 'renderer', 'features', p, 'index.js'), 'utf8');
  for (const m of src.matchAll(/tr\('((?:[^'\\]|\\.)*)'/g)) ownStrings.add(m[1].replace(/\\'/g, "'"));
}

const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

function keys(t) {
  const { cdp, sleep } = t;
  const CTRL = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 };
  const SHIFT = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 };
  const ev = (type, k, modifiers) => cdp('Input.dispatchKeyEvent', { type, ...k, modifiers });
  const letter = (l, modifiers) => ({ key: modifiers & 8 ? l.toUpperCase() : l.toLowerCase(), code: `Key${l.toUpperCase()}`, windowsVirtualKeyCode: l.toUpperCase().charCodeAt(0) });
  return {
    ctrlTap: async () => { await ev('rawKeyDown', CTRL, 2); await ev('keyUp', CTRL, 0); },
    doubleCtrl: async () => { for (let i = 0; i < 2; i++) { await ev('rawKeyDown', CTRL, 2); await ev('keyUp', CTRL, 0); } },
    // Ctrl held while a letter is pressed, as a person types Ctrl+C: Ctrl down, C down, C up, Ctrl up.
    ctrlChord: async (l) => { await ev('rawKeyDown', CTRL, 2); await ev('rawKeyDown', letter(l, 2), 2); await ev('keyUp', letter(l, 2), 2); await ev('keyUp', CTRL, 0); await sleep(30); },
    shiftDown: () => ev('rawKeyDown', SHIFT, 8),
    shiftUp: () => ev('keyUp', SHIFT, 0),
  };
}

const runText = (title) => `(ide.run.sessions().find(s => s.title === ${J(title)})?.con?.out?.textContent || '')`;
const termText = (name) => `(() => { const s = ide.terminal.sessions().find(s => s.name === ${J(name)}); return s?.id ? ide.terminal.text(s.id) : ''; })()`;
const row = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name').textContent === ${J(name)})`;
const menuRow = (label) => `[...document.querySelectorAll('.context-menu .menu-item')].find(r => r.querySelector('.menu-label').textContent === ${J(label)})`;
const dialogButton = (label) => `[...document.querySelectorAll('.dialog-buttons button')].reverse().find(b => b.textContent === ${J(label)})`;

async function treeMenu(t, name, path) {
  const { js, until, sleep } = t;
  await until(`!!${row(name)}`, `tree row ${name}`);
  await js(`(() => { const n = ${row(name)}; n.scrollIntoView(); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  for (const label of path) {
    await until(`!!${menuRow(label)}`, `menu item ${label}`);
    await js(`(${menuRow(label)}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), true)`);
    await sleep(80);
  }
}
async function answerPrompt(t, text) {
  const { js, until, type, press } = t;
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'name prompt');
  await js(`(document.querySelector('#popupIn').value = '', true)`);
  await type(text);
  await press('Enter');
}

// ===================================================================== instance A
const t = await launch({ fixture: 'editing-comfort', port: 9340, name: 'editing-comfort' });
const { js, until, press, type, check, sleep, shot } = t;
const k = keys(t);
const history = () => js('ide.clipboardHistory.items().map(i => i.text)');
const setText = (text) => js(`(() => { const e = ide.editor; e.getModel().setValue(${J(text)}); e.setPosition({ lineNumber: 1, column: 1 }); e.focus(); return true; })()`);
const select = (l1, c1, l2, c2) => js(`(ide.editor.setSelection({ startLineNumber: ${l1}, startColumn: ${c1}, endLineNumber: ${l2}, endColumn: ${c2} }), ide.editor.focus(), true)`);
const text = () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const popupOpen = `!!document.querySelector('#pasteFromHistory')`;
const raOpen = `!!document.querySelector('#runAnything')`;
let userData;
try {
  userData = t.userData;
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.clipboardHistory && !!ide.runAnything && !!ide.fileTemplates`), 'the three plugins are loaded');

  // ---------------------------------------------------------------- Paste from History
  check(J(await js(`ide.actions.filter(a => a.keys.includes('Ctrl+Shift+V')).map(a => a.id)`)) === J(['PasteMultiple']), 'Ctrl+Shift+V belongs to Paste from History only');
  check(await js(`ide.settings.get('clipboardHistory.persist', false) === false && ide.settings.get('clipboardHistory.captureSystem', false) === false`), 'keeping the history after a restart and reading other applications are off by default');
  await openFile(t, 'scratch.txt');
  await setText('alpha beta gamma\nx = 1\ny = 2\nz = 3\n');
  await select(1, 1, 1, 6);
  await k.ctrlChord('C');
  await until(`ide.clipboardHistory.items()[0]?.text === 'alpha'`, 'alpha copied');
  await select(1, 7, 1, 11);
  await k.ctrlChord('C');
  await select(1, 12, 1, 17);
  await k.ctrlChord('C');
  await until(`ide.clipboardHistory.items()[0]?.text === 'gamma'`, 'gamma copied');
  check(J(await history()) === J(['gamma', 'beta', 'alpha']), `Ctrl+C in the editor records copies newest first (${J(await history())})`);
  check(!(await js(raOpen)), 'Ctrl+C presses do not open Run Anything');
  await select(1, 1, 1, 6);
  await k.ctrlChord('C');
  await until(`ide.clipboardHistory.items()[0]?.text === 'alpha'`, 'alpha again');
  check(J(await history()) === J(['alpha', 'gamma', 'beta']), 'copying a text again moves it to the top instead of adding it twice');
  // Cut
  await setText('cut-me rest\n');
  await select(1, 1, 1, 7);
  await k.ctrlChord('X');
  await until(`ide.clipboardHistory.items()[0]?.text === 'cut-me'`, 'cut recorded');
  check((await text()) === ' rest\n', 'Ctrl+X cuts and is recorded');
  // The IDE's own copy action (core: Copy Path)
  await js(`ide.runAction('CopyPaths')`);
  await until(`/scratch\\.txt$/i.test(ide.clipboardHistory.items()[0]?.text || '')`, 'copy path recorded');
  check(true, 'Copy Path (an IDE copy action) is recorded');
  // Other applications: only with the option on, read when the window gets focus.
  await js(`window.api.invoke('clipboard:writeText', 'from-other-app')`);
  await js(`(dispatchEvent(new FocusEvent('focus')), true)`);
  await sleep(300);
  check(!(await history()).includes('from-other-app'), 'text copied in another application is not kept by default');
  await js(`(ide.settings.set('clipboardHistory.captureSystem', true), dispatchEvent(new FocusEvent('focus')), true)`);
  await until(`ide.clipboardHistory.items()[0]?.text === 'from-other-app'`, 'system clipboard read on focus');
  check(true, 'with the option on, the system clipboard is added when the window gets focus');
  await js(`(ide.settings.set('clipboardHistory.captureSystem', false), ide.clipboardHistory.remove('from-other-app'), true)`);
  // Limit
  await js(`(ide.settings.set('clipboardHistory.limit', 5), [1,2,3,4,5,6,7].forEach(n => ide.clipboardHistory.add('item-' + n)), true)`);
  check(J(await history()) === J(['item-7', 'item-6', 'item-5', 'item-4', 'item-3']), `the history keeps the configured number of items (${J(await history())})`);
  await js(`(ide.settings.set('clipboardHistory.limit', 30), true)`);
  await js(`(ide.clipboardHistory.clear(), ['first line\\n  second', 'gamma', 'beta'].forEach(s => ide.clipboardHistory.add(s)), true)`);
  check(await js(`ide.clipboardHistory.items().length`) === 3, 'the default limit is 30 (clear and add work)');

  // Ctrl+Shift+V: filter, Enter pastes at the caret.
  await setText('A-B\n');
  await js(`(ide.editor.setPosition({ lineNumber: 1, column: 2 }), ide.editor.focus(), true)`);
  await press('Ctrl+Shift+V');
  await until(popupOpen, 'paste from history popup');
  check(await js(`document.activeElement?.id === 'pasteHistoryFilter'`), 'Ctrl+Shift+V opens the popup with the filter focused');
  check(J(await js(`[...document.querySelectorAll('#pasteHistoryList .ch-row .ch-label')].map(n => n.textContent)`)) === J(['beta', 'gamma', 'first line']), 'the popup lists the history newest first, by first line');
  check(await js(`[...document.querySelectorAll('#pasteHistoryList .ch-hint')].some(n => n.textContent === '2 lines')`), 'a multi-line item shows its line count');
  check(await js(`document.querySelector('#pasteHistoryPreview').textContent === 'beta'`), 'the preview shows the selected text');
  await type('gam');
  await until(`document.querySelectorAll('#pasteHistoryList .ch-row').length === 1`, 'filtered');
  check(await js(`document.querySelector('#pasteHistoryList .ch-row .ch-label').textContent === 'gamma'`), 'typing filters the list');
  await shot('paste-from-history.png');
  await press('Enter');
  await until(`!${popupOpen}`, 'popup closed');
  check((await text()) === 'Agamma-B\n' && (await js(`document.activeElement?.closest('.monaco-editor') !== null`)), `Enter pastes into the editor at the caret and gives it the keyboard back (${J(await text())})`);
  check((await history())[0] === 'gamma', 'the pasted text moves to the top of the history');
  // Delete removes an item, Esc closes.
  await press('Ctrl+Shift+V');
  await until(popupOpen, 'popup again');
  await press('ArrowDown');
  check(await js(`document.querySelector('#pasteHistoryList .ch-row.active .ch-label').textContent === 'beta'`), 'ArrowDown selects the next item');
  await press('Delete');
  await until(`!ide.clipboardHistory.items().some(i => i.text === 'beta')`, 'beta removed');
  check(await js(`${popupOpen} && document.querySelectorAll('#pasteHistoryList .ch-row').length === 2`), 'Delete removes the selected item and the popup stays open');
  await press('Escape');
  await until(`!${popupOpen}`, 'Esc closes');
  check((await text()) === 'Agamma-B\n', 'Esc pastes nothing');

  // Multi-caret copy and paste: each caret gets its own piece.
  await setText('x = 1\ny = 2\nz = 3\n\n\n\n');
  await js(`(ide.editor.setSelections([1, 2, 3].map(l => ({ selectionStartLineNumber: l, selectionStartColumn: 1, positionLineNumber: l, positionColumn: 2 }))), ide.editor.focus(), true)`);
  await k.ctrlChord('C');
  await until(`ide.clipboardHistory.items()[0]?.multicursor?.length === 3`, 'multi-caret copy');
  check(J(await js(`ide.clipboardHistory.items()[0].multicursor`)) === J(['x', 'y', 'z']), 'a copy with three carets keeps each caret\'s text');
  await js(`(ide.clipboardHistory.add('single'), true)`);
  await js(`(ide.editor.setSelections([4, 5, 6].map(l => ({ selectionStartLineNumber: l, selectionStartColumn: 1, positionLineNumber: l, positionColumn: 1 }))), ide.editor.focus(), true)`);
  await press('Ctrl+Shift+V');
  await until(popupOpen, 'popup for multi-caret');
  check(await js(`[...document.querySelectorAll('#pasteHistoryList .ch-hint')].some(n => n.textContent === '3 carets')`), 'the multi-caret item shows its caret count');
  await press('ArrowDown');
  await press('Enter');
  await until(`!${popupOpen}`, 'closed after multi paste');
  check((await text()) === 'x = 1\ny = 2\nz = 3\nx\ny\nz\n', `pasting into three carets gives each caret its piece (${J(await text())})`);
  // With a different number of carets, every caret gets the whole text.
  await setText('a\nb\n');
  await js(`(ide.editor.setSelections([1, 2].map(l => ({ selectionStartLineNumber: l, selectionStartColumn: 2, positionLineNumber: l, positionColumn: 2 }))), ide.editor.focus(), true)`);
  await js(`ide.clipboardHistory.paste('single')`);
  check((await text()) === 'asingle\nbsingle\n', 'a single text is pasted at every caret');
  // Monaco's whole-line copy (no selection) pastes as a line above the caret.
  await setText('line one\nline two\n');
  await js(`(ide.editor.setPosition({ lineNumber: 1, column: 3 }), ide.editor.focus(), true)`);
  await k.ctrlChord('C');
  await until(`ide.clipboardHistory.items()[0]?.wholeLine === true`, 'whole-line copy');
  await js(`(ide.editor.setPosition({ lineNumber: 2, column: 4 }), ide.clipboardHistory.add('other'), true)`);
  await press('Ctrl+Shift+V');
  await until(popupOpen, 'popup for whole line');
  await press('ArrowDown');
  await press('Enter');
  await until(`!${popupOpen}`, 'closed');
  check((await text()) === 'line one\nline one\nline two\n', `a whole-line copy pastes as a line above the caret (${J(await text())})`);
  check(!(await js(`ide.api.invoke('clipboard-history:stored')`)), 'nothing is written to disk while keeping the history is off');

  // ---------------------------------------------------------------- Run Anything: Double Ctrl
  await js(`ide.editor.focus()`);
  check(J(await js(`ide.actions.find(a => a.id === 'RunAnything').keys`)) === J(['Ctrl Ctrl']) && await js(`ide.keymap.hint('RunAnything')`) === 'Double Ctrl', 'Run Anything is bound to Double Ctrl, shown as "Double Ctrl"');
  await k.doubleCtrl();
  await until(raOpen, 'Run Anything popup');
  check(await js(`document.activeElement?.id === 'runAnythingInput'`), 'Double Ctrl opens Run Anything with its input focused');
  await press('Escape');
  await until(`!${raOpen}`, 'Esc closes Run Anything');
  // Things that must not open it.
  await js(`ide.editor.focus()`);
  await k.ctrlChord('C'); await k.ctrlChord('V'); await k.ctrlChord('C');
  await sleep(400);
  check(!(await js(raOpen)), 'Ctrl+C, Ctrl+V, Ctrl+C in a row do not open it');
  await openFile(t, 'app.py');
  await js(`(ide.activeTab().model.setValue(ide.activeTab().model.getValue() + '\\n'), ide.editor.focus(), true)`);
  await k.ctrlTap();
  await k.ctrlChord('S');
  await sleep(400);
  check(!(await js(raOpen)), 'a Ctrl tap followed by Ctrl+S does not open it');
  await until(`!ide.isDirty(ide.activeTab())`, 'Ctrl+S saved');
  check(true, 'and Ctrl+S still saves');
  await k.ctrlTap();
  await sleep(500);
  await k.ctrlTap();
  await sleep(300);
  check(!(await js(raOpen)), 'two Ctrl taps 500 ms apart do not open it');
  await sleep(500);
  await k.ctrlTap();
  await js(`(document.querySelector('#editorArea').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
  await k.ctrlTap();
  await sleep(300);
  check(!(await js(raOpen)), 'a click between two Ctrl taps (Ctrl+click) does not open it');
  await sleep(500);
  // Double Shift still opens Search Everywhere.
  if (await js(`!!ide.searchEverywhere`)) {
    await js(`ide.editor.focus()`);
    await k.shiftDown(); await k.shiftUp(); await k.shiftDown(); await k.shiftUp();
    await until(`ide.searchEverywhere.isOpen()`, 'Search Everywhere');
    check(!(await js(raOpen)), 'Double Shift still opens Search Everywhere (and not Run Anything)');
    await press('Escape');
    await until(`!ide.searchEverywhere.isOpen()`, 'SE closed');
  }
  // Unbind and rebind through the keymap.
  await js(`(ide.settings.set('keymap.overrides', { RunAnything: [] }), ide.editor.focus(), true)`);
  await k.doubleCtrl();
  await sleep(400);
  check(!(await js(raOpen)), 'with its shortcut removed in the keymap, Double Ctrl does nothing');
  await js(`(ide.settings.set('keymap.overrides', { RunAnything: ['Ctrl+Alt+Shift+R'] }), ide.editor.focus(), true)`);
  await press('Ctrl+Alt+Shift+R');
  await until(raOpen, 'rebound shortcut');
  check(true, 'rebinding it in the keymap works');
  await press('Escape');
  await js(`(ide.settings.set('keymap.overrides', {}), ide.editor.focus(), true)`);
  await sleep(100);
  check(J(await js(`ide.actions.find(a => a.id === 'RunAnything').keys`)) === J(['Ctrl Ctrl']), 'Reset gives Double Ctrl back');
  check(await js(`ide.keymap.isValid('Ctrl Ctrl')`), 'Double Ctrl is a valid keymap key');

  // ---------------------------------------------------------------- Run Anything: running
  const raType = async (s) => { await k.doubleCtrl(); await until(raOpen, 'Run Anything'); await js(`(document.querySelector('#runAnythingInput').value = '', true)`); if (s) await type(s); await sleep(150); };
  const activeRow = () => js(`document.querySelector('#runAnythingList .ra-row.active .ra-label')?.textContent`);
  // A run configuration.
  await js(`(ide.run.addTemporary({ type: 'python', name: 'app-config', script: ide.util.joinPath(ide.root, 'app.py'), params: 'from-config' }), true)`);
  await js(`ide.editor.focus()`);
  await raType('app-con');
  check((await activeRow()) === 'app-config', 'typing a configuration name selects the configuration');
  await press('Enter');
  await until(`${runText('app-config')}.includes('APP-OUT from-config') && ${runText('app-config')}.includes('Process finished')`, 'config output', 30000);
  check(true, 'Enter runs the run configuration in the Run tool window (output seen)');
  // A Python file with arguments.
  await js(`ide.editor.focus()`);
  await raType('python app.py extra');
  check((await activeRow()) === 'python app.py extra', 'a typed command is the first row');
  check(await js(`document.querySelector('#runAnythingList .ra-row.active .ra-detail').textContent === 'Run tool window'`), 'python commands say they run in the Run tool window');
  await press('Enter');
  await until(`${runText('python app.py extra')}.includes('APP-OUT extra') && ${runText('python app.py extra')}.includes('Process finished with exit code 0')`, 'python file output', 30000);
  check(true, '`python app.py extra` runs the file with the project interpreter in the Run tool window');
  // python -m
  await js(`ide.editor.focus()`);
  await raType('python -m modx');
  await press('Enter');
  await until(`${runText('python -m modx')}.includes('MODX-OUT')`, 'python -m output', 30000);
  check(true, '`python -m modx` runs the module');
  // A terminal command.
  await js(`ide.editor.focus()`);
  await raType('echo marker-RA1');
  check(await js(`document.querySelector('#runAnythingList .ra-row.active .ra-detail').textContent === 'Terminal'`), 'other commands say they run in the Terminal');
  await press('Enter');
  await until(`${termText('echo marker-RA1')}.includes('marker-RA1')`, 'terminal output', 30000);
  check(await js(`ide.toolWindows.get('Terminal').isVisible()`), '`echo marker-RA1` runs in a new Terminal session and its output shows there');
  // History and suggestions.
  const hist = await js(`ide.runAnything.history()`);
  check(J(hist.slice(0, 3)) === J(['echo marker-RA1', 'python -m modx', 'python app.py extra']), `commands are remembered newest first (${J(hist)})`);
  check(await js(`Array.isArray(ide.settings.get('runAnything.history:' + ide.root))`), 'the history is stored per project');
  await js(`ide.editor.focus()`);
  await raType('');
  check(J(await js(`[...document.querySelectorAll('#runAnythingList .ra-group')].map(n => n.textContent)`)).includes('Recent'), 'the empty popup lists recent commands');
  check(await js(`[...document.querySelectorAll('#runAnythingList .ra-row .ra-label')].some(n => n.textContent === 'echo marker-RA1')`), 'with the last command among them');
  await type('python ap');
  await sleep(200);
  await until(`[...document.querySelectorAll('#runAnythingList .ra-row .ra-label')].some(n => n.textContent === 'python app.py')`, 'file suggestion');
  check(true, 'typing `python ap` suggests `python app.py` from the project files');
  await js(`(() => { const rows = [...document.querySelectorAll('#runAnythingList .ra-row')]; const r = rows.find(r => r.querySelector('.ra-label').textContent === 'python app.py'); rows.forEach(x => x.classList.toggle('active', x === r)); return true; })()`);
  await press('Tab');
  check(await js(`document.querySelector('#runAnythingInput').value`) === 'python app.py', 'Tab completes the input with the selected suggestion');
  await k.shiftDown();
  check(await js(`!document.querySelector('#runAnything .ra-mode').classList.contains('hidden')`), 'holding Shift switches the popup to Debug');
  await k.shiftUp();
  await press('Escape');
  await js(`ide.editor.focus()`);
  await raType('pip ins');
  check(await js(`[...document.querySelectorAll('#runAnythingList .ra-row .ra-label')].some(n => n.textContent.startsWith('pip install'))`), 'typing `pip ins` suggests pip install');
  await press('Escape');

  // ---------------------------------------------------------------- File and Code Templates
  // The files are compared byte for byte with LF; the default "System-Dependent" line separator for new files writes
  // CRLF on Windows (covered by verify/line-endings.mjs).
  await js(`(ide.settings.set('editor.lineSeparator', 'lf'), true)`);
  check(await js(`ide.fileTemplates.find('Python Script').body === ''`), 'the Python Script template is empty by default');
  // Core's New Python File with the default (empty) template.
  await js(`ide.revealInTree(ide.util.joinPath(ide.root, 'app.py'))`);
  await js(`(ide.runAction('NewPythonFile'), true)`);
  await answerPrompt(t, 'plain_new');
  await until(`ide.activeTab()?.title === 'plain_new.py'`, 'plain file opened');
  check(readFileSync(path.join(t.project, 'plain_new.py'), 'utf8') === '', 'New Python File with the default template creates an empty file');
  // A header in the Python Script template, through the tree's New › Python File in a sub-package.
  const header = '# ${NAME} by ${USER} on ${DATE} ${TIME}\n# project=${PROJECT_NAME} package=${PACKAGE_NAME} year=$YEAR cost=\\$5 ${DS}{x}\n';
  await js(`(ide.settings.set('fileTemplates.custom', { 'Python Script': { body: ${J(header)} } }), true)`);
  await js(`ide.revealInTree(ide.util.joinPath(ide.root, 'pkg\\\\sub\\\\__init__.py'))`);
  await treeMenu(t, 'sub', ['New', 'Python File']);
  await answerPrompt(t, 'module_one');
  const modOne = path.join(t.project, 'pkg', 'sub', 'module_one.py');
  await until(`ide.activeTab()?.title === 'module_one.py'`, 'module_one opened');
  const user = os.userInfo().username;
  const timeRe = '\\d\\d:\\d\\d';
  const got = readFileSync(modOne, 'utf8');
  check(new RegExp(`^# module_one by ${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} on ${today} ${timeRe}\\n# project=project package=pkg\\.sub year=${new Date().getFullYear()} cost=\\$5 \\$\\{x\\}\\n$`).test(got),
    `New › Python File substitutes NAME, USER, DATE, TIME, PROJECT_NAME, PACKAGE_NAME, $YEAR, \\$ and DS (${J(got)})`);
  await js(`ide.revealInTree(ide.util.joinPath(ide.root, 'app.py'))`);
  await js(`(ide.runAction('NewPythonFile'), true)`);
  await answerPrompt(t, 'with_header');
  await until(`ide.activeTab()?.title === 'with_header.py'`, 'with_header opened');
  check(readFileSync(path.join(t.project, 'with_header.py'), 'utf8').startsWith('# with_header by '), 'core New Python File (Alt+Insert, toolbar, File menu) uses the Python Script template too');
  // Python Package
  await js(`(ide.settings.set('fileTemplates.custom', { 'Python Package': { body: '"""The ${'${NAME}'} package."""\\n' } }), true)`);
  await treeMenu(t, 'project', ['New', 'Python Package']);
  await answerPrompt(t, 'newpkg.inner');
  const init = path.join(t.project, 'newpkg', 'inner', '__init__.py');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('inner\\\\__init__.py')`, 'package init opened');
  check(existsSync(path.join(t.project, 'newpkg', '__init__.py')) || existsSync(path.join(t.project, 'newpkg')), 'New › Python Package creates the folders');
  check(readFileSync(init, 'utf8') === '"""The inner package."""\n', `the package's __init__.py comes from the Python Package template (${J(readFileSync(init, 'utf8'))})`);
  // HTML File
  await treeMenu(t, 'project', ['New', 'HTML File']);
  await answerPrompt(t, 'index');
  await until(`ide.activeTab()?.title === 'index.html'`, 'html opened');
  check(readFileSync(path.join(t.project, 'index.html'), 'utf8').includes('<title>index</title>'), 'New › HTML File creates index.html with ${NAME} in the title');
  // A Python Package a.b whose template has a custom variable: asked for before any folder is made, so Cancel leaves none.
  await js(`(ide.settings.set('fileTemplates.custom', { 'Python Package': { body: '# \${AUTHOR}\\n' } }), true)`);
  await treeMenu(t, 'project', ['New', 'Python Package']);
  await answerPrompt(t, 'ghostpkg.inner');
  await until(`!!document.querySelector('.ft-vars input[data-var="AUTHOR"]')`, 'package variable dialog');
  check(!existsSync(path.join(t.project, 'ghostpkg')), 'no package folder exists while the variable dialog is open');
  await js(`(${dialogButton('Cancel')}.click(), true)`);
  await until(`!document.querySelector('.ft-vars')`, 'package variable dialog closed');
  await sleep(400);
  check(!existsSync(path.join(t.project, 'ghostpkg')), 'cancelling the variables of a Python Package a.b leaves no folders behind');
  // A user template with a custom variable: asked for in a dialog; Cancel creates nothing.
  await js(`(ide.settings.set('fileTemplates.custom', { 'Greeting': { ext: 'txt', body: 'Hello \${WHO} from \${NAME}!\\n' } }), true)`);
  await treeMenu(t, 'project', ['New', 'Greeting']);
  await answerPrompt(t, 'greet');
  await until(`!!document.querySelector('.ft-vars input[data-var="WHO"]')`, 'variable dialog');
  await js(`(${dialogButton('Cancel')}.click(), true)`);
  await sleep(400);
  check(!existsSync(path.join(t.project, 'greet.txt')), 'cancelling the variable dialog creates nothing');
  await treeMenu(t, 'project', ['New', 'Greeting']);
  await answerPrompt(t, 'greet');
  await until(`!!document.querySelector('.ft-vars input[data-var="WHO"]')`, 'variable dialog again');
  await js(`(() => { const i = document.querySelector('.ft-vars input[data-var="WHO"]'); i.focus(); return true; })()`);
  await type('세계');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'greet.txt'`, 'greet opened');
  check(readFileSync(path.join(t.project, 'greet.txt'), 'utf8') === 'Hello 세계 from greet!\n', 'a custom ${WHO} variable is asked for and substituted (Korean text kept)');
  // Edit and reset in Settings › Editor › File and Code Templates.
  await js(`(ide.settings.set('fileTemplates.custom', {}), ide.openSettings('file-templates'), true)`);
  await until(`!!document.querySelector('.ft-row[data-template="JSON File"]')`, 'templates page');
  check(await js(`[...document.querySelectorAll('.settings-crumb, .settings-page legend')].some(n => n.textContent.includes('File and Code Templates') || n.textContent === 'Files')`), 'Settings › Editor › File and Code Templates lists the templates');
  await js(`(document.querySelector('.ft-row[data-template="JSON File"]').click(), true)`);
  await js(`(() => { const b = document.querySelector('.ft-body'); b.value = '{"name": "\${NAME}"}\\n'; b.dispatchEvent(new Event('input')); return true; })()`);
  check(await js(`document.querySelector('.ft-row[data-template="JSON File"]').classList.contains('modified') && !document.querySelector('.ft-reset').disabled`), 'an edited built-in is marked modified and can be reset');
  await js(`(${dialogButton('OK')}.click(), true)`);
  await until(`ide.settings.get('fileTemplates.custom', {})['JSON File']?.body === '{"name": "\${NAME}"}\\n'`, 'edited template saved');
  check(true, 'OK saves the edited template');
  await treeMenu(t, 'project', ['New', 'JSON File']);
  await answerPrompt(t, 'conf');
  await until(`ide.activeTab()?.title === 'conf.json'`, 'json opened');
  check(readFileSync(path.join(t.project, 'conf.json'), 'utf8') === '{"name": "conf"}\n', 'a new JSON file uses the edited template');
  await js(`ide.settings.flush()`);
  const snap = archive.snapshot(userData);
  check(snap.appearance['fileTemplates.custom']?.['JSON File']?.body === '{"name": "${NAME}"}\n', 'Settings export includes the file templates');
  check(archive.classify('clipboardHistory.limit', 30).category === 'appearance' && archive.classify('runAnything.history:C:\\p', ['x']).category === null,
    'clipboard settings are exported; the Run Anything history is not');
  await js(`(ide.openSettings('file-templates'), true)`);
  await until(`!!document.querySelector('.ft-row[data-template="JSON File"]')`, 'templates page again');
  await js(`(document.querySelector('.ft-row[data-template="JSON File"]').click(), document.querySelector('.ft-reset').click(), true)`);
  check(await js(`document.querySelector('.ft-body').value === '{\\n}\\n'`), 'Reset to Default restores the built-in text');
  await js(`(${dialogButton('OK')}.click(), true)`);
  await until(`!ide.settings.get('fileTemplates.custom', {})['JSON File']`, 'reset saved');
  check(true, 'and OK saves the reset');

  // ---------------------------------------------------------------- keep the history for the restart below
  await js(`(ide.settings.set('clipboardHistory.persist', true), ide.clipboardHistory.add('kept across restarts'), true)`);
  // Turning the option on saves the history at once, without the item added right after it (that save follows 300 ms
  // later): wait for the item itself, since the instance is killed below and gets no beforeunload to save it.
  await until(`ide.api.invoke('clipboard-history:load').then((l) => l.some((i) => i.text === 'kept across restarts'))`, 'history stored');
  check(!readFileSync(path.join(userData, 'clipboard-history.bin')).toString('latin1').includes('kept across restarts'), 'the kept history is encrypted on disk');
  await js(`ide.settings.flush()`);
} catch (e) {
  check(false, e.stack || e.message);
  await shot('failure-a.png').catch(() => {});
}
if (t.consoleErrors.length) check(false, `renderer exceptions (A): ${t.consoleErrors.join(' | ')}`);
const aResults = t.results;
t.close();

// ===================================================================== instance B: restart in Korean
const b = await launch({ fixture: 'editing-comfort', port: 9341, name: 'editing-comfort-ko', lang: 'ko-KR', userData });
try {
  const kb = keys(b);
  await b.until(`ide.clipboardHistory.items().some(i => i.text === 'kept across restarts')`, 'restored history');
  b.check(true, 'with the option on, the history is back after a restart');
  await openFile(b, 'app.py');
  await b.js(`ide.editor.focus()`);
  await b.press('Ctrl+Shift+V');
  await b.until(popupOpen, 'popup (ko)');
  b.check(await b.js(`document.querySelector('#pasteFromHistory .ch-title').textContent === '기록에서 붙여넣기'`), 'Paste from History is Korean');
  const leaks1 = await englishLeaks(b, '#pasteFromHistory');
  b.check(!leaks1.length, `no English in the Korean popup (${J(leaks1)})`);
  await b.press('Escape');
  await kb.doubleCtrl();
  await b.until(raOpen, 'Run Anything (ko)');
  await b.type('echo 안녕');
  await b.sleep(150);
  b.check(await b.js(`document.querySelector('#runAnything .ra-title').textContent === '무엇이든 실행' && document.querySelector('#runAnythingList .ra-row.active .ra-detail').textContent === '터미널'`), 'Run Anything is Korean');
  const leaks2 = await englishLeaks(b, '#runAnything');
  b.check(!leaks2.length, `no English in the Korean Run Anything popup (${J(leaks2)})`);
  await b.press('Enter');
  await b.until(`${termText('echo 안녕')}.includes('안녕')`, 'Korean terminal output', 30000);
  b.check(true, 'a command with Korean text runs and prints it');
  await treeMenu(b, 'project', ['새로 만들기']);
  b.check(await b.js(`!!${menuRow('Python 파일')} && !!${menuRow('Python 패키지')} && !!${menuRow('HTML 파일')} && !!${menuRow('파일 템플릿 편집…')}`), 'the New submenu is Korean');
  await b.press('Escape'); await b.press('Escape');
  await b.js(`(ide.openSettings('file-templates'), true)`);
  await b.until(`!!document.querySelector('.ft-row[data-template="Python Script"]')`, 'templates page (ko)');
  b.check(await b.js(`document.querySelector('.ft-row[data-template="Python Script"] .ft-row-name').textContent === 'Python 스크립트'`), 'the File and Code Templates page is Korean');
  const leaks3 = await englishLeaks(b, '.ft-page');
  b.check(!leaks3.length, `no English on the templates page (${J(leaks3)})`);
  await b.js(`(ide.openSettings('clipboard'), true)`);
  await b.until(`[...document.querySelectorAll('.settings-page legend')].some(n => n.textContent === '기록에서 붙여넣기')`, 'clipboard page (ko)');
  b.check(true, 'the Clipboard settings page is Korean');
  await b.press('Escape');
  const missing = (await missingTranslations(b)).filter((s) => ownStrings.has(s));
  b.check(!missing.length, `no missing Korean translations for these plugins (${J(missing)})`);
  // Turning the option off deletes the stored history.
  await b.js(`(ide.settings.set('clipboardHistory.persist', false), true)`);
  await b.until(`ide.api.invoke('clipboard-history:stored').then(s => !s)`, 'stored history deleted');
  b.check(true, 'turning the option off deletes the stored history');
} catch (e) {
  b.check(false, e.stack || e.message);
  await b.shot('failure-b.png').catch(() => {});
}
if (b.consoleErrors.length) b.check(false, `renderer exceptions (B): ${b.consoleErrors.join(' | ')}`);
const bResults = b.results;
b.close();

// ===================================================================== instance C: Safe Mode
const work = mkdtempSync(path.join(os.tmpdir(), 'pyide-editing-comfort-'));
const home = path.join(work, 'home');
const untrusted = path.join(work, 'downloaded');
cpSync(path.join(APP, 'verify', 'fixtures', 'editing-comfort'), home, { recursive: true });
cpSync(path.join(APP, 'verify', 'fixtures', 'editing-comfort'), untrusted, { recursive: true });
const cUser = path.join(work, 'userdata');
mkdirSync(cUser);
writeFileSync(path.join(cUser, 'settings.json'), J({ recentProjects: [{ path: home, opened: Date.now() }] }));
const c = await launch({ fixture: 'editing-comfort', port: 9342, name: 'editing-comfort-safe', projectDir: home, userData: cUser, env: { PYIDE_TRUST_ALL: '' } });
try {
  const kc = keys(c);
  c.js(`ide.openProject(${J(untrusted)})`);
  await c.until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Trust and Open Project?')`, 'trust question');
  await c.js(`(${dialogButton('Preview in Safe Mode')}.click(), true)`);
  await c.until(`ide.root && ide.util.samePath(ide.root, ${J(untrusted)}) && ide.trusted === false`, 'Safe Mode');
  await c.sleep(800);
  await openFile(c, 'app.py');
  await c.js(`ide.editor.focus()`);
  await kc.doubleCtrl();
  await c.until(raOpen, 'Run Anything (safe)');
  await c.type('echo safe-RA');
  await c.sleep(150);
  await c.press('Enter');
  await c.until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Trust Project?')`, 'trust question from Run Anything');
  c.check(true, 'in Safe Mode, Run Anything asks to trust the project before running anything');
  await c.js(`(${dialogButton('Cancel')}.click(), true)`);
  await c.sleep(800);
  c.check(await c.js(`!ide.terminal.sessions().some(s => s.name === 'echo safe-RA') && !ide.runAnything.history().length`), 'Cancel runs nothing and remembers nothing');
  await c.js(`ide.editor.focus()`);
  await kc.doubleCtrl();
  await c.until(raOpen, 'Run Anything (safe, again)');
  await c.type('echo safe-RA');
  await c.sleep(150);
  await c.press('Enter');
  await c.until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Trust Project?')`, 'trust question again');
  await c.js(`(${dialogButton('Trust Project')}.click(), true)`);
  await c.until(`window.__ideReady === true && ide.trusted === true && !!document.querySelector('#runAnything') && document.querySelector('#runAnythingInput').value === 'echo safe-RA'`, 'reopened trusted with the command waiting', 40000);
  c.check(await c.js(`!ide.terminal.sessions().some(s => s.name === 'echo safe-RA')`), 'after Trust Project the page reopens with the command in Run Anything, not yet run');
  await c.press('Enter');
  await c.until(`${termText('echo safe-RA')}.includes('safe-RA')`, 'runs after trusting', 30000);
  c.check(true, 'Enter then runs it');
} catch (e) {
  c.check(false, e.stack || e.message);
  await c.shot('failure-c.png').catch(() => {});
}
const all = [...aResults, ...bResults, ...c.results];
c.results.length = 0;
c.results.push(...all);
c.finish();
