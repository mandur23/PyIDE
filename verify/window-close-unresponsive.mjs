// A window whose page crashed or hangs, with unsaved files, can still be closed: main/windows.js asks natively instead
// of waiting for the page's own question, Cancel keeps the window, and Close Anyway closes it and quits the app.
// The native message box is stubbed in the main process (its answers come from a list) and records what it was asked.
// Ports 9280 (page) and 9281 (the main process's Node inspector).
import { readFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const q = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const results = [];

async function mainProcess() {
  const target = (await (await fetch('http://127.0.0.1:9281/json/list')).json())[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  const evaluate = (expression) => new Promise((r) => {
    const id = ++seq;
    pending.set(id, (msg) => r(msg.result?.result?.value));
    ws.send(q({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, includeCommandLineAPI: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

// answers: the button index each native question gets, in order (0 Close Anyway, 1 Cancel), 1.5 s after it is asked.
async function setUp(t, answers) {
  const marks = path.join(tempDir('window-close-marks'), 'asked.jsonl');
  await t.js(`(async () => {
    const p = ide.util.joinPath(ide.root, 'unsaved.txt');
    await ide.api.write(p, 'saved\\n');
    await ide.openFile(p);
    ide.editor.getModel().setValue('not saved yet\\n');
    return true;
  })()`);
  await t.until(`ide.isDirty(ide.activeTab())`, 'a modified file');
  await sleep(600); // the window's list of modified files reaches main
  const main = await mainProcess();
  await main.evaluate(`(() => {
    const fs = require('fs');
    const answers = ${q(answers)};
    require('electron').dialog.showMessageBox = (_w, o) => {
      fs.appendFileSync(${q(marks)}, JSON.stringify({ at: Date.now(), message: o.message, detail: o.detail, buttons: o.buttons }) + '\\n');
      const response = answers.shift();
      return new Promise((r) => setTimeout(() => r({ response, checkboxChecked: false }), 1500));
    };
    return true;
  })()`);
  const asked = () => { try { return readFileSync(marks, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const closeWindow = () => main.evaluate(`(require('electron').BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())?.close(), true)`);
  const windows = () => main.evaluate(`require('electron').BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length`);
  return { main, asked, closeWindow, windows };
}

async function exits(pid, ms) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(100);
  return !alive(pid);
}

// ---------- a crashed page ----------
{
  const t = await launch({ fixture: 'core', port: 9280, name: 'window-close-crashed', args: ['--inspect=9281'] });
  try {
    const s = await setUp(t, [1, 0]);
    // Restart IDE, its quit held back until the page has crashed.
    await s.main.evaluate(`(() => {
      const { app } = require('electron');
      const quit = app.quit;
      app.quit = () => { app.quit = quit; };
      return true;
    })()`);
    await t.js(`ide.api.invoke('core:relaunch').then(() => true)`);
    t.cdp('Page.crash').catch(() => {});
    await sleep(1500);
    await s.main.evaluate(`(require('electron').app.quit(), true)`);
    await sleep(2500);
    const first = s.asked()[0];
    t.check(first?.message === 'This window stopped working.' && /unsaved\.txt/.test(first.detail) && q(first.buttons) === q(['Close Anyway', 'Cancel']),
      `restarting with a window whose page crashed asks natively, naming the unsaved file (${q(first)})`);
    t.check((await s.windows()) === 1, 'Cancel keeps the window open');
    await s.closeWindow();
    // A main-process inspector session that has evaluated code keeps Electron from exiting at all.
    s.main.close();
    t.check(await exits(t.pid, 15000), 'asked again, Close Anyway closes the window and the app quits');
    // A restart still pending would start a new instance, on the same ports.
    let relaunched = null;
    for (let i = 0; i < 80 && !relaunched; i++) {
      relaunched = await fetch('http://127.0.0.1:9280/json/version').then((r) => r.json(), () => null);
      if (!relaunched) await sleep(100);
    }
    if (relaunched) {
      const ws = new WebSocket(relaunched.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r));
      ws.send(q({ id: 1, method: 'Browser.close' }));
      await sleep(2000);
    }
    t.check(!relaunched, 'the native Cancel called the restart off: the quit that followed did not start the IDE again');
  } catch (err) {
    t.check(false, err.message);
  }
  t.close();
  results.push(...t.results);
}

// ---------- a page that hangs ----------
{
  const t = await launch({ fixture: 'core', port: 9280, name: 'window-close-hung', lang: 'ko-KR', args: ['--inspect=9281'] });
  try {
    const s = await setUp(t, [0]);
    await t.js(`(setTimeout(() => { for (;;) {} }, 200), true)`);
    await sleep(600);
    const closedAt = Date.now();
    await s.closeWindow();
    s.main.close();
    const quit = await exits(t.pid, 20000);
    const first = s.asked()[0];
    t.check(first?.message === '이 창이 응답하지 않습니다.' && /unsaved\.txt/.test(first.detail) && first.at - closedAt >= 3500,
      `a page that does not answer the close is asked natively after a few seconds, in the page's language (${q(first && { ...first, after: first.at - closedAt })})`);
    t.check(quit, 'Close Anyway closes the hung window and the app quits');
  } catch (err) {
    t.check(false, err.message);
  }
  t.close();
  results.push(...t.results);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
