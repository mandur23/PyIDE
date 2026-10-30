// A terminal opened while the project's interpreter is a venv starts with the venv activated, as in PyCharm: in
// Windows PowerShell and Command Prompt the venv's own activate script runs (the prompt shows "(.venv)", python is the
// venv's, deactivate works), under PowerShell's Restricted execution policy too (the script is read, not run as a
// file); with "Activate virtualenv" off the shell starts plain. Port 9794.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const project = mkdtempSync(path.join(tmpdir(), 'pyide-terminal-venv-'));
writeFileSync(path.join(project, 'main.py'), 'print("hi")\n');
execFileSync('py', ['-3', '-m', 'venv', path.join(project, '.venv')]);
const venvPython = path.join(project, '.venv', 'Scripts', 'python.exe');

// Restricted for this test's PowerShell sessions only (a process-scope policy inherited through the environment), so
// the check covers computers where .ps1 files are refused; nothing outside these processes changes.
const t = await launch({ name: 'terminal-venv', port: 9794, projectDir: project, env: { PSExecutionPolicyPreference: 'Restricted' } });
const { js, until, check, sleep } = t;
const text = () => js('ide.terminal.text()');
const send = (line) => js(`(ide.terminal.send(${S(`${line}\r`)}), true)`);
const lastLine = async () => (await text()).trim().split('\n').pop();
try {
  await until(`ide.currentInterp()?.executable.toLowerCase().includes('.venv')`, 'project venv selected', 30000);
  await js(`(ide.terminal.open({ shell: 'powershell' }), true)`);
  await until(`/\\(\\.venv\\) PS .*>/.test(ide.terminal.text())`, 'PowerShell prompt with (.venv)', 30000)
    .then(() => check(true, 'a PowerShell terminal opens with the venv active: the prompt shows (.venv)'), async () => check(false, `the PowerShell prompt shows (.venv): ${(await text()).slice(-600)}`));
  // A PowerShell profile of the user's may be refused under Restricted; Activate.ps1 must not be.
  check(!/Activate\.ps1[^\n]*(cannot be loaded|disabled)|(cannot be loaded|disabled)[^\n]*Activate\.ps1/i.test(await text()), 'Activate.ps1 runs under a Restricted execution policy (read as a script block, not run as a file)');
  await send('python -c "import sys; print(\'PREFIX=\' + sys.prefix)"');
  await until(`/PREFIX=.*\\.venv/i.test(ide.terminal.text())`, 'python is the venv\'s', 20000)
    .then(() => check(true, 'python in the terminal is the venv\'s'), async () => check(false, `python is the venv's: ${(await text()).slice(-400)}`));
  await send('deactivate');
  await sleep(1500);
  await send('echo "VE=$env:VIRTUAL_ENV|"');
  await until(`/VE=\\|/.test(ide.terminal.text())`, 'deactivated', 15000)
    .then(() => check(true, 'deactivate works (the venv\'s function) and clears VIRTUAL_ENV'), async () => check(false, `deactivate: ${(await text()).slice(-400)}`));
  check(!/^\(\.venv\)/.test(await lastLine()), `after deactivate the prompt has no (.venv) (${await lastLine()})`);

  await js(`(ide.terminal.open({ shell: 'cmd' }), true)`);
  await until(`/\\(\\.venv\\) [A-Z]:\\\\.*>/.test(ide.terminal.text())`, 'cmd prompt with (.venv)', 30000)
    .then(() => check(true, 'a Command Prompt terminal opens with the venv active (activate.bat)'), async () => check(false, `cmd prompt: ${(await text()).slice(-600)}`));
  await send('where python');
  await until(`ide.terminal.text().toLowerCase().includes(${S(venvPython.toLowerCase())})`, 'cmd python', 15000)
    .then(() => check(true, 'python in Command Prompt is the venv\'s first'), async () => check(false, `where python: ${(await text()).slice(-400)}`));

  const before = await js('ide.terminal.sessions().length');
  await js(`(ide.terminal.open({}), true)`);
  await until(`ide.terminal.sessions().length > ${before}`, 'default terminal');
  await until(`/\\(\\.venv\\) [A-Z]:\\\\.*>/.test(ide.terminal.text())`, 'default terminal with (.venv)', 30000)
    .then(() => check(true, 'a new terminal (Command Prompt by default) opens with the venv active'), async () => check(false, `default terminal: ${(await text()).slice(-600)}`));
  check(await js('ide.terminal.active().name') === 'Command Prompt', `the default terminal is Command Prompt (${await js('ide.terminal.active().name')})`);

  await js(`(ide.settings.set('terminal.activateVenv', false), ide.terminal.open({ shell: 'powershell' }), true)`);
  await until(`/PS [A-Z]:.*>\\s*$/.test(ide.terminal.text())`, 'plain prompt', 30000);
  check(!/\(\.venv\)/.test(await text()), 'with "Activate virtualenv" off the terminal starts without the venv');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
await js(`ide.terminal.sessions().forEach((s) => ide.terminal.close(s.id))`).catch(() => {});
t.finish();
