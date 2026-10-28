// Build Executable (exe-builder plugin): Run › Build Executable… on the open file asks for the name, one file or one
// folder, the console window and an icon; with PyInstaller missing from the project venv it offers to install it, then
// builds into dist and says where the program is. The choices stay in a saved PyInstaller configuration that does not
// take over the run widget; one folder, bundled data and a failed build. Offline: a stand-in PyInstaller wheel that
// writes the program file and logs its arguments, installed from a local folder with PIP_NO_INDEX. Port 9797.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-exe-builder-'));
const wheels = path.join(scratch, 'wheels');
const argsLog = path.join(scratch, 'pyinstaller-args.jsonl');
const WHEEL = `
import zipfile, hashlib, base64, sys, os
os.makedirs(sys.argv[1], exist_ok=True)
info = 'pyinstaller-6.99.0.dist-info'
main = '''import argparse, json, os, sys
p = argparse.ArgumentParser()
for flag in ('--noconfirm', '--clean', '--onefile', '--onedir', '--windowed'):
    p.add_argument(flag, action='store_true')
for opt in ('--name', '--distpath', '--workpath', '--specpath', '--icon'):
    p.add_argument(opt)
p.add_argument('--add-data', action='append', default=[])
p.add_argument('script')
a = p.parse_args()
with open(os.environ['PYIDE_FAKE_PYINSTALLER_LOG'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\\\n')
print('INFO: PyInstaller: 6.99.0 (stand-in)')
if a.name == 'Broken':
    print('ERROR: something went wrong', file=sys.stderr)
    sys.exit(1)
if a.name == 'Slow':
    import time
    time.sleep(60)
out = os.path.join(a.distpath, a.name) if a.onedir else a.distpath
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, a.name + '.exe'), 'wb') as f:
    f.write(b'MZ stand-in')
print('INFO: Build complete!')
'''
files = {'PyInstaller/__init__.py': '__version__ = "6.99.0"\\n', 'PyInstaller/__main__.py': main,
         f'{info}/METADATA': 'Metadata-Version: 2.1\\nName: pyinstaller\\nVersion: 6.99.0\\n',
         f'{info}/WHEEL': 'Wheel-Version: 1.0\\nGenerator: pyide-verify\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
record = []
with zipfile.ZipFile(os.path.join(sys.argv[1], 'pyinstaller-6.99.0-py3-none-any.whl'), 'w') as z:
    for p, c in files.items():
        b = c.encode()
        h = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()
        z.writestr(p, b)
        record.append(f'{p},sha256={h},{len(b)}')
    record.append(f'{info}/RECORD,,')
    z.writestr(f'{info}/RECORD', '\\n'.join(record) + '\\n')
`;
execFileSync('py', ['-3', '-I', '-c', WHEEL, wheels]);
const project = path.join(scratch, 'project');
mkdirSync(path.join(project, 'assets'), { recursive: true });
writeFileSync(path.join(project, 'main.py'), 'print("hello")\n');
writeFileSync(path.join(project, 'run.py'), 'print("the program the run widget runs")\n');
writeFileSync(path.join(project, 'assets', 'data.txt'), 'data\n');
writeFileSync(path.join(project, 'app.ico'), Buffer.from([0, 0, 1, 0]));
execFileSync('py', ['-3', '-m', 'venv', path.join(project, '.venv')]);
execFileSync('git', ['init', '-q', project]);
writeFileSync(path.join(project, '.gitignore'), '.venv/\n');

const t = await launch({ name: 'exe-builder', port: 9797, projectDir: project,
  env: { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels, PYIDE_FAKE_PYINSTALLER_LOG: argsLog } });
const { js, until, check, sleep, shot } = t;
const lastArgs = () => readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
const buttonIn = (dialog, label) => `[...document.querySelectorAll('.dialog')].find((d) => d.textContent.includes(${S(dialog)}))?.querySelectorAll('.dialog-buttons button')`
  + ` && [...[...document.querySelectorAll('.dialog')].find((d) => d.textContent.includes(${S(dialog)})).querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${S(label)})`;
try {
  await until(`ide.currentInterp()?.executable.toLowerCase().includes('.venv')`, 'project venv selected', 30000);
  check(await js(`ide.actions.some((a) => a.id === 'BuildExecutable' && a.title === 'Build Executable…')`), 'Build Executable… is an action (Run menu)');
  await openFile(t, 'run.py');
  await js(`ide.run.select(ide.run.addTemporary(ide.run.types.get('python').forFile(ide.activeTab().path)).id)`);
  const selectedBefore = await js(`ide.run.selected()?.id`);

  await openFile(t, 'main.py');
  await js(`(ide.runAction('BuildExecutable'), true)`);
  await until(`!!document.querySelector('#exeDlgName')`, 'dialog');
  check(await js(`document.querySelector('#exeDlgName').value`) === 'main' && await js(`document.querySelector('#exeDlgMode').value`) === 'onefile'
    && !(await js(`document.querySelector('#exeDlgWindowed').checked`)), 'the dialog starts from the script name, one file, with a console for a .py');
  await js(`(() => { document.querySelector('#exeDlgName').value = 'MyApp'; document.querySelector('#exeDlgWindowed').checked = true; document.querySelector('#exeDlgIcon').value = 'app.ico'; return true; })()`);
  await shot('dialog.png');
  await js(`(${buttonIn('Build Executable', 'Build')}).click()`);

  await until(`!!(${buttonIn('Install PyInstaller?', 'Install and Build')})`, 'install offer', 20000);
  check(true, 'with PyInstaller missing, the build offers to install it');
  await js(`(${buttonIn('Install PyInstaller?', 'Install and Build')}).click()`);
  const exe = path.join(project, 'dist', 'MyApp.exe');
  await until(`ide.api.exists(${S(exe)})`, 'MyApp.exe built', 120000);
  check(await js(`document.body.textContent.includes('Successfully installed pyinstaller')`), 'pip installed PyInstaller into the project venv');
  await until(`document.querySelector('.run-session:not(.hidden)')?.textContent.includes('Executable built: ' + ${S(exe)})`, 'built message', 20000);
  check(await js(`document.querySelector('.run-session:not(.hidden)').textContent.includes('Executable built: ' + ${S(exe)} + ' (0.0 MB)')`), 'the Run tab says where the program is and its size');
  check(await js(`!!document.querySelector('#bottomActions button[data-action="showExe"]')`), 'the Run tab has Show in Explorer');
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Executable built'))`, 'built balloon', 10000)
    .then(() => check(true, 'a notification says the executable was built'), () => check(false, 'a notification says the executable was built'));
  const ignoreButton = `[...document.querySelectorAll('.ide-balloon button, .ide-balloon a')].find((b) => b.textContent === 'Add build/, dist/ to .gitignore')`;
  check(await js(`!!(${ignoreButton})`), 'in a Git repository the notification offers to add build/ and dist/ to .gitignore');
  await js(`(${ignoreButton}).click()`);
  await until(`ide.api.read(ide.util.joinPath(ide.root, '.gitignore')).then((t) => t.includes('dist/'))`, '.gitignore written', 10000);
  check(readFileSync(path.join(project, '.gitignore'), 'utf8') === '.venv/\n# PyInstaller (Build Executable)\nbuild/\ndist/\n', 'the folders are added after what .gitignore had');
  const args = lastArgs();
  const after = (flag) => args[args.indexOf(flag) + 1];
  check(args.includes('--onefile') && args.includes('--windowed') && after('--name') === 'MyApp' && after('--distpath') === path.join(project, 'dist')
    && after('--workpath') === path.join(project, 'build', 'MyApp') && after('--icon') === path.join(project, 'app.ico') && args.at(-1) === path.join(project, 'main.py'),
  `PyInstaller gets the choices, dist for the program and build for its work files (${S(args)})`);
  check(!existsSync(path.join(project, 'requirements.txt')), 'PyInstaller is not added to the requirements');
  await shot('built.png');

  const cfg = await js(`ide.run.configs().find((c) => c.type === 'pyinstaller')`);
  check(cfg && !cfg.temporary && cfg.exeName === 'MyApp' && cfg.windowed === true && cfg.icon === 'app.ico', `the choices are kept in a saved PyInstaller configuration (${S(cfg)})`);
  check(await js(`ide.run.selected()?.id`) === selectedBefore, 'the run widget still runs the program, not the build');

  await js(`(ide.runAction('BuildExecutable'), true)`);
  await until(`!!document.querySelector('#exeDlgName')`, 'dialog again');
  check(await js(`document.querySelector('#exeDlgName').value === 'MyApp' && document.querySelector('#exeDlgWindowed').checked && document.querySelector('#exeDlgIcon').value === 'app.ico'`),
    'the dialog opens with the saved choices');
  await js(`(() => { document.querySelector('#exeDlgMode').value = 'onedir'; return true; })()`);
  await js(`(() => { const c = ide.run.configs().find((x) => x.type === 'pyinstaller'); c.data = 'assets'; return true; })()`);
  await js(`(${buttonIn('Build Executable', 'Build')}).click()`);
  const folderExe = path.join(project, 'dist', 'MyApp', 'MyApp.exe');
  await until(`ide.api.exists(${S(folderExe)})`, 'one-folder build', 60000);
  check(!(await js(`!!(${buttonIn('Install PyInstaller?', 'Install and Build')})`)), 'with PyInstaller installed it builds without asking');
  await until(`document.querySelector('.run-session:not(.hidden)')?.textContent.includes('Executable built: ' + ${S(folderExe)} + ' (folder 0.0 MB)')`, 'folder size', 20000)
    .then(() => check(true, 'a one-folder build gives the whole folder\'s size'), () => check(false, 'a one-folder build gives the whole folder\'s size'));
  const folderArgs = lastArgs();
  check(folderArgs.includes('--onedir') && folderArgs[folderArgs.indexOf('--add-data') + 1] === `${path.join(project, 'assets')};assets`,
    `one folder, with the assets folder bundled at the same place (${S(folderArgs)})`);

  await js(`(ide.exeBuilder.build(ide.util.joinPath(ide.root, 'main.py'), { exeName: 'Broken', mode: 'onefile', windowed: false, icon: '' }), true)`);
  await until(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Building Broken.exe failed'))`, 'failure balloon', 60000)
    .then(() => check(true, 'a failed build is reported with Show Output'), () => check(false, 'a failed build is reported'));
  check(!existsSync(path.join(project, 'dist', 'Broken.exe')), 'no program is left for a failed build');

  await js(`(ide.exeBuilder.build(ide.util.joinPath(ide.root, 'main.py'), { exeName: 'tool.exe', mode: 'onefile', windowed: false, icon: '' }), true)`);
  await until(`ide.api.exists(${S(path.join(project, 'dist', 'tool.exe'))})`, 'tool.exe', 60000);
  check(lastArgs()[lastArgs().indexOf('--name') + 1] === 'tool' && !existsSync(path.join(project, 'dist', 'tool.exe.exe')), 'a name typed with .exe is built as that name, not .exe.exe');

  await js(`(ide.exeBuilder.build(ide.util.joinPath(ide.root, 'main.py'), { exeName: 'Slow', mode: 'onefile', windowed: false, icon: '' }), true)`);
  await until(`ide.run.activeSession()?.cfg.type === 'pyinstaller' && ide.run.activeSession().running`, 'slow build running', 60000);
  await js(`(ide.run.activeSession().stop(), true)`);
  await until(`!ide.run.activeSession().running`, 'build stopped', 20000);
  await sleep(2000);
  check(!(await js(`[...document.querySelectorAll('.ide-balloon')].some((n) => n.textContent.includes('Building Slow.exe failed'))`)), 'a build the user stops is not reported as failed');

  await js(`(ide.run.select(null), true)`);
  await openFile(t, 'assets/data.txt');
  check(await js(`ide.run.selectedTarget()?.type ?? null`) !== 'pyinstaller', 'with nothing selected, Run does not repeat a build');
  check(await js(`!!ide.editor && ide.editors().some((ed) => ed.getAction('exeBuilder.build'))`), 'Build Executable… is in the editor context menu');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
await sleep(200);
t.finish();
