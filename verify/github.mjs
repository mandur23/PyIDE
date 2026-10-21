// GitHub plugin against a fake GitHub CLI (verify/fixtures/github: gh.cmd runs fake-gh.js, which answers from a state
// file and logs every argv). The real gh and GitHub are never used: PYIDE_GH points at the fake.
// Instance 1 (English, port 9240): nothing runs gh at startup; the Pull Requests tool window explains a logged-out gh,
// a missing gh (cli.github.com link, Install Manager item) and a project without a GitHub remote; Share Project on
// GitHub runs the exact `gh repo create` argv (private by default, a description full of cmd metacharacters) and the
// fake's remote lands in the temp repository; the PR list renders and filters (open, closed, mine); details render the
// body as text, files, reviews, comments and checks; a file opens a base/head diff; Open in Browser and Checkout run
// what they should; a PR whose head is not local explains Checkout; Git › GitHub menu.
// Instance 2 (Korean, port 9241): an untrusted project in Safe Mode runs no gh at all; a trusted one shows the list and
// details in Korean with no missing translations.
// First, without Electron: finding gh on PATH (main/features/github.js) never picks a gh from the working folder or
// a relative PATH entry. `node verify/github.mjs --unit` runs only that.
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const q = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-github-'));

// ---------- pure Node: gh on PATH ----------
{
  const github = createRequire(import.meta.url)('../main/features/github.js');
  const unit = [];
  const ok = (cond, msg) => { unit.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
  // Empty files are enough: finding gh only looks; nothing here runs it.
  const dir = (...parts) => { const d = path.join(work, 'path-unit', ...parts); mkdirSync(d, { recursive: true }); return d; };
  const touch = (d, name) => { writeFileSync(path.join(d, name), ''); return path.join(d, name); };
  const cwd = dir('cwd');
  touch(cwd, 'gh.exe'); // a planted gh in the working folder
  touch(dir('cwd', 'rel'), 'gh.exe'); // and under a relative PATH entry
  const goodDir = dir('good');
  const good = touch(goodDir, 'gh.cmd');
  const both = dir('both');
  const bothExe = touch(both, 'gh.exe');
  touch(both, 'gh.cmd');
  const named = dir('named');
  mkdirSync(path.join(named, 'gh.exe')); // a folder called gh.exe is not a program
  const drive = path.parse(cwd).root.slice(0, 2); // "C:"
  const cases = [
    [`;rel;.;.\\rel;${cwd};${goodDir}`, good, 'empty, relative and "." entries and the working folder are skipped'],
    [`${cwd}\\;${goodDir}`, good, 'the working folder with a trailing backslash is skipped too'],
    [`${cwd.toUpperCase()};${goodDir}`, good, 'and in other letter case'],
    [`"${goodDir}"`, good, 'a quoted PATH entry is found'],
    [`\\${path.relative(path.parse(cwd).root, cwd)};${goodDir}`, good, 'a root-relative entry (current drive) is skipped'],
    [`${drive}${path.relative(path.parse(cwd).root, cwd)};${goodDir}`, good, 'a drive-relative entry ("C:folder") is skipped'],
    [`${named};${goodDir}`, good, 'a folder named gh.exe is not taken for gh'],
    [`${both};${goodDir}`, bothExe, 'gh.exe comes before gh.cmd in the same folder (PATHEXT order)'],
    ['rel;.', null, 'nothing but relative entries: no gh'],
  ];
  for (const [pathVar, want, msg] of cases) {
    const got = github.ghOnPath(pathVar, cwd);
    ok(got === want, `${msg} (${q(got)})`);
  }
  // findGh itself, run from the folder with the planted gh.
  const saved = { PATH: process.env.PATH, PYIDE_GH: process.env.PYIDE_GH, cwd: process.cwd() };
  try {
    delete process.env.PYIDE_GH;
    process.env.PATH = `.;rel;${goodDir}`;
    process.chdir(cwd);
    const found = await github.findGh();
    ok(found === good, `findGh from a folder holding gh.exe returns the gh on PATH (${q(found)})`);
  } finally {
    process.chdir(saved.cwd);
    process.env.PATH = saved.PATH;
    if (saved.PYIDE_GH !== undefined) process.env.PYIDE_GH = saved.PYIDE_GH;
  }
  console.log(`${unit.filter(Boolean).length}/${unit.length} passed (unit)`);
  if (unit.some((x) => !x)) process.exit(1);
  if (process.argv.includes('--unit')) process.exit(0);
}

// git isolated from the user's configuration, for the test and the IDE it starts.
const gitConfig = path.join(work, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Octo Cat\n\temail = octocat@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The fake gh lives in a temp bin folder so the test can make it disappear.
const bin = path.join(work, 'bin');
mkdirSync(bin);
for (const f of ['gh.cmd', 'fake-gh.js']) copyFileSync(path.join(HERE, 'fixtures', 'github', f), path.join(bin, f));
const ghCmd = path.join(bin, 'gh.cmd');

function makeRepo(dir, origin) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, 'app.py'), "def hello():\n    return 'hi'\n");
  writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Initial commit');
  git(dir, 'checkout', '-qb', 'feature/login');
  writeFileSync(path.join(dir, 'app.py'), "def hello():\n    return 'hello'\n");
  writeFileSync(path.join(dir, 'login.py'), 'def login(user):\n    return user\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Add login');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return head;
}

function ghState(file, { auth, head, repo }) {
  const pr = (number, title, login, headRefName, state, extra = {}) => ({ number, title, author: { login }, headRefName, baseRefName: 'main', state,
    isDraft: false, updatedAt: '2026-10-20T09:30:00Z', reviewDecision: '', ...extra });
  const prs = [
    pr(1, 'Add login page', 'octocat', 'feature/login', 'OPEN', { reviewDecision: 'APPROVED' }),
    pr(2, 'Fix typo in README', 'hubot', 'fix-typo', 'OPEN', { isDraft: true, reviewDecision: 'REVIEW_REQUIRED' }),
    pr(3, 'Old experiment', 'octocat', 'experiment', 'MERGED'),
    pr(4, 'Rejected idea', 'hubot', 'idea', 'CLOSED'),
  ];
  const url = (n) => `https://github.com/octocat/${repo}/pull/${n}`;
  const views = {
    1: { ...prs[0], url: url(1), headRefOid: head,
      body: '## Summary\nAdds a **login** page.\n\n<img src=x onerror="window.__ghInjected=1"><script>window.__ghInjected=1</script>\n- [x] tests',
      commits: [{ oid: head, messageHeadline: 'Add login', authors: [{ login: 'octocat', name: 'Octo Cat' }], committedDate: '2026-10-20T09:00:00Z' }],
      files: [{ path: 'app.py', additions: 1, deletions: 1 }, { path: 'login.py', additions: 2, deletions: 0 }],
      reviews: [
        { author: { login: 'hubot' }, state: 'APPROVED', body: 'Looks good to me', submittedAt: '2026-10-20T10:00:00Z' },
        { author: { login: 'monalisa' }, state: 'CHANGES_REQUESTED', body: 'Please add tests', submittedAt: '2026-10-20T11:00:00Z' },
      ],
      comments: [{ author: { login: 'hubot' }, body: 'Nice work!', createdAt: '2026-10-20T12:00:00Z' }],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/octocat/${repo}/actions/runs/1` },
        { __typename: 'CheckRun', name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: `https://github.com/octocat/${repo}/actions/runs/2` },
        { __typename: 'StatusContext', context: 'ci/coverage', state: 'PENDING', targetUrl: 'https://coverage.example.com/1' },
      ] },
    2: { ...prs[1], url: url(2), headRefOid: 'f'.repeat(40), body: '', commits: [], files: [{ path: 'README.md', additions: 1, deletions: 1 }], reviews: [], comments: [], statusCheckRollup: [] },
  };
  writeFileSync(file, JSON.stringify({ auth, account: 'octocat', prs, views }));
}

const ghLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const PR_LIST = 'number,title,author,headRefName,baseRefName,state,isDraft,updatedAt,reviewDecision';
const PR_VIEW = 'title,body,author,commits,files,reviews,comments,statusCheckRollup,number,url,state,isDraft,baseRefName,headRefName,headRefOid';

let failed = 0;
async function instance(t, body) {
  try {
    await body();
  } catch (err) {
    t.check(false, err.message.split('\n')[0]);
    await t.shot('failure.png').catch(() => {});
  }
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  failed += t.results.filter((r) => !r.ok).length + t.consoleErrors.length;
  t.close();
}

const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].some(n => n.textContent.includes(${q(text)}))`;
const visible = (sel) => `(() => { const n = document.querySelector(${q(sel)}); return !!n && !!n.getClientRects().length && !n.closest('.hidden'); })()`;
const textOf = (sel) => `(document.querySelector(${q(sel)})?.textContent || '')`;
const texts = (sel) => `[...document.querySelectorAll(${q(sel)})].map(n => n.textContent)`;

// ---------------------------------------------------------------- instance 1: English
{
  const project = path.join(work, 'my-app');
  const head = makeRepo(project);
  const stateFile = path.join(work, 'gh-state.json');
  const logFile = path.join(work, 'gh-log.jsonl');
  ghState(stateFile, { auth: 'out', head, repo: 'my-app' });
  const t = await launch({ fixture: 'github', port: 9240, name: 'github', projectDir: project, env: {
    PYIDE_GH: ghCmd, FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile, PYIDE_FAKE_OPEN_EXTERNAL: '1',
    PYIDE_INSTALLER_RUNNER: path.join(HERE, 'fixtures', 'installer', 'fake-runner.cjs'), PYIDE_INSTALLER_RUNNER_LOG: path.join(work, 'runner.log'),
  } });
  const { js, until, check, sleep, click } = t;
  const opened = () => js(`ide.api.invoke('github:openedUrls')`);
  const argvs = () => ghLog(logFile).map((e) => e.argv);
  const lastArgv = (first, second) => argvs().filter((a) => a[0] === first && a[1] === second).pop();
  await instance(t, async () => {
    await sleep(1500);
    check(ghLog(logFile).length === 0, 'opening a project runs no gh until GitHub features are used');

    // ---------- logged out ----------
    await js(`ide.runAction('Github.View.Pull.Request')`);
    await until(visible('.gh-state.gh-logged-out'), 'logged-out explanation');
    check((await js(textOf('.gh-state'))).includes('You are not logged in to the GitHub CLI.') && (await js(textOf('.gh-state'))).includes('gh auth login'),
      'a logged-out gh: the tool window says so and how to log in');
    check(await js(`!!document.querySelector('.gh-state .gh-login') && !!document.querySelector('.gh-state .gh-refresh-btn')`), 'Log In in Terminal and Refresh are offered');
    check(argvs().some((a) => a[0] === '--version') && argvs().some((a) => a.join(' ') === 'auth status'), 'gh discovery ran gh --version and gh auth status');
    await js(`ide.runAction('Github.Share.Project')`);
    await until(`document.querySelector('.dialog .gh-setup-dialog')?.textContent.includes('You are not logged in')`, 'share asks to log in');
    check(argvs().every((a) => a[1] !== 'create'), 'Share Project on GitHub while logged out explains how to log in and runs nothing');
    await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Close').click()`);

    // ---------- missing ----------
    renameSync(ghCmd, `${ghCmd}.off`);
    await click('.gh-state .gh-refresh-btn');
    await until(visible('.gh-state.gh-missing'), 'missing explanation');
    check((await js(textOf('.gh-state'))).includes('GitHub CLI (gh) is not installed.'), 'a missing gh: the tool window says it is not installed');
    await click('.gh-state .gh-cli-link');
    await until(`ide.api.invoke('github:openedUrls').then(u => u.includes('https://cli.github.com/'))`, 'cli.github.com opened');
    check(true, 'the cli.github.com button opens the site in the browser (shell.openExternal stubbed)');
    await click('.gh-state .gh-install');
    await until(`!!document.querySelector('.inst-card[data-id="system:gh"]')`, 'Install Manager card');
    check(await js(`document.querySelector('.inst-card[data-id="system:gh"]').textContent.includes('GitHub CLI')`), 'Install GitHub CLI opens the Install Manager at its GitHub CLI item');
    await js(`ide.closeTab('installer:manager', true)`);
    renameSync(`${ghCmd}.off`, ghCmd);

    // ---------- logged in, no GitHub remote ----------
    ghState(stateFile, { auth: 'in', head, repo: 'my-app' });
    await js(`ide.toolWindows.get('PullRequests').show()`);
    await click('.gh-state .gh-refresh-btn');
    await until(visible('.gh-state.gh-no-remote'), 'no-remote state');
    check((await js(textOf('.gh-state'))).includes('This project has no GitHub remote.'), 'logged in without a GitHub remote: Share Project on GitHub is offered');

    // ---------- Share Project on GitHub ----------
    await click('.gh-state .gh-share-btn');
    await until(`document.querySelector('.dialog-title')?.textContent === 'Share Project on GitHub'`, 'share dialog');
    check(await js(`document.querySelector('.gh-share-name').value === 'my-app' && document.querySelector('.gh-share-private input').checked && document.querySelector('.gh-share-remote').value === 'origin'`),
      'the dialog defaults to the folder name, Private on and remote origin');
    check(await js(`document.querySelector('.gh-share-account').textContent.includes('octocat')`), 'the dialog names the logged-in account');
    const description = 'Demo "app" & tools 100% %PATH% ^caret!';
    await js(`(() => { const d = document.querySelector('.gh-share-description'); d.value = ${q(description)}; return true; })()`);
    // A remote name that exists is refused in the dialog (none exists here, so try an invalid one).
    await js(`document.querySelector('.gh-share-remote').value = 'bad name'`);
    await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Share').click()`);
    await until(`document.querySelector('.gh-share-error')?.textContent.includes('remote name')`, 'invalid remote refused');
    check(ghLog(logFile).every((e) => e.argv[1] !== 'create'), 'an invalid remote name is refused before gh runs');
    await js(`document.querySelector('.gh-share-remote').value = 'origin'`);
    await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Share').click()`);
    await until(noteWith('Shared the project on GitHub'), 'shared notification', 30000);
    const root = await js('ide.root');
    const create = lastArgv('repo', 'create');
    const want = ['repo', 'create', 'my-app', '--private', '--description', description, '--source', root, '--remote', 'origin', '--push'];
    check(q(create) === q(want), `Share runs gh repo create with the exact argv, private by default (${q(create)})`);
    check(git(project, 'remote', 'get-url', 'origin') === 'https://github.com/octocat/my-app.git', 'the new remote is in the repository');
    check(await js(noteWith('https://github.com/octocat/my-app')), 'the notification shows the new repository URL');
    const consoleText = await js(textOf('#vcsConsole'));
    check(consoleText.includes('gh repo create my-app --private') && consoleText.includes('Created repository octocat/my-app on GitHub'), 'the Git console shows the gh command and its output');

    // ---------- pull request list and filters ----------
    await until(`document.querySelectorAll('.gh-pr').length === 2`, 'open pull requests');
    check(q(lastArgv('pr', 'list')) === q(['pr', 'list', '--json', PR_LIST, '--limit', '50', '--state', 'open']), `the list runs gh pr list with the expected argv (${q(lastArgv('pr', 'list'))})`);
    check(q(await js(texts('.gh-pr .gh-pr-title'))) === q(['Add login page', 'Fix typo in README']), 'open pull requests are listed');
    const row1 = await js(textOf('.gh-pr[data-number="1"]'));
    const row2 = await js(textOf('.gh-pr[data-number="2"]'));
    check(row1.includes('#1') && row1.includes('octocat') && row1.includes('feature/login → main') && row1.includes('Approved'), `a row shows number, author, branches and review decision (${row1})`);
    check(row2.includes('Draft') && row2.includes('Review required'), 'a draft pull request is marked');
    check(await js(`document.querySelector('.gh-account').textContent.includes('octocat/my-app')`), 'the bar names the GitHub repository');
    await js(`(() => { const s = document.querySelector('#ghFilter'); s.value = 'closed'; s.dispatchEvent(new Event('change')); return true; })()`);
    await until(`document.querySelector('.gh-pr[data-number="3"]') && document.querySelectorAll('.gh-pr').length === 2`, 'closed list');
    check(lastArgv('pr', 'list').includes('closed') && (await js(textOf('.gh-pr[data-number="3"]'))).includes('Merged') && (await js(textOf('.gh-pr[data-number="4"]'))).includes('Closed'),
      'Closed lists closed and merged pull requests with their state');
    await js(`(() => { const s = document.querySelector('#ghFilter'); s.value = 'mine'; s.dispatchEvent(new Event('change')); return true; })()`);
    await until(`document.querySelectorAll('.gh-pr').length === 1 && document.querySelector('.gh-pr[data-number="1"]')`, 'mine list');
    check(q(lastArgv('pr', 'list').slice(-4)) === q(['--state', 'open', '--author', '@me']), 'Your pull requests asks gh for --author @me');
    await js(`(() => { const s = document.querySelector('#ghFilter'); s.value = 'open'; s.dispatchEvent(new Event('change')); return true; })()`);
    await until(`document.querySelectorAll('.gh-pr').length === 2`, 'open list again');

    // ---------- details ----------
    await click('.gh-pr[data-number="1"]');
    await until(`document.querySelector('.gh-detail-title')?.textContent === 'Add login page' && document.querySelectorAll('.gh-file').length === 2`, 'details of #1');
    check(q(lastArgv('pr', 'view')) === q(['pr', 'view', '1', '--json', PR_VIEW]), `details run gh pr view with the expected argv (${q(lastArgv('pr', 'view'))})`);
    const bodyText = await js(textOf('.gh-description .gh-body'));
    check(bodyText.includes('Adds a **login** page.') && bodyText.includes('<script>') && await js(`!document.querySelector('.gh-description img, .gh-description script') && window.__ghInjected === undefined`),
      'the description is shown as text: Markdown and HTML stay literal and nothing runs');
    check((await js(textOf('.gh-head-meta'))).includes('octocat wants to merge feature/login into main'), 'the header says who wants to merge which branch into which');
    check(q(await js(texts('.gh-file .gh-file-name'))) === q(['app.py', 'login.py']) && (await js(textOf('.gh-file[data-path="login.py"] .gh-file-stat'))).includes('+2'),
      'files changed are listed with their line counts');
    const reviews = await js(texts('.gh-review'));
    check(reviews.length === 2 && reviews[0].includes('hubot') && reviews[0].includes('Approved') && reviews[0].includes('Looks good to me') && reviews[1].includes('Changes requested'),
      'reviews show author, verdict and text');
    check((await js(texts('.gh-comment'))).join('|').includes('Nice work!'), 'comments are listed');
    const summary = await js(textOf('.gh-check-summary'));
    check(summary.includes('Failed 1') && summary.includes('Pending 1') && summary.includes('Passed 1'), `checks are summarized (${summary})`);
    check(q(await js(`[...document.querySelectorAll('.gh-check')].map(n => n.dataset.state)`)) === q(['success', 'failure', 'pending']) && (await js(texts('.gh-check-name')))[0] === 'CI / build',
      'each check run and commit status shows its state');
    check((await js(texts('.gh-commit'))).join('|').includes('Add login'), 'commits are listed');
    await t.shot('pull-requests.png');

    // ---------- file diff between base and head ----------
    await click('.gh-file[data-path="app.py"]');
    await until(`!!ide.findTab('app.py [#1]')`, 'diff tab');
    const sides = await js(`ide.monaco.editor.getModels().filter(m => m.uri.scheme === 'vcs-diff' && m.uri.path.endsWith('/app.py')).map(m => m.getValue())`);
    check(sides.some((s) => s.includes("return 'hi'")) && sides.some((s) => s.includes("return 'hello'")), 'a changed file opens a diff of the merge base and the head commit');
    check((await js(texts('.vcs-diff-side'))).join('|').match(/main \([0-9a-f]{7}\).*feature\/login \([0-9a-f]{7}\)/), 'the diff sides name the base and head branches');
    await click('.gh-file[data-path="login.py"]');
    await until(`!!ide.findTab('login.py [#1]')`, 'added file diff');
    const added = await js(`ide.monaco.editor.getModels().filter(m => m.uri.scheme === 'vcs-diff' && m.uri.path.endsWith('/login.py')).map(m => m.getValue())`);
    check(added.includes('') && added.some((s) => s.includes('def login')), 'an added file diffs against nothing');

    // ---------- Open in Browser ----------
    await click('.gh-open-browser');
    await until(`ide.api.invoke('github:openedUrls').then(u => u.includes('https://github.com/octocat/my-app/pull/1'))`, 'pull request opened');
    check(true, 'Open in Browser opens the pull request page (shell.openExternal stubbed)');
    await js(`[...document.querySelectorAll('.gh-check .gh-link')][1].click()`);
    await until(`ide.api.invoke('github:openedUrls').then(u => u.includes('https://github.com/octocat/my-app/actions/runs/2'))`, 'check details opened');
    check(true, 'a check links to its details page');

    // ---------- a pull request whose head commit is not local ----------
    await click('.gh-pr[data-number="2"]');
    await until(`document.querySelector('.gh-detail-title')?.textContent === 'Fix typo in README'`, 'details of #2');
    check((await js(textOf('.gh-description'))).includes('No description provided.') && (await js(textOf('.gh-reviews'))).includes('No reviews'), 'empty description and reviews are said so');
    const checkoutsBefore = argvs().filter((a) => a[1] === 'checkout').length;
    await click('.gh-file[data-path="README.md"]');
    await until(noteWith("The pull request's commits are not in the local repository"), 'head missing note');
    check(!(await js(`!!ide.findTab('README.md [#2]')`)) && argvs().filter((a) => a[1] === 'checkout').length === checkoutsBefore,
      'without the head commit no diff opens and nothing is fetched: the note points to Checkout');

    // ---------- Checkout (explicit) ----------
    await click('.gh-checkout');
    await until(noteWith('Checked out pull request #2'), 'checkout note');
    check(q(lastArgv('pr', 'checkout')) === q(['pr', 'checkout', '2']), 'Checkout runs gh pr checkout <n>');
    check((await js(textOf('#vcsConsole'))).includes('gh pr checkout 2') && (await js(textOf('#vcsConsole'))).includes("Switched to branch 'fix-typo'"), 'the checkout output is in the Git console');

    // ---------- Git › GitHub menu ----------
    await click('#mainMenuBtn');
    await until(`!!document.querySelector('#mainMenu')`, 'main menu');
    await js(`[...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.querySelector('.menu-label').textContent === 'Git').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
    await until(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-label')].some(n => n.textContent === 'GitHub')`, 'Git submenu');
    await js(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].find(n => n.querySelector('.menu-label').textContent === 'GitHub').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
    await until(`document.querySelectorAll('.context-menu[data-level="2"] .menu-item').length === 2`, 'GitHub submenu');
    check(q(await js(texts('.context-menu[data-level="2"] .menu-label'))) === q(['Share Project on GitHub…', 'View Pull Requests']), 'Git › GitHub lists Share Project on GitHub… and View Pull Requests');
    await t.press('Escape');

    // ---------- main-side guards ----------
    const empty = path.join(work, 'empty-repo');
    mkdirSync(empty);
    git(empty, 'init', '-q');
    const before = ghLog(logFile).length;
    const noCommits = await js(`ide.api.invoke('github:share', ${q(empty)}, { name: 'x', remote: 'origin' })`);
    check(noCommits.reason === 'noCommits' && ghLog(logFile).length === before, 'a repository without commits is refused before gh runs');
    const shared = await js(`ide.api.invoke('github:share', ide.root, { name: 'again', remote: 'github' })`);
    check(shared.reason === 'alreadyShared' && ghLog(logFile).length === before, 'a project already on GitHub is not shared again');
    const badName = await js(`ide.api.invoke('github:share', ide.root, { name: '--help', remote: 'origin' })`);
    check(badName.reason === 'badName', 'a repository name that reads as an option is refused');
    check((await js(`ide.api.invoke('github:openUrl', 'file:///C:/Windows/notepad.exe')`)) === false, 'only https URLs are opened');

    // ---------- a project without commits: the initial commit comes first ----------
    writeFileSync(path.join(empty, 'main.py'), 'print(1)\n');
    await js(`ide.openProject(${q(empty)})`);
    await until(`ide.util.samePath(ide.root, ${q(empty)})`, 'empty repo opened');
    await js(`ide.runAction('Github.Share.Project')`);
    await until(`document.querySelector('.dialog-body')?.textContent.includes('The project has no commits yet. Make the initial commit')`, 'initial commit offer');
    await js(`[...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Commit…').click()`);
    await until(`ide.toolWindows.get('Commit').isVisible() && document.activeElement?.classList.contains('vcs-msg')`, 'commit window');
    check(argvs().filter((a) => a[1] === 'create').length === 1, 'sharing a project without commits offers the Commit tool window first and creates nothing');
  });
}

// ---------------------------------------------------------------- instance 2: Korean, Safe Mode
{
  const home = path.join(work, 'home-app');
  const head = makeRepo(home, 'https://github.com/octocat/home-app.git');
  const downloaded = path.join(work, 'downloaded');
  makeRepo(downloaded, 'https://github.com/someone/downloaded.git');
  const stateFile = path.join(work, 'gh-state-ko.json');
  const logFile = path.join(work, 'gh-log-ko.jsonl');
  ghState(stateFile, { auth: 'in', head, repo: 'home-app' });
  const userData = path.join(work, 'userdata-ko');
  mkdirSync(userData);
  // The home project was opened before, so the first run of the trust feature trusts it; `downloaded` is not trusted.
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ recentProjects: [{ path: home, opened: Date.now() }] }));
  const t = await launch({ fixture: 'github', port: 9241, name: 'github-ko', projectDir: home, userData, lang: 'ko-KR', env: {
    PYIDE_TRUST_ALL: '', PYIDE_GH: ghCmd, FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile, PYIDE_FAKE_OPEN_EXTERNAL: '1',
  } });
  const { js, until, check, sleep, click } = t;
  await instance(t, async () => {
    // ---------- untrusted: no gh at all ----------
    js(`ide.openProject(${q(downloaded)})`);
    await until(`document.querySelectorAll('.dialog-buttons button').length === 3`, 'trust question');
    await js(`document.querySelectorAll('.dialog-buttons button')[1].click()`); // Preview in Safe Mode
    await until(`ide.root && ide.util.samePath(ide.root, ${q(downloaded)}) && ide.trusted === false`, 'opened in Safe Mode');
    await js(`ide.runAction('Github.View.Pull.Request')`);
    await until(visible('.gh-state .gh-untrusted'), 'Safe Mode note');
    check((await js(textOf('.gh-state'))).includes('안전 모드에서는 GitHub 기능이 꺼져 있습니다'), 'in Safe Mode the tool window says GitHub features are off (Korean)');
    await js(`ide.runAction('Github.Share.Project')`);
    await until(noteWith('안전 모드'), 'share refused');
    check(true, 'Share Project on GitHub is refused in Safe Mode');
    const direct = await js(`Promise.all([ide.api.invoke('github:status', ide.root), ide.api.invoke('github:prList', ide.root, 'open'),
      ide.api.invoke('github:prView', ide.root, 1), ide.api.invoke('github:checkout', ide.root, 1), ide.api.invoke('github:share', ide.root, { name: 'x', remote: 'up' }),
      ide.api.invoke('github:repo', ide.root)])`);
    check(direct[0].trusted === false && direct.slice(1, 5).every((r) => r.reason === 'untrusted') && direct[5].trusted === false,
      'every main-side GitHub call refuses an untrusted project');
    await sleep(500);
    check(ghLog(logFile).length === 0, `an untrusted project never runs gh (${ghLog(logFile).length} calls)`);
    check(!git(downloaded, 'remote').includes('up'), 'nothing was added to the untrusted repository');

    // ---------- trusted project in Korean ----------
    await js(`ide.openProject(${q(home)})`);
    await until(`ide.root && ide.util.samePath(ide.root, ${q(home)}) && ide.trusted === true`, 'home reopened');
    await js(`ide.runAction('Github.View.Pull.Request')`);
    await until(`document.querySelectorAll('.gh-pr').length === 2`, 'Korean list');
    check(await js(`document.querySelector('[data-tool="PullRequests"]').dataset.tooltip === '풀 리퀘스트'`), 'the tool window is called 풀 리퀘스트');
    check(q(await js(`[...document.querySelectorAll('#ghFilter option')].map(o => o.textContent)`)) === q(['열린 풀 리퀘스트', '닫힌 풀 리퀘스트', '내 풀 리퀘스트']), 'filters are in Korean');
    await click('.gh-pr[data-number="1"]');
    await until(`document.querySelectorAll('.gh-file').length === 2`, 'Korean details');
    check((await js(textOf('.gh-head-meta'))).includes('octocat 님이 feature/login을(를) main에 병합하려고 합니다'), 'the header sentence is Korean with names kept');
    check((await js(textOf('.gh-check-summary'))).includes('실패 1') && (await js(textOf('.gh-review'))).includes('승인됨'), 'check and review states are Korean');
    const leaks = await englishLeaks(t, '.gh-tool', ['gh', 'CI']);
    check(!leaks.length, `no English left in the Pull Requests tool window${leaks.length ? ` ${q(leaks)}` : ''}`);
    await js(`(() => { const s = document.querySelector('#ghFilter'); s.value = 'closed'; s.dispatchEvent(new Event('change')); return true; })()`);
    await until(`document.querySelector('.gh-pr[data-number="3"]')`, 'Korean closed list');
    check((await js(textOf('.gh-pr[data-number="3"]'))).includes('병합됨'), 'state badges are Korean');
    // The plugin's own strings (other plugins have their own suites).
    const src = readFileSync(path.join(HERE, '..', 'renderer', 'features', 'github', 'index.js'), 'utf8');
    const missing = (await missingTranslations(t)).filter((s) => src.includes(`'${s}'`) || src.includes(`"${s}"`));
    check(!missing.length, `no missing Korean translations for the GitHub plugin${missing.length ? ` ${q(missing)}` : ''}`);
  });
}

console.log(failed ? `FAILED (${failed})` : 'all passed');
process.exit(failed ? 1 : 0);
