// When the computer, not the IDE, fails: an update server that accepts and never answers or refuses the connection, a
// PATH without PowerShell's folder, a shell uninstalled while the IDE runs, user plugins with a broken plugin.json or
// main module, and a user data folder that cannot be written. Each is told to the user in words that name the cause,
// and none becomes an IDE internal error. Port 9282.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-env-failures-'));
const userData = path.join(work, 'userdata');

// User plugins: plugin.json cut off mid-file, a main module that throws, one with a syntax error, one that is missing.
const plugin = (id, files) => {
  const dir = path.join(userData, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
};
plugin('bad-json', { 'plugin.json': '{ "id": "bad-json", "name": "Bad JSON", "vers', 'index.js': 'window.__badJsonRan = true;' });
plugin('main-throws', { 'plugin.json': S({ id: 'main-throws', name: 'Main Throws', version: '1.0.0', main: 'm.js' }), 'm.js': "throw new Error('main-throws boom');" });
plugin('main-syntax', { 'plugin.json': S({ id: 'main-syntax', name: 'Main Syntax', version: '1.0.0', main: 'm.js' }), 'm.js': 'this is not JavaScript' });
plugin('no-main', { 'plugin.json': S({ id: 'no-main', name: 'No Main', version: '1.0.0', main: 'missing.js' }) });

// PowerShell 7 "installed" in a folder first on PATH (an empty file is enough for where.exe), removed once detected.
const fakeBin = path.join(work, 'bin');
mkdirSync(fakeBin);
const fakePwsh = path.join(fakeBin, 'pwsh.exe');
writeFileSync(fakePwsh, '');
const windir = process.env.SystemRoot || 'C:\\Windows';
const PATH = [fakeBin, path.join(windir, 'System32'), windir].join(';');

// Accepts connections and never answers, like a captive portal or a broken proxy.
const silent = net.createServer(() => {});
await new Promise((r) => silent.listen(0, '127.0.0.1', r));
const silentFeed = `http://127.0.0.1:${silent.address().port}/feed/`;
const refused = net.createServer();
await new Promise((r) => refused.listen(0, '127.0.0.1', r));
const refusedFeed = `http://127.0.0.1:${refused.address().port}/feed/`;
await new Promise((r) => refused.close(r));

const TIMEOUT_MS = 4000;
const t = await launch({ fixture: 'core', port: 9282, name: 'env-failures', userData, env: { PATH, PYIDE_UPDATE_TIMEOUT_MS: String(TIMEOUT_MS) } });
const { js, until, check, sleep } = t;
const internal = (re) => js(`ide.api.invoke('diagnostics:errors').then((l) => l.filter((e) => ${re}.test(e.message + ' ' + e.stack)).map((e) => e.message))`);
const lastDialog = () => js(`[...document.querySelectorAll('.dialog')].pop()?.textContent || ''`);
const closeDialogs = () => js(`([...document.querySelectorAll('.dialog .dialog-buttons button')].forEach((b) => b.textContent === 'Close' && b.click()), true)`);
const closeSettings = async () => {
  await js(`([...document.querySelectorAll('.settings-dialog .dialog-buttons button')].find((b) => b.textContent === 'Cancel')?.click(), true)`);
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed', 5000);
};
const denied = () => {
  const user = process.env.USERNAME;
  return {
    on: () => execFileSync('icacls', [userData, '/deny', `${user}:(OI)(CI)(WD,AD,WEA,WA,DC)`], { stdio: 'ignore' }),
    off: () => execFileSync('icacls', [userData, '/remove:d', user], { stdio: 'ignore' }),
  };
};

try {
  // ---------- update server that never answers ----------
  const started = Date.now();
  await js(`(ide.updater.check({ manual: true, feedUrl: ${S(silentFeed)} }), true)`);
  await sleep(500);
  check(await js(`ide.tasks.list().some((x) => x.title === 'Checking for updates…')`), 'a manual update check shows "Checking for updates…" while it runs');
  let ended = await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('Could not check for updates')`, 'update check ends', TIMEOUT_MS + 8000).then(() => true, () => false);
  const took = Date.now() - started;
  const text = await lastDialog();
  check(ended && /did not answer/.test(text), `an update check against a server that never answers ends after the deadline with a reason (${took} ms: ${S(text.slice(0, 160))})`);
  check(!(await js(`ide.tasks.list().some((x) => x.title === 'Checking for updates…')`)), 'the "Checking for updates…" task ends with the check');
  await closeDialogs();
  const again = Date.now();
  await js(`(ide.updater.check({ manual: true, feedUrl: ${S(silentFeed)} }), true)`);
  ended = await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('Could not check for updates')`, 'second update check ends', TIMEOUT_MS + 8000).then(() => true, () => false);
  check(ended, `a second check after a timed-out one ends too, not waiting on the first request (${Date.now() - again} ms)`);
  await closeDialogs();

  // ---------- update server that refuses the connection (offline) ----------
  await js(`(ide.updater.check({ manual: true, feedUrl: ${S(refusedFeed)} }), true)`);
  ended = await until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('Could not check for updates')`, 'offline check ends', 15000).then(() => true, () => false);
  await sleep(300);
  check(ended, `an offline update check says it could not check (${S((await lastDialog()).slice(0, 120))})`);
  await closeDialogs();
  const updaterErrors = await internal(`/updater:check|ERR_CONNECTION|ETIMEDOUT/`);
  check(!updaterErrors.length, `failed update checks are not IDE internal errors (${S(updaterErrors)})`);

  // ---------- terminal: PATH without PowerShell's folder; a shell removed after it was detected ----------
  await js(`ide.terminal.open({ shell: 'powershell' }).then(() => true)`);
  const psStarted = await until(`/PS [A-Za-z]:\\\\/.test(ide.terminal.text())`, 'PowerShell prompt', 25000).then(() => true, () => false);
  check(psStarted, `Windows PowerShell starts although PATH lacks its folder (${S((await js('ide.terminal.text()')).slice(-160))})`);
  const shells = await js(`ide.api.invoke('pty:shells').then((l) => l.map((s) => s.id + '=' + s.file))`);
  // where.exe names the file in long form, while TEMP may be an 8.3 short path (RUNNER~1 on GitHub runners).
  const pwshFile = shells.find((s) => s.startsWith('pwsh='))?.slice(5) || '';
  const samePath = (a, b) => existsSync(a) && realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  check(samePath(pwshFile, fakePwsh), `PowerShell 7 is detected on PATH (${S(shells)})`);
  rmSync(fakePwsh);
  await js(`ide.terminal.open({ shell: 'pwsh' }).then(() => true)`);
  await until(`ide.terminal.sessions().at(-1)?.exited === true`, 'pwsh session failed', 10000).catch(() => {});
  await sleep(500);
  const pwshText = await js(`ide.terminal.text(ide.terminal.sessions().at(-1).id)`);
  check(/PowerShell 7 was not found/.test(pwshText) && !!pwshFile && pwshText.includes(pwshFile) && /Settings › Terminal/.test(pwshText),
    `a shell that cannot be found is named with its file and the way out (${S(pwshText.slice(-260))})`);
  const ptyErrors = await internal(`/pty:create|File not found/`);
  check(!ptyErrors.length, `a shell that cannot start is not an IDE internal error (${S(ptyErrors)})`);
  await js(`ide.openSettings('terminal')`);
  await until(`document.querySelector('#terminalShell')?.options.length > 1`, 'shell picker filled', 10000).catch(() => {});
  const options = await js(`[...(document.querySelector('#terminalShell')?.options || [])].map((o) => o.textContent)`);
  check(options.includes('Windows PowerShell') && options.includes('Command Prompt'), `Settings › Terminal picks the default shell (${S(options)})`);
  await closeSettings();

  // ---------- plugins with a broken plugin.json or main module ----------
  const list = await js(`ide.api.invoke('plugins:list').then((l) => Object.fromEntries(l.filter((p) => !p.bundled).map((p) => [p.id, { broken: p.broken, loadError: p.loadError, enabled: p.enabled, loaded: p.loaded }])))`);
  console.log('user plugins:', S(list));
  check(list['bad-json']?.broken === 'invalid' && !list['bad-json'].loaded && !(await js('window.__badJsonRan === true')),
    'a plugin whose plugin.json is not valid JSON is listed as broken and does not run');
  check(/main-throws boom/.test(list['main-throws']?.loadError || ''), 'a plugin whose main module throws is listed with the error');
  check(/SyntaxError|Unexpected/.test(list['main-syntax']?.loadError || ''), 'a plugin whose main module has a syntax error is listed with the error');
  check(/Cannot find module/.test(list['no-main']?.loadError || ''), 'a plugin whose main module is missing is listed with the error');
  await js(`ide.openSettings('plugins')`);
  try {
    await until(`!!document.querySelector('#pluginsList .plugin-row[data-id="bad-json"]')`, 'broken plugin row', 10000);
    check(await js(`document.querySelector('#pluginsList .plugin-row[data-id="bad-json"] .plugin-error')?.textContent === 'Broken'`), 'the Plugins page marks the broken plugin');
    await js(`(document.querySelector('#pluginsList .plugin-row[data-id="main-throws"]').click(), true)`);
    check(/Failed to load: .*main-throws boom/.test(await js(`document.querySelector('#pluginError')?.textContent || ''`)), 'the Plugins page shows why a plugin failed to load');
    await js(`(document.querySelector('#pluginsList .plugin-row[data-id="bad-json"]').click(), true)`);
    const why = await js(`document.querySelector('#pluginError')?.textContent || ''`);
    check(/not valid JSON/.test(why), `the Plugins page says what is wrong with the broken plugin (${S(why)})`);
    await js(`(document.querySelector('#pluginUninstallBtn').click(), true)`);
    await until(`[...document.querySelectorAll('.dialog .dialog-buttons button')].some((b) => b.textContent === 'Uninstall')`, 'uninstall confirmation');
    await js(`([...document.querySelectorAll('.dialog .dialog-buttons button')].find((b) => b.textContent === 'Uninstall').click(), true)`);
    await until(`ide.api.invoke('plugins:list').then((l) => !l.some((p) => p.id === 'bad-json'))`, 'broken plugin uninstalled', 10000).catch(() => {});
    check(!existsSync(path.join(userData, 'plugins', 'bad-json')), 'the broken plugin can be uninstalled from the Plugins page');
  } catch (err) {
    check(false, err.message);
  }
  await closeSettings();

  // ---------- a user data folder that cannot be written ----------
  await openFile(t, 'hello.py');
  const acl = denied();
  acl.on();
  try {
    for (let i = 1; i <= 2; i++) {
      await js(`(ide.editor.getModel().setValue(ide.editor.getModel().getValue() + '\\n# denied ${i}\\n'), true)`);
      await sleep(2500); // crash recovery backs up after a pause in typing
      await js('ide.saveAll().then(() => true)');
      await sleep(2500);
    }
    const notes = await js(`ide.notifications.list().filter((e) => e.group === 'Local History').map((e) => e.title + ': ' + e.text)`);
    check(notes.length === 1 && /cannot be written/.test(notes[0]), `Local History says once that it cannot save (${S(notes)})`);
    const fsErrors = await internal(`/recovery:put|localHistory|local history|EPERM|EACCES/`);
    check(!fsErrors.length, `a user data folder that cannot be written makes no IDE internal errors (${S(fsErrors)})`);
  } finally {
    acl.off();
  }
  const before = await js(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'hello.py'), false).then((r) => r.revisions.length)`);
  await js(`(ide.editor.getModel().setValue(ide.editor.getModel().getValue() + '\\n# writable again\\n'), true)`);
  await js('ide.saveAll().then(() => true)');
  const resumed = await until(`ide.api.invoke('localHistory:list', ide.root, ide.util.joinPath(ide.root, 'hello.py'), false).then((r) => r.revisions.length > ${before})`, 'history resumes', 10000).then(() => true, () => false);
  check(resumed, 'Local History records saves again once the folder can be written');

  const all = await js(`ide.api.invoke('diagnostics:errors').then((l) => l.filter((e) => !/Plugin module/.test(e.title || '') && !/main-throws|missing\\.js|m\\.js/.test(e.message + e.stack)).map((e) => (e.title ? e.title + ': ' : '') + e.message))`);
  check(!all.length, `no other internal errors (${S(all).slice(0, 400)})`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png').catch(() => {});
} finally {
  try { execFileSync('icacls', [userData, '/remove:d', process.env.USERNAME], { stdio: 'ignore' }); } catch {}
  silent.close();
}
t.finish();
