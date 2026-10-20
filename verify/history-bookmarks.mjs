// Local History and Bookmarks. History: a save adds a revision, Show History diffs a revision against the current
// text, Revert Selected Changes and Revert put old text back, outside changes and deletions are recorded, a deleted
// file is recovered from the project history, and a Git rollback is preceded by a label. Bookmarks: F11 toggles,
// Ctrl+F11 assigns a mnemonic, Ctrl+digit jumps, bookmarks follow edits, the Alt+2 tool window lists them, and both
// bookmarks and history survive a restart. Then the same surfaces in Korean. Ports 9710-9712.
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, writeFileSync, appendFileSync, unlinkSync, existsSync, mkdtempSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-history-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const read = (p) => readFileSync(p, 'utf8');
const ORIGINAL_MAIN = read(new URL('./fixtures/history/main.py', import.meta.url));

function helpers(t) {
  const { js, click } = t;
  const abs = (rel) => `ide.util.joinPath(ide.root, ${JSON.stringify(rel.replace(/\//g, '\\'))})`;
  return {
    // Revision kinds of a file (or of a folder's files), newest first.
    kinds: (rel, dir = false) => js(`ide.api.invoke('localHistory:list', ide.root, ${rel ? abs(rel) : 'ide.root'}, ${dir}).then(r => r.revisions.map(x => x.k))`),
    labels: () => js(`ide.api.invoke('localHistory:list', ide.root, ide.root, true).then(r => r.labels.map(l => l.l))`),
    // The diff of the active history tab.
    diff: (expr) => js(`(() => { const d = ide.activeTab()?.host?._lhDiff; return d ? (${expr}) : null; })()`),
    // Clicks the first visible element matching `selector` whose text contains `text`.
    async clickText(selector, text) {
      const id = await js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.offsetParent && n.textContent.includes(${JSON.stringify(text)})); if (!n) return null; n.id ||= 'hbTmp' + Math.random().toString(36).slice(2); return n.id; })()`);
      if (!id) throw new Error(`no visible ${selector} containing ${text}`);
      await click(`#${id}`);
    },
    caretTo: (line) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 1 }), true)`),
    marks: () => js(`ide.bookmarks.list().map(m => ({ file: ide.util.basename(m.path), line: m.line, mnemonic: m.mnemonic || '', description: m.description || '' }))`),
  };
}

let before = null;
const t = await launch({ fixture: 'history', port: 9710, name: 'history' });
const { js, until, press, type, click, check, shot } = t;
const h = helpers(t);
const file = (rel) => path.join(t.project, rel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await until(`ide.localHistory.ready().then(Boolean)`, 'local history open');
  check((await h.kinds('', true)).length === 0, 'opening a project records nothing until a file is opened or changes');

  // ---------- a save is a revision ----------
  for (const f of ['notes.txt', 'util.py', 'pkg/mod.py']) await openFile(t, f);
  await openFile(t, 'main.py');
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'main.py'), false).then(r => r.revisions.map(x => x.k).join() === 'initial')`, 'initial revision');
  check(true, 'opening a file in the editor records its initial content');
  await js(`(ide.activeTab().model.pushEditOperations([], [{ range: new ide.monaco.Range(4, 1, 4, 1), text: '# greeting helper\\n' }], () => null), true)`);
  await h.caretTo(1);
  await press('Ctrl+S');
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'main.py'), false).then(r => r.revisions.length === 2)`, 'save revision');
  check((await h.kinds('main.py')).join() === 'save,initial', 'saving adds a "save" revision');
  await js(`(ide.saveAll(), true)`);
  await sleep(600);
  check((await h.kinds('main.py')).length === 2, 'a save that changes nothing adds no revision, and the watcher does not report the save again');

  // ---------- Show History: diff against the current text ----------
  await js(`(ide.runAction('LocalHistory.ShowHistory'), true)`);
  await until(`document.querySelectorAll('.lh-view:not(.hidden) .lh-row').length === 2 && ide.activeTab()?.title === 'Local History: main.py'`, 'history tab');
  check(await js(`[...document.querySelectorAll('.lh-row .lh-kind')].map(n => n.textContent).join('|')`) === 'Saved|Initial content', 'the history lists Saved and Initial content, newest first');
  await h.clickText('.lh-row', 'Initial content');
  await until(`ide.activeTab().host._lhDiff?.getLineChanges()?.length === 1`, 'diff with one change');
  check(await h.diff(`d.getLineChanges()[0].originalEndLineNumber === 0 && d.getModifiedEditor().getModel().getLineContent(d.getLineChanges()[0].modifiedStartLineNumber) === '# greeting helper'`),
    'the diff shows the added line as the only change');
  check(await h.diff(`d.getModifiedEditor().getModel() === ide.getDocument(ide.util.joinPath(ide.root, 'main.py')).model`), 'the current side is the live document');
  check(await js(`[...document.querySelectorAll('.lh-diff-head .lh-side-title')].map(n => n.textContent).join('|')`).then((s) => /\(read-only\)\|Current$/.test(s)), 'the diff header names the revision (read-only) and Current');
  await shot('history-diff.png');

  // ---------- Revert Selected Changes ----------
  await js(`(() => { const m = ide.getDocument(ide.util.joinPath(ide.root, 'main.py')).model; const l = m.findMatches('print(greet("world"))', false, false, true, null, false)[0].range.startLineNumber;
    m.pushEditOperations([], [{ range: new ide.monaco.Range(l, 1, l, m.getLineMaxColumn(l)), text: '    print(greet("PyIDE"))' }], () => null); return true; })()`);
  await js(`ide.saveAll().then(() => true)`);
  await until(`ide.activeTab().host._lhDiff?.getLineChanges()?.length === 2`, 'two changes');
  check(await js(`document.querySelector('.lh-row.selected')?.textContent.includes('Initial content')`), 'the selected revision stays selected when a new revision arrives');
  await h.diff(`(d.getModifiedEditor().setPosition({ lineNumber: d.getLineChanges()[1].modifiedStartLineNumber, column: 3 }), true)`);
  await click('.lh-view:not(.hidden) .lh-revert-selected');
  await until(`ide.activeTab().host._lhDiff?.getLineChanges()?.length === 1`, 'one change left');
  await until(`ide.api.read(ide.util.joinPath(ide.root, 'main.py')).then(s => s.includes('greet("world")'))`, 'saved after revert selected');
  const afterSelected = read(file('main.py'));
  check(afterSelected.includes('print(greet("world"))') && afterSelected.includes('# greeting helper'), 'Revert Selected Changes puts back only the change at the caret and saves the file');
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'main.py'), false).then(r => r.revisions[0].k === 'revert')`, 'revert revision');
  check(true, 'the reverted state is recorded as a "revert" revision');

  // ---------- Revert the whole file ----------
  await h.clickText('.lh-row', 'Initial content');
  await click('.lh-view:not(.hidden) .lh-revert');
  await until(`ide.api.read(ide.util.joinPath(ide.root, 'main.py')).then(s => !s.includes('# greeting helper'))`, 'whole revert');
  check(read(file('main.py')) === ORIGINAL_MAIN, 'Revert restores the file to the selected revision');
  check(await js(`ide.getDocument(ide.util.joinPath(ide.root, 'main.py')).model.getValue() === ${JSON.stringify(ORIGINAL_MAIN)} && !ide.isDirty(ide.findTab(ide.util.joinPath(ide.root, 'main.py')))`), 'the open document shows the reverted text and is saved');
  check(await js(`(ide.getDocument(ide.util.joinPath(ide.root, 'main.py')).model.undo(), ide.getDocument(ide.util.joinPath(ide.root, 'main.py')).model.getValue().includes('# greeting helper'))`), 'the revert is one undoable edit');
  await js(`(ide.getDocument(ide.util.joinPath(ide.root, 'main.py')).model.redo(), true)`);
  await until(`document.querySelector('.lh-view:not(.hidden) .lh-row.label')`, 'label row');
  check((await h.labels()).includes('Before Local History Revert'), 'a revert is preceded by a "Before Local History Revert" label');

  // ---------- outside changes and labels ----------
  appendFileSync(file('util.py'), '\n# changed outside\n');
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'util.py'), false).then(r => r.revisions[0]?.k === 'external')`, 'external revision', 8000);
  check(true, 'a change made outside the IDE is recorded by the watcher');
  writeFileSync(file('pkg/new_mod.py'), 'NEW = True\n');
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'pkg\\\\new_mod.py'), false).then(r => r.revisions[0]?.k === 'create')`, 'created file', 8000);
  check(true, 'a file created outside the IDE gets a "create" revision');

  // A Git rollback (vcs plugin) puts a label first.
  git(t.project, 'init');
  git(t.project, 'add', '-A');
  git(t.project, 'commit', '-m', 'init');
  appendFileSync(file('pkg/mod.py'), 'VALUE = 2\n');
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'pkg\\\\mod.py'), false).then(r => r.revisions[0]?.k === 'external')`, 'mod.py change', 8000);
  await js(`ide.vcs.invoke('rollback', ide.root, [{ path: ide.util.joinPath(ide.root, 'pkg\\\\mod.py'), status: 'modified' }]).then(() => true)`);
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'pkg\\\\mod.py'), false).then(r => r.revisions.map(x => x.k).join() === 'external,external,initial')`, 'rollback revision', 8000);
  check(read(file('pkg/mod.py')) === 'VALUE = 1\n' && (await h.labels()).includes('Before Rollback'), 'a Git rollback is preceded by a "Before Rollback" label and its result is recorded');
  await js(`ide.localHistory.checkpoint('My checkpoint', { user: true }).then(() => true)`);
  check((await h.labels())[0] === 'My checkpoint', 'Put Label adds a label the user named');

  // ---------- a deleted file is recovered from the project history ----------
  const beforeDelete = read(file('util.py'));
  unlinkSync(file('util.py'));
  await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'util.py'), false).then(r => r.revisions[0]?.k === 'delete')`, 'deletion', 8000);
  check(true, 'deleting a file outside the IDE is recorded');
  await js(`(ide.runAction('LocalHistory.ShowProjectHistory'), true)`);
  await until(`ide.activeTab()?.title === 'Local History: project' && document.querySelectorAll('.lh-view:not(.hidden) .lh-row').length > 5`, 'project history');
  check(await js(`[...document.querySelectorAll('.lh-view:not(.hidden) .lh-row')].some(r => r.textContent.includes('Deleted') && r.querySelector('.lh-path')?.textContent === 'util.py')`), 'the project history lists the deletion with the file path');
  await h.clickText('.lh-view:not(.hidden) .lh-row', 'Deletedutil.py');
  await until(`document.querySelector('.lh-view:not(.hidden) .lh-diff-head')?.textContent.includes('Deleted') && ide.activeTab().host._lhDiff?.getOriginalEditor().getModel().getValue().includes('# changed outside')`, 'deleted file diff');
  check(true, 'selecting the deletion shows the content just before it against nothing');
  await click('.lh-view:not(.hidden) .lh-revert');
  await until(`ide.api.exists(ide.util.joinPath(ide.root, 'util.py'))`, 'restored file');
  check(read(file('util.py')) === beforeDelete, 'Revert recovers the deleted file with its last content');
  // A closed file that cannot be written (read-only here) is reported in the view rather than failing silently.
  // (Closing the tab waits for the diff of the restored text: Monaco fails a diff still computing when its model goes.)
  await sleep(1000);
  await js(`(ide.closeTab(ide.util.joinPath(ide.root, 'util.py'), true), true)`);
  await until(`!ide.getDocument(ide.util.joinPath(ide.root, 'util.py'))`, 'util.py closed');
  await until(`document.querySelector('.lh-view:not(.hidden) .lh-diff-head')?.textContent.includes('Current (read-only)')`, 'diff against the file on disk', 8000)
    .then(() => check(true, 'closing a file shown in a history view switches its diff to the file on disk'), () => check(false, 'closing a file shown in a history view switches its diff to the file on disk'));
  chmodSync(file('util.py'), 0o444);
  await click('.lh-view:not(.hidden) .lh-revert');
  await until(`document.querySelector('.lh-view:not(.hidden) .lh-status')?.textContent.startsWith('Cannot revert: EPERM')`, 'revert error shown', 8000)
    .then(() => check(true, 'a revert that cannot write the file says so in the history view'), async () => check(false, `revert error shown (status: ${await js(`document.querySelector('.lh-view:not(.hidden) .lh-status')?.textContent`)})`));
  chmodSync(file('util.py'), 0o666);
  await shot('history-project.png');

  // ---------- bookmarks ----------
  await openFile(t, 'main.py');
  const size = await js(`[outerWidth, outerHeight].join()`);
  await h.caretTo(4);
  await press('F11');
  await until(`ide.bookmarks.list().length === 1`, 'bookmark added');
  check(JSON.stringify(await h.marks()) === JSON.stringify([{ file: 'main.py', line: 4, mnemonic: '', description: '' }]), 'F11 adds a bookmark on the caret line');
  await until(`document.querySelectorAll('.editor-group .monaco-editor .bm-glyph').length === 1`, 'gutter icon');
  check(true, 'the bookmark shows in the gutter');
  check(await js(`[outerWidth, outerHeight].join()`) === size, 'F11 does not switch the window to full screen');
  await press('F11');
  await until(`ide.bookmarks.list().length === 0 && !document.querySelector('.editor-group .bm-glyph')`, 'bookmark removed');
  check(true, 'F11 on a bookmarked line removes the bookmark');
  await press('F11');

  await h.caretTo(9);
  await press('Ctrl+F11');
  await until(`document.activeElement?.classList.contains('bm-grid')`, 'mnemonic dialog');
  await shot('mnemonic-dialog.png');
  await press('3');
  await until(`!document.querySelector('.bm-grid') && ide.bookmarks.list().some(m => m.mnemonic === '3' && m.line === 9)`, 'mnemonic 3');
  check(true, 'Ctrl+F11 then 3 adds bookmark 3 on the caret line');
  await until(`document.querySelector('.editor-group .bm-glyph.bm-m-3')`, 'mnemonic gutter icon');
  check(await js(`getComputedStyle(document.querySelector('.editor-group .bm-glyph.bm-m-3'), '::after').content === '"3"'`), 'the gutter icon of a mnemonic bookmark shows its character');

  await openFile(t, 'util.py');
  await h.caretTo(2);
  await press('Ctrl+Shift+5');
  await until(`ide.bookmarks.list().some(m => m.mnemonic === '5' && m.line === 2)`, 'bookmark 5');
  check(true, 'Ctrl+Shift+5 toggles numbered bookmark 5');
  await press('Ctrl+3');
  await until(`ide.activeTab()?.path.endsWith('main.py') && ide.editor.getPosition().lineNumber === 9`, 'jump to 3');
  check(true, 'Ctrl+3 jumps to bookmark 3 in another file');
  await press('Ctrl+5');
  await until(`ide.activeTab()?.path.endsWith('util.py') && ide.editor.getPosition().lineNumber === 2`, 'jump to 5');
  check(true, 'Ctrl+5 jumps back');

  // Bookmarks follow edits.
  await openFile(t, 'main.py');
  await h.caretTo(1);
  // Monaco types Enter through its textarea's input event, which a raw key event does not produce.
  await js(`(ide.editor.trigger('keyboard', 'type', { text: '\\n' }), ide.editor.trigger('keyboard', 'type', { text: '\\n' }), true)`);
  await until(`ide.bookmarks.list().map(m => m.line).join() === '6,11,2'`, 'lines moved', 4000).catch(() => {});
  const moved = await h.marks();
  check(JSON.stringify(moved.map((m) => `${m.file}:${m.line}${m.mnemonic}`)) === JSON.stringify(['main.py:6', 'main.py:113', 'util.py:25']), `bookmarks follow the lines when lines are inserted above (${JSON.stringify(moved)})`);
  check(await js(`ide.bookmarks.list().find(m => m.mnemonic === '3').text === 'print(greet("world"))'`), 'a bookmark keeps the text of its line');
  await js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 3, 1), text: '' }], () => null); return true; })()`);
  await until(`ide.bookmarks.list().find(m => m.mnemonic === '3').line === 9`, 'lines removed above', 4000).catch(() => {});
  check((await h.marks()).find((m) => m.mnemonic === '3').line === 9, 'and when lines above are deleted');
  await js(`ide.saveAll().then(() => true)`);

  // Bookmarks tool window (Alt+2).
  await press('Alt+2');
  await until(`ide.toolWindows.get('Bookmarks').isVisible() && document.querySelectorAll('.bm-row').length === 3`, 'bookmarks tool window');
  check(await js(`[...document.querySelectorAll('.bm-file .bm-file-name')].map(n => n.textContent).join()`) === 'main.py,util.py', 'the tool window groups bookmarks by file');
  check(await js(`[...document.querySelectorAll('.bm-row')].map(r => r.querySelector('.bm-badge').textContent + ':' + r.querySelector('.bm-line').textContent).join()`) === ':4,3:9,5:2', 'rows show the mnemonic and the line');
  await js(`(() => { const r = [...document.querySelectorAll('.bm-row')][1].getBoundingClientRect(); [...document.querySelectorAll('.bm-row')][1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 10 })); return true; })()`);
  await until(`document.querySelector('.context-menu')`, 'row menu');
  await h.clickText('.context-menu .menu-item', 'Edit Description');
  await until(`!document.getElementById('popup').classList.contains('hidden')`, 'description prompt');
  await type('entry point');
  await press('Enter');
  await until(`ide.bookmarks.list().find(m => m.mnemonic === '3').description === 'entry point'`, 'description');
  check(await js(`[...document.querySelectorAll('.bm-row')][1].querySelector('.bm-text').textContent === 'entry point'`), 'a description edited from the tool window shows in its row');
  await openFile(t, 'util.py');
  await h.clickText('.bm-row', 'entry point');
  await until(`ide.activeTab()?.path.endsWith('main.py') && ide.editor.getPosition().lineNumber === 9`, 'row jump');
  check(true, 'clicking a row opens its file at the line');
  await shot('bookmarks.png');

  await press('Shift+F11');
  await until(`document.querySelectorAll('#popupList .popup-item').length === 3`, 'show bookmarks popup');
  check(await js(`document.querySelector('#popupList .popup-item .label').textContent === 'main.py:4'`), 'Shift+F11 lists the bookmarks');
  await press('Escape');

  // ---------- restart ----------
  await until(`(ide.settings.get('bookmarks.' + ide.root) || []).length === 3 && ide.settings.get('bookmarks.' + ide.root).some(m => m.description === 'entry point')`, 'bookmarks saved');
  before = { main: (await h.kinds('main.py')).length, notes: await h.kinds('notes.txt') };
  check(before.notes.join() === 'initial', 'an opened file that never changed keeps its single revision');
  // The index is written in the background while the project is open: whole, and without temporary files left over.
  const lhDirs = () => readdirSync(path.join(t.userData, 'local-history')).map((d) => path.join(t.userData, 'local-history', d));
  const onDisk = () => lhDirs().some((d) => {
    try {
      const index = JSON.parse(read(path.join(d, 'index.json')));
      return index.files['main.py']?.revs.length === before.main && !readdirSync(d).some((n) => n.endsWith('.tmp'));
    } catch { return false; }
  });
  let written = false;
  for (let end = Date.now() + 10000; !written && Date.now() < end; await t.sleep(200)) written = onDisk();
  check(written, 'the local history index reaches the disk while the project is open, with no temporary file left');
  t.close();
  writeFileSync(file('notes.txt'), 'Edited while the IDE was closed.\n');
} catch (err) {
  check(false, err.message);
  t.close();
}

const r2 = await launch({ fixture: 'history', port: 9711, name: 'history-restart', userData: t.userData });
const h2 = helpers(r2);
try {
  await r2.js(`ide.openProject(${JSON.stringify(t.project)}).then(() => true)`);
  await r2.until(`ide.localHistory.ready().then(Boolean)`, 'local history reopened');
  const marks = await h2.marks();
  r2.check(JSON.stringify(marks) === JSON.stringify([
    { file: 'main.py', line: 4, mnemonic: '', description: '' },
    { file: 'main.py', line: 9, mnemonic: '3', description: 'entry point' },
    { file: 'util.py', line: 2, mnemonic: '5', description: '' },
  ]), `bookmarks with their lines, mnemonics and descriptions survive a restart (${JSON.stringify(marks)})`);
  await openFile(r2, 'main.py');
  await r2.until(`document.querySelectorAll('.editor-group .monaco-editor .bm-glyph').length === 2`, 'gutter after restart');
  r2.check(true, 'the reopened file shows its bookmarks in the gutter');
  await r2.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await r2.press('Ctrl+3');
  await r2.until(`ide.editor.getPosition().lineNumber === 9`, 'jump after restart');
  r2.check(true, 'Ctrl+3 still jumps after a restart');
  const kinds = await h2.kinds('main.py');
  r2.check(kinds.length === before?.main && kinds.includes('revert') && kinds.includes('save'), `the local history of a file survives a restart (${kinds.join()})`);
  r2.check((await h2.kinds('notes.txt')).join() === 'external,initial', 'a change made while the IDE was closed is recorded when the project opens');
  r2.check((await h2.kinds('pkg/mod.py')).join() === 'external,external,initial', 'unchanged files get no new revision when the project opens again');
  r2.check(r2.consoleErrors.length === 0, `no renderer exceptions after restart${r2.consoleErrors.length ? ` ${JSON.stringify(r2.consoleErrors)}` : ''}`);
} catch (err) {
  r2.check(false, err.message);
}
r2.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'history', port: 9712, name: 'history-ko', lang: 'ko-KR' });
const hk = helpers(k);
const sources = ['local-history', 'bookmarks'].map((p) => read(new URL(`../renderer/features/${p}/index.js`, import.meta.url)));
const mine = new Set(sources.flatMap((s) => [...s.matchAll(/\btr\((['"])((?:(?!\1).)*)\1/g)].map((m) => m[2])));
const ko = Object.assign({}, ...['local-history', 'bookmarks'].map((p) => JSON.parse(read(new URL(`../renderer/features/${p}/locales/ko.json`, import.meta.url)))));
async function noLeaks(selector, label) {
  const leaks = await englishLeaks(k, selector);
  k.check(leaks.length === 0, `${label}: no English UI text${leaks.length ? ` (${JSON.stringify(leaks.slice(0, 6))})` : ''}`);
}
try {
  k.check(await k.js(`i18n.locale === 'ko'`), 'session runs in Korean');
  const untranslated = [...mine].filter((s) => !(s in ko));
  k.check(untranslated.length === 0, `locales/ko.json covers every tr() string${untranslated.length ? ` (${JSON.stringify(untranslated)})` : ''}`);
  await k.until(`ide.localHistory.ready().then(Boolean)`, 'ko history');
  await openFile(k, 'main.py');
  await k.js(`(ide.activeTab().model.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: '# ko\\n' }], () => null), true)`);
  await k.js(`ide.saveAll().then(() => ide.localHistory.checkpoint('Before Update Project')).then(() => true)`);
  await k.js(`(ide.runAction('LocalHistory.ShowHistory'), true)`);
  await k.until(`document.querySelectorAll('.lh-view:not(.hidden) .lh-row').length === 3 && !!ide.activeTab().host._lhDiff`, 'ko history tab');
  k.check(await k.js(`ide.activeTab().title === '로컬 기록: main.py'`), 'the history tab is titled 로컬 기록');
  k.check(await k.js(`[...document.querySelectorAll('.lh-view:not(.hidden) .lh-row')].map(r => r.textContent).join('|')`).then((s) => s.includes('프로젝트 업데이트 전') && s.includes('저장됨') && s.includes('초기 내용') && s.includes('오늘')),
    'labels, kinds and times read in Korean');
  await hk.clickText('.lh-view:not(.hidden) .lh-row', '초기 내용');
  await k.until(`ide.activeTab().host._lhDiff?.getLineChanges()?.length === 1`, 'ko diff');
  await noLeaks('.lh-view:not(.hidden)', 'history view');
  await k.shot('history-ko.png');

  await k.js(`(ide.runAction('LocalHistory.ShowProjectHistory'), true)`);
  await k.until(`ide.activeTab().title === '로컬 기록: project' && document.querySelector('.lh-view:not(.hidden) .lh-row.label')`, 'ko project history');
  await hk.clickText('.lh-view:not(.hidden) .lh-row', '프로젝트 업데이트 전');
  await k.until(`!document.querySelector('.lh-view:not(.hidden) .lh-note').classList.contains('hidden')`, 'label note');
  await noLeaks('.lh-view:not(.hidden)', 'project history at a label');

  await openFile(k, 'main.py');
  await hk.caretTo(5);
  await k.press('F11');
  await hk.caretTo(9);
  await k.press('Ctrl+F11');
  await k.until(`document.activeElement?.classList.contains('bm-grid')`, 'ko mnemonic dialog');
  await noLeaks('.dialog', 'mnemonic dialog');
  k.check(await k.js(`document.querySelector('.dialog-title').textContent === '니모닉 북마크 추가'`), 'the mnemonic dialog reads 니모닉 북마크 추가');
  await k.shot('mnemonic-ko.png');
  await k.press('7');
  await k.until(`ide.bookmarks.list().length === 2`, 'ko bookmarks');
  await k.press('Alt+2');
  await k.until(`ide.toolWindows.get('Bookmarks').isVisible() && document.querySelectorAll('.bm-row').length === 2`, 'ko tool window');
  k.check(await k.js(`document.getElementById('sideTitle').textContent === '북마크'`), 'the tool window is titled 북마크');
  await noLeaks('#sidePanel', 'bookmarks tool window');
  await k.js(`(() => { const r = document.querySelector('.bm-row').getBoundingClientRect(); document.querySelector('.bm-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 10 })); return true; })()`);
  await k.until(`document.querySelector('.context-menu')`, 'ko row menu');
  await noLeaks('.context-menu', 'bookmark row menu');
  await k.press('Escape');
  const missing = (await missingTranslations(k)).filter((s) => mine.has(s));
  k.check(missing.length === 0, `every tr() string shown has a Korean entry${missing.length ? ` (${JSON.stringify(missing)})` : ''}`);
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${JSON.stringify(k.consoleErrors)}` : ''}`);
} catch (err) {
  k.check(false, err.message);
}
k.close();

const all = [...t.results, ...r2.results, ...k.results];
const failed = all.filter((r) => !r.ok).length;
if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || t.consoleErrors.length ? 1 : 0);
