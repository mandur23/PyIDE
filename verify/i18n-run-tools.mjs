// Korean UI of the run, tests and pyconsole plugins (run widget, Run/Debug Configurations, Run tool window, gutter
// menu, Test Results, Python Console), then the same surfaces in the Light theme.
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const q = JSON.stringify;
const PLUGINS = ['run', 'tests', 'pyconsole'];

// ---------- static: every string these plugins pass to tr() has a Korean entry in that plugin's ko.json ----------
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
        // Unescape the JS literal (e.g. 'path\\to\\script.py').
        const s = (m[1] ?? m[2]).replace(/\\(.)/g, '$1');
        if (/[A-Za-z]/.test(s) && !/^[a-z]+$/.test(s)) out.add(s);
        j = lit.lastIndex - 1;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
  }
  return out;
}
const mine = new Set();
const staticMissing = [];
for (const plugin of PLUGINS) {
  const dir = path.join(APP_DIR, 'renderer', 'features', plugin);
  const ko = JSON.parse(readFileSync(path.join(dir, 'locales', 'ko.json'), 'utf8'));
  for (const s of trStrings(path.join(dir, 'index.js'))) {
    mine.add(s);
    if (!(s in ko)) staticMissing.push(`${plugin}: ${s}`);
  }
}
// 'none' is lowercase and skipped by the literal filter above; add it explicitly.
mine.add('none');

const t = await launch({ fixture: 'run-tools', port: 9445, name: 'i18n-run-tools', lang: 'ko-KR' });
const { js, until, press, type, click, shot, sleep } = t;
const check = (ok, label) => t.check(ok, label);
const hangul = (s) => /[가-힣]/.test(s || '');

// Config names are user data (file names, names typed in the dialog); menus and pickers print them next to UI text.
const CONFIG_NAMES = ['app', 'App', 'with', 'args', 'scratch', 'calc', 'slow', 'units'];
async function noLeaks(selector, label, extra = []) {
  const leaks = await englishLeaks(t, selector, extra);
  check(leaks.length === 0, `${label}: no English UI text${leaks.length ? ` (${leaks.map((l) => `${l.text} @${l.where}`).join(' | ')})` : ''}`);
}
const menuItems = () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.textContent)`);
async function clickMenu(text) {
  const found = await js(`(() => { const n = [...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes(${q(text)})); n?.classList.add('pick-menu'); return !!n; })()`);
  if (!found) throw new Error(`menu item ${text} not found in ${q(await menuItems())}`);
  await click('.context-menu .menu-item.pick-menu');
}
const closeMenu = async () => { await click('#status'); await until(`!document.querySelector('.context-menu')`, 'menu closed', 3000); };
async function clickGutter(line) {
  // The editor of a freshly opened file may not be laid out yet in an occluded test window.
  await sleep(400);
  await js(`ide.editor.layout()`);
  await js(`ide.editor.revealLineInCenter(${line})`);
  const find = `(() => {
    const ed = ide.editor; ed.render(true); const top = ed.getTopForLineNumber(${line}) - ed.getScrollTop();
    const host = document.querySelector('#editor').getBoundingClientRect();
    const n = [...document.querySelectorAll('#editor .run-gutter-icon')].find(i => Math.abs(i.getBoundingClientRect().top - host.top - top) < 4);
    if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
  await until(find, `gutter icon on line ${line}`, 8000);
  const box = await js(find);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(150);
}
async function treeMenu(name) {
  await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.textContent.includes(${q(name)})); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); })()`);
  await until(`!!document.querySelector('.context-menu')`, `tree menu on ${name}`, 3000);
  return menuItems();
}
const runOut = () => js(`document.querySelector('#runOut')?.textContent || ''`);
const activeOut = () => js(`document.querySelector('.run-session:not(.hidden) .console')?.textContent || ''`);
const waitTests = (label, ms = 30000) => until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, label, ms);
const testStatus = () => js(`document.querySelector('.run-session:not(.hidden) .tr-status').textContent`);
// Tool window tab, stripe button and title-bar actions of one of our windows.
async function toolWindowChrome(id, label) {
  const c = await js(`(() => { const tw = ide.toolWindows.get(${q(id)}); return { tab: tw.tab.textContent, stripe: tw.button.title,
    actions: [...document.querySelectorAll('#bottomActions button')].map(b => b.title) }; })()`);
  check(hangul(c.tab) && hangul(c.stripe), `${label} tool window tab and stripe tooltip are Korean (${c.tab} / ${c.stripe})`);
  check(c.actions.length > 0 && c.actions.every(hangul), `${label} toolbar actions are Korean (${c.actions.join(' | ')})`);
}

try {
  check(staticMissing.length === 0, `every tr() string in run/tests/pyconsole has a Korean entry${staticMissing.length ? ` (missing: ${staticMissing.join(', ')})` : ''}`);
  check(await js(`i18n.locale === 'ko'`), 'session runs in Korean');

  // ---------- run widget (toolbar) ----------
  const tb = await js(`({ target: document.querySelector('.run-target').textContent, targetTitle: document.querySelector('.run-target').title,
    run: document.querySelector('.run-btn').title, stop: document.querySelector('.stop-btn').title })`);
  check(tb.target.includes('현재 파일'), `run widget shows 현재 파일 (${tb.target})`);
  check(tb.targetTitle === '실행/디버그 구성' && tb.run === '실행 (Shift+F10)' && tb.stop === '중지 (Ctrl+F2)', `toolbar tooltips (${tb.targetTitle} / ${tb.run} / ${tb.stop})`);

  // ---------- Run tool window, empty ----------
  await js(`ide.toolWindows.get('Run').show()`);
  await noLeaks('.run-tool', 'empty Run tool window');
  check(hangul(await js(`document.querySelector('.run-empty').textContent`)), 'Run tool window empty state is Korean');
  const runChrome = await js(`(() => { const tw = ide.toolWindows.get('Run'); return [tw.tab.textContent, tw.button.title]; })()`);
  check(runChrome[0] === '실행' && runChrome[1].startsWith('실행'), `Run tool window title (${runChrome.join(' / ')})`);

  // Shift+F10 with nothing to run explains itself in a dialog.
  await js(`[...ide.tabs].forEach(tab => ide.closeTab(tab.path, true))`);
  await js(`document.activeElement?.blur()`);
  await js(`ide.run.runCurrentFile()`);
  await until(`!!document.querySelector('.dialog')`, 'nothing-to-run dialog');
  await noLeaks('.dialog', 'nothing-to-run dialog');
  await click('.dialog-buttons .primary');

  // ---------- gutter menu, a run, the exit line ----------
  await openFile(t, 'app.py');
  await until(`ide.editor.getModel().getAllDecorations().some(d => (d.options.glyphMarginClassName || '').includes('run-gutter-icon'))`, 'gutter icon');
  const hover = await js(`ide.editor.getModel().getAllDecorations().find(d => (d.options.glyphMarginClassName || '').includes('run-gutter-icon')).options.glyphMarginHoverMessage.value`);
  check(hover === "'app' 실행", `gutter icon tooltip (${hover})`);
  await clickGutter(14);
  const gm = await menuItems();
  check(gm.some((s) => s.includes("'app' 실행")) && gm.some((s) => s.includes('실행 구성 수정…')), `gutter menu (${gm.join(' | ')})`);
  if (await js(`ide.actions.some(a => a.id === 'DebugCurrent' || a.id === 'Debug')`)) check(gm.some((s) => s.includes("'app' 디버그")), 'gutter menu offers 디버그');
  await noLeaks('.context-menu', 'gutter menu');
  await clickMenu("'app' 실행");
  await until(`document.querySelector('#runOut')?.textContent.includes('종료 코드 0(으)로 완료된 프로세스')`, 'Korean exit line');
  check(true, 'Run prints 종료 코드 0(으)로 완료된 프로세스');
  check((await runOut()).includes('sum: 5'), 'program output is shown untranslated');
  await noLeaks('.run-tool', 'Run tool window with a session');
  await toolWindowChrome('Run', 'Run');
  check((await js(`document.querySelector('#bottomActions button').title`)) === "'app' 다시 실행", 'Rerun action names the configuration');
  check(await js(`document.querySelector('.run-tab-close').title === '닫기'`), 'Run tab close tooltip');

  // ---------- run widget dropdown ----------
  await click('.run-target');
  const tm = await menuItems();
  check(tm.some((s) => s.includes('현재 파일')) && tm.some((s) => s.includes('구성 편집…')) && tm.some((s) => s.includes("'app' 구성 저장")), `run widget menu (${tm.join(' | ')})`);
  await noLeaks('.context-menu', 'run widget menu', CONFIG_NAMES);
  await clickMenu('구성 편집…');
  await until(`!!document.querySelector('.rc-dialog')`, 'configurations dialog');

  // ---------- Run/Debug Configurations dialog ----------
  const dlg = await js(`({ title: document.querySelector('.dialog-title').textContent,
    labels: [...document.querySelectorAll('.rc-form .field > span')].map(n => n.textContent),
    keep: document.querySelector('.rc-keep')?.textContent, tools: [...document.querySelectorAll('.rc-tool')].map(b => b.title),
    buttons: [...document.querySelectorAll('.dialog-buttons button')].map(b => b.textContent),
    interp: document.querySelector('.rc-form [data-key="interp"] option').textContent })`);
  check(dlg.title === '실행/디버그 구성', `dialog title (${dlg.title})`);
  check(['이름:', '스크립트 경로:', '스크립트 매개변수:', '작업 디렉터리:', '환경 변수:', 'Python 인터프리터:'].every((l) => dlg.labels.includes(l)), `Python configuration labels (${dlg.labels.join(' | ')})`);
  check(hangul(dlg.keep), `temporary configuration toggle (${dlg.keep})`);
  check(dlg.tools.join('|') === '새 구성 추가|구성 제거|구성 복사', `list toolbar tooltips (${dlg.tools.join(' | ')})`);
  check(dlg.buttons.join('|') === '확인|취소', `dialog buttons (${dlg.buttons.join(' | ')})`);
  check(dlg.interp.startsWith('프로젝트 기본값 ('), `interpreter default option (${dlg.interp})`);
  await noLeaks('.dialog', 'Python configuration form');
  await shot('ko-configurations.png');

  await click('.rc-tool[data-tool="add"]');
  // Run configuration types named after products (FastAPI on uvicorn, PyInstaller, Maven / Gradle) keep their names, as
  // PyCharm's Korean UI does.
  await noLeaks('.context-menu', 'Add New Configuration menu', ['FastAPI', 'uvicorn', 'PyInstaller', 'Maven', 'Gradle']);
  await clickMenu('pytest');
  const pyt = await js(`[...document.querySelectorAll('.rc-form .field > span')].map(n => n.textContent)`);
  check(['대상:', '추가 인수:', '작업 디렉터리:', '환경 변수:', 'Python 인터프리터:'].every((l) => pyt.includes(l)), `pytest configuration labels (${pyt.join(' | ')})`);
  check((await js(`document.querySelector('.rc-form [data-key="name"]').value`)) === '이름 없음', 'a new configuration is named 이름 없음');
  await noLeaks('.dialog', 'pytest configuration form');
  await shot('ko-configurations-pytest.png');
  // Remove both to see the empty list and the empty form.
  await click('.rc-tool[data-tool="remove"]');
  await click('.rc-tool[data-tool="remove"]');
  await until(`!!document.querySelector('.rc-none')`, 'empty configuration list');
  await noLeaks('.dialog', 'empty configurations dialog');
  await click('.dialog-buttons .secondary');
  await until(`!document.querySelector('.rc-dialog')`, 'dialog cancelled');
  check(await js(`ide.run.configs().some(c => c.name === 'app')`), 'Cancel keeps the configurations');

  // ---------- Alt+Shift+F10 chooser ----------
  await js(`ide.editor.focus()`);
  await press('Alt+Shift+F10');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'run chooser');
  const choices = await js(`[...document.querySelectorAll('#popupList .popup-item .label')].map(n => n.textContent)`);
  check(choices.includes('현재 파일') && choices.includes('구성 편집…'), `chooser entries (${choices.join(' | ')})`);
  check(hangul(await js(`document.querySelector('#popupIn').placeholder`)), 'chooser placeholder is Korean');
  await noLeaks('#popup', 'run chooser', CONFIG_NAMES);
  await press('Escape');

  // ---------- Test Results ----------
  await openFile(t, 'test_calc.py');
  await until(`ide.editor.getModel().getAllDecorations().filter(d => (d.options.glyphMarginClassName || '').includes('run-gutter-icon')).length >= 6`, 'test gutter icons');
  await clickGutter(21);
  const tg = await menuItems();
  check(tg.some((s) => s.includes("'test_calc.TestDiv.test_div에 대한 pytest' 실행")), `test gutter menu (${tg.join(' | ')})`);
  await noLeaks('.context-menu', 'test gutter menu');
  await closeMenu();
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 1 })`);
  await press('Ctrl+Shift+F10');
  await until(`document.querySelector('.run-tab.active .run-tab-title')?.textContent === 'test_calc.py의 pytest'`, 'Korean test configuration name');
  check(true, 'test configuration is named test_calc.py의 pytest');
  await waitTests('file tests done');
  const st = await testStatus();
  check(st.includes('테스트 실패: 2, 통과: 2, 무시됨: 1 / 총 5개 테스트 – '), `test status line (${st})`);
  const rootRow = await js(`document.querySelector('.run-session:not(.hidden) .tr-row[data-kind="root"] .tr-name').textContent`);
  check(rootRow === '테스트 결과', `results root (${rootRow})`);
  check(await js(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-time')].every(n => /^[\\d.]+(ms|초)$/.test(n.textContent))`), 'durations use ms / 초');
  await noLeaks('.run-tool', 'Test Results view');
  await toolWindowChrome('Run', 'Test Results');
  // A passed test and a skipped test print our own notes.
  await js(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-row')].find(r => r.dataset.id.endsWith('::test_add')).click()`);
  check((await activeOut()).includes('테스트 통과.'), 'passed test note');
  await js(`[...document.querySelectorAll('.run-session:not(.hidden) .tr-row')].find(r => r.dataset.id.endsWith('::test_skipped')).click()`);
  check((await activeOut()).includes('건너뜀: not ready'), 'skip reason note (reason itself untranslated)');
  check(hangul(await js(`document.querySelector('.run-session:not(.hidden) .tr-row').title`)), 'result rows have Korean status tooltips');
  await js(`document.querySelector('.run-session:not(.hidden) .tr-row[data-kind="root"]').click()`);
  check((await activeOut()).includes('종료 코드 1(으)로 완료된 프로세스'), 'test run log ends with the Korean exit line');
  await shot('ko-test-results.png');
  await click('#bottomActions button[title="실패한 테스트 다시 실행"]');
  await sleep(300);
  await waitTests('rerun failed done');
  check((await testStatus()).includes('테스트 실패: 2 / 총 2개 테스트 – '), `Rerun Failed Tests (${await testStatus()})`);

  // ---------- project tree actions ----------
  let tmenu = await treeMenu('test_units.py');
  check(tmenu.some((s) => s.includes("'test_units.py의 pytest' 실행")) && !tmenu.some((s) => s.startsWith('Run ')), `tree menu on a test file (${tmenu.join(' | ')})`);
  await closeMenu();
  tmenu = await treeMenu('scratch.py');
  check(tmenu.some((s) => s.includes("'…' 실행")), `tree menu on a script (${tmenu.join(' | ')})`);
  await closeMenu();

  // ---------- unittest fallback: install hint ----------
  const venv = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-i18n-nopytest-')), 'nopytest');
  execFileSync('py', ['-3', '-m', 'venv', '--without-pip', venv]);
  const exe = path.join(venv, 'Scripts', 'python.exe');
  await js(`(ide.settings.set('interpreters.extra', [${q(exe)}]), ide.reloadInterpreters())`);
  await js(`ide.run.runContext({ type: 'pytest', name: 'units', target: 'test_units.py', interp: ${q(exe)} })`);
  await sleep(300);
  await waitTests('unittest fallback done');
  const hint = await js(`document.querySelector('.run-session:not(.hidden) .tr-hint').textContent`);
  check(hangul(hint) && hint.includes('pip install pytest'), `install hint (${hint})`);
  await js(`document.querySelector('.run-session:not(.hidden) .tr-row[data-kind="root"]').click()`);
  check((await activeOut()).includes('unittest 검색으로 대체합니다'), 'fallback note in the console');
  check((await testStatus()).includes('테스트 실패: 1, 통과: 1, 무시됨: 1 / 총 3개 테스트 – '), `unittest results (${await testStatus()})`);
  await noLeaks('.run-tool', 'Test Results with the install hint');
  await shot('ko-unittest-fallback.png');

  // ---------- Python Console ----------
  await press('Alt+8');
  await until(`ide.toolWindows.get('PythonConsole').isVisible() && ide.pyconsole.isRunning() && document.querySelector('#pyconsoleOut').textContent.includes('Python 3')`, 'console started', 20000);
  check((await js(`document.querySelector('#pyconsoleOut').textContent`)).includes('(Python 콘솔)'), 'console banner line is Korean');
  await until(`document.activeElement?.id === 'pyconsoleIn'`, 'console input focused');
  await type('print("hello")');
  await press('Enter');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('>>> print("hello")\\nhello')`, 'console output');
  await noLeaks(`#bottomBody .tool.active`, 'Python Console window');
  await toolWindowChrome('PythonConsole', 'Python Console');
  check((await js(`ide.toolWindows.get('PythonConsole').tab.textContent`)) === 'Python 콘솔', 'Python Console title');
  await shot('ko-python-console.png');
  await click('#bottomActions button[title="콘솔 중지"]');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('(으)로 완료된 프로세스')`, 'console stopped');
  check(true, 'stopping the console prints the Korean exit line');
  check(hangul(await js(`ide.editor.getAction('pyide.executeInConsole').label`)), 'editor context menu: Execute Selection in Python Console');

  // ---------- action titles (Find Action) ----------
  const acts = await js(`ide.actions.filter(a => ['Run', 'RunClass', 'Stop', 'ChooseRunConfiguration', 'ChooseDebugConfiguration', 'editRunConfigurations', 'Rerun',
    'RunTestAtCaret', 'RerunFailedTests', 'ExecuteInPyConsoleAction', 'RunPythonConsole', 'ActivateRunToolWindow', 'ActivatePythonConsoleToolWindow'].includes(a.id)).map(a => a.id + '=' + a.title)`);
  check(acts.length >= 13 && acts.every((a) => hangul(a)), `action titles are Korean (${acts.join(' | ')})`);

  // ---------- missing translations at runtime ----------
  const missing = (await missingTranslations(t)).filter((s) => mine.has(s));
  check(missing.length === 0, `no tr() string of these plugins lacks a Korean entry at runtime${missing.length ? ` (${missing.join(' | ')})` : ''}`);

  // ---------- Light theme ----------
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await sleep(300);
  // Any surface of ours painted dark, or text painted near-white, is wrong on a light background.
  const darkSpots = (selector) => js(`(() => {
    const lum = (c) => { const m = c.match(/[\\d.]+/g); if (!m) return 1; const [r, g, b, a = 1] = m.map(Number); return a < 0.05 ? null : (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
    const out = [];
    let seen = 0;
    for (const root of document.querySelectorAll(${q(selector)})) {
      for (const n of [root, ...root.querySelectorAll('*')]) {
        // Primary buttons are blue with white text in both themes.
        if (!n.getClientRects().length || n.closest('button.primary')) continue;
        seen++;
        const s = getComputedStyle(n);
        const bg = lum(s.backgroundColor);
        if (bg !== null && bg < 0.5) out.push('bg ' + (n.className || n.tagName) + ' ' + s.backgroundColor);
        if ([...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && lum(s.color) > 0.75) out.push('text ' + (n.className || n.tagName) + ' ' + s.color);
      }
    }
    return seen ? out : ['nothing visible'];
  })()`);
  // Back to the unittest fallback session (the Python Console is the active bottom window now).
  await js(`ide.toolWindows.get('Run').show()`);
  await js(`[...document.querySelectorAll('.run-tab')].find(n => n.querySelector('.run-tab-title').textContent === 'units').click()`);
  await sleep(200);
  let spots = await darkSpots('.run-tool');
  check(spots.length === 0, `Light: Test Results view has no dark surfaces or light text${spots.length ? ` (${spots.slice(0, 8).join(' | ')})` : ''}`);
  const hintStyle = await js(`(() => { const s = getComputedStyle(document.querySelector('.run-session:not(.hidden) .tr-hint')); return s.backgroundColor + ' / ' + s.color; })()`);
  check(hintStyle === 'rgb(255, 246, 222) / rgb(92, 61, 0)', `Light: install hint uses the light warning banner (${hintStyle})`);
  await shot('light-test-results.png');

  await js(`[...document.querySelectorAll('.run-tab')].find(n => n.textContent.includes('test_calc.py의 pytest')).click()`);
  await sleep(200);
  spots = await darkSpots('.run-tool');
  check(spots.length === 0, `Light: test tree has no dark surfaces or light text${spots.length ? ` (${spots.slice(0, 8).join(' | ')})` : ''}`);
  await shot('light-test-tree.png');

  await openFile(t, 'app.py');
  await sleep(400);
  await js(`ide.editor.layout()`);
  await until(`!!document.querySelector('#editor .run-gutter-icon')`, 'light gutter icon', 8000);
  const gutterColor = await js(`(() => { const n = document.querySelector('#editor .run-gutter-icon'); return n ? getComputedStyle(n, '::before').color : null; })()`);
  check(gutterColor === 'rgb(32, 138, 60)', `Light: gutter run icon uses the light green (${gutterColor})`);
  const runBtnColor = await js(`getComputedStyle(document.querySelector('.run-btn')).color`);
  check(runBtnColor === 'rgb(95, 184, 101)', `Light: toolbar Run button stays readable on the dark toolbar (${runBtnColor})`);

  await click('.run-target');
  await clickMenu('구성 편집…');
  await until(`!!document.querySelector('.rc-dialog')`, 'light configurations dialog');
  spots = await darkSpots('.dialog');
  check(spots.length === 0, `Light: configurations dialog has no dark surfaces or light text${spots.length ? ` (${spots.slice(0, 8).join(' | ')})` : ''}`);
  await shot('light-configurations.png');
  await click('.dialog-buttons .secondary');

  await js(`ide.toolWindows.get('PythonConsole').show()`);
  await until(`ide.toolWindows.get('PythonConsole').isVisible() && ide.pyconsole.isRunning()`, 'console restarted', 20000);
  await until(`document.activeElement?.id === 'pyconsoleIn'`, 'light console input');
  await type('for i in range(2):');
  await press('Enter');
  await type('print(i)');
  await press('Enter');
  await press('Enter');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('0\\n1')`, 'light console output');
  await type('1/0');
  await press('Enter');
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('ZeroDivisionError')`, 'light traceback');
  spots = await darkSpots('#bottomBody .tool.active');
  check(spots.length === 0, `Light: Python Console has no dark surfaces or light text${spots.length ? ` (${spots.slice(0, 8).join(' | ')})` : ''}`);
  await shot('light-python-console.png');

  await js(`ide.toolWindows.get('Run').show()`);
  await js(`[...document.querySelectorAll('.run-tab')].find(n => n.textContent.includes('app')).click()`);
  await sleep(200);
  spots = await darkSpots('.run-tool');
  check(spots.length === 0, `Light: Run console has no dark surfaces or light text${spots.length ? ` (${spots.slice(0, 8).join(' | ')})` : ''}`);
  await shot('light-run.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
