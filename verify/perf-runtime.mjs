// Runtime performance and resource budgets (ports 9580-9581): idle CPU with a project open, typing in a 2,000-line
// Python file with every inline feature on (Pyright, inlay hints, spell checker, AI completion, live templates...),
// cancelled Pyright requests, and memory that opening a Markdown file or posting notifications must not keep.
// Budgets sit well between the measured numbers and the regressions they guard against, so a loaded machine passes:
//   idle 20 s: whole process tree ~0.2 s CPU (budget 2 s), renderer script ~0 ms (budget 250 ms)
//   typing 2 lines: Pyright busy ~10 s CPU and quiet ~2 s after the last key (before the fixes: ~50 s, and 19 s of
//   inlay hint requests after typing); completion answers in ~50 ms while typing (before: ~10 s behind queued hints)
//   signatureHelp while typing 2 lines: inlay hints 16 (once per printed signature; budget 30; before the fixes: one
//   per visible call after every pause); Monaco's Parameter Info 9 on a quiet machine, 25 with two other suites running
//   and ~50 on a loaded one: it asks again on every key typed inside a call that comes more than 120 ms after the
//   previous one, so it follows the typing cadence, and is held to at most one per such key
//   Markdown open/close: no growth (before: +22 DOM nodes, +23 listeners and a whole editor per open)
// Numbers go to verify/out/perf-runtime/results.json.
import { descendants, launch, openFile, processSnapshot } from './lib.mjs';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const BUDGET = { idleCpuMs: 2000, idleScriptMs: 250, pyrightMs: 30000, quietMs: 10000, completionMs: 1500, keyPaintMs: 50, inlaySignatureHelps: 30 };
const results = {};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const round = (x) => Math.round(x * 10) / 10;

// A git project with a 2,000-line module full of calls, assignments and misspelled words.
const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-perfrt-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Perf\n\temail = perf@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-perfrt-')), 'proj');
mkdirSync(path.join(project, 'pkg'), { recursive: true });
// The unresolved import gives Pyright a diagnostic to report (the sign it analyzed the file) and the import-install
// plugin a quick fix to offer.
const big = ['import os', 'import json', 'import numpy_missing_pkg', 'from dataclasses import dataclass', '', ''];
for (let i = 0; big.length < 2000; i++) {
  big.push('@dataclass', `class Recieved${i}:`, `    """Holds the recieved valu for item ${i}."""`, '    name: str', `    count: int = ${i}`, '',
    '    def total(self, factor: int, offset: int = 0) -> int:', '        result = self.count * factor + offset', '        return result + len(self.name)', '', '',
    `def helper_${i}(path, mode="r"):`, `    data = json.loads(open(os.path.join(path, "f${i}.json"), mode).read())`, `    item = Recieved${i}("x", ${i})`, `    return item.total(2, offset=${i}) + len(data)`, '', '');
}
writeFileSync(path.join(project, 'big.py'), `${big.slice(0, 2000).join('\n')}\n`);
writeFileSync(path.join(project, 'main.py'), 'import big\nprint(big.helper_1("."))\n');
writeFileSync(path.join(project, 'notes.md'), '# Notes\n\nSome *text* and a [link](main.py).\n\n```python\nprint(1)\n```\n');
for (let i = 0; i < 20; i++) writeFileSync(path.join(project, 'pkg', `m${i}.py`), `def f${i}(x):\n    return x + ${i}\n`);
const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'init');

// Test windows run on a hidden desktop, where Chromium would treat the window as occluded and stop drawing it; these
// flags keep it drawing like a window on screen, so frames, the caret and paint latency are real.
const VISIBLE = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const t = await launch({ fixture: 'core', port: 9580, name: 'perf-runtime', projectDir: project, args: VISIBLE });
const { js, until, check, sleep, cdp } = t;

// CPU ms of the IDE's processes (main, renderer, GPU, Pyright, sidecars), by kind.
function cpuOfTree() {
  const out = new Map();
  for (const r of descendants(processSnapshot(), t.pid, { includeRoot: true })) {
    const kind = /langserver/.test(r.cmd) ? 'pyright' : r.name === 'electron.exe' ? (/--type=([\w-]+)/.exec(r.cmd)?.[1] || 'main') : r.name;
    out.set(r.pid, { kind, ms: r.kernelMs + r.userMs });
  }
  return out;
}
const cpuSince = (a, b) => {
  const by = {};
  for (const [pid, v] of b) by[v.kind] = round((by[v.kind] || 0) + v.ms - (a.get(pid)?.ms || 0));
  return by;
};
const total = (by) => round(Object.values(by).reduce((s, v) => s + v, 0));
const metrics = async () => Object.fromEntries((await cdp('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
await cdp('Performance.enable', { timeDomain: 'timeTicks' });

try {
  await openFile(t, 'big.py');
  await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
  await until(`ide.problems.all().some((p) => p.source === 'pyright' && /big\\.py$/i.test(p.path))`, 'Pyright diagnostics for big.py', 90000);
  await js(`(() => { const ed = ide.editor; ed.focus(); ed.setPosition({ lineNumber: 1000, column: 1 }); ed.revealLineInCenter(1000); return 1; })()`);

  // ---- idle ----
  // After startup work settles (Pyright's first analysis, git status, indexing), nothing should keep waking up.
  await sleep(15000);
  const c0 = cpuOfTree();
  const m0 = await metrics();
  await sleep(20000);
  const idleCpu = cpuSince(c0, cpuOfTree());
  const m1 = await metrics();
  results.idle = { cpuMs: idleCpu, totalMs: total(idleCpu), scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000) };
  console.log(`idle 20 s: ${JSON.stringify(results.idle)}`);
  check(results.idle.totalMs < BUDGET.idleCpuMs, `idle: the IDE's processes use ${results.idle.totalMs} ms CPU in 20 s (< ${BUDGET.idleCpuMs})`);
  check(results.idle.scriptMs < BUDGET.idleScriptMs, `idle: the renderer runs ${results.idle.scriptMs} ms of script in 20 s (< ${BUDGET.idleScriptMs})`);

  // ---- typing ----
  await js(`(() => {
    window.__perf = { lat: [], sig: 0, paramInfo: 0 };
    addEventListener('keydown', (e) => {
      const ts = e.timeStamp;
      requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => __perf.lat.push(performance.now() - ts); ch.port2.postMessage(0); });
    }, true);
    const invoke = ide.api.invoke;
    ide.api.invoke = function (ch, method, ...rest) { if (ch === 'lsp:request' && method === 'textDocument/signatureHelp') {
      // The inlay hints plugin asks as an invoked request (triggerKind 1); Monaco's Parameter Info, opened by typing,
      // asks on a trigger character (2) or a content change (3).
      if (rest[0]?.context?.triggerKind === 1) __perf.sig++; else __perf.paramInfo++;
    }
    return invoke.call(this, ch, method, ...rest); };
    return 1;
  })()`);
  // Completion asked at the caret while typing goes on, as the suggest widget does.
  const completion = () => js(`(async () => {
    const ed = ide.editor; const p = ed.getPosition();
    const t0 = performance.now();
    await ide.lsp.request('textDocument/completion', { textDocument: { uri: ed.getModel().uri.toString() }, position: { line: p.lineNumber - 1, character: p.column - 1 }, context: { triggerKind: 1 } });
    return performance.now() - t0;
  })()`);
  const text = '    value = helper_12(os.path.join("data", "recieved"), mode="w") + Recieved3("n").total(4)\n';

  // Keys typed inside a call (its "(" included): where Monaco's Parameter Info may ask.
  let depth = 0;
  const keysInCalls = 2 * [...text].filter((ch) => { const inside = ch === '(' || depth > 0; if (ch === '(') depth++; else if (ch === ')') depth--; return inside; }).length;
  const completions = [];
  const t0 = cpuOfTree();
  let keys = 0;
  for (let rep = 0; rep < 2; rep++) {
    for (const ch of text) {
      if (ch === '\n') {
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await cdp('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      } else {
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      }
      keys++;
      if (keys % 20 === 10) completion().then((ms) => completions.push(ms));
      await sleep(100);
    }
  }
  const typedCpu = cpuSince(t0, cpuOfTree());
  // Until Pyright is quiet: under 5% of a core for 2 s in a row.
  const q0 = Date.now();
  let prev = cpuOfTree();
  for (let quiet = 0; quiet < 2 && Date.now() - q0 < 60000;) {
    await sleep(1000);
    const cur = cpuOfTree();
    quiet = (cpuSince(prev, cur).pyright || 0) < 50 ? quiet + 1 : 0;
    prev = cur;
  }
  const quietMs = Date.now() - q0 - 2000;
  while (completions.length < Math.floor(keys / 20)) await sleep(200);
  const pyrightMs = round(cpuSince(t0, prev).pyright || 0);
  const perf = await js(`(() => { const p = __perf; return { lat: p.lat.splice(0), sig: p.sig, paramInfo: p.paramInfo }; })()`);
  results.typing = {
    keys, pyrightMs, pyrightWhileTypingMs: typedCpu.pyright || 0, quietAfterMs: quietMs, signatureHelps: { inlayHints: perf.sig, parameterInfo: perf.paramInfo, keysInCalls },
    completionMs: { median: round(median(completions)), max: round(Math.max(...completions)), n: completions.length },
    keyToPaintMs: { median: round(median(perf.lat)), p90: round([...perf.lat].sort((a, b) => a - b)[Math.floor(perf.lat.length * 0.9)]) },
    rendererCpuMs: typedCpu.renderer,
  };
  console.log(`typing: ${JSON.stringify(results.typing)}`);
  check(pyrightMs < BUDGET.pyrightMs, `typing 2 lines: Pyright uses ${pyrightMs} ms CPU until it is quiet (< ${BUDGET.pyrightMs})`);
  check(quietMs < BUDGET.quietMs, `Pyright is quiet ${quietMs} ms after the last key (< ${BUDGET.quietMs})`);
  check(results.typing.completionMs.median < BUDGET.completionMs, `completion while typing answers in ${results.typing.completionMs.median} ms (median, < ${BUDGET.completionMs})`);
  check(results.typing.keyToPaintMs.median < BUDGET.keyPaintMs, `keydown to paint ${results.typing.keyToPaintMs.median} ms (median, < ${BUDGET.keyPaintMs})`);
  check(perf.sig < BUDGET.inlaySignatureHelps, `inlay hints ask ${perf.sig} signatureHelps while typing and after (< ${BUDGET.inlaySignatureHelps}; once per printed signature)`);
  check(perf.paramInfo <= keysInCalls, `Parameter Info asks ${perf.paramInfo} signatureHelps while typing (at most one per key typed inside a call: ${keysInCalls})`);

  // The hints are still there, with the same names a signatureHelp per call gives.
  const hints = await js(`(async () => {
    const model = ide.activeTab().model;
    const lines = [];
    for (let ln = 990; ln < 1030; ln++) if (/open\\(os\\.path\\.join|item\\.total\\(2|Recieved\\d+\\("x"/.test(model.getLineContent(ln))) lines.push(ln);
    const range = new ide.monaco.Range(lines[0], 1, lines[lines.length - 1], 200);
    return (await ide.inlayHints.hints(model, range)).map((h) => h.label);
  })()`);
  check(['file:', 'factor:', 'name:', 'count:'].every((l) => hints.includes(l)) && hints.some((l) => /^: /.test(l)),
    `inlay hints after typing: parameter names and types (${[...new Set(hints)].join(' ')})`);
  await js(`(ide.editor.revealLineInCenter(1000), 1)`);
  check(await until(`[...document.querySelectorAll('#editor .view-line')].some((l) => /file:/.test(l.textContent))`, 'inlay hints drawn', 15000).catch(() => false),
    'the editor draws the parameter name hints');

  // ---- cancellation ----
  // open()'s signatureHelp takes Pyright seconds (its documentation lookup). A cancelled request answers null at once,
  // and a cancelled one still queued behind it is dropped: the hover after them waits for the first one only.
  const cancel = await js(`(async () => {
    const model = ide.activeTab().model;
    const uri = model.uri.toString();
    const at = (ln) => ({ line: ln - 1, character: model.getLineContent(ln).indexOf('open(') + 5 });
    const opens = [];
    for (let ln = 1; ln <= model.getLineCount() && opens.length < 2; ln++) if (model.getLineContent(ln).includes('open(')) opens.push(ln);
    const sig = (ln, token) => ide.lsp.request('textDocument/signatureHelp', { textDocument: { uri }, position: at(ln), context: { triggerKind: 1, isRetrigger: false } }, token);
    const src = new ide.monaco.CancellationTokenSource();
    const t0 = performance.now();
    const a = sig(opens[0]).then((r) => ({ ms: performance.now() - t0, ok: !!r }));
    const b = sig(opens[1], src.token).then((r) => ({ ms: performance.now() - t0, value: r }));
    await new Promise((r) => setTimeout(r, 50));
    src.cancel();
    const c = ide.lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: opens[1] - 1, character: 4 } }).then(() => ({ ms: performance.now() - t0 }));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    return { first: Math.round(ra.ms), firstOk: ra.ok, cancelled: Math.round(rb.ms), cancelledValue: rb.value, hover: Math.round(rc.ms) };
  })()`);
  results.cancellation = cancel;
  console.log(`cancellation: ${JSON.stringify(cancel)}`);
  check(cancel.cancelledValue === null && cancel.cancelled < 1000, `a cancelled request answers null in ${cancel.cancelled} ms`);
  check(cancel.firstOk && cancel.hover < cancel.first + 2500, `the cancelled request is dropped in Pyright: the next request answers ${cancel.hover - cancel.first} ms after the one before it`);

  // ---- memory ----
  const counters = async () => {
    for (let i = 0; i < 3; i++) { await cdp('HeapProfiler.collectGarbage'); await sleep(150); }
    return (await cdp('Memory.getDOMCounters')).result;
  };
  const md = path.join(project, 'notes.md');
  const openMd = async () => { await js(`ide.openFile(${JSON.stringify(md)})`); await until(`!!document.querySelector('.vw-md-preview h1')`, 'Markdown preview'); await js(`ide.closeTab(${JSON.stringify(md)}, true)`); await sleep(100); };
  for (let i = 0; i < 2; i++) await openMd();
  await sleep(1000);
  const d0 = await counters();
  const ROUNDS = 10;
  for (let i = 0; i < ROUNDS; i++) await openMd();
  await sleep(1000);
  const d1 = await counters();
  results.markdown = { rounds: ROUNDS, nodes: d1.nodes - d0.nodes, listeners: d1.jsEventListeners - d0.jsEventListeners };
  console.log(`Markdown open/close x${ROUNDS}: ${JSON.stringify(results.markdown)}`);
  check(results.markdown.nodes <= ROUNDS * 3 && results.markdown.listeners <= ROUNDS, `opening and closing a Markdown file ${ROUNDS} times keeps nothing (DOM nodes +${results.markdown.nodes}, listeners +${results.markdown.listeners})`);

  // A closed balloon is not kept by the session's notification history.
  await js(`(() => { const n = ide.notifications.notify({ title: 'perf-runtime balloon', text: 'x', timeout: 0, actions: [{ label: 'Act', run: () => {} }] }); window.__note = n; window.__balloon = new WeakRef(n.balloon); n.remove(); return 1; })()`);
  await counters();
  check(await js(`__balloon.deref() === undefined && __note.balloon === null && ide.notifications.list().some((e) => e.title === 'perf-runtime balloon')`), 'a closed notification balloon is freed; the notification stays in the list');
} catch (err) {
  check(false, err.message);
}
mkdirSync(t.outDir, { recursive: true });
writeFileSync(path.join(t.outDir, 'results.json'), JSON.stringify(results, null, 2));
t.finish();
