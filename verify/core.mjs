import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'core', port: 9400 });
const { js, until, press, type, check, shot } = t;

try {
  check(await js(`document.querySelectorAll('#tree .node').length >= 4`), 'project tree lists fixture files');
  check(await js(`ide.interps.length > 0`), 'interpreter detected');

  await js(`[...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('hello.py')).click()`);
  await until(`ide.activeTab()?.title === 'hello.py'`, 'hello.py tab');
  check(true, 'clicking hello.py in tree opens a tab');
  await t.sleep(400);
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
  await js(`document.querySelector('#termIn').focus()`);
  await type('Get-ChildItem -Name');
  await press('Enter');
  await until(`document.querySelector('#termOut').textContent.includes('hello.py') && !document.querySelector('#termIn').disabled`, 'terminal output');
  check(true, 'terminal runs PowerShell in project folder');

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
  await shot('final.png');
} catch (err) {
  t.check(false, err.message);
  await shot('failure.png');
}
t.finish();
