// Real PTY terminal: interactive programs, Korean text, IDE shortcuts that stay out of the terminal's way,
// clipboard, shells, file links, and the Claude Code launcher (run against a stand-in claude.cmd).
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const fakeDir = mkdtempSync(path.join(tmpdir(), 'pyide-fake-claude-'));
const fakeClaude = path.join(fakeDir, 'claude.cmd');
writeFileSync(fakeClaude, [
  '@echo off',
  'echo FAKE CLAUDE READY in %CD%',
  ':loop',
  'set "line="',
  'set /p line=^> ',
  'if "%line%"=="/exit" exit /b 0',
  'echo GOT: %line%',
  'goto loop',
  '',
].join('\r\n'));
process.env.PYIDE_CLAUDE_PATH = fakeClaude;

const t = await launch({ fixture: 'core', port: 9500, name: 'terminal' });
const { js, until, press, type, check, shot, cdp } = t;
const text = () => js('ide.terminal.text()');
const focused = () => js(`!!document.activeElement?.closest('[data-terminal]')`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---------- a real shell ----------
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length === 1`, 'session started');
  await until(`/PS .*project>/.test(ide.terminal.text())`, 'PowerShell prompt in the project', 20000);
  check(await focused(), 'Alt+F12 starts a PowerShell session in the project folder and focuses it');
  await type('Write-Output "한글 출력 $(1+1)"');
  await press('Enter');
  await until(`ide.terminal.text().includes('한글 출력 2')`, 'Korean output');
  check(true, 'Korean input and output go through the PTY intact');

  // ---------- interactive program ----------
  await type('py -3 -q');
  await press('Enter');
  await until(`ide.terminal.text().includes('>>>')`, 'python REPL prompt', 20000);
  await type('print(6 * 7)');
  await press('Enter');
  await until(`/\\n42\\n/.test(ide.terminal.text())`, 'REPL answer');
  check(true, 'interactive programs (Python REPL) run inside the terminal');

  // ---------- IDE shortcuts stay out of the terminal ----------
  await press('Escape');
  check(await focused(), 'Escape stays in the terminal (Claude Code uses it to interrupt)');
  await press('Ctrl+K');
  check(await focused() && !(await js(`ide.toolWindows.get('Commit')?.isVisible() || false`)), 'Ctrl+K goes to the program, not the Commit window');
  await type('exit()');
  await press('Enter');
  await until(`/PS .*project>\\s*$/.test(ide.terminal.text().trimEnd() + ' ')`, 'back at PowerShell');
  const sideBefore = await js(`document.querySelector('#sidePanel').classList.contains('hidden')`);
  await press('Alt+1');
  check((await js(`document.querySelector('#sidePanel').classList.contains('hidden')`)) !== sideBefore, 'tool window shortcuts (Alt+1) still work from the terminal');
  await press('Alt+1');
  await js(`document.querySelector('.term-session:not(.hidden) textarea').focus()`);
  await press('Alt+F12');
  check(!(await js(`ide.toolWindows.get('Terminal').isVisible()`)), 'Alt+F12 from the terminal hides it');
  await press('Alt+F12');
  await until(`ide.toolWindows.get('Terminal').isVisible()`, 'terminal back');

  // ---------- clipboard ----------
  await js(`ide.api.invoke('clipboard:writeText', 'echo pasted-from-clipboard')`);
  await js(`document.querySelector('.term-session:not(.hidden) textarea').focus()`);
  await press('Ctrl+V');
  await press('Enter');
  await until(`ide.terminal.text().includes('\\npasted-from-clipboard')`, 'pasted command ran');
  check(true, 'Ctrl+V pastes into the terminal');

  // ---------- sessions and shells ----------
  await t.click('.term-tabs .term-pick');
  await until(`!!document.querySelector('.context-menu')`, 'shell menu');
  const shellMenu = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.firstChild.textContent)`);
  check(shellMenu.includes('Windows PowerShell') && shellMenu.includes('Command Prompt') && shellMenu.includes('Claude Code'), `new-session menu lists shells and Claude Code (${shellMenu.join(', ')})`);
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.startsWith('Command Prompt')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(`ide.terminal.sessions().length === 2 && /project>/.test(ide.terminal.text())`, 'cmd session', 20000);
  await type('echo %COMSPEC%');
  await press('Enter');
  await until(`/cmd\\.exe/i.test(ide.terminal.text())`, 'cmd output');
  check((await js(`document.querySelectorAll('.term-tab').length`)) === 2, 'a second session opens in its own tab (Command Prompt)');

  // ---------- traceback links ----------
  await type('py -3 broken.py');
  await press('Enter');
  await until(`/broken[.]py", line [0-9]+/.test(ide.terminal.text())`, 'traceback printed', 20000);
  // The prompt line after the traceback can scroll the view; aim only once the output has settled.
  await until(`/project>\s*$/.test(ide.terminal.text().trimEnd())`, 'prompt back after the traceback', 20000);
  await sleep(300);
  // The path is long enough to wrap; aim at the first cell of "broken.py" wherever it landed.
  const target = await js(`(() => {
    const p = ide.terminal.locate('broken.py"');
    const g = ide.terminal.geometry();
    const screen = document.querySelector('.term-session:not(.hidden) .xterm-screen').getBoundingClientRect();
    return { x: screen.left + (p.col + 1.5) * screen.width / g.cols, y: screen.top + (p.row - g.viewportY + 0.5) * screen.height / g.rows };
  })()`);
  // Chromium stops painting a window that other windows cover; a tiny screenshot forces a frame so xterm's link layer
  // has rendered the hovered link before the click.
  const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
  await frame();
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
  await sleep(300);
  await frame();
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await frame();
  await until(`ide.activeTab()?.title === 'broken.py'`, 'file opened from link', 8000);
  check(true, 'clicking a traceback location opens the file in the editor');

  // ---------- Claude Code ----------
  await openFile(t, 'hello.py');
  await press('Ctrl+Escape');
  await until(`ide.terminal.sessions().some(s => s.kind === 'claude')`, 'claude session');
  await until(`ide.terminal.text().includes('FAKE CLAUDE READY')`, 'claude started', 20000);
  check(await js(`document.querySelector('.term-tab.active').textContent.includes('Claude Code')`) && /READY in .*project/.test(await text()), 'Ctrl+Esc starts Claude Code in the project folder in a "Claude Code" tab');
  await js(`(ide.openFile(ide.util.joinPath(ide.root, 'hello.py')), ide.editor.setSelection(new ide.monaco.Selection(10, 1, 15, 5)), ide.editor.focus(), true)`);
  await press('Ctrl+Alt+K');
  await until(`ide.terminal.active()?.kind === 'claude'`, 'claude tab focused');
  await sleep(300);
  await press('Enter');
  await until(`ide.terminal.text().includes('GOT: @hello.py#L10-15')`, 'reference received', 8000);
  check(true, 'Ctrl+Alt+K sends "@file#Lstart-end" of the selection to Claude Code');
  await press('Ctrl+Escape');
  check((await js(`ide.terminal.sessions().filter(s => s.kind === 'claude').length`)) === 1, 'Ctrl+Esc again focuses the existing Claude Code session');
  check(await js(`!!document.querySelector('#toolbarRight .claude-btn')`), 'toolbar has a Claude Code button');
  await shot('claude.png');

  // ---------- install prompt ----------
  await js(`ide.runAction('InstallClaudeCode')`);
  await until(`document.querySelector('.dialog-title')?.textContent === 'Install Claude Code'`, 'install dialog');
  check(await js(`document.querySelector('.claude-install-cmd').textContent === 'irm https://claude.ai/install.ps1 | iex'`), 'install dialog shows the official install command');
  await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Cancel').click()`);

  // ---------- closing ----------
  const before = await js('ide.terminal.sessions().length');
  await js(`document.querySelector('.term-tab.active .term-tab-close').click()`);
  check((await js('ide.terminal.sessions().length')) === before - 1, 'closing a tab ends its session');

  // A tab closed while its shell is still starting must not leave that shell running unseen.
  const marker = `pyide-orphan-${Date.now()}`;
  const shellsWith = (m) => Number(execFileSync('powershell', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${m}') }).Count`],
  { encoding: 'utf8' }).trim());
  const closedEarly = await js(`(async () => {
    const tabs = () => document.querySelectorAll('.term-tab').length;
    const n = tabs();
    ide.terminal.open({ shell: 'cmd', command: 'echo ${marker} && ping -n 60 127.0.0.1 >nul' });
    for (let i = 0; tabs() === n && i < 1000; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r)); // no click lands in the same task (xterm finishes setting up in a timer)
    const s = ide.terminal.sessions().at(-1);
    if (s.id !== undefined) return 'the shell had already started';
    [...document.querySelectorAll('.term-tab')].pop().querySelector('.term-tab-close').click();
    return 'closed';
  })()`);
  await sleep(3000);
  check(closedEarly === 'closed' && shellsWith(marker) === 0, `closing a tab while its shell starts ends that shell (${closedEarly}, ${shellsWith(marker)} left)`);

  // A shell that cannot start (pty:create rejects) says why, and Enter closes the tab.
  const failed = await js(`(async () => {
    const api = ide.api;
    ide.api = { ...api, invoke: (ch, ...a) => (ch === 'pty:create' ? Promise.reject(new Error("Error invoking remote method 'pty:create': Error: File not found: nope.exe")) : api.invoke(ch, ...a)) };
    try { await ide.terminal.open({}); } finally { ide.api = api; }
    return { exited: ide.terminal.sessions().at(-1).exited };
  })()`);
  // xterm parses written text asynchronously.
  await until(`ide.terminal.text().includes('nope.exe')`, 'failure message', 5000).catch(() => {});
  failed.text = await js('ide.terminal.text()');
  check(failed.exited && failed.text.includes('could not start: File not found: nope.exe') && !failed.text.includes('Error invoking'), `a shell that cannot start says why (${JSON.stringify(failed.text.slice(-120))})`);
  const count = await js('ide.terminal.sessions().length');
  await js(`(document.querySelector('.term-session:not(.hidden) .xterm-helper-textarea').focus(), true)`);
  await press('Enter');
  await until(`ide.terminal.sessions().length === ${count - 1}`, 'failed tab closed with Enter');
  check(true, 'Enter closes the tab of a shell that could not start');
  await shot('terminal.png');
} catch (err) {
  check(false, err.message);
  console.log('terminal tail:', JSON.stringify((await js('ide.terminal.text()').catch(() => '')).slice(-700)));
  await shot('failure.png');
}
t.finish();
