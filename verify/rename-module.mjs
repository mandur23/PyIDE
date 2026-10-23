// End-to-end check for renaming and moving Python modules and packages from the project tree (renderer/core/ide.js
// tree hooks, renderer/features/refactor renameModule/move, refactor_server.py): Shift+F6 and Rename… with Search for
// references, Ctrl+X / Ctrl+V and drag-and-drop moves, imports rewritten in open and closed files (absolute, from,
// dotted and relative imports; a move keeps each importer's style: relative stays relative where it can, from-imports
// keep unqualified uses, `import a.b` stays qualified), unsaved editor text kept, one undo step, plain renames with the checkbox off, files
// that keep the plain rename (non-Python, untrusted projects), the rope install offer with its plain fallback, and the
// Korean dialog. The fixture program's output is compared after every refactoring.
// A src-layout project (src/shop, tests/) checks that importers are named relative to rope's source folder.
// rope comes from verify/out/refactor-venv, the venv verify/refactor.mjs keeps (made here when missing). Ports 9110-9112.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENV = path.join(HERE, 'out', 'refactor-venv');
const VENV_PY = path.join(VENV, 'Scripts', 'python.exe');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 600000, windowsHide: true, ...opts });

function ensureVenv() {
  if (existsSync(VENV_PY)) {
    try { run(VENV_PY, ['-c', 'import rope']); return; } catch {}
  } else {
    console.log('creating verify/out/refactor-venv (one time)…');
    try { run('py', ['-3', '-m', 'venv', VENV]); } catch { run('python', ['-m', 'venv', VENV]); }
  }
  run(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'rope']);
}
ensureVenv();

function bareVenv() {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-rm-bare-')), 'venv');
  run(run(VENV_PY, ['-c', 'import sys; print(sys._base_executable)']).trim(), ['-m', 'venv', '--without-pip', dir]);
  return path.join(dir, 'Scripts', 'python.exe');
}

async function useInterpreter(t, exe) {
  await t.js(`(async () => {
    ide.settings.set('interpreters.extra', [...new Set([...ide.settings.get('interpreters.extra', []), ${JSON.stringify(exe)}])]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${JSON.stringify(exe)});
  })()`);
  await t.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${JSON.stringify(exe)})`, 'interpreter selected');
}

const MINE = ['renderer/features/refactor/index.js'].map((f) => readFileSync(path.join(HERE, '..', f), 'utf8')).join('\n');
const q = JSON.stringify;

function helpers(t) {
  const { js, until, press } = t;
  const P = (rel) => path.join(t.project, rel);
  const disk = (rel) => readFileSync(P(rel), 'utf8').replace(/\r\n/g, '\n');
  // The live text of an open document, or null.
  const doc = (rel) => js(`(() => { const t = ide.tabs.find((t) => t.kind === 'file' && t.path.toLowerCase() === ${q(P(rel).toLowerCase())}); return t ? t.model.getValue(1) : null; })()`);
  // Selects a row in the project tree and gives the tree the keyboard.
  async function selectRow(rel) {
    await js(`ide.revealInTree(${q(P(rel))})`);
    await until(`document.querySelector('#tree .node.selected')?._entry?.path.toLowerCase() === ${q(P(rel).toLowerCase())}`, `tree row ${rel}`);
    await js(`(document.getElementById('tree').focus(), true)`);
  }
  const rowOf = (rel) => `[...document.querySelectorAll('#tree .node')].find((n) => n._entry?.path.toLowerCase() === ${q(P(rel).toLowerCase())})`;
  async function contextMenu(rel, label) {
    await selectRow(rel);
    await js(`(() => { const n = ${rowOf(rel)}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); return true; })()`);
    await until(`[...document.querySelectorAll('.context-menu .menu-label')].some((l) => l.textContent === ${q(label)})`, `menu item ${label}`);
    await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === ${q(label)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true`);
  }
  async function drag(fromRel, toRel) {
    await js(`ide.revealInTree(${q(P(fromRel))})`);
    await js(`ide.revealInTree(${q(P(toRel))})`);
    await until(`!!${rowOf(fromRel)} && !!${rowOf(toRel)}`, 'both rows drawn');
    await js(`(() => { const dt = new DataTransfer(); const from = ${rowOf(fromRel)}; const to = ${rowOf(toRel)};
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true; })()`);
  }
  const dialog = (id) => until(`!!document.querySelector('#${id}')`, `#${id}`, 30000);
  const gone = (id) => until(`!document.querySelector('#${id}')`, `#${id} closed`, 60000);
  const setInput = (sel, value) => js(`(() => { const i = document.querySelector(${q(sel)}); i.value = ${q(value)}; i.dispatchEvent(new Event('input')); return true; })()`);
  const button = (id, action) => t.click(`#${id} [data-action="${action}"]`);
  const exists = (rel) => existsSync(P(rel));
  return { P, disk, doc, selectRow, contextMenu, drag, dialog, gone, setInput, button, exists, press };
}

// A package with relative and absolute importers, moved with Cut / Paste (written into the fixture project, and under
// src/ in the src-layout project).
const SHOP = {
  'shop/__init__.py': '',
  'shop/models/__init__.py': '',
  'shop/models/price.py': 'RATE = 2\n\n\ndef total(n):\n    return RATE * n\n',
  'shop/models/cart.py': 'from .price import total\nfrom . import price as pr\n\n\ndef cart():\n    return total(1) + pr.total(2)\n',
  'shop/views/__init__.py': '',
  'shop/views/page.py': 'from ..models.price import total as tot, RATE\nfrom ..models import price\n\n\ndef page():\n    return tot(3) + price.total(4) + RATE\n',
  'shop_main.py': 'from shop.models import price\nimport shop.models.price\nimport shop.models.price as sp\n\n\ndef run():\n    return price.total(5) + shop.models.price.total(6) + sp.total(7)\n',
};

// ======================================================================
const t = await launch({ fixture: 'rename-module', port: 9110 });
const { js, until, press, check, shot } = t;
const h = helpers(t);
const appOutput = async () => { await js('ide.saveAll()'); return run(VENV_PY, ['main.py'], { cwd: t.project, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).replace(/\r\n/g, '\n'); };

try {
  await useInterpreter(t, VENV_PY);
  // Unsaved text must survive the refactoring, so auto save (autosave plugin) stays out of the way.
  await js(`(['autosave.onTabSwitch', 'autosave.onIdle', 'autosave.onFrameDeactivation'].forEach((k) => ide.settings.set(k, false)), true)`);
  const baseline = await appOutput();
  check(baseline === '12 27 48 6 150 147\n', `fixture program runs (${baseline.trim()})`);

  // Open editors: an importer, an importer with unsaved text, and the module itself with unsaved text.
  await openFile(t, 'geo/shapes.py');
  await js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: '# edited\\n' }], () => null); return true; })()`);
  await openFile(t, 'tools/calc.py');
  await js(`(() => { const m = ide.editor.getModel(); const n = m.getLineCount(); m.pushEditOperations([], [{ range: new monaco.Range(n, 1, n, 1), text: '# unsaved note\\n' }], () => null); return true; })()`);
  await openFile(t, 'main.py');
  check(await js(`ide.isDirty(ide.tabs.find((t) => /calc\\.py$/.test(t.path)))`), 'calc.py has unsaved text before the rename');
  const mainBefore = await h.doc('main.py');

  // ---- Shift+F6 on a module in the tree: rename it and every import of it ----
  await h.selectRow('geo/shapes.py');
  await press('Shift+F6');
  await h.dialog('rfRenameModuleDialog');
  const head = await js(`document.querySelector('#rfRenameModuleDialog .rf-message').textContent`);
  check(head === "Rename module 'geo.shapes' to:", `the dialog names the module (${head})`);
  check(await js(`document.querySelector('#rfRenameModuleDialog .rf-refs input').checked`), 'Search for references is on by default');
  check(await js(`(() => { const i = document.querySelector('#rfRenameModuleDialog .rf-name'); return i.value.slice(i.selectionStart, i.selectionEnd); })()`) === 'shapes', 'the name without .py is selected');
  await shot('rename-dialog.png');
  await h.setInput('#rfRenameModuleDialog .rf-name', 'figures.py');
  await press('Enter');
  await h.gone('rfRenameModuleDialog');
  await until(`(async () => await ide.api.exists(${q(h.P('geo/figures.py'))}))()`, 'geo/figures.py on disk', 60000);
  check(h.exists('geo/figures.py') && !h.exists('geo/shapes.py'), 'the file is renamed on disk');
  const main1 = await h.doc('main.py');
  check(main1.startsWith('import geo.figures\nfrom geo import figures\nfrom geo.figures import area\nfrom geo.report import report\n')
    && main1.includes('print(geo.figures.area(2), figures.area(3), area(4)'), `the open importer is rewritten (main.py: ${main1.split('\n').slice(0, 3).join(' | ')})`);
  check(await js(`ide.isDirty(ide.tabs.find((t) => /main\\.py$/.test(t.path)))`), 'the open importer gets an unsaved, undoable edit');
  const calc1 = await h.doc('tools/calc.py');
  check(calc1.startsWith('from geo.figures import area\n') && calc1.endsWith('# unsaved note\n'), 'an importer with unsaved text keeps it');
  check(h.disk('geo/report.py') === 'from . import figures\nfrom .figures import area\n\n\ndef report():\n    return figures.area(1) + area(1)\n', 'relative imports in a closed file are rewritten');
  check(h.disk('scripts/extra.py').startsWith('import geo.figures as gs\n'), 'aliased imports in a namespace package are rewritten');
  await until(`ide.tabs.some((t) => t.kind === 'file' && /geo\\\\figures\\.py$/i.test(t.path))`, 'renamed module reopened');
  check(!(await js(`ide.tabs.some((t) => t.kind === 'file' && /shapes\\.py$/i.test(t.path))`)), 'the old tab is gone');
  check(h.disk('geo/figures.py').startsWith('# edited\n"""Shape formulas."""'), 'the module\'s unsaved text was saved before it moved');
  check(await js(`[...document.querySelectorAll('#tree .node .name')].some((n) => n.textContent === 'figures.py')`), 'the tree shows the new name');
  check((await appOutput()) === baseline, 'the program prints the same after the rename');

  // one Ctrl+Z (in an importer) undoes it everywhere, Ctrl+Shift+Z redoes it
  await openFile(t, 'main.py');
  await js(`ide.editor.focus(), true`);
  await press('Ctrl+Z');
  await until(`(async () => await ide.api.exists(${q(h.P('geo/shapes.py'))}))()`, 'rename undone', 30000);
  check(!h.exists('geo/figures.py') && (await h.doc('main.py')) === mainBefore && h.disk('geo/report.py').startsWith('from . import shapes\n'), 'Ctrl+Z undoes the rename in every file');
  await press('Ctrl+Shift+Z');
  await until(`(async () => await ide.api.exists(${q(h.P('geo/figures.py'))}))()`, 'rename redone', 30000);
  check((await h.doc('main.py')).startsWith('import geo.figures\n') && h.disk('geo/report.py').startsWith('from . import figures\n'), 'Ctrl+Shift+Z redoes it');
  check((await appOutput()) === baseline, 'the program prints the same after undo and redo');

  // ---- Rename… on a package from the context menu, through the preview ----
  await h.contextMenu('geo', 'Rename…');
  await h.dialog('rfRenameModuleDialog');
  check(await js(`document.querySelector('#rfRenameModuleDialog .rf-message').textContent`) === "Rename package 'geo' to:", 'a folder with __init__.py is renamed as a package');
  await h.setInput('#rfRenameModuleDialog .rf-name', 'geometry');
  await h.button('rfRenameModuleDialog', 'preview');
  await h.dialog('rfPreview');
  const pv = await js(`[...document.querySelectorAll('#rfPreviewFiles .rf-file')].map((r) => r.textContent)`);
  check(pv.some((x) => /move/.test(x) && /geometry/.test(x)) && pv.some((x) => /main\.py/.test(x)), `the preview lists the importers and the move (${pv.join(' / ')})`);
  await h.button('rfPreview', 'apply');
  await h.gone('rfPreview');
  await until(`(async () => await ide.api.exists(${q(h.P('geometry/figures.py'))}))()`, 'package renamed', 60000);
  check(!h.exists('geo') && h.exists('geometry/__init__.py'), 'the package folder is renamed');
  check((await h.doc('main.py')).startsWith('import geometry.figures\nfrom geometry import figures\nfrom geometry.figures import area\nfrom geometry.report import report\n'), 'imports of the package are rewritten in the open editor');
  check((await h.doc('tools/calc.py')).startsWith('from geometry.figures import area\n'), 'and in the other open editor');
  check(h.disk('scripts/extra.py').startsWith('import geometry.figures as gs\n'), 'and in closed files');
  check(h.disk('geometry/report.py').startsWith('from . import figures\n'), 'relative imports inside the package stay as they are');
  await until(`ide.tabs.some((t) => t.kind === 'file' && /geometry\\\\figures\\.py$/i.test(t.path))`, 'tab inside the package reopened');
  check(true, 'a tab inside the renamed package reopens at its new place');
  check((await appOutput()) === baseline, 'the program prints the same after renaming the package');

  // ---- Ctrl+X, Ctrl+V: move a module into another package ----
  await h.selectRow('geometry/figures.py');
  await press('Ctrl+X');
  await h.selectRow('tools');
  await press('Ctrl+V');
  await h.dialog('rfMoveDialog');
  check(await js(`document.querySelector('#rfMoveDialog .rf-dest').value`) === 'tools', 'the Move dialog has the folder pasted on');
  check(await js(`document.querySelector('#rfMoveDialog .rf-refs input').checked`), 'and Search for references, on');
  await shot('move-dialog.png');
  await h.button('rfMoveDialog', 'refactor');
  await h.gone('rfMoveDialog');
  await until(`(async () => await ide.api.exists(${q(h.P('tools/figures.py'))}))()`, 'module moved', 60000);
  check(!h.exists('geometry/figures.py'), 'the module moved on disk');
  const main3 = await h.doc('main.py');
  check(main3.startsWith('import tools.figures\nfrom tools import figures\nfrom tools.figures import area\nfrom geometry.report import report\nfrom tools.calc import double_area\n')
    && main3.includes('print(tools.figures.area(2), figures.area(3)'), `importers are rewritten and keep their import order (${main3.split('\n').slice(0, 5).join(' | ')})`);
  check((await h.doc('tools/calc.py')).startsWith('from tools.figures import area\n'), 'the importer in the destination package is rewritten');
  const report3 = h.disk('geometry/report.py');
  check(report3 === 'from tools import figures\nfrom tools.figures import area\n\n\ndef report():\n    return figures.area(1) + area(1)\n',
    `relative from-imports of a module moved to another top-level package become absolute from-imports, call sites unchanged (${report3.split('\n').slice(0, 2).join(' | ')})`);
  check(h.disk('tools/figures.py') === '# edited\n"""Shape formulas."""\n\n\ndef area(r):\n    return 3 * r * r\n', 'the moved module keeps its text (rope\'s blank-line change is dropped)');
  check((await appOutput()) === baseline, 'the program prints the same after moving the module');

  // ---- drag a namespace package (no __init__.py) onto a package ----
  await h.drag('scripts', 'geometry');
  await h.dialog('rfMoveDialog');
  check(await js(`document.querySelector('#rfMoveDialog .rf-dest').value`) === 'geometry', 'dropping a folder opens Move with the drop target');
  await h.button('rfMoveDialog', 'refactor');
  await h.gone('rfMoveDialog');
  await until(`(async () => await ide.api.exists(${q(h.P('geometry/scripts/extra.py'))}))()`, 'namespace package moved', 60000).catch(async (e) => {
    const seen = await js(`[...document.querySelectorAll('.dialog, .notification, .balloon, .ide-notification')].map((n) => n.textContent.slice(0, 200)).join(' || ')`);
    throw new Error(`${e.message} (geometry: ${readdirSync(h.P('geometry')).join(',')}; on screen: ${seen || 'nothing'})`);
  });
  check(readdirSync(h.P('geometry/scripts')).join(',') === 'extra.py', 'no __init__.py is left in the namespace package');
  const main4 = await h.doc('main.py');
  check(main4.includes('import geometry.scripts.extra\n') && main4.includes('geometry.scripts.extra.run()'), 'imports of the namespace package are rewritten');
  check((await appOutput()) === baseline, 'the program prints the same after moving the namespace package');

  // ---- Cut / Paste from the context menu: importers keep their import style (relative, absolute, aliased) ----
  for (const [rel, text] of Object.entries(SHOP)) {
    mkdirSync(path.dirname(h.P(rel)), { recursive: true });
    writeFileSync(h.P(rel), text);
  }
  await js('ide.refreshTree()');
  const shopOutput = () => run(VENV_PY, ['-c', 'import shop_main, shop.models.cart, shop.views.page; print(shop_main.run(), shop.models.cart.cart(), shop.views.page.page())'],
    { cwd: t.project, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim();
  const shopBefore = shopOutput();
  check(shopBefore === '36 6 16', `the shop package runs (${shopBefore})`);
  await h.contextMenu('shop/models/price.py', 'Cut');
  await h.contextMenu('shop/views', 'Paste');
  await h.dialog('rfMoveDialog');
  await h.button('rfMoveDialog', 'refactor');
  await h.gone('rfMoveDialog');
  await until(`(async () => await ide.api.exists(${q(h.P('shop/views/price.py'))}))()`, 'shop price moved', 60000);
  check(!h.exists('shop/models/price.py') && h.disk('shop/views/price.py') === SHOP['shop/models/price.py'], 'Cut and Paste in the context menu move the module');
  const cart = h.disk('shop/models/cart.py');
  check(cart === 'from ..views.price import total\nfrom ..views import price as pr\n\n\ndef cart():\n    return total(1) + pr.total(2)\n',
    `\`from .x import y\` and \`from . import x as a\` stay relative and point at the new place (${cart.split('\n').slice(0, 2).join(' | ')})`);
  const page = h.disk('shop/views/page.py');
  check(page === 'from .price import total as tot, RATE\nfrom . import price\n\n\ndef page():\n    return tot(3) + price.total(4) + RATE\n',
    `\`from ..pkg.x import y as z\` and \`from ..pkg import x\` become the shortest relative imports (${page.split('\n').slice(0, 2).join(' | ')})`);
  const shopMain = h.disk('shop_main.py');
  check(shopMain === 'from shop.views import price\nimport shop.views.price\nimport shop.views.price as sp\n\n\ndef run():\n    return price.total(5) + shop.views.price.total(6) + sp.total(7)\n',
    `\`from pkg import x\` keeps x.f() unqualified, \`import a.b\` and \`import a.b as c\` keep the qualified style (${shopMain.split('\n').slice(0, 3).join(' | ')})`);
  check(shopOutput() === shopBefore, 'the shop package prints the same after the move');

  // ---- Search for references off: a plain rename, nothing else changes ----
  await js('ide.saveAll()');
  const mainSaved = h.disk('main.py');
  await h.selectRow('tools/calc.py');
  await press('Shift+F6');
  await h.dialog('rfRenameModuleDialog');
  await h.setInput('#rfRenameModuleDialog .rf-name', 'calc2.py');
  await js(`(() => { const c = document.querySelector('#rfRenameModuleDialog .rf-refs input'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
  await h.button('rfRenameModuleDialog', 'refactor');
  await until(`(async () => await ide.api.exists(${q(h.P('tools/calc2.py'))}))()`, 'plain rename', 30000);
  check(!h.exists('tools/calc.py') && h.disk('main.py') === mainSaved && (await h.doc('main.py')) === mainSaved, 'with the checkbox off only the file is renamed');
  await until(`ide.tabs.some((t) => t.kind === 'file' && /calc2\\.py$/i.test(t.path))`, 'plain rename reopens the tab');
  check(true, 'the open tab follows the plain rename');
  // and back, so the program runs again
  await h.selectRow('tools/calc2.py');
  await press('Shift+F6');
  await h.dialog('rfRenameModuleDialog');
  await h.setInput('#rfRenameModuleDialog .rf-name', 'calc.py');
  await js(`(() => { const c = document.querySelector('#rfRenameModuleDialog .rf-refs input'); c.checked = false; return true; })()`);
  await press('Enter');
  await until(`(async () => await ide.api.exists(${q(h.P('tools/calc.py'))}))()`, 'plain rename back', 30000);

  // ---- files that keep the plain rename ----
  await h.selectRow('notes.txt');
  await press('Shift+F6');
  await until(`!!document.querySelector('#popup:not(.hidden)') && document.getElementById('popupIn').value === 'notes.txt'`, 'plain rename prompt');
  check(!(await js(`!!document.querySelector('#rfRenameModuleDialog')`)), 'a non-Python file gets the plain rename prompt');
  await press('Escape');
  await js(`(ide.trusted = false, true)`);
  await h.selectRow('main.py');
  await press('Shift+F6');
  await until(`!!document.querySelector('#popup:not(.hidden)') && document.getElementById('popupIn').value === 'main.py'`, 'untrusted prompt');
  check(!(await js(`!!document.querySelector('#rfRenameModuleDialog')`)), 'an untrusted project keeps the plain rename');
  await press('Escape');
  await js(`(ide.trusted = true, true)`);
  check((await appOutput()) === baseline, 'the program still runs');

  // ---- no rope: Install rope, or rename without references ----
  const bare = bareVenv();
  await useInterpreter(t, bare);
  await h.selectRow('main.py');
  await press('Shift+F6');
  await h.dialog('rfRenameModuleDialog');
  await h.setInput('#rfRenameModuleDialog .rf-name', 'app.py');
  await press('Enter');
  await h.dialog('rfInstallDialog');
  const offer = await js(`document.querySelector('#rfInstallDialog').innerText`);
  check(/needs the rope library/.test(offer) && /Install rope/.test(offer) && /Rename Without References/.test(offer), 'without rope the dialog offers Install rope or a plain rename');
  await shot('install-offer.png');
  await h.button('rfInstallDialog', 'fallback');
  await until(`(async () => await ide.api.exists(${q(h.P('app.py'))}))()`, 'fallback rename', 30000);
  check(!h.exists('main.py'), 'Rename Without References renames the file');
  await useInterpreter(t, VENV_PY);
} catch (err) {
  check(false, `unexpected error: ${err.stack || err.message}`);
  await shot('error.png').catch(() => {});
}
t.close();

// ======================================================================
// src layout: rope's source folder is src/, so the package is `shop` (not `src.shop`); relative importers stay relative
// and point at the new place, and the absolute importer in tests/ is rewritten.
const srcDir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-rm-src-')), 'project');
const SRC = Object.fromEntries(Object.entries(SHOP).map(([rel, text]) => (rel === 'shop_main.py' ? ['tests/test_shop.py', text] : [`src/${rel}`, text])));
for (const [rel, text] of Object.entries(SRC)) {
  mkdirSync(path.dirname(path.join(srcDir, rel)), { recursive: true });
  writeFileSync(path.join(srcDir, rel), text);
}
const s = await launch({ port: 9112, name: 'rename-module-src', projectDir: srcDir });
const hs = helpers(s);
try {
  await useInterpreter(s, VENV_PY);
  const srcOutput = () => run(VENV_PY, ['-c', 'import sys; sys.path[:0] = ["src", "tests"]; import test_shop, shop.models.cart, shop.views.page; print(test_shop.run(), shop.models.cart.cart(), shop.views.page.page())'],
    { cwd: srcDir, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim();
  const srcBefore = srcOutput();
  s.check(srcBefore === '36 6 16', `the src-layout shop package runs (${srcBefore})`);
  await hs.contextMenu('src/shop/models/price.py', 'Cut');
  await hs.contextMenu('src/shop/views', 'Paste');
  await hs.dialog('rfMoveDialog');
  await hs.button('rfMoveDialog', 'refactor');
  await hs.gone('rfMoveDialog');
  await s.until(`(async () => await ide.api.exists(${q(hs.P('src/shop/views/price.py'))}))()`, 'src-layout price moved', 60000);
  s.check(!hs.exists('src/shop/models/price.py') && hs.disk('src/shop/views/price.py') === SHOP['shop/models/price.py'], 'src layout: the module moves');
  const srcCart = hs.disk('src/shop/models/cart.py');
  s.check(srcCart === 'from ..views.price import total\nfrom ..views import price as pr\n\n\ndef cart():\n    return total(1) + pr.total(2)\n',
    `src layout: \`from .x import y\` and \`from . import x as a\` stay relative and point at the new place (${srcCart.split('\n').slice(0, 2).join(' | ')})`);
  const srcPage = hs.disk('src/shop/views/page.py');
  s.check(srcPage === 'from .price import total as tot, RATE\nfrom . import price\n\n\ndef page():\n    return tot(3) + price.total(4) + RATE\n',
    `src layout: \`from ..pkg.x import y as z\` and \`from ..pkg import x\` become the shortest relative imports (${srcPage.split('\n').slice(0, 2).join(' | ')})`);
  const srcTest = hs.disk('tests/test_shop.py');
  s.check(srcTest === 'from shop.views import price\nimport shop.views.price\nimport shop.views.price as sp\n\n\ndef run():\n    return price.total(5) + shop.views.price.total(6) + sp.total(7)\n',
    `src layout: absolute importers outside src/ name \`shop.views.price\` (${srcTest.split('\n').slice(0, 3).join(' | ')})`);
  s.check(srcOutput() === srcBefore, 'the src-layout shop package prints the same after the move');
} catch (err) {
  s.check(false, `unexpected error (src layout): ${err.stack || err.message}`);
  await s.shot('error.png').catch(() => {});
}
s.close();

// ======================================================================
// Korean UI
const k = await launch({ fixture: 'rename-module', port: 9111, name: 'rename-module-ko', lang: 'ko-KR' });
const hk = helpers(k);
const finishAll = () => {
  const results = [...t.results, ...s.results, ...k.results];
  const errors = [...t.consoleErrors, ...s.consoleErrors, ...k.consoleErrors];
  k.close();
  if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed || errors.length ? 1 : 0);
};
try {
  await useInterpreter(k, VENV_PY);
  const leaks = [];
  const look = async (sel, label) => { const l = await englishLeaks(k, sel); if (l.length) leaks.push(`${label}: ${JSON.stringify(l)}`); };
  await hk.selectRow('geo');
  await k.press('Shift+F6');
  await hk.dialog('rfRenameModuleDialog');
  const text = await k.js(`document.querySelector('#rfRenameModuleDialog').innerText`);
  k.check(/패키지 'geo'의 이름을 다음으로 변경/.test(text) && /참조 검색/.test(text), `the rename dialog is in Korean (${text.replace(/\n/g, ' | ')})`);
  await look('#rfRenameModuleDialog', 'Rename');
  await hk.button('rfRenameModuleDialog', 'cancel');
  await hk.drag('geo/shapes.py', 'tools');
  await hk.dialog('rfMoveDialog');
  await look('#rfMoveDialog', 'Move');
  await hk.button('rfMoveDialog', 'cancel');
  k.check(!leaks.length, `no English in the dialogs${leaks.length ? `:\n  ${leaks.join('\n  ')}` : ''}`);
  const missing = (await missingTranslations(k)).filter((s) => MINE.includes(q(s).slice(1, -1)) || MINE.includes(s));
  k.check(!missing.length, `every string has a Korean entry${missing.length ? `: ${q(missing)}` : ''}`);
  await k.shot('korean.png');
} catch (err) {
  k.check(false, `unexpected error (Korean): ${err.stack || err.message}`);
  await k.shot('error-ko.png').catch(() => {});
}
finishAll();
