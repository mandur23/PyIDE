// Sync Python Requirements (requirements-sync plugin): the project's imports against requirements.txt. Packages the
// code imports that the file lacks are listed checked with their installed version (the distribution comes from the
// installed metadata: bs4 -> beautifulsoup4, else the usual name: yaml -> PyYAML); the standard library and the
// project's own modules are not; a declared package nothing imports is listed unchecked. Apply writes the chosen
// version form into the open, unsaved editor of the file, and a second sync finds nothing to do. Offline: tiny local
// wheels and PIP_NO_INDEX. Port 9798.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-requirements-sync-'));
const wheels = path.join(scratch, 'wheels');
const WHEELS = `
import zipfile, hashlib, base64, sys, os
os.makedirs(sys.argv[1], exist_ok=True)
for dist, module, ver in (('beautifulsoup4', 'bs4', '4.99.0'), ('pyide_rs_demo', 'rsdemo', '1.2.3'), ('pyide_rs_local', 'rslocal', '2.0+cpu'), ('pyide_rs_one', 'rsone', '5')):
    info = f'{dist}-{ver}.dist-info'
    files = {f'{module}/__init__.py': '', f'{info}/top_level.txt': module + '\\n',
             f'{info}/METADATA': f'Metadata-Version: 2.1\\nName: {dist.replace("_", "-")}\\nVersion: {ver}\\n',
             f'{info}/WHEEL': 'Wheel-Version: 1.0\\nGenerator: pyide-verify\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
    record = []
    with zipfile.ZipFile(os.path.join(sys.argv[1], f'{dist}-{ver}-py3-none-any.whl'), 'w') as z:
        for p, c in files.items():
            b = c.encode()
            h = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()
            z.writestr(p, b)
            record.append(f'{p},sha256={h},{len(b)}')
        record.append(f'{info}/RECORD,,')
        z.writestr(f'{info}/RECORD', '\\n'.join(record) + '\\n')
`;
execFileSync('py', ['-3', '-I', '-c', WHEELS, wheels]);
const project = path.join(scratch, 'project');
mkdirSync(path.join(project, 'tools'), { recursive: true });
writeFileSync(path.join(project, 'main.py'), 'import os, json\nimport requests\nfrom bs4 import BeautifulSoup\nimport rsdemo.sub\nimport helpers\nimport yaml\nfrom . import nothing\n');
writeFileSync(path.join(project, 'tools', 'helpers.py'), 'X = 1\n');
const reqFile = path.join(project, 'requirements.txt');
writeFileSync(reqFile, 'requests>=2\nunusedpkg==1.0\n');
const venv = path.join(project, '.venv');
execFileSync('py', ['-3', '-m', 'venv', venv]);
execFileSync(path.join(venv, 'Scripts', 'python.exe'), ['-m', 'pip', 'install', '-q', '--no-index', '--find-links', wheels, 'beautifulsoup4', 'pyide-rs-demo', 'pyide-rs-local', 'pyide-rs-one']);

const t = await launch({ name: 'requirements-sync', port: 9798, projectDir: project, env: { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels } });
const { js, until, check, shot } = t;
const items = () => js(`[...document.querySelectorAll('#reqSync .reqsync-item')].map((r) => ({ id: r.querySelector('input').dataset.id, checked: r.querySelector('input').checked, detail: r.querySelector('.reqsync-detail').textContent }))`);
const apply = `[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('#reqSync')).querySelector('.dialog-buttons button').click()`;
try {
  await until(`ide.currentInterp()?.executable.toLowerCase().includes('.venv')`, 'project venv selected', 30000);
  check(await js(`ide.actions.some((a) => a.id === 'SyncPythonRequirements' && a.title === 'Sync Python Requirements…')`), 'Sync Python Requirements… is an action (Tools menu)');
  await openFile(t, 'requirements.txt');
  await js(`(ide.editor.getModel().setValue('# kept unsaved\\n' + ide.editor.getModel().getValue()), true)`);

  await js(`(ide.runAction('SyncPythonRequirements'), true)`);
  await until(`!!document.querySelector('#reqSync')`, 'sync dialog', 60000);
  const list = await items();
  const by = Object.fromEntries(list.map((i) => [i.id, i]));
  check(by['add:beautifulsoup4']?.checked && by['add:beautifulsoup4'].detail === 'installed 4.99.0', `bs4 is found as beautifulsoup4 from the installed metadata (${S(by['add:beautifulsoup4'])})`);
  check(by['add:pyide-rs-demo']?.checked && by['add:pyide-rs-demo'].detail === 'installed 1.2.3', 'a submodule import counts for its package');
  check(by['add:PyYAML']?.checked && by['add:PyYAML'].detail === 'not installed', 'an import that is not installed gets its usual distribution name (yaml -> PyYAML)');
  check(!list.some((i) => /add:(os|json|helpers|requests|nothing)$/.test(i.id)), `the standard library, the project's modules and declared packages are left out (${S(list.map((i) => i.id))})`);
  check(by['remove:unusedpkg'] && !by['remove:unusedpkg'].checked, 'a declared package nothing imports is offered for removal, unchecked');
  check(list.length === 4, `four entries in all (${list.length})`);
  check(await js(`document.querySelector('#reqSyncForm').value`) === '~=', 'the version form defaults to compatible (~=)');
  await shot('sync-dialog.png');

  await js(`(document.querySelector('[data-id="remove:unusedpkg"]').click(), document.querySelector('[data-id="add:PyYAML"]').click(), true)`);
  await js(`(document.querySelector('#reqSyncForm').value = '==', true)`);
  await js(apply);
  await until(`ide.editor.getModel().getValue().includes('beautifulsoup4==4.99.0')`, 'written to the editor', 20000);
  const text = await js(`ide.editor.getModel().getValue()`);
  check(text.startsWith('# kept unsaved\n') && /^requests>=2$/m.test(text) && /^pyide-rs-demo==1\.2\.3$/m.test(text) && !text.includes('unusedpkg') && !text.includes('PyYAML'),
    `the chosen packages are added with ==, the unused one removed, the unchecked one left out, the unsaved edit kept (${S(text)})`);
  check(readFileSync(reqFile, 'utf8') === 'requests>=2\nunusedpkg==1.0\n', 'the file on disk waits for the save, as the editor has unsaved edits');
  check(await js(`ide.settings.get('requirementsSync.version')`) === '==', 'the version form is remembered');

  await js(`ide.saveTab(ide.activeTab()).then(() => true)`);
  await js(`(ide.runAction('SyncPythonRequirements'), true)`);
  await until(`!!document.querySelector('#reqSync')`, 'second sync', 60000);
  check(S((await items()).map((i) => i.id)) === S(['add:PyYAML']), 'a second sync lists only what was left unchecked');
  await js(`[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('#reqSync')).querySelectorAll('.dialog-buttons button')[1].click()`);

  // ~= takes no local label and needs two release parts: pip would reject ~=2.0+cpu and ~=5.
  writeFileSync(path.join(project, 'extra.py'), 'import rslocal\nimport rsone\n');
  await js(`(ide.runAction('SyncPythonRequirements'), true)`);
  await until(`!!document.querySelector('[data-id="add:pyide-rs-one"]')`, 'third sync', 60000);
  await js(`(document.querySelector('#reqSyncForm').value = '~=', true)`);
  await js(apply);
  await until(`ide.editor.getModel().getValue().includes('pyide-rs-one')`, 'versions written', 20000);
  const versions = await js(`ide.editor.getModel().getValue()`);
  check(/^pyide-rs-local~=2\.0$/m.test(versions) && /^pyide-rs-one>=5$/m.test(versions), `a local version label is dropped and a one-part version gets >= (${S(versions)})`);
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Not installed in the project interpreter: PyYAML')
    && [...n.querySelectorAll('button, a')].some((b) => b.textContent === "Install 'PyYAML'"))`, 'install offer', 10000)
    .then(() => check(true, 'a package added that is not installed is offered for install'), () => check(false, 'a package added that is not installed is offered for install'));
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
t.finish();
