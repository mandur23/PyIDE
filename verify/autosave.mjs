// Auto save (window blur, tab switch, idle timer) and actions on save (trailing whitespace, final newline, ruff
// reformat and optimize imports). Ports 9960-9961.
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'autosave', port: 9960 });
const { js, until, check, press, sleep } = t;
const disk = (f) => readFileSync(path.join(t.project, f), 'utf8');
const untilDisk = async (f, pred, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (pred(disk(f))) return true;
  return false;
};
const P = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
const set = (k, v) => js(`(ide.settings.set(${S(k)}, ${S(v)}), true)`);
// A model edit (not a key press, which would also restart the idle timer).
const edit = (f, text, line = 1, col = 1) => js(`(() => {
  const m = ide.getDocument(${P(f)}).model;
  m.pushEditOperations([], [{ range: new ide.monaco.Range(${line}, ${col}, ${line}, ${col}), text: ${S(text)} }], () => null);
  return true;
})()`);
const dirty = (f) => js(`ide.isDirty(ide.findTab(${P(f)}))`);
// Test windows run with CDP focus emulation, so the document always reports focus; the blur says it was lost.
const blur = () => js(`(() => {
  document.hasFocus = () => false;
  window.dispatchEvent(new Event('blur'));
  setTimeout(() => delete document.hasFocus, 50);
  return true;
})()`);
const save = (f) => js(`ide.saveTab(ide.findTab(${P(f)})).then(() => true)`);
const caret = (line, column) => js(`(ide.editor.setPosition({ lineNumber: ${line}, column: ${column} }), true)`);

try {
  // ---------- Settings: defaults ----------
  await js(`(ide.openSettings('system'), true)`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'system'`, 'System Settings page');
  check(await js(`(() => {
    const rows = [...document.querySelectorAll('.settings-nav-row')];
    const i = rows.findIndex((r) => r.dataset.group === 'appearance-behavior');
    const j = rows.findIndex((r) => r.dataset.page === 'system');
    return i >= 0 && j > i && rows[j].classList.contains('child') && rows.slice(i + 1, j).every((r) => r.classList.contains('child'));
  })()`), 'System Settings sits under Appearance & Behavior');
  check(await js(`['autosave.onFrameDeactivation', 'autosave.onTabSwitch', 'autosave.onIdle', 'autosave.beforeRun'].every((k) => document.querySelector('[data-key="' + k + '"]').checked)`),
    'autosave on blur, tab switch, idle and before run default to on');
  check(await js(`document.querySelector('[data-key="autosave.idleSeconds"]').value === '15'`), 'idle time defaults to 15 s');
  await js(`(ide.openSettings('actionsOnSave'), true)`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'actionsOnSave'`, 'Actions on Save page');
  check(await js(`['save.stripTrailingSpaces', 'save.ensureFinalNewline', 'tools.formatOnSave', 'tools.optimizeImportsOnSave'].every((k) => document.querySelector('[data-key="' + k + '"]'))`),
    'Actions on Save lists strip whitespace, final newline, reformat and optimize imports');
  await js(`(document.querySelector('#settingsCancel').click(), true)`);
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
  await set('autosave.onIdle', false);

  // ---------- window blur ----------
  await openFile(t, 'a.py');
  await edit('a.py', '# blur\n');
  check(disk('a.py') === 'x = 1\ny = 2\n', 'an edit alone does not write the file');
  await blur();
  check(await untilDisk('a.py', (s) => s === '# blur\nx = 1\ny = 2\n'), 'window blur writes the edited file');
  await until(`!ide.isDirty(ide.activeTab())`, 'clean after the blur save');
  await set('autosave.onFrameDeactivation', false);
  await edit('a.py', '# off\n');
  await blur();
  await sleep(800);
  check(!disk('a.py').includes('# off') && await dirty('a.py'), 'blur does not save with the setting off');
  await set('autosave.onFrameDeactivation', true);

  // ---------- tab switch ----------
  await openFile(t, 'b.py');
  check(await untilDisk('a.py', (s) => s.startsWith('# off\n')), 'switching to another tab saves the tab left behind');
  await edit('b.py', '# switch\n');
  await openFile(t, 'c.py');
  check(await untilDisk('b.py', (s) => s.startsWith('# switch\n')), 'switching tabs again saves b.py');
  await set('autosave.onTabSwitch', false);
  await edit('c.py', '# stay\n');
  await openFile(t, 'b.py');
  await sleep(800);
  check(!disk('c.py').includes('# stay') && await dirty('c.py'), 'tab switch does not save with the setting off');
  await set('autosave.onTabSwitch', true);

  // ---------- idle timer ----------
  await set('autosave.idleSeconds', 1);
  await set('autosave.onIdle', true);
  await openFile(t, 'd.py');
  await edit('d.py', '# idle\n');
  check(!disk('d.py').includes('# idle'), 'not saved right after the edit');
  const t0 = Date.now();
  check(await untilDisk('d.py', (s) => s.startsWith('# idle\n'), 5000) && Date.now() - t0 >= 700, `the idle timer saves after 1 s (${Date.now() - t0} ms)`);
  check(await untilDisk('c.py', (s) => s.startsWith('# stay\n'), 3000), 'the idle save covers every modified file');
  await set('autosave.onIdle', false);

  // ---------- untitled, read-only, in-memory ----------
  const files = readdirSync(t.project).sort().join();
  await openFile(t, 'e.py');
  await js(`(ide.getDocument(${P('e.py')}).untitled = true, true)`);
  await edit('e.py', '# untitled\n');
  await blur();
  await js(`ide.autoSave().then(() => true)`);
  check(disk('e.py') === "print('e')\n" && await dirty('e.py'), 'an untitled document is not auto-saved');
  await js(`(Object.assign(ide.getDocument(${P('e.py')}), { untitled: false, readOnly: true }), true)`);
  await js(`ide.autoSave().then(() => true)`);
  check(disk('e.py') === "print('e')\n" && await dirty('e.py'), 'a read-only document is not auto-saved');
  await js(`(() => {
    const model = ide.monaco.editor.createModel('scratch = 1\\n', 'python');
    ide.openCustomTab({ id: 'untitled-scratch', title: 'Untitled', mount: (host) => ide.createEditor(host, { model }) });
    model.setValue('scratch = 2\\n');
    return true;
  })()`);
  await blur();
  await js(`ide.autoSave().then(() => true)`);
  check(readdirSync(t.project).sort().join() === files, 'an in-memory buffer writes nothing to the project');
  await js(`(ide.closeTab('untitled-scratch', true), ide.closeTab(${P('e.py')}, true), true)`);

  // ---------- file changed on disk ----------
  await openFile(t, 'd.py');
  await edit('d.py', '# mine\n');
  writeFileSync(path.join(t.project, 'd.py'), 'external = True\n');
  await blur();
  await sleep(800);
  await js(`ide.autoSave().then(() => true)`);
  check(disk('d.py') === 'external = True\n' && await dirty('d.py'), 'a file changed on disk is not overwritten by auto save');
  // The status note follows the save on the next render; a slow runner may show it a moment later.
  const leftAlone = `!document.querySelector('#autosaveStatus').classList.contains('hidden') && document.querySelector('#autosaveStatus').textContent.includes('d.py changed on disk')`;
  for (let i = 0; i < 25 && !(await js(leftAlone)); i++) await sleep(200);
  check(await js(leftAlone), 'the status bar names the file auto save left alone');
  // The explicit save asks first (File Cache Conflict, verify/external-changes.mjs); keeping the editor text writes it.
  const saving = save('d.py');
  await until(`document.querySelector('.dialog-title')?.textContent === 'File Cache Conflict'`, 'file cache conflict');
  await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Keep Memory Changes').click()`);
  await saving;
  check(disk('d.py').startsWith('# mine\n') && await js(`document.querySelector('#autosaveStatus').classList.contains('hidden')`), 'an explicit save still writes it and clears the warning');

  // ---------- actions on save ----------
  await openFile(t, 'ws.py');
  await set('save.stripTrailingSpaces', false);
  await edit('ws.py', '  ', 1, 6);
  await caret(3, 1);
  await save('ws.py');
  check(disk('ws.py') === 'a = 1  \nb = 2   \nc = 3\n', 'trailing whitespace is kept with the action off');
  await set('save.stripTrailingSpaces', true);
  await edit('ws.py', ' ', 1, 8);
  await caret(3, 1);
  await save('ws.py');
  check(disk('ws.py') === 'a = 1\nb = 2   \nc = 3\n', 'trailing whitespace is stripped on the modified line only');
  await edit('ws.py', '  ', 3, 6);
  await caret(3, 8);
  await save('ws.py');
  check(disk('ws.py') === 'a = 1\nb = 2   \nc = 3  \n', 'the caret line keeps its trailing spaces');

  await openFile(t, 'noeol.txt');
  await edit('noeol.txt', 'x');
  await save('noeol.txt');
  check(disk('noeol.txt') === 'xfirst\nno newline', 'no final newline with the action off');
  await set('save.ensureFinalNewline', true);
  await edit('noeol.txt', 'y');
  await save('noeol.txt');
  check(disk('noeol.txt') === 'yxfirst\nno newline\n', 'a final newline is added with the action on');

  await openFile(t, 'fmt.py');
  await edit('fmt.py', '# a\n');
  await save('fmt.py');
  check(disk('fmt.py') === '# a\nx=1\n', 'no reformat with the action off');
  await set('tools.formatOnSave', true);
  await edit('fmt.py', '# b\n');
  await save('fmt.py');
  check(disk('fmt.py') === '# b\n# a\nx = 1\n', 'ruff reformats on save with the action on');

  await openFile(t, 'imports.py');
  await edit('imports.py', '# i\n');
  await save('imports.py');
  check(disk('imports.py').includes('import sys'), 'imports untouched with the action off');
  await set('tools.optimizeImportsOnSave', true);
  await edit('imports.py', '# j\n');
  await save('imports.py');
  check(!disk('imports.py').includes('import sys') && disk('imports.py').includes('import os'), 'optimize imports drops the unused import on save');

  // The actions also run on auto save.
  await openFile(t, 'b.py');
  await edit('b.py', 'y=2   \n');
  await caret(1, 1);
  await blur();
  check(await untilDisk('b.py', (s) => s.startsWith('y = 2\n')), 'actions run on auto save too');

  // ---------- one undo step, caret kept ----------
  await openFile(t, 'undo.py');
  await js(`(ide.editor.focus(), true)`);
  await edit('undo.py', '# u  \n');
  await caret(3, 5);
  await press('Ctrl+S');
  check(await untilDisk('undo.py', (s) => s === '# u\ndef f(a):\n    return a\n'), 'Ctrl+S applies reformat and whitespace stripping');
  check(await js(`(() => { const p = ide.editor.getPosition(); return p.lineNumber === 3 && p.column === 5; })()`), 'the caret stays where it was');
  await press('Ctrl+Z');
  check(await js(`ide.editor.getModel().getValue() === '# u  \\ndef f( a ):\\n    return a\\n'`), 'a single Ctrl+Z reverts all save actions');
  check(await dirty('undo.py'), 'after the undo the file is modified again');
  await press('Ctrl+Z');
  check(await js(`ide.editor.getModel().getValue() === 'def f( a ):\\n    return a\\n'`), 'the next Ctrl+Z undoes the edit before the save');
  await js(`(ide.closeTab(${P('undo.py')}, true), true)`);
} catch (err) {
  check(false, err.message);
}
const failedFirst = t.results.some((r) => !r.ok) || t.consoleErrors.length;
if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'autosave', port: 9961, name: 'autosave-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.openSettings('system'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'system'`, 'System Settings page (ko)');
  let leaks = await englishLeaks(k, '.settings-dialog');
  k.check(!leaks.length, `System Settings page is Korean (${leaks.join(' | ')})`);
  await k.js(`(ide.openSettings('actionsOnSave'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'actionsOnSave'`, 'Actions on Save page (ko)');
  leaks = await englishLeaks(k, '.settings-dialog');
  k.check(!leaks.length, `Actions on Save page is Korean (${leaks.join(' | ')})`);
  await k.js(`(document.querySelector('#settingsCancel').click(), true)`);
  await openFile(k, 'd.py');
  await k.js(`(() => { const m = ide.getDocument(ide.util.joinPath(ide.root, 'd.py')).model; m.setValue('# mine\\n'); return true; })()`);
  writeFileSync(path.join(k.project, 'd.py'), 'external = True\n');
  await k.js(`ide.autoSave().then(() => true)`);
  await k.until(`!document.querySelector('#autosaveStatus').classList.contains('hidden')`, 'status shown (ko)');
  k.check(await k.js(`document.querySelector('#autosaveStatus').textContent.includes('자동 저장 안 됨')`), 'the status warning is Korean');
  const missing = (await missingTranslations(k)).filter((s) => /auto|save|Save|idle|whitespace|line break/i.test(s));
  k.check(!missing.length, `no missing translations (${missing.join(' | ')})`);
} catch (err) {
  k.check(false, err.message);
}
console.log(`${t.results.filter((r) => r.ok).length}/${t.results.length} passed (English)`);
if (failedFirst) {
  k.close();
  process.exit(1);
}
k.finish();
