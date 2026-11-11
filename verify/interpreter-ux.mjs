// Interpreters as a user picks and fixes them: every installed Python (what `py -0p` reports) is listed in the
// status-bar menu and in Settings › Python Interpreter; the menu's Add New Interpreter… opens the add step itself and
// it offers Create Virtual Environment…, as does the Workspace card of a project without one; the settings page links
// to the Python Packages window; an install that cannot reach the package index says so (in the window and in a
// balloon) instead of only pip's "No matching distribution found"; with no Python at all, Run and Debug offer what
// fixes it, as the startup notification does. Ports 9955-9956. The package index is a dead local address; nothing
// goes to the network.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeBalloonsOver, launch, openFile, tempDir } from './lib.mjs';

const S = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const real = (p) => { try { return realpathSync.native(p).toLowerCase(); } catch { return p.toLowerCase(); } };
const installed = execFileSync('py', ['-0p'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => /([A-Za-z]:\\.*\.exe)\s*$/i.exec(l)?.[1]).filter(Boolean);
const venv = path.join(HERE, 'out', 'interpreter-ux-venv');
const venvPy = path.join(venv, 'Scripts', 'python.exe');
if (!existsSync(venvPy)) execFileSync('py', ['-3', '-m', 'venv', venv]);

// A project with no virtual environment; pip's index is a local port nothing listens on.
const pipEnv = { PIP_INDEX_URL: 'http://127.0.0.1:9/simple', PIP_RETRIES: '2', PIP_TIMEOUT: '3', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1' };
const t = await launch({ fixture: 'core', port: 9955, name: 'interpreter-ux', env: pipEnv });
const { js, until, check, click, sleep } = t;
const menuLabels = () => js(`[...document.querySelectorAll('.context-menu .menu-label')].map((l) => l.textContent)`);

try {
  await until(`(ide.interps || []).length > 0`, 'interpreters listed', 30000);
  // ---------- every installed Python ----------
  const listed = (await js(`ide.interps.map((i) => i.executable)`)).map(real);
  const missing = installed.filter((p) => !listed.includes(real(p)));
  check(installed.length >= 1 && !missing.length, `every Python py -0p reports is listed (${installed.length} installed; missing ${S(missing)})`);
  await click('#statusInterp');
  await until(`!!document.querySelector('.context-menu')`, 'interpreter menu');
  const menu = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map((r) => r.querySelector('.menu-detail')?.textContent || r.textContent)`);
  const notInMenu = installed.filter((p) => !menu.some((m) => m.toLowerCase().includes(p.toLowerCase())) && !listed.includes(real(p)));
  const labels = await menuLabels();
  check(!notInMenu.length && labels.filter((l) => /\(Python \d/.test(l)).length >= installed.length, `the status-bar menu shows them (${S(labels)})`);
  check(labels.includes('Create Virtual Environment…'), `the status-bar menu offers Create Virtual Environment… (${S(labels)})`);

  // ---------- Add New Interpreter goes to the add step ----------
  await js(`([...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Add New Interpreter…').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
  await until(`!!document.querySelector('#addInterpMenu')`, 'add interpreter menu', 8000)
    .then(() => check(true, 'Add New Interpreter… opens Settings with the Add Interpreter choices open'), () => check(false, 'Add New Interpreter… opens Settings with the Add Interpreter choices open'));
  const addItems = await js(`[...document.querySelectorAll('#addInterpMenu .menu-item')].map((n) => n.textContent)`);
  check(addItems.includes('Add Local Interpreter…') && addItems.includes('Create Virtualenv Environment…'), `the add step lists its kinds (${S(addItems)})`);
  await js(`(document.querySelector('#addInterpMenu')?.remove(), true)`);
  const options = (await js(`[...document.querySelectorAll('#settingsInterp option')].map((o) => o.value)`)).map(real);
  check(installed.every((p) => options.includes(real(p))), `Settings › Python Interpreter lists them too (${options.length} options)`);

  // ---------- the settings page links to the Python Packages window ----------
  const linkText = await js(`document.getElementById('interpPackagesLink')?.textContent || ''`);
  check(/Python Packages/.test(linkText), `the interpreter page links to the Python Packages window (${S(linkText)})`);
  await click('#interpPackagesLink');
  await until(`!document.querySelector('.settings-dialog') && ide.toolWindows.get('PythonPackages').isVisible()`, 'packages window', 8000)
    .then(() => check(true, 'the link closes Settings and shows the Python Packages window'), () => check(false, 'the link closes Settings and shows the Python Packages window'));

  // ---------- Workspace card of a project without a venv ----------
  await js(`(ide.runAction('WorkspaceHome'), true)`);
  await until(`!!document.querySelector('.ws-card-venvs')`, 'workspace venv card', 15000);
  const card = await js(`({ text: document.querySelector('.ws-card-venvs').textContent, button: !!document.querySelector('.ws-card-venvs .ws-create-venv') })`);
  check(/No virtual environments found/.test(card.text) && card.button, `the Workspace card of a project without a venv offers Create Virtual Environment… (${S(card)})`);
  await js(`(ide.toolWindows.get('PythonPackages').hide(), document.querySelector('.ws-card-venvs .ws-create-venv').scrollIntoView({ block: 'center' }), true)`);
  await click('.ws-card-venvs .ws-create-venv');
  await until(`[...document.querySelectorAll('#dialogHost .dialog-title')].some((n) => n.textContent === 'Create Virtual Environment')`, 'venv dialog', 8000)
    .then(() => check(true, 'and it opens the Create Virtual Environment dialog'), async () => check(false, `and it opens the Create Virtual Environment dialog (${S(await t.js(`(() => { const n = document.querySelector('.ws-card-venvs .ws-create-venv'); if (!n) return "none"; const r = n.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { r: [r.x, r.y, r.width, r.height], at: e?.className || e?.tagName, up: e?.closest("[class]")?.className, text: e?.textContent?.slice(0, 60), titles: [...document.querySelectorAll(".dialog-title")].map((d) => d.textContent) }; })()`))})`));
  await t.press('Escape');

  // ---------- an install with the package index unreachable ----------
  await js(`(ide.settings.set('interpreters.extra', [${S(venvPy)}]), true)`);
  await js('ide.reloadInterpreters()');
  await js(`ide.setInterpreter(${S(venvPy)})`);
  await js(`(ide.toolWindows.get('PythonPackages').show(), true)`);
  await until(`!!document.getElementById('pkgSearch') && !ide.packages.busy()`, 'packages window ready', 30000);
  await click('#pkgSearch');
  await t.type('nanostudio-offline-check');
  await t.press('Enter');
  await until(`(document.getElementById('pkgOut')?.textContent || '').includes('could not be reached')`, 'install finished', 120000).catch(() => {});
  const pkgOut = await js(`document.getElementById('pkgOut').textContent`);
  check(/No matching distribution/.test(pkgOut) && /The package index http:\/\/127\.0\.0\.1:9\/simple could not be reached/.test(pkgOut),
    `the Python Packages output says the index could not be reached (${S(pkgOut.slice(-260))})`);
  const balloon = await js(`ide.notifications.list().filter((n) => n.title === 'Package index unreachable').map((n) => n.text)`);
  check(balloon.length === 1 && /could not be reached/.test(balloon[0]), `and so does a balloon (${S(balloon)})`);
  check(!existsSync(path.join(venv, 'Lib', 'site-packages', 'nanostudio_offline_check')), 'nothing was installed');
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
}
t.close();

// ---------- no Python at all ----------
const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const root = tempDir('interpreter-ux-root');
mkdirSync(root, { recursive: true });
const n = await launch({ fixture: 'core', port: 9956, name: 'interpreter-ux-none', env: { PATH: SYS, Path: SYS, PYIDE_PYTHON_ROOTS: ';', PYIDE_INSTALL_ROOT: root } });
try {
  await n.until(`[...document.querySelectorAll('.ide-balloon')].some((b) => /No Python interpreter found/.test(b.textContent))`, 'no-interpreter notification', 30000);
  const note = await n.js(`(() => { const b = [...document.querySelectorAll('.ide-balloon')].find((x) => /No Python interpreter found/.test(x.textContent)); return { text: b.textContent, actions: [...b.querySelectorAll('.ide-balloon-action')].map((a) => a.textContent) }; })()`);
  n.check(note.actions.some((a) => /^Install Nano Studio Python/.test(a)) && note.actions.includes('Add Local Interpreter…'),
    `the startup notification also offers to add a Python already on the computer (${S(note.actions)})`);
  writeFileSync(path.join(n.project, 'hello.py'), 'print("hi")\n');
  await openFile(n, 'hello.py');
  await n.js(`(ide.runAction('RunClass'), true)`);
  await n.until(`(ide.run.activeSession()?.con?.out?.textContent || '').includes('No Python interpreter found.')`, 'run refused', 15000);
  const runActions = await n.js(`[...ide.run.activeSession().con.out.querySelectorAll('.console-actions a')].map((a) => a.textContent)`);
  n.check(runActions.some((a) => /^Install Nano Studio Python/.test(a)) && runActions.includes('Add Local Interpreter…') && runActions.includes('Interpreter Settings…'),
    `Run says no interpreter was found and offers what fixes it (${S(runActions)})`);
  await n.js(`(ide.runAction('DebugCurrent') || ide.runAction('Debug'), true)`);
  await n.until(`(document.getElementById('dbgOut')?.textContent || '').includes('No Python interpreter found.')`, 'debug refused', 15000);
  const dbgActions = await n.js(`[...document.querySelectorAll('#dbgOut .console-actions a')].map((a) => a.textContent)`);
  n.check(S(dbgActions) === S(runActions), `so does Debug (${S(dbgActions)})`);
  const where = await n.js(`(() => { const n = document.querySelector('#dbgOut .console-actions a:last-child'); const r = n.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { r: [r.x, r.y, r.width, r.height], at: e?.className || e?.tagName, text: e?.textContent?.slice(0, 40) }; })()`);
  console.log('link', S(where));
  await closeBalloonsOver(n, "document.querySelector('#dbgOut .console-actions a:last-child')");
  await n.click('#dbgOut .console-actions a:last-child');
  await n.until(`document.querySelector('.settings-page')?.dataset.page === 'interpreter'`, 'interpreter settings', 8000)
    .then(() => n.check(true, 'Interpreter Settings… opens Settings › Python Interpreter'), async () => { n.check(false, `Interpreter Settings… opens Settings › Python Interpreter (${S(await n.js(`[...document.querySelectorAll('.settings-page, .dialog-title')].map((p) => p.dataset.page || p.textContent)`))})`); await n.shot('settings.png'); });
  n.check(n.consoleErrors.length === 0, 'no renderer exceptions (no Python)');
} catch (err) {
  n.check(false, err.message);
  await n.shot('failure.png').catch(() => {});
}
n.results.unshift(...t.results);
n.finish();
