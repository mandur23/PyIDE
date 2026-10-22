// "Create a virtual environment?" for a project with requirements.txt and no interpreter: the bar appears when the
// configured interpreter is missing, Create .venv makes the venv, selects it and installs the requirements (offline
// wheels, PIP_NO_INDEX); Don't Ask Again persists across a restart; Choose Interpreter… and the close button;
// Tools › Create Virtual Environment…; another project opened during creation (the venv stays, nothing is set up in
// the project now open); Korean; Safe Mode shows nothing (no bar, no install quick fix). Ports 9305-9309.
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-venv-prompt-'));
const wheels = path.join(scratch, 'wheels');
const WHEELS = `
import zipfile, hashlib, base64, sys, os
os.makedirs(sys.argv[1], exist_ok=True)
for name, ver in (('pyide_venv_demo', '1.0'),):
    info = f'{name}-{ver}.dist-info'
    files = {f'{name}/__init__.py': f'__version__ = "{ver}"\\n',
             f'{info}/METADATA': f'Metadata-Version: 2.1\\nName: {name.replace("_", "-")}\\nVersion: {ver}\\n',
             f'{info}/WHEEL': 'Wheel-Version: 1.0\\nGenerator: pyide-verify\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
    record = []
    with zipfile.ZipFile(os.path.join(sys.argv[1], f'{name}-{ver}-py3-none-any.whl'), 'w') as z:
        for p, c in files.items():
            b = c.encode()
            h = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()
            z.writestr(p, b)
            record.append(f'{p},sha256={h},{len(b)}')
        record.append(f'{info}/RECORD,,')
        z.writestr(f'{info}/RECORD', '\\n'.join(record) + '\\n')
`;
execFileSync('py', ['-3', '-I', '-c', WHEELS, wheels]);
const env = { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels };
const copy = (name) => {
  const dir = path.join(scratch, name);
  cpSync(path.join(HERE, 'fixtures', 'venv-prompt'), dir, { recursive: true });
  return dir;
};
const userDataWith = (name, settings) => {
  const dir = path.join(scratch, name);
  mkdirSync(dir, { recursive: true });
  if (settings) writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
};

const results = [];
let t = null;
const start = async (opts) => {
  // Results of the earlier instances carry over, so finish() counts them all.
  if (t) { results.push(...t.results.splice(0)); t.close(); }
  t = await launch({ fixture: 'venv-prompt', env, ...opts, env: { ...env, ...(opts.env || {}) } });
  t.results.push(...results.splice(0));
  return t;
};
const visible = `!document.querySelector('#venvBar').classList.contains('hidden')`;
const barText = () => t.js(`document.querySelector('#venvBar').textContent`);
const clickAction = (action) => t.click(`#venvBar [data-action="${action}"]`);
// Runs the check the bar makes and returns what it shows: 'prompt', 'working', 'done', 'error' or null.
const settle = () => t.js(`ide.venvSetup.evaluate().then(() => ide.venvSetup.state())`);

try {
  // ---------- the configured interpreter is gone: prompt, Create .venv ----------
  const projA = copy('a');
  const gone = path.join(scratch, 'gone', 'Scripts', 'python.exe');
  await start({ name: 'venv-prompt', port: 9305, projectDir: projA, userData: userDataWith('ud-a', { [`interpreter.${projA}`]: gone }) });
  const { js, until, check, shot } = t;
  await until(visible, 'the venv bar appears', 30000);
  const text = await barText();
  check(text.includes('Create a virtual environment?') && text.includes(`The project interpreter ${gone} was not found`) && text.includes('requirements.txt'),
    `the bar says the configured interpreter is missing and names requirements.txt (${S(text)})`);
  check(await js(`['create', 'choose', 'ignore', 'close'].every(a => !!document.querySelector('#venvBar [data-action="' + a + '"]'))`), 'Create .venv, Choose Interpreter…, Don\'t Ask Again and close');
  check(await js(`document.querySelector('#venvBar [data-action="create"]').textContent === 'Create .venv'`), 'the action reads "Create .venv"');
  await shot('venv-prompt.png');
  await clickAction('create');
  await until(`ide.venvSetup.state() === 'working'`, 'creating');
  await until(`document.querySelector('#pkgOut')?.textContent.includes('-m venv')`, 'venv command in the Packages console', 30000);
  check(await js(`ide.toolWindows.get('PythonPackages').isVisible()`), 'progress shows in the Python Packages window');
  await until(`['done', 'error'].includes(ide.venvSetup.state())`, 'venv created and requirements installed', 240000);
  check(await js(`ide.venvSetup.state()`) === 'done', `the bar reports success (${S(await barText())})`);
  const venvPy = path.join(projA, '.venv', 'Scripts', 'python.exe');
  check(existsSync(venvPy) && existsSync(path.join(projA, '.venv', 'pyvenv.cfg')), '.venv was created in the project');
  check(await js(`ide.currentInterp()?.executable.toLowerCase() === ${S(venvPy.toLowerCase())}`), 'the new .venv is the project interpreter');
  check(await js(`ide.settings.get(${S(`interpreter.${projA}`)}, '').toLowerCase() === ${S(venvPy.toLowerCase())}`), 'and is saved as the project interpreter setting');
  const out = await js(`document.querySelector('#pkgOut').textContent`);
  check(/Successfully installed pyide[-_]venv[-_]demo-1\.0/i.test(out) && out.includes('install -r'), 'the requirements were installed with pip install -r requirements.txt');
  check(execFileSync(venvPy, ['-c', 'import pyide_venv_demo; print(pyide_venv_demo.__version__)'], { encoding: 'utf8' }).trim() === '1.0', 'the package is importable from the new .venv');
  await until(`ide.dependencies.state().files[0]?.reqs[0]?.status === 'ok'`, 'requirements satisfied', 30000);
  check(true, 'the dependency check reports requirements.txt as satisfied');
  await shot('venv-created.png');
  check(await settle() === 'done', 'with a project venv there is no prompt any more');

  // ---------- no interpreter configured: Choose Interpreter…, close, Don't Ask Again across a restart ----------
  const projB = copy('b');
  const udB = userDataWith('ud-b');
  await start({ name: 'venv-prompt-b', port: 9306, projectDir: projB, userData: udB });
  await t.until(visible, 'the venv bar appears for a project with no interpreter', 30000);
  t.check((await barText()).includes('No Python interpreter is configured for this project'), 'with no interpreter configured the bar says so');
  await clickAction('choose');
  await t.until(`document.querySelector('.settings-page')?.dataset.page === 'interpreter'`, 'Settings › Python Interpreter');
  t.check(true, 'Choose Interpreter… opens Settings › Python Interpreter');
  await t.press('Escape');
  await t.until(`!document.querySelector('.settings-page')`, 'settings closed');
  await clickAction('close');
  t.check(await t.js(`!(${visible})`) && await settle() === null, 'the close button hides the bar for this session');
  await t.js(`ide.openProject(${S(projB)})`);
  t.check(await settle() === null, 'reopening the project in the same session does not ask again');
  await start({ name: 'venv-prompt-b', port: 9306, projectDir: projB, userData: udB });
  await t.until(visible, 'the bar is back after a restart', 30000);
  await clickAction('ignore');
  t.check(await t.js(`!(${visible})`), "Don't Ask Again hides the bar");
  t.check(await t.js(`ide.settings.get(${S(`venvPrompt.ignore:${projB}`)}, false)`) === true, "Don't Ask Again is saved for this project");
  await t.js('ide.settings.flush()');
  await start({ name: 'venv-prompt-b', port: 9306, projectDir: projB, userData: udB });
  await t.until(`ide.root && ide.interps.length > 0`, 'project and interpreters loaded', 30000);
  t.check(await settle() === null && await t.js(`!(${visible})`), "after a restart the project is not asked about again");
  t.check(!existsSync(path.join(projB, '.venv')), 'nothing was created');

  // ---------- Tools › Create Virtual Environment… ----------
  t.check(await t.js(`ide.actions.some(a => a.id === 'CreateVirtualEnvironment' && a.title === 'Create Virtual Environment…')`), 'the Create Virtual Environment… action is registered');
  await t.js(`(ide.runAction('CreateVirtualEnvironment'), true)`);
  await t.until(`!!document.querySelector('#venvDlgLocation')`, 'Create Virtual Environment dialog');
  t.check(await t.js(`document.querySelector('#venvDlgLocation').value.toLowerCase() === ${S(path.join(projB, '.venv').toLowerCase())}`), 'the dialog proposes <project>\\.venv');
  t.check(await t.js(`document.querySelector('#venvDlgBase').options.length > 0 && !!document.querySelector('#venvDlgInstall')?.checked`), 'it lists base interpreters and offers to install from requirements.txt');
  t.check(await t.js(`[...document.querySelector('#venvDlgBase').options].every(o => !o.value.toLowerCase().includes('\\\\.venv\\\\'))`), 'only base interpreters, no virtual environments');
  await t.js(`(document.querySelector('#venvDlgInstall').checked = false, document.querySelector('#venvDlgLocation').value = ${S(path.join(projB, 'env2'))}, true)`);
  await t.js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Create').click(), true)`);
  await t.until(`['done', 'error'].includes(ide.venvSetup.state())`, 'env2 created', 180000);
  const env2 = path.join(projB, 'env2', 'Scripts', 'python.exe');
  t.check(existsSync(env2) && await t.js(`ide.currentInterp()?.executable.toLowerCase() === ${S(env2.toLowerCase())}`), 'the dialog creates env2 and selects it');
  t.check((await barText()).includes('set it as the project interpreter') && !(await t.js(`document.querySelector('#pkgOut').textContent.includes('install -r')`)),
    'without the install box nothing is installed');

  // ---------- another project opened while the venv is being created ----------
  // The environment stays where it was made, but it is not selected for, nor are dependencies installed into, the
  // project that is open when creation ends; a notification says so, and the new project gets its own check.
  const projD = copy('d');
  const env3Dir = path.join(projB, 'env3');
  const env3 = path.join(env3Dir, 'Scripts', 'python.exe');
  await t.js(`(ide.runAction('CreateVirtualEnvironment'), true)`);
  await t.until(`!!document.querySelector('#venvDlgLocation')`, 'Create Virtual Environment dialog');
  await t.js(`(document.querySelector('#venvDlgInstall').checked = true, document.querySelector('#venvDlgLocation').value = ${S(env3Dir)}, true)`);
  await t.js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Create').click(), true)`);
  await t.until(`ide.venvSetup.state() === 'working' && ide.packages.busy() && document.querySelector('#pkgOut')?.textContent.includes('env3')`, 'creating env3', 30000);
  await t.js(`ide.openProject(${S(projD)})`);
  const switchedWhileBusy = await t.js(`ide.util.samePath(ide.root, ${S(projD)}) && ide.packages.busy()`);
  t.check(switchedWhileBusy, 'another project was opened while the venv was still being created');
  await t.until(`ide.notifications.list().some(e => e.text.includes('was closed before the environment was set up'))`, 'left-behind notification', 180000);
  const leftNote = await t.js(`ide.notifications.list().find(e => e.text.includes('was closed before the environment was set up')).text`);
  t.check(leftNote.includes(env3Dir) && leftNote.includes(path.basename(projB)), `a notification names the environment and its project (${S(leftNote)})`);
  t.check(existsSync(env3) && existsSync(path.join(env3Dir, 'pyvenv.cfg')), 'the environment is kept');
  t.check(await t.js(`ide.util.samePath(ide.root, ${S(projD)}) && !ide.util.samePath(ide.currentInterp()?.executable || '', ${S(env3)})`),
    'it is not the interpreter of the project that is open now');
  t.check(await t.js(`!ide.util.samePath(ide.settings.get(${S(`interpreter.${projD}`)}, '') || '-', ${S(env3)}) && !ide.util.samePath(ide.settings.get(${S(`interpreter.${projB}`)}, '') || '-', ${S(env3)})`),
    'no project interpreter setting was changed to it');
  await t.until(`!ide.packages.busy()`, 'packages idle', 60000);
  t.check(!(await t.js(`document.querySelector('#pkgOut').textContent.includes('install -r')`)) && !existsSync(path.join(env3Dir, 'Lib', 'site-packages', 'pyide_venv_demo')),
    'no dependencies were installed');
  await t.until(`ide.venvSetup.state() === 'prompt'`, 'the new project is checked once creation has ended', 30000);
  t.check(true, 'the project opened meanwhile gets its own "Create a virtual environment?" bar');

  // ---------- Korean ----------
  const projC = copy('c');
  await start({ name: 'venv-prompt-ko', port: 9307, projectDir: projC, userData: userDataWith('ud-c'), lang: 'ko-KR' });
  const { englishLeaks, missingTranslations } = await import('./i18n-lib.mjs');
  await t.until(visible, 'Korean venv bar', 30000);
  const ko = await barText();
  t.check(ko.includes('가상 환경을 생성하시겠습니까?') && ko.includes('.venv 생성') && ko.includes('인터프리터 선택…') && ko.includes('다시 묻지 않음'), `the bar is Korean (${S(ko)})`);
  const leaks = await englishLeaks(t, '#venvBar', ['requirements.txt', '.venv']);
  t.check(!leaks.length, `no English in the bar (${S(leaks)})`);
  await t.js(`(ide.runAction('CreateVirtualEnvironment'), true)`);
  await t.until(`!!document.querySelector('#venvDlgLocation')`, 'Korean dialog');
  t.check(await t.js(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === '가상 환경 생성')`), 'the dialog title is Korean');
  const dlgLeaks = await englishLeaks(t, '.dialog', ['requirements.txt']);
  t.check(!dlgLeaks.filter((s) => !/python|py launcher|\\|:/i.test(s)).length, `no English in the dialog except interpreter names and paths (${S(dlgLeaks)})`);
  await t.press('Escape');
  t.check(await t.js(`ide.actions.find(a => a.id === 'CreateVirtualEnvironment').title === '가상 환경 생성…'`), 'the action is Korean');
  const mine = new Set(Object.keys(JSON.parse(readFileSync(path.join(HERE, '..', 'renderer', 'features', 'venv-setup', 'locales', 'ko.json'), 'utf8'))));
  const missingKo = (await missingTranslations(t)).filter((s) => mine.has(s) || /virtual environment/i.test(s));
  t.check(!missingKo.length, `no missing Korean translations (${S(missingKo)})`);
  await t.shot('venv-prompt-ko.png');

  // ---------- Safe Mode: no prompt, no install quick fix ----------
  const home = copy('home');
  const untrusted = copy('untrusted');
  const udD = userDataWith('ud-d', { recentProjects: [{ path: home, opened: Date.now() }] });
  await start({ name: 'venv-prompt-safe', port: 9308, projectDir: home, userData: udD, env: { PYIDE_TRUST_ALL: '' } });
  t.check(await t.js('ide.trusted') === true, 'the home project (opened before) is trusted');
  t.js(`ide.openProject(${S(untrusted)})`).catch(() => {});
  await t.until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Trust and Open Project?')`, 'trust question');
  await t.js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Preview in Safe Mode').click(), true)`);
  await t.until(`ide.root && ide.util.samePath(ide.root, ${S(untrusted)}) && ide.trusted === false`, 'opened in Safe Mode');
  t.check(await settle() === null && await t.js(`!(${visible})`), 'Safe Mode shows no venv prompt');
  t.check((await t.js(`ide.api.invoke('venv-setup:create', ${S(untrusted)}, { dir: ${S(path.join(untrusted, '.venv'))}, base: { executable: 'py' } })`)).error === 'The project is not trusted.',
    'the main process refuses to create a venv in an untrusted project');
  // The Workspace home tab opens with the project and may take the focus from main.py: open it until it is active.
  await t.until(`ide.activeTab()?.path?.toLowerCase().endsWith('main.py') || (ide.openFile(ide.util.joinPath(ide.root, 'main.py')), false)`, 'main.py active');
  await t.until(`ide.lsp.status() === 'ready' && ide.lsp.diagnostics(ide.activeTab().path).some(d => d.code === 'reportMissingImports')`, 'Pyright flags the import in Safe Mode', 60000);
  await t.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 9 }), true)`);
  await t.sleep(400);
  await t.press('Alt+Enter');
  await t.until(`document.querySelectorAll('.action-widget .monaco-list-row.action').length > 0`, 'quick fix menu');
  const titles = await t.js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
  t.check(!titles.some((x) => x.includes('Install package')), `Safe Mode offers no install quick fix (${S(titles)})`);
  await t.press('Escape');
  await t.js(`(ide.runAction('CreateVirtualEnvironment'), true)`);
  await t.until(`[...document.querySelectorAll('.dialog-message')].some(n => n.textContent.includes('Safe Mode'))`, 'Safe Mode message');
  t.check(!existsSync(path.join(untrusted, '.venv')), 'Create Virtual Environment… explains Safe Mode and creates nothing');
} catch (err) {
  t.check(false, err.message);
  await t.shot('failure.png');
}
t.finish();
