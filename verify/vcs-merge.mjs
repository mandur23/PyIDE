// Merging with Git through the UI: two branches that conflict are merged from the branch popup, the Conflicts dialog
// accepts one file's other side, the three-pane merge tool resolves the other file chunk by chunk and the merge is
// committed; a conflicting rebase is aborted, redone and continued; changes go to a stash and come back; a commit is
// cherry-picked and reverted from the Log and both show in Activity. Then the same surfaces in Korean, without leaks.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-vcsmerge-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const q = JSON.stringify;

// Every string the two Git plugins pass to tr().
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWN = new Set();
for (const p of ['vcs', 'vcs-merge']) {
  for (const k of Object.keys(JSON.parse(readFileSync(path.join(APP, `renderer/features/${p}/locales/ko.json`), 'utf8')))) OWN.add(k);
  const src = readFileSync(path.join(APP, `renderer/features/${p}/index.js`), 'utf8');
  for (const m of src.matchAll(/\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) OWN.add(m[2].replace(/\\'/g, "'"));
  for (const m of src.matchAll(/\btrn\([^,]+,\s*'([^']*)',\s*'([^']*)'/g)) { OWN.add(m[1]); OWN.add(m[2]); }
}

const MAIN = (greet, add, footer = '') => `import sys


def greet(name):
    return f"${greet}"


def add(a, b):
    return ${add}


def main():
    print(greet("PyIDE"))
    print(add(2, 3))


if __name__ == "__main__":
    main()
${footer}`;
const HELPERS = (double) => `def double(x):\n    return ${double}\n\n\ndef triple(x):\n    return x * 3\n`;
const README = (line) => `# VCS fixture\n\n${line}\n`;

// main and feature both change greet() (a conflict) and README.md (a conflict); main also changes add() and feature
// adds a footer and changes helpers.py, which merge cleanly.
function buildConflict(dir) {
  const write = (rel, text) => writeFileSync(path.join(dir, rel), text);
  git(dir, 'init');
  write('main.py', MAIN('Hello, {name}!', 'a + b'));
  write('util/helpers.py', HELPERS('x * 2'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'Initial commit');
  git(dir, 'checkout', '-b', 'feature');
  write('main.py', MAIN('Hi there, {name}!', 'a + b', '# feature footer\n'));
  write('README.md', README('Feature readme.'));
  write('util/helpers.py', HELPERS('x + x'));
  git(dir, '-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-am', 'Feature greeting');
  git(dir, 'checkout', 'main');
  write('main.py', MAIN('Hello, {name}! Welcome.', 'b + a'));
  write('README.md', README('Main readme.'));
  git(dir, 'commit', '-am', 'Main greeting');
}

function helpers(t) {
  const { js, cdp, sleep, type, press } = t;
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
  async function mouse(expr, { button = 'left', clickCount = 1, label = expr } = {}) {
    await frame();
    const box = await js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${label}`);
    await frame();
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(120);
    for (let i = 1; i <= clickCount; i++) {
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: i });
    }
    await sleep(100);
  }
  const popupOpen = `!document.querySelector('#popup').classList.contains('hidden')`;
  // Opens the branch popup and runs the item with this label.
  async function branchItem(label) {
    await mouse(`document.querySelector('.vcs-branch')`, { label: 'branch widget' });
    await until(popupOpen, 'branch popup');
    await type(label);
    await until(`document.querySelector('.popup-item.active .label')?.textContent === ${q(label)}`, `popup item ${label}`);
    await press('Enter');
  }
  async function pickBranch(placeholder, name) {
    await until(`${popupOpen} && document.querySelector('#popupIn').placeholder === ${q(placeholder)}`, placeholder);
    await type(name);
    await until(`document.querySelector('.popup-item.active .label')?.textContent === ${q(name)}`, `branch ${name}`);
    await press('Enter');
  }
  const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].some(n => n.textContent.includes(${q(text)}))`;
  const clearNotes = () => js(`document.querySelectorAll('.vcs-note').forEach(n => n.remove())`);
  const changeRow = (name, status) => `[...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith(${q('\\' + name)})${status ? ` && r.dataset.status === ${q(status)}` : ''})`;
  const conflictRow = (name) => `[...document.querySelectorAll('.vcs-conflict-row[data-path]')].find(r => r.dataset.path.endsWith(${q('\\' + name)}))`;
  const MT = `document.querySelector('.custom-tab:not(.hidden) .vcs-mt')`;
  const act = (side, kind, chunk) => `${MT}.querySelector('.vcs-mt-strip[data-side="${side}"] .vcs-mt-act.${kind}[data-chunk="${chunk}"]')`;
  const logRow = (subject) => `[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].find(r => r.querySelector('.vcs-subject-text')?.textContent === ${q(subject)})`;
  const menuItem = (label) => `[...document.querySelectorAll('#menuHost .menu-item')].find(m => m.firstChild.textContent === ${q(label)})`;
  const refresh = () => js(`(window.dispatchEvent(new Event('focus')), true)`);
  return { frame, until, mouse, branchItem, pickBranch, noteWith, clearNotes, changeRow, conflictRow, MT, act, logRow, menuItem, refresh };
}

const t = await launch({ fixture: 'vcs', port: 9680, name: 'vcs-merge' });
const { js, check, shot, type, press, project } = t;
const h = helpers(t);
const { until, mouse, noteWith, clearNotes, MT } = h;
const file = (rel) => readFileSync(path.join(project, rel), 'utf8');
try {
  buildConflict(project);
  await h.refresh();
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository detected');
  await js(`(ide.toolWindows.get('Commit').show(), true)`);

  // ---------- merge from the branch popup stops on conflicts ----------
  await h.branchItem('Merge into Current…');
  await h.pickBranch('Merge into main', 'feature');
  await until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'Conflicts dialog', 20000);
  check(await js(noteWith('Conflicts in 2 files')), 'a merge that stops says how many files conflict');
  check(git(project, 'diff', '--name-only', '--diff-filter=U').split('\n').sort().join('|') === 'README.md|main.py', 'git really is stopped with main.py and README.md unmerged');
  check(await js(`document.querySelectorAll('.vcs-conflict-row[data-path]').length === 2`), 'the Conflicts dialog lists both conflicted files');
  check(await js(`[...document.querySelectorAll('.vcs-conflict-head > span')].map(s => s.textContent).join('|')`) === 'Name|Yours (main)|Theirs (feature)', 'the dialog names the sides: Yours (main) | Theirs (feature)');
  check(await js(`${h.conflictRow('main.py')}.textContent.includes('Modified')`), 'each side\'s change is shown (Modified)');
  check(await js(`document.querySelector('.vcs-branch-op')?.textContent === 'Merging'`), 'the branch widget says Merging');
  await shot('conflicts-dialog.png');

  // Accept Theirs for README.md
  await mouse(h.conflictRow('README.md'), { label: 'README row' });
  await mouse(`document.querySelector('.vcs-accept-theirs')`, { label: 'Accept Theirs' });
  await until(`document.querySelectorAll('.vcs-conflict-row[data-path]').length === 1`, 'README resolved');
  check(file('README.md') === README('Feature readme.') && !git(project, 'diff', '--name-only', '--diff-filter=U').includes('README'), 'Accept Theirs takes feature\'s README.md and marks it resolved');

  // ---------- the merge tool ----------
  await mouse(h.conflictRow('main.py'), { clickCount: 2, label: 'main.py row' });
  await until(`!!${MT}?._vcsMerge && ${MT}.querySelectorAll('.vcs-mt-act').length >= 4`, 'merge tool', 20000);
  check(await js(`ide.activeTab().title === 'Merge: main.py' && !document.querySelector('.dialog')`),'Merge… opens a Merge: main.py tab in place of the dialog');
  check(await js(`[...${MT}.querySelectorAll('.vcs-mt-head .vcs-diff-side')].map(s => s.textContent).join('|')`) === 'Yours (main) — read-only|Result|Theirs (feature) — read-only', 'the panes are Yours | Result | Theirs');
  check(await js(`${MT}._vcsMerge.chunks.map(c => c.kind).join(',')`) === 'conflict,ours,theirs', 'the chunks are the greet() conflict, main\'s add() change and feature\'s footer');
  check(await js(`${MT}._vcsMerge.models.result.getValue()`) === MAIN('Hello, {name}!', 'a + b'), 'the result starts as the common base');
  check(await js(`${MT}.querySelector('.vcs-mt-status').textContent`) === '1 conflict · 2 non-conflicting changes', 'the toolbar counts what is left');
  check(await js(`['vcs-mt-pane:first-child', 'vcs-mt-result', 'vcs-mt-pane:last-child'].every(c => ${MT}.querySelector('.' + c + ' .monaco-editor .vcs-mt-conflict'))`), 'the conflict is colored in all three panes');
  // model decorations: Monaco only puts the lines in view into the DOM
  const hasDeco = (pane, cls) => `${MT}._vcsMerge.models.${pane}.getAllDecorations().some(d => (d.options.className || '').split(' ').includes('${cls}'))`;
  check(await js(`${hasDeco('ours', 'vcs-mt-modified')} && ${hasDeco('theirs', 'vcs-mt-added')} && ${hasDeco('result', 'vcs-mt-conflict')}`), 'main\'s change is blue on the left, feature\'s addition green on the right');
  check(await js(`!!${MT}.querySelector('.vcs-mt-strip[data-side="ours"] .vcs-mt-link.vcs-mt-conflict') && !!${MT}.querySelector('.vcs-mt-strip[data-side="theirs"] .vcs-mt-link.vcs-mt-conflict')`), 'connectors join the conflict on both sides to the result');
  await shot('merge-tool.png');

  await mouse(`${MT}.querySelector('.vcs-mt-apply-all')`, { label: 'Apply Non-Conflicting Changes' });
  await until(`${MT}.querySelector('.vcs-mt-status').textContent === '1 conflict'`, 'non-conflicting applied');
  check(await js(`${MT}._vcsMerge.models.result.getValue()`) === MAIN('Hello, {name}!', 'b + a', '# feature footer\n'), 'Apply Non-Conflicting Changes takes main\'s add() and feature\'s footer');

  const conflict = await js(`${MT}._vcsMerge.chunks.find(c => c.kind === 'conflict').id`);
  await mouse(h.act('theirs', 'accept', conflict), { label: 'accept theirs «' });
  await until(`${MT}._vcsMerge.models.result.getValue().includes('Hi there')`, 'theirs accepted');
  check(await js(`${h.act('ours', 'accept', conflict)}?.title`) === 'Append', 'after one side, the other side\'s » appends');
  await mouse(h.act('ours', 'accept', conflict), { label: 'append ours »' });
  await until(`${MT}.querySelector('.vcs-mt-status').textContent === 'All changes have been processed'`, 'all processed');
  const merged = MAIN('Hi there, {name}!"\n    return f"Hello, {name}! Welcome.', 'b + a', '# feature footer\n');
  check(await js(`${MT}._vcsMerge.models.result.getValue()`) === merged, 'accepting theirs then appending yours puts both greet lines in the result');
  check(await js(`!${MT}.querySelector('.vcs-mt-act')`), 'no accept / ignore buttons remain');
  await shot('merge-tool-done.png');

  await clearNotes();
  await mouse(`${MT}.querySelector('.vcs-mt-apply')`, { label: 'Apply' });
  await until(noteWith('All conflicts resolved'), 'all resolved note');
  check(file('main.py') === merged, 'Apply writes the result to main.py');
  check(git(project, 'diff', '--name-only', '--diff-filter=U') === '' && git(project, 'status', '--porcelain').includes('M  main.py'), 'Apply marks main.py resolved (git add)');
  check(await js(`!document.querySelector('.vcs-mt')`), 'the merge tab closes');

  // ---------- the commit window during the merge ----------
  await until(`!!document.querySelector('.vcs-op-banner[data-op="merge"]')`, 'merge banner');
  check(await js(`document.querySelector('.vcs-op-banner .vcs-op-title').textContent`) === 'Merge in progress', 'the Commit window says a merge is in progress');
  check(await js(`document.querySelector('.vcs-msg').value`) === "Merge branch 'feature'", 'the commit message is prefilled with git\'s merge message');
  await clearNotes();
  await mouse(`document.querySelector('.vcs-commit-btn')`, { label: 'Commit' });
  await until(`!document.querySelector('.vcs-op-banner') && !document.querySelector('.vcs-branch-op')`, 'merge committed');
  check(git(project, 'log', '-1', '--format=%P').split(' ').length === 2 && git(project, 'log', '-1', '--format=%s') === "Merge branch 'feature'", 'Commit records a merge commit with both parents');
  check(file('util/helpers.py') === HELPERS('x + x') && git(project, 'status', '--porcelain') === '', 'the clean change from feature is in and the tree is clean');

  // ---------- rebase: stop on a conflict, abort, redo, resolve and continue ----------
  git(project, 'checkout', '-b', 'side');
  writeFileSync(path.join(project, 'util/helpers.py'), HELPERS('x + x  # side'));
  git(project, 'commit', '-am', 'Side change');
  git(project, 'checkout', 'main');
  writeFileSync(path.join(project, 'util/helpers.py'), HELPERS('2 * x  # main'));
  git(project, 'commit', '-am', 'Main change');
  await js(`ide.reloadFromDisk()`);
  await h.refresh();
  const mainHead = git(project, 'rev-parse', 'HEAD');
  await h.branchItem('Rebase Current onto…');
  await h.pickBranch('Rebase main onto', 'side');
  await until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'rebase conflicts dialog', 20000);
  check(await js(`[...document.querySelectorAll('.vcs-conflict-head > span')].map(s => s.textContent).join('|')`) === 'Name|Yours (side)|Theirs (main)', 'in a rebase yours is the branch rebased onto, theirs the commit being replayed');
  await press('Escape');
  await until(`document.querySelector('.vcs-op-banner')?.dataset.op === 'rebase' && document.querySelector('.vcs-branch-op')?.textContent === 'Rebasing'`, 'rebase banner');
  check(await js(`document.querySelector('.vcs-branch-name').textContent`) === 'main', 'the widget still names the branch being rebased');
  check(await js(`[...document.querySelectorAll('.vcs-op-btns button')].map(b => b.textContent).join('|')`) === 'Continue|Skip|Abort', 'a stopped rebase offers Continue, Skip and Abort');
  await mouse(`document.querySelector('.vcs-changes .vcs-file[data-status="conflict"]')`, { label: 'conflict row' });
  check(await js(`document.querySelector('.vcs-group.vcs-conflicts .vcs-group-title').textContent === 'Merge Conflicts' && document.querySelector('.vcs-file[data-status="conflict"] input').disabled`), 'conflicts are their own group and cannot be ticked for commit');
  await mouse(`document.querySelector('.vcs-branch')`, { label: 'branch widget' });
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'branch popup while rebasing');
  check(await js(`[...document.querySelectorAll('.popup-item .label')].slice(0, 4).map(l => l.textContent).join('|')`) === 'Resolve Conflicts…|Continue Rebase|Skip Commit|Abort Rebase', 'the branch popup leads with Resolve / Continue / Skip / Abort');
  await press('Escape');
  await clearNotes();
  await mouse(`document.querySelector('.vcs-op-abort')`, { label: 'Abort' });
  await until(noteWith('Rebase aborted'), 'rebase aborted');
  check(git(project, 'rev-parse', 'HEAD') === mainHead && !existsSync(path.join(project, '.git', 'rebase-merge')) && file('util/helpers.py') === HELPERS('2 * x  # main'), 'Abort puts main back where it was');

  await h.branchItem('Rebase Current onto…');
  await h.pickBranch('Rebase main onto', 'side');
  await until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'rebase conflicts again', 20000);
  await press('Escape');
  await until(`!!${h.changeRow('helpers.py', 'conflict')}`, 'conflict in the commit window');
  await mouse(h.changeRow('helpers.py', 'conflict'), { clickCount: 2, label: 'helpers.py conflict row' });
  await until(`!!${MT}?._vcsMerge`, 'merge tool from the Commit window', 20000);
  check(await js(`ide.activeTab().title`) === 'Merge: helpers.py', 'double-clicking a conflict in the Commit window opens the merge tool');
  await mouse(`${MT}.querySelector('.vcs-mt-accept-right')`, { label: 'Accept Right' });
  await until(`!document.querySelector('.vcs-mt') && ${noteWith('All conflicts resolved')}`, 'accept right');
  check(file('util/helpers.py') === HELPERS('2 * x  # main'), 'Accept Right takes the replayed commit\'s version');
  await clearNotes();
  await mouse(`document.querySelector('.vcs-op-continue')`, { label: 'Continue' });
  await until(noteWith('Rebase finished'), 'rebase finished', 20000);
  check(git(project, 'log', '--format=%s', '-2').split('\n').join('|') === 'Main change|Side change' && git(project, 'log', '-1', '--format=%P').split(' ').length === 1, 'Continue replays main\'s commit on top of side');
  check(await js(`!document.querySelector('.vcs-op-banner') && !document.querySelector('.vcs-branch-op') && document.querySelector('.vcs-branch-name').textContent === 'main'`), 'the widget and Commit window are back to normal');

  // ---------- stash round trip ----------
  writeFileSync(path.join(project, 'main.py'), `${merged}# stashed edit\n`);
  writeFileSync(path.join(project, 'new.txt'), 'untracked\n');
  await h.refresh();
  await until(`!!${h.changeRow('main.py')} && !!${h.changeRow('new.txt')}`, 'local changes');
  await h.branchItem('Stash Changes…');
  await until(`!!document.querySelector('.dialog .vcs-stash-msg')`, 'stash dialog');
  await js(`document.querySelector('.vcs-stash-msg').focus()`);
  await type('WIP greeting');
  await mouse(`document.querySelector('.vcs-stash-untracked input')`, { label: 'include untracked' });
  await clearNotes();
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Create Stash' });
  await until(noteWith('Changes stashed'), 'stashed');
  const stashed = `${git(project, 'status', '--porcelain')}|${git(project, 'stash', 'list', '--format=%gs')}`;
  check(stashed === '|On main: WIP greeting', `Create Stash shelves tracked and untracked changes with the message (${stashed})`);
  await until(`!${h.changeRow('main.py')}`, 'clean changes list');
  check(!file('main.py').includes('# stashed edit'), 'the editor files are back to HEAD');

  await js(`(ide.runAction('Git.Unstash'), true)`);
  await until(`document.querySelectorAll('.vcs-stash-row').length === 1 && document.querySelectorAll('.vcs-stash-file').length === 2`, 'unstash dialog');
  check(await js(`document.querySelector('.vcs-stash-row').textContent.includes('stash@{0}') && document.querySelector('.vcs-stash-row').textContent.includes('WIP greeting')`), 'Unstash lists the stash with its message');
  check(await js(`[...document.querySelectorAll('.vcs-stash-file')].map(r => r.dataset.rel).sort().join('|')`) === 'main.py|new.txt', 'the stash\'s changes are listed, untracked files included');
  await shot('unstash.png');
  await mouse(`[...document.querySelectorAll('.vcs-stash-file')].find(r => r.dataset.rel === 'new.txt')`, { clickCount: 2, label: 'new.txt in stash' });
  await until(`ide.activeTab()?.title === 'new.txt (stash@{0})' && !!document.querySelector('.custom-tab:not(.hidden)')?._vcsDiff`, 'stash diff');
  check(await js(`document.querySelector('.custom-tab:not(.hidden)')._vcsDiff.getModifiedEditor().getValue()`) === 'untracked\n', 'Show changes diffs a stashed untracked file against nothing');
  await press('Ctrl+F4');
  await js(`(ide.runAction('Git.Unstash'), true)`);
  await until(`document.querySelectorAll('.vcs-stash-row').length === 1`, 'unstash dialog again');
  await mouse(`document.querySelector('.vcs-stash-pop input')`, { label: 'pop stash' });
  check(await js(`document.querySelector('.dialog .primary').textContent`) === 'Pop Stash', 'ticking Pop stash turns the button into Pop Stash');
  await clearNotes();
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Pop Stash' });
  await until(noteWith('Unstashed stash@{0}'), 'unstashed');
  check(file('main.py').endsWith('# stashed edit\n') && file('new.txt') === 'untracked\n' && git(project, 'stash', 'list') === '', 'Pop brings the changes back and removes the stash');

  // drop, with its confirmation
  await js(`(ide.runAction('Git.Stash'), true)`);
  await until(`!!document.querySelector('.dialog .vcs-stash-msg')`, 'stash dialog');
  await mouse(`document.querySelector('.vcs-stash-untracked input')`, { label: 'include untracked' });
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Create Stash' });
  await until(`${noteWith('Changes stashed')} && !${h.changeRow('main.py')}`, 'stashed again');
  await js(`(ide.runAction('Git.Unstash'), true)`);
  await until(`document.querySelectorAll('.vcs-stash-row').length === 1`, 'unstash for drop');
  await mouse(`document.querySelector('.vcs-stash-drop')`, { label: 'Drop' });
  await until(`!document.querySelector('.vcs-stash-confirm').classList.contains('hidden')`, 'drop confirmation');
  await mouse(`document.querySelector('.vcs-stash-drop-yes')`, { label: 'confirm drop' });
  await until(`document.querySelector('.vcs-stash-list').textContent.includes('No stashed changes')`, 'dropped');
  check(git(project, 'stash', 'list') === '', 'Drop removes the stash after confirming');
  await press('Escape');

  // ---------- cherry-pick and revert from the Log ----------
  git(project, 'checkout', '-b', 'pick');
  writeFileSync(path.join(project, 'picked.txt'), 'picked\n');
  git(project, 'add', 'picked.txt');
  git(project, 'commit', '-m', 'Pick me');
  git(project, 'checkout', 'main');
  await h.refresh();
  await js(`(ide.toolWindows.get('Git').show(), true)`);
  await until(`!!${h.logRow('Pick me')}`, 'log shows Pick me', 20000);
  await mouse(h.logRow('Pick me'), { button: 'right', label: 'Pick me row' });
  await until(`!!${h.menuItem('Cherry-Pick')}`, 'log context menu');
  check(await js(`[...document.querySelectorAll('#menuHost .menu-item')].map(m => m.firstChild.textContent).join('|')`) === 'Cherry-Pick|Revert Commit', 'a Log row\'s context menu has Cherry-Pick and Revert Commit');
  await clearNotes();
  await mouse(h.menuItem('Cherry-Pick'), { label: 'Cherry-Pick' });
  await until(noteWith('Cherry-picked'), 'cherry-picked');
  check(git(project, 'log', '-1', '--format=%s') === 'Pick me' && git(project, 'branch', '--show-current') === 'main' && file('picked.txt') === 'picked\n', 'Cherry-Pick applies the commit onto main');
  await until(`${h.logRow('Pick me')} && document.querySelectorAll('.vcs-log-rows .vcs-log-row').length >= 2 && [...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].filter(r => r.textContent.includes('Pick me')).length === 2`, 'picked commit in log');
  await mouse(`document.querySelector('.vcs-log-rows .vcs-log-row')`, { button: 'right', label: 'top log row' });
  await until(`!!${h.menuItem('Revert Commit')}`, 'context menu on top commit');
  await clearNotes();
  await mouse(h.menuItem('Revert Commit'), { label: 'Revert Commit' });
  await until(noteWith('Reverted'), 'reverted');
  check(git(project, 'log', '-1', '--format=%s') === 'Revert "Pick me"' && !existsSync(path.join(project, 'picked.txt')), 'Revert Commit records a revert and removes the file again');
  await js(`document.querySelector('#vcsActivityTab').click()`);
  await until(`!!document.querySelector('#vcsActivity .vcs-act-row[data-kind="revert"]') && !!document.querySelector('#vcsActivity .vcs-act-row[data-kind="cherry-pick"]')`, 'activity rows');
  const act = (kind) => js(`document.querySelector('#vcsActivity .vcs-act-row[data-kind="${kind}"] .vcs-act-text').textContent`);
  check(await act('cherry-pick') === 'Cherry-picked: Pick me' && await act('revert') === 'Reverted: Revert "Pick me"', 'Activity shows the cherry-pick and the revert');
  check(await js(`[...document.querySelectorAll('#vcsActivity .vcs-act-row')].map(r => r.dataset.kind).slice(0, 2).join(',')`) === 'revert,cherry-pick', 'newest first: revert, then cherry-pick');
  check(await js(`!!document.querySelector('#vcsActivity .vcs-act-row[data-kind="rebase"]') && !!document.querySelector('#vcsActivity .vcs-act-row[data-kind="merge"]')`), 'the rebase and the merge are in Activity too');
  await shot('activity.png');
  check(await js(`document.querySelector('#vcsConsole').textContent.includes('git cherry-pick') && document.querySelector('#vcsConsole').textContent.includes('git stash push')`), 'the Git console logs the commands');

  // ---------- a CP949 file in conflict: its versions are decoded, and the result is written back as CP949 ----------
  const cp949 = (s) => Buffer.from(s.replace(/한글/g, '\u0000').split('').flatMap((c) => (c === '\u0000' ? [0xc7, 0xd1, 0xb1, 0xdb] : [c.charCodeAt(0)])));
  const legacy = path.join(project, 'legacy.py');
  writeFileSync(legacy, cp949('# 한글\nx = 1\n'));
  git(project, 'add', 'legacy.py');
  git(project, 'commit', '-m', 'Add legacy');
  git(project, 'checkout', '-b', 'legacy-side');
  writeFileSync(legacy, cp949('# 한글\nx = 2\n'));
  git(project, 'commit', '-am', 'Side');
  git(project, 'checkout', 'main');
  writeFileSync(legacy, cp949('# 한글\nx = 3\n'));
  git(project, 'commit', '-am', 'Main');
  try { git(project, 'merge', 'legacy-side'); } catch {}
  const v = await js(`ide.api.invoke('git:mergeVersions', ide.root, ${q(legacy)})`);
  check(v.base === '# 한글\nx = 1\n' && v.ours === '# 한글\nx = 3\n' && v.theirs === '# 한글\nx = 2\n' && v.working.startsWith('# 한글\n<<<<<<<'),
    `the merge tool gets a CP949 file's three versions and the work tree file as text (${JSON.stringify(v).slice(0, 160)})`);
  const resolved = await js(`ide.api.invoke('git:resolve', ide.root, ${q(legacy)}, '# 한글\\nx = 23\\n')`);
  check(resolved.ok && readFileSync(legacy).equals(cp949('# 한글\nx = 23\n')), 'resolving a CP949 file writes the result in CP949, so its Korean text survives');
  git(project, 'commit', '--no-edit');

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'vcs', port: 9681, name: 'vcs-merge-ko', lang: 'ko-KR' });
const kh = helpers(k);
const leaks = [];
const noLeaks = async (selector, label, allowed = []) => {
  const found = await englishLeaks(k, selector, allowed);
  if (found.length) leaks.push({ label, found });
  k.check(!found.length, `${label}: no English UI text${found.length ? ` ${JSON.stringify(found)}` : ''}`);
};
try {
  buildConflict(k.project);
  await kh.refresh();
  await kh.until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'ko repository');
  await k.js(`(ide.toolWindows.get('Commit').show(), true)`);
  await kh.mouse(`document.querySelector('.vcs-branch')`, { label: 'branch widget' });
  await kh.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'ko branch popup');
  k.check(await k.js(`['현재 브랜치로 병합…', '현재 브랜치 리베이스…', '변경 사항 스태시…', '변경 사항 스태시 해제…'].every(l => [...document.querySelectorAll('.popup-item .label')].some(n => n.textContent === l))`), 'the branch popup offers merge, rebase, stash and unstash in Korean');
  await noLeaks('#popup', 'branch popup', ['main', 'feature']);
  await k.press('Escape');

  await kh.branchItem('현재 브랜치로 병합…');
  await kh.pickBranch('main(으)로 병합', 'feature');
  await kh.until(`!!document.querySelector('.dialog .vcs-conflicts')`, 'ko conflicts dialog', 20000);
  k.check(await k.js(`document.querySelector('.dialog-title').textContent`) === '충돌' && await k.js(kh.noteWith('파일 2개에 충돌이 있습니다')), 'the Conflicts dialog and its notification are Korean');
  await noLeaks('#dialogHost', 'Conflicts dialog');
  await noLeaks('.vcs-notes', 'conflict notification');
  await k.shot('conflicts-ko.png');
  await kh.mouse(kh.conflictRow('main.py'), { label: 'main.py' });
  await kh.mouse(`document.querySelector('.vcs-merge-btn')`, { label: '병합…' });
  await kh.until(`!!${kh.MT}?._vcsMerge && ${kh.MT}.querySelectorAll('.vcs-mt-act').length >= 4`, 'ko merge tool', 20000);
  k.check(await k.js(`ide.activeTab().title`) === '병합: main.py' && await k.js(`${kh.MT}.querySelector('.vcs-mt-status').textContent`) === '충돌 1개 · 충돌하지 않는 변경 2개', 'the merge tool tab and its status are Korean');
  await noLeaks('.custom-tab:not(.hidden)', 'merge tool');
  await k.shot('merge-tool-ko.png');
  await kh.mouse(`${kh.MT}.querySelector('.vcs-mt-apply')`, { label: '적용' });
  await kh.until(`document.querySelector('.dialog-title')?.textContent === '처리되지 않은 변경 사항'`, 'unprocessed changes dialog');
  await noLeaks('#dialogHost', 'unprocessed changes confirmation');
  await k.press('Escape');
  await kh.mouse(`${kh.MT}.querySelector('.vcs-mt-cancel')`, { label: '취소' });
  await kh.until(`!document.querySelector('.vcs-mt')`, 'merge tool closed');

  await kh.until(`document.querySelector('.vcs-op-banner .vcs-op-title')?.textContent === '병합 진행 중' && document.querySelector('.vcs-branch-op')?.textContent === '병합 중'`, 'ko merge banner');
  k.check(true, 'the Commit window banner and branch widget say 병합 진행 중 / 병합 중');
  await noLeaks('#sideTitle, #sideActions, #sideBody .tool.active', 'Commit window during a merge');
  await kh.clearNotes();
  await kh.mouse(`document.querySelector('.vcs-op-abort')`, { label: '중단' });
  await kh.until(kh.noteWith('병합을 중단했습니다'), 'ko merge aborted');
  await noLeaks('.vcs-notes', 'merge aborted notification');
  k.check(git(k.project, 'diff', '--name-only', '--diff-filter=U') === '' && !existsSync(path.join(k.project, '.git', 'MERGE_HEAD')), 'Abort from the Korean banner aborts the merge');

  writeFileSync(path.join(k.project, 'main.py'), 'print("edited")\n');
  await kh.refresh();
  await kh.until(`!!${kh.changeRow('main.py')}`, 'ko local change');
  await k.js(`(ide.runAction('Git.Stash'), true)`);
  await kh.until(`!!document.querySelector('.dialog .vcs-stash-msg')`, 'ko stash dialog');
  await noLeaks('#dialogHost', 'Stash dialog', ['main']);
  await k.js(`document.querySelector('.vcs-stash-msg').focus()`);
  await k.type('작업 중');
  await kh.mouse(`document.querySelector('.dialog .primary')`, { label: '스태시 만들기' });
  await kh.until(kh.noteWith('변경 사항을 스태시했습니다'), 'ko stashed');
  await k.js(`(ide.runAction('Git.Unstash'), true)`);
  await kh.until(`document.querySelectorAll('.vcs-stash-row').length === 1 && document.querySelectorAll('.vcs-stash-file').length === 1`, 'ko unstash dialog');
  await kh.mouse(`document.querySelector('.vcs-stash-drop')`, { label: '삭제' });
  await noLeaks('#dialogHost', 'Unstash dialog with the drop confirmation');
  await k.shot('unstash-ko.png');
  await kh.mouse(`document.querySelector('.dialog .primary')`, { label: '스태시 적용' });
  await kh.until(kh.noteWith('stash@{0}을(를) 적용했습니다'), 'ko applied');
  await noLeaks('.vcs-notes', 'unstash notification');

  await k.js(`(ide.toolWindows.get('Git').show(), true)`);
  await kh.until(`document.querySelectorAll('.vcs-log-rows .vcs-log-row').length >= 3`, 'ko log');
  await kh.mouse(`document.querySelector('.vcs-log-rows .vcs-log-row')`, { button: 'right', label: 'ko log row' });
  await kh.until(`!!${kh.menuItem('체리픽')} && !!${kh.menuItem('커밋 되돌리기')}`, 'ko log menu');
  await noLeaks('#menuHost', 'Log context menu');
  await k.press('Escape');

  await k.js(`ide.editor.focus()`);
  await k.press('Ctrl+Shift+A');
  await kh.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'find action');
  await k.type('스태시');
  await kh.until(`[...document.querySelectorAll('.popup-item .label')].some(l => l.textContent === '변경 사항 스태시 해제…')`, 'stash actions');
  await noLeaks('#popup', 'Find Action results for stash');
  await k.press('Escape');

  const missing = (await missingTranslations(k)).filter((s) => OWN.has(s));
  k.check(missing.length === 0, `every Git tr() string has a Korean entry${missing.length ? ` (missing ${JSON.stringify(missing)})` : ''}`);
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${JSON.stringify(k.consoleErrors)}` : ''}`);
} catch (err) {
  k.check(false, err.message);
  await k.shot('failure-ko.png');
}
for (const r of k.results) t.results.push(r);
k.close();
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
