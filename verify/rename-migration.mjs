// The rename to Nano Studio (main/migrate.js and the product name). Plain Node first: migrate() on temp folders (no
// PyIDE folder, settings already there, the same folder, damaged settings, the marker, a failed item retried), the names in package.json and
// the User-Agent. Then the real app, twice, on a temp folder laid out like %APPDATA%: PyIDE\ holds a user's PyIDE data
// (settings in Korean, a disabled plugin, a user plugin, interpreter probes, project roots, trusted projects, logs and
// caches) and Nano Studio\ is the new user data. The first start copies what the design lists and the trusted
// projects, leaves logs and caches, says
// "PyIDE 설정을 가져왔어요" once, and changes nothing in PyIDE\; the second start imports and says nothing.
// The real %APPDATA%\PyIDE is never read. Usage: node verify/rename-migration.mjs (CDP ports 9905-9906).
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { migrate, takeNotice, MARKER } = require('../main/migrate.js');
const J = JSON.stringify;
const OLD_FEED = 'https://github.com/mandur23/Portfolio-Nano-/releases/download/pyide/';

const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const quiet = { info() {}, warn() {} };
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Every file under dir: relative path -> sha1 and mtime, to tell that PyIDE's folder was not changed.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${createHash('sha1').update(readFileSync(p)).digest('hex')} ${statSync(p).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

// ---------- plain Node ----------
{
  const pkg = readJson(path.join(APP_DIR, 'package.json'));
  check(pkg.name === 'nano-studio' && pkg.productName === 'Nano Studio' && pkg.build.productName === 'Nano Studio' && pkg.build.appId === 'dev.nanostudio.app',
    `package.json: nano-studio, Nano Studio, dev.nanostudio.app (${pkg.name}, ${pkg.productName}, ${pkg.build.appId})`);
  check(pkg.build.nsis.artifactName === 'NanoStudio-Setup-${version}.exe' && pkg.build.msi.artifactName === 'NanoStudio-${version}.msi'
    && pkg.build.nsis.shortcutName === 'Nano Studio' && pkg.build.msi.shortcutName === 'Nano Studio' && pkg.build.nsis.uninstallDisplayName === 'Nano Studio',
    'installers: NanoStudio-Setup-<v>.exe and NanoStudio-<v>.msi, shortcuts "Nano Studio"');
  check(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(pkg.build.msi.upgradeCode) && pkg.build.msi.upgradeCode !== 'C8A5FFE8-0263-4874-B6AC-E39E095BE819',
    `the MSI has a new upgrade code (${pkg.build.msi.upgradeCode})`);
  check(pkg.updateFeed.endsWith('/releases/download/nano-studio/') && pkg.build.publish[0].url === pkg.updateFeed, `the update feed is the nano-studio release (${pkg.updateFeed})`);
  const nsh = readFileSync(path.join(APP_DIR, 'build', 'installer.nsh'), 'utf8');
  const msi = readFileSync(path.join(APP_DIR, 'build', 'msi-project.js'), 'utf8');
  check(nsh.includes('Software\\Classes\\NanoStudio.py') && !nsh.includes('PyIDE.py') && msi.includes("'Software\\\\Classes\\\\NanoStudio.py'") && !msi.includes('PyIDE.py'),
    'the "Open with" ProgID is NanoStudio.py in both installers');
  const ua = require('../main/minecraft/sources.js').HEADERS['User-Agent'];
  check(ua.startsWith(`NanoStudio/${pkg.version} `), `the User-Agent is NanoStudio/<version> (${ua})`);

  const base = tempDir('rename-unit');
  const userData = path.join(base, 'Nano Studio');
  check(migrate(userData, { log: quiet }) === null && !existsSync(path.join(userData, MARKER)), 'without a PyIDE folder beside it nothing happens');

  const legacy = path.join(base, 'PyIDE');
  write(path.join(legacy, 'settings.json'), J({ 'editor.fontSize': 15, 'updates.feedUrl': OLD_FEED }));
  write(path.join(legacy, 'plugins', 'p', 'plugin.json'), '{}');
  write(path.join(userData, 'settings.json'), J({ 'editor.fontSize': 20 }));
  check(migrate(userData, { log: quiet }) === null && readJson(path.join(userData, 'settings.json'))['editor.fontSize'] === 20 && !existsSync(path.join(userData, 'plugins')),
    'user data that already has settings.json is left alone');

  check(migrate(legacy, { log: quiet }) === null, 'a user data folder named PyIDE does not import from itself');

  const fresh = path.join(base, 'fresh', 'Nano Studio');
  cpSync(legacy, path.join(base, 'fresh', 'PyIDE'), { recursive: true });
  const r = migrate(fresh, { log: quiet });
  const s = readJson(path.join(fresh, 'settings.json'));
  check(r && r.copied.includes('settings.json') && r.copied.includes('plugins') && s['editor.fontSize'] === 15 && !('updates.feedUrl' in s),
    `settings and plugins are copied, PyIDE's update feed is dropped (${J(r)}, ${J(s)})`);
  const marker = readJson(path.join(fresh, MARKER));
  check(marker.noticeShown === false && marker.from === path.join(base, 'fresh', 'PyIDE'), `the marker records where from (${J(marker)})`);
  check(takeNotice(fresh)?.from === marker.from && takeNotice(fresh) === null, 'the notice is given once');
  write(path.join(base, 'fresh', 'PyIDE', 'scratch.txt'), 'x');
  rmSync(path.join(fresh, 'settings.json'));
  check(migrate(fresh, { log: quiet }) === null, 'with the marker there, a later start does not import again (even with settings.json gone)');

  const damaged = path.join(base, 'damaged', 'Nano Studio');
  write(path.join(base, 'damaged', 'PyIDE', 'settings.json'), '{ "editor.fontSize": 1');
  const d = migrate(damaged, { log: quiet });
  check(d?.copied.includes('settings.json') && readFileSync(path.join(damaged, 'settings.json'), 'utf8') === '{ "editor.fontSize": 1',
    'a damaged settings.json is copied as it is (main.js then keeps it as settings.json.bak)');

  const blocked = path.join(base, 'blocked', 'Nano Studio');
  cpSync(legacy, path.join(base, 'blocked', 'PyIDE'), { recursive: true });
  write(path.join(blocked, 'plugins'), 'a file where the plugins folder goes');
  const b1 = migrate(blocked, { log: quiet });
  check(J(b1?.failed) === J(['plugins']) && b1.copied.includes('settings.json') && J(readJson(path.join(blocked, MARKER)).failed) === J(['plugins']),
    `an item that cannot be copied is recorded as failed in the marker (${J(b1)})`);
  const shown = takeNotice(blocked);
  write(path.join(blocked, 'settings.json'), J({ 'editor.fontSize': 30 }));
  rmSync(path.join(blocked, 'plugins'));
  const b2 = migrate(blocked, { log: quiet });
  const m2 = readJson(path.join(blocked, MARKER));
  check(J(b2?.copied) === J(['plugins']) && existsSync(path.join(blocked, 'plugins', 'p', 'plugin.json')) && readJson(path.join(blocked, 'settings.json'))['editor.fontSize'] === 30
    && m2.failed.length === 0 && m2.copied.includes('settings.json') && m2.copied.includes('plugins'),
  `the next start copies what failed, and only that: settings changed since stay (${J(b2)}, ${J(m2)})`);
  check(shown && m2.noticeShown === true && takeNotice(blocked) === null && migrate(blocked, { log: quiet }) === null,
    'the retry does not show the notice again, and once everything is copied later starts import nothing');
}

// ---------- the real app ----------
const root = tempDir('rename-appdata');
const legacy = path.join(root, 'PyIDE');
const userData = path.join(root, 'Nano Studio');
write(path.join(legacy, 'settings.json'), J({
  'appearance.language': 'ko', 'editor.fontSize': 17, 'updates.feedUrl': OLD_FEED, 'updates.channel': 'beta',
  recentProjects: [{ path: 'C:\\old\\project', name: 'project' }, { path: 'C:\\old\\safe-mode', name: 'safe-mode' }],
}, null, 2));
write(path.join(legacy, 'plugin-state.json'), J({ disabled: ['bookmarks'] }));
write(path.join(legacy, 'plugins', 'rename-probe', 'plugin.json'), J({ id: 'rename-probe', name: 'Rename Probe', version: '1.0.0', vendor: 'Nano Studio tests', description: 'Loads to show that user plugins came over.' }));
write(path.join(legacy, 'plugins', 'rename-probe', 'index.js'), 'window.__renameProbe = true;\n');
write(path.join(legacy, 'interpreters.json'), J({ version: 0, probes: {} }));
write(path.join(legacy, 'project-roots.json'), J({ 'c:\\old\\project': { excluded: ['build'] } }));
write(path.join(legacy, 'logs', 'pyide.log'), 'OLD PYIDE LOG LINE\n');
write(path.join(legacy, 'semantic', 'index.bin'), 'cache');
write(path.join(legacy, 'local-history', 'index.json'), '{}');
// The second recent project was kept in Safe Mode: it is not in the trusted list.
write(path.join(legacy, 'trusted-projects.json'), J(['c:\\old\\project']));
const before = snapshot(legacy);

const t = await launch({ fixture: 'core', port: 9905, name: 'rename-migration', userData });
let failedEarly = null;
try {
  const { js, until, shot } = t;
  check(await js(`ide.settings.get('editor.fontSize')`) === 17 && await js(`document.documentElement.lang`) === 'ko',
    'the first window already has the PyIDE settings: editor font 17, Korean UI');
  check(await js(`ide.settings.get('updates.channel')`) === 'beta' && await js(`ide.settings.get('updates.feedUrl', null)`) === null,
    "the update channel came over; PyIDE's own update feed did not");
  check(await js(`window.__renameProbe === true`), 'the user plugin from PyIDE\\plugins loads');
  check(await js(`ide.api.invoke('plugins:list').then((l) => l.find((p) => p.id === 'bookmarks')?.enabled === false)`), 'the plugin PyIDE had turned off is still off');
  await until(`ide.notifications.list().some((n) => n.title === 'PyIDE 설정을 가져왔어요')`, 'migration notification');
  const note = await js(`(({ title, text, kind }) => ({ title, text, kind }))(ide.notifications.list().find((n) => n.title === 'PyIDE 설정을 가져왔어요'))`);
  check(note.text.includes(legacy) && note.text.includes('그대로'), `the one-time notification says "PyIDE 설정을 가져왔어요" and where from (${note.text})`);
  await shot('migrated-notice.png');
  for (const f of ['plugin-state.json', 'interpreters.json', 'project-roots.json', 'trusted-projects.json']) check(existsSync(path.join(userData, f)), `${f} was copied`);
  check(readJson(path.join(userData, 'project-roots.json'))['c:\\old\\project']?.excluded?.[0] === 'build', 'project-roots.json has PyIDE\'s content');
  const trusted = path.join(userData, 'trusted-projects.json');
  check(!existsSync(path.join(userData, 'semantic', 'index.bin')) && !existsSync(path.join(userData, 'local-history', 'index.json'))
    && !readFileSync(path.join(userData, 'logs', 'pyide.log'), 'utf8').includes('OLD PYIDE LOG LINE'), 'logs, caches and local history stay behind');
  check(J(readJson(trusted)) === J(['c:\\old\\project']),
    `the trusted projects come over as they were: a recent project PyIDE kept in Safe Mode is not trusted now (${readFileSync(trusted, 'utf8').trim()})`);
  const log = readFileSync(path.join(userData, 'logs', 'pyide.log'), 'utf8');
  check(/#migrate.*imported plugin-state\.json, interpreters\.json, project-roots\.json, trusted-projects\.json, plugins, settings\.json from /.test(log), 'the IDE log records the import');
  check(readJson(path.join(userData, MARKER)).noticeShown === true, 'the marker says the notice was shown');
  check(J(snapshot(legacy)) === J(before), 'nothing in the PyIDE folder was changed, moved or deleted');
  // Visible names.
  check((await js(`document.title`)).endsWith(' - Nano Studio Code'), `the window title ends with "Nano Studio Code" (${await js('document.title')})`);
  check(await js(`document.querySelector('#welcome h1').textContent`) === 'Nano Studio', 'the welcome heading is Nano Studio');
  await js(`(ide.runAction('AboutPyIDE'), true)`);
  await until(`document.querySelector('.diag-about-dialog')`, 'About dialog');
  check(await js(`document.querySelector('.diag-about-dialog .dialog-title').textContent`) === 'Nano Studio 정보'
    && await js(`document.querySelector('.diag-about-dialog h2').textContent`) === 'Nano Studio Code', 'About is "Nano Studio 정보" and names Nano Studio Code');
  await shot('about-ko.png');
} catch (err) {
  failedEarly = err;
  check(false, `first start: ${err.message.split('\n')[0]}`);
}
t.close();

// Second start on the same user data: no second import, no second notification.
if (!failedEarly) {
  const t2 = await launch({ fixture: 'core', port: 9906, name: 'rename-migration-again', userData });
  try {
    await t2.sleep(1500);
    check(!(await t2.js(`ide.notifications.list().some((n) => n.title === 'PyIDE 설정을 가져왔어요')`)), 'the second start shows no import notification');
    const log = readFileSync(path.join(userData, 'logs', 'pyide.log'), 'utf8');
    check((log.match(/#migrate.*imported /g) || []).length === 1, 'and imports nothing again');
    check(await t2.js(`ide.settings.get('editor.fontSize')`) === 17, 'the imported settings stay');
  } catch (err) { check(false, `second start: ${err.message.split('\n')[0]}`); }
  t2.close();
}
check(J(snapshot(legacy)) === J(before), 'after both starts the PyIDE folder is as it was');

const consoleErrors = t.consoleErrors;
if (consoleErrors.length) console.log(`renderer exceptions:\n  ${consoleErrors.join('\n  ')}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed || consoleErrors.length ? 1 : 0);
