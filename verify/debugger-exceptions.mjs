// Python Exception Breakpoints (Breakpoints dialog, Ctrl+Shift+F8): "Any exception" on termination by default, added
// classes on raise with a condition, the exception named in the Debug window, live changes, persistence, 1008x681 and
// Korean. Ports 9050 (English, then its restart) and 9051 (Korean).
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const results = [];

// Every suspension shown to the user: the stop's frame and the exception strip's text.
const TRACK = `(() => { window.__suspensions = []; let last = null;
  ide.on('debugContextChanged', () => {
    const s = ide.debugger.stopped();
    if (!s) { last = null; return; }
    const key = JSON.stringify(s.frames[0]);
    if (key === last) return;
    last = key;
    window.__suspensions.push({ reason: s.reason, line: s.frames[0]?.line, name: s.frames[0]?.name,
      strip: document.querySelector('#dbgException:not(.hidden)')?.textContent || '' });
  }); return true; })()`;

function helpers(t) {
  const { js, until, press, type, click } = t;
  const suspensions = () => js('window.__suspensions');
  const out = () => js(`document.querySelector('#dbgOut').textContent`);
  const vars = () => js(`document.querySelector('#dbgVars').textContent`);
  const finished = (code) => until(`(t => t.includes('Process finished with exit code ${code}') || t.includes('종료 코드 ${code}(으)로'))(document.querySelector('#dbgOut').textContent)`, `exit code ${code}`, 30000);
  const suspended = (n) => until(`window.__suspensions.length === ${n} && !!document.querySelector('#dbgVars .dbg-var')`, `suspension ${n}`, 20000);
  const cursorTo = (line) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 1 }))`);
  const openDialog = async () => {
    await cursorTo(1);
    await press('Ctrl+Shift+F8');
    await until(`!!document.querySelector('#dbgBpList')`, 'Breakpoints dialog');
  };
  const closeDialog = async () => {
    await press('Enter');
    await until(`!document.querySelector('#dbgBpList')`, 'Breakpoints dialog closed');
  };
  const listText = () => js(`document.querySelector('#dbgBpList').textContent`);
  const clickRow = async (text) => {
    const id = await js(`(() => { const r = [...document.querySelectorAll('#dbgBpList .dbg-bps-row')].find((n) => n.textContent.includes(${JSON.stringify(text)}));
      if (!r) return null; r.id = 'dbgTestRow'; return r.id; })()`);
    if (!id) throw new Error(`no breakpoint row ${text}`);
    await click('#dbgTestRow > :nth-child(3)');
  };
  const addClass = async (name) => {
    await click('#dbgExcAdd');
    await until(`document.activeElement?.id === 'dbgExcClass'`, 'class field focused');
    await type(name);
    await press('Enter');
  };
  const debug = async (file) => {
    await openFile(t, file);
    await cursorTo(1);
    await press('Shift+F9');
  };
  return { suspensions, out, vars, finished, suspended, cursorTo, openDialog, closeDialog, listText, clickRow, addClass, debug };
}

const t = await launch({ fixture: 'debugger-exceptions', port: 9050, name: 'debugger-exceptions' });
const { js, until, press, type, click, check } = t;
const h = helpers(t);
try {
  await openFile(t, 'exc.py');
  await js(TRACK);

  await h.openDialog();
  let text = await h.listText();
  check(text.includes('Python Exception Breakpoints (1)') && text.includes('Any exception') && text.includes('On termination') && !text.includes('On raise'),
    `the dialog lists "Any exception" on termination by default (${text})`);
  await press('Escape');
  await until(`!document.querySelector('#dbgBpList')`, 'dialog closed');

  await h.debug('exc.py');
  await h.finished(0);
  check((await h.out()).includes('caught empty text') && (await h.suspensions()).length === 0,
    'without a ValueError breakpoint a caught ValueError does not suspend');

  await h.openDialog();
  await h.addClass('1bad');
  await until(`!document.querySelector('#dbgExcClassError').classList.contains('hidden')`, 'class name error');
  check((await js(`document.querySelector('#dbgExcClassError').textContent`)).includes('Not a Python class name: 1bad'), 'a name that is no Python class is refused with a message');
  await js(`document.querySelector('#dbgExcClass').select()`);
  await type('ValueError');
  await press('Enter');
  await until(`document.querySelector('#dbgBpList').textContent.includes('ValueError')`, 'ValueError row');
  check(await js(`document.querySelector('#dbgExcOnRaise').checked && !document.querySelector('#dbgExcOnTerminate').checked
    && document.querySelector('.dbg-bps-detail .dbg-bps-title').textContent === 'ValueError' && document.activeElement?.id === 'dbgBpList'`),
  'Enter in the class field adds ValueError on raise, shows it and gives the keyboard back to the list');
  await h.addClass('errors.AppError');
  await until(`document.querySelector('.dbg-bps-detail .dbg-bps-title')?.textContent === 'errors.AppError'`, 'AppError detail');
  await click('#dbgExcCondition');
  await type(`__exception__[1].args[0].endswith('4')`);
  for (const name of ['json.NoSuch', 'nosuch.Missing', 'os.sep', 'True']) await h.addClass(name);
  text = await h.listText();
  check(text.includes('Python Exception Breakpoints (7)') && text.includes(`[__exception__[1].args[0].endswith('4')]`),
    `classes and a condition are listed (${text})`);
  await h.closeDialog();
  await t.sleep(300);
  const saved = await js(`JSON.stringify(ide.settings.get('debugger.exceptionBreakpoints:' + ide.root))`);
  check(saved.includes('"type":"ValueError"') && saved.includes('endswith') && saved.includes('"type":null'), 'exception breakpoints are saved per project');

  // The next suspension after pressing key (or after starting a run when key is a file).
  const next = async (key) => {
    const n = (await h.suspensions()).length + 1;
    if (key.endsWith('.py')) await h.debug(key); else await press(key);
    await h.suspended(n);
    return (await h.suspensions())[n - 1];
  };
  let s = await next('exc.py');
  check(s.reason === 'exception' && s.name === 'parse' && s.line === 6, `a ValueError-on-raise breakpoint suspends at the raise (${JSON.stringify(s)})`);
  check(s.strip.includes('ValueError: empty text') && s.strip.includes('On raise'), `the Debug window names the exception and its message (${s.strip})`);
  await t.shot('exception-stop.png');
  s = await next('F9');
  check(s.line === 12 && s.strip.includes('AppError: too big: 4'), `the AppError condition passes over n == 3 and the propagation of the ValueError to its caller (${JSON.stringify(s)})`);
  await until(`document.querySelector('#dbgVars').textContent.includes('n = {int} 4')`, 'n in Variables');
  await press('F9');
  await h.finished(0);
  check((await h.suspensions()).length === 2 && (await h.out()).includes('done'),
    'names debugpy cannot use as exception classes (json.NoSuch, nosuch.Missing, os.sep, True) leave the session working');

  s = await next('uncaught.py');
  check(s.line === 3 && s.strip.includes(`KeyError: 'missing'`) && s.strip.includes('On termination'), `"Any exception" suspends on an uncaught exception (${JSON.stringify(s)})`);
  await press('F9');
  await h.finished(1);

  await h.openDialog();
  await h.clickRow('Any exception');
  await click('#dbgExcOnTerminate');
  await h.closeDialog();
  await h.debug('uncaught.py');
  await h.finished(1);
  check((await h.suspensions()).length === 3, 'with "On termination" off an uncaught exception ends the program without suspending');
  await h.openDialog();
  await h.clickRow('Any exception');
  await click('#dbgExcOnTerminate');
  await h.clickRow('ValueError');
  await press(' ');
  check(await js(`[...document.querySelectorAll('#dbgBpList .dbg-bps-row')].find((r) => r.textContent.includes('ValueError')).querySelector('input').checked === false`),
    'Space on the selected row disables the breakpoint');
  await h.closeDialog();
  s = await next('exc.py');
  check(s.line === 12, `a disabled breakpoint is not sent: the run suspends only for AppError (${JSON.stringify(s)})`);
  await press('F9');
  await h.finished(0);
  check((await h.suspensions()).length === 4, 'no other suspension in that run');

  await openFile(t, 'exc.py');
  await h.cursorTo(17);
  await press('Ctrl+F8');
  s = await next('exc.py');
  check(s.line === 17, 'line breakpoint before the raise');
  await h.openDialog();
  await h.clickRow('ValueError');
  await press(' ');
  await h.closeDialog();
  s = await next('F9');
  check(s.line === 6 && s.strip.includes('ValueError'), `a breakpoint enabled during a session is sent to debugpy (${JSON.stringify(s)})`);
  s = await next('F8');
  check(s.name === '<module>' && [17, 18, 19].includes(s.line) && !(await h.out()).includes('done'),
    `F8 at the raise stops in the caller instead of running the program to its end (${JSON.stringify(s)})`);
  await next('F9');
  await press('F9');
  await h.finished(0);
  await openFile(t, 'exc.py');
  await h.cursorTo(17);
  await press('Ctrl+F8');

  // F8 over check(3): its AppError (condition false) is passed over, and the step still ends on the next line.
  await h.cursorTo(22);
  await press('Ctrl+F8');
  s = await next('exc.py');
  for (let i = 0; i < 4; i++) s = await next('F9');
  check(s.line === 22 && (await h.vars()).includes('n = {int} 3'), `at check(n) with n == 3 (${JSON.stringify(s)})`);
  s = await next('F8');
  check(s.name === '<module>' && [23, 24].includes(s.line) && s.reason === 'step',
    `F8 over a call whose exception is passed over stops on the next line of the caller (${JSON.stringify(s)})`);
  await openFile(t, 'exc.py');
  await h.cursorTo(22);
  await press('Ctrl+F8');
  s = await next('F9');
  check(s.line === 12 && s.strip.includes('too big: 4'), `then F9 suspends for n == 4 (${JSON.stringify(s)})`);
  await press('F9');
  await h.finished(0);

  await t.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await h.openDialog();
  await h.clickRow('errors.AppError');
  const fit = await js(`(() => { const inside = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; };
    return ['.dialog', '#dbgBpList', '#dbgExcCondition', '#dbgBpRemove', '#dbgExcAdd'].every((s) => inside(document.querySelector(s))); })()`);
  check(fit, 'at 1008x681 the Breakpoints dialog and its exception fields are inside the window');
  await t.shot('breakpoints-small.png');
  await press('Escape');
  await t.cdp('Emulation.clearDeviceMetricsOverride');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
results.push(...t.results);
t.close();

try {
  const r = await launch({ fixture: 'debugger-exceptions', port: 9050, name: 'debugger-exceptions-restart', userData: t.userData, projectDir: t.project });
  try {
    await openFile(r, 'exc.py');
    await helpers(r).openDialog();
    const text = await helpers(r).listText();
    r.check(text.includes('Python Exception Breakpoints (7)') && text.includes('ValueError') && text.includes(`endswith('4')`) && text.includes('On termination'),
      `exception breakpoints are restored after a restart (${text})`);
    await r.press('Escape');
  } catch (err) {
    r.check(false, err.message);
  }
  results.push(...r.results);
  r.close();
} catch (err) {
  results.push({ ok: false, label: err.message });
}

const k = await launch({ fixture: 'debugger-exceptions', port: 9051, name: 'debugger-exceptions-ko', lang: 'ko-KR' });
try {
  const kh = helpers(k);
  await openFile(k, 'exc.py');
  await k.js(TRACK);
  await kh.openDialog();
  await kh.addClass('ValueError');
  await k.until(`document.querySelector('#dbgBpList').textContent.includes('ValueError')`, 'ValueError row (ko)');
  const text = await kh.listText();
  k.check(text.includes('Python 예외 중단점 (2)') && text.includes('모든 예외') && text.includes('발생 시'), `the exception group in Korean (${text})`);
  let leaks = await englishLeaks(k, '.dialog');
  k.check(leaks.length === 0, `no English in the Breakpoints dialog (${JSON.stringify(leaks)})`);
  await k.shot('breakpoints-ko.png');
  await kh.closeDialog();
  await kh.debug('exc.py');
  await kh.suspended(1);
  const s = (await k.js('window.__suspensions'))[0];
  k.check(s.strip.includes('ValueError: empty text') && s.strip.includes('발생 시'), `the exception strip in Korean (${s.strip})`);
  leaks = await englishLeaks(k, '#dbgException');
  k.check(leaks.length === 0, `no English in the exception strip (${JSON.stringify(leaks)})`);
  await k.shot('exception-stop-ko.png');
  await k.press('F9');
  await kh.finished(0);
  const missing = await missingTranslations(k);
  k.check(missing.length === 0, `every string has a Korean entry (${JSON.stringify(missing)})`);
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${JSON.stringify(k.consoleErrors)}` : ''}`);
} catch (err) {
  k.check(false, err.message);
  await k.shot('failure-ko.png');
}
results.push(...k.results);
k.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
