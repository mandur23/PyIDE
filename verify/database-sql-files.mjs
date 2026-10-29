// Project .sql files with a data source (renderer/features/database/sql-files.js), on a SQLite file (Electron's built-in
// node:sqlite, nothing downloaded):
// - without a data source a .sql file gets no table names; the status bar widget says <No data source>;
// - Attach Data Source… from the editor's context menu, the status bar widget and Find Action; the attachment is kept
//   per project (relative path), follows a rename, survives a page reload and a restart, and goes with a removed source;
// - attached, tables, columns, alias.column, functions with signature help complete as in a console, without the
//   language-basics keywords twice;
// - Ctrl+Enter runs the statement at the caret or the selection into the Query Results tool window (a modifying
//   statement runs without a question, as in the console); with no data source it asks for one first;
// - a file outside the project gets nothing; another project does not see this project's attachments; in Safe Mode a
//   statement runs only after a confirmation that shows it (Cancel runs nothing);
// - Korean UI: no missing translations, no English in the widget, the results and the dialog.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile, menuRow, clickMenuPath } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

// A driver directory of the suite's own, holding database-completion's stand-in `pg` package (two schemas, no server).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const driverDir = mkdtempSync(path.join(tmpdir(), 'pyide-db-sql-files-drivers-'));
process.env.PYIDE_DB_DRIVERS = driverDir;
writeFileSync(path.join(driverDir, 'package.json'), JSON.stringify({ name: 'pyide-db-drivers', private: true }));
cpSync(path.join(HERE, 'fixtures', 'database-completion', 'fake-pg'), path.join(driverDir, 'node_modules', 'pg'), { recursive: true });
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;

// ---------- helpers ----------
async function suggest(t, text, { empty = false } = {}) {
  const at = text.indexOf('|');
  const value = text.slice(0, at) + text.slice(at + 1);
  await t.js(`(() => { const e = ide.editor; e.trigger('t', 'hideSuggestWidget', {}); e.getModel().setValue(${q(value)}); e.focus(); e.setPosition(e.getModel().getPositionAt(${at})); e.trigger('t', 'editor.action.triggerSuggest', {}); return true; })()`);
  const rowsReady = `(() => { const w = document.querySelector('.suggest-widget.visible'); return !!w && !w.classList.contains('message') && w.querySelectorAll('.monaco-list-row').length > 0; })()`;
  if (empty) {
    await t.sleep(1500);
    if (!(await t.js(rowsReady))) return [];
  } else await t.until(rowsReady, `suggestions for ${text}`, 15000);
  await t.sleep(200);
  // Every row, not only the rendered ones: the list model behind the widget.
  return t.js(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].sort((a, b) => a.dataset.index - b.dataset.index).map(r => ({
    label: r.querySelector('.label-name').textContent, signature: r.querySelector('.signature-label')?.textContent.trim() || '', right: r.querySelector('.details-label')?.textContent.trim() || '' }))`);
}
const labels = (rows) => rows.map((r) => r.label);
async function accept(t) {
  await t.js(`(ide.editor.trigger('t', 'acceptSelectedSuggestion', {}), true)`);
  await t.sleep(200);
  return t.js(`ide.editor.getModel().getValue()`);
}
const hideSuggest = (t) => t.js(`(ide.editor.trigger('t', 'hideSuggestWidget', {}), true)`);
const statusText = `(() => { const n = document.querySelector('#statusSqlSource'); return n && !n.classList.contains('hidden') ? n.textContent : null; })()`;
const popupShown = `!document.querySelector('#popup').classList.contains('hidden')`;
const popupLabels = `[...document.querySelectorAll('#popup .popup-item .label')].map(n => n.textContent)`;
async function pickRow(t, label) {
  await t.until(`${popupLabels}.includes(${q(label)})`, `popup row ${label}`);
  await t.js(`([...document.querySelectorAll('#popup .popup-item')].find(r => r.querySelector('.label')?.textContent === ${q(label)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), true)`);
  // Closed, or showing the next question (the schema picker).
  await t.until(`!(${popupShown}) || !${popupLabels}.includes(${q(label)})`, 'popup closed');
}
// Puts text in the editor, the caret at `|` (or the selection between two `|`), focuses it and presses Ctrl+Enter.
async function runIn(t, text) {
  const first = text.indexOf('|');
  const second = text.indexOf('|', first + 1);
  const value = text.replace(/\|/g, '');
  await hideSuggest(t);
  await t.js(`(() => { const e = ide.editor; const m = e.getModel(); m.setValue(${q(value)}); e.focus();
    const a = m.getPositionAt(${first}); const b = m.getPositionAt(${second < 0 ? first : second - 1});
    e.setSelection(new ide.monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column)); return true; })()`);
  await t.press('Ctrl+Enter');
}
const view = (rel) => `ide.database.sqlFiles.results(ide.util.joinPath(ide.root, ${q(rel.replace(/\//g, '\\'))}))`;
const gridRows = `[...document.querySelectorAll('.db-file-results.active .db-grid tbody tr')].map(tr => [...tr.querySelectorAll('td')].slice(1).map(td => td.textContent))`;
const resultStatus = `(document.querySelector('.db-file-results.active .db-result-status')?.textContent || '')`;
const attachmentsOf = `ide.settings.get('database.sqlFiles.' + ide.root, {})`;
const dialogTitle = `[...document.querySelectorAll('.dialog-title')].map(n => n.textContent).join('|')`;
const clickDialog = (t, label) => t.js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === ${q(label)}).click(), true)`);
const userCount = (file) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT count(*) AS n FROM users').get().n; } finally { db.close(); } };

let a;
let k;
try {
  a = await launch({ fixture: 'database-sql-files', port: 9888, name: 'database-sql-files' });
  const dbFile = path.join(a.project, 'shop.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL);
    INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com'), ('Linus', NULL);
    INSERT INTO orders (user_id, total) VALUES (1, 10.5), (2, 20);`);
  db.close();
  const shop = await a.js(`ide.database.addDataSource({ kind: 'sqlite', name: 'shop', file: ${q(dbFile)} })`);

  // ---------- no data source ----------
  await openFile(a, 'query.sql');
  await a.until(`${statusText} !== null`, 'status widget');
  check((await a.js(statusText)).includes('<No data source>'), `the status bar widget shows <No data source> for a project .sql file (${q(await a.js(statusText))})`);
  let rows = await suggest(a, 'SELECT * FROM |', { empty: true });
  check(!labels(rows).some((l) => ['users', 'orders', 'SELECT … FROM'].includes(l)), `no data source: no table names offered (${q(labels(rows).slice(0, 5))})`);
  await hideSuggest(a);
  check(await a.js(`ide.database.completionHost.consoleFor(ide.editor.getModel()) === null`), 'no completion context without a data source');

  // ---------- attach from the editor's context menu ----------
  await a.js(`(ide.ui.editorContextMenu(ide.editor, 300, 200), true)`);
  await clickMenuPath(a, ['Attach Data Source…']);
  await a.until(popupShown, 'data source picker');
  check(q(await a.js(popupLabels)) === q(['shop', '<No data source>', 'New Data Source…']), `the picker lists the SQL data sources, <No data source> and New Data Source… (${q(await a.js(popupLabels))})`);
  await pickRow(a, 'shop');
  await a.until(`${statusText}?.includes('shop')`, 'status shows shop');
  check(true, 'choosing a source attaches it; the widget shows its name (SQLite: one schema, so no schema question)');
  check(q(await a.js(attachmentsOf)) === q({ 'query.sql': { source: shop } }), `stored per project by relative path (${q(await a.js(attachmentsOf))})`);

  // ---------- completion ----------
  rows = await suggest(a, 'SELECT * FROM |');
  check(q(labels(rows)) === q(['orders', 'users']), `after FROM: the source's tables (${q(labels(rows))})`);
  rows = await suggest(a, 'SELECT u.| FROM users u JOIN orders o ON o.user_id = u.id');
  check(q(rows.map((r) => `${r.label}:${r.right}`)) === q(['id:users', 'name:users', 'email:users']), `alias.column: the alias's columns (${q(rows)})`);
  rows = await suggest(a, 'SELECT | FROM orders');
  check(q(labels(rows).slice(0, 3)) === q(['id', 'user_id', 'total']), `columns of the FROM table rank first (${q(labels(rows).slice(0, 4))})`);
  rows = await suggest(a, 'SELECT * FROM users WH|');
  check(labels(rows).filter((l) => l === 'WHERE').length === 1 && rows.find((r) => r.label === 'WHERE')?.right === 'keyword', `keywords complete once (no plain keyword list on top) (${q(labels(rows))})`);
  rows = await suggest(a, 'SELECT group_con|');
  check(rows[0]?.label === 'group_concat' && rows[0].signature === '(x[, separator])', `the kind's functions with their signatures (${q(rows[0])})`);
  await a.js(`(ide.editor.trigger('t', 'acceptSelectedSuggestion', {}), true)`);
  await a.until(`!!document.querySelector('.parameter-hints-widget.visible')`, 'signature help', 5000).catch(() => {});
  check((await a.js(`document.querySelector('.parameter-hints-widget.visible')?.textContent || ''`)).includes('group_concat(x[, separator])'), 'signature help inside the call');
  await a.js(`(ide.editor.trigger('t', 'closeParameterHints', {}), true)`);

  // ---------- Ctrl+Enter ----------
  await runIn(a, 'SELECT name FROM us|ers ORDER BY id;\nSELECT count(*) AS n FROM orders;\n');
  await a.until(`${view('query.sql')}?.runs === 1`, 'first run', 15000);
  check(q(await a.js(gridRows)) === q([['Ada'], ['Linus']]), `Ctrl+Enter runs the statement at the caret and shows its rows (${q(await a.js(gridRows))})`);
  check(await a.js(`ide.database.sqlFiles.toolWindow.isVisible()`) && (await a.js(resultStatus)).includes('2 rows'), `in the Query Results tool window with the console's status line (${q(await a.js(resultStatus))})`);
  check(await a.js(`document.querySelectorAll('.db-console').length === 0 && !!document.querySelector('.db-file-results.active .db-result-bar .db-export')`), 'the console\'s result view (Copy/Export bar), no console tab opened');
  await runIn(a, 'SELECT name FROM users ORDER BY id;\nSELECT count(*) AS n FR|OM orders;\n');
  await a.until(`${view('query.sql')}?.runs === 2`, 'second run');
  check(q(await a.js(gridRows)) === q([['2']]), `the caret on the second statement runs that one (${q(await a.js(gridRows))})`);
  await runIn(a, "SELECT 1 AS a; |SELECT 'sel' AS b|; SELECT 3 AS c;");
  await a.until(`${view('query.sql')}?.runs === 3`, 'selection run');
  check(q(await a.js(gridRows)) === q([['sel']]) && (await a.js(`${view('query.sql')}.lastStatement`)) === "SELECT 'sel' AS b", 'a selection runs exactly the selected text');
  await runIn(a, "INSERT INTO users (name) VALUES ('Gr|ace');");
  await a.until(`${view('query.sql')}?.runs === 4`, 'insert run');
  check(!(await a.js(dialogTitle)) && (await a.js(resultStatus)).includes('1 rows affected') && userCount(dbFile) === 3, `a modifying statement runs without a question, like the console (${q(await a.js(resultStatus))})`);
  await a.js(`(ide.editor.getModel().setValue('SELECT * FROM users;\\n'), true)`);

  // ---------- rename ----------
  await a.js(`ide.saveAll().then(() => true)`);
  await a.js(`ide.moveTreeEntry({ path: ide.util.joinPath(ide.root, 'query.sql'), name: 'query.sql' }, ide.util.joinPath(ide.root, 'renamed.sql')).then(() => true)`);
  await a.until(`ide.activeTab()?.path.toLowerCase().endsWith('renamed.sql')`, 'tab follows rename');
  await a.until(`${statusText}?.includes('shop')`, 'status after rename');
  check(q(await a.js(attachmentsOf)) === q({ 'renamed.sql': { source: shop } }), `a renamed file keeps its data source (${q(await a.js(attachmentsOf))})`);

  // ---------- a file without one: Ctrl+Enter asks first ----------
  await openFile(a, 'sub/report.sql');
  await a.until(`${statusText}?.includes('<No data source>')`, 'report.sql unattached');
  check(true, 'attachments are per file');
  await a.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 3 }), true)`);
  await a.press('Ctrl+Enter');
  await a.until(popupShown, 'picker from Ctrl+Enter');
  check((await a.js(popupLabels)).includes('shop'), 'Ctrl+Enter in a file without a data source opens the picker');
  await a.press('Escape');
  await a.until(`!(${popupShown})`, 'picker closed');
  await a.sleep(300);
  check(await a.js(`${view('sub/report.sql')} === null`) && !(await a.js(`ide.database.sqlFiles.attachmentOf(ide.activeTab().path)`)), 'cancelling it runs nothing and attaches nothing');

  // ---------- reload ----------
  await a.cdp('Page.reload');
  await a.until('window.__ideReady === true && !!ide.root', 'IDE ready after reload', 30000);
  await openFile(a, 'renamed.sql');
  await a.until(`${statusText}?.includes('shop')`, 'status after reload', 15000);
  rows = await suggest(a, 'SELECT * FROM |');
  check(q(labels(rows)) === q(['orders', 'users']), `the attachment survives a reload and completes again (${q(labels(rows))})`);
  await hideSuggest(a);

  // ---------- detach through Find Action's action ----------
  a.js(`ide.runAction('Database.AttachDataSource')`);
  await a.until(popupShown, 'picker from the action');
  await pickRow(a, '<No data source>');
  await a.until(`${statusText}?.includes('<No data source>')`, 'detached');
  rows = await suggest(a, 'SELECT * FROM |', { empty: true });
  check(!labels(rows).includes('users') && q(await a.js(attachmentsOf)) === q({}), `detaching: no table names, nothing stored (${q(labels(rows).slice(0, 4))})`);
  await hideSuggest(a);

  // ---------- the status bar widget; removing the source ----------
  await a.click('#statusSqlSource');
  await pickRow(a, 'shop');
  await a.until(`${statusText}?.includes('shop')`, 'attached from the widget');
  check(true, 'the status bar widget attaches too');
  await a.js(`(ide.database.toolWindow.show(), true)`);
  await a.until(`!!document.querySelector('#dbTree .db-node.db-source')`, 'source row');
  await a.click('#dbTree .db-node.db-source');
  await a.click('#dbRemove');
  await a.until(`${dialogTitle}.includes('Remove Data Source')`, 'remove dialog');
  await clickDialog(a, 'Remove');
  await a.until(`ide.database.list().length === 0`, 'source removed');
  await a.until(`${statusText}?.includes('<No data source>')`, 'status after removal');
  check(q(await a.js(attachmentsOf)) === q({}), 'removing the data source clears the attachment');

  // ---------- a schema (the PostgreSQL kind on the stand-in pg) ----------
  const pg = await a.js(`ide.database.addDataSource({ kind: 'postgres', name: 'pg', host: '127.0.0.1', port: 5432, user: 'u', password: 'p', database: 'd' })`);
  await openFile(a, 'sub/report.sql');
  await a.click('#statusSqlSource');
  await pickRow(a, 'pg');
  await a.until(`${popupLabels}.includes('sales')`, 'schema picker', 15000);
  check(q(await a.js(popupLabels)) === q(['Default schema', 'public', 'sales']), `a source with several schemas asks for one (${q(await a.js(popupLabels))})`);
  await pickRow(a, 'sales');
  await a.until(`${statusText}?.includes('pg · sales')`, 'status with the schema');
  check(q(await a.js(attachmentsOf)) === q({ 'sub/report.sql': { source: pg, schema: 'sales' } }), `the schema is stored with the source (${q(await a.js(attachmentsOf))})`);
  await suggest(a, 'SELECT * FROM inv|');
  check((await accept(a)) === 'SELECT * FROM invoices', "the attached schema's tables go in unqualified");
  await suggest(a, 'SELECT * FROM ref|');
  check((await accept(a)) === 'SELECT * FROM refunds', 'every table of that schema');
  rows = await suggest(a, 'SELECT i.| FROM invoices i');
  check(q(labels(rows)) === q(['id', 'customer_id', 'amount']), `an unqualified table resolves in the attached schema (${q(labels(rows))})`);
  await hideSuggest(a);
  await a.js(`(ide.editor.getModel().setValue('SELECT * FROM invoices;\\n'), ide.saveAll().then(() => true))`);

  // ---------- another project's file ----------
  const shop2 = await a.js(`ide.database.addDataSource({ kind: 'sqlite', name: 'shop2', file: ${q(dbFile)} })`);
  const outside = mkdtempSync(path.join(tmpdir(), 'pyide-db-sql-files-outside-'));
  const outsideFile = path.join(outside, 'outside.sql');
  writeFileSync(outsideFile, 'DELETE FROM users;\n');
  await a.js(`ide.openFile(${q(outsideFile)}).then(() => true)`);
  await a.until(`ide.activeTab()?.path.toLowerCase().endsWith('outside.sql')`, 'outside file open');
  await a.sleep(300);
  check((await a.js(statusText)) === null, 'a file outside the project shows no data source widget');
  check(!(await a.js(`ide.database.sqlFiles.attach(ide.activeTab().path, ${q(shop2)})`)) && (await a.js(`ide.database.completionHost.consoleFor(ide.editor.getModel())`)) === null, 'and cannot be attached');
  await a.js(`(ide.ui.editorContextMenu(ide.editor, 300, 200), true)`);
  await a.until(`!!document.querySelector('.context-menu')`, 'menu');
  check(!(await a.js(`!!${menuRow('Attach Data Source…')}`)), 'its context menu has no Attach Data Source…');
  await a.js(`(ide.ui.closeMenus(), true)`);
  await a.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 3 }), true)`);
  await a.press('Ctrl+Enter');
  await a.sleep(800);
  check(!(await a.js(popupShown)) && !(await a.js(dialogTitle)) && userCount(dbFile) === 3, 'Ctrl+Enter in it runs nothing and asks nothing');
  // For the next launch: this project's renamed.sql attached to shop2.
  await openFile(a, 'renamed.sql');
  await a.js(`(ide.database.sqlFiles.attach(ide.activeTab().path, ${q(shop2)}), true)`);
  await a.until(`${statusText}?.includes('shop2')`, 'attached to shop2');
  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? q(a.consoleErrors) : ''}`);
  const settingsFile = path.join(a.userData, 'settings.json');
  for (let i = 0; i < 50 && !(existsSync(settingsFile) && readFileSync(settingsFile, 'utf8').includes(shop2)); i++) await a.sleep(200);
  const projectA = a.project;
  const userData = a.userData;
  a.close();
  a = null;

  // ---------- Korean, a restart, another project in Safe Mode ----------
  writeFileSync(path.join(userData, 'trusted-projects.json'), q([projectA.toLowerCase()]));
  const other = mkdtempSync(path.join(tmpdir(), 'pyide-db-sql-files-other-'));
  mkdirSync(path.join(other, 'src'));
  writeFileSync(path.join(other, 'renamed.sql'), 'DELETE FROM users;\nSELECT name FROM users ORDER BY id;\n');
  k = await launch({ fixture: 'database-sql-files', port: 9889, name: 'database-sql-files-ko', projectDir: projectA, userData, lang: 'ko-KR', env: { PYIDE_TRUST_ALL: '' } });
  check(await k.js(`i18n.locale === 'ko' && ide.trusted === true`), 'Korean UI, the project trusted');
  await openFile(k, 'renamed.sql');
  await k.until(`${statusText}?.includes('shop2')`, 'attachment after restart', 15000);
  check(true, 'the attachment survives a restart');
  await runIn(k, 'SELECT name FROM users ORDER BY id;|');
  await k.until(`${view('renamed.sql')}?.runs === 1`, 'Korean run', 15000);
  check(q(await k.js(gridRows)) === q([['Ada'], ['Linus'], ['Grace']]) && (await k.js(resultStatus)).includes('3개 행'), `runs with the Korean status line (${q(await k.js(resultStatus))})`);
  await k.js(`(ide.ui.editorContextMenu(ide.editor, 300, 200), true)`);
  check(await k.js(`!!${menuRow('데이터 소스 연결…')}`), 'the context menu item in Korean');
  await k.js(`(ide.ui.closeMenus(), true)`);
  let leaks = await englishLeaks(k, '#statusSqlSource, .db-file-results');
  check(leaks.length === 0, `no English in the widget and the results${leaks.length ? q(leaks) : ''}`);

  await k.js(`ide.saveAll().then(() => true)`);
  k.js(`ide.openProject(${q(other)})`);
  await k.until(`${dialogTitle}.includes('프로젝트를 신뢰')`, 'trust question', 15000).catch(() => {});
  await k.until(`[...document.querySelectorAll('.dialog-buttons button')].some(b => b.textContent === '안전 모드로 미리 보기')`, 'safe mode button');
  await clickDialog(k, '안전 모드로 미리 보기');
  await k.until(`ide.root && ide.util.samePath(ide.root, ${q(other)}) && ide.trusted === false`, 'other project in Safe Mode', 20000);
  await openFile(k, 'renamed.sql');
  await k.until(`${statusText}?.includes('<데이터 소스 없음>')`, 'unattached in the other project');
  check(q(await k.js(attachmentsOf)) === q({}), "another project's file of the same name does not get this project's data source");
  await k.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 3 }), true)`);
  await k.press('Ctrl+Enter');
  await k.until(popupShown, 'picker in Safe Mode');
  await pickRow(k, 'shop2');
  await k.until(`${dialogTitle}.includes('신뢰하지 않는 프로젝트의 문을 실행할까요?')`, 'Safe Mode confirmation');
  check((await k.js(`document.querySelector('.db-safe-statements')?.textContent`)) === 'DELETE FROM users', 'Safe Mode: the statement is shown before it runs');
  leaks = await englishLeaks(k, '.dialog');
  check(leaks.length === 0, `no English in the Safe Mode dialog${leaks.length ? q(leaks) : ''}`);
  await clickDialog(k, '취소');
  await k.sleep(500);
  check(userCount(path.join(projectA, 'shop.sqlite')) === 3 && (await k.js(`${view('renamed.sql')} === null`)), 'Cancel runs nothing (the rows are all still there)');
  await k.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 3 }), true)`);
  await k.press('Ctrl+Enter');
  await k.until(`${dialogTitle}.includes('신뢰하지 않는 프로젝트의 문을 실행할까요?')`, 'confirmation again');
  await clickDialog(k, '실행');
  await k.until(`${view('renamed.sql')}?.runs === 1`, 'run after confirming', 15000);
  check(q(await k.js(gridRows)) === q([['Ada'], ['Linus'], ['Grace']]), 'Run in the confirmation runs it');
  const missing = await missingTranslations(k);
  check(missing.length === 0, `no missing translations${missing.length ? ` ${q(missing)}` : ''}`);
  check(k.consoleErrors.length === 0, `no renderer exceptions (Korean)${k.consoleErrors.length ? q(k.consoleErrors) : ''}`);
} catch (err) {
  check(false, err.stack || err.message);
  await (a || k)?.shot('failure.png').catch(() => {});
} finally {
  a?.close();
  k?.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
