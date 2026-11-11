import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'search-nav', port: 9403, env: { PYIDE_FIND_TIMEOUT_MS: '4000', PYIDE_REPLACE_TIMEOUT_MS: '4000' } });
const { js, until, press, type, click, shot, cdp, project, sleep } = t;
// The fixture's myenv is a bare pyvenv.cfg (a folder the searches must skip). The IDE now takes a project venv as the
// project's interpreter and refuses a broken one, which left Structure and the symbol index without Python: make it
// a real venv of the Python running the tests (no pip, nothing downloaded).
execFileSync(process.platform === 'win32' ? 'py' : 'python3', ['-3', '-m', 'venv', '--without-pip', path.join(project, 'myenv')]);
await js(`(ide.reloadInterpreters?.(), true)`);
await sleep(3000);
await js(`document.querySelectorAll('.ide-balloon').forEach((b) => b.remove())`);
let seenErrors = 0;
const check = (ok, label) => {
  t.check(ok, label);
  if (t.consoleErrors.length > seenErrors) { console.log(`  !! renderer exception before/at: ${label}`); seenErrors = t.consoleErrors.length; }
};
const J = JSON.stringify;

const where = () => js(`(() => { const p = ide.editor.getPosition(); const m = ide.editor.getModel(); const s = ide.editor.getSelection(); return { file: ide.activeTab()?.title, line: p?.lineNumber, col: p?.column, selCol: s?.startColumn, sel: m ? m.getValueInRange(ide.editor.getSelection()) : '' }; })()`);
const popupOpen = `!document.querySelector('#popup').classList.contains('hidden')`;
const activeRow = `(document.querySelector('#popupList .popup-item.active')?.textContent || '')`;
const texts = (sel) => js(`[...document.querySelectorAll(${J(sel)})].map(n => n.textContent)`);
const at = async (file, line, label) => {
  await until(`ide.activeTab()?.title === ${J(file)} && ide.editor.getPosition()?.lineNumber === ${line}`, label, 8000)
    .then(() => check(true, label), async () => check(false, `${label} (at ${J(await where())})`));
};
// Marks the first element under `sel` whose text contains `text`, then clicks it with a real mouse event.
const clickText = async (sel, text) => {
  const ok = await js(`(() => { document.querySelectorAll('[data-vt]').forEach(n => n.removeAttribute('data-vt'));
    const n = [...document.querySelectorAll(${J(sel)})].find(n => n.textContent.includes(${J(text)}));
    if (n) n.setAttribute('data-vt', '1'); return !!n; })()`);
  if (!ok) throw new Error(`no ${sel} containing ${text}`);
  await click('[data-vt="1"]');
};
const setToggle = async (opt, on) => {
  const cur = await js(`document.querySelector('.sn-toggle[data-opt=${opt}]').classList.contains('on')`);
  if (cur !== on) await press({ caseSensitive: 'Alt+C', words: 'Alt+W', regex: 'Alt+X' }[opt]);
};
const setQuery = async (text) => { await js(`document.querySelector('#snQuery').select()`); await type(text); };
// The topmost dialog's message, and a real click on one of its buttons.
const question = () => js(`[...document.querySelectorAll('#dialogHost .dialog-message')].pop()?.textContent || ''`);
const answer = async (label) => {
  await js(`(() => { document.querySelectorAll('[data-answer]').forEach(n => n.removeAttribute('data-answer'));
    const b = [...[...document.querySelectorAll('#dialogHost .dialog')].pop().querySelectorAll('.dialog-buttons button')].find(n => n.textContent === ${J(label)});
    b.dataset.answer = '1'; return true; })()`);
  await click('[data-answer="1"]');
};
const status = (expected) => until(`document.querySelector('#snStatus')?.textContent === ${J(expected)}`, `status "${expected}"`, 8000)
  .then(() => true, async () => { console.log('  status was:', await js(`document.querySelector('#snStatus')?.textContent`)); return false; });

try {
  // Binary and oversized files are generated so the fixture stays small; search must skip both.
  writeFileSync(path.join(project, 'data.bin'), Buffer.concat([Buffer.from('greet compute '), Buffer.alloc(32), Buffer.from(' greet')]));
  writeFileSync(path.join(project, 'big.txt'), 'greet compute\n'.repeat(160000));
  const bigSize = statSync(path.join(project, 'big.txt')).size;

  check(await js(`['FindInFiles', 'Structure', 'TODO'].every((id) => ide.toolWindows.has(id))`), 'Find in Files, Structure and TODO tool windows registered');

  // ---- TODO tool window ----
  await press('Ctrl+Shift+A');
  await type('Tool Window: TODO');
  await until(`${activeRow}.includes('Tool Window: TODO')`, 'TODO action listed');
  await press('Enter');
  await until(`ide.toolWindows.get('TODO').isVisible() && document.querySelectorAll('#snTodo .sn-todo').length > 0`, 'TODO items');
  let todos = await texts('#snTodo .sn-todo');
  check(todos.length === 3, `TODO lists exactly the 3 project comments, skipping venvs/node_modules/text (got ${J(todos)})`);
  check(todos.some((x) => x.includes('FIXME: escape')) && todos.some((x) => x.includes('todo: real totals')) && todos.some((x) => x.includes('TODO: support')), 'TODO and FIXME found case-insensitively');
  check((await js(`document.querySelector('#snTodoHead').textContent`)) === 'Found 3 TODO items in 2 files', 'TODO header counts items and files');
  await shot('todo.png');
  await clickText('#snTodo .sn-todo', 'FIXME');
  await at('models.py', 8, 'clicking a TODO item opens models.py at line 8');

  // ---- Structure tool window ----
  await openFile(t, 'main.py');
  await press('Alt+7');
  await until(`ide.toolWindows.get('Structure').isVisible() && document.querySelectorAll('#snStructure .sn-node[data-kind]').length >= 10`, 'structure rows');
  const nodes = await js(`[...document.querySelectorAll('#snStructure .sn-node[data-kind]')].map(n => [n.dataset.kind, n.dataset.name, +n.dataset.depth, n.querySelector('.sn-icon').textContent])`);
  const has = (kind, name, depth) => nodes.some(([k, n, d]) => k === kind && n === name && d === depth);
  check(has('class', 'Greeter', 1) && has('function', 'compute', 1) && has('function', 'main', 1), 'Alt+7 shows top-level class and functions');
  check(has('method', 'greet', 2) && has('method', '__init__', 2) && has('property', 'times', 2), 'methods and property nested under the class');
  check(has('field', 'greeting', 2) && has('field', 'name', 2) && has('field', 'count', 2), 'class attribute and self.* fields listed');
  check(has('variable', 'VERSION', 1) && has('function', 'inner', 2), 'module variables and nested functions listed');
  check(nodes.find(([, n]) => n === 'Greeter')[3] === 'C' && nodes.find(([, n]) => n === 'greet')[3] === 'm', 'kind icons (C for class, m for method)');
  check((await js(`document.querySelector('#sideTitle').textContent`)) === 'Structure', 'Structure shown in the left panel');
  await clickText('#snStructure .sn-node[data-kind]', 'compute(a, b=2)');
  await at('main.py', 29, 'clicking compute in Structure jumps to line 29');
  await until(`document.querySelector('#snStructure .sn-node.selected')?.dataset.name === 'compute'`, 'structure follows caret');
  check(true, 'Structure highlights the element at the caret');
  await shot('structure.png');

  // ---- File Structure popup ----
  await js(`ide.editor.focus()`);
  await press('Ctrl+F12');
  await until(`!!document.querySelector('#snFileStructure .sn-fs-row.active')`, 'file structure popup');
  check((await js(`document.querySelector('#snFileStructure .sn-fs-row.active .sn-name').textContent`)) === 'compute', 'Ctrl+F12 preselects the element at the caret');
  await type('tim');
  await until(`document.querySelector('#snFileStructure .sn-fs-row.active .sn-name')?.textContent === 'times'`, 'filtered to times');
  check(await js(`[...document.querySelectorAll('#snFileStructure .sn-fs-row.dim .sn-name')].some(n => n.textContent === 'Greeter')`), 'filter keeps parent class (dimmed) of a match');
  await shot('file-structure.png');
  await press('Enter');
  await at('main.py', 25, 'Enter in File Structure jumps to times()');
  check(!(await js(`!!document.querySelector('#snFileStructure')`)), 'popup closes after navigation');
  await press('Ctrl+F12');
  await until(`!!document.querySelector('#snFileStructure')`, 'popup again');
  await press('Escape');
  check(!(await js(`!!document.querySelector('#snFileStructure')`)), 'Escape closes File Structure');

  // ---- Find in Files ----
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+F');
  await until(`document.activeElement?.id === 'snQuery'`, 'find dialog with focused query');
  check(true, 'Ctrl+Shift+F opens Find in Files with the query focused');
  await type('greet');
  check(await status('8 matches in 2 files'), 'live preview: 8 matches in 2 files');
  const files = new Set((await texts('#snPreview .sn-ploc')).map((s) => s.split(' ')[0]));
  check(files.size === 2 && files.has('main.py') && files.has('notes.txt'), `skips .venv, pyvenv dirs, node_modules, binary and >2MB files (got ${[...files]})`);
  await press('Alt+C');
  check(await js(`document.querySelector('.sn-toggle[data-opt=caseSensitive]').classList.contains('on')`), 'Alt+C toggles Match Case');
  check(await status('5 matches in 2 files'), 'match case: 5 matches');
  await press('Alt+W');
  check(await status('3 matches in 2 files'), 'whole words: 3 matches');
  await click('#snMaskOn');
  await js(`document.querySelector('#snMask').value`) === '*.py' || (await type('*.py'));
  check(await status('2 matches in 1 file'), 'file mask *.py: 2 matches in 1 file');
  check((await texts('#snPreview .sn-hit')).every((s) => s === 'greet'), 'preview highlights the matched text');
  await shot('find-dialog.png');
  await press('Enter');
  await until(`ide.toolWindows.get('FindInFiles').isVisible() && document.querySelectorAll('#snFindResults .sn-match').length === 2`, 'find window results');
  check((await js(`document.querySelector('#snFindHead').textContent`)).includes('2 matches in 1 file'), 'Find in Files tool window shows the summary');
  check((await texts('#snFindResults .sn-fname')).join() === 'main.py', 'results grouped by file');
  check((await texts('#snFindResults .sn-match .sn-hit')).every((s) => s === 'greet'), 'tool window highlights matches');
  await clickText('#snFindResults .sn-match', 'g.greet()');
  await at('main.py', 43, 'clicking a result opens the file at the match line');
  const w = await where();
  check(w.selCol === 13 && w.sel === 'greet', `match is selected at its column (col ${w.selCol}, sel "${w.sel}")`);
  await shot('find-window.png');

  await press('Ctrl+Shift+F');
  await until(`document.activeElement?.id === 'snQuery'`, 'find dialog again');
  check((await js(`document.querySelector('#snQuery').value`)) === 'greet', 'query prefilled from the editor selection');
  await setToggle('words', false);
  await click('#snMaskOn');
  await js(`document.querySelector('#snQuery').focus()`);
  await setToggle('regex', true);
  await setQuery('comp\\w+\\(');
  check(await status('5 matches in 2 files'), 'regex comp\\w+\\( finds 5 matches in 2 files');
  await setQuery('gre(');
  check(await until(`document.querySelector('#snStatus').classList.contains('sn-error')`, 'regex error').then(() => true, () => false), 'invalid regex is reported');
  await press('Escape');
  check(!(await js(`!!document.querySelector('.dialog')`)), 'Escape closes the dialog');

  // ---- Go to Class / Go to Symbol ----
  await js(`ide.editor.focus()`);
  await press('Ctrl+N');
  await until(popupOpen, 'goto class popup');
  await type('UM');
  await until(`${activeRow}.includes('UserModel')`, 'UserModel via CamelHumps', 15000);
  check(!(await texts('#popupList .popup-item')).some((s) => s.includes('greet')), 'Go to Class lists only classes');
  await press('Enter');
  await at('models.py', 1, 'Ctrl+N "UM" opens UserModel');
  check((await where()).sel === 'UserModel', 'class name selected');

  await press('Ctrl+Alt+Shift+N');
  await until(popupOpen, 'goto symbol popup');
  await type('greet');
  await until(`document.querySelector('#popupList .popup-item.active .sn-icon.k-method') && ${activeRow}.startsWith('mgreet')`, 'method greet ranked first');
  check((await js(activeRow)).includes('Greeter · main.py'), 'symbol shows its class and file');
  await press('Enter');
  await at('main.py', 19, 'Ctrl+Alt+Shift+N "greet" opens the method');

  // ---- Edits: live Structure, TODO refresh on save, index invalidation ----
  // The TODO list is kept fresh while its window is shown (a hidden one scans when shown again).
  await js(`ide.runAction('ActivateTODOToolWindow')`);
  await until(`document.querySelectorAll('#snTodo .sn-todo').length === 3`, 'TODO window shown');
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 52, column: 1 })`);
  await type('class AddedThing: pass  # TODO: added later');
  await until(`[...document.querySelectorAll('#snStructure .sn-node[data-kind=class]')].some(n => n.dataset.name === 'AddedThing')`, 'structure updates while typing');
  check(true, 'Structure updates live from unsaved edits');
  await press('Ctrl+S');
  await until(`document.querySelectorAll('#snTodo .sn-todo').length === 4`, 'TODO refresh on save');
  check(true, 'TODO window refreshes after save');
  await press('Ctrl+N');
  await until(popupOpen, 'goto class popup');
  await type('AddedTh');
  await until(`${activeRow}.includes('AddedThing')`, 'new class in index', 15000);
  check(true, 'symbol index picks up the saved file');
  await press('Enter');
  await at('main.py', 52, 'Go to Class opens the new class');

  // An index batch Python could not parse (here an interpreter that does not exist) is not cached as files without
  // symbols: the next build parses them again.
  await js(`ide.api.invoke('search:invalidate', null)`);
  const broken = await js(`ide.api.invoke('search:symbols', { cmd: 'C:/no/such/python.exe', args: [] }, ide.root).then((s) => s.length)`);
  const healed = await js(`ide.api.invoke('search:symbols', ide.currentInterp(), ide.root).then((s) => s.filter((x) => x.kind === 'class').map((x) => x.name))`);
  check(broken === 0 && healed.includes('UserModel') && healed.includes('AddedThing'), `a failed index run is not cached: the next one finds the classes (${broken} then ${healed.length})`);

  // ---- Back / Forward ----
  await press('Ctrl+N');
  await until(popupOpen, 'goto class popup');
  await type('OrderModel');
  await until(`${activeRow}.includes('OrderModel')`, 'OrderModel');
  await press('Enter');
  await at('models.py', 12, 'opened OrderModel');
  await press('Ctrl+N');
  await until(popupOpen, 'goto class popup');
  await type('UserModel');
  await until(`${activeRow}.includes('UserModel')`, 'UserModel');
  await press('Enter');
  await at('models.py', 1, 'opened UserModel');
  await press('Ctrl+Alt+ArrowLeft');
  await at('models.py', 12, 'Back returns to the previous place in the same file');
  await press('Ctrl+Alt+ArrowLeft');
  await at('main.py', 52, 'Back again returns to the previous file');
  await press('Ctrl+Alt+ArrowRight');
  await at('models.py', 12, 'Forward');
  await press('Ctrl+Alt+ArrowRight');
  await at('models.py', 1, 'Forward again');

  // ---- Last Edit Location ----
  await press('Ctrl+Shift+Backspace');
  await at('main.py', 52, 'Ctrl+Shift+Backspace jumps to the last edit');

  // ---- Recent Files ----
  await press('Ctrl+E');
  await until(popupOpen, 'recent files popup');
  const recentRows = await texts('#popupList .popup-item');
  check(recentRows[0].includes('main.py') && recentRows[1].includes('models.py'), `Recent Files lists most recent first (${J(recentRows)})`);
  check((await js(activeRow)).includes('models.py'), 'previous file is preselected');
  await shot('recent-files.png');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'models.py'`, 'switched by Ctrl+E Enter');
  check(true, 'Ctrl+E, Enter switches to the previous file');

  // ---- Recent Locations ----
  await press('Ctrl+Shift+E');
  await until(popupOpen, 'recent locations popup');
  const locs = await texts('#popupList .popup-item');
  check(locs.some((s) => s.includes('main.py:52') && s.includes('AddedThing') && s.includes('changed')), `Recent Locations shows the edited place with code (${J(locs.slice(0, 4))})`);
  await shot('recent-locations.png');
  await type('main.py:52');
  await until(`${activeRow}.includes('main.py:52')`, 'location filtered');
  await press('Enter');
  await at('main.py', 52, 'choosing a recent location navigates there');

  // ---- Replace in Files ----
  await openFile(t, 'pkg/models.py');
  await openFile(t, 'main.py');
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  await type('# local edit\n');
  check(await js(`ide.isDirty(ide.activeTab())`), 'main.py has unsaved changes before replace');
  await js(`window.__treeRefreshes = 0, ide.on('treeRefreshed', () => window.__treeRefreshes++)`);
  await press('Ctrl+Shift+R');
  await until(`!!document.querySelector('#snReplace') && document.activeElement?.id === 'snQuery'`, 'replace dialog');
  check(true, 'Ctrl+Shift+R opens Replace in Files');
  await setToggle('regex', false);
  await setToggle('words', false);
  await setToggle('caseSensitive', true);
  await setQuery('compute');
  await click('#snReplace');
  await type('calculate');
  check(await status('6 matches in 3 files'), 'replace preview: 6 matches in 3 files');
  await press('Enter');
  await until(`!!document.querySelector('#snReplaceAll')`, 'Replace All in find window');
  await shot('replace-window.png');
  const preview = await js(`[...document.querySelectorAll('#snFindResults .sn-match')].map((r) => [r.querySelector('.sn-old')?.textContent, r.querySelector('.sn-new')?.textContent])`);
  check(preview.length >= 3 && preview.every(([a, b]) => a === 'compute' && b === 'calculate'), `the results show each match with its replacement (${J(preview.slice(0, 3))})`);
  const disk = (rel) => readFileSync(path.join(project, rel), 'utf8');
  const notesBefore = disk('notes.txt');
  const historyLabels = () => js(`ide.api.invoke('localHistory:list', ide.root, ide.root, true).then(r => r.labels.map(l => l.l))`);
  await click('#snReplaceAll');
  await until(`[...document.querySelectorAll('#dialogHost .dialog-message')].pop()?.textContent === 'Replace 6 occurrences in 3 files?'`, 'the question before Replace All')
    .then(() => check(true, 'Replace All asks "Replace 6 occurrences in 3 files?" first'), async () => check(false, `Replace All asks first (${J(await question())})`));
  await answer('Cancel');
  await until(`!document.getElementById('dialogHost').childElementCount`, 'the question closed');
  await sleep(500);
  check(disk('notes.txt') === notesBefore && disk('pkg/models.py').includes('compute_total(self)') && await js(`ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model.getValue().includes('print(compute(3))')`)
    && !(await historyLabels()).includes('Before Replace in Files'), 'Cancel at the question changes no file, no buffer and no Local History');
  await click('#snReplaceAll');
  await until(`[...document.querySelectorAll('#dialogHost .dialog-message')].pop()?.textContent === 'Replace 6 occurrences in 3 files?'`, 'the question again');
  await answer('Replace');
  await until(`document.querySelector('#snFindHead').textContent.includes('Replaced 6 occurrences in 3 files')`, 'replace summary');
  check(true, 'Replace All reports 6 occurrences in 3 files');
  check(disk('notes.txt').includes('before calculate.') && disk('pkg/models.py').includes('calculate_total(self)'), 'closed and clean files rewritten on disk');
  check(await js(`ide.findTab(ide.util.joinPath(ide.root, 'pkg\\\\models.py')).model.getValue().includes('calculate_total(order)')`), 'open clean tab reloaded from disk');
  const mainTab = `ide.findTab(ide.util.joinPath(ide.root, 'main.py'))`;
  check(await js(`${mainTab}.model.getValue().includes('print(calculate(3))') && ide.isDirty(${mainTab})`), 'unsaved tab replaced in the editor and left unsaved');
  check(disk('main.py').includes('print(compute(3))'), 'unsaved file not written behind the user\'s back');
  check(disk('node_modules/dep/index.py').includes('compute') && disk('myenv/Lib/vendored.py').includes('compute') && statSync(path.join(project, 'big.txt')).size === bigSize, 'skipped files untouched');
  check(await js(`window.__treeRefreshes > 0`), 'project tree refreshed after Replace All');
  check(await js(`document.querySelector('#snFindResults').textContent.includes('No matches found')`), 'search reruns and shows nothing left');

  // notes.txt was never opened: its text from before the replace is in Local History, under the label.
  const notesPath = `ide.util.joinPath(ide.root, 'notes.txt')`;
  check((await historyLabels()).includes('Before Replace in Files'), 'Replace All puts a "Before Replace in Files" label in Local History');
  await js(`(ide.localHistory.show(${notesPath}, false), true)`);
  await until(`ide.activeTab()?.title === 'Local History: notes.txt' && [...document.querySelectorAll('.lh-view:not(.hidden) .lh-row.label')].some(r => r.textContent.includes('Before Replace in Files'))`, 'notes.txt history with the label', 8000);
  await clickText('.lh-view:not(.hidden) .lh-row.label', 'Before Replace in Files');
  await until(`document.querySelector('.lh-view:not(.hidden) .lh-row.selected')?.textContent.includes('Before Replace in Files')`, 'the label selected');
  await click('.lh-view:not(.hidden) .lh-revert');
  await until(`ide.api.read(${notesPath}).then(s => s === ${J(notesBefore)})`, 'notes.txt reverted', 8000)
    .then(() => check(true, 'a closed file changed by Replace All is restored to its previous text from Local History'), () => check(false, `notes.txt restored from Local History (${J(disk('notes.txt'))})`));
  await js(`(ide.closeTabObject(ide.activeTab(), true), true)`);

  // More files than Local History takes from one burst of outside changes (200), and one past its 1 MB limit for
  // them, all never opened: each goes into the label with its text, as Replace All asks for it.
  mkdirSync(path.join(project, 'burst'));
  const burst = Array.from({ length: 230 }, (_, i) => path.join(project, 'burst', `f${i}.txt`));
  for (const f of burst) writeFileSync(f, `burst_token ${f}\n`);
  const large = path.join(project, 'burst', 'large.txt');
  writeFileSync(large, 'burst_token\n'.repeat(130000));
  const kept = await js(`ide.localHistory.checkpoint('Before Replace in Files', { paths: ${J([...burst, large])}, disk: true })`);
  const burstRevs = await js(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'burst'), true).then(r => r.revisions.filter(x => x.k === 'checkpoint' && x.l === 'Before Replace in Files').length)`);
  check(kept?.skipped?.length === 0 && burstRevs === burst.length + 1, `231 files never opened, one of 1.5 MB, each get their text in the label (${J({ skipped: kept?.skipped, burstRevs })})`);

  // A file Local History cannot read is named, and Replace All asks again before it changes anything.
  const lockA = path.join(project, 'lockme_a.txt');
  const lockB = path.join(project, 'lockme_b.txt');
  writeFileSync(lockA, 'lockme\n');
  writeFileSync(lockB, 'lockme\n');
  await js(`(ide.editor?.focus(), true)`);
  await press('Ctrl+Shift+R');
  await until(`!!document.querySelector('#snReplace') && document.activeElement?.id === 'snQuery'`, 'Replace in Files again');
  await setQuery('lockme');
  await js(`document.querySelector('#snReplace').select()`);
  await type('unlocked');
  check(await status('2 matches in 2 files'), 'preview: lockme in 2 files');
  await press('Enter');
  await until(`!!document.querySelector('#snReplaceAll') && document.querySelector('#snFindHead').textContent.includes('lockme')`, 'Replace All for lockme');
  execFileSync('icacls', [lockA, '/deny', `${process.env.USERNAME}:(RD)`], { stdio: 'ignore' });
  try {
    await click('#snReplaceAll');
    await until(`[...document.querySelectorAll('#dialogHost .dialog-message')].pop()?.textContent === 'Replace 2 occurrences in 2 files?'`, 'the lockme question');
    await answer('Replace');
    await until(`([...document.querySelectorAll('#dialogHost .dialog-message')].pop()?.textContent || '').includes('lockme_a.txt')`, 'the second question', 8000)
      .catch(() => {});
    const second = await question();
    check(second.startsWith('Local History cannot keep the current text of 1 file') && second.includes('lockme_a.txt (') && second.endsWith('Replace anyway?'), `a file Local History cannot read is named before the replace (${J(second)})`);
    await answer('Cancel');
    await until(`!document.getElementById('dialogHost').childElementCount`, 'the second question closed');
    await sleep(500);
  } finally {
    execFileSync('icacls', [lockA, '/remove:d', process.env.USERNAME], { stdio: 'ignore' });
  }
  check(disk('lockme_a.txt') === 'lockme\n' && disk('lockme_b.txt') === 'lockme\n', 'Cancel there changes neither file');

  // A regex that can match the empty string replaces only the non-empty matches the preview counts.
  writeFileSync(path.join(project, 'empty_re.txt'), 'bab\n');
  const reOpts = `{ query: 'a*', regex: true, caseSensitive: true, words: false, replacement: '[$&]' }`;
  const inBuffer = await js(`ide.api.invoke('search:replaceText', ${reOpts}, 'bab')`);
  const onDisk = await js(`ide.api.invoke('search:replace', ${reOpts}, [ide.util.joinPath(ide.root, 'empty_re.txt')])`);
  check(inBuffer.text === 'b[a]b' && inBuffer.count === 1 && onDisk.count === 1 && disk('empty_re.txt') === 'b[a]b\n',
    `empty regex matches are not replaced (buffer ${JSON.stringify(inBuffer)}, disk ${JSON.stringify(disk('empty_re.txt'))})`);

  // A CP949 file ('한글' is c7 d1 b1 db) is searched as Korean text and rewritten in CP949, not as broken UTF-8.
  const cp949 = (word) => Buffer.concat([Buffer.from('# '), Buffer.from('c7d1b1db', 'hex'), Buffer.from(` ${word}\n`)]);
  writeFileSync(path.join(project, 'korean.txt'), cp949('total'));
  const opts = (query, replacement = '') => `{ query: ${J(query)}, caseSensitive: true, words: false, regex: false, mask: '', dir: null, replacement: ${J(replacement)} }`;
  const korean = await js(`ide.api.invoke('search:find', ide.root, ${opts('한글')}, {})`);
  check(korean.count === 1 && korean.files[0].path.endsWith('korean.txt') && korean.files[0].matches[0].col === 3, `Korean text found in a CP949 file at its column (${J(korean.files.map((f) => f.matches))})`);
  const cpReplace = await js(`ide.api.invoke('search:replace', ${opts('total', 'sum')}, [ide.util.joinPath(ide.root, 'korean.txt')])`);
  check(cpReplace.count === 1 && readFileSync(path.join(project, 'korean.txt')).equals(cp949('sum')), 'Replace in Files keeps a CP949 file in CP949');
  // UTF-16 as PowerShell's `>` writes it (LE with a BOM) and without a BOM: found as text, rewritten in UTF-16.
  const utf16 = (word, bom) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(`한글 ${word} 끝\r\n`, 'utf16le')]);
  writeFileSync(path.join(project, 'ps_out.txt'), utf16('wide_total', true));
  writeFileSync(path.join(project, 'nobom.txt'), utf16('wide_total', false));
  const wide = await js(`ide.api.invoke('search:find', ide.root, ${opts('wide_total')}, {})`);
  check(wide.count === 2 && wide.files.every((f) => f.matches[0].col === 4), `UTF-16 files are searched as text (${J(wide.files.map((f) => [f.path.split(/[\\\\/]/).pop(), f.matches[0]?.col]))})`);
  const wideReplace = await js(`ide.api.invoke('search:replace', ${opts('wide_total', 'wide_sum')}, ['ps_out.txt', 'nobom.txt'].map((f) => ide.util.joinPath(ide.root, f)))`);
  check(wideReplace.count === 2 && readFileSync(path.join(project, 'ps_out.txt')).equals(utf16('wide_sum', true)) && readFileSync(path.join(project, 'nobom.txt')).equals(utf16('wide_sum', false)), 'Replace in Files keeps UTF-16 files in UTF-16 (with and without a BOM)');
  // A UTF-8 file is written as a save writes it: a new file renamed over the old one (a new file id), so a full disk or
  // a crash cannot leave it cut short. A hard-linked file is still written in place, so its other name sees the change.
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(path.join(project, 'atomic.txt'), Buffer.concat([BOM, Buffer.from('atomic_total = 1\n')]));
  writeFileSync(path.join(project, 'hardlinked.txt'), 'atomic_total = 2\n');
  linkSync(path.join(project, 'hardlinked.txt'), path.join(project, 'hardlinked-other.txt'));
  const fileId = (n) => statSync(path.join(project, n), { bigint: true }).ino;
  const idBefore = fileId('atomic.txt');
  const atomic = await js(`ide.api.invoke('search:replace', ${opts('atomic_total', 'atomic_sum')}, ['atomic.txt', 'hardlinked.txt'].map((f) => ide.util.joinPath(ide.root, f)))`);
  const leftovers = readdirSync(project).filter((n) => n.includes('pyide-tmp'));
  check(atomic.count === 2 && readFileSync(path.join(project, 'atomic.txt')).equals(Buffer.concat([BOM, Buffer.from('atomic_sum = 1\n')])) && fileId('atomic.txt') !== idBefore && !leftovers.length,
    `Replace in Files writes a UTF-8 file through a temporary file renamed over it, keeping its BOM (${J({ count: atomic.count, renamed: fileId('atomic.txt') !== idBefore, leftovers })})`);
  check(readFileSync(path.join(project, 'hardlinked-other.txt'), 'utf8') === 'atomic_sum = 2\n', 'and writes a hard-linked file in place');
  // Preview searches typed in a row: the one waiting behind a running search is replaced by the newer one.
  const live = await js(`Promise.all(['greet', 'compute', 'calculate'].map((q) => ide.api.invoke('search:find', ide.root, { ...${opts('')}, query: q }, {}, { live: true })))`);
  check(!live[0].superseded && live[1].superseded && !live[2].superseded && live[2].count > 0, `a queued preview search is superseded by a newer one (${J(live.map((r) => r.superseded || r.count))})`);

  // A catastrophic regex backtracks for hours on this line. The search is stopped at its limit (4 s in this suite,
  // PYIDE_FIND_TIMEOUT_MS) with a readable message, and the scans queued behind it still answer.
  writeFileSync(path.join(project, 'backtrack.txt'), `${'a'.repeat(40)}b\n`);
  const slow = `{ ...${opts('(a+)+$')}, regex: true }`;
  let t0 = Date.now();
  const stuck = await js(`Promise.all([ide.api.invoke('search:find', ide.root, ${slow}, {}), ide.api.invoke('search:todos', ide.root, {}), ide.api.invoke('search:find', ide.root, ${opts('greet')}, {})])`);
  check(stuck[0].stopped === 4 && stuck[0].count === 0 && stuck[1].count > 0 && stuck[2].count > 0 && Date.now() - t0 < 12000,
    `a runaway regex search is stopped and the TODO scan and search queued behind it answer (${J([stuck[0], stuck[1].count, stuck[2].count])}, ${Date.now() - t0} ms)`);
  // Replace with it, in a file the main side reads and writes (CP949) and in an unsaved buffer: the pattern runs on the
  // worker under the replace limit (4 s here, PYIDE_REPLACE_TIMEOUT_MS), and the main process, which answers every
  // window's calls, is not held meanwhile. It used to run there with no limit.
  const krBacktrack = Buffer.concat([cp949('x'), Buffer.from(`${'a'.repeat(40)}b\n`)]);
  writeFileSync(path.join(project, 'backtrack_kr.txt'), krBacktrack);
  t0 = Date.now();
  const runaway = await js(`(async () => {
    const opts = { ...${slow}, replacement: 'z' };
    const replace = ide.api.invoke('search:replace', opts, [ide.util.joinPath(ide.root, 'backtrack_kr.txt')]);
    await new Promise((r) => setTimeout(r, 500));
    const asked = performance.now();
    await ide.api.invoke('fs:exists', ide.root);
    const answered = Math.round(performance.now() - asked);
    const buffer = await ide.api.invoke('search:replaceText', opts, ${J(`${'a'.repeat(40)}b`)});
    return { replace: await replace, answered, buffer };
  })()`);
  check(runaway.replace.stopped === 4 && runaway.buffer.stopped === 4 && runaway.buffer.count === 0 && runaway.buffer.text === `${'a'.repeat(40)}b`
    && runaway.answered < 1000 && readFileSync(path.join(project, 'backtrack_kr.txt')).equals(krBacktrack) && Date.now() - t0 < 20000,
    `a runaway regex in Replace is stopped in a CP949 file and in an unsaved buffer, and the main process answers meanwhile (${J(runaway)}, ${Date.now() - t0} ms)`);
  writeFileSync(path.join(project, 'backtrack_kr.txt'), 'gone\n');
  // A preview replaced by a newer one is stopped after a second instead of running to the limit.
  t0 = Date.now();
  const typed = await js(`(async () => {
    const a = ide.api.invoke('search:find', ide.root, ${slow}, {}, { live: true });
    await new Promise((r) => setTimeout(r, 200));
    const b = ide.api.invoke('search:find', ide.root, ${opts('greet')}, {}, { live: true });
    return [await a, await b];
  })()`);
  check(typed[0].superseded && typed[1].count > 0 && Date.now() - t0 < 3500,
    `a running runaway preview is stopped when a newer preview replaces it (${J(typed.map((r) => r.superseded || r.count))}, ${Date.now() - t0} ms)`);
  // The Find tool window says why it shows nothing.
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+F');
  await until(`document.activeElement?.id === 'snQuery'`, 'find dialog for the runaway regex');
  await setToggle('regex', true);
  await setQuery('(a+)+$');
  await press('Enter');
  check(await until(`(document.querySelector('#snFindHead')?.textContent || '').includes('The search was stopped after 4 seconds')`, 'stopped message', 15000).then(() => true, () => false),
    'the Find tool window reports a search stopped at its time limit');
  writeFileSync(path.join(project, 'backtrack.txt'), 'gone\n');

  // ---- Replace All past the 5,000 matches the list shows, and its one-step Undo ----
  // 300 files with 20 matches each: the list stops at 5,000, Replace All counts and replaces all 6,000.
  const capDir = path.join(project, 'cap');
  mkdirSync(capDir);
  const CAP_TEXT = 'captoken line\n'.repeat(20);
  for (let i = 0; i < 300; i++) writeFileSync(path.join(capDir, `c${String(i).padStart(4, '0')}.txt`), CAP_TEXT);
  writeFileSync(path.join(project, 'cap_open.txt'), 'captoken in an open file\n');
  await openFile(t, 'cap_open.txt');
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  await type('x');
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+R');
  await until(`!!document.querySelector('#snReplace') && document.activeElement?.id === 'snQuery'`, 'replace dialog for captoken');
  await setToggle('regex', false);
  await setToggle('caseSensitive', true);
  await setQuery('captoken');
  await js(`document.querySelector('#snReplace').select()`);
  await type('capdone');
  const capStatus = await until(`/^More than 5000 matches/.test(document.querySelector('#snStatus')?.textContent || '')`, 'capped status', 15000)
    .then(() => js(`document.querySelector('#snStatus').textContent`), () => js(`document.querySelector('#snStatus')?.textContent`));
  check(/^More than 5000 matches; the first 5000 are shown/.test(capStatus), `the status says the list is capped, not that 5000 is the count (${capStatus})`);
  const cancelled = await js(`(async () => { const p = ide.api.invoke('search:findAll', ide.root, { query: 'captoken', caseSensitive: true, words: false, regex: false, mask: '', dir: null, replacement: '' }, {}, 'cancel-me'); ide.api.invoke('search:cancelFindAll', 'cancel-me'); return p; })()`);
  check(cancelled.cancelled === true, `the full count before Replace All can be cancelled (${J(cancelled)})`);
  await answer('Replace All');
  await until(`/^Replace 6001 occurrences in 301 files\\?$/.test(${'[...document.querySelectorAll(\'#dialogHost .dialog-message\')].pop()?.textContent || \'\''})`, 'the true count in the question', 60000)
    .then(() => check(true, 'Replace All asks with the true count: "Replace 6001 occurrences in 301 files?"'), async () => check(false, `Replace All asks with the true count (${J(await question())})`));
  await answer('Replace');
  await until(`document.querySelector('#snFindHead')?.textContent.includes('Replaced 6001 occurrences in 301 files')`, 'replaced everything', 60000)
    .then(() => check(true, 'every match is replaced, past the 5000 shown'), async () => check(false, `every match is replaced (${J(await js(`document.querySelector('#snFindHead')?.textContent`))})`));
  const capFiles = readdirSync(capDir).map((n) => readFileSync(path.join(capDir, n), 'utf8'));
  check(capFiles.length === 300 && capFiles.every((s) => !s.includes('captoken') && s.split('capdone').length === 21), 'all 300 closed files are rewritten');
  check(await js(`ide.findTab(ide.util.joinPath(ide.root, 'cap_open.txt')).model.getValue()`) === 'xcapdone in an open file\n', 'and the unsaved buffer');
  check(await js(`ide.notifications.list().some((n) => n.title === 'Replaced 6001 occurrences in 301 files' && n.actions?.some((a) => a.label === 'Undo'))`), 'a balloon reports it and offers Undo');
  await click('#snUndoReplace');
  await until(`document.querySelector('#snFindHead')?.textContent.includes('Replace undone')`, 'undone', 60000).catch(() => {});
  const undone = readdirSync(capDir).map((n) => readFileSync(path.join(capDir, n), 'utf8'));
  check(undone.every((s) => s === CAP_TEXT) && await js(`ide.findTab(ide.util.joinPath(ide.root, 'cap_open.txt')).model.getValue()`) === 'xcaptoken in an open file\n',
    'Undo Replace puts every file and the buffer back in one step');
  await js(`(ide.closeTabObject(ide.findTab(ide.util.joinPath(ide.root, 'cap_open.txt')), true), true)`);

  // ---- Find in a directory from the project tree ----
  await press('Alt+1');
  await until(`ide.toolWindows.get('Project').isVisible()`, 'project tree visible');
  const box = await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name')?.textContent === 'pkg'); const r = n.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await until(`!!document.querySelector('.context-menu')`, 'tree menu');
  await clickText('.context-menu .menu-item', 'Find in Files');
  await until(`document.querySelector('.sn-scope')?.textContent === 'Directory: pkg'`, 'directory scope');
  check(true, 'tree context menu opens Find in Files scoped to the directory');
  await setQuery('self.name');
  await setToggle('regex', false);
  check(await status('2 matches in 1 file'), 'directory search only finds pkg/models.py matches');
  await press('Escape');

  if (!(await js(`ide.toolWindows.get('Structure').isVisible()`))) await press('Alt+7');
  await shot('final.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
