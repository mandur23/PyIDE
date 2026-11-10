// Closing the window while a program runs asks first (main/windows.js busy names from the run plugin, the dialog in
// renderer/core/editors.js): Programs Are Running with the run's name, Stop and Close or Cancel; with unsaved files too,
// one Save Changes? dialog lists both. Cancel keeps the window and the program; Don't Save closes the app and the
// program stops. Craft's servers are checked in verify/minecraft.mjs. Port 9899.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'core', port: 9899, name: 'close-running' });
const { js, until, check, sleep } = t;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dialog = () => js(`(() => { const d = document.querySelector('#closeConfirmDialog'); return d && { title: d.querySelector('.dialog-title')?.textContent || d.innerText.split('\\n')[0], text: d.innerText, buttons: [...d.querySelectorAll('.dialog-buttons button')].map((b) => b.textContent) }; })()`);
const press = (label) => js(`([...document.querySelectorAll('#closeConfirmDialog .dialog-buttons button')].find((b) => b.textContent === ${S(label)}).click(), true)`);

try {
  const pidFile = path.join(t.project, 'long.pid');
  writeFileSync(path.join(t.project, 'long.py'), `import os, pathlib, time\npathlib.Path(${S(pidFile)}).write_text(str(os.getpid()))\ntime.sleep(120)\n`);
  await openFile(t, 'long.py');
  await js(`(ide.run.runCurrentFile(), true)`);
  await until(`ide.run.sessions().some((s) => s.title === 'long' && s.running)`, 'long.py running', 30000);
  await until(`(async () => await ide.api.exists(${S(pidFile)}))()`, 'pid written', 30000);
  const pid = Number(readFileSync(pidFile, 'utf8'));

  await js(`(ide.api.invoke('window:close'), true)`);
  await until(`!!document.querySelector('#closeConfirmDialog')`, 'close question');
  let d = await dialog();
  check(/Programs Are Running/.test(d.text) && /\blong\b/.test(d.text) && S(d.buttons) === S(['Stop and Close', 'Cancel']), `closing while a program runs asks first, naming it (${S(d)})`);
  await press('Cancel');
  await until(`!document.querySelector('#closeConfirmDialog')`, 'dialog closed');
  await sleep(500);
  check(alive(t.pid) && alive(pid) && await js(`ide.run.sessions().some((s) => s.title === 'long' && s.running)`), 'Cancel keeps the window and the program running');

  await openFile(t, 'hello.py');
  await js(`(ide.activeTab().model.setValue('print("unsaved")\\n'), true)`);
  await js(`(ide.api.invoke('window:close'), true)`);
  await until(`!!document.querySelector('#closeConfirmDialog')`, 'close question with unsaved text');
  d = await dialog();
  check(/Save Changes\?/.test(d.text) && /hello\.py/.test(d.text) && /\blong\b/.test(d.text) && S(d.buttons) === S(['Save All', "Don't Save", 'Cancel']),
    `with unsaved files too, one dialog lists both (${S(d)})`);
  // The click closes the app: it runs after this call has answered, or the answer is lost with the window.
  await js(`(setTimeout(() => [...document.querySelectorAll('#closeConfirmDialog .dialog-buttons button')].find((b) => b.textContent === "Don't Save").click(), 50), true)`);
  for (let i = 0; i < 100 && alive(t.pid); i++) await sleep(100);
  check(!alive(t.pid), "Don't Save closes the app");
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
  check(!alive(pid), 'and the program it ran is stopped');
  check(!readFileSync(path.join(t.project, 'hello.py'), 'utf8').includes('unsaved') && existsSync(path.join(t.project, 'hello.py')), 'the unsaved text was not written');
} catch (err) {
  check(false, err.message);
}
t.finish();
