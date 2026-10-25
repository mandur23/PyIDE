// PyCharm's Git log menu for one commit: Copy Revision Number, Checkout Revision, Reset Current Branch to Here (Soft,
// Mixed, Hard), Undo Commit (the message goes back into the commit box), Edit Commit Message of an older unpushed commit
// with local changes in the work tree, New Branch and New Tag at a commit; pushed commits are not rewritten. Then the
// menu and the Git Reset dialog in Korean. Ports 9432, 9433.
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-vcsacts-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const q = JSON.stringify;

// Two pushed commits, then two local ones (a third author's on top) and an uncommitted change.
function buildRepo(dir) {
  const remote = path.join(gitHome, `remote-${path.basename(path.dirname(dir))}.git`);
  git(gitHome, 'init', '--bare', remote);
  const write = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
  git(dir, 'init');
  write('app.py', 'VERSION = 1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'Initial commit');
  write('second.py', 'SECOND = 2\n');
  git(dir, 'add', 'second.py');
  git(dir, 'commit', '-m', 'Second commit');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-u', 'origin', 'main');
  write('third.py', 'THIRD = 3\n');
  git(dir, 'add', 'third.py');
  git(dir, 'commit', '-m', 'Third: local work\n\nWhy the third commit exists.');
  write('fourth.py', 'FOURTH = 4\n');
  git(dir, 'add', 'fourth.py');
  git(dir, '-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-m', 'Fourth commit', '--date=2020-01-02T03:04:05+0900');
  write('app.py', 'VERSION = 1\nLOCAL_EDIT = True\n');
}

function helpers(t) {
  const { js, cdp, sleep } = t;
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
    const box = await js(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView?.({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${label}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(80);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: 1 });
    await sleep(100);
  }
  const logRow = (subject) => `[...document.querySelectorAll('.vcs-log-rows .vcs-log-row')].find(r => r.querySelector('.vcs-subject-text')?.textContent === ${q(subject)})`;
  const menuItem = (label) => `[...document.querySelectorAll('#menuHost .menu-item')].find(m => m.firstChild.textContent === ${q(label)})`;
  const labels = () => js(`[...document.querySelectorAll('#menuHost .menu-item')].map(m => m.firstChild.textContent + (m.classList.contains('disabled') ? ' (off)' : ''))`);
  async function menu(subject) {
    await t.press('Escape');
    await until(`!!${logRow(subject)}`, `log row ${subject}`, 20000);
    await mouse(logRow(subject), { button: 'right', label: `${subject} row` });
    await until(`document.querySelectorAll('#menuHost .menu-item').length > 3`, `menu of ${subject}`);
    return labels();
  }
  const run = async (subject, label) => { await menu(subject); await mouse(menuItem(label), { label }); };
  const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].some(n => n.textContent.includes(${q(text)}))`;
  return { until, mouse, logRow, menuItem, labels, menu, run, noteWith };
}

const t = await launch({ fixture: 'vcs', port: 9432, name: 'vcs-log-actions' });
const { js, check, shot, press, type, project } = t;
const h = helpers(t);
const { until, mouse, menu, run, logRow, noteWith } = h;
const subjects = () => git(project, 'log', '--format=%s').split('\n');
const hashOf = (subject) => git(project, 'log', '--format=%H', '--fixed-strings', `--grep=${subject}`, '-n1');
try {
  buildRepo(project);
  await js(`(ide.emit('filesChanged'), true)`);
  await js(`(ide.toolWindows.get('Git').show(), true)`);
  await until(`document.querySelectorAll('.vcs-log-rows .vcs-log-row').length === 4`, 'four log rows', 20000);

  // ---------- the menu ----------
  const ALL = ['Copy Revision Number', 'Cherry-Pick', 'Revert Commit', 'Checkout Revision', 'Reset Current Branch to Here…', 'Undo Commit', 'Edit Commit Message…', 'New Branch…', 'New Tag…'];
  let items = await menu('Fourth commit');
  check(items.map((s) => s.replace(' (off)', '')).join('|') === ALL.join('|'), `a commit's menu has PyCharm's actions in order (${items.join('|')})`);
  check(!items.some((s) => s.endsWith('(off)')), 'on the last, unpushed commit every action is available');
  items = await menu('Third: local work');
  check(items.includes('Undo Commit (off)') && items.includes('Edit Commit Message…'), `an older unpushed commit can be reworded but not undone (${items.join('|')})`);
  items = await menu('Second commit');
  check(items.includes('Undo Commit (off)') && items.includes('Edit Commit Message… (off)') && items.includes('Reset Current Branch to Here…'),
    `a pushed commit is neither undone nor reworded, but can be reset to (${items.join('|')})`);
  await shot('log-menu.png');

  // ---------- Copy Revision Number ----------
  await js(`(ide.on('clipboardWritten', (text) => { window.__copied = text; }), true)`);
  await mouse(h.menuItem('Copy Revision Number'), { label: 'Copy Revision Number' });
  await until(`!!window.__copied`, 'copied');
  check(await js(`window.__copied`) === hashOf('Second commit'), 'Copy Revision Number copies the full hash');

  // ---------- Edit Commit Message of an older commit, with a local change ----------
  const treeBefore = git(project, 'rev-parse', 'HEAD^{tree}');
  const fourthAuthor = git(project, 'log', '-1', '--format=%an <%ae> %ad', '--date=raw');
  await run('Third: local work', 'Edit Commit Message…');
  await until(`document.querySelector('.dialog .vcs-reword-text')?.value === 'Third: local work\\n\\nWhy the third commit exists.'`, 'reword dialog with the full message');
  check(await js(`document.querySelector('.dialog-title').textContent`) === 'Edit Commit Message', 'Edit Commit Message opens with the full message');
  await js(`(() => { const b = document.querySelector('.dialog .vcs-reword-text'); b.value = 'Third: reworded\\n\\nA better reason.'; return true; })()`);
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'OK' });
  await until(`!!${logRow('Third: reworded')}`, 'reworded row', 20000);
  check(subjects().join('|') === 'Fourth commit|Third: reworded|Second commit|Initial commit', `the commit gets the new message and the one after it stays (${subjects().join('|')})`);
  check(git(project, 'log', '-1', '--skip=1', '--format=%b') === 'A better reason.', 'the new message keeps its body');
  check(git(project, 'rev-parse', 'HEAD^{tree}') === treeBefore && git(project, 'log', '-1', '--format=%an <%ae> %ad', '--date=raw') === fourthAuthor,
    'the commit after it keeps its files, author and date');
  check(readFileSync(path.join(project, 'app.py'), 'utf8') === 'VERSION = 1\nLOCAL_EDIT = True\n' && git(project, 'status', '--porcelain') === 'M app.py',
    'the local change in the work tree is untouched');
  check(git(project, 'log', '-1', '--format=%gs', '-g', 'HEAD') === 'reword: Third: reworded', 'the reflog says what happened');
  check(await js(`document.querySelector('.vcs-log-row.selected .vcs-subject-text')?.textContent`) === 'Third: reworded', 'the reworded commit stays selected');

  // ---------- pushed commits are refused by main too ----------
  const refused = await js(`ide.api.invoke('git:reword', ide.root, ${q(hashOf('Second commit'))}, 'Rewritten')`);
  check(!refused.ok && refused.reason === 'pushed' && subjects()[2] === 'Second commit', `rewording a pushed commit is refused (${refused.reason})`);

  // ---------- Undo Commit ----------
  await run('Fourth commit', 'Undo Commit');
  await until(`document.querySelectorAll('.vcs-log-rows .vcs-log-row').length === 3`, 'three rows after undo', 20000);
  check(subjects().join('|') === 'Third: reworded|Second commit|Initial commit', 'Undo Commit removes the last commit');
  check(git(project, 'diff', '--cached', '--name-only') === 'fourth.py' && readFileSync(path.join(project, 'fourth.py'), 'utf8') === 'FOURTH = 4\n', 'its changes stay as local changes');
  await until(`ide.toolWindows.get('Commit').isVisible() && document.querySelector('.vcs-msg')?.value === 'Fourth commit'`, 'message in the commit box').catch(() => {});
  check(await js(`ide.toolWindows.get('Commit').isVisible() && document.querySelector('.vcs-msg').value`) === 'Fourth commit', 'its message goes back into the commit box');
  await js(`(document.querySelector('.vcs-msg').value = '', true)`);

  // ---------- Reset Current Branch to Here ----------
  await js(`ide.openFile(${q(path.join(project, 'app.py'))})`);
  await run('Second commit', 'Reset Current Branch to Here…');
  await until(`document.querySelector('.dialog-title')?.textContent === 'Git Reset'`, 'Git Reset dialog');
  check(await js(`[...document.querySelectorAll('.dialog .vcs-reset-mode')].map(r => r.querySelector('.vcs-reset-label').textContent + (r.querySelector('input').checked ? '*' : '')).join('|')`) === 'Soft|Mixed*|Hard|Keep',
    'the Git Reset dialog offers Soft, Mixed, Hard and Keep with Mixed chosen');
  await shot('reset-dialog.png');
  await mouse(`[...document.querySelectorAll('.dialog .vcs-reset-mode')].find(r => r.querySelector('input').value === 'soft')`, { label: 'Soft' });
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Reset' });
  await until(`document.querySelectorAll('.vcs-log-rows .vcs-log-row').length === 2`, 'two rows after the soft reset', 20000);
  check(git(project, 'log', '-1', '--format=%s') === 'Second commit' && git(project, 'diff', '--cached', '--name-only').split('\n').sort().join(',') === 'fourth.py,third.py',
    'Soft moves the branch and stages the differences');
  git(project, 'commit', '-m', 'Back again');
  await js(`(window.dispatchEvent(new Event('focus')), true)`);
  await until(`!!${logRow('Back again')}`, 'the log shows the commit made outside the IDE', 20000);
  await run('Initial commit', 'Reset Current Branch to Here…');
  await until(`document.querySelector('.dialog-title')?.textContent === 'Git Reset'`, 'Git Reset dialog again');
  await mouse(`[...document.querySelectorAll('.dialog .vcs-reset-mode')].find(r => r.querySelector('input').value === 'hard')`, { label: 'Hard' });
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Reset' });
  await until(`!!${logRow('Initial commit')}?.querySelector('.vcs-ref.head') && !${logRow('Back again')}`, 'main on Initial commit after the hard reset', 20000).catch(async (e) => { console.log('DIAG', JSON.stringify({ rows: subjects(), heads: await js(`[...document.querySelectorAll('.vcs-log-row')].map(r => r.querySelector('.vcs-subject-text')?.textContent + ':' + [...r.querySelectorAll('.vcs-ref')].map(x => x.className + '=' + x.textContent).join(','))`), git: git(project, 'log', '--format=%s'), status: git(project, 'status', '--porcelain'), notes: await js(`[...document.querySelectorAll('.notification, .toast')].map(n => n.textContent).slice(-5)`), dialogs: await js(`[...document.querySelectorAll('.dialog')].map(d => d.textContent.slice(0, 200))`) })); throw e; });
  check(git(project, 'status', '--porcelain') === '' && readFileSync(path.join(project, 'app.py'), 'utf8') === 'VERSION = 1\n', 'Hard puts the files back as they were in the commit');
  await until(`ide.findTab(${q(path.join(project, 'app.py'))})?.model.getValue() === 'VERSION = 1\\n'`, 'app.py tab reloaded').catch(() => {});
  check(await js(`ide.findTab(${q(path.join(project, 'app.py'))})?.model.getValue()`) === 'VERSION = 1\n', 'the open editor of app.py shows the file as reset');

  // ---------- New Branch and New Tag at a commit ----------
  git(project, 'reset', '--hard', 'origin/main');
  await js(`(window.dispatchEvent(new Event('focus')), true)`);
  await run('Initial commit', 'New Branch…');
  await until(`document.querySelector('.dialog-title')?.textContent === 'Create New Branch'`, 'Create New Branch dialog');
  await js(`(() => { document.querySelector('.dialog .vcs-new-branch-checkout input').click(); document.querySelector('.dialog .vcs-new-branch-name').value = 'old start'; return true; })()`);
  await mouse(`document.querySelector('.dialog .primary')`, { label: 'Create' });
  await until(`!!${logRow('Initial commit')}?.querySelector('.vcs-ref')`, 'branch label on Initial commit', 20000);
  check(git(project, 'rev-parse', 'old-start') === hashOf('Initial commit') && git(project, 'branch', '--show-current') === 'main', 'New Branch without checkout creates the branch at the commit and stays on main');
  await run('Second commit', 'New Branch…');
  await until(`document.querySelector('.dialog-title')?.textContent === 'Create New Branch'`, 'Create New Branch dialog again');
  await js(`(document.querySelector('.dialog .vcs-new-branch-name').value = 'from-second', true)`);
  await press('Enter');
  await until(`document.querySelector('.vcs-branch')?.textContent.includes('from-second')`, 'switched to from-second', 20000);
  check(git(project, 'branch', '--show-current') === 'from-second' && git(project, 'rev-parse', 'HEAD') === hashOf('Second commit'), 'New Branch with checkout switches to it');

  await run('Initial commit', 'New Tag…');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'tag name prompt');
  await type('v0.1');
  await press('Enter');
  await until(`[...(${logRow('Initial commit')}?.querySelectorAll('.vcs-ref.tag') || [])].some(n => n.textContent === 'v0.1')`, 'tag label', 20000);
  check(git(project, 'rev-parse', 'v0.1^{commit}') === hashOf('Initial commit'), 'New Tag tags the commit');
  await js(`document.querySelectorAll('.vcs-note').forEach(n => n.remove())`);
  await run('Initial commit', 'New Tag…');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'tag name prompt again');
  await type('bad..name');
  await press('Enter');
  await until(noteWith('Tag creation failed'), 'tag error');
  check(!git(project, 'tag').includes('bad'), 'an invalid tag name is refused with a notification');

  // ---------- Checkout Revision ----------
  await run('Initial commit', 'Checkout Revision');
  await until(`document.querySelector('.vcs-branch')?.textContent.includes(${q(hashOf('Initial commit').slice(0, 8))})`, 'detached HEAD in the branch widget', 20000);
  check(git(project, 'rev-parse', 'HEAD') === hashOf('Initial commit') && git(project, 'branch', '--show-current') === '', 'Checkout Revision detaches HEAD at the commit');
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
t.close();

// ---------- Korean ----------
const k = await launch({ fixture: 'vcs', port: 9433, name: 'vcs-log-actions-ko', lang: 'ko-KR' });
const kh = helpers(k);
try {
  buildRepo(k.project);
  await k.js(`(ide.emit('filesChanged'), true)`);
  await k.js(`(ide.toolWindows.get('Git').show(), true)`);
  await kh.until(`document.querySelectorAll('.vcs-log-rows .vcs-log-row').length === 4`, 'ko log rows', 20000);
  const items = await kh.menu('Fourth commit');
  k.check(items.join('|') === '리비전 번호 복사|체리픽|커밋 되돌리기|리비전 체크아웃|현재 브랜치를 여기로 재설정…|커밋 실행 취소|커밋 메시지 편집…|새 브랜치…|새 태그…', `the commit menu is Korean (${items.join('|')})`);
  let leaks = await englishLeaks(k, '#menuHost');
  await kh.mouse(kh.menuItem('현재 브랜치를 여기로 재설정…'), { label: 'reset' });
  await kh.until(`document.querySelector('.dialog-title')?.textContent === 'Git 재설정'`, 'ko reset dialog');
  leaks = [...leaks, ...await englishLeaks(k, '.dialog', ['Fourth commit'])];
  await k.shot('reset-dialog-ko.png');
  await k.press('Escape');
  await kh.run('Third: local work', '커밋 메시지 편집…');
  await kh.until(`document.querySelector('.dialog-title')?.textContent === '커밋 메시지 편집'`, 'ko reword dialog');
  await k.press('Escape');
  await kh.run('Initial commit', '새 브랜치…');
  await kh.until(`document.querySelector('.dialog-title')?.textContent === '새 브랜치 생성'`, 'ko new branch dialog');
  leaks = [...leaks, ...await englishLeaks(k, '.dialog')];
  await k.press('Escape');
  k.check(!leaks.length, `the Korean menu and dialogs have no English leaks${leaks.length ? ` ${q(leaks)}` : ''}`);
  k.check(k.consoleErrors.length === 0, 'no renderer exceptions (ko)');
} catch (err) {
  k.check(false, err.message);
  await k.shot('failure-ko.png').catch(() => {});
}
for (const r of k.results) t.results.push(r);
k.close();
const failed = t.results.filter((r) => !r.ok).length;
console.log(`${t.results.length - failed}/${t.results.length} passed`);
process.exit(failed ? 1 : 0);
