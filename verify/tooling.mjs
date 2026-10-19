import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

// Local wheels + pip offline so install/upgrade never touch PyPI, and a pip-less venv for "Add Local Interpreter".
const scratch = mkdtempSync(path.join(tmpdir(), 'pyide-tooling-aux-'));
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
const otherVenv = path.join(scratch, 'other');
execFileSync('py', ['-3', '-m', 'venv', '--without-pip', otherVenv]);
const otherExe = path.join(otherVenv, 'Scripts', 'python.exe');
process.env.PIP_NO_INDEX = '1';
process.env.PIP_FIND_LINKS = scratch;

const t = await launch({ fixture: 'tooling', port: 9406 });
const { js, until, press, type, check, shot, click, cdp, sleep } = t;
const S = JSON.stringify;
const text = () => js('ide.editor.getModel().getValue()');
const line = (n) => js(`ide.editor.getModel().getLineContent(${n})`);
const disk = (rel) => readFileSync(path.join(t.project, rel), 'utf8');

async function clickText(selector, label) {
  const box = await js(`(() => { const n = [...document.querySelectorAll(${S(selector)})].find(n => n.textContent.includes(${S(label)})); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`no ${selector} with "${label}"`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(80);
}

async function quickFix(lineNumber, column, label) {
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${lineNumber}, column: ${column} }), true)`);
  // Alt+Enter belongs to the lsp feature; without it, fall back to Monaco's own quick-fix command.
  if (await js(`ide.actions.some(a => a.keys.includes('Alt+Enter'))`)) await press('Alt+Enter');
  else await js(`(ide.editor.trigger('verify', 'editor.action.quickFix', null), true)`);
  await until(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].some(n => n.textContent.includes(${S(label)}))`, `quick fix "${label}"`);
  for (let i = 0; i < 12; i++) {
    if (await js(`!!document.querySelector('.action-widget .monaco-list-row.action.focused')?.textContent.includes(${S(label)})`)) return press('Enter');
    await press('ArrowDown');
  }
  throw new Error(`could not focus quick fix "${label}"`);
}

const settingsOpen = () => js(`!!document.querySelector('.settings-dialog')`);
async function setNumber(key, value) {
  await click(`[data-key="${key}"]`);
  await press('Ctrl+A');
  await type(String(value));
}

try {
  // ---------- Reformat Code ----------
  await openFile(t, 'messy.py');
  const original = await text();
  await press('Ctrl+Alt+L');
  await until(`ide.editor.getModel().getValue().includes('def f(a, b):')`, 'reformatted');
  const formatted = await text();
  check(formatted.includes('x = 1\n\n\ndef f(a, b):\n    return a + b\n\n\ny = [1, 2]'), 'Ctrl+Alt+L formats the buffer with ruff');
  check(await js(`!document.querySelector('#toolingHint').classList.contains('hidden') && document.querySelector('#toolingHint').textContent.includes('Reformatted')`), 'reformat shows a hint');
  check(await js(`!!document.querySelector('.tab.active .dirty')`), 'reformat is a buffer edit (tab dirty, not written to disk)');
  await js(`ide.editor.focus()`);
  await press('Ctrl+Z');
  check((await text()) === original, 'Ctrl+Z undoes the reformat in one step');

  await js(`(ide.editor.focus(), ide.editor.setSelection(new ide.monaco.Selection(4, 1, 5, 15)), true)`);
  await press('Ctrl+Alt+L');
  await until(`ide.editor.getModel().getLineContent(4) === 'def f(a, b):'`, 'range formatted');
  check((await line(3)) === 'x=1' && (await line(6)) === 'y = [1,2]', 'with a selection only the selected lines are reformatted (--range)');
  await press('Ctrl+Alt+L');
  await sleep(300);

  // ---------- Optimize Imports ----------
  await openFile(t, 'imports.py');
  await press('Ctrl+Alt+O');
  await until(`ide.editor.getModel().getValue().startsWith('import os')`, 'imports optimized');
  check((await text()).startsWith('import os\nimport sys\nfrom collections import OrderedDict\n\nprint('), 'Ctrl+Alt+O sorts imports and drops unused ones');
  await press('Ctrl+Z');
  check((await text()).startsWith('import sys\nimport os'), 'Optimize Imports is undoable');

  // ---------- Lint + quick fixes ----------
  await openFile(t, 'lint.py');
  await until(`ide.problems.all().some(p => p.source === 'ruff' && p.path.endsWith('lint.py') && p.msg.startsWith('F401'))`, 'ruff F401 problem');
  const probs = await js(`ide.problems.all().filter(p => p.source === 'ruff' && p.path.endsWith('lint.py'))`);
  check(probs.every((p) => p.severity === 'warning'), 'ruff problems are warnings');
  check(probs.some((p) => p.msg.startsWith('F841') && p.line === 6), 'rule codes in messages (F841 on line 6)');
  check(await js(`ide.monaco.editor.getModelMarkers({ owner: 'ruff' }).some(m => m.message.startsWith('F401') && m.startLineNumber === 2)`), 'ruff markers shown in the editor');
  await quickFix(2, 8, 'Fix with ruff: Remove unused import');
  await until(`!ide.editor.getModel().getValue().includes('import json')`, 'F401 fixed');
  check((await line(1)) === 'import os' && (await line(2)) === '', "'Fix with ruff' applies ruff's fix");
  await until(`!ide.problems.all().some(p => p.source === 'ruff' && p.path.endsWith('lint.py') && p.msg.startsWith('F401'))`, 'F401 cleared after fix');
  const valueLine = await js(`ide.editor.getModel().getLinesContent().findIndex(l => l.includes('value = 1')) + 1`);
  await quickFix(valueLine, 6, '# noqa');
  await until(`ide.editor.getModel().getValue().includes('# noqa: F841')`, 'noqa inserted');
  check((await line(valueLine)) === '    value = 1  # noqa: F841', "'# noqa' suppresses the rule on that line");
  await press('Ctrl+S');
  await until(`!ide.problems.all().some(p => p.source === 'ruff' && p.path.endsWith('lint.py'))`, 'lint clean after save');
  check(true, 'ruff re-runs on save and clears fixed problems');
  await shot('lint.png');

  // ---------- Settings: Editor ----------
  await press('Ctrl+Alt+S');
  await until(`!!document.querySelector('.settings-dialog')`, 'settings dialog');
  check(await js(`document.querySelector('.settings-nav-row.selected').textContent === 'Appearance' && [...document.querySelectorAll('.settings-nav-row')].filter(n => n.offsetParent).map(n => n.textContent.replace(/[▾▸]/g, '')).join('|') === 'Appearance & Behavior|Appearance|Language and Region|Keymap|Editor|General|Code Style|Plugins|Project: project|Python Interpreter|Tools'`), 'Ctrl+Alt+S opens Settings with categories');
  check(await js(`document.querySelector('#settingsApply').disabled`), 'Apply disabled until something changes');
  await type('wrap');
  check(await js(`[...document.querySelectorAll('.settings-nav-row')].filter(n => n.offsetParent).map(n => n.textContent.replace(/[▾▸]/g, '')).join('|') === 'Editor|General|Code Style' && document.querySelector('.settings-page').dataset.page === 'editor'`), 'settings search filters categories');
  await press('Ctrl+A');
  await press('Backspace');
  await click('.settings-nav-row[data-page="editor"]');
  await setNumber('editor.fontSize', 18);
  await click('[data-key="editor.showWhitespace"]');
  await click('[data-key="editor.softWrap"]');
  await click('.settings-nav-row[data-page="codestyle"]');
  await setNumber('editor.tabSize', 2);
  await setNumber('editor.ruler', 100);
  check(await js(`!document.querySelector('#settingsApply').disabled`), 'Apply enabled after edits');
  check(await js(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 14`), 'nothing applied before Apply');
  await click('#settingsApply');
  const E = 'ide.monaco.editor.EditorOption';
  check(await js(`ide.editor.getOption(${E}.fontSize) === 18 && ide.editor.getOption(${E}.lineHeight) === 29`), 'Apply sets font size 18 and line height live');
  check(await js(`ide.editor.getOption(${E}.renderWhitespace) === 'all' && ide.editor.getOption(${E}.wordWrap) === 'on'`), 'show whitespace and soft wrap applied');
  check(await js(`JSON.stringify(ide.editor.getOption(${E}.rulers).map(r => r.column)) === '[100]'`), 'ruler column applied');
  check(await js(`ide.tabs.filter(t => t.kind === 'file').every(t => t.model.getOptions().tabSize === 2)`), 'tab size applied to open files');
  check(await settingsOpen(), 'Apply keeps the dialog open');

  // ---------- Settings: Tools ----------
  await click('.settings-nav-row[data-page="tools"]');
  await until(`document.querySelector('.settings-note')?.textContent.includes('ruff 0.')`, 'ruff version shown');
  await click('[data-key="tools.formatOnSave"]');
  // ---------- Settings: Appearance -> Light ----------
  await click('.settings-nav-row[data-page="appearance"]');
  await js(`document.querySelector('[data-key="appearance.theme"]').focus()`);
  await press('ArrowDown');
  check(await js(`document.querySelector('[data-key="appearance.theme"]').value === 'light'`), 'theme combo switched to Light');
  await shot('settings.png');
  await click('#settingsOk');
  await until(`!document.querySelector('.settings-dialog')`, 'dialog closed by OK');
  check(await js(`ide.settings.get('tools.formatOnSave') === true`), 'OK persists Tools settings');
  check(await js(`document.documentElement.dataset.theme === 'light' && getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)'`), 'Light theme switches the UI colors');
  check(await js(`getComputedStyle(document.querySelector('#toolbar')).backgroundColor === 'rgb(39, 40, 46)'`), 'Light theme keeps the dark main toolbar like PyCharm');
  await openFile(t, 'messy.py');
  // An occluded window skips animation frames, so Monaco may not have painted; a screenshot forces a frame.
  await shot('light.png');
  await until(`[...document.querySelectorAll('.view-line span span')].some(s => s.textContent.trim() === 'def')`, 'def rendered').catch(() => {});
  const colors = await js(`(() => { const c = {}; for (const s of document.querySelectorAll('.view-line span span')) c[s.textContent.trim()] = getComputedStyle(s).color; return c; })()`);
  check(colors.def === 'rgb(0, 51, 179)' && colors.import === 'rgb(0, 51, 179)', `Light editor keyword color 0033b3 (got ${colors.def})`);
  check(await js(`getComputedStyle(document.querySelector('.monaco-editor .monaco-editor-background')).backgroundColor === 'rgb(255, 255, 255)'`), 'Light Monaco background');
  await shot('light.png');

  // ---------- Format on save ----------
  await openFile(t, 'savefmt.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 3, column: 1 }), true)`);
  await type('x=greet( "a" )\n');
  await press('Ctrl+S');
  await until(`ide.editor.getModel().getValue().includes('x = greet("a")') && !document.querySelector('.tab.active .dirty')`, 'formatted on save');
  check(disk('savefmt.py') === 'def greet(name):\n    return "hi " + name\n\n\nx = greet("a")\n', 'format on save writes the formatted file');

  // ---------- Persistence across restart ----------
  await js(`(location.reload(), true)`).catch(() => {});
  await sleep(1500);
  await until('window.__ideReady === true', 'IDE ready after reload', 30000);
  await openFile(t, 'messy.py');
  check(await js(`document.documentElement.dataset.theme === 'light' && ide.editor.getOption(${E}.fontSize) === 18 && ide.editor.getModel().getOptions().tabSize === 2 && ide.editor.getOption(${E}.wordWrap) === 'on'`), 'settings re-applied at startup after restart');

  // ---------- Python Interpreter: create venv ----------
  await press('Ctrl+Alt+Shift+S');
  await until(`document.querySelector('.settings-page')?.dataset.page === 'interpreter'`, 'interpreter page');
  check(true, 'Ctrl+Shift+Alt+S opens the Python Interpreter page');
  await until(`document.querySelectorAll('#settingsPackages .pkg-trow').length > 0`, 'system interpreter packages listed', 60000);
  await click('#addInterpBtn');
  await clickText('#addInterpMenu .menu-item', 'Create Virtualenv');
  await until(`document.querySelector('#venvLocation')?.value.endsWith('\\\\.venv')`, 'venv form');
  check(await js(`document.querySelector('#venvLocation').value.toLowerCase() === ${S(path.join(t.project, '.venv').toLowerCase())}`), 'new venv defaults to <project>\\.venv');
  await click('#venvCreate');
  await until(`document.querySelector('#interpStatus').textContent.startsWith('Created')`, 'venv created', 180000);
  check(await js(`ide.currentInterp().executable.toLowerCase().startsWith(${S(path.join(t.project, '.venv').toLowerCase())})`), 'created venv becomes the project interpreter');
  await until(`[...document.querySelectorAll('#settingsPackages .pkg-trow')].some(r => r.textContent.startsWith('pip'))`, 'venv packages', 60000);
  check(await js(`document.querySelectorAll('#settingsPackages .pkg-trow').length <= 3`), 'interpreter page lists the venv packages');

  // ---------- Python Interpreter: add existing (the native file dialog is stubbed) ----------
  await js(`(window.__api = ide.api, ide.api = { ...window.__api, openFileDialog: async () => ${S(otherExe)} }, true)`);
  await click('#addInterpBtn');
  await clickText('#addInterpMenu .menu-item', 'Add Local Interpreter');
  await until(`document.querySelector('#interpStatus').textContent.startsWith('Added')`, 'interpreter added', 30000);
  await js(`(ide.api = window.__api, true)`);
  check(await js(`ide.settings.get('interpreters.extra', []).some(p => p.toLowerCase() === ${S(otherExe.toLowerCase())})`), "existing python.exe saved to 'interpreters.extra'");
  check(await js(`ide.currentInterp().executable.toLowerCase() === ${S(otherExe.toLowerCase())} && [...document.querySelector('#settingsInterp').options].length >= 3`), 'added interpreter listed and selected');
  await shot('interpreter.png');
  await js(`document.querySelector('#settingsInterp').focus()`);
  await press('ArrowUp');
  check(await js(`!document.querySelector('#settingsApply').disabled`), 'choosing another interpreter is a pending change');
  await click('#settingsOk');
  await until(`ide.currentInterp()?.executable.toLowerCase().includes('\\\\.venv\\\\')`, 'venv selected again');
  check(true, 'OK switches the project interpreter back to .venv');

  // ---------- Python Packages tool window ----------
  // Not pinned to the sidebar by default: open it from the sidebar's More menu.
  await click('#stripeMore');
  await until(`!!document.querySelector('#moreToolWindows .more-row[data-tool="PythonPackages"]')`, 'more menu');
  await click('#moreToolWindows .more-row[data-tool="PythonPackages"]');
  await until(`ide.toolWindows.get('PythonPackages').isVisible() && [...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pip')`, 'packages listed', 60000);
  check(await js(`document.querySelector('.pkgs-interp').textContent.includes('.venv')`), 'tool window shows the current interpreter');
  check(await js(`ide.currentInterp().executable.toLowerCase().startsWith(${S(t.project.toLowerCase())})`), 'about to install only into the temp project venv');
  await click('#pkgSearch');
  await type('pyide-probe==0.1');
  await until(`!!document.querySelector('#pkgInstallRow')`, 'install row');
  await click('#pkgInstallRow');
  await until(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-probe' && r.textContent.includes('0.1'))`, 'installed 0.1', 120000);
  check(await js(`document.querySelector('#pkgOut').textContent.includes('Successfully installed pyide-probe-0.1')`), 'install by name shows pip output');
  check(await js(`document.querySelector('.pkg-title')?.textContent.includes('pyide-probe')`), 'installed package is selected');
  await click('#pkgSearch');
  await type('probe');
  check(await js(`[...document.querySelectorAll('#pkgList .pkg-row')].every(r => r.dataset.name.includes('probe')) && !document.querySelector('#pkgList .pkg-row[data-name="pip"]')`), 'search filters installed packages');
  await click('#pkgUpgrade');
  await until(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-probe' && r.textContent.includes('0.2'))`, 'upgraded to 0.2', 120000);
  check(true, 'Upgrade installs the newer version');
  await shot('packages.png');
  await click('#pkgUninstall');
  await until(`document.querySelector('.dialog-title')?.textContent === 'Uninstall Package'`, 'confirm dialog');
  check(await js(`[...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-probe')`), 'nothing uninstalled before confirming');
  await click('.dialog-buttons .primary');
  await until(`![...document.querySelectorAll('#pkgList .pkg-row')].some(r => r.dataset.name === 'pyide-probe')`, 'uninstalled', 120000);
  check(await js(`document.querySelector('#pkgOut').textContent.includes('Successfully uninstalled')`), 'Uninstall after confirmation removes the package');
  await shot('final.png');
} catch (err) {
  t.check(false, err.message);
  await shot('failure.png');
}
t.finish();
