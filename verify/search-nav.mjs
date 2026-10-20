import { readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'search-nav', port: 9403, env: { PYIDE_FIND_TIMEOUT_MS: '4000' } });
const { js, until, press, type, click, shot, cdp, project } = t;
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
  await until(`${activeRow}.startsWith('ⓜgreet')`, 'method greet ranked first');
  check((await js(activeRow)).includes('Greeter · main.py'), 'symbol shows its class and file');
  await press('Enter');
  await at('main.py', 19, 'Ctrl+Alt+Shift+N "greet" opens the method');

  // ---- Edits: live Structure, TODO refresh on save, index invalidation ----
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
  await click('#snReplaceAll');
  await until(`document.querySelector('#snFindHead').textContent.includes('Replaced 6 occurrences in 3 files')`, 'replace summary');
  check(true, 'Replace All reports 6 occurrences in 3 files');
  const disk = (rel) => readFileSync(path.join(project, rel), 'utf8');
  check(disk('notes.txt').includes('before calculate.') && disk('pkg/models.py').includes('calculate_total(self)'), 'closed and clean files rewritten on disk');
  check(await js(`ide.findTab(ide.util.joinPath(ide.root, 'pkg\\\\models.py')).model.getValue().includes('calculate_total(order)')`), 'open clean tab reloaded from disk');
  const mainTab = `ide.findTab(ide.util.joinPath(ide.root, 'main.py'))`;
  check(await js(`${mainTab}.model.getValue().includes('print(calculate(3))') && ide.isDirty(${mainTab})`), 'unsaved tab replaced in the editor and left unsaved');
  check(disk('main.py').includes('print(compute(3))'), 'unsaved file not written behind the user\'s back');
  check(disk('node_modules/dep/index.py').includes('compute') && disk('myenv/Lib/vendored.py').includes('compute') && statSync(path.join(project, 'big.txt')).size === bigSize, 'skipped files untouched');
  check(await js(`window.__treeRefreshes > 0`), 'project tree refreshed after Replace All');
  check(await js(`document.querySelector('#snFindResults').textContent.includes('No matches found')`), 'search reruns and shows nothing left');

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
