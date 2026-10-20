// Query console autocompletion through Monaco's real suggest widget:
// - SQL on a SQLite file: tables after FROM, columns of FROM tables ranked first, alias and table qualifiers (with AS),
//   keywords and functions with signature help, snippets, quoting of odd identifiers, and the cache refreshing after DDL.
// - Schema-qualified names through the real PostgreSQL kind with a fake `pg` package holding public and sales schemas.
// - MongoDB (fake driver): db. collections and methods, sampled fields and query/update operators by position,
//   aggregation stages, use <database>.
// - Redis (RESP mock): commands with their syntax, key names after key commands found with SCAN MATCH.
// - Nothing from the consoles leaks into a .py or .sql project file; detail text is Korean in a Korean UI.
import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { startRespMock } from './fixtures/database-nosql/resp-mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), 'pyide-db-completion-'));
const driverDir = path.join(work, 'db-drivers');
process.env.PYIDE_DB_DRIVERS = driverDir;
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;

// Real ioredis for the Redis kind; fake mongodb and pg packages next to it (copied after npm, which prunes strangers).
mkdirSync(driverDir, { recursive: true });
writeFileSync(path.join(driverDir, 'package.json'), q({ name: 'pyide-db-drivers', private: true }));
const npm = spawnSync('npm', ['install', '--prefix', `"${driverDir}"`, '--no-audit', '--no-fund', '--loglevel', 'error', 'ioredis@5'], { shell: true, encoding: 'utf8' });
if (npm.status !== 0) { console.log(npm.stdout, npm.stderr); process.exit(1); }
cpSync(path.join(HERE, 'fixtures', 'database-nosql', 'fake-mongodb'), path.join(driverDir, 'node_modules', 'mongodb'), { recursive: true });
cpSync(path.join(HERE, 'fixtures', 'database-completion', 'fake-pg'), path.join(driverDir, 'node_modules', 'pg'), { recursive: true });

// ---------- helpers ----------
// Puts `text` in the editor with the caret at `|`, opens the suggest widget and returns its rendered rows.
async function suggest(t, editorExpr, text, { empty = false } = {}) {
  const at = text.indexOf('|');
  const value = text.slice(0, at) + text.slice(at + 1);
  await t.js(`(() => { const e = ${editorExpr}; e.trigger('t', 'hideSuggestWidget', {}); e.getModel().setValue(${q(value)}); e.focus(); e.setPosition(e.getModel().getPositionAt(${at})); e.trigger('t', 'editor.action.triggerSuggest', {}); return true; })()`);
  const rowsReady = `(() => { const w = document.querySelector('.suggest-widget.visible'); return !!w && !w.classList.contains('message') && w.querySelectorAll('.monaco-list-row').length > 0; })()`;
  if (empty) {
    await t.sleep(1500);
    if (!(await t.js(rowsReady))) return [];
  } else await t.until(rowsReady, `suggestions for ${text}`, 15000);
  await t.sleep(150);
  return t.js(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].sort((a, b) => a.dataset.index - b.dataset.index).map(r => ({
    label: r.querySelector('.label-name').textContent, signature: r.querySelector('.signature-label')?.textContent.trim() || '', right: r.querySelector('.details-label')?.textContent.trim() || '' }))`);
}
const labels = (rows) => rows.map((r) => r.label);
async function accept(t, editorExpr) {
  await t.js(`(${editorExpr}.trigger('t', 'acceptSelectedSuggestion', {}), true)`);
  await t.sleep(200);
  return t.js(`${editorExpr}.getModel().getValue()`);
}
const consoleEditor = 'ide.database.activeConsole().editor';

const redis = await startRespMock({
  password: 'redis-pw',
  seed: { 0: { 'user:1': { type: 'hash', value: new Map([['name', 'Ada']]) }, 'user:2': { type: 'hash', value: new Map([['name', 'Linus']]) }, 'user:2:tags': { type: 'set', value: new Set(['x']) }, session: { type: 'string', value: 's' } } },
});

let a;
let k;
try {
  a = await launch({ fixture: 'database', port: 9841, name: 'database-completion' });
  const file = path.join(a.project, 'shop.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL, "created at" TEXT);
    CREATE TABLE "order items" (order_id INTEGER, sku TEXT);
    CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;`);
  db.close();
  const sqlite = await a.js(`ide.database.addDataSource({ kind: 'sqlite', name: 'shop', file: ${q(file)} })`);
  await a.js(`ide.database.openConsole(${q(sqlite)}).then(() => true)`);

  // ---------- SQL ----------
  let rows = await suggest(a, consoleEditor, 'SELECT * FROM |');
  check(q(labels(rows)) === q(['big_orders', 'order items', 'orders', 'users']), `after FROM: the tables and views (${q(labels(rows))})`);
  rows = await suggest(a, consoleEditor, 'SELECT * FROM ord|');
  check(rows[0].label === 'order items' && (await accept(a, consoleEditor)) === 'SELECT * FROM "order items"', 'an identifier with a space is inserted quoted with the kind\'s quote');
  rows = await suggest(a, consoleEditor, 'SELECT u.| FROM users u JOIN orders AS o ON o.user_id = u.id');
  check(q(rows.map((r) => `${r.label}:${r.signature}:${r.right}`)) === q(['id:integer:users', 'name:text:users', 'email:text:users']), `alias.: the alias's columns in table order, with type and table (${q(rows)})`);
  rows = await suggest(a, consoleEditor, 'SELECT o.cr| FROM users u JOIN orders AS o ON o.user_id = u.id');
  check(rows.length === 1 && rows[0].label === 'created at' && (await accept(a, consoleEditor)).startsWith('SELECT o."created at" FROM'), 'an AS alias resolves too, and an odd column name is quoted');
  rows = await suggest(a, consoleEditor, 'SELECT orders.| FROM orders');
  check(labels(rows)[0] === 'id' && labels(rows).includes('created at'), 'table.: the table\'s columns');
  rows = await suggest(a, consoleEditor, 'SELECT | FROM orders WHERE total > 1');
  check(q(labels(rows).slice(0, 4)) === q(['id', 'user_id', 'total', 'created at']) && rows.slice(0, 4).every((r) => r.right === 'orders'), `columns of the FROM tables are ranked first (${q(labels(rows).slice(0, 6))})`);
  rows = await suggest(a, consoleEditor, 'SELECT * FROM users WH|');
  check(rows.find((r) => r.label === 'WHERE')?.right === 'keyword', 'keywords complete (WHERE)');
  rows = await suggest(a, consoleEditor, 'SELECT * FROM users ORDER BY na|');
  check(rows[0].label === 'name' && rows[0].right === 'users', 'ORDER BY offers the columns of the FROM table');
  rows = await suggest(a, consoleEditor, 'SELECT group_con|');
  check(rows[0].label === 'group_concat' && rows[0].signature === '(x[, separator])', `the kind's functions come with their signatures (${q(rows[0])})`);
  const inserted = await accept(a, consoleEditor);
  await a.until(`!!document.querySelector('.parameter-hints-widget.visible')`, 'signature help', 5000).catch(() => {});
  const hint = await a.js(`document.querySelector('.parameter-hints-widget.visible')?.textContent || ''`);
  check(inserted === 'SELECT group_concat()' && hint.includes('group_concat(x[, separator])'), `accepting a function inserts the call and shows signature help (${q(hint)})`);
  rows = await suggest(a, consoleEditor, 'SELECT upp|');
  check(rows.some((r) => r.label === 'upper' && r.signature === '(x)'), 'ANSI functions merge with the kind\'s lists');
  rows = await suggest(a, consoleEditor, 'CREATE TABLE t (x INTEG|');
  check(rows.some((r) => r.label === 'INTEGER' && r.right === 'data type'), 'data types complete');
  rows = await suggest(a, consoleEditor, 'sel|');
  check(rows.some((r) => r.label === 'SELECT … FROM' && r.right === 'snippet'), 'snippets are offered');
  check(await a.js(`(() => { const e = ${consoleEditor}; e.trigger('t', 'hideSuggestWidget', {}); e.getModel().setValue('sel'); e.setPosition({ lineNumber: 1, column: 4 }); e.trigger('t', 'editor.action.triggerSuggest', {}); return true; })()`), 'select snippet');
  await a.until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].some(r => r.textContent.includes('SELECT … FROM'))`, 'snippet row');
  await a.js(`(() => { const rows = [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]; const i = rows.findIndex(r => r.textContent.includes('SELECT … FROM')); for (let n = 0; n < i; n++) ${consoleEditor}.trigger('t', 'selectNextSuggestion', {}); return true; })()`);
  const expanded = (await accept(a, consoleEditor)).replace(/\r\n/g, '\n');
  check(expanded === 'SELECT *\nFROM table', `the SELECT … FROM snippet expands (${q(expanded)})`);
  rows = await suggest(a, consoleEditor, "SELECT * FROM users WHERE name = '|", { empty: true });
  check(!rows.some((r) => r.right), `no console completions inside a string literal (${q(rows.slice(0, 3))})`);

  // The cache refreshes after DDL from the console.
  await a.js(`ide.database.activeConsole().execute(['CREATE TABLE audit (at TEXT)']).then(() => true)`);
  await a.sleep(300);
  const overlap = await a.js(`(async () => { const c = ide.database.activeConsole(); const before = c.runs; const [x, y] = await Promise.all([c.execute(['SELECT 1']), c.execute(['SELECT 2'])]); return { first: !!x?.ok, second: y === undefined, runs: c.runs - before }; })()`);
  check(overlap.first && overlap.second && overlap.runs === 1, `a second run while one is in progress is ignored (${q(overlap)})`);
  rows = await suggest(a, consoleEditor, 'SELECT * FROM a|');
  check(labels(rows).includes('audit'), 'a table created in the console completes right away');

  // ---------- schema-qualified (PostgreSQL kind, fake pg) ----------
  const pg = await a.js(`ide.database.addDataSource({ kind: 'postgres', name: 'pg', host: '127.0.0.1', port: 5432, user: 'u', password: 'p', database: 'd' })`);
  await a.js(`ide.database.openConsole(${q(pg)}).then(() => true)`);
  rows = await suggest(a, consoleEditor, 'SELECT * FROM |');
  check(q(rows.filter((r) => r.right && r.right !== 'schema').map((r) => `${r.label}@${r.right}`)) === q(['customers@public', 'invoices@sales', 'products@public', 'refunds@sales'])
    && rows.some((r) => r.label === 'sales' && r.right === 'schema'), `tables from every schema with their schema, and the non-default schema itself (${q(rows)})`);
  rows = await suggest(a, consoleEditor, 'SELECT * FROM inv|');
  check((await accept(a, consoleEditor)) === 'SELECT * FROM sales.invoices', 'a table outside the implicit schema is inserted schema-qualified');
  rows = await suggest(a, consoleEditor, 'SELECT * FROM cus|');
  check((await accept(a, consoleEditor)) === 'SELECT * FROM customers', 'a table in public is inserted unqualified');
  rows = await suggest(a, consoleEditor, 'SELECT * FROM sales.|');
  check(q(labels(rows)) === q(['invoices', 'refunds']), 'schema.: that schema\'s tables');
  rows = await suggest(a, consoleEditor, 'SELECT i.| FROM sales.invoices i');
  check(q(labels(rows)) === q(['id', 'customer_id', 'amount']), 'a qualified table\'s alias resolves to its columns');
  rows = await suggest(a, consoleEditor, 'SELECT * FROM t WHERE x ILI|');
  check(rows.some((r) => r.label === 'ILIKE'), 'the PostgreSQL kind adds its own keywords');

  // ---------- no leaks into project files ----------
  writeFileSync(path.join(a.project, 'query.sql'), '');
  for (const f of ['app.py', 'query.sql']) {
    await a.js(`ide.openFile(ide.util.joinPath(ide.root, ${q(f)})).then(() => true)`);
    await a.until(`ide.editor?.getModel()?.uri.path.endsWith(${q(f)})`, `${f} open`);
    rows = await suggest(a, 'ide.editor', 'SELECT * FROM |', { empty: true });
    check(!labels(rows).some((l) => ['users', 'orders', 'customers', 'SELECT … FROM'].includes(l)), `no console completions in ${f} (${q(labels(rows).slice(0, 5))})`);
  }

  // ---------- MongoDB ----------
  const mongo = await a.js(`ide.database.addDataSource({ kind: 'mongodb', name: 'shop-db', uri: 'mongodb://127.0.0.1:27017/shop' })`);
  await a.js(`ide.database.openConsole(${q(mongo)}).then(() => true)`);
  rows = await suggest(a, consoleEditor, 'db.|');
  check(q(labels(rows).slice(0, 2)) === q(['orders', 'users']) && rows[0].right === 'collection' && labels(rows).includes('runCommand'), `db.: the current database's collections, then db methods (${q(labels(rows).slice(0, 4))})`);
  rows = await suggest(a, consoleEditor, 'db.users.|');
  check(labels(rows).includes('find') && labels(rows).includes('aggregate') && rows.find((r) => r.label === 'find').signature === '(filter, projection)', 'db.coll.: collection methods with their arguments');
  rows = await suggest(a, consoleEditor, 'db.users.updateO|');
  check((await accept(a, consoleEditor)) === 'db.users.updateOne({}, {$set: {}})', 'methods insert as snippets');
  rows = await suggest(a, consoleEditor, 'db.users.find({|})');
  check(q(labels(rows).slice(0, 6)) === q(['_id', 'name', 'age', 'address', 'address.city', 'address.zip']), `a filter offers the sampled fields in document order, nested ones as paths (${q(labels(rows).slice(0, 8))})`);
  check(rows.find((r) => r.label === 'age').right === 'int', 'fields show their sampled type');
  rows = await suggest(a, consoleEditor, 'db.users.find({$g|})');
  check(labels(rows).includes('$gt') && labels(rows).includes('$gte') && rows.find((r) => r.label === '$gt').right === 'query operator', 'a filter also offers query operators');
  rows = await suggest(a, consoleEditor, 'db.users.find({age: {|}})');
  check(labels(rows)[0].startsWith('$') && !labels(rows).includes('name'), 'inside a field condition: query operators only');
  rows = await suggest(a, consoleEditor, 'db.users.find({$or: [{|}]})');
  check(labels(rows).includes('name'), 'inside $or: fields again');
  rows = await suggest(a, consoleEditor, 'db.users.updateMany({}, {|})');
  check(labels(rows).includes('$set') && labels(rows).includes('$push') && !labels(rows).includes('name'), 'the update argument offers update operators');
  rows = await suggest(a, consoleEditor, 'db.users.updateMany({}, {$set: {|}})');
  check(labels(rows).includes('name'), 'inside $set: fields');
  rows = await suggest(a, consoleEditor, 'db.users.aggregate([{|}])');
  check(labels(rows).includes('$match') && labels(rows).includes('$group') && rows[0].right === 'aggregation stage', 'a pipeline offers stage names');
  rows = await suggest(a, consoleEditor, "db.users.aggregate([{$group: {_id: '$|'}}])");
  check(labels(rows).includes('$name'), "'$field' paths inside a pipeline string");
  rows = await suggest(a, consoleEditor, 'use |');
  check(q(labels(rows)) === q(['admin', 'shop']), 'use offers the database names');
  rows = await suggest(a, consoleEditor, 'use admin\ndb.|');
  check(labels(rows)[0] === 'system.version' || !labels(rows).includes('users'), 'db. follows the database chosen with use');

  // ---------- Redis ----------
  const cache = await a.js(`ide.database.addDataSource({ kind: 'redis', name: 'cache', host: '127.0.0.1', port: ${redis.port}, password: 'redis-pw' })`);
  await a.js(`ide.database.openConsole(${q(cache)}).then(() => true)`);
  rows = await suggest(a, consoleEditor, 'HGET|');
  check(rows[0].label === 'HGET' && rows[0].signature === 'key field' && labels(rows).includes('HGETALL'), `commands with their argument syntax (${q(rows.slice(0, 2))})`);
  rows = await suggest(a, consoleEditor, 'HGETALL us|');
  check(q(labels(rows)) === q(['user:1', 'user:2', 'user:2:tags']) && rows[0].right === 'key', `keys after a key command (${q(labels(rows))})`);
  const scans = redis.commands.filter((c) => c[0] === 'SCAN');
  check(scans.length && scans.every((c) => c.includes('MATCH') && c[c.indexOf('MATCH') + 1] === 'us*') && !redis.commands.some((c) => c[0] === 'KEYS'), `keys come from SCAN MATCH us*, never KEYS (${q(scans.at(-1))})`);
  rows = await suggest(a, consoleEditor, 'HGETALL user:2 |', { empty: true });
  check(!rows.some((r) => r.right === 'key'), 'no keys after the key argument of a single-key command');
  rows = await suggest(a, consoleEditor, 'DEL session user:|');
  check(labels(rows).includes('user:1'), 'every argument of a multi-key command completes keys');

  check(a.consoleErrors.length === 0, `no renderer exceptions${a.consoleErrors.length ? q(a.consoleErrors) : ''}`);
  await a.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  const localState = path.join(a.userData, 'Local State');
  for (let i = 0; i < 150 && !(existsSync(localState) && readFileSync(localState, 'utf8').includes('encrypted_key')); i++) await a.sleep(200);
  a.close();
  a = null;

  // ---------- Korean ----------
  k = await launch({ fixture: 'database', port: 9842, name: 'database-completion-ko', userData: path.dirname(localState), lang: 'ko-KR' });
  await k.until(`document.querySelectorAll('.db-console').length === 4`, 'consoles restored', 30000);
  await k.sleep(500);
  await k.js(`ide.database.openConsole(${q(sqlite)}).then(() => true)`);
  rows = await suggest(k, consoleEditor, 'SELECT * FROM users WH|');
  check(rows.find((r) => r.label === 'WHERE')?.right === '키워드', `detail text is Korean, SQL stays SQL (${q(rows.slice(0, 3))})`);
  rows = await suggest(k, consoleEditor, 'sel|');
  check(rows.some((r) => r.label === 'SELECT … FROM' && r.right === '스니펫'), 'snippet detail in Korean');
  await k.js(`ide.database.openConsole(${q(mongo)}).then(() => true)`);
  rows = await suggest(k, consoleEditor, 'db.users.find({$|})');
  check(rows.some((r) => r.label === '$gt' && r.right === '쿼리 연산자'), 'MongoDB operator detail in Korean');
  await k.js(`ide.database.openConsole(${q(cache)}).then(() => true)`);
  await suggest(k, consoleEditor, 'HGETAL|');
  await k.js(`(${consoleEditor}.trigger('t', 'toggleSuggestionDetails', {}), true)`);
  await k.until(`document.querySelector('.suggest-details-container .suggest-details')?.textContent.includes('해시의 모든 필드와 값을 가져옵니다')`, 'redis doc', 5000).catch(() => {});
  check((await k.js(`document.querySelector('.suggest-details-container .suggest-details')?.textContent || ''`)).includes('해시의 모든 필드와 값을 가져옵니다'), 'Redis command documentation in Korean');
  check(k.consoleErrors.length === 0, `no renderer exceptions (Korean)${k.consoleErrors.length ? q(k.consoleErrors) : ''}`);
} catch (err) {
  check(false, err.stack || err.message);
} finally {
  a?.close();
  k?.close();
  await redis.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
