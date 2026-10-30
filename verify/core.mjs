import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'core', port: 9400 });
const { js, until, press, type, check, shot } = t;

try {
  check(await js(`document.querySelectorAll('#tree .node').length >= 4`), 'project tree lists fixture files');
  check(await js(`ide.interps.length > 0`), 'interpreter detected');

  await js(`[...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('hello.py')).click()`);
  await until(`ide.activeTab()?.title === 'hello.py'`, 'hello.py tab');
  check(true, 'clicking hello.py in tree opens a tab');
  await until(`[...document.querySelectorAll('.view-line span span')].some(s => s.textContent.trim() === 'helper')`, 'editor tokens painted');
  const colors = await js(`(() => { const c = {}; for (const s of document.querySelectorAll('.view-line span span')) c[s.textContent.trim()] = getComputedStyle(s).color; return c; })()`);
  check(colors['def'] === 'rgb(207, 142, 109)', `keyword color cf8e6d (got ${colors['def']})`);
  check(colors['helper'] === 'rgb(86, 168, 245)', `function declaration color 56a8f5 (got ${colors['helper']})`);

  await press('Shift+F10');
  await until(`document.querySelector('#runOut')?.textContent.includes('name?')`, 'program prompts');
  check(await js(`document.querySelector('#runOut').textContent.includes('Hello, PyIDE! 42 3')`), 'Shift+F10 runs current file');
  await js(`document.querySelector('#runIn').focus()`);
  await type('Claude');
  await press('Enter');
  await until(`document.querySelector('#runOut').textContent.includes('exit code')`, 'process exit');
  const out = await js(`document.querySelector('#runOut').textContent`);
  check(out.includes('hi Claude'), 'stdin reaches the program');
  check(out.includes('Process finished with exit code 1'), 'exit code shown');
  check(await js(`[...document.querySelectorAll('#runOut a')].some(a => a.textContent.includes('hello.py'))`), 'traceback lines are links');
  await shot('run.png');

  await openFile(t, 'broken.py');
  await until(`ide.problems.all().some(p => p.path.endsWith('broken.py'))`, 'syntax problem for broken.py');
  check(true, 'syntax error reported on open');
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 1 })`);
  await type(' ');
  check(await js(`!!document.querySelector('.tab.active .dirty')`), 'typing marks tab dirty');
  await press('Ctrl+S');
  await until(`!document.querySelector('.tab.active .dirty')`, 'saved');
  check(true, 'Ctrl+S saves');

  await press('Alt+F12');
  await until(`ide.toolWindows.get('Terminal').isVisible()`, 'terminal visible');
  await until(`/^[A-Z]:\\\\.*project>/m.test(ide.terminal.text())`, 'Command Prompt in the project folder', 20000);
  await type('dir /b');
  await press('Enter');
  await until(`ide.terminal.text().includes('hello.py')`, 'terminal output');
  check(true, 'terminal runs Command Prompt in the project folder');

  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+N');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'goto file popup');
  await type('util');
  await until(`document.querySelector('.popup-item.active')?.textContent.includes('util.py')`, 'util.py suggested');
  await press('Enter');
  await until(`ide.activeTab()?.title === 'util.py'`, 'util.py opened');
  check(true, 'Ctrl+Shift+N opens util.py');

  await press('Ctrl+Shift+A');
  await type('Duplicate Line');
  await until(`document.querySelector('.popup-item.active')?.textContent.includes('Duplicate Line')`, 'action found');
  await press('Escape');
  check(true, 'Find Action lists registered actions');

  await press('Alt+1');
  check(await js(`document.querySelector('#sidePanel').classList.contains('hidden')`), 'Alt+1 hides project panel');
  await press('Alt+1');
  check(await js(`!document.querySelector('#sidePanel').classList.contains('hidden')`), 'Alt+1 shows project panel');

  // ---------- console links, process input ----------
  const traceback = '  File "<frozen runpy>", line 198, in _run_module_as_main\n  File "C:\\p\\app.py", line 3, in <module>\n';
  const links = await js(`(() => { const host = document.createElement('div'); ide.ui.console(host).append(${JSON.stringify(traceback)}); return [...host.querySelectorAll('a')].map(a => a.textContent); })()`);
  check(links.length === 1 && links[0] === 'File "C:\\p\\app.py", line 3', `traceback frames without a file ("<frozen runpy>") are not links (${JSON.stringify(links)})`);
  // Input sent while a program exits meets a closed pipe (EPIPE), and input after closeInput a finished stream.
  const writes = await js(`(async () => {
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const id = await ide.api.invoke('project:exec', 'cmd.exe', ['/c', 'exit 0'], ide.root);
      let done = false;
      ide.proc.attach(id, { exit: () => { done = true; } });
      while (!done) { await ide.proc.input(id, 'typed while the program exits\\n'); n++; }
    }
    const id = await ide.api.invoke('project:exec', 'cmd.exe', ['/c', 'ping -n 3 127.0.0.1 >nul'], ide.root);
    ide.proc.attach(id, {});
    await ide.proc.closeInput(id);
    await ide.proc.input(id, 'typed after the input was closed\\n');
    ide.proc.kill(id);
    return n;
  })()`);
  await t.sleep(500);
  const internal = await js(`ide.api.invoke('diagnostics:errors').then(list => list.map(e => e.message))`);
  check(!internal.some((m) => /write after end|EPIPE/i.test(m)), `input to a process that exits or whose stdin is closed is not an internal error (${writes} writes; ${JSON.stringify(internal)})`);
  // spawn refuses a .cmd without a shell (EINVAL) synchronously: the caller still gets output and an exit code.
  writeFileSync(path.join(t.project, 'tool.cmd'), '@echo tool\r\n');
  const refused = await js(`(async () => {
    const id = await ide.api.invoke('project:exec', ide.util.joinPath(ide.root, 'tool.cmd'), [], ide.root);
    return new Promise((resolve) => { let out = ''; ide.proc.attach(id, { data: (t) => { out += t; }, exit: (code) => resolve({ out, code }) }); });
  })()`);
  check(refused.code === -1 && /^Cannot start .*tool\.cmd: EINVAL/.test(refused.out), `a program spawn refuses ends with its error and exit code -1 (${JSON.stringify(refused)})`);

  // A file given as the project (a stale last project or recent entry) opens its folder and then the file.
  mkdirSync(path.join(t.project, 'received'), { recursive: true });
  writeFileSync(path.join(t.project, 'received', 'ex1.py'), 'print(1)\n');
  const root = await js('ide.root');
  // The terminal opened above would make the switch ask whether to end it.
  await js(`(ide.terminal?.sessions().forEach((s) => ide.terminal.close(s.id)), true)`);
  await until(`!ide.terminal?.sessions().some((s) => !s.exited)`, 'terminals closed');
  await js(`ide.openProject(${JSON.stringify(path.join(t.project, 'received', 'ex1.py'))})`);
  await until(`ide.activeTab()?.title === 'ex1.py'`, 'ex1.py opened');
  const after = await js(`ide.api.invoke('diagnostics:errors').then(list => list.map(e => e.message))`);
  check(await js('ide.root') === path.join(t.project, 'received') && !after.some((m) => /ENOTDIR/.test(m)),
    `a file given as the project opens its folder and the file, without an ENOTDIR error (${JSON.stringify(after.filter((m) => /ENOTDIR/.test(m)))})`);
  await js(`ide.openProject(${JSON.stringify(root)})`);
  await shot('final.png');
} catch (err) {
  t.check(false, err.message);
  await shot('failure.png');
}
t.finish();
