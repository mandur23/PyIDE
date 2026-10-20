// Project dependency management: requirements.txt / pyproject.toml checked against a temp project venv, the editor
// banner, Install, the quick fix, "Add to requirements" and uv / Poetry detection. Offline: tiny local wheels and
// PIP_NO_INDEX, so nothing reaches PyPI. Ports 9920-9929.
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-deps-aux-'));
const wheels = path.join(scratch, 'wheels');
const WHEELS = `
import zipfile, hashlib, base64, sys, os
os.makedirs(sys.argv[1], exist_ok=True)
for name, ver in (('pyide_deps_tiny', '1.0'), ('pyide_deps_other', '1.0'), ('pyide_deps_other', '2.0')):
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

// The project: the fixture plus a .venv that has pyide-deps-other 1.0 (requirements.txt asks for >=2.0).
const project = path.join(scratch, 'project');
cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deps'), project, { recursive: true });
execFileSync('py', ['-3', '-m', 'venv', path.join(project, '.venv')]);
const venvPython = path.join(project, '.venv', 'Scripts', 'python.exe');
execFileSync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-index', '--find-links', wheels, 'pyide-deps-other==1.0'], { stdio: 'ignore' });

const t = await launch({ fixture: 'deps', port: 9920, projectDir: project, env: { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels } });
const { js, until, press, check, shot, click, sleep } = t;
const state = () => js('ide.dependencies.state()');
const fileState = async (name) => (await state()).files.find((f) => f.path.toLowerCase().endsWith(name));
const bannerVisible = `!!document.querySelector('#editor')?.parentElement.querySelector('.deps-banner:not(.hidden)')`;
const bannerText = () => js(`document.querySelector('#editor').parentElement.querySelector('.deps-banner')?.textContent || ''`);
const markers = () => js(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'dependencies' }).map(m => ({ line: m.startLineNumber, msg: m.message, sev: m.severity }))`);

async function quickFixTitles(line, column) {
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${column} }), true)`);
  await press('Alt+Enter');
  await until(`document.querySelectorAll('.action-widget .monaco-list-row.action').length > 0`, 'quick fix menu');
  return js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
}

try {
  // ---------- a UTF-16 requirements.txt (Windows PowerShell's `pip freeze >`) is read as pip reads it ----------
  const utf16 = mkdtempSync(path.join(scratch, 'utf16-'));
  writeFileSync(path.join(utf16, 'requirements.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('pyide-deps-tiny==1.0\r\n# 한글\r\n', 'utf16le')]));
  const depsLib = createRequire(import.meta.url)('../main/packages/deps.js');
  const utf16Reqs = depsLib.detect(utf16).files[0]?.reqs.map((r) => `${r.name}${r.spec}`);
  check(S(utf16Reqs) === S(['pyide-deps-tiny==1.0']), `a UTF-16 requirements.txt is parsed (${S(utf16Reqs)})`);

  // ---------- the project venv is the interpreter ----------
  const isVenv = `ide.currentInterp()?.executable.toLowerCase() === ${S(venvPython.toLowerCase())}`;
  try { await until(isVenv, 'project venv selected', 20000); } catch {
    await until(`ide.interps.some(i => i.executable.toLowerCase() === ${S(venvPython.toLowerCase())})`, 'venv listed', 20000);
    await js(`(ide.setInterpreter(${S(venvPython)}), true)`);
    await until(isVenv, 'venv selected');
  }
  check(true, 'the temp project venv is the project interpreter');

  // ---------- requirements.txt: missing and outdated ----------
  await until(`(ide.dependencies.state().files.find(f => f.kind === 'requirements')?.reqs.length || 0) === 2`, 'requirements checked', 60000);
  const req = await fileState('requirements.txt');
  const tiny = req.reqs.find((r) => r.name === 'pyide-deps-tiny');
  const other = req.reqs.find((r) => r.name === 'Pyide_Deps_Other');
  check((await state()).manager === 'pip', 'a project with only requirements.txt uses pip');
  check(tiny?.status === 'missing' && tiny.line === 2, 'a package that is not installed is flagged as missing');
  check(other?.status === 'outdated' && other.installed === '1.0' && other.spec === '>=2.0', 'an installed version that does not satisfy the specifier is flagged (Pyide_Deps_Other matches pyide-deps-other)');

  await openFile(t, 'requirements.txt');
  await until(bannerVisible, 'banner on requirements.txt');
  const text = await bannerText();
  check(text.includes('2 packages not installed / outdated') && text.includes('pyide-deps-tiny') && text.includes('Pyide_Deps_Other'), 'the editor banner shows "2 packages not installed / outdated" and their names');
  check(await js(`!!document.querySelector('#editor').parentElement.querySelector('.deps-banner [data-action="install"]')`), 'the banner has an Install button');
  check(await js(`parseInt(document.querySelector('#editor').style.top) > 0`), 'the banner pushes the editor down instead of covering it');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'dependencies' }).length === 2`, 'markers');
  const ms = await markers();
  check(ms.some((m) => m.line === 2 && m.msg === "Package 'pyide-deps-tiny' is not installed" && m.sev === 4), 'the missing package line has a warning squiggle');
  check(ms.some((m) => m.line === 3 && m.msg.includes("'Pyide_Deps_Other>=2.0' is not satisfied: 1.0 is installed")), 'the unsatisfied specifier line has a warning squiggle');

  // Packages tool window: summary row.
  await js(`(ide.toolWindows.get('PythonPackages').show(), true)`);
  await until(`!document.querySelector('#depsSummary').classList.contains('hidden')`, 'summary row');
  check(await js(`document.querySelector('#depsSummary').textContent.includes('2 packages not installed / outdated')`), 'the Packages window shows "2 packages not installed / outdated"');
  await shot('deps-banner.png');

  // ---------- quick fix: Install <pkg> ----------
  await js(`(ide.editor.focus(), true)`);
  const titles = await quickFixTitles(2, 3);
  check(titles.some((x) => x.includes('Install pyide-deps-tiny')), 'Alt+Enter on the missing line offers "Install pyide-deps-tiny"');
  for (let i = 0; i < 8 && !(await js(`!!document.querySelector('.action-widget .monaco-list-row.action.focused')?.textContent.includes('Install pyide-deps-tiny')`)); i++) await press('ArrowDown');
  await press('Enter');
  await until(`ide.dependencies.state().files.find(f => f.kind === 'requirements')?.reqs.find(r => r.name === 'pyide-deps-tiny')?.status === 'ok'`, 'quick fix installed tiny', 120000);
  check(await js(`document.querySelector('#pkgOut').textContent.includes('python -m pip install pyide-deps-tiny>=1.0')`), 'the quick fix runs pip install for that requirement in the Packages console');
  await until(`document.querySelector('#editor').parentElement.querySelector('.deps-banner')?.textContent.includes('1 package not installed / outdated')`, 'banner shows 1 left');
  check(true, 'after the quick fix the banner shows the 1 package left');

  // ---------- banner Install: pip install -r requirements.txt ----------
  await click('.deps-banner [data-action="install"]');
  await until(`document.querySelector('#pkgOut').textContent.includes('install -r')`, 'install started');
  check(await js(`document.querySelector('#pkgOut').textContent.includes('> python -m pip install -r ')`), 'Install runs "python -m pip install -r requirements.txt" in a visible console');
  await until(`!${bannerVisible}`, 'banner gone after install', 120000);
  const out = await js(`document.querySelector('#pkgOut').textContent`);
  check(/Successfully installed pyide[-_]deps[-_]other-2\.0/i.test(out), 'Install resolves the outdated requirement');
  if (!/Successfully installed/i.test(out)) console.log(out.slice(-1500));
  check((await markers()).length === 0, 'the squiggles are gone after Install');
  check(await js(`document.querySelector('#depsSummary').classList.contains('hidden')`), 'the Packages window summary is gone');
  check(await js(`parseInt(document.querySelector('#editor').style.top || '0') === 0`), 'the editor takes the full height again');

  // ---------- Add to requirements ----------
  await until(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pip')`, 'packages listed', 60000);
  await click('#pkgList .pkg-row[data-name="pip"]');
  await until(`!!document.querySelector('#pkgAddReq')`, 'Add to requirements button');
  check(!(await js(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-deps-tiny') && (document.querySelector('#pkgList .pkg-row[data-name="pyide-deps-tiny"]').click(), !!document.querySelector('#pkgAddReq'))`)),
    'a package that is already declared has no "Add to requirements"');
  await click('#pkgList .pkg-row[data-name="pip"]');
  await until(`!!document.querySelector('#pkgAddReq')`, 'Add to requirements button again');
  await click('#pkgAddReq');
  await until(`ide.editor.getModel().getValue().includes('pip~=')`, 'requirement added');
  const disk = readFileSync(path.join(project, 'requirements.txt'), 'utf8');
  check(/\npip~=\d+(\.\d+)+\n$/.test(disk), '"Add to requirements" appends pip~=<version> to requirements.txt');
  await until(`!document.querySelector('#pkgAddReq')`, 'button gone once declared');
  check(true, 'the button disappears once the package is declared');

  // ---------- pyproject.toml with uv.lock: uv project ----------
  writeFileSync(path.join(project, 'pyproject.toml'), [
    '[project]', 'name = "deps-fixture"', 'version = "0.1.0"', 'dependencies = [',
    '    "pyide-deps-tiny>=1.0",', '    "pyide-deps-missing",', '    "pyide-deps-skip; python_version < \'3\'",', ']', '',
  ].join('\n'));
  writeFileSync(path.join(project, 'uv.lock'), 'version = 1\n');
  await js('ide.dependencies.check()');
  const uvState = await state();
  const pyproject = uvState.files.find((f) => f.kind === 'pyproject');
  check(uvState.manager === 'uv' && uvState.tool?.name === 'uv', 'uv.lock makes it a uv project');
  check(pyproject && pyproject.reqs.find((r) => r.name === 'pyide-deps-missing')?.status === 'missing' && pyproject.reqs.find((r) => r.name === 'pyide-deps-tiny')?.status === 'ok',
    '[project].dependencies of pyproject.toml are detected and checked');
  check(pyproject && !pyproject.reqs.some((r) => r.name === 'pyide-deps-skip'), 'a requirement whose marker does not apply is not required');
  await openFile(t, 'pyproject.toml');
  await until(bannerVisible, 'banner on pyproject.toml');
  check((await bannerText()).includes('1 package not installed / outdated'), 'pyproject.toml gets the banner');
  const uvAction = uvState.tool?.path ? 'install' : 'install-tool';
  check(await js(`!!document.querySelector('#editor').parentElement.querySelector('.deps-banner [data-action="${uvAction}"]')`),
    uvState.tool?.path ? 'uv is found, so the banner installs with uv' : 'uv is not found, so the banner offers to install it through the Install Manager');
  await until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'dependencies' }).length === 1`, 'pyproject marker');
  check((await markers())[0]?.line === 6, 'the missing pyproject.toml item has a warning squiggle');
  const pyTitles = await quickFixTitles(6, 8);
  check(pyTitles.some((x) => x.includes('Install pyide-deps-missing')), 'pyproject.toml offers "Install pyide-deps-missing"');
  await press('Escape');
  await shot('deps-pyproject.png');

  // ---------- Poetry ----------
  rmSync(path.join(project, 'uv.lock'));
  writeFileSync(path.join(project, 'pyproject.toml'), [
    '[tool.poetry]', 'name = "deps-fixture"', '', '[tool.poetry.dependencies]', 'python = "^3.8"', 'pyide-deps-other = "^3.0"', 'pyide-deps-tiny = { version = "~1.0" }', '',
  ].join('\n'));
  await js(`(ide.reloadFromDisk(), true)`);
  await js('ide.dependencies.check()');
  const poetry = await state();
  const pp = poetry.files.find((f) => f.kind === 'pyproject');
  check(poetry.manager === 'poetry', '[tool.poetry] makes it a Poetry project');
  check(pp?.reqs.find((r) => r.name === 'pyide-deps-other')?.status === 'outdated' && pp.reqs.find((r) => r.name === 'pyide-deps-tiny')?.status === 'ok' && !pp.reqs.some((r) => r.name === 'python'),
    'Poetry constraints: ^3.0 is not satisfied by 2.0, ~1.0 is satisfied by 1.0, python is not a package');
  await shot('deps-final.png');
} catch (err) {
  t.check(false, err.message);
  await shot('failure.png');
}
t.finish();
