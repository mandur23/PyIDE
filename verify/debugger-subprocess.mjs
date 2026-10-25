// Debugging a program that starts Python processes (subprocess.run with sys.executable, multiprocessing with Windows'
// spawn), with PyCharm's "Attach to subprocess automatically while debugging" (Settings › Python Debugger, on by
// default): a breakpoint in the child's code suspends the child, set before the session or while it runs; the process
// list in the Frames header names both processes; Step Over and Resume act on the child; its output is in the Debug
// console; a child that exits leaves the list; Stop ends the parent and a child it started; a program reached with
// Attach to Process has its children debugged too; off (unchecked on the Korean settings page), the children run
// without the debugger and nothing waits. Before 0.2.9 the session hung as soon as the child started. Ports 9370-9371.
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const OUT = `document.querySelector('#dbgOut').textContent`;
const st = `window.__debugger.state()`;
const stoppedAt = (file, line) => `${st}?.state === 'suspended' && ${st}.frames[0]?.path?.toLowerCase().endsWith(${JSON.stringify(`\\${file}`)}) && ${st}.frames[0]?.line === ${line}`;
const evaluate = async (t, expr) => (await t.js(`ide.debugger.evaluate(${JSON.stringify(expr)}).then((r) => r.value ?? r.error)`));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const FILES = {
  'parent.py': [
    'import os, subprocess, sys',
    'here = os.path.dirname(os.path.abspath(__file__))',
    "r = subprocess.run([sys.executable, os.path.join(here, 'child.py'), '7'])",
    "print('PARENT DONE', r.returncode, flush=True)",
    '',
  ],
  'child.py': [
    'import sys',
    'n = int(sys.argv[1])',
    'value = n * 6',
    "print('CHILD', value, flush=True)",
    'done = True',
    '',
  ],
  'mp_main.py': [
    'import multiprocessing as mp',
    '',
    '',
    'def work(n):',
    '    square = n * n',
    "    print('WORK', square, flush=True)",
    '',
    '',
    "if __name__ == '__main__':",
    '    p = mp.Process(target=work, args=(3,))',
    '    p.start()',
    '    p.join()',
    "    print('MP DONE', p.exitcode, flush=True)",
    '',
  ],
  'starter.py': [
    'import os, subprocess, sys',
    'here = os.path.dirname(os.path.abspath(__file__))',
    "print('STARTER', os.getpid(), flush=True)",
    "subprocess.Popen([sys.executable, os.path.join(here, 'looper.py')]).wait()",
    '',
  ],
  'host.py': [
    'import os, subprocess, sys, time',
    'here = os.path.dirname(os.path.abspath(__file__))',
    "while not os.path.exists(os.path.join(here, 'go.flag')):",
    '    time.sleep(0.1)',
    "subprocess.run([sys.executable, os.path.join(here, 'child.py'), '5'])",
    '',
  ],
  'looper.py': [
    'import os, time',
    "print('LOOPER', os.getpid(), flush=True)",
    'while True:',
    '    time.sleep(0.1)',
    '',
  ],
};

async function toggleBp(t, file, line) {
  await openFile(t, file);
  await t.js(`(ide.editor.setPosition({ lineNumber: ${line}, column: 1 }), ide.editor.focus(), true)`);
  await t.press('Ctrl+F8');
}

const t = await launch({ fixture: 'debugger', port: 9370, name: 'debugger-subprocess' });
try {
  for (const [name, lines] of Object.entries(FILES)) writeFileSync(path.join(t.project, name), lines.join('\n'));
  t.check(await t.js(`ide.settings.get('debugger.attachSubprocess', true) === true && !!ide.settingsPages.find((p) => p.id === 'python-debugger')`),
    'Settings › Python Debugger has "Attach to subprocess automatically while debugging", on by default');

  await toggleBp(t, 'parent.py', 3);
  await t.press('Shift+F9');
  await t.until(stoppedAt('parent.py', 3), 'stopped in the parent before it starts the child', 30000);
  await toggleBp(t, 'child.py', 3);
  await t.press('F9');
  await t.until(stoppedAt('child.py', 3), 'stopped in the child', 30000).catch(() => {});
  t.check(await t.js(stoppedAt('child.py', 3)), 'a breakpoint set during the session suspends the child process at child.py:3');
  t.check(await t.js(`${OUT}.includes('Attached to subprocess')`), 'the Debug console says the debugger attached to the subprocess');
  const list = await t.js(`[...document.querySelectorAll('#dbgProcesses option')].map((o) => o.textContent)`);
  t.check(await t.js(`!document.querySelector('#dbgProcesses').classList.contains('hidden')`) && list.length === 2
    && /^parent\.py \(pid \d+\) · Running$/.test(list[0]) && /^child\.py \(pid \d+\) · breakpoint$/.test(list[1]),
  `the Frames header lists both processes with their state (${JSON.stringify(list)})`);
  t.check(await t.js(`document.querySelector('#dbgProcesses').selectedIndex === 1`), 'the suspended child is the selected process');
  t.check(await evaluate(t, 'n') === '7', 'Variables and evaluation are the child\'s (n == 7)');
  await t.press('F8');
  await t.until(stoppedAt('child.py', 4), 'stepped in the child', 15000).catch(() => {});
  t.check(await t.js(stoppedAt('child.py', 4)) && await evaluate(t, 'value') === '42', 'Step Over runs the child\'s next line (value == 42)');
  await toggleBp(t, 'parent.py', 4);
  await t.press('F9');
  await t.until(stoppedAt('parent.py', 4), 'stopped in the parent after the child', 30000).catch(() => {});
  t.check(await t.js(stoppedAt('parent.py', 4)), 'Resume lets the child finish and the parent goes on to its next breakpoint');
  t.check(await t.js(`${OUT}.includes('CHILD 42')`), 'the child\'s output is in the Debug console');
  t.check(await t.js(`${st}.procs.length === 1 && document.querySelector('#dbgProcesses').classList.contains('hidden')`),
    'the child that exited left the process list');
  await t.press('F9');
  await t.until(`${OUT}.includes('Process finished with exit code 0')`, 'parent finished', 20000).catch(() => {});
  t.check(await t.js(`${OUT}.includes('PARENT DONE 0') && ${OUT}.includes('Process finished with exit code 0')`), 'the parent finishes with exit code 0');

  await toggleBp(t, 'mp_main.py', 5);
  await t.press('Shift+F9');
  await t.until(stoppedAt('mp_main.py', 5), 'stopped in the multiprocessing worker', 40000).catch(() => {});
  t.check(await t.js(stoppedAt('mp_main.py', 5)) && await t.js(`${st}.frames[0].name === 'work'`) && await evaluate(t, 'n') === '3',
    'multiprocessing (spawn): a breakpoint in the target function suspends the worker process (n == 3)');
  t.check(await t.js(`${st}.procs.length === 2 && ${st}.procs[1].child && ${st}.cur === ${st}.procs[1].id`), 'the worker is a second process of the session');
  await t.press('F9');
  await t.until(`${OUT}.includes('Process finished with exit code')`, 'multiprocessing finished', 30000).catch(() => {});
  t.check(await t.js(`${OUT}.includes('WORK 9') && ${OUT}.includes('MP DONE 0') && ${OUT}.includes('Process finished with exit code 0')`),
    'the worker finishes and the program ends with exit code 0');

  await toggleBp(t, 'looper.py', 4);
  await openFile(t, 'starter.py');
  await t.press('Shift+F9');
  await t.until(stoppedAt('looper.py', 4), 'stopped in the looping child', 30000).catch(() => {});
  t.check(await t.js(stoppedAt('looper.py', 4)), 'a child started with Popen stops at its breakpoint');
  const pids = await t.js(`[/STARTER (\\d+)/, /LOOPER (\\d+)/].map((re) => Number(re.exec(${OUT})?.[1]))`);
  await t.press('Ctrl+F2');
  await t.until(`${st} === null`, 'session stopped', 20000).catch(() => {});
  const end = Date.now() + 10000;
  while (Date.now() < end && pids.some(alive)) await t.sleep(200);
  t.check(pids.every(Boolean) && !pids.some(alive), `Stop ends the parent and the child it started (${pids.join(', ')})`);
  for (const pid of pids.filter(alive)) process.kill(pid);

  const exe = await t.js('ide.currentInterp()?.executable');
  const host = spawn(exe, [path.join(t.project, 'host.py')], { cwd: t.project, stdio: 'ignore', windowsHide: true });
  await t.js(`(ide.debugger.attachToProcess({ pid: ${host.pid} }), true)`);
  await t.until(`${st}?.attach === ${host.pid} && ${st}.state === 'running'`, 'attached to host.py', 60000);
  writeFileSync(path.join(t.project, 'go.flag'), '');
  await t.until(stoppedAt('child.py', 3), 'stopped in the attached process\'s child', 30000).catch(() => {});
  t.check(await t.js(stoppedAt('child.py', 3)) && await evaluate(t, 'n') === '5',
    'Attach to Process: a child the attached program starts stops at its breakpoint (n == 5)');
  await t.press('F9');
  await t.until(`${OUT}.includes('CHILD 30') && ${st}?.procs.length === 1`, 'child of the attached process finished', 20000).catch(() => {});
  t.check(await t.js(`${OUT}.includes('CHILD 30') && ${st}?.procs.length === 1`), 'its output is in the Debug console and it leaves the process list when it exits');
  await t.until(`${st} === null`, 'attached program finished', 20000).catch(() => {});
  t.check(await t.js(`${st} === null && ${OUT}.includes('Process ${host.pid} finished')`) && !alive(host.pid),
    `the attached program goes on, ends by itself and ends the session (${JSON.stringify((await t.js(OUT)).slice(-120))})`);
  if (alive(host.pid)) host.kill();
  t.check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? `: ${t.consoleErrors[0]}` : ''}`);
} catch (err) {
  t.check(false, err.message);
}
t.close();

const k = await launch({ fixture: 'debugger', port: 9371, name: 'debugger-subprocess-ko', lang: 'ko-KR' });
try {
  for (const [name, lines] of Object.entries(FILES)) writeFileSync(path.join(k.project, name), lines.join('\n'));
  await toggleBp(k, 'child.py', 3);
  await openFile(k, 'parent.py');
  await k.press('Shift+F9');
  await k.until(stoppedAt('child.py', 3), 'stopped in the child (ko)', 30000).catch(() => {});
  const list = await k.js(`[...document.querySelectorAll('#dbgProcesses option')].map((o) => o.textContent)`);
  k.check(await k.js(stoppedAt('child.py', 3)) && /^parent\.py \(PID \d+\) · 실행 중$/.test(list[0]) && /^child\.py \(PID \d+\) · 중단점$/.test(list[1])
    && await k.js(`/하위 프로세스 \\d+에 연결됨/.test(${OUT})`), `Korean: the process list and the console line (${JSON.stringify(list)})`);
  const leaks = await englishLeaks(k, '.dbg-pane-head');
  k.check(!leaks.length, `Korean: no English UI text in the Frames header (${leaks.join(' | ')})`);
  await k.press('F9');
  await k.until(`${OUT}.includes('종료 코드 0')`, 'finished (ko)', 30000).catch(() => {});

  await k.js(`(ide.openSettings('python-debugger'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'python-debugger'`, 'Python Debugger settings page');
  const box = '[data-key="debugger.attachSubprocess"]';
  k.check(await k.js(`document.querySelector('${box}')?.checked === true && document.querySelector('.settings-page').textContent.includes('디버그하는 동안 하위 프로세스에 자동으로 연결')`),
    'Settings › Python 디버거: "디버그하는 동안 하위 프로세스에 자동으로 연결" is checked');
  const setLeaks = await englishLeaks(k, '.settings-page');
  k.check(!setLeaks.length, `Korean: no English UI text on the settings page (${setLeaks.join(' | ')})`);
  await k.click(box);
  await k.click('#settingsOk');
  await k.until(`!document.querySelector('.settings-page')`, 'settings closed');
  k.check(await k.js(`ide.settings.get('debugger.attachSubprocess', true) === false`), 'unchecking it turns the setting off');
  await openFile(k, 'parent.py');
  await k.press('Shift+F9');
  await k.until(`${OUT}.includes('종료 코드')`, 'finished with the setting off', 30000).catch(() => {});
  k.check(await k.js(`${OUT}.includes('CHILD 42') && ${OUT}.includes('PARENT DONE 0') && ${OUT}.includes('종료 코드 0')`),
    'with the setting off the child runs without the debugger and the program finishes');
  k.check(await k.js(`!/하위 프로세스 \\d+에 연결됨/.test(${OUT}) && ${st} === null`), 'off: no subprocess attached, no stop in the child');
  const missing = (await missingTranslations(k)).filter((m) => /subprocess|process|debugger|pid/i.test(m));
  k.check(!missing.length, `no missing translations (${missing.join(' | ')})`);
  k.check(k.consoleErrors.length === 0, 'no renderer exceptions (ko)');
} catch (err) {
  k.check(false, err.message);
}
for (const r of k.results) t.results.push(r);
k.close();
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
