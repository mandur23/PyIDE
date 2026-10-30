// Debugging tests (pytest under debugpy from the gutter, Shift+F9, the project tree, Rerun and Rerun Failed Tests, with
// the results in the debug session's Test Results sub-tab of the Debug window), the Python configuration's "Run: Script
// path / Module name" switch, and the "Process 'x' Is Running" question before a rerun, in English, at 1008x681 and in
// Korean. Ports 9053-9054.
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;

function helpers(t) {
  const { js, until, click, cdp, sleep } = t;
  const menuLabels = () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map((n) => n.textContent)`);
  async function clickMenu(text) {
    const found = await js(`(() => { const n = [...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.textContent.includes(${S(text)})); n?.classList.add('pick-menu'); return !!n; })()`);
    if (!found) throw new Error(`menu item ${text} not found in ${S(await menuLabels())}`);
    await click('.context-menu .menu-item.pick-menu');
  }
  async function clickRunGutter(line) {
    await js(`ide.editor.revealLineInCenter(${line})`);
    const find = `(() => {
      const ed = ide.editor; ed.render(true); const top = ed.getTopForLineNumber(${line}) - ed.getScrollTop();
      const host = document.querySelector('#editor').getBoundingClientRect();
      const n = [...document.querySelectorAll('#editor .run-gutter-icon')].find((i) => Math.abs(i.getBoundingClientRect().top - host.top - top) < 4);
      if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`;
    await until(find, `run icon on line ${line}`, 10000);
    const box = await js(find);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await until(`!!document.querySelector('.context-menu')`, 'gutter menu');
  }
  async function treeMenu(rel) {
    const target = path.join(t.project, rel);
    await js(`ide.revealInTree(${S(target)})`);
    const row = `[...document.querySelectorAll('#tree .node')].find((n) => n._entry.path.toLowerCase() === ${S(target.toLowerCase())})`;
    await until(`!!${row}`, `tree row ${rel}`);
    await js(`(() => { const n = ${row}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
    await until(`!!document.querySelector('.context-menu .menu-label')`, `menu on ${rel}`);
    return js(`[...document.querySelectorAll('.context-menu .menu-label')].map((l) => l.textContent)`);
  }
  const caretTo = (line) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 1 }), true)`);
  const stoppedAt = (file, line, ms = 30000) => until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx];
    return !!f && f.path?.toLowerCase().endsWith(${S(file)}) && f.line === ${line}; })()`, `suspended at ${file}:${line}`, ms);
  const where = () => js(`(() => { const s = window.__debugger.state(); const f = s?.frames[s.frameIdx]; return s ? s.state + ' ' + (f ? f.path + ':' + f.line : '') : 'no session'; })()`);
  // The Test Results sub-tab of the debug session in the Debug window.
  const debugTab = () => js(`(() => { const b = document.querySelector('.dbg-bar .dbg-plugin-tab[data-tab="testResults"]'); const p = document.querySelector('.dbg-plugin-pane[data-tab="testResults"]');
    if (!b || !p) return null; const st = p.querySelector('.tr-status');
    return { label: b.textContent, icon: b.querySelector('.dbg-subtab-icon .ide-icon')?.dataset.iconName, active: b.classList.contains('active'), shown: !!p.offsetParent,
      state: st?.dataset.state || null, status: st?.textContent || '', files: [...p.querySelectorAll('.tr-row[data-kind="file"] .tr-name')].map((r) => r.textContent) }; })()`);
  const resultsDone = (label, ms = 30000) => until(`(() => { const st = document.querySelector('.dbg-plugin-pane[data-tab="testResults"] .tr-status');
    return st && st.dataset.state !== 'running' && !window.__debugger.state(); })()`, `debug results of ${label}`, ms);
  const noRunTab = () => js(`!ide.run.sessions().some((s) => s.key.startsWith('debug:') || s.tab.classList.contains('run-tab-debug'))`);
  const dialogTitle = () => js(`[...document.querySelectorAll('#dialogHost .dialog-title')].pop()?.textContent || null`);
  return { menuLabels, clickMenu, clickRunGutter, treeMenu, caretTo, stoppedAt, where, debugTab, resultsDone, noRunTab, dialogTitle, sleep };
}

const t = await launch({ fixture: 'tests-debug-run', port: 9053 });
const { js, until, press, click, check, sleep } = t;
const h = helpers(t);

try {
  await until(`ide.root && !!document.querySelector('#tree .node')`, 'project tree');
  // ---------- breakpoints in a test and in the code under test ----------
  await openFile(t, 'calc.py');
  await h.caretTo(2);
  await press('Ctrl+F8');
  await openFile(t, 'test_calc.py');
  await h.caretTo(5);
  await press('Ctrl+F8');
  check(await js(`window.__debugger.breakpoints().map((b) => b.path.split(/[\\\\/]/).pop() + ':' + b.line).sort().join() === 'calc.py:2,test_calc.py:5'`), 'breakpoints set with Ctrl+F8 in the test and in calc.py');

  // ---------- gutter: Debug 'pytest for test_calc.test_add' ----------
  await until(`ide.editor.getModel().getAllDecorations().filter((d) => (d.options.glyphMarginClassName || '').includes('run-gutter-icon')).length === 2`, 'run icons on both tests');
  await h.clickRunGutter(4);
  const gutterMenu = await h.menuLabels();
  check(gutterMenu.some((l) => l.includes("Debug 'pytest for test_calc.test_add'")), `the test's gutter menu offers Debug (${gutterMenu.join(' | ')})`);
  await h.clickMenu("Debug 'pytest for test_calc.test_add'");
  await h.stoppedAt('test_calc.py', 5);
  check(true, 'Debug from the gutter pauses on the breakpoint inside the test');
  const running = await h.debugTab();
  check(running?.state === 'running' && running.label.includes('Test Results') && running.icon === 'runRun',
    `the debug session has a Test Results sub-tab in the Debug window while the test runs (${S(running)})`);
  check(await h.noRunTab(), 'a debug test run opens no tab in the Run window');
  check(await js(`!!document.querySelector('.dbg-plugin-pane[data-tab="testResults"] .tr-debug-btn[data-action="rerunFailed"]')?.disabled`), 'Rerun Failed Tests is off while nothing has failed');
  await press('F9');
  await h.stoppedAt('calc.py', 2);
  check(await js(`window.__debugger.state().frames.some((f) => f.name === 'test_add')`), 'Resume runs on to the breakpoint in the code under test, called from the test');
  await press('F9');
  await h.resultsDone('pytest for test_calc.test_add');
  const one = await h.debugTab();
  check(one.status.includes('Tests passed: 1 of 1 test') && one.icon === 'testPassed', `Resume finishes with the result in the Test Results sub-tab (${S(one)})`);
  check(one.active && await js(`!!document.querySelector('.dbg-plugin-pane[data-tab="testResults"] .tr-row[data-kind="test"][data-status="passed"]')?.offsetParent && ide.toolWindows.get('Debug').isVisible()`),
    'when the session ends the Debug window shows the Test Results with the passed test');
  check(await js(`ide.run.configs().some((c) => c.name === 'pytest for test_calc.test_add' && c.temporary)`), 'the gutter Debug creates the temporary configuration');

  // ---------- Shift+F9 on the test file ----------
  await js(`(ide.run.select('__current'), true)`);
  await openFile(t, 'test_calc.py');
  await h.caretTo(1);
  await press('Shift+F9');
  await h.stoppedAt('test_calc.py', 5);
  check(await js(`document.querySelector('#dbgTabVars').classList.contains('active') && document.querySelectorAll('.dbg-bar .dbg-plugin-tab').length === 1`),
    'a breakpoint shows Threads & Variables; the new session has its own single Test Results sub-tab');
  await press('F9');
  await h.stoppedAt('calc.py', 2);
  await press('F9');
  await h.stoppedAt('calc.py', 2);
  check(await js(`window.__debugger.state().frames.some((f) => f.name === 'test_wrong')`), 'the second test stops in calc.py too');
  await press('F9');
  await h.resultsDone('pytest in test_calc.py');
  const file = await h.debugTab();
  check(file.status.includes('Tests failed: 1, passed: 1 of 2 tests') && file.files.join() === 'test_calc.py' && file.icon === 'testFailed',
    `Shift+F9 on a test file debugs pytest on the file: both tests ran under the debugger (${S(file)})`);
  await openFile(t, 'test_calc.py');
  await until(`ide.editor.getModel().getAllDecorations().some((d) => /run-gutter-icon failed/.test(d.options.glyphMarginClassName || ''))`, 'failed gutter icon', 5000).catch(() => {});
  check(await js(`ide.findTab(${S(path.join(t.project, 'test_calc.py'))}).model.getAllDecorations().some((d) => /run-gutter-icon failed/.test(d.options.glyphMarginClassName || ''))`), 'the gutter shows the failed test from the debug run');
  check(await h.noRunTab(), 'still no Run window tab for debug runs');

  // ---------- Rerun from the Debug window, Stop ----------
  check(await js(`!!document.querySelector('#dbgRerun')?.offsetParent && !document.querySelector('#dbgRerun').disabled`), 'the finished debug run stays in the Debug window with its Rerun');
  await click('#dbgRerun');
  await h.stoppedAt('test_calc.py', 5);
  check(true, "the Debug window's Rerun debugs the tests again");
  await press('Ctrl+F2');
  await until(`!window.__debugger.state()`, 'debug session stopped');
  await h.resultsDone('pytest in test_calc.py');
  const stoppedTab = await h.debugTab();
  check(stoppedTab.state === 'stopped' && stoppedTab.status.includes('Stopped.') && stoppedTab.icon === 'testTerminated',
    `Stop ends the Test Results run too, shown as stopped, not passed (${S(stoppedTab)})`);

  // ---------- another debug session replaces a debug test run ----------
  await click('#dbgRerun');
  await h.stoppedAt('test_calc.py', 5);
  await js(`(ide.debugger.debugFile(${S(path.join(t.project, 'slow.py'))}), true)`);
  await until(`document.querySelector('#dbgOut')?.textContent.includes('tick 2')`, 'slow.py debugged');
  check(await js(`!document.querySelector('.dbg-plugin-tab') && !document.querySelector('.dbg-plugin-pane')`), "debugging another file ends the test session and its Test Results sub-tab goes with it");
  check(await js(`!!document.querySelector('#dbgOut')?.offsetParent && window.__debugger.state()?.state === 'running'`), 'and the Debug window stays on the new session');
  await press('Ctrl+F2');
  await until(`!window.__debugger.state()`, 'slow.py debug stopped');
  await sleep(1000);
  check(await js(`!document.querySelector('.dbg-plugin-tab') && !!document.querySelector('#dbgOut')?.offsetParent`), 'ending the new session brings no Test Results back over it');

  // ---------- Debug again, then Rerun Failed Tests in the sub-tab ----------
  await openFile(t, 'test_calc.py');
  await h.caretTo(1);
  await press('Shift+F9');
  await h.stoppedAt('test_calc.py', 5);
  for (const [f, l] of [['calc.py', 2], ['calc.py', 2]]) { await press('F9'); await h.stoppedAt(f, l); }
  await press('F9');
  await h.resultsDone('pytest in test_calc.py');
  check((await h.debugTab()).status.includes('Tests failed: 1, passed: 1 of 2 tests'), 'debugging the file again gives both results again');
  await click('.dbg-plugin-pane[data-tab="testResults"] .tr-debug-btn[data-action="rerunFailed"]');
  await h.stoppedAt('calc.py', 2);
  check(await js(`window.__debugger.state().frames.some((f) => f.name === 'test_wrong') && !window.__debugger.state().frames.some((f) => f.name === 'test_add')`), "the sub-tab's Rerun Failed Tests debugs only the failed test");
  await press('F9');
  await h.resultsDone('pytest in test_calc.py');
  check((await h.debugTab()).status.includes('Tests failed: 1 of 1 test'), `the failed test alone (${(await h.debugTab()).status})`);
  await click('#dbgRerun');
  await h.stoppedAt('calc.py', 2);
  check(await js(`!window.__debugger.state().frames.some((f) => f.name === 'test_add')`), "the Debug window's Rerun after Rerun Failed Tests debugs the failed test again");
  await press('F9');
  await h.resultsDone('pytest in test_calc.py');

  // ---------- project tree: Debug 'pytest in test_calc.py' ----------
  const treeLabels = await h.treeMenu('test_calc.py');
  check(treeLabels.includes("Run 'pytest in test_calc.py'") && treeLabels.includes("Debug 'pytest in test_calc.py'"), `the tree offers Run and Debug 'pytest in test_calc.py' (${treeLabels.filter((l) => /pytest/.test(l)).join(' | ')})`);
  await h.clickMenu("Debug 'pytest in test_calc.py'");
  await h.stoppedAt('test_calc.py', 5);
  check(true, "the tree's Debug 'pytest in …' pauses in the test");
  // Without breakpoints the run goes through.
  for (const f of ['calc.py', 'test_calc.py']) {
    await openFile(t, f);
    await h.caretTo(f === 'calc.py' ? 2 : 5);
    await press('Ctrl+F8');
  }
  check(await js(`window.__debugger.breakpoints().length === 0`), 'breakpoints removed');
  await press('F9');
  await h.resultsDone('pytest in test_calc.py');
  check((await h.debugTab()).status.includes('Tests failed: 1, passed: 1 of 2 tests'), 'with the breakpoints removed, Resume runs both tests to the end');
  check(await js(`ide.run.selected()?.name === 'pytest in test_calc.py' && ide.run.selected().temporary && ide.run.selected().target === 'test_calc.py'`), 'the tree debugs a temporary configuration for the file and selects it');

  // ---------- Python configuration: Run: Module name ----------
  await js(`(ide.run.editConfigurations(), true)`);
  await until(`!!document.querySelector('.rc-dialog')`, 'configurations dialog');
  await click('.rc-tool[data-tool="add"]');
  await h.clickMenu('Python');
  await js(`(() => { const n = document.querySelector('.rc-form [data-key="name"]'); n.focus(); n.select(); })()`);
  await t.type('hello module');
  check(await js(`!!document.querySelector('.rc-form [data-key="script"]') && !document.querySelector('.rc-form [data-key="module"]')`), 'a new Python configuration starts on Script path');
  const runOptions = await js(`[...document.querySelector('.rc-form select[data-key="runMode"]').options].map((o) => o.textContent).join('|')`);
  check(runOptions === 'Script path|Module name', `the Run: switch offers Script path and Module name (${runOptions})`);
  await js(`(() => { const s = document.querySelector('.rc-form select[data-key="runMode"]'); s.focus(); })()`);
  await press('ArrowDown');
  await until(`!!document.querySelector('.rc-form [data-key="module"]')`, 'module field');
  check(await js(`!document.querySelector('.rc-form [data-key="script"]') && document.querySelector('.rc-form [data-key="cwd"]').placeholder === 'Defaults to the project root'`), 'Module name replaces the script field; the working directory defaults to the project root');
  await click('.rc-form [data-key="module"]');
  await t.type('pkg.hello');
  await click('.rc-form [data-key="params"]');
  await t.type('one "two words"');
  await click('.dialog-buttons .primary');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog closed');
  const saved = await js(`ide.settings.get('runConfigs:' + ide.root).configs.find((c) => c.name === 'hello module')`);
  check(saved?.runMode === 'module' && saved.module === 'pkg.hello', `the configuration stores runMode and module (${S({ runMode: saved?.runMode, module: saved?.module })})`);
  await js(`ide.editor.focus()`);
  await press('Shift+F10');
  await until(`ide.run.activeSession()?.title === 'hello module' && document.querySelector('#runOut')?.textContent.includes('Process finished')`, 'module run finished');
  const modOut = await js(`document.querySelector('#runOut').textContent`);
  check(/ -m pkg\.hello one "two words"\n/.test(modOut), `the command line runs python -m pkg.hello (${modOut.split('\n')[0].slice(-60)})`);
  check(modOut.includes('module: __main__ package: pkg') && modOut.includes('cwd: project') && modOut.includes('argv: one two words') && modOut.includes('exit code 0'),
    `the module runs as __main__ of its package in the project root with its parameters (${S(modOut.slice(0, 300))})`);
  // Debugging the module configuration (Alt+Shift+F9 chooser) stops in the module.
  await openFile(t, 'pkg\\hello.py');
  await h.caretTo(5);
  await press('Ctrl+F8');
  await js(`ide.editor.focus()`);
  await press('Alt+Shift+F9');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'debug chooser');
  await t.type('hello module');
  await until(`document.querySelector('.popup-item.active .label')?.textContent === 'hello module'`, 'module configuration highlighted');
  await press('Enter');
  await h.stoppedAt('hello.py', 5);
  check(await js(`window.__debugger.state().frames[0].name === '<module>'`), 'debugging a Module name configuration stops in the module');
  await press('F9');
  await until(`!window.__debugger.state()`, 'module debug finished');
  await h.caretTo(5);
  await press('Ctrl+F8');
  // An empty module name is reported.
  await js(`(ide.run.editConfigurations(), true)`);
  await until(`!!document.querySelector('.rc-dialog')`, 'dialog');
  await js(`[...document.querySelectorAll('.rc-item')].find((n) => n.textContent === 'hello module').click()`);
  await js(`(() => { const n = document.querySelector('.rc-form [data-key="module"]'); n.value = ''; n.dispatchEvent(new Event('input')); })()`);
  await click('.dialog-buttons .primary');
  await js(`ide.editor.focus()`);
  await press('Shift+F10');
  await until(`document.querySelector('#runOut')?.textContent.includes('Module name is not specified')`, 'missing module message');
  check(true, 'a Module name configuration without a module says so');
  // Back to Script path: the script field returns.
  await js(`(ide.run.editConfigurations(), true)`);
  await until(`!!document.querySelector('.rc-dialog')`, 'dialog');
  await js(`[...document.querySelectorAll('.rc-item')].find((n) => n.textContent === 'hello module').click()`);
  await js(`(() => { const s = document.querySelector('.rc-form select[data-key="runMode"]'); s.focus(); })()`);
  await press('ArrowUp');
  await until(`!!document.querySelector('.rc-form [data-key="script"]') && !document.querySelector('.rc-form [data-key="module"]')`, 'script field again');
  check(true, 'switching back to Script path shows the script field');
  await press('Escape');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog cancelled');

  // ---------- Process 'slow' Is Running ----------
  await js(`(ide.run.runContext({ type: 'python', name: 'slow', script: ${S(path.join(t.project, 'slow.py'))} }), true)`);
  await until(`ide.run.activeSession()?.title === 'slow' && ide.run.activeSession().running && document.querySelector('#runOut')?.textContent.includes('tick 2')`, 'slow running');
  const first = await js(`ide.run.activeSession().procId`);
  await js(`ide.editor.focus()`);
  await press('Shift+F10');
  await until(`!!document.querySelector('.run-confirm')`, 'rerun question');
  check(await h.dialogTitle() === "Process 'slow' Is Running" && await js(`document.querySelector('.run-confirm .dialog-message').textContent`) === "'slow' is running. Stop and rerun?",
    `Run while it runs asks "${await js(`document.querySelector('.run-confirm .dialog-message').textContent`)}"`);
  check(await js(`[...document.querySelectorAll('#dialogHost .dialog-buttons button')].map((b) => b.textContent).join('|')`) === 'Stop and Rerun|Cancel', 'the question offers Stop and Rerun and Cancel');
  check(await js(`document.querySelector('.run-confirm [data-key="dontAskAgain"]')?.checked === false`), "with Don't ask again unchecked");
  await press('Escape');
  await sleep(700);
  check(await js(`!document.querySelector('.run-confirm') && ide.run.activeSession().procId === ${S(first)} && ide.run.activeSession().running`), 'Cancel keeps the running process');
  await press('Shift+F10');
  await until(`!!document.querySelector('.run-confirm')`, 'rerun question again');
  await press('Enter');
  await until(`ide.run.activeSession().running && ide.run.activeSession().procId !== ${S(first)} && document.querySelector('#runOut')?.textContent.includes('tick 2')`, 'rerun started');
  check(await js(`!document.querySelector('.run-confirm') && ide.run.sessions().filter((s) => s.title === 'slow').length === 1`), 'Stop and Rerun stops the old process and runs again in the same tab');
  // The tab's Rerun asks too, and so does a test configuration.
  await click('#bottomActions button[data-action="rerun"]');
  await until(`!!document.querySelector('.run-confirm')`, 'question from the Rerun button');
  check(true, "the Run tab's Rerun asks as well");
  await click('.run-confirm [data-key="dontAskAgain"]');
  const second = await js(`ide.run.activeSession().procId`);
  await click('#dialogHost .dialog-buttons .primary');
  await until(`ide.run.activeSession().running && ide.run.activeSession().procId !== ${S(second)}`, 'rerun after Don\'t ask again');
  check(await js(`ide.settings.get('run.confirmRerun', true) === false`), "Don't ask again turns the run.confirmRerun setting off");
  const third = await js(`ide.run.activeSession().procId`);
  await js(`ide.editor.focus()`);
  await press('Shift+F10');
  await until(`ide.run.activeSession().running && ide.run.activeSession().procId !== ${S(third)}`, 'rerun without a question');
  check(await js(`!document.querySelector('.run-confirm')`), 'afterwards Run reruns without asking');
  await js(`(ide.openSettings('run-debug'), true)`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'run-debug'`, 'Run/Debug settings page');
  check(await js(`document.querySelector('[data-key="run.confirmRerun"]')?.checked === false`), 'Settings › Run/Debug shows the question turned off');
  await click('[data-key="run.confirmRerun"]');
  await click('#settingsOk');
  await until(`!document.querySelector('.settings-page')`, 'settings closed');
  check(await js(`ide.settings.get('run.confirmRerun', true) === true`), 'the settings checkbox turns it back on');
  await click('#bottomActions button[data-action="stop"]');
  await until(`!ide.run.activeSession().running`, 'slow stopped');
  await js(`(ide.run.runContext(ide.tests.configFor(${S(path.join(t.project, 'test_slow.py'))}, null)), true)`);
  await until(`ide.run.activeSession()?.title === 'pytest in test_slow.py' && ide.run.activeSession().running`, 'slow test running');
  await click('#bottomActions button[data-action="rerun"]');
  await until(`!!document.querySelector('.run-confirm')`, 'question for a test run');
  check(await h.dialogTitle() === "Process 'pytest in test_slow.py' Is Running", 'a running test configuration asks too');
  await press('Escape');
  await click('#bottomActions button[data-action="stop"]');
  await until(`!ide.run.activeSession().running`, 'slow test stopped');

  // ---------- 1008x681 ----------
  await t.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await until(`Math.abs(innerWidth - 1008) <= 1 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await js(`(ide.run.runContext({ type: 'python', name: 'slow', script: ${S(path.join(t.project, 'slow.py'))} }), true)`);
  await until(`ide.run.activeSession()?.title === 'slow' && ide.run.activeSession().running`, 'slow running (small)');
  await js(`ide.editor.focus()`);
  await press('Shift+F10');
  await until(`!!document.querySelector('.run-confirm')`, 'question (small)');
  const inside = (sel) => js(`[...document.querySelectorAll(${S(sel)})].every((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && n.scrollWidth <= n.clientWidth + 1; })`);
  check(await inside('#dialogHost .dialog, #dialogHost .dialog-buttons button, .run-confirm-again'), 'at 1008x681 the question and its buttons are inside the window');
  await t.shot('confirm-small.png');
  await press('Escape');
  await click('#bottomActions button[data-action="stop"]');
  await js(`(ide.run.editConfigurations(), true)`);
  await until(`!!document.querySelector('.rc-dialog')`, 'dialog (small)');
  await js(`[...document.querySelectorAll('.rc-item')].find((n) => n.textContent === 'hello module').click()`);
  await js(`(() => { const s = document.querySelector('.rc-form select[data-key="runMode"]'); s.value = 'module'; s.dispatchEvent(new Event('change')); })()`);
  check(await inside('.rc-form select[data-key="runMode"], .rc-form [data-key="module"], #dialogHost .dialog-buttons button'), 'at 1008x681 the Run: switch and the module field are inside the window');
  await t.shot('module-small.png');
  await press('Escape');
  await h.treeMenu('test_calc.py');
  check(await inside('.context-menu .menu-item'), "at 1008x681 the tree's Debug 'pytest in …' is inside the window");
  await press('Escape');
  await js(`(ide.run.debugConfig(ide.tests.configFor(${S(path.join(t.project, 'test_calc.py'))}, null)), true)`);
  await h.resultsDone('pytest in test_calc.py (small)');
  await until(`ide.toolWindows.get('Debug').isVisible() && !!document.querySelector('.dbg-plugin-tab.active')?.offsetParent`, 'Debug window with Test Results (small)');
  const bar = await js(`(() => { const b = document.querySelector('.dbg-bar'); return { fits: b.scrollWidth <= b.clientWidth + 1, inside: [...b.children].every((n) => n.getBoundingClientRect().right <= innerWidth), tree: !!document.querySelector('.dbg-plugin-pane[data-tab="testResults"] .tr-row')?.offsetParent }; })()`);
  check(bar.fits && bar.inside && bar.tree, `at 1008x681 the Debug window's bar with the Test Results sub-tab fits, and the results show (${S(bar)})`);
  await t.shot('debug-results-small.png');
  await t.cdp('Emulation.clearDeviceMetricsOverride');
} catch (err) {
  check(false, `${err.message.split('\n')[0]} [${await h.where().catch(() => '?')}]`);
  await t.shot('failure.png').catch(() => {});
}
const errors = [...t.consoleErrors];
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'tests-debug-run', port: 9054, name: 'tests-debug-run-ko', lang: 'ko-KR' });
const hk = helpers(k);
try {
  await k.until(`ide.root && !!document.querySelector('#tree .node')`, 'Korean project tree');
  const treeKo = (await hk.treeMenu('test_calc.py')).filter((l) => /pytest/.test(l));
  k.check(treeKo.join(' | ') === "'test_calc.py의 pytest' 실행 | 'test_calc.py의 pytest' 디버그", `the tree entries in Korean (${treeKo.join(' | ')})`);
  await hk.clickMenu("'test_calc.py의 pytest' 디버그");
  await hk.resultsDone('test_calc.py의 pytest');
  const koTab = await hk.debugTab();
  k.check(koTab.status.includes('테스트 실패: 1') && koTab.label.includes('테스트 결과') && koTab.shown, `the debug results in Korean, in the 테스트 결과 sub-tab (${S(koTab)})`);
  const runLeaks = await englishLeaks(k, '#bottom');
  k.check(!runLeaks.length, `the Debug window with the test results has no English UI text (${S(runLeaks)})`);
  await k.shot('debug-results-ko.png');
  await k.js(`(ide.run.runContext({ type: 'python', name: 'slow', script: ${S(path.join(k.project, 'slow.py'))} }), true)`);
  await k.until(`ide.run.activeSession()?.title === 'slow' && ide.run.activeSession().running`, 'slow running (ko)');
  await k.js(`ide.editor?.focus()`);
  await k.press('Shift+F10');
  await k.until(`!!document.querySelector('.run-confirm')`, 'question (ko)');
  k.check(await hk.dialogTitle() === "'slow' 프로세스가 실행 중입니다", `the question's title in Korean (${await hk.dialogTitle()})`);
  const askLeaks = await englishLeaks(k, '#dialogHost');
  k.check(!askLeaks.length, `the question has no English UI text (${S(askLeaks)})`);
  await k.press('Escape');
  await k.click('#bottomActions button[data-action="stop"]');
  await k.js(`(ide.run.editConfigurations(), true)`);
  await k.until(`!!document.querySelector('.rc-dialog')`, 'dialog (ko)');
  await k.js(`[...document.querySelectorAll('.rc-item')].find((n) => n.textContent === 'slow').click()`);
  await k.js(`(() => { const s = document.querySelector('.rc-form select[data-key="runMode"]'); s.value = 'module'; s.dispatchEvent(new Event('change')); })()`);
  const formKo = await k.js(`[...document.querySelectorAll('.rc-form .field > span')].map((n) => n.textContent).slice(0, 3).join(' | ') + ' / ' + [...document.querySelector('.rc-form select[data-key="runMode"]').options].map((o) => o.textContent).join('|')`);
  k.check(formKo === '이름: | 실행: | 모듈 이름: / 스크립트 경로|모듈 이름', `the Run: switch in Korean (${formKo})`);
  const formLeaks = await englishLeaks(k, '.rc-form');
  k.check(!formLeaks.length, `the form has no English UI text (${S(formLeaks)})`);
  await k.press('Escape');
  await k.js(`(ide.openSettings('run-debug'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'run-debug'`, 'settings page (ko)');
  const setLeaks = await englishLeaks(k, '.settings-dialog');
  k.check(!setLeaks.length, `Settings › 실행/디버그 has no English UI text (${S(setLeaks)})`);
  await k.js(`(document.querySelector('#settingsCancel').click(), true)`);
  const missing = (await missingTranslations(k)).filter((s) => /pytest|Debug|Rerun|rerun|Module|module|Script|running|ask/i.test(s));
  k.check(!missing.length, `no missing translations (${missing.join(' | ')})`);
} catch (err) {
  k.check(false, `${err.message.split('\n')[0]} [${await hk.where().catch(() => '?')}]`);
  await k.shot('failure.png').catch(() => {});
}
k.results.unshift(...t.results);
k.consoleErrors.unshift(...errors);
k.finish();
