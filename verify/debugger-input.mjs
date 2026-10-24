// Debugging a beginner's input() script: Shift+F9 gives the keyboard to the Debug console's input, so an answer typed
// right away (even before debugpy has started the program) reaches the program and never lands in the source file;
// focus moved away meanwhile stays where the user put it. A stop on a worker thread is labelled with that thread's
// name, not MainThread. Ports 9192-9193.
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const OUT = `document.querySelector('#dbgOut').textContent`;
const state = (t) => t.js(`window.__debugger.state()?.state || null`);

const k = await launch({ fixture: 'debugger', port: 9192, name: 'debugger-input-ko', lang: 'ko-KR' });
try {
  writeFileSync(path.join(k.project, 'ask.py'), "name = input('이름? ')\nprint('안녕하세요, ' + name)\n");
  await openFile(k, 'ask.py');
  await k.js(`(ide.editor.focus(), true)`);
  await k.until(`ide.editor.hasTextFocus()`, 'editor focused');
  const source = await k.js(`ide.editor.getModel().getValue()`);
  await k.press('Shift+F9');
  const early = await state(k);
  await k.type('철수');
  await k.press('Enter');
  k.check(early === 'starting', `the answer was typed while debugpy was still starting (${early})`);
  await k.until(`${OUT}.includes('안녕하세요, 철수')`, 'program received the answer', 30000);
  k.check(true, 'Korean: Shift+F9 on an input() script, typing 철수 Enter, the program receives 철수');
  k.check((await k.js(`ide.editor.getModel().getValue()`)) === source && !(await k.js(`ide.isDirty(ide.activeTab())`)), 'the source file is unchanged');
  k.check(await k.js(`${OUT}.includes('철수\\n')`), 'the typed answer is echoed in the Debug console');
  await k.until(`${OUT}.includes('종료 코드 0')`, 'program finished');

  await k.js(`(ide.editor.focus(), true)`);
  await k.press('Shift+F9');
  await k.until(`document.activeElement?.id === 'dbgIn'`, 'debug input has the keyboard');
  k.check(await state(k) === 'starting', 'the Debug console input takes the keyboard as soon as debugging starts');
  await k.js(`(ide.editor.focus(), true)`);
  await k.until(`window.__debugger.state()?.state === 'running'`, 'second session running', 30000);
  await k.sleep(300);
  k.check(await k.js(`ide.editor.hasTextFocus()`), 'focus moved back to the editor while debugpy started stays there');
  await k.press('Ctrl+F2');
  await k.until(`window.__debugger.state() === null`, 'second session stopped', 20000);
  k.check(k.consoleErrors.length === 0, 'no renderer exceptions (ko)');
} catch (err) {
  k.check(false, err.message);
}
k.close();

// ---------- thread name ----------
const t = await launch({ fixture: 'debugger', port: 9193, name: 'debugger-input' });
try {
  writeFileSync(path.join(t.project, 'threads.py'), [
    'import threading',
    '',
    'def work():',
    '    total = 0',
    '    for i in range(3):',
    '        total += i',
    '    return total',
    '',
    "worker = threading.Thread(target=work, name='worker-1')",
    'worker.start()',
    'worker.join()',
    "print('done')",
    '',
  ].join('\n'));
  await openFile(t, 'threads.py');
  for (const line of [4, 12]) {
    await t.js(`(ide.editor.setPosition({ lineNumber: ${line}, column: 1 }), ide.editor.focus(), true)`);
    await t.press('Ctrl+F8');
  }
  await t.press('Shift+F9');
  await t.until(`window.__debugger.state()?.state === 'suspended' && window.__debugger.state().frames[0]?.line === 4`, 'stopped in the worker', 30000);
  await t.until(`document.querySelector('.dbg-thread').textContent !== ''`, 'thread label');
  const worker = await t.js(`document.querySelector('.dbg-thread').textContent`);
  t.check(worker === 'worker-1 · breakpoint', `a stop on a worker thread names that thread (${worker})`);
  await t.press('F9');
  await t.until(`window.__debugger.state()?.state === 'suspended' && window.__debugger.state().frames[0]?.line === 12`, 'stopped in main', 30000);
  await t.until(`document.querySelector('.dbg-thread').textContent.startsWith('MainThread')`, 'main thread label', 5000).catch(() => {});
  const main = await t.js(`document.querySelector('.dbg-thread').textContent`);
  t.check(main === 'MainThread · breakpoint', `a stop on the main thread reads MainThread (${main})`);
  await t.press('F9');
  await t.until(`${OUT}.includes('Process finished with exit code 0')`, 'finished', 20000);
  t.check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  t.check(false, err.message);
}
for (const r of k.results) t.results.unshift(r);
t.close();
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
