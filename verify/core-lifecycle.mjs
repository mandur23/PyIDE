// Core lifecycle under impatient or long use: two projects opened at once end on the last one with one projectOpened,
// switching projects does not pile up listeners in the main process, closed diff views give their editor back,
// a program that cannot start in a too-long folder is no internal error, environment errors read as sentences, and a
// plugin whose main module fails names the plugin. Ports 9276-9277 (9277: the main process's Node inspector).
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const q = JSON.stringify;
const userData = tempDir('core-lifecycle-ud');
const plugin = path.join(userData, 'plugins', 'broken-main');
mkdirSync(plugin, { recursive: true });
writeFileSync(path.join(plugin, 'plugin.json'), q({ id: 'broken-main', name: 'Broken Main Demo', version: '1.0.0', main: ['m.js'] }));
writeFileSync(path.join(plugin, 'm.js'), "throw new Error('boom from m.js');\n");

const t = await launch({ fixture: 'core', port: 9276, name: 'core-lifecycle', userData, args: ['--inspect=9277'] });
const { js, until, check, sleep, cdp } = t;

const mainTarget = (await (await fetch('http://127.0.0.1:9277/json/list')).json())[0];
const mainWs = new WebSocket(mainTarget.webSocketDebuggerUrl);
await new Promise((r) => mainWs.addEventListener('open', r));
let mainSeq = 0;
const mainPending = new Map();
mainWs.addEventListener('message', (m) => { const msg = JSON.parse(m.data); mainPending.get(msg.id)?.(msg); mainPending.delete(msg.id); });
const mainEval = (expr) => new Promise((r) => {
  const id = ++mainSeq;
  mainPending.set(id, (msg) => r(msg.result?.result?.value));
  mainWs.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, includeCommandLineAPI: true } }));
});
const destroyedListeners = () => mainEval(`require('electron').webContents.getAllWebContents().reduce((n, w) => n + w.listenerCount('destroyed'), 0)`);
const errors = () => js(`ide.api.invoke('diagnostics:errors')`);

try {
  // ---------- two projects opened at once ----------
  const p1 = tempDir('core-lifecycle-p1');
  const p2 = tempDir('core-lifecycle-p2');
  writeFileSync(path.join(p1, 'one.py'), 'x = 1\n');
  writeFileSync(path.join(p2, 'two.py'), 'y = 2\n');
  await js(`(() => {
    window.__opened = [];
    ide.on('projectOpened', (d) => window.__opened.push(d));
    const real = ide.api.interpreters;
    ide.api.interpreters = async (root, extra) => { if (root && /p1-/.test(root)) await new Promise((r) => setTimeout(r, 800)); return real(root, extra); };
    return true;
  })()`);
  const answers = await js(`(async () => { const a = ide.openProject(${q(p1)}); await new Promise((r) => setTimeout(r, 5)); const b = ide.openProject(${q(p2)}); return [await a, await b]; })()`);
  await sleep(1200);
  const opened = await js('window.__opened');
  const state = await js(`({ root: ide.root, title: document.title, recent: ide.settings.get('recentProjects', [])[0]?.path })`);
  check(state.root === p2 && state.title.startsWith(path.basename(p2)) && state.recent === p2, `the project opened last is the one open, titled and first in Recent Projects (${q(state)})`);
  check(q(opened) === q([p2]) && answers[0] === false && answers[1] === true, `projectOpened fires once, for the last project; the overtaken open answers false (${q({ opened, answers })})`);
  await js(`(window.__opened = [], true)`);
  await js(`Promise.all([ide.openProject(${q(p1)}), ide.openProject(${q(p1)})])`);
  await sleep(1200);
  check(q(await js('window.__opened')) === q([p1]), `opening the same project twice at once emits projectOpened once (${q(await js('window.__opened'))})`);

  // ---------- project switches: one 'destroyed' listener per window ----------
  const before = await destroyedListeners();
  for (let i = 0; i < 12; i++) await js(`ide.openProject(${q(i % 2 ? p1 : p2)})`);
  const after = await destroyedListeners();
  check(typeof before === 'number' && after - before <= 1, `12 project switches add no 'destroyed' listeners in the main process (${before} -> ${after})`);

  // ---------- diff views ----------
  const a = path.join(p1, 'left.py');
  const b = path.join(p1, 'right.py');
  writeFileSync(a, Array.from({ length: 60 }, (_, i) => `value_${i} = ${i}\n`).join(''));
  writeFileSync(b, Array.from({ length: 60 }, (_, i) => `value_${i} = ${i % 7 ? i : -i}\n`).join(''));
  const compareOnce = async () => {
    await js(`ide.compare.files(${q(a)}, ${q(b)})`);
    await until(`ide.compare.view()?.ready()`, 'diff view ready');
    await js(`(ide.closeTabObject(ide.activeTab(), true), true)`);
  };
  const counters = async () => {
    await cdp('HeapProfiler.collectGarbage');
    await cdp('HeapProfiler.collectGarbage');
    return (await cdp('Memory.getDOMCounters')).result;
  };
  for (let i = 0; i < 5; i++) await compareOnce();
  const c0 = await counters();
  for (let i = 0; i < 30; i++) await compareOnce();
  const c1 = await counters();
  const nodes = (c1.nodes - c0.nodes) / 30;
  const listeners = (c1.jsEventListeners - c0.jsEventListeners) / 30;
  check(nodes < 5 && listeners < 2, `Compare Files opened and closed 30 times: ${nodes.toFixed(1)} DOM nodes and ${listeners.toFixed(1)} listeners kept per round (a leaked diff editor keeps ~46 and ~11)`);

  // ---------- a program started in a folder whose path is too long for Windows ----------
  let long = p2;
  while (long.length < 280) long = path.join(long, 'a_rather_long_folder_name_x');
  mkdirSync(long, { recursive: true });
  const errsBefore = (await errors()).length;
  const out = await js(`new Promise(async (resolve) => {
    let text = '';
    const id = await ide.api.invoke('project:exec', 'py', ['-3', '-c', 'print(1)'], ${q(long)});
    ide.proc.attach(id, { data: (s) => { text += s; }, exit: (code) => resolve({ text, code }) });
    setTimeout(() => resolve({ text, code: 'none' }), 8000);
  })`);
  await sleep(1000);
  const newErrors = (await errors()).slice(errsBefore).map((e) => e.message);
  check(!newErrors.some((m) => /ENOTCONN/.test(m)), `no uncaught "read ENOTCONN" in the main process (${q(newErrors)})`);
  check(out.code !== 'none' && /too long/i.test(out.text), `the output says the working directory is too long (${q(out)})`);

  // ---------- environment errors read as sentences ----------
  const texts = await js(`[
    "Error invoking remote method 'x': Error: connect ECONNREFUSED 203.0.113.5:443",
    'net::ERR_CONNECTION_REFUSED',
    'getaddrinfo ENOTFOUND example.invalid',
    "Error invoking remote method 'x': Error: spawn git ENOENT",
    "EPERM: operation not permitted, open 'C:\\\\x.txt'",
    'Something else entirely',
    "Error invoking remote method 'debug:start': Error: Could not connect to debugpy on port 5678: connect ECONNREFUSED 127.0.0.1:5678",
    'connect ECONNREFUSED ::1:8000',
    'request to http://localhost:9000/ failed, reason: connect ETIMEDOUT',
  ].map((m) => ide.util.errorText(new Error(m)))`);
  check(/Cannot reach the server/.test(texts[0]) && /Cannot reach the server/.test(texts[1]) && /Cannot reach the server/.test(texts[2]),
    `network failures read as one sentence (${q(texts.slice(0, 3))})`);
  check(/^git is not installed or not on PATH/.test(texts[3]), `a program that is not found is named (${q(texts[3])})`);
  check(texts[4] === 'Access is denied (the file may be read-only)' && texts[5] === 'Something else entirely', 'file errors and other messages read as before');
  check(texts[6] === 'Could not connect to debugpy on port 5678: connect ECONNREFUSED 127.0.0.1:5678' && /^connect ECONNREFUSED ::1/.test(texts[7]) && texts[8].startsWith('request to http://localhost'),
    `a failure on this computer's own address (127.0.0.1, ::1, localhost) keeps its own text (${q(texts.slice(6))})`);

  // ---------- a plugin whose main module fails ----------
  const loadError = (await errors()).find((e) => e.source === 'plugin' && /boom from m\.js/.test(e.message));
  check(!!loadError && /Broken Main Demo/.test(loadError.title || ''), `the load error names the plugin (${q(loadError?.title)})`);

  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
}
mainWs.close();
t.finish();
