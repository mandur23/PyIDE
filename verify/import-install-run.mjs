// Installing a missing package from where the error shows, not only from Alt+Enter: a run that fails with
// "ModuleNotFoundError: No module named 'yaml'" gets an "Install package 'PyYAML'" button after the message that
// installs it, a module of the project run from the wrong folder gets none, and the hover on an unresolved import links
// straight to the installs. Offline: tiny local wheels and PIP_NO_INDEX, so nothing reaches PyPI. Port 9302.
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-import-install-run-'));
const wheels = path.join(scratch, 'wheels');
// pyide-imp-demo (module pyide_imp_demo) and a stand-in PyYAML 6.0.99 (module yaml).
const WHEELS = `
import zipfile, hashlib, base64, sys, os
os.makedirs(sys.argv[1], exist_ok=True)
for dist, module, ver in (('pyide_imp_demo', 'pyide_imp_demo', '1.0'), ('PyYAML', 'yaml', '6.0.99')):
    info = f'{dist}-{ver}.dist-info'
    files = {f'{module}/__init__.py': f'__version__ = "{ver}"\\n',
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
cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'import-install'), project, { recursive: true });
writeFileSync(path.join(project, 'run_me.py'), 'import yaml\nimport pyide_imp_demo\n\nprint("yaml", yaml.__version__)\n');
// tools/helpers.py is a module of the project; run from the project folder, Python does not find it.
writeFileSync(path.join(project, 'run_local.py'), 'import helpers\n');
execFileSync('py', ['-3', '-m', 'venv', path.join(project, '.venv')]);

const t = await launch({ name: 'import-install-run', port: 9302, projectDir: project, env: { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels } });
const { js, until, check, press, sleep, shot, cdp } = t;
const missingAt = (line) => `ide.lsp.diagnostics(ide.tabs.find(x => x.model === ide.editor.getModel()).path).some(d => d.range.start.line === ${line - 1} && d.code === 'reportMissingImports')`;
try {
  await until(`ide.currentInterp()?.executable.toLowerCase().includes('.venv')`, 'project venv selected', 30000);

  await openFile(t, 'run_local.py');
  await press('Shift+F10');
  await until(`document.body.innerText.includes("No module named 'helpers'")`, 'run_local fails', 60000);
  await sleep(1500);
  check(!(await js(`[...document.querySelectorAll('.console a.console-install')].some(a => a.textContent.includes('helpers'))`)), 'a module of the project gets no install button');

  await openFile(t, 'run_me.py');
  await press('Shift+F10');
  await until(`[...document.querySelectorAll('.console a.console-install')].some(a => a.textContent === "No module named 'yaml'")`, 'install button in the Run console', 60000);
  const button = `[...document.querySelectorAll('.console a.console-install')].find(a => a.textContent === "No module named 'yaml'")`;
  check(await js(`${button}.dataset.install`) === "Install package 'PyYAML'", "the button after \"No module named 'yaml'\" says Install package 'PyYAML'");
  check(await js(`!${button}.closest('.console').textContent.includes('Install package')`), 'the console text keeps only what the program printed');
  await shot('run-button.png');
  await js(`${button}.click()`);
  await until(`${button}?.dataset.state === 'done'`, 'installed from the console', 60000);
  check(await js(`${button}.dataset.install`) === "'PyYAML' installed. Run again.", 'the button says the package is installed');
  check(await js(`document.body.innerText.includes('Successfully installed PyYAML')`), 'pip installed PyYAML in the Packages console');

  await until(`ide.lsp.status() === 'ready' && ${missingAt(2)}`, 'Pyright reports pyide_imp_demo', 60000);
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 10 }), ide.editor.trigger('verify', 'editor.action.showHover', {}), true)`);
  await until(`[...document.querySelectorAll('.monaco-hover a')].some(a => a.textContent.includes("Install package 'pyide-imp-demo'"))`, 'hover install link', 15000);
  const links = await js(`[...document.querySelectorAll('.monaco-hover a')].map(a => a.textContent.trim()).filter(s => s.startsWith('Install'))`);
  check(links.length === 2 && links[1] === "Install package 'pyide-imp-demo' and add to requirements.txt", `the hover links to both installs: ${JSON.stringify(links)}`);
  await shot('hover-link.png');
  const box = await js(`(() => { const r = [...document.querySelectorAll('.monaco-hover a')].find(a => a.textContent.trim() === "Install package 'pyide-imp-demo'").getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await until(`!(${missingAt(2)})`, 'the squiggle goes after the install from the hover', 90000);
  check(true, 'a click on the hover link installs the package and the squiggle goes');

  await press('Shift+F10');
  await until(`document.body.innerText.includes('yaml 6.0.99')`, 'the program runs after both installs', 60000);
  check(true, 'the program runs after both installs');
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
t.finish();
