// A program running in the Terminal is not ended without a question: closing its tab asks "Terminate the Process?"
// naming the session (Cancel keeps it running), closing the window asks Programs Are Running naming the terminal, as
// for a run, and once the program has ended (the shell back at its prompt) neither asks. Port 9952.
import { launch } from './lib.mjs';

const S = JSON.stringify;
const t = await launch({ fixture: 'core', port: 9952, name: 'terminal-busy' });
const { js, until, press, type, check, click, sleep } = t;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dialogText = () => js(`[...document.querySelectorAll('#dialogHost .dialog')].pop()?.innerText || ''`);
const pressButton = (label) => js(`([...[...document.querySelectorAll('#dialogHost .dialog')].pop().querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${S(label)}).click(), true)`);
const prompt = `/^[A-Z]:\\\\.*project>\\s*$/m.test(ide.terminal.text().trimEnd().split('\\n').pop())`;

try {
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length === 1 && ide.terminal.sessions()[0].id`, 'session started');
  await until(prompt, 'Command Prompt at its prompt', 20000);

  // An idle shell closes without a question.
  await click('.term-tab.active .term-tab-close');
  await until(`ide.terminal.sessions().length === 0`, 'idle tab closed', 8000)
    .then(() => check(true, 'closing the tab of an idle shell does not ask'), async () => check(false, `closing the tab of an idle shell does not ask (${S(await dialogText())})`));
  await sleep(300);

  // A program running in it: the tab asks first.
  await js(`(ide.terminal.open(), true)`);
  await until(`ide.terminal.sessions().length === 1 && ide.terminal.sessions()[0].id`, 'second session');
  await until(prompt, 'second prompt', 20000);
  await js(`(document.querySelector('.term-pane.active .xterm-helper-textarea').focus(), true)`);
  await type('ping -n 40 127.0.0.1');
  await press('Enter');
  await until(`ide.terminal.text().includes('Reply from 127.0.0.1') || ide.terminal.text().includes('127.0.0.1의 응답')`, 'ping running', 15000);
  await sleep(1500);
  await click('.term-tab.active .term-tab-close');
  await until(`/Terminate the Process\\?/.test([...document.querySelectorAll('#dialogHost .dialog')].pop()?.innerText || '')`, 'terminate question', 8000).catch(() => {});
  const asked = await dialogText();
  check(/Terminate the Process\?/.test(asked) && /Command Prompt/.test(asked) && /Terminate/.test(asked), `closing the tab while a program runs asks first, naming the session (${S(asked)})`);
  await pressButton('Cancel');
  await sleep(500);
  check(await js(`ide.terminal.sessions().length === 1 && !ide.terminal.sessions()[0].exited`), 'Cancel keeps the session and its program');

  // Closing the window asks too, naming the terminal.
  await js(`(ide.api.invoke('window:close'), true)`);
  await until(`!!document.querySelector('#closeConfirmDialog')`, 'window close question', 8000).catch(() => {});
  const closeQ = await js(`document.querySelector('#closeConfirmDialog')?.innerText || ''`);
  check(/Programs Are Running/.test(closeQ) && /Terminal: Command Prompt/.test(closeQ), `closing the window while a program runs in the Terminal asks, naming it (${S(closeQ)})`);
  await js(`([...document.querySelectorAll('#closeConfirmDialog .dialog-buttons button')].find((b) => b.textContent === 'Cancel').click(), true)`);
  await until(`!document.querySelector('#closeConfirmDialog')`, 'close question closed');

  // The program ends: back at the prompt, nothing asks.
  await js(`(document.querySelector('.term-pane.active .xterm-helper-textarea').focus(), true)`);
  await press('Ctrl+C');
  await until(prompt, 'prompt after Ctrl+C', 15000);
  await sleep(1500);
  await click('.term-tab.active .term-tab-close');
  await until(`ide.terminal.sessions().length === 0`, 'tab closed after the program ended', 8000)
    .then(() => check(true, 'once the program has ended, the tab closes without a question'), async () => check(false, `once the program has ended, the tab closes without a question (${S(await dialogText())})`));

  // An idle shell left open: the window closes without asking.
  await js(`(ide.terminal.open(), true)`);
  await until(`ide.terminal.sessions().length === 1 && ide.terminal.sessions()[0].id`, 'third session');
  await until(prompt, 'third prompt', 20000);
  await js(`(document.querySelector('.term-pane.active .xterm-helper-textarea').focus(), true)`);
  await type('echo done');
  await press('Enter');
  await until(`ide.terminal.text().includes('\\ndone')`, 'echo ran', 10000);
  await sleep(1500);
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
  await js(`(setTimeout(() => ide.api.invoke('window:close'), 50), true)`).catch(() => {});
  for (let i = 0; i < 100 && alive(t.pid); i++) await sleep(100);
  check(!alive(t.pid), 'with only an idle shell, closing the window does not ask');
} catch (err) {
  check(false, err.message);
}
t.finish();
