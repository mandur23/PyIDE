// Search Everywhere (Double Shift): the key gesture, every tab finding its kind and acting on Enter, the All tab's
// groups and "more", recent files, a 12,000-file project, and Korean (ports 9950-9951).
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const OPEN = `!!document.querySelector('#searchEverywhere')`;
const tabOf = `document.querySelector('#searchEverywhere .se-tab.active')?.dataset.tab`;
const labels = `[...document.querySelectorAll('#seList .se-row:not(.se-more) .se-label')].map(n => n.textContent)`;
const activeLabel = `document.querySelector('#seList .se-row.active .se-label')?.textContent`;

const t = await launch({ fixture: 'search-nav', port: 9950, name: 'search-everywhere' });
const { js, until, press, type, click, shot, sleep, project } = t;
let seenErrors = 0;
const check = (ok, label) => {
  t.check(ok, label);
  if (t.consoleErrors.length > seenErrors) { console.log(`  !! renderer exception before/at: ${label}`); seenErrors = t.consoleErrors.length; }
};
const waitFor = (expr, label, ms = 15000) => until(expr, label, ms).then(() => true, () => false);
const doubleShift = async () => { await press('Shift'); await press('Shift'); };
const openSe = async () => {
  await doubleShift();
  const ok = await waitFor(OPEN, 'Search Everywhere open', 10000);
  if (!ok) console.log('  open failed; focus:', await js(`document.activeElement?.outerHTML.slice(0, 120)`), 'menus:', await js(`ide.ui.menuOpen()`), 'dialogs:', await js(`document.querySelector('#dialogHost').childElementCount`));
  return ok;
};
// Replaces the query (it is selected when the popup opens) and waits for the debounced search.
const query = async (text) => { await until(`!!document.querySelector('#seInput')`, 'Search Everywhere input', 10000); await js(`document.querySelector('#seInput').select()`); await type(text); };
const at = (file, line) => js(`ide.activeTab()?.title === ${J(file)} && ide.editor.getPosition()?.lineNumber === ${line}`);

try {
  // Extra files: enough "model" files for the All tab's "more", and their classes for the index.
  for (let i = 1; i <= 7; i++) writeFileSync(path.join(project, `extra_model_${i}.py`), `class ExtraModel${i}:\n    pass\n${i === 1 ? '\n\ndef build_model():\n    pass\n' : ''}`);

  await openFile(t, 'main.py');
  check(await js(`JSON.stringify(ide.actions.find(a => a.id === 'SearchEverywhere').keys) === '["Shift Shift"]' && !ide.actions.find(a => a.id === 'GotoFile').keys.includes('Shift Shift')`),
    'SearchEverywhere owns Double Shift; Go to File keeps Ctrl+Shift+N only');

  // ---- the gesture ----
  await js(`ide.editor.focus()`);
  await press('Shift');
  await sleep(500);
  check(!(await js(OPEN)), 'a single Shift does not open it');
  await press('Shift');
  await sleep(300);
  check(!(await js(OPEN)), 'two Shifts 500 ms apart do not open it');
  await sleep(400);
  await js(`document.activeElement.blur()`);
  await press('Shift');
  await press('Shift+A');
  await press('Shift');
  await sleep(300);
  check(!(await js(OPEN)), 'Shift, Shift+A, Shift does not open it');
  await sleep(400);
  await js(`ide.editor.focus()`);
  check(await openSe(), 'Double Shift opens Search Everywhere');
  check((await js(tabOf)) === 'all', 'it opens on the All tab');
  check(await js(`[...document.querySelectorAll('#searchEverywhere .se-tab')].map(b => b.textContent).join('|') === 'All|Classes|Files|Symbols|Actions|Settings'`), 'tabs: All, Classes, Files, Symbols, Actions, Settings');
  check(await js(`document.activeElement?.id === 'seInput'`), 'the query field has focus');
  await press('Escape');
  check(await waitFor(`!(${OPEN})`, 'closed', 2000), 'Esc closes it');
  check(await js(`ide.editor.hasTextFocus()`), 'focus returns to the editor');

  // ---- Tab / Shift+Tab ----
  await openSe();
  await press('Tab');
  check((await js(tabOf)) === 'classes', 'Tab moves to Classes');
  await press('Tab');
  check((await js(tabOf)) === 'files', 'Tab again moves to Files');
  await press('Shift+Tab');
  await press('Shift+Tab');
  await press('Shift+Tab');
  check((await js(tabOf)) === 'settings', 'Shift+Tab wraps from All to Settings');
  await press('Escape');

  // ---- Files ----
  await openSe();
  await press('Tab');
  await press('Tab');
  await query('models');
  check(await waitFor(`${activeLabel} === 'models.py'`, 'models.py'), 'Files finds models.py');
  check(await js(`!!document.querySelector('#seList .se-row.active .se-icon .file-icon[data-type="python"]')`), 'file rows carry the file type icon');
  check(await js(`document.querySelector('#seList .se-row.active .se-label .sn-hit')?.textContent === 'models'`), 'the matched part is highlighted');
  await shot('se-files.png');
  await press('Enter');
  check(await waitFor(`ide.activeTab()?.title === 'models.py'`, 'models.py opened'), 'Enter opens the file');
  check(!(await js(OPEN)), 'and closes the popup');

  // A line suffix opens the file at that line.
  await openSe();
  await query('main.py:29');
  check(await waitFor(`${activeLabel} === 'main.py'`, 'main.py:29'), 'main.py:29 is found on All');
  await press('Enter');
  check(await waitFor(`ide.activeTab()?.title === 'main.py' && ide.editor.getPosition()?.lineNumber === 29`, 'line 29'), 'main.py:29 opens main.py at line 29');

  // ---- Classes (camel humps) ----
  await openSe();
  await press('Tab');
  await query('OrM');
  check(await waitFor(`${activeLabel} === 'OrderModel'`, 'OrderModel', 30000), `Classes finds OrderModel by camel humps "OrM" (rows ${J(await js(labels))})`);
  check(await js(`[...document.querySelectorAll('#seList .se-row.active .sn-hit')].map(n => n.textContent).join('') === 'OrM'`), 'the hump letters O, r, M are highlighted');
  check(await js(`!!document.querySelector('#seList .se-row.active .sn-icon.k-class')`), 'class rows carry the class icon');
  await press('Enter');
  check(await waitFor(`ide.activeTab()?.title === 'models.py' && ide.editor.getPosition()?.lineNumber === 12`, 'class jump'), 'Enter jumps to class OrderModel (models.py:12)');

  // ---- Symbols ----
  await openSe();
  await press('Tab');
  await press('Tab');
  await press('Tab');
  check((await js(tabOf)) === 'symbols', 'third Tab is Symbols');
  await query('comp_tot');
  check(await waitFor(`${activeLabel} === 'compute_total'`, 'compute_total'), `Symbols finds function compute_total by snake humps "comp_tot" (rows ${J(await js(labels))})`);
  check(await js(`document.querySelector('#seList .se-row.active .se-hint')?.textContent === 'function'`), 'the row says it is a function');
  await press('Enter');
  check(await waitFor(`ide.activeTab()?.title === 'models.py' && ide.editor.getPosition()?.lineNumber === 17`, 'symbol jump'), 'Enter jumps to compute_total (models.py:17)');
  check(await js(`ide.editor.getModel().getValueInRange(ide.editor.getSelection()) === 'compute_total'`), 'and selects its name');

  // ---- Actions ----
  check(!(await js(`ide.toolWindows.get('TODO').isVisible()`)), 'TODO tool window starts hidden');
  await openSe();
  await press('Shift+Tab');
  await press('Shift+Tab');
  check((await js(tabOf)) === 'actions', 'Shift+Tab twice is Actions');
  await query('todo tool');
  check(await waitFor(`${activeLabel} === 'Tool Window: TODO'`, 'TODO action'), `Actions finds "Tool Window: TODO" from "todo tool" (rows ${J(await js(labels))})`);
  await press('Enter');
  check(await waitFor(`ide.toolWindows.get('TODO').isVisible()`, 'TODO shown'), 'Enter runs the action (TODO tool window shown)');
  await openSe();
  await press('Shift+Tab');
  await press('Shift+Tab');
  await query('GoFi');
  check(await waitFor(`${activeLabel} === 'Go to File…'`, 'Go to File'), 'action titles match by word humps ("GoFi")');
  check(await js(`document.querySelector('#seList .se-row.active .se-hint')?.textContent === 'Ctrl+Shift+N'`), 'action rows show their shortcut');
  await press('Escape');

  // ---- Settings ----
  await openSe();
  await press('Shift+Tab');
  check((await js(tabOf)) === 'settings', 'Shift+Tab is Settings');
  await query('');
  check(await waitFor(`${labels}.includes('Keymap') && ${labels}.includes('Python Interpreter')`, 'pages'), 'an empty query lists the settings pages');
  check(await js(`${labels}.length === ide.settingsPageList().length && ide.settingsPages.every(p => ${labels}.includes(p.title()))`),
    'including every page plugins pushed to ide.settingsPages');
  await query('shortcut');
  check(await waitFor(`${activeLabel} === 'Keymap'`, 'Keymap'), 'a keyword ("shortcut") finds the Keymap page');
  check(await js(`document.querySelector('#seList .se-row.active .se-detail')?.textContent.includes('shortcut')`), 'the matched keyword is shown');
  await press('Enter');
  check(await waitFor(`document.querySelector('.settings-page')?.dataset.page === 'keymap'`, 'keymap page'), 'Enter opens Settings on the Keymap page');
  await shot('se-settings-opened.png');
  check(await js(`[...document.querySelectorAll('.settings kbd')].some(k => k.textContent === 'Double Shift')`), 'the Keymap page lists Double Shift');
  await press('Escape');
  await waitFor(`!document.querySelector('.settings-page')`, 'settings closed', 3000);

  // ---- All: groups and "more" ----
  await openSe();
  await query('model');
  check(await waitFor(`[...document.querySelectorAll('#seList .se-group')].map(g => g.dataset.group).join(',').startsWith('classes,files,symbols')`, 'groups'),
    `All shows Classes, Files and Symbols groups for "model" (${J(await js(`[...document.querySelectorAll('#seList .se-group')].map(g => g.textContent)`))})`);
  check(await js(`[...document.querySelectorAll('#seList .se-group')].map(g => g.textContent).join('|').startsWith('Classes|Files|Symbols')`), 'group titles');
  const filesGroup = `(() => { const out = []; let n = document.querySelector('#seList .se-group[data-group=files]')?.nextElementSibling; while (n && !n.classList.contains('se-group')) { out.push(n); n = n.nextElementSibling; } return out; })()`;
  check(await js(`${filesGroup}.filter(n => !n.classList.contains('se-more')).length === 5 && ${filesGroup}.at(-1).classList.contains('se-more')`), 'the Files group shows 5 rows and a "more" link');
  check(await js(`${filesGroup}[0].querySelector('.se-label').textContent === 'models.py'`), 'the best file match leads the group');
  await shot('se-all.png');
  await js(`document.querySelector('#seList .se-group[data-group=files] ~ .se-more').scrollIntoView({ block: 'nearest' })`);
  await click('#seList .se-group[data-group=files] ~ .se-more');
  check(await waitFor(`${tabOf} === 'files' && ${labels}.length === 8`, 'files tab'), `"more" switches to the Files tab with all 8 matches (${J(await js(labels))})`);
  check((await js(`document.querySelector('#seInput').value`)) === 'model', 'the query is kept');
  await press('Escape');

  // Mixed results: a class, files and actions in one list.
  await openSe();
  await query('keymap');
  check(await waitFor(`[...document.querySelectorAll('#seList .se-group')].map(g => g.dataset.group).includes('actions') && [...document.querySelectorAll('#seList .se-group')].map(g => g.dataset.group).includes('settings')`, 'actions+settings'),
    'All also groups Actions and Settings');
  await press('Escape');

  // Empty query: recent files.
  await openSe();
  await query('');
  check(await waitFor(`document.querySelector('#seList .se-group')?.textContent === 'Recent Files' && ${labels}[0] === 'main.py'`, 'recent files'),
    `an empty query shows Recent Files, newest first, without the active file (${J(await js(labels))})`);
  await press('Escape');

  // Enter right after typing waits for the search of that text.
  await openSe();
  await press('Tab');
  await press('Tab');
  await js(`document.querySelector('#seInput').select()`);
  await type('notes');
  await press('Enter');
  check(await waitFor(`ide.activeTab()?.title === 'notes.txt'`, 'notes.txt'), 'Enter pressed before the debounce fires opens the new match, not a stale row');

  // ---- toolbar and menu ----
  await click('#searchBtn');
  check(await waitFor(OPEN, 'from button', 3000), 'the toolbar search button opens Search Everywhere');
  await js(`document.querySelector('.se-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  check(await waitFor(`!(${OPEN})`, 'click outside', 2000), 'a click outside closes it');
  await click('#mainMenuBtn');
  await until(`!!document.querySelector('#mainMenu')`, 'main menu');
  await js(`[...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.firstChild.textContent === 'Navigate').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await until(`document.querySelectorAll('.context-menu').length > 1`, 'navigate submenu');
  const navItems = await js(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].map(n => [n.firstChild.textContent, n.querySelector('.hint-right')?.textContent || ''])`);
  check(navItems.some(([l, h]) => l === 'Search Everywhere' && h === 'Double Shift'), `Navigate menu lists Search Everywhere (Double Shift) (${J(navItems.slice(0, 6))})`);
  await js(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].find(n => n.firstChild.textContent === 'Search Everywhere').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  check(await waitFor(OPEN, 'from menu', 3000), 'the menu entry opens it');
  await press('Escape');

  // ---- a 12,000-file project: debounced, stale answers dropped, rows capped ----
  const big = path.join(project, 'big');
  mkdirSync(big);
  for (let d = 0; d < 40; d++) {
    const dir = path.join(big, `pkg${d}`);
    mkdirSync(dir);
    for (let i = 0; i < 300; i++) writeFileSync(path.join(dir, `module_${d}_${i}.txt`), '');
  }
  writeFileSync(path.join(big, 'pkg7', 'needle_unique_file.txt'), '');
  await openSe();
  await press('Tab');
  await press('Tab');
  await query('module');
  check(await waitFor(`${labels}.length === 100`, 'capped', 20000), `"module" on Files shows at most 100 of 12,000 matches (${await js(`${labels}.length`)})`);
  // Typing fast: only the last text's answer may show.
  await js(`(() => { window.__seRenders = 0; new MutationObserver(() => window.__seRenders++).observe(document.querySelector('#seList'), { childList: true }); })()`);
  const t0 = Date.now();
  await js(`document.querySelector('#seInput').select()`);
  for (const ch of 'needle_uniq') await type(ch);
  check(await waitFor(`${labels}.join() === 'needle_unique_file.txt'`, 'needle', 10000), 'the last text wins after typing fast');
  const ms = Date.now() - t0;
  check(ms < 3000, `typing 11 characters and getting the answer took ${ms} ms`);
  const renders = await js('window.__seRenders');
  check(renders < 11, `keystrokes were debounced: the list re-rendered ${renders} times for 11 keystrokes`);
  const busy = await js(`(async () => { const s = performance.now(); let worst = 0, last = s;
    const el = document.querySelector('#seInput'); el.value = 'mod'; el.dispatchEvent(new Event('input'));
    while (performance.now() - s < 1500) { await new Promise(r => setTimeout(r)); const n = performance.now(); worst = Math.max(worst, n - last); last = n; }
    return Math.round(worst); })()`);
  check(busy < 150, `the renderer never blocked more than ${busy} ms while matching 12,000 files`);
  await press('Escape');
} catch (err) {
  check(false, `error: ${err.message}`);
  await shot('se-error.png').catch(() => {});
}

// ---- Korean ----
const k = await launch({ fixture: 'search-nav', port: 9951, name: 'search-everywhere-ko', lang: 'ko-KR' });
try {
  await openFile(k, 'main.py');
  await k.js(`ide.editor.focus()`);
  await k.press('Shift');
  await k.press('Shift');
  await k.until(OPEN, 'ko open', 3000);
  const tabs = await k.js(`[...document.querySelectorAll('#searchEverywhere .se-tab')].map(b => b.textContent).join('|')`);
  check(tabs === '전체|클래스|파일|심볼|액션|설정', `Korean tab labels (${tabs})`);
  await k.js(`document.querySelector('#seInput').select()`);
  await k.type('설정');
  await k.until(`document.querySelectorAll('#seList .se-group').length > 0`, 'ko results', 10000);
  const leaks = await englishLeaks(k, '#searchEverywhere');
  check(leaks.length === 0, `Korean popup has no English UI text (${J(leaks)})`);
  const mine = new Set([...readFileSync(new URL('../renderer/features/search-everywhere/index.js', import.meta.url), 'utf8').matchAll(/tr\('([^']*)'/g)].map((m) => m[1]));
  const missing = (await missingTranslations(k)).filter((s) => mine.has(s));
  check(missing.length === 0, `no missing translations (${J(missing)})`);
  await k.shot('se-ko.png');
} catch (err) {
  check(false, `ko error: ${err.message}`);
}
k.close();
if (k.consoleErrors.length) t.consoleErrors.push(...k.consoleErrors.map((e) => `[ko] ${e}`));
t.finish();
