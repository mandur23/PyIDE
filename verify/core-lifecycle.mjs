// Core lifecycle under impatient or long use: two projects opened at once end on the last one with one projectOpened,
// switching projects does not pile up listeners in the main process, closed diff views give their editor back,
// a program that cannot start in a too-long folder is no internal error, environment errors read as sentences, and a
// plugin whose main module fails names the plugin, there is no application menu whose Ctrl+R, Ctrl+Shift+R, Ctrl+W or
// Ctrl+M would reload, close or minimize the window behind a key the page leaves alone (F12 opens DevTools); at the end, the quit waits for a program asked to stop and for a
// holdQuit job, runs the quit handlers once, and kills a program that does not stop. Ports 9276-9277 (9277: the main
// process's Node inspector).
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const q = JSON.stringify;
const userData = tempDir('core-lifecycle-ud');
const plugin = path.join(userData, 'plugins', 'broken-main');
mkdirSync(plugin, { recursive: true });
writeFileSync(path.join(plugin, 'plugin.json'), q({ id: 'broken-main', name: 'Broken Main Demo', version: '1.0.0', main: ['m.js'] }));
writeFileSync(path.join(plugin, 'm.js'), "throw new Error('boom from m.js');\n");
// A plugin whose work holds the quit (main.js's quit gate): a program that saves for 2 s after `stop`, one that ignores
// `stop`, and a holdQuit job of 1 s; each, and the plugin's before-quit and will-quit handlers, leave a timed mark.
const marks = path.join(userData, 'quit-marks.txt');
const quitDemo = path.join(userData, 'plugins', 'quit-demo');
mkdirSync(quitDemo, { recursive: true });
writeFileSync(path.join(quitDemo, 'plugin.json'), q({ id: 'quit-demo', name: 'Quit Demo', version: '1.0.0', main: ['q.js'] }));
const saver = `const fs = require('fs'); fs.appendFileSync(${q(marks)}, 'started ' + Date.now() + '\\n');
process.stdin.on('data', (d) => { if (String(d) === 'stop\\n') setTimeout(() => { fs.appendFileSync(${q(marks)}, 'saved ' + Date.now() + '\\n'); process.exit(0); }, 2000); });`;
const stubborn = `require('fs').appendFileSync(${q(marks)}, 'stubborn ' + process.pid + '\\n'); process.stdin.on('data', () => {}); setInterval(() => {}, 1000);`;
writeFileSync(path.join(quitDemo, 'q.js'), `const fs = require('fs');
const mark = (m) => fs.appendFileSync(${q(marks)}, m + ' ' + Date.now() + '\\n');
exports.register = ({ ipcMain, app, startProcess, holdQuit }) => {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  ipcMain.handle('quitDemo:start', () => [
    startProcess(process.execPath, ['-e', ${q(saver)}], { env, quitInput: 'stop\\n', quitWaitMs: 20000 }),
    startProcess(process.execPath, ['-e', ${q(stubborn)}], { env, quitInput: 'stop\\n', quitWaitMs: 1500 }),
  ]);
  holdQuit(() => new Promise((r) => { setTimeout(() => { mark('held'); r(); }, 1000); }), 10000);
  app.on('before-quit', () => mark('before-quit'));
  app.on('will-quit', () => mark('will-quit'));
};
`);
const readMarks = () => { try { return readFileSync(marks, 'utf8'); } catch { return ''; } };
const markTime = (name) => Number(new RegExp(`^${name} (\\d+)$`, 'm').exec(readMarks())?.[1]) || null;

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

  // ---------- window keys the page leaves alone ----------
  // Sent by the main process: CDP key events never reach menu accelerators, so a suite pressing keys through CDP
  // never saw Electron's default menu reload the page on Ctrl+R.
  check(await mainEval(`require('electron').Menu.getApplicationMenu() === null`) === true, 'the app has no application menu');
  const keysFile = path.join(p1, 'keys.py');
  writeFileSync(keysFile, 'k = 1\n');
  await js(`ide.openProject(${q(p1)})`);
  await js(`ide.openFile(${q(keysFile)}).then(() => (ide.editor.trigger('test', 'type', { text: 'edited ' }), true))`);
  const keysTab = `ide.findTab(${q(keysFile)})`;
  await until(`${keysTab} && ide.isDirty(${keysTab}) && !![...document.querySelectorAll('#tree .node')].find((n) => n._entry?.name === 'keys.py')`, 'modified keys.py in the tree');
  await js(`([...document.querySelectorAll('#tree .node')].find((n) => n._entry?.name === 'keys.py').dataset.keysRow = '1', true)`);
  await t.click('[data-keys-row="1"]');
  await js(`(window.__keysMark = 'same page', true)`);
  const pressInMain = (keyCode, modifiers) => mainEval(`(() => {
    const w = require('electron').BrowserWindow.getAllWindows().find((x) => x.isVisible());
    w.webContents.focus();
    for (const type of ['keyDown', 'keyUp']) w.webContents.sendInputEvent({ type, keyCode: ${q(keyCode)}, modifiers: ${q(modifiers)} });
    return true;
  })()`);
  const windowState = () => mainEval(`require('electron').BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), minimized: w.isMinimized() }))`);
  const afterKey = async (label, dialogs) => {
    await sleep(1500);
    const page = await js(`({ mark: window.__keysMark, dirty: ide.isDirty(${keysTab}), dialogs: document.getElementById('dialogHost').childElementCount, focus: document.activeElement?.closest('.monaco-editor') ? 'editor' : document.activeElement?.closest('#tree') ? 'tree' : document.activeElement?.tagName })`).catch((e) => ({ error: e.message }));
    const wins = await windowState();
    check(page.mark === 'same page' && page.dirty && page.dialogs === dialogs && wins.length === 1 && wins[0].visible && !wins[0].minimized,
      `${label}: the page, its modified document and the window stay (${q({ page, wins })})`);
    if (page.mark !== 'same page') {
      await until('window.__ideReady === true', 'the page after a reload', 60000).catch(() => {});
      await js(`(window.__keysMark = 'same page', true)`).catch(() => {});
    }
  };
  check(await js(`!!document.activeElement?.closest('#tree')`), 'the keyboard is in the project tree');
  for (const [keyCode, mods, label] of [['R', ['control'], 'Ctrl+R in the project tree'], ['W', ['control'], 'Ctrl+W in the project tree'], ['M', ['control'], 'Ctrl+M in the project tree']]) {
    await pressInMain(keyCode, mods);
    await afterKey(label, 0);
  }
  // With a dialog up the IDE's keymap takes no key at all (Ctrl+Shift+R in the tree is Replace in Files).
  await js(`(window.__keysDialog = ide.ui.dialog({ title: 'Keys', body: Object.assign(document.createElement('input'), { className: 'input' }) }), true)`);
  for (const [keyCode, mods, label] of [['R', ['control'], 'Ctrl+R in a dialog'], ['R', ['control', 'shift'], 'Ctrl+Shift+R in a dialog'], ['W', ['control'], 'Ctrl+W in a dialog']]) {
    await pressInMain(keyCode, mods);
    await afterKey(label, 1);
  }
  await js(`(window.__keysDialog?.close(), ide.closeTabObject(${keysTab}, true), true)`).catch(() => {});
  const devTools = async (open) => {
    for (let i = 0; i < 50; i++) { if (await mainEval(`require('electron').BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()`) === open) return true; await sleep(100); }
    return false;
  };
  await pressInMain('F12', []);
  const devToolsOpened = await devTools(true);
  await pressInMain('F12', []);
  check(devToolsOpened && await devTools(false), 'run from the source folder, F12 opens DevTools and closes them again');

  check(t.consoleErrors.length === 0, 'no renderer exceptions');

  // ---------- the quit gate (last: the app quits) ----------
  await js(`ide.api.invoke('quitDemo:start')`);
  for (let i = 0; i < 100 && !(markTime('started') && /^stubborn \d+$/m.test(readMarks())); i++) await sleep(100);
  const stubbornPid = Number(/^stubborn (\d+)$/m.exec(readMarks())?.[1]);
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // A main-process inspector session that has evaluated code keeps Electron from exiting at all.
  mainWs.close();
  await sleep(300);
  js(`(ide.api.invoke('window:closeNow'), true)`).catch(() => {});
  const quitAt = Date.now();
  while (isAlive(t.pid) && Date.now() - quitAt < 60000) await sleep(100);
  const took = Date.now() - quitAt;
  const m = readMarks();
  check(!isAlive(t.pid) && took < 30000, `closing the window quits the app after the work it waits for (${took} ms)`);
  check(markTime('saved') > markTime('started'), `a program started with quitInput gets it at quit and the time to finish saving (${q(m)})`);
  check(!!markTime('held'), 'a holdQuit job is waited for');
  check((m.match(/^before-quit /gm) || []).length === 1 && (m.match(/^will-quit /gm) || []).length === 1,
    'the quit handlers of the features run once each, though the quit was held and taken up again');
  check(markTime('will-quit') >= markTime('saved') && markTime('will-quit') >= markTime('held'), 'the will-quit handlers run after the wait, not before it');
  check(stubbornPid > 0 && !isAlive(stubbornPid), 'a program that does not stop within its quitWaitMs is killed');
} catch (err) {
  check(false, err.message);
}
mainWs.close();
t.finish();
