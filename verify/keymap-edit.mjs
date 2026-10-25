// Settings › Keymap editing: rebind an action (new key runs it, old key does not), tooltips, Find Action and main menu
// hints, the conflict question (Leave / Remove), Remove, Reset, a two-stroke shortcut, an editor action rebound inside
// Monaco (also in an embedded editor), persistence across a restart, malformed and late-registered overrides, Reset All,
// and the Korean UI. Ports 9120-9122.
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const row = (id) => `document.querySelector('.keymap-row[data-id="${id}"]')`;

async function helpers(t) {
  const { js, until, sleep } = t;
  const h = {
    async openKeymap() {
      await js(`(ide.openSettings('keymap'), true)`);
      await until(`document.querySelector('.settings-page')?.dataset.page === 'keymap' && !!document.querySelector('.keymap-row')`, 'Keymap page');
    },
    rowKeys: (id) => js(`[...(${row(id)}?.querySelectorAll('kbd') || [])].map((k) => k.textContent).join(' | ')`),
    modified: (id) => js(`!!${row(id)}?.classList.contains('modified')`),
    async select(id) {
      await js(`(() => { const r = ${row(id)}; r.scrollIntoView({ block: 'nearest' }); r.click(); return true; })()`);
      await until(`${row(id)}.classList.contains('selected')`, `row ${id} selected`);
    },
    clickJs: (sel) => js(`(document.querySelector(${S(sel)}).click(), true)`),
    async capture(first, second) {
      await h.clickJs('#keymapAdd');
      await until(`document.activeElement?.id === 'keymapFirstStroke'`, 'capture field focused');
      await t.press(first);
      if (second) {
        await h.clickJs('#keymapTwoStrokes');
        await until(`document.activeElement?.id === 'keymapSecondStroke'`, 'second stroke field focused');
        await t.press(second);
      }
      await sleep(100);
    },
    captureOk: () => h.clickJs('#keymapCaptureDialog .dialog-buttons .primary'),
    conflictText: () => js(`document.getElementById('keymapConflicts')?.textContent || ''`),
    async closeSettings(button = '#settingsOk') {
      await h.clickJs(button);
      await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
      await js(`(ide.settings.flush(), true)`);
    },
    lines: () => js(`ide.editor.getModel().getLinesContent()`),
    async caret(line) {
      await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 1 }), true)`);
      await until(`ide.editor.hasTextFocus()`, 'editor focus');
    },
    projectVisible: () => js(`ide.toolWindows.get('Project').isVisible()`),
    // An editor embedded the way viewers and notebook cells embed one: not ide.editor, so only Monaco's own keybindings run.
    async embedded() {
      await js(`(() => {
        window.__kmEd?.dispose(); window.__kmModel?.dispose(); document.getElementById('kmHost')?.remove();
        const host = document.createElement('div');
        host.id = 'kmHost';
        host.style.cssText = 'position:fixed;left:40px;top:80px;width:420px;height:160px;z-index:50';
        document.getElementById('editorArea').appendChild(host);
        window.__kmModel = ide.monaco.editor.createModel('a = 1\\nb = 2\\n', 'python');
        window.__kmEd = ide.createEditor(host, { model: __kmModel });
        __kmEd.setPosition({ lineNumber: 1, column: 1 });
        __kmEd.focus();
        return true;
      })()`);
      await until(`window.__kmEd.hasTextFocus() && !ide.editor.hasTextFocus()`, 'embedded editor focus');
    },
    embeddedLine: () => js(`__kmModel.getLineContent(1)`),
    disposeEmbedded: () => js(`(window.__kmEd.dispose(), window.__kmModel.dispose(), document.getElementById('kmHost').remove(), true)`),
  };
  return h;
}

// ======================= instance A: editing =======================
const t = await launch({ fixture: 'keyboard', port: 9120, name: 'keymap-edit' });
const { js, until, press, check, sleep } = t;
const h = await helpers(t);
let userData = t.userData;
try {
  await openFile(t, 'main.py');
  await h.caret(3);

  await h.openKeymap();
  check(await js(`[...document.querySelectorAll('.keymap-row')].some((r) => r.textContent.includes('Find Action') && r.textContent.includes('Ctrl+Shift+A'))`), 'the Keymap page lists actions with their shortcuts');
  check(await js(`!document.querySelector('.keymap-row.modified')`), 'nothing is modified at first');

  // ---------- rebind Tool Window: Project (Alt+1 -> Ctrl+Alt+Shift+1) ----------
  await h.select('ActivateProjectToolWindow');
  check(await h.rowKeys('ActivateProjectToolWindow') === 'Alt+1', 'Project tool window defaults to Alt+1');
  await h.clickJs('#keymapRemove');
  check(await h.rowKeys('ActivateProjectToolWindow') === '' && await h.modified('ActivateProjectToolWindow'), 'Remove takes its only shortcut and marks it modified');
  await h.capture('Ctrl+Alt+Shift+1');
  check(await js(`document.getElementById('keymapFirstStroke').value`) === 'Ctrl+Alt+Shift+1', 'the capture box records the pressed chord');
  check(await h.conflictText() === '', `no conflict for a free chord (${await h.conflictText()})`);
  await h.captureOk();
  await until(`!document.getElementById('keymapCaptureDialog')`, 'capture dialog closed');
  check(await h.rowKeys('ActivateProjectToolWindow') === 'Ctrl+Alt+Shift+1', 'the row shows the new shortcut');
  check(await js(`ide.keysFor('ActivateProjectToolWindow')`) === 'Alt+1', 'nothing applies before OK / Apply');
  await h.clickJs('#keymapModifiedOnly');
  check(await js(`[...document.querySelectorAll('.keymap-row')].map((r) => r.dataset.id).join()`) === 'ActivateProjectToolWindow', 'Show modified only lists just the modified action');
  await h.clickJs('#keymapModifiedOnly');
  await h.clickJs('#settingsApply');
  check(S(await js(`ide.settings.get('keymap.overrides')`)) === S({ ActivateProjectToolWindow: ['Ctrl+Alt+Shift+1'] }), 'Apply stores only the override');

  // ---------- conflict: Ctrl+D for Delete Line, Leave ----------
  await h.select('EditorDeleteLine');
  await h.capture('Ctrl+D');
  check((await h.conflictText()).includes('Duplicate Line'), `the capture dialog warns that Ctrl+D belongs to Duplicate Line (${await h.conflictText()})`);
  await h.captureOk();
  await until(`!!document.getElementById('keymapConflictDialog')`, 'conflict question');
  check(await js(`document.getElementById('keymapConflictDialog').textContent.includes('Duplicate Line')`), 'the question names the other action');
  await js(`([...document.querySelectorAll('#keymapConflictDialog .dialog-buttons button')].find((b) => b.textContent === 'Leave').click(), true)`);
  await until(`!document.getElementById('keymapCaptureDialog') && !document.getElementById('keymapConflictDialog')`, 'dialogs closed after Leave');
  check(await h.rowKeys('EditorDeleteLine') === 'Ctrl+Y | Ctrl+D' && await h.rowKeys('EditorDuplicate') === 'Ctrl+D', 'Leave keeps Ctrl+D on both actions');
  await h.clickJs('#keymapReset');
  check(await h.rowKeys('EditorDeleteLine') === 'Ctrl+Y' && !(await h.modified('EditorDeleteLine')), 'Reset Shortcuts puts Delete Line back to its default');

  // ---------- conflict again, Remove ----------
  await h.capture('Ctrl+D');
  await h.captureOk();
  await until(`!!document.getElementById('keymapConflictDialog')`, 'conflict question again');
  await js(`([...document.querySelectorAll('#keymapConflictDialog .dialog-buttons button')].find((b) => b.textContent === 'Remove').click(), true)`);
  await until(`!document.getElementById('keymapCaptureDialog')`, 'dialogs closed after Remove');
  check(await h.rowKeys('EditorDeleteLine') === 'Ctrl+Y | Ctrl+D' && await h.rowKeys('EditorDuplicate') === '' && await h.modified('EditorDuplicate'),
    'Remove moves Ctrl+D from Duplicate Line to Delete Line');

  // ---------- Remove one of two shortcuts ----------
  await h.clickJs('#keymapRemove');
  await until(`!!document.getElementById('keymapRemoveMenu')`, 'remove menu');
  await js(`(() => { const item = [...document.querySelectorAll('#keymapRemoveMenu .menu-item')].find((i) => i.textContent === 'Remove Ctrl+Y'); item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  check(await h.rowKeys('EditorDeleteLine') === 'Ctrl+D', 'Remove › Remove Ctrl+Y leaves Delete Line with Ctrl+D');

  // ---------- two-stroke shortcut for Duplicate Line ----------
  await h.select('EditorDuplicate');
  await h.capture('Ctrl+Alt+Shift+Y', 'D');
  check(await h.conflictText() === '', `no conflict for the two-stroke chord (${await h.conflictText()})`);
  await h.captureOk();
  await until(`!document.getElementById('keymapCaptureDialog')`, 'capture dialog closed (two strokes)');
  check(await h.rowKeys('EditorDuplicate') === 'Ctrl+Alt+Shift+Y, D', 'the row shows the two-stroke shortcut as "Ctrl+Alt+Shift+Y, D"');

  // ---------- editor action: Comment with Line Comment (Ctrl+/ -> Ctrl+Shift+/) ----------
  await h.select('CommentByLineComment');
  await h.clickJs('#keymapRemove');
  await h.capture('Ctrl+Shift+/');
  await h.captureOk();
  await until(`!document.getElementById('keymapCaptureDialog')`, 'capture dialog closed (comment)');
  check(await h.rowKeys('CommentByLineComment') === 'Ctrl+Shift+/', 'Comment with Line Comment is now Ctrl+Shift+/');
  await h.closeSettings();
  check(S(await js(`ide.settings.get('keymap.overrides')`)) === S({
    ActivateProjectToolWindow: ['Ctrl+Alt+Shift+1'], EditorDeleteLine: ['Ctrl+D'], EditorDuplicate: ['Ctrl+Alt+Shift+Y D'], CommentByLineComment: ['Ctrl+Shift+/'],
  }), `OK stores the overrides (${S(await js(`ide.settings.get('keymap.overrides')`))})`);

  // ---------- the new keys run the actions, the old ones do not ----------
  await h.caret(3);
  const p0 = await h.projectVisible();
  await press('Alt+1');
  check(await h.projectVisible() === p0, 'Alt+1 no longer toggles the Project tool window');
  await press('Ctrl+Alt+Shift+1');
  check(await h.projectVisible() !== p0, 'Ctrl+Alt+Shift+1 toggles it');
  if (await h.projectVisible() !== p0) await press('Ctrl+Alt+Shift+1');
  await h.caret(3);
  const before = await h.lines();
  await press('Ctrl+D');
  let after = await h.lines();
  check(after.length === before.length - 1 && !after.includes(before[2]), 'Ctrl+D now deletes the line');
  await h.caret(2);
  const beforeY = await h.lines();
  await press('Ctrl+Y');
  check(S(await h.lines()) === S(beforeY), 'Ctrl+Y (removed) no longer deletes the line');
  await press('Ctrl+Alt+Shift+Y');
  await press('D');
  after = await h.lines();
  check(after.length === beforeY.length + 1 && after[1] === beforeY[1] && after[2] === beforeY[1], 'Ctrl+Alt+Shift+Y then D duplicates the line, and the D is not typed');

  // ---------- a single-stroke action beside a chord that starts with the same stroke ----------
  // As in PyCharm and VS Code: the single stroke runs when the wait for a second stroke runs out or the second stroke
  // completes no chord (that key is then handled normally); Escape cancels.
  await js(`(window.__single = 0, window.__chord = 0,
    ide.registerAction({ id: 'TestSingleK', title: 'Test Single K', keys: 'Ctrl+Alt+Shift+K', run: () => { window.__single++; } }),
    ide.registerAction({ id: 'TestChordKC', title: 'Test Chord K C', keys: 'Ctrl+Alt+Shift+K C', run: () => { window.__chord++; } }), true)`);
  const counts = () => js(`[window.__single, window.__chord].join(',')`);
  await h.caret(1);
  const beforeChord = await h.lines();
  await press('Ctrl+Alt+Shift+K');
  await press('C');
  check(await counts() === '0,1' && S(await h.lines()) === S(beforeChord), `Ctrl+Alt+Shift+K then C runs the chord only, and the C is not typed (${await counts()})`);
  await press('Ctrl+Alt+Shift+K');
  await sleep(300);
  check(await counts() === '0,1', 'while it waits for a second stroke, the single-stroke action has not run');
  await sleep(1700);
  check(await counts() === '1,1', `when the wait runs out (1.5 s), the single-stroke Ctrl+Alt+Shift+K runs (${await counts()})`);
  await h.caret(1);
  await press('Ctrl+Alt+Shift+K');
  await press('ArrowDown');
  check(await counts() === '2,1' && await js(`ide.editor.getPosition().lineNumber`) === 2,
    `a second stroke that completes no chord runs the single stroke, then is handled as usual (${await counts()}, caret on line ${await js(`ide.editor.getPosition().lineNumber`)})`);
  await press('Ctrl+Alt+Shift+K');
  await press('Escape');
  await sleep(1700);
  check(await counts() === '2,1', `Escape cancels a pending first stroke (${await counts()})`);
  // The real case: Commit… (Ctrl+K) still runs when another action is bound to Ctrl+K C.
  await js(`(() => {
    window.__commit = 0;
    const a = ide.actions.find((x) => x.id === 'CheckinProject');
    window.__commitRun = a.run;
    a.run = () => { window.__commit++; };
    ide.registerAction({ id: 'TestChordCtrlKC', title: 'Test Chord Ctrl+K C', keys: 'Ctrl+K C', run: () => { window.__chord++; } });
    return true;
  })()`);
  await h.caret(1);
  await press('Ctrl+K');
  await press('C');
  check(await js(`window.__commit === 0 && window.__chord === 2`), 'Ctrl+K then C runs the Ctrl+K C chord, not Commit…');
  await press('Ctrl+K');
  await sleep(2000);
  check(await js(`window.__commit === 1`), `Ctrl+K alone still runs Commit… after the wait when Ctrl+K C is bound (${await js('window.__commit')})`);
  await js(`(() => {
    ide.actions.find((x) => x.id === 'CheckinProject').run = window.__commitRun;
    ide.actions = ide.actions.filter((a) => !['TestSingleK', 'TestChordKC', 'TestChordCtrlKC'].includes(a.id));
    return true;
  })()`);
  await h.caret(1);
  const line1 = (await h.lines())[0];
  await press('Ctrl+/');
  check((await h.lines())[0] === line1, 'Ctrl+/ no longer comments in the editor');
  await press('Ctrl+Shift+/');
  check((await h.lines())[0] !== line1 && (await h.lines())[0].replace(/^#\s?/, '') === line1.replace(/^#\s?/, ''), 'Ctrl+Shift+/ toggles the line comment');
  await press('Ctrl+Shift+/');
  check((await h.lines())[0] === line1, 'and toggles it back');

  // Monaco itself: an embedded editor follows the keymap through Monaco keybindings.
  await h.embedded();
  await press('Ctrl+/');
  check(await h.embeddedLine() === 'a = 1', "Monaco's own Ctrl+/ is gone in an embedded editor");
  await press('Ctrl+Shift+/');
  check(/^#\s?a = 1$/.test(await h.embeddedLine()), 'Ctrl+Shift+/ comments in an embedded editor (Monaco keybinding)');
  await h.disposeEmbedded();

  // ---------- tooltips, Find Action, main menu ----------
  check(await js(`(() => { const b = ide.toolWindows.get('Project').button; b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return b.title; })()`) === 'Project (Ctrl+Alt+Shift+1)',
    'the Project stripe button tooltip shows the new shortcut');
  check(await js(`ide.toolWindows.get('Project').keys`) === 'Ctrl+Alt+Shift+1', 'the More Tool Windows list and the View menu use it too');
  await js(`(ide.runAction('GotoAction'), true)`);
  await sleep(300);
  await t.type('Delete Line');
  await sleep(500);
  check(await js(`[...document.querySelectorAll('.popup .list-row, .popup [class*="row"], .se-row')].some((r) => r.textContent.includes('Delete Line') && r.textContent.includes('Ctrl+D'))`)
    || await js(`document.body.innerText.includes('Delete Line') && /Delete Line[\\s\\S]{0,40}Ctrl\\+D/.test(document.body.innerText)`), 'Find Action shows Delete Line with Ctrl+D');
  await press('Escape');
  await js(`(ide.mainMenu.open(), true)`);
  await js(`(() => { const r = [...document.querySelectorAll('#mainMenu .menu-item')].find((x) => x.textContent.startsWith('Edit')); r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  await sleep(200);
  check(await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.textContent.startsWith('Delete Line'))?.querySelector('.hint-right')?.textContent`) === 'Ctrl+D', 'Edit › Delete Line shows Ctrl+D in the main menu');
  check(await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.textContent.startsWith('Duplicate Line'))?.querySelector('.hint-right')?.textContent`) === 'Ctrl+Alt+Shift+Y, D', 'Edit › Duplicate Line shows the two-stroke shortcut');
  await press('Escape');
  await press('Escape');
  await js(`(ide.settings.flush(), true)`);
} catch (e) {
  check(false, `instance A: ${e.message}`);
}
t.close();
if (t.consoleErrors.length) check(false, `renderer exceptions in A: ${t.consoleErrors.join(' | ')}`);
await sleep(1000);

// ======================= instance B: after a restart =======================
const b = await launch({ fixture: 'keyboard', port: 9121, name: 'keymap-edit-restart', userData });
const hb = await helpers(b);
try {
  await openFile(b, 'main.py');
  check(await b.js(`ide.keysFor('ActivateProjectToolWindow')`) === 'Ctrl+Alt+Shift+1' && await b.js(`ide.keysFor('EditorDuplicate')`) === 'Ctrl+Alt+Shift+Y D',
    'the overrides apply at startup');
  await hb.caret(1);
  const p0 = await hb.projectVisible();
  await b.press('Alt+1');
  check(await hb.projectVisible() === p0, 'after a restart Alt+1 still does nothing');
  await b.press('Ctrl+Alt+Shift+1');
  check(await hb.projectVisible() !== p0, 'after a restart Ctrl+Alt+Shift+1 toggles the Project tool window');
  if (await hb.projectVisible() !== p0) await b.press('Ctrl+Alt+Shift+1');
  await hb.embedded();
  await b.press('Ctrl+/');
  check(await hb.embeddedLine() === 'a = 1', "after a restart Monaco's Ctrl+/ stays removed");
  await b.press('Ctrl+Shift+/');
  check(/^#\s?a = 1$/.test(await hb.embeddedLine()), 'after a restart Ctrl+Shift+/ comments through Monaco');
  await hb.disposeEmbedded();

  // ---------- malformed values and late registrations ----------
  await b.js(`(ide.settings.set('keymap.overrides', JSON.parse(${S(S({
    NoSuchAction: ['Ctrl+Q'], ActivateProjectToolWindow: 'Ctrl+Alt+Shift+1', GotoFile: [42, 'Ctrl+Alt+Shift+G', 'Shift+Ctrl+X', '', 'Ctrl+', null, 'A B C'],
    EditorDuplicate: { keys: 1 }, ['__proto__']: ['Ctrl+Q'], 'Test.Late': ['Ctrl+Alt+Shift+L'],
  }))})), true)`);
  await b.sleep(200);
  check(await b.js(`ide.keysFor('GotoFile')`) === 'Ctrl+Alt+Shift+G', 'malformed keys are dropped and the valid one applies');
  check(await b.js(`ide.keysFor('ActivateProjectToolWindow')`) === 'Alt+1' && await b.js(`ide.keysFor('EditorDuplicate')`) === 'Ctrl+D', 'values that are not key lists leave the defaults');
  check(await b.js(`({}).constructor === Object && !Object.prototype.length`), 'a __proto__ entry does not touch Object.prototype');
  await b.js(`(window.__lateRan = 0, ide.registerAction({ id: 'Test.Late', title: 'Late Test Action', keys: 'Ctrl+Alt+Shift+K', run: () => window.__lateRan++ }), true)`);
  check(await b.js(`ide.keysFor('Test.Late')`) === 'Ctrl+Alt+Shift+L', 'an action registered later gets its override');
  await hb.caret(1);
  await b.press('Ctrl+Alt+Shift+L');
  await b.press('Ctrl+Alt+Shift+K');
  check(await b.js(`window.__lateRan`) === 1, 'the late action runs on its override only');
  await hb.openKeymap();
  check(await b.js(`!!document.querySelector('.keymap-row[data-id="GotoFile"].modified')`), 'the Keymap page opens with the malformed setting');

  // ---------- Reset All ----------
  await hb.clickJs('#keymapResetAll');
  check(await b.js(`!document.querySelector('.keymap-row.modified')`), 'Reset All clears every modification');
  await hb.closeSettings();
  check(S(await b.js(`ide.settings.get('keymap.overrides')`)) === '{}', 'Reset All stores no overrides');
  check(await b.js(`ide.keysFor('GotoFile')`) === 'Ctrl+Shift+N' && await b.js(`ide.keysFor('Test.Late')`) === 'Ctrl+Alt+Shift+K', 'defaults are back');
  await hb.caret(2);
  const before = await hb.lines();
  await b.press('Ctrl+D');
  check((await hb.lines()).length === before.length + 1, 'Ctrl+D duplicates the line again');
  await hb.caret(1);
  const l1 = (await hb.lines())[0];
  await b.press('Ctrl+/');
  check((await hb.lines())[0] !== l1, 'Ctrl+/ comments again');
  await hb.embedded();
  await b.press('Ctrl+/');
  check(/^#\s?a = 1$/.test(await hb.embeddedLine()), "Monaco's own Ctrl+/ is back in embedded editors");
  await hb.disposeEmbedded();
} catch (e) {
  check(false, `instance B: ${e.message}`);
}
b.close();
if (b.consoleErrors.length) check(false, `renderer exceptions in B: ${b.consoleErrors.join(' | ')}`);
for (const r of b.results) t.results.push(r);

// ======================= instance C: Korean =======================
const c = await launch({ fixture: 'keyboard', port: 9122, name: 'keymap-edit-ko', lang: 'ko-KR' });
const hc = await helpers(c);
try {
  await openFile(c, 'main.py');
  await hc.openKeymap();
  await hc.select('EditorDeleteLine');
  const leaks = (await englishLeaks(c, '.settings-dialog')).filter((l) => !/keymap-title|keymap-row/.test(l.where));
  check(!leaks.length, `the Korean Keymap page has no English UI text (${S(leaks)})`);
  await hc.capture('Ctrl+D');
  check(/[가-힣]/.test(await hc.conflictText()), 'the conflict warning is Korean');
  check(!(await englishLeaks(c, '#keymapCaptureDialog')).length, `the Keyboard Shortcut dialog is Korean (${S(await englishLeaks(c, '#keymapCaptureDialog'))})`);
  await hc.captureOk();
  await c.until(`!!document.getElementById('keymapConflictDialog')`, 'conflict question (ko)');
  check(!(await englishLeaks(c, '#keymapConflictDialog')).length, `the conflict question is Korean (${S(await englishLeaks(c, '#keymapConflictDialog'))})`);
  await hc.clickJs('#keymapConflictDialog .dialog-buttons button:last-child');
  await hc.clickJs('#keymapCaptureDialog .dialog-buttons button:last-child');
  await hc.clickJs('#keymapRemove');
  await hc.clickJs('#keymapModifiedOnly');
  check(await c.js(`document.querySelectorAll('.keymap-row.modified').length === 1`), 'Korean: the removed shortcut shows as modified');
  const leaks2 = (await englishLeaks(c, '.settings-dialog')).filter((l) => !/keymap-title|keymap-row/.test(l.where));
  check(!leaks2.length, `the Korean Keymap page stays Korean with a modified action (${S(leaks2)})`);
  await hc.closeSettings('#settingsCancel');
  const mine = /Keyboard Shortcut|stroke|Conflicts|Remove|Leave|Reset|modified|Modified|already|key combination|No actions|Warning|Double Shift/;
  const missing = (await missingTranslations(c)).filter((s) => mine.test(s));
  check(!missing.length, `keymap strings have Korean translations (${S(missing)})`);
} catch (e) {
  check(false, `instance C: ${e.message}`);
}
c.close();
if (c.consoleErrors.length) check(false, `renderer exceptions in C: ${c.consoleErrors.join(' | ')}`);
for (const r of c.results) t.results.push(r);
t.finish();
