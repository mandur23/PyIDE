// Korean UI of the tooling (ruff) and packages (Python Packages) plugins, in Dark and Light.
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = JSON.stringify;

// ---------- static: every string these plugins pass to tr() has a Korean entry ----------
// Collects string literals inside tr(...) calls (skipping lowercase identifiers such as channel names) plus the
// pip console messages, which are looked up through tr(msg.start) and friends.
function trStrings(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Set();
  const lit = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/y;
  for (let i = src.indexOf('tr('); i >= 0; i = src.indexOf('tr(', i + 1)) {
    if (/[\w.]/.test(src[i - 1] || '')) continue;
    let depth = 0;
    for (let j = i + 2; j < src.length; j++) {
      const c = src[j];
      if (c === "'" || c === '"') {
        lit.lastIndex = j;
        const m = lit.exec(src);
        const s = m[1] ?? m[2];
        if (/[A-Z{… ]/.test(s)) out.add(s);
        j = lit.lastIndex - 1;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
  }
  for (const m of src.matchAll(/\b(?:start|done|failed): '([^']+)'/g)) out.add(m[1]);
  return out;
}
const mine = new Set();
let staticOk = true;
const staticMissing = [];
for (const plugin of ['tooling', 'packages']) {
  const dir = path.join(APP_DIR, 'renderer', 'features', plugin);
  const ko = JSON.parse(readFileSync(path.join(dir, 'locales', 'ko.json'), 'utf8'));
  for (const s of trStrings(path.join(dir, 'index.js'))) {
    mine.add(s);
    if (!(s in ko)) { staticOk = false; staticMissing.push(`${plugin}: ${s}`); }
  }
}

// ---------- a project venv with pip, plus local wheels so install/upgrade never touch PyPI ----------
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-i18n-tooling-aux-'));
const WHEELS = `
import zipfile, hashlib, base64, sys, os
for ver in ('0.1', '0.2'):
    info = f'pyide_probe-{ver}.dist-info'
    files = {'pyide_probe/__init__.py': f'__version__ = "{ver}"\\n',
             f'{info}/METADATA': f'Metadata-Version: 2.1\\nName: pyide-probe\\nVersion: {ver}\\n',
             f'{info}/WHEEL': 'Wheel-Version: 1.0\\nGenerator: pyide-verify\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}
    record = []
    with zipfile.ZipFile(os.path.join(sys.argv[1], f'pyide_probe-{ver}-py3-none-any.whl'), 'w') as z:
        for p, c in files.items():
            b = c.encode()
            h = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()
            z.writestr(p, b)
            record.append(f'{p},sha256={h},{len(b)}')
        record.append(f'{info}/RECORD,,')
        z.writestr(f'{info}/RECORD', '\\n'.join(record) + '\\n')
`;
execFileSync('py', ['-3', '-I', '-c', WHEELS, scratch]);
const venv = path.join(scratch, 'venv');
execFileSync('py', ['-3', '-m', 'venv', venv]);
const venvExe = path.join(venv, 'Scripts', 'python.exe');
process.env.PIP_NO_INDEX = '1';
process.env.PIP_FIND_LINKS = scratch;

const t = await launch({ fixture: 'tooling', port: 9446, name: 'i18n-tooling', lang: 'ko-KR' });
const { js, until, press, type, check, shot, click, cdp, sleep } = t;
const hint = () => js(`document.querySelector('#toolingHint').textContent`);
const leaks = async (selector, label) => {
  const l = await englishLeaks(t, selector);
  check(l.length === 0, `${label}: no English UI text${l.length ? ` (${S(l)})` : ''}`);
};
const pkgRows = () => js(`[...document.querySelectorAll('#pkgList .pkg-row')].map(r => r.dataset.name + ' ' + r.querySelector('.pkg-ver').textContent)`);
const out = () => js(`document.querySelector('#pkgOut').textContent`);

check(staticOk, `every tr() string of tooling/packages has a ko.json entry${staticMissing.length ? ` (missing: ${S(staticMissing)})` : ''}`);

try {
  check(await js(`i18n.locale === 'ko'`), 'ko-KR session runs in Korean');

  // ---------- actions ----------
  const titles = await js(`Object.fromEntries(ide.actions.filter(a => ['ReformatCode', 'OptimizeImports', 'RuffFixAll'].includes(a.id)).map(a => [a.id, a.title]))`);
  check(titles.ReformatCode === '코드 서식 다시 지정' && titles.OptimizeImports === 'import 최적화' && titles.RuffFixAll === '파일의 모든 Ruff 문제 수정', `action titles in Korean (${S(titles)})`);

  // ---------- Reformat Code / Optimize Imports hints ----------
  await openFile(t, 'messy.py');
  await press('Ctrl+Alt+L');
  await until(`ide.editor.getModel().getValue().includes('def f(a, b):')`, 'reformatted');
  check(/^코드 서식을 다시 지정했습니다: \d+줄 변경됨$/.test(await hint()), `reformat hint in Korean (${await hint()})`);
  await leaks('#toolingHint', 'reformat hint');
  await shot('reformat-dark.png');
  await press('Ctrl+Alt+L');
  await until(`document.querySelector('#toolingHint').textContent.startsWith('변경된 줄 없음')`, 'already formatted hint');
  check(true, 'already-formatted hint in Korean');
  await js(`(ide.editor.focus(), ide.editor.setSelection(new ide.monaco.Selection(1, 1, 2, 1)), true)`);
  await press('Ctrl+Z');
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(4, 1, 5, 15)), true)`);
  await press('Ctrl+Alt+L');
  await until(`document.querySelector('#toolingHint').textContent.startsWith('선택한 텍스트의 서식을')`, 'selection hint');
  check(true, 'reformat-selection hint in Korean');

  await openFile(t, 'imports.py');
  await press('Ctrl+Alt+O');
  await until(`ide.editor.getModel().getValue().startsWith('import os')`, 'imports optimized');
  check((await hint()) === 'import를 최적화했습니다', `optimize imports hint in Korean (${await hint()})`);
  await press('Ctrl+Alt+O');
  await until(`document.querySelector('#toolingHint').textContent === '사용되지 않는 import가 없습니다'`, 'no unused imports hint');
  check(true, 'nothing-to-optimize hint in Korean');
  await leaks('#toolingHint', 'optimize imports hint');

  // ---------- project tree actions (file not open: rewritten on disk) ----------
  await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes('savefmt.py')); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 30, clientY: r.y + r.height / 2 })); return true; })()`);
  await until(`!!document.querySelector('.context-menu')`, 'tree context menu');
  const items = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.textContent)`);
  check(items.includes('코드 서식 다시 지정Ctrl+Alt+L') && items.includes('import 최적화Ctrl+Alt+O'), `tree context menu items in Korean (${S(items)})`);
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.startsWith('코드 서식 다시 지정')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(`document.querySelector('#toolingHint').textContent === 'savefmt.py을(를) 업데이트했습니다'`, 'tree reformat hint');
  check(true, 'tree reformat hint in Korean');

  // ---------- quick fixes ----------
  await openFile(t, 'lint.py');
  await until(`ide.problems.all().some(p => p.source === 'ruff' && p.path.endsWith('lint.py') && p.msg.startsWith('F401'))`, 'ruff F401 problem');
  // A pause after the caret move, as in verify/tooling.mjs's quickFix(): Monaco's own check 250 ms after it would
  // replace an explicit request still waiting on Pyright.
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 8 }), true)`);
  await sleep(400);
  await js(`(ide.editor.trigger('verify', 'editor.action.quickFix', null), true)`);
  await until(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].some(n => n.textContent.includes('ruff로 수정'))`, 'quick fix menu');
  const fixes = await js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(n => n.textContent).filter(s => /ruff|noqa|Ruff/.test(s))`);
  check(fixes.some((s) => s.startsWith('ruff로 수정: ') && s.includes('(F401)')), `'Fix with ruff' in Korean (${S(fixes)})`);
  check(fixes.includes('이 줄에서 F401 억제 (# noqa)'), "'# noqa' suppression in Korean");
  // ruff's own fix message ("Remove unused import") is tool output and stays English; everything else must be Korean.
  check(fixes.every((s) => /[가-힣]/.test(s)), 'every ruff quick fix label carries Korean UI text');
  await shot('quickfix.png');
  await press('Escape');

  // ---------- Python Packages tool window ----------
  await js(`(ide.settings.set('interpreters.extra', [${S(venvExe)}]), ide.settings.set('interpreter.' + ide.root, ${S(venvExe)}), true)`);
  await js(`ide.reloadInterpreters()`);
  check(await js(`ide.currentInterp()?.executable.toLowerCase() === ${S(venvExe.toLowerCase())}`), 'temp venv is the project interpreter (nothing installs elsewhere)');
  check(await js(`[...document.querySelectorAll('.bottom-tab')].some(n => n.textContent === 'Python 패키지') && !!document.querySelector('.stripe-btn[title^="Python 패키지"]')`), 'tool window title in Korean');
  await js(`(ide.toolWindows.get('PythonPackages').show(), true)`);
  await until(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pip')`, 'packages listed', 60000);
  check(await js(`document.querySelector('#pkgSearch').placeholder === '검색하거나 설치할 패키지 이름 입력'`), 'search placeholder in Korean');
  check(await js(`document.querySelector('.pkgs-interp').textContent.startsWith('설치 위치: ')`), 'interpreter line in Korean');
  check(await js(`document.querySelector('#pkgDetails').textContent === '작업을 보려면 패키지를 선택하세요'`), 'empty details state in Korean');
  check(await js(`[...document.querySelectorAll('#bottom button[title]')].some(b => b.title === '새로고침')`), 'Refresh action tooltip in Korean');
  await leaks('.pkgs', 'Python Packages window');
  await leaks('.bottom-tab.active', 'Python Packages tab');

  await click('#pkgSearch');
  await type('pyide-probe==0.1');
  await until(`!!document.querySelector('#pkgInstallRow')`, 'install row');
  check(await js(`document.querySelector('#pkgInstallRow').textContent === "'pyide-probe==0.1' 설치PyPI에서"`), 'install row in Korean');
  await leaks('.pkgs', 'install row');
  await click('#pkgInstallRow');
  await until(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-probe')`, 'installed', 120000);
  const installOut = await out();
  check(installOut.includes('에 pyide-probe==0.1 설치 중') && installOut.includes('pyide-probe==0.1 설치됨'), 'install output headers in Korean');
  check(installOut.includes('Successfully installed pyide-probe-0.1'), "pip's own output left untouched");
  check(await js(`document.querySelector('#pkgUpgrade').textContent === '업그레이드' && document.querySelector('#pkgUninstall').textContent === '제거'`), 'Upgrade / Uninstall buttons in Korean');
  await leaks('.pkgs', 'package details');
  await click('#pkgUpgrade');
  await until(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-probe' && r.textContent.includes('0.2'))`, 'upgraded', 120000);
  check((await out()).includes('pyide-probe 업그레이드됨'), 'upgrade output headers in Korean');
  await shot('packages-dark.png');

  await click('#pkgUninstall');
  await until(`!!document.querySelector('.dialog')`, 'confirm dialog');
  check(await js(`document.querySelector('.dialog-title').textContent === '패키지 제거' && [...document.querySelectorAll('.dialog-buttons button')].map(b => b.textContent).join('|') === '제거|취소'`), 'uninstall confirmation in Korean');
  check(/에서 'pyide-probe' 0\.2을\(를\) 제거하시겠습니까\?$/.test(await js(`document.querySelector('.dialog-body').textContent`)), 'uninstall question in Korean');
  await leaks('.dialog', 'uninstall confirmation');
  await shot('uninstall-dialog.png');
  await click('.dialog-buttons .primary');
  await until(`![...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-probe')`, 'uninstalled', 120000);
  check((await out()).includes('pyide-probe 제거 중') && (await out()).includes('pyide-probe 제거됨'), 'uninstall output headers in Korean');

  // ---------- Light theme ----------
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await sleep(200);
  if (!(await js(`document.documentElement.dataset.theme === 'light'`))) await js(`(document.documentElement.dataset.theme = 'light', true)`);
  await click('#pkgSearch');
  await type('pip');
  await until(`!!document.querySelector('#pkgList .pkg-row[data-name="pip"]')`, 'pip row');
  await click('#pkgList .pkg-row[data-name="pip"]');
  const light = await js(`(() => {
    const bg = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
    const fg = (s) => getComputedStyle(document.querySelector(s)).color;
    return { bottom: bg('#bottom'), title: fg('.pkg-title'), ver: fg('.pkg-title .pkg-ver'), row: bg('#pkgList .pkg-row.selected') };
  })()`);
  check(light.bottom === 'rgb(255, 255, 255)' && light.title === 'rgb(0, 0, 0)' && light.row !== 'rgb(46, 67, 110)', `Light Packages colors (${S(light)})`);
  await shot('packages-light.png');
  await openFile(t, 'messy.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await type('x=2\n');
  await press('Ctrl+Alt+L');
  await until(`document.querySelector('#toolingHint').textContent.startsWith('코드 서식을')`, 'light reformat hint');
  const hintStyle = await js(`(() => { const s = getComputedStyle(document.querySelector('#toolingHint')); return { bg: s.backgroundColor, fg: s.color, shadow: s.boxShadow }; })()`);
  check(hintStyle.bg === 'rgb(255, 255, 255)' && hintStyle.fg === 'rgb(0, 0, 0)' && !hintStyle.shadow.includes('0.4'), `Light reformat hint colors (${S(hintStyle)})`);
  await shot('reformat-light.png');

  // ---------- runtime: nothing these plugins asked tr() for is missing ----------
  const missing = (await missingTranslations(t)).filter((s) => mine.has(s));
  check(missing.length === 0, `no missing Korean strings from tooling/packages${missing.length ? ` (${S(missing)})` : ''}`);
} catch (err) {
  t.check(false, err.message);
  await shot('failure.png');
}
t.finish();
