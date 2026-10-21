// Toggle Auto-test (tests plugin): saving a project .py file re-runs the test tab's last run. Ports 9150-9151.
// Uses the default interpreter's pytest, like verify/run-tools.mjs. The fixture's conftest.py logs each pytest session
// to runs.log and notes "overlap" if one starts while the previous one is still alive.
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'auto-test', port: 9150 });
const { js, until, check, press, click, sleep } = t;

const log = () => (existsSync(path.join(t.project, 'runs.log')) ? readFileSync(path.join(t.project, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')) : []);
const starts = () => log().filter((l) => l[0] === 'start');
const overlaps = () => log().filter((l) => l[0] === 'overlap').length;
const untilStarts = async (n, label, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (starts().length >= n) return true;
  throw new Error(`timeout waiting for: ${label} (${starts().length} runs)`);
};
const waitTests = (label, ms = 30000) => until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, label, ms);
const testStatus = () => js(`document.querySelector('.run-session:not(.hidden) .tr-status')?.textContent || ''`);
const P = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
const setText = (f, text) => js(`(ide.getDocument(${P(f)}).model.setValue(${S(text)}), true)`);
const save = (f) => js(`ide.saveTab(ide.findTab(${P(f)})).then(() => true)`);
const module = (body, delay = 0) => `DELAY = ${delay}\n\n\ndef add(a, b):\n    return ${body}\n`;
const toggle = () => js(`(() => { const b = document.querySelector('#bottomActions button[data-action="autoTest"]'); return b ? b.getAttribute('aria-pressed') : null; })()`);
const badge = () => js(`(() => { const b = document.querySelector('.run-tab.active .run-tab-autotest'); return !!b && !b.classList.contains('hidden') && b.textContent; })()`);

let failedFirst = false;
try {
  // ---------- first run, then the toggle ----------
  await openFile(t, 'test_mathlib.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await press('Ctrl+Shift+F10');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'pytest in test_mathlib.py'`, 'test tab');
  await waitTests('first run');
  check((await testStatus()).includes('Tests passed: 1 of 1 test'), `first run passes (${await testStatus()})`);
  check(starts().length === 1, `one run so far (${starts().length})`);
  check(await toggle() === 'false', 'the Run window toolbar has an Auto-test toggle, off by default');
  check(await js(`ide.actions.some((a) => a.id === 'ToggleAutoTest' && a.title === 'Toggle Auto-test')`), 'ToggleAutoTest is an action (Find Action)');
  check(!(await badge()), 'no Auto-test mark on the tab while it is off');

  // Off: a save runs nothing.
  await openFile(t, 'mathlib.py');
  await setText('mathlib.py', module('a + b  # off'));
  await save('mathlib.py');
  await sleep(2500);
  check(starts().length === 1, `with auto-test off a save runs nothing (${starts().length} runs)`);

  await click('#bottomActions button[data-action="autoTest"]');
  check(await toggle() === 'true', 'clicking the toggle turns it on (pressed state)');
  check(await js(`document.querySelector('#bottomActions button[data-action="autoTest"]').classList.contains('toggled')`), 'the toggle button is drawn pressed');
  check(await badge() === 'Auto-test', `the tab shows the Auto-test mark (${await badge()})`);

  // ---------- break, fix ----------
  await js(`(ide.editor.focus(), true)`);
  await setText('mathlib.py', module('a - b'));
  await press('Ctrl+S');
  await untilStarts(2, 'auto-test run after breaking the module');
  await waitTests('broken run');
  check((await testStatus()).includes('Tests failed: 1 of 1 test'), `saving a broken module re-runs the tests and shows the failure (${await testStatus()})`);
  check(await js(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-row')].some((r) => r.dataset.kind === 'test' && r.dataset.status === 'failed')`), 'the failed test is in the results tree');
  check(await js(`ide.activeTab()?.title === 'mathlib.py'`), 'the editor keeps the file being edited');

  await setText('mathlib.py', module('a + b'));
  await save('mathlib.py');
  await untilStarts(3, 'auto-test run after fixing the module');
  await waitTests('fixed run');
  check((await testStatus()).includes('Tests passed: 1 of 1 test'), `saving the fix re-runs the tests and they pass (${await testStatus()})`);

  // ---------- rapid saves: one run ----------
  await sleep(1500);
  const before = starts().length;
  for (let i = 0; i < 6; i++) {
    await setText('mathlib.py', module(`a + b  # edit ${i}`));
    await save('mathlib.py');
    await sleep(150);
  }
  await untilStarts(before + 1, 'run after rapid saves');
  await waitTests('rapid saves run');
  await sleep(2500);
  check(starts().length === before + 1, `six saves 150 ms apart cause one run (${starts().length - before})`);

  // ---------- idle auto save: one run, no storm ----------
  await js(`(ide.settings.set('autosave.idleSeconds', 1), true)`);
  const beforeIdle = starts().length;
  await setText('mathlib.py', module('a + b  # idle'));
  await untilStarts(beforeIdle + 1, 'run after the idle auto save');
  await waitTests('idle run');
  await sleep(4000);
  check(starts().length === beforeIdle + 1, `an idle auto save causes one run and idle saves without changes cause none (${starts().length - beforeIdle})`);
  check(readFileSync(path.join(t.project, 'mathlib.py'), 'utf8').includes('# idle'), 'the idle auto save wrote the module');
  await js(`(ide.settings.set('autosave.idleSeconds', 15), true)`);

  // ---------- a save during a run: stop it, run once more ----------
  const beforeSlow = starts().length;
  await setText('mathlib.py', module('a + b', 5));
  await save('mathlib.py');
  await untilStarts(beforeSlow + 1, 'slow run started');
  await sleep(500);
  check(await js(`document.querySelector('.run-session:not(.hidden) .tr-status').dataset.state === 'running'`), 'the slow run is in progress');
  await setText('mathlib.py', module('a + b', 0));
  await save('mathlib.py');
  await setText('mathlib.py', module('a + b  # again', 0));
  await save('mathlib.py');
  await untilStarts(beforeSlow + 2, 'run after the save during the slow run');
  await waitTests('run after the slow one');
  await sleep(2500);
  const slow = starts().slice(beforeSlow);
  check(slow.length === 2, `a save during a run gives exactly one more run (${slow.length})`);
  check(slow.length === 2 && Number(slow[1][2]) - Number(slow[0][2]) < 4.5, `the running tests were stopped instead of finishing first (${slow.length === 2 ? (Number(slow[1][2]) - Number(slow[0][2])).toFixed(1) : '?'} s apart)`);
  check((await testStatus()).includes('Tests passed: 1 of 1 test'), `the last run passes (${await testStatus()})`);
  check(overlaps() === 0, `runs never overlap (${overlaps()} overlaps)`);

  // ---------- debug session: no trigger ----------
  const beforeDebug = starts().length;
  await js(`(ide.emit('debugSessionChanged', true), true)`);
  await setText('mathlib.py', module('a + b  # debugging'));
  await save('mathlib.py');
  await sleep(2500);
  check(starts().length === beforeDebug, `saves during a debug session do not trigger (${starts().length - beforeDebug})`);
  await js(`(ide.emit('debugSessionChanged', false), true)`);

  // ---------- a save outside the project or of a non-Python file ----------
  await js(`ide.api.write(${P('notes.txt')}, 'x').then(() => ide.openFile(${P('notes.txt')}))`);
  await until(`ide.activeTab()?.title === 'notes.txt'`, 'notes tab');
  await setText('notes.txt', 'changed');
  await save('notes.txt');
  await sleep(2500);
  check(starts().length === beforeDebug, `saving a non-Python file does not trigger (${starts().length - beforeDebug})`);

  // ---------- off through Find Action, then closing the tab ----------
  await js(`(ide.runAction('ToggleAutoTest'), true)`);
  check(await toggle() === 'false' && !(await badge()), 'ToggleAutoTest turns it off: button released, mark gone');
  await openFile(t, 'mathlib.py');
  await setText('mathlib.py', module('a + b  # off again'));
  await save('mathlib.py');
  await sleep(2500);
  check(starts().length === beforeDebug, `toggled off, a save causes no run (${starts().length - beforeDebug})`);

  await js(`(ide.runAction('ToggleAutoTest'), true)`);
  check(await toggle() === 'true' && await badge() === 'Auto-test', 'ToggleAutoTest turns it on again');
  await click('.run-tab.active .run-tab-close');
  await until(`!document.querySelector('.run-tab')`, 'test tab closed');
  await setText('mathlib.py', module('a + b  # closed'));
  await save('mathlib.py');
  await sleep(2500);
  check(starts().length === beforeDebug, `after closing the tab a save causes no run (${starts().length - beforeDebug})`);
  check(overlaps() === 0, 'no overlapping runs at all');

  // ---------- another project: auto-test turns off and stays off there ----------
  await openFile(t, 'test_mathlib.py');
  await js(`(ide.run.runContext(ide.tests.configFor(ide.activeTab().path, null)), true)`);
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'pytest in test_mathlib.py'`, 'test tab again');
  await waitTests('run before the project switch');
  await js(`(ide.tests.autoTest.set(true), true)`);
  check(await js(`ide.tests.autoTest.enabled()`), 'auto-test is on again before the project switch');
  const beforeSwitch = starts().length;
  const other = mkdtempSync(path.join(tmpdir(), 'pyide-auto-test-other-'));
  cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'auto-test'), other, { recursive: true });
  const otherStarts = () => (existsSync(path.join(other, 'runs.log')) ? readFileSync(path.join(other, 'runs.log'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('start')).length : 0);
  await js(`ide.openProject(${S(other)}).then(() => true)`);
  await until(`ide.util.samePath(ide.root, ${S(other)})`, 'other project open');
  check(await js(`ide.run.sessions().length > 0 && ide.run.sessions().every((s) => !s.autoTest)`), 'opening another project turns auto-test off in every kept Run tab');
  check(await toggle() !== 'true' && !(await badge()), `the toggle and the tab mark show it off (${await toggle()})`);
  await openFile(t, 'mathlib.py');
  await setText('mathlib.py', module('a + b  # other project'));
  await save('mathlib.py');
  await sleep(2500);
  check(starts().length === beforeSwitch && otherStarts() === 0, `a save in the other project runs nothing (${starts().length - beforeSwitch} / ${otherStarts()})`);

  // ---------- an untrusted project never auto-runs ----------
  await js(`(ide.trusted = false, ide.tests.autoTest.set(true, ide.run.sessions()[0]), true)`);
  await setText('mathlib.py', module('a + b  # untrusted'));
  await save('mathlib.py');
  await sleep(2500);
  check(starts().length === beforeSwitch && otherStarts() === 0, `with ide.trusted === false a save runs nothing (${starts().length - beforeSwitch} / ${otherStarts()})`);
  await js(`(ide.tests.autoTest.set(false, ide.run.sessions()[0]), ide.trusted = true, true)`);

  // ---------- delay setting ----------
  await js(`(ide.openSettings('python-tests'), true)`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'python-tests'`, 'Python Integrated Tools page');
  check(await js(`document.querySelector('[data-key="tests.autoTestDelay"]')?.value === '1000'`), 'Auto-test delay defaults to 1000 ms in Settings');
  await js(`(document.querySelector('#settingsCancel').click(), true)`);

  // ---------- closing the project turns it off too ----------
  await js(`(ide.tests.autoTest.set(true, ide.run.sessions()[0]), true)`);
  await js(`ide.closeProject().then(() => true)`);
  await until(`!ide.root`, 'project closed');
  check(await js(`ide.run.sessions().every((s) => !s.autoTest)`), 'Close Project turns auto-test off');
} catch (err) {
  check(false, err.message);
}
failedFirst = t.results.some((r) => !r.ok) || t.consoleErrors.length > 0;
if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'auto-test', port: 9151, name: 'auto-test-ko', lang: 'ko-KR' });
try {
  await openFile(k, 'test_mathlib.py');
  await k.js(`(ide.run.runContext(ide.tests.configFor(ide.activeTab().path, null)), true)`);
  await k.until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, 'Korean run', 30000);
  await k.js(`(ide.tests.autoTest.set(true), true)`);
  k.check(await k.js(`document.querySelector('.run-tab.active .run-tab-autotest')?.textContent === '자동 테스트'`), 'the tab mark is Korean');
  k.check(await k.js(`document.querySelector('#bottomActions button[data-action="autoTest"]')?.title === '자동 테스트 전환'`), 'the toggle tooltip is Korean');
  await k.js(`(ide.openSettings('python-tests'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'python-tests'`, 'settings page (ko)');
  const leaks = await englishLeaks(k, '.settings-dialog');
  k.check(!leaks.length, `Python Integrated Tools page is Korean (${leaks.join(' | ')})`);
  await k.js(`(document.querySelector('#settingsCancel').click(), true)`);
  const missing = (await missingTranslations(k)).filter((s) => /auto-test|Auto-test|Testing|Integrated/i.test(s));
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
