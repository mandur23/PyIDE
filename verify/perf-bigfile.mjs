// Typing in a very large Python file (ports 9180-9181): completion latency while typing, how often Pyright is asked for
// the file's document symbols (breadcrumbs, sticky lines, the outline), and Pyright's CPU until it is quiet, in a
// 20,000-line file and a 2,000-line control. Not in CI (it times things), like perf-runtime.mjs.
//   node verify/perf-bigfile.mjs [--lines 20000] [--port 9180]   (default: both sizes, one launch each)
// Medians of 5 runs each, interleaved with the code before the fix, on a 16-thread laptop running other suites
// (machine 24-47% busy; numbers in verify/out/perf-bigfile-*/results.json):
//   documentSymbol requests per typed line: 20,000 lines 19 -> 0.5, 2,000 lines 10.5 -> 0.5 (one after typing stops)
//   Pyright CPU while typing 2 lines in 20,000: 30.4 s -> 25.8 s; completion while typing: 7.8 s -> 5.6 s, ranges
//   overlapping (3.8-20.5 s, 4.6-12.2 s). 2,000 lines: completion ~40 ms either way.
// What still bounds completion in the large file is Pyright's own check of the open file after each edit (65% of its
// CPU in a profile): it runs on the thread that answers requests and cannot be interrupted, and Pyright 1.1.406's
// background-analysis thread (--cancellationReceive) publishes no diagnostics here, so it is not used.
import { descendants, launch, processSnapshot } from './lib.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { cpus, tmpdir } from 'os';
import path from 'path';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const SIZES = arg('lines') ? [Number(arg('lines'))] : [2000, 20000];
const BASE_PORT = Number(arg('port')) || 9180;
const BUDGET = {
  2000: { symbolsPerLine: 2, completionMs: 1500 },
  // Completion waits for Pyright's check of the file (above); the budget catches answers stuck behind a request queue.
  20000: { symbolsPerLine: 2, completionMs: 15000 },
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const round = (x) => Math.round(x * 10) / 10;
const VISIBLE = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

function makeProject(lines) {
  const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-perfbig-')), 'proj');
  mkdirSync(project, { recursive: true });
  const big = ['import os', 'import json', 'from dataclasses import dataclass', '', ''];
  for (let i = 0; big.length < lines; i++) {
    big.push('@dataclass', `class Received${i}:`, `    """Holds the received value for item ${i}."""`, '    name: str', `    count: int = ${i}`, '',
      '    def total(self, factor: int, offset: int = 0) -> int:', '        result = self.count * factor + offset', '        return result + len(self.name)', '', '',
      `def helper_${i}(path, mode="r"):`, `    data = json.loads(open(os.path.join(path, "f${i}.json"), mode).read())`, `    item = Received${i}("x", ${i})`, `    return item.total(2, offset=${i}) + len(data)`, '', '');
  }
  writeFileSync(path.join(project, 'big.py'), `${big.slice(0, lines).join('\n')}\n`);
  writeFileSync(path.join(project, 'main.py'), 'import big\nprint(big.helper_1("."))\n');
  return project;
}

// Busy share of the whole machine over an interval, from os.cpus() (other suites' load included).
const machineTimes = () => cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });

async function run(lines, port) {
  const project = makeProject(lines);
  const t = await launch({ fixture: 'core', port, name: `perf-bigfile-${lines}`, projectDir: project, args: VISIBLE });
  const { js, until, check, sleep, cdp } = t;
  const result = { lines };
  const cpuOfTree = () => {
    const out = new Map();
    for (const r of descendants(processSnapshot(), t.pid, { includeRoot: true })) {
      const kind = /langserver/.test(r.cmd) ? 'pyright' : r.name === 'electron.exe' ? (/--type=([\w-]+)/.exec(r.cmd)?.[1] || 'main') : r.name;
      out.set(r.pid, { kind, ms: r.kernelMs + r.userMs });
    }
    return out;
  };
  const cpuSince = (a, b) => {
    const by = {};
    for (const [pid, v] of b) by[v.kind] = round((by[v.kind] || 0) + v.ms - (a.get(pid)?.ms || 0));
    return by;
  };
  try {
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'big.py'))`);
    await until(`ide.activeTab()?.path.toLowerCase().endsWith('big.py')`, 'big.py open');
    await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
    const t0open = Date.now();
    await until(`ide.lsp.documentSymbols(ide.activeTab().path).then((s) => s.length > 0)`, 'document symbols of big.py', 240000);
    result.firstSymbolsMs = Date.now() - t0open;
    // Settle: Pyright's first full check of the file, then a quiet moment.
    let prev = cpuOfTree();
    for (let quiet = 0, q0 = Date.now(); quiet < 3 && Date.now() - q0 < 240000;) {
      await sleep(1000);
      const cur = cpuOfTree();
      quiet = (cpuSince(prev, cur).pyright || 0) < 50 ? quiet + 1 : 0;
      prev = cur;
    }

    const target = Math.floor(lines / 2);
    const { at, cls } = await js(`(() => {
      const ed = ide.editor; const m = ed.getModel();
      let ln = ${target};
      while (ln < m.getLineCount() && !/^        return result \\+ len\\(self\\.name\\)$/.test(m.getLineContent(ln))) ln++;
      let c = ln;
      while (c > 1 && !/^class /.test(m.getLineContent(c))) c--;
      ed.focus(); ed.setPosition({ lineNumber: ln, column: m.getLineMaxColumn(ln) }); ed.revealLineInCenter(ln);
      return { at: ln, cls: /^class (\\w+)/.exec(m.getLineContent(c))[1] };
    })()`);
    await js(`(() => {
      window.__perf = { sym: [], cancels: 0, callers: {}, methods: {} };
      const invoke = ide.api.invoke;
      ide.api.invoke = function (ch, method, params, ticket) {
        if (ch === 'lsp:cancel') __perf.cancels++;
        if (ch !== 'lsp:request') return invoke.apply(this, arguments);
        const m = (__perf.methods[method] ||= { n: 0, nulls: 0, ms: [] });
        m.n++;
        const rec = { at: performance.now(), version: ide.activeTab().model.getVersionId(), ms: null, ok: null };
        if (method === 'textDocument/documentSymbol') __perf.sym.push(rec);
        const done = (r) => { rec.ms = performance.now() - rec.at; rec.ok = r != null; m.ms.push(Math.round(rec.ms)); if (!rec.ok) m.nulls++; };
        return invoke.apply(this, arguments).then((r) => { done(r); return r; }, (e) => { done(null); throw e; });
      };
      const ds = ide.lsp.documentSymbols;
      ide.lsp.documentSymbols = function (p) {
        const s = new Error().stack;
        const who = /navigation-bar/.test(s) ? 'breadcrumbs' : /editor-assists/.test(s) ? 'stickyRefresh' : 'other';
        __perf.callers[who] = (__perf.callers[who] || 0) + 1;
        return ds.apply(this, arguments);
      };
      return 1;
    })()`);
    const completion = () => js(`(async () => {
      const ed = ide.editor; const p = ed.getPosition();
      const t0 = performance.now();
      const r = await ide.lsp.request('textDocument/completion', { textDocument: { uri: ed.getModel().uri.toString() }, position: { line: p.lineNumber - 1, character: p.column - 1 }, context: { triggerKind: 1 } });
      return { ms: performance.now() - t0, answered: r != null };
    })()`);
    const key = async (ch) => {
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
    };
    const LINES = 2;
    const text = '\nvalue = helper_12(os.path.join("data", "received"), mode="w") + Received3("n").total(4)'.repeat(LINES);
    const completions = [];
    const c0 = cpuOfTree();
    const m0 = machineTimes();
    let keys = 0;
    for (const ch of text) {
      await key(ch);
      keys++;
      if (keys % 20 === 10) completion().then((c) => completions.push(c));
      await sleep(100);
    }
    const typedMs = keys * 100;
    const typedCpu = cpuSince(c0, cpuOfTree());
    const m1 = machineTimes();
    const q0 = Date.now();
    let prevQ = cpuOfTree();
    for (let quiet = 0; quiet < 2 && Date.now() - q0 < 120000;) {
      await sleep(1000);
      const cur = cpuOfTree();
      quiet = (cpuSince(prevQ, cur).pyright || 0) < 50 ? quiet + 1 : 0;
      prevQ = cur;
    }
    const quietMs = Date.now() - q0 - 2000;
    for (const e0 = Date.now(); completions.length < Math.floor(keys / 20) && Date.now() - e0 < 60000;) await sleep(200);
    const all = cpuSince(c0, prevQ);
    const perf = await js(`(() => ({ ...__perf, finalVersion: ide.activeTab().model.getVersionId() }))()`);
    const ourCpu = Object.values(typedCpu).reduce((s, v) => s + v, 0);
    const machineBusy = (m1.busy - m0.busy) / (m1.all - m0.all);
    Object.assign(result, {
      caretLine: at, keys, typedLines: LINES,
      documentSymbol: {
        requests: perf.sym.length, perTypedLine: round(perf.sym.length / LINES), cancels: perf.cancels, callers: perf.callers,
        answeredMs: { median: round(median(perf.sym.filter((s) => s.ok).map((s) => s.ms))), max: round(Math.max(0, ...perf.sym.map((s) => s.ms || 0))) },
        lastForFinalVersion: perf.sym.length > 0 && perf.sym[perf.sym.length - 1].version === perf.finalVersion,
      },
      completionMs: { median: round(median(completions.map((c) => c.ms))), max: round(Math.max(...completions.map((c) => c.ms))), n: completions.length, answered: completions.filter((c) => c.answered).length },
      // Every request the plugins sent Pyright while typing and until it was quiet: count, unanswered (cancelled), median ms.
      requests: Object.fromEntries(Object.entries(perf.methods).map(([k, m]) => [k.replace(/^textDocument\//, ''), { n: m.n, nulls: m.nulls, medianMs: median(m.ms) }])),
      pyrightCpuMs: { whileTyping: typedCpu.pyright || 0, untilQuiet: all.pyright || 0 },
      rendererCpuMs: typedCpu.renderer || 0,
      quietAfterMs: quietMs,
      // Load on the machine while typing: all cores' busy share, and how much of it was not this IDE.
      machine: { cores: cpus().length, busyPct: round(machineBusy * 100), othersPct: round(Math.max(0, machineBusy - ourCpu / (typedMs * cpus().length)) * 100) },
    });
    console.log(`RESULT ${JSON.stringify(result)}`);

    // The breadcrumbs and the outline caught up with the text: the chain names the class and method typed in.
    await until(`[...document.querySelectorAll('.nb-bar:not(.hidden) .nb-crumb[data-kind=symbol]')].map((n) => n.dataset.name).join('/') === '${cls}/total'`, 'breadcrumbs after typing', 60000)
      .then(() => check(true, `${lines} lines: the breadcrumbs show the method typed in after typing stops`))
      .catch(async () => check(false, `${lines} lines: breadcrumbs after typing (${await js(`[...document.querySelectorAll('.nb-bar .nb-crumb')].map((n) => n.textContent).join(' > ')`)})`));
    const fresh = await js(`(async () => { const v = ide.activeTab().model.getVersionId(); const s = await ide.lsp.documentSymbols(ide.activeTab().path); return { n: s.length, same: v === ide.activeTab().model.getVersionId() }; })()`);
    check(fresh.n > 0, `${lines} lines: document symbols of the edited file (${fresh.n} top-level)`);
    const b = BUDGET[lines] || BUDGET[20000];
    check(result.completionMs.answered === result.completionMs.n && result.completionMs.n > 0, `${lines} lines: every completion asked while typing is answered (${result.completionMs.answered}/${result.completionMs.n})`);
    check(result.completionMs.median < b.completionMs, `${lines} lines: completion while typing answers in ${result.completionMs.median} ms (median of ${result.completionMs.n}, < ${b.completionMs})`);
    check(result.documentSymbol.perTypedLine <= b.symbolsPerLine, `${lines} lines: ${result.documentSymbol.perTypedLine} documentSymbol requests per typed line (<= ${b.symbolsPerLine})`);
    check(result.documentSymbol.lastForFinalVersion, `${lines} lines: the last documentSymbol request is for the final text`);
  } catch (err) {
    check(false, `${lines} lines: ${err.message}`);
  }
  mkdirSync(t.outDir, { recursive: true });
  writeFileSync(path.join(t.outDir, 'results.json'), JSON.stringify(result, null, 2));
  return t;
}

const earlier = [];
for (const [i, lines] of SIZES.entries()) {
  const t = await run(lines, BASE_PORT + i);
  if (i < SIZES.length - 1) { t.close(); earlier.push(...t.results); continue; }
  t.results.unshift(...earlier);
  t.finish();
}
