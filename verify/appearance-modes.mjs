// View › Appearance modes: Distraction-Free, Zen, Full Screen and Presentation Mode. Chrome hidden and back, Monaco
// options, the centered editor width, the layout restored exactly, tool window shortcuts inside a mode, full screen
// through the main process, the presentation font size, switching modes, and the Korean menu. Ports 9230-9231.
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const q = JSON.stringify;

async function hover(t, expr) {
  const p = await t.js(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await t.sleep(300);
}
const menuLabels = (t, level) => t.js(`[...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')].map(n => n.querySelector('.menu-label').textContent)`);
const menuRow = (level, label) => `[...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')].find(n => n.querySelector('.menu-label').textContent === ${q(label)})`;
// Opens View › Appearance and returns its labels.
async function appearanceMenu(t, view, appearance) {
  await t.click('#mainMenuBtn');
  await t.until(`!!document.querySelector('#mainMenu')`, 'main menu');
  await hover(t, menuRow(0, view));
  await t.until(`!!(${menuRow(1, appearance)})`, `${view} submenu`);
  await hover(t, menuRow(1, appearance));
  await t.until(`document.querySelectorAll('.context-menu[data-level="2"] .menu-item').length > 0`, `${appearance} submenu`);
  return menuLabels(t, 2);
}
async function clickMenu(t, level, label) {
  await t.js(`(() => { document.querySelector('.pick-menu')?.classList.remove('pick-menu'); ${menuRow(level, label)}.classList.add('pick-menu'); return true; })()`);
  await t.click('.context-menu .menu-item.pick-menu');
}

const shown = (sel) => `[...document.querySelectorAll(${q(sel)})].some(n => n.getClientRects().length > 0)`;
const CHROME = ['#toolbar', '#stripe', '#status', '.editor-group .group-tabs', '.editor-group .nb-bar'];
const chromeState = (t) => t.js(`Object.fromEntries(${q(CHROME)}.map(s => [s, ${'[...document.querySelectorAll(s)].some(n => n.getClientRects().length > 0)'}]))`);
const gutter = (t) => t.js(`(() => { const E = ide.monaco.editor.EditorOption, ed = ide.editor;
  return { lineNumbers: ed.getOption(E.lineNumbers).renderType, glyphMargin: ed.getOption(E.glyphMargin), folding: ed.getOption(E.folding),
    minimap: ed.getOption(E.minimap).enabled, fontSize: ed.getOption(E.fontSize), lineHeight: ed.getOption(E.lineHeight) }; })()`);
// Which tool window each area shows (null when the area is hidden) and its size.
const layout = (t) => t.js(`(() => {
  const out = {};
  for (const [side, id] of [['left', 'sidePanel'], ['bottom', 'bottom'], ['right', 'rightPanel']]) {
    const p = document.getElementById(id);
    const tw = [...ide.toolWindows.values()].find(w => w.area.panel === p && w.isVisible());
    const active = [...ide.toolWindows.values()].find(w => w.area.panel === p && w.container.classList.contains('active'));
    out[side] = { shown: tw ? tw.id : null, active: active?.id || null, width: p.style.width, height: p.style.height };
  }
  return out;
})()`);
const hostBox = (t) => t.js(`(() => { const h = ide.activeGroup().editorHost, b = ide.activeGroup().body.getBoundingClientRect(), r = h.getBoundingClientRect();
  return { left: Math.round(r.left - b.left), right: Math.round(b.right - r.right), width: Math.round(r.width), body: Math.round(b.width) }; })()`);
const isFull = (t) => t.js(`ide.api.invoke('appearance-modes:isFullScreen')`);
const mode = (t) => t.js(`ide.appearanceModes.mode()`);
const title = (t, id) => t.js(`ide.actions.find(a => a.id === ${q(id)}).title`);
const runAction = (t, id) => t.js(`(ide.runAction(${q(id)}), true)`);

const t = await launch({ fixture: 'core', port: 9230, name: 'appearance-modes' });
const { js, until, check, press, sleep } = t;
try {
  await openFile(t, 'hello.py');
  // Starting layout: Project on the left at 333 px, Problems at the bottom at 222 px, the right side closed.
  await js(`(ide.toolWindows.get('Project').show(), ide.toolWindows.get('Problems').show(), document.getElementById('sidePanel').style.width = '333px', document.getElementById('bottom').style.height = '222px', ide.editor.focus(), true)`);
  const before = await layout(t);
  const gutterBefore = await gutter(t);
  check(before.left.shown === 'Project' && before.bottom.shown === 'Problems' && !before.right.shown, `starting layout (${q(before)})`);
  check(Object.values(await chromeState(t)).every(Boolean), 'toolbar, stripe, status bar, tabs and breadcrumbs show');

  // ---------- menu ----------
  const labels = await appearanceMenu(t, 'View', 'Appearance');
  check(['Enter Presentation Mode', 'Enter Distraction-Free Mode', 'Enter Full Screen', 'Enter Zen Mode'].every((l, i) => labels[i] === l),
    `View › Appearance lists the four modes in PyCharm's order (${labels.join(', ')})`);
  check(labels.includes('Dark') && labels.includes('Light'), 'the theme items stay');
  await clickMenu(t, 2, 'Enter Distraction-Free Mode');
  await until(`ide.appearanceModes.mode() === 'distractionFree'`, 'distraction-free mode');

  // ---------- distraction-free ----------
  const df = await chromeState(t);
  check(Object.values(df).every((v) => !v), `distraction-free hides the toolbar, stripes, status bar, editor tabs and breadcrumbs (${q(df)})`);
  const dfLayout = await layout(t);
  check(!dfLayout.left.shown && !dfLayout.bottom.shown && !dfLayout.right.shown, 'open tool windows are hidden');
  const g = await gutter(t);
  check(g.lineNumbers === 0 && g.glyphMargin === false && g.folding === false && g.minimap === false, `line numbers, gutter icons, folding and minimap are off (${q(g)})`);
  const box = await hostBox(t);
  // Visible columns: the content width less the vertical scrollbar, which Monaco draws over the content.
  const cols = await js(`(() => { const ed = ide.editor; const li = ed.getLayoutInfo(); return (li.contentWidth - li.verticalScrollbarWidth) / ed.getOption(ide.monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth; })()`);
  check(box.left > 50 && Math.abs(box.left - box.right) <= 1 && cols >= 100 && cols < 101,
    `the editor is centered about 100 columns wide (left ${box.left}, right ${box.right}, ${cols.toFixed(1)} columns)`);
  const note = await js(`document.querySelector('#appearanceModeNotice:not(.hidden)')?.textContent || ''`);
  check(note.includes('Distraction-Free Mode') && note.includes('View › Appearance') && note.includes('Find Action (Ctrl+Shift+A)'),
    `a notice says how to exit (${note})`);
  check(await title(t, 'ToggleDistractionFreeMode') === 'Exit Distraction-Free Mode', 'the action now reads Exit Distraction-Free Mode');
  check(!(await isFull(t)), 'distraction-free is not full screen');

  // Esc keeps its usual job.
  await js(`(ide.editor.focus(), true)`);
  await press('Escape');
  check(await mode(t) === 'distractionFree', 'Esc does not leave the mode');

  // Tool windows by their shortcuts, then hiding them returns to the mode.
  await press('Alt+1');
  await until(`ide.toolWindows.get('Project').isVisible()`, 'Project by Alt+1');
  check(await mode(t) === 'distractionFree' && !(await js(shown('#stripe'))), 'Alt+1 opens Project inside the mode; the stripes stay hidden');
  await press('Alt+1');
  await until(`!ide.toolWindows.get('Project').isVisible()`, 'Project hidden again');
  check(await mode(t) === 'distractionFree', 'closing it returns to the mode');
  await press('Alt+6');
  await until(`ide.toolWindows.get('Problems').isVisible()`, 'Problems by Alt+6');
  await js(`(document.getElementById('bottom').style.height = '150px', ide.toolWindows.get('TODO').show(), document.getElementById('sidePanel').style.width = '200px', true)`);
  if (await js(`ide.toolWindows.has('AIChat')`)) await js(`(ide.toolWindows.get('AIChat').show(), true)`);
  await sleep(100);
  await js(`(ide.editor.focus(), true)`);

  // Find Action finds the exit.
  await press('Ctrl+Shift+A');
  await until(`document.querySelector('#popup:not(.hidden)')`, 'Find Action');
  await t.type('Exit Distraction');
  await until(`[...document.querySelectorAll('#popupList .popup-item')].some(n => n.textContent.includes('Exit Distraction-Free Mode'))`, 'Exit in Find Action');
  await press('Enter');
  await until(`ide.appearanceModes.mode() === null`, 'left distraction-free mode');
  check(Object.values(await chromeState(t)).every(Boolean), 'leaving brings the chrome back');
  const after = await layout(t);
  check(q(after) === q(before), `the layout is restored exactly: windows, active tabs and sizes (${q(after)})`);
  check(q(await gutter(t)) === q(gutterBefore), 'the editor options are restored');
  const box2 = await hostBox(t);
  check(box2.left === 0 && box2.right === 0, 'the editor fills its pane again');
  check(await title(t, 'ToggleDistractionFreeMode') === 'Enter Distraction-Free Mode', 'the action reads Enter again');
  check(await js(`document.getElementById('appearanceModeNotice').classList.contains('hidden')`), 'the notice is gone');

  // ---------- zen ----------
  await runAction(t, 'ToggleZenMode');
  await until(`ide.appearanceModes.mode() === 'zen'`, 'zen');
  await until(`ide.api.invoke('appearance-modes:isFullScreen')`, 'zen full screen', 8000).catch(() => {});
  check(await isFull(t), 'zen puts the window in full screen (main process)');
  check(Object.values(await chromeState(t)).every((v) => !v) && (await gutter(t)).lineNumbers === 0 && (await hostBox(t)).left > 50,
    'zen hides the chrome, the gutter and centers the editor like distraction-free');
  await runAction(t, 'ToggleZenMode');
  await until(`ide.appearanceModes.mode() === null`, 'zen left');
  await until(`ide.api.invoke('appearance-modes:isFullScreen').then(v => !v)`, 'zen full screen left', 8000).catch(() => {});
  check(!(await isFull(t)) && q(await layout(t)) === q(before), 'leaving zen leaves full screen and restores the layout');

  // ---------- full screen ----------
  await runAction(t, 'ToggleFullScreen');
  await until(`ide.appearanceModes.mode() === 'fullScreen'`, 'full screen');
  await until(`ide.api.invoke('appearance-modes:isFullScreen')`, 'full screen on', 8000).catch(() => {});
  check(await isFull(t), 'Enter Full Screen sets the window full screen');
  check(Object.values(await chromeState(t)).every(Boolean) && q(await layout(t)) === q(before) && q(await gutter(t)) === q(gutterBefore),
    'full screen alone keeps the chrome, tool windows and gutter');
  check(await title(t, 'ToggleFullScreen') === 'Exit Full Screen', 'the action reads Exit Full Screen');
  await runAction(t, 'ToggleFullScreen');
  await until(`ide.appearanceModes.mode() === null`, 'full screen left');
  await until(`ide.api.invoke('appearance-modes:isFullScreen').then(v => !v)`, 'full screen off', 8000).catch(() => {});
  check(!(await isFull(t)), 'Exit Full Screen leaves full screen');

  // ---------- presentation ----------
  await runAction(t, 'TogglePresentationMode');
  await until(`ide.appearanceModes.mode() === 'presentation'`, 'presentation');
  await until(`ide.api.invoke('appearance-modes:isFullScreen')`, 'presentation full screen', 8000).catch(() => {});
  let p = await gutter(t);
  check(p.fontSize === 24 && p.lineHeight === Math.round(24 * gutterBefore.lineHeight / gutterBefore.fontSize), `presentation uses a 24 pt editor font (${p.fontSize}/${p.lineHeight})`);
  check(Object.values(await chromeState(t)).every((v) => !v) && await isFull(t), 'presentation hides the chrome in full screen');
  check(p.lineNumbers !== 0 && (await hostBox(t)).left === 0, 'presentation keeps line numbers and the full editor width');
  await js(`(ide.settings.set('appearance.presentationFontSize', 30), true)`);
  await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 30`, 'font size setting applies live');
  await js(`(ide.settings.set('editor.fontSize', 16), true)`);
  await sleep(200);
  p = await gutter(t);
  check(p.fontSize === 30, `changing the editor font during presentation keeps the presentation size (${p.fontSize})`);
  await runAction(t, 'TogglePresentationMode');
  await until(`ide.appearanceModes.mode() === null`, 'presentation left');
  check((await gutter(t)).fontSize === 16, 'leaving presentation uses the editor font size set meanwhile');
  await js(`(ide.settings.set('editor.fontSize', 14), ide.settings.set('appearance.presentationFontSize', 24), true)`);
  await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 14`, 'font back to 14');
  await until(`ide.api.invoke('appearance-modes:isFullScreen').then(v => !v)`, 'presentation full screen off', 8000).catch(() => {});
  check(!(await isFull(t)) && q(await layout(t)) === q(before), 'presentation left: not full screen, layout restored');

  // ---------- switching and leaving full screen elsewhere ----------
  await runAction(t, 'ToggleZenMode');
  await until(`ide.appearanceModes.mode() === 'zen'`, 'zen again');
  await runAction(t, 'TogglePresentationMode');
  await until(`ide.appearanceModes.mode() === 'presentation'`, 'zen -> presentation');
  await sleep(500);
  check(await mode(t) === 'presentation' && await isFull(t) && (await hostBox(t)).left === 0 && (await gutter(t)).lineNumbers !== 0,
    'switching from zen to presentation stays full screen with presentation\'s editor');
  await js(`ide.api.invoke('appearance-modes:setFullScreen', false).then(() => true)`);
  await until(`ide.appearanceModes.mode() === null`, 'leaving full screen elsewhere ends the mode', 8000);
  check(q(await layout(t)) === q(before) && (await gutter(t)).fontSize === 14, 'leaving full screen another way ends presentation and restores the layout');

  // Split panes: both editors lose their gutter and come back.
  await js(`(ide.runAction('SplitVertically'), true)`);
  await until(`ide.editors().length === 2`, 'split');
  await runAction(t, 'ToggleDistractionFreeMode');
  await until(`ide.appearanceModes.mode() === 'distractionFree'`, 'df with split');
  check(await js(`ide.editors().every(ed => ed.getOption(ide.monaco.editor.EditorOption.lineNumbers).renderType === 0)`), 'both split editors hide line numbers');
  await runAction(t, 'ToggleDistractionFreeMode');
  await until(`ide.appearanceModes.mode() === null`, 'df left with split');
  check(await js(`ide.editors().every(ed => ed.getOption(ide.monaco.editor.EditorOption.lineNumbers).renderType === 1)`), 'both get them back');

  // An editor disposed during the mode (its split closed) is dropped from the saved options at once.
  await runAction(t, 'ToggleDistractionFreeMode');
  await until(`ide.appearanceModes.mode() === 'distractionFree'`, 'df with split again');
  check(await js(`ide.appearanceModes.savedEditors()`) === 2, 'both split editors have saved gutter options');
  await js(`(ide.runAction('UnsplitAll'), true)`);
  await until(`ide.editors().length === 1`, 'unsplit inside the mode');
  check(await js(`ide.appearanceModes.savedEditors()`) === 1, 'closing a split during the mode drops its disposed editor from the saved options');
  await runAction(t, 'ToggleDistractionFreeMode');
  await until(`ide.appearanceModes.mode() === null`, 'df left after unsplit');
  check(await js(`ide.appearanceModes.savedEditors()`) === 0 && (await gutter(t)).lineNumbers === 1, 'leaving restores the remaining editor and clears the saved options');

  // A gutter option the user changes during the mode keeps the user's value on exit; the others come back, and a
  // settings change during the mode does not hide it again.
  await runAction(t, 'ToggleDistractionFreeMode');
  await until(`ide.appearanceModes.mode() === 'distractionFree'`, 'df for user gutter change');
  await js(`(ide.editor.updateOptions({ lineNumbers: 'relative' }), true)`);
  await js(`(ide.settings.set('editor.fontSize', 15), true)`);
  await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 15`, 'font 15 during df');
  await sleep(200);
  check((await gutter(t)).lineNumbers === 2, 'a settings change during the mode keeps the line numbers the user turned on');
  await runAction(t, 'ToggleDistractionFreeMode');
  await until(`ide.appearanceModes.mode() === null`, 'df left after user gutter change');
  const userGutter = await gutter(t);
  check(userGutter.lineNumbers === 2 && userGutter.glyphMargin === gutterBefore.glyphMargin && userGutter.folding === gutterBefore.folding,
    `leaving keeps the line numbers the user changed during the mode and restores the rest (${q(userGutter)})`);
  await js(`(ide.editor.updateOptions({ lineNumbers: 'on' }), ide.settings.set('editor.fontSize', 14), true)`);
  await until(`ide.editor.getOption(ide.monaco.editor.EditorOption.fontSize) === 14`, 'font back to 14 after df');

  // Settings page.
  await js(`(ide.openSettings('appearanceModes'), true)`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'appearanceModes'`, 'settings page');
  check(await js(`document.querySelector('[data-key="appearance.presentationFontSize"]').value === '24' && document.querySelector('[data-key="appearance.distractionFreeColumns"]').value === '100'`),
    'Settings › Appearance lists the presentation font size (24) and the distraction-free width (100)');
  await js(`(document.querySelector('#settingsCancel').click(), true)`);
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed');

  // A page reload in a full-screen mode (Trust Project reopens the page) must not leave the window full screen with
  // no mode to leave it.
  await runAction(t, 'ToggleZenMode');
  await until(`ide.appearanceModes.mode() === 'zen'`, 'zen before reload');
  await until(`ide.api.invoke('appearance-modes:isFullScreen')`, 'zen full screen before reload', 8000).catch(() => {});
  check(await isFull(t), 'zen is full screen before the reload');
  await t.cdp('Page.reload');
  await sleep(500);
  await until('window.__ideReady === true', 'IDE ready after reload', 30000);
  await until(`ide.api.invoke('appearance-modes:isFullScreen').then(v => !v)`, 'full screen left after reload', 8000).catch(() => {});
  check(!(await isFull(t)) && (await mode(t)) === null, 'after a reload in Zen Mode the window is out of full screen and no mode is on');
} catch (err) {
  check(false, `error: ${err.message}`);
}
t.close();
if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);

// ---------- Korean ----------
const k = await launch({ fixture: 'core', port: 9231, name: 'appearance-modes-ko', lang: 'ko-KR' });
try {
  await openFile(k, 'hello.py');
  const labels = await appearanceMenu(k, '보기', '외관');
  k.check(['프레젠테이션 모드 진입', '방해 금지 모드 진입', '전체 화면 진입', 'Zen 모드 진입'].every((l, i) => labels[i] === l), `Korean View › Appearance (${labels.join(', ')})`);
  await clickMenu(k, 2, '방해 금지 모드 진입');
  await k.until(`ide.appearanceModes.mode() === 'distractionFree'`, 'Korean distraction-free');
  const note = await k.js(`document.getElementById('appearanceModeNotice').textContent`);
  k.check(note.includes('방해 금지 모드') && note.includes('보기 › 외관') && note.includes('액션 찾기'), `Korean notice (${note})`);
  const leaks = await englishLeaks(k, '#appearanceModeNotice');
  k.check(!leaks.length, `no English in the notice (${q(leaks)})`);
  await k.js(`ide.appearanceModes.toggle('distractionFree').then(() => true)`);
  const labels2 = await appearanceMenu(k, '보기', '외관');
  k.check(labels2[1] === '방해 금지 모드 진입', 'Korean label back to 진입 after leaving');
  await k.press('Escape');
  await k.press('Escape');
  await k.press('Escape');
  await k.js(`ide.appearanceModes.toggle('presentation').then(() => true)`);
  const labels3 = await k.js(`ide.actions.find(a => a.id === 'TogglePresentationMode').title`);
  k.check(labels3 === '프레젠테이션 모드 종료', `Korean exit label (${labels3})`);
  await k.js(`ide.appearanceModes.toggle('presentation').then(() => true)`);
  await k.js(`(ide.openSettings('appearanceModes'), true)`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'appearanceModes'`, 'Korean settings page');
  const pageLeaks = await englishLeaks(k, '.settings-page');
  k.check(!pageLeaks.length, `no English on the settings page (${q(pageLeaks)})`);
  await k.js(`(document.querySelector('#settingsCancel').click(), true)`);
  const missing = (await missingTranslations(k)).filter((s) => /Distraction|Zen Mode|Presentation|Full Screen|to exit|Find Action|columns|Font size/.test(s));
  k.check(!missing.length, `no missing translations (${missing.join(' | ')})`);
} catch (err) {
  k.check(false, `error: ${err.message}`);
}
k.close();
if (k.consoleErrors.length) console.log(`renderer exceptions:\n  ${k.consoleErrors.join('\n  ')}`);
const all = [...t.results, ...k.results];
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || t.consoleErrors.length || k.consoleErrors.length ? 1 : 0);
