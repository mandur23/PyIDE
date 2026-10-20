// Conditional breakpoints, hit counts and logpoints against a real debugpy run (ports 9900-9901).
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'cond-breakpoints', port: 9900 });
const { js, until, press, type, click, check, shot, cdp } = t;

const bp = (line) => js(`window.__debugger.breakpoints().find(b => b.path.endsWith('loop.py') && b.line === ${line}) || null`);
const glyphClass = (line) => js(`(() => { const d = ide.editor.getModel().getLinesDecorations(${line}, ${line}).find(d => /\\bdbg-bp\\b/.test(d.options.glyphMarginClassName || '')); return d?.options.glyphMarginClassName || ''; })()`);
const out = () => js(`document.querySelector('#dbgOut').textContent`);
const varsText = () => js(`document.querySelector('#dbgVars').textContent`);
const stoppedAt = (line) => until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.endsWith('loop.py') && f.line === ${line}; })()`, `suspended at loop.py:${line}`);

async function gutter(line, button = 'left') {
  const p = await js(`(() => { const e = ide.editor; e.revealLineInCenterIfOutsideViewport(${line}); const li = e.getLayoutInfo();
    const pos = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const r = e.getDomNode().getBoundingClientRect();
    return { x: r.left + li.glyphMarginLeft + li.glyphMarginWidth / 2, y: r.top + pos.top + pos.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const kind of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type: kind, x: p.x, y: p.y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 });
  await t.sleep(120);
}
const cursorTo = (line) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 5 }))`);
const popupOpen = () => until(`!!document.querySelector('#dbgBpPopup #dbgBpCondition')`, 'inline breakpoint popup');
const popupClosed = () => until(`!document.querySelector('#dbgBpPopup')`, 'popup closed');
const focusType = async (sel, text) => { await js(`document.querySelector(${JSON.stringify(sel)}).focus()`); await type(text); };

let t2;
try {
  await openFile(t, 'loop.py');
  // Every 'stopped' event of the run, to prove which lines suspended.
  await js(`(window.__stops = [], ide.api.on('debug:event', (m) => { if (m.event === 'stopped') window.__stops.push(m.body.reason); }), true)`);

  // ---- condition: right-click the glyph ----
  await gutter(3);
  await until(`window.__debugger.breakpoints().length === 1`, 'breakpoint on line 3');
  await gutter(3, 'right');
  await popupOpen();
  check(await js(`!document.querySelector('.dialog-backdrop') && !!document.querySelector('#dbgBpHit') && !!document.querySelector('#dbgBpLogToggle')`),
    'right-clicking a breakpoint opens the inline popup (no modal) with Condition, Hit count and Log message');
  const popBox = await js(`(() => { const p = document.querySelector('#dbgBpPopup').getBoundingClientRect(); const e = ide.editor.getDomNode().getBoundingClientRect(); return { left: p.left - e.left, inEditor: p.left >= e.left && p.top >= e.top }; })()`);
  check(popBox.inEditor && popBox.left < 80, `popup opens next to the gutter (${JSON.stringify(popBox)})`);
  await focusType('#dbgBpCondition', 'i == 3');
  await press('Enter');
  await popupClosed();
  check((await bp(3))?.condition === 'i == 3', 'Enter applies the condition i == 3');
  check(/\bcond\b/.test(await glyphClass(3)) && !/\blog\b/.test(await glyphClass(3)), 'conditional breakpoint glyph is the dot with "?"');

  // ---- logpoint: Ctrl+F8 then Ctrl+Shift+F8 on the line ----
  await cursorTo(4);
  await press('Ctrl+F8');
  check(!!(await bp(4)), 'Ctrl+F8 adds a breakpoint on line 4');
  await cursorTo(4);
  await press('Ctrl+Shift+F8');
  await popupOpen();
  check(!(await js(`!!document.querySelector('#dbgBpList')`)), 'Ctrl+Shift+F8 on a breakpoint line edits it inline instead of listing all');
  check(await js(`document.querySelector('#dbgBpLog').disabled`), 'log message field is off until the logpoint box is ticked');
  await click('#dbgBpLogToggle');
  await until(`!document.querySelector('#dbgBpLog').disabled && document.activeElement?.id === 'dbgBpLog'`, 'log message field enabled and focused');
  await type('i={i} total={total} sq={i * i}');
  await shot('logpoint-popup.png');
  await press('Escape');
  await popupClosed();
  check((await bp(4))?.logMessage === 'i={i} total={total} sq={i * i}', 'Esc closes the popup and keeps the log message');
  const logClass = await glyphClass(4);
  check(/\blog\b/.test(logClass) && !/\bcond\b/.test(logClass), `logpoint glyph is a diamond (${logClass})`);
  check(!(await js(`ide.editor.getModel().getLinesDecorations(4, 4).some(d => d.options.className === 'dbg-bp-line')`)), 'a logpoint does not tint its line like a suspending breakpoint');

  // ---- hit count ----
  await gutter(7);
  await until(`window.__debugger.breakpoints().length === 3`, 'breakpoint on line 7');
  await gutter(7, 'right');
  await popupOpen();
  await focusType('#dbgBpHit', '4');
  await click('#editor .view-lines');
  await popupClosed();
  check((await bp(7))?.hitCondition === '4', 'a click outside the popup applies hit count 4');
  check(/\bcond\b/.test(await glyphClass(7)), 'a hit count also shows the "?" glyph');
  const hover = await js(`ide.editor.getModel().getLinesDecorations(7, 7).find(d => d.options.glyphMarginHoverMessage)?.options.glyphMarginHoverMessage.value`);
  check(hover.includes('Hit count:') && hover.includes('4'), 'glyph hover shows the hit count');

  // ---- reopening shows the saved values; Done keeps them ----
  await gutter(3, 'right');
  await popupOpen();
  check(await js(`document.querySelector('#dbgBpCondition').value === 'i == 3' && !document.querySelector('#dbgBpLogToggle').checked`), 'popup shows the saved condition');
  await click('#dbgBpPopup .primary');
  await popupClosed();
  check((await bp(3))?.condition === 'i == 3', 'Done keeps the condition');

  // ---- Breakpoints dialog lists the settings ----
  await cursorTo(5);
  await press('Ctrl+Shift+F8');
  await until(`!!document.querySelector('#dbgBpList')`, 'breakpoints dialog');
  const listText = await js(`document.querySelector('#dbgBpList').textContent`);
  check(listText.includes('[i == 3]') && listText.includes('hit 4') && listText.includes('"i={i} total={total} sq={i * i}"'),
    `Breakpoints list shows condition, hit count and log message (${listText})`);
  check(await js(`document.querySelectorAll('#dbgBpList .dbg-bp-dot.log').length === 1 && document.querySelectorAll('#dbgBpList .dbg-bp-dot.cond').length === 2`), 'list icons match the glyphs');
  check(await js(`document.querySelector('#dbgBpListCondition').value === 'i == 3'`), 'dialog detail edits the condition');
  await shot('breakpoints-dialog.png');
  await press('Escape');
  await until(`!document.querySelector('#dbgBpList')`, 'dialog closed');

  // ---- real debugpy run ----
  await press('Shift+F9');
  await stoppedAt(3);
  await until(`document.querySelector('#dbgVars').textContent.includes('total = {int}')`, 'variables');
  let vt = await varsText();
  check(vt.includes('i = {int} 3') && vt.includes('total = {int} 3'), `condition stops only when true: paused frame shows i = 3 (${vt.slice(0, 80)})`);
  await until(`document.querySelector('#dbgOut').textContent.includes('i=2 total=3 sq=4')`, 'logpoint output before the stop');
  let o = await out();
  check(['i=0 total=0 sq=0', 'i=1 total=1 sq=1', 'i=2 total=3 sq=4'].every((s) => o.includes(s)), 'logpoint prints its interpolated message to the Debug console');
  check(!o.includes('i=3 total'), 'no log line yet for i = 3 (the program is suspended before line 4)');
  check((await js(`window.__stops.length`)) === 1, 'the logpoint and the earlier iterations did not suspend');
  await shot('suspended-cond.png');

  await press('F9');
  await stoppedAt(7);
  await until(`document.querySelector('#dbgVars').textContent.includes('hits = {int}')`, 'variables at line 7');
  vt = await varsText();
  check(vt.includes('k = {int} 3') && vt.includes('hits = {int} 3'), `hit count 4 stops on the 4th hit only (k = 3, hits = 3): ${vt.slice(0, 80)}`);
  o = await out();
  check(['i=3 total=6 sq=9', 'i=4 total=10 sq=16', 'i=5 total=15 sq=25'].every((s) => o.includes(s)), 'logpoint kept logging after resuming');

  await press('F9');
  await until(`document.querySelector('#dbgOut').textContent.includes('Process finished with exit code 0')`, 'program finished');
  o = await out();
  check(o.includes('done 15 5'), 'program ran to the end');
  check((await js(`window.__stops.join()`)) === 'breakpoint,breakpoint', `exactly two suspensions in the run (${await js(`window.__stops.join()`)})`);
  check((o.match(/i=\d total=/g) || []).length === 6, 'one log line per iteration, never a suspension at the logpoint');

  // ---- persistence across a restart ----
  await js(`(ide.settings.flush(), true)`);
  await t.sleep(300);
  t.close();
  t2 = await launch({ fixture: 'cond-breakpoints', port: 9901, name: 'cond-breakpoints-restart', userData: t.userData, projectDir: t.project });
  t2.results.push(...t.results);
  await openFile(t2, 'loop.py');
  const saved = await t2.js(`window.__debugger.breakpoints().map(b => ({ line: b.line, condition: b.condition, hitCondition: b.hitCondition, logMessage: b.logMessage, enabled: b.enabled }))`);
  t2.check(JSON.stringify(saved) === JSON.stringify([
    { line: 3, condition: 'i == 3', hitCondition: '', logMessage: '', enabled: true },
    { line: 4, condition: '', hitCondition: '', logMessage: 'i={i} total={total} sq={i * i}', enabled: true },
    { line: 7, condition: '', hitCondition: '4', logMessage: '', enabled: true },
  ]), `condition, hit count and log message survive a restart (${JSON.stringify(saved)})`);
  await t2.until(`(ide.editor.render(true), document).querySelectorAll('#editor .dbg-bp.cond').length === 2 && document.querySelectorAll('#editor .dbg-bp.log').length === 1`, 'glyphs restored');
  t2.check(true, 'glyphs restored after restart');
  await t2.shot('restored.png');
} catch (err) {
  (t2 || t).check(false, err.message);
  await (t2 || t).shot('failure.png').catch(() => {});
}
if (!t2) t.finish();
// The first instance's renderer exceptions count too.
t2.consoleErrors.push(...t.consoleErrors);
t2.finish();
