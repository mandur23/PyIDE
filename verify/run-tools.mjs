// Run configurations, multiple run tabs, gutter run icons, test runner (pytest + unittest fallback), Python Console.
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'run-tools', port: 9405 });
const { js, until, press, type, click, shot, sleep } = t;
const check = (ok, label) => t.check(ok, process.env.DEBUG_ERRS ? `${label} [errors ${t.consoleErrors.length}]` : label);
const q = JSON.stringify;

const sessionTitles = () => js(`[...document.querySelectorAll('.run-tab-title')].map(n => n.textContent)`);
const activeOut = () => js(`document.querySelector('.run-session:not(.hidden) .console')?.textContent || ''`);
const menuItems = () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.textContent)`);
async function clickMenu(prefix) {
  const found = await js(`(() => { const n = [...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes(${q(prefix)})); n?.classList.add('pick-menu'); return !!n; })()`);
  if (!found) throw new Error(`menu item ${prefix} not found in ${JSON.stringify(await menuItems())}`);
  const onTop = await js(`(() => { const r = document.querySelector('.pick-menu').getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.pick-menu'); })()`);
  if (!onTop) throw new Error(`menu item ${prefix} is covered by another element`);
  await click('.context-menu .menu-item.pick-menu');
}
async function clickRcItem(name) {
  await js(`[...document.querySelectorAll('.rc-item')].find(n => n.textContent === ${q(name)}).classList.add('pick-me')`);
  await click('.rc-item.pick-me');
}
async function fill(key, value) {
  await click(`.rc-form [data-key="${key}"]`);
  await js(`document.querySelector('.rc-form [data-key="${key}"]').select()`);
  await type(value);
}
const gutterLines = () => js(`(() => {
  const ed = ide.editor, m = ed.getModel();
  return m.getAllDecorations().filter(d => (d.options.glyphMarginClassName || '').includes('run-gutter-icon')).map(d => d.range.startLineNumber);
})()`);
// Clicks the gutter icon on a line, like a user would.
async function clickGutter(line) {
  await js(`ide.editor.revealLineInCenter(${line})`);
  const find = `(() => {
    // An occluded test window gets no animation frames, so render Monaco's view synchronously.
    const ed = ide.editor; ed.render(true); const top = ed.getTopForLineNumber(${line}) - ed.getScrollTop();
    const host = document.querySelector('#editor').getBoundingClientRect();
    const n = [...document.querySelectorAll('#editor .run-gutter-icon')].find(i => Math.abs(i.getBoundingClientRect().top - host.top - top) < 4);
    if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
  await until(find, `gutter icon on line ${line}`, 5000);
  const box = await js(find);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(150);
}
const waitTests = (label, ms = 30000) => until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, label, ms);
const testStatus = () => js(`document.querySelector('.run-session:not(.hidden) .tr-status').textContent`);

try {
  // ---------- run widget defaults ----------
  check((await js(`document.querySelector('.run-target').textContent`)).includes('Current File'), 'run widget starts on Current File');

  // ---------- gutter icon on __main__ and temporary configuration ----------
  await openFile(t, 'app.py');
  await until(`ide.editor.getModel().getAllDecorations().some(d => (d.options.glyphMarginClassName || '').includes('run-gutter-icon'))`, 'gutter icon');
  check((await gutterLines()).join() === '14', `run icon on the if __name__ line (lines ${await gutterLines()})`);
  await clickGutter(14);
  const gm = await menuItems();
  check(gm.some((s) => s.includes("Run 'app'")), `gutter menu offers Run 'app' (${gm.join(' | ')})`);
  const hasDebug = await js(`ide.actions.some(a => a.id === 'DebugCurrent' || a.id === 'Debug')`);
  check(gm.some((s) => s.includes("Debug 'app'")) === hasDebug, `gutter menu shows Debug only when a debugger action exists (${hasDebug})`);
  await clickMenu("Run 'app'");
  check(!(await js(`document.querySelector('#editor .dbg-bp:not(.hover)')`)), 'clicking the run icon does not toggle a breakpoint');
  await until(`document.querySelector('#runOut')?.textContent.includes('Process finished with exit code 0')`, 'app.py finished');
  const appOut = await js(`document.querySelector('#runOut').textContent`);
  check(appOut.includes('sum: 5') && appOut.includes('env: <unset>') && appOut.includes('cwd: project'), 'gutter Run runs the script in its folder with the project on PYTHONPATH');
  check(await js(`ide.run.configs().some(c => c.name === 'app' && c.temporary)`), 'running from the gutter creates a temporary configuration');
  check((await js(`document.querySelector('.run-target-name').textContent`)) === 'app', 'temporary configuration becomes the selected one');

  // ---------- Edit Configurations: add a Python configuration with params/env ----------
  await click('.run-target');
  const tm = await menuItems();
  check(tm.some((s) => s.includes('app')) && tm.some((s) => s.includes('Current File')) && tm.some((s) => s.includes('Edit Configurations')), `run widget dropdown lists configs, Current File, Edit Configurations (${tm.join(' | ')})`);
  await clickMenu('Edit Configurations');
  await until(`!!document.querySelector('.rc-dialog')`, 'configurations dialog');
  await click('.rc-tool[title="Add New Configuration"]');
  await clickMenu('Python');
  await fill('name', 'App with args');
  await fill('script', 'app.py');
  await fill('params', '--fast "two words"');
  await fill('env', 'GREETING=hello');
  await shot('configurations.png');
  await click('.dialog-buttons .primary');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  check((await js(`document.querySelector('.run-target-name').textContent`)) === 'App with args', 'new configuration is selected after OK');
  await js(`ide.editor.focus()`);
  await press('Shift+F10');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'App with args' && document.querySelector('#runOut')?.textContent.includes('exit code')`, 'App with args run');
  const argsOut = await js(`document.querySelector('#runOut').textContent`);
  check(argsOut.includes('args: --fast two words'), 'script parameters are passed (quoted args kept together)');
  check(argsOut.includes('env: hello'), 'environment variables are passed');
  check((await sessionTitles()).join('|') === 'app|App with args', `each configuration gets its own Run tab (${await sessionTitles()})`);

  // duplicate + delete
  await click('.run-target');
  await clickMenu('Edit Configurations');
  await until(`!!document.querySelector('.rc-dialog')`, 'dialog again');
  await clickRcItem('App with args');
  await click('.rc-tool[title="Copy Configuration"]');
  check(await js(`[...document.querySelectorAll('.rc-item')].some(n => n.textContent === 'App with args (1)')`), 'Copy Configuration duplicates it');
  check((await js(`document.querySelector('.rc-form [data-key="params"]').value`)) === '--fast "two words"', 'duplicate keeps the fields');
  await click('.rc-tool[title="Remove Configuration"]');
  check(!(await js(`[...document.querySelectorAll('.rc-item')].some(n => n.textContent === 'App with args (1)')`)), 'Remove Configuration deletes it');
  await clickRcItem('App with args');
  await click('.dialog-buttons .primary');
  check(await js(`(() => { const s = ide.settings.get('runConfigs:' + ide.root); return s.configs.map(c => c.name).join('|') === 'app|App with args'; })()`), 'configurations are stored per project in ide.settings');

  // ---------- Alt+Shift+F10 chooser ----------
  await js(`ide.editor.focus()`);
  await press('Alt+Shift+F10');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'run chooser popup');
  const choices = await js(`[...document.querySelectorAll('#popupList .popup-item .label')].map(n => n.textContent)`);
  check(['App with args', 'app', 'Current File', 'Edit Configurations…'].every((c) => choices.includes(c)), `Alt+Shift+F10 lists configurations (${choices.join(' | ')})`);
  await type('Current');
  await until(`document.querySelector('.popup-item.active .label')?.textContent === 'Current File'`, 'Current File highlighted');
  await press('Enter');
  await until(`document.querySelectorAll('.run-tab').length === 3`, 'current file run tab');
  check((await js(`document.querySelector('.run-target-name').textContent`)) === 'Current File', 'choosing Current File selects it');

  // ---------- multiple runs, stop ----------
  await openFile(t, 'slow.py');
  await press('Shift+F10');
  await until(`document.querySelector('#runOut')?.textContent.includes('slow started')`, 'slow.py running');
  check(!(await js(`document.querySelector('.stop-btn').disabled`)), 'toolbar Stop is enabled while something runs');
  await press('Alt+Shift+F10');
  await type('App with args');
  await until(`document.querySelector('.popup-item.active .label')?.textContent === 'App with args'`, 'App with args highlighted');
  await press('Enter');
  await until(`document.querySelector('.run-tab.active .run-tab-title').textContent === 'App with args' && document.querySelector('#runOut').textContent.includes('exit code 0')`, 'parallel run done');
  check(await js(`ide.run.sessions().find(s => s.title === 'slow').running`), 'the other run keeps going in its own tab');
  await js(`[...document.querySelectorAll('.run-tab')].find(n => n.textContent.includes('slow')).classList.add('pick-tab')`);
  await click('.run-tab.pick-tab');
  await click('#bottomActions button[title="Stop"]');
  await until(`document.querySelector('#runOut').textContent.includes('Process finished with exit code')`, 'slow stopped');
  check(!(await js(`ide.run.sessions().some(s => s.running)`)), 'Stop ends the selected run');
  await shot('run-tabs.png');
  // Rerun while running replaces the process in the same tab; the stopped one's exit line stays out of the new console.
  await js(`ide.runAction('Rerun'), true`);
  await until(`document.querySelector('#runOut')?.textContent.includes('slow started') && ide.run.activeSession().running`, 'slow.py rerun');
  await js(`ide.runAction('Rerun'), true`);
  await until(`document.querySelector('#runOut')?.textContent.includes('slow started') && ide.run.activeSession().running`, 'slow.py rerun again');
  await sleep(1500);
  check(!(await js(`document.querySelector('#runOut').textContent.includes('Process finished')`)), 'the replaced process writes nothing into the new run console');
  await click('#bottomActions button[title="Stop"]');
  await until(`document.querySelector('#runOut').textContent.includes('Process finished with exit code')`, 'slow stopped again');

  // ---------- project tree "Run" creates a temporary configuration ----------
  await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('scratch.py')); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await clickMenu("Run '…'");
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'scratch' && document.querySelector('#runOut').textContent.includes('y is 1024')`, 'tree run');
  check(await js(`ide.run.configs().some(c => c.name === 'scratch' && c.temporary)`), 'Run from the project tree creates a temporary configuration');

  if (hasDebug) {
    await openFile(t, 'app.py');
    await clickGutter(14);
    await clickMenu("Debug 'app'");
    await until(`ide.toolWindows.get('Debug')?.isVisible()`, 'debugger started');
    check(true, "gutter Debug 'app' hands the script to the debugger");
    await sleep(3000);

    // Alt+Shift+F9 on a configuration debugs it with its parameters and environment
    await press('Alt+Shift+F9');
    await until(`document.activeElement?.id === 'popupIn'`, 'debug chooser');
    await type('App with args');
    await sleep(200);
    await press('Enter');
    await until(`document.querySelector('#dbgOut')?.textContent.includes('exit code')`, 'debugged configuration finished', 30000);
    const dbgOut = await js(`document.querySelector('#dbgOut').textContent`);
    check(dbgOut.includes('args: --fast two words') && dbgOut.includes('env: hello') && dbgOut.includes('sum: 5'), 'debugging a configuration passes its parameters, environment and PYTHONPATH');
  }

  // ---------- tests: gutter, Ctrl+Shift+F10 at caret ----------
  await openFile(t, 'test_calc.py');
  await until(`ide.editor.getModel().getAllDecorations().filter(d => (d.options.glyphMarginClassName || '').includes('run-gutter-icon')).length >= 6`, 'test gutter icons');
  check((await gutterLines()).sort((a, b) => a - b).join() === '6,10,16,20,21,24', `run icons on test functions, class, methods (${await gutterLines()})`);
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 22, column: 9 })`);
  await press('Ctrl+Shift+F10');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'pytest for test_calc.TestDiv.test_div'`, 'single test tab');
  await waitTests('single test done');
  check((await testStatus()).includes('Tests passed: 1 of 1 test'), `Ctrl+Shift+F10 in a test method runs just that test (${await testStatus()})`);

  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 1 })`);
  await press('Ctrl+Shift+F10');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'pytest in test_calc.py'`, 'file test tab');
  await waitTests('file tests done');
  const st = await testStatus();
  check(st.includes('Tests failed: 2, passed: 2, ignored: 1 of 5 tests'), `whole-file run counts (${st})`);
  const rows = await js(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-row')].map(r => r.dataset.kind + ':' + r.querySelector('.tr-name').textContent + ':' + r.dataset.status)`);
  check(['root:Test Results:failed', 'file:test_calc.py:failed', 'test:test_add:passed', 'test:test_add_wrong:failed', 'test:test_skipped:skipped', 'class:TestDiv:failed', 'test:test_div:passed', 'test:test_div_zero:failed'].every((r) => rows.includes(r)), `results tree files/classes/tests with status (${rows.join(', ')})`);
  check(await js(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-row[data-kind="test"] .tr-time')].length === 5`), 'each test shows a duration');
  check((await activeOut()).includes('assert 4 == 5') && (await activeOut()).includes('about to compare'), 'first failed test is selected with its failure and captured output');
  await js(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-row')].find(r => r.dataset.id.endsWith('test_div_zero')).classList.add('pick-row')`);
  await openFile(t, 'app.py');
  await click('.run-session:not(.hidden) .tr-row.pick-row');
  await until(`ide.activeTab()?.title === 'test_calc.py' && ide.editor.getPosition().lineNumber === 24`, 'navigated to test');
  check((await activeOut()).includes('ZeroDivisionError'), 'selecting a test shows its failure output');
  check(true, 'clicking a test navigates to it');
  await shot('test-results.png');
  check((await js(`ide.editor.getModel().getAllDecorations().map(d => d.options.glyphMarginClassName || '').filter(c => c.includes('run-gutter-icon')).map(c => c.split(' ')[1] || '-').join()`)) === 'passed,failed,-,failed,passed,failed'
    && await js(`!!document.querySelector('#editor .run-gutter-icon.failed')`), 'gutter icons show the last test results');

  await click('#bottomActions button[title="Rerun Failed Tests"]');
  await sleep(300);
  await waitTests('rerun failed done');
  check((await testStatus()).includes('Tests failed: 2 of 2 tests'), `Rerun Failed Tests runs only the failures (${await testStatus()})`);

  // Ctrl+Shift+F10 outside test files keeps the normal behavior.
  await openFile(t, 'calc.py');
  await press('Ctrl+Shift+F10');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'calc' && document.querySelector('#runOut').textContent.includes('exit code 0')`, 'calc run');
  check(true, 'Ctrl+Shift+F10 in a non-test file runs it as a Python script');

  // ---------- pytest configuration from the dialog ----------
  await click('.run-target');
  await clickMenu('Edit Configurations');
  await until(`!!document.querySelector('.rc-dialog')`, 'dialog for pytest');
  await click('.rc-tool[title="Add New Configuration"]');
  await clickMenu('pytest');
  await fill('name', 'units');
  await fill('target', 'test_units.py');
  await fill('args', '-q');
  await click('.dialog-buttons .primary');
  await press('Shift+F10');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'units'`, 'units tab');
  await waitTests('units done');
  check((await testStatus()).includes('Tests failed: 1, passed: 1, ignored: 1 of 3 tests'), `pytest configuration with extra args (${await testStatus()})`);
  check((await activeOut()).includes('2 != 3'), 'unittest-style failure shown');

  // project tree: a test file is offered as pytest, and the project folder runs every test
  // (a sixth temporary configuration pushes out the oldest)
  await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('test_units.py')); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  check(!(await menuItems()).some((m) => m.startsWith("Run '…'")) && (await menuItems()).some((m) => m.startsWith("Run 'pytest in …'")), 'test files are offered as pytest runs, not plain Python runs, in the tree');
  await click('#status');
  check(!(await js(`document.querySelector('.context-menu')`)), 'clicking elsewhere closes the tree menu');
  await js(`(() => { const n = document.querySelector('#tree .node'); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await clickMenu("Run 'pytest in …'");
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'pytest in project'`, 'tree pytest tab');
  await waitTests('tree pytest done');
  check((await testStatus()).includes('Tests failed: 3, passed: 3, ignored: 2 of 8 tests'), `Run 'pytest in project' from the project tree runs every test (${await testStatus()})`);
  check(await js(`ide.run.configs().filter(c => c.temporary).length === 5 && !ide.run.configs().some(c => c.name === 'app')`), 'at most five temporary configurations are kept');

  // ---------- unittest fallback without pytest ----------
  const venv = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-nopytest-')), 'nopytest');
  execFileSync('py', ['-3', '-m', 'venv', '--without-pip', venv]);
  const exe = path.join(venv, 'Scripts', 'python.exe');
  await js(`(ide.settings.set('interpreters.extra', [${q(exe)}]), ide.reloadInterpreters())`);
  await click('.run-target');
  await clickMenu('Edit Configurations');
  await until(`!!document.querySelector('.rc-dialog')`, 'dialog for interpreter');
  await clickRcItem('units');
  await js(`(() => { const s = document.querySelector('.rc-form [data-key="interp"]'); s.focus(); s.value = [...s.options].find(o => o.value.toLowerCase().includes('nopytest')).value; s.dispatchEvent(new Event('change')); })()`);
  await click('.dialog-buttons .primary');
  await press('Shift+F10');
  await sleep(300);
  await waitTests('unittest fallback done');
  check(await js(`!document.querySelector('.run-session:not(.hidden) .tr-hint').classList.contains('hidden') && document.querySelector('.run-session:not(.hidden) .tr-hint').textContent.includes('pip install pytest')`), 'missing pytest shows an install hint');
  check((await testStatus()).includes('Tests failed: 1, passed: 1, ignored: 1 of 3 tests'), `unittest fallback reports results (${await testStatus()})`);
  await shot('unittest-fallback.png');

  // ---------- Python Console ----------
  await press('Alt+8');
  await until(`ide.toolWindows.get('PythonConsole').isVisible() && document.querySelector('#pyconsoleOut').textContent.includes('Python 3')`, 'console started');
  await until(`ide.pyconsole.isRunning() && document.activeElement?.id === 'pyconsoleIn'`, 'console input focused');
  await type('x = 6 * 7');
  await press('Enter');
  await type('x');
  await press('Enter');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('>>> x\\n42')`, 'console evaluates');
  check(true, 'Python Console keeps state between inputs and echoes values');
  await type('for i in range(3):');
  await press('Enter');
  await until(`document.querySelector('#pyconsolePrompt').textContent === '... '`, 'continuation prompt');
  check((await js(`document.querySelector('#pyconsoleIn').value`)) === '    ', 'continuation line is indented after a colon');
  await type('print(i * 10)');
  await press('Enter');
  await press('Enter');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('0\\n10\\n20')`, 'block output');
  check((await js(`document.querySelector('#pyconsolePrompt').textContent`)) === '>>> ', 'multi-line block runs and prompt returns');
  await type('1/0');
  await press('Enter');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('ZeroDivisionError')`, 'traceback');
  check(true, 'errors are shown in the console');
  await press('ArrowUp');
  check((await js(`document.querySelector('#pyconsoleIn').value`)) === '1/0', 'Up recalls the previous input');
  await press('ArrowUp');
  await press('ArrowUp');
  await press('ArrowUp');
  check((await js(`document.querySelector('#pyconsoleIn').value`)) === 'x', 'Up walks further back in history');
  await press('ArrowDown');
  check((await js(`document.querySelector('#pyconsoleIn').value`)) === 'for i in range(3):', 'Down walks forward');
  await js(`document.querySelector('#pyconsoleIn').value = ''`);

  await openFile(t, 'calc.py');
  await js(`ide.editor.setSelection(ide.editor.getModel().getFullModelRange())`);
  await press('Alt+Shift+E');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('... def div(a, b):')`, 'selection sent');
  await sleep(300);
  await js(`document.querySelector('#pyconsoleIn').focus()`);
  await type('add(40, 2), div(9, 3)');
  await press('Enter');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('(42, 3.0)')`, 'selection executed');
  check(true, 'Alt+Shift+E executes the editor selection in the console');

  await openFile(t, 'scratch.py');
  await js(`ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  await press('Alt+Shift+E');
  check((await js(`ide.editor.getPosition().lineNumber`)) === 2, 'without a selection the current line runs and the caret moves down');
  await press('Alt+Shift+E');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('y is 1024')`, 'line by line');
  check(true, 'line-by-line execution keeps console state');
  await shot('python-console.png');
  // Rerun Python Console: the stopped interpreter's exit line stays out of the fresh console.
  await click('#bottomActions button[title="Rerun Python Console"]');
  await until(`ide.pyconsole.isRunning() && document.querySelector('#pyconsoleOut').textContent.includes('Python 3') && !document.querySelector('#pyconsoleOut').textContent.includes('y is 1024')`, 'console restarted');
  await sleep(1500);
  check(!(await js(`document.querySelector('#pyconsoleOut').textContent.includes('Process finished')`)), 'Rerun Python Console starts with a clean console');
  await press('Alt+8');
  check(!(await js(`ide.toolWindows.get('PythonConsole').isVisible()`)), 'Alt+8 hides the Python Console');

  // ---------- persistence ----------
  await js(`location.reload()`);
  await sleep(500);
  await until(`window.__ideReady === true && !!ide.root`, 'reloaded', 30000);
  await until(`document.querySelector('.run-target-name')?.textContent === 'units'`, 'restored selection');
  check(await js(`ide.run.configs().map(c => c.name).join('|') === 'App with args|scratch|pytest for test_calc.TestDiv.test_div|pytest in test_calc.py|calc|units|pytest in project'`), `configurations survive a restart (${await js(`ide.run.configs().map(c => c.name).join('|')`)})`);
} catch (err) {
  check(false, err.message);
  try { console.log('sessions:', await sessionTitles(), 'selected:', await js(`ide.run.selected()?.name`)); } catch {}
  await shot('failure.png');
}
t.finish();
