// Run with Coverage and Profile (renderer/features/coverage, renderer/features/profiler) with real coverage.py and
// cProfile runs on verify/fixtures/coverage-profile. The suite keeps a venv with pytest in
// verify/out/coverage-profile-venv and uninstalls coverage.py from it first, so every run installs coverage.py through
// the Install Manager's pip job from the Run with Coverage prompt (COVERAGE_KEEP=1 keeps an installed one).
// Ports 9700-9701.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENV = path.join(HERE, 'out', 'coverage-profile-venv');
const VENV_PY = path.join(VENV, 'Scripts', 'python.exe');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 600000, windowsHide: true, ...opts });

if (!existsSync(VENV_PY)) {
  console.log('creating verify/out/coverage-profile-venv (one time)…');
  try { sh('py', ['-3', '-m', 'venv', VENV]); } catch { sh('python', ['-m', 'venv', VENV]); }
}
try { sh(VENV_PY, ['-c', 'import pytest']); } catch { sh(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'pytest']); }
if (!process.env.COVERAGE_KEEP) {
  try { sh(VENV_PY, ['-m', 'pip', 'uninstall', '-y', '-q', 'coverage']); } catch {}
}
const hadCoverage = (() => { try { sh(VENV_PY, ['-c', 'import coverage']); return true; } catch { return false; } })();

const q = JSON.stringify;

async function useInterpreter(t, exe) {
  await t.js(`(async () => {
    ide.settings.set('interpreters.extra', [...new Set([...ide.settings.get('interpreters.extra', []), ${q(exe)}])]);
    await ide.reloadInterpreters();
    return ide.setInterpreter(${q(exe)});
  })()`);
  await t.until(`ide.util.samePath(ide.currentInterp()?.executable || '', ${q(exe)})`, 'interpreter selected');
}

const menuLabels = (t) => t.js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.querySelector('.menu-label').textContent)`);
async function clickMenu(t, label, level = 0) {
  const found = await t.js(`(() => { document.querySelector('.pick-menu')?.classList.remove('pick-menu');
    const n = [...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')].find(n => n.querySelector('.menu-label').textContent === ${q(label)});
    n?.classList.add('pick-menu'); return !!n; })()`);
  if (!found) throw new Error(`menu item ${label} not found in ${q(await menuLabels(t))}`);
  await t.click('.context-menu .menu-item.pick-menu');
}
async function clickAt(t, expr, { double = false, button = 'left' } = {}) {
  const box = await t.js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`nothing at ${expr}`);
  for (let i = 1; i <= (double ? 2 : 1); i++) {
    for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: i });
  }
  await t.sleep(120);
}
async function hover(t, expr) {
  const p = await t.js(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await t.sleep(300);
}

const runOut = (t) => t.js(`document.querySelector('.run-session:not(.hidden) .console')?.textContent || ''`);
const covRow = (t, rel) => t.js(`(() => { const r = [...document.querySelectorAll('.cov-item')].find(r => r.dataset.path.toLowerCase().endsWith(${q(rel.toLowerCase())}));
  return r && [...r.querySelectorAll('.cov-pc')].map(c => c.textContent); })()`);
const rootRow = (t) => t.js(`[...document.querySelector('.cov-item[data-kind="dir"]').querySelectorAll('.cov-pc')].map(c => c.textContent)`);
// Coverage stripes on the active editor's model: {line: state}.
const stripes = (t) => t.js(`Object.fromEntries(ide.editor.getModel().getAllDecorations()
  .filter(d => (d.options.linesDecorationsClassName || '').includes('cov-line'))
  .map(d => [d.range.startLineNumber, d.options.linesDecorationsClassName.split(' ').pop().replace('cov-', '')]))`);
async function stripeBox(t, line) {
  await t.js(`ide.editor.revealLineInCenter(${line})`);
  const find = `(() => { const ed = ide.editor; ed.render(true); const top = ed.getTopForLineNumber(${line}) - ed.getScrollTop();
    const host = document.querySelector('#editor').getBoundingClientRect();
    const n = [...document.querySelectorAll('#editor .cov-line')].find(i => Math.abs(i.getBoundingClientRect().top - host.top - top) < 4);
    if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, cls: n.className }; })()`;
  await t.until(find, `coverage stripe on line ${line}`, 5000);
  return t.js(find);
}
const statsRows = (t) => t.js(`[...document.querySelectorAll('.pf-stats .pf-item')].map(r => ({ name: r.querySelector('.pf-label').textContent,
  loc: r.querySelector('.pf-loc')?.textContent || '', nums: [...r.querySelectorAll(':scope > .pf-num')].map(c => parseFloat(c.firstChild.textContent)) }))`);
const treeRows = (t) => t.js(`[...document.querySelectorAll('.pf-tree .pf-item')].map(r => ({ name: r.querySelector('.pf-label').textContent, depth: +r.dataset.depth,
  open: r.querySelector('.pf-arrow').textContent === '▾' }))`);
const frames = (t) => t.js(`(() => { const c = document.querySelector('.pf-flame-canvas'); const W = c.clientWidth;
  return [...c.querySelectorAll('.pf-frame')].map(f => ({ name: f.dataset.name || '', w: f.offsetWidth / W, bottom: parseFloat(f.style.bottom), title: f.title, zoomed: f.classList.contains('zoomed') })); })()`);

// coverage.py's own report for the same program, to compare with what the tool window shows.
function coverageCli(project, args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyide-cov-cli-'));
  const data = path.join(dir, '.coverage');
  sh(VENV_PY, ['-m', 'coverage', 'run', '--branch', `--source=${project}`, `--data-file=${data}`, ...args], { cwd: project, env: { ...process.env, PYTHONPATH: project } });
  sh(VENV_PY, ['-m', 'coverage', 'json', '-q', `--data-file=${data}`, '-o', path.join(dir, 'c.json')], { cwd: project });
  const files = JSON.parse(readFileSync(path.join(dir, 'c.json'), 'utf8')).files;
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replace(/\\/g, '/'), v.summary]));
}

// ---------- English session ----------
const t = await launch({ fixture: 'coverage-profile', port: 9700 });
const { js, until, check, shot } = t;
try {
  await until('ide.currentInterp()', 'interpreter detected', 30000);
  await useInterpreter(t, VENV_PY);
  check(await js(`ide.installables.some(i => i.id === 'pip:coverage')`), 'coverage.py is listed in the Install Manager');
  if (!process.env.COVERAGE_KEEP) check(!hadCoverage, 'coverage.py starts uninstalled in the test interpreter');

  // ---------- toolbar: More Actions next to Run and Debug ----------
  await openFile(t, 'app.py');
  const widget = await js(`[...document.querySelector('.run-btn').parentElement.children].filter(n => !n.classList.contains('hidden')).map(n => n.className.split(' ')[1] || n.className)`);
  const iRun = widget.indexOf('run-btn');
  check(iRun >= 0 && widget[iRun + 1] === 'dbg-tb-btn' && widget[iRun + 2] === 'run-more-btn', `run widget: Run, Debug, then More Actions (${widget.join(', ')})`);
  check(await js(`!!document.querySelector('.run-more-btn svg')`), 'More Actions uses the PyCharm icon');
  await t.click('.run-more-btn');
  await until(`!!document.querySelector('.context-menu')`, 'More Actions menu');
  const more = await menuLabels(t);
  check(more.includes("Run 'app' with Coverage") && more.includes("Profile 'app'"), `More Actions offers Run 'app' with Coverage and Profile 'app' (${more.join(' | ')})`);
  check(await js(`[...document.querySelectorAll('.context-menu .menu-item')].every(n => n.querySelector('.menu-icon svg'))`), 'both items show PyCharm icons (runWithCoverage, profile)');

  // ---------- Run with Coverage: install coverage.py through the Install Manager ----------
  await clickMenu(t, "Run 'app' with Coverage");
  if (!hadCoverage) {
    await until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Run with Coverage')`, 'install prompt', 30000);
    check((await js(`document.querySelector('.cov-install').textContent`)).includes('coverage.py is not installed'), 'missing coverage.py prompts to install it');
    await shot('install-prompt.png');
    await t.click('.dialog-buttons .primary');
    await until(`!document.querySelector('.cov-install-log.hidden') && !!document.querySelector('.cov-install-log')?.textContent`, 'pip log streams', 30000);
    check(true, 'the pip log streams into the prompt');
    await until(`!document.querySelector('.cov-install')`, 'coverage.py installed', 240000);
    check(sh(VENV_PY, ['-c', 'import coverage; print(coverage.__version__)']).trim().length > 0, 'coverage.py is now installed in the project interpreter');
  }
  await until(`(document.querySelector('.run-session:not(.hidden) .console')?.textContent || '').includes('Process finished with exit code')`, 'app.py finished', 60000);
  const out = await runOut(t);
  check(out.includes('positive zero') && out.includes('Process finished with exit code 0'), 'the program runs normally under coverage');
  check(out.includes('pyide_coverage_run.py'), 'the run console shows the coverage command line');
  await until(`ide.toolWindows.get('Coverage').isVisible() && !!document.querySelector('.cov-item')`, 'Coverage tool window', 15000);
  check(true, 'the Coverage tool window opens with the results');
  check((await js(`document.querySelector('.cov-suite').textContent`)) === 'app', 'the suite is named after the configuration');
  await shot('coverage-window.png');

  // ---------- percentages ----------
  const cli = coverageCli(t.project, ['app.py']);
  const pct = (c, n) => `${Math.round((100 * c) / n)}% (${c}/${n})`;
  const app = await covRow(t, '\\app.py');
  check(app?.[0] === '90% (26/29)' && app?.[1] === '80% (8/10)', `app.py: 90% of lines (26/29), 80% of branches (8/10) (${app})`);
  check(app?.[0] === pct(cli['app.py'].covered_lines, cli['app.py'].num_statements) && app?.[1] === pct(cli['app.py'].covered_branches, cli['app.py'].num_branches),
    'app.py matches coverage.py\'s own report');
  const text = await covRow(t, '\\util\\text.py');
  check(text?.[0] === '0% (0/6)' && text?.[1] === '0% (0/2)', `a never-imported package file is reported at 0% (${text})`);
  const util = await covRow(t, '\\util');
  check(util?.[0] === '0% (0/6)', `folder rows add up their files (util: ${util})`);
  const root = await rootRow(t);
  check(root[0] === '63% (26/41)' && root[1] === '67% (8/12)', `the project row totals every file (${root})`);
  check((await js(`document.querySelector('.cov-summary').textContent`)) === '63% lines covered, 67% branches covered', 'the header sums up line and branch coverage');
  check((await js(`[...document.querySelectorAll('.cov-columns span')].map(s => s.textContent).join('|')`)) === 'Element|Line, %|Branch, %', 'columns: Element, Line %, Branch %');

  // ---------- editor stripes ----------
  let s = await stripes(t);
  check(s[5] === 'hit' && s[40] === 'hit', 'executed lines get green stripes');
  check(s[7] === 'miss' && s[14] === 'miss' && s[15] === 'miss', 'missed lines (return \'negative\', unused()) get red stripes');
  check(s[6] === 'partial' && s[45] === 'partial', 'lines with a branch never taken get yellow stripes');
  check(s[2] === 'hit' && !s[3] && !s[4] && !s[11], 'blank lines get no stripe');
  const box = await stripeBox(t, 6);
  check(box.cls.includes('cov-partial'), 'the yellow stripe is drawn in the editor gutter');
  check(await js(`getComputedStyle(document.querySelector('#editor .cov-line')).width`) === '4px', 'stripes are 4px wide');
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await until(`!!document.querySelector('.context-menu .menu-header')`, 'stripe popup');
  check((await js(`document.querySelector('.context-menu .menu-header').textContent`)) === 'Covered 1/2 branches', 'clicking a yellow stripe tells how many branches ran');
  check(!(await js(`!!document.querySelector('#editor .dbg-bp:not(.hover)')`)), 'clicking a stripe does not toggle a breakpoint');
  await clickMenu(t, 'Hide Coverage');
  s = await stripes(t);
  check(!Object.keys(s).length, 'Hide Coverage removes the stripes');
  check((await js(`document.querySelector('.cov-hidden')?.textContent`)) === 'Hidden in editors', 'the tool window says the coverage is hidden in editors');
  check(await js(`ide.actions.some(a => a.id === 'ShowCoverage') && !ide.settings.get('coverage.showInEditor', true)`), 'hiding is a setting with a Show Coverage in Editors action');
  await t.click('#bottomActions button[title="Show Coverage in Editors"]');
  s = await stripes(t);
  check(s[7] === 'miss' && s[6] === 'partial', 'the tool window toggle brings the stripes back');

  // ---------- project tree badges and navigation ----------
  await until(`[...document.querySelectorAll('#tree .tree-badge')].some(b => b.textContent === '90% lines covered')`, 'tree badge', 5000)
    .then(() => check(true, 'the project tree shows "90% lines covered" next to app.py'), () => check(false, 'the project tree shows "90% lines covered" next to app.py'));
  await clickAt(t, `[...document.querySelectorAll('.cov-item')].find(r => r.dataset.path.toLowerCase().endsWith('\\\\text.py'))`, { double: true });
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('text.py')`, 'text.py opened');
  s = await stripes(t);
  check(Object.values(s).length === 6 && Object.values(s).every((v) => v === 'miss'), 'double-clicking a file opens it, fully red');

  // ---------- Run menu: Run with Coverage on the current file (pytest), replacing the data ----------
  await openFile(t, 'test_app.py');
  await t.click('#mainMenuBtn');
  await until(`!!document.querySelector('#mainMenu')`, 'main menu');
  await hover(t, `[...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.querySelector('.menu-label').textContent === 'Run')`);
  await until(`document.querySelectorAll('.context-menu').length === 2`, 'Run submenu');
  const runMenu = await t.js(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].map(n => n.querySelector('.menu-label').textContent)`);
  check(runMenu.indexOf('Run with Coverage') === runMenu.indexOf('Debug') + 1 && runMenu.indexOf('Profile') === runMenu.indexOf('Debug') + 2,
    `the Run menu lists Run with Coverage and Profile after Debug (${runMenu.slice(0, 6).join(', ')})`);
  check(runMenu.includes('Hide Coverage'), 'the Run menu has Hide Coverage');
  await clickMenu(t, 'Run with Coverage', 1);
  await until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, 'tests finished', 60000);
  const testStatus = await js(`document.querySelector('.run-session:not(.hidden) .tr-status').textContent`);
  check(testStatus.includes('Tests passed: 2 of 2 tests'), `pytest runs with coverage and both tests pass (${testStatus})`);
  await until(`document.querySelector('.cov-suite')?.textContent === 'pytest in test_app.py'`, 'test coverage suite', 15000);
  const app2 = await covRow(t, '\\app.py');
  check(app2?.[0] === '38% (11/29)' && app2?.[1] === '20% (2/10)', `re-running replaces the data: app.py is now 38% (11/29) and 20% of branches (${app2})`);
  const cli2 = coverageCli(t.project, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider']);
  check(app2?.[0] === pct(cli2['app.py'].covered_lines, cli2['app.py'].num_statements), 'the test run matches coverage.py\'s own report');
  check((await covRow(t, '\\util\\text.py'))?.[0] === '50% (3/6)' && (await covRow(t, '\\test_app.py'))?.[0] === '100% (6/6)', 'test files and modules they import are measured');
  await openFile(t, 'app.py');
  s = await stripes(t);
  check(s[40] === 'miss' && s[7] === 'hit' && s[6] === 'partial', 'stripes follow the new run (main() now red, return \'negative\' green)');

  // ---------- Profile from the gutter ----------
  await js(`ide.editor.revealLineInCenter(45)`);
  const gutter = `(() => { const ed = ide.editor; ed.render(true); const top = ed.getTopForLineNumber(45) - ed.getScrollTop();
    const host = document.querySelector('#editor').getBoundingClientRect();
    const n = [...document.querySelectorAll('#editor .run-gutter-icon')].find(i => Math.abs(i.getBoundingClientRect().top - host.top - top) < 4);
    if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
  await until(gutter, 'run icon on the __main__ line', 5000);
  const g = await js(gutter);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: g.x, y: g.y, button: 'left', clickCount: 1 });
  await until(`!!document.querySelector('.context-menu')`, 'gutter menu');
  const gm = await menuLabels(t);
  check(gm.includes("Run 'app' with Coverage") && gm.includes("Profile 'app'"), `the gutter run menu offers coverage and profiling (${gm.join(' | ')})`);
  await clickMenu(t, "Profile 'app'");
  await until(`ide.toolWindows.get('Profiler').isVisible() && !!document.querySelector('.pf-stats .pf-item')`, 'Profiler tool window', 60000);
  check((await runOut(t)).includes('Process finished with exit code 0'), 'the program runs normally under cProfile');
  check((await js(`[...document.querySelectorAll('.pf-tab')].map(b => b.textContent).join('|')`)) === 'Statistics|Call Tree|Flame Graph', 'tabs: Statistics, Call Tree, Flame Graph');
  await shot('profiler-statistics.png');

  // ---------- Statistics ----------
  const rows = await statsRows(t);
  const byName = (n) => rows.find((r) => r.name === n && (n.startsWith('<built-in') || r.loc.startsWith('app.py')));
  check((await js(`[...document.querySelectorAll('.pf-stats .pf-head .pf-col')].map(c => c.firstChild.textContent).join('|')`)) === 'Name|Call Count|Time (ms)|Own Time (ms)', 'columns: Name, Call Count, Time, Own Time');
  const busy = byName('busy_wait');
  check(busy && busy.nums[0] === 1 && busy.nums[1] >= 290, `busy_wait: 1 call, at least 300 ms in total (${busy && busy.nums})`);
  check(byName('fib')?.nums[0] === 1973, `fib(15) makes 1973 calls (${byName('fib')?.nums[0]})`);
  check(byName('classify')?.nums[0] === 2 && byName('<module>')?.loc === 'app.py:1', 'call counts and source locations are listed');
  check(!rows.some((r) => /pyide_profile_run|runpy|_lsprof/.test(r.name + r.loc)), 'the profiler\'s own frames are left out');
  check(rows.every((r, i) => i === 0 || rows[i - 1].nums[1] >= r.nums[1]), 'sorted by total time, descending');
  await t.click('.pf-stats .pf-col-nc');
  let sorted = await statsRows(t);
  check(sorted[0].name === '<built-in method time.perf_counter>' && sorted.every((r, i) => i === 0 || sorted[i - 1].nums[0] >= r.nums[0]), `clicking Call Count sorts by calls (top: ${sorted[0].name})`);
  await t.click('.pf-stats .pf-col-nc');
  sorted = await statsRows(t);
  check(sorted.every((r, i) => i === 0 || sorted[i - 1].nums[0] <= r.nums[0]), 'clicking again reverses the order');
  await t.click('.pf-stats .pf-col-tt');
  sorted = await statsRows(t);
  check(sorted.every((r, i) => i === 0 || sorted[i - 1].nums[2] >= r.nums[2]), 'Own Time sorts descending');
  await clickAt(t, `[...document.querySelectorAll('.pf-stats .pf-item')].find(r => r.querySelector('.pf-label').textContent === 'slow_sum')`, { double: true });
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('app.py') && ide.editor.getPosition().lineNumber === 18`, 'navigated to slow_sum', 5000)
    .then(() => check(true, 'double-clicking a row navigates to the function (app.py:18)'), () => check(false, 'double-clicking a row navigates to the function (app.py:18)'));

  // ---------- Call Tree ----------
  await t.click('.pf-tab[data-tab="tree"]');
  let tree = await treeRows(t);
  const at = (n) => tree.find((r) => r.name === n);
  check(tree[0]?.name === '<module>' && tree[0].depth === 0, `the program's top-level code is the first root (${tree[0]?.name})`);
  check(at('main')?.depth === 1 && at('busy_wait')?.depth === 2 && at('<built-in method time.perf_counter>')?.depth === 3, 'the hot path <module> → main → busy_wait → perf_counter is expanded');
  check(at('compute')?.depth === 2 && !at('compute').open, 'compute is listed under main, collapsed');
  await clickAt(t, `[...document.querySelectorAll('.pf-tree .pf-item')].find(r => r.querySelector('.pf-label').textContent === 'compute').querySelector('.pf-arrow')`);
  tree = await treeRows(t);
  const ci = tree.findIndex((r) => r.name === 'compute');
  const kids = tree.slice(ci + 1).filter((r) => r.depth === 3).map((r) => r.name);
  check(kids.includes('slow_sum') && kids.includes('fib'), `expanding compute shows slow_sum and fib (${kids.join(', ')})`);
  check(tree.filter((r) => r.name === 'fib').length === 1, 'recursive fib calls fold into one node');
  await shot('profiler-tree.png');

  // ---------- Flame Graph ----------
  await t.click('.pf-tab[data-tab="flame"]');
  await until(`document.querySelectorAll('.pf-flame-canvas .pf-frame').length > 3`, 'flame graph');
  let fr = await frames(t);
  const f = (n) => fr.find((x) => x.name === n);
  check(fr.find((x) => !x.name && x.bottom === 0)?.w > 0.99, 'the base frame (All) spans the full width');
  check(f('<module>')?.bottom === 20 && f('main')?.bottom === 40, 'callers sit below their callees (root at the bottom)');
  check(f('busy_wait')?.w > 0.8 && f('compute')?.w < f('busy_wait').w, `busy_wait is the widest frame above main (${f('busy_wait')?.w.toFixed(2)} vs compute ${f('compute')?.w.toFixed(3)})`);
  check(f('busy_wait')?.title.includes('Calls: 1') && f('busy_wait').title.includes('app.py:29'), 'frame tooltips show location, time and calls');
  await shot('profiler-flame.png');
  await clickAt(t, `document.querySelector('.pf-frame[data-name="busy_wait"]')`);
  await until(`!!document.querySelector('.pf-frame.zoomed')`, 'zoomed', 3000).catch(() => {});
  fr = await frames(t);
  check(f('busy_wait')?.zoomed && f('busy_wait').w > 0.99 && !(await js(`document.querySelector('.pf-reset').classList.contains('hidden')`)), 'clicking a frame zooms into it');
  await t.click('.pf-reset');
  fr = await frames(t);
  check(f('busy_wait')?.w < 0.99, 'Reset Zoom shows the whole graph again');
  await clickAt(t, `document.querySelector('.pf-frame[data-name="busy_wait"]')`, { double: true });
  await until(`ide.editor.getPosition().lineNumber === 29`, 'navigated to busy_wait', 5000)
    .then(() => check(true, 'double-clicking a frame navigates to the source'), () => check(false, 'double-clicking a frame navigates to the source'));

  // ---------- rerun keeps the executor ----------
  const before = await js('ide.profiler.snapshot().time');
  await js(`ide.toolWindows.get('Run').show()`);
  await t.click(`#bottomActions button[title^="Rerun"]`);
  await until(`ide.profiler.snapshot().time !== ${before}`, 'profile rerun', 60000)
    .then(() => check(true, 'Rerun in the Run tool window profiles again'), () => check(false, 'Rerun in the Run tool window profiles again'));
  check(await js(`ide.actions.some(a => a.id === 'RunCoverage') && ide.actions.some(a => a.id === 'Profile') && ide.actions.some(a => a.id === 'HideCoverage')`), 'Run with Coverage, Profile and Hide Coverage are actions');
} catch (err) {
  check(false, `english session: ${err.message}`);
  await shot('failure.png').catch(() => {});
}
t.close();

// ---------- Korean session ----------
const k = await launch({ fixture: 'coverage-profile', port: 9701, name: 'coverage-profile-ko', lang: 'ko-KR' });
try {
  await k.until('ide.currentInterp()', 'interpreter detected', 30000);
  await useInterpreter(k, VENV_PY);
  await openFile(k, 'app.py');
  await k.click('.run-more-btn');
  await k.until(`!!document.querySelector('.context-menu')`, 'More Actions menu');
  const more = await menuLabels(k);
  k.check(more.includes("커버리지로 'app' 실행") && more.includes("'app' 프로파일"), `More Actions in Korean (${more.join(' | ')})`);
  k.check((await k.js(`document.querySelector('.run-more-btn').title`)) === '액션 더보기', 'More Actions tooltip in Korean');
  await clickMenu(k, "커버리지로 'app' 실행");
  await k.until(`ide.toolWindows.get('Coverage').isVisible() && !!document.querySelector('.cov-item')`, 'Coverage tool window', 60000);
  k.check((await k.js(`[...document.querySelectorAll('.cov-columns span')].map(s => s.textContent).join('|')`)) === '요소|줄, %|브랜치, %', 'coverage columns in PyCharm\'s Korean terms');
  k.check((await k.js(`document.querySelector('.cov-summary').textContent`)) === '63%개 줄 포함, 67%개 브랜치 포함', 'coverage summary in Korean');
  k.check((await k.js(`document.querySelector('.bottom-tab.active')?.textContent`)) === '커버리지', 'the tool window is named 커버리지');
  const leaks = await englishLeaks(k, '.cov-tool, #bottomActions');
  k.check(!leaks.length, `no English in the Coverage tool window${leaks.length ? `: ${q(leaks.slice(0, 5))}` : ''}`);
  const box = await stripeBox(k, 7);
  for (const type of ['mousePressed', 'mouseReleased']) await k.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await k.until(`!!document.querySelector('.context-menu .menu-header')`, 'stripe popup');
  const popup = await k.js(`document.querySelector('.context-menu').innerText`);
  k.check(popup.includes('포함되지 않음') && popup.includes('커버리지 숨기기'), `stripe popup in Korean (${popup.replace(/\n/g, ' | ')})`);
  await k.press('Escape');
  await k.shot('coverage-ko.png');

  await k.js(`ide.run.runSelected({ executor: 'Profile' })`);
  await k.until(`ide.toolWindows.get('Profiler').isVisible() && !!document.querySelector('.pf-stats .pf-item')`, 'Profiler tool window', 60000);
  k.check((await k.js(`[...document.querySelectorAll('.pf-tab')].map(b => b.textContent).join('|')`)) === '통계|호출 트리|플레임 그래프', 'profiler tabs in Korean');
  k.check((await k.js(`[...document.querySelectorAll('.pf-stats .pf-head .pf-col')].map(c => c.firstChild.textContent).join('|')`)) === '이름|호출 횟수|시간 (밀리초)|자기 시간(밀리초)', 'statistics columns in PyCharm\'s Korean terms');
  let pl = await englishLeaks(k, '.pf-tool, #bottomActions');
  k.check(!pl.length, `no English in Statistics${pl.length ? `: ${q(pl.slice(0, 5))}` : ''}`);
  await k.click('.pf-tab[data-tab="tree"]');
  pl = await englishLeaks(k, '.pf-tool, #bottomActions');
  k.check(!pl.length, `no English in Call Tree${pl.length ? `: ${q(pl.slice(0, 5))}` : ''}`);
  await k.click('.pf-tab[data-tab="flame"]');
  await k.until(`document.querySelectorAll('.pf-flame-canvas .pf-frame').length > 3`, 'flame graph');
  pl = await englishLeaks(k, '.pf-tool, #bottomActions');
  k.check(!pl.length, `no English in Flame Graph${pl.length ? `: ${q(pl.slice(0, 5))}` : ''}`);
  k.check((await k.js(`document.querySelector('.pf-frame[data-name="busy_wait"]').title`)).includes('호출: 1회'), 'flame tooltips in Korean');
  await k.shot('profiler-ko.png');

  await k.click('#mainMenuBtn');
  await k.until(`!!document.querySelector('#mainMenu')`, 'main menu');
  await hover(k, `[...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.querySelector('.menu-label').textContent === '실행')`);
  await k.until(`document.querySelectorAll('.context-menu').length === 2`, 'Run submenu');
  const runMenu = await menuLabels(k);
  k.check(runMenu.includes('커버리지로 실행') && runMenu.includes('프로파일') && runMenu.includes('커버리지 숨기기'), 'Run menu entries in Korean');
  await k.press('Escape');
  await k.press('Escape');

  const mine = new Set([
    ...Object.keys(JSON.parse(readFileSync(path.join(HERE, '..', 'renderer', 'features', 'coverage', 'locales', 'ko.json'), 'utf8'))),
    ...Object.keys(JSON.parse(readFileSync(path.join(HERE, '..', 'renderer', 'features', 'profiler', 'locales', 'ko.json'), 'utf8'))),
  ]);
  const missing = (await missingTranslations(k)).filter((x) => mine.has(x) || /coverage|profil|flame|call tree/i.test(x));
  k.check(!missing.length, `every coverage and profiler string has a Korean translation${missing.length ? `: ${q(missing)}` : ''}`);
} catch (err) {
  k.check(false, `korean session: ${err.message}`);
  await k.shot('failure-ko.png').catch(() => {});
}
for (const r of t.results) k.results.unshift(r);
k.consoleErrors.unshift(...t.consoleErrors);
k.finish();
