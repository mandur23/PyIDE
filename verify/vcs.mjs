// End-to-end check of the Git integration: init, commit, gutter markers, diff, rollback, log, blame, branches, push/pull.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, lensesShown, openFile } from './lib.mjs';

// Isolate git from the user's global/system config (identity, autocrlf, default branch, hooks).
const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const t = await launch({ fixture: 'vcs', port: 9404 });
const { js, press, type, check, shot, cdp, sleep, project } = t;
const q = JSON.stringify;
// Chromium pauses animation frames for an occluded window (other instances may cover this one), so every wait and
// mouse action first forces a frame with a tiny screenshot; otherwise Monaco never paints its DOM.
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

// Mouse input at the center of the element an expression returns.
async function mouse(expr, { button = 'left', clickCount = 1, label = expr } = {}) {
  await frame();
  const box = await js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element for ${label}`);
  await frame();
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(150);
  for (let i = 1; i <= clickCount; i++) {
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: i });
  }
  await sleep(80);
}
const fileRow = (name) => `[...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith(${q('\\' + name)}))`;
const treeNode = (name) => `[...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name').textContent === ${q(name)})`;
const treeColor = (name) => js(`getComputedStyle(${treeNode(name)}.querySelector('.name')).color`);
const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].some(n => n.textContent.includes(${q(text)}))`;
const clearNotes = () => js(`document.querySelectorAll('.vcs-note').forEach(n => n.remove())`);
// Monaco's context menu may live in a shadow root.
const menuItem = (label) => `(() => { const roots = [document, ...[...document.querySelectorAll('*')].filter(e => e.shadowRoot).map(e => e.shadowRoot)];
  for (const r of roots) for (const a of r.querySelectorAll('.monaco-menu .action-label')) if (a.textContent.trim() === ${q(label)}) return a; return null; })()`;
const cursorLine = () => js(`ide.editor.getPosition().lineNumber`);

try {
  // --- not a repository: Create Git Repository ---
  check(await js(`document.querySelector('.vcs-branch').classList.contains('hidden')`), 'branch widget hidden outside a git repo');
  await press('Alt+0');
  await until(`ide.toolWindows.get('Commit').isVisible()`, 'Commit window via Alt+0');
  await until(`!!document.querySelector('.vcs-init-btn')?.offsetParent`, 'Create Git Repository offered');
  check(true, 'Alt+0 opens Commit window offering "Create Git Repository" for non-repo');
  await t.click('.vcs-init-btn');
  await until(`document.querySelectorAll('.vcs-changes .vcs-file').length >= 4`, 'unversioned files listed');
  check(await js(`[...document.querySelectorAll('.vcs-group-title')].some(g => g.textContent === 'Unversioned Files')`), 'git init: files grouped as Unversioned Files');
  check(await js(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`), 'branch widget shows main after init');
  await until(`getComputedStyle(${treeNode('main.py')}.querySelector('.name')).color === 'rgb(209, 103, 90)'`, 'unversioned color in tree');
  check(true, 'project tree shows unversioned files in red');
  check(await js(`[...document.querySelectorAll('.vcs-file input')].every(c => !c.checked)`), 'unversioned files are unchecked by default');

  // --- first commit through the UI ---
  await mouse(`[...document.querySelectorAll('.vcs-group')].find(g => g.textContent.includes('Unversioned')).querySelector('input')`, { label: 'unversioned group checkbox' });
  check(await js(`[...document.querySelectorAll('.vcs-file input')].every(c => c.checked)`), 'group checkbox includes all its files');
  await js(`ide.editor.focus()`);
  await press('Ctrl+K');
  await until(`document.activeElement?.classList.contains('vcs-msg')`, 'Ctrl+K focuses commit message');
  check(true, 'Ctrl+K focuses the commit message box');
  await type('Initial commit');
  await t.click('.vcs-commit-btn');
  await until(`document.querySelectorAll('.vcs-changes .vcs-file').length === 0`, 'clean after commit');
  check(git(project, 'log', '--format=%s') === 'Initial commit', 'Commit button creates the commit with the selected files');
  check(git(project, 'ls-files').split('\n').length === 4, 'all 4 files committed');
  check(await js(noteWith('4 files committed')), 'commit notification shown');
  await until(`getComputedStyle(${treeNode('main.py')}.querySelector('.name')).color !== 'rgb(209, 103, 90)'`, 'tree color cleared');
  check(true, 'tree colors clear after commit');

  // a second author, committed outside the IDE; focus brings the IDE up to date
  writeFileSync(path.join(project, 'util', 'helpers.py'), 'def double(x):\n    return x * 2\n\n\ndef triple(x):\n    return x * 3  # by Bob\n');
  git(project, '-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-qam', 'Bob tweaks triple');

  // --- Rollback Lines when the file's only change is added lines (one hunk with no HEAD lines) ---
  await openFile(t, 'util/helpers.py');
  const headHelpers = await js('ide.activeTab().model.getValue()');
  await js(`ide.editor.setPosition({ lineNumber: 3, column: 1 }), ide.editor.focus()`);
  await type('# only change\n');
  await until(`!!document.querySelector('.vcs-added')`, 'added marker for the only change');
  await js(`ide.editor.setPosition({ lineNumber: 3, column: 2 })`);
  await press('Ctrl+Alt+Z');
  await until(`ide.activeTab().model.getValue() === ${q(headHelpers)}`, 'only change rolled back');
  check(true, 'Rollback Lines removes added lines that are the only change in the file');
  await press('Ctrl+S');

  // --- gutter markers and change navigation ---
  await openFile(t, 'main.py');
  await js(`ide.editor.setPosition({ lineNumber: 14, column: 1 }), ide.editor.focus()`);
  await press('Ctrl+Y'); // delete line 14
  await js(`ide.editor.setPosition({ lineNumber: 9, column: 17 })`);
  await type('\n'); // a raw Enter key event carries no text for Monaco, so type the newline
  await type('# added line');
  await js(`ide.editor.setPosition({ lineNumber: 5, column: 29 })`);
  await type('  # changed');
  await until(`!!(document.querySelector('.vcs-added') && document.querySelector('.vcs-modified') && document.querySelector('.vcs-deleted'))`, 'gutter markers');
  check(true, 'gutter shows added, modified and deleted markers while typing');
  const marks = await js(`ide.activeTab().model.getAllDecorations().filter(d => /vcs-(added|modified|deleted)/.test(d.options.linesDecorationsClassName || '')).map(d => d.options.linesDecorationsClassName.split(' ')[1] + ':' + d.range.startLineNumber + '-' + d.range.endLineNumber).join(',')`);
  check(marks === 'vcs-modified:5-5,vcs-added:10-10,vcs-deleted:15-15', `marker ranges (got ${marks})`);
  await js(`ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  const nav = [];
  for (let i = 0; i < 4; i++) { await press('Ctrl+Alt+Shift+ArrowDown'); nav.push(await cursorLine()); }
  check(nav.join() === '5,10,15,5', `Ctrl+Alt+Shift+Down walks changes (got ${nav})`);
  await press('Ctrl+Alt+Shift+ArrowUp');
  check(await cursorLine() === 15, 'Ctrl+Alt+Shift+Up goes to previous change (wraps)');
  await shot('gutter.png');

  // Rollback Lines (Ctrl+Alt+Z in the editor) on the added line
  await js(`ide.editor.setPosition({ lineNumber: 10, column: 3 })`);
  await press('Ctrl+Alt+Z');
  await until(`!ide.activeTab().model.getValue().includes('# added line')`, 'hunk rolled back');
  check(true, 'Ctrl+Alt+Z in editor rolls back the change under the caret');
  await press('Ctrl+S');
  await until(`!!${fileRow('main.py')}`, 'main.py listed as changed');
  check(await js(`${fileRow('main.py')}.dataset.status === 'modified'`), 'saved edit shows main.py under Changes');
  await until(`getComputedStyle(${treeNode('main.py')}.querySelector('.name')).color === 'rgb(104, 151, 187)'`, 'modified color');
  check(true, 'project tree shows modified file in blue');

  // --- side-by-side diff from the Commit window ---
  await mouse(fileRow('main.py'), { clickCount: 2, label: 'main.py change row' });
  await until(`ide.activeTab()?.kind === 'custom' && ide.activeTab().title === 'Diff: main.py'`, 'diff tab');
  await until(`!!document.querySelector('.custom-tab:not(.hidden) .monaco-diff-editor') && document.querySelector('.custom-tab:not(.hidden)')._vcsDiff.getLineChanges()?.length >= 2`, 'diff computed');
  const diffSides = await js(`(() => { const d = document.querySelector('.custom-tab:not(.hidden)')._vcsDiff; return [d.getOriginalEditor().getValue().includes('print(add(2, 3))'), d.getModifiedEditor().getValue().includes('# changed')]; })()`);
  check(diffSides[0] && diffSides[1], 'double-click opens HEAD vs working copy diff editor');
  await shot('diff.png');
  await press('Ctrl+F4');

  // --- unversioned file from the IDE ---
  await js(`ide.editor.focus()`);
  await press('Alt+Insert');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'new file prompt');
  await js(`document.querySelector('#popupIn').value = ''`);
  await type('extra');
  await press('Enter');
  await until(`!!${fileRow('extra.py')}`, 'extra.py listed');
  check(await js(`${fileRow('extra.py')}.dataset.status === 'unversioned'`), 'new file appears under Unversioned Files');

  // --- annotate (git blame) from the editor context menu ---
  await openFile(t, 'util/helpers.py');
  // Code vision's lens above double() pushes the lines down a moment after the file opens (later on a busy machine):
  // the annotation clicked below is the one on Bob's line only once it is there.
  await until(lensesShown(), 'code lenses shown');
  await js(`ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  await frame();
  const textBox = await js(`(() => { const r = document.querySelector('#editor .view-line').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 8 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: textBox.x, y: textBox.y, button: 'right', clickCount: 1 });
  await until(`!!${menuItem('Annotate with Git Blame')}`, 'context menu item');
  await mouse(menuItem('Annotate with Git Blame'), { label: 'Annotate menu item' });
  await until(`document.querySelectorAll('#editor .vcs-blame').length >= 6`, 'blame annotations');
  await frame();
  const blameText = await js(`[...document.querySelectorAll('#editor .vcs-blame')].map(n => getComputedStyle(n, '::after').content).join('|')`);
  check(blameText.includes('Alice') && blameText.includes('Bob'), 'annotations show author per line in the gutter');
  check(await js(`ide.editor.getLayoutInfo().decorationsWidth > 60`), 'gutter widens for annotations');
  await shot('blame.png');
  // clicking a Bob line's annotation selects that commit in the Git log
  await mouse(`[...document.querySelectorAll('#editor .vcs-blame')].find(n => getComputedStyle(n, '::after').content.includes('Bob'))`, { label: 'Bob blame' });
  await until(`ide.toolWindows.get('Git').isVisible() && document.querySelector('.vcs-log-row.selected')?.textContent.includes('Bob tweaks triple')`, 'blame opens commit');
  check(true, 'clicking an annotation shows its commit in the Git log');
  // Line 1 again: code vision's lens above the first declaration may have moved the lines since.
  const textBox2 = await js(`(() => { const r = document.querySelector('#editor .view-line').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 8 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: textBox2.x + 100, y: textBox2.y, button: 'right', clickCount: 1 });
  await until(`!!${menuItem('Close Annotations')}`, 'close annotations item');
  await mouse(menuItem('Close Annotations'), { label: 'Close Annotations' });
  await until(`document.querySelectorAll('#editor .vcs-blame').length === 0`, 'annotations closed');
  check(true, 'Close Annotations removes them');

  // --- rollback a file from the Commit window ---
  await press('Alt+0'); // toggles off? ensure visible
  if (!(await js(`ide.toolWindows.get('Commit').isVisible()`))) await press('Alt+0');
  await mouse(fileRow('main.py'), { label: 'main.py row' });
  await press('Ctrl+Alt+Z');
  await until(`!!document.querySelector('.dialog')?.textContent.includes('main.py')`, 'rollback confirm');
  check(await js(`document.querySelector('.dialog-title').textContent === 'Rollback Changes'`), 'Ctrl+Alt+Z asks for confirmation');
  await t.click('.dialog .primary');
  await until(`!${fileRow('main.py')}`, 'main.py rolled back');
  check(readFileSync(path.join(project, 'main.py'), 'utf8').includes('print(add(2, 3))'), 'rollback restores HEAD content on disk');
  await until(`ide.findTab(ide.util.joinPath(ide.root, 'main.py')).model.getValue() === ${q(readFileSync(path.join(project, 'main.py'), 'utf8'))}`, 'editor reloaded');
  check(true, 'open editor reloads rolled back file');

  // --- Git log (Alt+9) ---
  await js(`ide.editor.focus()`);
  if (await js(`ide.toolWindows.get('Git').isVisible()`)) await press('Alt+9');
  await press('Alt+9');
  await until(`ide.toolWindows.get('Git').isVisible() && document.querySelectorAll('.vcs-log-rows .vcs-log-row').length === 2`, 'log rows');
  const firstRow = await js(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')][0].textContent`);
  check(firstRow.includes('Bob tweaks triple') && firstRow.includes('Bob') && firstRow.includes('main'), `log lists message, author, refs (got ${firstRow})`);
  await mouse(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].find(r => r.textContent.includes('Initial commit'))`, { label: 'Initial commit row' });
  await until(`document.querySelectorAll('.vcs-log-files .vcs-log-file').length === 4`, 'commit files');
  check(await js(`document.querySelector('.vcs-log-details').textContent.includes('Alice')`), 'selecting a commit lists its files and details');
  await mouse(`[...document.querySelectorAll('.vcs-log-file')].find(r => r.dataset.rel === 'main.py')`, { clickCount: 2, label: 'log main.py' });
  await until(`ide.activeTab()?.title.startsWith('main.py (') && document.querySelector('.custom-tab:not(.hidden)')._vcsDiff?.getModifiedEditor().getValue().includes('def main')`, 'commit diff tab');
  check(true, 'double-clicking a file in a commit opens that commit diff');
  await shot('log.png');
  await press('Ctrl+F4');

  // --- branches ---
  await t.click('.vcs-branch');
  await until(`document.querySelector('.popup-item.active')?.textContent.includes('New Branch')`, 'branch popup');
  check(await js(`[...document.querySelectorAll('.popup-item')].some(i => i.textContent.includes('main') && i.textContent.includes('current'))`), 'branch popup lists local branches');
  await press('Enter');
  await until(`document.querySelector('#popupIn').placeholder === 'New branch name'`, 'branch name prompt');
  await type('feature-x');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name').textContent === 'feature-x'`, 'on feature-x');
  check(git(project, 'branch', '--show-current') === 'feature-x', 'New Branch creates and checks out the branch');
  writeFileSync(path.join(project, 'README.md'), '# VCS fixture\n\nChanged on feature-x.\n');
  git(project, 'commit', '-qam', 'Feature work');
  await t.click('.vcs-branch');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'branch popup');
  await type('main');
  await until(`document.querySelector('.popup-item.active')?.textContent.startsWith('★main') || document.querySelector('.popup-item.active .label')?.textContent === 'main'`, 'main item');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name').textContent === 'main'`, 'back on main');
  check(git(project, 'branch', '--show-current') === 'main' && !readFileSync(path.join(project, 'README.md'), 'utf8').includes('feature-x'), 'checkout from the branch popup switches branch and files');

  // Unsaved edits are saved before a checkout (like PyCharm), so they carry over instead of a later Ctrl+S writing
  // the old branch's text over the checked-out file.
  await openFile(t, 'main.py');
  await js(`ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 })`);
  await type('# unsaved edit\n');
  check(await js(`ide.isDirty(ide.activeTab())`), 'main.py has unsaved changes before checkout');
  await t.click('.vcs-branch');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'branch popup');
  await type('feature-x');
  await until(`document.querySelector('.popup-item.active')?.textContent.includes('feature-x')`, 'feature-x item');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name').textContent === 'feature-x'`, 'on feature-x with edit');
  check(!(await js(`ide.isDirty(ide.activeTab())`)) && readFileSync(path.join(project, 'main.py'), 'utf8').startsWith('# unsaved edit')
    && readFileSync(path.join(project, 'README.md'), 'utf8').includes('feature-x'), 'checkout saves unsaved editors first and the edit carries over');
  await t.click('.vcs-branch');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'branch popup');
  await type('main');
  await until(`document.querySelector('.popup-item.active')?.textContent.startsWith('★main') || document.querySelector('.popup-item.active .label')?.textContent === 'main'`, 'main item');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name').textContent === 'main'`, 'back on main again');
  git(project, 'checkout', '--', 'main.py');
  await js(`ide.reloadFromDisk()`);
  await until(`!ide.activeTab().model.getValue().includes('# unsaved edit')`, 'main.py restored');

  // --- update / push without a remote ---
  await clearNotes();
  await press('Ctrl+T');
  await until(noteWith("Can't update"), 'no remote note');
  check(await js(noteWith('No remotes are defined')), 'Ctrl+T without a remote explains there is no remote');

  const bare = path.join(gitHome, 'remote.git');
  git(gitHome, 'init', '-q', '--bare', bare);
  await clearNotes();
  await press('Ctrl+Shift+K');
  await until(`!!document.querySelector('.dialog .vcs-remote-url')`, 'push dialog with define remote');
  check(await js(`document.querySelector('.dialog').textContent.includes('No remotes are defined') && document.querySelectorAll('.vcs-push-commit').length === 2`), 'Ctrl+Shift+K push dialog lists outgoing commits and offers to define a remote');
  await js(`document.querySelector('.vcs-remote-url').focus()`);
  await type(bare);
  await t.click('.dialog .primary');
  await until(noteWith('Pushed 2 commits to origin/main'), 'push note');
  check(git(bare, 'log', '--format=%s', 'main').split('\n').length === 2, 'push sends commits to the remote and sets upstream');
  check(await js(`document.querySelector('#vcsConsole').textContent.includes('git push')`), 'push output is logged in the Git console');

  // --- update project (pull) ---
  const clone = path.join(gitHome, 'clone');
  git(gitHome, 'clone', '-q', bare, clone);
  writeFileSync(path.join(clone, 'util', 'helpers.py'), 'def double(x):\n    return x * 2\n\n\ndef triple(x):\n    return x * 3  # by Bob\n\n\ndef square(x):\n    return x * x\n');
  git(clone, '-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-qam', 'Add square');
  git(clone, 'push', '-q');
  await openFile(t, 'util/helpers.py');
  await clearNotes();
  await press('Ctrl+T');
  await until(noteWith('1 file updated'), 'pull note');
  await until(`ide.activeTab().model.getValue().includes('def square')`, 'editor reloaded after pull');
  check(true, 'Ctrl+T pulls and reloads the open editor');

  // --- Commit and Push ---
  await press('Ctrl+K');
  await until(`document.activeElement?.classList.contains('vcs-msg')`, 'message focus');
  await mouse(`${fileRow('extra.py')}.querySelector('input')`, { label: 'extra.py checkbox' });
  await type('Add extra module');
  await clearNotes();
  await t.click('.vcs-commit-push-btn');
  await until(`!!document.querySelector('.dialog .vcs-push-target')`, 'push dialog after commit');
  check(await js(`document.querySelector('.vcs-push-target').textContent.includes('main → origin : main')`), 'Commit and Push opens push dialog for the tracked branch');
  await t.click('.dialog .primary');
  await until(noteWith('Pushed 1 commit to origin/main'), 'commit and push');
  check(git(bare, 'log', '-1', '--format=%s', 'main') === 'Add extra module', 'Commit and Push lands on the remote');

  // --- push from a detached HEAD: no branch to push, said so instead of "HEAD → origin : null" ---
  git(project, 'checkout', '-q', '--detach');
  await js('ide.vcs.refresh().then(() => true)');
  await press('Ctrl+Shift+K');
  await until(`!!document.querySelector('.dialog .vcs-push-warn')`, 'push dialog on a detached HEAD');
  check(await js(`document.querySelector('.dialog .vcs-push-warn').textContent === 'Cannot push from a detached HEAD.' && !document.querySelector('.dialog').textContent.includes('null')`),
    'the push dialog on a detached HEAD says it cannot push instead of showing a null target');
  await press('Escape');
  await until(`!document.querySelector('.dialog')`, 'push dialog closed');
  git(project, 'checkout', '-q', 'main');
  await js('ide.vcs.refresh().then(() => true)');

  // --- a staged rename commits as a rename (the original path's deletion is committed too) ---
  git(project, 'mv', 'extra.py', 'extra_renamed.py');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await until(`!!${fileRow('extra_renamed.py')}`, 'renamed file listed');
  await press('Ctrl+K');
  await until(`document.activeElement?.classList.contains('vcs-msg')`, 'message focus');
  await type('Rename extra');
  await t.click('.vcs-commit-btn');
  await until(`document.querySelectorAll('.vcs-changes .vcs-file').length === 0`, 'clean after rename commit');
  check(git(project, 'status', '--porcelain') === '' && git(project, 'show', '--name-status', '--format=', 'HEAD').startsWith('R'),
    `committing a staged rename records a rename and leaves nothing staged (${git(project, 'show', '--name-status', '--format=', 'HEAD')})`);

  // --- CP949 and UTF-8 BOM files: HEAD is read in the file's encoding, so only edited lines are changes ---
  const hangul = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" in CP949
  writeFileSync(path.join(project, 'legacy.py'), Buffer.concat([Buffer.from('# '), hangul, Buffer.from('\r\nx = 1\r\n')]));
  writeFileSync(path.join(project, 'bom.py'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a = 1\nb = 2\n')]));
  git(project, 'add', 'legacy.py', 'bom.py');
  git(project, 'commit', '-qm', 'Add CP949 and BOM files');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await openFile(t, 'legacy.py');
  await js(`ide.runAction('Annotate')`);
  const blamed = `ide.activeTab().model.getAllDecorations().filter(d => /vcs-blame/.test(d.options.linesDecorationsClassName || '')).map(d => d.range.startLineNumber).join(',')`;
  await until(`${blamed} !== ''`, 'CP949 blame');
  await sleep(300);
  const blamedLines = await js(blamed);
  check(blamedLines === '1,2', `Annotate attributes the Korean line of a CP949 file to its commit (lines ${blamedLines})`);
  await js(`ide.runAction('Annotate')`);
  await js(`(ide.closeTab(ide.util.joinPath(ide.root, 'legacy.py'), true), true)`);
  const marksOf = `ide.activeTab().model.getAllDecorations().filter(d => /vcs-(added|modified|deleted)/.test(d.options.linesDecorationsClassName || '')).map(d => d.options.linesDecorationsClassName.split(' ')[1] + ':' + d.range.startLineNumber + '-' + d.range.endLineNumber).join(',')`;
  for (const name of ['legacy.py', 'bom.py']) {
    await openFile(t, name);
    await js(`ide.editor.executeEdits('test', [{ range: new ide.monaco.Range(2, 1, 2, 1), text: 'y = 0  ' }])`);
    await until(`${marksOf} !== ''`, `${name} gutter`);
    await sleep(400);
    const got = await js(marksOf);
    check(got === 'vcs-modified:2-2', `editing line 2 of ${name === 'legacy.py' ? 'a CP949' : 'a UTF-8 BOM'} file marks only line 2 (got ${got})`);
  }
  await js(`(ide.closeTab(ide.util.joinPath(ide.root, 'bom.py'), true), true)`);
  await until(`ide.activeTab()?.title === 'legacy.py'`, 'legacy.py active');
  await js(`ide.runAction('Compare.SameVersion')`);
  await until(`!!document.querySelector('.custom-tab:not(.hidden)')?._vcsDiff`, 'CP949 diff tab');
  check(await js(`document.querySelector('.custom-tab:not(.hidden)')._vcsDiff.getOriginalEditor().getValue().startsWith('# 한글')`), 'the diff with HEAD shows a CP949 file\'s Korean text');
  await press('Ctrl+F4');
  await js(`(ide.closeTab(ide.util.joinPath(ide.root, 'legacy.py'), true), true)`);

  // --- external change picked up on window focus ---
  writeFileSync(path.join(project, 'README.md'), '# VCS fixture\n\nEdited outside.\n');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await until(`!!${fileRow('README.md')}`, 'focus refresh');
  check(true, 'window focus refreshes changes');

  // A burst of refreshes (saves, focus, file events) runs one git status at a time, not one per event.
  const burst = await js(`(async () => {
    const real = ide.api;
    let now = 0, peak = 0, calls = 0;
    ide.api = { ...real, invoke: async (ch, ...args) => {
      if (ch !== 'git:status') return real.invoke(ch, ...args);
      calls++; peak = Math.max(peak, ++now);
      try { return await real.invoke(ch, ...args); } finally { now--; }
    } };
    try { await Promise.all(Array.from({ length: 10 }, () => ide.vcs.refresh())); } finally { ide.api = real; }
    return { peak, calls };
  })()`);
  check(burst.peak === 1 && burst.calls <= 2, `ten refreshes at once run git status one at a time (${burst.calls} runs, ${burst.peak} at once)`);

  await press('Alt+9');
  if (!(await js(`ide.toolWindows.get('Git').isVisible()`))) await press('Alt+9');
  await openFile(t, 'README.md');
  await shot('final.png');
} catch (err) {
  check(false, err.message);
  console.log(await js(`JSON.stringify({ text: ide.activeTab()?.model?.getValue(), decos: ide.activeTab()?.model?.getAllDecorations().map(d => d.options.linesDecorationsClassName).filter(Boolean), dom: [...document.querySelectorAll('#editor .vcs-gutter')].map(n => n.className) })`).catch((e) => e.message));
  await shot('failure.png');
}
t.finish();
