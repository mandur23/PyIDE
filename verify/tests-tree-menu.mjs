// The Project tree's Run and Debug 'pytest in <name>' (tests plugin): named after the folder or file, offered on folders with a
// test file at any depth and on test files, not on folders without tests or on other files, following files created
// and deleted, running pytest on that folder, and in Korean. Ports 9106-9107.
import { rmSync, writeFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'tests-tree-menu', port: 9106 });
const { js, until, check, press } = t;
const project = path.basename(t.project);

// The labels of the tree's context menu on `rel` ('' for the project folder), the menu closed again. menuCut lists the
// pytest labels that were cut off or outside the window.
let menuCut = [];
async function menuOn(ctx, rel) {
  const target = rel ? path.join(ctx.project, rel) : ctx.project;
  if (rel) await ctx.js(`ide.revealInTree(${S(target)})`);
  const row = `[...document.querySelectorAll('#tree .node')].find((n) => !n._entry.treeRoot && n._entry.path.toLowerCase() === ${S(target.toLowerCase())})`;
  await ctx.until(`!!${row}`, `tree row ${rel || 'project'}`);
  await ctx.js(`(() => { const n = ${row}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await ctx.until(`!!document.querySelector('.context-menu .menu-label')`, `menu on ${rel || 'project'}`);
  const labels = await ctx.js(`[...document.querySelectorAll('.context-menu .menu-label')].map((l) => l.textContent)`);
  menuCut = await ctx.js(`[...document.querySelectorAll('.context-menu .menu-label')].filter((l) => /pytest/.test(l.textContent)).filter((l) => {
    const r = l.getBoundingClientRect();
    return l.scrollWidth > l.clientWidth || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
  }).map((l) => l.textContent)`);
  await ctx.press('Escape');
  await ctx.until(`!document.querySelector('.context-menu')`, 'menu closed');
  return labels;
}
const pytestItems = (labels) => labels.filter((l) => /pytest/.test(l));
const filesChanged = (rel, kind) => js(`(ide.emit('filesChanged', { ${kind}: [${S(path.join(t.project, rel))}] }), true)`);

try {
  await until(`ide.root && !!document.querySelector('#tree .node')`, 'project tree');
  await t.sleep(1000);
  const offered = async (rel) => pytestItems(await menuOn(t, rel)).join(' | ');
  const both = (name) => `Run 'pytest in ${name}' | Debug 'pytest in ${name}'`;
  const expected = {
    '': both(project),
    tests: both('tests'),
    pkg: both('pkg'),
    'pkg\\sub': both('sub'),
    'tests\\test_calc.py': both('test_calc.py'),
    src: '',
    docs: '',
    'src\\calc.py': '',
  };
  const seen = {};
  for (const rel of Object.keys(expected)) seen[rel] = await offered(rel);
  const wrong = Object.keys(expected).filter((rel) => seen[rel] !== expected[rel]);
  check(!wrong.length, `the menu names the folder or file, and offers pytest only where there are tests${wrong.length ? `: ${wrong.map((r) => `${r || 'project'} -> ${S(seen[r])}`).join('; ')}` : ''}`);
  check(!Object.values(seen).some((l) => l.includes('…')), 'no label shows a literal "…"');

  writeFileSync(path.join(t.project, 'src', 'test_calc_src.py'), 'def test_src():\n    assert True\n');
  await filesChanged('src\\test_calc_src.py', 'created');
  await t.sleep(1500);
  check(await offered('src') === both('src'), 'a folder gets the entry once a test file is created in it');
  for (const rel of ['tests\\test_calc.py', 'pkg\\sub\\test_deep.py', 'src\\test_calc_src.py']) {
    rmSync(path.join(t.project, rel));
    await filesChanged(rel, 'deleted');
  }
  await t.sleep(1500);
  const none = { project: await offered(''), tests: await offered('tests'), src: await offered('src') };
  check(!none.project && !none.tests && !none.src, `with every test file deleted, the project and its folders offer no pytest run (${S(none)})`);

  writeFileSync(path.join(t.project, 'tests', 'test_calc.py'), 'def test_add():\n    assert 1 + 1 == 2\n');
  await filesChanged('tests\\test_calc.py', 'created');
  await t.sleep(1500);
  await js(`ide.revealInTree(${S(path.join(t.project, 'tests'))})`);
  const row = `[...document.querySelectorAll('#tree .node')].find((n) => n._entry.path.toLowerCase() === ${S(path.join(t.project, 'tests').toLowerCase())})`;
  await js(`(() => { const n = ${row}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((r) => r.querySelector('.menu-label')?.textContent === "Run 'pytest in tests'")`, 'pytest item');
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === "Run 'pytest in tests'").dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true`);
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'pytest in tests'`, 'pytest run tab', 20000);
  check(await js(`ide.run.activeSession()?.cfg.target === 'tests'`), 'choosing it runs pytest on that folder (tab "pytest in tests", target tests)');
  await press('Escape');
} catch (err) {
  check(false, err.message.split('\n')[0]);
  await t.shot('failure.png').catch(() => {});
}
const errors = [...t.consoleErrors];
t.close();

const k = await launch({ fixture: 'tests-tree-menu', port: 9107, name: 'tests-tree-menu-ko', lang: 'ko-KR' });
try {
  await k.until(`ide.root && !!document.querySelector('#tree .node')`, 'Korean project tree');
  await k.sleep(1000);
  const ko = pytestItems(await menuOn(k, 'tests')).concat(pytestItems(await menuOn(k, 'tests\\test_calc.py')));
  k.check(ko.join(' | ') === "'tests의 pytest' 실행 | 'tests의 pytest' 디버그 | 'test_calc.py의 pytest' 실행 | 'test_calc.py의 pytest' 디버그", `the entry in Korean (${ko.join(' | ')})`);
  await k.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await k.until(`Math.abs(innerWidth - 1008) <= 1 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await k.sleep(250);
  const small = pytestItems(await menuOn(k, 'pkg\\sub'));
  k.check(small.length === 2 && !menuCut.length, `at 1008x681 the entry shows whole inside the window (${small.join()}${menuCut.length ? `; cut: ${menuCut.join()}` : ''})`);
} catch (err) {
  k.check(false, err.message.split('\n')[0]);
}
k.results.unshift(...t.results);
k.consoleErrors.unshift(...errors);
k.finish();
