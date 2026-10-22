// Quick fix "Install package '<dist>'" on an unresolved import: the import name maps to its distribution, the standard
// library and the project's own modules get no fix, the install runs with pip in the Packages console and Pyright's
// squiggle goes, "… and add to requirements.txt" writes the requirement, and the Korean titles. Offline: tiny local
// wheels and PIP_NO_INDEX, so nothing reaches PyPI. Ports 9300-9301.
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-import-install-'));
const wheels = path.join(scratch, 'wheels');
// pyide-imp-demo (module pyide_imp_demo) and a stand-in PyYAML 6.0.99 (module yaml), so `import yaml` resolves offline.
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
execFileSync('py', ['-3', '-m', 'venv', path.join(project, '.venv')]);
const venvPython = path.join(project, '.venv', 'Scripts', 'python.exe');
const env = { PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels };
const MAIN = path.join(project, 'main.py');

let t = await launch({ name: 'import-install', port: 9300, projectDir: project, env });
const userData = t.userData;
const LINES = { demo: 2, yaml: 3, cv2: 4, helpers: 5, mylib: 6, distutils: 7 };
const missing = (line) => `ide.lsp.diagnostics(${S(MAIN)}).some(d => d.range.start.line === ${line - 1} && ['reportMissingImports', 'reportMissingModuleSource'].includes(d.code))`;
const marker = (line) => `ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri, owner: 'pyright' }).some(m => m.startLineNumber === ${line})`;

async function quickFixTitles(line) {
  const { js, until, press, sleep } = t;
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 9 }), true)`);
  // Monaco's own code-action check runs 250 ms after a caret move and replaces an explicit request still waiting.
  await sleep(400);
  await press('Alt+Enter');
  await until(`document.querySelectorAll('.action-widget .monaco-list-row.action').length > 0`, `quick fix menu on line ${line}`);
  return js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent)`);
}
async function choose(label) {
  const { js, press } = t;
  for (let i = 0; i < 12; i++) {
    if (await js(`!!document.querySelector('.action-widget .monaco-list-row.action.focused')?.textContent.includes(${S(label)})`)) return press('Enter');
    await press('ArrowDown');
  }
  throw new Error(`could not focus quick fix "${label}"`);
}

async function openMain() {
  const isVenv = `ide.currentInterp()?.executable.toLowerCase() === ${S(venvPython.toLowerCase())}`;
  try { await t.until(isVenv, 'project venv selected', 20000); } catch {
    await t.until(`ide.interps.some(i => i.executable.toLowerCase() === ${S(venvPython.toLowerCase())})`, 'venv listed', 20000);
    await t.js(`(ide.setInterpreter(${S(venvPython)}), true)`);
    await t.until(isVenv, 'venv selected');
  }
  await openFile(t, 'main.py');
  await t.until(`ide.lsp.status() === 'ready' && ${missing(LINES.cv2)}`, 'Pyright reports the unresolved imports', 60000);
}

try {
  const { js, until, check, press, shot } = t;
  await openMain();

  // ---------- import name -> distribution ----------
  const map = await js(`Object.fromEntries(['cv2', 'PIL', 'PIL.Image', 'sklearn.linear_model', 'yaml', 'bs4', 'dateutil.parser', 'dotenv', 'attr', 'jwt', 'serial',
    'Crypto.Cipher', 'docx', 'magic', 'win32api', 'win32con', 'google.protobuf', 'google', 'requests', 'typing_extensions', 'os', 'os.path', 'distutils', 'tomllib', '.local', '..pkg.mod']
    .map(n => [n, ide.importInstall.distFor(n)]))`);
  check(map.cv2 === 'opencv-python' && map.PIL === 'Pillow' && map['PIL.Image'] === 'Pillow' && map['sklearn.linear_model'] === 'scikit-learn' && map.yaml === 'PyYAML'
    && map.bs4 === 'beautifulsoup4' && map['dateutil.parser'] === 'python-dateutil' && map.dotenv === 'python-dotenv' && map.attr === 'attrs' && map.jwt === 'PyJWT'
    && map.serial === 'pyserial' && map['Crypto.Cipher'] === 'pycryptodome' && map.docx === 'python-docx' && map.magic === 'python-magic'
    && map.win32api === 'pywin32' && map.win32con === 'pywin32' && map['google.protobuf'] === 'protobuf', `well-known import names map to their distributions (${S(map)})`);
  check(map.requests === 'requests' && map.typing_extensions === 'typing-extensions', 'other names install their top-level module name');
  check(map.os === null && map['os.path'] === null && map.distutils === null && map.tomllib === null && map['.local'] === null && map['..pkg.mod'] === null && map.google === null,
    'standard library, relative imports and the bare google namespace get no distribution');

  // ---------- which imports get the fix ----------
  let titles = await quickFixTitles(LINES.cv2);
  check(titles.some((x) => x.includes("Install package 'opencv-python'")), `import cv2 offers "Install package 'opencv-python'" (${S(titles)})`);
  check(titles.some((x) => x.includes("Install package 'opencv-python' and add to requirements.txt")), 'and "… and add to requirements.txt" since the project has one');
  await press('Escape');
  await shot('import-install-menu.png');
  for (const [name, line] of [['a module in tools/ of the project', LINES.helpers], ['a package in lib/ of the project', LINES.mylib]]) {
    check(await js(missing(line)), `Pyright cannot resolve ${name}`);
    titles = await quickFixTitles(line);
    check(!titles.some((x) => x.includes('Install package')), `${name} gets no install fix (${S(titles)})`);
    await press('Escape');
  }
  if (await js(missing(LINES.distutils))) {
    titles = await quickFixTitles(LINES.distutils);
    check(!titles.some((x) => x.includes('Install package')), `a standard library module that Pyright flags (distutils) gets no install fix (${S(titles)})`);
    await press('Escape');
  } else check(true, 'distutils is not flagged by this Pyright/Python; covered by the mapping check');

  // ---------- Install package 'pyide-imp-demo' ----------
  check(await js(marker(LINES.demo)), 'the unresolved import has a squiggle');
  titles = await quickFixTitles(LINES.demo);
  check(titles.some((x) => x.includes("Install package 'pyide-imp-demo'")), 'import pyide_imp_demo offers "Install package \'pyide-imp-demo\'"');
  await choose("Install package 'pyide-imp-demo'");
  await until(`/Successfully installed pyide[-_]imp[-_]demo-1\\.0/i.test(document.querySelector('#pkgOut')?.textContent || '')`, 'pip installed the wheel', 120000);
  check(await js(`ide.toolWindows.get('PythonPackages').isVisible() && document.querySelector('#pkgOut').textContent.includes('python -m pip install pyide-imp-demo')`),
    'the install runs "python -m pip install pyide-imp-demo" in the visible Python Packages console');
  await until(`!(${missing(LINES.demo)}) && !(${marker(LINES.demo)})`, 'squiggle gone after the install', 60000);
  check(true, 'Pyright resolves the import again and the squiggle is gone');
  check(await js(missing(LINES.cv2)), 'the other unresolved imports keep their squiggles');
  check(readFileSync(path.join(project, 'requirements.txt'), 'utf8') === '# Requirements of the import-install fixture\n', 'the plain fix leaves requirements.txt alone');

  // ---------- Install package 'PyYAML' and add to requirements.txt ----------
  check(await js(missing(LINES.yaml)), 'import yaml is unresolved (reportMissingModuleSource: stubs but no source)');
  titles = await quickFixTitles(LINES.yaml);
  await choose("Install package 'PyYAML' and add to requirements.txt");
  await until(`/Successfully installed pyyaml-6\\.0\\.99/i.test(document.querySelector('#pkgOut')?.textContent || '')`, 'PyYAML installed', 120000);
  await until(`(ide.dependencies.state().files.find(f => f.kind === 'requirements')?.reqs || []).some(r => r.name === 'PyYAML')`, 'requirement added', 30000);
  const req = readFileSync(path.join(project, 'requirements.txt'), 'utf8');
  check(req === '# Requirements of the import-install fixture\nPyYAML~=6.0.99\n', `"… and add to requirements.txt" appends PyYAML~=6.0.99 (${S(req)})`);
  await until(`!(${missing(LINES.yaml)})`, 'yaml squiggle gone', 60000);
  check(true, 'the yaml squiggle is gone');
  await shot('import-install-done.png');
} catch (err) {
  t.check(false, err.message);
  await t.shot('failure.png');
}

// ---------- Korean ----------
const results = t.results;
t.close();
t = await launch({ name: 'import-install-ko', port: 9301, projectDir: project, userData, lang: 'ko-KR', env });
t.results.push(...results);
try {
  const { js, check, press } = t;
  const { missingTranslations } = await import('./i18n-lib.mjs');
  await openMain();
  const titles = await quickFixTitles(LINES.cv2);
  check(titles.some((x) => x.includes("'opencv-python' 패키지 설치")) && titles.some((x) => x.includes("'opencv-python' 패키지 설치 후 requirements.txt에 추가")),
    `the quick fixes are Korean (${S(titles)})`);
  await press('Escape');
  const mine = new Set(Object.keys(JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'features', 'import-install', 'locales', 'ko.json'), 'utf8'))));
  const missingKo = (await missingTranslations(t)).filter((s) => mine.has(s) || /Install package/.test(s));
  check(!missingKo.length, `no missing Korean translations (${S(missingKo)})`);
  check(!(await js(`[...i18n.missing]`)).some((s) => /^(Done|Failed with exit code \{code\})$/.test(s)), 'the packages console texts have Korean entries');
} catch (err) {
  t.check(false, err.message);
  await t.shot('failure-ko.png');
}
t.finish();
