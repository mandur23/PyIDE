// Font zoom (Ctrl+Mouse Wheel, Increase/Decrease/Reset Font Size, Presentation Mode), the "Sync with OS" theme, Power
// Save Mode and Window › Layouts. Ports 9320-9323.
//
// The OS theme: CDP's Emulation.setEmulatedMedia only changes what the page's prefers-color-scheme reports; Electron's
// nativeTheme in the main process, which decides the "Sync with OS" theme, never sees it. So the instances run with
// PYIDE_OS_THEME (main/system-theme.js), which starts nativeTheme in that mode and adds the theme:testSetOs hook that
// switches it later through the same nativeTheme 'updated' event a real Windows switch sends.
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const q = JSON.stringify;
let failed = 0;
const instances = [];
const start = async (opts) => { const t = await launch(opts); instances.push(t); return t; };
const wrap = (t) => (ok, label) => { if (!ok) failed++; t.check(ok, label); };

// ---------- menus (as verify/appearance-modes.mjs) ----------
async function hover(t, expr) {
  const p = await t.js(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await t.sleep(300);
}
const menuLabels = (t, level) => t.js(`[...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')].map(n => n.querySelector('.menu-label').textContent)`);
const menuRow = (level, label) => `[...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')].find(n => n.querySelector('.menu-label').textContent === ${q(label)})`;
const isChecked = (t, level, label) => t.js(`(${menuRow(level, label)})?.querySelector('.menu-icon')?.textContent === '✓'`);
async function closeMenu(t) {
  for (let i = 0; i < 5 && await t.js(`!!document.querySelector('#menuHost .context-menu')`); i++) await t.press('Escape');
}
// Opens the main menu and the submenus along `labels`; returns the labels of the last one.
async function openMenu(t, ...labels) {
  await closeMenu(t);
  await t.click('#mainMenuBtn');
  await t.until(`!!document.querySelector('#mainMenu')`, 'main menu');
  for (let i = 0; i < labels.length; i++) {
    await t.until(`!!(${menuRow(i, labels[i])})`, `menu item ${labels[i]}`);
    await hover(t, menuRow(i, labels[i]));
    await t.until(`document.querySelectorAll('.context-menu[data-level="${i + 1}"] .menu-item').length > 0`, `${labels[i]} submenu`);
  }
  return menuLabels(t, labels.length);
}
async function clickMenu(t, level, label) {
  await t.until(`!!(${menuRow(level, label)})`, `menu item ${label}`);
  await t.js(`(() => { document.querySelector('.pick-menu')?.classList.remove('pick-menu'); ${menuRow(level, label)}.classList.add('pick-menu'); return true; })()`);
  await t.click('.context-menu .menu-item.pick-menu');
}

// ---------- editor font ----------
const editorFont = (t) => t.js(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize)`);
const editorCenter = (t) => t.js(`(() => { const r = ide.editor.getDomNode().getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
async function wheel(t, deltaY, modifiers = 2) {
  const p = await editorCenter(t);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY, modifiers });
  await t.sleep(120);
}
// Alt+Shift+. / Alt+Shift+, as real key events (code Period / Comma).
async function altShift(t, ch) {
  const code = ch === '.' ? 'Period' : 'Comma';
  const vk = ch === '.' ? 190 : 188;
  const base = { modifiers: 1 | 8, key: ch === '.' ? '>' : '<', code, windowsVirtualKeyCode: vk };
  await t.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await t.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await t.sleep(80);
}

// ---------- tool window layout as the user sees it ----------
const shownLayout = (t) => t.js(`(() => {
  const out = {};
  for (const [side, id] of [['left', 'sidePanel'], ['bottom', 'bottom'], ['right', 'rightPanel']]) {
    const p = document.getElementById(id);
    const tws = [...ide.toolWindows.values()].filter(w => w.area.panel === p);
    out[side] = { shown: tws.find(w => w.isVisible())?.id || null, active: tws.find(w => w.container.classList.contains('active'))?.id || null, size: id === 'bottom' ? p.style.height : p.style.width };
  }
  out.pinned = ide.sidebar.pinned().slice().sort().join(',');
  out.stripe = [...document.querySelectorAll('#stripe .stripe-btn[data-tool]:not(.hidden), #stripeRight .stripe-btn[data-tool]:not(.hidden)')].map(b => b.dataset.tool).sort().join(',');
  return out;
})()`);

const GHOST = `(() => { const r = ide.editor?.getDomNode(); return r ? [...r.querySelectorAll('.ghost-text-decoration, .ghost-text')].map(n => n.textContent).join('') : ''; })()`;
const freshLine = (t) => t.js(`(() => {
  const m = ide.editor.getModel();
  const n = m.getLineCount();
  m.pushEditOperations([], [{ range: new ide.monaco.Range(n, m.getLineMaxColumn(n), n, m.getLineMaxColumn(n)), text: '\\n\\n' }], () => null);
  ide.editor.setPosition({ lineNumber: m.getLineCount(), column: 1 });
  ide.editor.focus();
  return true;
})()`);
const clearLine = (t) => t.js(`(() => { const m = ide.editor.getModel(); const n = ide.editor.getPosition().lineNumber; m.pushEditOperations([], [{ range: new ide.monaco.Range(n, 1, n, m.getLineMaxColumn(n)), text: '' }], () => null); ide.editor.setPosition({ lineNumber: n, column: 1 }); ide.editor.focus(); return true; })()`);
const typos = (t) => t.js(`ide.spellcheck.markers(ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model).length`);
const semInfo = (t) => t.js(`ide.api.invoke('semantic:indexInfo', ide.root)`);

let a;
try {
  // =====================================================================================
  // A: a new install (fresh user data) on a dark OS.
  // =====================================================================================
  a = await start({ fixture: 'ui-comfort', port: 9320, name: 'ui-comfort' });
  const check = wrap(a);
  const { js, until, sleep } = a;

  await openFile(a, 'main.py');
  // ---------- Sync with OS ----------
  check(await js(`ide.settings.get('appearance.theme')`) === 'system', 'a new install starts with the Sync with OS theme');
  check(await js(`document.documentElement.dataset.theme`) === 'dark' && await js(`ide.theme.current()`) === 'dark', 'the dark OS gives the dark theme');
  await js(`ide.api.invoke('theme:testSetOs', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'OS switched to light');
  check(await js(`ide.theme.current() === 'light' && ide.theme.systemDark() === false`), 'the theme follows the OS to light at once (nativeTheme updated)');
  check(await js(`getComputedStyle(ide.editor.getDomNode().querySelector('.monaco-editor-background') || ide.editor.getDomNode()).backgroundColor`) === 'rgb(255, 255, 255)', 'the editor is drawn in PyCharm Light');
  await js(`ide.api.invoke('theme:testSetOs', 'dark')`);
  await until(`document.documentElement.dataset.theme === 'dark'`, 'OS switched back to dark');
  check(true, 'and back to dark');
  // An explicit choice is kept whatever the OS does.
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await js(`ide.api.invoke('theme:testSetOs', 'light')`);
  await sleep(700);
  check(await js(`document.documentElement.dataset.theme`) === 'dark', 'with Dark chosen, a light OS changes nothing');
  await js(`(ide.settings.set('appearance.theme', 'system'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'back to Sync with OS');
  check(true, 'choosing Sync with OS again follows the light OS');
  await js(`ide.api.invoke('theme:testSetOs', 'dark')`);
  await until(`document.documentElement.dataset.theme === 'dark'`, 'dark OS again');
  const appearance = await openMenu(a, 'View', 'Appearance');
  check(['Dark', 'Light', 'Sync with OS'].every((l) => appearance.includes(l)), `View › Appearance lists Dark, Light and Sync with OS (${appearance.join(', ')})`);
  await clickMenu(a, 2, 'Light');
  await until(`ide.settings.get('appearance.theme') === 'light' && document.documentElement.dataset.theme === 'light'`, 'Light from the menu');
  await openMenu(a, 'View', 'Appearance');
  await clickMenu(a, 2, 'Sync with OS');
  await until(`ide.settings.get('appearance.theme') === 'system' && document.documentElement.dataset.theme === 'dark'`, 'Sync with OS from the menu');
  check(true, 'the View › Appearance items set Light and Sync with OS');
  await js(`(ide.openSettings('appearance'), true)`);
  await until(`!!document.querySelector('.settings select[data-key="appearance.theme"]')`, 'Appearance page');
  const options = await js(`[...document.querySelector('.settings select[data-key="appearance.theme"]').options].map(o => o.value + '=' + o.textContent)`);
  check(q(options) === q(['dark=Dark', 'light=Light', 'system=Sync with OS']), `Settings › Appearance offers Dark / Light / Sync with OS (${options.join(', ')})`);
  check(await js(`document.querySelector('.settings select[data-key="appearance.theme"]').value`) === 'system', 'the page shows Sync with OS selected');
  await a.press('Escape');
  await until(`!document.querySelector('.settings')`, 'settings closed');

  // ---------- default layout (first run) ----------
  await openFile(a, 'main.py');
  await until(`ide.toolWindows.has('Project') && ide.toolWindows.has('Problems')`, 'tool windows');
  const firstRun = await shownLayout(a);
  check(firstRun.left.shown === 'Project' && !firstRun.right.shown, `first-run layout: Project open on the left, the right side closed (${q(firstRun)})`);

  // ---------- font zoom: Ctrl+Mouse Wheel ----------
  const f0 = await editorFont(a);
  check(f0 === 14, `the editor starts at 14 (${f0})`);
  await wheel(a, -100);
  await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 15`, 'Ctrl+wheel up');
  await until(`ide.settings.get('editor.fontSize') === 15`, 'the wheel size saved');
  check(true, 'Ctrl+wheel up sets the editor font size setting to 15');
  check(await js(`!document.querySelector('#fontZoomHint').classList.contains('hidden') && document.querySelector('#fontZoomHint').textContent.includes('Font size: 15pt')`), 'the zoom hint shows "Font size: 15pt"');
  check(await js(`document.querySelector('#fontZoomHint .font-zoom-reset')?.textContent === 'Reset to 14pt'`), 'with a Reset to 14pt link');
  await js(`(ide.openFile(ide.util.joinPath(ide.root, 'helpers.py'), { group: 'right' }), true)`);
  await until(`ide.editors().length === 2 && ide.activeTab()?.title === 'helpers.py'`, 'split editor');
  check(await js(`ide.editors().every(e => e.getOption(ide.monaco.editor.EditorOption.fontSize) === 15)`), 'every editor follows (all editors)');
  await wheel(a, 100);
  await wheel(a, 100);
  await until(`ide.settings.get('editor.fontSize') === 13`, 'Ctrl+wheel down twice');
  check(await js(`ide.editors().every(e => e.getOption(ide.monaco.editor.EditorOption.fontSize) === 13)`), 'Ctrl+wheel down twice gives 13 in every editor');
  // Small trackpad deltas add up to one step.
  for (let i = 0; i < 4; i++) await wheel(a, -15);
  await until(`ide.settings.get('editor.fontSize') === 14`, 'trackpad deltas');
  check(true, 'four small deltas (60 px) make one step');
  const scrollBefore = await js(`ide.editor.getScrollTop()`);
  await wheel(a, 100, 0);
  check(await js(`ide.settings.get('editor.fontSize')`) === 14, 'a wheel without Ctrl does not change the size');
  // A fast wheel burst resizes the editors at once and saves the size (settings.json) once, after the burst.
  await js(`(window.__fontSets = 0, ide.on('settingsChanged', (k) => { if (k === 'editor.fontSize') window.__fontSets++; }), true)`);
  {
    const p = await editorCenter(a);
    for (let i = 0; i < 5; i++) await a.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -100, modifiers: 2 });
  }
  await until(`ide.editors().every(e => e.getOption(ide.monaco.editor.EditorOption.fontSize) === 19)`, 'burst shown in every editor');
  const duringBurst = await js(`({ saved: ide.settings.get('editor.fontSize'), sets: window.__fontSets, zoom: ide.fontZoom.size() })`);
  check(duringBurst.saved === 14 && duringBurst.sets === 0 && duringBurst.zoom === 19, `a burst of 5 steps resizes the editors (19) before anything is saved (${q(duringBurst)})`);
  await until(`ide.settings.get('editor.fontSize') === 19`, 'burst saved');
  await a.sleep(700);
  const burstSets = await js(`window.__fontSets`);
  check(burstSets === 1 && (await js(`ide.editor.getOption(ide.monaco.editor.EditorOption.lineHeight)`)) === Math.round(19 * 1.6), `the burst is saved once (${burstSets} settings writes), with the line height to match`);
  await js(`(ide.fontZoom.reset(), true)`);
  await until(`ide.settings.get('editor.fontSize') === 14 && ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 14`, 'reset after burst');
  // ---------- the setting ----------
  await js(`(ide.openSettings('editor'), true)`);
  await until(`!!document.querySelector('.settings input[data-key="editor.wheelZoom"]')`, 'Editor page');
  check(await js(`document.querySelector('.settings input[data-key="editor.wheelZoom"]').checked && document.querySelector('.settings input[data-key="editor.wheelZoom"]').closest('label').textContent === 'Change font size with Ctrl+Mouse Wheel'`), 'Settings › Editor › General has "Change font size with Ctrl+Mouse Wheel", on by default');
  await a.click('.settings input[data-key="editor.wheelZoom"]');
  await a.click('.dialog-buttons .primary');
  await until(`ide.settings.get('editor.wheelZoom') === false`, 'setting off');
  await wheel(a, -100);
  check(await js(`ide.settings.get('editor.fontSize')`) === 14, 'with the setting off, Ctrl+wheel leaves the size alone');
  await js(`(ide.settings.set('editor.wheelZoom', true), true)`);
  void scrollBefore;

  // ---------- actions ----------
  const titles = await js(`Object.fromEntries(['EditorIncreaseFontSize', 'EditorDecreaseFontSize', 'EditorResetFontSize', 'EditorIncreaseFontSizeGlobal', 'EditorDecreaseFontSizeGlobal'].map(id => [id, (ide.actions.find(a => a.id === id) || {}).keys?.join(',') ?? 'missing']))`);
  check(titles.EditorIncreaseFontSize === '' && titles.EditorDecreaseFontSize === '' && titles.EditorResetFontSize === '', `Increase/Decrease/Reset Font Size are unbound, as in PyCharm's Windows keymap (${q(titles)})`);
  check(titles.EditorIncreaseFontSizeGlobal === 'Alt+Shift+.' && titles.EditorDecreaseFontSizeGlobal === 'Alt+Shift+,', 'the "in All Editors" variants take PyCharm\'s Alt+Shift+. and Alt+Shift+,');
  await js(`ide.runAction('EditorIncreaseFontSize')`);
  await js(`ide.runAction('EditorIncreaseFontSize')`);
  await until(`ide.settings.get('editor.fontSize') === 16`, 'Increase Font Size');
  await js(`ide.runAction('EditorDecreaseFontSize')`);
  await until(`ide.settings.get('editor.fontSize') === 15`, 'Decrease Font Size');
  await js(`ide.runAction('EditorResetFontSize')`);
  await until(`ide.settings.get('editor.fontSize') === 14 && ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 14`, 'Reset Font Size');
  check(true, 'Increase, Decrease and Reset Font Size change the editor font setting');
  await js(`(ide.editor.focus(), true)`);
  await altShift(a, '.');
  await until(`ide.settings.get('editor.fontSize') === 15`, 'Alt+Shift+.');
  await altShift(a, ',');
  await altShift(a, ',');
  await until(`ide.settings.get('editor.fontSize') === 13`, 'Alt+Shift+,');
  check(true, 'Alt+Shift+. and Alt+Shift+, change the size from the keyboard');
  const findAction = await js(`ide.actions.filter(a => a.id.startsWith('Editor') && a.id.includes('FontSize')).map(a => a.title).join(' | ')`);
  check(findAction.includes('Increase Font Size') && findAction.includes('Reset Font Size in All Editors'), `the actions are in Find Action (${findAction})`);
  await js(`(ide.settings.set('editor.fontSize', 16), true)`);
  await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 16`, 'font 16');

  // ---------- Presentation Mode ----------
  await js(`ide.appearanceModes.toggle('presentation')`);
  await until(`ide.appearanceModes.mode() === 'presentation' && ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 24`, 'presentation mode at 24');
  await wheel(a, -100);
  await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 25`, 'presentation Ctrl+wheel');
  await until(`ide.settings.get('appearance.presentationFontSize') === 25`, 'presentation size saved');
  check(await js(`ide.settings.get('appearance.presentationFontSize') === 25 && ide.settings.get('editor.fontSize') === 16`), 'in Presentation Mode, Ctrl+wheel changes the presentation size (25), not the editor setting');
  check(await js(`document.querySelector('#fontZoomHint').textContent.includes('Font size: 25pt') && document.querySelector('#fontZoomHint .font-zoom-reset')?.textContent === 'Reset to 24pt'`), 'the hint shows the presentation size and its default');
  await js(`ide.appearanceModes.exit()`);
  await until(`ide.appearanceModes.mode() === null`, 'presentation left');
  await until(`ide.editors().every(e => e.getOption(ide.monaco.editor.EditorOption.fontSize) === 16)`, 'editor font restored');
  check(true, 'leaving Presentation Mode restores the editor font (16) in every editor');
  await wheel(a, -100);
  await until(`ide.settings.get('editor.fontSize') === 17`, 'zoom after presentation');
  check(await js(`ide.settings.get('appearance.presentationFontSize')`) === 25, 'after it, Ctrl+wheel changes the editor size again');

  // ---------- Power Save Mode ----------
  await until(`ide.aiComplete.mode() === 'on'`, 'AI completion ready');
  await until(`ide.spellcheck.enabled() && ${'(' + "ide.spellcheck.markers(ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model).length" + ')'} >= 2`, 'typos found', 30000);
  await until(`(await ide.api.invoke('semantic:indexInfo', ide.root)).files === 3`, 'semantic index ready', 30000);
  check(!(await js(`ide.powerSave.on()`)) && await js(`document.querySelector('#powerSaveStatus').classList.contains('hidden')`), 'Power Save Mode is off by default, no indicator');
  check(await js(`ide.vulnerabilities.autoCheck()`) === true, 'automatic vulnerability checks are on');
  await js(`(ide.settings.set('aiEdit.nes.enabled', true), true)`);
  check(await js(`ide.aiEdit.nesActive()`) === true, 'next edit suggestions on');
  const fileMenu = await openMenu(a, 'File');
  check(fileMenu.includes('Power Save Mode') && !(await isChecked(a, 1, 'Power Save Mode')), `File › Power Save Mode, unchecked (${fileMenu.join(', ')})`);
  let psEvents = await js(`(window.__ps = [], ide.on('powerSaveChanged', on => window.__ps.push(on)), true)`);
  await clickMenu(a, 1, 'Power Save Mode');
  await until(`ide.powerSave.on() === true`, 'power save on');
  psEvents = await js(`window.__ps`);
  check(q(psEvents) === '[true]', `powerSaveChanged(true) fires once (${q(psEvents)})`);
  check(await js(`!document.querySelector('#powerSaveStatus').classList.contains('hidden') && document.querySelector('#powerSaveStatus').textContent.includes('Power Save Mode')`), 'the status bar shows the Power Save Mode indicator');
  await openMenu(a, 'File');
  check(await isChecked(a, 1, 'Power Save Mode'), 'File › Power Save Mode is checked');
  await closeMenu(a);
  // AI completion: no request while typing, the status says paused.
  await until(`ide.aiComplete.mode() === 'powerSave'`, 'AI completion paused');
  check(await js(`document.querySelector('#aiCompleteStatus').textContent.includes('AI Completion: paused')`), 'AI completion shows "paused"');
  await js(`(ide.editor.updateOptions({ quickSuggestions: false, suggestOnTriggerCharacters: false }), true)`);
  await freshLine(a);
  const asked = (await js(`ide.api.invoke('ai-complete:stats')`)).requests;
  await a.type('print("hello');
  await sleep(1200);
  check(!(await js(GHOST)) && (await js(`ide.api.invoke('ai-complete:stats')`)).requests === asked, 'no AI completion request or ghost text while typing in Power Save Mode');
  // Next edit suggestions, spell check, vulnerabilities, semantic indexing.
  check(await js(`ide.aiEdit.nesActive() === false && ide.aiEdit.nesEnabled() === true`), 'next edit suggestions pause (the setting stays on)');
  await until(`!ide.spellcheck.enabled() && ${"ide.spellcheck.markers(ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model).length"} === 0`, 'spell check paused');
  check(true, 'spell checking pauses and its markers go');
  check(await js(`ide.vulnerabilities.autoCheck()`) === false, 'automatic vulnerability checks stop going online');
  // Git auto-fetch: the project becomes a repository with a (local, bare) remote and fetches every 1.2 s.
  const bare = path.join(tempDir('ui-comfort-remote'), 'remote.git');
  const git = (...args) => execFileSync('git', args, { cwd: a.project, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', '-q', bare], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', bare);
  await js(`(ide.vcs.reload(), true)`);
  await sleep(1500);
  await js(`(ide.settings.set('vcs.autoFetchMinutes', 0.02), true)`);
  await sleep(3500);
  check(await js(`ide.vcs.autoFetch.state().attempts`) === 0, 'no automatic git fetch in Power Save Mode');
  check((await semInfo(a)).powerSave === true, 'semantic indexing is paused in main');
  await js(`ide.api.write(ide.util.joinPath(ide.root, 'extra.py'), 'def triple(x):\\n    return x * 3\\n')`);
  await js(`ide.api.invoke('semantic:index', ide.root)`);
  await sleep(2500);
  check((await semInfo(a)).files === 3, 'a new file is not indexed while Power Save Mode is on');
  // Off again: everything resumes.
  await clearLine(a);
  await js(`ide.runAction('TogglePowerSave')`);
  await until(`ide.powerSave.on() === false && document.querySelector('#powerSaveStatus').classList.contains('hidden')`, 'power save off');
  await until(`(await ide.api.invoke('semantic:indexInfo', ide.root)).files === 4`, 'indexing resumed', 30000);
  check(true, 'turning it off resumes indexing (the new file is indexed)');
  await until(`ide.spellcheck.enabled() && ${"ide.spellcheck.markers(ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model).length"} >= 2`, 'typos back', 30000);
  check(true, 'spell checking resumes');
  check(await js(`ide.aiEdit.nesActive() === true && ide.vulnerabilities.autoCheck() === true && ide.aiComplete.mode() === 'on'`), 'next edit suggestions, vulnerability checks and AI completion resume');
  await until(`ide.vcs.autoFetch.state().attempts > 0`, 'auto-fetch resumed', 20000);
  check(await js(`ide.vcs.autoFetch.state().failures`) === 0, 'git auto-fetch resumes (and fetches from the local remote)');
  await js(`(ide.settings.set('vcs.autoFetchMinutes', 10), true)`);
  await a.type('print("hello');
  await until(`${GHOST}.includes('world')`, 'ghost text after power save', 15000);
  check(true, 'AI completion suggests again');
  await a.press('Escape');
  await clearLine(a);
  await js(`(ide.settings.set('aiEdit.nes.enabled', false), true)`);
  // On for the restart check below.
  await js(`(ide.powerSave.set(true), true)`);

  // ---------- Window › Layouts ----------
  await js(`ide.layouts.restoreDefault()`);
  await until(`ide.toolWindows.get('Project').isVisible()`, 'default layout');
  check(q(await shownLayout(a)) === q(firstRun), 'Restore Default Layout from the API gives the first-run layout');
  const layoutsMenu = await openMenu(a, 'Window', 'Layouts');
  check(['Save Current Layout As…', 'Restore Default Layout', 'Restore Current Layout'].every((l) => layoutsMenu.includes(l)), `Window › Layouts (${layoutsMenu.join(', ')})`);
  check(await isChecked(a, 2, 'Restore Default Layout'), 'the default layout is the current one');
  await closeMenu(a);
  // A custom layout: Problems at the bottom, Structure on the left at 333 px, the bottom at 222 px, the right open,
  // TODO pinned and Terminal unpinned.
  await js(`(() => {
    ide.toolWindows.get('Structure').show(); ide.toolWindows.get('Problems').show();
    document.getElementById('sidePanel').style.width = '333px'; document.getElementById('bottom').style.height = '222px';
    const right = [...ide.toolWindows.values()].find(w => w.area.panel.id === 'rightPanel'); right?.show();
    ide.sidebar.setPinned('TODO', true); ide.sidebar.setPinned('Terminal', false);
    return true; })()`);
  const custom = await shownLayout(a);
  check(custom.left.shown === 'Structure' && custom.bottom.shown === 'Problems' && custom.left.size === '333px' && custom.pinned.includes('TODO'), `custom layout set up (${q(custom)})`);
  await openMenu(a, 'Window', 'Layouts');
  await clickMenu(a, 2, 'Save Current Layout As…');
  await until(`document.activeElement?.id === 'layoutName'`, 'name dialog');
  await js(`(document.getElementById('layoutName').value = '', true)`);
  await a.type('Review');
  await a.press('Enter');
  await until(`ide.layouts.list().includes('Review') && ide.layouts.current() === 'Review'`, 'layout saved');
  check(true, 'Save Current Layout As… stores "Review" and makes it current');
  // Something else, then Restore 'Review' from its submenu.
  await js(`(ide.layouts.restoreDefault(), true)`);
  await until(`ide.toolWindows.get('Project').isVisible() && ide.layouts.current() === null`, 'default again');
  check(q(await shownLayout(a)) === q(firstRun), 'Restore Default Layout brings the first-run layout back (sizes, pinned windows, stripes)');
  const sub = await openMenu(a, 'Window', 'Layouts', 'Review');
  check(q(sub) === q(['Restore', 'Rename…', 'Delete']), `the layout's submenu (${sub.join(', ')})`);
  await clickMenu(a, 3, 'Restore');
  await until(`ide.toolWindows.get('Structure').isVisible() && ide.toolWindows.get('Problems').isVisible()`, 'Review restored');
  check(q(await shownLayout(a)) === q(custom), `Restore brings back exactly the saved layout (${q(await shownLayout(a))})`);
  // Shift+F12 restores the current layout after changes.
  await js(`(ide.toolWindows.get('Structure').hide(), ide.toolWindows.get('Problems').hide(), document.getElementById('bottom').style.height = '300px', ide.editor.focus(), true)`);
  await a.press('Shift+F12');
  await until(`ide.toolWindows.get('Structure').isVisible() && document.getElementById('bottom').style.height === '222px'`, 'Shift+F12');
  check(q(await shownLayout(a)) === q(custom), 'Shift+F12 (Restore Current Layout) restores "Review"');
  // Restore Default Layout from the menu.
  await openMenu(a, 'Window', 'Layouts');
  await clickMenu(a, 2, 'Restore Default Layout');
  await until(`ide.toolWindows.get('Project').isVisible() && ide.layouts.current() === null`, 'default from the menu');
  check(q(await shownLayout(a)) === q(firstRun), 'Window › Layouts › Restore Default Layout');
  // A second layout to delete.
  await js(`(ide.toolWindows.get('Problems').show(), ide.layouts.save('Temp'), true)`);
  await openMenu(a, 'Window', 'Layouts', 'Temp');
  await clickMenu(a, 3, 'Delete');
  await until(`!ide.layouts.list().includes('Temp')`, 'Temp deleted');
  check(q(await js(`ide.layouts.list()`)) === q(['Review']) && await js(`ide.layouts.current()`) === null, 'Delete removes the layout (the current one falls back to the default)');
  check(await js(`Array.isArray(ide.settings.get('toolWindowLayouts')) && ide.settings.get('toolWindowLayouts').length === 1`), 'layouts are kept in the IDE-level toolWindowLayouts setting');
  await js(`(ide.layouts.restoreDefault(), true)`);
  check(!(a.consoleErrors.length), `no renderer exceptions (${a.consoleErrors.join(' | ')})`);
  await js(`ide.settings.flush()`);
  const userData = a.userData;
  a.close();

  // =====================================================================================
  // B: the same user data after a restart.
  // =====================================================================================
  const b = await start({ fixture: 'ui-comfort', port: 9321, name: 'ui-comfort-restart', userData });
  const checkB = wrap(b);
  await openFile(b, 'main.py');
  checkB(await b.js(`ide.settings.get('editor.fontSize')`) === 17 && await b.js(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize)`) === 17, 'the zoomed font size (17) persists across a restart');
  checkB(await b.js(`ide.settings.get('appearance.presentationFontSize')`) === 25, 'and so does the presentation size');
  checkB(await b.js(`ide.powerSave.on() && !document.querySelector('#powerSaveStatus').classList.contains('hidden')`), 'Power Save Mode is still on after a restart, with its indicator');
  await b.until(`ide.aiComplete.mode() === 'powerSave'`, 'AI paused after restart');
  checkB(true, 'AI completion starts paused');
  checkB(await b.js(`!ide.spellcheck.enabled() && ide.vulnerabilities.autoCheck() === false`), 'spell checking and automatic vulnerability checks start paused');
  await b.until(`(await ide.api.invoke('semantic:indexInfo', ide.root)).powerSave === true`, 'semantic paused after restart');
  checkB(true, 'semantic indexing starts paused');
  checkB(q(await b.js(`ide.layouts.list()`)) === q(['Review']), 'saved layouts are there after a restart');
  await b.js(`ide.layouts.restore('Review')`);
  const restored = await shownLayout(b);
  checkB(restored.left.shown === 'Structure' && restored.bottom.shown === 'Problems' && restored.left.size === '333px' && restored.bottom.size === '222px' && restored.pinned === custom.pinned, `"Review" restores after a restart (${q(restored)})`);
  await b.js(`(ide.powerSave.set(false), true)`);
  await b.until(`ide.aiComplete.mode() === 'on'`, 'AI back');
  checkB(!(b.consoleErrors.length), `no renderer exceptions (${b.consoleErrors.join(' | ')})`);
  b.close();

  // =====================================================================================
  // C: a new install on a light OS, in Korean.
  // =====================================================================================
  const c = await start({ fixture: 'ui-comfort', port: 9322, name: 'ui-comfort-ko', lang: 'ko-KR', env: { PYIDE_OS_THEME: 'light' } });
  const checkC = wrap(c);
  checkC(await c.js(`ide.settings.get('appearance.theme') === 'system' && document.documentElement.dataset.theme === 'light'`), 'a new install on a light OS starts light');
  await openFile(c, 'main.py');
  const fileKo = await openMenu(c, '파일');
  checkC(fileKo.includes('절전 모드'), `파일 › 절전 모드 (${fileKo.join(', ')})`);
  await clickMenu(c, 1, '절전 모드');
  await c.until(`ide.powerSave.on()`, 'power save on (ko)');
  checkC(await c.js(`document.querySelector('#powerSaveStatus').textContent.includes('절전 모드') && document.querySelector('#powerSaveStatus').title.includes('절전 모드: 켜짐')`), 'the indicator reads 절전 모드 (절전 모드: 켜짐)');
  await c.until(`document.querySelector('#aiCompleteStatus').textContent.includes('AI 코드 완성: 일시 중지됨')`, 'ko AI paused');
  checkC(true, 'AI 코드 완성: 일시 중지됨');
  const appearanceKo = await openMenu(c, '보기', '외관');
  checkC(appearanceKo.includes('OS와 동기화') && await isChecked(c, 2, 'OS와 동기화'), `보기 › 외관 › OS와 동기화, checked (${appearanceKo.join(', ')})`);
  const layoutsKo = await openMenu(c, '창', '레이아웃');
  checkC(['현재 레이아웃을 새 이름으로 저장…', '디폴트 레이아웃 복원', '현재 레이아웃 복원'].every((l) => layoutsKo.includes(l)), `창 › 레이아웃 (${layoutsKo.join(', ')})`);
  await clickMenu(c, 2, '현재 레이아웃을 새 이름으로 저장…');
  await c.until(`document.activeElement?.id === 'layoutName'`, 'ko name dialog');
  checkC(await c.js(`document.querySelector('.dialog-title').textContent === '현재 레이아웃을 새 이름으로 저장' && document.querySelector('.layout-name-row').textContent.startsWith('이름:')`), 'the Save dialog in Korean');
  await c.press('Escape');
  await c.js(`(ide.editor.focus(), true)`);
  await wheel(c, -100);
  await c.until(`document.querySelector('#fontZoomHint')?.textContent.includes('글꼴 크기: 15pt')`, 'ko hint');
  checkC(await c.js(`document.querySelector('#fontZoomHint .font-zoom-reset').textContent === '14pt로 재설정'`), 'the zoom hint in Korean (글꼴 크기: 15pt, 14pt로 재설정)');
  await c.js(`(ide.openSettings('appearance'), true)`);
  await c.until(`!!document.querySelector('.settings select[data-key="appearance.theme"]')`, 'ko Appearance page');
  const optionsKo = await c.js(`[...document.querySelector('.settings select[data-key="appearance.theme"]').options].map(o => o.textContent)`);
  checkC(optionsKo.includes('OS와 동기화'), `테마: ${optionsKo.join(' / ')}`);
  await c.js(`(ide.openSettings('editor'), true)`);
  await c.until(`!!document.querySelector('.settings input[data-key="editor.wheelZoom"]')`, 'ko Editor page');
  checkC(await c.js(`document.querySelector('.settings input[data-key="editor.wheelZoom"]').closest('label').textContent === 'Ctrl+마우스 휠로 글꼴 크기 변경'`), 'Ctrl+마우스 휠로 글꼴 크기 변경');
  await c.press('Escape');
  const titlesKo = await c.js(`['EditorIncreaseFontSize', 'TogglePowerSave', 'RestoreFactoryDefaultLayout', 'StoreNewLayout'].map(id => ide.actions.find(a => a.id === id).title)`);
  checkC(q(titlesKo) === q(['글꼴 크기 크게', '절전 모드', '디폴트 레이아웃 복원', '현재 레이아웃을 새 이름으로 저장…']), `Korean action titles (${titlesKo.join(', ')})`);
  const missing = (await missingTranslations(c)).filter((s) => /font|layout|power|sync with os|mouse|restore|rename|delete|name:|custom|semantic|ai completion|next edit|vulnerab/i.test(s));
  checkC(!missing.length, `no missing Korean strings (${missing.join(' | ')})`);
  checkC(!(c.consoleErrors.length), `no renderer exceptions (${c.consoleErrors.join(' | ')})`);
  c.close();

  // =====================================================================================
  // D: an existing install (settings without a theme) on a light OS keeps Dark.
  // =====================================================================================
  const existing = path.join(tempDir('ui-comfort-existing'), 'userdata');
  mkdirSync(existing, { recursive: true });
  writeFileSync(path.join(existing, 'settings.json'), JSON.stringify({ 'editor.fontSize': 14, recentProjects: [] }));
  const d = await start({ fixture: 'ui-comfort', port: 9323, name: 'ui-comfort-existing', userData: existing, env: { PYIDE_OS_THEME: 'light' } });
  const checkD = wrap(d);
  checkD(await d.js(`ide.settings.get('appearance.theme') === undefined && document.documentElement.dataset.theme === 'dark' && ide.theme.current() === 'dark'`), 'an existing install keeps Dark on a light OS (the default changes for new installs only)');
  checkD(!(d.consoleErrors.length), `no renderer exceptions (${d.consoleErrors.join(' | ')})`);
  d.close();
} catch (err) {
  console.log(`FAIL ${err.stack || err}`);
  failed++;
  for (const t of instances) { try { await t.shot('failure.png'); } catch {} }
} finally {
  for (const t of instances) { try { t.close(); } catch {} }
  const total = instances.reduce((n, t) => n + t.results.length, 0);
  console.log(`${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
}
