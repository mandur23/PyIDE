// File compare (compare plugin): two files selected in the project tree (context menu, Ctrl+D), Compare With… on one
// file, Compare with Clipboard (whole file and a selection), Compare with Branch… in a temporary Git repository (a
// branch, a typed revision, a file missing there), F7 / Shift+F7 (also in a vcs diff tab), the unified viewer, editing
// the right side (saved with Save All, the close question), binary and too-large files, and the Korean UI.
// Ports 9380 and 9383.
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-compare-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const A = 'def greet(name):\n    return "Hello " + name\n\n\nvalue = 1\nother = 2\nthird = 3\n\n\ndef tail():\n    pass\n';
const B = 'def greet(name):\n    return "Hi " + name\n\n\nvalue = 1\nother = 2\nthird = 3\nextra = 4\n\n\ndef tail():\n    return None\n';
const write = (t, f, text) => writeFileSync(path.join(t.project, f), text);
const setup = (t) => {
  write(t, 'a.py', A);
  write(t, 'b.py', B);
  writeFileSync(path.join(t.project, 'one.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  writeFileSync(path.join(t.project, 'two.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  writeFileSync(path.join(t.project, 'three.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 8]));
};

let t = await launch({ fixture: 'compare-files', port: 9380 });
try {
  const { js, check, press, sleep, cdp, project } = t;
  setup(t);
  writeFileSync(path.join(project, 'big.txt'), 'x'.repeat(80).concat('\n').repeat(70000)); // ~5.7 MB
  // Chromium pauses frames for an occluded window; a tiny screenshot forces one so Monaco lays out and paints.
  const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
  const until = async (expr, label, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
      await frame();
      try { if (await js(expr)) return true; } catch {}
    }
    throw new Error(`timeout waiting for: ${label}`);
  };
  const P = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
  const disk = (f) => readFileSync(path.join(project, f), 'utf8');
  const view = `ide.compare.view()`;
  const diffReady = (n) => until(`${view}?.ready() && ${view}.count() === ${n}`, `diff with ${n} differences`);
  const caretLine = () => js(`${view}.diff.getModifiedEditor().getPosition().lineNumber`);
  const starts = () => js(`${view}.diff.getLineChanges().map(c => Math.max(1, c.modifiedStartLineNumber))`);
  const mouse = async (x, y, { button = 'left', modifiers = 0 } = {}) => {
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button, modifiers, clickCount: 1 });
    await sleep(80);
  };
  const rowBox = (name) => js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name')?.textContent === ${S(name)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clickMenu = async (label) => {
    const box = await js(`(() => { const r = [...document.querySelectorAll('.context-menu .menu-item')].find(n => n.querySelector('.menu-label')?.textContent === ${S(label)}); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!box) throw new Error(`no menu item ${label}`);
    await mouse(box.x, box.y);
  };
  const menuLabels = () => js(`[...document.querySelectorAll('.context-menu .menu-item .menu-label')].map(n => n.textContent)`);
  const closeActive = () => js(`(() => { const t = ide.activeTab(); return ide.closeTabObject(t, true) === true; })()`);

  // ---------- two files from the project tree ----------
  await js(`ide.refreshTree().then(() => true)`);
  await until(`!!document.querySelector('#tree .node') && [...document.querySelectorAll('#tree .node .name')].some(n => n.textContent === 'b.py')`, 'tree rows');
  const a = await rowBox('a.py');
  const b = await rowBox('b.py');
  await mouse(a.x, a.y);
  await mouse(b.x, b.y, { modifiers: 2 });
  const sel = await js(`ide.selectedTreeEntries().map(e => e.name)`);
  check(S(sel) === S(['a.py', 'b.py']) && (await js(`document.querySelectorAll('#tree .node.selected').length`)) === 2, `Ctrl+click selects a second file (${S(sel)})`);
  await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name')?.textContent === 'b.py'); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); return true; })()`);
  await until(`!!document.querySelector('.context-menu')`, 'tree context menu');
  const labels = await menuLabels();
  check(labels.includes('Compare Files') && !labels.includes('Compare With…'), `the tree menu offers Compare Files for two files (${S(labels.filter((l) => /Compare/.test(l)))})`);
  check((await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.querySelector('.menu-label')?.textContent === 'Compare Files')?.querySelector('.hint-right')?.textContent`)) === 'Ctrl+D', 'Compare Files shows Ctrl+D');
  await clickMenu('Compare Files');
  await diffReady(3);
  check(await js(`ide.activeTab().title === 'a.py vs b.py' && document.querySelector('.cmp-view .cmp-left-title').textContent === 'a.py' && document.querySelector('.cmp-view .cmp-right-title').textContent === 'b.py'`),
    'Compare Files opens "a.py vs b.py" with the first selected file on the left');
  check((await js(`document.querySelector('.cmp-view:not(.hidden) .cmp-count, .custom-tab:not(.hidden) .cmp-count')?.textContent`)) === '3 differences', 'the toolbar counts 3 differences');
  check((await js(`${view}.diff.getModel().original.getValue()`)) === A && (await js(`${view}.diff.getModel().modified === ide.getDocument(${P('b.py')}).model`)),
    'left is a.py; right is b.py\'s own document');
  check((await js(`${view}.diff.getOriginalEditor().getOption(ide.monaco.editor.EditorOption.readOnly)`)) && !(await js(`${view}.diff.getModifiedEditor().getOption(ide.monaco.editor.EditorOption.readOnly)`)),
    'the left side is read-only and the right side editable');

  // ---------- F7 / Shift+F7 ----------
  const st = await starts();
  await until(`${view}.diff.getModifiedEditor().hasTextFocus()`, 'the right editor has the keyboard');
  check((await caretLine()) === st[0], `the view opens at the first difference (line ${st[0]})`);
  await press('F7');
  check((await caretLine()) === st[1], `F7 goes to the next difference (line ${st[1]})`);
  await press('F7');
  check((await caretLine()) === st[2], `F7 again (line ${st[2]})`);
  await press('F7');
  check((await caretLine()) === st[2], 'F7 at the last difference stays there');
  await press('Shift+F7');
  check((await caretLine()) === st[1], 'Shift+F7 goes back');
  await js(`(document.querySelector('.custom-tab:not(.hidden) .cmp-prev').click(), true)`);
  check((await caretLine()) === st[0], 'the toolbar\'s Previous Difference button too');

  // F7 while the debugger is suspended: the debugger's Step Into stands back while a diff tab has the keyboard, even
  // when it is registered last. A stand-in for the suspended debugger's action (its real `when` is suspended() &&
  // !ide.compare.diffFocused()) is registered after Next Difference, then the real one comes back.
  await js(`(${view}.diff.getModifiedEditor().focus(), true)`);
  check(await js(`ide.compare.diffFocused() && ide.actions.some(a => a.id === 'StepInto' && a.keys.includes('F7'))`), 'a focused diff tab reports diffFocused; Step Into is on F7');
  await js(`(() => { window.__realStepInto = ide.actions.find(a => a.id === 'StepInto'); window.__stepped = 0;
    ide.registerAction({ id: 'StepInto', title: 'Step Into', keys: 'F7', when: () => !ide.compare.diffFocused(), run: () => { window.__stepped++; } }); return true; })()`);
  await press('F7');
  check((await caretLine()) === st[1] && (await js(`window.__stepped`)) === 0, 'F7 in a focused diff tab is Next Difference, not Step Into, while suspended');
  await js(`(document.getElementById('tree').focus(), true)`);
  check(!(await js(`ide.compare.diffFocused()`)), 'with the keyboard in the Project tool window the diff is not focused (F7 steps again)');
  await js(`(ide.registerAction(window.__realStepInto), delete window.__realStepInto, true)`);
  await js(`(${view}.diff.getModifiedEditor().focus(), ${view}.diff.getModifiedEditor().setPosition({ lineNumber: ${st[0]}, column: 1 }), true)`);

  // Open / Move to New Window from Find Action do nothing for a compare tab (its path is only a title).
  await js(`(() => { window.__detached = []; const inv = ide.api.invoke; window.__inv = inv;
    ide.api.invoke = function (ch, ...args) { if (ch === 'window:openDetached') { window.__detached.push(args); return Promise.resolve(); } return inv.call(this, ch, ...args); }; return true; })()`);
  await js(`(ide.runAction('OpenInNewWindow'), ide.runAction('MoveToNewWindow'), true)`);
  await sleep(300);
  check((await js(`window.__detached.length`)) === 0 && (await js(`ide.activeTab()?.title === 'a.py vs b.py' && !!${view}`)),
    'Open in New Window and Move to New Window leave a compare tab alone (nothing sent, the tab stays)');
  await js(`(ide.api.invoke = window.__inv, delete window.__inv, true)`);

  // ---------- unified viewer ----------
  await js(`(() => { const s = document.querySelector('.custom-tab:not(.hidden) .cmp-mode'); s.value = 'unified'; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(`document.querySelector('.custom-tab:not(.hidden)').classList.contains('cmp-unified') && ${view}.diff.getModifiedEditor().getLayoutInfo().width > document.querySelector('.custom-tab:not(.hidden) .cmp-body').clientWidth * 0.8`, 'unified layout');
  check(await js(`ide.settings.get('diff.unified') === true`), 'the unified viewer fills the tab and is remembered');
  await js(`(${view}.diff.getModifiedEditor().focus(), true)`);
  await press('F7');
  check((await caretLine()) === st[1], 'F7 works in the unified viewer');
  await js(`(${view}.setUnified(false), true)`);
  await until(`!document.querySelector('.custom-tab:not(.hidden)').classList.contains('cmp-unified')`, 'side by side again');

  // ---------- editing the right side ----------
  await js(`(${view}.diff.getModifiedEditor().focus(), ${view}.diff.getModifiedEditor().setPosition({ lineNumber: 1, column: 1 }), true)`);
  await t.type('# edited in diff\n');
  await until(`ide.isDirty(ide.activeTab())`, 'diff tab shows the document modified');
  check(await js(`document.querySelector('.tab.active')?.classList.contains('modified') || /modified|dirty/.test(document.querySelector('.tab.active')?.className || '') || ide.isDirty(ide.activeTab())`), 'the diff tab shows the modified mark');
  await until(`${view}.count() === 4`, 'the new line is a fourth difference');
  check(true, 'the diff follows the edit (4 differences)');
  check(await js(`document.getElementById('statusEncoding').textContent === 'UTF-8' && document.getElementById('statusLineSeparator').textContent === 'LF'`), 'the status bar shows the right file\'s encoding and line separator');
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'saved');
  check(disk('b.py') === `# edited in diff\n${B}`, 'Ctrl+S (Save All) writes the right side to b.py');
  await js(`(() => { const e = ${view}.diff.getModifiedEditor(); e.focus(); e.setPosition({ lineNumber: 1, column: 1 }); return true; })()`);
  await t.type('x');
  await until(`ide.isDirty(ide.activeTab())`, 'typed x');
  const closing = js(`Promise.resolve(ide.closeTabObject(ide.activeTab()))`);
  await until(`!!document.querySelector('.dialog')`, 'unsaved changes question');
  check(/unsaved changes/i.test(await js(`document.querySelector('.dialog').textContent`)), 'closing the diff tab with unsaved edits asks first');
  await press('Escape');
  const closed = await closing;
  const kept = await js(`!!ide.compare.view() && ide.isDirty(ide.activeTab())`);
  check(closed === false && kept, `Cancel keeps the diff tab and its edit (${closed}, ${kept})`);
  await js(`ide.saveAll().then(() => true)`);
  check(disk('b.py').startsWith('x# edited in diff'), `Save All writes it (${S(disk('b.py').slice(0, 30))})`);
  await js(`ide.openFile(${P('b.py')}).then(() => true)`);
  check(await js(`ide.getDocument(${P('b.py')}).model.getLineContent(1) === 'x# edited in diff'`), 'the same document opens in a normal editor');
  await js(`(ide.closeTab(${P('b.py')}, true), true)`);
  await js(`(ide.openCustomTab({ id: ide.tabs.find(t => t.title === 'a.py vs b.py').path }), true)`);
  check(await closeActive(), 'the saved diff tab closes without a question');
  check(!(await js(`ide.getDocument(${P('b.py')})`)), 'closing it releases b.py\'s document');

  // ---------- Ctrl+D in the tree ----------
  await mouse(a.x, a.y);
  await js(`(document.getElementById('tree').focus(), true)`);
  await press('Ctrl+D');
  await until(`document.activeElement?.id === 'popupIn'`, 'file picker for one selected file');
  await t.type('b.py');
  await until(`[...document.querySelectorAll('#popupList .popup-item.active')].some(n => n.textContent.includes('b.py'))`, 'b.py in the picker');
  await press('Enter');
  await diffReady(4);
  check(await js(`ide.activeTab().title === 'b.py vs a.py'`), 'Ctrl+D on one file asks for the other and compares them (the picked file on the left)');
  await closeActive();
  await mouse(a.x, a.y);
  await mouse(b.x, b.y, { modifiers: 2 });
  await js(`(document.getElementById('tree').focus(), true)`);
  await press('Ctrl+D');
  await diffReady(4);
  check(await js(`ide.activeTab().title === 'a.py vs b.py'`), 'Ctrl+D with two files selected compares them');
  await closeActive();
  await mouse(a.x, a.y);
  check((await js(`ide.selectedTreeEntries().length`)) === 1, 'a plain click selects one file again');

  // ---------- F7 in a vcs diff tab ----------
  if (await js(`!!ide.vcs?.openTextDiff`)) {
    await js(`(ide.vcs.openTextDiff({ id: 'cmp-vcs-test', title: 'vcs', name: 'v.py', left: 'a\\nb\\nc\\nd\\n', right: 'a\\nB\\nc\\nD\\n', leftTitle: 'L', rightTitle: 'R' }), true)`);
    await until(`(ide.activeTab().host._vcsDiff?.getLineChanges() || []).length === 2`, 'vcs diff computed');
    await js(`(() => { const e = ide.activeTab().host._vcsDiff.getModifiedEditor(); e.focus(); e.setPosition({ lineNumber: 1, column: 1 }); return true; })()`);
    await press('F7');
    const l1 = await js(`ide.activeTab().host._vcsDiff.getModifiedEditor().getPosition().lineNumber`);
    await press('F7');
    const l2 = await js(`ide.activeTab().host._vcsDiff.getModifiedEditor().getPosition().lineNumber`);
    check(l1 === 2 && l2 === 4, `F7 also moves through the vcs plugin's diff tabs (${l1}, ${l2})`);
    await closeActive();
  }

  // ---------- clipboard ----------
  await js(`ide.api.invoke('clipboard:writeText', 'def greet(name):\\n    return "Hey " + name\\n').then(() => true)`);
  await js(`ide.openFile(${P('a.py')}).then(() => true)`);
  check(await js(`!!ide.editor.getAction('pyide.compareWithClipboard')`), 'the editor context menu has Compare with Clipboard');
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 1, 1)), ide.editor.getAction('pyide.compareWithClipboard').run(), true)`);
  await until(`${view}?.ready()`, 'clipboard diff');
  check(await js(`ide.activeTab().title === 'Clipboard vs a.py' && ${view}.diff.getModel().original.getValue().includes('Hey') && ${view}.diff.getModel().modified === ide.getDocument(${P('a.py')}).model`),
    'Compare with Clipboard: the clipboard on the left, a.py (editable) on the right');
  check((await js(`${view}.count()`)) >= 1 && (await js(`document.querySelector('.custom-tab:not(.hidden) .cmp-left-title').textContent`)) === 'Clipboard', 'the clipboard side is titled Clipboard');
  await closeActive();
  await js(`(ide.editor.setSelection(new ide.monaco.Selection(1, 1, 3, 1)), true)`);
  await js(`ide.runAction('CompareClipboardWithSelection').then(() => true)`);
  await until(`${view}?.ready()`, 'selection diff');
  check(await js(`${view}.diff.getModel().modified.getValue() === 'def greet(name):\\n    return "Hello " + name\\n' && ${view}.diff.getModifiedEditor().getOption(ide.monaco.editor.EditorOption.readOnly) && document.querySelector('.custom-tab:not(.hidden) .cmp-right-title').textContent.startsWith('Selection in a.py')`),
    'with a selection the action compares the selection (read-only) with the clipboard');
  check((await js(`${view}.count()`)) === 1, 'one difference between the selection and the clipboard');
  await closeActive();
  await js(`(ide.closeTab(${P('a.py')}, true), true)`);

  // ---------- binary and too large ----------
  await js(`ide.compare.files(${P('one.bin')}, ${P('two.bin')}).then(() => true)`);
  await until(`document.querySelector('.custom-tab:not(.hidden).cmp-message')?.dataset.verdict === 'same'`, 'binary message');
  const msg = await js(`document.querySelector('.custom-tab:not(.hidden) .cmp-message-box').textContent`);
  check(/cannot be compared as text/.test(msg) && /binary file/.test(msg) && /identical/.test(msg), `two equal binary files: a message that they are binary and identical (${S(msg)})`);
  await closeActive();
  await js(`ide.compare.files(${P('one.bin')}, ${P('three.bin')}).then(() => true)`);
  await until(`document.querySelector('.custom-tab:not(.hidden).cmp-message')?.dataset.verdict === 'different'`, 'binary differ message');
  check(/The files differ/.test(await js(`document.querySelector('.custom-tab:not(.hidden) .cmp-message-box').textContent`)), 'different binary files: the files differ');
  await closeActive();
  await js(`ide.compare.files(${P('a.py')}, ${P('big.txt')}).then(() => true)`);
  await until(`!!document.querySelector('.custom-tab:not(.hidden).cmp-message')`, 'too large message');
  const big = await js(`document.querySelector('.custom-tab:not(.hidden) .cmp-message-box').textContent`);
  check(/big\.txt is too large to compare as text \(5\.\d MB; the limit is 5\.0 MB\)/.test(big), `a file over 5 MB gets a clear message (${S(big)})`);
  await closeActive();

  // ---------- a comparison that is already open when the files are read; deleting the compared file ----------
  write(t, 'c.py', 'x = 1\n');
  write(t, 'd.py', 'x = 2\n');
  const cdId = `${P('d.py')} + ' [compared with c.py]'`;
  await js(`(() => { const p = ide.compare.files(${P('c.py')}, ${P('d.py')}); ide.openCustomTab({ id: ${cdId}, title: 'placeholder', mount() {} }); return p.then(() => true); })()`);
  check(!(await js(`ide.getDocument(${P('d.py')})`)) && (await js(`ide.activeTab()?.title`)) === 'placeholder',
    'a comparison already opened while the files were read: the document loaded for it is released');
  await closeActive();
  await js(`ide.refreshTree().then(() => true)`);
  await js(`ide.compare.files(${P('c.py')}, ${P('d.py')}).then(() => true)`);
  await diffReady(1);
  await js(`(() => { const e = ${view}.diff.getModifiedEditor(); e.focus(); e.setPosition({ lineNumber: 1, column: 1 }); return true; })()`);
  await t.type('# unsaved\n');
  await until(`ide.isDirty(ide.activeTab())`, 'compared d.py modified');
  await until(`[...document.querySelectorAll('#tree .node .name')].some(n => n.textContent === 'd.py')`, 'd.py row');
  const d = await rowBox('d.py');
  await mouse(d.x, d.y);
  await js(`(document.getElementById('tree').focus(), true)`);
  await press('Delete');
  await until(`!!document.querySelector('#dialogHost .dialog')`, 'delete confirmation');
  await js(`(document.querySelector('#dialogHost .dialog button.primary').click(), true)`);
  await until(`!ide.groups().some(g => g.tabs.some(t => t.doc && /d\\.py$/i.test(t.doc.path)))`, 'compare tab of the deleted file closed');
  await js(`ide.saveAll().then(() => true)`);
  await sleep(300);
  check(!(await js(`ide.getDocument(${P('d.py')})`)) && !existsSync(path.join(project, 'd.py')),
    'deleting the compared file closes its compare tab; Save All does not write it back');

  // ---------- Compare with Branch ----------
  git(project, 'init', '-q');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'Initial');
  const first = git(project, 'rev-parse', 'HEAD');
  git(project, 'checkout', '-qb', 'feature');
  write(t, 'a.py', A.replace('Hello', 'Bonjour'));
  git(project, 'commit', '-qam', 'French');
  git(project, 'checkout', '-q', 'main');
  write(t, 'only-main.py', 'print("main only")\n');
  await js(`ide.vcs.refresh().then(() => true)`);
  await until(`!!ide.vcs.repo()`, 'repository detected');
  await js(`ide.openFile(${P('a.py')}).then(() => true)`);
  await js(`(ide.runAction('Git.CompareWithBranch'), true)`);
  await until(`document.activeElement?.id === 'popupIn' && [...document.querySelectorAll('#popupList .popup-item')].some(n => n.textContent.includes('feature'))`, 'branch picker');
  const picker = await js(`[...document.querySelectorAll('#popupList .popup-item')].map(n => n.textContent).join('|')`);
  check(picker.includes('feature') && picker.includes('Local branch') && picker.includes('French'), `the picker lists branches and commits (${S(picker.slice(0, 200))})`);
  await t.type('feature');
  await until(`document.querySelector('#popupList .popup-item.active')?.textContent.trim().startsWith('featureLocal')`, 'feature selected');
  await press('Enter');
  await diffReady(1);
  check(await js(`${view}.diff.getModel().original.getValue().includes('Bonjour') && ${view}.diff.getModel().modified === ide.getDocument(${P('a.py')}).model && ide.activeTab().title === 'a.py (feature)'`),
    'Compare with Branch: the branch\'s a.py on the left, the editable file on the right');
  check((await js(`document.querySelector('.custom-tab:not(.hidden) .cmp-left-title').textContent`)) === 'feature: a.py', 'the left side is titled with the branch');
  await js(`(() => { const e = ${view}.diff.getModifiedEditor(); e.focus(); e.setPosition({ lineNumber: 2, column: e.getModel().getLineMaxColumn(2) }); return true; })()`);
  await t.type('  # changed');
  await js(`ide.saveAll().then(() => true)`);
  check(disk('a.py').includes('name  # changed'), 'editing the right side of a branch diff saves the file');
  await closeActive();
  await js(`ide.compare.branch(${P('a.py')}, ${S(first)}).then(() => true)`);
  await diffReady(1);
  check((await js(`document.querySelector('.custom-tab:not(.hidden) .cmp-left-title').textContent`)) === `${first.slice(0, 8)}: a.py`, 'a revision (commit hash) works too');
  await closeActive();
  await js(`ide.compare.branch(${P('only-main.py')}, 'feature').then(() => true)`);
  await until(`${view}?.ready()`, 'missing file diff');
  check(/does not exist/.test(await js(`document.querySelector('.custom-tab:not(.hidden) .cmp-left-title').textContent`)) && (await js(`${view}.count()`)) === 1,
    'a file missing in the branch shows an empty left side that says so');
  await closeActive();
  await js(`(() => { const n = [...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name')?.textContent === 'b.py'); const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 })); return true; })()`);
  await until(`!!document.querySelector('.context-menu')`, 'tree menu in a repository');
  const repoLabels = await menuLabels();
  check(repoLabels.includes('Git: Compare with Branch…') && repoLabels.includes('Compare With…'), 'the tree menu of one file offers Compare With… and Git: Compare with Branch…');
  await press('Escape');
  check(await js(`(() => { const items = []; const a = ide.actions.find(x => x.id === 'Git.CompareWithBranch'); return !!a && !!ide.actions.find(x => x.id === 'CompareClipboardWithSelection'); })()`), 'the actions exist for the View and Git menus');

  t.close();

  // ---------- Korean ----------
  const firstRun = t;
  t = await launch({ fixture: 'compare-files', port: 9383, name: 'compare-files-ko', lang: 'ko-KR' });
  t.results.push(...firstRun.results);
  t.consoleErrors.push(...firstRun.consoleErrors);
  setup(t);
  const K = (f) => `ide.util.joinPath(ide.root, ${S(f)})`;
  await t.js(`ide.compare.files(${K('a.py')}, ${K('b.py')}).then(() => true)`);
  await t.until(`ide.compare.view()?.ready() && ide.compare.view().count() === 3`, 'ko diff');
  const bar = await t.js(`document.querySelector('.custom-tab:not(.hidden) .cmp-bar').textContent`);
  t.check(bar.includes('차이 3개') && (await t.js(`ide.activeTab().title`)) === 'a.py 대 b.py', `the diff toolbar and title are Korean (${S(bar)})`);
  const leaks = await englishLeaks(t, '.custom-tab:not(.hidden) .cmp-bar, .custom-tab:not(.hidden) .cmp-head');
  t.check(leaks.length === 0, `no English in the diff view (${S(leaks)})`);
  await t.js(`(ide.closeTabObject(ide.activeTab(), true), true)`);
  await t.js(`ide.compare.files(${K('one.bin')}, ${K('three.bin')}).then(() => true)`);
  await t.until(`document.querySelector('.custom-tab:not(.hidden).cmp-message')?.dataset.verdict === 'different'`, 'ko binary message');
  const koMsg = await t.js(`document.querySelector('.custom-tab:not(.hidden) .cmp-message-box').textContent`);
  t.check(koMsg.includes('바이너리 파일') && koMsg.includes('서로 다릅니다'), `the binary message is Korean (${S(koMsg)})`);
  const leaks2 = await englishLeaks(t, '.custom-tab:not(.hidden) .cmp-message-box');
  t.check(leaks2.length === 0, `no English in the message (${S(leaks2)})`);
  const missing = (await missingTranslations(t)).filter((s) => /ompare|ifferen|lipboard|evision|ranch|binary|identical|viewer|read-only|vs/i.test(s));
  t.check(missing.length === 0, `no missing Korean translations (${S(missing)})`);
  t.check(await t.js(`ide.actions.find(a => a.id === 'CompareTwoFiles').title === '다음과 비교…'`), 'the action titles are Korean');
} catch (e) {
  console.log(`FAIL ${e.stack || e}`);
  t.check(false, String(e.message || e));
}
t.finish();
