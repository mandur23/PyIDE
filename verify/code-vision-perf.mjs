// What code vision costs while typing (ports 9023-9024): verify/perf-runtime.mjs's 2,000-line git project and typing
// measurement, run once with code vision off and once on (fresh instances), comparing Pyright's CPU until it is quiet,
// how long it stays busy after the last key, keydown-to-paint latency, completion while typing and the references
// requests code vision sends. Not in CI (it times things, like perf-runtime.mjs); numbers go to
// verify/out/code-vision-perf/results.json.
import { descendants, launch, processSnapshot } from './lib.mjs';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const round = (x) => Math.round(x * 10) / 10;

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-cvperf-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Perf\n\temail = perf@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });

function makeProject() {
  const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-cvperf-')), 'proj');
  mkdirSync(path.join(project, 'pkg'), { recursive: true });
  const big = ['import os', 'import json', 'import numpy_missing_pkg', 'from dataclasses import dataclass', '', ''];
  for (let i = 0; big.length < 2000; i++) {
    big.push('@dataclass', `class Recieved${i}:`, `    """Holds the recieved valu for item ${i}."""`, '    name: str', `    count: int = ${i}`, '',
      '    def total(self, factor: int, offset: int = 0) -> int:', '        result = self.count * factor + offset', '        return result + len(self.name)', '', '',
      `def helper_${i}(path, mode="r"):`, `    data = json.loads(open(os.path.join(path, "f${i}.json"), mode).read())`, `    item = Recieved${i}("x", ${i})`, `    return item.total(2, offset=${i}) + len(data)`, '', '');
  }
  writeFileSync(path.join(project, 'big.py'), `${big.slice(0, 2000).join('\n')}\n`);
  writeFileSync(path.join(project, 'main.py'), 'import big\nprint(big.helper_1("."))\n');
  for (let i = 0; i < 20; i++) writeFileSync(path.join(project, 'pkg', `m${i}.py`), `def f${i}(x):\n    return x + ${i}\n`);
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return project;
}

const VISIBLE = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const results = {};
let failed = false;

async function measure(mode, port) {
  const t = await launch({ fixture: 'core', port, name: `code-vision-perf-${mode}`, projectDir: makeProject(), args: VISIBLE });
  const { js, until, sleep, cdp } = t;
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
    const on = mode === 'on';
    await js(`(ide.settings.set('editor.codeVision.usages', ${on}), ide.settings.set('editor.codeVision.authors', ${on}), true)`);
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'big.py'))`);
    await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
    await until(`ide.problems.all().some((p) => p.source === 'pyright' && /big\\.py$/i.test(p.path))`, 'Pyright diagnostics for big.py', 90000);
    await js(`(() => { const ed = ide.editor; ed.focus(); ed.setPosition({ lineNumber: 1000, column: 1 }); ed.revealLineInCenter(1000); return 1; })()`);
    if (on) {
      await until(`(() => { const m = ide.activeTab().model; const r = ide.editor.getVisibleRanges()[0];
        return ide.codeVision.lenses(m).filter((l) => l.line >= r.startLineNumber && l.line <= r.endLineNumber).some((l) => l.kind === 'usages')
          && !ide.codeVision.stats().running && !ide.codeVision.stats().scheduled; })()`, 'code vision counted the view', 60000);
    }
    const openRefs = on ? await js(`ide.codeVision.stats().references`) : 0;
    await sleep(10000);
    await js(`(() => {
      window.__perf = { lat: [], refs: 0, sig: 0 };
      addEventListener('keydown', (e) => {
        const ts = e.timeStamp;
        requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => __perf.lat.push(performance.now() - ts); ch.port2.postMessage(0); });
      }, true);
      const invoke = ide.api.invoke;
      ide.api.invoke = function (ch, method, ...rest) {
        if (ch === 'lsp:request' && method === 'textDocument/references') __perf.refs++;
        if (ch === 'lsp:request' && method === 'textDocument/signatureHelp') __perf.sig++;
        return invoke.call(this, ch, method, ...rest);
      };
      return 1;
    })()`);
    const completion = () => js(`(async () => {
      const ed = ide.editor; const p = ed.getPosition();
      const t0 = performance.now();
      await ide.lsp.request('textDocument/completion', { textDocument: { uri: ed.getModel().uri.toString() }, position: { line: p.lineNumber - 1, character: p.column - 1 }, context: { triggerKind: 1 } });
      return performance.now() - t0;
    })()`);
    const text = '    value = helper_12(os.path.join("data", "recieved"), mode="w") + Recieved3("n").total(4)\n';
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
    const refsWhileTyping = await js(`__perf.refs`);
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
    const perf = await js(`(() => { const p = __perf; return { lat: p.lat.splice(0), refs: p.refs, sig: p.sig }; })()`);
    const lat = [...perf.lat].sort((a, b) => a - b);
    results[mode] = {
      keys, openReferences: openRefs, pyrightMs: round(cpuSince(t0, prev).pyright || 0), pyrightWhileTypingMs: typedCpu.pyright || 0, quietAfterMs: quietMs,
      referencesWhileTyping: refsWhileTyping, referencesInAll: perf.refs, signatureHelps: perf.sig,
      completionMs: { median: round(median(completions)), max: round(Math.max(...completions)), n: completions.length },
      keyToPaintMs: { median: round(median(lat)), p90: round(lat[Math.floor(lat.length * 0.9)]) },
      rendererCpuMs: typedCpu.renderer,
    };
    console.log(`${mode}: ${JSON.stringify(results[mode])}`);
    if (on) {
      t.check(refsWhileTyping <= 2, `code vision sends ${refsWhileTyping} references requests while typing (<= 2)`);
      t.check(perf.refs <= 20, `${perf.refs} references requests in all after typing two lines (<= 20, the declarations in view)`);
    }
    t.check(results[mode].keyToPaintMs.median < 50, `${mode}: keydown to paint ${results[mode].keyToPaintMs.median} ms (median, < 50)`);
    t.check(results[mode].completionMs.median < 1500, `${mode}: completion while typing answers in ${results[mode].completionMs.median} ms (median, < 1500)`);
  } catch (err) {
    t.check(false, err.message);
  }
  if (t.results.some((r) => !r.ok) || t.consoleErrors.length) failed = true;
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  t.close();
}

await measure('off', 9023);
await measure('on', 9024);
if (results.off && results.on) {
  const d = (k) => round(results.on[k] - results.off[k]);
  console.log(`code vision on - off: Pyright CPU ${d('pyrightMs')} ms, quiet after ${d('quietAfterMs')} ms, key-to-paint median ${round(results.on.keyToPaintMs.median - results.off.keyToPaintMs.median)} ms, completion median ${round(results.on.completionMs.median - results.off.completionMs.median)} ms`);
}
const outDir = path.join(import.meta.dirname, 'out', 'code-vision-perf');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(failed ? 'code-vision-perf: FAILED' : 'code-vision-perf: all passed');
process.exit(failed ? 1 : 0);
