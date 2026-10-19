// Korean UI and Light theme of the Git integration: every vcs surface is exercised in a ko-KR session and checked for
// English leaks and missing translations; then the Commit window, a diff tab and the log are checked in Light.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

// Same git isolation as verify/vcs.mjs.
const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-i18n-vcs-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Every string the vcs plugin passes to tr().
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWN = new Set(Object.keys(JSON.parse(readFileSync(path.join(APP, 'renderer/features/vcs/locales/ko.json'), 'utf8'))));
const src = readFileSync(path.join(APP, 'renderer/features/vcs/index.js'), 'utf8');
for (const m of src.matchAll(/\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) OWN.add(m[2].replace(/\\'/g, "'"));
for (const m of src.matchAll(/\btrn\([^,]+,\s*'([^']*)',\s*'([^']*)'/g)) { OWN.add(m[1]); OWN.add(m[2]); }

const t = await launch({ fixture: 'vcs', port: 9444, name: 'i18n-vcs', lang: 'ko-KR' });
const { js, press, type, check, shot, cdp, sleep, project } = t;
const q = JSON.stringify;
// Forces a frame first: Chromium pauses painting for an occluded window (see verify/vcs.mjs).
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
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(150);
  for (let i = 1; i <= clickCount; i++) {
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount: i });
  }
  await sleep(80);
}
const fileRow = (name) => `[...document.querySelectorAll('.vcs-changes .vcs-file')].find(r => r.dataset.path.endsWith(${q('\\' + name)}))`;
const treeNode = (name) => `[...document.querySelectorAll('#tree .node')].find(n => n.querySelector('.name').textContent === ${q(name)})`;
const noteWith = (text) => `[...document.querySelectorAll('.vcs-note')].some(n => n.textContent.includes(${q(text)}))`;
const clearNotes = () => js(`document.querySelectorAll('.vcs-note').forEach(n => n.remove())`);
const diffTab = `document.querySelector('.custom-tab:not(.hidden)')`;

// Asserts that nothing under `selector` is English UI text. Branch names in core's popup are user data.
async function noLeaks(selector, label, allowed = []) {
  const leaks = await englishLeaks(t, selector, allowed);
  check(leaks.length === 0, `${label}: no English UI text${leaks.length ? ` (got ${JSON.stringify(leaks)})` : ''}`);
}
const SIDE = '#sideTitle, #sideActions, #sideBody .tool.active';
const BOTTOM = '#bottomActions, #bottomBody .tool.active';

try {
  // --- Commit window outside a repository ---
  await press('Alt+0');
  await until(`!!document.querySelector('.vcs-init-btn')?.offsetParent`, 'Create Git Repository offered');
  check(await js(`document.querySelector('.vcs-init-btn').textContent === 'Git 저장소 생성…' && document.querySelector('#sideTitle').textContent === '커밋'`), 'Commit window and Create Git Repository are Korean');
  await noLeaks(SIDE, 'Commit window (no repository)');
  check(await js(`ide.toolWindows.get('Commit').button.title`) === '커밋 (Alt+0)', 'Commit stripe button tooltip is Korean');

  // --- init: Unversioned Files group, notification ---
  await t.click('.vcs-init-btn');
  await until(`document.querySelectorAll('.vcs-changes .vcs-file').length >= 4`, 'unversioned files listed');
  check(await js(`[...document.querySelectorAll('.vcs-group-title')].map(g => g.textContent).join('|')`) === '변경 사항|버전 관리되지 않는 파일', 'groups are 변경 사항 / 버전 관리되지 않는 파일');
  check(await js(`document.querySelector('.vcs-msg').placeholder`) === '커밋 메시지', 'Commit Message placeholder is Korean');
  check(await js(`document.querySelector('.vcs-commit-btn').textContent === '커밋' && document.querySelector('.vcs-commit-push-btn').textContent === '커밋 및 푸시…'`), 'Commit / Commit and Push buttons are Korean');
  check(await js(noteWith('Git 저장소를 생성했습니다')), 'init notification is Korean');
  await noLeaks(`${SIDE}, .vcs-notes`, 'Commit window with unversioned files and init notification');
  check(await js(`document.querySelector('.vcs-branch').title`) === 'Git 브랜치', 'branch widget tooltip is Korean');
  await shot('commit-ko.png');

  // --- empty-commit and empty-message warnings ---
  await clearNotes();
  await t.click('.vcs-commit-btn');
  await until(noteWith('커밋할 변경 사항이 선택되지 않았습니다'), 'nothing selected warning');
  await noLeaks('.vcs-notes', 'no-selection warning');
  await mouse(`[...document.querySelectorAll('.vcs-group')].find(g => g.textContent.includes('버전 관리되지 않는')).querySelector('input')`, { label: 'unversioned group checkbox' });
  await clearNotes();
  await t.click('.vcs-commit-btn');
  await until(noteWith('커밋 메시지가 비어 있습니다'), 'empty message warning');
  await noLeaks('.vcs-notes', 'empty message warning');

  // --- commit ---
  await js(`document.querySelector('.vcs-msg').focus()`);
  await type('Initial commit');
  await clearNotes();
  await t.click('.vcs-commit-btn');
  await until(`document.querySelectorAll('.vcs-changes .vcs-file').length === 0`, 'clean after commit');
  check(git(project, 'log', '--format=%s') === 'Initial commit', 'commit from the Korean UI works');
  check(await js(noteWith('파일 4개 커밋됨: Initial commit')), 'commit notification is Korean and keeps the message as is');
  await noLeaks(`${SIDE}, .vcs-notes`, 'Commit window after commit');

  writeFileSync(path.join(project, 'util', 'helpers.py'), 'def double(x):\n    return x * 2\n\n\ndef triple(x):\n    return x * 3  # by Bob\n');
  git(project, '-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-qam', 'Bob tweaks triple');

  // --- gutter popup ---
  await openFile(t, 'main.py');
  await js(`ide.editor.setPosition({ lineNumber: 5, column: 29 }), ide.editor.focus()`);
  await type('  # changed');
  await until(`!!document.querySelector('#editor .vcs-modified')`, 'modified marker');
  await mouse(`document.querySelector('#editor .vcs-modified')`, { label: 'gutter marker' });
  await until(`!!document.querySelector('#menuHost .context-menu')`, 'gutter popup');
  check(await js(`[...document.querySelectorAll('#menuHost .menu-item > span:first-child')].map(s => s.textContent).join('|')`) === '줄 롤백|차이 표시|다음 변경 사항|이전 변경 사항', 'gutter popup: 줄 롤백, 차이 표시, 다음/이전 변경 사항');
  await noLeaks('#menuHost', 'gutter change popup', ['Down', 'Up']); // key chords stay in English
  await shot('gutter-popup-ko.png');

  // Show Diff from the gutter popup
  await mouse(`[...document.querySelectorAll('#menuHost .menu-item')].find(m => m.textContent.includes('차이 표시'))`, { label: 'Show Diff item' });
  await until(`ide.activeTab()?.kind === 'custom' && ${diffTab}?._vcsDiff?.getLineChanges()?.length >= 1`, 'diff tab');
  check(await js(`ide.activeTab().title`) === '차이: main.py', 'diff tab title is 차이: main.py');
  check(/^HEAD \([0-9a-f]{8}\) — 읽기 전용\|사용자 버전$/.test(await js(`[...${diffTab}.querySelectorAll('.vcs-diff-side')].map(s => s.textContent).join('|')`)), 'diff headers are Korean');
  await noLeaks('#customHost .custom-tab:not(.hidden) .vcs-diff-head', 'diff tab headers');
  check(await js(`${diffTab}.querySelectorAll('.vcs-diff-mod').length >= 2`), 'modified block is marked on both diff sides');
  await shot('diff-ko.png');
  await press('Ctrl+F4');

  // --- annotate ---
  await openFile(t, 'util/helpers.py');
  check(await js(`ide.editor.getAction('vcs.annotate').label`) === 'Git Blame으로 어노테이트', 'Annotate action is "Git Blame으로 어노테이트"');
  await js(`ide.editor.getAction('vcs.annotate').run()`);
  await until(`document.querySelectorAll('#editor .vcs-blame').length >= 6`, 'blame annotations');
  check(await js(`ide.editor.getAction('vcs.closeAnnotations').label`) === '어노테이션 닫기', 'Close Annotations is Korean');
  await js(`ide.editor.getAction('vcs.closeAnnotations').run()`);

  // --- rollback confirmation ---
  await openFile(t, 'main.py');
  await press('Ctrl+S');
  await until(`!!${fileRow('main.py')}`, 'main.py changed');
  if (!(await js(`ide.toolWindows.get('Commit').isVisible()`))) await press('Alt+0');
  check(await js(`${fileRow('main.py')}.title.endsWith('수정됨')`), 'changed file tooltip shows the Korean status');
  await mouse(fileRow('main.py'), { label: 'main.py row' });
  await press('Ctrl+Alt+Z');
  await until(`!!document.querySelector('.dialog')?.textContent.includes('main.py')`, 'rollback dialog');
  check(await js(`document.querySelector('.dialog-title').textContent`) === '변경 사항 롤백', 'rollback dialog title is 변경 사항 롤백');
  await noLeaks('#dialogHost', 'rollback confirmation');
  await shot('rollback-ko.png');
  await press('Escape');

  // --- Git log ---
  await js(`ide.editor.focus()`);
  await press('Alt+9');
  await until(`ide.toolWindows.get('Git').isVisible() && document.querySelectorAll('.vcs-log-rows .vcs-log-row').length === 2`, 'log rows');
  check(await js(`[...document.querySelectorAll('.vcs-log-header span')].map(s => s.textContent).join('|')`) === '커밋|작성자|날짜', 'log columns are 커밋 | 작성자 | 날짜');
  check(await js(`[...document.querySelectorAll('.vcs-subtab')].map(s => s.textContent).join('|')`) === '로그|콘솔', 'log sub-tabs are 로그 | 콘솔');
  check(await js(`document.querySelector('.vcs-log-rows .vcs-c-date').textContent.startsWith('오늘 ')`), 'commit dates read 오늘 …');
  await until(`document.querySelectorAll('.vcs-log-files .vcs-log-file').length >= 1`, 'commit files');
  check(await js(`document.querySelector('.vcs-side-title').textContent`) === '파일 1개 변경됨', 'changed-files title is Korean');
  await noLeaks(BOTTOM, 'Git log window');
  await shot('log-ko.png');
  await mouse(`[...document.querySelectorAll('.vcs-log-file')].find(r => r.dataset.rel === 'util/helpers.py')`, { clickCount: 2, label: 'log helpers.py' });
  await until(`ide.activeTab()?.title.startsWith('helpers.py (') && !!${diffTab}?._vcsDiff`, 'commit diff');
  check(await js(`${diffTab}.querySelector('.vcs-diff-side').textContent.endsWith('^ (부모)')`), 'commit diff header says (부모)');
  await noLeaks('#customHost .custom-tab:not(.hidden) .vcs-diff-head', 'commit diff headers');
  await press('Ctrl+F4');

  // --- branch popup and New Branch prompt ---
  await t.click('.vcs-branch');
  await until(`document.querySelector('.popup-item.active')?.textContent.includes('새 브랜치')`, 'branch popup');
  check(await js(`document.querySelector('#popupIn').placeholder`) === 'Git 브랜치 — main', 'branch popup title is Korean');
  check(await js(`[...document.querySelectorAll('.popup-item')].some(i => i.textContent.includes('main') && i.textContent.includes('현재'))`), 'current branch is marked 현재');
  await noLeaks('#popup', 'branch popup', ['main']);
  await shot('branches-ko.png');
  await press('Enter');
  await until(`document.querySelector('#popupIn').placeholder === '새 브랜치 이름'`, 'new branch prompt');
  await noLeaks('#popup', 'New Branch prompt');
  await type('feature-x');
  await press('Enter');
  await until(`document.querySelector('.vcs-branch-name').textContent === 'feature-x'`, 'on feature-x');
  check(git(project, 'branch', '--show-current') === 'feature-x', 'New Branch from the Korean prompt creates the branch');
  await t.click('.vcs-branch');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'branch popup');
  check(await js(`[...document.querySelectorAll('.popup-item .hint-right')].map(h => h.textContent).sort().join('|')`) === '로컬|현재', 'branch hints are 현재 / 로컬');
  await noLeaks('#popup', 'branch popup with two branches', ['main', 'feature']);
  await type('main');
  await until(`document.querySelector('.popup-item.active .label')?.textContent === 'main'`, 'main item');
  await clearNotes();
  await press('Enter');
  await until(noteWith('main 체크아웃됨'), 'checkout notification');
  await noLeaks('.vcs-notes', 'checkout notification');
  git(project, 'checkout', '-q', '--', 'main.py');
  await js(`ide.reloadFromDisk()`);

  // --- Update Project / Push without a remote ---
  await clearNotes();
  await press('Ctrl+T');
  await until(noteWith('업데이트할 수 없음'), 'no remote note');
  await noLeaks('.vcs-notes', 'Update Project without a remote');
  const bare = path.join(gitHome, 'remote.git');
  git(gitHome, 'init', '-q', '--bare', bare);
  await clearNotes();
  await press('Ctrl+Shift+K');
  await until(`!!document.querySelector('.dialog .vcs-remote-url')`, 'push dialog');
  check(await js(`document.querySelector('.dialog .primary').textContent`) === '푸시', 'push button is 푸시');
  await noLeaks('#dialogHost', 'Push dialog defining a remote');
  await shot('push-ko.png');
  await js(`document.querySelector('.vcs-remote-url').focus()`);
  await type(bare);
  await t.click('.dialog .primary');
  await until(noteWith('origin/main에 푸시했습니다'), 'push note');
  check(await js(noteWith('커밋 2개를 origin/main에 푸시했습니다')), 'push notification is Korean');
  await noLeaks('.vcs-notes', 'push notification');
  await clearNotes();
  await press('Ctrl+T');
  await until(noteWith('모든 파일이 최신 상태입니다'), 'up-to-date note');
  await noLeaks('.vcs-notes', 'Update Project up to date');

  // --- Commit and Push opens the push dialog for the tracked branch ---
  writeFileSync(path.join(project, 'README.md'), '# VCS fixture\n\nEdited.\n');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await until(`!!${fileRow('README.md')}`, 'README changed');
  await press('Ctrl+K');
  await until(`document.activeElement?.classList.contains('vcs-msg')`, 'message focus');
  await type('Edit readme');
  await t.click('.vcs-commit-push-btn');
  await until(`!!document.querySelector('.dialog .vcs-push-target')`, 'push dialog after commit');
  await noLeaks('#dialogHost', 'Push dialog with a tracked branch');
  await press('Escape');

  // --- Find Action lists the Git actions in Korean ---
  await js(`ide.editor.focus()`);
  await press('Ctrl+Shift+A');
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'find action');
  await type('Git');
  await until(`[...document.querySelectorAll('.popup-item .label')].some(l => l.textContent === 'Git 로그 표시')`, 'Git actions');
  await noLeaks('#popup', 'Find Action results for Git');
  await press('Escape');

  const missing = (await missingTranslations(t)).filter((s) => OWN.has(s));
  check(missing.length === 0, `every vcs tr() string has a Korean entry${missing.length ? ` (missing ${JSON.stringify(missing)})` : ''}`);

  // --- Light theme ---
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  writeFileSync(path.join(project, 'extra.py'), 'print("extra")\n');
  await openFile(t, 'main.py');
  await js(`ide.editor.setPosition({ lineNumber: 5, column: 29 }), ide.editor.focus()`);
  await type('  # changed');
  // also an inserted and a deleted block, so the Light diff shows all three colors
  await js(`ide.editor.setPosition({ lineNumber: 14, column: 1 })`);
  await press('Ctrl+Y');
  await js(`ide.editor.setPosition({ lineNumber: 9, column: 17 })`);
  await type('\n# added line');
  await press('Ctrl+S');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await until(`!!${fileRow('main.py')} && !!${fileRow('extra.py')}`, 'changes listed');
  if (!(await js(`ide.toolWindows.get('Commit').isVisible()`))) await press('Alt+0');
  const color = (expr) => js(`getComputedStyle(${expr}).color`);
  check(await color(`${fileRow('main.py')}.querySelector('.vcs-name')`) === 'rgb(0, 50, 160)', 'Light: modified file is #0032a0');
  check(await color(`${fileRow('extra.py')}.querySelector('.vcs-name')`) === 'rgb(140, 46, 27)', 'Light: unversioned file is #8c2e1b');
  check(await color(`${treeNode('main.py')}.querySelector('.name')`) === 'rgb(0, 50, 160)', 'Light: project tree uses the Light status colors');
  await mouse(fileRow('main.py'), { label: 'main.py row' });
  check(await js(`getComputedStyle(${fileRow('main.py')}).backgroundColor`) === 'rgb(212, 226, 255)', 'Light: focused selection is light blue');
  check(await js(`getComputedStyle(document.querySelector('#editor .vcs-modified')).backgroundColor`) !== 'rgb(55, 95, 173)', 'Light: gutter uses Light change colors');
  await shot('commit-light.png');

  await mouse(fileRow('main.py'), { clickCount: 2, label: 'main.py diff' });
  await until(`ide.activeTab()?.kind === 'custom' && ${diffTab}?._vcsDiff?.getLineChanges()?.length >= 1 && ${diffTab}.querySelectorAll('.vcs-diff-mod').length >= 2`, 'light diff');
  check(await js(`getComputedStyle(${diffTab}.querySelector('.monaco-editor-background')).backgroundColor`) === 'rgb(255, 255, 255)', 'Light: diff editor uses the Light editor theme');
  check(await js(`getComputedStyle(${diffTab}.querySelector('.vcs-diff-mod')).backgroundColor`) === 'rgb(232, 239, 250)', 'Light: modified diff lines are #e8effa');
  check(await js(`getComputedStyle(${diffTab}.querySelector('.monaco-editor')).getPropertyValue('--vscode-diffEditor-insertedLineBackground').trim()`) === '#e9f5e6', 'Light: inserted diff lines are #e9f5e6');
  await shot('diff-light.png');
  await press('Ctrl+F4');

  await js(`ide.editor.focus()`);
  if (!(await js(`ide.toolWindows.get('Git').isVisible()`))) await press('Alt+9');
  await until(`ide.toolWindows.get('Git').isVisible() && document.querySelectorAll('.vcs-log-rows .vcs-log-row').length >= 3`, 'light log');
  check(await js(`getComputedStyle(document.querySelector('.vcs-ref.head')).backgroundColor`) === 'rgb(220, 239, 220)', 'Light: HEAD branch label uses a light background');
  await shot('log-light.png');
} catch (err) {
  check(false, err.message);
  await shot('failure.png');
}
t.finish();
