// File › Manage IDE Settings › Export Settings… / Import Settings… (renderer/features/settings-sync,
// main/features/settings-sync.js, main/settings-sync/). Instance A changes settings, the keymap, a live template, a
// plugin's state, adds a data source with a password and a scratch file, and exports through the menu (the Save dialog
// is answered through PYIDE_SETTINGS_SYNC_DIALOG). The archive is checked as plain Node: manifest, entries, nothing
// secret or machine-specific. Instance B (fresh user data, with its own conflicting state) imports it: everything
// arrived, the password did not, the backup zip exists; a damaged zip, a zip without a manifest, a newer format and
// zip-slip entries are refused with a message and change nothing; paths the dialogs did not return are refused.
// Then B restarts in Korean: the disabled plugin stays unloaded, the menu and dialogs are translated. Ports 9200-9202.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const require = createRequire(import.meta.url);
const archive = require('../main/settings-sync/archive.js');
const unzip = require('../main/settings-sync/unzip.js');
const { zip } = require('../main/diagnostics/zip.js');
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const S = JSON.stringify;
const PASSWORD = 'Pg-Secret-Password-7319';
const work = mkdtempSync(path.join(tmpdir(), 'pyide-settings-sync-'));
const dialogFile = path.join(work, 'dialog.json');
const answer = (o) => writeFileSync(dialogFile, S(o));
const env = { PYIDE_SETTINGS_SYNC_DIALOG: dialogFile };
const exported = path.join(work, 'out', 'settings.zip');
answer({});

// ---------- helpers ----------
const topDialog = `[...document.querySelectorAll('#dialogHost .dialog')].pop()`;
const rows = (t) => t.js(`[...${topDialog}.querySelectorAll('.settings-sync-row')].map(r => { const b = r.querySelector('input'); return { id: b.dataset.category, checked: b.checked, disabled: b.disabled, label: r.querySelector('.settings-sync-name').textContent, detail: r.querySelector('.settings-sync-detail').textContent }; })`);
const dialogText = (t) => t.js(`${topDialog}?.textContent || ''`);
const pressPrimary = (t) => t.js(`(${topDialog}.querySelector('.dialog-buttons .primary').click(), true)`);
const pressButton = (t, label) => t.js(`(() => { const b = [...${topDialog}.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${S(label)}); b?.click(); return !!b; })()`);
const dialogCount = (t) => t.js(`document.querySelectorAll('#dialogHost .dialog').length`);
async function closeDialogs(t) {
  for (let i = 0; i < 5 && (await dialogCount(t)); i++) { await t.press('Escape'); await t.sleep(100); }
}
// Main menu: File › Manage IDE Settings › …; returns the labels of each submenu level opened.
async function menuPath(t, labels) {
  await t.click('#mainMenuBtn');
  await t.until(`!!document.querySelector('#mainMenu')`, 'main menu');
  const seen = [];
  for (let level = 0; level < labels.length; level++) {
    const found = await t.js(`(() => { const m = [...document.querySelectorAll('.context-menu')][${level}]; const n = [...m.querySelectorAll('.menu-item')].find(n => n.querySelector('.menu-label')?.textContent === ${S(labels[level])}); n?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); return !!n; })()`);
    if (!found) return seen;
    await t.until(`document.querySelectorAll('.context-menu').length > ${level + 1}`, `submenu ${labels[level]}`);
    seen.push(await t.js(`[...[...document.querySelectorAll('.context-menu')][${level + 1}].querySelectorAll('.menu-item .menu-label')].map(n => n.textContent)`));
  }
  return seen;
}
const readZip = (file) => {
  const z = unzip.open(readFileSync(file));
  return { z, names: z.entries.map((e) => e.name), json: (n) => JSON.parse(z.read(n).toString('utf8')), text: () => z.entries.filter((e) => !e.dir).map((e) => z.read(e.name).toString('utf8')).join('\n') };
};

// ---------- crafted ZIP bombs ----------
// Rewrites the central directory of a zip() buffer: edit(records) gets [{head: Buffer(46), name}] and returns the list.
function rewriteCentral(buf, edit) {
  const eocd = buf.length - 22;
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const recs = [];
  for (let p = cdOffset, i = 0; i < count; i++) {
    const n = buf.readUInt16LE(p + 28);
    recs.push({ head: Buffer.from(buf.subarray(p, p + 46)), name: buf.toString('utf8', p + 46, p + 46 + n) });
    p += 46 + n;
  }
  const out = edit(recs);
  const central = Buffer.concat(out.flatMap((r) => {
    const name = Buffer.from(r.name, 'utf8');
    const head = Buffer.from(r.head);
    head.writeUInt16LE(name.length, 28);
    return [head, name];
  }));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(out.length, 8);
  end.writeUInt16LE(out.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([buf.subarray(0, cdOffset), central, end]);
}
const withSize = (r, size) => { const head = Buffer.from(r.head); head.writeUInt32LE(size, 24); return { ...r, head }; };
const bombManifest = { name: 'pyide-settings.json', data: S({ format: 1, product: 'PyIDE', version: '0.2.2', created: new Date().toISOString(), categories: { appearance: { count: 1 }, scratches: { count: 1 } } }) };
const bombFont = { name: 'settings/appearance.json', data: S({ 'editor.fontSize': 31 }) };
// 1 MB of zeros (about 1 KB deflated) and n central entries that all point at its one local header: n MB from a few KB.
const overlapBomb = (n) => rewriteCentral(zip([bombManifest, bombFont, { name: 'scratches/b0.py', data: Buffer.alloc(2 ** 20) }]),
  (recs) => [...recs, ...Array.from({ length: n - 1 }, (_, i) => ({ head: recs[2].head, name: `scratches/b${i + 1}.py` }))]);
// n separate one-byte entries that each declare `each` bytes (open() refuses before inflating anything).
const declaredBomb = (n, each) => rewriteCentral(zip([bombManifest, bombFont, ...Array.from({ length: n }, (_, i) => ({ name: `scratches/big${i}.py`, data: 'x' }))]),
  (recs) => recs.map((r) => (r.name.startsWith('scratches/') ? withSize(r, each) : r)));
const MB = 2 ** 20;
const timed = (fn) => { const t0 = performance.now(); try { fn(); return { ms: performance.now() - t0 }; } catch (err) { return { err, ms: performance.now() - t0 }; } };
const timedAsync = async (fn) => { const t0 = performance.now(); try { await fn(); return { ms: performance.now() - t0 }; } catch (err) { return { err, ms: performance.now() - t0 }; } };

// ================= instance A: change things, export =================
let t = await launch({ fixture: 'core', port: 9200, name: 'settings-sync-a', env });
try {
  const { js, until, check } = t;
  await until(`ide.actions.some(a => a.id === 'ExportSettings') && !!ide.database && !!ide.scratches && !!ide.liveTemplates`, 'plugins ready');

  // ---------- pure Node: the key table ----------
  const cls = (k, v) => archive.classify(k, v).category;
  check(cls('editor.fontSize', 14) === 'appearance' && cls('appearance.theme', 'dark') === 'appearance' && cls('autosave.onIdle', true) === 'appearance', 'editor, appearance and auto save keys are appearance settings');
  check(cls('editor.tabSize', 4) === 'codeStyle' && cls('editor.ruler', 120) === 'codeStyle' && cls('tools.ruffLineLength', 88) === 'codeStyle', 'tab size, ruler and ruff line length are code style');
  check(cls('keymap.overrides', {}) === 'keymap' && cls('liveTemplates.custom', {}) === 'liveTemplates' && cls('recentProjects', []) === 'recentProjects', 'keymap, live templates and recent projects have their own categories');
  const never = ['interpreters.extra', 'interpreters.remote', 'terminal.shell', 'updates.feedUrl', 'updates.skippedVersion', 'aiComplete.snoozeUntil', 'pyconsole.history', 'projectTree.expanded', 'interpreter.C:\\proj', 'runConfigs:C:\\proj', 'bookmarks.C:\\proj', 'httpClient.env.c:\\proj', 'ai.apiKey', 'aiChat.token', 'someNewFeature.flag'];
  check(never.every((k) => cls(k, 'x') === null), `machine-specific, per-project, secret and unclassified keys are never exported (${never.filter((k) => cls(k, 'x') !== null)})`);
  check(cls('viewers.htmlMode', 'C:\\Users\\me\\x.html') === null, 'a preference whose value is an absolute path stays on this computer');
  const unsafe = ['../evil.txt', 'scratches/../../evil.txt', '/abs.txt', 'C:/evil.txt', 'scratches\\..\\evil.txt', 'scratches/a:stream', 'scratches/CON', 'scratches/./x'];
  check(unsafe.every((n) => archive.unsafeName(n)) && !archive.unsafeName('scratches/sub/a b.py') && !archive.unsafeName('settings/appearance.json'), 'zip-slip, absolute, drive, backslash, stream and device names are unsafe');

  // ---------- change things in A ----------
  await js(`(() => {
    ide.settings.set('editor.fontSize', 19);
    ide.settings.set('appearance.theme', 'light');
    ide.settings.set('editor.tabSize', 2);
    ide.settings.set('tools.ruffLineLength', 100);
    ide.settings.set('interpreters.extra', ['C:\\\\FakePython\\\\python.exe']);
    ide.settings.set('updates.skippedVersion', '9.9.9');
    ide.settings.set('updates.feedUrl', 'C:\\\\LocalFeed');
    ide.settings.set('terminal.shell', 'cmd');
    ide.settings.set('pyconsole.history', ['print("typed in A")']);
    ide.settings.set('keymap.overrides', { GotoLine: ['Ctrl+Alt+Shift+G'] });
    ide.settings.set('liveTemplates.custom', { sszz: { description: 'settings sync test', body: 'print("from A")$END$' }, conflict: { description: 'A', body: 'A version$END$' } });
    ide.settings.set('liveTemplates.postfixDisabled', ['nn']);
    ide.settings.flush();
    return true;
  })()`);
  await until(`ide.actions.find(a => a.id === 'GotoLine')?.keys?.includes('Ctrl+Alt+Shift+G')`, 'GotoLine rebound in A');
  await js(`ide.api.invoke('plugins:setEnabled', 'spellcheck', false)`);
  const pgId = await js(`ide.database.addDataSource({ kind: 'postgres', name: 'SyncPG', host: 'db.example.test', port: 5433, user: 'alice', password: ${S(PASSWORD)}, database: 'shop' })`);
  check((await js(`ide.api.invoke('db:list')`)).find((s) => s.id === pgId)?.hasPassword === true, 'A: the data source has a stored password');
  await js(`ide.api.invoke('scratches:create', 'py', 'print("scratch from A")')`);

  // ---------- menu ----------
  const menus = await menuPath(t, ['File', 'Manage IDE Settings']);
  check(menus[0]?.includes('Manage IDE Settings') && menus[0].indexOf('Manage IDE Settings') === menus[0].indexOf('Settings…') + 1, `File lists Manage IDE Settings after Settings… (${menus[0]?.join(', ')})`);
  check(S(menus[1]) === S(['Import Settings…', 'Export Settings…']), `Manage IDE Settings › Import Settings…, Export Settings… (${menus[1]})`);
  await t.js(`(() => { const n = [...[...document.querySelectorAll('.context-menu')][2].querySelectorAll('.menu-item')].find(n => n.querySelector('.menu-label').textContent === 'Export Settings…'); n.classList.add('pick-me'); return true; })()`);
  answer({ save: exported });
  await t.click('.context-menu .menu-item.pick-me');

  // ---------- export dialog ----------
  await until(`!!${topDialog}?.querySelector('.settings-sync-list')`, 'export dialog');
  check((await js(`${topDialog}.querySelector('.dialog-title').textContent`)) === 'Export Settings', 'the dialog is titled Export Settings');
  const ex = await rows(t);
  const byId = Object.fromEntries(ex.map((r) => [r.id, r]));
  check(S(ex.map((r) => r.id)) === S(archive.CATEGORIES), `all categories are listed in order (${ex.map((r) => r.id)})`);
  check(['appearance', 'keymap', 'liveTemplates', 'codeStyle', 'plugins', 'dataSources', 'scratches'].every((id) => byId[id].checked && !byId[id].disabled), 'every category with content is ticked');
  check(byId.recentProjects && !byId.recentProjects.checked && !byId.recentProjects.disabled, 'Recent projects list is offered unticked');
  check(byId.dataSources.label === 'Database data sources (without passwords)' && byId.scratches.detail.startsWith('1 files'), `labels and details (${byId.dataSources.label}; ${byId.scratches.detail})`);
  check(byId.plugins.detail === '1 disabled' && byId.keymap.detail === '1 changed actions', `plugin and keymap counts (${byId.plugins.detail}; ${byId.keymap.detail})`);
  await t.shot('export-dialog.png');
  await pressPrimary(t);
  await until(`!!${topDialog}?.querySelector('.settings-sync-message.done')`, 'export finished');
  check((await dialogText(t)).includes(exported), 'the result names the exported file');
  await closeDialogs(t);
  check(existsSync(exported), 'settings.zip was written where the Save dialog said');

  // ---------- the archive ----------
  const a = readZip(exported);
  const manifest = a.json('pyide-settings.json');
  check(manifest.format === 1 && manifest.product === 'PyIDE' && manifest.version === VERSION && !Number.isNaN(Date.parse(manifest.created)), `manifest: format 1, PyIDE ${manifest.version}, date ${manifest.created}`);
  check(S(Object.keys(manifest.categories)) === S(['appearance', 'keymap', 'liveTemplates', 'codeStyle', 'plugins', 'dataSources', 'scratches']), `manifest categories (${Object.keys(manifest.categories)})`);
  check(['settings/appearance.json', 'keymap.json', 'live-templates.json', 'settings/code-style.json', 'plugins.json', 'database/sources.json', 'scratches/scratch.py'].every((n) => a.names.includes(n)) && !a.names.includes('recent-projects.json'),
    `entries (${a.names.join(', ')})`);
  const appearance = a.json('settings/appearance.json');
  check(appearance['editor.fontSize'] === 19 && appearance['appearance.theme'] === 'light' && !('editor.tabSize' in appearance), 'appearance.json holds the font size and theme, not code style');
  check(a.json('settings/code-style.json')['editor.tabSize'] === 2 && a.json('settings/code-style.json')['tools.ruffLineLength'] === 100, 'code-style.json holds tab size and ruff line length');
  const all = a.text();
  check(!all.includes(PASSWORD), 'the data source password is nowhere in the archive');
  check(!/"secret"|safeStorage|"enc"/.test(all), 'no encrypted password blob is in the archive');
  check(!all.includes('FakePython') && !all.includes('9.9.9') && !all.includes('LocalFeed') && !all.includes('typed in A') && !/"terminal\.shell"/.test(all), 'interpreter paths, skipped version, update feed, console history and shell are not exported');
  const src = a.json('database/sources.json').sources.find((s) => s.name === 'SyncPG');
  check(src && src.hasPassword === false && src.host === 'db.example.test' && src.user === 'alice' && !('password' in src), `the data source is exported with hasPassword: false (${S(src)})`);
  check(S(a.json('plugins.json').disabled) === S(['spellcheck']), 'plugins.json lists spellcheck as disabled');
  check(S(a.json('keymap.json')) === S({ GotoLine: ['Ctrl+Alt+Shift+G'] }), 'keymap.json holds the override');

  // ---------- paths the dialog did not return ----------
  const evil = path.join(work, 'evil.zip');
  const refused = await js(`ide.api.invoke('settings:export', ${S(evil)}, ['appearance'])`);
  check(refused.ok === false && refused.code === 'notChosen' && !existsSync(evil), 'settings:export refuses a path the Save dialog did not return');
  const refusedImport = await js(`ide.api.invoke('settings:import', ${S(exported)}, ['appearance'])`);
  check(refusedImport.ok === false && refusedImport.code === 'notChosen', 'settings:import refuses a path the Open dialog did not return');
} catch (err) {
  t.check(false, `instance A: ${err.message}`);
} finally {
  t.close();
}
const resultsA = t.results;
const errorsA = t.consoleErrors;

// ================= pure Node: a hostile archive's keys are filtered =================
{
  const ud = mkdtempSync(path.join(work, 'hostile-ud-'));
  const file = path.join(work, 'hostile.zip');
  writeFileSync(file, zip([
    { name: 'pyide-settings.json', data: S({ format: 1, product: 'PyIDE', version: '0.2.2', categories: { appearance: { count: 3 }, dataSources: { count: 1 } } }) },
    { name: 'settings/appearance.json', data: S({ 'editor.fontSize': 15, 'interpreters.extra': ['C:\\evil\\python.exe'], 'updates.feedUrl': 'https://evil.example/', '__proto__': { polluted: true } }) },
    { name: 'database/sources.json', data: S({ sources: [{ id: 'x1', kind: 'postgres', name: 'H', host: 'h', secret: { enc: 'plain', data: 'cHc=' }, password: 'pw' }] }) },
  ]));
  const r = await archive.apply(ud, file, ['appearance', 'dataSources'], {});
  resultsA.push({ ok: S(r.settings) === S({ 'editor.fontSize': 15 }), label: `a crafted archive cannot set interpreter paths or the update feed (${S(r.settings)})` });
  const saved = JSON.parse(readFileSync(path.join(ud, 'database', 'sources.json'), 'utf8')).sources[0];
  resultsA.push({ ok: saved && !saved.secret && !saved.password && saved.host === 'h', label: 'with the Database plugin off, sources.json gets the source without any password or secret' });
}
const pureStart = resultsA.length;
// ================= pure Node: ZIP bombs are refused before anything is inflated =================
{
  const pass = (ok, label) => resultsA.push({ ok: !!ok, label });
  // unzip.open on crafted buffers, timed: each refusal must take well under a second.
  for (const n of [100, 4000]) {
    const buf = overlapBomb(n);
    const r = timed(() => unzip.open(buf));
    pass(r.err?.code === 'overlap' && r.ms < 1000, `unzip.open: ${n} entries sharing one local header (${buf.length} bytes declaring ${n} MB) are refused as overlapping in ${r.ms.toFixed(1)} ms (${r.err?.code}: ${r.err?.message})`);
  }
  const many = timed(() => unzip.open(overlapBomb(6000)));
  pass(many.err?.code === 'tooManyEntries' && many.err.count === 6002 && many.err.limit === 5000 && many.ms < 1000, `unzip.open: 6002 entries are refused (at most 5000) in ${many.ms.toFixed(1)} ms (${many.err?.message})`);
  const total = timed(() => unzip.open(declaredBomb(10, 60 * MB), { maxEntryBytes: 64 * MB }));
  pass(total.err?.code === 'tooLarge' && total.err.size > 512 * MB && total.err.limit === 512 * MB && total.ms < 1000, `unzip.open: entries declaring 600 MB in all are refused (at most 512 MB) in ${total.ms.toFixed(1)} ms (${total.err?.message})`);
  const one = timed(() => unzip.open(declaredBomb(1, 300 * MB)));
  pass(one.err?.code === 'tooLarge' && one.err.limit === 256 * MB && one.ms < 1000, `unzip.open: one entry declaring 300 MB is refused (at most 256 MB) in ${one.ms.toFixed(1)} ms`);
  // A real deflate bomb that lies about its size: inflating stops at the declared size.
  const liar = unzip.open(rewriteCentral(zip([bombManifest, { name: 'scratches/z.py', data: Buffer.alloc(200 * MB) }]), (recs) => recs.map((r, i) => (i === 1 ? withSize(r, 1000) : r))));
  const lie = await timedAsync(() => liar.readAsync('scratches/z.py'));
  pass(lie.err?.code === 'notZip' && lie.ms < 1000, `an entry inflating past its declared size (1000 bytes of 200 MB) stops there in ${lie.ms.toFixed(1)} ms`);
  const ok = unzip.open(zip([bombManifest, bombFont]));
  pass(ok.read('settings/appearance.json').toString() === bombFont.data && (await ok.readAsync('settings/appearance.json')).toString() === bombFont.data, 'a normal archive still reads, sync and async');

  // archive.apply / inspect: refused quickly, nothing written to user data.
  const refusedApply = async (name, buf, code) => {
    const ud = mkdtempSync(path.join(work, `bomb-ud-${name}-`));
    const file = path.join(work, `bomb-${name}.zip`);
    writeFileSync(file, buf);
    const r = await timedAsync(() => archive.apply(ud, file, archive.CATEGORIES, {}));
    const i = timed(() => archive.inspect(file));
    pass(r.err?.code === code && i.err?.code === code && r.ms < 1000 && readdirSync(ud).length === 0,
      `apply refuses ${name} with ${r.err?.code} in ${r.ms.toFixed(1)} ms, inspect too, and writes nothing (${r.err?.message}; ${readdirSync(ud)})`);
  };
  await refusedApply('4000 entries sharing one offset', overlapBomb(4000), 'overlap');
  await refusedApply('600 MB declared in all', declaredBomb(10, 60 * MB), 'tooLarge');
  await refusedApply('300 MB of scratch files', declaredBomb(5, 60 * MB), 'tooLarge');
  await refusedApply('1001 scratch files', zip([bombManifest, ...Array.from({ length: 1001 }, (_, i) => ({ name: `scratches/s${i}.py`, data: 'x' }))]), 'tooManyEntries');
  await refusedApply('a 20 MB settings file', rewriteCentral(zip([bombManifest, bombFont]), (recs) => recs.map((r, i) => (i === 1 ? withSize(r, 20 * MB) : r))), 'tooLarge');
  let pending = null;
  try { pending = archive.apply(mkdtempSync(path.join(work, 'async-')), path.join(work, 'missing.zip'), []); } catch {}
  pass(pending instanceof Promise, 'apply() is asynchronous (entries inflate on the thread pool)');
  await pending?.catch(() => {});

  // Data sources with the Database plugin off: the local password stays only for the same server and user.
  const ud = mkdtempSync(path.join(work, 'secret-ud-'));
  const local = { id: 'pg1', kind: 'postgres', name: 'PG', host: 'db.example.test', port: 5433, user: 'alice', database: 'shop', secret: { enc: 'plain', data: 'cHc=' } };
  const same = { ...local, id: 'pg2', name: 'PG2', host: 'same.example.test' };
  mkdirSync(path.join(ud, 'database'), { recursive: true });
  writeFileSync(path.join(ud, 'database', 'sources.json'), S({ version: 1, sources: [local, same] }));
  const file = path.join(work, 'moved-host.zip');
  writeFileSync(file, zip([
    { name: 'pyide-settings.json', data: S({ format: 1, product: 'PyIDE', version: '0.2.2', categories: { dataSources: { count: 2 } } }) },
    { name: 'database/sources.json', data: S({ version: 1, sources: [{ ...local, secret: undefined, host: 'evil.example' }, { ...same, secret: undefined, name: 'PG2 renamed', hasPassword: false }] }) },
  ]));
  await archive.apply(ud, file, ['dataSources'], {});
  const saved = JSON.parse(readFileSync(path.join(ud, 'database', 'sources.json'), 'utf8')).sources;
  pass(saved.find((s) => s.id === 'pg1')?.host === 'evil.example' && !saved.find((s) => s.id === 'pg1').secret, 'an imported source with a local id but another host arrives without the local password');
  pass(saved.find((s) => s.id === 'pg2')?.name === 'PG2 renamed' && saved.find((s) => s.id === 'pg2').secret?.data === 'cHc=', 'an imported source with a local id and the same server keeps the local password');
}
for (const r of resultsA.slice(pureStart - 2)) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.label}`);

// ================= instance B: fresh user data, import =================
t = await launch({ fixture: 'core', port: 9201, name: 'settings-sync-b', env });
const userDataB = t.userData;
t.results.push(...resultsA);
t.consoleErrors.push(...errorsA);
try {
  const { js, until, check } = t;
  await until(`ide.actions.some(a => a.id === 'ImportSettings') && !!ide.database && !!ide.scratches && !!ide.liveTemplates`, 'plugins ready in B');
  // B's own state: a conflicting template, one of its own, its own keymap change, a setting A never touched, a scratch.
  await js(`(() => {
    ide.settings.set('liveTemplates.custom', { conflict: { description: 'B', body: 'B version$END$' }, bonly: { description: 'B only', body: 'kept$END$' } });
    ide.settings.set('keymap.overrides', { SaveAll: ['Ctrl+Alt+Shift+S'] });
    ide.settings.set('editor.lineHeight', 2);
    ide.settings.flush();
    return true;
  })()`);
  await js(`ide.api.invoke('scratches:create', 'py', 'print("B own scratch")')`);
  check((await js(`ide.api.invoke('plugins:list')`)).find((p) => p.id === 'spellcheck')?.enabled === true, 'B starts with spellcheck enabled');

  // ---------- import ----------
  answer({ open: exported });
  await js(`(ide.runAction('ImportSettings'), true)`);
  await until(`!!${topDialog}?.querySelector('.settings-sync-list')`, 'import dialog');
  const im = await rows(t);
  check(S(im.map((r) => r.id)) === S(['appearance', 'keymap', 'liveTemplates', 'codeStyle', 'plugins', 'dataSources', 'scratches']) && im.every((r) => r.checked),
    `the import dialog lists the archive's categories, ticked (${im.map((r) => r.id)})`);
  check((await dialogText(t)).includes(`Settings exported from PyIDE ${VERSION} on`), 'the import dialog says which PyIDE exported the settings and when');
  await t.shot('import-dialog.png');
  await pressPrimary(t);
  await until(`!!${topDialog}?.querySelector('.settings-sync-message.done')`, 'import finished');
  const done = await dialogText(t);
  check(done.includes('Live templates replaced by the imported ones: conflict'), 'the result names the live template that was replaced');
  check(done.includes('1 scratch files added') && done.includes('settings-backups'), 'the result reports the scratch file and the backup');
  check(await js(`[...${topDialog}.querySelectorAll('.dialog-buttons button')].map(b => b.textContent).join('|') === 'Restart|Not Now'`), 'Restart is offered, with Not Now');
  await t.shot('import-done.png');
  await pressButton(t, 'Not Now');
  await until(`!document.querySelector('#dialogHost .dialog')`, 'result closed');

  // ---------- what arrived ----------
  const get = (k) => js(`ide.settings.get(${S(k)})`);
  check(await get('editor.fontSize') === 19 && await get('appearance.theme') === 'light', 'font size and theme arrived');
  check(await get('editor.tabSize') === 2 && await get('tools.ruffLineLength') === 100, 'code style arrived');
  check(await get('editor.lineHeight') === 2, "B's own setting that A never changed is kept");
  check(await get('interpreters.extra') == null && await get('updates.skippedVersion') == null && await get('updates.feedUrl') == null && await get('terminal.shell') == null && await get('pyconsole.history') == null,
    'machine-specific settings did not arrive');
  check(await js(`ide.actions.find(a => a.id === 'GotoLine').keys.includes('Ctrl+Alt+Shift+G')`), 'the keymap override applies at once');
  check(S(await get('keymap.overrides')) === S({ GotoLine: ['Ctrl+Alt+Shift+G'] }), "the keymap overrides were replaced (B's SaveAll change is gone)");
  const tpl = await js(`Object.fromEntries(ide.liveTemplates.templates().filter(t => ['sszz', 'conflict', 'bonly'].includes(t.abbr)).map(t => [t.abbr, t.body]))`);
  check(tpl.sszz === 'print("from A")$END$' && tpl.conflict === 'A version$END$' && tpl.bonly === 'kept$END$', `live templates: added, conflict imported wins, B's own kept (${S(tpl)})`);
  check(S(await get('liveTemplates.postfixDisabled')) === S(['nn']), 'postfix switches arrived');
  const state = JSON.parse(readFileSync(path.join(userDataB, 'plugin-state.json'), 'utf8'));
  check(state.disabled.includes('spellcheck'), 'plugin-state.json now disables spellcheck');
  check((await js(`ide.api.invoke('plugins:list')`)).find((p) => p.id === 'spellcheck')?.enabled === false, 'Settings › Plugins sees spellcheck disabled (restart required)');
  const srcB = (await js(`ide.api.invoke('db:list')`)).find((s) => s.name === 'SyncPG');
  check(srcB && srcB.hasPassword === false && srcB.host === 'db.example.test' && srcB.port === 5433 && srcB.user === 'alice', `the data source arrived without a password (${S(srcB)})`);
  check(await js(`ide.database.list().some(s => s.name === 'SyncPG')`), 'the Database tool window lists it');
  const sourcesText = readFileSync(path.join(userDataB, 'database', 'sources.json'), 'utf8');
  check(!sourcesText.includes(PASSWORD) && !sourcesText.includes('"secret"'), "B's sources.json holds no password");
  const scratchB = path.join(userDataB, 'scratches');
  check(readFileSync(path.join(scratchB, 'scratch_1.py'), 'utf8') === 'print("scratch from A")' && readFileSync(path.join(scratchB, 'scratch.py'), 'utf8') === 'print("B own scratch")',
    "A's scratch.py arrived as scratch_1.py next to B's own scratch.py");
  const backups = readdirSync(path.join(userDataB, 'settings-backups')).filter((f) => f.endsWith('.zip'));
  check(backups.length === 1 && /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.zip$/.test(backups[0]), `one backup zip named by date (${backups})`);
  const bk = readZip(path.join(userDataB, 'settings-backups', backups[0]));
  check(bk.json('pyide-settings.json').format === 1 && bk.json('live-templates.json').custom.conflict.body === 'B version$END$' && S(bk.json('keymap.json')) === S({ SaveAll: ['Ctrl+Alt+Shift+S'] }),
    "the backup has the same format and B's state before the import");
  check(archive.inspect(path.join(userDataB, 'settings-backups', backups[0])).categories.length > 0, 'the backup can be imported again');

  // ---------- refused archives ----------
  const tryImport = async (name, data, expect, label) => {
    const file = path.join(work, name);
    writeFileSync(file, data);
    answer({ open: file });
    await js(`(ide.runAction('ImportSettings'), true)`);
    await until(`!!${topDialog}?.querySelector('.settings-sync-message.error, .settings-sync-list')`, `${name} answered`);
    const text = await dialogText(t);
    const listed = await js(`!!${topDialog}.querySelector('.settings-sync-list')`);
    check(!listed && text.includes(expect), `${label} (${text.slice(0, 160)})`);
    await closeDialogs(t);
  };
  const manifestOk = { name: 'pyide-settings.json', data: S({ format: 1, product: 'PyIDE', version: '0.2.2', created: new Date().toISOString(), categories: { appearance: { count: 1 }, scratches: { count: 1 } } }) };
  const fontSize30 = { name: 'settings/appearance.json', data: S({ 'editor.fontSize': 30 }) };
  await tryImport('damaged.zip', 'this is not a zip file at all', 'The file is not a ZIP archive, or it is damaged.', 'a file that is not a zip is refused');
  const truncated = readFileSync(exported).subarray(0, 200);
  await tryImport('truncated.zip', truncated, 'The file is not a ZIP archive, or it is damaged.', 'a truncated zip is refused');
  await tryImport('other.zip', zip([{ name: 'readme.txt', data: 'hello' }]), 'it has no pyide-settings.json', 'a zip without pyide-settings.json is refused');
  await tryImport('newer.zip', zip([{ ...manifestOk, data: S({ format: 99, product: 'PyIDE', version: '9.0.0', categories: { appearance: { count: 1 } } }) }, fontSize30]),
    'exported by a newer PyIDE (9.0.0, format 99)', 'a newer format is refused with a clear message');
  await tryImport('slip.zip', zip([manifestOk, fontSize30, { name: 'scratches/../../evil.txt', data: 'pwned' }]), 'unsafe path, so nothing was imported: scratches/../../evil.txt', 'a zip-slip entry is refused');
  await tryImport('slip2.zip', zip([manifestOk, fontSize30, { name: '..\\evil2.txt', data: 'pwned' }]), 'unsafe path', 'a backslash ..\\ entry is refused');
  await tryImport('slip3.zip', zip([manifestOk, fontSize30, { name: 'C:/evil3.txt', data: 'pwned' }]), 'unsafe path', 'a drive-letter entry is refused');
  const bombAt = performance.now();
  await tryImport('bomb.zip', overlapBomb(4000), 'The archive is malformed: several entries share the same data, as in a ZIP bomb, so nothing was imported.', 'a ZIP bomb (4000 entries sharing one local header) is refused with a clear message');
  const bombMs = performance.now() - bombAt;
  check(bombMs < 5000, `the ZIP bomb is answered quickly (${bombMs.toFixed(0)} ms through the dialog)`);
  await tryImport('total.zip', declaredBomb(10, 60 * MB), 'The archive is too large: 600.0 MB, at most 512.0 MB is allowed.', 'an archive declaring more than 512 MB in all is refused');
  check(['evil.txt', 'evil2.txt', 'evil3.txt'].every((f) => !existsSync(path.join(userDataB, f)) && !existsSync(path.join(path.dirname(userDataB), f)) && !existsSync(path.join(scratchB, f))) && !existsSync('C:\\evil3.txt'),
    'no zip-slip file was written anywhere');
  check(!readdirSync(scratchB).some((f) => /^(b|big)\d+/.test(f)), 'no scratch file of the bombs was written');
  check(await get('editor.fontSize') === 19, 'refused archives changed nothing');
  check(readdirSync(path.join(userDataB, 'settings-backups')).length === 1, 'refused archives made no backup');

  // ---------- data sources: the local password stays only for the same server (Database plugin running) ----------
  const importSources = async (name, sources) => {
    const file = path.join(work, name);
    writeFileSync(file, zip([
      { name: 'pyide-settings.json', data: S({ format: 1, product: 'PyIDE', version: '0.2.2', created: new Date().toISOString(), categories: { dataSources: { count: sources.length } } }) },
      { name: 'database/sources.json', data: S({ version: 1, sources }) },
    ]));
    answer({ open: file });
    await js(`(ide.runAction('ImportSettings'), true)`);
    await until(`!!${topDialog}?.querySelector('.settings-sync-list')`, `${name} import dialog`);
    await pressPrimary(t);
    await until(`!!${topDialog}?.querySelector('.settings-sync-message.done')`, `${name} imported`);
    await pressButton(t, 'Not Now');
    await until(`!document.querySelector('#dialogHost .dialog')`, `${name} result closed`);
  };
  const pgB = { id: srcB.id, kind: 'postgres', name: 'SyncPG', host: 'db.example.test', port: 5433, user: 'alice', database: 'shop' };
  const listedPg = async () => (await js(`ide.api.invoke('db:list')`)).find((s) => s.id === srcB.id);
  await js(`ide.database.addDataSource(${S({ ...pgB, password: 'B-local-password' })})`);
  check((await listedPg())?.hasPassword === true, 'B: SyncPG has a local password');
  await importSources('ui-moved-host.zip', [{ ...pgB, host: 'evil.example' }]);
  const moved = await listedPg();
  check(moved?.host === 'evil.example' && moved.hasPassword === false, `an imported source with the same id but another host arrives without the local password (${S(moved)})`);
  await js(`ide.database.addDataSource(${S({ ...pgB, password: 'B-local-password' })})`);
  await importSources('ui-same-host.zip', [{ ...pgB, name: 'SyncPG renamed' }]);
  const kept = await listedPg();
  check(kept?.name === 'SyncPG renamed' && kept.hasPassword === true, `an imported source with the same id and server keeps the local password (${S(kept)})`);
  check(S(await missingTranslations(t)) === '[]', 'no missing translations');
} catch (err) {
  t.check(false, `instance B: ${err.message}`);
} finally {
  t.close();
}
const resultsB = t.results;
const errorsB = t.consoleErrors;

// ================= B again, in Korean =================
t = await launch({ fixture: 'core', port: 9202, name: 'settings-sync-ko', lang: 'ko-KR', userData: userDataB, env });
t.results.push(...resultsB);
t.consoleErrors.push(...errorsB);
try {
  const { js, until, check } = t;
  await until(`ide.actions.some(a => a.id === 'ImportSettings')`, 'plugins ready (Korean)');
  const plugins = await js(`ide.api.invoke('plugins:list')`);
  check(plugins.find((p) => p.id === 'spellcheck')?.loaded === false, 'after the restart the imported plugin state holds: spellcheck is not loaded');
  check(await js(`ide.settings.get('editor.fontSize') === 19 && ide.settings.get('appearance.theme') === 'light'`), 'imported settings persist across the restart');

  const menus = await menuPath(t, ['파일', 'IDE 설정 관리']);
  check(menus[0]?.includes('IDE 설정 관리'), `File menu: IDE 설정 관리 (${menus[0]?.join(', ')})`);
  check(S(menus[1]) === S(['설정 가져오기…', '설정 내보내기…']), `submenu: 설정 가져오기…, 설정 내보내기… (${menus[1]})`);
  await closeDialogs(t);
  await t.press('Escape');
  await t.press('Escape');

  answer({ save: path.join(work, 'out', 'ko.zip') });
  await js(`(ide.runAction('ExportSettings'), true)`);
  await until(`!!${topDialog}?.querySelector('.settings-sync-list')`, 'Korean export dialog');
  const ko = await rows(t);
  check(ko.find((r) => r.id === 'dataSources')?.label === '데이터베이스 데이터 소스 (비밀번호 제외)' && ko.find((r) => r.id === 'keymap')?.label === '키맵', `Korean category labels (${ko.map((r) => r.label).join(', ')})`);
  check((await js(`${topDialog}.querySelector('.dialog-title').textContent`)) === '설정 내보내기', 'Korean export title');
  const leaks = await englishLeaks(t, '#dialogHost .dialog');
  check(leaks.length === 0, `no English in the export dialog (${S(leaks)})`);
  await t.shot('ko-export-dialog.png');
  await pressPrimary(t);
  await until(`!!${topDialog}?.querySelector('.settings-sync-message.done')`, 'Korean export done');
  check((await dialogText(t)).includes('(으)로 내보냈습니다'), 'Korean export result');
  await closeDialogs(t);

  answer({ open: path.join(work, 'slip.zip') });
  await js(`(ide.runAction('ImportSettings'), true)`);
  await until(`!!${topDialog}?.querySelector('.settings-sync-message.error')`, 'Korean import error');
  const err = await dialogText(t);
  check(err.includes('안전하지 않은 경로') && err.includes('설정 가져오기'), `Korean zip-slip message (${err})`);
  await closeDialogs(t);

  answer({ open: exported });
  await js(`(ide.runAction('ImportSettings'), true)`);
  await until(`!!${topDialog}?.querySelector('.settings-sync-list')`, 'Korean import dialog');
  const koLeaks = await englishLeaks(t, '#dialogHost .dialog');
  check(koLeaks.length === 0 && (await dialogText(t)).includes('가져올 설정을 선택하세요'), `Korean import dialog (${S(koLeaks)})`);
  await t.shot('ko-import-dialog.png');
  await closeDialogs(t);
  check(S(await missingTranslations(t)) === '[]', `no missing Korean translations (${S(await missingTranslations(t))})`);
} catch (err) {
  t.check(false, `Korean: ${err.message}`);
}
t.finish();
