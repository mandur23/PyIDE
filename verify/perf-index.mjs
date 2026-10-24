// Go to Class right after a 3,000-module project opens (ports 9184-9185): how long the popup waits for the symbol
// index, what it shows meanwhile, and the same index built again later with warm disks as the control. Not in CI (it
// times things), like perf-bigfile.mjs.
//   node verify/perf-index.mjs [--port 9184]
// Medians of 5 runs each, interleaved with the code before the fix (16-thread laptop, other suites running):
//   classes listed after the project opened: 18.9 s -> 5.6 s (18.1-19.4 -> 5.5-5.8); the same index rebuilt later on:
//   3.2 s -> 1.2 s. Before, the popup said "Nothing found" meanwhile, the index waited for the TODO scan on the shared
//   search worker, and Python parsed its batches one at a time.
import { launch } from './lib.mjs';
import { cpus, tmpdir } from 'os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import path from 'path';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const PORT = Number(arg('port')) || 9184;
const BUDGET = { classesMs: 15000 };
const machineTimes = () => cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });

const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-perfidx-')), 'proj');
for (let p = 0; p < 30; p++) {
  const dir = path.join(project, `pkg${p}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '__init__.py'), '');
  for (let m = 0; m < 100; m++) {
    const lines = [`"""Module ${p}.${m}."""`, 'import os', ''];
    for (let c = 0; c < 3; c++) lines.push(`class Model${p}x${m}x${c}:`, '    def __init__(self, v):', '        self.v = v', '', '    def total(self, k):', `        return self.v * k + ${c}`, '', '');
    for (let f = 0; f < 4; f++) lines.push(`def helper_${p}_${m}_${f}(x):`, f === 0 && m % 10 === 0 ? '    # TODO: tidy' : '    pass', `    return x + ${f}`, '', '');
    writeFileSync(path.join(dir, `mod${m}.py`), `${lines.join('\n')}\n`);
  }
}

const m0 = machineTimes();
const t = await launch({ fixture: 'core', port: PORT, name: 'perf-index', projectDir: project });
const { js, until, check, sleep } = t;
const result = {};
const rows = `[...document.querySelectorAll('#popupList .popup-item:not(.hint)')].length`;
const hint = `(document.querySelector('#popupList .popup-item.hint')?.textContent || '')`;
try {
  await until('ide.root && ide.currentInterp()', 'project and interpreter');
  await js(`(() => { window.__todoScans = 0; const inv = ide.api.invoke; ide.api.invoke = function (ch) { if (ch === 'search:todos') __todoScans++; return inv.apply(this, arguments); }; return 1; })()`);
  // The smallest window the layout rules support.
  await t.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await until('innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1', 'viewport 1008x681');
  // The index Go to Class waits for, timed from the renderer (the popup is the user's view of the same wait; a test
  // window on a shared hidden desktop can lose focus, which closes it).
  const indexDone = async (label, shotName) => {
    await js(`(window.__idx = { t0: performance.now() }, ide.searchNav.symbols().then((s) => Object.assign(__idx, { ms: performance.now() - __idx.t0, n: s.length })), 1)`);
    await js(`(ide.runAction('GotoClass'), 1)`);
    await sleep(300);
    const shown = { hint: await js(hint), inside: await js(`(() => { const r = document.querySelector('#popupList .popup-item.hint')?.getBoundingClientRect(); return !!r && r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`) };
    if (shotName) await t.shot(shotName);
    await until('__idx.ms !== undefined', label, 180000);
    return { ...shown, ...(await js('__idx')) };
  };
  const listed = async () => {
    if (await js(`document.querySelector('#popup').classList.contains('hidden')`)) await js(`(ide.runAction('GotoClass'), 1)`);
    await until(`${rows} > 0`, 'Go to Class lists classes', 20000);
    const names = await js(`[...document.querySelectorAll('#popupList .popup-item:not(.hint) .label')].slice(0, 3).map((n) => n.textContent)`);
    await js(`document.querySelector('#popupIn').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    return names;
  };
  const first = await indexDone('symbol index after the project opened', 'indexing-1008x681.png');
  Object.assign(result, { hintWhileIndexing: first.hint, hintInside: first.inside, classesMs: Math.round(first.ms), symbols: first.n });
  result.firstRows = await listed();
  const m1 = machineTimes();
  result.machineBusyPct = Math.round(((m1.busy - m0.busy) / (m1.all - m0.all)) * 1000) / 10;
  result.todoScansWhileHidden = await js('__todoScans');

  // The TODO window scans when it is shown.
  const s0 = Date.now();
  await js(`(ide.runAction('ActivateTODOToolWindow'), 1)`);
  await until(`document.querySelectorAll('#snTodo .sn-todo').length > 0`, 'TODO items', 120000);
  result.todoShownMs = Date.now() - s0;
  result.todoItems = await js(`document.querySelectorAll('#snTodo .sn-todo').length`);

  // Control: the same index built again from nothing, a minute into the session.
  await sleep(5000);
  await js(`ide.api.invoke('search:invalidate', null)`);
  result.laterClassesMs = Math.round((await indexDone('symbol index again')).ms);
  await listed();

  // Search Everywhere during a rebuild: an "Indexing…" row where Classes will appear, then the classes.
  await js(`ide.api.invoke('search:invalidate', null)`);
  await js(`(ide.runAction('SearchEverywhere'), 1)`);
  await until(`!!document.querySelector('#seInput')`, 'Search Everywhere input', 10000);
  await js(`(() => { const i = document.querySelector('#seInput'); i.value = 'Model1x1x'; i.dispatchEvent(new Event('input')); return 1; })()`);
  result.seIndexing = await until(`!!document.querySelector('#seList .se-indexing')`, 'Indexing… row', 3000).then(() => true, () => false);
  await until(`!!document.querySelector('#seList .se-group[data-group="classes"]')`, 'Classes group', 30000);
  result.seIndexingGone = !(await js(`!!document.querySelector('#seList .se-indexing')`));
  console.log(`RESULT ${JSON.stringify(result)}`);

  check(/Indexing…/.test(result.hintWhileIndexing) && result.hintInside, `the popup says "Indexing…" while the index builds, inside a 1008x681 window (${result.hintWhileIndexing || 'nothing'})`);
  check(result.firstRows.length === 3 && result.firstRows.every((n) => /^Model\d+x\d+x\d$/.test(n)), `Go to Class lists the project's classes (${result.firstRows.join(', ')})`);
  check(result.classesMs < BUDGET.classesMs, `Go to Class lists classes ${result.classesMs} ms after the project opened (< ${BUDGET.classesMs}; ${result.laterClassesMs} ms later on)`);
  check(result.todoScansWhileHidden === 0, `no TODO scan while the TODO window stays hidden, from the IDE being ready on (${result.todoScansWhileHidden})`);
  check(result.seIndexing && result.seIndexingGone, `Search Everywhere shows "Indexing…" while the index rebuilds, then the Classes group (${result.seIndexing}, ${result.seIndexingGone})`);
  check(result.todoItems === 300, `the TODO window lists the project's 300 TODO comments once shown (${result.todoItems}, ${result.todoShownMs} ms)`);
} catch (err) {
  check(false, err.message);
}
t.finish();
