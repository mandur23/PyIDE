// Impatient users and failing programs around Run, Debug, the Python Console and Pyright: Rerun clicked twice or Stop
// clicked while the console starts, Run pressed again during Before launch tasks, Stop while a debug session starts, a
// debuggee that exits before debugpy listens, a script folder longer than Windows allows, and Pyright crashing.
// Ports 9286-9287.
import { execSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { launch, processSnapshot, descendants } from './lib.mjs';

const q = JSON.stringify;
const errorsNow = (t) => t.js(`ide.api.invoke('diagnostics:errors').then((list) => list.map((e) => e.message))`);

const t = await launch({ fixture: 'debugger', port: 9286, name: 'run-debug-edges' });
const { js, until, check, click, sleep } = t;
const P = (...f) => path.join(t.project, ...f);
const PYC_OUT = `document.querySelector('#pyconsoleOut').textContent`;
const DBG_OUT = `document.querySelector('#dbgOut').textContent`;
const RUN_OUT = `(ide.run.activeSession()?.con?.out.textContent || '')`;
const section = async (name, fn) => { try { await fn(); } catch (err) { check(false, `${name}: ${err.message}`); } };

await section('Python Console', async () => {
  // A sitecustomize that sleeps keeps each console process starting (no prompt yet) for a moment, deterministically.
  mkdirSync(P('slowstart'), { recursive: true });
  writeFileSync(P('slowstart', 'sitecustomize.py'), 'import time\ntime.sleep(1.5)\n');
  writeFileSync(P('.env'), `PYTHONPATH=${P('slowstart').replace(/\\/g, '/')}\n`);
  const consoleWorks = async (label) => {
    const ok = await until(`ide.pyconsole.isRunning() && ${PYC_OUT}.includes('Python 3')`, label, 20000).catch(() => false);
    if (!ok) return false;
    const answer = await js(`ide.pyconsole.evaluate('6 * 7')`).catch((e) => String(e));
    return answer === '42';
  };
  await js(`(ide.toolWindows.get('PythonConsole').show(), true)`);
  check(await consoleWorks('first console'), 'the Python Console starts');
  await click('[title="Rerun Python Console"]');
  await until(`ide.pyconsole.isRunning()`, 'the rerun console process exists', 10000);
  await sleep(150);
  await click('[title="Rerun Python Console"]');
  const works = await consoleWorks('console after a double Rerun');
  check(works, 'Rerun clicked twice while the console starts: the console runs and answers');
  // A wedged console stays wedged for the rest of the session: the rounds below cannot run.
  if (!works) return;
  await click('[title="Rerun Python Console"]');
  await until(`ide.pyconsole.isRunning()`, 'the rerun console process exists', 10000);
  await click('[title="Stop Console"]');
  await click('[title="Rerun Python Console"]');
  check(await consoleWorks('console after Stop while starting'), 'Stop while the console starts, then Rerun: the console runs and answers');
  for (let i = 0; i < 4; i++) {
    await click('[title="Rerun Python Console"]');
    await until(`ide.pyconsole.isRunning()`, 'the rerun console process exists', 10000);
    await click('[title="Stop Console"]');
  }
  await click('[title="Rerun Python Console"]');
  check(await consoleWorks('console after 4 Stop/Rerun rounds'), 'after four Rerun-then-Stop rounds the console still starts');
});
await js(`(ide.toolWindows.get('PythonConsole').hide(), true)`).catch(() => {});
rmSync(P('.env'), { force: true });

await section('Run pressed again while a Before launch task runs', async () => {
  writeFileSync(P('bl_main.py'), `with open(r"${P('bl-main.log')}", "a") as f:\n    f.write("ran\\n")\nprint("BL main ran")\n`);
  await js(`(() => {
    ide.run.configs().push({ id: 'cfg-bl', name: 'BL main', type: 'python', script: ${q(P('bl_main.py'))}, params: '', cwd: '', env: '',
      envFiles: '.env', interp: '', beforeLaunch: [{ kind: 'tool', name: 'Slow tool', program: ${q(process.execPath)}, args: '-e "setTimeout(() => {}, 1500)"' }] });
    ide.run.select('cfg-bl');
    return true;
  })()`);
  const notesBefore = await js(`ide.notifications.list().length`);
  await js(`(ide.run.runSelected(), true)`);
  await sleep(150);
  await js(`(ide.run.runSelected(), true)`);
  await until(`(${RUN_OUT}).includes('BL main ran') && (${RUN_OUT}).includes('exit code 0')`, 'BL main ran', 20000);
  await sleep(2500);
  const blNotes = await js(`ide.notifications.list().slice(${notesBefore}).map((e) => e.title + ' | ' + e.text)`);
  check(!blNotes.some((n) => /was not started/.test(n)), `Run pressed twice during a Before launch task: no "was not started" error (${q(blNotes)})`);
  const runs = existsSync(P('bl-main.log')) ? readFileSync(P('bl-main.log'), 'utf8').split('\n').filter(Boolean).length : 0;
  check(runs === 1, `the configuration ran once (${runs})`);
});

await section('Stop while a debug session starts', async () => {
  const errs0 = (await errorsNow(t)).length;
  for (const ms of [0, 100, 400]) {
    await js(`(ide.debugger.debugFile(${q(P('waiter.py'))}), true)`);
    if (ms) await sleep(ms);
    await js(`(ide.runAction('StopDebug'), true)`);
    await until(`!ide.debugger.isActive?.() && !document.querySelector('#debugBtn')?.disabled`, 'debug session ended', 15000).catch(() => {});
    await sleep(800);
  }
  const stopErrs = (await errorsNow(t)).slice(errs0);
  check(!stopErrs.some((m) => /Debugging stopped/.test(m)), `Stop while debugging starts (0, 100, 400 ms) records no internal error (${q(stopErrs)})`);
});

await section('A debuggee that exits before debugpy listens', async () => {
  const probe = await js(`ide.api.invoke('run:start', ide.currentInterp(), ${q(P('helper.py'))}, ${q(t.project)}, [], {}, [])`);
  await js(`(ide.proc.attach(${probe}, {}), true)`);
  const errs1 = (await errorsNow(t)).length;
  await js(`(() => { const i = ide.currentInterp();
    ide.debugger.debugFile(${q(P('main.py'))}, { interp: { ...i, args: [...i.args, '-c', 'import sys; sys.stderr.write("EARLY_EXIT_MARK\\\\n"); sys.exit(3)'] } });
    return true; })()`);
  const early = await until(`${DBG_OUT}.includes('exit code 3')`, 'the early exit shows', 30000).then(() => true, () => false);
  const dbgText = await js(DBG_OUT);
  check(early && dbgText.includes('EARLY_EXIT_MARK'), `a debuggee that exits before debugpy listens shows its own output and exit code (${q(dbgText.slice(-300))})`);
  check(!/ECONNREFUSED|Could not connect/.test(dbgText), 'and no connection error');
  await sleep(500);
  const earlyErrs = (await errorsNow(t)).slice(errs1);
  check(!earlyErrs.length, `and no internal error (${q(earlyErrs)})`);
  const replayed = await js(`(() => { const got = []; for (let id = ${probe} + 1; id <= ${probe} + 3; id++) ide.proc.attach(id, { data: (text) => got.push(text), exit: (c) => got.push('exit ' + c) }); return got; })()`);
  check(!replayed.some((x) => x.includes('EARLY_EXIT_MARK') || x === 'exit 3'), `its output is not left buffered (${q(replayed)})`);
});

await section('A script folder longer than Windows allows', async () => {
  let deep = t.project;
  while (deep.length < 300) deep = path.join(deep, 'abcdefghijklmnop');
  let deeper = deep;
  while (deeper.length < 560) deeper = path.join(deeper, 'abcdefghijklmnop');
  const script = 'import os\nprint("REAL=" + os.path.realpath(os.getcwd()))\n';
  for (const d of [deep, deeper]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'over.py'), script); }
  const realIn = (text) => /REAL=(.*)/.exec(text)?.[1]?.trim().toLowerCase();

  const runIn = async (dir) => {
    await js(`(ide.run.runContext(ide.run.types.get('python').forFile(${q(path.join(dir, 'over.py'))})), true)`);
    await until(`ide.run.activeSession()?.cfg?.script === ${q(path.join(dir, 'over.py'))} && (${RUN_OUT}).includes('Process finished')`, 'over.py finished', 30000).catch(() => {});
    return js(RUN_OUT);
  };
  let out = await runIn(deep);
  check(realIn(out) === deep.toLowerCase() && out.includes('exit code 0'), `Run in a ${deep.length}-character folder runs there (${q(out.slice(-300))})`);
  out = await runIn(deeper);
  check(realIn(out) === t.project.toLowerCase() && out.includes('exit code 0') && out.includes('longer than Windows allows'),
    `Run in a ${deeper.length}-character folder whose short form is too long runs in the project root and says so (${q(out.slice(-400))})`);

  const errs2 = (await errorsNow(t)).length;
  const debugIn = async (dir) => {
    await js(`(ide.debugger.debugFile(${q(path.join(dir, 'over.py'))}), true)`);
    await until(`${DBG_OUT}.includes(${q(path.join(dir, 'over.py'))}) && ${DBG_OUT}.includes('Process finished')`, 'debugged over.py finished', 40000).catch(() => {});
    return js(DBG_OUT);
  };
  out = await debugIn(deep);
  check(realIn(out) === deep.toLowerCase() && out.includes('exit code 0'), `Debug in a ${deep.length}-character folder runs there (${q(out.slice(-300))})`);
  out = await debugIn(deeper);
  check(realIn(out) === t.project.toLowerCase() && out.includes('exit code 0') && out.includes('longer than Windows allows'),
    `Debug in a folder whose short form is too long runs in the project root and says so (${q(out.slice(-400))})`);
  const longErrs = (await errorsNow(t)).slice(errs2);
  check(!longErrs.length, `long folders record no internal error (${q(longErrs)})`);
});
t.close();

// ---------- Pyright crashes ----------
const l = await launch({ fixture: 'lsp', port: 9287, name: 'run-debug-edges-lsp' });
const langserver = () => descendants(processSnapshot(), l.pid).filter((p) => p.cmd.includes('langserver.index.js')).map((p) => p.pid);
await (async () => {
  await l.js(`ide.openFile(ide.util.joinPath(ide.root, 'app.py'))`);
  await l.until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
  const restarted = [];
  for (let i = 1; i <= 6; i++) {
    const pids = langserver();
    for (const pid of pids) try { execSync(`taskkill /pid ${pid} /F`, { stdio: 'ignore' }); } catch {}
    await l.until(`ide.lsp.status() === 'error'`, `crash ${i} seen`, 15000);
    const back = await l.until(`ide.lsp.status() === 'ready'`, `restart ${i}`, 40000).then(() => true, () => false);
    restarted.push(back);
    if (!back) break;
  }
  l.check(restarted.slice(0, 5).length === 5 && restarted.slice(0, 5).every(Boolean), `Pyright killed: restarted automatically each time, 5 times (${q(restarted)})`);
  l.check(restarted[5] === false, 'after a 6th crash within 3 minutes it is not restarted again');
  const note = await l.js(`ide.notifications.list().map((e) => e.title + ' | ' + e.text).find((n) => n.includes('crashed')) || ''`);
  l.check(/crashed 6 times/.test(note), `a notification says so (${q(note)})`);
  if (!note) return;
  await l.js(`(() => { const e = ide.notifications.list().find((n) => n.text.includes('crashed')); e.actions.find((a) => a.label === 'Restart').run(e.note); return true; })()`);
  l.check(await l.until(`ide.lsp.status() === 'ready'`, 'restart from the notification', 40000).then(() => true, () => false), 'Restart in the notification starts Pyright again');
})().catch((err) => l.check(false, `Pyright crashes: ${err.message}`));
l.results.unshift(...t.results);
l.consoleErrors.unshift(...t.consoleErrors);
l.finish();
