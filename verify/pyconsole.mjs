// Python Console input handling: lines typed before the interpreter's banner run after it in order, a statement
// reading input() gets the typed answer (no >>> prompt, not echoed as a command), and Interrupt (Ctrl+C in the input,
// the toolbar button) raises KeyboardInterrupt without losing the session, in English and Korean. Ports 9190-9191.
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';

const OUT = `document.querySelector('#pyconsoleOut').textContent`;
const PROMPT_SHOWN = `getComputedStyle(document.querySelector('#pyconsolePrompt')).visibility === 'visible'`;
const count = (t, word) => t.js(`${OUT}.split(${JSON.stringify(word)}).length - 1`);

// The project's .env puts a sitecustomize that sleeps on the console's PYTHONPATH, so the interpreter is running
// for a while before it prints its banner, deterministically.
function slowStart(project) {
  const dir = path.join(project, 'slowstart');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'sitecustomize.py'), 'import time\ntime.sleep(3)\n');
  writeFileSync(path.join(project, '.env'), `PYTHONPATH=${dir.replace(/\\/g, '/')}\n`);
}

async function enter(t, text) {
  if (text) await t.type(text);
  await t.press('Enter');
}

const t = await launch({ fixture: 'run-tools', port: 9190, name: 'pyconsole' });
const { js, until, check, press, sleep, click } = t;
try {
  slowStart(t.project);
  await js(`(ide.toolWindows.get('PythonConsole').show(), true)`);
  await until(`ide.pyconsole.isRunning()`, 'console process started', 20000);
  await js(`document.querySelector('#pyconsoleIn').focus()`);
  await enter(t, 'x = 6 * 7');
  await enter(t, 'x');
  check(!(await js(`${OUT}.includes('Python 3')`)), 'the lines were typed before the banner');
  await until(`${OUT}.includes('\\n42\\n')`, 'queued lines ran', 30000);
  const order = await js(`(() => { const o = ${OUT}; return [o.indexOf('Python 3'), o.indexOf('>>> x = 6 * 7\\n'), o.indexOf('>>> x\\n42\\n')]; })()`);
  check(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], `lines typed before the banner echo after it, each right before its result (${order})`);

  // ---------- input() ----------
  await until(PROMPT_SHOWN, 'prompt back');
  await enter(t, "name = input('Name? ')");
  await until(`${OUT}.endsWith('Name? ')`, 'input() prompt');
  await sleep(400);
  check(!(await js(PROMPT_SHOWN)), 'no >>> prompt while a statement waits for input()');
  await enter(t, 'Hong');
  await until(PROMPT_SHOWN, 'prompt after input()');
  await enter(t, 'print(name * 2)');
  await until(`${OUT}.includes('HongHong')`, 'the answer reached the program');
  check(await js(`${OUT}.includes('Name? Hong\\n') && !${OUT}.includes('>>> Hong')`), 'the answer is echoed after the program\'s prompt, not as a >>> command');
  check(await js(`[...document.querySelectorAll('#pyconsoleOut .stdin')].map(s => s.textContent).join('|') === 'Hong\\n'`), 'the answer is drawn as program input');

  // ---------- Interrupt ----------
  await enter(t, 'import time');
  await enter(t, 'time.sleep(60)');
  await sleep(800);
  check(!(await js(PROMPT_SHOWN)), 'no prompt while time.sleep runs');
  const before = Date.now();
  await press('Ctrl+c');
  await until(`${OUT}.includes('KeyboardInterrupt') && ${PROMPT_SHOWN}`, 'Ctrl+C interrupts', 10000);
  check(Date.now() - before < 5000, `Ctrl+C in the console input raises KeyboardInterrupt in time.sleep (${Date.now() - before} ms)`);
  await enter(t, 'x + 1');
  await until(`${OUT}.includes('>>> x + 1\\n43\\n')`, 'state kept');
  check(true, 'the session keeps its variables after an interrupt');
  check(await js(`ide.pyconsole.isRunning()`), 'Interrupt does not end the console');

  await enter(t, 'n = 0');
  await enter(t, 'while True: n += 1');
  await until(`document.querySelector('#pyconsolePrompt').textContent === '... '`, 'continuation prompt');
  await enter(t, '');
  await sleep(800);
  const interruptsBefore = await count(t, 'KeyboardInterrupt');
  check(await js(`document.querySelector('[data-action="pyconsoleInterrupt"]')?.title === 'Interrupt (Ctrl+C)'`), 'the toolbar has Interrupt (Ctrl+C)');
  await click('[data-action="pyconsoleInterrupt"]');
  await until(`${OUT}.split('KeyboardInterrupt').length - 1 > ${interruptsBefore} && ${PROMPT_SHOWN}`, 'toolbar interrupts', 10000);
  await js(`document.querySelector('#pyconsoleIn').focus()`);
  await enter(t, 'n > 1000');
  await until(`${OUT}.includes('>>> n > 1000\\nTrue\\n')`, 'loop ran');
  check(true, 'the toolbar button interrupts a busy loop');

  await enter(t, "answer = input()");
  await sleep(500);
  await press('Ctrl+c');
  await until(`${OUT}.split('KeyboardInterrupt').length - 1 > ${interruptsBefore + 1} && ${PROMPT_SHOWN}`, 'input() interrupted', 10000);
  check(true, 'Ctrl+C interrupts a statement waiting in input()');

  await enter(t, 'for i in range(3):');
  await until(`document.querySelector('#pyconsolePrompt').textContent === '... '`, 'block started');
  await js(`(() => { const i = document.querySelector('#pyconsoleIn'); i.value = 'print(i)'; i.select(); })()`);
  const atSelection = await count(t, 'KeyboardInterrupt');
  await press('Ctrl+c');
  await sleep(500);
  check((await count(t, 'KeyboardInterrupt')) === atSelection && (await js(`document.querySelector('#pyconsoleIn').value`)) === 'print(i)', 'Ctrl+C with a selection in the input copies instead of interrupting');
  await js(`(() => { const i = document.querySelector('#pyconsoleIn'); i.setSelectionRange(i.value.length, i.value.length); })()`);
  await press('Ctrl+c');
  await until(`${OUT}.split('KeyboardInterrupt').length - 1 > ${atSelection} && document.querySelector('#pyconsolePrompt').textContent === '>>> '`, 'block dropped');
  check((await js(`document.querySelector('#pyconsoleIn').value`)) === '', 'Ctrl+C at a continuation prompt drops the block being typed');
  await enter(t, 'i');
  await until(`${OUT}.includes("NameError")`, 'block never ran');
  check(true, 'the dropped block did not run');

  await click('[title="Stop Console"]');
  await until(`${OUT}.includes('Process finished') && !ide.pyconsole.isRunning()`, 'stopped');
  check(true, 'Stop Console still ends the interpreter');
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'run-tools', port: 9191, name: 'pyconsole-ko', lang: 'ko-KR' });
try {
  await k.press('Alt+8');
  await k.until(`ide.pyconsole.isRunning() && document.activeElement?.id === 'pyconsoleIn'`, 'ko console', 30000);
  await enter(k, "이름 = input('이름? ')");
  await k.until(`${OUT}.endsWith('이름? ')`, 'ko input() prompt');
  await k.sleep(400);
  k.check(!(await k.js(PROMPT_SHOWN)), 'Korean: no >>> while input() waits');
  await enter(k, '홍길동');
  await k.until(PROMPT_SHOWN, 'ko prompt back');
  await enter(k, "print(이름 + '님')");
  await k.until(`${OUT}.includes('홍길동님')`, 'ko answer');
  k.check(await k.js(`${OUT}.includes('이름? 홍길동\\n') && !${OUT}.includes('>>> 홍길동')`), 'Korean: 이름? 홍길동 reads as program input, not as a >>> command');
  k.check(await k.js(`document.querySelector('[data-action="pyconsoleInterrupt"]')?.title === '인터럽트 (Ctrl+C)'`), 'Korean: the Interrupt button is 인터럽트 (Ctrl+C)');
  await enter(k, 'import time; time.sleep(60)');
  await k.sleep(800);
  await k.press('Ctrl+c');
  await k.until(`${OUT}.includes('KeyboardInterrupt') && ${PROMPT_SHOWN}`, 'ko interrupt', 10000);
  await enter(k, '이름');
  await k.until(`${OUT}.includes("'홍길동'")`, 'ko state kept');
  k.check(true, 'Korean: Ctrl+C interrupts and the session keeps 이름');
  await k.shot('pyconsole-ko.png');
  await k.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await k.until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await k.sleep(300);
  k.check(await k.js(`(() => { const b = document.querySelector('[data-action="pyconsoleInterrupt"]').getBoundingClientRect(); return b.width > 0 && b.right <= innerWidth && b.bottom <= innerHeight; })()`), 'at 1008x681 the Interrupt button is shown');
  await enter(k, "input('? ')");
  await k.sleep(500);
  k.check(!(await k.js(PROMPT_SHOWN)) && await k.js(`document.querySelector('#pyconsoleIn').getBoundingClientRect().width > 200`), 'at 1008x681 the input stays usable while a statement waits');
  await enter(k, '네');
  await k.until(`${OUT}.includes("'네'")`, 'small answer');
  await k.shot('pyconsole-ko-small.png');
  k.check(k.consoleErrors.length === 0, 'no renderer exceptions (ko)');
} catch (err) {
  k.check(false, err.message);
}
for (const r of k.results) t.results.push(r);
k.close();
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
