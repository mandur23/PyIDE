// Opening a folder runs nothing it ships until the user trusts it (PyCharm's "Trust and Open Project"): an untrusted
// repository with its own virtualenv, .env and .git opens after a question; in Safe Mode its venv's Python is not
// started, git does not run and the .env is not loaded; Trust Project from the bar turns everything on; Cancel opens
// nothing; a project created with New Project is trusted; projects opened before this feature stay trusted.
import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'pyide-trust-'));
const home = path.join(work, 'home');
cpSync(path.join(import.meta.dirname, 'fixtures', 'core'), home, { recursive: true });
const repo = path.join(work, 'downloaded-repo');
mkdirSync(repo);
writeFileSync(path.join(repo, 'show_env.py'), 'import os\nprint("FOO=" + os.environ.get("FOO", "unset"))\n');
writeFileSync(path.join(repo, '.env'), 'FOO=from_env\n');
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' });
git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init');
execFileSync('py', ['-3', '-m', 'venv', '.venv'], { cwd: repo, stdio: 'ignore' });
const venvPy = path.join(repo, '.venv', 'Scripts', 'python.exe').toLowerCase();

// The home project was opened before (recent projects): the first run of the feature trusts it.
const userData = path.join(work, 'userdata');
mkdirSync(userData);
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ recentProjects: [{ path: home, opened: Date.now() }] }));

const t = await launch({ fixture: 'core', port: 9881, name: 'trust', projectDir: home, userData, env: { PYIDE_TRUST_ALL: '' } });
const { js, until, check, sleep, press } = t;
const q = JSON.stringify;
const dialogTitle = `[...document.querySelectorAll('.dialog-title')].map(n => n.textContent).join('|')`;
const click = (label) => js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${q(label)}).click(), true)`);
const runOut = `(document.querySelector('.run-session:not(.hidden) .console, #runOut')?.textContent || '')`;
try {
  check(await js(`ide.trusted`) === true && await js(`document.querySelector('#trustBar').classList.contains('hidden')`), 'a project opened before the feature existed opens without asking');

  // ---------- Cancel ----------
  js(`ide.openProject(${q(repo)})`);
  await until(`${dialogTitle}.includes('Trust and Open Project?')`, 'trust question');
  await click('Cancel');
  await sleep(500);
  check(await js(`ide.util.samePath(ide.root, ${q(home)})`), 'Cancel opens nothing and keeps the current project');

  // ---------- Safe Mode ----------
  js(`ide.openProject(${q(repo)})`);
  await until(`${dialogTitle}.includes('Trust and Open Project?')`, 'trust question again');
  await click('Preview in Safe Mode');
  await until(`ide.root && ide.util.samePath(ide.root, ${q(repo)})`, 'opened in safe mode');
  await sleep(1500);
  check(!(await js(`document.querySelector('#trustBar').classList.contains('hidden')`)), 'Safe Mode shows the trust bar');
  check(!(await js(`ide.interps.some(i => i.executable.toLowerCase() === ${q(venvPy)})`)), "Safe Mode does not start the project's own virtualenv Python");
  check((await js(`ide.api.invoke('git:status', ide.root)`)).isRepo === false, 'Safe Mode runs no git in the project');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'show_env.py'))`);
  await until(`ide.activeTab()?.title === 'show_env.py'`, 'file');
  await press('Ctrl+Shift+F10');
  await until(`${runOut}.includes('Process finished')`, 'run', 30000);
  check((await js(runOut)).includes('FOO=unset'), "Safe Mode does not load the project's .env");

  // ---------- Trust Project from the bar ----------
  await js(`(document.querySelector('#trustBar button').click(), true)`);
  await until(`window.__ideReady === true && ide.root && ide.util.samePath(ide.root, ${q(repo)}) && ide.trusted === true`, 'reloaded trusted', 30000);
  check(await js(`document.querySelector('#trustBar').classList.contains('hidden')`) && !(await js(dialogTitle)), 'Trust Project reopens it normally, without asking again');
  await until(`ide.interps.some(i => i.executable.toLowerCase() === ${q(venvPy)})`, 'venv listed', 30000);
  check(true, "a trusted project's virtualenv is found");
  check((await js(`ide.api.invoke('git:status', ide.root)`)).isRepo === true, 'git runs in a trusted project');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'show_env.py'))`);
  await until(`ide.activeTab()?.title === 'show_env.py'`, 'file again');
  await press('Ctrl+Shift+F10');
  await until(`${runOut}.includes('FOO=from_env')`, 'env loaded', 30000);
  check(true, "a trusted project's .env is loaded");

  // ---------- New Project ----------
  const created = path.join(work, 'made-here');
  await js(`ide.api.invoke('project:create', ${q(created)}, { 'main.py': 'print(1)\\n' })`);
  check(await js(`ide.api.invoke('trust:isTrusted', ${q(created)})`), 'a project made with New Project is trusted');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
t.finish();
