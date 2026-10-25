// Go to Implementation(s), Go to Super Method and the override gutter markers (type-hierarchy), Go to Test and Create
// New Test (goto-test), and <Click to see difference> for failed assertions (tests), on verify/fixtures/nav-tests:
// shapes/base.py (Shape(ABC) with an abstract area, Polygon(Shape)), shapes/figures.py (Square(Polygon),
// Circle(Shape)), shapes/util.py (no tests), tests/test_figures.py, shapes/base_test.py and tests/test_base.py (two tests
// for base.py), tests/test_diffs.py (failing comparisons). First the reporters on their own (pytest plugin and unittest
// runner, no window), then the IDE, then Korean. The difference opens in a compare tab (a dialog without the compare
// plugin). Ports 9550-9551. Uses the default interpreter's pytest.
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile, lensesShown } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'nav-tests');
const HELPERS = path.join(HERE, '..', 'renderer', 'features', 'tests');
// 1-based line of the first line of a fixture file matching re.
const lineOf = (rel, re) => readFileSync(path.join(FIXTURE, rel), 'utf8').split(/\r?\n/).findIndex((l) => re.test(l)) + 1;

// ---------- the reporters without the IDE ----------
const pure = [];
const pureCheck = (ok, label) => { pure.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
function report(args, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyide-navtests-'));
  const file = path.join(dir, 'report.jsonl');
  try {
    execFileSync('py', ['-3', ...args], { cwd: FIXTURE, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYIDE_TEST_REPORT: file, ...env }, stdio: 'ignore', timeout: 60000 });
  } catch {}
  const events = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  rmSync(dir, { recursive: true, force: true });
  return Object.fromEntries(events.filter((e) => e.e === 'result').map((e) => [e.id, e]));
}
{
  const r = report(['-m', 'pytest', '-p', 'pyide_pytest_plugin', '-q', '-p', 'no:cacheprovider', 'tests/test_diffs.py'], { PYTHONPATH: HELPERS });
  const d = (id) => r[`tests/test_diffs.py::${id}`]?.diff;
  pureCheck(S(d('test_dict')) === S({ expected: "{'a': 1, 'b': [1, 2, 4]}", actual: "{'a': 1, 'b': [1, 2, 3]}" }), `pytest: assert a == b reports expected (right) and actual (left) (${S(d('test_dict'))})`);
  pureCheck(S(d('test_lines')) === S({ expected: 'alpha\nBETA\ngamma\n', actual: 'alpha\nbeta\ngamma\n' }), `pytest: two strings are reported as they are, line by line (${S(d('test_lines'))})`);
  pureCheck(S(d('TestUnit::test_equal')) === S({ expected: '[1, 2, 4]', actual: '[1, 2, 3]' }), `pytest: a TestCase's assertEqual(first, second) reports second as expected (${S(d('TestUnit::test_equal'))})`);
  pureCheck(r['tests/test_diffs.py::test_no_compare']?.outcome === 'failed' && !d('test_no_compare'), 'pytest: a failed assertion that is no == comparison has no diff');
  pureCheck(r['tests/test_diffs.py::test_caught_then_error']?.outcome === 'failed' && !d('test_caught_then_error'), 'pytest: a comparison the test caught does not become the diff of a later error');
  // unittest discovery wants a package below its top folder, so the runner's root is tests/ here.
  const u = report(['-u', path.join(HELPERS, 'pyide_unittest_runner.py'), path.join(FIXTURE, 'tests'), 'test_diffs.py::TestUnit']);
  pureCheck(S(u['test_diffs.py::TestUnit::test_equal']?.diff) === S({ expected: '[1, 2, 4]', actual: '[1, 2, 3]' }), `unittest runner: assertEqual reports the pair (${S(u['test_diffs.py::TestUnit::test_equal']?.diff)})`);
  pureCheck(!/pyide_test_diff/.test(u['test_diffs.py::TestUnit::test_equal']?.text || 'pyide_test_diff'), 'unittest runner: the traceback does not show the assertEqual wrapper');
}

// ---------- the IDE ----------
const t = await launch({ fixture: 'nav-tests', port: 9550 });
const { js, until, check, press, cdp, sleep } = t;
const P = (rel) => `ide.util.joinPath(ide.root, ${S(rel.replace(/\//g, '\\'))})`;
const caret = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), ide.editor.revealLineInCenter(${line}), true)`);
const colOf = (rel, line, word) => readFileSync(path.join(FIXTURE, rel), 'utf8').split(/\r?\n/)[line - 1].indexOf(word) + 2;
const where = () => js(`(() => { const p = ide.editor.getPosition(); return [ide.activeTab()?.title, p.lineNumber]; })()`);
const popupItems = () => js(`[...document.querySelectorAll('#popupList .popup-item:not(.hint)')].map((r) => r.querySelector('.label').textContent)`);
const popupShown = () => js(`!document.getElementById('popup').classList.contains('hidden')`);
const hintShown = (re) => until(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some((n) => ${re}.test(n.textContent))`, `hint ${re}`, 10000).then(() => true, () => false);
const realClick = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(80); };
const clickPopup = async (label) => {
  const box = await js(`(() => { const r = [...document.querySelectorAll('#popupList .popup-item')].find((n) => n.querySelector('.label')?.textContent === ${S(label)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (box) await realClick(box.x, box.y);
  return !!box;
};
const marks = () => js(`ide.typeHierarchy.gutterMarks()`);
const markAt = async (line) => (await marks()).find((m) => m.line === line) || null;
const untilMarks = (label, test, ms = 30000) => until(`(() => { const m = ide.typeHierarchy.gutterMarks(); return (${test})(m); })()`, label, ms).then(() => true, () => false);
// The gutter icon drawn for a line, as a point to click.
const iconPoint = (line) => js(`(() => {
  const ed = ide.editor; const r = ed.getDomNode().getBoundingClientRect();
  const y = r.top + ed.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }).top + ed.getOption(ide.monaco.editor.EditorOption.lineHeight) / 2;
  const icons = [...ed.getDomNode().querySelectorAll('.th-gutter')].map((n) => n.getBoundingClientRect()).filter((b) => b.height);
  const b = icons.sort((a, c) => Math.abs(a.top + a.height / 2 - y) - Math.abs(c.top + c.height / 2 - y))[0];
  return b && Math.abs(b.top + b.height / 2 - y) < 6 ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`);
const testStatus = () => js(`document.querySelector('.run-session:not(.hidden) .tr-status')?.textContent || ''`);
const runTests = async (target, label) => {
  await js(`(ide.run.runConfig({ type: 'pytest', name: ${S(`pytest ${target}`)}, target: ${S(target)} }, { confirm: false }), true)`);
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === ${S(`pytest ${target}`)}`, `${label}: tab`, 20000);
  await until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state && s.dataset.state !== 'running'; })()`, label, 60000);
};
const selectTest = async (id) => {
  await until(`!!document.querySelector('.run-session:not(.hidden) .tr-row[data-id=${S(id)}]')`, `row ${id}`);
  await js(`document.querySelector('.run-session:not(.hidden) .tr-row[data-id=${S(id)}]').click()`);
};
const diffLink = () => js(`(() => { const a = document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a'); return a ? a.textContent : null; })()`);
const diffDialog = () => js(`(() => {
  const d = document.querySelector('.dialog .tr-diff'); if (!d) return null;
  const ed = ide.monaco.editor.getDiffEditors().find((e) => d.contains(e.getContainerDomNode()));
  const m = ed?.getModel();
  return { title: d.closest('.dialog').querySelector('.dialog-title').textContent, head: [...d.querySelectorAll('.tr-diff-head span')].map((s) => s.textContent),
    expected: m?.original.getValue(), actual: m?.modified.getValue(), differences: d.dataset.differences ?? null, count: d.querySelector('.tr-diff-count').textContent }; })()`);
// The Comparison Failure compare tab that is active (ide.compare.texts), once its diff is computed.
const DIFF_TAB = `(() => { const t = ide.activeTab(); const v = t && ide.compare.view(t); return v && v.ready() && t.path.endsWith(' [diff]') ? t : null; })()`;
const diffTab = () => js(`(() => {
  const t = ${DIFF_TAB}; if (!t) return null;
  const m = ide.compare.view(t).diff.getModel();
  const side = (c) => t.host.querySelector(c)?.firstChild?.textContent;
  return { title: t.title, head: [side('.cmp-left-title'), side('.cmp-right-title')], expected: m.original.getValue(), actual: m.modified.getValue(),
    differences: t.host.dataset.differences, count: t.host.querySelector('.cmp-count').textContent, dialogs: document.querySelectorAll('.dialog').length }; })()`);

try {
  check(await js(`['GotoImplementation', 'GotoSuperMethod', 'GotoTest', 'CreateTest'].every((id) => ide.actions.some((a) => a.id === id))`), 'actions GotoImplementation, GotoSuperMethod, GotoTest and CreateTest are registered');
  check(await js(`ide.actions.find((a) => a.id === 'GotoImplementation').title === 'Go to Implementation(s)' && ide.actions.find((a) => a.id === 'GotoSuperMethod').title === 'Go to Super Method' && ide.actions.find((a) => a.id === 'GotoTest').title === 'Go to Test'`), 'their titles follow PyCharm');
  await openFile(t, 'shapes/base.py');
  await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
  const base = 'shapes/base.py';
  const fig = 'shapes/figures.py';
  const L = {
    shape: lineOf(base, /^class Shape/), area: lineOf(base, /def area/), describe: lineOf(base, /def describe/), polygon: lineOf(base, /^class Polygon/), sides: lineOf(base, /def sides/),
    square: lineOf(fig, /^class Square/), sqInit: lineOf(fig, /def __init__\(self, side/), sqArea: lineOf(fig, /return self.side \* self.side/) - 1, sqSides: lineOf(fig, /return 4/) - 1,
    sqDescribe: lineOf(fig, /return "square"/) - 1, circle: lineOf(fig, /^class Circle/), ciArea: lineOf(fig, /3.14159/) - 1, total: lineOf(fig, /def total_area/), call: lineOf(fig, /s.area\(\) for s/),
  };
  check(await js(`ide.editor.getSupportedActions().map((a) => a.id.split(':').pop()).filter((id) => ['pyide.gotoImplementation', 'pyide.gotoSuperMethod', 'pyide.gotoTest'].includes(id)).length`) === 3,
    'the editor context menu has Go to Implementation(s), Go to Super Method and Go to Test');

  // ---------- Go to Implementation(s) ----------
  await caret(L.area, colOf(base, L.area, 'area'));
  await js(`(ide.runAction('GotoImplementation'), true)`);
  await until(`!document.getElementById('popup').classList.contains('hidden') && document.querySelectorAll('#popupList .popup-item:not(.hint)').length >= 2`, 'implementations list', 30000).catch(() => {});
  check(S(await popupItems()) === S(['Circle.area', 'Square.area']), `the abstract Shape.area lists its two implementations (${S(await popupItems())})`);
  check(await js(`document.getElementById('popupIn').placeholder`) === 'Choose Implementation of area (2 found)', `the list is titled as in PyCharm (${await js(`document.getElementById('popupIn').placeholder`)})`);
  await clickPopup('Circle.area');
  await until(`ide.activeTab()?.title === 'figures.py'`, 'figures.py opens', 10000).catch(() => {});
  check(S(await where()) === S(['figures.py', L.ciArea]), `choosing Circle.area opens it (${S(await where())})`);

  await openFile(t, base);
  await caret(L.polygon, 8);
  await js(`(ide.runAction('GotoImplementation'), true)`);
  await until(`ide.activeTab()?.title === 'figures.py' && ide.editor.getPosition().lineNumber === ${L.square}`, 'Square opens', 30000).catch(() => {});
  check(S(await where()) === S(['figures.py', L.square]) && !(await popupShown()), `a class with one subclass opens it at once (Polygon -> Square) (${S(await where())})`);

  await openFile(t, base);
  await caret(L.describe + 1, 12); // inside Shape.describe, not on a name of a method
  await js(`(ide.runAction('GotoImplementation'), true)`);
  await until(`ide.activeTab()?.title === 'figures.py'`, 'Square.describe opens', 30000).catch(() => {});
  check(S(await where()) === S(['figures.py', L.sqDescribe]), `in a method body, its one override opens (Shape.describe -> Square.describe) (${S(await where())})`);

  await caret(L.call, colOf(fig, L.call, 'area'));
  await js(`(ide.runAction('GotoImplementation'), true)`);
  await until(`document.querySelectorAll('#popupList .popup-item:not(.hint)').length >= 2`, 'list from a call', 30000).catch(() => {});
  check(S(await popupItems()) === S(['Circle.area', 'Square.area']), `on a call s.area() it lists what the call can run (${S(await popupItems())})`);
  await press('Escape');
  await caret(L.total, 6);
  await js(`(ide.runAction('GotoImplementation'), true)`);
  check(await hintShown('/No implementations found/'), 'a function without implementations says "No implementations found"');

  // ---------- Go to Super Method ----------
  await caret(L.sqArea + 1, 14);
  await js(`(ide.runAction('GotoSuperMethod'), true)`);
  await until(`ide.activeTab()?.title === 'base.py'`, 'Shape.area opens', 30000).catch(() => {});
  check(S(await where()) === S(['base.py', L.area]), `in Square.area it opens Shape.area two levels up (${S(await where())})`);
  await openFile(t, fig);
  await caret(L.sqSides + 1, 14);
  await js(`(ide.runAction('GotoSuperMethod'), true)`);
  await until(`ide.activeTab()?.title === 'base.py'`, 'Polygon.sides opens', 30000).catch(() => {});
  check(S(await where()) === S(['base.py', L.sides]), `in Square.sides it opens the nearest one, Polygon.sides (${S(await where())})`);
  await openFile(t, fig);
  await caret(L.circle, 3);
  await js(`(ide.runAction('GotoSuperMethod'), true)`);
  await until(`ide.activeTab()?.title === 'base.py'`, 'Shape opens', 30000).catch(() => {});
  check(S(await where()) === S(['base.py', L.shape]), `on a class line it opens the superclass (Circle -> Shape) (${S(await where())})`);
  await openFile(t, fig);
  await caret(L.sqInit + 1, 10);
  await js(`(ide.runAction('GotoSuperMethod'), true)`);
  check(await hintShown('/No super method found/'), 'Square.__init__ (object\'s is left out) says "No super method found"');

  // ---------- gutter markers ----------
  await openFile(t, base);
  const baseOk = await untilMarks('markers in base.py', `(m) => m.length >= 5`);
  const bm = Object.fromEntries((await marks()).map((m) => [m.line, m]));
  check(baseOk && bm[L.shape]?.kind === 'down' && bm[L.polygon]?.kind === 'down', `subclassed classes get a down marker (${S(await marks())})`);
  check(bm[L.area]?.kind === 'down' && bm[L.area].implements && bm[L.area].hover === 'Is implemented in Circle, Square', `the abstract area: implemented in Circle and Square (${S(bm[L.area])})`);
  check(bm[L.describe]?.kind === 'down' && !bm[L.describe].implements && bm[L.describe].hover === 'Is overridden in Square', `describe: overridden in Square (${S(bm[L.describe])})`);
  check(bm[L.sides]?.kind === 'down' && bm[L.shape].hover === 'Is subclassed by Circle, Polygon, Square', `sides is overridden; Shape is subclassed by Circle, Polygon and Square (${S(bm[L.shape])})`);
  await t.until(lensesShown(), 'code lenses', 10000).catch(() => {});
  check(await js(`ide.editor.getDomNode().querySelectorAll('.th-gutter.th-down.th-impl').length`) === 1, 'the implemented abstract method is drawn as an implementation marker');
  let pt = await iconPoint(L.area);
  if (pt) await realClick(pt.x, pt.y);
  await until(`!!document.querySelector('.context-menu')`, 'gutter menu', 5000).catch(() => {});
  const menu = await js(`[...document.querySelectorAll('.context-menu .menu-header, .context-menu .menu-label')].map((n) => n.textContent)`);
  check(S(menu) === S(['Implementations', 'Circle.area', 'Square.area']), `clicking the marker lists the implementations (${S(menu)})`);
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label').textContent === 'Square.area').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true`);
  await until(`ide.activeTab()?.title === 'figures.py'`, 'Square.area from the gutter', 10000).catch(() => {});
  check(S(await where()) === S(['figures.py', L.sqArea]), `choosing one opens it (${S(await where())})`);
  check(await js(`!(window.__debugger?.breakpoints() || []).length`), 'the click set no breakpoint');

  const figOk = await untilMarks('markers in figures.py', `(m) => m.length >= 4`);
  const fm = Object.fromEntries((await marks()).map((m) => [m.line, m]));
  check(figOk && fm[L.sqArea]?.kind === 'up' && fm[L.sqArea].implements && fm[L.sqArea].hover === 'Implements method in Shape', `Square.area implements Shape.area (${S(fm[L.sqArea])})`);
  check(fm[L.sqSides]?.kind === 'up' && !fm[L.sqSides].implements && fm[L.sqSides].hover === 'Overrides method in Polygon', `Square.sides overrides Polygon.sides (${S(fm[L.sqSides])})`);
  check(fm[L.ciArea]?.kind === 'up' && !fm[L.square] && !fm[L.sqInit] && !fm[L.total], `Circle.area is marked; Square (no subclasses), __init__ and total_area are not (${S(Object.keys(fm))})`);
  await t.until(lensesShown(), 'code lenses', 10000).catch(() => {});
  pt = await iconPoint(L.sqSides);
  if (pt) await realClick(pt.x, pt.y);
  await until(`ide.activeTab()?.title === 'base.py'`, 'Polygon.sides from the gutter', 10000).catch(() => {});
  check(S(await where()) === S(['base.py', L.sides]), `a marker with one target opens it directly (${S(await where())})`);

  // An edit adds a subclass of Square: its area is now overridden too, and Square gets a down marker.
  await openFile(t, fig);
  await js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: new ide.monaco.Range(${L.circle - 1}, 1, ${L.circle - 1}, 1), text: '\\nclass Big(Square):\\n    def area(self) -> float:\\n        return 0.0\\n\\n' }], () => null); return true; })()`);
  const edited = await untilMarks('markers follow the edit', `(m) => m.some((x) => x.line === ${L.sqArea} && x.kind === 'updown') && m.some((x) => x.line === ${L.square} && x.kind === 'down')`);
  check(edited, `after typing a subclass, Square is subclassed and Square.area both implements and is overridden (${S(await marks())})`);
  await js(`(ide.editor.getModel().undo(), true)`);

  // ---------- Go to Test ----------
  await caret(L.sqDescribe, 9);
  await js(`(ide.runAction('GotoTest'), true)`);
  await until(`ide.activeTab()?.title === 'test_figures.py'`, 'test_figures.py opens', 10000).catch(() => {});
  check(S(await where()) === S(['test_figures.py', lineOf('tests/test_figures.py', /def test_describe/)]), `Square.describe goes to TestSquare.test_describe (${S(await where())})`);
  await caret(lineOf('tests/test_figures.py', /def test_area/) + 1, 10);
  await js(`(ide.runAction('GotoTest'), true)`);
  await until(`ide.activeTab()?.title === 'figures.py'`, 'back to figures.py', 10000).catch(() => {});
  check(S(await where()) === S(['figures.py', L.sqArea]), `from TestSquare.test_area back to Square.area (${S(await where())})`);
  await openFile(t, base);
  await caret(L.shape, 3);
  await js(`(ide.runAction('GotoTest'), true)`);
  await until(`document.querySelectorAll('#popupList .popup-item:not(.hint)').length >= 3`, 'two tests listed', 10000).catch(() => {});
  check(S(await popupItems()) === S(['Create New Test…', 'base_test.py', 'test_base.py']), `two tests: Create New Test… first, then the nearest (base_test.py beside it) (${S(await popupItems())})`);
  check(await js(`document.getElementById('popupIn').placeholder`) === 'Choose Test for Shape (2 found)', 'the list is titled Choose Test for Shape (2 found)');
  await clickPopup('test_base.py');
  await until(`ide.activeTab()?.title === 'test_base.py'`, 'test_base.py opens', 10000).catch(() => {});
  check(await js(`ide.activeTab()?.path.toLowerCase().endsWith('tests\\\\test_base.py')`), 'choosing tests/test_base.py opens it');
  await js(`(ide.runAction('GotoTest'), true)`);
  await until(`ide.activeTab()?.title === 'base.py'`, 'subject of test_base.py', 10000).catch(() => {});
  check(await js(`ide.activeTab()?.path.toLowerCase().endsWith('shapes\\\\base.py')`), 'from a test file to the module it tests (test_base.py -> shapes/base.py)');

  // ---------- Create New Test ----------
  const util = 'shapes/util.py';
  await openFile(t, util);
  await caret(lineOf(util, /def length/) + 1, 10);
  await js(`(ide.runAction('GotoTest'), true)`);
  await until(`document.querySelectorAll('#popupList .popup-item:not(.hint)').length === 1`, 'only Create New Test', 10000).catch(() => {});
  check(S(await popupItems()) === S(['Create New Test…']) && await js(`document.getElementById('popupIn').placeholder`) === 'Choose Test for Vector (0 found)', `without tests only Create New Test… is offered (${S(await popupItems())})`);
  await press('Enter');
  await until(`!!document.querySelector('.dialog .gt-create')`, 'Create Test dialog', 10000).catch(() => {});
  const dlg = await js(`(() => { const d = document.querySelector('.dialog'); return d && { title: d.querySelector('.dialog-title').textContent,
    fields: [...d.querySelectorAll('.gt-create input.input')].map((i) => i.value), checks: [...d.querySelectorAll('.gt-check')].map((c) => (c.querySelector('input').checked ? '+' : '-') + c.textContent),
    buttons: [...d.querySelectorAll('.dialog-buttons button')].map((b) => b.textContent) }; })()`);
  check(dlg?.title === 'Create Test' && S(dlg.buttons) === S(['OK', 'Cancel']), `the Create Test dialog opens (${S(dlg && [dlg.title, dlg.buttons])})`);
  check(S(dlg?.fields) === S([path.join(t.project, 'tests'), 'test_util.py', 'TestVector']), `it proposes tests/, test_util.py and TestVector (${S(dlg?.fields)})`);
  check(S(dlg?.checks) === S(['-test_init', '+test_length', '-test_cache']), `public methods are checked, private and special ones not (${S(dlg?.checks)})`);
  await js(`(() => { const i = document.querySelector('.dialog input[name="file"]'); i.value = 'bad'; return true; })()`);
  await js(`(document.querySelector('.dialog .dialog-buttons .primary').click(), true)`);
  await sleep(300);
  check(await js(`document.querySelectorAll('.dialog').length === 2 && [...document.querySelectorAll('.dialog-message')].some((m) => m.textContent === 'The test file name must end with .py')`), 'a file name without .py is refused and the dialog stays');
  await press('Escape');
  await js(`(() => { const i = document.querySelector('.dialog input[name="file"]'); i.value = 'test_util.py'; return true; })()`);
  await js(`(document.querySelector('.dialog .dialog-buttons .primary').click(), true)`);
  await until(`ide.activeTab()?.title === 'test_util.py'`, 'the new test opens', 10000).catch(() => {});
  const made = path.join(t.project, 'tests', 'test_util.py');
  const madeText = existsSync(made) ? readFileSync(made, 'utf8').replace(/\r\n/g, '\n') : '';
  check(madeText === 'from shapes.util import Vector\n\n\nclass TestVector:\n    def test_length(self):\n        assert False\n', `OK writes tests/test_util.py with a pytest class (${S(madeText)})`);
  check(S(await where()) === S(['test_util.py', 5]), `and opens it at the class's first test (${S(await where())})`);
  await js(`ide.revealInTree(${S(made)})`).catch(() => {});
  check(await until(`[...document.querySelectorAll('#tree .node')].some((n) => n._entry?.path?.toLowerCase() === ${S(made.toLowerCase())})`, 'tree row', 8000).then(() => true, () => false), 'the project tree shows the new file');

  // The module's functions, added to the same file: the import goes after the first one.
  await openFile(t, util);
  await js(`(ide.gotoTest.create(${P(util)}, null), true)`);
  await until(`!!document.querySelector('.dialog .gt-create')`, 'Create Test for the module', 10000).catch(() => {});
  const mdlg = await js(`({ fields: [...document.querySelectorAll('.dialog .gt-create input.input')].map((i) => i.value), checks: [...document.querySelectorAll('.dialog .gt-check')].map((c) => (c.querySelector('input').checked ? '+' : '-') + c.textContent), list: document.querySelector('.dialog .gt-list-title')?.textContent })`);
  check(S(mdlg.fields.slice(1)) === S(['test_util.py', '']) && S(mdlg.checks) === S(['+test_clamp', '+test_lerp']) && mdlg.list === 'Test functions:', `for the module: no class name, the functions to test (${S(mdlg)})`);
  await js(`(document.querySelector('.dialog .dialog-buttons .primary').click(), true)`);
  await until(`!document.querySelector('.dialog')`, 'dialog closed', 10000).catch(() => {});
  await sleep(500);
  const added = readFileSync(made, 'utf8').replace(/\r\n/g, '\n');
  check(added === 'from shapes.util import Vector\nfrom shapes.util import clamp, lerp\n\n\nclass TestVector:\n    def test_length(self):\n        assert False\n\n\ndef test_clamp():\n    assert False\n\n\ndef test_lerp():\n    assert False\n', `an existing test file gets the import and the functions added (${S(added)})`);
  await runTests('tests/test_util.py', 'generated tests ran');
  check((await testStatus()).includes('Tests failed: 3 of 3 tests'), `the generated tests import their module and run (each fails on assert False) (${await testStatus()})`);

  // ---------- <Click to see difference> ----------
  await runTests('tests/test_diffs.py', 'test_diffs ran');
  check((await testStatus()).includes('Tests failed: 5 of 5 tests'), `the comparisons fail (${await testStatus()})`);
  await selectTest('tests/test_diffs.py::test_dict');
  check(await diffLink() === '<Click to see difference>', `a failed == shows <Click to see difference> in its output (${await diffLink()})`);
  check(await js(`(() => { const t = document.querySelector('.run-session:not(.hidden) .console').textContent; return t.trimEnd().endsWith('<Click to see difference>') && t.includes('AssertionError'); })()`), 'the link follows the failure text');
  await sleep(300);
  check(await js(`(() => { const c = document.querySelector('.run-session:not(.hidden) .console'); const a = c.querySelector('.tr-diff-line a').getBoundingClientRect(); const r = c.getBoundingClientRect(); return a.top >= r.top && a.bottom <= r.bottom + 1; })()`), 'and is in view where the console shows the end of the output');
  await js(`(document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a').click(), true)`);
  await until(DIFF_TAB, 'diff tab', 15000).catch(() => {});
  let dv = await diffTab();
  check(dv?.title === 'Comparison Failure (test_dict)' && S(dv.head) === S(['Expected', 'Actual']) && dv.dialogs === 0,
    `the link opens a Comparison Failure compare tab with Expected and Actual (${S(dv && [dv.title, dv.head, dv.dialogs])})`);
  check(dv?.expected === "{'a': 1, 'b': [1, 2, 4]}" && dv.actual === "{'a': 1, 'b': [1, 2, 3]}" && dv.differences === '1' && dv.count === '1 difference', `the tab compares the two values (${S(dv)})`);
  const diffId = await js(`ide.activeTab().path`);
  await js(`(document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a').click(), true)`);
  await until(DIFF_TAB, 'diff tab again', 15000).catch(() => {});
  check(await js(`ide.tabs.filter((t) => t.path === ${S(diffId)}).length`) === 1, 'clicking the link again shows one tab for the test, not a second');
  const models = await js(`ide.monaco.editor.getModels().length`);
  await js(`(ide.closeTab(${S(diffId)}), true)`);
  await until(`!ide.findTab(${S(diffId)})`, 'diff tab closed', 5000).catch(() => {});
  check(await js(`ide.monaco.editor.getModels().length`) === models - 2, 'closing the tab disposes its two models');

  await selectTest('tests/test_diffs.py::test_lines');
  await js(`document.querySelector('.run-session:not(.hidden) .tr-tree').focus()`);
  await press('Ctrl+d');
  await until(DIFF_TAB, 'Ctrl+D tab', 15000).catch(() => {});
  dv = await diffTab();
  check(dv?.expected === 'alpha\nBETA\ngamma\n' && dv.actual === 'alpha\nbeta\ngamma\n' && dv.differences === '1', `Ctrl+D in the test tree opens it too; strings are compared line by line (${S(dv)})`);
  await js(`(ide.closeTab(ide.activeTab().path), true)`);

  // Without the compare plugin the viewer is a dialog.
  await js(`(window.__compare = ide.compare, ide.compare = undefined, true)`);
  await selectTest('tests/test_diffs.py::test_dict');
  await js(`(document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a').click(), true)`);
  await until(`(() => { const d = document.querySelector('.dialog .tr-diff'); return d && d.dataset.differences; })()`, 'diff dialog', 15000).catch(() => {});
  dv = await diffDialog();
  check(dv?.title === 'Comparison Failure (test_dict)' && S(dv.head) === S(['Expected', 'Actual']) && dv.differences === '1',
    `with the compare plugin disabled the link opens a Comparison Failure dialog (${S(dv && [dv.title, dv.head, dv.differences])})`);
  const dialogModels = await js(`ide.monaco.editor.getModels().length`);
  await press('Escape');
  await until(`!document.querySelector('.dialog')`, 'viewer closed', 5000).catch(() => {});
  check(await js(`ide.monaco.editor.getModels().length`) === dialogModels - 2, 'Esc closes the dialog and its two models are disposed');
  await js(`(ide.compare = window.__compare, true)`);
  await selectTest('tests/test_diffs.py::TestUnit::test_equal');
  check(await diffLink() === '<Click to see difference>', 'a TestCase assertEqual failure has the link too');
  await selectTest('tests/test_diffs.py::test_no_compare');
  check(await diffLink() === null, 'a failed assertion without == has none');
  await selectTest('tests/test_diffs.py::test_caught_then_error');
  check(await diffLink() === null, 'nor has a test that failed with another error after a caught comparison');
} catch (err) {
  check(false, err.message.split('\n')[0]);
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'nav-tests', port: 9551, name: 'navigation-tests-ko', lang: 'ko-KR' });
try {
  await openFile(k, 'shapes/base.py');
  await k.until(`ide.lsp.status() === 'ready'`, 'Pyright ready (ko)', 60000);
  await k.until(`ide.typeHierarchy.gutterMarks().length >= 5`, 'markers (ko)', 30000).catch(() => {});
  const hovers = (await k.js(`ide.typeHierarchy.gutterMarks().map((m) => m.hover)`)) || [];
  k.check(hovers.includes('Circle, Square에서 구현됨') && hovers.includes('서브클래스: Circle, Polygon, Square'), `marker tooltips are Korean (${S(hovers)})`);
  const area = lineOf('shapes/base.py', /def area/);
  await k.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${area}, column: ${colOf('shapes/base.py', area, 'area')} }), true)`);
  await k.js(`(ide.runAction('GotoImplementation'), true)`);
  await k.until(`document.querySelectorAll('#popupList .popup-item:not(.hint)').length >= 2`, 'list (ko)', 30000).catch(() => {});
  k.check(await k.js(`document.getElementById('popupIn').placeholder`) === 'area의 구현 선택(2개 찾음)', `the implementations list is Korean (${await k.js(`document.getElementById('popupIn').placeholder`)})`);
  await k.press('Escape');
  await openFile(k, 'shapes/util.py');
  await k.js(`(ide.gotoTest.create(ide.util.joinPath(ide.root, 'shapes\\\\util.py'), { kind: 'class', name: 'Vector' }), true)`);
  await k.until(`!!document.querySelector('.dialog .gt-create')`, 'Create Test (ko)', 10000).catch(() => {});
  k.check(await k.js(`document.querySelector('.dialog .dialog-title').textContent`) === '테스트 생성', 'Create Test is 테스트 생성');
  const leaks1 = await englishLeaks(k, '.dialog');
  k.check(!leaks1.length, `the Create Test dialog has no English UI text (${S(leaks1)})`);
  await k.press('Escape');
  await k.js(`(ide.run.runConfig({ type: 'pytest', name: 'diffs', target: 'tests/test_diffs.py::test_dict' }, { confirm: false }), true)`);
  await k.until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'diffs'`, 'run tab (ko)', 20000);
  await k.until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state && s.dataset.state !== 'running'; })()`, 'run (ko)', 60000);
  await k.until(`!!document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a')`, 'link (ko)', 10000).catch(() => {});
  k.check(await k.js(`document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a')?.textContent`) === '<클릭하여 차이 보기>', 'the link is Korean');
  await k.js(`(document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a').click(), true)`);
  await k.until(DIFF_TAB, 'viewer (ko)', 15000).catch(() => {});
  k.check(await k.js(`${DIFF_TAB}?.title`) === '비교 실패 (test_dict)' && await k.js(`[...${DIFF_TAB}.host.querySelectorAll('.cmp-head .cmp-side')].map((s) => s.firstChild.textContent).join()`) === '예상,실제',
    'the viewer reads 비교 실패, 예상, 실제');
  const leaks2 = await englishLeaks(k, '.custom-tab.cmp-tab:not(.hidden)');
  k.check(!leaks2.length, `the viewer has no English UI text (${S(leaks2)})`);
  const mine = new Set(['Go to Implementation(s)', 'Go to Super Method', 'Go to Test', 'Create New Test…', 'Create Test', '<Click to see difference>', 'Expected', 'Actual', 'Comparison Failure ({name})']);
  const missing = (await missingTranslations(k)).filter((s) => mine.has(s) || /Implement|Overrid|Super|subclass|Test (class|file|methods|functions)|Target directory/.test(s));
  k.check(!missing.length, `every new string has a Korean entry (${S(missing)})`);
} catch (err) {
  k.check(false, err.message.split('\n')[0]);
}
k.results.unshift(...pure, ...t.results);
k.consoleErrors.push(...t.consoleErrors);
k.finish();
