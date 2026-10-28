// Performance budgets on a generated 20,000-file project (100 packages x 100 files, plus one 10,000-file folder).
// Prints every number and writes them to verify/out/perf/results.json; a budget miss fails the run.
// PERF_RUNS=n sets the number of measured startups (default 3, after one unmeasured warm-up launch);
// PERF_ONLY=startup stops after the startup measurements.
import { descendants, launch, processSnapshot } from './lib.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const PKGS = 100;
const PER_PKG = 100;
const WIDE = 10000;
const RUNS = Number(process.env.PERF_RUNS || 3);
const BUDGET = { readyMs: 1500, treeMs: 1500, expandMs: 100, ipcBlockMs: 100, todosMs: 2000 };

function generateProject() {
  const dir = path.join(tmpdir(), 'pyide-perf-20k');
  if (existsSync(path.join(dir, '.generated'))) return dir;
  for (let p = 0; p < PKGS; p++) {
    const pkg = path.join(dir, `pkg${String(p).padStart(3, '0')}`);
    mkdirSync(pkg, { recursive: true });
    for (let f = 0; f < PER_PKG; f++) {
      writeFileSync(path.join(pkg, `mod${String(f).padStart(3, '0')}.py`), `def f${f}():\n    return ${p * PER_PKG + f}  # needle${f % 7}\n`);
    }
  }
  mkdirSync(path.join(dir, 'wide'), { recursive: true });
  for (let i = 0; i < WIDE; i++) writeFileSync(path.join(dir, 'wide', `w${String(i).padStart(5, '0')}.py`), `x = ${i}\n`);
  writeFileSync(path.join(dir, 'main.py'), 'print("perf")\n');
  writeFileSync(path.join(dir, '.generated'), '');
  return dir;
}

// Working set of a process and all its descendants (electron renderers/GPU, node workers, Python sidecars), by
// process kind (electron's --type flag, or the executable name).
function treeMemory(rootPid) {
  const out = descendants(processSnapshot(), rootPid, { includeRoot: true });
  const byName = {};
  for (const p of out) {
    const kind = p.name === 'electron.exe' ? `electron ${/--type=([\w-]+)/.exec(p.cmd)?.[1] || 'main'}` : p.name;
    byName[kind] = Math.round(((byName[kind] || 0) + p.workingSet / 1048576) * 10) / 10;
  }
  return { totalMB: Math.round(out.reduce((s, p) => s + p.workingSet, 0) / 1048576), processes: out.length, byName };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 10) / 10;
const stats = (xs) => ({ median: round(median(xs)), min: round(Math.min(...xs)), max: round(Math.max(...xs)), runs: xs.length });

const project = generateProject();
const results = { project, startup: [], memory: null };

async function startOnce(port, userData) {
  const ctx = await launch({ fixture: 'perf', name: 'perf', port, projectDir: project, userData });
  const m = await ctx.js(`(() => {
    const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('pyide:')).map((m) => [m.name, m.startTime]));
    const names = [...document.querySelectorAll('#tree .node .name')].map((n) => n.textContent);
    return { origin: performance.timeOrigin, marks, listed: names.includes('pkg000') && names.includes('pkg001') };
  })()`);
  const sinceLaunch = (mark) => m.origin + m.marks[mark] - ctx.spawnedAt;
  return { ctx, run: { launchToReady: sinceLaunch('pyide:ready'), launchToTree: sinceLaunch('pyide:tree'), navToReady: m.marks['pyide:ready'],
    monaco: m.marks['pyide:monaco'], features: m.marks['pyide:features'] - m.marks['pyide:monaco'], listed: m.listed } };
}

// Measured startups reuse the warm-up launch's profile (settings, Chromium code cache), like a user's restart.
const warmup = await startOnce(9770);
results.firstLaunch = warmup.run;
console.log(`first launch (fresh profile): ${JSON.stringify(warmup.run)}`);
await warmup.ctx.sleep(3000);
warmup.ctx.close();
let ctx;
for (let i = 0; i < RUNS; i++) {
  const s = await startOnce(9771 + i, warmup.ctx.userData);
  results.startup.push(s.run);
  if (i < RUNS - 1) s.ctx.close(); else ctx = s.ctx;
}
const { js, check, sleep } = ctx;
for (const key of ['launchToReady', 'launchToTree', 'navToReady', 'monaco', 'features']) {
  results[key] = stats(results.startup.map((r) => r[key]));
  console.log(`${key}: ${JSON.stringify(results[key])}`);
}
check(results.startup.every((r) => r.listed), 'startup tree lists the project');
check(results.launchToReady.median < BUDGET.readyMs, `renderer ready ${results.launchToReady.median} ms after launch < ${BUDGET.readyMs} ms`);
if (process.env.PERF_ONLY === 'startup') ctx.finish();

// Time from a click on a tree row until the rows named `probe` change count: `dom` when the DOM changes, `frame`
// through the next frame. The row is found by scrolling from the top, since a virtualized tree draws only the rows
// in view.
const clickRow = (name, probe) => js(`(async () => {
  const tree = document.getElementById('tree');
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const count = () => [...document.querySelectorAll('#tree .node .name')].filter((n) => n.textContent === ${JSON.stringify(probe)}).length;
  const find = () => [...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name')?.textContent === ${JSON.stringify(name)});
  tree.scrollTop = 0;
  await frame();
  while (!find() && tree.scrollTop + tree.clientHeight < tree.scrollHeight) { tree.scrollTop += tree.clientHeight / 2; await frame(); }
  find()?.scrollIntoView({ block: 'nearest' });
  await frame();
  const row = find();
  if (!row) return { frame: -1, dom: -1 };
  const before = count();
  let dom = 0;
  const watch = new MutationObserver(() => { if (!dom && count() !== before) dom = performance.now() - t0; });
  watch.observe(tree, { childList: true, subtree: true });
  const t0 = performance.now();
  row.click();
  await new Promise((resolve) => { const tick = () => (count() !== before || performance.now() - t0 > 10000 ? resolve() : requestAnimationFrame(tick)); tick(); });
  watch.disconnect();
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  return { frame: performance.now() - t0, dom };
})()`);

// Opening the project from the welcome screen: until its first folder row is drawn, through the next frame.
const reopen = [];
for (let i = 0; i < RUNS; i++) {
  reopen.push(await js(`(async () => {
    const root = ide.root;
    await ide.closeProject();
    const t0 = performance.now();
    const opened = ide.openProject(root);
    const listed = () => [...document.querySelectorAll('#tree .node .name')].some((n) => n.textContent === 'pkg000');
    await new Promise((resolve) => { const tick = () => (listed() || performance.now() - t0 > 10000 ? resolve() : requestAnimationFrame(tick)); tick(); });
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    const ms = performance.now() - t0;
    await opened;
    return listed() ? ms : -1;
  })()`));
  await sleep(300);
}
results.reopenTree = stats(reopen);
console.log(`reopenTree: ${JSON.stringify(results.reopenTree)}`);
check(reopen.every((t) => t > 0) && results.reopenTree.median < BUDGET.treeMs, `tree visible ${results.reopenTree.median} ms after opening the project < ${BUDGET.treeMs} ms`);

await clickRow('pkg010', 'mod000.py');
await clickRow('pkg020', 'mod000.py');
const expand = [];
const collapse = [];
for (let i = 0; i < 5; i++) {
  expand.push(await clickRow('pkg050', 'mod000.py'));
  collapse.push(await clickRow('pkg050', 'mod000.py'));
}
results.expand = stats(expand.map((r) => r.frame));
results.expandDom = stats(expand.map((r) => r.dom));
results.collapse = stats(collapse.map((r) => r.frame));
results.collapseDom = stats(collapse.map((r) => r.dom));
console.log(`expand (two 100-file folders open): ${JSON.stringify(results.expand)}, DOM updated ${JSON.stringify(results.expandDom)}`);
console.log(`collapse: ${JSON.stringify(results.collapse)}, DOM updated ${JSON.stringify(results.collapseDom)}`);
check(expand.every((r) => r.frame > 0), 'expanding pkg050 shows its files');
check(results.expand.median < BUDGET.expandMs, `expand ${results.expand.median} ms < ${BUDGET.expandMs} ms`);
check(results.collapse.median < BUDGET.expandMs, `collapse ${results.collapse.median} ms < ${BUDGET.expandMs} ms`);

results.expandWide = await clickRow('wide', 'w00000.py');
console.log(`expand 10,000-file folder: ${round(results.expandWide.frame)} ms, DOM updated ${round(results.expandWide.dom)} ms`);
results.wideDomRows = await js(`document.querySelectorAll('#tree .node').length`);
const wideExpand = [];
for (let i = 0; i < 5; i++) {
  wideExpand.push((await clickRow('pkg050', 'mod000.py')).frame);
  await clickRow('pkg050', 'mod000.py');
}
results.expandWithWideOpen = stats(wideExpand);
console.log(`expand with the 10,000-file folder open: ${JSON.stringify(results.expandWithWideOpen)}, DOM rows ${results.wideDomRows}`);
check(results.expandWithWideOpen.median < BUDGET.expandMs, `expand with a 10,000-file folder open ${results.expandWithWideOpen.median} ms < ${BUDGET.expandMs} ms`);

// Scrolling through the wide folder: frame-to-frame times while the tree scrolls 300 px per frame.
results.scroll = await js(`(async () => {
  const tree = document.getElementById('tree');
  const frames = [];
  let last = performance.now();
  for (let i = 0; i < 180; i++) {
    tree.scrollTop += 300;
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    frames.push(now - last);
    last = now;
  }
  frames.sort((a, b) => a - b);
  const visible = [...tree.querySelectorAll('.node .name')].some((n) => /^w\\d{5}\\.py$/.test(n.textContent));
  return { p50: frames[90], p95: frames[171], max: frames[179], visible, scrollTop: tree.scrollTop };
})()`);
console.log(`scroll frames: ${JSON.stringify(results.scroll)}`);
check(results.scroll.visible && results.scroll.p95 < 50, `scrolling the 10,000-file folder keeps frames short (p95 ${round(results.scroll.p95)} ms)`);
await js(`document.getElementById('tree').scrollTop = 0`);
await clickRow('wide', 'w00000.py');

// The longest wait of a trivial IPC call (fs:exists) while `call` runs in the main process.
const blocking = (label, call) => js(`(async () => {
  let max = 0, n = 0, done = false;
  const ping = (async () => {
    while (!done) {
      const t = performance.now();
      await api.exists(ide.root);
      max = Math.max(max, performance.now() - t);
      n++;
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const result = await ${call};
  const ms = performance.now() - t0;
  done = true;
  await ping;
  return { ms, maxPing: max, pings: n, result };
})()`);
const QUERY = `{ query: 'needle3', caseSensitive: false, words: false, regex: false, mask: '', dir: null, replacement: '' }`;
const find = await blocking('find', `api.invoke('search:invalidate', null).then(() => api.invoke('search:find', ide.root, ${QUERY}, {})).then((r) => ({ count: r.count, files: r.files.length, truncated: !!r.truncated }))`);
results.findInPath = find;
console.log(`Find in Path: ${round(find.ms)} ms, longest IPC wait ${round(find.maxPing)} ms over ${find.pings} pings, ${JSON.stringify(find.result)}`);
check(find.result.count > 0, 'Find in Path found matches');
check(find.maxPing < BUDGET.ipcBlockMs, `Find in Path blocks a trivial IPC call for at most ${round(find.maxPing)} ms < ${BUDGET.ipcBlockMs} ms`);

for (const [label, call] of [
  ['walk (Go to File)', `api.walk(ide.root).then((r) => r.length)`],
  ['interpreters', `api.interpreters(ide.root, []).then((r) => r.length)`],
  ['todos', `api.invoke('search:todos', ide.root, {}).then((r) => r.count)`],
  ['list (10,000-entry folder)', `api.list(ide.util.joinPath(ide.root, 'wide')).then((r) => r.length)`],
  ['claude status', `api.invoke('claude:status').then((r) => !!r.installed)`],
]) {
  const r = await blocking(label, call);
  results[label] = r;
  console.log(`${label}: ${round(r.ms)} ms, longest IPC wait ${round(r.maxPing)} ms, result ${JSON.stringify(r.result)}`);
}
check(results['walk (Go to File)'].maxPing < BUDGET.ipcBlockMs, `Go to File's project walk blocks IPC for at most ${round(results['walk (Go to File)'].maxPing)} ms`);
check(results.interpreters.maxPing < BUDGET.ipcBlockMs, `interpreter discovery blocks IPC for at most ${round(results.interpreters.maxPing)} ms`);
// One synchronous stat and read per file took 3.3-3.9 s here and stalled IPC for 158-174 ms; read ahead like Find in
// Files, ~0.7 s and under 10 ms.
check(results.todos.maxPing < BUDGET.ipcBlockMs && results.todos.ms < BUDGET.todosMs,
  `the TODO scan takes ${round(results.todos.ms)} ms (< ${BUDGET.todosMs}) and blocks IPC for at most ${round(results.todos.maxPing)} ms`);
check(results['list (10,000-entry folder)'].result === WIDE && results['list (10,000-entry folder)'].maxPing < BUDGET.ipcBlockMs,
  `listing a 10,000-entry folder blocks IPC for at most ${round(results['list (10,000-entry folder)'].maxPing)} ms`);
check(results['claude status'].maxPing < BUDGET.ipcBlockMs, `Claude Code detection blocks IPC for at most ${round(results['claude status'].maxPing)} ms`);

await sleep(1000);
results.memory = treeMemory(ctx.pid);
console.log(`memory: ${JSON.stringify(results.memory)}`);

mkdirSync(path.join(ctx.outDir), { recursive: true });
writeFileSync(path.join(ctx.outDir, 'results.json'), JSON.stringify(results, null, 2));
ctx.finish();
