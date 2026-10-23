// IDE log, internal errors and diagnostic data. Injects failures (a plugin that fails to activate and whose main module
// fails to register, a plugin that throws on demand in the renderer and the main process, a core main-process
// exception through the PYIDE_DIAGNOSTICS_TEST hook, a crashing Python sidecar, a killed Pyright, an error in a
// detached window) and checks that no raw Electron dialog appears, the status icon and the error list show them with
// the right plugin, the log has them, the diagnostic zip has the expected files and no secrets, and the Korean UI.
// Ports 9750 (English) and 9751 (Korean).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// diag-broken calls ide.noSuchApi.register() while activating.
const ACTIVATION = "(reading 'register')";

const SECRETS = {
  password: 'hunter2-Pa55word-diag',
  apiKey: 'sk-ant-api03-DIAGSECRETKEY0123456789abcdef',
  token: 'ghp_DIAGtoken0123456789abcdefABCDEF',
  blob: 'djEwDIAGsafeStorageBlob0123456789ABCDEFabcdef==',
};

// A user-data folder with both test plugins installed, secrets in the settings and a safeStorage-style data source.
function prepareUserData(lang) {
  const dir = mkdtempSync(path.join(tmpdir(), `pyide-diagnostics-${lang}-`));
  const userData = path.join(dir, 'userdata');
  for (const id of ['diag-broken', 'diag-flaky']) {
    cpSync(path.join(APP, 'verify', 'fixtures', 'diagnostics-plugins', id), path.join(userData, 'plugins', id), { recursive: true });
  }
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    'appearance.language': lang === 'ko' ? 'ko' : 'en',
    'editor.fontSize': 14,
    'database.password': SECRETS.password,
    'ai.apiKey': SECRETS.apiKey,
    'vcs.github': { user: 'octo', token: SECRETS.token },
    'proxy.url': `http://octo:${SECRETS.password}@proxy.local:8080`,
    'notes.blob': SECRETS.blob,
  }, null, 2));
  mkdirSync(path.join(userData, 'database'), { recursive: true });
  writeFileSync(path.join(userData, 'database', 'sources.json'), JSON.stringify([{ id: 'pg', password: SECRETS.blob }]));
  return { dir, userData };
}

const errors = (t) => t.js(`ide.api.invoke('diagnostics:errors')`);
const findError = (t, text) => t.js(`ide.api.invoke('diagnostics:errors').then(l => l.find(e => (e.message + e.stack).includes(${JSON.stringify(text)})) || null)`);
const untilError = (t, text, label, ms = 15000) => t.until(`ide.api.invoke('diagnostics:errors').then(l => l.some(e => (e.message + e.stack).includes(${JSON.stringify(text)})))`, label, ms);
// Expected renderer exceptions are this test's own; anything else still fails the run.
const dropExpected = (t) => t.consoleErrors.splice(0, t.consoleErrors.length, ...t.consoleErrors.filter((e) => !/diag/.test(e)));

// ---------------------------------------------------------------- English
{
  const { dir, userData } = prepareUserData('en');
  const zipPath = path.join(dir, 'out', 'diagnostics.zip');
  Object.assign(process.env, { PYIDE_DIAGNOSTICS_TEST: '1', PYIDE_DIAGNOSTICS_SAVE_TO: zipPath, PYIDE_LOG_MAX_BYTES: String(256 * 1024) });
  const t = await launch({ fixture: 'diagnostics', port: 9750, name: 'diagnostics', userData });
  const { js, until, check, click, shot } = t;
  const logDir = path.join(userData, 'logs');
  const allLogs = () => readdirSync(logDir).filter((f) => f.endsWith('.log')).map((f) => readFileSync(path.join(logDir, f), 'utf8')).join('\n');
  try {
    // ---- plugin load failures at startup ----
    await untilError(t, ACTIVATION, 'activation failure listed');
    const activation = await findError(t, ACTIVATION);
    check(activation.plugin?.id === 'diag-broken' && activation.source === 'renderer' && activation.window === 'main', `activation failure belongs to diag-broken (got ${activation.plugin?.id}, ${activation.source})`);
    const register = await findError(t, 'main module register failed');
    check(register?.plugin?.id === 'diag-broken' && register.source === 'plugin', `main module register failure belongs to diag-broken (got ${register?.plugin?.id}, ${register?.source})`);
    check(await js(`(() => { const s = document.querySelector('#ideErrors'); return s && !s.classList.contains('hidden') && s.classList.contains('unread') && s.getClientRects().length > 0; })()`), 'red status-bar icon shows unread errors');
    check(await js(`getComputedStyle(document.querySelector('#ideErrors .diag-status-icon')).animationName === 'diag-blink'`), 'status icon blinks while errors are unread');
    check(await js(`getComputedStyle(document.querySelector('#ideErrors')).color === getComputedStyle(document.documentElement).getPropertyValue('--red').trim() || /rgb\\(2[0-9]{2}, /.test(getComputedStyle(document.querySelector('#ideErrors')).color)`), 'status icon is red');

    // ---- main process: core and plugin exceptions, rejections ----
    await js(`ide.api.invoke('diagnostics:test', 'uncaught')`);
    await js(`ide.api.invoke('diagnostics:test', 'rejection')`);
    await js(`ide.api.invoke('diagflaky:uncaught')`);
    await untilError(t, 'uncaught main-process exception', 'core uncaught exception listed');
    await untilError(t, 'unhandled main-process rejection', 'core rejection listed');
    await untilError(t, 'diag-flaky: main-process failure', 'plugin main-process exception listed');
    const core = await findError(t, 'uncaught main-process exception');
    check(core.source === 'main' && core.plugin === null && core.kind === 'uncaught', `core main-process exception has no plugin (got ${JSON.stringify(core.plugin)})`);
    check((await findError(t, 'unhandled main-process rejection')).kind === 'rejection', 'unhandled rejection kind');
    const flakyMain = await findError(t, 'diag-flaky: main-process failure');
    check(flakyMain.plugin?.id === 'diag-flaky' && /flaky-main\.js/.test(flakyMain.stack), `main-process exception mapped to diag-flaky by its stack (got ${flakyMain.plugin?.id})`);
    check((await js(`ide.api.invoke('diagnostics:test', 'rawDialogs')`)).length === 0, 'Electron never tried to show its raw main-process error dialog');
    check(await js(`ide.api.invoke('fs:exists', ide.root)`), 'main process still answers after uncaught exceptions');

    // ---- renderer: plugin errors, repeated, a rejection, and core code ----
    for (let i = 0; i < 3; i++) { await js(`ide.runAction('DiagFlaky.Fail')`); await sleep(80); }
    await js(`ide.runAction('DiagFlaky.Reject')`);
    await js(`(setTimeout(() => { throw new Error('diag core renderer failure'); }), true)`);
    await until(`ide.api.invoke('diagnostics:errors').then(l => l.find(e => e.message.includes('diag-flaky: renderer failure'))?.count === 3)`, 'repeated renderer error counted');
    const flaky = await findError(t, 'diag-flaky: renderer failure');
    check(flaky.plugin?.id === 'diag-flaky' && flaky.count === 3, `renderer exception from diag-flaky, counted 3 times (got ${flaky.plugin?.id}, ${flaky.count})`);
    await untilError(t, 'diag-flaky: rejected promise', 'renderer rejection listed');
    check((await findError(t, 'diag-flaky: rejected promise')).plugin?.id === 'diag-flaky', 'renderer rejection mapped to diag-flaky');
    await untilError(t, 'diag core renderer failure', 'core renderer error listed');
    check((await findError(t, 'diag core renderer failure')).plugin === null, 'renderer error outside plugins is core');
    // A diff whose models went away while the worker computed it: Monaco rethrows it from a timer, as message + stack.
    await js(`(setTimeout(() => { const e = new Error('no diff result available'); throw new Error(e.message + '\\n\\n' + e.stack); }), Promise.reject(new Error('no diff result available')), true)`);
    await sleep(800);
    check(!(await js(`ide.api.invoke('diagnostics:errors').then(l => l.some(e => e.message.includes('no diff result available')))`)) && !t.consoleErrors.some((m) => m.includes('no diff result available')),
      'Monaco\'s "no diff result available" (a diff editor closed mid-computation) is neither an internal error nor a renderer exception');

    // ---- a crashing Python sidecar and a killed Pyright ----
    const interp = await js(`(() => { const i = ide.currentInterp(); return i && { cmd: i.cmd, args: i.args }; })()`);
    check(!!interp, 'a Python interpreter for the sidecar');
    await js(`ide.api.invoke('diagflaky:sidecar', ${JSON.stringify(interp.cmd)}, ${JSON.stringify(interp.args)})`);
    await untilError(t, 'fake_sidecar.py exited unexpectedly', 'crashed sidecar listed');
    const sidecar = await findError(t, 'fake_sidecar.py exited unexpectedly');
    check(sidecar.source === 'sidecar' && sidecar.plugin?.id === 'diag-flaky' && sidecar.message.includes('exit code 3'), `sidecar crash from diag-flaky with its exit code (got ${sidecar.plugin?.id}: ${sidecar.message})`);
    check(sidecar.stack.includes('RuntimeError: diag sidecar boom'), 'sidecar crash shows the stderr traceback');

    await openFile(t, 'main.py');
    // A program run through the IDE: its launch and exit code are logged, its output is not.
    await t.press('Shift+F10');
    await until(`document.querySelector('#runOut')?.textContent.includes('exit code')`, 'main.py ran', 30000);
    await until(`ide.lsp && ide.lsp.ready()`, 'Pyright ready', 60000);
    await until(`ide.api.invoke('diagnostics:test', 'processes').then(l => l.some(p => p.name === 'Pyright language server'))`, 'Pyright watched');
    const pyright = (await js(`ide.api.invoke('diagnostics:test', 'processes')`)).find((p) => p.name === 'Pyright language server');
    check(pyright.plugin === 'lsp', `Pyright process belongs to the lsp plugin (got ${pyright.plugin})`);
    execSync(`taskkill /pid ${pyright.pid} /F`, { stdio: 'ignore' });
    await untilError(t, 'Pyright language server exited unexpectedly', 'Pyright crash listed');
    check((await findError(t, 'Pyright language server exited unexpectedly')).plugin?.id === 'lsp', 'Pyright crash attributed to Python Language Support');

    // ---- an error in a detached window ----
    await js(`ide.runAction('OpenInNewWindow')`);
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(250);
      page = (await (await fetch('http://127.0.0.1:9750/json')).json()).find((p) => p.type === 'page' && p.url.includes('detached=1'));
    }
    check(!!page, 'detached window opened');
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r));
      let seq = 0;
      const send = (method, params) => ws.send(JSON.stringify({ id: ++seq, method, params }));
      for (let i = 0; i < 40; i++) {
        send('Runtime.evaluate', { expression: `window.__ideReady && (setTimeout(() => { throw new Error('diag detached window failure'); }), true)` });
        if (await findError(t, 'diag detached window failure')) break;
        await sleep(250);
      }
      ws.close();
      await untilError(t, 'diag detached window failure', 'detached window error listed');
      const detached = await findError(t, 'diag detached window failure');
      check(detached.source === 'renderer' && detached.window === 'detached', `detached window error is labelled (got ${detached.window})`);
    }

    // ---- the error list ----
    await click('#ideErrors');
    await until(`document.querySelector('.diag-dialog')`, 'errors dialog');
    const listed = (await errors(t)).length;
    check(await js(`document.querySelectorAll('.diag-dialog .diag-row').length`) === listed, `the dialog lists every error (${listed})`);
    await until(`!document.querySelector('#ideErrors').classList.contains('unread')`, 'icon stops blinking once seen');
    check(true, 'opening the list marks the errors as seen');
    const selectRow = (text) => js(`(() => { const r = [...document.querySelectorAll('.diag-row')].find(n => n.textContent.includes(${JSON.stringify(text)})); r?.click(); return !!r; })()`);
    await selectRow('diag-flaky: renderer failure');
    check(await js(`document.querySelector('.diag-plugin-name').textContent === 'Diag Flaky' && document.querySelector('.diag-stack').textContent.includes('flakyTimer')`), 'detail shows the plugin and the stack trace');
    check(await js(`!!document.querySelector('.diag-failing') && !document.querySelector('#diagDisable').classList.contains('hidden')`), 'a plugin that keeps failing is called out with Disable Plugin');
    await click('#diagCopy');
    const copied = await js(`ide.api.invoke('clipboard:readText')`);
    check(copied.includes('diag-flaky: renderer failure') && copied.includes('Plugin: Diag Flaky (diag-flaky)') && copied.includes('flakyTimer'), 'Copy puts the error with plugin and stack on the clipboard');
    await selectRow('uncaught main-process exception');
    check(await js(`document.querySelector('.diag-plugin-name').textContent === 'PyIDE core' && document.querySelector('#diagDisable').classList.contains('hidden')`), 'core errors offer no Disable Plugin');
    await shot('errors.png');

    await selectRow('diag-flaky: renderer failure');
    await click('#diagDisable');
    await until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Disable Plugin')`, 'disable confirmation');
    await js(`[...document.querySelectorAll('.dialog')].pop().querySelector('.dialog-buttons .primary').click()`);
    await until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent === 'Plugin Disabled')`, 'plugin disabled notice');
    check((await js(`ide.api.invoke('plugins:list')`)).find((p) => p.id === 'diag-flaky')?.enabled === false, 'Disable Plugin turns diag-flaky off for the next start');
    await js(`[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')[1].click()`);
    check(await js(`!document.querySelector('.diag-dialog')`), 'the error list closes after disabling');

    // ---- the log ----
    await js(`ide.log.info('connecting with password=${SECRETS.password} and key ${SECRETS.apiKey}')`);
    await js(`ide.logger('#diagtest').warn('diag warning line')`);
    await sleep(300);
    let log = readFileSync(path.join(logDir, 'pyide.log'), 'utf8');
    check(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} \[ *\d+\] +INFO - #main - -+ IDE STARTED -+$/m.test(log), 'idea.log-style lines with time, uptime, level and category');
    for (const [text, label] of [
      [ACTIVATION, 'plugin activation failure'], ['main module register failed', 'main module failure'],
      ['uncaught main-process exception', 'main-process exception'], ['diag-flaky: renderer failure', 'renderer exception'],
      ['diag detached window failure', 'detached window exception'], ['RuntimeError: diag sidecar boom', 'sidecar stderr'],
      ['#sidecar.Pyright language server', 'Pyright process'], ['Pyright language server exited unexpectedly', 'Pyright crash'],
      ['#process - #', 'IDE process launches'], ['WARN - #diagtest - diag warning line', 'renderer log lines with level and category'],
    ]) check(log.includes(text), `log has the ${label}`);
    check(/\[plugin diag-flaky\]/.test(log), 'log names the plugin of an error');
    check(!log.includes('Hello, PyIDE'), "the user program's output stays out of the log");
    check(!log.includes(SECRETS.password) && !log.includes(SECRETS.apiKey), 'secrets are scrubbed before they reach the log');

    // ---- Help menu ----
    await click('#mainMenuBtn');
    await js(`[...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.textContent.startsWith('Help')).dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
    await until(`document.querySelectorAll('.context-menu').length > 1`, 'Help submenu');
    const help = await js(`[...document.querySelectorAll('.context-menu')].pop().textContent`);
    check(['Show Log', 'Show Log in Explorer', 'Collect Logs and Diagnostic Data', 'About PyIDE'].every((s) => help.includes(s)), 'Help lists Show Log, Show Log in Explorer, Collect Logs and About');
    await t.press('Escape');
    await t.press('Escape');

    await js(`ide.runAction('OpenLogInEditor')`);
    await until(`ide.activeTab()?.path.toLowerCase().endsWith('logs\\\\pyide.log')`, 'log opened');
    check(await js(`ide.activeTab().model.getValue().includes('IDE STARTED')`), 'Show Log opens pyide.log in an editor tab');

    // ---- Debug Log Settings: the level applies at once ----
    await js(`ide.log.debug('diag debug line before')`);
    await js(`ide.runAction('LogDebugConfigure')`);
    await until(`document.querySelector('.diag-log-settings-dialog #diagLogLevel')`, 'Debug Log Settings dialog');
    await js(`(() => { const s = document.querySelector('#diagLogLevel'); s.value = 'DEBUG'; s.dispatchEvent(new Event('change')); document.querySelector('.diag-log-settings-dialog .dialog-buttons .primary').click(); return true; })()`);
    await sleep(200);
    await js(`ide.log.debug('diag debug line after')`);
    await sleep(300);
    log = readFileSync(path.join(logDir, 'pyide.log'), 'utf8');
    check(!log.includes('diag debug line before') && /DEBUG - #renderer - diag debug line after/.test(log), 'Debug Log Settings switches the log to DEBUG at once');
    check(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))['diagnostics.logLevel'] === 'DEBUG', 'the log level is saved for the next start');

    // ---- rotation ----
    await js(`(() => { const l = ide.logger('#flood'); const line = 'x'.repeat(200); for (let i = 0; i < 1800; i++) l.info(i + ' ' + line); return true; })()`);
    await until(`ide.api.invoke('fs:exists', ${JSON.stringify(path.join(logDir, 'pyide.1.log'))})`, 'rotated log');
    await sleep(500);
    check(statSync(path.join(logDir, 'pyide.log')).size <= 256 * 1024 && statSync(path.join(logDir, 'pyide.1.log')).size <= 256 * 1024 + 4096, 'the log rotates at its size cap');
    check(!existsSync(path.join(logDir, 'pyide.6.log')), 'at most five rotated logs are kept');

    // ---- About ----
    await js(`ide.runAction('AboutPyIDE')`);
    await until(`document.querySelector('.diag-about-dialog')`, 'About dialog');
    const about = await js(`document.querySelector('.diag-about-dialog .diag-facts').textContent`);
    check(['Electron', 'Chromium', 'Node', 'Pyright', 'Python'].every((s) => about.includes(s)), 'About lists PyIDE, Electron, Node, Pyright and Python versions');
    await click('#aboutCopy');
    const aboutCopy = await js(`ide.api.invoke('clipboard:readText')`);
    check(/^PyIDE \S+\nRuntime: Electron [\d.]+, Chromium [\d.]+, Node [\d.]+/.test(aboutCopy) && /Pyright \d/.test(aboutCopy) && /Python: \d/.test(aboutCopy), 'About Copy puts the versions on the clipboard');
    check(await js(`document.querySelector('#aboutCopy').textContent === 'Copied'`), 'Copy button confirms');
    await shot('about.png');
    await t.press('Escape');

    // ---- Collect Logs and Diagnostic Data ----
    await js(`ide.runAction('CollectZippedLogs')`);
    await until(`document.querySelector('.diag-saved-dialog')`, 'saved dialog', 30000);
    check(await js(`document.querySelector('.diag-saved-path').textContent === ${JSON.stringify(zipPath)}`), 'the dialog names the saved archive');
    check(existsSync(zipPath) && readFileSync(zipPath).subarray(0, 2).toString() === 'PK', 'a .zip archive was written');
    const unzipped = path.join(dir, 'unzipped');
    mkdirSync(unzipped, { recursive: true });
    // Windows' own bsdtar reads zips; a GNU tar earlier on PATH (Git's) does not.
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipPath, '-C', unzipped]);
    const files = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(path.relative(unzipped, p).replace(/\\/g, '/')); } };
    walk(unzipped);
    for (const f of ['logs/pyide.log', 'logs/pyide.1.log', 'about.txt', 'versions.json', 'plugins.json', 'settings.json', 'internal-errors.txt']) {
      check(files.includes(f), `archive has ${f}`);
    }
    const read = (f) => readFileSync(path.join(unzipped, f), 'utf8');
    const versions = JSON.parse(read('versions.json'));
    check(versions.electron && versions.node && versions.app && /^\d/.test(versions.pyright || '') && versions.interpreters.length > 0 && versions.interpreters.every((i) => i.version), 'versions.json has app, Electron, Node, Pyright and the Python interpreters');
    const plugins = JSON.parse(read('plugins.json'));
    check(plugins.some((p) => p.id === 'diagnostics' && p.enabled) && plugins.some((p) => p.id === 'diag-flaky' && p.enabled === false), 'plugins.json lists plugins and their state');
    const settings = JSON.parse(read('settings.json'));
    check(settings['editor.fontSize'] === 14 && settings['database.password'] === '<redacted>' && settings['ai.apiKey'] === '<redacted>' && settings['vcs.github'].token === '<redacted>' && settings['vcs.github'].user === 'octo', 'settings.json keeps settings and redacts secrets');
    check(read('internal-errors.txt').includes('Plugin: Diag Flaky (diag-flaky)'), 'internal-errors.txt lists the errors with their plugins');
    const everything = files.map(read).join('\n');
    const leaked = Object.entries(SECRETS).filter(([, v]) => everything.includes(v)).map(([k]) => k);
    check(!leaked.length, `no password, token, API key or safeStorage blob in the archive${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`);
    check(!files.some((f) => /sources\.json|servers\.json|plugin-state/.test(f)), 'data source and server files are not collected');
    await shot('collected.png');
    await js(`document.querySelector('.diag-saved-dialog .dialog-buttons .primary').click()`);

    // ---- Clear All ----
    await js(`ide.runAction('ShowIdeErrors')`);
    await until(`document.querySelector('.diag-dialog')`, 'errors dialog again');
    await click('#diagClear');
    await until(`document.querySelector('#ideErrors').classList.contains('hidden')`, 'icon hidden after Clear All');
    check((await errors(t)).length === 0, 'Clear All empties the list and hides the icon');
    check((await js(`ide.api.invoke('diagnostics:test', 'rawDialogs')`)).length === 0, 'still no raw Electron dialog at the end');
  } catch (err) {
    check(false, err.message);
    await shot('failure.png');
  }
  dropExpected(t);
  t.close();
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  var englishFailed = t.results.filter((r) => !r.ok).length + t.consoleErrors.length;
  console.log(`${t.results.length - t.results.filter((r) => !r.ok).length}/${t.results.length} passed (English)`);
}

// ---------------------------------------------------------------- Korean
{
  const { dir, userData } = prepareUserData('ko');
  process.env.PYIDE_DIAGNOSTICS_SAVE_TO = path.join(dir, 'out', 'diagnostics.zip');
  const t = await launch({ fixture: 'diagnostics', port: 9751, name: 'diagnostics-ko', userData, lang: 'ko-KR' });
  const { js, until, check, click, shot } = t;
  const leaks = async (selector, label) => {
    const l = await englishLeaks(t, selector, ['Diag', 'Broken', 'Flaky', 'Electron', 'Chromium', 'Node', 'V8']);
    check(!l.length, `${label} has no English${l.length ? `: ${JSON.stringify(l.slice(0, 5))}` : ''}`);
  };
  try {
    await untilError(t, ACTIVATION, 'activation failure listed');
    await js(`ide.api.invoke('diagnostics:test', 'uncaught')`);
    await untilError(t, 'uncaught main-process exception', 'core exception listed');
    await js(`ide.runAction('DiagFlaky.Fail')`);
    await js(`ide.runAction('DiagFlaky.Fail')`);
    await js(`ide.runAction('DiagFlaky.Fail')`);
    await until(`ide.api.invoke('diagnostics:errors').then(l => l.find(e => e.message.includes('diag-flaky: renderer failure'))?.count === 3)`, 'flaky errors');
    check(await js(`document.querySelector('#ideErrors').title.startsWith('IDE 내부 오류')`), 'status icon tooltip is Korean');
    await leaks('#status', 'status bar');

    await click('#ideErrors');
    await until(`document.querySelector('.diag-dialog')`, 'errors dialog');
    check(await js(`document.querySelector('.diag-dialog .dialog-title').textContent === 'IDE 내부 오류'`), 'error list title is Korean');
    await js(`[...document.querySelectorAll('.diag-row')].find(n => n.textContent.includes('diag-flaky: renderer failure')).click()`);
    check(await js(`document.querySelector('#diagDisable').textContent === '플러그인 비활성화' && !!document.querySelector('.diag-failing')`), 'Disable Plugin and the keeps-failing note are Korean');
    await leaks('.diag-dialog', 'error list (plugin error)');
    await js(`[...document.querySelectorAll('.diag-row')].find(n => n.textContent.includes('uncaught main-process exception')).click()`);
    check(await js(`document.querySelector('.diag-plugin-name').textContent === 'PyIDE 코어'`), 'core errors say PyIDE 코어');
    await leaks('.diag-dialog', 'error list (core error)');
    await shot('errors-ko.png');
    await t.press('Escape');

    await click('#mainMenuBtn');
    await js(`[...document.querySelectorAll('#mainMenu .menu-item')].find(n => n.textContent.startsWith('도움말')).dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`);
    await until(`document.querySelectorAll('.context-menu').length > 1`, 'Help submenu');
    const help = await js(`[...document.querySelectorAll('.context-menu')].pop().textContent`);
    check(['로그 표시', '탐색기에서 로그 표시', '로그 및 진단 데이터 수집', 'PyIDE 정보'].every((s) => help.includes(s)), 'Help items are Korean');
    await leaks('#menuHost', 'Help menu');
    await t.press('Escape');
    await t.press('Escape');

    await js(`ide.runAction('AboutPyIDE')`);
    await until(`document.querySelector('.diag-about-dialog')`, 'About');
    await leaks('.diag-about-dialog', 'About dialog');
    await t.press('Escape');

    await js(`ide.runAction('CollectZippedLogs')`);
    await until(`document.querySelector('.diag-saved-dialog')`, 'saved dialog', 30000);
    await leaks('.diag-saved-dialog', 'saved dialog');
    await js(`document.querySelector('.diag-saved-dialog .dialog-buttons .primary').click()`);

    await js(`ide.runAction('LogDebugConfigure')`);
    await until(`document.querySelector('.diag-log-settings-dialog #diagLogLevel')`, 'Debug Log Settings');
    await leaks('.diag-log-settings-dialog', 'Debug Log Settings');
    await t.press('Escape');

    // This plugin's strings; other plugins have their own suites.
    const source = readFileSync(path.join(APP, 'renderer', 'features', 'diagnostics', 'index.js'), 'utf8');
    const missing = (await missingTranslations(t)).filter((s) => source.includes(`'${s}'`));
    check(!missing.length, `every tr() string has Korean${missing.length ? `: ${JSON.stringify(missing.slice(0, 10))}` : ''}`);
  } catch (err) {
    check(false, err.message);
    await shot('failure-ko.png');
  }
  dropExpected(t);
  t.close();
  if (t.consoleErrors.length) console.log(`renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
  const failed = t.results.filter((r) => !r.ok).length + t.consoleErrors.length;
  console.log(`${t.results.length - t.results.filter((r) => !r.ok).length}/${t.results.length} passed (Korean)`);
  process.exit(englishFailed || failed ? 1 : 0);
}
