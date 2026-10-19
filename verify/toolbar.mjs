// Main toolbar (PyCharm New UI): main menu with submenus and keys, project widget, run widget, search, settings
// gear, status-bar interpreter widget, Close Project and the welcome screen, in English and Korean.
import { launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const menuLabels = (t, sel) => t.js(`[...document.querySelectorAll('${sel} .menu-item')].map(n => n.querySelector('.menu-label').textContent)`);
const hover = async (t, expr) => {
  const p = await t.js(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await sleep(250);
};
const rowByLabel = (sel, label) => `[...document.querySelectorAll('${sel} .menu-item')].find(n => n.querySelector('.menu-label').textContent === ${JSON.stringify(label)})`;

let a;
try {
  a = await launch({ fixture: 'core', port: 9540, name: 'toolbar' });
  await openFile(a, 'hello.py');

  // ---------- layout ----------
  const layout = await a.js(`(() => {
    const left = [...document.querySelectorAll('#toolbarLeft > *')].filter(n => n.offsetParent).map(n => n.id || n.className);
    const right = [...document.querySelectorAll('#toolbarRight > *')].filter(n => n.offsetParent).map(n => n.id || n.className);
    return { left, right, run: [...document.querySelectorAll('#runWidget > *')].map(n => n.className.split(' ').pop()) };
  })()`);
  check(layout.left[0] === 'mainMenuBtn' && layout.left[1] === 'projectWidget', `left: main menu, then project widget (${layout.left.join(', ')})`);
  check(['run-target', 'run-btn', 'dbg-tb-btn', 'stop-btn'].every((c) => layout.run.includes(c)), `run widget holds configuration, Run, Debug, Stop (${layout.run.join(', ')})`);
  check(layout.right.indexOf('runWidget') < layout.right.indexOf('searchBtn') && layout.right.at(-1).includes('settings-gear'), `right: run widget … search, settings last (${layout.right.join(', ')})`);
  check(!(await a.js(`!!document.querySelector('#toolbar select')`)) && /Python/.test(await a.js(`document.querySelector('#statusInterpLabel').textContent`)), 'interpreter moved from the toolbar to the status bar');
  check(await a.js(`document.querySelector('#projectWidget .project-avatar').textContent === 'PR' && document.querySelector('.project-widget-name').textContent === 'project'`), 'project widget shows an avatar and the project name');
  check(await a.js(`['#mainMenuBtn', '#searchBtn', '.run-btn', '.stop-btn', '.dbg-tb-btn', '.settings-gear'].every(s => !!document.querySelector(s + ' svg'))`), 'toolbar buttons use PyCharm SVG icons');

  // ---------- main menu ----------
  await a.click('#mainMenuBtn');
  await a.until(`!!document.querySelector('#mainMenu')`, 'main menu');
  check((await menuLabels(a, '#mainMenu')).join('|') === 'File|Edit|View|Navigate|Code|Refactor|Run|Tools|Git|Window|Help', 'main menu lists File … Help');
  await hover(a, rowByLabel('#mainMenu', 'File'));
  await a.until(`document.querySelectorAll('.context-menu').length === 2`, 'File submenu');
  const file = await menuLabels(a, '.context-menu[data-level="1"]');
  check(['New Project…', 'Open Folder…', 'Get from VCS…', 'Recent Projects', 'Close Project', 'Save All', 'Settings…', 'Exit'].every((x) => file.includes(x)), `File menu (${file.join(', ')})`);
  check(await a.js(`${rowByLabel('.context-menu[data-level="1"]', 'Save All')}.querySelector('.hint-right').textContent === 'Ctrl+S'`), 'menu items show their shortcuts');
  // Keyboard: Esc closes the submenu, Down/Right/Enter navigate.
  await a.press('Escape');
  check(await a.js(`document.querySelectorAll('.context-menu').length === 1`), 'Esc closes just the submenu');
  await a.press('Escape');
  check(!(await a.js(`!!document.querySelector('.context-menu')`)), 'Esc again closes the menu');
  // Keep the pointer off the menu so hover does not open a submenu while the keyboard navigates.
  await a.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 });
  await a.js('ide.editor.focus()');
  await a.press('Alt+\\');
  await a.until(`!!document.querySelector('#mainMenu')`, 'Alt+\\');
  for (let i = 0; i < 11; i++) await a.press('ArrowDown');
  await a.press('ArrowRight');
  await a.until(`document.querySelectorAll('.context-menu').length === 2`, 'Help submenu by keyboard');
  check((await menuLabels(a, '.context-menu[data-level="1"]')).includes('About PyIDE'), 'Alt+\\ then arrows open Help');
  for (let i = 0; i < 5; i++) await a.press('ArrowUp');
  await a.js(`(${rowByLabel('.context-menu[data-level="1"]', 'About PyIDE')}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await a.until(`document.querySelector('.dialog-title')?.textContent === 'About PyIDE'`, 'about dialog');
  check(/Electron \d+/.test(await a.js(`document.querySelector('.about-facts').textContent`)), 'Help › About PyIDE shows versions');
  await a.press('Escape');

  // Edit › Select All acts on the editor; View › Appearance › Light switches the theme.
  await a.click('#mainMenuBtn');
  await hover(a, rowByLabel('#mainMenu', 'Edit'));
  await a.js(`(${rowByLabel('.context-menu[data-level="1"]', 'Select All')}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await sleep(200);
  check(await a.js(`(() => { const s = ide.editor.getSelection(); return s.startLineNumber === 1 && s.endLineNumber === ide.editor.getModel().getLineCount(); })()`), 'Edit › Select All selects the whole file');
  await a.click('#mainMenuBtn');
  await hover(a, rowByLabel('#mainMenu', 'View'));
  await hover(a, rowByLabel('.context-menu[data-level="1"]', 'Appearance'));
  await a.until(`document.querySelectorAll('.context-menu').length === 3`, 'appearance submenu');
  await a.js(`(${rowByLabel('.context-menu[data-level="2"]', 'Light')}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await a.until(`document.documentElement.dataset.theme === 'light'`, 'light');
  check(true, 'View › Appearance › Light switches the theme (nested submenus)');
  await a.shot('light.png');
  await a.js(`ide.settings.set('appearance.theme', 'dark')`);

  // ---------- settings gear, search, interpreter widget ----------
  await a.click('.settings-gear');
  await a.until(`!!document.querySelector('#settingsGearMenu')`, 'gear menu');
  check((await menuLabels(a, '#settingsGearMenu')).slice(0, 2).join('|') === 'Settings…|Plugins…', 'settings gear opens a menu (Settings…, Plugins…, Theme, …)');
  await a.press('Escape');
  await a.click('#searchBtn');
  await a.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'search popup');
  check(true, 'search button opens Search Everywhere');
  await a.press('Escape');
  await a.click('#statusInterp');
  await a.until(`!!document.querySelector('.context-menu .menu-item')`, 'interpreter menu');
  const interpMenu = await menuLabels(a, '.context-menu');
  check(interpMenu.some((l) => /Python/.test(l)) && interpMenu.includes('Interpreter Settings…'), `status-bar interpreter widget lists interpreters (${interpMenu.join(', ')})`);
  check(await a.js(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.querySelector('.menu-icon').textContent === '✓')`), 'the current interpreter is checked');
  await a.js(`(${rowByLabel('.context-menu', 'Interpreter Settings…')}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await a.until(`document.querySelector('.settings-page')?.dataset.page === 'interpreter'`, 'interpreter settings');
  check(true, 'Interpreter Settings… opens the interpreter page');
  await a.click('#settingsCancel');

  // ---------- project widget, Close Project, welcome ----------
  await a.click('#projectWidget');
  await a.until(`!!document.querySelector('.context-menu .menu-item')`, 'project menu');
  const pm = await menuLabels(a, '.context-menu');
  check(['New Project…', 'Open Folder…', 'Get from VCS…', 'Close Project'].every((x) => pm.includes(x)), `project widget menu (${pm.join(', ')})`);
  await a.js(`(${rowByLabel('.context-menu', 'Close Project')}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await a.until(`ide.root === null && !document.querySelector('#welcome').classList.contains('hidden')`, 'welcome screen');
  check(await a.js(`document.querySelector('.project-widget-name').textContent === 'No project' && !document.querySelector('#tree .node')`), 'Close Project returns to the welcome screen');
  check(await a.js(`document.querySelectorAll('#welcomeRecent .welcome-recent-row').length === 1 && ['welcomeNew', 'welcomeOpen', 'welcomeVcs'].every(id => !!document.getElementById(id))`), 'welcome shows New Project / Open / Get from VCS and recent projects');
  await a.shot('welcome.png');
  await a.click('#welcomeRecent .welcome-recent-row');
  await a.until(`ide.root && document.querySelector('#welcome').classList.contains('hidden')`, 'reopened');
  check(true, 'clicking a recent project reopens it');
  check(a.consoleErrors.length === 0, 'no renderer exceptions');
  a.close();

  // ---------- Korean ----------
  const k = await launch({ fixture: 'core', port: 9541, name: 'toolbar-ko', lang: 'ko-KR' });
  await k.click('#mainMenuBtn');
  await k.until(`!!document.querySelector('#mainMenu')`, 'menu (ko)');
  await hover(k, `[...document.querySelectorAll('#mainMenu .menu-item')][0]`);
  await k.until(`document.querySelectorAll('.context-menu').length === 2`, 'file (ko)');
  const leaks = await englishLeaks(k, '#toolbar, .context-menu, #status', ['Git']);
  check(!leaks.length && (await menuLabels(k, '#mainMenu'))[0] === '파일', `toolbar and menus are Korean${leaks.length ? ` ${JSON.stringify(leaks.slice(0, 6))}` : ''}`);
  await k.shot('menu-ko.png');
  check(k.consoleErrors.length === 0, 'no renderer exceptions (Korean)');
  k.close();
} catch (err) {
  check(false, err.message);
  a?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
