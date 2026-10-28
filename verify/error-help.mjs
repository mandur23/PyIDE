// The Explain button before the exception line of a traceback: in the Run console after a TypeError from a None
// value, the console's text unchanged, the dialog with the meaning, the None hint and where it was raised, Go to Error,
// Ask AI sending the traceback with the file open, the button beside "Install package" on a ModuleNotFoundError, a
// SyntaxError, and an exception of the program's own. Port 9787.
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-error-help-')), 'project');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'none_value.py'), 'def find():\n    return None\n\n\ndata = find()\nprint(data["x"])\n');
writeFileSync(path.join(project, 'missing.py'), 'import pyide_error_help_not_installed\n');
writeFileSync(path.join(project, 'syntax.py'), 'def f(:\n    pass\n');
writeFileSync(path.join(project, 'own.py'), 'class QuotaExceededError(Exception):\n    pass\n\n\nraise QuotaExceededError("over the limit")\n');

const t = await launch({ name: 'error-help', port: 9787, projectDir: project });
const { js, until, check, press, sleep } = t;
const LINK = `[...document.querySelectorAll('.run-session:not(.hidden) .console a.error-help-link, .console a.error-help-link')].pop()`;
async function runAndWait(file, name) {
  await openFile(t, file);
  await press('Shift+F10');
  await until(`(${LINK})?.textContent.endsWith(${JSON.stringify(name)}) && document.querySelector('.run-session:not(.hidden) .console, #runOut')?.textContent.includes(${JSON.stringify(file)})`, `${name} from ${file}`, 60000);
  await sleep(300);
}
async function open() {
  await js(`(${LINK}).click()`);
  await until(`!!document.querySelector('#errorHelp')`, 'Explain dialog');
  return js(`document.querySelector('#errorHelp').innerText`);
}
const close = () => js(`[...document.querySelectorAll('#errorHelp .dialog-buttons button')].find(b => b.textContent === 'Close').click()`);
try {
  await runAndWait('none_value.py', 'TypeError');
  check(await js(`(${LINK}).dataset.explain`) === 'Explain', 'an Explain button stands before the exception name');
  check(!(await js(`(${LINK}).closest('.console').textContent.includes('Explain')`)), "the console's text keeps only what the program printed");
  let text = await open();
  check(text.includes("TypeError: 'NoneType' object is not subscriptable"), 'the dialog shows the error line');
  check(text.includes('An operation or call got a value of the wrong type'), 'it says what a TypeError means');
  check(text.includes('A value is None'), 'it reads the None hint from the message');
  check(text.includes('none_value.py, line 6'), 'it names the line that raised it');
  await js(`[...document.querySelectorAll('#errorHelp .dialog-buttons button')].find(b => b.textContent === 'Go to Error').click()`);
  await until(`!document.querySelector('#errorHelp') && ide.activeTab()?.title === 'none_value.py' && ide.editor.getPosition().lineNumber === 6`, 'Go to Error opens the line');
  check(true, 'Go to Error opens the file at the line');

  await js(`(window.__asked = [], ide.aiChat.send = (q) => { window.__asked.push(q); }, true)`);
  await open();
  await js(`[...document.querySelectorAll('#errorHelp .dialog-buttons button')].find(b => b.textContent === 'Ask AI').click()`);
  await until(`window.__asked.length === 1`, 'Ask AI sent');
  const asked = await js(`window.__asked[0]`);
  check(asked.includes('Traceback (most recent call last):') && asked.includes('none_value.py", line 6') && asked.includes("TypeError: 'NoneType' object is not subscriptable"), 'Ask AI sends the whole traceback');
  check(await js(`ide.activeTab()?.title === 'none_value.py'`), 'with the file that raised it open, so AI Chat sees the code');

  await runAndWait('missing.py', 'ModuleNotFoundError');
  check(await js(`!!(${LINK}).parentElement.closest('.console').querySelector('a.console-install')`), 'a ModuleNotFoundError line keeps its Install package button beside Explain');
  text = await open();
  check(text.includes('The module is not installed'), 'it explains ModuleNotFoundError');
  await close();

  await runAndWait('syntax.py', 'SyntaxError');
  text = await open();
  check(text.includes('Python could not read the code') && text.includes('syntax.py, line 1'), `a SyntaxError is explained with its line (${JSON.stringify(text.slice(0, 200))})`);
  await close();

  await runAndWait('own.py', 'QuotaExceededError');
  text = await open();
  check(text.includes('a library or your code') && text.includes('QuotaExceededError: over the limit'), "the program's own exception gets the general explanation");
  await close();
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.finish();
