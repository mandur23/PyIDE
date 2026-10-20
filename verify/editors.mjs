// Editor groups (split panes), tab management, preview/pinned tabs, encodings, binary files and detached windows.
import { chmodSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { launch, openFile } from './lib.mjs';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');
const PORT = 9490;
const t = await launch({ fixture: 'editors', port: PORT, name: 'editors' });
const { js, until, press, type, click, check, shot } = t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const groupCount = () => js('ide.groups().length');
// Only file tabs: other plugins may add their own custom tabs (e.g. a workspace home page).
const tabTitles = (i) => js(`ide.groups()[${i}].tabs.filter(t => t.kind === 'file').map(t => t.title).join('|')`);
const fileTabCount = (i) => `ide.groups()[${i}].tabs.filter(t => t.kind === 'file').length`;

// Minimal CDP client for a second window (detached editors).
async function attach(predicate) {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(250);
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((p) => p.type === 'page' && predicate(p.url));
  }
  if (!page) throw new Error('second window not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  ws.addEventListener('close', () => { for (const r of pending.values()) r({}); pending.clear(); });
  const cdp = (method, params = {}) => new Promise((r) => {
    if (ws.readyState !== WebSocket.OPEN) return r({});
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ejs = async (expr) => (await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const euntil = async (expr, label, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await ejs(expr)) return; } catch {} await sleep(150); }
    throw new Error(`timeout (detached): ${label}`);
  };
  return { cdp, js: ejs, until: euntil, close: () => ws.close() };
}

// Synthetic HTML5 drag of a tab onto a target element, at a position inside it (fractions of its box).
const dragTab = (fromGroup, title, targetExpr, fx, fy) => js(`(() => {
  const g = ide.groups()[${fromGroup}];
  const tab = [...g.el.querySelectorAll('.tab')].find(n => n.querySelector('.name').textContent === ${JSON.stringify(title)});
  const target = ${targetExpr};
  const r = target.getBoundingClientRect();
  const x = r.left + r.width * ${fx}, y = r.top + r.height * ${fy};
  const dt = new DataTransfer();
  tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return true;
})()`);

try {
  // ---------- split and clone ----------
  await openFile(t, 'a.py');
  check(await js(`(() => {
    const tab = document.querySelector('.tab.active'), c = tab.querySelector('.close'), r = c.getBoundingClientRect(), n = tab.querySelector('.name').getBoundingClientRect();
    const s = getComputedStyle(c), x = getComputedStyle(c, '::before');
    return r.width === 16 && r.height === 16 && s.display === 'flex' && s.alignItems === 'center' && s.justifyContent === 'center'
      && x.width === '8px' && x.height === '8px' && Math.abs((r.top + r.bottom) / 2 - (n.top + n.bottom) / 2) <= 1;
  })()`), 'the tab close cross is centered in a square hover box level with the file name');
  await js('ide.editor.focus()');
  await press('Ctrl+\\');
  await until(`ide.groups().length === 2`, 'split right');
  check((await tabTitles(1)) === 'a.py' && await js(`ide.editor === ide.groups()[1].editor`), 'Ctrl+\\ splits right with a clone, focused');
  check(await js(`ide.groups()[0].editor.getModel() === ide.groups()[1].editor.getModel()`), 'both panes share one document model');
  check(await js(`(() => { const [a, b] = ide.groups().map(g => g.el.getBoundingClientRect()); return Math.abs(a.top - b.top) < 2 && b.left >= a.right - 2; })()`), 'second pane sits to the right');
  await js(`ide.editor.setPosition({ lineNumber: 2, column: 1 })`);
  await type('    # edited in right pane\n');
  check(await js(`ide.groups()[0].editor.getModel().getValue().includes('edited in right pane')`), 'typing in one pane shows in the other');
  check(await js(`document.querySelectorAll('.tab .dirty').length === 2`), 'both tabs show the modified marker');
  await press('Ctrl+S');
  await until(`!document.querySelector('.tab .dirty')`, 'saved');
  check(readFileSync(path.join(t.project, 'a.py'), 'utf8').includes('edited in right pane'), 'Ctrl+S from a split pane writes the file');

  await press('Ctrl+Shift+\\');
  await until(`ide.groups().length === 3`, 'split down');
  check(await js(`(() => { const g = ide.groups(); const a = g[1].el.getBoundingClientRect(), b = g[2].el.getBoundingClientRect(); return b.top >= a.bottom - 2 && Math.abs(a.left - b.left) < 2; })()`), 'Ctrl+Shift+\\ splits the focused pane downward');
  await shot('three-panes.png');

  // ---------- focus, move, unsplit ----------
  await press('Ctrl+1');
  check(await js(`ide.editor === ide.groups()[0].editor`), 'Ctrl+1 focuses the first pane');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'b.py'))`);
  await until(`ide.groups()[0].active?.title === 'b.py'`, 'b.py in pane 1');
  await dragTab(0, 'b.py', `ide.groups()[1].el.querySelector('.group-body')`, 0.5, 0.5);
  await until(`ide.groups()[1].tabs.some(t => t.title === 'b.py') && !ide.groups()[0].tabs.some(t => t.title === 'b.py')`, 'b.py moved');
  check(true, 'dragging a tab onto another pane moves it');
  await dragTab(1, 'b.py', `ide.groups()[1].el.querySelector('.group-body')`, 0.95, 0.5);
  await until(`ide.groups().length === 4`, 'drop on the edge splits');
  check(await js(`ide.groups().some(g => g.tabs.length === 1 && g.tabs[0].title === 'b.py')`), 'dropping a tab on a pane edge splits it off');
  await js(`ide.runAction('UnsplitAll')`);
  await until(`ide.groups().length === 1`, 'unsplit all');
  const merged = await tabTitles(0);
  check(merged.split('|').sort().join('|') === 'a.py|b.py', `Unsplit All merges every pane into one without duplicates (${merged})`);

  // ---------- tab operations ----------
  for (const f of ['c.py', 'notes.txt', 'pkg\\d.py']) await js(`ide.openFile(ide.util.joinPath(ide.root, ${JSON.stringify(f)}))`);
  await until(`(${fileTabCount(0)}) === 5`, 'five tabs');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'c.py'))`);
  await js(`ide.runAction('PinActiveTab')`);
  check((await tabTitles(0)).startsWith('c.py') && await js(`!!document.querySelector('.tab.pinned .pin')`), 'pinned tab moves to the front with a pin icon');
  await js(`(() => { const n = [...document.querySelectorAll('.tab')].find(n => n.textContent.includes('notes.txt')); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 60 })); })()`);
  await until(`!!document.querySelector('.context-menu')`, 'tab menu');
  const menu = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.firstChild.textContent)`);
  check(['Close Other Tabs', 'Close Tabs to the Right', 'Pin Tab', 'Split Right', 'Split Down', 'Open in New Window', 'Copy Path', 'Select in Project View', 'Show in Explorer'].every((x) => menu.includes(x)), 'tab context menu offers close, pin, split, window and path actions');
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.startsWith('Close Other Tabs')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(`(${fileTabCount(0)}) === 2`, 'close others');
  check((await tabTitles(0)) === 'c.py|notes.txt', 'Close Other Tabs keeps the pinned tab');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'notes.txt'))`);
  await press('Ctrl+F4');
  await until(`(${fileTabCount(0)}) === 1`, 'closed');
  await press('Ctrl+Shift+T');
  await until(`ide.groups()[0].tabs.some(t => t.title === 'notes.txt')`, 'reopened');
  check(true, 'Ctrl+Shift+T reopens the last closed tab');

  // ---------- preview tab and tab limit ----------
  await js(`ide.settings.set('editor.previewTab', true)`);
  await js(`[...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('a.py')).click()`);
  await until(`ide.groups()[0].tabs.some(t => t.title === 'a.py' && t.preview)`, 'preview a.py');
  await js(`[...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('b.py')).click()`);
  await until(`ide.groups()[0].tabs.some(t => t.title === 'b.py' && t.preview)`, 'preview b.py');
  check(!(await tabTitles(0)).includes('a.py') && await js(`!!document.querySelector('.tab.preview .name')`), 'a single click replaces the preview tab (shown in italics)');
  await js(`[...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('b.py')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await until(`ide.groups()[0].tabs.some(t => t.title === 'b.py' && !t.preview)`, 'b.py kept');
  check(true, 'double-click keeps the preview tab');
  await js(`ide.settings.set('editor.previewTab', false)`);
  await js(`ide.settings.set('editor.tabLimit', 3)`);
  for (const f of ['a.py', 'pkg\\d.py']) await js(`ide.openFile(ide.util.joinPath(ide.root, ${JSON.stringify(f)}))`);
  check(await js(`(${fileTabCount(0)}) <= 3 && ide.groups()[0].tabs.some(t => t.title === 'c.py')`), 'tab limit closes the least recently used tab but never a pinned one');
  await js(`ide.settings.set('editor.tabLimit', 10)`);

  // ---------- encodings ----------
  const cp949 = path.join(t.project, 'run_kr.bat');
  writeFileSync(cp949, iconv.encode('@echo off\r\nrem 한글 주석입니다\r\necho 시작\r\n', 'cp949'));
  await js(`ide.openFile(${JSON.stringify(cp949)})`);
  await until(`document.querySelector('#statusEncoding').textContent.startsWith('CP949')`, 'cp949 detected');
  check(await js(`ide.editor.getModel().getValue().includes('한글 주석입니다')`), 'CP949 file is decoded with Korean intact');
  await js(`ide.editor.setPosition({ lineNumber: 3, column: 1 })`);
  await js(`ide.editor.focus()`);
  await type('rem 수정\r\n');
  await press('Ctrl+S');
  await until(`!document.querySelector('.tab.active .dirty')`, 'cp949 saved');
  const saved = readFileSync(cp949);
  check(iconv.decode(saved, 'cp949').includes('rem 수정') && !saved.toString('utf8').includes('수정'), 'saving keeps the file in CP949');
  await click('#statusEncoding');
  await until(`!!document.querySelector('.context-menu')`, 'encoding menu');
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.startsWith('Convert to UTF-8')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(`document.querySelector('#statusEncoding').textContent === 'UTF-8'`, 'converted');
  check(readFileSync(cp949, 'utf8').includes('한글 주석입니다'), 'Convert to UTF-8 rewrites the file as UTF-8');

  // ---------- binary files ----------
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'data.bin'))`);
  await until(`!!document.querySelector('.custom-tab:not(.hidden) .binary-actions, .custom-tab:not(.hidden) [data-viewer]')`, 'binary viewer');
  check(true, 'a binary file opens a viewer instead of garbage text');

  // ---------- saving and reloading while the user types ----------
  // One IPC channel is slowed down so an edit lands while a save or a reload is waiting for the main process.
  const slowIpc = (channel, ms) => js(`(() => { const real = window.api; ide.api = { ...real, invoke: async (ch, ...a) => { if (ch === ${JSON.stringify(channel)}) await new Promise(r => setTimeout(r, ${ms})); return real.invoke(ch, ...a); } }; return true; })()`);
  const fastIpc = () => js(`(ide.api = window.api, true)`);
  const notes = path.join(t.project, 'notes.txt');
  const notesTab = `ide.findTab(${JSON.stringify(notes)})`;
  const insert = (text) => `${notesTab}.model.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: ${JSON.stringify(text)} }], () => null)`;
  await js(`ide.openFile(${JSON.stringify(notes)})`);
  await until(`!!${notesTab}`, 'notes.txt open');
  await slowIpc('fs:writeText', 400);
  const dirtyAfterSave = await js(`(async () => { ${insert('saved line\n')}; const p = ide.saveTab(${notesTab}); await new Promise(r => setTimeout(r, 100)); ${insert('typed during save\n')}; await p; return ide.isDirty(${notesTab}); })()`);
  await fastIpc();
  const onDisk = readFileSync(notes, 'utf8');
  check(dirtyAfterSave && onDisk.includes('saved line') && !onDisk.includes('typed during save'), 'text typed while a save is writing stays marked modified (it is not on disk yet)');
  await js(`ide.saveTab(${notesTab})`);
  writeFileSync(notes, 'changed on disk\n');
  await slowIpc('fs:readText', 400);
  const afterReload = await js(`(async () => { const p = ide.reloadFromDisk([${notesTab}.path]); await new Promise(r => setTimeout(r, 100)); ${insert('typed during reload\n')}; await p; return { text: ${notesTab}.model.getValue(), dirty: ide.isDirty(${notesTab}) }; })()`);
  await fastIpc();
  check(afterReload.text.includes('typed during reload') && !afterReload.text.includes('changed on disk') && afterReload.dirty, `a reload from disk does not overwrite text typed while the file was read (${JSON.stringify(afterReload)})`);

  // Save All in the close confirmation keeps the window open when a file cannot be written (read-only here).
  await js(`(window.__alerts = [], ide.ui.alert = (m) => window.__alerts.push(String(m)), true)`);
  chmodSync(notes, 0o444);
  t.cdp('Runtime.evaluate', { expression: "setTimeout(() => ide.api.invoke('window:close'), 0)" });
  await until(`document.querySelector('.dialog-title')?.textContent === 'Save Changes?'`, 'close confirmation (main window)', 8000);
  await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Save All').click()`);
  // notes.txt also changed on disk above: unless the project watcher already reloaded it before the typing, the save
  // asks first (File Cache Conflict, covered by verify/external-changes.mjs) and keeping the editor text goes on.
  await until(`window.__alerts.length > 0 || [...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'File Cache Conflict')`, 'save error or conflict', 8000);
  await js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Keep Memory Changes')?.click(), true)`);
  await until(`window.__alerts.length > 0 && !document.querySelector('.dialog-backdrop')`, 'save error shown');
  await sleep(800);
  check(await js(`ide.isDirty(${notesTab}) && window.__alerts[0].startsWith('Could not save notes.txt: ')`), 'Save All that fails to write keeps the window open with the file still modified');
  chmodSync(notes, 0o666);
  await js(`ide.saveTab(${notesTab})`);
  check(await js(`!ide.isDirty(${notesTab})`), 'the file saves once it is writable again');
  // A file that cannot be read gets a readable message, not Electron's IPC error text.
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'missing.py'))`);
  const openAlert = await js(`window.__alerts.pop()`);
  check(/^Cannot open missing\.py: /.test(openAlert) && !openAlert.includes('invoking remote method'), `opening a missing file explains why (${openAlert})`);

  // ---------- maximize editor ----------
  await press('Alt+F12');
  await until(`ide.toolWindows.get('Terminal').isVisible()`, 'terminal');
  await press('Ctrl+Shift+F12');
  check(await js(`![...ide.toolWindows.values()].some(tw => tw.isVisible())`), 'Ctrl+Shift+F12 hides all tool windows');
  await press('Ctrl+Shift+F12');
  check(await js(`ide.toolWindows.get('Terminal').isVisible() && ide.toolWindows.get('Project').isVisible()`), 'pressing it again restores them');

  // ---------- detached window ----------
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'c.py'))`);
  await js(`ide.editor.focus()`);
  await press('Shift+F4');
  const w = await attach((url) => url.includes('detached=1'));
  await w.until(`window.__ideReady === true && ide.activeTab()?.title === 'c.py'`, 'detached window shows c.py');
  check(await w.js(`document.body.classList.contains('detached') && getComputedStyle(document.querySelector('#stripe')).display === 'none'`), 'Shift+F4 opens the file in a window with only the editor');
  await w.js(`(ide.editor.setPosition({ lineNumber: 2, column: 1 }), ide.editor.trigger('test', 'type', { text: 'FROM_DETACHED = 1\\n' }), true)`);
  await until(`ide.getDocument(ide.util.joinPath(ide.root, 'c.py')).model.getValue().includes('FROM_DETACHED')`, 'edit synced to main', 8000);
  check(true, 'typing in the detached window updates the main window');
  await js(`(ide.openFile(ide.util.joinPath(ide.root, 'c.py')), ide.editor.setPosition({ lineNumber: 1, column: 1 }), ide.editor.trigger('test', 'type', { text: '# from main\\n' }), true)`);
  await w.until(`ide.editor.getModel().getValue().startsWith('# from main')`, 'edit synced to detached', 8000);
  check(true, 'typing in the main window updates the detached window');
  await w.js(`(ide.saveAll(), true)`);
  await until(`!ide.isDirty(ide.findTab(ide.util.joinPath(ide.root, 'c.py')))`, 'main sees saved state', 8000);
  check(readFileSync(path.join(t.project, 'c.py'), 'utf8').includes('FROM_DETACHED'), 'saving in the detached window writes the file and clears the modified marker in both windows');
  await w.js(`(ide.editor.trigger('test', 'type', { text: 'UNSAVED = 1\\n' }), true)`);
  // Not awaited: the evaluation may never answer while the window is closing.
  w.cdp('Runtime.evaluate', { expression: "setTimeout(() => ide.api.invoke('window:close'), 0)" });
  await w.until(`document.querySelector('.dialog-title')?.textContent === 'Save Changes?'`, 'close confirmation', 8000);
  check(true, 'closing a window with unsaved changes asks first');
  w.cdp('Runtime.evaluate', { expression: `setTimeout(() => [...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === "Don't Save").click(), 0)` });
  await sleep(800);
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((p) => p.type === 'page');
  check(pages.length === 1, "Don't Save closes the detached window");
  w.close();
  await shot('final.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
