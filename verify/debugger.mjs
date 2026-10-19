import { execFileSync } from 'child_process';
import path from 'path';
import { launch, openFile } from './lib.mjs';

// Live Python processes whose command line names `file` (a venv launcher and its child may both count).
const pyProcs = (file) => Number(execFileSync('powershell', ['-NoProfile', '-Command',
  `@(Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${file.replace(/'/g, "''")}') }).Count`],
{ encoding: 'utf8' }).trim());
async function noProcs(file, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pyProcs(file) === 0) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const t = await launch({ fixture: 'debugger', port: 9402 });
const { js, until, press, type, click, check, shot, cdp } = t;

const state = () => js(`window.__debugger.state()`);
const bpLines = (file) => js(`window.__debugger.breakpoints().filter(b => b.path.endsWith(${JSON.stringify(file)})).map(b => b.line)`);
const glyphs = () => js(`[...(ide.editor.render(true), document).querySelectorAll('#editor .dbg-bp:not(.hover)')].length`);
const varsText = () => js(`document.querySelector('#dbgVars').textContent`);
const stoppedAt = (file, line) => until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.endsWith(${JSON.stringify(file)}) && f.line === ${line}; })()`, `suspended at ${file}:${line}`);

// Real mouse events on the editor gutter (glyph margin) for a given line.
async function gutter(line, button = 'left') {
  const p = await js(`(() => { const e = ide.editor; e.revealLineInCenterIfOutsideViewport(${line}); const li = e.getLayoutInfo();
    const pos = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const r = e.getDomNode().getBoundingClientRect();
    return { x: r.left + li.glyphMarginLeft + li.glyphMarginWidth / 2, y: r.top + pos.top + pos.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: p.x, y: p.y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 });
  await t.sleep(120);
}
const cursorTo = (line) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 5 }))`);
const clickText = (sel, text) => js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(sel)})].find(n => n.textContent.includes(${JSON.stringify(text)})); if (!n) return false; n.id ||= 'dbgTmp' + Math.random().toString(36).slice(2); return n.id; })()`)
  .then((id) => { if (!id) throw new Error(`no ${sel} containing ${text}`); return click(`#${id}`); });

try {
  // ---- breakpoints in the gutter and Ctrl+F8 ----
  await openFile(t, 'main.py');
  await gutter(7);
  await until(`(ide.editor.render(true), document).querySelectorAll('#editor .dbg-bp:not(.hover)').length === 1`, 'red dot after gutter click');
  check((await bpLines('main.py')).join() === '7', 'clicking the glyph margin adds a breakpoint on line 7');
  check(await js(`!!(ide.editor.render(true), document).querySelector('#editor .dbg-bp-line')`), 'breakpoint line is tinted');
  await gutter(11);
  check((await bpLines('main.py')).join() === '7,11', 'second gutter click adds line 11');
  await gutter(11);
  check((await bpLines('main.py')).join() === '7', 'clicking an existing breakpoint removes it');

  await openFile(t, 'helper.py');
  await cursorTo(3);
  await press('Ctrl+F8');
  check((await bpLines('helper.py')).join() === '3', 'Ctrl+F8 toggles a breakpoint on at the caret');
  await press('Ctrl+F8');
  check((await bpLines('helper.py')).length === 0 && (await glyphs()) === 0, 'Ctrl+F8 again removes it');

  // ---- conditional breakpoint via right-click on the glyph ----
  await openFile(t, 'main.py');
  await gutter(7, 'right');
  await until(`!!document.querySelector('#dbgBpCondition')`, 'breakpoint condition popup');
  await js(`document.querySelector('#dbgBpCondition').focus()`);
  await type('v == 2');
  await press('Enter');
  await until(`!document.querySelector('#dbgBpCondition')`, 'popup closed');
  check(await js(`window.__debugger.breakpoints().find(b => b.line === 7)?.condition === 'v == 2'`), 'right-click on a breakpoint sets a condition');
  check(await js(`!!(ide.editor.render(true), document).querySelector('#editor .dbg-bp.cond')`), 'conditional breakpoint glyph shown');

  // ---- breakpoints follow edits and persist ----
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }))`);
  await type('# note\n');
  await until(`window.__debugger.breakpoints().some(b => b.line === 8)`, 'breakpoint moved to line 8');
  check(true, 'inserting a line above moves the breakpoint down with the code');
  await cursorTo(1);
  await press('Ctrl+Y');
  await until(`window.__debugger.breakpoints().some(b => b.line === 7)`, 'breakpoint back on line 7');
  check(await js(`ide.editor.getModel().getLineContent(1) === 'from helper import scale'`), 'deleting the line moves it back');
  await t.sleep(400);
  const saved = await js(`JSON.stringify(ide.settings.get('debugger.breakpoints:' + ide.root))`);
  check(saved.includes('"line":7') && saved.includes('v == 2'), 'breakpoints persisted per project in ide.settings');
  await press('Ctrl+S');

  // ---- Shift+F9 debugs, stops at the conditional breakpoint ----
  await press('Shift+F9');
  await stoppedAt('main.py', 7);
  check(true, 'Shift+F9 starts debugging and suspends at main.py:7');
  check(await js(`ide.toolWindows.get('Debug').isVisible()`), 'Debug tool window shown');
  await until(`document.querySelector('#dbgVars').textContent.includes('total')`, 'variables loaded');
  let vt = await varsText();
  check(vt.includes('v = {int} 2'), `condition v == 2 respected (variables: ${vt.slice(0, 80)})`);
  check(vt.includes('total = {int} 10'), 'Variables show locals with types');
  await until(`!!(ide.editor.render(true), document).querySelector('#editor .dbg-exec-line') && !!(ide.editor.render(true), document).querySelector('#editor .dbg-exec-arrow')`, 'execution line');
  check(true, 'execution line highlighted with arrow');
  const frames = await js(`[...document.querySelectorAll('#dbgFrames .dbg-frame')].map(f => f.textContent)`);
  check(frames[0] === 'compute, main.py:7' && frames.some((f) => f.startsWith('<module>, main.py:13')), `Frames list (${frames.slice(0, 2).join(' | ')})`);
  const inlineText = `[...(ide.editor.render(true), document).querySelectorAll('#editor .dbg-inline-val')].map(n => n.textContent.replace(/\\s/g, ' ')).join('|')`;
  await until(`${inlineText}.includes('total: 10')`, 'inline values');
  check(await js(`${inlineText}.includes('values: [1, 2, 3]')`), 'inline values shown after lines');
  await shot('suspended.png');

  // lazy expansion of a list
  await clickText('#dbgVars .dbg-var', 'values = {list}');
  await until(`document.querySelector('#dbgVars .dbg-kids:not(.hidden)')?.textContent.includes('0 = {int} 1')`, 'list children');
  check(true, 'expanding a list loads its items lazily');

  // select the module frame, expand a dict
  await clickText('#dbgFrames .dbg-frame', '<module>');
  await until(`document.querySelector('#dbgVars').textContent.includes('info = {dict}')`, 'module frame variables');
  check(await js(`document.querySelector('#dbgFrames .dbg-frame.selected').textContent.startsWith('<module>')`), 'clicking a frame selects it');
  await until(`!!(ide.editor.render(true), document).querySelector('#editor .dbg-frame-line')`, 'outer frame line');
  check(true, 'selected outer frame line highlighted');
  await clickText('#dbgVars .dbg-var', 'info = {dict}');
  await until(`document.querySelector('#dbgVars').textContent.includes("'name' = {str} 'demo'")`, 'dict children');
  check(true, 'expanding a dict shows its entries');
  await clickText('#dbgFrames .dbg-frame', 'compute');
  await until(`document.querySelector('#dbgVars').textContent.includes('total = {int} 10')`, 'back on top frame');

  // ---- watches ----
  await click('#dbgWatchAdd');
  await js(`document.querySelector('#dbgWatchInput').focus()`);
  await type('total * 2');
  await press('Enter');
  await until(`document.querySelector('#dbgWatches').textContent.includes('total * 2 = {int} 20')`, 'watch value');
  check(true, 'added watch is evaluated in the current frame');
  await click('#dbgWatchAdd');
  await js(`document.querySelector('#dbgWatchInput').focus()`);
  await type('len(values)');
  await press('Enter');
  await until(`document.querySelector('#dbgWatches').textContent.includes('len(values) = {int} 3')`, 'second watch');

  // ---- stepping ----
  await press('F7');
  await stoppedAt('helper.py', 2);
  check(await js(`ide.activeTab().title === 'helper.py'`), 'F7 steps into scale() and opens helper.py');
  await until(`document.querySelector('#dbgWatches .dbg-err')`, 'watch re-evaluated in new frame');
  check(true, 'watches re-evaluated on each stop (NameError for total in scale)');
  await press('F8');
  await stoppedAt('helper.py', 3);
  check((await varsText()).includes('factor = {int} 10'), 'F8 steps over a line');
  await press('Shift+F8');
  await until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.endsWith('main.py'); })()`, 'back in main.py');
  check(true, 'Shift+F8 steps out to the caller');
  await shot('stepped.png');

  // ---- Alt+F8 evaluate ----
  await press('Alt+F8');
  await until(`!!document.querySelector('#dbgEvalInput')`, 'evaluate dialog');
  await js(`(document.querySelector('#dbgEvalInput').value = '', document.querySelector('#dbgEvalInput').focus())`);
  await type('{"sum": sum(values), "rest": values[1:]}');
  await press('Enter');
  await until(`document.querySelector('#dbgEvalResult').textContent.includes('{dict}')`, 'evaluate result');
  check(await js(`document.querySelector('#dbgEvalResult').textContent.includes("'sum': 6")`), 'Alt+F8 evaluates an expression');
  await click('#dbgEvalResult .dbg-var');
  await until(`document.querySelector('#dbgEvalResult').textContent.includes("'rest' = {list} [2, 3]")`, 'expand eval result');
  check(true, 'evaluate result is an expandable tree');
  await shot('evaluate.png');
  await press('Escape');
  await until(`!document.querySelector('#dbgEvalInput')`, 'evaluate closed');

  // ---- console evaluate ----
  await click('#dbgTabConsole');
  await js(`document.querySelector('#dbgConsoleEval').focus()`);
  await type('total + 1');
  await press('Enter');
  await until(`document.querySelector('#dbgOut').textContent.includes('>>> total + 1')`, 'console echo');
  await until(`/>>> total \\+ 1\\s+\\d+/.test(document.querySelector('#dbgOut').textContent)`, 'console eval result');
  check(true, 'console evaluates expressions in the selected frame');

  // ---- Alt+F9 run to cursor ----
  await openFile(t, 'main.py');
  await cursorTo(8);
  await press('Alt+F9');
  await stoppedAt('main.py', 8);
  check((await varsText()).includes('total = {int} 60'), 'Alt+F9 runs to the caret line (loop finished, total 60)');

  // ---- breakpoints dialog ----
  await press('Ctrl+Shift+F8');
  await until(`!!document.querySelector('#dbgBpList')`, 'breakpoints dialog');
  check(await js(`document.querySelector('#dbgBpList').textContent.includes('main.py:7') && document.querySelector('#dbgBpList').textContent.includes('v == 2')`), 'Ctrl+Shift+F8 lists breakpoints with conditions');
  await shot('breakpoints.png');
  await click('#dbgBpList .dbg-bps-row input[type=checkbox]');
  check(await js(`window.__debugger.breakpoints()[0].enabled === false`), 'breakpoint disabled from the list');
  check(await js(`!!(ide.editor.render(true), document).querySelector('#editor .dbg-bp.disabled')`), 'disabled breakpoint glyph is hollow');
  await click('#dbgBpList .dbg-bps-row input[type=checkbox]');
  await press('Escape');
  await until(`!document.querySelector('#dbgBpList')`, 'breakpoints dialog closed');

  // ---- F9 resume, stdin, program exit ----
  await press('F9');
  await until(`document.querySelector('#dbgOut').textContent.includes('name?')`, 'program prompts for input');
  check(await js(`window.__debugger.state().state === 'running'`), 'F9 resumes the program');
  await click('#dbgTabConsole');
  await until(`document.activeElement?.id === 'dbgIn'`, 'stdin field focused');
  await type('Ann');
  await press('Enter');
  await until(`document.querySelector('#dbgOut').textContent.includes('Process finished with exit code 0')`, 'program finished');
  check(await js(`document.querySelector('#dbgOut').textContent.includes('result=60 name=Ann')`), 'stdin reaches the debugged program, output shown in Console');
  check(await js(`!(ide.editor.render(true), document).querySelector('#editor .dbg-exec-line') && window.__debugger.state() === null`), 'session ended and decorations cleared');

  // ---- pause and Ctrl+F2 stop ----
  await openFile(t, 'loop.py');
  await click('#debugBtn');
  await until(`window.__debugger.state()?.state === 'running'`, 'loop running');
  await t.sleep(500);
  await click('#dbgPause');
  await until(`window.__debugger.state()?.state === 'suspended'`, 'paused');
  await until(`document.querySelector('#dbgVars').textContent.includes('count = {int}')`, 'paused variables');
  check(true, 'toolbar Debug button starts a session; Pause suspends a running program');
  await press('Ctrl+F2');
  await until(`window.__debugger.state() === null`, 'debug session stopped');
  check(!(await js(`document.querySelector('#dbgOut').textContent.includes('loop done')`)), 'Ctrl+F2 stops the debug session');

  // The main toolbar's Stop button (owned by run) also stops a debug session
  await click('#debugBtn');
  await until(`window.__debugger.state()?.state === 'running' && !document.querySelector('.stop-btn').disabled`, 'loop running, toolbar Stop enabled');
  await click('.stop-btn');
  await until(`window.__debugger.state() === null`, 'debug session stopped from toolbar');
  check(await js(`document.querySelector('.stop-btn').disabled`), 'toolbar Stop button stops the debug session');

  // Ctrl+F2 without a debug session still stops a normal Run
  await openFile(t, 'waiter.py');
  await press('Shift+F10');
  await until(`document.querySelector('#runOut')?.textContent.includes('waiting for input')`, 'run started');
  await press('Ctrl+F2');
  await until(`document.querySelector('#runOut').textContent.includes('Process finished')`, 'run stopped');
  check(true, "Ctrl+F2 outside debugging still stops Run");

  // ---- quick double starts and Stop during startup leave no process behind ----
  const loopPy = path.join(t.project, 'loop.py');
  const waiterPy = path.join(t.project, 'waiter.py');
  await openFile(t, 'loop.py');
  await press('Shift+F9');
  await press('Shift+F9');
  await until(`window.__debugger.state()?.state === 'running'`, 'second debug session running');
  await t.sleep(1500);
  check(pyProcs(loopPy) > 0, 'the debuggee is running');
  await press('Ctrl+F2');
  await until(`window.__debugger.state() === null`, 'double-started session stopped');
  check(await noProcs(loopPy), 'Shift+F9 twice while debugpy connects leaves no orphaned debuggee after Stop');
  await press('Shift+F9');
  await until(`window.__debugger.state()?.state === 'starting'`, 'debug session starting');
  await press('Ctrl+F2');
  await until(`window.__debugger.state() === null`, 'starting session stopped');
  check(await noProcs(loopPy), 'Ctrl+F2 while a debug session is starting stops its debuggee');

  await openFile(t, 'waiter.py');
  await js(`(ide.runAction('Run'), ide.runAction('Run'), true)`); // the second Run lands while the first is still starting
  await until(`document.querySelector('#runOut')?.textContent.includes('waiting for input')`, 'rerun started');
  await t.sleep(1000);
  await press('Ctrl+F2');
  await until(`document.querySelector('#runOut').textContent.includes('Process finished')`, 'rerun stopped');
  check(await noProcs(waiterPy), 'Run twice in a row leaves no unstoppable process behind');

  // ---- persistence across reload ----
  await js(`location.reload(), true`);
  await t.sleep(500);
  await until('window.__ideReady === true', 'IDE reloaded', 30000);
  await openFile(t, 'main.py');
  await until(`(ide.editor.render(true), document).querySelectorAll('#editor .dbg-bp.cond').length === 1`, 'breakpoint restored');
  check(true, 'breakpoints restored after reload');
  const wasVisible = await js(`ide.toolWindows.get('Debug').isVisible()`);
  await press('Alt+5');
  const toggled = (await js(`ide.toolWindows.get('Debug').isVisible()`)) !== wasVisible;
  if (wasVisible) await press('Alt+5');
  check(toggled && await js(`ide.toolWindows.get('Debug').isVisible()`), 'Alt+5 toggles the Debug tool window');
  check(await js(`document.querySelector('#dbgWatches').textContent.includes('total * 2')`), 'watches persisted');
  await shot('final.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
