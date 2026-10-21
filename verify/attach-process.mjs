// Run › Attach to Process (Ctrl+Alt+F5): attaches the debugger to a Python program started outside the IDE, hits a
// breakpoint, shows its variables, continues, detaches (the program keeps running), attaches again, and reports the
// error paths (a process that has exited, one that never runs Python code again) without hanging. Ports 9130-9139.
import { spawn, execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const require = createRequire(import.meta.url);
const attach = require('../main/features/debug-attach.js');

const started = [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

// ---- pure Node: how injector failures read ----
const results0 = [];
const check0 = (ok, label) => { results0.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
check0(attach.injectError(999999, '').message === 'Process 999999 is not running', 'a pid that is gone reads "is not running"');
check0(attach.injectError(process.pid, 'OSError: [WinError 5] Access is denied.').message === `Access denied: cannot attach to process ${process.pid}`,
  'WinError 5 from the injector reads "Access denied"');
check0(attach.injectError(process.pid, 'Traceback (most recent call last):\nRuntimeError: boom').message.endsWith('RuntimeError: boom'),
  'other injector failures keep their last line');
check0(JSON.stringify(attach.splitArgs('"C:\\Program Files\\Python\\python.exe" -u "C:\\a b\\x.py" --n 3')) === JSON.stringify(['C:\\Program Files\\Python\\python.exe', '-u', 'C:\\a b\\x.py', '--n', '3']),
  'command lines split like Windows does');

// ---- pure Node: version probe cache, own-process filter, ports ----
{
  const fails = () => Promise.resolve({ err: new Error('timed out'), stdout: '' });
  const works = () => Promise.resolve({ err: null, stdout: '3.12.1\n' });
  check0((await attach.pythonVersion('C:\\fake\\probe-python.exe', fails)) === null, 'a failed version probe reads null');
  check0((await attach.pythonVersion('C:\\fake\\probe-python.exe', works)) === '3.12.1', 'a failed version probe is not cached: the next probe runs');
  check0((await attach.pythonVersion('C:\\fake\\probe-python.exe', fails)) === '3.12.1', 'a successful version probe is cached');
  check0((await attach.pythonVersion('C:\\fake\\probe-throws.exe', () => Promise.reject(new Error('spawn')))) === null, 'a probe that throws reads null');

  const appDir = 'C:\\Apps\\PyIDE\\resources\\app';
  const userData = 'C:\\Users\\u\\AppData\\Roaming\\PyIDE';
  const own = attach.ownDirsFor({ appDir, unpackedDir: appDir, vendorDir: `${appDir}\\vendor`, userData, home: 'C:\\Users\\u' });
  check0(!own.some((d) => d.toLowerCase() === userData.toLowerCase()) && own.some((d) => /pyide[\\/]semantic$/i.test(d))
    && own.some((d) => /\.pyide$/i.test(d)), `own dirs are the sidecar folders, not all of userData (${own.join(' | ')})`);
  const py = 'C:\\Python312\\python.exe';
  const raw = [
    { pid: 101, ppid: 1, name: 'python.exe', exe: py, cmd: `"${py}" "${userData}\\scratches\\scratch_1.py"`, created: 'a' },
    { pid: 102, ppid: 1, name: 'python.exe', exe: py, cmd: `"${py}" -u "${appDir}\\renderer\\features\\pyconsole\\pyide_repl.py"`, created: 'b' },
    { pid: 103, ppid: 1, name: 'python.exe', exe: 'C:\\Users\\u\\.pyide\\semantic\\venv\\Scripts\\python.exe', cmd: 'C:\\Users\\u\\.pyide\\semantic\\venv\\Scripts\\python.exe -m embed', created: 'c' },
    { pid: 104, ppid: 1, name: 'python.exe', exe: py, cmd: `"${py}" "${userData}\\semantic\\worker.py"`, created: 'd' },
    { pid: 105, ppid: 1, name: 'python.exe', exe: py, cmd: `"${py}" "${appDir}-projects\\demo\\main.py"`, created: 'e' },
    { pid: 106, ppid: 1, name: 'python.exe', exe: py, cmd: `"${py}" prog.py`, created: 'f' },
    { pid: 107, ppid: 106, name: 'python.exe', exe: py, cmd: `"${py}" C:\\x\\debugpy\\adapter --for-server --port 99999`, created: 'g' },
    { pid: 108, ppid: 1, name: 'python.exe', exe: py, cmd: `"${py}" other.py`, created: 'h' },
    { pid: 109, ppid: 108, name: 'python.exe', exe: py, cmd: `"${py}" C:\\x\\debugpy\\adapter --for-server --port 5678`, created: 'i' },
  ];
  const shown = attach.filterProcesses(raw, { ownDirs: own });
  const pids = shown.map((p) => p.pid);
  check0(pids.includes(101), 'a scratch file running from <userData>/scratches is listed');
  check0(!pids.includes(102) && !pids.includes(103) && !pids.includes(104), `sidecars (app folder, ~/.pyide, <userData>/semantic) are not listed (${pids})`);
  check0(pids.includes(105), 'a folder that merely starts with the app folder name is not mistaken for it');
  check0(shown.find((p) => p.pid === 106)?.debugPort === null && shown.find((p) => p.pid === 108)?.debugPort === 5678,
    'a debugpy port out of range is ignored, a valid one is reported');
  check0(attach.validPort(5678) && !attach.validPort(0) && !attach.validPort(65536) && !attach.validPort(1.5) && !attach.validPort('5678'),
    'ports are validated as integers in 1-65535');
  let threw = '';
  try { await attach.inject({ exe: py, pid: 1, port: 70000 }); } catch (err) { threw = err.message; }
  check0(/Invalid debugger port/.test(threw), 'inject refuses an out-of-range port');
  // A Stop during the version probe never starts the injector.
  await attach.pythonVersion('C:\\fake\\stopped-python.exe', works);
  let spawned = false;
  threw = '';
  try {
    await attach.inject({ exe: 'C:\\fake\\stopped-python.exe', pid: process.pid, port: 5678, vendorDir: '', isStopped: () => true, onChild: () => { spawned = true; } });
  } catch (err) { threw = err.message; }
  check0(threw === 'Debugging stopped' && !spawned && attach.injectorCount() === 0, 'a Stop before injecting starts no injector');
}

// ---- pure Node: killTree ends the injector's helpers too ----
{
  const parent = spawn(process.execPath, ['-e',
    "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)"],
  { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
  const grandchild = await new Promise((r) => parent.stdout.once('data', (d) => r(Number(String(d).trim()))));
  const exited = new Promise((r) => parent.once('exit', r));
  attach.killTree(parent, { sync: true });
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  for (let i = 0; i < 30 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
  check0(!alive(parent.pid) && !alive(grandchild), 'killTree kills the injector and the helpers it started');
  if (alive(grandchild)) killTree(grandchild);
}

// ---- pure Node: debug:attach in main with a fake IPC (no Electron, ephemeral ports only) ----
{
  const { EventEmitter } = await import('events');
  const net = await import('net');
  const debug = require('../main/features/debug.js');
  const handlers = new Map();
  const app = new EventEmitter();
  app.getPath = () => 'C:\\fake-userdata';
  debug.register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, app, send: () => {}, startProcess: () => 0,
    killProcess: () => {}, procs: new Map(), vendorDir: 'C:\\fake-vendor', appDir: 'C:\\fake-app', unpackedDir: 'C:\\fake-app' });
  const invoke = (ch, ...args) => handlers.get(ch)({}, ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const real = { listProcesses: attach.listProcesses, inject: attach.inject };
  // A live pid that is not this process: a sleeping node child.
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const listed = (over = {}) => [{ pid: dummy.pid, ppid: 1, name: 'python.exe', exe: 'C:\\listed\\python.exe', interpreter: 'C:\\listed\\python.exe',
    cmd: 'python prog.py', args: ['prog.py'], cwd: null, created: 'T1', debugPort: null, version: '3.12.1', ...over }];
  const outcome = (p) => p.then(() => 'ok', (err) => err.message);
  try {
    // Stop while main is still looking the process up: no injection follows.
    let injected = 0;
    attach.listProcesses = () => sleep(300).then(() => listed());
    attach.inject = async () => { injected++; return { version: '3.12.1' }; };
    const a1 = outcome(invoke('debug:attach', { pid: dummy.pid }, [], { startKey: 'k1' }));
    await sleep(50);
    await invoke('debug:stop', null, 'k1');
    const t0 = Date.now();
    const r1 = await a1;
    check0(r1 === 'Debugging stopped' && Date.now() - t0 < 200, `Stop during the process lookup ends the attach at once (${r1})`);
    await sleep(400);
    check0(injected === 0, 'and nothing is injected after the lookup finishes');

    // Stop while injecting, the injection completes anyway: its port is remembered, so the next attach connects to it.
    let injectPort = 0;
    let injectExe = '';
    attach.listProcesses = async () => listed();
    attach.inject = async ({ port, exe, onChild }) => { injectPort = port; injectExe = exe; onChild?.({ pid: undefined }); await sleep(300); return { version: '3.12.1' }; };
    const a2 = outcome(invoke('debug:attach', { pid: dummy.pid, exe: 'C:\\evil\\renderer.exe', debugPort: 1 }, [], { startKey: 'k2' }));
    await sleep(100);
    await invoke('debug:stop', null, 'k2');
    check0((await a2) === 'Debugging stopped', 'Stop during injection ends the attach');
    check0(injectExe === 'C:\\listed\\python.exe', `the interpreter comes from main's listing, not from the renderer (${injectExe})`);
    await sleep(400);
    let connections = 0;
    const server = net.createServer((s) => { connections++; s.on('error', () => {}); });
    await new Promise((r, j) => { server.once('error', j); server.listen(injectPort, '127.0.0.1', r); });
    try {
      injected = 0;
      attach.inject = async () => { injected++; throw new Error('sentinel inject'); };
      const a3 = outcome(invoke('debug:attach', { pid: dummy.pid }, [], { startKey: 'k3' }));
      for (let i = 0; i < 40 && !connections; i++) await sleep(50);
      check0(connections === 1 && injected === 0, 'an injection that completed after a Stop is reused: the next attach connects without injecting');
      await invoke('debug:stop', null, 'k3');
      check0((await a3) === 'Debugging stopped', 'Stop during the DAP handshake ends that attach');

      // The same pid with another start time is another process: its remembered port is not used.
      attach.listProcesses = async () => listed({ created: 'T2' });
      const a5 = await outcome(invoke('debug:attach', { pid: dummy.pid }, [], { startKey: 'k5' }));
      check0(a5 === 'sentinel inject' && connections === 1, `a reused pid (another start time) is injected afresh, not connected to the old port (${a5}, ${connections} connections)`);
    } finally { server.close(); }

    // The renderer's start time must match the process main finds under that pid.
    attach.listProcesses = async () => listed({ created: 'T2' });
    const a6 = await outcome(invoke('debug:attach', { pid: dummy.pid, created: 'T1' }, [], {}));
    check0(a6 === `Process ${dummy.pid} is not running`, `a pid now naming a process started at another time is refused (${a6})`);
    attach.listProcesses = async () => [];
    const a7 = await outcome(invoke('debug:attach', { pid: dummy.pid }, [], {}));
    check0(a7 === `Process ${dummy.pid} is not running`, 'a pid missing from main\'s listing is refused');

    // Quitting PyIDE aborts an attach in progress.
    attach.listProcesses = () => sleep(300).then(() => listed({ created: 'T3' }));
    const a8 = outcome(invoke('debug:attach', { pid: dummy.pid }, [], {}));
    await sleep(50);
    app.emit('will-quit');
    check0((await a8) === 'Debugging stopped', 'will-quit aborts a pending attach');
  } catch (err) {
    check0(false, `main-side attach checks: ${err.stack || err.message}`);
  } finally {
    Object.assign(attach, real);
    killTree(dummy.pid);
  }
}

const t = await launch({ fixture: 'attach-process', port: 9130, env: { PYIDE_ATTACH_TIMEOUT_MS: '8000' } });
const { js, until, press, type, click, check, shot } = t;
for (const ok of results0) t.results.push({ ok, label: 'pure node' });

const state = () => js('window.__debugger.state()');
const consoleText = () => js(`document.querySelector('#dbgOut').textContent`);
const varsText = () => js(`document.querySelector('#dbgVars').textContent`);
const counterValue = async () => Number(/counter = \{int\} (\d+)/.exec(await varsText())?.[1]);
const stoppedAt = (file, line, ms) => until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx];
  return f && f.path?.toLowerCase().endsWith(${JSON.stringify(file)}) && f.line === ${line}; })()`, `suspended at ${file}:${line}`, ms);
const cursorTo = (line) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 5 }))`);
const bpLines = () => js(`window.__debugger.breakpoints().map(b => b.line).join()`);
const rowsText = () => js(`[...document.querySelectorAll('#dbgAttachList .dbg-attach-row')].map(r => r.dataset.pid + ' ' + r.title)`);

// Starts a fixture script outside the IDE with the project interpreter.
function startOutside(exe, script) {
  const child = spawn(exe, [path.join(t.project, script)], { cwd: t.project, stdio: 'ignore', windowsHide: true });
  started.push(child.pid);
  return child;
}
// Opens Attach to Process, waits for the row of `script`, filters down to it and returns its pid (a venv launcher's
// child is the one listed).
async function openDialogFor(script) {
  await press('Ctrl+Alt+F5');
  await until(`!!document.querySelector('#dbgAttachFilter')`, 'Attach to Process dialog');
  await until(`[...document.querySelectorAll('#dbgAttachList .dbg-attach-row')].some(r => r.title.toLowerCase().includes(${JSON.stringify(script)}))`, `${script} listed`, 20000);
  await js(`document.querySelector('#dbgAttachFilter').focus()`);
  await type(script);
  await until(`document.querySelectorAll('#dbgAttachList .dbg-attach-row').length >= 1 && [...document.querySelectorAll('#dbgAttachList .dbg-attach-row')].every(r => r.title.toLowerCase().includes(${JSON.stringify(script)}))`, 'filtered list');
  return Number(await js(`document.querySelector('#dbgAttachList .dbg-attach-row.selected')?.dataset.pid`));
}

let target;
try {
  const exe = await js('ide.currentInterp()?.executable');
  check(!!exe, `project interpreter found (${exe})`);
  target = startOutside(exe, 'counter.py');
  await t.sleep(1000);
  check(alive(target.pid), `counter.py runs outside the IDE (pid ${target.pid})`);

  await openFile(t, 'counter.py');
  await cursorTo(5);
  await press('Ctrl+F8');
  check((await bpLines()) === '5', 'breakpoint set on counter.py:5');

  // ---- the dialog lists the process, project processes first ----
  await press('Ctrl+Alt+F5');
  await until(`!!document.querySelector('#dbgAttachFilter')`, 'Attach to Process dialog');
  check(true, 'Ctrl+Alt+F5 opens Attach to Process');
  check(await js(`document.activeElement?.id === 'dbgAttachFilter'`), 'the filter field has the keyboard');
  await until(`[...document.querySelectorAll('#dbgAttachList .dbg-attach-row')].some(r => r.title.toLowerCase().includes('counter.py'))`, 'counter.py listed', 20000);
  const firstGroup = await js(`document.querySelector('#dbgAttachList .dbg-attach-group')?.textContent`);
  const firstRow = await js(`document.querySelector('#dbgAttachList .dbg-attach-row')?.title`);
  check(firstGroup === 'In this project' && firstRow.toLowerCase().includes('counter.py'), `the project's process comes first (${firstGroup}: ${firstRow})`);
  const listed = await rowsText();
  check(!listed.some((r) => /debugpy|pyide_repl|embed_server|complete_server|refactor_server|kernel_bridge/i.test(r)), 'no PyIDE sidecars or debugpy adapters listed');
  check(await js(`[...document.querySelectorAll('#dbgAttachList .dbg-attach-interp')].some(n => /Python \\d+\\.\\d+/.test(n.textContent))`), 'rows show the interpreter version');
  await shot('dialog.png');
  await js(`document.querySelector('#dbgAttachFilter').focus()`);
  await type('counter.py');
  await until(`[...document.querySelectorAll('#dbgAttachList .dbg-attach-row')].every(r => r.title.toLowerCase().includes('counter.py'))`, 'filtered to counter.py');
  await type(' zzz-no-such');
  await until(`document.querySelector('#dbgAttachStatus').textContent === 'Nothing matches the filter'`, 'empty filter result');
  check(true, 'typing filters the list');
  await js(`(() => { const f = document.querySelector('#dbgAttachFilter'); f.value = 'counter.py'; f.dispatchEvent(new Event('input')); })()`);
  await until(`!!document.querySelector('#dbgAttachList .dbg-attach-row.selected')`, 'row selected');
  const pid = Number(await js(`document.querySelector('#dbgAttachList .dbg-attach-row.selected').dataset.pid`));
  check(pid === target.pid || alive(pid), `selected pid ${pid}`);

  // ---- Enter attaches; the breakpoint hits ----
  const t0 = Date.now();
  await press('Enter');
  await until(`!document.querySelector('#dbgAttachFilter')`, 'dialog closed');
  await stoppedAt('counter.py', 5, 30000);
  check(true, `attached and suspended at counter.py:5 after ${Date.now() - t0} ms`);
  check((await state()).attach === pid, 'the session is an attach session');
  await until(`/counter = \\{int\\} \\d+/.test(document.querySelector('#dbgVars').textContent)`, 'counter variable');
  const c1 = await counterValue();
  check(c1 >= 0, `Variables show the counter (counter = ${c1})`);
  const frames = await js(`[...document.querySelectorAll('#dbgFrames .dbg-frame')].map(f => f.textContent)`);
  check(frames[0] === 'tick, counter.py:5' && frames.some((f) => f.startsWith('main, counter.py')), `Frames show the running program (${frames.slice(0, 2).join(' | ')})`);
  check((await consoleText()).includes(`Attached to process ${pid}`), 'console says it attached');
  check(await js(`document.querySelector('#dbgStop').title.startsWith('Detach')`), 'Stop reads Detach for an attached process');
  await shot('suspended.png');

  // ---- evaluate in the frame, continue, hit again with a larger counter ----
  check((await js(`ide.debugger.evaluate('counter * 2')`)).value === String(c1 * 2), 'expressions evaluate in the attached frame');
  await press('F9');
  await until(`(() => { const m = /counter = \\{int\\} (\\d+)/.exec(document.querySelector('#dbgVars').textContent); return window.__debugger.state()?.state === 'suspended' && m && Number(m[1]) > ${c1}; })()`, 'next hit with a larger counter');
  const c2 = await counterValue();
  check(c2 > c1, `F9 continues and the breakpoint hits again (counter ${c1} -> ${c2})`);
  await press('F8');
  await stoppedAt('counter.py', 6);
  check(true, 'F8 steps in the attached process');

  // ---- remove the breakpoint, resume, see output, detach ----
  await cursorTo(5);
  await press('Ctrl+F8');
  await press('F9');
  await until(`window.__debugger.state()?.state === 'running'`, 'running');
  await until(`/tick \\d+/.test(document.querySelector('#dbgOut').textContent)`, 'program output in the console', 10000);
  check(true, "the program's output shows in the Debug console");
  await press('Ctrl+F2');
  await until(`!window.__debugger.state()`, 'session ended');
  check((await consoleText()).includes(`Detached from process ${pid}`), 'Ctrl+F2 detaches');
  await t.sleep(1500);
  check(alive(pid) && target.exitCode === null, 'the target process is still alive after Detach');

  // ---- attach again (its debugpy is already listening) and detach with the toolbar button ----
  await cursorTo(5);
  await press('Ctrl+F8');
  const pid2 = await openDialogFor('counter.py');
  check(pid2 === pid, 'the same process is listed again');
  check(await js(`!!document.querySelector('#dbgAttachList .dbg-attach-row.selected .dbg-attach-tag')`), 'it is marked as having debugpy listening');
  const t1 = Date.now();
  await click('#dbgAttachDialog .dialog-buttons .primary');
  await stoppedAt('counter.py', 5, 20000);
  check(true, `re-attached and suspended again after ${Date.now() - t1} ms`);
  await until(`/counter = \\{int\\} \\d+/.test(document.querySelector('#dbgVars').textContent)`, 'counter variable again');
  check((await counterValue()) > c2, 'the counter kept counting while detached');
  await click('#dbgStop');
  await until(`!window.__debugger.state()`, 'session ended by the Stop button');
  await t.sleep(1500);
  check(alive(pid), 'the Stop button detached without killing the process');
  killTree(target.pid);
  await t.sleep(500);
  check(!alive(pid), 'only the test process was killed');

  // ---- error: the process exits between listing and attaching ----
  const quick = startOutside(exe, 'quick.py');
  const quickPid = await openDialogFor('quick.py');
  const exited = new Promise((r) => (quick.exitCode !== null ? r() : quick.once('exit', r)));
  await exited;
  for (let i = 0; i < 40 && alive(quickPid); i++) await t.sleep(100);
  const t2 = Date.now();
  await press('Enter');
  await until(`document.querySelector('#dbgOut').textContent.includes('Cannot attach to process ${quickPid}')`, 'attach error', 15000);
  const errText = await consoleText();
  check(errText.includes(`Process ${quickPid} is not running (it may have exited)`), `attaching to an exited process says so (${errText.trim().split('\n').pop()})`);
  check(Date.now() - t2 < 10000 && !(await state()), 'the error ends the attempt without a session');

  // ---- error: the target never runs Python code again (injection timeout) ----
  const blocked = startOutside(exe, 'blocked.py');
  await t.sleep(800);
  const blockedPid = await openDialogFor('blocked.py');
  const t3 = Date.now();
  await press('Enter');
  await until(`document.querySelector('#dbgOut').textContent.includes('Cannot attach to process ${blockedPid}')`, 'timeout error', 40000);
  const toText = (await consoleText()).trim().split('\n').pop();
  check(/did not start the debugger within 8 seconds/.test(toText), `a target that never runs Python code times out with a message (${toText}, ${Date.now() - t3} ms)`);
  check(!(await state()), 'no session is left behind');
  killTree(blocked.pid);

  const missing = await missingTranslations(t);
  const mine = missing.filter((s) => /attach|process|detach|debugpy|inject|filter|interpreter/i.test(s));
  check(mine.length === 0, `Attach to Process strings are translated${mine.length ? `: ${mine.join(' | ')}` : ''}`);
  check(await js(`ide.actions.some(a => a.id === 'AttachToProcess' && a.keys.includes('Ctrl+Alt+F5'))`), 'AttachToProcess action owns Ctrl+Alt+F5');
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
} finally {
  for (const pid of started) if (alive(pid)) killTree(pid);
}
t.finish();
