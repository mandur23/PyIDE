// Every shortcut the UI shows follows the user's keymap: actions rebound through `keymap.overrides` while the IDE runs
// show their new keys in the editor tab and split menus, the empty editor, toolbar and tool window tooltips, the Git
// gutter menu and tool window actions, project tree actions, the terminal's Claude Code menu, Run/Debug buttons, the
// Find, Find in Files, Bookmarks and Run empty texts, Find Action and Search Everywhere (two strokes as "Ctrl+K, V");
// an action whose shortcut was removed shows none; a context menu shows a second rebinding without a reload; Korean.
// Ports 9160-9161.
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// A committed Git repository, so the Git gutter and tool windows have something to show. Git is isolated from the
// user's own configuration.
const work = mkdtempSync(path.join(tmpdir(), 'pyide-keymap-labels-'));
const gitConfig = path.join(work, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const project = path.join(work, 'project');
cpSync(path.join(HERE, 'fixtures', 'vcs'), project, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'Initial commit');

const OVERRIDES = {
  CloseContent: ['Ctrl+Alt+Shift+W'],
  SplitVertically: ['Ctrl+K V'],
  ReopenClosedTab: [],
  MainMenu: ['Ctrl+Alt+Shift+M'],
  'ChangesView.Revert': ['Ctrl+Alt+Shift+R'],
  VcsShowNextChangeMarker: ['Ctrl+K N'],
  VcsShowPrevChangeMarker: [],
  'Vcs.Push': ['Ctrl+Alt+Shift+P'],
  'Vcs.UpdateProject': [],
  ClaudeCode: ['Ctrl+Alt+Shift+C'],
  ReformatCode: ['Ctrl+Alt+Shift+F'],
  RunClass: [],
  FindInPath: ['Ctrl+Alt+Shift+G'],
  Run: [],
  Debug: ['Ctrl+Alt+Shift+D'],
  StepOver: ['Ctrl+K O'],
  FindUsages: ['Ctrl+Alt+Shift+U'],
  ToggleBookmark: ['Ctrl+Alt+Shift+B'],
};

const t = await launch({ fixture: 'vcs', port: 9160, name: 'keymap-labels', projectDir: project });
const { js, press, check, cdp, sleep } = t;
// Chromium pauses animation frames of an occluded window; a tiny screenshot forces one so Monaco paints its gutter.
const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
async function until(expr, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await frame();
    try { if (await js(expr)) return true; } catch {}
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${label}`);
}
const setOverrides = async (o) => {
  await js(`(ide.settings.set('keymap.overrides', ${S(o)}), true)`);
  await sleep(100);
};
// The hints of the open context menu, {label: hint}.
const menuHints = () => js(`Object.fromEntries([...document.querySelectorAll('.context-menu .menu-item')].map((r) => [r.firstChild.textContent, r.querySelector('.hint-right')?.textContent || '']))`);
const closeMenus = () => js(`(ide.ui.closeMenus(), true)`);
const tabNode = (name) => `[...document.querySelectorAll('.group-tabs .tab')].find((n) => n.textContent.includes(${S(name)}))`;
const treeNode = (name) => `[...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name')?.textContent === ${S(name)})`;
const rightClick = (expr) => js(`(() => { const n = ${expr}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); return true; })()`);
async function tabMenu() {
  await rightClick(tabNode('main.py'));
  await until(`!!document.querySelector('.context-menu')`, 'tab menu');
  const h = await menuHints();
  await closeMenus();
  return h;
}
const title = (sel) => js(`document.querySelector(${S(sel)})?.title`);
const text = (sel) => js(`document.querySelector(${S(sel)})?.textContent`);
const areaButton = (tooltip) => `[...document.querySelectorAll('button')].find((b) => b.dataset.tooltip === ${S(tooltip)})`;

try {
  await openFile(t, 'main.py');
  check((await tabMenu()).Close === 'Ctrl+F4', 'before rebinding, the tab menu shows Close with its default Ctrl+F4');

  await setOverrides(OVERRIDES);

  // ---------- editor tabs and split (core/editors.js) ----------
  let h = await tabMenu();
  check(h.Close === 'Ctrl+Alt+Shift+W', `tab menu: Close shows the new key (${S(h.Close)})`);
  check(h['Split Right'] === 'Ctrl+K, V', `tab menu: Split Right shows the two-stroke key as "Ctrl+K, V" (${S(h['Split Right'])})`);
  check(h['Split Down'] === 'Ctrl+Shift+\\' && h['Open in New Window'] === 'Shift+F4', `tab menu: untouched actions keep their keys (${S(h)})`);
  await js(`(document.querySelector('.group-actions button:last-child').click(), true)`);
  await until(`!!document.querySelector('.context-menu')`, 'editor group menu');
  h = await menuHints();
  await closeMenus();
  check(h['Reopen Closed Tab'] === '', `group menu: Reopen Closed Tab, whose shortcut was removed, shows no stale chord (${S(h['Reopen Closed Tab'])})`);
  check(h['Split Right'] === 'Ctrl+K, V', 'group menu: Split Right shows the new key');
  check(await title('.group-actions button') === 'Split Right (Ctrl+K, V)', `Split Right button tooltip (${await title('.group-actions button')})`);
  check(await text('.group-empty .empty-row[data-action="SplitVertically"] kbd') === 'Ctrl+K, V'
    && await text('.group-empty .empty-row[data-action="GotoFile"] kbd') === 'Ctrl+Shift+N', 'the empty editor lists the current shortcuts');
  // An action without a shortcut has no row (no label beside a blank key); it comes back with its shortcut.
  const emptyRows = () => js(`[...document.querySelector('.group-empty').querySelectorAll('.empty-row[data-action]')].map((r) => ({ id: r.dataset.action, shown: getComputedStyle(r).display !== 'none', keys: r.querySelector('kbd').textContent }))`);
  await setOverrides({ ...OVERRIDES, GotoFile: [] });
  let rows = await emptyRows();
  check(rows.some((r) => r.id === 'GotoFile' && !r.shown) && rows.some((r) => r.id === 'SplitVertically' && r.shown && r.keys === 'Ctrl+K, V')
    && rows.every((r) => !r.shown || r.keys), `the empty editor hides Go to File once it has no shortcut, and no row shows a blank key (${S(rows)})`);
  await setOverrides(OVERRIDES);
  rows = await emptyRows();
  check(rows.some((r) => r.id === 'GotoFile' && r.shown && r.keys === 'Ctrl+Shift+N'), `the Go to File row comes back with its shortcut (${S(rows)})`);

  // A second rebinding shows in the next menu without a reload; removing the shortcut leaves the item without one.
  await setOverrides({ ...OVERRIDES, CloseContent: ['Ctrl+Alt+Shift+Q'] });
  check((await tabMenu()).Close === 'Ctrl+Alt+Shift+Q', 'tab menu follows a second rebinding without a reload');
  await setOverrides({ ...OVERRIDES, CloseContent: [] });
  check((await tabMenu()).Close === '', 'tab menu: Close shows no shortcut once it is removed');
  await setOverrides(OVERRIDES);

  // ---------- toolbar ----------
  check(await title('#mainMenuBtn') === 'Main Menu (Ctrl+Alt+Shift+M)', `main menu button tooltip follows the keymap without a hover (${await title('#mainMenuBtn')})`);
  check(await title('#searchBtn') === 'Search Everywhere (Double Shift)', `Search Everywhere button keeps Double Shift (${await title('#searchBtn')})`);
  check(await title('.run-btn') === 'Run', `Run button: no stale Shift+F10 once Run has no shortcut (${await title('.run-btn')})`);
  check(await title('.stop-btn') === 'Stop (Ctrl+F2)', 'Stop button keeps Ctrl+F2');
  check(await title('#debugBtn') === 'Debug (Ctrl+Alt+Shift+D)', `Debug button tooltip (${await title('#debugBtn')})`);
  await js(`(document.querySelector('#debugBtn').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })), true)`);
  check(await title('#debugBtn') === 'Debug (Ctrl+Alt+Shift+D)', 'hovering keeps the current shortcut');
  check(await title('#dbgStepOver') === 'Step Over (Ctrl+K, O)', `Debug window Step Over tooltip (${await title('#dbgStepOver')})`);
  check(await title('.claude-btn') === 'Claude Code (Ctrl+Alt+Shift+C)', `terminal's Claude Code toolbar button (${await title('.claude-btn')})`);

  // ---------- terminal new-session menu ----------
  await js(`(document.querySelector('.term-pick').click(), true)`);
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((r) => r.firstChild.textContent === 'Claude Code')`, 'new session menu');
  h = await menuHints();
  await closeMenus();
  check(h['Claude Code'] === 'Ctrl+Alt+Shift+C', `terminal new-session menu: Claude Code (${S(h['Claude Code'])})`);

  // ---------- empty tool window texts ----------
  check(await text('.run-empty') === 'Nothing to show.', `Run window empty text names no removed shortcut (${await text('.run-empty')})`);
  check(await text('.lsp-find-head') === 'Use Find Usages (Ctrl+Alt+Shift+U) on a symbol to find its usages', `Find window (${await text('.lsp-find-head')})`);
  check(await text('#snFindHead') === 'Use Find in Files (Ctrl+Alt+Shift+G) to search the project', `Find in Files window (${await text('#snFindHead')})`);
  check(await text('.bm-empty') === 'No bookmarks. Use Toggle Bookmark (Ctrl+Alt+Shift+B) in the editor to add one.', `Bookmarks window (${await text('.bm-empty')})`);

  // ---------- project tree actions (tooling, run, search-nav) ----------
  await until(`!!${treeNode('main.py')}`, 'main.py in the tree');
  await rightClick(treeNode('main.py'));
  await until(`!!document.querySelector('.context-menu')`, 'tree menu');
  h = await menuHints();
  await closeMenus();
  check(h['Reformat Code'] === 'Ctrl+Alt+Shift+F' && h['Optimize Imports'] === 'Ctrl+Alt+O', `tree menu: Reformat Code follows the keymap (${S(h)})`);
  check(h["Run '…'"] === '', `tree menu: Run '…' shows no shortcut once Run Context Configuration has none (${S(h["Run '…'"])})`);
  await rightClick(treeNode('util'));
  await until(`!!document.querySelector('.context-menu')`, 'folder menu');
  h = await menuHints();
  await closeMenus();
  check(h['Find in Files…'] === 'Ctrl+Alt+Shift+G' && h['Replace in Files…'] === 'Ctrl+Shift+R', `tree menu: Find in Files… (${S(h['Find in Files…'])})`);

  // ---------- Git: tool window actions and the gutter menu ----------
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  await until(`!!${areaButton('Rollback…')}`, 'Commit window actions');
  check(await js(`${areaButton('Rollback…')}.title`) === 'Rollback… (Ctrl+Alt+Shift+R)', `Commit window Rollback… tooltip (${await js(`${areaButton('Rollback…')}.title`)})`);
  await js(`(ide.toolWindows.get('Git').show(), true)`);
  await until(`!!${areaButton('Push…')}`, 'Git window actions');
  check(await js(`${areaButton('Push…')}.title`) === 'Push… (Ctrl+Alt+Shift+P)', 'Git window Push… tooltip');
  check(await js(`${areaButton('Update Project…')}.title`) === 'Update Project…', 'Git window Update Project… shows no removed shortcut');
  await js(`(ide.toolWindows.get('Git').hide(), true)`);

  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await t.type('# changed\n');
  await until(`!!document.querySelector('#editor .vcs-added, #editor .vcs-modified')`, 'gutter change marker', 20000);
  const box = await js(`(() => { const r = document.querySelector('#editor .vcs-added, #editor .vcs-modified').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await frame();
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((r) => r.firstChild.textContent === 'Rollback Lines')`, 'gutter change menu');
  h = await menuHints();
  await closeMenus();
  check(h['Rollback Lines'] === 'Ctrl+Alt+Shift+R', `gutter menu: Rollback Lines (${S(h['Rollback Lines'])})`);
  check(h['Next Change'] === 'Ctrl+K, N', `gutter menu: Next Change (${S(h['Next Change'])})`);
  check(h['Previous Change'] === '', `gutter menu: Previous Change shows no removed shortcut (${S(h['Previous Change'])})`);

  // ---------- Find Action (core) and Search Everywhere's Actions tab ----------
  await js(`(ide.runAction('GotoAction'), true)`);
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'Find Action');
  await t.type('Split Right');
  await until(`[...document.querySelectorAll('#popupList .popup-item')].some((r) => r.querySelector('.label')?.textContent === 'Split Right')`, 'Find Action row');
  const fa = await js(`[...document.querySelectorAll('#popupList .popup-item')].find((r) => r.querySelector('.label')?.textContent === 'Split Right').querySelector('.hint-right')?.textContent`);
  check(fa === 'Ctrl+K, V', `Find Action shows a two-stroke key as "Ctrl+K, V" (${S(fa)})`);
  await press('Escape');
  await until(`document.getElementById('popup').classList.contains('hidden')`, 'Find Action closed');

  const seHint = async (query, label) => {
    await js(`(ide.searchEverywhere.open({ tab: 'actions', query: ${S(query)} }), true)`);
    await until(`[...document.querySelectorAll('#seList .se-row')].some((r) => r.querySelector('.se-label')?.textContent === ${S(label)})`, `Search Everywhere row ${label}`);
    const hint = await js(`[...document.querySelectorAll('#seList .se-row')].find((r) => r.querySelector('.se-label')?.textContent === ${S(label)}).querySelector('.se-hint')?.textContent || ''`);
    await press('Escape');
    await until(`!document.getElementById('searchEverywhere')?.offsetParent`, 'Search Everywhere closed');
    return hint;
  };
  check(await seHint('Split Right', 'Split Right') === 'Ctrl+K, V', 'Search Everywhere Actions shows a two-stroke key as "Ctrl+K, V"');
  check(await seHint('Step Over', 'Step Over') === 'Ctrl+K, O', 'Search Everywhere Actions: Step Over');
  check(await seHint('Reopen Closed Tab', 'Reopen Closed Tab') === '', 'Search Everywhere Actions: an action without a shortcut shows none');
} catch (e) {
  check(false, `instance A: ${e.message}`);
  await t.shot('failure.png').catch(() => {});
}

// ======================= instance B: Korean =======================
t.close();
const b = await launch({ fixture: 'keyboard', port: 9161, name: 'keymap-labels-ko', lang: 'ko-KR' });
try {
  await openFile(b, 'main.py');
  await b.js(`(ide.settings.set('keymap.overrides', ${S({ FindInPath: ['Ctrl+Alt+Shift+G'], Run: [], ToggleBookmark: ['Ctrl+K B'] })}), true)`);
  await b.sleep(200);
  const ko = (sel) => b.js(`document.querySelector(${S(sel)})?.textContent`);
  check(await ko('#snFindHead') === '프로젝트를 검색하려면 파일에서 찾기 (Ctrl+Alt+Shift+G)을(를) 사용하세요', `Korean Find in Files text (${await ko('#snFindHead')})`);
  check(await ko('.run-empty') === '표시할 내용이 없습니다.', `Korean Run empty text (${await ko('.run-empty')})`);
  check(await ko('.bm-empty') === '북마크가 없습니다. 에디터에서 북마크 토글 (Ctrl+K, B)을(를) 사용해 추가하세요.', `Korean Bookmarks text (${await ko('.bm-empty')})`);
  check(await b.js(`document.querySelector('#searchBtn').title`) === '어디서나 검색 (Shift 두 번)', `Korean Search Everywhere tooltip (${await b.js(`document.querySelector('#searchBtn').title`)})`);
  const mine = /\{action\}|\{keys\}|\{saves\}|\{dialog\}|explicit saves|Surround With|the Push dialog|Nothing to show|Inline Edit|AI edits with Claude|^Execute$|request$|Show Context Actions/;
  const missing = (await missingTranslations(b)).filter((s) => mine.test(s));
  check(!missing.length, `shortcut texts have Korean translations (${S(missing)})`);
} catch (e) {
  check(false, `instance B: ${e.message}`);
}
b.close();
if (b.consoleErrors.length) check(false, `renderer exceptions in B: ${b.consoleErrors.join(' | ')}`);
for (const r of b.results) t.results.push(r);
t.finish();
