// Updates from source: Help > Check for Updates… with no feed, a local folder feed with a newer version, the same
// version, and a feed that cannot be read; the Settings > Updates page; a skipped version; the status bar text of a
// differential download (states set through PYIDE_UPDATE_TEST's updater:testPhase); and the Korean strings.
// The differential download itself is verify/update-delta.mjs.
// The real download and restart of an installed build is verify/update-e2e.mjs.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

function feedFolder(version) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-feed-')), 'feed');
  mkdirSync(dir);
  const sha = 'A'.repeat(86) + '==';
  writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: PyIDE-Setup-${version}.exe\n    sha512: ${sha}\n    size: 1\npath: PyIDE-Setup-${version}.exe\nsha512: ${sha}\nreleaseDate: '2026-10-20T00:00:00.000Z'\n`);
  return dir;
}

const S = JSON.stringify;
const dialogText = (t) => t.js(`[...document.querySelectorAll('.dialog')].pop()?.textContent || ''`);
const dialogButtons = (t) => t.js(`[...[...document.querySelectorAll('.dialog')].pop()?.querySelectorAll('.dialog-buttons button') || []].map(b => b.textContent)`);
const pressButton = (t, label) => t.js(`([...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${S(label)}).click(), true)`);
const waitDialog = (t, what) => t.until(`!!document.querySelector('.dialog')`, what);

{
  const t = await launch({ fixture: 'core', port: 9800, name: 'updater', env: { PYIDE_UPDATE_TEST: '1' } });
  const { js, until, check } = t;
  try {
    const current = (await js(`ide.api.invoke('app:info')`)).version;
    check(await js(`ide.actions.some(a => a.id === 'CheckForUpdates')`), 'Check for Updates… is an action');
    await js(`(document.getElementById('mainMenuBtn').click(), true)`);
    await js(`([...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.textContent.startsWith('Help')).dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })), true)`);
    await until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.startsWith('Check for Updates…'))`, 'Help menu item');
    check(true, 'Help lists Check for Updates…');
    await t.press('Escape');
    await t.press('Escape');

    // ---------- no feed ----------
    await js(`(ide.runAction('CheckForUpdates'), true)`);
    await waitDialog(t, 'no-feed dialog');
    check((await dialogText(t)).includes('Updates are off') && (await dialogButtons(t)).includes('Open Settings'), 'with no feed, the check says updates are off and offers Settings');
    await pressButton(t, 'Open Settings');
    await until(`!!document.querySelector('.settings-dialog [data-key="updates.feedUrl"]')`, 'Updates settings page');
    check(await js(`document.querySelector('[data-key="updates.checkOnStartup"]').checked`), 'Settings > Updates: check on startup is on by default');
    check(await js(`document.querySelector('.settings-dialog').textContent.includes('Run from source (no updates)')`), 'Settings > Updates names the installation kind');
    check(await js(`document.querySelector('[data-key="updates.differential"]')?.checked === true`), 'Settings > Updates: differential downloads are on by default');

    // ---------- a newer version in a local folder feed, set through the page ----------
    const newer = feedFolder('9.9.9');
    await js(`(() => { const i = document.querySelector('[data-key="updates.feedUrl"]'); i.value = ${S(newer)}; i.dispatchEvent(new Event('input')); return true; })()`);
    await js(`(document.getElementById('settingsOk').click(), true)`);
    check(await js(`ide.settings.get('updates.feedUrl')`) === newer, 'the feed setting is saved with OK');
    await js(`(ide.runAction('CheckForUpdates'), true)`);
    await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('9.9.9')`, 'update dialog');
    check((await dialogText(t)).includes(`PyIDE 9.9.9 is available. You have ${current}.`), 'a local folder feed reports the newer version');
    check((await dialogText(t)).includes('installed with the PyIDE installer'), 'a source run explains that it does not update itself');
    await pressButton(t, 'Close');

    // ---------- the same version ----------
    await js(`(ide.settings.set('updates.feedUrl', ${S(feedFolder(current))}), true)`);
    await js(`(ide.runAction('CheckForUpdates'), true)`);
    await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('latest version')`, 'latest dialog');
    check((await dialogText(t)).includes(`PyIDE ${current} is the latest version.`), 'the same version reports "latest version"');
    await pressButton(t, 'Close');

    // ---------- an unreadable feed ----------
    await js(`(ide.settings.set('updates.feedUrl', ${S(path.join(tmpdir(), 'pyide-no-such-feed'))}), true)`);
    await js(`(ide.runAction('CheckForUpdates'), true)`);
    await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('Could not check')`, 'error dialog');
    check((await dialogText(t)).includes('No latest.yml in'), 'a folder without latest.yml is reported');
    await pressButton(t, 'Close');

    // ---------- status bar during a download: delta size when the download is differential ----------
    const statusText = () => js(`document.getElementById('updateStatus').textContent`);
    await js(`ide.api.invoke('updater:testPhase', { phase: 'downloading', available: '9.9.9', percent: 42, download: { mode: 'delta', size: 102933452, bytes: 4729305, reason: null } })`);
    await until(`document.getElementById('updateStatus').textContent.includes('delta')`, 'delta status text');
    check(await statusText() === 'Downloading PyIDE 9.9.9 (delta 4.5 MB)… 42%', `a differential download shows its size: ${await statusText()}`);
    await js(`ide.api.invoke('updater:testPhase', { download: { mode: 'full', size: 102933452, bytes: 102933452, reason: 'fallback' }, percent: 3 })`);
    await until(`document.getElementById('updateStatus').textContent === 'Downloading PyIDE 9.9.9… 3%'`, 'full download status text');
    check(true, 'after a fallback to the full installer the status bar shows the plain text');
    await js(`ide.api.invoke('updater:testPhase', { phase: 'idle', available: null, percent: 0, download: null })`);
    await until(`document.getElementById('updateStatus').classList.contains('hidden')`, 'status hidden');

    // ---------- a skipped version shows in Settings and can be cleared ----------
    await js(`(ide.settings.set('updates.skippedVersion', '9.9.9'), ide.openSettings('updates'), true)`);
    await until(`document.querySelector('.settings-dialog')?.textContent.includes('Skipped version:')`, 'skipped row');
    await js(`([...document.querySelectorAll('.upd-skipped button')][0].click(), document.getElementById('settingsOk').click(), true)`);
    check(!(await js(`ide.settings.get('updates.skippedVersion')`)), 'Clear removes the skipped version');
    await t.shot('updater-en.png');
  } catch (err) {
    check(false, err.message);
  }
  t.close();
  var resultsEn = t.results;
  var errorsEn = t.consoleErrors;
}

// ---------- what's new ----------
// A CHANGELOG with this version, two older ones and a future one; user data whose updater.json says which version ran.
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const changelog = path.join(tempDir('changelog'), 'CHANGELOG.md');
writeFileSync(changelog, `# 변경 내역\r\n\r\n안내 문장\r\n\r\n## 99.0.0\r\n\r\n- 미래 항목\r\n\r\n## ${version}\r\n\r\n- 새 항목 \`code\` 강조\r\n- 둘째 항목\r\n\r\n## 0.0.2\r\n\r\n- 이전 항목\r\n\r\n## 0.0.1\r\n\r\n- 오래된 항목\r\n`);
const userDataWith = (history) => {
  const dir = tempDir('whatsnew-userdata');
  if (history) writeFileSync(path.join(dir, 'updater.json'), JSON.stringify(history));
  return dir;
};
const notesShown = (t) => t.js(`(() => { const n = [...document.querySelectorAll('.dialog')].find((d) => d.querySelector('.upd-notes'));
  return n && { title: n.querySelector('.dialog-title').textContent, versions: [...n.querySelectorAll('.upd-notes h3')].map((h) => h.textContent),
    items: [...n.querySelectorAll('.upd-notes li')].map((li) => li.textContent), code: [...n.querySelectorAll('.upd-notes li code')].map((c) => c.textContent) }; })()`);
const settle = (t) => t.until(`!!ide.updater`, 'updater plugin').then(() => t.sleep(1500));
{
  const userData = userDataWith({ lastCheck: Date.now(), seenVersion: '0.0.1' });
  const t = await launch({ fixture: 'core', port: 9805, name: 'updater-whatsnew', userData, env: { PYIDE_CHANGELOG: changelog } });
  try {
    await t.until(`!!document.querySelector('.upd-notes')`, "What's New after an update");
    const n = await notesShown(t);
    t.check(n.title.includes(`What's New in PyIDE ${version}`), `after an update the first window shows What's New in PyIDE ${version} (${n.title})`);
    t.check(S(n.versions) === S([`PyIDE ${version}`, 'PyIDE 0.0.2']), `it lists the versions since the one that ran before, newest first, not the future one (${S(n.versions)})`);
    t.check(S(n.items) === S(['새 항목 code 강조', '둘째 항목', '이전 항목']) && S(n.code) === S(['code']), `bullets become list items with code spans (${S(n.items)})`);
    const saved = JSON.parse(readFileSync(path.join(userData, 'updater.json'), 'utf8'));
    t.check(saved.seenVersion === version && saved.lastCheck, `updater.json now records ${version} and keeps the last check (${S(saved)})`);
    await t.shot('whatsnew-en.png');
    await pressButton(t, 'Close');
  } catch (err) { t.check(false, err.message); }
  t.close();
  const again = await launch({ fixture: 'core', port: 9805, name: 'updater-whatsnew-2', userData, env: { PYIDE_CHANGELOG: changelog } });
  try {
    await settle(again);
    again.check(!(await notesShown(again)), 'the next start of the same version shows nothing');
    await again.js(`(ide.runAction('WhatsNew'), true)`);
    await again.until(`!!document.querySelector('.upd-notes')`, 'Help > What\'s New');
    const n = await notesShown(again);
    again.check(S(n.versions) === S([`PyIDE ${version}`, 'PyIDE 0.0.2', 'PyIDE 0.0.1']), `Help > What's New lists every version up to this one (${S(n.versions)})`);
  } catch (err) { again.check(false, err.message); }
  again.close();
  const old = await launch({ fixture: 'core', port: 9805, name: 'updater-whatsnew-3', userData: userDataWith({ lastCheck: Date.now() }), env: { PYIDE_CHANGELOG: changelog } });
  try {
    await old.until(`!!document.querySelector('.upd-notes')`, "What's New after an update from 0.2.4");
    old.check(S((await notesShown(old)).versions) === S([`PyIDE ${version}`]), 'after an update from a version that recorded none (0.2.4 and older), only this version');
  } catch (err) { old.check(false, err.message); }
  old.close();
  const fresh = await launch({ fixture: 'core', port: 9805, name: 'updater-whatsnew-4', env: { PYIDE_CHANGELOG: changelog } });
  try {
    await settle(fresh);
    fresh.check(!(await notesShown(fresh)), 'a fresh install shows nothing');
  } catch (err) { fresh.check(false, err.message); }
  fresh.close();
  var resultsNew = [t, again, old, fresh].flatMap((x) => x.results);
  var errorsNew = [t, again, old, fresh].flatMap((x) => x.consoleErrors);
}

// ---------- Korean ----------
const k = await launch({ fixture: 'core', port: 9801, name: 'updater-ko', lang: 'ko-KR', env: { PYIDE_UPDATE_TEST: '1' } });
try {
  await k.js(`(ide.settings.set('updates.feedUrl', ${S(feedFolder('9.9.9'))}), true)`);
  await k.js(`(ide.runAction('CheckForUpdates'), true)`);
  await k.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('9.9.9')`, 'Korean update dialog');
  k.check((await dialogText(k)).includes('PyIDE 9.9.9을(를) 사용할 수 있습니다.'), 'the update dialog is in Korean');
  const dialogLeaks = await englishLeaks(k, '.dialog');
  k.check(!dialogLeaks.length, `no English in the Korean update dialog${dialogLeaks.length ? `: ${S(dialogLeaks)}` : ''}`);
  await pressButton(k, '닫기');
  await k.js(`ide.api.invoke('updater:testPhase', { phase: 'downloading', available: '9.9.9', percent: 42, download: { mode: 'delta', size: 102933452, bytes: 4729305, reason: null } })`);
  await k.until(`document.getElementById('updateStatus').textContent.includes('9.9.9')`, 'Korean delta status');
  k.check(await k.js(`document.getElementById('updateStatus').textContent`) === 'PyIDE 9.9.9 다운로드 중 (변경분 4.5 MB)… 42%', 'the delta status text is in Korean');
  await k.js(`ide.api.invoke('updater:testPhase', { phase: 'idle', available: null, percent: 0, download: null })`);
  await k.js(`(ide.openSettings('updates'), true)`);
  await k.until(`!!document.querySelector('.settings-dialog [data-key="updates.feedUrl"]')`, 'Korean settings page');
  const pageLeaks = await englishLeaks(k, '.settings-page');
  k.check(!pageLeaks.length, `no English on the Korean Updates page${pageLeaks.length ? `: ${S(pageLeaks)}` : ''}`);
  await k.js(`(ide.runAction('WhatsNew'), true)`);
  await k.until(`!!document.querySelector('.upd-notes')`, 'Korean What\x27s New');
  k.check((await notesShown(k)).title === `PyIDE ${version}의 새로운 기능`, `Help > What\x27s New is titled in Korean (${(await notesShown(k)).title})`);
  await k.shot('whatsnew-ko.png');
  await pressButton(k, '닫기');
  const missing = (await missingTranslations(k)).filter((s) => /What\x27s New|release notes|update|PyIDE \{version\}|feed|Skip This|Restart to|installer|Installed with|This Installation|Check Now/i.test(s));
  k.check(!missing.length, `every updater string has a Korean entry${missing.length ? `: ${S(missing)}` : ''}`);
  await k.shot('updater-ko.png');
} catch (err) {
  k.check(false, err.message);
}
k.results.unshift(...resultsEn, ...resultsNew);
k.consoleErrors.unshift(...errorsEn, ...errorsNew);
k.finish();
