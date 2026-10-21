// Auto-update end to end on a real NSIS install: installs dist/PyIDE-Setup-<version>.exe per-user into a temp folder,
// builds the next patch version into a temp feed folder (or takes a feed folder as the first argument), points the
// installed PyIDE at it, and checks that it finds the update, downloads it with progress in the status bar, restarts
// into the new version on "Restart to Update", and keeps its settings. Then it uninstalls.
// With dist/PyIDE-<version>.msi present it also checks that an MSI install offers the new MSI instead.
// Build first with `npm run dist`.
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const S = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const next = version.replace(/\d+$/, (n) => String(Number(n) + 1));
const installer = path.join(APP_DIR, 'dist', `PyIDE-Setup-${version}.exe`);
if (!existsSync(installer)) throw new Error(`no ${installer}: run npm run dist first`);
// The NSIS installer removes an existing per-user PyIDE before installing anywhere, so a temp install here would
// uninstall the real one (settings in %APPDATA%\PyIDE survive, the app does not).
const localInstall = path.join(process.env.LOCALAPPDATA, 'Programs', 'PyIDE', 'Uninstall PyIDE.exe');
if (existsSync(localInstall)) throw new Error(`PyIDE is installed in ${path.dirname(localInstall)}; installing a test copy would remove it. Uninstall it first (or use npm run release -- <v> --replace-local-install, which reinstalls it).`);

const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

// ---------- the feed: the next version, built from this tree ----------
let feed = process.argv[2];
if (!feed) {
  feed = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-feed-')), next);
  console.log(`building ${next} into ${feed} …`);
  const r = spawnSync(`npx electron-builder --win nsis --x64 -c.extraMetadata.version=${next} "-c.directories.output=${feed}"`,
    { cwd: APP_DIR, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error('electron-builder failed for the feed build');
}
const feedVersion = /^version:\s*(\S+)/m.exec(readFileSync(path.join(feed, 'latest.yml'), 'utf8'))?.[1];
check(feedVersion && feedVersion !== version && existsSync(path.join(feed, `PyIDE-Setup-${feedVersion}.exe`)), `feed folder holds latest.yml for ${feedVersion} and its installer`);

// ---------- install the current version ----------
const installDir = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-update-')), 'PyIDE');
const exe = path.join(installDir, 'PyIDE.exe');
const cacheDir = path.join(process.env.LOCALAPPDATA, 'pyide-updater');
const cacheExisted = existsSync(cacheDir);
check(spawnSync(installer, ['/S', `/D=${installDir}`], { stdio: 'ignore' }).status === 0 && existsSync(exe), `installed ${version} into ${installDir}`);
const installedVersion = () => {
  asar.uncacheAll(); // the archive is replaced in place; a cached header would keep reading the old one
  try { return JSON.parse(asar.extractFile(path.join(installDir, 'resources', 'app.asar'), 'package.json').toString()).version; } catch { return null; }
};

// PyIDE processes started from this install only (never other PyIDE or Electron instances).
const ownProcesses = () => {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='PyIDE.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${installDir.replace(/'/g, "''")}', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`],
    { encoding: 'utf8' }).trim();
  return out ? out.split(/\r?\n/).map((l) => { const [pid, ...cmd] = l.split('|'); return { pid: Number(pid), cmd: cmd.join('|') }; }) : [];
};
const killOwn = () => { for (const p of ownProcesses()) try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

let userData;
try {
  // ---------- detect and download ----------
  const t = await launch({ fixture: 'core', port: 9802, name: 'update-e2e', exe });
  userData = t.userData;
  check(await t.js(`ide.api.invoke('app:info').then(i => i.version)`) === version, `the installed app runs ${version}`);
  check(await t.js(`ide.api.invoke('updater:state').then(s => s.kind)`) === 'nsis', 'it knows it is an NSIS install');
  await t.js(`(() => {
    window.__upd = { phases: [], status: new Set() };
    ide.api.on('updater:state', (s) => window.__upd.phases.push(s.phase + ':' + (s.percent ?? '')));
    const item = document.getElementById('updateStatus');
    new MutationObserver(() => window.__upd.status.add(item.textContent)).observe(item, { childList: true, characterData: true, subtree: true });
    ide.settings.set('updates.feedUrl', ${S(feed)});
    ide.runAction('CheckForUpdates');
    return true;
  })()`);
  await t.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('has been downloaded')`, 'Update Ready dialog', 180000);
  const phases = await t.js('window.__upd.phases');
  const shown = await t.js('[...window.__upd.status]');
  check(phases.includes('checking:') && phases.some((p) => p.startsWith('downloading:')) && phases.at(-1).startsWith('downloaded'), `check, download and ready in order (${phases.filter((p, i, a) => a.indexOf(p) === i).slice(0, 8).join(' ')} …)`);
  check(shown.some((s) => s.startsWith(`Downloading PyIDE ${feedVersion}…`) && /\d+%$/.test(s)), `the status bar shows download progress (${shown.find((s) => s.startsWith('Downloading')) || 'none'})`);
  check(await t.js(`document.getElementById('updateStatus').textContent`) === 'Restart to Update', 'the status bar then offers Restart to Update');
  check((await t.js(`[...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')].map(b => b.textContent).join('|')`)) === 'Restart to Update|Skip This Version|Later', 'the dialog offers Restart to Update, Skip This Version and Later');
  await t.shot('update-ready.png');

  // ---------- restart into the new version ----------
  await t.js(`([...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Restart to Update').click(), true)`);
  // The silent installer replaces the app and starts it again through the Start menu shortcut (with --updated).
  let relaunched = null;
  const seen = new Set();
  for (let i = 0; i < 300 && !relaunched; i++) {
    await sleep(400);
    const procs = ownProcesses();
    for (const p of procs) seen.add(p.cmd.replace(/--type=\S+.*/, '--type=…'));
    if (installedVersion() === feedVersion) relaunched = procs.find((p) => p.cmd.includes('--updated') && !p.cmd.includes('--type='));
  }
  check(installedVersion() === feedVersion, `the install folder now holds ${feedVersion}`);
  check(relaunched, `PyIDE restarted by itself after the update (--updated)${relaunched ? '' : `; seen: ${S([...seen])}`}`);
  // The installer starts it as the signed-in user, outside this test's environment and profile: close it at once.
  killOwn();
  t.close();
  await sleep(1000);

  // ---------- the updated app, with the same profile ----------
  const u = await launch({ fixture: 'core', port: 9803, name: 'update-e2e-after', exe, userData });
  check(await u.js(`ide.api.invoke('app:info').then(i => i.version)`) === feedVersion, `the app comes back as ${feedVersion}`);
  check(await u.js(`ide.settings.get('updates.feedUrl')`) === feed, 'settings survive the update');
  await u.js(`(ide.runAction('CheckForUpdates'), true)`);
  await u.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('latest version')`, 'latest dialog', 30000);
  check(true, `a check now reports ${feedVersion} as the latest version`);
  await u.shot('update-after.png');
  u.close();
} catch (err) {
  check(false, err.message);
} finally {
  killOwn();
}

// ---------- uninstall ----------
await sleep(1500);
spawnSync(path.join(installDir, 'Uninstall PyIDE.exe'), ['/S'], { stdio: 'ignore' });
for (let i = 0; i < 120 && existsSync(exe); i++) await sleep(500);
check(!existsSync(exe), 'uninstall removes the updated app');
try { rmSync(path.dirname(installDir), { recursive: true, force: true }); } catch {}

// ---------- an MSI install is pointed at the new MSI instead of updating itself ----------
const msi = path.join(APP_DIR, 'dist', `PyIDE-${version}.msi`);
const msiDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'PyIDE');
if (existsSync(msi) && !existsSync(msiDir)) {
  check(spawnSync('msiexec', ['/i', msi, '/qn'], { stdio: 'ignore' }).status === 0, `MSI: installed ${version} per-user`);
  const m = await launch({ fixture: 'core', port: 9804, name: 'update-e2e-msi', exe: path.join(msiDir, 'PyIDE.exe') });
  try {
    check(await m.js(`ide.api.invoke('updater:state').then(s => s.kind)`) === 'msi', 'MSI: it knows it is an MSI install');
    await m.js(`(ide.settings.set('updates.feedUrl', ${S(feed)}), ide.runAction('CheckForUpdates'), true)`);
    await m.until(`[...document.querySelectorAll('.dialog')].pop()?.textContent.includes('MSI package')`, 'MSI update dialog', 30000);
    check((await m.js(`[...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')].map(b => b.textContent).join('|')`)) === 'Download the new installer|Skip This Version|Later',
      'MSI: the update dialog offers Download the new installer, Skip This Version and Later');
    check(await m.js(`ide.api.invoke('updater:state').then(s => s.phase)`) === 'available', 'MSI: nothing is downloaded in the background');
    await m.shot('update-msi.png');
    await m.js(`([...[...document.querySelectorAll('.dialog')].pop().querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Skip This Version').click(), true)`);
    check(await m.js(`ide.settings.get('updates.skippedVersion')`) === feedVersion, `MSI: Skip This Version remembers ${feedVersion}`);
  } catch (err) {
    check(false, `MSI: ${err.message}`);
  }
  m.close();
  await sleep(1500);
  check(spawnSync('msiexec', ['/x', msi, '/qn'], { stdio: 'ignore' }).status === 0 && !existsSync(path.join(msiDir, 'PyIDE.exe')), 'MSI: uninstalled');
} else console.log(`skipping the MSI part (${existsSync(msi) ? `${msiDir} exists` : 'no MSI in dist'})`);
if (!cacheExisted) rmSync(cacheDir, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
