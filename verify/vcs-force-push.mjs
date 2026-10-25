// Force Push after a rejected push, against a local bare remote: Amend Commit and Push… on a pushed commit is rejected
// as non-fast-forward and PyCharm's Push Rejected question offers Force Push (--force-with-lease, listing the commits it
// removes); Cancel keeps the remote; a push someone made after the question (even once fetched) is never overwritten;
// a protected branch (main, master by default; Settings › Git) asks again with a warning. Real mouse input, English,
// Korean and 1008x681, then main-process checks (fetch first, a lease that no longer matches, no upstream yet).
// Ports 9420-9421.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-force-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const q = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remoteHead = (remote, branch) => git(remote, 'rev-parse', `refs/heads/${branch}`);

// main and feature, both pushed to a bare remote, feature checked out.
function buildRepo(dir) {
  git(dir, 'init');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'Initial commit');
  const remote = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-force-remote-'));
  git(remote, 'init', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'checkout', '-b', 'feature');
  appendFileSync(path.join(dir, 'main.py'), '\nprint("feature")\n');
  git(dir, 'commit', '-am', 'Add feature');
  git(dir, 'push', '-u', 'origin', 'feature');
  return remote;
}

// Pushes a commit to the remote's branch from another clone, as a teammate would.
function teammatePush(remote, branch, file) {
  const other = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-force-other-'));
  git(other, 'clone', '-q', '-b', branch, remote, '.');
  writeFileSync(path.join(other, file), 'teammate\n');
  git(other, 'add', file);
  git(other, 'commit', '-m', `Teammate change on ${branch}`);
  git(other, 'push', '-q', 'origin', branch);
  return git(other, 'rev-parse', 'HEAD');
}

function helpers(t) {
  const { js, cdp } = t;
  // Chromium does not paint an occluded window, so a frame is forced before each look.
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
  async function mouse(expr, label = expr) {
    await frame();
    const box = await js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${label}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(100);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(120);
  }
  const dialog = (title) => `[...document.querySelectorAll('.dialog')].find(d => d.querySelector('.dialog-title').textContent === ${q(title)})`;
  const dialogButton = (title, label) => `[...${dialog(title)}?.querySelectorAll('.dialog-buttons button') || []].find(b => b.textContent === ${q(label)})`;
  const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].find(n => n.textContent.includes(${q(text)}))`;
  const clearNotes = () => js(`(document.querySelectorAll('.vcs-note').forEach(n => n.remove()), true)`);
  return { until, mouse, dialog, dialogButton, noteWith, clearNotes };
}

async function openRepo(t, h) {
  const remote = buildRepo(t.project);
  await t.js(`(['analyze', 'todo'].forEach(k => ide.settings.set('vcs.commitChecks.' + k, false)), ide.emit('filesChanged'), true)`);
  await h.until(`document.querySelector('.vcs-branch-name')?.textContent === 'feature'`, 'repository detected', 20000);
  return remote;
}

// Opens Push… (Ctrl+Shift+K) and presses Push; resolves when the Push Rejected question shows.
async function pushUntilRejected(t, h, title) {
  await t.press('Ctrl+Shift+K');
  await h.until(`!!${h.dialog(`Push Commits to ${path.basename(t.project)}`)}`, 'Push dialog');
  await h.mouse(h.dialogButton(`Push Commits to ${path.basename(t.project)}`, 'Push'), 'Push');
  await h.until(`!!${h.dialog(title)}`, `${title} question`, 20000);
}

// ---------- English ----------
const t = await launch({ fixture: 'vcs', port: 9420, name: 'vcs-force-push' });
const { js, check, project } = t;
const h = helpers(t);
const { until, mouse } = h;
try {
  const remote = await openRepo(t, h);

  // Amend Commit and Push… on the pushed feature commit
  await t.press('Alt+0');
  await until(`ide.toolWindows.get('Commit').isVisible() && !!document.querySelector('#vcsAmend')?.offsetParent`, 'Commit window');
  await mouse(`document.querySelector('#vcsAmend')`, 'Amend');
  await until(`document.querySelector('.vcs-msg').value === 'Add feature'`, 'last message in the box');
  await mouse(`document.querySelector('.vcs-msg')`, 'message box');
  await t.press('Ctrl+A');
  await t.type('Add the feature');
  const before = remoteHead(remote, 'feature');
  await mouse(`document.querySelector('.vcs-commit-push-btn')`, 'Amend Commit and Push…');
  await until(`!!${h.dialog('Amend Commit')}`, 'pushed commit warning');
  await mouse(h.dialogButton('Amend Commit', 'Amend Commit'), 'confirm amend');
  await until(`!!${h.dialog(`Push Commits to ${path.basename(project)}`)}`, 'Push dialog after the amend');
  await mouse(h.dialogButton(`Push Commits to ${path.basename(project)}`, 'Push'), 'Push');
  await until(`!!${h.dialog('Push Rejected')}`, 'Push Rejected question', 20000);
  const rejected = await js(`(() => { const d = ${h.dialog('Push Rejected')}; return { text: d.querySelector('.dialog-body').textContent,
    commits: [...d.querySelectorAll('.vcs-push-commit')].map(r => r.textContent), buttons: [...d.querySelectorAll('.dialog-buttons button')].map(b => b.textContent) }; })()`);
  check(rejected.text.includes('Push of current branch feature was rejected: origin/feature has commits that are not in your branch.'),
    `pushing an amended pushed commit is rejected and the Push Rejected question says why (${q(rejected.text.slice(0, 120))})`);
  check(rejected.commits.length === 1 && rejected.commits[0].includes('Add feature') && rejected.text.includes('removes these commits'),
    `it lists the commit a force push would remove from origin/feature (${q(rejected.commits)})`);
  check(rejected.buttons.join('|') === 'Force Push|Cancel', `it offers Force Push and Cancel (${rejected.buttons.join('|')})`);
  await t.shot('push-rejected.png');
  await mouse(h.dialogButton('Push Rejected', 'Cancel'), 'Cancel');
  await until(`!document.querySelector('.dialog')`, 'question closed');
  await until(`!!${h.noteWith('Push rejected')}`, 'Push rejected notification');
  check(remoteHead(remote, 'feature') === before, 'Cancel leaves the remote branch as it was and says the push was rejected');

  await h.clearNotes();
  await pushUntilRejected(t, h, 'Push Rejected');
  await mouse(h.dialogButton('Push Rejected', 'Force Push'), 'Force Push');
  await until(`!!${h.noteWith('Force pushed feature to origin/feature')}`, 'force pushed notification', 20000);
  check(remoteHead(remote, 'feature') === git(project, 'rev-parse', 'HEAD') && git(remote, 'log', '-1', '--format=%s', 'feature') === 'Add the feature',
    'Force Push replaces origin/feature with the amended commit and says so');
  check(!await js(`!!${h.dialog('Force Push to Protected Branch')}`), 'a feature branch is force pushed without the protected-branch question');
  await until(`!document.querySelector('.vcs-sync-out')?.offsetParent`, 'nothing outgoing after the force push');
  check(true, 'the branch widget shows nothing outgoing afterwards');

  // A push someone made after the question is not overwritten, even when a fetch has seen it.
  git(project, 'commit', '--amend', '-m', 'Add the feature, again');
  await h.clearNotes();
  await pushUntilRejected(t, h, 'Push Rejected');
  const theirs = teammatePush(remote, 'feature', 'theirs.txt');
  git(project, 'fetch', 'origin');
  await mouse(h.dialogButton('Push Rejected', 'Force Push'), 'Force Push (stale)');
  await until(`!!${h.noteWith('Push failed')}`, 'push failed notification', 20000);
  check(remoteHead(remote, 'feature') === theirs && await js(`${h.noteWith('Push failed')}.textContent.includes('origin/feature changed after the Push Rejected question')`),
    "Force Push refuses to overwrite a teammate's push made after the question, also once fetched, and says why");
  check(!await js(`!!document.querySelector('.dialog')`), 'and asks no second Push Rejected question for it');

  // Protected branch: main asks again with a warning.
  git(project, 'checkout', '-q', 'main');
  appendFileSync(path.join(project, 'README.md'), '\nmore\n');
  git(project, 'commit', '-q', '--amend', '-am', 'Initial commit, amended');
  await js(`(ide.emit('filesChanged'), true)`);
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'on main');
  const mainBefore = remoteHead(remote, 'main');
  await h.clearNotes();
  await pushUntilRejected(t, h, 'Push Rejected');
  await mouse(h.dialogButton('Push Rejected', 'Force Push'), 'Force Push (main)');
  await until(`!!${h.dialog('Force Push to Protected Branch')}`, 'protected branch question');
  const warn = await js(`${h.dialog('Force Push to Protected Branch')}.querySelector('.dialog-body').textContent`);
  check(warn.includes('main is a protected branch.') && warn.includes('Force push to origin/main anyway?'), `Force Push to main asks again with a warning (${q(warn)})`);
  await t.shot('protected.png');
  await mouse(h.dialogButton('Force Push to Protected Branch', 'Cancel'), 'Cancel (protected)');
  await until(`!document.querySelector('.dialog')`, 'questions closed');
  await until(`!!${h.noteWith('Force Push to the protected branch main was canceled.')}`, 'canceled notification');
  check(remoteHead(remote, 'main') === mainBefore, 'Cancel on the warning refuses the force push to main');
  await pushUntilRejected(t, h, 'Push Rejected');
  await mouse(h.dialogButton('Push Rejected', 'Force Push'), 'Force Push (main, again)');
  await until(`!!${h.dialog('Force Push to Protected Branch')}`, 'protected branch question again');
  await mouse(h.dialogButton('Force Push to Protected Branch', 'Force Push'), 'confirm protected force push');
  await until(`!!${h.noteWith('Force pushed main to origin/main')}`, 'main force pushed', 20000);
  check(remoteHead(remote, 'main') === git(project, 'rev-parse', 'HEAD'), 'confirming the warning force pushes main');

  // The setting: Settings › Git › Protected branches.
  await js(`(ide.openSettings('vcs-git'), true)`);
  await until(`!!document.querySelector('[data-key="vcs.protectedBranches"]')`, 'Git settings page');
  check(await js(`document.querySelector('[data-key="vcs.protectedBranches"]').value`) === 'master, main', 'Settings › Git lists master and main as protected branches by default');
  await js(`(() => { const i = document.querySelector('[data-key="vcs.protectedBranches"]'); i.value = 'release/*'; i.dispatchEvent(new Event('input')); })()`);
  await t.click('#settingsOk');
  await until(`!document.querySelector('.settings-page')`, 'settings closed');
  check(await js(`ide.settings.get('vcs.protectedBranches')`) === 'release/*', 'the field is saved with OK');
  git(project, 'commit', '-q', '--amend', '-m', 'Initial commit, amended twice');
  await h.clearNotes();
  await pushUntilRejected(t, h, 'Push Rejected');
  await mouse(h.dialogButton('Push Rejected', 'Force Push'), 'Force Push (main, unprotected)');
  await until(`!!${h.noteWith('Force pushed main to origin/main')}`, 'main force pushed without a question', 20000);
  check(remoteHead(remote, 'main') === git(project, 'rev-parse', 'HEAD'), 'with main no longer listed, Force Push to it asks nothing more');

  // 1008x681
  await t.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await js(`(ide.settings.set('vcs.protectedBranches', 'master, main'), true)`);
  git(project, 'commit', '-q', '--amend', '-m', 'Initial commit, amended three times');
  await pushUntilRejected(t, h, 'Push Rejected');
  const inside = (sel) => js(`[...document.querySelectorAll(${q(sel)})].every((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })`);
  check(await inside('.dialog, .dialog-buttons button'), '1008x681: the Push Rejected question and its buttons are inside the window');
  await mouse(h.dialogButton('Push Rejected', 'Force Push'), 'Force Push (small)');
  await until(`!!${h.dialog('Force Push to Protected Branch')}`, 'protected question (small)');
  check(await inside('.dialog, .dialog-buttons button'), '1008x681: the protected-branch question fits too');
  await mouse(h.dialogButton('Force Push to Protected Branch', 'Cancel'), 'Cancel (small)');
  await until(`!document.querySelector('.dialog')`, 'closed (small)');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${q(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message.split('\n')[0]);
  await t.shot('failure.png').catch(() => {});
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'vcs', port: 9421, name: 'vcs-force-push-ko', lang: 'ko-KR' });
const hk = helpers(k);
try {
  await openRepo(k, hk);
  git(k.project, 'checkout', '-q', 'main');
  git(k.project, 'commit', '-q', '--amend', '-m', 'Initial commit, amended');
  await k.js(`(ide.emit('filesChanged'), true)`);
  await hk.until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'ko on main');
  const leaks = [];
  await k.press('Ctrl+Shift+K');
  await hk.until(`!!${hk.dialog(`${path.basename(k.project)}에 커밋 푸시`)}`, 'ko Push dialog');
  await hk.mouse(hk.dialogButton(`${path.basename(k.project)}에 커밋 푸시`, '푸시'), 'ko Push');
  await hk.until(`!!${hk.dialog('푸시 거부됨')}`, 'ko Push Rejected', 20000);
  const ko = await k.js(`(() => { const d = ${hk.dialog('푸시 거부됨')}; return { text: d.querySelector('.dialog-body').textContent, buttons: [...d.querySelectorAll('.dialog-buttons button')].map(b => b.textContent).join('|') }; })()`);
  k.check(ko.text.includes('현재 브랜치 main의 푸시가 거부되었습니다.') && ko.buttons === '강제 푸시|취소', `Push Rejected reads in Korean (${q(ko)})`);
  leaks.push(...await englishLeaks(k, '.dialog'));
  await k.shot('push-rejected-ko.png');
  await hk.mouse(hk.dialogButton('푸시 거부됨', '강제 푸시'), 'ko Force Push');
  await hk.until(`!!${hk.dialog('보호된 브랜치에 강제 푸시')}`, 'ko protected question');
  k.check(await k.js(`${hk.dialog('보호된 브랜치에 강제 푸시')}.textContent.includes('main은(는) 보호된 브랜치입니다.')`), 'the protected-branch warning reads in Korean');
  leaks.push(...await englishLeaks(k, '.dialog'));
  await hk.mouse(hk.dialogButton('보호된 브랜치에 강제 푸시', '강제 푸시'), 'ko confirm');
  await hk.until(`!!${hk.noteWith('main을(를) origin/main에 강제 푸시했습니다')}`, 'ko force pushed', 20000);
  k.check(true, 'the result reads in Korean');
  await k.js(`(ide.openSettings('vcs-git'), true)`);
  await hk.until(`!!document.querySelector('[data-key="vcs.protectedBranches"]')`, 'ko Git settings');
  leaks.push(...await englishLeaks(k, '.settings-page'));
  await k.js(`(document.querySelector('#settingsCancel').click(), true)`);
  k.check(!leaks.length, `no English UI text in the questions and the settings page (${q(leaks)})`);
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${q(k.consoleErrors)}` : ''}`);
} catch (err) {
  k.check(false, err.message.split('\n')[0]);
  await k.shot('failure.png').catch(() => {});
}
for (const r of k.results) t.results.push(r);
k.close();

// ---------- main process only ----------
{
  const require = createRequire(path.join(APP, 'main/features/git.js'));
  const handlers = {};
  require(path.join(APP, 'main/features/git.js')).register({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: () => {} },
    app: { getPath: () => mkdtempSync(path.join(tmpdir(), 'pyide-vcs-force-main-')), on: () => {} },
  });
  const call = (name, ...args) => handlers[`git:${name}`](null, ...args);
  try {
    const repo = mkdtempSync(path.join(tmpdir(), 'pyide-vcs-force-repo-'));
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    writeFileSync(path.join(repo, 'main.py'), 'print(1)\n');
    const remote = buildRepo(repo);

    teammatePush(remote, 'feature', 'b.txt');
    appendFileSync(path.join(repo, 'a.txt'), 'mine\n');
    git(repo, 'commit', '-qam', 'Mine');
    const fetchFirst = await call('push', repo);
    t.check(!fetchFirst.ok && fetchFirst.rejected === 'fetch first' && !fetchFirst.lease,
      `a remote with commits never fetched is rejected as "fetch first" and offers no force push (${q({ rejected: fetchFirst.rejected, lease: fetchFirst.lease })})`);

    git(repo, 'fetch', '-q');
    const nonFF = await call('push', repo);
    t.check(!nonFF.ok && nonFF.rejected === 'non-fast-forward' && nonFF.lease === git(repo, 'rev-parse', 'origin/feature') && nonFF.dropped.map((c) => c.subject).join() === 'Teammate change on feature',
      `once fetched it is non-fast-forward, with the lease and the commit a force push removes (${q({ rejected: nonFF.rejected, dropped: nonFF.dropped })})`);
    const wrongLease = await call('push', repo, { lease: git(repo, 'rev-parse', 'origin/feature~1') });
    t.check(!wrongLease.ok && wrongLease.rejected === 'stale info' && remoteHead(remote, 'feature') === nonFF.lease,
      `a lease that is not the remote's commit is refused (${q(wrongLease.rejected)})`);
    const bad = await call('push', repo, { lease: '--force' });
    t.check(!bad.ok && remoteHead(remote, 'feature') === nonFF.lease, 'a lease that is no commit id is refused before git runs');
    const forced = await call('push', repo, { lease: nonFF.lease });
    t.check(forced.ok && forced.forced && remoteHead(remote, 'feature') === git(repo, 'rev-parse', 'HEAD') && forced.cmd.includes(`--force-with-lease=refs/heads/feature:${nonFF.lease}`) && !/ --force( |$)/.test(forced.cmd),
      `the right lease force pushes with --force-with-lease, never plain --force (${forced.cmd})`);

    // A branch with no upstream yet whose remote branch exists: Force Push pushes it and sets the upstream.
    git(repo, 'checkout', '-q', '-b', 'fresh');
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/fresh');
    git(repo, 'commit', '-q', '--amend', '-m', 'Mine, on fresh');
    git(repo, 'fetch', '-q');
    const freshRej = await call('push', repo);
    const freshForced = freshRej.lease ? await call('push', repo, { lease: freshRej.lease }) : freshRej;
    t.check(freshRej.rejected === 'non-fast-forward' && freshForced.ok && remoteHead(remote, 'fresh') === git(repo, 'rev-parse', 'HEAD') && git(repo, 'rev-parse', '--abbrev-ref', 'fresh@{u}') === 'origin/fresh',
      `a branch without an upstream is force pushed to the branch of its name, which becomes its upstream (${q({ rejected: freshRej.rejected, err: freshForced.err })})`);
  } catch (err) {
    t.check(false, err.message);
  }
}

const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
