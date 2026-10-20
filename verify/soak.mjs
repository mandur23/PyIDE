// Long-session health: opens and closes 200 files, switches between 3 projects 30 times, opens and closes every
// tool window 20 times, runs a short program 50 times, starts and stops the debugger 20 times and opens and closes a
// terminal 20 times. Around each phase (after a warm-up round, so first-use caches do not count) it measures the
// renderer's JS heap after garbage collection, DOM nodes and JS event listeners (Memory.getDOMCounters), Monaco
// models, the main process's heap (Node inspector) and the IDE's child processes, and fails on growth that scales
// with the number of rounds (ports 9867-9868). SOAK_SCALE=0.2 runs a fifth of the rounds.
import { launch } from './lib.mjs';
import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = Number(process.env.SOAK_SCALE || 1);
const rounds = (n) => Math.max(2, Math.round(n * SCALE));
const work = mkdtempSync(path.join(tmpdir(), 'pyide-soak-'));
const projects = ['alpha', 'beta', 'gamma'].map((n) => path.join(work, n));
for (const p of projects) {
  cpSync(path.join(APP_DIR, 'verify', 'fixtures', 'core'), p, { recursive: true });
  writeFileSync(path.join(p, 'quick.py'), 'print("quick", 6 * 7)\n');
  writeFileSync(path.join(p, 'wait.py'), 'import time\nprint("waiting")\ntime.sleep(120)\n');
}
mkdirSync(path.join(projects[0], 'many'));
for (let i = 0; i < 200; i++) {
  writeFileSync(path.join(projects[0], 'many', `mod_${String(i).padStart(3, '0')}.py`),
    `"""Module ${i}."""\nimport os\n\n\ndef func_${i}(value):\n    """Doubles a value."""\n    return value * 2 + ${i}\n\n\nclass Thing${i}:\n    def __init__(self):\n        self.path = os.getcwd()\n`);
}

const t = await launch({ fixture: 'core', port: 9867, name: 'soak', projectDir: projects[0], args: ['--inspect=9868'] });
const { js, until, check, sleep, cdp } = t;
setTimeout(() => { console.log('FAIL the soak did not finish in 25 minutes (watchdog)'); t.close(); process.exit(1); }, 25 * 60 * 1000).unref();

// The main process, through its Node inspector.
const mainTarget = (await (await fetch('http://127.0.0.1:9868/json/list')).json())[0];
const mainWs = new WebSocket(mainTarget.webSocketDebuggerUrl);
await new Promise((r) => mainWs.addEventListener('open', r));
let mainSeq = 0;
const mainPending = new Map();
mainWs.addEventListener('message', (m) => { const msg = JSON.parse(m.data); mainPending.get(msg.id)?.(msg); mainPending.delete(msg.id); });
const main = (method, params = {}) => new Promise((r) => { const id = ++mainSeq; mainPending.set(id, r); mainWs.send(JSON.stringify({ id, method, params })); });
const mainEval = async (expr) => (await main('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

// Processes below the IDE's main process: Chromium's own helpers (renderer, GPU, utility) and everything the IDE started.
function children() {
  const rows = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const below = new Set([t.pid]);
  const out = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (below.has(r.ParentProcessId) && !below.has(r.ProcessId)) {
        below.add(r.ProcessId);
        out.push(r);
        grew = true;
      }
    }
  }
  const helpers = out.filter((r) => /--type=/.test(r.CommandLine || ''));
  return { helpers: helpers.length, others: out.filter((r) => !helpers.includes(r)).map((r) => r.Name) };
}

async function metrics() {
  await js(`(document.querySelectorAll('#dialogHost .dialog-backdrop').forEach((d) => d.remove()), 1)`);
  for (let i = 0; i < 2; i++) { await cdp('HeapProfiler.collectGarbage'); await main('HeapProfiler.collectGarbage'); await sleep(200); }
  const heap = (await cdp('Runtime.getHeapUsage')).result;
  const dom = (await cdp('Memory.getDOMCounters')).result;
  const mainMem = await mainEval('JSON.stringify(process.memoryUsage())').then(JSON.parse);
  const procs = children();
  return {
    heapMB: +(heap.usedSize / 1048576).toFixed(1),
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    documents: dom.documents,
    models: await js('ide.monaco.editor.getModels().length'),
    mainHeapMB: +(mainMem.heapUsed / 1048576).toFixed(1),
    mainRssMB: Math.round(mainMem.rss / 1048576),
    helpers: procs.helpers,
    children: procs.others.length,
    childNames: [...new Set(procs.others)].join(','),
  };
}

const table = [];
// Runs `round` once to warm up, measures, runs it n times, measures again, and checks the growth per round.
async function phase(name, n, round, limits = {}) {
  await round(-1);
  await sleep(1500);
  const before = await metrics();
  const t0 = Date.now();
  for (let i = 0; i < n; i++) await round(i);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  await sleep(3000);
  const after = await metrics();
  const d = (k) => +(after[k] - before[k]).toFixed(1);
  table.push({ name, n, secs, before, after });
  console.log(`${name} x${n} (${secs} s): heap ${before.heapMB} -> ${after.heapMB} MB, nodes ${before.nodes} -> ${after.nodes}, listeners ${before.listeners} -> ${after.listeners}, models ${before.models} -> ${after.models}, main heap ${before.mainHeapMB} -> ${after.mainHeapMB} MB (rss ${before.mainRssMB} -> ${after.mainRssMB}), child processes ${before.children} -> ${after.children} [${after.childNames}], helpers ${before.helpers} -> ${after.helpers}`);
  // Growth that scales with the rounds is a leak; a constant amount (a cache that fills once) is not. The limits are
  // per round, generous enough for allocator noise.
  const per = (k) => d(k) / n;
  check(per('heapMB') <= (limits.heapMB ?? 0.05), `${name}: renderer heap grows ${d('heapMB')} MB over ${n} rounds`);
  check(per('nodes') <= (limits.nodes ?? 5), `${name}: DOM nodes grow ${d('nodes')} over ${n} rounds`);
  check(per('listeners') <= (limits.listeners ?? 1), `${name}: event listeners grow ${d('listeners')} over ${n} rounds`);
  check(d('models') <= 0, `${name}: Monaco models ${before.models} -> ${after.models}`);
  check(per('mainHeapMB') <= (limits.mainHeapMB ?? 0.05), `${name}: main-process heap grows ${d('mainHeapMB')} MB over ${n} rounds`);
  check(d('children') <= 0, `${name}: child processes ${before.children} -> ${after.children}`);
}

try {
  await until(`ide.root && document.querySelectorAll('#tree .node').length > 2`, 'project tree');
  console.log('start', JSON.stringify(await metrics()));
  const files = Array.from({ length: 200 }, (_, i) => path.join(projects[0], 'many', `mod_${String(i).padStart(3, '0')}.py`));

  await phase('open and close files', rounds(200), async (i) => {
    const f = files[Math.max(0, i) % files.length];
    await js(`ide.openFile(${JSON.stringify(f)})`);
    await sleep(60);
    await js(`ide.closeTab(${JSON.stringify(f)}, true)`);
  });

  let next = 0;
  await phase('switch projects', rounds(30), async () => {
    const p = projects[++next % projects.length];
    await js(`ide.openProject(${JSON.stringify(p)})`);
    await until(`ide.root === ${JSON.stringify(p)} && document.querySelectorAll('#tree .node').length > 2`, `project ${p}`);
    await js(`ide.openFile(ide.util.joinPath(ide.root, 'quick.py'))`);
    await sleep(400);
  });
  await js(`ide.openProject(${JSON.stringify(projects[0])})`);
  await until(`ide.root === ${JSON.stringify(projects[0])}`, 'back to the first project');

  const windows = await js(`[...ide.toolWindows.keys()]`);
  console.log(`tool windows: ${windows.join(', ')}`);
  await phase('open and close every tool window', rounds(20), async () => {
    for (const id of windows) {
      await js(`ide.toolWindows.get(${JSON.stringify(id)}).show()`);
      await sleep(30);
      await js(`ide.toolWindows.get(${JSON.stringify(id)}).hide()`);
    }
  }, { heapMB: 0.2, nodes: 20, listeners: 4 });

  await js(`ide.openFile(ide.util.joinPath(ide.root, 'quick.py'))`);
  await phase('run a short program', rounds(50), async () => {
    await js(`ide.run.runCurrentFile()`);
    await until(`(() => { const s = ide.run.activeSession(); return s && !s.running && !s.starting && s.con?.text().includes('quick 42'); })()`, 'program output', 20000);
  });

  const waitPy = path.join(projects[0], 'wait.py');
  await phase('start and stop the debugger', rounds(20), async () => {
    await js(`ide.debugger.debugFile(${JSON.stringify(waitPy)})`);
    await until(`window.__debugger.state()?.state === 'running'`, 'debug session running', 30000);
    await js(`ide.runAction('StopDebug')`);
    await until(`!window.__debugger.state()`, 'debug session ended', 15000);
  });

  await phase('open and close a terminal', rounds(20), async () => {
    await js(`ide.terminal.open()`);
    await until(`ide.terminal.sessions().some((s) => s.id && !s.exited)`, 'terminal session started', 20000);
    await sleep(300);
    // Showing the tool window may also have started a session of its own.
    await js(`(document.querySelectorAll('.term-tab .term-tab-close').forEach((b) => b.click()), 1)`);
    await until(`!ide.terminal.sessions().length`, 'terminal session closed');
    await js(`ide.toolWindows.get('Terminal').hide()`);
  });

  console.log('end', JSON.stringify(await metrics()));
  const internal = await js(`ide.api.invoke('diagnostics:errors').then((l) => l.map((e) => e.message))`);
  check(internal.length === 0, `no internal errors${internal.length ? `:\n  ${internal.join('\n  ')}` : ''}`);
} catch (err) {
  check(false, err.message);
}
mainWs.close();
t.finish();
