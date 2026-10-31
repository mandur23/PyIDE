// Periodic update checks and Report on GitHub, from source and offline (ports 9360-9362).
// Updates: PYIDE_UPDATE_INTERVAL_MS shortens the day, and a local folder feed stands in for GitHub Releases. The
// periodic check fires again and again without a second dialog, pauses while an update downloads (PYIDE_UPDATE_TEST
// sets the phase) and in Power Save mode, backs off after failures and recovers; a check that ran recently (kept in
// <userData>/updater.json) is not repeated at startup; with checks turned off nothing runs.
// Reports: the preview holds the version, install kind, OS, runtime and the error with its stack and the log tail,
// with the home folder as ~, the project as <project> and no token; it stays under GitHub's link limit (log first,
// then stack); Open in Browser hands main's https link to a stubbed shell.openExternal (PYIDE_DIAGNOSTICS_TEST).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir, userInfo } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const ISSUE_BASE = 'https://github.com/mandur23/PyIDE/issues/new?title=';
const TOKEN = 'ghp_FAKEtoken0123456789abcdefABCDEF12';
const HOME = homedir();
const USER = userInfo().username;

function feedFolder(version) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-report-update-feed-')), 'feed');
  mkdirSync(dir);
  const sha = 'A'.repeat(86) + '==';
  writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: NanoStudio-Setup-${version}.exe\n    sha512: ${sha}\n    size: 1\npath: NanoStudio-Setup-${version}.exe\nsha512: ${sha}\nreleaseDate: '2026-10-20T00:00:00.000Z'\n`);
  return dir;
}
// A user-data folder with these settings and, optionally, an earlier check history (main/features/updater.js).
function userData(settings, history) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-report-update-')), 'userdata');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), S(settings));
  if (history) writeFileSync(path.join(dir, 'updater.json'), S(history));
  return dir;
}

const status = (t) => t.js(`ide.updater.status()`);
const mainState = (t) => t.js(`ide.api.invoke('updater:state')`);
const updateDialogs = (t, version) => t.js(`[...document.querySelectorAll('.dialog')].filter(d => d.textContent.includes(${S(`Nano Studio ${version}`)})).length`);
const closeDialogs = (t) => t.js(`([...document.querySelectorAll('.dialog')].reverse().forEach(d => [...d.querySelectorAll('.dialog-buttons button')].pop().click()), true)`);
// Waits until the scheduler has decided `count` more times, the last time for `reason`.
async function untilDecisions(t, count, reason, label) {
  const start = (await status(t)).decisions;
  await t.until(`(s => s.decisions >= ${start + count} && s.reason === ${S(reason)})(ide.updater.status())`, label, 30000);
}
// The first decision, 3 s after startup.
const untilStartupDecision = (t, reason) => t.until(`(s => s.decisions >= 1 && s.reason === ${S(reason)})(ide.updater.status())`, `startup decision "${reason}"`, 30000);
const NEW_STRINGS = ['Check for updates', 'On startup only', 'Daily', 'Weekly', 'Last checked:', 'Report on GitHub…', 'Report on GitHub',
  'Report a Problem…', 'Open in Browser', 'Title:', 'Could not prepare the report: {reason}',
  'This text opens in your browser as a new GitHub issue. Nothing is sent until you submit it there. Passwords, tokens, your user folder and project names were removed; check it before you submit.',
  'Part of the log or stack trace was left out so that the report fits in a link.'];
const lower = (s) => s.toLowerCase().replace(/\//g, '\\');
// A test error whose message and stack name the home folder, the project and a token.
const reportError = (t, message, extraFrames = '') => t.js(`(() => {
  const err = new Error(${S(message)});
  err.stack = 'Error: ' + err.message + '\\n    at loadModel (' + ${S(HOME)} + '\\\\.pyide\\\\semantic\\\\server.js:10:5)'
    + '\\n    at run (file:///' + ide.root.replace(/\\\\/g, '/') + '/main.py:1:1)' + ${S(extraFrames)} + '\\n    at last (renderer/core/ide.js:1:1)';
  ideDiagnostics.report(err);
  return true;
})()`);
const untilErrorId = async (t, text) => {
  await t.until(`ide.api.invoke('diagnostics:errors').then(l => l.some(e => e.message.includes(${S(text)})))`, `error "${text}" listed`);
  return t.js(`ide.api.invoke('diagnostics:errors').then(l => l.find(e => e.message.includes(${S(text)})).id)`);
};
const previewText = (t) => t.js(`(() => { const d = document.querySelector('.diag-report-dialog'); return d ? (d.querySelector('.diag-report-title')?.textContent || '') + '\\n\\n' + d.querySelector('.diag-report-body').textContent : null; })()`);

// ---------------------------------------------------------------- English: periodic checks and reports
{
  const newer = feedFolder('9.9.9');
  const dir = userData({ 'updates.feedUrl': newer });
  const PERIOD = 2400;
  const t = await launch({ fixture: 'core', port: 9360, name: 'report-update', userData: dir,
    env: { PYIDE_UPDATE_INTERVAL_MS: String(PERIOD), PYIDE_UPDATE_TEST: '1', PYIDE_DIAGNOSTICS_TEST: '1' } });
  const { js, until, check } = t;
  try {
    const current = (await js(`ide.api.invoke('app:info')`)).version;
    await until(`ide.updater.status().period === ${PERIOD}`, 'interval from PYIDE_UPDATE_INTERVAL_MS');
    check(true, 'PYIDE_UPDATE_INTERVAL_MS sets the daily interval');

    // ---------- the startup check, then periodic ones ----------
    await until(`ide.updater.status().history.length >= 1`, 'startup check', 20000);
    await until(`[...document.querySelectorAll('.dialog')].some(d => d.textContent.includes('Nano Studio 9.9.9 is available'))`, 'update dialog');
    check((await mainState(t)).available === '9.9.9', 'the startup check finds 9.9.9 in the folder feed');
    await until(`ide.updater.status().history.length >= 3`, 'two periodic checks', 30000);
    const h = (await status(t)).history;
    const gaps = h.slice(1).map((x, i) => x.at - h[i].at);
    check(h.every((x) => x.ok) && gaps.every((g) => g >= PERIOD - 50), `the check repeats every interval (gaps ${S(gaps)} ms)`);
    check(await updateDialogs(t, '9.9.9') === 1, 'periodic checks do not open a second dialog for the same version');
    const saved = JSON.parse(readFileSync(path.join(dir, 'updater.json'), 'utf8'));
    check(saved.lastCheck >= h[h.length - 1].at && saved.failures === 0, 'the last check time is kept in updater.json');
    await closeDialogs(t);

    // ---------- no check while an update downloads ----------
    await until(`ide.api.invoke('updater:state').then(s => s.phase !== 'checking')`, 'check finished');
    await js(`ide.api.invoke('updater:testPhase', 'downloading')`);
    let before = (await status(t)).history.length;
    await untilDecisions(t, 2, 'downloading', 'decisions while downloading');
    check((await status(t)).history.length === before, 'no check while an update is downloading');
    await js(`ide.api.invoke('updater:testPhase', 'idle')`);
    await until(`ide.updater.status().history.length > ${before}`, 'checks resume after the download', 30000);
    check(true, 'checks resume once the download is over');

    // ---------- no check in Power Save mode ----------
    await closeDialogs(t);
    await js(`(ide.powerSave.set(true), true)`);
    before = (await status(t)).history.length;
    await untilDecisions(t, 2, 'powerSave', 'decisions in Power Save mode');
    check((await status(t)).history.length === before, 'no check in Power Save mode');
    await js(`(ide.powerSave.set(false), true)`);
    await until(`ide.updater.status().history.length > ${before}`, 'checks resume after Power Save', 30000);
    check(true, 'checks resume when Power Save mode ends');
    await closeDialogs(t);

    // ---------- failures back off, then a good check resets them ----------
    const failStart = (await status(t)).history.length;
    await js(`(ide.settings.set('updates.feedUrl', ${S(path.join(tmpdir(), 'pyide-report-update-no-feed'))}), true)`);
    await until(`ide.api.invoke('updater:state').then(s => s.failures >= 4)`, 'four failed checks', 30000);
    const fails = (await status(t)).history.slice(failStart).filter((x) => !x.ok);
    const expected = fails.slice(1).map((_, i) => Math.min(PERIOD, (PERIOD / 24) * 2 ** i));
    const failGaps = fails.slice(1).map((x, i) => x.at - fails[i].at);
    check(fails.length >= 4 && failGaps.every((g, i) => g >= expected[i] - 30),
      `after failures the retries back off (gaps ${S(failGaps)} ms, at least ${S(expected)})`);
    const failedState = await mainState(t);
    check(/No latest\.yml/.test(failedState.lastError || '') && JSON.parse(readFileSync(path.join(dir, 'updater.json'), 'utf8')).failures === failedState.failures,
      'the failure count and error are kept in updater.json');
    check(!(await js(`[...document.querySelectorAll('.dialog')].some(d => d.textContent.includes('Could not check'))`)), 'automatic checks fail quietly');
    await js(`(ide.settings.set('updates.feedUrl', ${S(newer)}), true)`);
    await until(`ide.api.invoke('updater:state').then(s => s.failures === 0 && s.available === '9.9.9')`, 'a good check after failures', 30000);
    check(true, 'a check that reads the feed resets the failures');
    await js(`(ide.settings.set('updates.checkOnStartup', false), true)`);
    await untilDecisions(t, 1, 'off', 'checks turned off');
    await closeDialogs(t);

    // ---------- Settings > Updates ----------
    await js(`(ide.openSettings('updates'), true)`);
    await until(`!!document.querySelector('.settings-dialog [data-key="updates.checkInterval"]')`, 'interval select');
    check(await js(`(s => s.value === 'daily' && [...s.options].map(o => o.value).join() === 'startup,daily,weekly')(document.querySelector('[data-key="updates.checkInterval"]'))`),
      'Settings > Updates offers On startup only / Daily / Weekly, Daily by default');
    check(await js(`!!document.querySelector('.settings-dialog .upd-last-check')`), 'Settings > Updates shows when the last check ran');
    await js(`(() => { const s = document.querySelector('[data-key="updates.checkInterval"]'); s.value = 'weekly'; s.dispatchEvent(new Event('change')); document.getElementById('settingsOk').click(); return true; })()`);
    check((await status(t)).period === PERIOD * 7, 'Weekly checks every seven intervals');

    // ---------- Report on GitHub from the internal errors ----------
    for (let i = 0; i < 35; i++) await js(`(ide.log.info(${S(`LOGFILL-${i} `)} + 'x'.repeat(400)), true)`);
    await until(`ide.api.invoke('diagnostics:logFile').then(f => ide.api.read(f)).then(t => t.includes('LOGFILL-34'))`, 'long log lines written');
    const message = `Model not found: ${HOME}\\.pyide\\models\\gemma (token ${TOKEN})`;
    await reportError(t, message);
    const id = await untilErrorId(t, 'Model not found');
    await js(`(ide.diagnostics.openErrors(), true)`);
    await until(`!!document.querySelector('.diag-dialog .diag-report')`, 'Report on GitHub… in the error details');
    check(await js(`document.querySelector('.diag-report').textContent === 'Report on GitHub…'`), 'the selected error offers Report on GitHub…');
    await js(`(document.querySelector('.diag-report').click(), true)`);
    await until(`!!document.querySelector('.diag-report-dialog .diag-report-body')`, 'report preview');
    const preview = await previewText(t);
    const root = await js(`ide.root`);
    check(preview.includes(`Nano Studio ${current} (run from source)`), 'the preview names the version and the install kind');
    check(/- Windows .*\d+\.\d+\.\d+ x64/.test(preview), 'the preview names the Windows version');
    check(/Electron \d+\.\d+\.\d+, Chromium \d+\./.test(preview) && preview.includes('Non-default plugins enabled: 0'), 'the preview has the Electron and Chromium versions and the plugin count');
    check(preview.includes('Model not found: ~\\.pyide\\models\\gemma') && preview.includes('at loadModel (~\\.pyide\\semantic\\server.js'), 'the error and its stack show the home folder as ~');
    check(!lower(preview).includes(lower(HOME)) && !new RegExp(`users[\\\\/]+${USER}\\b`, 'i').test(preview), 'no path in the preview names the user');
    check(!preview.includes(TOKEN) && !preview.includes('ghp_'), 'the fake token is not in the preview');
    check(preview.includes('file:///<project>/main.py') && !lower(preview).includes(lower(root)), 'the project folder shows as <project>');
    check(preview.includes('at last (renderer/core/ide.js') && preview.includes('oldest lines were left out to fit in a link'), 'the log is shortened before the stack');
    const logPart = preview.split('### Last 30 lines of the IDE log')[1] || '';
    check(logPart.includes('LOGFILL-34') && logPart.split('\n').filter((l) => /^\d{4}-\d\d-\d\d /.test(l)).length <= 30, 'the log part keeps the newest lines, at most 30');
    check(await js(`[...document.querySelectorAll('.diag-report-dialog .dialog-buttons button')].map(b => b.textContent).join('|')`) === 'Open in Browser|Copy|Cancel',
      'the preview offers Open in Browser, Copy and Cancel');
    check((await js(`ide.api.invoke('diagnostics:testOpened')`)).length === 0, 'nothing is opened before the user asks');
    await t.shot('report-preview.png');
    await js(`([...document.querySelectorAll('.diag-report-dialog .dialog-buttons button')][0].click(), true)`);
    await until(`ide.api.invoke('diagnostics:testOpened').then(l => l.length === 1)`, 'openExternal');
    const [url] = await js(`ide.api.invoke('diagnostics:testOpened')`);
    const params = new URL(url).searchParams;
    check(url.startsWith(ISSUE_BASE) && url.length <= 8000, `openExternal gets the https new-issue link of package.json's repository (${url.length} characters)`);
    check(`${params.get('title')}\n\n${params.get('body')}` === preview, 'the link carries exactly the previewed text');
    check(!(await js(`!!document.querySelector('.diag-report-dialog')`)), 'the preview closes after opening the browser');
    await closeDialogs(t);
    const draft = await js(`ide.api.invoke('diagnostics:reportDraft', { errorId: ${id}, plugins: [{ id: 'x', enabled: true, bundled: false }, { id: 'y', enabled: false, bundled: false }] })`);
    check(draft.body.includes('Non-default plugins enabled: 1'), 'enabled plugins that are not bundled are counted');

    // ---------- a stack too long for a link ----------
    const frames = Array.from({ length: 300 }, (_, i) => `\n    at frame${i} (${HOME}\\work\\deep\\module${i}.js:${i}:1)`).join('');
    await reportError(t, 'Huge stack overflowed', frames);
    const hugeId = await untilErrorId(t, 'Huge stack overflowed');
    const huge = await js(`ide.diagnostics.reportProblem(${hugeId})`);
    check(huge.truncated && huge.url.length <= 8000, `a huge report is cut to fit the link limit (${huge.url.length} characters)`);
    check(huge.body.includes('The log was left out to fit in a link') && /The stack trace was shortened \(\d+ more lines\)/.test(huge.body)
      && huge.body.includes('Error: Huge stack overflowed') && huge.body.includes('at frame0 (~\\work'), 'the log goes first, then the end of the stack, with a note; the top of the stack stays');
    check(await js(`!!document.querySelector('.diag-report-dialog .diag-report-truncated')`), 'the preview says that part was left out');
    await closeDialogs(t);

    // ---------- Help > Report a Problem… ----------
    await js(`(document.getElementById('mainMenuBtn').click(), true)`);
    await js(`([...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.textContent.startsWith('Help')).dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })), true)`);
    await until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.startsWith('Report a Problem…'))`, 'Help menu item');
    check(true, 'Help lists Report a Problem…');
    await t.press('Escape');
    await t.press('Escape');
    await js(`(ide.runAction('ReportProblem'), true)`);
    await until(`!!document.querySelector('.diag-report-dialog .diag-report-body')`, 'general report preview');
    const general = await previewText(t);
    check(general.includes('Describe the problem') && !general.includes('### Error') && general.includes(`Nano Studio ${current}`), 'Report a Problem… has the environment and the log, without an error');
    await closeDialogs(t);

    // ---------- also removed: e-mail addresses, URL users, other user folders, project and repository names ----------
    await js(`(ide.settings.set('recentProjects', [...ide.settings.get('recentProjects', []), { path: 'D:\\\\work\\\\acme-billing', opened: 1 }]), ide.settings.flush(), true)`);
    const LEAKY = [
      "git push: fatal: unable to access 'https://jsmith:hunter2pass@github.com/jsmith/moonshot-api.git/': 403",
      'cloned moonshot-api for acme-billing; author jane.doe@example.com',
      'opened /home/alice/x.py, C:\\Users\\Jane Doe\\x.py and \\\\wsl$\\Ubuntu\\home\\bob\\y.py',
      'kept: react@18.3.1 at last (renderer/core/ide.js:1:1) Electron 38.1.2',
    ];
    for (const line of LEAKY) await js(`(ide.log.info(${S(line)}), true)`);
    await until(`ide.api.invoke('diagnostics:logFile').then(f => ide.api.read(f)).then(t => t.includes('kept: react@18.3.1'))`, 'leaky log lines written');
    const leaky = (await js(`ide.api.invoke('diagnostics:reportDraft', {})`)).body;
    const scrubbed = [
      "fatal: unable to access 'https://<user>@github.com/jsmith/<project>.git/': 403",
      'cloned <project> for <project>; author <email>',
      'opened /home/<user>/x.py, C:\\Users\\<user>\\x.py and \\\\wsl$\\Ubuntu\\home\\<user>\\y.py',
      'kept: react@18.3.1 at last (renderer/core/ide.js:1:1) Electron 38.1.2',
    ];
    const missed = scrubbed.filter((x) => !leaky.includes(x));
    check(!missed.length && !/hunter2pass|moonshot-api|acme-billing|jane\.doe|alice|Jane Doe|\bbob\b/.test(leaky),
      `the report hides e-mail addresses, URL users, other user folders (with spaces, WSL), project and git repository names, and keeps versions and stack frames (missing: ${S(missed)})`);
  } catch (err) {
    check(false, err.message);
  }
  t.close();
  var results = [...t.results];
  var errors = [...t.consoleErrors];
}

// ---------------------------------------------------------------- a recent check is not repeated at startup
{
  const lastCheck = Date.now() - 60000;
  const dir = userData({ 'updates.feedUrl': feedFolder('9.9.9') }, { lastCheck, lastAttempt: lastCheck, failures: 0 });
  const t = await launch({ fixture: 'core', port: 9361, name: 'report-update-recent', userData: dir, env: { PYIDE_UPDATE_INTERVAL_MS: String(600000) } });
  try {
    await untilStartupDecision(t, 'recent');
    const s = await status(t);
    t.check(s.history.length === 0 && (await mainState(t)).checks === 0, 'a check 1 minute ago (interval 10 minutes) is not repeated at startup');
    t.check(s.due === lastCheck + 600000, 'the next check is due one interval after the last one');
  } catch (err) {
    t.check(false, err.message);
  }
  t.close();
  results.push(...t.results);
  errors.push(...t.consoleErrors);
}

// ---------------------------------------------------------------- Korean, with checks turned off
const k = await launch({ fixture: 'core', port: 9362, name: 'report-update-ko', lang: 'ko-KR',
  userData: userData({ 'updates.feedUrl': feedFolder('9.9.9'), 'updates.checkOnStartup': false }),
  env: { PYIDE_UPDATE_INTERVAL_MS: '1500', PYIDE_DIAGNOSTICS_TEST: '1' } });
try {
  await untilStartupDecision(k, 'off');
  const offAt = (await status(k)).at;
  await k.until(`Date.now() > ${offAt + 3 * 1500}`, 'three intervals');
  k.check((await mainState(k)).checks === 0 && !(await k.js(`!!document.querySelector('.dialog')`)), 'with checks turned off nothing is checked');
  await k.js(`(ide.settings.set('updates.checkOnStartup', true), true)`);
  await k.until(`[...document.querySelectorAll('.dialog')].some(d => d.textContent.includes('9.9.9'))`, 'Korean update dialog', 20000);
  k.check(await k.js(`[...document.querySelectorAll('.dialog')].some(d => d.textContent.includes('Nano Studio 9.9.9을(를) 사용할 수 있습니다.'))`), 'turning checks on checks, and the dialog is in Korean');
  await k.js(`(ide.settings.set('updates.checkOnStartup', false), true)`);
  await closeDialogs(k);

  await k.js(`(ide.openSettings('updates'), true)`);
  await k.until(`!!document.querySelector('.settings-dialog [data-key="updates.checkInterval"]')`, 'Korean settings page');
  k.check(await k.js(`[...document.querySelector('[data-key="updates.checkInterval"]').options].map(o => o.textContent).join('|')`) === '시작할 때만|매일|매주', 'the interval choices are in Korean');
  const pageLeaks = await englishLeaks(k, '.settings-page');
  k.check(!pageLeaks.length, `no English on the Korean Updates page${pageLeaks.length ? `: ${S(pageLeaks)}` : ''}`);
  await k.shot('report-update-settings-ko.png');
  await k.js(`(document.getElementById('settingsOk').click(), true)`);

  await reportError(k, `Model not found: ${HOME}\\.pyide\\models`);
  await untilErrorId(k, 'Model not found');
  await k.js(`(ide.diagnostics.openErrors(), true)`);
  await k.until(`!!document.querySelector('.diag-dialog .diag-report')`, 'Korean error details');
  k.check(await k.js(`document.querySelector('.diag-report').textContent`) === 'GitHub에 보고…', 'Report on GitHub… is in Korean');
  await k.js(`(document.querySelector('.diag-report').click(), true)`);
  await k.until(`!!document.querySelector('.diag-report-dialog .diag-report-body')`, 'Korean report preview');
  k.check(await k.js(`[...document.querySelectorAll('.diag-report-dialog .dialog-buttons button')].map(b => b.textContent).join('|')`) === '브라우저에서 열기|복사|취소', 'the preview buttons are in Korean');
  k.check((await previewText(k)).includes('### Environment'), 'the report itself stays in English for the maintainers');
  const leaks = await englishLeaks(k, '.diag-report-dialog');
  k.check(!leaks.length, `no English in the Korean report dialog${leaks.length ? `: ${S(leaks)}` : ''}`);
  await k.shot('report-preview-ko.png');
  await closeDialogs(k);
  await k.js(`(ide.runAction('ReportProblem'), true)`);
  await k.until(`!!document.querySelector('.diag-report-dialog .diag-report-body')`, 'Korean general report');
  await closeDialogs(k);
  const missing = (await missingTranslations(k)).filter((s) => NEW_STRINGS.includes(s));
  const locale = (id) => JSON.parse(readFileSync(new URL(`../renderer/features/${id}/locales/ko.json`, import.meta.url), 'utf8'));
  const ko = { ...locale('updater'), ...locale('diagnostics') };
  missing.push(...NEW_STRINGS.filter((s) => !ko[s] && !missing.includes(s)));
  k.check(!missing.length, `every new string has a Korean entry${missing.length ? `: ${S(missing)}` : ''}`);
} catch (err) {
  k.check(false, err.message);
}
k.results.unshift(...results);
k.consoleErrors.unshift(...errors);
k.finish();
