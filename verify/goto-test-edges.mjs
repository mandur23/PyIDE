// Edge cases of Create New Test (goto-test) and Comparison Failure (tests, compare): the import added to a test file
// whose imports span lines (parentheses, a backslash), test functions the file already has (unchecked, and refused
// when chosen), the module path from a Sources Root, a comparison the test caught that is not the failure, large
// values, and two strings that differ only in line separators. First the pytest plugin and pyide_test_diff on their
// own (no window), then the IDE on a project made here. Ports 9890-9891. Uses the default interpreter's pytest.
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile, tempDir } from './lib.mjs';

const S = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = path.join(HERE, '..', 'renderer', 'features', 'tests');
const write = (dir, files) => { for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); } };
const py = (args, opts = {}) => execFileSync('py', ['-3', ...args], { encoding: 'utf8', timeout: 120000, ...opts, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...opts.env } });

const pure = [];
const pureCheck = (ok, label) => { pure.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

// ---------- the helpers without the IDE ----------
for (const name of ['pyide_pytest_plugin.py', 'pyide_unittest_runner.py', 'pyide_test_diff.py']) {
  pureCheck(!readFileSync(path.join(HELPERS, name), 'latin1').includes('\r'), `${name} has LF line endings`);
}
{
  const dir = tempDir('goto-test-edges-pytest');
  write(dir, {
    'test_edges.py': [
      'import unittest',
      '',
      'BIG = list(range(1_000_000))',
      'BIG2 = list(range(1, 1_000_001))',
      '',
      '',
      'def check(a, b):',
      '    assert a == b',
      '',
      '',
      'def test_caught_then_lt():',
      '    try:',
      '        assert {"a": 1} == {"a": 2}',
      '    except AssertionError:',
      '        pass',
      '    assert 3 < 2',
      '',
      '',
      'def test_caught_then_assert_false():',
      '    try:',
      '        assert {"a": 1} == {"a": 2}',
      '    except AssertionError:',
      '        pass',
      '    assert False, "msg"',
      '',
      '',
      'def test_helper_wrapped():',
      '    try:',
      '        check({"a": 1}, {"a": 2})',
      '    except AssertionError:',
      '        raise AssertionError("wrapped")',
      '',
      '',
      'def test_helper_fails():',
      '    check([1, 2], [1, 3])',
      '',
      '',
      'def test_caught_then_other_eq():',
      '    try:',
      '        assert "x" == "y"',
      '    except AssertionError:',
      '        pass',
      '    assert [5] == [6]',
      '',
      '',
      'def test_multiline_message():',
      '    assert (',
      '        {"k": [1, 2]}',
      '        ==',
      '        {"k": [1, 3]}',
      '    ), "spread over lines"',
      '',
      '',
      'def test_big_caught():',
      '    for _ in range(5):',
      '        try:',
      '            assert BIG == BIG2',
      '        except AssertionError:',
      '            pass',
      '    assert False',
      '',
      '',
      'class TestUnit(unittest.TestCase):',
      '    def test_caught_then_equal(self):',
      '        try:',
      '            self.assertEqual([1], [2])',
      '        except AssertionError:',
      '            pass',
      '        self.assertEqual([3], [4])',
      '',
    ].join('\n'),
  });
  const report = path.join(dir, 'report.jsonl');
  try {
    py(['-m', 'pytest', '-p', 'pyide_pytest_plugin', '-q', '-p', 'no:cacheprovider', 'test_edges.py'], { cwd: dir, env: { PYIDE_TEST_REPORT: report, PYTHONPATH: HELPERS }, stdio: 'ignore' });
  } catch {}
  const events = existsSync(report) ? readFileSync(report, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const r = Object.fromEntries(events.filter((e) => e.e === 'result').map((e) => [e.id.split('::').slice(1).join('::'), e]));
  const d = (id) => r[id]?.diff;
  const failedWithout = (id) => r[id]?.outcome === 'failed' && !d(id);
  pureCheck(failedWithout('test_caught_then_lt'), `pytest: a caught == is not the diff of a later failed < (${S(d('test_caught_then_lt'))})`);
  pureCheck(failedWithout('test_caught_then_assert_false'), `pytest: nor of a later assert False, "msg" (${S(d('test_caught_then_assert_false'))})`);
  pureCheck(failedWithout('test_helper_wrapped'), `pytest: nor of an AssertionError raised in its place (${S(d('test_helper_wrapped'))})`);
  pureCheck(S(d('test_helper_fails')) === S({ expected: '[1, 3]', actual: '[1, 2]' }), `pytest: a helper's failed == is the diff (${S(d('test_helper_fails'))})`);
  pureCheck(S(d('test_caught_then_other_eq')) === S({ expected: '[6]', actual: '[5]' }), `pytest: after a caught ==, the == that fails is the diff (${S(d('test_caught_then_other_eq'))})`);
  pureCheck(S(d('test_multiline_message')) === S({ expected: "{'k': [1, 3]}", actual: "{'k': [1, 2]}" }), `pytest: an assert over several lines with a message has the diff (${S(d('test_multiline_message'))})`);
  pureCheck(S(d('TestUnit::test_caught_then_equal')) === S({ expected: '[4]', actual: '[3]' }), `pytest: the assertEqual that fails is the diff, not a caught one (${S(d('TestUnit::test_caught_then_equal'))})`);
  pureCheck(failedWithout('test_big_caught') && r.test_big_caught.duration < 3, `pytest: five caught == on 1,000,000-element lists cost no formatting (${r.test_big_caught?.duration?.toFixed(2)} s)`);
  rmSync(dir, { recursive: true, force: true });
}
{
  const out = JSON.parse(py(['-c', [
    'import json, pprint, time, pyide_test_diff as d',
    'a, b = list(range(3_000_000)), list(range(1, 3_000_001))',
    't = time.perf_counter(); p = d.pair(a, b); big = time.perf_counter() - t',
    'small = list(range(100_000))',
    'full = pprint.pformat(small, width=80)',
    'q = d.pair(small, small)',
    'n = [list(range(1000)) for _ in range(1000)]',
    't = time.perf_counter(); r = d.pair(n, n); nested = time.perf_counter() - t',
    'print(json.dumps({"big": big, "len": len(p["actual"]), "head": p["expected"][:12], "same": q["actual"] == full[:d.LIMIT] + "\\n...", "nested": nested, "nlen": len(r["actual"])}))',
  ].join('\n')], { env: { PYTHONPATH: HELPERS } }));
  pureCheck(out.big < 2 && out.len === 200004 && out.head === '[1,\n 2,\n 3,\n', `pair() of two 3,000,000-element lists is bounded (${out.big.toFixed(2)} s, ${out.len} characters)`);
  pureCheck(out.same, 'what pair() shows of a long list equals the start of its full pprint');
  pureCheck(out.nested < 2 && out.nlen === 200004, `pair() of nested lists of 1,000,000 elements is bounded (${out.nested.toFixed(2)} s)`);
}

// ---------- the IDE ----------
const project = path.join(tempDir('goto-test-edges'), 'project');
write(project, {
  'shapes/__init__.py': '',
  'shapes/util.py': 'def clamp(x):\n    return x\n\n\ndef lerp(a, b, t):\n    return a + (b - a) * t\n\n\ndef _private():\n    pass\n',
  'shapes/geo.py': 'def area(w, h):\n    return w * h\n',
  'tests/test_util.py': 'import pytest\nfrom shapes.util import (\n    clamp,\n)\n\n\ndef test_clamp():\n    assert clamp(1) == 1\n',
  'tests/test_geo.py': 'import os, \\\n    sys\n\n\ndef test_env():\n    assert os and sys\n',
  'lib2/helper_mod.py': 'def helper():\n    return 1\n',
  'lib2/sub/deep.py': 'def deep():\n    return 2\n',
  'tests/test_seps.py': 'def test_crlf():\n    assert "line one\\r\\nline two\\r\\n" == "line one\\nline two\\n"\n',
});
const t = await launch({ name: 'goto-test-edges', port: 9890, projectDir: project });
const { js, until, check, sleep } = t;
const P = (rel) => `ide.util.joinPath(ide.root, ${S(rel.replace(/\//g, '\\'))})`;
const read = (rel) => readFileSync(path.join(project, rel), 'utf8').replace(/\r\n/g, '\n');
const compiles = (rel) => { try { py(['-m', 'py_compile', path.join(project, rel)], { stdio: 'pipe' }); return true; } catch (e) { return String(e.stderr || e.message).trim().split('\n').pop(); } };
const collected = (rel) => { try { return py(['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider', rel], { cwd: project, stdio: 'pipe' }).split(/\r?\n/).filter((l) => l.includes('::')); } catch (e) { return String(e.stdout || e.message).split('\n').slice(-3); } };
const openCreate = async (rel) => {
  await js(`(ide.gotoTest.create(${P(rel)}, null), true)`);
  await until(`!!document.querySelector('.dialog .gt-create')`, `Create Test for ${rel}`, 10000);
};
const checks = () => js(`[...document.querySelectorAll('.dialog .gt-check')].map((c) => (c.querySelector('input').checked ? '+' : '-') + c.textContent)`);
const pressOk = () => js(`(document.querySelector('.dialog .gt-create').closest('.dialog').querySelector('.dialog-buttons .primary').click(), true)`);
const closed = () => until(`!document.querySelector('.dialog')`, 'dialog closed', 10000).then(() => true, () => false);

try {
  // ---------- a parenthesized import; a test function the file has ----------
  await openFile(t, 'shapes/util.py');
  await openCreate('shapes/util.py');
  check(S(await checks()) === S(['-test_clamp', '+test_lerp', '-test_private']), `test_clamp, which tests/test_util.py has, starts unchecked (${S(await checks())})`);
  await pressOk();
  check(await closed(), 'OK writes the test');
  await sleep(300);
  let text = read('tests/test_util.py');
  check(text === 'import pytest\nfrom shapes.util import (\n    clamp,\n)\nfrom shapes.util import lerp\n\n\ndef test_clamp():\n    assert clamp(1) == 1\n\n\ndef test_lerp():\n    assert False\n',
    `the import goes after the closing parenthesis and test_clamp is not written again (${S(text)})`);
  check(compiles('tests/test_util.py') === true, `the test file compiles (${compiles('tests/test_util.py')})`);
  check(S(collected('tests/test_util.py')) === S(['tests/test_util.py::test_clamp', 'tests/test_util.py::test_lerp']), `pytest collects the user's test_clamp and the new test_lerp (${S(collected('tests/test_util.py'))})`);

  await openCreate('shapes/util.py');
  await js(`(() => { for (const c of document.querySelectorAll('.dialog .gt-check input')) c.checked = c.value === 'clamp'; return true; })()`);
  await pressOk();
  await sleep(300);
  check(await js(`[...document.querySelectorAll('.dialog-message')].some((m) => m.textContent.includes('test_clamp already exists in test_util.py'))`), 'choosing a test function the file has is refused with a message');
  check(read('tests/test_util.py') === text, 'and the file is unchanged');
  await js(`(() => { for (const d of [...document.querySelectorAll('.dialog')].reverse()) d.querySelector('.dialog-buttons button:last-child')?.click(); return true; })()`);
  await closed();

  // ---------- a backslash continuation ----------
  await openCreate('shapes/geo.py');
  await pressOk();
  check(await closed(), 'OK writes the geo test');
  await sleep(300);
  text = read('tests/test_geo.py');
  check(text.startsWith('import os, \\\n    sys\nfrom shapes.geo import area\n'), `the import goes after a backslash continuation (${S(text)})`);
  check(compiles('tests/test_geo.py') === true, `that file compiles too (${compiles('tests/test_geo.py')})`);

  // ---------- the module path from a Sources Root ----------
  const moduleOf = (rel) => js(`ide.gotoTest.moduleOf(${P(rel)})`);
  check(await moduleOf('lib2/helper_mod.py') === 'lib2.helper_mod', 'with no root marked, a folder without __init__.py is part of the path');
  await js(`ide.projectRoots.mark(${P('lib2')}, 'sources')`);
  await until(`ide.projectRoots.sourceRoots().length === 1`, 'lib2 marked', 5000).catch(() => {});
  check(await moduleOf('lib2/helper_mod.py') === 'helper_mod', `a module in a Sources Root is imported from the root (${await moduleOf('lib2/helper_mod.py')})`);
  check(await moduleOf('lib2/sub/deep.py') === 'sub.deep', `a namespace folder below the root stays in the path (${await moduleOf('lib2/sub/deep.py')})`);
  check(await moduleOf('shapes/util.py') === 'shapes.util', `a module outside the roots goes from the project root (${await moduleOf('shapes/util.py')})`);
  await openCreate('lib2/helper_mod.py');
  await pressOk();
  await closed();
  await sleep(300);
  check(read('tests/test_helper_mod.py').startsWith('from helper_mod import helper\n'), `Create Test writes that import (${S(read('tests/test_helper_mod.py').split('\n')[0])})`);

  // ---------- strings that differ only in line separators ----------
  await js(`(ide.run.runConfig({ type: 'pytest', name: 'seps', target: 'tests/test_seps.py' }, { confirm: false }), true)`);
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'seps'`, 'seps tab', 20000);
  await until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state && s.dataset.state !== 'running'; })()`, 'seps ran', 60000);
  await until(`!!document.querySelector('.run-session:not(.hidden) .tr-row[data-id="tests/test_seps.py::test_crlf"]')`, 'seps row');
  await js(`document.querySelector('.run-session:not(.hidden) .tr-row[data-id="tests/test_seps.py::test_crlf"]').click()`);
  await until(`!!document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a')`, 'diff link', 10000).catch(() => {});
  await js(`(document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a').click(), true)`);
  await until(`(() => { const t = ide.activeTab(); const v = t && ide.compare.view(t); return v && v.ready(); })()`, 'diff tab', 15000).catch(() => {});
  const tab = await js(`(() => { const t = ide.activeTab(); return { title: t.title, count: t.host.querySelector('.cmp-count')?.textContent, differences: t.host.dataset.differences }; })()`);
  check(tab.title === 'Comparison Failure (test_crlf)' && tab.count === 'Contents have differences only in line separators', `the compare tab says the contents differ only in line separators (${S(tab)})`);
  await js(`(ide.closeTab(ide.activeTab().path), true)`);

  await js(`(window.__compare = ide.compare, ide.compare = undefined, true)`);
  await js(`(document.querySelector('.run-session:not(.hidden) .console .tr-diff-line a').click(), true)`);
  await until(`(() => { const d = document.querySelector('.dialog .tr-diff'); return d && d.dataset.differences; })()`, 'diff dialog', 15000).catch(() => {});
  check(await js(`document.querySelector('.dialog .tr-diff-count')?.textContent`) === 'Contents have differences only in line separators', 'so does the dialog used without the compare plugin');
  await js(`(document.querySelector('.dialog .dialog-buttons .primary').click(), ide.compare = window.__compare, true)`);
  await closed();

  for (const p of pure) check(p.ok, `(no window) ${p.label}`);
} catch (err) {
  check(false, `suite error: ${err.message}`);
}
t.finish();
