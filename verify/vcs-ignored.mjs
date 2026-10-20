// Files and folders that .gitignore excludes are shown in orange in the project tree, including what an ignored
// folder holds, while tracked and new files keep their usual colors; the color follows the theme.
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-ignored-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const t = await launch({ fixture: 'core', port: 9860, name: 'vcs-ignored' });
const { js, until, check, shot } = t;
try {
  const p = t.project;
  writeFileSync(path.join(p, '.gitignore'), 'build/\n*.log\nsecret.env\n.venv/\n');
  for (const d of ['build/out', 'logs', '.venv/Lib']) mkdirSync(path.join(p, d), { recursive: true });
  writeFileSync(path.join(p, 'build/out/app.bin'), 'x');
  writeFileSync(path.join(p, 'logs/run.log'), 'x');
  writeFileSync(path.join(p, 'logs/keep.txt'), 'x');
  writeFileSync(path.join(p, 'secret.env'), 'x');
  writeFileSync(path.join(p, '.venv/Lib/site.py'), 'x');
  git(p, 'init');
  git(p, 'add', '.gitignore', 'hello.py');
  git(p, 'commit', '-m', 'init');
  writeFileSync(path.join(p, 'hello.py'), 'print("changed")\n');
  await js(`(ide.emit('filesChanged'), ide.refreshTree(), true)`);
  const color = (name) => js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)}); return n ? getComputedStyle(n.querySelector('.name')).color : null; })()`);
  const expand = (name) => js(`(() => { [...document.querySelectorAll('#tree .node')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)})?.click(); return true; })()`);
  const ORANGE_DARK = 'rgb(224, 145, 61)';
  await until(`(() => { const n = [...document.querySelectorAll('#tree .node')].find((r) => r.querySelector('.name').textContent === 'build'); return n && getComputedStyle(n.querySelector('.name')).color === '${ORANGE_DARK}'; })()`, 'ignored folder colored', 20000);
  check(true, 'an ignored folder (build/) is orange');
  check(await color('secret.env') === ORANGE_DARK && await color('.venv') === ORANGE_DARK, 'an ignored file and an ignored virtualenv folder are orange');
  await expand('build');
  await until(`[...document.querySelectorAll('#tree .node .name')].some((n) => n.textContent === 'out')`, 'build expanded');
  await expand('out');
  await until(`[...document.querySelectorAll('#tree .node .name')].some((n) => n.textContent === 'app.bin')`, 'out expanded');
  check(await color('out') === ORANGE_DARK && await color('app.bin') === ORANGE_DARK, 'what an ignored folder holds is orange too');
  await expand('logs');
  await until(`[...document.querySelectorAll('#tree .node .name')].some((n) => n.textContent === 'run.log')`, 'logs expanded');
  check(await color('run.log') === ORANGE_DARK, 'a file matched by a pattern (*.log) is orange');
  const keep = await color('keep.txt');
  const hello = await color('hello.py');
  const plain = await color('broken.py');
  check(keep !== ORANGE_DARK && hello !== ORANGE_DARK && plain !== ORANGE_DARK && hello !== plain, `new, modified and unchanged files keep their own colors (${keep}, ${hello}, ${plain})`);
  check(await color('logs') !== ORANGE_DARK, 'a folder that is only partly ignored is not orange');
  await shot('ignored-dark.png');
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light');
  check(await color('secret.env') === 'rgb(194, 106, 0)', 'the light theme uses a darker orange');
  await shot('ignored-light.png');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.finish();
