// New Project wizard (Pure Python with a fresh .venv and Git, Flask on a base interpreter without installing),
// the error for an existing folder, and Get from VCS from a local repository. Runs offline.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const where = mkdtempSync(path.join(tmpdir(), 'pyide-newproj-'));
const q = JSON.stringify;

// A local "remote" for Get from VCS.
const origin = path.join(where, 'origin');
mkdirSync(origin);
writeFileSync(path.join(origin, 'tool.py'), 'print("cloned")\n');
const git = (...args) => execFileSync('git', args, { cwd: origin, stdio: 'ignore' });
git('init', '-q');
git('add', '.');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

async function openWizard(t) {
  await t.js(`ide.runAction('NewProject')`);
  await t.until(`!!document.querySelector('.np-dialog #npName')`, 'wizard');
}
const setValue = (t, sel, value) => t.js(`(() => { const i = document.querySelector(${q(sel)}); i.value = ${q(value)}; i.dispatchEvent(new Event('input')); return true; })()`);

let a;
try {
  a = await launch({ fixture: 'core', port: 9545, name: 'new-project' });
  await a.js(`ide.settings.set('newProject.location', ${q(where)})`);

  // ---------- Pure Python + venv + git, from the welcome screen ----------
  await a.js(`ide.closeProject()`);
  await a.until(`!document.querySelector('#welcome').classList.contains('hidden')`, 'welcome');
  await a.click('#welcomeNew');
  await a.until(`!!document.querySelector('.np-dialog #npName')`, 'wizard from welcome');
  const types = await a.js(`[...document.querySelectorAll('.np-type')].map(n => n.lastChild.textContent).join('|')`);
  check(types === 'Pure Python|Flask|FastAPI|Django', `project types: Pure Python, Flask, FastAPI, Django (${types})`);
  check(await a.js(`document.querySelector('#npName').value.startsWith('pythonProject') && document.querySelector('#npLocation').value === ${q(where)}`), 'defaults: pythonProject in the last location');
  await setValue(a, '#npName', 'demo');
  check(await a.js(`document.querySelector('#npPreview').textContent.endsWith(${q(path.join(where, 'demo'))})`), 'path preview follows the name');
  await a.shot('wizard.png');
  await a.click('#npCreate');
  await a.until(`ide.root && ide.root.toLowerCase() === ${q(path.join(where, 'demo').toLowerCase())}`, 'project opened', 120000);
  const demo = path.join(where, 'demo');
  check(await a.js(`!document.querySelector('.np-dialog')`), 'the wizard closes once the project is created');
  check(existsSync(path.join(demo, '.venv', 'Scripts', 'python.exe')), 'a .venv was created with the base interpreter');
  check(existsSync(path.join(demo, '.git')) && readFileSync(path.join(demo, '.gitignore'), 'utf8').includes('.venv/'), 'Git repository and .gitignore created');
  await a.until(`ide.activeTab()?.title === 'main.py'`, 'main.py opened');
  check(await a.js(`ide.editor.getModel().getValue().includes("print_hi('PyCharm')")`), 'welcome script main.py is opened');
  check(await a.js(`ide.currentInterp()?.executable.toLowerCase() === ${q(path.join(demo, '.venv', 'Scripts', 'python.exe').toLowerCase())}`), 'the new .venv is the project interpreter');
  await a.press('Shift+F10');
  await a.until(`document.querySelector('#runOut')?.textContent.includes('Hi, PyCharm')`, 'ran', 30000);
  check(true, 'Shift+F10 runs the new project with its venv');

  // ---------- Flask on the base interpreter, packages not installed ----------
  await openWizard(a);
  await a.js(`document.querySelector('.np-type[data-type="flask"]').click()`);
  await setValue(a, '#npName', 'web');
  await a.js(`document.querySelector('input[name="npMode"][value="base"]').click()`);
  check(await a.js(`document.querySelector('#npInstall').disabled && document.querySelector('#npWelcome').closest('.np-check').classList.contains('hidden')`), 'Flask on a base interpreter does not offer to pip install into it');
  await a.js(`document.querySelector('#npGit').checked = false`);
  await a.click('#npCreate');
  await a.until(`ide.root && ide.root.toLowerCase().endsWith('\\\\web')`, 'flask project', 60000);
  const web = path.join(where, 'web');
  check(readFileSync(path.join(web, 'app.py'), 'utf8').includes('Flask(__name__)') && existsSync(path.join(web, 'templates')) && existsSync(path.join(web, 'static')), 'Flask template: app.py, templates/, static/');
  check(!existsSync(path.join(web, '.git')) && !existsSync(path.join(web, '.venv')), 'no Git and no venv when not asked for');
  await a.until(`ide.activeTab()?.title === 'app.py'`, 'app.py opened');
  check(true, 'app.py is opened');

  // ---------- a failing setup step ----------
  await openWizard(a);
  await a.js(`document.querySelector('.np-type[data-type="django"]').click()`);
  await setValue(a, '#npName', 'broken');
  await a.js(`(() => { document.querySelector('input[name="npMode"][value="custom"]').click(); const s = document.querySelector('#npCustom'); s.add(new Option('missing', 'C:\\\\nope\\\\python.exe'), 0); s.value = 'C:\\\\nope\\\\python.exe'; document.querySelector('#npGit').checked = true; return true; })()`);
  await a.click('#npCreate');
  await a.until(`ide.root && ide.root.toLowerCase().endsWith('\\\\broken')`, 'project with a failed step opened', 60000);
  check(await a.js(`!document.querySelector('.np-dialog')`), 'a failed setup step still closes the wizard and opens the project');
  const failLog = await a.js(`document.querySelector('#npFailLog')?.textContent || ''`);
  check(/Installing packages/.test(failLog) && existsSync(path.join(where, 'broken', '.git')), `the failure is reported with the setup log, and later steps (git init) still run (${JSON.stringify(failLog.slice(-200))})`);
  await a.js(`([...document.querySelectorAll('.dialog-buttons .primary')].pop().click(), true)`);

  // ---------- Cancel stops a running step ----------
  await openWizard(a);
  await a.js(`document.querySelector('.np-type[data-type="python"]').click()`);
  await setValue(a, '#npName', 'stopped');
  await a.js(`(document.querySelector('input[name="npMode"][value="venv"]').click(), true)`);
  await a.click('#npCreate');
  await a.until(`/-m venv/.test(document.querySelector('#npLog').textContent)`, 'venv step running');
  await a.js(`(document.querySelector('.np-dialog .dialog-buttons .secondary').click(), true)`);
  await a.until(`!document.querySelector('.np-dialog') && ide.root && ide.root.toLowerCase().endsWith('\\\\stopped')`, 'cancelled', 30000);
  check(!(await a.js(`!!document.querySelector('#npFailLog')`)), 'Cancel during a setup step stops it, closes the wizard and opens the project without an error report');

  // Esc during a step cancels it the same way.
  await openWizard(a);
  await setValue(a, '#npName', 'escaped');
  await a.js(`(document.querySelector('input[name="npMode"][value="venv"]').click(), true)`);
  await a.click('#npCreate');
  await a.until(`/-m venv/.test(document.querySelector('#npLog').textContent)`, 'venv step running (Esc)');
  await a.press('Escape');
  await a.until(`ide.root && ide.root.toLowerCase().endsWith('\\\\escaped')`, 'escaped', 30000);
  // A stopped venv step leaves the project on the base interpreter (a finished one would select .venv).
  const escInterp = await a.js(`ide.settings.get('interpreter.' + ide.root) || ''`);
  check(!/\.venv/i.test(escInterp) && !(await a.js(`!!document.querySelector('#npFailLog')`)), `Esc during a setup step stops it too, with no error report (${escInterp})`);

  // ---------- existing folder ----------
  await openWizard(a);
  await setValue(a, '#npName', 'web');
  await a.click('#npCreate');
  await a.until(`/already exists/.test(document.querySelector('.np-error').textContent)`, 'error');
  check(await a.js(`!!document.querySelector('.np-dialog')`), 'an existing non-empty folder is refused and the dialog stays open');
  await a.click('.np-dialog .dialog-buttons .secondary');

  // ---------- Get from VCS ----------
  await a.js(`ide.runAction('GetFromVcs')`);
  await a.until(`!!document.querySelector('#cloneUrl')`, 'clone dialog');
  await setValue(a, '#cloneUrl', origin);
  await setValue(a, '#cloneDir', path.join(where, 'cloned'));
  await a.js(`[...document.querySelectorAll('.dialog-buttons .primary')].pop().click()`);
  await a.until(`ide.root && ide.root.toLowerCase().endsWith('\\\\cloned')`, 'cloned project opened', 60000);
  check(existsSync(path.join(where, 'cloned', 'tool.py')), 'Get from VCS clones the repository and opens it');
  check((await a.js(`ide.settings.get('recentProjects').map(p => p.path.split('\\\\').pop())`)).slice(0, 4).join('|') === 'cloned|escaped|stopped|broken', 'recent projects keep the newest first');
  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? ` ${JSON.stringify(a.consoleErrors)}` : ''}`);
  a.close();

  // ---------- Korean ----------
  const k = await launch({ fixture: 'core', port: 9546, name: 'new-project-ko', lang: 'ko-KR' });
  await openWizard(k);
  await k.js(`document.querySelector('.np-type[data-type="fastapi"]').click()`);
  const leaks = await englishLeaks(k, '.np-dialog', ['Flask', 'FastAPI', 'Django', 'fastapi', 'uvicorn']);
  check(!leaks.length && (await k.js(`document.querySelector('.np-dialog .dialog-title').textContent`)) === '새 프로젝트', `wizard is Korean${leaks.length ? ` ${JSON.stringify(leaks.slice(0, 5))}` : ''}`);
  await k.shot('wizard-ko.png');
  k.close();
} catch (err) {
  check(false, err.message);
  a?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
