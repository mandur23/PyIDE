// Updates from source: Help > Check for Updates… with no feed, a local folder feed with a newer version, the same
// version, and a feed that cannot be read; the Settings > Updates page; a skipped version; the status bar text of a
// differential download (states set through PYIDE_UPDATE_TEST's updater:testPhase); the Stable and Beta channels
// (port 9070) and the version order and What's New sections of betas (pure Node); and the Korean strings.
// The differential download itself is verify/update-delta.mjs.
// The real download and restart of an installed build is verify/update-e2e.mjs.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const channelFile = (version) => {
  const sha = 'A'.repeat(86) + '==';
  return `version: ${version}\nfiles:\n  - url: NanoStudio-Setup-${version}.exe\n    sha512: ${sha}\n    size: 1\npath: NanoStudio-Setup-${version}.exe\nsha512: ${sha}\nreleaseDate: '2026-10-20T00:00:00.000Z'\n`;
};
// latest.yml naming `version`, and beta.yml naming `beta` when given.
function feedFolder(version, beta = null) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-feed-')), 'feed');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'latest.yml'), channelFile(version));
  if (beta) writeFileSync(path.join(dir, 'beta.yml'), channelFile(beta));
  return dir;
}

const S = JSON.stringify;

// ---------- versions and What's New sections of betas (pure Node) ----------
const pure = [];
const pureCheck = (ok, label) => { pure.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
{
  const U = createRequire(import.meta.url)('../main/features/updater.js');
  const order = ['0.2.5', '0.2.5-beta.10', '0.2.4', '0.2.5-beta.2', '0.2.6', '0.2.5-beta.1', '0.10.0'].sort(U.compareVersions);
  pureCheck(S(order) === S(['0.2.4', '0.2.5-beta.1', '0.2.5-beta.2', '0.2.5-beta.10', '0.2.5', '0.2.6', '0.10.0']), `versions order as semver: ${order.join(' < ')}`);
  const file = path.join(tempDir('changelog-beta'), 'CHANGELOG.md');
  writeFileSync(file, '# 변경 내역\n\n## 0.2.6\n\n- six\n\n## 0.2.5\n\n- five\n\n## 0.2.5-beta.2\n\n- beta two\n\n## 0.2.5-beta.1\n\n- beta one\n\n## 0.2.4\n\n- four\n');
  const all = U.readChangelog(file);
  const releases = all.filter((s) => !s.version.includes('-'));
  const vs = (list) => list.map((s) => s.version).join(' ');
  pureCheck(vs(all) === '0.2.6 0.2.5 0.2.5-beta.2 0.2.5-beta.1 0.2.4', `"## 0.2.5-beta.1" headings are sections (${vs(all)})`);
  pureCheck(vs(U.sectionsUpTo(all, '0.2.5-beta.1')) === '0.2.5 0.2.5-beta.1 0.2.4', "Help > What's New in 0.2.5-beta.1: the release it previews (## 0.2.5), betas up to it, older releases");
  pureCheck(vs(U.sectionsUpTo(all, '0.2.5')) === '0.2.5 0.2.4', "Help > What's New in 0.2.5 leaves the beta sections out");
  pureCheck(vs(U.notesAfterUpdate(releases, '0.2.5-beta.1', '0.2.4')) === '0.2.5', 'after 0.2.4 -> 0.2.5-beta.1 with only "## 0.2.5" written: the 0.2.5 notes');
  pureCheck(vs(U.notesAfterUpdate(all, '0.2.5-beta.1', '0.2.4')) === '0.2.5 0.2.5-beta.1', 'after 0.2.4 -> 0.2.5-beta.1: ## 0.2.5 and ## 0.2.5-beta.1');
  pureCheck(vs(U.notesAfterUpdate(all, '0.2.5-beta.2', '0.2.5-beta.1')) === '0.2.5 0.2.5-beta.2', 'after beta.1 -> beta.2: ## 0.2.5 again and ## 0.2.5-beta.2');
  pureCheck(vs(U.notesAfterUpdate(all, '0.2.5', '0.2.5-beta.2')) === '0.2.5', 'after beta.2 -> 0.2.5 (promoted): the final 0.2.5 notes');
  pureCheck(vs(U.notesAfterUpdate(all, '0.2.5', '0.2.4')) === '0.2.5', 'after 0.2.4 -> 0.2.5 on Stable: no beta sections');
  pureCheck(vs(U.notesAfterUpdate(all, '0.2.5-beta.1', null)) === '0.2.5 0.2.5-beta.1', 'after an update to a beta from a version that recorded none: this beta and its release');
  pureCheck(!U.notesAfterUpdate(all, '0.2.4', '0.2.5-beta.1').length && !U.notesAfterUpdate(all, '0.2.5-beta.1', '0.2.5-beta.1').length, 'an older or the same version than the one that ran: nothing');
}
const dialogText = (t) => t.js(`[...document.querySelectorAll('.dialog')].pop()?.textContent || ''`);
const dialogButtons = (t) => t.js(`[...[...document.querySelectorAll('.dialog')].pop()?.querySelectorAll('.dialog-buttons button') || []].map(b => b.textContent)`);
const pressButton = (t, label) => t.js(`([...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${S(label)}).click(), true)`);
const waitDialog = (t, what) => t.until(`!!document.querySelector('.dialog')`, what);
// Settings > Updates > Check Now: the result appears under the button and no dialog opens over Settings.
async function checkNowInline(t, text, label) {
  const dialogs = await t.js(`document.querySelectorAll('.dialog').length`);
  await t.js(`(document.getElementById('updatesCheckNow').scrollIntoView({ block: 'center' }), true)`);
  await t.click('#updatesCheckNow');
  await t.until(`document.getElementById('updatesCheckResult')?.textContent.includes(${S(text)})`, label);
  await t.sleep(300);
  t.check(await t.js(`document.querySelectorAll('.dialog').length === ${dialogs} && !!document.querySelector('.settings-dialog')`), label);
}

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
    await checkNowInline(t, 'Updates are off: no update feed is set.', 'with no feed, Check Now on the page says updates are off on the page, with no dialog over Settings');

    // ---------- a newer version in a local folder feed, set through the page ----------
    const newer = feedFolder('9.9.9');
    await js(`(() => { const i = document.querySelector('[data-key="updates.feedUrl"]'); i.value = ${S(newer)}; i.dispatchEvent(new Event('input')); return true; })()`);
    await checkNowInline(t, `Nano Studio 9.9.9 is available. You have ${current}.`, 'Check Now on the page shows a newer version on the page');
    await js(`(() => { const i = document.querySelector('[data-key="updates.feedUrl"]'); i.value = ${S(path.join(tmpdir(), 'pyide-no-such-feed'))}; i.dispatchEvent(new Event('input')); return true; })()`);
    await checkNowInline(t, 'Could not check for updates.', 'Check Now on the page shows a failed check on the page');
    check(await js(`document.getElementById('updatesCheckResult').classList.contains('err')`), 'a failed check is drawn as an error');
    await js(`(() => { const i = document.querySelector('[data-key="updates.feedUrl"]'); i.value = ${S(newer)}; i.dispatchEvent(new Event('input')); return true; })()`);
    await js(`(document.getElementById('settingsOk').click(), true)`);
    check(await js(`ide.settings.get('updates.feedUrl')`) === newer, 'the feed setting is saved with OK');
    await js(`(ide.runAction('CheckForUpdates'), true)`);
    await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('9.9.9')`, 'update dialog');
    check((await dialogText(t)).includes(`Nano Studio 9.9.9 is available. You have ${current}.`), 'a local folder feed reports the newer version');
    check((await dialogText(t)).includes('installed with the Nano Studio installer'), 'a source run explains that it does not update itself');
    await pressButton(t, 'Close');

    // ---------- the same version ----------
    await js(`(ide.settings.set('updates.feedUrl', ${S(feedFolder(current))}), true)`);
    await js(`(ide.runAction('CheckForUpdates'), true)`);
    await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('latest version')`, 'latest dialog');
    check((await dialogText(t)).includes(`Nano Studio ${current} is the latest version.`), 'the same version reports "latest version"');
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
    check(await statusText() === 'Downloading Nano Studio 9.9.9 (delta 4.5 MB)… 42%', `a differential download shows its size: ${await statusText()}`);
    await js(`ide.api.invoke('updater:testPhase', { download: { mode: 'full', size: 102933452, bytes: 102933452, reason: 'fallback' }, percent: 3 })`);
    await until(`document.getElementById('updateStatus').textContent === 'Downloading Nano Studio 9.9.9… 3%'`, 'full download status text');
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

// ---------- update channels ----------
{
  const t = await launch({ fixture: 'core', port: 9070, name: 'updater-channel' });
  const { js, until, check } = t;
  // What a manual check reports: the offered version, 'latest', or the dialog text.
  const offered = async (what) => {
    await js(`(ide.runAction('CheckForUpdates'), true)`);
    await until(`/is available|latest version|Could not/.test([...document.querySelectorAll('.dialog')].pop()?.textContent || '')`, what);
    const text = await dialogText(t);
    await pressButton(t, 'Close');
    await until(`!document.querySelector('.dialog')`, `${what}: dialog closed`);
    return /Nano Studio (\S+) is available/.exec(text)?.[1] || (text.includes('is the latest version') ? 'latest' : text);
  };
  const setFeed = (dir) => js(`(ide.settings.set('updates.feedUrl', ${S(dir)}), true)`);
  try {
    await js(`(ide.settings.set('updates.checkOnStartup', false), ide.openSettings('updates'), true)`);
    await until(`!!document.querySelector('.settings-dialog [data-key="updates.channel"]')`, 'channel setting');
    check(await js(`document.querySelector('[data-key="updates.channel"]').value`) === 'stable', 'Settings > Updates: the channel is Stable by default');
    check(await js(`[...document.querySelector('[data-key="updates.channel"]').options].map((o) => o.textContent).join()`) === 'Stable,Beta', 'the channel choices are Stable and Beta');
    check((await js(`document.querySelector('[data-key="updates.channel"]').closest('.field').textContent`)).includes('Switching back to Stable does not reinstall an older version'), 'the page says switching back to Stable does not downgrade');
    await t.shot('updater-channel-en.png');
    await js(`(document.getElementById('settingsCancel').click(), true)`);

    const both = feedFolder('5.0.0', '9.9.9-beta.1');
    await setFeed(both);
    check(await offered('Stable check') === '5.0.0', 'a Stable install sees 5.0.0 from latest.yml, not 9.9.9-beta.1 from beta.yml');
    await js(`(ide.settings.set('updates.channel', 'beta'), true)`);
    check(await offered('Beta check') === '9.9.9-beta.1', 'a Beta install sees 9.9.9-beta.1 from beta.yml');
    await setFeed(feedFolder('5.0.0', '5.0.0'));
    check(await offered('Beta, stable release') === '5.0.0', 'a Beta install sees a newer stable release (beta.yml names 5.0.0, as a stable release writes it)');
    await setFeed(feedFolder('5.0.0'));
    check(await offered('Beta, no beta.yml') === '5.0.0', 'a Beta install reads latest.yml when the feed has no beta.yml');
    await setFeed(feedFolder('0.0.1', '0.0.1-beta.1'));
    check(await offered('Beta, older beta') === 'latest', 'Beta: an older version in beta.yml is not offered (no downgrade)');
    await js(`(ide.settings.set('updates.channel', 'stable'), true)`);
    check(await offered('back to Stable') === 'latest', 'back on Stable after Beta: an older latest.yml is not offered (no downgrade)');

    await setFeed(both);
    await js(`(ide.openSettings('updates'), true)`);
    await until(`!!document.querySelector('.settings-dialog [data-key="updates.channel"]')`, 'channel setting again');
    await js(`(() => { const s = document.querySelector('[data-key="updates.channel"]'); s.value = 'beta'; s.dispatchEvent(new Event('change')); document.getElementById('updatesCheckNow').click(); return true; })()`);
    await until(`document.getElementById('updatesCheckResult')?.textContent.includes('9.9.9-beta.1')`, 'Check Now on Beta');
    check(true, 'Check Now uses the channel chosen on the page before OK');
    await js(`(document.getElementById('settingsOk').click(), true)`);
    check(await js(`ide.settings.get('updates.channel')`) === 'beta', 'the channel setting is saved with OK');
  } catch (err) {
    check(false, err.message);
  }
  t.close();
  var resultsChannel = t.results;
  var errorsChannel = t.consoleErrors;
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
    t.check(n.title.includes(`What's New in Nano Studio ${version}`), `after an update the first window shows What's New in Nano Studio ${version} (${n.title})`);
    t.check(S(n.versions) === S([`Nano Studio ${version}`, 'Nano Studio 0.0.2']), `it lists the versions since the one that ran before, newest first, not the future one (${S(n.versions)})`);
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
    again.check(S(n.versions) === S([`Nano Studio ${version}`, 'Nano Studio 0.0.2', 'Nano Studio 0.0.1']), `Help > What's New lists every version up to this one (${S(n.versions)})`);
  } catch (err) { again.check(false, err.message); }
  again.close();
  const old = await launch({ fixture: 'core', port: 9805, name: 'updater-whatsnew-3', userData: userDataWith({ lastCheck: Date.now() }), env: { PYIDE_CHANGELOG: changelog } });
  try {
    await old.until(`!!document.querySelector('.upd-notes')`, "What's New after an update from 0.2.4");
    old.check(S((await notesShown(old)).versions) === S([`Nano Studio ${version}`]), 'after an update from a version that recorded none (0.2.4 and older), only this version');
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
  k.check((await dialogText(k)).includes('Nano Studio 9.9.9을(를) 사용할 수 있습니다.'), 'the update dialog is in Korean');
  const dialogLeaks = await englishLeaks(k, '.dialog');
  k.check(!dialogLeaks.length, `no English in the Korean update dialog${dialogLeaks.length ? `: ${S(dialogLeaks)}` : ''}`);
  await pressButton(k, '닫기');
  await k.js(`ide.api.invoke('updater:testPhase', { phase: 'downloading', available: '9.9.9', percent: 42, download: { mode: 'delta', size: 102933452, bytes: 4729305, reason: null } })`);
  await k.until(`document.getElementById('updateStatus').textContent.includes('9.9.9')`, 'Korean delta status');
  k.check(await k.js(`document.getElementById('updateStatus').textContent`) === 'Nano Studio 9.9.9 다운로드 중 (변경분 4.5 MB)… 42%', 'the delta status text is in Korean');
  await k.js(`ide.api.invoke('updater:testPhase', { phase: 'idle', available: null, percent: 0, download: null })`);
  await k.js(`(ide.openSettings('updates'), true)`);
  await k.until(`!!document.querySelector('.settings-dialog [data-key="updates.feedUrl"]')`, 'Korean settings page');
  await k.js(`(() => { const i = document.querySelector('[data-key="updates.feedUrl"]'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`);
  await checkNowInline(k, '업데이트 피드가 설정되지 않아 업데이트를 사용하지 않습니다.', 'Korean: Check Now with no feed answers on the page in Korean, with no dialog');
  await k.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await k.until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await k.js(`(document.getElementById('updatesCheckResult').scrollIntoView({ block: 'center' }), true)`);
  k.check(await k.js(`(() => { const p = document.querySelector('.settings-page'); const r = document.getElementById('updatesCheckResult').getBoundingClientRect(); const b = p.getBoundingClientRect();
    return r.width > 100 && r.left >= b.left && r.right <= b.right + 0.5 && p.scrollWidth <= p.clientWidth; })()`), 'at 1008x681 the Check Now result fits the page');
  await k.shot('updater-check-now-ko-small.png');
  await k.cdp('Emulation.clearDeviceMetricsOverride');
  const pageLeaks = await englishLeaks(k, '.settings-page');
  k.check(!pageLeaks.length, `no English on the Korean Updates page${pageLeaks.length ? `: ${S(pageLeaks)}` : ''}`);
  const channelRow = await k.js(`(() => { const s = document.querySelector('[data-key="updates.channel"]'); return { options: [...s.options].map((o) => o.textContent), text: s.closest('.field').textContent }; })()`);
  k.check(S(channelRow.options) === S(['안정 릴리스', '베타 릴리스']) && channelRow.text.includes('업데이트 채널:') && channelRow.text.includes('이전 버전을 다시 설치하지 않으며'), `the channel row is in Korean (${S(channelRow)})`);
  await k.shot('updater-channel-ko.png');
  await k.js(`(ide.runAction('WhatsNew'), true)`);
  await k.until(`!!document.querySelector('.upd-notes')`, 'Korean What\x27s New');
  k.check((await notesShown(k)).title === `Nano Studio ${version}의 새로운 기능`, `Help > What\x27s New is titled in Korean (${(await notesShown(k)).title})`);
  await k.shot('whatsnew-ko.png');
  await pressButton(k, '닫기');
  const missing = (await missingTranslations(k)).filter((s) => /What\x27s New|release notes|update|Nano Studio \{version\}|feed|Skip This|Restart to|installer|Installed with|This Installation|Check Now|channel|^Stable$|^Beta/i.test(s));
  k.check(!missing.length, `every updater string has a Korean entry${missing.length ? `: ${S(missing)}` : ''}`);
  await k.shot('updater-ko.png');
} catch (err) {
  k.check(false, err.message);
}
k.results.unshift(...pure, ...resultsEn, ...resultsChannel, ...resultsNew);
k.consoleErrors.unshift(...errorsEn, ...errorsChannel, ...errorsNew);
k.finish();
