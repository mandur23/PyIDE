// Git log graph and the Activity timeline: a repository with a branch, a merge, an amend and a reset shows branch
// lines and a merge badge in the Log, filters by author ("me"), and lists every action (commit, checkout, merge,
// amend, reset) in Activity, in English and Korean.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-vcslog-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function buildHistory(dir) {
  git(dir, 'init');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'Initial commit');
  git(dir, 'checkout', '-b', 'feature');
  appendFileSync(path.join(dir, 'main.py'), '\n# feature work\n');
  git(dir, '-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-am', 'Feature work');
  git(dir, 'checkout', 'main');
  writeFileSync(path.join(dir, 'notes.txt'), 'main fix\n');
  git(dir, 'add', 'notes.txt');
  git(dir, 'commit', '-m', 'Main fix');
  git(dir, 'merge', '--no-ff', 'feature', '-m', 'Merge feature');
  appendFileSync(path.join(dir, 'notes.txt'), 'typo\n');
  git(dir, 'commit', '-am', 'Typo');
  git(dir, 'commit', '--amend', '-m', 'Fix typo');
  git(dir, 'reset', '--hard', 'HEAD~1');
}

async function openGit(t, what) {
  buildHistory(t.project);
  await t.js(`(ide.emit('filesChanged'), true)`);
  await t.js(`(ide.toolWindows.get('Git').show(), true)`);
  await t.until(`document.querySelectorAll('.vcs-log-rows .vcs-log-row').length === 4`, `${what} log rows`, 20000);
}

const rows = (t) => t.js(`[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].map(r => r.querySelector('.vcs-subject-text').textContent)`);
const nodeX = (t, subject) => t.js(`Number([...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].find(r => r.textContent.includes(${JSON.stringify(subject)}))?.querySelector('.vcs-node').getAttribute('cx'))`);

const t = await launch({ fixture: 'vcs', port: 9660, name: 'vcs-log' });
const { js, until, check, shot } = t;
try {
  await openGit(t, 'en');

  // ---------- Log graph ----------
  check((await rows(t)).join('|') === 'Merge feature|Main fix|Feature work|Initial commit', `the log lists the reachable commits newest first (${(await rows(t)).join('|')})`);
  const merge = '[...document.querySelectorAll(".vcs-log-rows .vcs-log-row")].find(r => r.textContent.includes("Merge feature"))';
  check(await js(`${merge}.classList.contains('merge') && ${merge}.querySelector('.vcs-badge.merge').textContent === 'Merge' && ${merge}.querySelector('.vcs-node.merge') !== null`), 'the merge commit has a Merge badge and a hollow node');
  check(await nodeX(t, 'Feature work') !== await nodeX(t, 'Main fix'), 'the feature branch commit is drawn on its own lane');
  check(await nodeX(t, 'Merge feature') === await nodeX(t, 'Initial commit'), 'main stays on the first lane from the root to the merge');
  check(await js(`${merge}.querySelectorAll('.vcs-graph path').length >= 2`), 'the merge row draws lines to both parents');
  await shot('log-graph.png');

  // ---------- details of a merge ----------
  await js(`${merge}.click()`);
  await until(`document.querySelectorAll('.vcs-detail-parents .vcs-hash-link').length === 2`, 'merge parents');
  check(true, 'a merge commit lists both parents in its details');
  await js(`document.querySelectorAll('.vcs-detail-parents .vcs-hash-link')[1].click()`);
  await until(`document.querySelector('.vcs-log-row.selected')?.textContent.includes('Feature work')`, 'parent selected');
  check(true, 'clicking the second parent selects the merged branch commit');

  // ---------- author filter ----------
  check(await js(`[...document.querySelectorAll('#vcsLogAuthor option')].map(o => o.textContent).join('|')`) === 'All|Me (Alice)|Alice|Bob', 'the user filter offers All, Me and each author');
  check(await js(`[...document.querySelectorAll('.vcs-log-rows .vcs-c-author.mine')].length === 3 && !document.querySelector('.vcs-log-rows .vcs-log-row[data-hash] .vcs-c-author.mine')?.textContent.includes('Bob')`), 'my commits are highlighted');
  await js(`(() => { const s = document.querySelector('#vcsLogAuthor'); s.value = '@me'; s.dispatchEvent(new Event('change')); })()`);
  check((await rows(t)).join('|') === 'Merge feature|Main fix|Initial commit' && await js(`document.querySelector('.vcs-log-rows').classList.contains('filtered') && !document.querySelector('.vcs-log-rows .vcs-graph path')`), 'Me shows only my commits, as dots without misleading lines');
  await js(`(() => { const s = document.querySelector('#vcsLogAuthor'); s.value = ''; s.dispatchEvent(new Event('change')); const i = document.querySelector('#vcsLogSearch'); i.value = 'typo'; i.dispatchEvent(new Event('input')); })()`);
  check(await js(`document.querySelector('.vcs-log-rows').textContent.includes('No commits match the filter')`), 'a search with no match says so');
  await js(`(() => { const i = document.querySelector('#vcsLogSearch'); i.value = 'feat'; i.dispatchEvent(new Event('input')); })()`);
  check((await rows(t)).join('|') === 'Merge feature|Feature work', 'search filters by message');
  await js(`(() => { const i = document.querySelector('#vcsLogSearch'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);

  // ---------- Activity ----------
  await js(`document.querySelector('#vcsActivityTab').click()`);
  await until(`document.querySelectorAll('#vcsActivity .vcs-act-row').length >= 9`, 'activity rows');
  const kinds = await js(`[...document.querySelectorAll('#vcsActivity .vcs-act-row')].map(r => r.dataset.kind).join(',')`);
  check(kinds === 'reset,amend,commit,merge,commit,checkout,commit,checkout,commit', `Activity lists every action newest first (${kinds})`);
  const text = (kind, i = 0) => js(`[...document.querySelectorAll('#vcsActivity .vcs-act-row[data-kind="${kind}"]')][${i}].querySelector('.vcs-act-text').textContent`);
  check((await text('merge')) === 'Merged feature (Merge made by the \'ort\' strategy.)', `a merge reads as "Merged feature" (${await text('merge')})`);
  check((await text('checkout')) === 'Switched from feature to main' && (await text('checkout', 1)) === 'Switched from main to feature', 'branch switches show from and to');
  check((await text('amend')) === 'Amended the last commit: Fix typo' && (await text('reset')).startsWith('Reset to HEAD~1'), 'amend and reset are named');
  check(await js(`document.querySelector('#vcsActivity .vcs-act-day').textContent === 'Today' && document.querySelector('#vcsActivity .vcs-act-who').textContent === 'Alice'`), 'actions are grouped by day with who did them');
  await js(`(() => { const s = document.querySelector('#vcsActivityKind'); s.value = 'merge'; s.dispatchEvent(new Event('change')); })()`);
  check(await js(`document.querySelectorAll('#vcsActivity .vcs-act-row').length === 1`), 'the kind filter shows only merges');
  await shot('activity.png');
  await js(`document.querySelector('#vcsActivity .vcs-act-row .vcs-hash-link').click()`);
  await until(`!document.querySelector('.vcs-log').classList.contains('hidden') && document.querySelector('.vcs-log-row.selected')?.textContent.includes('Merge feature')`, 'jump to log');
  check(true, 'clicking an action\'s hash shows that commit in the Log');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'vcs', port: 9661, name: 'vcs-log-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  await openGit(k, 'ko');
  check(await k.js(`[...document.querySelectorAll('.vcs-subtab')].map(s => s.textContent).join('|')`) === '로그|활동|콘솔', 'sub-tabs are 로그 | 활동 | 콘솔');
  check(await k.js(`document.querySelector('.vcs-log-row.merge .vcs-badge').textContent === '병합'`), 'the merge badge reads 병합');
  const leaks = await englishLeaks(k, '.vcs-log-bar, .vcs-log-header');

  // ---------- the filter bar in a narrow bottom panel ----------
  const barLayout = () => k.js(`(() => {
    const box = (n) => n.getBoundingClientRect();
    const bar = box(document.querySelector('.vcs-log-bar'));
    const label = document.querySelector('.vcs-log-bar label');
    const search = box(document.querySelector('#vcsLogSearch'));
    const author = box(document.querySelector('#vcsLogAuthor'));
    return { table: Math.round(box(document.querySelector('.vcs-log-table')).width), labelLines: Math.round(box(label).height / (parseFloat(getComputedStyle(label).fontSize) * 1.3)),
      search: Math.round(search.width), searchInside: search.left >= bar.left && search.right <= bar.right + 0.5, authorInside: author.right <= bar.right + 0.5,
      subject: Math.round(box(document.querySelector('.vcs-log-rows .vcs-log-row .vcs-c-subject')).width) };
  })()`);
  const barChecks = async (where) => {
    const b = await barLayout();
    k.check(b.labelLines === 1, `${where}: the 사용자: label stays on one line (${JSON.stringify(b)})`);
    k.check(b.searchInside && b.authorInside && b.search >= 120, `${where}: the search box and the user list are whole (${JSON.stringify(b)})`);
    k.check(b.subject >= 120, `${where}: the subject column keeps its minimum width (${JSON.stringify(b)})`);
  };
  await barChecks('normal size');
  await k.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  // The emulated height can come out a pixel taller.
  await k.until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await k.js(`(ide.toolWindows.get('Notifications').show(), true)`);
  await k.until(`ide.toolWindows.get('Notifications').isVisible()`, 'right tool window');
  await k.sleep(400);
  await barChecks('1008x681 with a right tool window');
  await k.shot('log-narrow-ko.png');
  await k.js(`(ide.toolWindows.get('Notifications').hide(), true)`);
  await k.cdp('Emulation.clearDeviceMetricsOverride');
  await k.js(`document.querySelector('#vcsActivityTab').click()`);
  await k.until(`document.querySelectorAll('#vcsActivity .vcs-act-row').length >= 9`, 'ko activity');
  check(await k.js(`[...document.querySelectorAll('#vcsActivity .vcs-act-row[data-kind="checkout"] .vcs-act-text')][0].textContent`) === 'feature에서 main(으)로 전환함', 'a branch switch reads in Korean');
  leaks.push(...await englishLeaks(k, '.vcs-activity'));
  check(!leaks.length, `Korean Git log and Activity have no English leaks${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
  await k.shot('activity-ko.png');
  check(k.consoleErrors.length === 0, 'no renderer exceptions (ko)');
} catch (err) {
  check(false, err.message);
}
for (const r of k.results) t.results.push(r);
k.close();
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
