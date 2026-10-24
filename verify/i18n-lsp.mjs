// Korean UI of the lsp, problems and terminal plugins, plus their Light theme colors.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = ['lsp', 'problems', 'terminal'];

// Every literal passed to tr() in these plugins, and the Korean dictionary they can use (core + their own).
const source = (p) => readFileSync(path.join(APP_DIR, 'renderer', 'features', p, 'index.js'), 'utf8');
const ownStrings = new Set(PLUGINS.flatMap((p) => [...source(p).matchAll(/\btr\((['"])((?:(?!\1).)*)\1/g)].map((m) => m[2])));
const json = (...parts) => JSON.parse(readFileSync(path.join(APP_DIR, ...parts), 'utf8'));
const ko = Object.assign(json('renderer', 'locales', 'ko.json'), ...PLUGINS.map((p) => json('renderer', 'features', p, 'locales', 'ko.json')));

const t = await launch({ fixture: 'lsp', port: 9441, name: 'i18n-lsp', lang: 'ko-KR' });
const { js, until, press, type, check, shot, cdp, sleep } = t;

const caret = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), ide.editor.revealPositionInCenter({ lineNumber: ${line}, column: ${col} }), true)`);
const shown = `n => n.getClientRects().length > 0 && n.getBoundingClientRect().height > 0 && getComputedStyle(n).visibility !== 'hidden'`;
const visible = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].some(${shown})`;
const textOf = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(${shown}).map(n => n.textContent).join(' | ')`);
const noLeaks = async (selector, label) => {
  const leaks = await englishLeaks(t, selector);
  check(leaks.length === 0, `${label}: no English UI text${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
};
const overlayMessage = '.monaco-editor-overlaymessage';

try {
  check(await js(`i18n.locale`) === 'ko', 'session language is Korean');
  const untranslated = [...ownStrings].filter((s) => !(s in ko));
  check(ownStrings.size > 40 && untranslated.length === 0, `every tr() string of ${PLUGINS.join('/')} has a Korean entry (${ownStrings.size} strings)${untranslated.length ? ` missing ${JSON.stringify(untranslated)}` : ''}`);

  // ---- status bar item ----
  await until(`document.querySelector('#lspStatus')?.dataset.state === 'ready'`, 'Pyright ready', 30000);
  check(await textOf('#lspStatus') === 'Pyright: 준비됨', `status item reads "Pyright: 준비됨" (${await textOf('#lspStatus')})`);
  const statusTitle = await js(`document.querySelector('#lspStatus').title`);
  check(/^Pyright 준비됨.*클릭하면 다시 시작합니다\.$/.test(statusTitle), `status tooltip is Korean (${statusTitle})`);
  await noLeaks('#lspStatus', 'status item');

  // ---- Problems tool window ----
  await openFile(t, 'errors.py');
  await until(`ide.problems.all().filter(p => p.source === 'pyright' && p.path.endsWith('errors.py')).length >= 3`, 'pyright diagnostics', 30000);
  await caret(1, 1);
  await press('Alt+6');
  await until(`ide.toolWindows.get('Problems').isVisible() && document.querySelectorAll('#problemList .problem').length >= 3`, 'Problems window');
  check(await js(`ide.toolWindows.get('Problems').tab.textContent.startsWith('문제')`), 'Problems tool window tab is "문제"');
  check(await js(`[...document.querySelectorAll('#problemList .sev')].every(s => ['오류', '경고', '정보'].includes(s.title))`), 'severity icons have Korean tooltips');
  // Pyright runs in the UI language (VSCODE_NLS_CONFIG), as PyCharm's inspections do; verify/lsp.mjs checks English.
  const korean = await js(`[...document.querySelectorAll('#problemList .problem')].map(r => r.textContent).join(' | ')`);
  check(korean.includes('"undefined_name"이(가) 정의되지 않았습니다'), `Pyright's messages are Korean (${korean})`);
  await noLeaks('#problemList', 'Problems list');
  writeFileSync(path.join(t.project, 'paren.py'), 'total = sum((1, 2)\n');
  await openFile(t, 'paren.py');
  const parenMsgs = `ide.problems.all().filter(p => p.source === 'pyright' && p.path.endsWith('paren.py')).map(p => p.msg).join(' | ')`;
  await until(`(${parenMsgs}).length > 0`, 'pyright diagnostics for paren.py', 30000).catch(() => {});
  check((await js(parenMsgs)).includes('"("가 닫혀 있지 않음'), `an unclosed parenthesis is reported in Korean (${await js(parenMsgs)})`);
  await openFile(t, 'errors.py');
  await shot('problems.png');

  // ---- F2 and the "no problems" hint ----
  await caret(1, 1);
  await press('F2');
  await until(visible('.monaco-hover'), 'hover after F2');
  check((await js(`ide.editor.getPosition().lineNumber`)) === 11, 'F2 jumps to the first error');
  await noLeaks('.monaco-hover .hover-row.status-bar', 'problem hover actions');
  await press('Escape');

  // ---- Alt+Enter ----
  await caret(13, 11);
  await press('Alt+Enter');
  await until(visible('.action-widget .monaco-list-row.action'), 'context actions');
  const fixes = await js(`[...document.querySelectorAll('.action-widget .monaco-list-row.action')].map(r => r.textContent)`);
  check(fixes.some((f) => f.includes("'os' import 추가")), `Alt+Enter offers "'os' import 추가" (${fixes.join(', ')})`);
  check(fixes.some((f) => f.includes("문에 대해 'reportUndefinedVariable' 억제")), 'Alt+Enter offers the Korean suppression fix');
  await noLeaks('.action-widget', 'Alt+Enter menu');
  await shot('context-actions.png');
  await press('Escape');

  // ---- hints in the editor ----
  // Escape closes the Alt+Enter menu asynchronously; a shortcut sent before that reaches the menu, not the editor.
  await until(`!document.querySelector('.action-widget')?.offsetParent`, 'Alt+Enter menu closed');
  await caret(2, 1);
  await until('ide.editor.hasTextFocus()', 'editor focused');
  await press('Ctrl+B');
  await until(visible(overlayMessage), 'Ctrl+B hint', 30000);
  check(await textOf(overlayMessage) === '이동할 선언을 찾을 수 없습니다', `Ctrl+B on nothing says so in Korean (${await textOf(overlayMessage)})`);
  await press('Escape');
  await caret(2, 1);
  await press('Ctrl+Alt+B');
  await until(visible(overlayMessage), 'Ctrl+Alt+B hint', 30000);
  check(await textOf(overlayMessage) === '이동할 타입 선언을 찾을 수 없습니다', 'Ctrl+Alt+B on nothing says so in Korean');
  await press('Escape');
  await caret(11, 2);
  await press('Alt+F7');
  await until(visible(overlayMessage), 'no usages hint', 30000);
  check(/^프로젝트 파일에서 '.*'의 사용 위치를 찾을 수 없습니다$/.test(await textOf(overlayMessage)), `Alt+F7 without usages says so in Korean (${await textOf(overlayMessage)})`);
  await press('Escape');

  // ---- Ctrl+Q ----
  await openFile(t, 'app.py');
  await until(`ide.lsp.status() === 'ready'`, 'ready');
  await caret(6, 25);
  // Monaco sometimes closes a hover that opens while the LSP is still updating highlights; a user just presses again.
  const quickDoc = `[...document.querySelectorAll('.monaco-hover')].some(h => h.offsetParent && /def greet/.test(h.textContent))`;
  await press('Ctrl+Q');
  if (!(await until(quickDoc, 'quick documentation', 5000).catch(() => false))) {
    await press('Ctrl+Q');
    await until(quickDoc, 'quick documentation');
  }
  await noLeaks('.monaco-hover .hover-row.status-bar', 'quick documentation chrome');
  await shot('quick-doc.png');
  await press('Escape');

  // ---- Find tool window ----
  const findText = async () => js(`ide.toolWindows.get('FindUsages').container.textContent`);
  check((await findText()).includes('심볼에서 사용 위치 찾기 (Alt+F7)을(를) 사용하면 사용 위치를 찾습니다'), 'Find window empty state is Korean');
  await caret(8, 14);
  await press('Alt+F7');
  await until(`document.querySelectorAll('#lspFindList .lsp-find-row').length >= 3`, 'usages of Greeter');
  const head = await textOf('.lsp-find-head');
  check(/^Greeter의 사용 위치\s+파일 \d+개에서 사용 위치 \d+개$/.test(head), `Find header is Korean (${head})`);
  check(await js(`[...document.querySelectorAll('#lspFindList .lsp-find-file')].every(r => /사용 위치 \\d+개$/.test(r.textContent))`), 'per-file usage counts are Korean');
  check(await js(`ide.toolWindows.get('FindUsages').tab.textContent.startsWith('찾기')`), 'Find tool window tab is "찾기"');
  await noLeaks('.lsp-find-head, #lspFindList', 'Find tool window');
  await shot('find-usages.png');

  // ---- rename box ----
  await caret(6, 25);
  await press('Shift+F6');
  await until(`${visible('.rename-box input')} && document.activeElement?.closest('.rename-box')`, 'rename box');
  await noLeaks('.rename-box', 'inline rename box');
  await shot('rename.png');
  await press('Escape');
  await until(`!(${visible('.rename-box input')})`, 'rename box closed');
  // A keyword cannot be renamed; Monaco shows the reason next to the caret.
  await caret(4, 2);
  await press('Shift+F6');
  await until(visible(overlayMessage), 'rename rejection', 30000);
  check(await textOf(overlayMessage) === '이 요소는 이름을 변경할 수 없습니다', `rename on a keyword is refused in Korean (${await textOf(overlayMessage)})`);
  await press('Escape');

  // ---- editor context menu (Monaco's NLS bundle) ----
  await caret(6, 25);
  const pos = await js(`(() => { const v = ide.editor.getScrolledVisiblePosition({ lineNumber: 6, column: 25 }); const r = ide.editor.getDomNode().getBoundingClientRect(); return { x: r.left + v.left + 2, y: r.top + v.top + v.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'right', clickCount: 1 });
  // Monaco renders its context menu inside a shadow root, out of reach of englishLeaks().
  const menuLabels = `[...document.querySelectorAll('.shadow-root-host')].flatMap(h => [...(h.shadowRoot?.querySelectorAll('.action-label') || [])]).map(n => n.textContent.trim()).filter(Boolean)`;
  await until(`${menuLabels}.length > 3`, 'editor context menu');
  const menu = await js(menuLabels);
  check(menu.some((l) => /정의로 이동/.test(l)) && menu.every((l) => /[가-힣]/.test(l)), `editor context menu is Korean (${menu.join(', ')})`);
  await shot('context-menu.png');
  await press('Escape');

  // ---- actions (Find Action) ----
  const titles = await js(`Object.fromEntries(ide.actions.filter(a => ['GotoDeclaration', 'GotoTypeDeclaration', 'FindUsages', 'RenameElement', 'QuickJavaDoc', 'ParameterInfo', 'ShowIntentionActions', 'GotoNextError', 'GotoPreviousError', 'Pyright.Restart', 'ActivateProblemsToolWindow', 'ActivateTerminalToolWindow'].includes(a.id)).map(a => [a.id, a.title]))`);
  check(Object.keys(titles).length === 12 && Object.values(titles).every((s) => /[가-힣]/.test(s)), `action titles are Korean (${Object.values(titles).join(', ')})`);
  check(titles.FindUsages === '사용 위치 찾기' && titles.QuickJavaDoc === '빠른 문서' && titles.ShowIntentionActions === '컨텍스트 액션 표시' && titles.RenameElement === '이름 변경…', 'PyCharm terminology for the core actions');
  await press('Ctrl+Shift+A');
  await until(visible('#popup'), 'Find Action popup');
  await type('Pyright');
  await until(`/Pyright 언어 서버 다시 시작/.test(document.querySelector('#popup').textContent)`, 'restart action listed');
  await noLeaks('#popup', 'Find Action popup for Pyright');
  await press('Escape');

  // ---- terminal ----
  await press('Alt+F12');
  await until(`ide.toolWindows.get('Terminal').isVisible()`, 'terminal');
  check(await js(`ide.toolWindows.get('Terminal').tab.textContent.startsWith('터미널')`), 'Terminal tool window tab is "터미널"');
  check(await js(`[...document.querySelectorAll('#bottomActions [title]')].map(b => b.title).includes('버퍼 지우기')`), 'terminal Clear Buffer tooltip is "버퍼 지우기"');
  await until(`/PS .*>/.test(ide.terminal.text())`, 'PowerShell prompt', 20000);
  await type('echo 안녕');
  await press('Enter');
  await until(`ide.terminal.text().includes('안녕\\n')`, 'Korean echoed by the real terminal');
  check(true, 'Korean text round-trips through the terminal');
  await noLeaks('#bottom .tool.active, #bottomActions, .bottom-tab-list', 'Terminal tool window and bottom tabs');
  await noLeaks('#stripe', 'tool window stripe');
  await shot('terminal.png');

  // ---- restart from the status bar ----
  await js(`(window.__lspStates = [], new MutationObserver(() => __lspStates.push(document.querySelector('#lspStatus').textContent)).observe(document.querySelector('#lspStatus'), { childList: true, characterData: true, subtree: true }), true)`);
  await t.click('#lspStatus');
  await until(`document.querySelector('#lspStatus').dataset.state === 'ready'`, 'ready after restart', 30000);
  check(await js(`__lspStates.includes('Pyright: 시작 중')`), 'status shows "Pyright: 시작 중" while restarting');

  // ---- nothing of ours left untranslated ----
  const missing = await missingTranslations(t);
  const ours = missing.filter((s) => ownStrings.has(s));
  check(ours.length === 0, `no missing translations from ${PLUGINS.join('/')}${ours.length ? ` ${JSON.stringify(ours)}` : ''}`);
  await shot('korean.png');

  // ---- Light theme ----
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await openFile(t, 'app.py');
  await caret(8, 14);
  await press('Alt+F7');
  await until(`ide.toolWindows.get('FindUsages').isVisible() && document.querySelectorAll('#lspFindList .lsp-find-row').length >= 1`, 'usages in light');
  const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  const colors = await js(`(() => { const s = (q, p) => getComputedStyle(document.querySelector(q))[p]; return { hit: s('#lspFindList .hit', 'backgroundColor'), code: s('#lspFindList .code', 'color'), panel: s('#bottom', 'backgroundColor') }; })()`);
  check(lum(colors.hit) > 0.7 && lum(colors.code) < 0.3, `usage highlight is light with dark text in Light (${JSON.stringify(colors)})`);
  await shot('light-find.png');
  await press('Alt+6');
  await until(`ide.toolWindows.get('Problems').isVisible()`, 'problems in light');
  await shot('light-problems.png');
  await press('Alt+F12');
  await until(`ide.toolWindows.get('Terminal').isVisible()`, 'terminal in light');
  await until(`getComputedStyle(document.querySelector('.term-session:not(.hidden) .xterm-viewport')).backgroundColor !== ''`, 'terminal painted');
  const termBg = await js(`getComputedStyle(document.querySelector('.term-host')).backgroundColor`);
  check(lum(termBg) > 0.8, `terminal background follows the Light theme (${termBg})`);
  await shot('light-terminal.png');
  await js(`ide.settings.set('appearance.theme', 'dark')`);
} catch (err) {
  t.check(false, err.message);
  await shot('failure.png');
}
t.finish();
