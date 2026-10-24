// Git daily flows: Amend in the Commit window (the last message, a message-only amend, the question when the commit
// is already pushed), Delete and Rename of local branches from the branch popup (an unmerged branch only after a
// question, never the current one, Restore), and Show History of a file (the Log of that file followed through a
// rename, its change per commit, Show Diff and Compare with Local) from the editor, the project tree and Find Action.
// Real mouse and keyboard input, in English and Korean, at normal size and 1008x681; the main-process parts that need
// no window (a project in a subfolder, git's upstream rule for unmerged branches, --only) at the end.
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, lensesShown, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-daily-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branches = (dir) => git(dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
const q = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const V1 = 'def calc(a, b):\n    return a + b\n';
const V2 = 'def calc(a, b):\n    return a + b  # sum\n';
const V3 = `${V2}\n\ndef twice(x):\n    return 2 * x\n`;

// History for mathx.py (added as calc.py, changed, renamed, changed), a pushed main, one local commit to amend,
// a merged branch and an unmerged one.
function buildRepo(dir) {
  git(dir, 'init');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'Initial commit');
  writeFileSync(path.join(dir, 'calc.py'), V1);
  git(dir, 'add', 'calc.py');
  git(dir, 'commit', '-m', 'Add calc');
  writeFileSync(path.join(dir, 'calc.py'), V2);
  git(dir, 'commit', '-am', 'Tweak calc');
  git(dir, 'mv', 'calc.py', 'mathx.py');
  git(dir, 'commit', '-m', 'Rename calc to mathx');
  writeFileSync(path.join(dir, 'mathx.py'), V3);
  git(dir, 'commit', '-am', 'Extend mathx');
  const remote = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-daily-remote-'));
  git(remote, 'init', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-u', 'origin', 'main');
  appendFileSync(path.join(dir, 'util', 'helpers.py'), '\n\ndef hello():\n    return "hi"\n');
  git(dir, 'commit', '-am', 'Add greeting');
  git(dir, 'branch', 'merged-topic');
  git(dir, 'checkout', '-b', 'wip');
  writeFileSync(path.join(dir, 'wip.txt'), 'experiment\n');
  git(dir, 'add', 'wip.txt');
  git(dir, 'commit', '-m', 'WIP experiment');
  git(dir, 'checkout', 'main');
}

// The page helpers of verify/vcs.mjs: a frame is forced before each look, since Chromium does not paint an occluded
// window and Monaco then never renders its DOM.
function helpers(t) {
  const { js, cdp } = t;
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
  async function mouse(expr, { button = 'left', label = expr } = {}) {
    await frame();
    const box = await js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${label}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(120);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: 1 });
    await sleep(120);
  }
  const popupOpen = `!document.querySelector('#popup').classList.contains('hidden')`;
  const menuItem = (label) => `[...document.querySelectorAll('.context-menu .menu-item')].find(r => r.querySelector('.menu-label')?.textContent === ${q(label)})`;
  // Monaco's own context menu may live in a shadow root.
  const monacoItem = (label) => `(() => { const roots = [document, ...[...document.querySelectorAll('*')].filter(e => e.shadowRoot).map(e => e.shadowRoot)];
    for (const r of roots) for (const a of r.querySelectorAll('.monaco-menu .action-label')) if (a.textContent.trim() === ${q(label)}) return a; return null; })()`;
  const dialog = (title) => `[...document.querySelectorAll('.dialog')].find(d => d.querySelector('.dialog-title').textContent === ${q(title)})`;
  const dialogButton = (title, label) => `[...${dialog(title)}?.querySelectorAll('.dialog-buttons button') || []].find(b => b.textContent === ${q(label)})`;
  const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].find(n => n.textContent.includes(${q(text)}))`;
  const logSubjects = `[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].map(r => r.querySelector('.vcs-subject-text').textContent).join('|')`;
  const logRow = (subject) => `[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].find(r => r.querySelector('.vcs-subject-text').textContent === ${q(subject)})`;
  // The diff editor shown in a host (mountDiff keeps it on the host as _vcsDiff): its two texts.
  const diffTexts = (host) => js(`(() => { const d = ${host}?._vcsDiff; if (!d) return null; const m = d.getModel(); return { left: m.original.getValue(), right: m.modified.getValue() }; })()`);
  const tabDiff = `[...document.querySelectorAll('.vcs-diff-body')].map(b => b.parentElement).find(h => h._vcsDiff && h.offsetParent && !h.classList.contains('vcs-history-diff'))`;
  async function branchPopup(name) {
    await mouse(`document.querySelector('.vcs-branch')`, { label: 'branch widget' });
    await until(popupOpen, 'branch popup');
    await t.type(name);
    await until(`document.querySelector('#popupList .popup-item.active .label')?.textContent === ${q(name)}`, `${name} selected in the popup`);
  }
  async function branchMenu(name) {
    await branchPopup(name);
    await t.press('ArrowRight');
    await until(`!!document.querySelector('#vcsBranchMenu') && !document.querySelector('#popup:not(.hidden)')`, `branch menu of ${name}`);
  }
  // Right-click in the editor's text until Monaco's context menu shows `label` (a click while code lenses still move
  // the lines can land outside the text).
  async function editorMenu(label) {
    await until(lensesShown(), 'code lenses shown');
    for (let i = 0; ; i++) {
      await frame();
      const box = await js(`(() => { const r = document.querySelector('#editor .view-line').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 8 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
      try { return await until(`!!${monacoItem(label)}`, `editor context menu item ${label}`, 5000); } catch (err) { if (i === 2) throw err; }
      await t.press('Escape');
    }
  }
  return { frame, until, mouse, editorMenu, popupOpen, menuItem, monacoItem, dialog, dialogButton, noteWith, logSubjects, logRow, diffTexts, tabDiff, branchPopup, branchMenu };
}

async function untilNode(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (fn()) return true; } catch {}
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function openRepo(t, h) {
  buildRepo(t.project);
  await t.js(`(['analyze', 'todo'].forEach(k => ide.settings.set('vcs.commitChecks.' + k, false)), ide.emit('filesChanged'), true)`);
  await h.until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository detected', 20000);
}

// ---------- English ----------
const t = await launch({ fixture: 'vcs', port: 9056, name: 'vcs-daily' });
const { js, press, type, check, shot, cdp, project } = t;
const h = helpers(t);
const { until, mouse } = h;
try {
  await openRepo(t, h);

  // ---------- Amend ----------
  await press('Alt+0');
  await until(`ide.toolWindows.get('Commit').isVisible() && !!document.querySelector('#vcsAmend')?.offsetParent`, 'Commit window with Amend');
  appendFileSync(path.join(project, 'util', 'helpers.py'), '# tidy\n');
  await js(`(ide.emit('filesChanged'), true)`);
  await until(`[...document.querySelectorAll('.vcs-changes .vcs-file')].some(r => r.dataset.path.endsWith('helpers.py'))`, 'helpers.py changed');
  await mouse(`document.querySelector('.vcs-msg')`, { label: 'message box' });
  await type('draft note');
  const parentBefore = git(project, 'rev-parse', 'HEAD^');
  const countBefore = git(project, 'rev-list', '--count', 'HEAD');
  const amendAt = `(() => { const r = document.querySelector('#vcsAmend').getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y); })()`;
  const amendBefore = await js(amendAt);
  await mouse(`document.querySelector('#vcsAmend')`, { label: 'Amend' });
  await until(`document.querySelector('.vcs-msg').value === 'Add greeting'`, 'last message in the box');
  check(await js(`document.querySelector('.vcs-commit-btn').textContent === 'Amend Commit' && document.querySelector('.vcs-commit-push-btn').textContent === 'Amend Commit and Push…'`),
    'ticking Amend puts the last commit message in the box and the buttons say Amend Commit');
  check(await js(amendAt) === amendBefore, `the Amend checkbox stays under the pointer when the buttons' labels grow (${amendBefore} -> ${await js(amendAt)})`);
  await mouse(`document.querySelector('#vcsAmend')`, { label: 'Amend off' });
  await until(`document.querySelector('.vcs-msg').value === 'draft note'`, 'draft back');
  check(await js(`document.querySelector('.vcs-commit-btn').textContent === 'Commit'`), 'unticking Amend brings back the message typed before and the Commit button');
  await mouse(`document.querySelector('#vcsAmend')`, { label: 'Amend on' });
  await until(`document.querySelector('.vcs-msg').value === 'Add greeting'`, 'last message again');
  await mouse(`document.querySelector('.vcs-msg')`, { label: 'message box' });
  await press('Ctrl+A');
  await type('Add a friendlier greeting');
  await shot('amend.png');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Amend Commit' });
  await untilNode(() => git(project, 'log', '-1', '--format=%s') === 'Add a friendlier greeting', 'amended commit');
  check(git(project, 'rev-list', '--count', 'HEAD') === countBefore && git(project, 'rev-parse', 'HEAD^') === parentBefore,
    'Amend Commit replaces the last commit (same parent, no new commit)');
  check(git(project, 'show', 'HEAD:util/helpers.py').includes('# tidy') && git(project, 'status', '--porcelain') === '', 'the ticked change goes into the amended commit');
  await until(`!document.querySelector('#vcsAmend').checked && document.querySelector('.vcs-commit-btn').textContent === 'Commit' && document.querySelector('.vcs-msg').value === ''`, 'Amend reset');
  check(await js(`!document.querySelector('.dialog') && !!${h.noteWith('Amended the last commit: Add a friendlier greeting')}`),
    'a commit not pushed yet is amended without a question, Amend is off afterwards');

  writeFileSync(path.join(project, 'main.py'), `${readFileSync(path.join(project, 'main.py'), 'utf8')}# local only\n`);
  await js(`(ide.emit('filesChanged'), true)`);
  await until(`[...document.querySelectorAll('.vcs-changes .vcs-file')].some(r => r.dataset.path.endsWith('main.py'))`, 'main.py changed');
  await mouse(`[...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith('main.py')).querySelector('input')`, { label: 'main.py checkbox' });
  await until(`![...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith('main.py')).querySelector('input').checked`, 'main.py unticked');
  await mouse(`document.querySelector('#vcsAmend')`, { label: 'Amend' });
  await until(`document.querySelector('.vcs-msg').value === 'Add a friendlier greeting'`, 'amended message in the box');
  await mouse(`document.querySelector('.vcs-msg')`, { label: 'message box' });
  await press('Ctrl+A');
  await type('Add a friendly greeting');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Amend Commit (message only)' });
  await untilNode(() => git(project, 'log', '-1', '--format=%s') === 'Add a friendly greeting', 'message-only amend');
  check(git(project, 'diff', '--name-only', 'HEAD^', 'HEAD') === 'util/helpers.py' && git(project, 'status', '--porcelain') === 'M main.py',
    'Amend with no file ticked changes only the message; the unticked change stays local');
  git(project, 'checkout', '--', 'main.py');

  git(project, 'push');
  await js(`(ide.emit('filesChanged'), true)`);
  await until(`document.querySelector('.vcs-msg').value === '' && !document.querySelector('#vcsAmend').checked`, 'ready');
  await mouse(`document.querySelector('#vcsAmend')`, { label: 'Amend (pushed)' });
  await until(`document.querySelector('.vcs-msg').value === 'Add a friendly greeting'`, 'pushed message');
  await mouse(`document.querySelector('.vcs-msg')`, { label: 'message box' });
  await press('Ctrl+A');
  await type('Add a friendly greeting!');
  const pushedHead = git(project, 'rev-parse', 'HEAD');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Amend Commit (pushed)' });
  await until(`!!${h.dialog('Amend Commit')}`, 'pushed warning');
  check(await js(`${h.dialog('Amend Commit')}.querySelector('.dialog-body').textContent.includes('The last commit is already pushed to origin/main.')`),
    'amending a commit already on its upstream asks first, naming the upstream');
  await shot('amend-pushed.png');
  await mouse(h.dialogButton('Amend Commit', 'Cancel'), { label: 'Cancel' });
  await until(`!document.querySelector('.dialog')`, 'question closed');
  check(git(project, 'rev-parse', 'HEAD') === pushedHead && await js(`document.querySelector('#vcsAmend').checked`), 'Cancel leaves the pushed commit and Amend as they were');
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Amend Commit (pushed, again)' });
  await until(`!!${h.dialog('Amend Commit')}`, 'pushed warning again');
  await mouse(h.dialogButton('Amend Commit', 'Amend Commit'), { label: 'confirm amend' });
  await untilNode(() => git(project, 'log', '-1', '--format=%s') === 'Add a friendly greeting!', 'pushed commit amended');
  check(git(project, 'rev-parse', 'HEAD^') === git(project, 'rev-parse', 'origin/main^'), 'confirming amends the pushed commit (HEAD now differs from origin/main)');

  // ---------- Delete and Rename branches ----------
  // the amends above left merged-topic on the first "Add greeting", which main no longer contains
  git(project, 'branch', '-f', 'merged-topic', 'HEAD');
  const mergedHash = git(project, 'rev-parse', 'merged-topic');
  await h.branchMenu('merged-topic');
  check(await js(`[...document.querySelectorAll('#vcsBranchMenu .menu-item')].map(r => r.querySelector('.menu-label').textContent + (r.classList.contains('disabled') ? '(off)' : '')).join('|')`) === 'Checkout|Rename…|Delete',
    'Right on a local branch in the popup opens Checkout, Rename… and Delete');
  await shot('branch-menu.png');
  for (let i = 0; i < 3; i++) await press('ArrowDown');
  await press('Enter');
  await untilNode(() => !branches(project).includes('merged-topic'), 'merged-topic deleted');
  await until(`!!${h.noteWith('Deleted branch merged-topic')}`, 'deleted notification');
  check(true, 'Delete removes a merged branch at once and says so');
  await mouse(`[...${h.noteWith('Deleted branch merged-topic')}.querySelectorAll('.ide-balloon-action')].find(b => b.textContent === 'Restore')`, { label: 'Restore' });
  await untilNode(() => branches(project).includes('merged-topic'), 'merged-topic restored');
  check(git(project, 'rev-parse', 'merged-topic') === mergedHash, 'Restore in the notification brings the branch back at its commit');

  await h.branchPopup('wip');
  await mouse(`[...document.querySelectorAll('#popupList .popup-item')].find(r => r.querySelector('.label')?.textContent === 'wip')`, { button: 'right', label: 'wip row' });
  await until(`!!document.querySelector('#vcsBranchMenu')`, 'branch menu by right-click');
  check(git(project, 'branch', '--show-current') === 'main', 'a right-click on a branch opens its actions instead of checking it out');
  await mouse(h.menuItem('Delete'), { label: 'Delete' });
  await until(`!!${h.dialog('Branch Is Not Fully Merged')}`, 'unmerged question');
  check(await js(`(() => { const d = ${h.dialog('Branch Is Not Fully Merged')}; return d.textContent.includes('The branch wip is not fully merged to the branch main.') && d.querySelector('.vcs-unmerged-commits').textContent.includes('WIP experiment'); })()`),
    'an unmerged branch is not deleted without a question listing its unmerged commits');
  await shot('branch-unmerged.png');
  await mouse(h.dialogButton('Branch Is Not Fully Merged', 'Cancel'), { label: 'Cancel' });
  await until(`!document.querySelector('.dialog')`, 'question closed');
  check(branches(project).includes('wip'), 'Cancel keeps the unmerged branch');
  await h.branchMenu('wip');
  await mouse(h.menuItem('Delete'), { label: 'Delete' });
  await until(`!!${h.dialog('Branch Is Not Fully Merged')}`, 'unmerged question again');
  await mouse(h.dialogButton('Branch Is Not Fully Merged', 'Delete'), { label: 'Delete anyway' });
  await untilNode(() => !branches(project).includes('wip'), 'wip deleted');
  check(true, 'Delete in the question deletes the unmerged branch');

  await h.branchMenu('main');
  check(await js(`[...document.querySelectorAll('#vcsBranchMenu .menu-item')].map(r => r.querySelector('.menu-label').textContent + (r.classList.contains('disabled') ? '(off)' : '')).join('|')`) === 'Checkout(off)|Rename…|Delete(off)',
    'the current branch can be renamed but not deleted');
  await press('Escape');
  await until(`!document.querySelector('#vcsBranchMenu')`, 'menu closed');

  await h.branchMenu('merged-topic');
  await press('ArrowDown');
  await press('ArrowDown');
  await press('Enter');
  await until(`${h.popupOpen} && document.querySelector('#popupIn').placeholder === 'Rename branch merged-topic to' && document.querySelector('#popupIn').value === 'merged-topic'`, 'rename prompt');
  await press('Ctrl+A');
  await type('topic renamed');
  await press('Enter');
  await untilNode(() => branches(project).includes('topic-renamed') && !branches(project).includes('merged-topic'), 'renamed');
  check(true, 'Rename… renames a local branch (spaces become dashes, as for New Branch)');

  await h.branchMenu('main');
  await mouse(h.menuItem('Rename…'), { label: 'Rename current' });
  await until(`${h.popupOpen} && document.querySelector('#popupIn').value === 'main'`, 'rename prompt for main');
  await press('Ctrl+A');
  await type('trunk');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'trunk'`, 'widget shows trunk');
  check(git(project, 'branch', '--show-current') === 'trunk' && git(project, 'rev-parse', '--abbrev-ref', 'trunk@{u}') === 'origin/main',
    'renaming the current branch updates the branch widget and keeps its upstream');

  await h.branchPopup('topic-renamed');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'topic-renamed'`, 'Enter checks out');
  await h.branchPopup('trunk');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'trunk'`, 'back on trunk');
  check(true, 'Enter on a branch in the popup still checks it out');

  // ---------- Show History ----------
  await openFile(t, 'mathx.py');
  const mathx = path.join(project, 'mathx.py');
  await h.editorMenu('Git: Show History');
  await mouse(h.monacoItem('Git: Show History'), { label: 'Git: Show History' });
  const HISTORY = 'Extend mathx|Rename calc to mathx|Tweak calc|Add calc';
  await until(`ide.toolWindows.get('Git').isVisible() && ${h.logSubjects} === ${q(HISTORY)}`, 'file history', 20000);
  check(await js(`!document.querySelector('#vcsLogPath').classList.contains('hidden') && document.querySelector('#vcsLogPath .vcs-log-path-name').textContent === 'mathx.py'`),
    'the editor\'s Git: Show History lists only the commits of mathx.py, through its rename, under a Path filter');
  await until(`document.querySelector('.vcs-log-row.selected')?.textContent.includes('Extend mathx') && !!document.querySelector('.vcs-history-diff')?._vcsDiff`, 'preview of the newest change');
  let d = await h.diffTexts(`document.querySelector('.vcs-history-diff')`);
  check(d?.left === V2 && d?.right === V3, 'the selected commit\'s change of the file shows beside the list');
  await shot('history.png');
  await press('ArrowDown');
  await until(`document.querySelector('.vcs-log-files .vcs-side-title')?.textContent === 'calc.py → mathx.py'`, 'rename preview');
  d = await h.diffTexts(`document.querySelector('.vcs-history-diff')`);
  check(d?.left === V2 && d?.right === V2, 'the rename commit shows the old and new name and an unchanged text');
  await press('ArrowDown');
  await until(`document.querySelector('.vcs-log-files .vcs-side-title')?.textContent === 'calc.py'`, 'calc.py preview');
  d = await h.diffTexts(`document.querySelector('.vcs-history-diff')`);
  check(d?.left === V1 && d?.right === V2, 'an older commit shows the file under its old name');
  await press('Enter');
  await until(`ide.activeTab()?.kind !== 'file' && !!${h.tabDiff}`, 'Show Diff tab');
  d = await h.diffTexts(h.tabDiff);
  check(d?.left === V1 && d?.right === V2 && await js(`ide.activeTab().path.includes(${q(git(project, 'rev-parse', 'HEAD~3').slice(0, 8))})`), 'Enter opens the commit\'s diff of the file in a tab');

  await mouse(h.logRow('Add calc'), { button: 'right', label: 'Add calc row' });
  await until(`!!${h.menuItem('Compare with Local')}`, 'history row menu');
  check((await js(`[...document.querySelectorAll('.context-menu .menu-item .menu-label')].map(n => n.textContent).join('|')`)).startsWith('Show Diff|Compare with Local'),
    'a history row offers Show Diff and Compare with Local');
  await mouse(h.menuItem('Compare with Local'), { label: 'Compare with Local' });
  await until(`ide.activeTab()?.title === 'Diff: mathx.py' && !!${h.tabDiff}`, 'Compare with Local tab');
  d = await h.diffTexts(h.tabDiff);
  check(d?.left === V1 && d?.right === V3 && await js(`${h.tabDiff}._vcsDiff.getModel().modified === ide.findTab(${q(mathx)}).model`),
    'Compare with Local shows that version against the open editor\'s text');
  await shot('history-compare-local.png');

  await mouse(`document.querySelector('#vcsLogPath .vcs-log-path-close')`, { label: 'Show All Commits' });
  await until(`document.querySelector('#vcsLogPath').classList.contains('hidden') && ${h.logSubjects}.includes('Initial commit') && ${h.logSubjects}.includes('Add a friendly greeting!')`, 'all commits again');
  await until(`!document.querySelector('.vcs-history-diff') && !!document.querySelector('.vcs-log-files .vcs-side-title')?.textContent.endsWith('changed')`, 'changed files beside the log');
  check(true, 'the × on the Path filter lists every commit again, with the changed files beside them');

  await press('Alt+1');
  await until(`ide.toolWindows.get('Project').isVisible() && [...document.querySelectorAll('#tree .node')].some(n => n.querySelector('.name').textContent === 'mathx.py' && n.getClientRects().length)`, 'project tree');

  await mouse(`[...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name').textContent === 'mathx.py')`, { button: 'right', label: 'mathx.py in the tree' });
  await until(`!!${h.menuItem('Git: Show History')}`, 'tree menu item');
  await mouse(h.menuItem('Git: Show History'), { label: 'tree Git: Show History' });
  await until(`${h.logSubjects} === ${q(HISTORY)}`, 'history from the tree');
  check(true, 'the project tree\'s Git: Show History opens the same history');
  await mouse(`[...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name').textContent === 'README.md')`, { button: 'right', label: 'README.md in the tree' });
  await until(`document.querySelectorAll('.context-menu .menu-item').length > 0`, 'tree menu');
  check(await js(`!!${h.menuItem('Git: Show History')}`), 'a committed file in the tree offers Git: Show History');
  await press('Escape');
  writeFileSync(path.join(project, 'scratch.py'), 'x = 1\n');
  await js(`(ide.emit('filesChanged'), ide.refreshTree(), true)`);
  await until(`[...document.querySelectorAll('.vcs-changes .vcs-file')].some(r => r.dataset.path.endsWith('scratch.py')) && [...document.querySelectorAll('#tree .node')].some(n => n.querySelector('.name').textContent === 'scratch.py')`, 'scratch.py unversioned');
  await mouse(`[...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name').textContent === 'scratch.py')`, { button: 'right', label: 'scratch.py in the tree' });
  await until(`document.querySelectorAll('.context-menu .menu-item').length > 0`, 'tree menu for scratch.py');
  check(await js(`!${h.menuItem('Git: Show History')}`), 'an unversioned file has no Git: Show History');
  await press('Escape');

  await js(`(ide.runAction('Git.Log'), true)`);
  await until(`document.querySelector('#vcsLogPath').classList.contains('hidden') && ${h.logSubjects}.includes('Initial commit')`, 'Show Git Log');
  check(true, 'Show Git Log leaves the file history for the whole log');
  await openFile(t, 'mathx.py');
  await press('Ctrl+Shift+A');
  await until(h.popupOpen, 'Find Action');
  await type('Show History');
  await until(`document.querySelector('#popupList .popup-item.active .label')?.textContent === 'Show History'`, 'Show History found');
  await press('Enter');
  await until(`${h.logSubjects} === ${q(HISTORY)}`, 'history from Find Action');
  check(true, 'Find Action finds Show History for the current file');

  // ---------- 1008x681 ----------
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await sleep(400);
  const narrowHistory = await js(`(() => {
    const box = (n) => n.getBoundingClientRect();
    const bar = box(document.querySelector('.vcs-log-bar'));
    const chip = box(document.querySelector('#vcsLogPath'));
    const diff = box(document.querySelector('.vcs-history-diff .vcs-diff-body'));
    return { chipInside: chip.left >= bar.left && chip.right <= bar.right + 0.5 && chip.width > 60, diffW: Math.round(diff.width), diffH: Math.round(diff.height) };
  })()`);
  check(narrowHistory.chipInside && narrowHistory.diffW >= 200 && narrowHistory.diffH >= 60, `1008x681: the Path filter and the change preview fit (${q(narrowHistory)})`);
  await shot('history-narrow.png');
  await press('Alt+0');
  await until(`ide.toolWindows.get('Commit').isVisible()`, 'Commit window');
  const narrowCommit = await js(`(() => {
    const tool = document.querySelector('.vcs-commit').getBoundingClientRect();
    const label = document.querySelector('.vcs-amend').getBoundingClientRect();
    const btn = document.querySelector('.vcs-commit-btn').getBoundingClientRect();
    return { inside: label.left >= tool.left && label.right <= tool.right + 0.5 && label.bottom <= btn.top, oneLine: label.height < 30, btn: btn.width > 40 && btn.bottom <= innerHeight };
  })()`);
  check(narrowCommit.inside && narrowCommit.oneLine && narrowCommit.btn, `1008x681: Amend stays whole above the Commit buttons (${q(narrowCommit)})`);
  await shot('amend-narrow.png');
  await cdp('Emulation.clearDeviceMetricsOverride');

  // ---------- Show History of a binary file ----------
  const model = path.join(project, 'model.bin');
  writeFileSync(model, randomBytes(4 << 20));
  git(project, 'add', 'model.bin'); git(project, 'commit', '-m', 'Add model');
  writeFileSync(model, randomBytes(4 << 20));
  git(project, 'commit', '-am', 'Retrain model');
  await js(`(() => {
    window.__fileAtChars = 0;
    const invoke = ide.api.invoke;
    ide.api.invoke = async (ch, ...args) => { const r = await invoke(ch, ...args); if (ch === 'git:fileAt') window.__fileAtChars += typeof r === 'string' ? r.length : JSON.stringify(r ?? null).length; return r; };
    return true;
  })()`);
  await js(`(ide.vcs.showHistory(${q(model)}), true)`);
  const binaryPreview = (subject) => `document.querySelector('.vcs-log-row.selected')?.textContent.includes(${q(subject)}) && document.querySelector('.vcs-log-files .vcs-side-title')?.textContent === 'model.bin'
    && document.querySelector('.vcs-history-binary')?.textContent === 'Binary file' && !document.querySelector('.vcs-history-diff')`;
  await until(`${h.logSubjects} === 'Retrain model|Add model'`, 'history of model.bin', 20000);
  let shownBinary = true;
  try { await until(binaryPreview('Retrain model'), 'binary preview', 8000); } catch { shownBinary = false; }
  check(shownBinary, 'Show History of a binary file says "Binary file" beside the list instead of a diff of its bytes');
  await press('ArrowDown');
  try { await until(binaryPreview('Add model'), 'binary preview of the older commit', 8000); } catch { shownBinary = false; }
  await press('ArrowUp');
  await sleep(1500);
  const shipped = await js(`window.__fileAtChars`);
  check(shownBinary && shipped < 1000, `moving through the history of a binary file does not send its contents to the window (${shipped} characters)`);
  const tabsBefore = await js(`ide.tabs.length`);
  await press('Enter');
  let noted = true;
  try { await until(`!!${h.noteWith('model.bin is a binary file')}`, 'binary notification', 5000); } catch { noted = false; }
  check(noted && await js(`ide.tabs.length`) === tabsBefore, 'Show Diff on a binary file\'s commit says it is binary and opens no diff of its bytes');
  await js(`(ide.vcs.showHistory(null), true)`);

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.close();

// ---------- Korean ----------
const OWN = new Set(Object.keys(JSON.parse(readFileSync(path.join(APP, 'renderer/features/vcs/locales/ko.json'), 'utf8'))));
const src = readFileSync(path.join(APP, 'renderer/features/vcs/index.js'), 'utf8');
for (const m of src.matchAll(/\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) OWN.add(m[2].replace(/\\'/g, "'"));
const k = await launch({ fixture: 'vcs', port: 9057, name: 'vcs-daily-ko', lang: 'ko-KR' });
const hk = helpers(k);
try {
  await k.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  await openRepo(k, hk);
  const leaks = [];
  await k.press('Alt+0');
  await hk.until(`ide.toolWindows.get('Commit').isVisible() && !!document.querySelector('#vcsAmend')?.offsetParent`, 'ko Commit window');
  git(k.project, 'push');
  await hk.mouse(`document.querySelector('#vcsAmend')`, { label: 'ko Amend' });
  await hk.until(`document.querySelector('.vcs-msg').value === 'Add greeting' && document.querySelector('.vcs-commit-btn').textContent === '커밋 수정'`, 'ko amend labels');
  k.check(await k.js(`document.querySelector('.vcs-amend').textContent === '커밋 수정' && document.querySelector('.vcs-commit-push-btn').textContent === '커밋 수정 및 푸시…'`), 'Amend and its buttons read in Korean');
  leaks.push(...await englishLeaks(k, '.vcs-commit-btns'));
  await hk.mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'ko Amend Commit' });
  await hk.until(`!!${hk.dialog('커밋 수정')}`, 'ko pushed warning');
  leaks.push(...await englishLeaks(k, '.dialog'));
  await k.shot('amend-pushed-ko.png');
  await hk.mouse(hk.dialogButton('커밋 수정', '취소'), { label: 'ko Cancel' });
  await hk.until(`!document.querySelector('.dialog')`, 'ko question closed');
  await hk.mouse(`document.querySelector('#vcsAmend')`, { label: 'ko Amend off' });

  await k.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await hk.until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'ko viewport 1008x681');
  await k.sleep(400);
  k.check(await k.js(`(() => { const tool = document.querySelector('.vcs-commit').getBoundingClientRect(); const l = document.querySelector('.vcs-amend').getBoundingClientRect(); return l.height < 30 && l.right <= tool.right + 0.5; })()`),
    'ko 1008x681: 커밋 수정 stays on one line inside the Commit window');

  await hk.branchMenu('wip');
  k.check(await k.js(`[...document.querySelectorAll('#vcsBranchMenu .menu-label')].map(n => n.textContent).join('|')`) === '브랜치 전환|이름 변경…|삭제', 'the branch actions read in Korean');
  leaks.push(...await englishLeaks(k, '#vcsBranchMenu'));
  await hk.mouse(hk.menuItem('삭제'), { label: 'ko Delete' });
  await hk.until(`!!${hk.dialog('브랜치가 완전히 병합되지 않음')}`, 'ko unmerged question');
  leaks.push(...await englishLeaks(k, '.dialog'));
  await k.shot('branch-unmerged-ko.png');
  await hk.mouse(hk.dialogButton('브랜치가 완전히 병합되지 않음', '삭제'), { label: 'ko Delete anyway' });
  await hk.until(`!!${hk.noteWith('wip 브랜치를 삭제했습니다')}`, 'ko deleted notification');
  leaks.push(...await englishLeaks(k, '.vcs-note'));
  k.check(await k.js(`[...${hk.noteWith('wip 브랜치를 삭제했습니다')}.querySelectorAll('.ide-balloon-action')].some(b => b.textContent === '복원')`), 'the deleted-branch notification offers 복원');

  await openFile(k, 'mathx.py');
  await hk.editorMenu('Git: 기록 표시');
  await hk.mouse(hk.monacoItem('Git: 기록 표시'), { label: 'ko Git: 기록 표시' });
  await hk.until(`${hk.logSubjects} === 'Extend mathx|Rename calc to mathx|Tweak calc|Add calc' && !!document.querySelector('.vcs-history-diff')?._vcsDiff`, 'ko history', 20000);
  k.check(await k.js(`document.querySelector('#vcsLogPath').textContent.startsWith('경로:') && document.querySelector('#vcsLogPath .vcs-log-path-close').title === '모든 커밋 표시'`), 'the Path filter reads in Korean');
  const chip = await k.js(`(() => { const b = document.querySelector('.vcs-log-bar').getBoundingClientRect(); const c = document.querySelector('#vcsLogPath').getBoundingClientRect(); return c.right <= b.right + 0.5 && c.height < 28; })()`);
  k.check(chip, 'ko 1008x681: the Path filter fits the Log bar on one line');
  leaks.push(...await englishLeaks(k, '.vcs-log-bar, .vcs-log-side'));
  await k.shot('history-ko.png');
  await hk.mouse(hk.logRow('Add calc'), { button: 'right', label: 'ko history row' });
  await hk.until(`!!${hk.menuItem('로컬과 비교')}`, 'ko history row menu');
  leaks.push(...await englishLeaks(k, '.context-menu'));
  await k.press('Escape');
  await k.cdp('Emulation.clearDeviceMetricsOverride');

  k.check(!leaks.length, `no English leaks in the Korean Amend, branch and history UI${leaks.length ? ` ${q(leaks)}` : ''}`);
  const missing = (await missingTranslations(k)).filter((s) => OWN.has(s));
  k.check(!missing.length, `every Git string shown has a Korean translation${missing.length ? ` ${q(missing)}` : ''}`);
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${q(k.consoleErrors)}` : ''}`);
} catch (err) {
  k.check(false, err.message);
}
for (const r of k.results) t.results.push(r);
k.close();

// ---------- main process only ----------
{
  const require = createRequire(path.join(APP, 'main/features/git.js'));
  const handlers = {};
  require(path.join(APP, 'main/features/git.js')).register({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: () => {} },
    app: { getPath: () => mkdtempSync(path.join(tmpdir(), 'pyide-vcs-daily-main-')), on: () => {} },
  });
  const call = (name, ...args) => handlers[`git:${name}`](null, ...args);
  try {
    const repo = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-daily-sub-'));
    const sub = path.join(repo, 'pkg');
    execFileSync('git', ['init', repo]);
    mkdirSync(sub);
    writeFileSync(path.join(sub, 'a.py'), 'A = 1\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'add a');
    git(repo, 'mv', 'pkg/a.py', 'pkg/b.py'); git(repo, 'commit', '-m', 'a to b');
    writeFileSync(path.join(sub, 'b.py'), 'A = 2\n'); git(repo, 'commit', '-am', 'change b');
    const hist = await call('fileHistory', sub, path.join(sub, 'b.py'));
    t.check(hist.map((c) => `${c.subject}:${c.orig ? `${c.orig}>` : ''}${c.rel}:${c.status}`).join('|') === 'change b:pkg/b.py:modified|a to b:pkg/a.py>pkg/b.py:renamed|add a:pkg/a.py:added',
      `fileHistory of a project that is a subfolder of the work tree gives repo-relative paths through the rename (${q(hist.map((c) => [c.subject, c.orig, c.rel, c.status]))})`);

    writeFileSync(path.join(sub, 'c.py'), 'C = 1\n');
    git(repo, 'add', 'pkg/c.py');
    const amended = await call('commit', sub, 'change b, reworded', [], { amend: true });
    t.check(amended.ok && git(repo, 'log', '-1', '--format=%s') === 'change b, reworded' && git(repo, 'status', '--porcelain') === 'A  pkg/c.py',
      'a message-only amend leaves out what else is staged');

    const remote = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-daily-up-'));
    git(remote, 'init', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'checkout', '-b', 'feat');
    writeFileSync(path.join(repo, 'f.txt'), 'f\n'); git(repo, 'add', 'f.txt'); git(repo, 'commit', '-m', 'pushed work');
    git(repo, 'push', '-u', 'origin', 'feat');
    writeFileSync(path.join(repo, 'g.txt'), 'g\n'); git(repo, 'add', 'g.txt'); git(repo, 'commit', '-m', 'local work');
    git(repo, 'checkout', 'main');
    git(repo, 'merge', '--ff-only', 'feat');
    const r = await call('deleteBranch', sub, 'feat');
    t.check(!r.ok && r.reason === 'notMerged' && r.target === 'origin/feat' && r.commits.map((c) => c.subject).join('|') === 'local work' && branches(repo).includes('feat'),
      `a branch merged into HEAD but not into its upstream is refused, listing what its upstream lacks (${q({ reason: r.reason, target: r.target, commits: r.commits })})`);
    const cur = await call('deleteBranch', sub, 'main', { force: true });
    t.check(!cur.ok && cur.reason === 'currentBranch' && branches(repo).includes('main'), 'the current branch is never deleted, even forced');

    const upstreamOf = (b) => git(repo, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${b}`);
    git(repo, 'branch', '기능');
    git(repo, 'push', '-u', 'origin', '기능');
    const gone = await call('deleteBranch', sub, '기능');
    const back = await call('restoreBranch', sub, '기능', gone.hash, gone.upstream);
    t.check(gone.ok && back.ok && branches(repo).includes('기능') && upstreamOf('기능') === 'origin/기능',
      `Restore after Delete brings the branch back with its upstream (${q({ deleted: gone.ok, restored: back.ok, upstream: upstreamOf('기능') })})`);

    git(repo, 'branch', 'casey');
    const renamed = await call('renameBranch', sub, 'casey', 'Casey');
    t.check(renamed.ok && branches(repo).includes('Casey') && !branches(repo).includes('casey'),
      `Rename… to a change of case only renames the branch (${q({ ok: renamed.ok, err: renamed.err, branches: branches(repo) })})`);
    const clash = await call('renameBranch', sub, 'Casey', 'main');
    t.check(!clash.ok && branches(repo).includes('Casey') && branches(repo).includes('main'), 'Rename… onto another existing branch is still refused');

    const bin = Buffer.alloc(64 * 1024, 7);
    bin[100] = 0;
    writeFileSync(path.join(sub, 'model.bin'), bin);
    git(repo, 'add', 'pkg/model.bin'); git(repo, 'commit', '-m', 'add model');
    const binAt = await call('fileAt', sub, 'HEAD', 'pkg/model.bin', { binary: true });
    const textAt = await call('fileAt', sub, 'HEAD', 'pkg/b.py', { binary: true });
    t.check(binAt?.binary === true && typeof binAt.text === 'undefined' && textAt === 'A = 2\n',
      `fileAt reports a binary blob as binary instead of decoding it (${q({ bin: typeof binAt === 'string' ? `${binAt.length} chars of text` : binAt, text: textAt })})`);
  } catch (err) {
    t.check(false, err.message);
  }
}

const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
