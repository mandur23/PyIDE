// Korean UI and Light theme for the search-nav plugin: every surface is driven in a ko-KR session and checked for
// English leaks, missing translations, and Light theme colors.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = await launch({ fixture: 'search-nav', port: 9443, name: 'i18n-search-nav', lang: 'ko-KR' });
const { js, until, press, type, click, shot, check } = t;
const J = JSON.stringify;

const popupOpen = `!document.querySelector('#popup').classList.contains('hidden')`;
const activeRow = `(document.querySelector('#popupList .popup-item.active')?.textContent || '')`;
const text = (sel) => js(`document.querySelector(${J(sel)})?.textContent ?? null`);
const waitText = (sel, expected, label) => until(`document.querySelector(${J(sel)})?.textContent === ${J(expected)}`, label, 10000)
  .then(() => true, async () => { console.log(`  ${sel} was: ${J(await text(sel))}`); return false; });
const hangul = (s) => typeof s === 'string' && /[가-힣]/.test(s);

// The selector must match something visible, otherwise "no leaks" proves nothing.
async function noLeaks(selector, label) {
  const visible = await js(`[...document.querySelectorAll(${J(selector)})].some((n) => n.getClientRects().length)`);
  const leaks = visible ? await englishLeaks(t, selector) : null;
  check(visible && leaks.length === 0, `${label}: no English UI text${visible ? (leaks.length ? ` (leaks ${J(leaks)})` : '') : ' (nothing visible)'}`);
}
const placeholder = (sel) => js(`document.querySelector(${J(sel)})?.placeholder ?? null`);

// Every literal tr() key in the plugin, so missingTranslations can be narrowed to this plugin.
const source = readFileSync(path.join(APP_DIR, 'renderer/features/search-nav/index.js'), 'utf8');
const myKeys = new Set([...source.matchAll(/tr\((['"])((?:(?!\1).)*)\1/g)].map((m) => m[2]));
for (const m of source.matchAll(/\[('[^']*\{count\}[^']*'(?:,\s*'[^']*')*)\]/g)) for (const k of m[1].match(/'[^']*'/g)) myKeys.add(k.slice(1, -1));
for (const m of source.matchAll(/nt\([^,]+, '([^']*)', '([^']*)'\)/g)) myKeys.add(m[1]).add(m[2]);
myKeys.add('Python interpreter failed');
const ko = {
  ...JSON.parse(readFileSync(path.join(APP_DIR, 'renderer/locales/ko.json'), 'utf8')),
  ...JSON.parse(readFileSync(path.join(APP_DIR, 'renderer/features/search-nav/locales/ko.json'), 'utf8')),
};

try {
  check((await js('i18n.locale')) === 'ko', 'session runs in Korean');
  const noEntry = [...myKeys].filter((k) => !(k in ko));
  check(myKeys.size > 60 && noEntry.length === 0, `every tr() string of search-nav (${myKeys.size}) has a Korean entry${noEntry.length ? ` (missing ${J(noEntry)})` : ''}`);

  // ---- action titles (Find Action, keymap) and tool window chrome ----
  const ids = ['FindInPath', 'ReplaceInPath', 'RecentFiles', 'RecentLocations', 'Back', 'Forward', 'JumpToLastChange',
    'FileStructurePopup', 'GotoClass', 'GotoSymbol', 'ActivateFindToolWindow', 'ActivateTODOToolWindow', 'ActivateStructureToolWindow'];
  const titles = await js(`${J(ids)}.map((id) => ide.actions.find((a) => a.id === id)?.title)`);
  check(titles.every(hangul), `action titles are Korean (${J(titles)})`);
  check(titles[0] === '파일에서 찾기…' && titles[1] === '파일에서 바꾸기…' && titles[2] === '최근 파일' && titles[3] === '최근 위치'
    && titles[4] === '뒤로' && titles[5] === '앞으로' && titles[6] === '마지막 편집 위치' && titles[7] === '파일 구조'
    && titles[8] === '클래스로 이동…' && titles[9] === '심볼로 이동…', 'PyCharm Korean terms for actions');
  const tws = await js(`['FindInFiles', 'Structure', 'TODO'].map((id) => { const tw = ide.toolWindows.get(id); return [tw.title, tw.button.title, tw.tab?.textContent ?? null]; })`);
  check(tws[0][0] === '파일에서 찾기' && tws[0][2] === '파일에서 찾기' && tws[1][0] === '구조' && tws[1][1] === '구조 (Alt+7)' && tws[2][0] === 'TODO',
    `tool window titles, stripe tooltips and tabs (${J(tws)})`);

  // ---- Find in Files tool window before any search ----
  await js(`ide.runAction('ActivateFindToolWindow')`);
  check(await waitText('#snFindHead', '프로젝트를 검색하려면 파일에서 찾기 (Ctrl+Shift+F)을(를) 사용하세요', 'find head'), 'empty Find window explains Ctrl+Shift+F');
  await noLeaks('#snFindHead, #bottomActions', 'empty Find window and its toolbar');

  // ---- TODO ----
  await js(`ide.runAction('ActivateTODOToolWindow')`);
  check(await waitText('#snTodoHead', '파일 2개에서 TODO 항목 3개를 찾았습니다', 'todo head'), 'TODO header counts in Korean');
  check((await js(`[...document.querySelectorAll('#snTodo .sn-count')].map((n) => n.textContent).sort().join()`)) === '항목 1개,항목 2개', 'TODO per-file counts');
  await noLeaks('#snTodoHead, #snTodo, #bottomActions', 'TODO window');
  check(await js(`document.querySelector('#snTodo .sn-todo-text').hasAttribute('data-user-text')`), 'TODO comment text is user data');
  await shot('todo-ko.png');

  // ---- Structure ----
  await openFile(t, 'main.py');
  await press('Alt+7');
  await until(`document.querySelectorAll('#snStructure .sn-node[data-kind]').length >= 10`, 'structure rows');
  check((await text('#sideTitle')) === '구조', 'Structure tool window is titled 구조');
  await noLeaks('#sidePanel .panel-header, #snStructure', 'Structure tool window');
  await shot('structure-ko.png');
  await openFile(t, 'notes.txt');
  check(await waitText('#snStructure', '이 파일에는 구조를 사용할 수 없습니다', 'no structure'), 'Structure for a non-Python file');
  await noLeaks('#snStructure', 'Structure empty state');
  await openFile(t, 'main.py');
  const original = await js(`ide.editor.getModel().getValue()`);
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 9, column: 1 })`);
  await type('def broken(:\n');
  await until(`(document.querySelector('#snStructure .sn-err')?.textContent || '').startsWith('구문 오류: ')`, 'syntax error', 10000)
    .then(() => check(true, 'syntax error reported in Korean'), async () => check(false, `syntax error reported in Korean (${J(await text('#snStructure .sn-err'))})`));
  await noLeaks('#snStructure', 'Structure with a syntax error');
  await js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: ${J(original)} }], () => null); })()`);
  await press('Ctrl+S');
  await until(`!document.querySelector('#snStructure .sn-err')`, 'syntax error gone', 10000);

  // ---- File Structure popup ----
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 30, column: 5 })`);
  await press('Ctrl+F12');
  await until(`!!document.querySelector('#snFileStructure .sn-fs-row.active')`, 'file structure popup');
  check((await placeholder('#snFileStructure input')) === '입력하여 필터링', 'File Structure filter placeholder');
  await noLeaks('#snFileStructure', 'File Structure popup');
  await shot('file-structure-ko.png');
  await type('zzzq');
  check(await waitText('#snFileStructure .sn-fs-list', '검색 결과 없음', 'nothing found'), 'File Structure empty state');
  await press('Escape');

  // ---- Find in Files dialog ----
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+F');
  await until(`document.activeElement?.id === 'snQuery'`, 'find dialog');
  await type('greet');
  check(await waitText('#snStatus', '파일 2개에서 일치 항목 8개', 'status'), 'live preview count in Korean');
  check((await text('.dialog .dialog-title')) === '파일에서 찾기', 'dialog title 파일에서 찾기');
  const toggles = await js(`[...document.querySelectorAll('.sn-toggle')].map((b) => b.title)`);
  check(J(toggles) === J(['대/소문자 구분 (Alt+C)', '단어 (Alt+W)', '정규식 (Alt+X)']), `option tooltips (${J(toggles)})`);
  check((await text('.sn-mask-lbl')) === '파일 마스크:' && (await text('.sn-scope')) === '프로젝트에서', 'file mask label and scope');
  check((await placeholder('#snQuery')) === '검색할 텍스트', 'query placeholder');
  check((await js(`[...document.querySelectorAll('.dialog button.primary, .dialog button.secondary')].map((b) => b.textContent).join()`)).includes('찾기 창에서 열기'), 'Open in Find Window button');
  await noLeaks('.dialog', 'Find in Files dialog');
  await shot('find-dialog-ko.png');
  await press('Alt+X');
  await js(`document.querySelector('#snQuery').select()`);
  await type('gre(');
  await until(`(document.querySelector('#snStatus')?.textContent || '').startsWith('잘못된 정규식: ')`, 'regex error', 8000)
    .then(() => check(true, 'invalid regex reported in Korean'), async () => check(false, `invalid regex reported in Korean (${J(await text('#snStatus'))})`));
  await press('Alt+X');
  await js(`document.querySelector('#snQuery').select()`);
  await type('greet');
  await waitText('#snStatus', '파일 2개에서 일치 항목 8개', 'status again');
  await press('Enter');
  await until(`document.querySelectorAll('#snFindResults .sn-match').length > 0`, 'find results');
  const head = await text('#snFindHead');
  check(head.includes("찾기: 'greet'") && head.includes('파일 2개에서 일치 항목 8개 · 프로젝트'), `Find window header (${J(head)})`);
  check((await js(`[...document.querySelectorAll('#snFindResults .sn-count')].map((n) => n.textContent).join()`)).split(',').every((s) => /^일치 항목 \d+개$/.test(s)), 'per-file match counts');
  await noLeaks('#snFindHead, #snFindResults, #bottomActions', 'Find in Files results');
  await shot('find-window-ko.png');

  // ---- Find in a directory from the project tree context menu ----
  await press('Alt+1');
  await until(`ide.toolWindows.get('Project').isVisible()`, 'project tree');
  const box = await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name')?.textContent === 'pkg'); const r = n.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await until(`!!document.querySelector('.context-menu')`, 'tree menu');
  const menu = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map((n) => n.textContent)`);
  check(menu.some((s) => s.startsWith('파일에서 찾기…')) && menu.some((s) => s.startsWith('파일에서 바꾸기…')) && !menu.some((s) => s.includes('in Files')), `tree menu items (${J(menu)})`);
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.textContent.startsWith('파일에서 찾기…')).setAttribute('data-vt', '1')`);
  await click('[data-vt="1"]');
  check(await waitText('.sn-scope', '디렉터리: pkg', 'dir scope'), 'directory scope in Korean');
  await press('Escape');

  // ---- Replace in Files ----
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+R');
  await until(`!!document.querySelector('#snReplace') && document.activeElement?.id === 'snQuery'`, 'replace dialog');
  await js(`document.querySelector('#snQuery').select()`);
  await type('compute');
  await click('#snReplace');
  await type('calculate');
  await until(`/^파일 \\d+개에서 일치 항목 \\d+개$/.test(document.querySelector('#snStatus')?.textContent)`, 'replace preview');
  check((await text('.dialog .dialog-title')) === '파일에서 바꾸기' && (await placeholder('#snReplace')) === '바꿀 텍스트', 'Replace in Files title and placeholder');
  const buttons = await js(`[...document.querySelectorAll('.dialog button.primary, .dialog button.secondary')].map((b) => b.textContent)`);
  check(buttons.includes('모두 바꾸기') && buttons.includes('찾기 창에서 열기'), `Replace dialog buttons (${J(buttons)})`);
  await noLeaks('.dialog', 'Replace in Files dialog');
  await shot('replace-dialog-ko.png');
  await press('Enter');
  await until(`!!document.querySelector('#snReplaceAll')`, 'Replace All button');
  check((await text('#snReplaceAll')) === '모두 바꾸기', 'Replace All button in the Find window');
  check((await text('#snFindHead .sn-title')) === "바꾸기: 'compute' → 'calculate'", 'replace header');
  await noLeaks('#snFindHead, #snFindResults', 'Replace results');
  await click('#snReplaceAll');
  await until(`!!document.querySelector('#snFindHead .sn-note')`, 'replace summary');
  check(/^파일 \d+개에서 \d+개 항목을 바꿨습니다$/.test(await text('#snFindHead .sn-note')), `replace summary in Korean (${J(await text('#snFindHead .sn-note'))})`);
  check(await waitText('#snFindResults', '일치 항목이 없습니다', 'no matches'), 'no matches left');
  await noLeaks('#snFindHead, #snFindResults', 'Find window after Replace All');

  // ---- Go to Class / Go to Symbol ----
  await js(`ide.editor.focus()`);
  await press('Ctrl+N');
  await until(popupOpen, 'goto class');
  check((await placeholder('#popupIn')) === '클래스 이름 입력', 'Go to Class placeholder');
  await type('UM');
  await until(`${activeRow}.includes('UserModel')`, 'UserModel', 15000);
  check((await text('#popupList .popup-item.active .hint-right')) === '클래스', 'class kind in Korean');
  await noLeaks('#popupList .hint-right', 'Go to Class kinds');
  await press('Escape');
  await js(`ide.editor.focus()`);
  await press('Ctrl+Alt+Shift+N');
  await until(popupOpen, 'goto symbol');
  check((await placeholder('#popupIn')) === '심볼 이름 입력', 'Go to Symbol placeholder');
  await type('greet');
  await until(`document.querySelector('#popupList .popup-item.active .sn-icon.k-method') && ${activeRow}.startsWith('mgreet')`, 'greet');
  const kinds = await js(`[...new Set([...document.querySelectorAll('#popupList .hint-right')].map((n) => n.textContent))]`);
  check(kinds.includes('메서드') && kinds.every(hangul), `symbol kinds in Korean (${J(kinds)})`);
  await noLeaks('#popupList .hint-right', 'Go to Symbol kinds');
  await shot('goto-symbol-ko.png');
  await press('Escape');

  // ---- Recent Files / Recent Locations ----
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 3, column: 1 })`);
  await type('# edited\n');
  await js(`ide.editor.setPosition({ lineNumber: 40, column: 1 })`);
  await press('Ctrl+E');
  await until(popupOpen, 'recent files');
  check((await placeholder('#popupIn')) === '최근 파일', 'Recent Files placeholder');
  await shot('recent-files-ko.png');
  await press('Escape');
  await press('Ctrl+Shift+E');
  await until(popupOpen, 'recent locations');
  check((await placeholder('#popupIn')) === '최근 위치', 'Recent Locations placeholder');
  check((await js(`[...document.querySelectorAll('#popupList .hint-right')].map((n) => n.textContent)`)).includes('변경됨'), 'edited location marked 변경됨');
  await noLeaks('#popupList .hint-right', 'Recent Locations');
  await press('Escape');

  // ---- missing translations ----
  const missing = await missingTranslations(t);
  const mine = missing.filter((k) => myKeys.has(k));
  check(mine.length === 0, `no search-nav string without a Korean entry${mine.length ? ` (${J(mine)})` : ''}`);
  const others = missing.filter((k) => !myKeys.has(k));
  if (others.length) console.log(`  (other plugins' missing strings, not checked here: ${J(others)})`);

  // ---- Light theme ----
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+F');
  await until(`document.activeElement?.id === 'snQuery'`, 'find dialog (light)');
  await js(`document.querySelector('#snQuery').select()`);
  await type('greet');
  await waitText('#snStatus', '파일 2개에서 일치 항목 8개', 'light status');
  await until(`!!document.querySelector('#snPreview .sn-hit')`, 'preview hits');
  await shot('light-find-dialog.png');
  await press('Enter');
  await until(`document.querySelectorAll('#snFindResults .sn-match .sn-hit').length > 0`, 'light results');
  const hit = await js(`(() => { const s = getComputedStyle(document.querySelector('#snFindResults .sn-hit')); return [s.backgroundColor, s.color]; })()`);
  check(hit[0] === 'rgb(246, 233, 160)' && hit[1] === 'rgb(8, 8, 8)', `Light search highlight is light yellow with dark text (${J(hit)})`);
  await shot('light-find-window.png');
  await press('Alt+7');
  if (!(await js(`ide.toolWindows.get('Structure').isVisible()`))) await press('Alt+7');
  await until(`ide.toolWindows.get('Structure').isVisible() && document.querySelectorAll('#snStructure .sn-node[data-kind]').length >= 10`, 'light structure');
  const icon = await js(`(() => { const s = getComputedStyle(document.querySelector('#snStructure .sn-icon.k-class')); return [s.backgroundColor, s.color]; })()`);
  check(icon[0] === 'rgb(53, 116, 240)' && icon[1] === 'rgb(255, 255, 255)', `Light class icon (${J(icon)})`);
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 21, column: 9 })`);
  await press('Ctrl+F12');
  await until(`!!document.querySelector('#snFileStructure .sn-fs-row.active')`, 'light file structure');
  const fs = await js(`(() => { const s = getComputedStyle(document.querySelector('#snFileStructure')); return [s.backgroundColor, s.boxShadow]; })()`);
  check(fs[0] === 'rgb(255, 255, 255)' && !fs[1].includes('0.6'), `Light File Structure popup is white with a soft shadow (${J(fs)})`);
  await shot('light-structure.png');
  await press('Escape');
  await js(`ide.runAction('ActivateTODOToolWindow')`);
  await until(`!!document.querySelector('#snTodo .sn-todo-text')`, 'light todo');
  check((await js(`getComputedStyle(document.querySelector('#snTodo .sn-todo-text')).color`)) === 'rgb(0, 141, 222)', 'Light TODO text uses PyCharm Light blue');
  await shot('light-todo.png');
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+E');
  await until(popupOpen, 'light recent locations');
  await shot('light-recent-locations.png');
  await press('Escape');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
