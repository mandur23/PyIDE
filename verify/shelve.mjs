// Shelve and unshelve, as in PyCharm (Git › Shelve Changes…, the Commit window's Shelf tab). A repository with a
// modified, a CRLF, a binary, a deleted, a renamed, a staged new and an untracked file: most are shelved and rolled
// back, one is shelved but kept; files come back selectively and then all at once, where an edit made since conflicts
// and goes through the Conflicts dialog; a file that cannot be applied stays on the shelf. Shelves are renamed, survive
// a restart and are deleted. Then the same surfaces in Korean, without English leaks. Ports 9250-9252.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-shelve-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '');
const q = JSON.stringify;

// Every string the vcs plugin passes to tr().
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWN = new Set(Object.keys(JSON.parse(readFileSync(path.join(APP, 'renderer/features/vcs/locales/ko.json'), 'utf8'))));
const src = readFileSync(path.join(APP, 'renderer/features/vcs/index.js'), 'utf8');
for (const m of src.matchAll(/\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) OWN.add(m[2].replace(/\\'/g, "'"));
for (const m of src.matchAll(/\btrn\([^,]+,\s*'([^']*)',\s*'([^']*)'/g)) { OWN.add(m[1]); OWN.add(m[2]); }

const binary = (n) => Buffer.from(Array.from({ length: 600 }, (_, i) => (i * n + (i >> 3)) % 256));
const CRLF_HEAD = 'one\r\ntwo\r\nthree\r\n';
const CRLF_NEW = 'one\r\nTWO\r\nthree\r\n';
const MAIN_NEW = 'import sys\n\n\ndef greet(name):\n    return f"Shelved, {name}!"\n';
const OLD = 'def old_name():\n    return "renamed module"\n\n\nVALUE = 1\n';
const NEW = 'def old_name():\n    return "renamed module"\n\n\nVALUE = 2\n';

// The fixture as a repository, then one change of every kind in the work tree.
function buildRepo(dir) {
  const write = (rel, data) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), data); };
  write('crlf.txt', CRLF_HEAD);
  write('data.bin', binary(7));
  write('gone.py', 'GONE = "this file is deleted"\n');
  write('old_name.py', OLD);
  git(dir, 'init');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'Initial commit');
  write('main.py', MAIN_NEW);
  write('crlf.txt', CRLF_NEW);
  write('data.bin', binary(11));
  unlinkSync(path.join(dir, 'gone.py'));
  git(dir, 'mv', 'old_name.py', 'new_name.py');
  write('new_name.py', NEW);
  git(dir, 'add', 'new_name.py');
  write('added.py', 'ADDED = True\n');
  git(dir, 'add', 'added.py');
  write('notes/todo.txt', 'remember the milk\n');
  write('util/helpers.py', 'def double(x):\n    return x + x\n');
}

function helpers(t) {
  const { js, cdp, sleep } = t;
  // Chromium pauses painting for an occluded window, so every wait and mouse action first forces a frame.
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
  async function mouse(expr, { button = 'left', clickCount = 1, modifiers = 0, label = expr } = {}) {
    await frame();
    const box = await js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${label}`);
    await frame();
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(100);
    for (let i = 1; i <= clickCount; i++) {
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: i, modifiers });
    }
    await sleep(100);
  }
  const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].some(n => n.textContent.includes(${q(text)}))`;
  const clearNotes = () => js(`document.querySelectorAll('.vcs-note').forEach(n => n.remove())`);
  const changeRow = (name) => `[...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith(${q('\\' + name)}))`;
  const dialogFile = (name) => `[...document.querySelectorAll('.vcs-shelve-file')].find(r => r.dataset.path.endsWith(${q('\\' + name)}))`;
  const shelfRow = (name) => `[...document.querySelectorAll('.vcs-shelf-row')].find(r => r.querySelector('.vcs-shelf-name').textContent === ${q(name)})`;
  const shelfFile = (shelf, rel) => `[...document.querySelectorAll('.vcs-shelf-file')].find(r => r.dataset.id === ${shelfRow(shelf)}?.dataset.id && r.dataset.rel === ${q(rel)})`;
  const menuItem = (label) => `[...document.querySelectorAll('#menuHost .menu-item')].find(m => m.firstChild.textContent === ${q(label)})`;
  const refresh = () => js(`(window.dispatchEvent(new Event('focus')), true)`);
  return { frame, until, mouse, noteWith, clearNotes, changeRow, dialogFile, shelfRow, shelfFile, menuItem, refresh };
}

// <userData>/shelf/<project id>/<shelf id>/: the shelves PyIDE keeps for this project.
const shelfDirs = (userData) => {
  const base = path.join(userData, 'shelf');
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((p) => readdirSync(path.join(base, p)).map((id) => path.join(base, p, id)));
};

const t = await launch({ fixture: 'vcs', port: 9250, name: 'shelve' });
const { js, check, shot, type, press, project } = t;
const h = helpers(t);
const { until, mouse, noteWith, clearNotes } = h;
const file = (rel) => readFileSync(path.join(project, rel));
const text = (rel) => readFileSync(path.join(project, rel), 'utf8');
const exists = (rel) => existsSync(path.join(project, rel));
const porcelain = () => git(project, 'status', '--porcelain', '--untracked-files=all', '--no-renames');
const HEAD_MAIN = readFileSync(path.join(APP, 'verify/fixtures/vcs/main.py'), 'utf8');
const HEAD_HELPERS = readFileSync(path.join(APP, 'verify/fixtures/vcs/util/helpers.py'), 'utf8');
try {
  buildRepo(project);
  await h.refresh();
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository detected');
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  await until(`document.querySelectorAll('.vcs-changes .vcs-file').length === 8`, 'eight changes listed');
  check(await js(`!document.querySelector('.vcs-commit-tabs').classList.contains('hidden') && [...document.querySelectorAll('.vcs-commit-tabs .vcs-ctab')].map(b => b.textContent).join('|')`) === 'Commit|Shelf', 'the Commit window has Commit and Shelf tabs');
  await js(`ide.openFile(ide.util.joinPath(ide.root, 'main.py'))`);
  await until(`ide.activeTab()?.title === 'main.py'`, 'main.py open');

  // ---------- Shelve Changes… ----------
  await js(`(ide.runAction('ChangesView.Shelve'), true)`);
  await until(`document.querySelectorAll('.dialog .vcs-shelve-file').length === 8`, 'Shelve Changes dialog');
  check(await js(`document.querySelector('.dialog-title').textContent`) === 'Shelve Changes', 'Git › Shelve Changes… opens the Shelve Changes dialog');
  check(/^Changes from /.test(await js(`document.querySelector('.vcs-shelve-name').value`)), 'the shelf name defaults to "Changes from <date>"');
  check(await js(`${h.dialogFile('todo.txt')}.querySelector('input').checked === false && ${h.dialogFile('main.py')}.querySelector('input').checked`), 'the files ticked for commit are preselected, unversioned ones are not');
  check(await js(`!document.querySelector('.vcs-shelve-keep input').checked`), '"Keep changes in working tree" is off by default');
  await mouse(`${h.dialogFile('helpers.py')}.querySelector('input')`, { label: 'untick helpers.py' });
  await mouse(`${h.dialogFile('todo.txt')}.querySelector('input')`, { label: 'tick todo.txt' });
  check(await js(`document.querySelector('.vcs-shelve-count').textContent`) === '7 / 8', 'the dialog counts the ticked files');
  await js(`(() => { const n = document.querySelector('.vcs-shelve-name'); n.value = 'Shelf A'; return true; })()`);
  await shot('shelve-dialog.png');
  await clearNotes();
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Shelve Changes button' });
  await until(noteWith('Shelved 7 files: Shelf A'), 'shelved note', 20000);
  check(porcelain() === ' M util/helpers.py', `the shelved files are rolled back and only the unticked file is still changed (${q(porcelain())})`);
  check(text('main.py') === HEAD_MAIN && file('crlf.txt').toString() === CRLF_HEAD && file('data.bin').equals(binary(7)), 'modified, CRLF and binary files are back at HEAD');
  check(exists('gone.py') && exists('old_name.py') && !exists('new_name.py') && !exists('added.py') && !exists('notes/todo.txt') && !exists('notes'), 'the deleted file is back, the rename undone, new and untracked files removed');
  await until(`ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model.getValue() === ${q(HEAD_MAIN)}`, 'open editor reloaded');
  check(true, 'the open editor of a shelved file shows the rolled-back text');
  const dirs = shelfDirs(t.userData);
  check(dirs.length === 1 && existsSync(path.join(dirs[0], 'changes.patch')) && existsSync(path.join(dirs[0], 'shelf.json')), 'the shelf is a patch plus shelf.json under <userData>/shelf');
  const patch = readFileSync(path.join(dirs[0], 'changes.patch'), 'latin1');
  check(patch.includes('GIT binary patch') && patch.includes('rename from old_name.py') && patch.includes('new file mode') && patch.includes('deleted file mode') && patch.includes('TWO\r\n'),
    'the patch is binary-safe and holds the rename, the new and deleted files and the CRLF lines');
  check(!git(project, 'status', '--porcelain', '--ignored').includes('shelf'), 'nothing is written into the repository');
  await until(`!document.querySelector('.vcs-shelf').classList.contains('hidden') && !!${h.shelfRow('Shelf A')}`, 'Shelf tab shown');
  check(await js(`${h.shelfRow('Shelf A')}.querySelector('.vcs-shelf-count').textContent`) === '7 files', 'the Shelf tab lists the new shelf with its file count');
  check(await js(`document.querySelectorAll('.vcs-shelf-file').length`) === 7, 'the new shelf is expanded to its files');
  await shot('shelf-tab.png');

  // ---------- shelved diffs ----------
  await mouse(h.shelfFile('Shelf A', 'crlf.txt'), { clickCount: 2, label: 'crlf.txt row' });
  await until(`ide.activeTab()?.title === 'crlf.txt (shelved)'`, 'shelved diff tab');
  const sides = await js(`(() => { const d = document.querySelector('.custom-tab:not(.hidden)')._vcsDiff.getModel(); return [d.original.getValue(), d.modified.getValue()]; })()`);
  check(sides[0].includes('two') && sides[1].includes('TWO') && !sides[1].includes('two'), 'double-clicking a shelved file shows its shelved diff');
  await mouse(h.shelfFile('Shelf A', 'new_name.py'), { clickCount: 2, label: 'new_name.py row' });
  await until(`ide.activeTab()?.title === 'new_name.py (shelved)'`, 'renamed diff tab');
  const ren = await js(`(() => { const d = document.querySelector('.custom-tab:not(.hidden)')._vcsDiff.getModel(); return [d.original.getValue(), d.modified.getValue()]; })()`);
  check(ren[0] === OLD && ren[1] === NEW, 'a renamed file\'s diff is its old text against its shelved text');
  await clearNotes();
  await mouse(h.shelfFile('Shelf A', 'data.bin'), { clickCount: 2, label: 'data.bin row' });
  await until(noteWith('Binary file'), 'binary note');
  check(true, 'a binary file says it cannot be shown as text');

  // ---------- a second shelf that keeps the working tree ----------
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  await mouse(`document.querySelector('#vcsChangesTab')`, { label: 'Commit tab' });
  await until(`!!${h.changeRow('helpers.py')}`, 'helpers.py listed');
  await mouse(h.changeRow('helpers.py'), { label: 'helpers.py row' });
  await mouse(`document.querySelector('[data-action="vcsShelveAction"]')`, { label: 'Shelve Changes toolbar button' });
  await until(`document.querySelectorAll('.dialog .vcs-shelve-file').length === 1`, 'second Shelve dialog');
  check(await js(`${h.dialogFile('helpers.py')}.querySelector('input').checked`), 'the file selected in the Commit window is preselected');
  await mouse(`document.querySelector('.vcs-shelve-keep input')`, { label: 'keep changes' });
  await js(`(() => { document.querySelector('.vcs-shelve-name').value = 'Shelf B'; return true; })()`);
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Shelve Changes button' });
  await until(`!!${h.shelfRow('Shelf B')}`, 'Shelf B listed', 20000);
  check(text('util/helpers.py') !== HEAD_HELPERS && porcelain() === ' M util/helpers.py', 'with "Keep changes in working tree" the shelved file stays changed');
  check(await js(`[...document.querySelectorAll('.vcs-shelf-row .vcs-shelf-name')].map(n => n.textContent).join('|')`) === 'Shelf B|Shelf A', 'shelves are listed newest first');

  // ---------- Unshelve Selected Files ----------
  await mouse(h.shelfFile('Shelf A', 'main.py'), { label: 'main.py in Shelf A' });
  await mouse(h.shelfFile('Shelf A', 'data.bin'), { modifiers: 2, label: 'Ctrl+click data.bin' });
  check(await js(`document.querySelectorAll('.vcs-shelf-file.selected').length`) === 2, 'Ctrl+click selects two shelved files');
  await mouse(h.shelfFile('Shelf A', 'data.bin'), { button: 'right', label: 'context menu' });
  await until(`!!${h.menuItem('Unshelve Selected Files')}`, 'shelf context menu');
  check(await js(`!!${h.menuItem('Unshelve')} && !!${h.menuItem('Rename…')} && !!${h.menuItem('Delete…')}`), 'the context menu offers Unshelve, Unshelve Selected Files, Rename… and Delete…');
  await clearNotes();
  await mouse(h.menuItem('Unshelve Selected Files'), { label: 'Unshelve Selected Files' });
  await until(noteWith('Unshelved 2 files from Shelf A'), 'unshelved note', 20000);
  check(text('main.py') === MAIN_NEW && file('data.bin').equals(binary(11)), 'the two files come back, the binary one byte for byte');
  check(porcelain().split('\n').sort().join('|') === ' M data.bin| M main.py| M util/helpers.py', 'only those two files changed');
  await until(`${h.shelfRow('Shelf A')}?.querySelector('.vcs-shelf-count').textContent === '5 files'`, 'Shelf A has 5 files');
  check(true, 'files applied successfully are removed from the shelf (the option is on by default)');
  check(await js(`document.querySelector('.vcs-shelf-remove input').checked`), '"Remove successfully applied files from the shelf" is on by default');
  await until(`ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model.getValue() === ${q(MAIN_NEW)}`, 'editor shows unshelved text');

  // ---------- Unshelve all with a conflict ----------
  writeFileSync(path.join(project, 'crlf.txt'), 'one\r\nDOS\r\nthree\r\n');
  await mouse(h.shelfRow('Shelf A'), { label: 'Shelf A row' });
  await clearNotes();
  await mouse(`document.querySelector('.vcs-shelf-unshelve')`, { label: 'Unshelve button' });
  await until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'Conflicts dialog', 20000);
  check(await js(noteWith('Conflicts in 1 file')), 'unshelving over an edit of the same lines reports the conflict');
  check(await js(noteWith('The file with conflicts stays on the shelf until you delete it')), 'the result says the file with conflicts stays on the shelf');
  check(git(project, 'diff', '--name-only', '--diff-filter=U') === 'crlf.txt', 'git has crlf.txt unmerged');
  check(text('crlf.txt').includes('<<<<<<<') && text('crlf.txt').includes('TWO\r\n'), 'the work tree file has conflict markers and keeps its CRLF lines');
  check(!exists('gone.py') && !exists('old_name.py') && text('new_name.py') === NEW && text('added.py') === 'ADDED = True\n' && text('notes/todo.txt') === 'remember the milk\n',
    'the deletion, the rename, the new and the untracked files are back');
  const st = porcelain().split('\n');
  check(st.includes('A  added.py') && st.includes('?? notes/todo.txt') && st.includes('A  new_name.py'), `a file that was staged as new is staged again, an untracked one stays untracked (${q(st)})`);
  check(await js(`document.querySelectorAll('.vcs-conflict-row[data-path]').length`) === 1, 'the Conflicts dialog lists the file');
  await shot('unshelve-conflict.png');
  await mouse(`document.querySelector('.vcs-accept-theirs')`, { label: 'Accept Theirs' });
  await until(`!document.querySelector('.dialog .vcs-conflicts')`, 'conflict resolved');
  check(file('crlf.txt').toString() === CRLF_NEW, 'Accept Theirs takes the shelved CRLF text byte for byte');
  // PyCharm keeps a conflicted file on the shelf: had the user picked Accept Yours, the shelf would be its only copy
  await until(`${h.shelfRow('Shelf A')}?.querySelector('.vcs-shelf-count').textContent === '1 file'`, 'Shelf A keeps crlf.txt');
  const shelfA = JSON.parse(readFileSync(path.join(shelfDirs(t.userData).find((d) => readFileSync(path.join(d, 'shelf.json'), 'utf8').includes('"Shelf A"')), 'shelf.json'), 'utf8'));
  check(shelfA.files.map((f) => f.rel).join() === 'crlf.txt', 'files that applied cleanly leave the shelf; the one with conflicts stays on it');
  await mouse(h.shelfRow('Shelf A'), { label: 'Shelf A row' });
  await mouse(`document.querySelector('.vcs-shelf-delete')`, { label: 'Delete… Shelf A' });
  await until(`document.querySelector('.dialog .dialog-message')?.textContent.includes('Shelf A')`, 'Shelf A delete confirmation');
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Delete' });
  await until(`!${h.shelfRow('Shelf A')}`, 'Shelf A gone');
  check(true, 'the shelf with the resolved file is deleted by hand');

  // ---------- a file that cannot be unshelved stays on the shelf ----------
  unlinkSync(path.join(project, 'util/helpers.py'));
  await h.refresh();
  await mouse(h.shelfRow('Shelf B'), { label: 'Shelf B row' });
  await clearNotes();
  await mouse(`document.querySelector('.vcs-shelf-unshelve')`, { label: 'Unshelve Shelf B' });
  await until(noteWith('1 file could not be unshelved and stays on the shelf'), 'failure note', 20000);
  check(await js(noteWith('util/helpers.py')), 'the failure names the file and git\'s reason');
  check(await js(`${h.shelfRow('Shelf B')}?.querySelector('.vcs-shelf-count').textContent`) === '1 file', 'the shelf keeps the file');
  check(porcelain().split('\n').includes(' D util/helpers.py'), 'a failed unshelve leaves the index as it was');
  git(project, 'checkout', '--', 'util/helpers.py');

  // ---------- rename and delete ----------
  await mouse(h.shelfRow('Shelf B'), { label: 'Shelf B row' });
  await mouse(`document.querySelector('.vcs-shelf-rename')`, { label: 'Rename…' });
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'rename prompt');
  await type('보관함 B');
  await press('Enter');
  await until(`!!${h.shelfRow('보관함 B')}`, 'renamed shelf');
  check(true, 'Rename… renames the shelf (Korean name)');
  await shot('shelf-renamed.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
const userData = t.userData;
t.close();

// ---------- the shelf survives a restart ----------
const r = await launch({ fixture: 'vcs', port: 9251, name: 'shelve-restart', userData, projectDir: project });
try {
  const rh = helpers(r);
  await rh.until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository after restart');
  await r.js(`(ide.runAction('Vcs.Show.Shelf'), true)`);
  await rh.until(`!!${rh.shelfRow('보관함 B')}`, 'shelf after restart', 20000);
  r.check(await r.js(`${rh.shelfRow('보관함 B')}.querySelector('.vcs-shelf-count').textContent`) === '1 file', 'after a restart Show Shelf lists the renamed shelf with its file');
  await rh.mouse(rh.shelfRow('보관함 B'), { label: 'shelf row' });
  await rh.mouse(`document.querySelector('.vcs-shelf-delete')`, { label: 'Delete…' });
  await rh.until(`document.querySelector('.dialog .dialog-message')?.textContent.includes('보관함 B')`, 'delete confirmation');
  r.check(await r.js(`document.querySelector('.dialog-title').textContent`) === 'Delete Shelf', 'Delete… asks first');
  await rh.mouse(`document.querySelector('.dialog .primary')`, { label: 'Delete' });
  await rh.until(`!document.querySelector('.vcs-shelf-row') && document.querySelector('.vcs-shelf-list').textContent.includes('No shelved changes')`, 'no shelves');
  r.check(shelfDirs(userData).length === 0, 'Delete removes the shelf from disk');
  r.check(r.consoleErrors.length === 0, `no renderer exceptions after restart${r.consoleErrors.length ? ` ${q(r.consoleErrors)}` : ''}`);
} catch (err) {
  r.check(false, err.message);
  await r.shot('failure-restart.png');
}
for (const x of r.results) t.results.push(x);
r.close();
check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);

// ---------- Korean ----------
const k = await launch({ fixture: 'vcs', port: 9252, name: 'shelve-ko', lang: 'ko-KR' });
const kh = helpers(k);
const noLeaks = async (selector, label, allowed = []) => {
  const found = await englishLeaks(k, selector, allowed);
  k.check(!found.length, `${label}: no English UI text${found.length ? ` ${q(found)}` : ''}`);
};
try {
  buildRepo(k.project);
  await kh.refresh();
  await kh.until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'ko repository');
  await k.js(`(ide.toolWindows.get('Commit').show(), true)`);
  await kh.until(`document.querySelectorAll('.vcs-changes .vcs-file').length === 8`, 'ko changes');
  k.check(await k.js(`[...document.querySelectorAll('.vcs-commit-tabs .vcs-ctab')].map(b => b.textContent).join('|')`) === '커밋|셸프', 'the tabs are 커밋 and 셸프');
  await k.js(`(ide.runAction('ChangesView.Shelve'), true)`);
  await kh.until(`document.querySelectorAll('.dialog .vcs-shelve-file').length === 8`, 'ko Shelve dialog');
  k.check(await k.js(`document.querySelector('.dialog-title').textContent`) === '변경 사항 셸브' && /의 변경 사항$/.test(await k.js(`document.querySelector('.vcs-shelve-name').value`)), 'the dialog and the default shelf name are Korean');
  await noLeaks('#dialogHost', 'Shelve Changes dialog');
  await k.shot('shelve-dialog-ko.png');
  await kh.clearNotes();
  await kh.mouse(`document.querySelector('.dialog .primary')`, { label: '변경 사항 셸브' });
  await kh.until(kh.noteWith('파일 7개를 셸브함'), 'ko shelved', 20000);
  await noLeaks('.ide-balloons', 'shelved notification');
  await kh.until(`document.querySelectorAll('.vcs-shelf-file').length === 7`, 'ko shelf tab');
  await noLeaks('.vcs-shelf', 'Shelf tab');
  await noLeaks('.vcs-commit-tabs', 'Commit window tabs');
  await k.shot('shelf-tab-ko.png');
  await kh.mouse(`document.querySelector('.vcs-shelf-file')`, { button: 'right', label: 'ko context menu' });
  await kh.until(`!!${kh.menuItem('선택한 파일 셸브 해제')}`, 'ko context menu');
  await noLeaks('#menuHost', 'Shelf context menu');
  await k.press('Escape');
  // with "Remove successfully applied files" off, an unshelved file stays on the shelf
  await kh.mouse(`document.querySelector('.vcs-shelf-remove input')`, { label: 'remove applied off' });
  await kh.mouse(kh.shelfFile(await k.js(`document.querySelector('.vcs-shelf-name').textContent`), 'main.py'), { button: 'right', label: 'main.py' });
  await kh.until(`!!${kh.menuItem('선택한 파일 셸브 해제')}`, 'ko menu again');
  await kh.clearNotes();
  await kh.mouse(kh.menuItem('선택한 파일 셸브 해제'), { label: '선택한 파일 셸브 해제' });
  await kh.until(kh.noteWith('파일 1개를 셸브 해제함'), 'ko unshelved', 20000);
  await noLeaks('.ide-balloons', 'unshelved notification');
  k.check(readFileSync(path.join(k.project, 'main.py'), 'utf8') === MAIN_NEW && await k.js(`document.querySelectorAll('.vcs-shelf-file').length`) === 7,
    'with the option off the unshelved file stays on the shelf');
  await kh.mouse(`document.querySelector('.vcs-shelf-delete')`, { label: '삭제…' });
  await kh.until(`!!document.querySelector('.dialog .dialog-message')`, 'ko delete confirmation');
  await noLeaks('#dialogHost', 'Delete Shelf confirmation');
  await k.press('Escape');
  await k.js(`ide.editor.focus()`);
  await k.press('Ctrl+Shift+A');
  await kh.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'find action');
  await k.type('셸브');
  await kh.until(`[...document.querySelectorAll('.popup-item .label')].some(l => l.textContent === '변경 사항 셸브…')`, 'shelve action');
  await noLeaks('#popup', 'Find Action results for shelve');
  await k.press('Escape');
  const missing = (await missingTranslations(k)).filter((s) => OWN.has(s));
  k.check(missing.length === 0, `every Git tr() string has a Korean entry${missing.length ? ` (missing ${q(missing)})` : ''}`);
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${q(k.consoleErrors)}` : ''}`);
} catch (err) {
  k.check(false, err.message);
  await k.shot('failure-ko.png');
}
for (const x of k.results) t.results.push(x);
k.close();

// ---------- a rollback git cannot vouch for touches nothing (main process only, no window) ----------
// main/features/git.js with a fake ipcMain; child_process.spawn is wrapped so `cat-file --batch-check` (which tells the
// rollback which files HEAD has) fails. Before the fix every path then looked new and tracked files were deleted.
{
  const require = createRequire(path.join(APP, 'main/features/git.js'));
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  let breakCatFile = null; // replacement args for cat-file --batch-check
  cp.spawn = (cmd, args, opts) => realSpawn(cmd, cmd === 'git' && breakCatFile && args.includes('cat-file') && args.includes('--batch-check') ? breakCatFile : args, opts);
  const trustAll = process.env.PYIDE_TRUST_ALL;
  process.env.PYIDE_TRUST_ALL = '1';
  const handlers = {};
  require(path.join(APP, 'main/features/git.js')).register({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: () => {} },
    app: { getPath: () => mkdtempSync(path.join(tmpdir(), 'pyide-shelve-main-')), on: () => {} },
  });
  const call = (name, ...args) => handlers[`git:${name}`](null, ...args);
  try {
    for (const [label, args] of [['cat-file fails', ['cat-file', '--no-such-option']], ['cat-file exits 0 with no answer', ['rev-parse']]]) {
      const dir = mkdtempSync(path.join(tmpdir(), 'pyide-shelve-abort-'));
      writeFileSync(path.join(dir, 'mod.py'), 'A = 1\n');
      git(dir, 'init'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'init');
      writeFileSync(path.join(dir, 'mod.py'), 'A = 2\n');
      writeFileSync(path.join(dir, 'new.py'), 'NEW = True\n');
      breakCatFile = args;
      const s = await call('shelve', dir, { name: label, paths: [path.join(dir, 'mod.py'), path.join(dir, 'new.py')], keep: false });
      breakCatFile = null;
      check(s.ok && !s.reverted && !!s.revertError, `${label}: the changes are shelved, the rollback is refused with an error (${q(s.revertError)})`);
      check(readFileSync(path.join(dir, 'mod.py'), 'utf8') === 'A = 2\n' && readFileSync(path.join(dir, 'new.py'), 'utf8') === 'NEW = True\n'
        && git(dir, 'status', '--porcelain', '--untracked-files=all') === ' M mod.py\n?? new.py', `${label}: the work tree and the index are untouched`);
      check((await call('shelves', dir)).some((x) => x.id === s.id && x.files.length === 2), `${label}: the shelf is kept`);
    }
    // the conflicted file stays on the shelf when unshelved through the main process too
    const dir = mkdtempSync(path.join(tmpdir(), 'pyide-shelve-conflict-'));
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(path.join(dir, 'b.txt'), 'x\n');
    git(dir, 'init'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'init');
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(path.join(dir, 'b.txt'), 'y\n');
    const s = await call('shelve', dir, { name: 'C', paths: [path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], keep: false });
    writeFileSync(path.join(dir, 'a.txt'), 'one\nDOS\nthree\n');
    const u = await call('unshelve', dir, s.id, { rels: null, remove: true });
    git(dir, 'checkout', '--ours', '--', 'a.txt'); git(dir, 'add', 'a.txt'); // Accept Yours
    const d = await call('shelfDiff', dir, s.id, 'a.txt');
    check(u.conflicts.length === 1 && q(u.keptConflicts) === '["a.txt"]' && !u.shelfRemoved && d.ok && d.after === 'one\nTWO\nthree\n',
      'after a conflicting unshelve resolved with Accept Yours, the shelved change is still on the shelf');
  } catch (err) {
    check(false, `main-process shelf checks: ${err.message}`);
  } finally {
    cp.spawn = realSpawn;
    if (trustAll === undefined) delete process.env.PYIDE_TRUST_ALL; else process.env.PYIDE_TRUST_ALL = trustAll;
  }
}

const failed = t.results.filter((x) => !x.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
