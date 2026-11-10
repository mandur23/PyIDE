// Opening a folder runs nothing it ships until the user trusts it (PyCharm's "Trust and Open Project"): an untrusted
// repository with its own virtualenv, .env and .git opens after a question; in Safe Mode its venv's Python is not
// started, git does not run and the .env is not loaded; Trust Project from the bar turns everything on; Cancel opens
// nothing; a project created with New Project is trusted; projects opened before this feature stay trusted.
import { execFileSync } from 'child_process';
import { createServer } from 'http';
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
// A README whose images tell a server who opened it: an untrusted folder's Markdown preview fetches nothing remote.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fetched = [];
const imgServer = createServer((req, res) => { fetched.push(req.url); res.setHeader('content-type', 'image/png'); res.end(PNG); });
await new Promise((r) => imgServer.listen(0, '127.0.0.1', r));
const tracker = `http://127.0.0.1:${imgServer.address().port}`;
writeFileSync(path.join(repo, 'pic.png'), PNG);
writeFileSync(path.join(repo, 'README.md'), `# Readme\n\n![remote](${tracker}/opened.png)\n\n<video src="${tracker}/v.mp4" controls></video>\n\n![local](pic.png) ![inline](data:image/png;base64,${PNG.toString('base64')})\n`);
// A notebook as well: a Markdown cell's image, and a saved HTML output's (IPython's Image(url=...) saves one).
writeFileSync(path.join(repo, 'notes.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
  { cell_type: 'markdown', id: 'm1', metadata: {}, source: [`![remote](${tracker}/nb.png) ![local](pic.png)`] },
  { cell_type: 'code', id: 'c1', metadata: {}, execution_count: 1, source: ['Image(url=...)'],
    outputs: [{ output_type: 'display_data', metadata: {}, data: { 'text/html': [`<img src="${tracker}/nb-output.png">`], 'text/plain': ['<Image>'] } }] },
] }));
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
  const md = 'ide.activeTab().host.querySelector';
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'README.md'))`);
  await until(`ide.activeTab()?.title === 'README.md' && ${md}('.vw-md-preview img[alt="local"]')?.naturalWidth === 1 && ${md}('.vw-md-preview img[alt="inline"]')?.naturalWidth === 1`, 'README preview', 15000);
  await sleep(800);
  check(!(await js(`${md}('img[alt="remote"]').hasAttribute('src') || ${md}('video').hasAttribute('src')`)) && !fetched.length,
    `Safe Mode's Markdown preview loads no remote image or video, only project and data: images (fetched: ${q(fetched)})`);
  check(await js(`${md}('.vw-md-blocked').textContent`) === 'Remote images are not loaded: this folder is not trusted', 'and says so in its toolbar');
  const nb = 'ide.activeTab().host.querySelector';
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'notes.ipynb'))`);
  await until(`ide.activeTab()?.title === 'notes.ipynb' && ${nb}('.nb-md img[alt="local"]')?.naturalWidth === 1 && !!${nb}('iframe.nb-html')`, 'notebook shown', 15000);
  await sleep(1500);
  check(!(await js(`${nb}('.nb-md img[alt="remote"]').hasAttribute('src')`)) && !fetched.length,
    `Safe Mode's notebook loads no remote image, in a Markdown cell or a saved HTML output, but the project's own (fetched: ${q(fetched)})`);
  check(await js(`${nb}('.nb-md .nb-md-blocked')?.textContent`) === 'Remote images are not loaded: this folder is not trusted', 'and the Markdown cell says so');
  check(t.takeCsp(/"img-src data:"[^]*about:srcdoc/) >= 1, "the HTML output's image is refused by the policy the output frame adds");

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
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'README.md'))`);
  await until(`ide.activeTab()?.title === 'README.md' && ide.activeTab().host.querySelector('.vw-md-preview img[alt="local"]')?.naturalWidth === 1`, 'trusted README preview', 15000);
  await sleep(800);
  // A trusted notebook's HTML output (restored with the tabs) loads what it likes, as its scripts run too.
  check(!fetched.some((u) => u !== '/nb-output.png') && await js(`ide.activeTab().host.querySelector('.vw-md-blocked').textContent`) === 'Images over plain http are not loaded',
    `a trusted project's preview still loads nothing over plain http, and says so (fetched: ${q(fetched)})`);
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'notes.ipynb'))`);
  await until(`ide.activeTab()?.title === 'notes.ipynb' && !!ide.activeTab().host.querySelector('.nb-md .nb-md-blocked')`, 'trusted notebook', 15000);
  check(await js(`ide.activeTab().host.querySelector('.nb-md .nb-md-blocked').textContent`) === 'Images over plain http are not loaded' && !fetched.some((u) => u === '/nb.png'),
    `a trusted project's notebook loads no Markdown image over plain http either (fetched: ${q(fetched)})`);

  // ---------- New Project ----------
  const created = path.join(work, 'made-here');
  await js(`ide.api.invoke('project:create', ${q(created)}, { 'main.py': 'print(1)\\n' })`);
  check(await js(`ide.api.invoke('trust:isTrusted', ${q(created)})`), 'a project made with New Project is trusted');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
imgServer.close();
t.finish();
