// Scratch files (renderer/features/scratches, main/features/scratches.js): New Scratch File from the action and from
// Ctrl+Alt+Shift+Insert, numbering, the Scratches and Consoles tree node, save, run in the project root, Pyright on a
// scratch, Find in Files / semantic index leave scratches out, Search Everywhere finds them, rename and delete from the
// tree, files added outside, restart with the same user data, another project, Ctrl+X / Ctrl+V never pasting into
// Scratches and Consoles, reveal under the right top-level node (project holding the user data, longer project path),
// and Korean. Ports 9140-9149.
// lib.mjs gives every launch a temporary PYIDE_USER_DATA, so the user's own scratches are never touched.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const TOKEN = 'SCRATCH_ONLY_TOKEN_93721';

const rowSel = (label) => `[...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name')?.textContent === ${S(label)})`;
const helpers = (t) => {
  const { js, until, click, sleep } = t;
  return {
    hasRow: (label) => js(`!!${rowSel(label)}`),
    clickRow: async (label) => {
      await until(`!!${rowSel(label)}`, `tree row ${label}`);
      await js(`(${rowSel(label)}.click(), true)`);
      await sleep(150);
    },
    rowMenu: async (label) => {
      await until(`!!${rowSel(label)}`, `tree row ${label}`);
      await js(`(() => { const n = ${rowSel(label)}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); return true; })()`);
      await until(`!!document.querySelector('.context-menu .menu-item')`, 'context menu');
    },
    menuItems: () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.textContent)`),
    clickMenu: async (prefix) => {
      const found = await js(`(() => { const n = [...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes(${S(prefix)})); n?.classList.add('pick-menu'); return !!n; })()`);
      if (!found) throw new Error(`menu item ${prefix} not found in ${S(await js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.textContent)`))}`);
      await click('.context-menu .menu-item.pick-menu');
    },
    // Expands Scratches and Consoles › Scratches when closed.
    openScratches: async () => {
      await until(`!!${rowSel('Scratches and Consoles')} || !!${rowSel('스크래치 및 콘솔')}`, 'Scratches and Consoles node');
      const top = (await js(`!!${rowSel('Scratches and Consoles')}`)) ? 'Scratches and Consoles' : '스크래치 및 콘솔';
      const sub = top === 'Scratches and Consoles' ? 'Scratches' : '스크래치';
      if (!(await js(`!!${rowSel(sub)}`))) await t.js(`(${rowSel(top)}.click(), true)`);
      await until(`!!${rowSel(sub)}`, `${sub} node`);
      if ((await js(`${rowSel(sub)}.querySelector('.arrow').textContent`)) === '▸') await js(`(${rowSel(sub)}.click(), true)`);
      await until(`${rowSel(sub)}.querySelector('.arrow').textContent === '▾'`, `${sub} open`);
    },
  };
};

// ================= first run =================
let t = await launch({ fixture: 'scratches', port: 9140 });
const userData = t.userData;
const scratchDir = path.join(userData, 'scratches');
const disk = (name) => readFileSync(path.join(scratchDir, name), 'utf8');
const onDisk = () => readdirSync(scratchDir).sort();
try {
  const { js, until, check, press, type, sleep } = t;
  const h = helpers(t);
  await until('!!ide.scratches?.dir()', 'scratches plugin ready');
  check((await js('ide.scratches.dir()')).toLowerCase() === scratchDir.toLowerCase(), 'scratches live in <userData>/scratches');
  check(!(await js(`ide.util.isUnder(ide.scratches.dir(), ide.root)`)), 'the scratches folder is outside the project');

  // ---------- tree node ----------
  await until(`!!${rowSel('Scratches and Consoles')}`, 'Scratches and Consoles node');
  check(await js(`(() => { const rows = [...document.querySelectorAll('#tree .node')]; const i = rows.findIndex(n => n.querySelector('.name')?.textContent === 'Scratches and Consoles'); return i > 0 && rows[i].style.paddingLeft === rows[0].style.paddingLeft; })()`),
    'Scratches and Consoles is a top-level node after the project root');
  check(await js(`${rowSel('Scratches and Consoles')}.querySelector('.file-icon').dataset.type === 'scratches'`), 'the node has the scratches icon');

  // ---------- New Scratch File from the action: language picker, Python first ----------
  check(await js(`(() => { const a = ide.actions.find(a => a.id === 'NewScratchFile'); return !!a && a.keys.includes('Ctrl+Alt+Shift+Insert'); })()`), 'NewScratchFile action with Ctrl+Alt+Shift+Insert');
  await js(`(ide.runAction('NewScratchFile'), true)`);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'language picker');
  const langs = await js(`[...document.querySelectorAll('#popupList .popup-item .label')].map(n => n.textContent)`);
  check(langs[0] === 'Python' && ['Markdown', 'JSON', 'SQL', 'HTML', 'Plain Text'].every((l) => langs.includes(l)), `picker lists Python first, then Markdown, JSON, SQL, HTML, Plain Text… (${langs.slice(0, 6).join(', ')})`);
  await press('Enter');
  await until(`ide.activeTab()?.path.toLowerCase() === ${S(path.join(scratchDir, 'scratch.py').toLowerCase())}`, 'scratch.py opened');
  check(existsSync(path.join(scratchDir, 'scratch.py')), 'scratch.py is created on disk');

  // ---------- from the keyboard: filtered to JSON ----------
  await js('(ide.editor.focus(), true)');
  await press('Ctrl+Alt+Shift+Insert');
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'language picker from the shortcut');
  await type('json');
  await until(`document.querySelector('#popupList .popup-item.active .label')?.textContent === 'JSON'`, 'JSON filtered to the top');
  await press('Enter');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\scratch.json')`, 'scratch.json opened');
  check(await js(`ide.editor.getModel().getLanguageId() === 'json'`), 'the JSON scratch has JSON highlighting');

  // ---------- numbering ----------
  await js('(ide.editor.focus(), true)');
  await press('Ctrl+Alt+Shift+Insert');
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'picker again');
  await press('Enter');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\scratch_1.py')`, 'scratch_1.py opened');
  await js(`ide.scratches.create('json')`);
  check(S(onDisk()) === S(['scratch.json', 'scratch.py', 'scratch_1.json', 'scratch_1.py']), `numbering scratch, scratch_1 per extension (${onDisk().join(', ')})`);

  // ---------- tree lists them ----------
  await h.openScratches();
  for (const f of ['scratch.py', 'scratch_1.py', 'scratch.json', 'scratch_1.json']) await until(`!!${rowSel(f)}`, `tree row ${f}`);
  check(true, 'Scratches and Consoles › Scratches lists the scratch files');
  check(await js(`${rowSel('scratch.py')}.querySelector('.file-icon').dataset.type === 'python'`), 'a Python scratch shows the Python file icon');
  check(!(await js(`${rowSel('scratch.py')}.draggable`)), 'scratch rows are not dragged into the project');

  // ---------- edit + save persists; run in the project root ----------
  const SCRIPT = `import os\nfrom helper import greet\nprint("cwd=" + os.getcwd())\nprint(open("marker.txt").read().strip())\nprint(greet())\n# ${TOKEN}\n`;
  await h.clickRow('scratch.py');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\scratch.py')`, 'scratch.py active from the tree');
  await js(`(ide.editor.getModel().setValue(${S(SCRIPT)}), ide.editor.focus(), true)`);
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'saved');
  check(disk('scratch.py') === SCRIPT, 'Ctrl+S writes the scratch to disk');

  await press('Shift+F10');
  await until(`(document.querySelector('#runOut')?.textContent || '').includes('hello from helper')`, 'scratch output in the Run window', 30000);
  const out = await js(`document.querySelector('#runOut').textContent`);
  check(out.toLowerCase().includes(`cwd=${t.project.toLowerCase()}`), 'a Python scratch runs with the project root as working directory');
  check(out.includes('project-root-marker'), 'it reads files relative to the project root');
  check(out.includes('hello from helper'), 'it imports project modules (project root on PYTHONPATH)');

  // Run from the tree's context menu.
  await h.rowMenu('scratch.py');
  const items = await h.menuItems();
  check(items.some((s) => s.includes("Run 'scratch'")) && items.some((s) => s.includes('New Scratch File')) && !items.some((s) => s.includes('New Python File')),
    `scratch context menu: Run, New Scratch File, no project items (${items.join(' | ')})`);
  await js(`(document.querySelector('#runOut').textContent = '', true)`);
  await h.clickMenu("Run 'scratch'");
  await until(`(document.querySelector('#runOut')?.textContent || '').includes('hello from helper')`, 'tree run output', 30000);
  check(await js(`ide.run.configs().some(c => c.name === 'scratch' && c.temporary && ide.util.samePath(c.cwd, ide.root))`), 'Run from the tree makes a temporary configuration in the project root');

  // Debug (Shift+F9) also runs in the project root.
  if (await js(`ide.actions.some(a => a.id === 'DebugCurrent' || a.id === 'Debug')`)) {
    await until(`!ide.run.sessions().some(s => s.running)`, 'tree run finished');
    await js(`(ide.editor.focus(), true)`);
    await press('Shift+F9');
    await until(`(document.querySelector('#dbgOut')?.textContent || '').includes('Process finished with exit code')`, 'debugged scratch finished', 60000);
    const dbg = await js(`document.querySelector('#dbgOut').textContent`);
    check(dbg.toLowerCase().includes(`cwd=${t.project.toLowerCase()}`) && dbg.includes('hello from helper'), 'Debug (Shift+F9) runs a scratch in the project root');
  }

  // ---------- Pyright and completion on a scratch ----------
  const s1 = path.join(scratchDir, 'scratch_1.py');
  await js(`ide.openFile(${S(s1)})`);
  await until(`ide.activeTab()?.path.toLowerCase() === ${S(s1.toLowerCase())}`, 'scratch_1.py active');
  await js(`(ide.editor.getModel().setValue('import os\\nundefined_name_xyz\\nos.pa'), ide.editor.setPosition({ lineNumber: 3, column: 6 }), ide.editor.focus(), true)`);
  let pyright = true;
  try {
    await until(`ide.problems.all().some(p => p.source === 'pyright' && ide.util.samePath(p.path, ${S(s1)}) && p.msg.includes('undefined_name_xyz'))`, 'Pyright diagnostics for the scratch', 60000);
  } catch { pyright = false; }
  check(pyright, 'Pyright reports problems in a scratch outside the project');
  await js(`(ide.editor.trigger('test', 'editor.action.triggerSuggest', {}), true)`);
  let completion = true;
  try {
    await until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].some(r => r.textContent.includes('path'))`, 'completion in the scratch', 30000);
  } catch { completion = false; }
  check(completion, 'completion works in a scratch (os.pa → path)');
  await press('Escape');
  await js(`(ide.editor.getModel().setValue(''), true)`);
  await js(`ide.saveTab(ide.activeTab()).then(() => true)`);

  // ---------- project-wide search leaves scratches out; Search Everywhere finds them ----------
  const dirty = await js(`Object.fromEntries(ide.tabs.filter(t => t.kind === 'file').map(t => [t.path, t.model.getValue()]))`);
  const found = await js(`ide.api.invoke('search:find', ide.root, { query: ${S(TOKEN)}, caseSensitive: false, words: false, regex: false, mask: '', dir: null, replacement: '' }, ${S(dirty)}, {})`);
  check(found.files.length === 0, `Find in Files does not search scratches (${found.files.length} files)`);
  if (await js('!!ide.semantic')) {
    let indexed = true;
    try { await until(`ide.semantic.query('greet hello helper').then(r => r.length > 0)`, 'semantic index', 30000); } catch { indexed = false; }
    if (indexed) check(await js(`ide.semantic.query(${S(TOKEN)}).then(r => r.every(x => !ide.util.isUnder(ide.util.joinPath(ide.root, x.rel), ide.scratches.dir()) && !/scratch/i.test(x.rel)))`), 'the semantic index does not contain scratches');
    else console.log('NOTE semantic index not ready; skipped');
  }
  if (await js('!!ide.searchEverywhere')) {
    await js(`(ide.searchEverywhere.open({ tab: 'files', query: 'scratch_1' }), true)`);
    await until(`[...document.querySelectorAll('#seList .se-row .se-label')].some(n => n.textContent === 'scratch_1.py')`, 'Search Everywhere finds scratch_1.py');
    check(true, 'Search Everywhere › Files finds scratch files');
    await press('Escape');
  }

  // ---------- rename and delete from the tree ----------
  await h.rowMenu('scratch.json');
  await h.clickMenu('Rename');
  await until(`!document.getElementById('popup').classList.contains('hidden') && document.getElementById('popupIn').value === 'scratch.json'`, 'rename prompt');
  await js(`(document.getElementById('popupIn').select(), true)`);
  await type('notes.json');
  await press('Enter');
  await until(`!!${rowSel('notes.json')} && !${rowSel('scratch.json')}`, 'renamed row');
  check(existsSync(path.join(scratchDir, 'notes.json')) && !existsSync(path.join(scratchDir, 'scratch.json')), 'Rename… renames the scratch on disk');
  check(await js(`!ide.tabs.some(t => t.path && /scratch\\.json$/i.test(t.path)) && ide.tabs.some(t => t.path && /notes\\.json$/i.test(t.path))`), 'its open tab follows the rename');

  await h.clickRow('scratch_1.json');
  await js(`(document.getElementById('tree').focus(), true)`);
  await press('Delete');
  await until(`!!document.querySelector('#dialogHost .dialog')`, 'delete confirmation');
  check(await js(`document.querySelector('#dialogHost').textContent.includes('scratch_1.json')`), 'Delete asks first');
  await t.click('#dialogHost .dialog button.primary');
  await until(`!${rowSel('scratch_1.json')}`, 'deleted row gone');
  check(!existsSync(path.join(scratchDir, 'scratch_1.json')), 'Delete removes the scratch');

  // Fixed nodes cannot be renamed or deleted.
  await h.rowMenu('Scratches and Consoles');
  check(await js(`[...document.querySelectorAll('.context-menu .menu-item')].filter(n => /Rename|Delete/.test(n.textContent)).every(n => n.classList.contains('disabled') || n.hasAttribute('disabled') || n.getAttribute('aria-disabled') === 'true')`), 'the Scratches and Consoles node cannot be renamed or deleted');
  await press('Escape');

  // ---------- a file added outside the IDE appears ----------
  await h.openScratches();
  writeFileSync(path.join(scratchDir, 'outside.md'), '# from outside\n');
  await until(`!!${rowSel('outside.md')}`, 'file added outside shows in the tree');
  check(true, 'the tree updates when a scratch file is added');

  await t.shot('scratches.png');
} catch (err) {
  t.check(false, err.message);
}
t.close();
const firstResults = t.results;
const firstErrors = t.consoleErrors;

// ================= restart with the same user data, then another project =================
t = await launch({ fixture: 'scratches', port: 9141, name: 'scratches-2', userData });
try {
  const { js, until, check } = t;
  const h = helpers(t);
  await h.openScratches();
  for (const f of ['scratch.py', 'scratch_1.py', 'notes.json', 'outside.md']) await until(`!!${rowSel(f)}`, `after restart: ${f}`);
  check(true, 'scratches survive a restart');
  check(disk('scratch.py').includes(TOKEN), 'their text survives too');

  const other = mkdtempSync(path.join(tmpdir(), 'pyide-scratches-other-'));
  cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'core'), other, { recursive: true });
  await js(`ide.openProject(${S(other)})`);
  await until(`ide.util.samePath(ide.root, ${S(other)})`, 'other project open');
  await h.openScratches();
  for (const f of ['scratch.py', 'notes.json']) await until(`!!${rowSel(f)}`, `in another project: ${f}`);
  check(true, 'another project shows the same scratches');
  await js(`ide.scratches.create('py')`);
  check(existsSync(path.join(scratchDir, 'scratch_2.py')), 'numbering continues across projects (scratch_2.py)');

  // ---------- Ctrl+X, Ctrl+V never moves a project file under Scratches and Consoles ----------
  const { press, sleep } = t;
  writeFileSync(path.join(other, 'cut_me.txt'), 'cut\n');
  writeFileSync(path.join(other, 'root.txt'), 'root\n');
  mkdirSync(path.join(other, 'dest'));
  writeFileSync(path.join(other, 'dest', 'keep.txt'), 'keep\n');
  await js(`ide.refreshTree().then(() => true)`);
  const reveal = (p) => js(`ide.revealInTree(${S(p)}).then(() => true)`);
  const treeKey = async (key) => { await js(`(document.getElementById('tree').focus(), true)`); await press(key); await sleep(300); };
  const dialogOpen = () => js(`!!document.querySelector('#dialogHost .dialog')`);
  const selectedName = () => js(`ide.selectedTreeEntry()?.label || ide.selectedTreeEntry()?.name`);
  await reveal(path.join(other, 'cut_me.txt'));
  check(await js(`ide.selectedTreeEntry()?.name === 'cut_me.txt' && !ide.selectedTreeEntry().treeRoot`), 'the project file is selected');
  await treeKey('Ctrl+X');
  await reveal(path.join(scratchDir, 'scratch.py'));
  check(await js(`ide.selectedTreeEntry()?.treeRoot === 'scratches'`), 'revealing a scratch selects its row under Scratches');
  await treeKey('Ctrl+V');
  check(!(await dialogOpen()) && existsSync(path.join(other, 'cut_me.txt')) && !existsSync(path.join(scratchDir, 'cut_me.txt')), 'Ctrl+V on a scratch file row does not move the cut project file');
  await treeKey('ArrowLeft');
  check(await selectedName() === 'Scratches', `ArrowLeft selects the Scratches node (${await selectedName()})`);
  await treeKey('Ctrl+V');
  check(!(await dialogOpen()) && existsSync(path.join(other, 'cut_me.txt')) && !existsSync(path.join(scratchDir, 'cut_me.txt')), 'Ctrl+V on the Scratches node does not move it');
  await treeKey('ArrowLeft'); // closes Scratches
  await treeKey('ArrowLeft');
  check(await selectedName() === 'Scratches and Consoles', `then Scratches and Consoles is selected (${await selectedName()})`);
  await treeKey('Ctrl+V');
  check(!(await dialogOpen()) && existsSync(path.join(other, 'cut_me.txt')) && !existsSync(path.join(path.dirname(scratchDir), 'cut_me.txt')), 'Ctrl+V on Scratches and Consoles does not move it into the user data folder');
  await reveal(path.join(other, 'dest', 'keep.txt'));
  await treeKey('Ctrl+V');
  await until(`!!document.querySelector('#dialogHost .dialog')`, 'move confirmation in the project');
  check(await js(`document.querySelector('#dialogHost').textContent.includes('cut_me.txt')`), 'the refused pastes kept the file cut: Ctrl+V on a project folder asks to move it');
  await t.click('#dialogHost .dialog button.primary');
  for (let i = 0; i < 50 && !existsSync(path.join(other, 'dest', 'cut_me.txt')); i++) await sleep(100);
  check(existsSync(path.join(other, 'dest', 'cut_me.txt')) && !existsSync(path.join(other, 'cut_me.txt')), 'and moves it there');

  // A cut does not survive closing and reopening the project.
  await reveal(path.join(other, 'dest', 'cut_me.txt'));
  await treeKey('Ctrl+X');
  await js(`ide.closeProject().then(() => true)`);
  await js(`ide.openProject(${S(other)}).then(() => true)`);
  await until(`ide.util.samePath(ide.root, ${S(other)})`, 'project reopened');
  await reveal(path.join(other, 'root.txt'));
  await treeKey('Ctrl+V');
  check(!(await dialogOpen()) && existsSync(path.join(other, 'dest', 'cut_me.txt')), 'Ctrl+V after reopening the project does nothing (the cut was reset)');

  // ---------- reveal picks the closest top-level node ----------
  // A project folder that contains the user data folder: a scratch file is shown under Scratches, not the project.
  const parent = path.dirname(userData);
  await js(`ide.openProject(${S(parent)}).then(() => true)`);
  await until(`ide.util.samePath(ide.root, ${S(parent)})`, 'project holding the user data folder');
  await reveal(path.join(scratchDir, 'scratch.py'));
  check(await js(`ide.selectedTreeEntry()?.treeRoot === 'scratches' && document.querySelector('#tree .node.selected')?.classList.contains('tree-extra')`), 'with the project holding the user data, reveal selects the scratch under Scratches');
  check(await js(`${rowSel('Scratches')}?.querySelector('.arrow').textContent === '▾'`), 'and expands the Scratches node');
  await treeKey('Ctrl+X'); // a scratch row cannot be cut
  await reveal(path.join(parent, 'project', 'main.py'));
  check(await js(`ide.selectedTreeEntry()?.name === 'main.py' && !ide.selectedTreeEntry().treeRoot`), 'a project file in it is still revealed in the project');
  await treeKey('Ctrl+V');
  check(!(await dialogOpen()) && existsSync(path.join(scratchDir, 'scratch.py')), 'a scratch file cannot be cut and pasted into the project');
  // A project path longer than the user data path: reveal still opens Scratches.
  const long = mkdtempSync(path.join(tmpdir(), 'pyide-scratches-a-project-folder-with-a-much-longer-name-than-user-data-'));
  writeFileSync(path.join(long, 'main.py'), 'print(1)\n');
  await js(`ide.openProject(${S(long)}).then(() => true)`);
  await until(`ide.util.samePath(ide.root, ${S(long)})`, 'long project open');
  await reveal(path.join(scratchDir, 'scratch.py'));
  check(await js(`ide.selectedTreeEntry()?.treeRoot === 'scratches' && ${rowSel('Scratches')}?.querySelector('.arrow').textContent === '▾' && document.querySelector('#tree .node.selected .name')?.textContent === 'scratch.py'`),
    'with a project path longer than the user data path, reveal expands Scratches and selects the scratch');
} catch (err) {
  t.check(false, err.message);
}
t.close();

// ================= Korean =================
const k = await launch({ fixture: 'scratches', port: 9142, name: 'scratches-ko', lang: 'ko-KR', userData });
try {
  const { js, until, check } = k;
  const h = helpers(k);
  await until(`!!${rowSel('스크래치 및 콘솔')}`, 'Korean node');
  await h.openScratches();
  check(true, 'Korean: 스크래치 및 콘솔 › 스크래치');
  await h.rowMenu('scratch.py');
  const items = await h.menuItems();
  check(items.some((s) => s.includes("'scratch' 실행")) && items.some((s) => s.includes('새 스크래치 파일')), `Korean context menu (${items.join(' | ')})`);
  await k.press('Escape');
  await js(`(ide.runAction('NewScratchFile'), true)`);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'Korean picker');
  check(await js(`document.getElementById('popupIn').placeholder === '새 스크래치 파일' && [...document.querySelectorAll('#popupList .label')].some(n => n.textContent === '일반 텍스트')`), 'Korean picker title and Plain Text');
  await k.press('Escape');
  // Only this plugin's strings: other plugins' gaps are their own suites' business.
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'features', 'scratches', 'index.js'), 'utf8');
  const missing = (await missingTranslations(k)).filter((m) => source.includes(`'${m}'`) || source.includes(`"${m}"`));
  check(missing.length === 0, `no missing Korean strings for scratches (${missing.join(', ')})`);
  const leaks = await englishLeaks(k, '#tree');
  check(!leaks.some((s) => /^Scratches/.test(s)), `no English scratch labels in the tree (${leaks.join(', ')})`);
} catch (err) {
  k.check(false, err.message);
}
k.close();

const all = [...firstResults, ...t.results, ...k.results].filter((r) => r.label);
const errors = [...firstErrors, ...t.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
