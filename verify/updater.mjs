// Updates from source: Help > Check for Updates… with no feed, a local folder feed with a newer version, the same
// version, and a feed that cannot be read; the Settings > Updates page; a skipped version; and the Korean strings.
// The real download and restart of an installed build is verify/update-e2e.mjs.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
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
  const t = await launch({ fixture: 'core', port: 9800, name: 'updater' });
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

// ---------- Korean ----------
const k = await launch({ fixture: 'core', port: 9801, name: 'updater-ko', lang: 'ko-KR' });
try {
  await k.js(`(ide.settings.set('updates.feedUrl', ${S(feedFolder('9.9.9'))}), true)`);
  await k.js(`(ide.runAction('CheckForUpdates'), true)`);
  await k.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('9.9.9')`, 'Korean update dialog');
  k.check((await dialogText(k)).includes('PyIDE 9.9.9을(를) 사용할 수 있습니다.'), 'the update dialog is in Korean');
  const dialogLeaks = await englishLeaks(k, '.dialog');
  k.check(!dialogLeaks.length, `no English in the Korean update dialog${dialogLeaks.length ? `: ${S(dialogLeaks)}` : ''}`);
  await pressButton(k, '닫기');
  await k.js(`(ide.openSettings('updates'), true)`);
  await k.until(`!!document.querySelector('.settings-dialog [data-key="updates.feedUrl"]')`, 'Korean settings page');
  const pageLeaks = await englishLeaks(k, '.settings-page');
  k.check(!pageLeaks.length, `no English on the Korean Updates page${pageLeaks.length ? `: ${S(pageLeaks)}` : ''}`);
  const missing = (await missingTranslations(k)).filter((s) => /update|PyIDE \{version\}|feed|Skip This|Restart to|installer|Installed with|This Installation|Check Now/i.test(s));
  k.check(!missing.length, `every updater string has a Korean entry${missing.length ? `: ${S(missing)}` : ''}`);
  await k.shot('updater-ko.png');
} catch (err) {
  k.check(false, err.message);
}
k.results.unshift(...resultsEn);
k.consoleErrors.unshift(...errorsEn);
k.finish();
