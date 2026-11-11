// Git as the user meets it from outside the app and in the Commit window: a repository made, a commit made and files
// created outside the IDE show up without the Refresh button or a window switch (the project watcher, also on .git);
// unversioned files are grouped by folder; the changes list has its context menu (Show Diff, Jump to Source,
// Rollback with a word that it happened, Add to VCS, Delete); the Log leaves stash internals out; a diff with HEAD
// follows a commit and shows no inlay hints; a checkout that would overwrite local changes offers Smart Checkout.
// Port 9471.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-vcsoutside-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const q = JSON.stringify;

const t = await launch({ fixture: 'vcs', port: 9471, name: 'vcs-outside' });
const { js, until, check, press, type, cdp, sleep, shot, project } = t;
const P = (rel) => path.join(project, rel);
const waitFor = (expr, label, ms = 12000) => until(expr, label, ms).then(() => true, () => false);
const changeRow = (name) => `[...document.querySelectorAll('.vcs-changes .vcs-file')].find((r) => r.dataset.path.endsWith(${q(`\\${name}`)}))`;
const logSubjects = `[...document.querySelectorAll('.vcs-log-rows .vcs-log-row .vcs-subject-text')].map((n) => n.textContent)`;
async function rightClick(expr) {
  const box = await js(`(() => { const n = ${expr}; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await until(`!!document.querySelector('#vcsChangeMenu')`, 'changes menu', 5000);
}
const menuLabels = () => js(`[...document.querySelectorAll('#vcsChangeMenu .menu-item')].map((r) => (r.classList.contains('disabled') ? '-' : '') + r.querySelector('.menu-label').textContent)`);
async function menuItem(label) {
  await js(`(() => { document.querySelectorAll('[data-pick]').forEach((n) => n.removeAttribute('data-pick')); [...document.querySelectorAll('#vcsChangeMenu .menu-item')].find((r) => r.querySelector('.menu-label').textContent === ${q(label)}).dataset.pick = '1'; return true; })()`);
  await t.click('[data-pick="1"]');
}
async function answer(label) {
  await until(`!!document.querySelector('#dialogHost .dialog')`, `dialog for ${label}`, 5000);
  await js(`(() => { document.querySelectorAll('[data-answer]').forEach((n) => n.removeAttribute('data-answer')); [...[...document.querySelectorAll('#dialogHost .dialog')].pop().querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === ${q(label)}).dataset.answer = '1'; return true; })()`);
  await t.click('[data-answer="1"]');
}
const noteWith = (text) => `ide.notifications.list().some((n) => (n.title + ' ' + (n.text || '')).includes(${q(text)}))`;

try {
  await until(`!!document.querySelector('.vcs-init-btn')`, 'Commit window says there is no repository', 20000);
  await js(`(ide.toolWindows.get('Commit').show(), true)`);
  // Settle: no focus events from here on; only the watcher can tell the IDE about what happens outside.
  await sleep(1500);
  const focusRefreshes = `window.__focusEvents`;
  await js(`(window.__focusEvents = 0, window.addEventListener('focus', () => window.__focusEvents++), true)`);

  // ---- git init and a first commit in a shell outside the IDE ----
  git(project, 'init');
  git(project, 'add', '-A');
  git(project, 'commit', '-m', 'Initial commit');
  check(await waitFor(`document.querySelector('.vcs-branch-name')?.textContent === 'main' && !document.querySelector('.vcs-commit').classList.contains('hidden')`, 'repository noticed'),
    'git init and a commit made outside show up in the Commit window and the branch widget, without Refresh');

  // ---- files created outside: one group per folder, a crowded folder collapsed ----
  mkdirSync(P('data/raw'), { recursive: true });
  for (let i = 0; i < 120; i++) writeFileSync(P(`data/raw/f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
  writeFileSync(P('notes.txt'), 'notes\n');
  writeFileSync(P('scratch.txt'), 'scratch\n');
  check(await waitFor(`document.querySelectorAll('.vcs-folder').length >= 2`, 'unversioned folders'), 'files created outside appear as unversioned, without Refresh');
  const folders = await js(`[...document.querySelectorAll('.vcs-folder')].map((f) => [f.querySelector('.vcs-folder-name').textContent, f.classList.contains('open'), f.querySelector('.muted').textContent])`);
  check(folders.some(([n, open, c]) => /data[\\/]raw/.test(n) && !open && c.includes('120')) && !(await js(`!!document.querySelector('.vcs-file[data-path$="f000.txt"]')`)),
    `unversioned files are grouped by folder, collapsed when there are many (${q(folders)})`);
  for (let i = 0; i < 4 && await js(`!!document.querySelector('.vcs-folder:not(.open)')`); i++) { await t.click('.vcs-folder:not(.open)'); await sleep(200); }
  check(await waitFor(`document.querySelectorAll('.vcs-file.vcs-nested').length >= 120`, 'folder opened', 5000), 'clicking a folder row shows its files');
  await shot('unversioned-folders.png');

  // ---- the changes list's context menu ----
  writeFileSync(P('main.py'), `${readFileSync(P('main.py'), 'utf8')}# local edit\n`);
  await until(`!!${changeRow('main.py')}`, 'modified main.py listed');
  await rightClick(changeRow('notes.txt'));
  const unvMenu = await menuLabels();
  check(q(unvMenu) === q(['Show Diff', 'Jump to Source', '-Rollback…', 'Add to VCS', 'Delete…']), `an unversioned file's menu: Show Diff, Jump to Source, Add to VCS, Delete (Rollback off) (${q(unvMenu)})`);
  await menuItem('Add to VCS');
  check(await waitFor(`${changeRow('notes.txt')}?.dataset.status === 'added'`, 'notes.txt added', 8000) && git(project, 'status', '--porcelain', 'notes.txt').startsWith('A '), 'Add to VCS stages the file');
  await rightClick(changeRow('scratch.txt'));
  await menuItem('Delete…');
  await answer('Delete');
  check(await waitFor(`!${changeRow('scratch.txt')}`, 'scratch deleted', 8000) && !existsSync(P('scratch.txt')), 'Delete moves the file to the Recycle Bin after asking');
  await rightClick(changeRow('main.py'));
  check(q(await menuLabels()) === q(['Show Diff', 'Jump to Source', 'Rollback…', '-Add to VCS', 'Delete…']), 'a modified file\'s menu offers Rollback, not Add to VCS');
  await menuItem('Jump to Source');
  check(await waitFor(`ide.activeTab()?.title === 'main.py'`, 'jumped', 5000), 'Jump to Source opens the file');
  await rightClick(changeRow('main.py'));
  await menuItem('Show Diff');
  check(await waitFor(`ide.activeTab()?.title === 'Diff: main.py'`, 'diff tab', 8000), 'Show Diff opens the diff with HEAD');

  // ---- the diff with HEAD: no inlay hints, and it follows a commit ----
  const diffHost = `document.querySelector('.custom-tab:not(.hidden)')`;
  await until(`!!${diffHost}?._vcsDiff`, 'diff editor');
  check(await js(`[${diffHost}._vcsDiff.getModifiedEditor(), ${diffHost}._vcsDiff.getOriginalEditor()].every((e) => e.getOption(monaco.editor.EditorOption.inlayHints).enabled === 'off')`),
    'the diff editors show no inlay hints (only the working copy had them, so equal lines looked changed)');
  check(await js(`${diffHost}._vcsDiff.getLineChanges()?.length`) === 1, 'the diff shows the local edit');
  git(project, 'commit', '-qam', 'Commit the edit outside');
  const head = git(project, 'rev-parse', 'HEAD').slice(0, 8);
  check(await waitFor(`${diffHost}._vcsDiff.getLineChanges()?.length === 0 && ${diffHost}.querySelector('.vcs-diff-side').textContent.includes(${q(head)})`, 'diff follows HEAD'),
    'after a commit the open diff compares with the new HEAD');

  // ---- the Log: an outside commit shows up, stash internals do not ----
  await press('Alt+9');
  await until(`${logSubjects}.includes('Commit the edit outside')`, 'log', 10000);
  writeFileSync(P('later.txt'), 'later\n');
  git(project, 'add', 'later.txt');
  git(project, 'commit', '-qm', 'Made in a terminal');
  check(await waitFor(`${logSubjects}.includes('Made in a terminal')`, 'outside commit in the log'), 'a commit made outside shows in the Log without Refresh');
  writeFileSync(P('main.py'), `${readFileSync(P('main.py'), 'utf8')}# wip\n`);
  git(project, 'stash', 'push', '-m', 'wip');
  await sleep(2500);
  const subjects = await js(logSubjects);
  check(!subjects.some((s) => /^(On main: wip|index on main|WIP on)/.test(s)), `stash commits are not in the Log (${q(subjects)})`);
  git(project, 'stash', 'pop');

  // ---- Rollback says it happened ----
  await until(`!!${changeRow('main.py')}`, 'main.py modified again');
  await rightClick(changeRow('main.py'));
  await menuItem('Rollback…');
  await answer('Rollback');
  check(await waitFor(noteWith('Rolled back changes in 1 file'), 'rollback note', 8000) && !readFileSync(P('main.py'), 'utf8').includes('# wip'), 'Rollback restores the file and says so');

  // ---- Smart Checkout ----
  git(project, 'checkout', '-qb', 'other');
  writeFileSync(P('README.md'), 'other branch readme\n');
  git(project, 'commit', '-qam', 'Other readme');
  git(project, 'checkout', '-q', 'main');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'back on main');
  writeFileSync(P('README.md'), 'my local readme\n');
  await until(`!!${changeRow('README.md')}`, 'local README change');
  const checkoutOther = async () => {
    await t.click('.vcs-branch');
    await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'branch popup');
    await type('other');
    await until(`document.querySelector('.popup-item.active .label')?.textContent === 'other'`, 'other in the popup');
    await press('Enter');
    await until(`!!document.querySelector('#vcsSmartCheckout')`, 'Smart Checkout question', 10000);
  };
  await checkoutOther();
  const asked = await js(`document.querySelector('#vcsSmartCheckout').textContent`);
  check(asked.includes('README.md') && asked.includes('Smart Checkout') && !/error:|Aborting/.test(asked), `a checkout over local changes asks, naming the files, without git's raw error (${asked})`);
  await answer('Cancel');
  await sleep(500);
  check(git(project, 'branch', '--show-current') === 'main' && readFileSync(P('README.md'), 'utf8') === 'my local readme\n', 'Cancel leaves the branch and the change as they were');
  await checkoutOther();
  await answer('Smart Checkout');
  check(await waitFor(`document.querySelector('.vcs-branch-name')?.textContent === 'other'`, 'switched', 15000) && git(project, 'branch', '--show-current') === 'other',
    'Smart Checkout switches the branch');
  check(git(project, 'stash', 'list') === '' || readFileSync(P('README.md'), 'utf8').includes('my local readme'), 'and brings the local change along (or leaves it in the stash with the conflict to resolve)');
  check(await js(noteWith('Checked out other')), 'a balloon says the checkout happened');
  await shot('smart-checkout-done.png');

  // ---- no refresh loop from the IDE's own git calls ----
  await sleep(1500);
  await js(`(window.__gitCalls = 0, (() => { const inv = ide.api.invoke; ide.api.invoke = (ch, ...a) => { if (ch === 'git:status') window.__gitCalls++; return inv(ch, ...a); }; })(), true)`);
  await sleep(4000);
  const calls = await js(`window.__gitCalls`);
  check(calls <= 2, `an idle window does not keep refreshing Git (${calls} status calls in 4 s)`);
  check((await js(focusRefreshes)) === 0, 'none of this needed the window to be focused again');
} catch (err) {
  check(false, `error: ${err.message}`);
  await shot('failure.png').catch(() => {});
}
t.finish();
