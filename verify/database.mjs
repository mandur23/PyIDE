// Database plugin end to end over SQLite: data source dialog, Test Connection, query console (Ctrl+Enter on the
// statement at the caret, errors, grid, CSV copy), schema tree, Open Data, restart persistence, password secrecy,
// opening a .sqlite file from the project, the missing-driver flow for PostgreSQL, and Korean UI.
// DB_REAL=1 also downloads the pg driver through the dialog into a temp driver directory.
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const REAL = process.env.DB_REAL === '1';
process.env.PYIDE_DB_DRIVERS = mkdtempSync(path.join(tmpdir(), 'pyide-db-drivers-'));
const SECRET = 'pg-s3cret-Zq9';
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;

// Clicks the first element matching `selector` whose text includes `text` (real mouse events).
async function clickText(t, selector, text) {
  await t.until(`[...document.querySelectorAll(${q(selector)})].some(n => n.textContent.includes(${q(text)}))`, `${selector} "${text}"`);
  await t.js(`(() => { document.querySelectorAll('[data-test-target]').forEach(n => n.removeAttribute('data-test-target')); [...document.querySelectorAll(${q(selector)})].find(n => n.textContent.includes(${q(text)})).dataset.testTarget = '1'; return true; })()`);
  await t.click('[data-test-target="1"]');
}
async function rightClickText(t, selector, text) {
  await t.until(`[...document.querySelectorAll(${q(selector)})].some(n => n.textContent.includes(${q(text)}))`, `${selector} "${text}"`);
  const box = await t.js(`(() => { const r = [...document.querySelectorAll(${q(selector)})].find(n => n.textContent.includes(${q(text)})).getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await t.sleep(80);
}
const setInput = (t, selector, value) => t.js(`(() => { const n = document.querySelector(${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const consoleOf = (name) => `ide.database.list().find(s => s.name === ${q(name)})`;
const activeConsole = `document.querySelector('.custom-tab:not(.hidden) .db-console, .custom-tab.db-console:not(.hidden)')`;
const status = (t) => t.js(`${activeConsole}?.querySelector('.db-result-status').textContent`);
// Puts the caret on a line of the visible console and presses Ctrl+Enter like a user.
async function runLine(t, line, column = 3) {
  await t.js(`(() => { const c = ide.database.activeConsole(); c.editor.focus(); c.editor.setPosition({ lineNumber: ${line}, column: ${column} }); return true; })()`);
  const before = await t.js(`ide.database.activeConsole().runs`);
  await t.press('Ctrl+Enter');
  await t.until(`ide.database.activeConsole().runs > ${before}`, `statement on line ${line} ran`);
}

const SQL = [
  'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);',
  "INSERT INTO users (name, email) VALUES ('Lovelace, Ada', 'ada@example.com; primary'), ('Linus', NULL);",
  'SELECT * FROM users ORDER BY id;',
  'SELECT * FROM missing_table;',
].join('\n');

let a;
try {
  a = await launch({ fixture: 'database', port: 9600, name: 'database' });
  const dbFile = path.join(a.project, 'app.sqlite');

  // ---------- add a SQLite data source through the dialog ----------
  await a.js(`ide.toolWindows.get('Database').show()`);
  await a.until(`!!document.querySelector('#dbTree .db-empty')`, 'empty database tool window');
  await a.click('#dbAdd');
  await clickText(a, '.context-menu .menu-item', 'SQLite');
  await a.until(`!!document.querySelector('.db-dialog #dbField-file')`, 'data source dialog');
  check(await a.js(`!document.querySelector('.db-dialog #dbField-host') && !document.querySelector('.db-dialog #dbDriverMissing')`), 'SQLite dialog asks only for a file and needs no driver download');
  await setInput(a, '#dbName', 'app-db');
  await setInput(a, '#dbField-file', dbFile);
  await a.click('#dbTest');
  await a.until(`document.querySelector('#dbTestResult').classList.contains('ok')`, 'test connection result');
  check(/SQLite 3\.\d+/.test(await a.js(`document.querySelector('#dbTestResult').textContent`)), 'Test Connection succeeds and reports the SQLite version');
  await clickText(a, '.db-dialog .dialog-buttons button', 'OK');
  await a.until(`!document.querySelector('.db-dialog') && document.querySelector('#dbTree .db-source')?.textContent.includes('app-db')`, 'source in tree');
  check(true, 'the data source appears in the Database tool window');

  // ---------- query console ----------
  await a.click('#dbConsole');
  await a.until(`!!ide.database.activeConsole()`, 'console tab');
  check(await a.js(`ide.activeTab()?.title === 'app-db'`), 'New Query Console opens a tab named after the data source');
  await a.js(`ide.database.activeConsole().editor.focus()`);
  await a.type(SQL);
  check(await a.js(`ide.database.activeConsole().model.getValue() === ${q(SQL)}`), 'SQL typed into the console editor');

  await runLine(a, 1);
  check(/executed/.test(await status(a)), `Ctrl+Enter on line 1 runs only CREATE TABLE (${await status(a)})`);
  await runLine(a, 2, SQL.split('\n')[1].indexOf('primary') + 1);
  check((await status(a)).startsWith('2 rows affected'), `Ctrl+Enter inside the INSERT runs it, ignoring the ; inside the string (${await status(a)})`);
  await runLine(a, 3);
  await a.until(`${activeConsole}.querySelectorAll('.db-grid tbody tr').length === 2`, 'result grid');
  const grid = await a.js(`[...${activeConsole}.querySelectorAll('.db-grid tbody tr')].map(r => [...r.children].slice(1).map(td => td.textContent))`);
  check(q(grid) === q([['1', 'Lovelace, Ada', 'ada@example.com; primary'], ['2', 'Linus', 'NULL']]), `SELECT shows the rows in the grid (${q(grid)})`);
  check(await a.js(`${activeConsole}.querySelector('.db-grid tbody tr:nth-child(2) td:last-child').classList.contains('db-null')`), 'NULL is rendered as a dim NULL cell');
  check(await a.js(`[...${activeConsole}.querySelectorAll('.db-grid th')].map(th => th.firstChild?.textContent).join(',') === ',id,name,email'`), 'grid header lists the columns');
  check(/^2 rows · [\d.]+ ms$/.test(await status(a)), `status shows the row count and time (${await status(a)})`);
  await a.click(`.custom-tab:not(.hidden) .db-copy`);
  await a.until(`ide.api.invoke('clipboard:readText').then(t => t.startsWith('id,name,email'))`, 'clipboard csv');
  check((await a.js(`ide.api.invoke('clipboard:readText')`)) === 'id,name,email\r\n1,"Lovelace, Ada",ada@example.com; primary\r\n2,Linus,', 'Copy as CSV puts the result on the clipboard, quoting and empty NULLs');
  await a.shot('console.png');

  await runLine(a, 4);
  await a.until(`!!${activeConsole}.querySelector('.db-error')`, 'error shown');
  check((await a.js(`${activeConsole}.querySelector('.db-error').textContent`)).includes('no such table: missing_table'), 'bad SQL shows the database error');
  check(await a.js(`getComputedStyle(${activeConsole}.querySelector('.db-error')).color === 'rgb(219, 92, 92)'`), 'the error is red');

  // A long statement runs on the SQLite worker thread: the main process keeps answering IPC meanwhile.
  await a.js(`(window.__longQuery = ide.database.query(ide.database.list()[0].id, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 15000000) SELECT count(*) FROM c', { maxRows: 1 }), true)`);
  await a.sleep(300);
  const ipcMs = await a.js(`(async () => { const t0 = performance.now(); await ide.api.invoke('db:list'); return Math.round(performance.now() - t0); })()`);
  const longQuery = await a.js('window.__longQuery');
  check(longQuery.ok && longQuery.rows[0][0] === 15000000 && longQuery.ms > 3 * ipcMs && ipcMs < 500, `IPC answers in ${ipcMs} ms while a ${Math.round(longQuery.ms)} ms SQLite statement runs`);

  // ---------- schema tree ----------
  await clickText(a, '#dbTree .db-node.db-source', 'app-db');
  await a.until(`[...document.querySelectorAll('#dbTree .db-node.db-table')].some(n => n.textContent.includes('users'))`, 'users table in tree');
  check(await a.js(`document.querySelector('#dbTree .db-node.db-source .db-dot').classList.contains('db-state-connected')`), 'the source shows a connected state dot');
  await clickText(a, '#dbTree .db-node.db-table', 'users');
  await a.until(`document.querySelectorAll('#dbTree .db-node.db-column').length === 3`, 'columns');
  const cols = await a.js(`[...document.querySelectorAll('#dbTree .db-node.db-column')].map(n => n.querySelector('.db-label').textContent + ':' + n.querySelector('.db-detail').textContent + ':' + n.querySelector('.db-icon').dataset.iconName)`);
  check(q(cols) === q(['id:INTEGER:key', 'name:TEXT NOT NULL:dataColumn', 'email:TEXT:dataColumn']), `the tree shows the table's columns with types and the primary key (${q(cols)})`);
  await a.shot('tree.png');

  // ---------- Open Data from the table's context menu ----------
  await rightClickText(a, '#dbTree .db-node.db-table', 'users');
  await clickText(a, '.context-menu .menu-item', 'Open Data');
  await a.until(`ide.database.activeConsole()?.model.getValue().includes('SELECT * FROM "users" LIMIT 200;') && ${activeConsole}.querySelectorAll('.db-grid tbody tr').length === 2`, 'open data result');
  check(true, 'Open Data appends SELECT * ... LIMIT 200 to the console and shows the rows');

  // ---------- PostgreSQL without its driver; the password stays in the main process ----------
  await a.click('#dbAdd');
  await clickText(a, '.context-menu .menu-item', 'PostgreSQL');
  await a.until(`!!document.querySelector('.db-dialog #dbDriverMissing')`, 'missing driver notice');
  check(await a.js(`!!document.querySelector('#dbDownloadDriver') && document.querySelector('#dbField-port').value === '5432'`), 'PostgreSQL shows the driver as missing with a Download Driver button and the default port');
  await a.click('.db-dialog .db-local-server');
  await a.until(`!document.querySelector('.db-dialog') && document.querySelector('.inst-nav.selected')?.dataset.filter === 'cat:databases'`, 'install manager databases');
  check(true, 'the dialog links to local database servers in the Install Manager');
  await a.click('#dbAdd');
  await clickText(a, '.context-menu .menu-item', 'PostgreSQL');
  await a.until(`!!document.querySelector('.db-dialog #dbDriverMissing')`, 'missing driver notice again');
  await setInput(a, '#dbName', 'pg-local');
  await setInput(a, '#dbField-host', '127.0.0.1');
  await setInput(a, '#dbField-user', 'postgres');
  await setInput(a, '#dbField-password', SECRET);
  await a.click('#dbTest');
  await a.until(`document.querySelector('#dbTestResult').classList.contains('err')`, 'pg test result');
  check((await a.js(`document.querySelector('#dbTestResult').textContent`)).includes('Download the driver first'), 'Test Connection without the driver says to download it');
  await clickText(a, '.db-dialog .dialog-buttons button', 'OK');
  await a.until(`!document.querySelector('.db-dialog') && ide.database.list().length === 2`, 'pg source saved');
  const listed = await a.js(`ide.api.invoke('db:list')`);
  const pg = listed.find((s) => s.name === 'pg-local');
  check(pg.hasPassword && !q(listed).includes(SECRET) && !('password' in pg) && !('secret' in pg), 'the renderer sees hasPassword but never the password');
  await rightClickText(a, '#dbTree .db-node.db-source', 'pg-local');
  await clickText(a, '.context-menu .menu-item', 'Edit Data Source');
  await a.until(`!!document.querySelector('.db-dialog #dbField-password')`, 'edit dialog');
  check(await a.js(`document.querySelector('#dbField-password').value === '' && document.querySelector('#dbField-password').placeholder.length > 0 && !document.documentElement.outerHTML.includes(${q(SECRET)})`), 'editing shows a saved-password placeholder, not the password');
  await a.press('Escape');
  const onDisk = readFileSync(path.join(a.userData, 'database', 'sources.json'), 'utf8');
  check(!onDisk.includes(SECRET) && onDisk.includes('"enc": "safeStorage"'), 'sources.json stores the password encrypted with safeStorage');

  await a.js(`(window.__dbConnecting = 0, ide.api.on('db:state', (m) => { if (m.state === 'connecting') window.__dbConnecting++; }), true)`);
  await clickText(a, '#dbTree .db-node.db-source', 'pg-local');
  await a.until(`[...document.querySelectorAll('#dbTree .db-node.db-error')].some(n => n.textContent.includes('Driver files are missing'))`, 'missing driver row');
  await a.sleep(1500);
  check(await a.js(`window.__dbConnecting === 1 && [...document.querySelectorAll('#dbTree .db-node.db-source')].find(n => n.textContent.includes('pg-local')).querySelector('.db-dot').classList.contains('db-state-error')`),
    `expanding a source whose driver is missing shows the problem and tries to connect once (${await a.js('window.__dbConnecting')} attempts)`);
  await rightClickText(a, '#dbTree .db-node.db-source', 'app-db');
  await clickText(a, '.context-menu .menu-item', 'Disconnect');
  await a.until(`document.querySelector('#dbTree .db-node.db-source .db-dot').classList.contains('db-state-disconnected')`, 'disconnected');
  await a.sleep(500);
  check(await a.js(`!document.querySelector('#dbTree .db-node.db-table') && document.querySelector('#dbTree .db-node.db-source .db-dot').classList.contains('db-state-disconnected')`), 'Disconnect closes the connection and folds the source without reconnecting');

  await a.until(`ide.api.invoke('db:consoleLoad', ${consoleOf('app-db')}.id).then(t => t?.includes('LIMIT 200'))`, 'console text saved');
  check(a.consoleErrors.length === 0, 'no renderer exceptions');
  await a.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  a.close();

  // ---------- restart: data sources and console come back ----------
  const b = await launch({ fixture: 'database', port: 9601, name: 'database-restart', userData: a.userData, lang: 'ko-KR' });
  try {
    await b.until(`!!ide.database.activeConsole()`, 'console restored', 20000);
    check(await b.js(`ide.database.list().map(s => s.name).sort().join(',') === 'app-db,pg-local'`), 'both data sources survive a restart');
    check(await b.js(`ide.database.activeConsole().model.getValue().startsWith(${q(SQL)})`), 'the query console reopens with its text');
    await b.js(`ide.toolWindows.get('Database').show()`);
    await clickText(b, '#dbTree .db-node.db-source', 'app-db');
    await b.until(`[...document.querySelectorAll('#dbTree .db-node.db-table')].some(n => n.textContent.includes('users'))`, 'tree after restart');
    await runLine(b, 3);
    await b.until(`${activeConsole}.querySelectorAll('.db-grid tbody tr').length === 2`, 'grid after restart');
    check(true, 'the restored console runs queries against the same database');

    // ---------- Korean UI ----------
    await rightClickText(b, '#dbTree .db-node.db-source', 'pg-local');
    await b.until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.includes('데이터 소스 편집'))`, 'korean menu');
    const menuLeaks = await englishLeaks(b, '.context-menu', ['SELECT']);
    await clickText(b, '.context-menu .menu-item', '데이터 소스 편집');
    await b.until(`!!document.querySelector('.db-dialog #dbDriverMissing')`, 'korean dialog');
    const allowed = ['SQLite', 'PostgreSQL', 'MySQL', 'MariaDB', 'SELECT', 'CSV', 'TSV', 'NULL', 'ms'];
    const leaks = [...menuLeaks, ...await englishLeaks(b, '.db-tool, .db-console, .db-dialog', allowed)];
    check(!leaks.length, `Database UI is in Korean${leaks.length ? ` ${q(leaks)}` : ''}`);
    await b.shot('korean.png');
    await b.press('Escape');
    check(b.consoleErrors.length === 0, 'no renderer exceptions after restart');
  } finally { b.close(); }

  // ---------- opening SQLite files from the project tree ----------
  const c = await launch({ fixture: 'database', port: 9602, name: 'database-file' });
  try {
    const inv = new DatabaseSync(path.join(c.project, 'inventory.sqlite'));
    inv.exec("CREATE TABLE items (sku TEXT PRIMARY KEY, qty INTEGER); INSERT INTO items VALUES ('a-1', 3), ('b-2', 0), ('c-3', 12);");
    inv.close();
    await c.js(`ide.refreshTree()`);
    await clickText(c, '#tree .node', 'inventory.sqlite');
    await c.until(`ide.database.list().some(s => s.name === 'inventory.sqlite' && s.kind === 'sqlite')`, 'file added as data source');
    check(true, 'opening a .sqlite file from the project tree adds it as a SQLite data source');
    await c.until(`!!ide.database.activeConsole() && ide.activeTab()?.title === 'inventory.sqlite' && ide.activeTab()?.path.startsWith('db-console:')`, 'console for the file');
    check(true, 'and opens a query console for it');
    check(await c.js(`[...document.querySelectorAll('.db-file-table')].some(n => n.textContent.includes('items'))`), 'the file tab lists its tables');
    await c.js(`ide.database.activeConsole().editor.focus()`);
    await c.type('SELECT sum(qty) AS total FROM items');
    await runLine(c, 1);
    await c.until(`${activeConsole}.querySelector('.db-grid tbody td.db-num')?.textContent === '15'`, 'sum over the file');
    check(true, 'the console queries the opened file');
    await clickText(c, '#tree .node', 'notes.db');
    await c.until(`[...document.querySelectorAll('.custom-tab:not(.hidden) .db-file-info')].some(n => n.textContent.includes('not a SQLite database'))`, 'non-sqlite notice');
    check(await c.js(`ide.database.list().length === 1`), 'a .db file that is not SQLite is not added');
    check(c.consoleErrors.length === 0, 'no renderer exceptions when opening database files');
  } finally { c.close(); }

  // ---------- real driver download ----------
  if (REAL) {
    const d = await launch({ fixture: 'database', port: 9603, name: 'database-driver' });
    try {
      await d.js(`ide.toolWindows.get('Database').show()`);
      await d.click('#dbAdd');
      await clickText(d, '.context-menu .menu-item', 'PostgreSQL');
      await d.until(`!!document.querySelector('#dbDownloadDriver')`, 'download button');
      check(await d.js(`ide.installables.find(i => i.id === 'db-driver-postgres').status().then(s => s.installed === false)`), 'the pg installable reports not installed');
      await d.click('#dbDownloadDriver');
      await d.until(`document.querySelector('#dbDriverLog')?.textContent.includes('npm')`, 'live npm log');
      check(true, 'Download Driver streams the npm log');
      await d.until(`!document.querySelector('#dbDriverMissing') && document.querySelector('.db-driver')?.textContent.includes('pg 8.')`, 'driver installed', 240000);
      check(true, 'after the download the dialog shows the installed pg driver');
      const st = await d.js(`ide.installables.find(i => i.id === 'db-driver-postgres').status()`);
      check(st.installed && /^8\./.test(st.version), `the pg installable now reports ${q(st)}`);
      check(d.consoleErrors.length === 0, 'no renderer exceptions during the driver download');
    } finally { d.close(); }
  }
} catch (err) {
  check(false, err.message);
  a?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
