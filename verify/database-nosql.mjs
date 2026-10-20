// MongoDB and Redis in the Database tool window, and the console splitters the kinds pick through `ui`.
// - Pure functions: the MongoDB shell parser (no eval), BSON-to-display conversion, the redis-cli argument splitter and
//   reply shapes, key grouping, and the installer's MongoDB wire codec.
// - Redis end to end against a RESP mock server started here: Download Driver (real ioredis from npm), Test Connection,
//   the SCAN-based key tree grouped by `:`, Open Data per key type, and one command per line in the console.
// - MongoDB end to end with a fake `mongodb` package in the driver directory: connection string with the password kept
//   out of sources.json, databases/collections/sampled fields, Open Data, multi-line shell statements, BSON helper
//   arguments reaching the driver as BSON types, the Grid/JSON views, and errors.
// - The statement splitters: 'go-line' (the SQL Server kind), 'mongo', 'lines', 'plsql' and the semicolon default.
// - Korean UI for all of it.
// DB_NOSQL_REAL=1 also installs portable MongoDB through the Install Manager into a temp root (download, sha256,
// extract, init with a generated admin password), starts it, installs the real mongodb driver, adds it as a data
// source, runs CRUD and aggregate from the console and the tree, stops it and removes it.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';
import { startRespMock } from './fixtures/database-nosql/resp-mock.mjs';

const REAL = process.env.DB_NOSQL_REAL === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const work = mkdtempSync(path.join(tmpdir(), 'pyide-nosql-'));
const driverDir = path.join(work, 'db-drivers');
process.env.PYIDE_DB_DRIVERS = driverDir;
const fakeLog = path.join(work, 'fake-mongo.log');
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const q = JSON.stringify;

// ---------- UI helpers (as in verify/database.mjs) ----------
async function clickText(t, selector, text) {
  await t.until(`[...document.querySelectorAll(${q(selector)})].some(n => n.textContent.includes(${q(text)}))`, `${selector} "${text}"`);
  await t.js(`(() => { document.querySelectorAll('[data-test-target]').forEach(n => n.removeAttribute('data-test-target')); const n = [...document.querySelectorAll(${q(selector)})].find(n => n.textContent.includes(${q(text)})); n.scrollIntoView({ block: 'center' }); n.dataset.testTarget = '1'; return true; })()`);
  await t.click('[data-test-target="1"]');
}
async function rightClickText(t, selector, text) {
  await t.until(`[...document.querySelectorAll(${q(selector)})].some(n => n.textContent.includes(${q(text)}))`, `${selector} "${text}"`);
  const box = await t.js(`(() => { const n = [...document.querySelectorAll(${q(selector)})].find(n => n.textContent.includes(${q(text)})); n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await t.sleep(80);
}
async function doubleClickText(t, selector, text) {
  await t.until(`[...document.querySelectorAll(${q(selector)})].some(n => n.querySelector('.db-label')?.textContent === ${q(text)})`, `${selector} "${text}"`);
  await t.js(`([...document.querySelectorAll(${q(selector)})].find(n => n.querySelector('.db-label')?.textContent === ${q(text)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`);
}
const setInput = (t, selector, value) => t.js(`(() => { const n = document.querySelector(${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const activeConsole = `document.querySelector('.custom-tab:not(.hidden) .db-console, .custom-tab.db-console:not(.hidden)')`;
const status = (t) => t.js(`${activeConsole}?.querySelector('.db-result-status').textContent`);
const gridRows = (t) => t.js(`[...${activeConsole}.querySelectorAll('.db-grid tbody tr')].map(r => [...r.children].slice(1).map(td => td.textContent))`);
const gridHead = (t) => t.js(`[...${activeConsole}.querySelectorAll('.db-grid th')].slice(1).map(th => th.firstChild.textContent)`);
const treeLabels = (t, kind) => t.js(`[...document.querySelectorAll('#dbTree .db-node.db-${kind}')].map(n => n.querySelector('.db-label').textContent + (n.querySelector('.db-detail') ? ' ' + n.querySelector('.db-detail').textContent : ''))`);
async function runs(t, fn, label) {
  const before = await t.js('ide.database.activeConsole().runs');
  await fn();
  await t.until(`ide.database.activeConsole().runs > ${before}`, label, 20000);
}
async function runLine(t, line, column = 3) {
  await t.js(`(() => { const c = ide.database.activeConsole(); c.editor.focus(); c.editor.setPosition({ lineNumber: ${line}, column: ${column} }); return true; })()`);
  await runs(t, () => t.press('Ctrl+Enter'), `statement on line ${line} ran`);
}
const setConsole = (t, text) => t.js(`(ide.database.activeConsole().model.setValue(${q(text)}), true)`);
const fakeCalls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---------- pure functions ----------
{
  const { parseCommand, parseValue, ShellValue, openDataCommand } = require('../main/db/mongo-shell.js');
  const c = parseCommand("db.users.find({age: {$gt: 30}, name: /^a/i, 'x y': ObjectId('65a1b2c3d4e5f60718293a4b'),}, {name: 1, _id: 0}).sort({age: -1}).limit(5).skip(2);");
  check(c.type === 'call' && c.collection === 'users' && c.method === 'find' && c.args[0].age.$gt === 30 && c.args[0].name instanceof RegExp && c.args[0].name.flags === 'i'
    && c.args[0]['x y'] instanceof ShellValue && c.args[0]['x y'].value === '65a1b2c3d4e5f60718293a4b' && q(c.chain.map((x) => x.method)) === q(['sort', 'limit', 'skip']),
  'mongo shell: find with unquoted keys, single quotes, regex literal, ObjectId(), trailing comma and a cursor chain');
  const helpers = parseValue("{d: ISODate('2024-01-02T03:04:05Z'), n: NumberLong('9007199254740993'), i: NumberInt(7), x: NumberDecimal('1.10'), u: UUID('01234567-89ab-cdef-0123-456789abcdef'), neg: -2.5, e: 1e3, h: 0x10, s: \"a\\u00e9\\n\", nul: null, t: Timestamp(1, 2), dt: new Date('2020-01-01')}");
  check(helpers.d instanceof Date && helpers.d.toISOString() === '2024-01-02T03:04:05.000Z' && helpers.n.type === 'Long' && helpers.n.value === '9007199254740993' && helpers.i.type === 'Int32'
    && helpers.x.value === '1.10' && helpers.u.value === '0123456789abcdef0123456789abcdef' && helpers.neg === -2.5 && helpers.e === 1000 && helpers.h === 16 && helpers.s === 'aé\n'
    && helpers.nul === null && q(helpers.t.value) === q({ t: 1, i: 2 }) && helpers.dt instanceof Date, 'mongo shell: ISODate, NumberLong, NumberInt, NumberDecimal, UUID, Timestamp, new Date and JS number/string forms');
  check(q(parseCommand('show dbs')) === q({ type: 'show', what: 'dbs' }) && q(parseCommand('use shop;')) === q({ type: 'use', db: 'shop' }), 'mongo shell: show dbs and use');
  const sib = parseCommand("db.getSiblingDB('admin').getCollection('my coll').countDocuments({})");
  const dotted = parseCommand('db.system.profile.find()');
  const bracket = parseCommand('db["weird name"].distinct("k")');
  check(sib.db === 'admin' && sib.collection === 'my coll' && dotted.collection === 'system.profile' && bracket.collection === 'weird name' && parseCommand('db.runCommand({ping: 1})').collection === null,
    'mongo shell: getSiblingDB, getCollection, dotted and bracketed collection names, database methods');
  const proto = parseCommand('db.c.find({__proto__: {polluted: 1}})');
  check(Object.prototype.hasOwnProperty.call(proto.args[0], '__proto__') && ({}).polluted === undefined, 'mongo shell: a __proto__ key is plain data and pollutes nothing');
  const refused = ['require("fs")', 'db.c.find({}).forEach(function(){})', 'db.c.find({$where: this.x})', 'db.c.find({a: process.exit(1)})', 'db.c.find({a: `${1}`})', 'db.c.find({a: 1 / 2})', "db.c.find({_id: ObjectId('zz')})", 'db.c.find('];
  const errors = refused.map((s) => { try { parseCommand(s); return null; } catch (e) { return e.constructor.name; } });
  check(errors.every((e) => e === 'ShellSyntaxError'), `mongo shell: code, functions, template expressions, division and bad helpers are syntax errors, never evaluated (${q(errors)})`);
  check(openDataCommand('shop', 'users') === 'use shop\ndb.users.find({}).limit(200)' && openDataCommand('shop', 'my-coll') === 'use shop\ndb.getCollection("my-coll").find({}).limit(200)',
    'mongo shell: Open Data command for plain and unusual collection names');

  const { plain, flatten, shellText } = require('../main/db/kinds/mongodb.js').forTests;
  const fake = require('./fixtures/database-nosql/fake-mongodb/index.js');
  const doc = plain({ _id: new fake.ObjectId('65a1b2c3d4e5f60718293a40'), when: new Date('2024-05-06T07:08:09Z'), big: new fake.Long('9007199254740993'), small: new fake.Long('42'),
    n: new fake.Int32(5), dec: fake.Decimal128.fromString('1.10'), nested: { a: [1, { b: null }] }, re: /x+/g });
  check(q(doc) === q({ _id: { $oid: '65a1b2c3d4e5f60718293a40' }, when: { $date: '2024-05-06T07:08:09.000Z' }, big: { $numberLong: '9007199254740993' }, small: 42, n: 5, dec: { $numberDecimal: '1.10' }, nested: { a: [1, { b: null }] }, re: { $regex: 'x+', $options: 'g' } }),
    'mongodb kind: BSON values become tagged JSON (ObjectId, Date, Long beyond 2^53, Decimal128, regex)');
  const flat = flatten([doc, { _id: { $oid: '65a1b2c3d4e5f60718293a41' }, extra: true }]);
  check(q(flat.columns.map((x) => `${x.name}:${x.type}`)) === q(['_id:objectId', 'when:date', 'big:long', 'small:int', 'n:int', 'dec:decimal', 'nested:object', 're:regex', 'extra:bool'])
    && q(flat.rows[0].slice(0, 4)) === q(['65a1b2c3d4e5f60718293a40', '2024-05-06T07:08:09.000Z', '9007199254740993', 42]) && flat.rows[0][6] === '{ a: [1, { b: null }] }' && flat.rows[1][1] === null,
  `mongodb kind: documents flatten to top-level columns with readable cells (${q(flat.rows[0])})`);
  check(shellText({ _id: { $oid: 'ab' }, 'odd key': { $date: 'd' } }) === "{ _id: ObjectId('ab'), \"odd key\": ISODate('d') }", 'mongodb kind: nested values print in shell syntax');

  const r = require('../main/db/redis-cli.js');
  check(q(r.splitArgs(String.raw`SET "a b" 'it\'s' "x\ny\x41" plain`)) === q(['SET', 'a b', "it's", 'x\nyA', 'plain']), 'redis-cli: quoted words and escapes split like redis-cli');
  let unbalanced = null;
  try { r.splitArgs('GET "open'); } catch (e) { unbalanced = e.message; }
  check(unbalanced === 'Unbalanced quotes', 'redis-cli: unbalanced quotes are an error');
  check(q(r.formatReply(['HGETALL', 'h'], ['f', 'v'])) === q({ columns: [{ name: 'field', type: '' }, { name: 'value', type: '' }], rows: [['f', 'v']] })
    && q(r.formatReply(['zrange', 'z', '0', '-1', 'withscores'], ['a', '1.5']).rows) === q([['a', 1.5]])
    && q(r.formatReply(['XRANGE', 's', '-', '+'], [['1-0', ['a', '1']], ['2-0', ['b', '2']]]).rows) === q([['1-0', '1', null], ['2-0', null, '2']])
    && r.formatReply(['INCR', 'k'], 3).message === '(integer) 3' && r.formatReply(['GET', 'k'], null).message === '(nil)' && r.formatReply(['SET', 'k', 'v'], 'OK').message === 'OK',
  'redis-cli: replies shaped by command (hash pairs, scores, stream entries, integers, nil, status)');
  const tree = r.groupKeys([{ key: 'user:1', type: 'hash' }, { key: 'user:2', type: 'hash' }, { key: 'user:2:tags', type: 'set' }, { key: 'solo:x', type: 'string' }, { key: 'plain', type: 'list' }], 3);
  check(q(tree.map((n) => n.name)) === q(['user:', 'plain', 'solo:x']) && q(tree[0].children.map((n) => n.name)) === q(['user:1', 'user:2', 'user:2:tags']) && tree[0].children[0].open === 'SELECT 3\nHGETALL user:1',
    'redis-cli: keys group by a shared `:` prefix and carry their Open Data command');
  check(r.openDataCommand(0, 'my key', 'zset') === 'SELECT 0\nZRANGE "my key" 0 199 WITHSCORES', 'redis-cli: Open Data quotes awkward key names');

  const wire = require('../main/installer/mongo-wire.js');
  const round = wire.decodeDoc(wire.encodeDoc({ s: 'é', i: 7, d: 1.5, b: true, n: null, o: { a: [1, 'x'] }, big: 2 ** 40 }));
  check(q(round) === q({ s: 'é', i: 7, d: 1.5, b: true, n: null, o: { a: [1, 'x'] }, big: 2 ** 40 }), 'installer: the MongoDB wire codec round-trips BSON documents');
}

// ---------- Redis against the RESP mock ----------
const hash = (o) => ({ type: 'hash', value: new Map(Object.entries(o)) });
const redis = await startRespMock({
  password: 'redis-pw',
  seed: {
    0: {
      'user:1': hash({ name: 'Ada', lang: 'en' }), 'user:2': hash({ name: 'Linus' }), 'user:2:tags': { type: 'set', value: new Set(['kernel', 'git']) },
      queue: { type: 'list', value: ['first', 'second', 'third'] }, leaderboard: { type: 'zset', value: new Map([['ada', 30], ['linus', 12.5]]) },
      events: { type: 'stream', value: [['1-0', ['kind', 'login', 'user', 'ada']], ['2-0', ['kind', 'logout']]] }, 'cache:greeting': { type: 'string', value: 'hello world' },
    },
    2: { other: { type: 'string', value: 'x' } },
  },
});

let a;
let b;
let k;
try {
  a = await launch({ fixture: 'database', port: 9834, name: 'database-nosql', env: { FAKE_MONGO_LOG: fakeLog } });
  await a.js(`ide.toolWindows.get('Database').show()`);

  // ---------- splitters, through the renderer ----------
  const split = (text, mode) => a.js(`ide.database.splitStatements(${q(text)}, ${q(mode)}).map(p => p.text).filter(Boolean)`);
  const tsql = "SELECT 1; SELECT 2\nGO\nCREATE PROCEDURE p AS\nBEGIN\n  SELECT 'GO';\n  SELECT 'a\nGO\nb'; -- GO\nEND\n  go 2  \n/* \nGO\n */ SELECT [GO\nx]\nGO";
  check(q(await split(tsql, 'go-line')) === q(['SELECT 1; SELECT 2', "CREATE PROCEDURE p AS\nBEGIN\n  SELECT 'GO';\n  SELECT 'a\nGO\nb'; -- GO\nEND", '/* \nGO\n */ SELECT [GO\nx]']),
    'go-line: a line holding only GO (any case, with a count) ends a T-SQL batch; GO in strings, comments and [names] does not, and `;` stays inside');
  const caret = await a.js(`(() => { const t = ${q(tsql)}; return ide.database.statementAt(t, t.indexOf('BEGIN'), 'go-line').text.startsWith('CREATE PROCEDURE'); })()`);
  check(caret, 'go-line: the statement at the caret is the whole batch');
  const mongoText = "show dbs\nuse shop\ndb.users.find(\n  {age: {$gt: 1}}, // a; comment\n  {name: 1}\n)\n  .sort({age: -1})\n  .limit(2)\n\ndb.c.find({re: /[)}]/, s: ')}'}); db.c.countDocuments({})\ndb.c.aggregate([\n  {$match: {}},\n])";
  check(q(await split(mongoText, 'mongo')) === q(['show dbs', 'use shop', 'db.users.find(\n  {age: {$gt: 1}}, // a; comment\n  {name: 1}\n)\n  .sort({age: -1})\n  .limit(2)', "db.c.find({re: /[)}]/, s: ')}'})", 'db.c.countDocuments({})', 'db.c.aggregate([\n  {$match: {}},\n])']),
    'mongo: an expression runs across lines until its brackets balance, a leading `.` continues it, `;` and line ends separate statements; strings, regexes and comments are skipped');
  check(q(await split('SET a 1\n\nGET a\n# note\nINCR "b c"', 'lines')) === q(['SET a 1', 'GET a', '# note', 'INCR "b c"'])
    && await a.js(`ide.database.splitStatements('SET a 1\\n# note', 'lines').filter(p => !/^\\s*(#|$)/.test(p.text)).length === 1`), 'lines: one Redis command per line');
  const plsql = "SELECT 1 FROM dual;\nBEGIN\n  x := 1;\n  y := q'[it's; fine]';\nEND;\n/\nCREATE OR REPLACE PROCEDURE p IS BEGIN NULL; END;\n/\nSELECT 2 FROM dual";
  check(q(await split(plsql, 'plsql')) === q(['SELECT 1 FROM dual', "BEGIN\n  x := 1;\n  y := q'[it's; fine]';\nEND;", 'CREATE OR REPLACE PROCEDURE p IS BEGIN NULL; END;', 'SELECT 2 FROM dual']),
    'plsql: `;` ends SQL, a PL/SQL unit keeps its semicolons and ends at a `/` line');
  check(q(await split("SELECT ';'; SELECT $$a;b$$; -- x;\nSELECT 3", 'semicolon')) === q(["SELECT ';'", 'SELECT $$a;b$$', '-- x;\nSELECT 3']), 'semicolon: the SQL default is unchanged');

  // ---------- Redis: driver download, connection, tree ----------
  await a.click('#dbAdd');
  await clickText(a, '.context-menu .menu-item', 'Redis');
  await a.until(`!!document.querySelector('.db-dialog #dbField-db')`, 'redis dialog');
  const fields = await a.js(`[...document.querySelectorAll('.db-dialog [data-field]')].map(n => n.dataset.field + '=' + (n.type === 'checkbox' ? n.checked : n.value))`);
  check(q(fields) === q(['host=', 'port=6379', 'user=', 'password=', 'db=0', 'tls=false']), `Redis asks for host, port 6379, username, password, database index and TLS (${q(fields)})`);
  check(await a.js(`!!document.querySelector('#dbDownloadDriver') && document.querySelector('#dbDriverMissing').textContent.includes('Redis')`), 'the ioredis driver starts out missing');
  await a.click('#dbDownloadDriver');
  await a.until(`!document.querySelector('#dbDriverMissing') && /ioredis 5\\./.test(document.querySelector('.db-driver')?.textContent)`, 'ioredis installed', 300000);
  check(true, 'Download Driver installs ioredis 5 from npm');
  await setInput(a, '#dbName', 'cache');
  await setInput(a, '#dbField-host', '127.0.0.1');
  await setInput(a, '#dbField-port', String(redis.port));
  await setInput(a, '#dbField-password', 'wrong');
  await a.click('#dbTest');
  await a.until(`document.querySelector('#dbTestResult').classList.contains('err')`, 'redis wrong password');
  check((await a.js(`document.querySelector('#dbTestResult').textContent`)).includes('WRONGPASS'), 'a wrong password shows the server error');
  await setInput(a, '#dbField-password', 'redis-pw');
  await a.click('#dbTest');
  await a.until(`document.querySelector('#dbTestResult').classList.contains('ok')`, 'redis test ok');
  check((await a.js(`document.querySelector('#dbTestResult').textContent`)).includes('Redis 7.2.0-mock'), 'Test Connection reports the Redis version');
  await clickText(a, '.db-dialog .dialog-buttons button', 'OK');
  await a.until(`!document.querySelector('.db-dialog') && ide.database.list().some(s => s.name === 'cache')`, 'redis saved');
  await clickText(a, '#dbTree .db-node.db-source', 'cache');
  await a.until(`document.querySelectorAll('#dbTree .db-node.db-database').length === 2`, 'redis databases');
  check(q(await treeLabels(a, 'database')) === q(['db0 (7)', 'db2 (1)']), `the tree lists the databases holding keys with their key counts (${q(await treeLabels(a, 'database'))})`);
  await clickText(a, '#dbTree .db-node.db-database', 'db0');
  await a.until(`document.querySelectorAll('#dbTree .db-node.db-key').length >= 4`, 'redis keys');
  const groups = await treeLabels(a, 'group');
  const keys = await treeLabels(a, 'key');
  check(q(groups) === q(['user: (3)']) && q(keys) === q(['cache:greeting string', 'events stream', 'leaderboard zset', 'queue list']),
    `keys show with their types, grouped by a shared \`:\` prefix (${q(groups)} ${q(keys)})`);
  await clickText(a, '#dbTree .db-node.db-group', 'user:');
  await a.until(`[...document.querySelectorAll('#dbTree .db-node.db-key')].some(n => n.textContent.includes('user:2:tags'))`, 'group opens');
  check(q(await treeLabels(a, 'key')).includes('"user:1 hash","user:2 hash","user:2:tags set"'), 'a key group expands to its keys');
  const used = redis.commands.map((c) => c[0]);
  check(used.includes('SCAN') && !used.includes('KEYS'), `keys are found with SCAN, never KEYS (${[...new Set(used)].join(' ')})`);
  await a.shot('redis-tree.png');

  // ---------- Redis: Open Data by type ----------
  await doubleClickText(a, '#dbTree .db-node.db-key', 'user:1');
  await a.until(`!!ide.database.activeConsole() && ${activeConsole}.querySelectorAll('.db-grid tbody tr').length === 2`, 'hash open data');
  check(await a.js(`ide.database.activeConsole().model.getValue().endsWith('SELECT 0\\nHGETALL user:1')`) && q(await gridHead(a)) === q(['field', 'value']) && q(await gridRows(a)) === q([['name', 'Ada'], ['lang', 'en']]),
    'Open Data on a hash shows its fields as a table');
  const opened = async (key, head, rows) => {
    await doubleClickText(a, '#dbTree .db-node.db-key', key);
    await a.until(`${activeConsole}.querySelector('.db-grid') && ${q(q(head))} === JSON.stringify([...${activeConsole}.querySelectorAll('.db-grid th')].slice(1).map(th => th.firstChild.textContent)) && ${activeConsole}.querySelectorAll('.db-grid tbody tr').length === ${rows.length}`, `open ${key}`);
    return q(await gridRows(a)) === q(rows);
  };
  check(await opened('leaderboard', ['member', 'score'], [['linus', '12.5'], ['ada', '30']]), 'Open Data on a sorted set shows members with scores');
  check(await opened('queue', ['value'], [['first'], ['second'], ['third']]), 'Open Data on a list shows one row per element');
  check(await opened('events', ['id', 'kind', 'user'], [['1-0', 'login', 'ada'], ['2-0', 'logout', 'NULL']]), 'Open Data on a stream shows its entries with a column per field');
  check(await opened('cache:greeting', ['value'], [['hello world']]), 'Open Data on a string shows its value');
  await doubleClickText(a, '#dbTree .db-node.db-key', 'user:2:tags');
  await a.until(`ide.database.activeConsole().model.getValue().endsWith('SMEMBERS user:2:tags') && ${activeConsole}.querySelectorAll('.db-grid tbody tr').length === 2`, 'set open data');
  check(true, 'Open Data on a set lists its members');

  // ---------- Redis console: one command per line ----------
  await setConsole(a, 'SET "greeting key" "hello there"\nGET "greeting key"\nINCR counter\nGET missing\nNOPE 1');
  await runLine(a, 1);
  check((await a.js(`${activeConsole}.querySelector('.db-reply')?.textContent`)) === 'OK', 'Ctrl+Enter on a line runs that command and shows the reply (OK)');
  await runLine(a, 2);
  check(q(await gridRows(a)) === q([['hello there']]), 'GET shows the value with quoting handled');
  await runLine(a, 3);
  check((await a.js(`${activeConsole}.querySelector('.db-reply')?.textContent`)) === '(integer) 1', 'integer replies read like redis-cli');
  await runLine(a, 4);
  check((await a.js(`${activeConsole}.querySelector('.db-reply')?.textContent`)) === '(nil)', 'a missing key reads (nil)');
  await runLine(a, 5);
  check((await a.js(`${activeConsole}.querySelector('.db-error-text')?.textContent`)).includes("unknown command 'NOPE'"), 'a Redis error is shown as an error');
  await runs(a, () => a.js(`(() => { const c = ide.database.activeConsole(); c.editor.setSelection(new ide.monaco.Selection(1, 1, 3, 13)); return c.runAtCaret(), true; })()`), 'selection');
  check((await status(a)).startsWith('3 of 3 statements executed'), `a selection of three lines runs three commands (${await status(a)})`);
  check(await a.js(`ide.database.activeConsole().model.getLanguageId() === 'plaintext'`), 'the Redis console is plain text');
  await a.shot('redis-console.png');
  check(a.consoleErrors.length === 0, `no renderer exceptions (Redis)${a.consoleErrors.length ? q(a.consoleErrors) : ''}`);
  a.close();
  a = null;

  // ---------- MongoDB with the fake driver ----------
  cpSync(path.join(HERE, 'fixtures', 'database-nosql', 'fake-mongodb'), path.join(driverDir, 'node_modules', 'mongodb'), { recursive: true });
  b = await launch({ fixture: 'database', port: 9835, name: 'database-nosql-mongo', env: { FAKE_MONGO_LOG: fakeLog } });
  await b.js(`ide.toolWindows.get('Database').show()`);
  await b.click('#dbAdd');
  await clickText(b, '.context-menu .menu-item', 'MongoDB');
  await b.until(`!!document.querySelector('.db-dialog #dbField-uri')`, 'mongo dialog');
  const mfields = await b.js(`[...document.querySelectorAll('.db-dialog [data-field]')].map(n => n.dataset.field + '=' + (n.type === 'checkbox' ? n.checked : n.value))`);
  check(q(mfields) === q(['uri=', 'host=', 'port=27017', 'user=', 'password=', 'database=', 'authSource=', 'tls=false']), `MongoDB asks for a connection string or host, port 27017, user, password, database, auth database and TLS (${q(mfields)})`);
  check(await b.js(`document.querySelector('.db-driver').textContent.includes('mongodb 7.0.0-fake')`), 'the (fake) mongodb driver shows as installed');
  await setInput(b, '#dbName', 'shop-db');
  await setInput(b, '#dbField-uri', 'mongodb://ada:s3cr%40t@127.0.0.1:27017/shop?authSource=admin');
  await b.click('#dbTest');
  await b.until(`document.querySelector('#dbTestResult').classList.contains('ok')`, 'mongo test ok');
  check((await b.js(`document.querySelector('#dbTestResult').textContent`)).includes('MongoDB 8.0.0-fake'), 'Test Connection reports the MongoDB version');
  await clickText(b, '.db-dialog .dialog-buttons button', 'OK');
  await b.until(`!document.querySelector('.db-dialog') && ide.database.list().some(s => s.name === 'shop-db')`, 'mongo saved');
  const onDisk = readFileSync(path.join(b.userData, 'database', 'sources.json'), 'utf8');
  const listed = await b.js(`ide.api.invoke('db:list')`);
  check(!onDisk.includes('s3cr') && onDisk.includes('mongodb://ada@127.0.0.1:27017/shop?authSource=admin') && listed.find((s) => s.name === 'shop-db').hasPassword,
    'a password typed into the connection string is stored encrypted, not in sources.json');
  check(fakeCalls().filter((c) => c.op === 'client').every((c) => c.uri === 'mongodb://ada:s3cr%40t@127.0.0.1:27017/shop?authSource=admin'), 'the driver still receives the full connection string');

  await clickText(b, '#dbTree .db-node.db-source', 'shop-db');
  await b.until(`document.querySelectorAll('#dbTree .db-node.db-database').length === 2`, 'mongo databases');
  check(q(await treeLabels(b, 'database')) === q(['admin', 'shop']), 'the tree lists the databases');
  await clickText(b, '#dbTree .db-node.db-database', 'shop');
  await b.until(`document.querySelectorAll('#dbTree .db-node.db-collection').length === 2`, 'collections');
  check(q(await treeLabels(b, 'collection')) === q(['orders', 'users']), 'a database lists its collections');
  await clickText(b, '#dbTree .db-node.db-collection', 'users');
  await b.until(`document.querySelectorAll('#dbTree .db-node.db-field').length >= 6`, 'fields');
  const sampled = await treeLabels(b, 'field');
  check(q(sampled) === q(['_id objectId', 'name string', 'age int', 'address object | null', 'tags array', 'joined date', 'balance long']), `expanding a collection samples its field names and types (${q(sampled)})`);
  await clickText(b, '#dbTree .db-node.db-field', 'address');
  await b.until(`[...document.querySelectorAll('#dbTree .db-node.db-field')].some(n => n.textContent.includes('zip'))`, 'nested fields');
  check((await treeLabels(b, 'field')).includes('city string'), 'embedded documents show their own fields');
  check(fakeCalls().some((c) => c.op === 'aggregate' && c.raw[0][0].$sample), 'fields come from a $sample of the collection');

  // Open Data from the context menu
  await rightClickText(b, '#dbTree .db-node.db-collection', 'users');
  await clickText(b, '.context-menu .menu-item', 'Open Data');
  await b.until(`!!ide.database.activeConsole() && ${activeConsole}.querySelectorAll('.db-grid tbody tr').length === 3`, 'mongo open data');
  check(await b.js(`ide.database.activeConsole().model.getValue().endsWith('use shop\\ndb.users.find({}).limit(200)')`), 'Open Data appends use shop and find({}).limit(200) to the console');
  check(q(await gridHead(b)) === q(['_id', 'name', 'age', 'address', 'tags', 'joined', 'balance']), `documents flatten to top-level columns (${q(await gridHead(b))})`);
  const firstRow = (await gridRows(b))[0];
  check(q(firstRow) === q(['65a1b2c3d4e5f60718293a40', 'Ada', '36', '{ city: "London", zip: "NW1" }', '["math", "poetry"]', '1842-01-01T00:00:00.000Z', 'NULL']), `ObjectId and dates read as strings, nested values in shell syntax (${q(firstRow)})`);
  check(/(^| · )3 documents · /.test(await status(b)), `the status counts documents (${await status(b)})`);
  check(await b.js(`ide.database.activeConsole().model.getLanguageId() === 'mongosh'`), 'the console speaks the mongosh dialect');

  // Grid / JSON
  await clickText(b, `.custom-tab:not(.hidden) .db-view-btn`, 'JSON');
  await b.until(`${activeConsole}.querySelectorAll('.db-json > .db-json-node').length === 3`, 'json view');
  check((await b.js(`${activeConsole}.querySelector('.db-json-summary').textContent`)).startsWith(`{ _id: ObjectId('65a1b2c3d4e5f60718293a40'), name: "Ada", age: 36, address: {…}, tags: […2], joined: ISODate('1842-01-01T00:00:00.000Z')`),
    'the JSON view lists each document with a shell-style preview');
  await b.js(`(${activeConsole}.querySelector('.db-json-line').click(), true)`);
  await b.until(`${activeConsole}.querySelectorAll('.db-json > .db-json-node:first-child > .db-json-children > .db-json-node').length === 6`, 'doc expands');
  await b.js(`([...${activeConsole}.querySelectorAll('.db-json-key')].find(k => k.textContent === 'address').parentElement.click(), true)`);
  const jsonText = await b.js(`${activeConsole}.querySelector('.db-json > .db-json-node').innerText`);
  check(jsonText.includes("ObjectId('65a1b2c3d4e5f60718293a40')") && jsonText.includes('city') && jsonText.includes('"London"') && jsonText.includes("ISODate('1842-01-01T00:00:00.000Z')"), 'a document expands into an expandable JSON tree');
  await b.shot('mongo-json.png');
  await clickText(b, `.custom-tab:not(.hidden) .db-view-btn`, 'Grid');
  await b.until(`!!${activeConsole}.querySelector('.db-grid')`, 'grid back');

  // Console: multi-line statements, BSON helpers, CRUD, aggregate
  const SCRIPT = [
    "db.users.insertOne({name: 'Hopper', age: NumberInt(85), born: ISODate('1906-12-09T00:00:00Z'), ref: ObjectId('65a1b2c3d4e5f60718293a40'), tags: ['navy', \"cobol\"],})",
    'db.users.find(',
    '  {age: {$gte: 50}},',
    '  {name: 1, _id: 0}',
    ')',
    '  .sort({age: -1})',
    "db.users.updateMany({name: /^(Ada|Linus)$/}, {$inc: {age: 1}})",
    'db.users.aggregate([',
    '  {$match: {age: {$gt: 0}}},',
    '  {$group: {_id: null, n: {$sum: 1}, years: {$sum: "$age"}}}',
    '])',
    "db.users.deleteOne({name: 'Hopper'})",
    'db.users.countDocuments({})',
    'db.users.find({a: foo})',
    'show collections',
  ].join('\n');
  await setConsole(b, SCRIPT);
  await runLine(b, 1);
  check((await status(b)).startsWith('1 documents affected'), `insertOne reports one document written (${await status(b)})`);
  const insert = fakeCalls().find((c) => c.op === 'insertOne');
  check(q(insert.args[0]) === q({ name: 'string', age: 'Int32', born: 'Date', ref: 'ObjectId', tags: ['string', 'string'] }), `shell helpers reach the driver as BSON types (${q(insert.args[0])})`);
  await runLine(b, 3);
  check(q(await gridRows(b)) === q([['Grace'], ['Hopper'], ['Linus']]) && fakeCalls().some((c) => c.op === 'find' && q(c.raw[1]) === q({ projection: { name: 1, _id: 0 } })),
    `Ctrl+Enter inside a multi-line find runs the whole chained statement (${q(await gridRows(b))})`);
  await runLine(b, 7);
  check((await status(b)).startsWith('2 documents affected'), `updateMany with a regex filter (${await status(b)})`);
  await runLine(b, 9);
  check(q(await gridHead(b)) === q(['_id', 'n', 'years']) && q(await gridRows(b)) === q([['NULL', '4', '262']]), `aggregate runs a pipeline (${q(await gridRows(b))})`);
  await runLine(b, 12);
  check((await status(b)).startsWith('1 documents affected'), 'deleteOne');
  await runLine(b, 13);
  check(q(await gridRows(b)) === q([['3']]), 'countDocuments');
  await runLine(b, 14);
  check((await b.js(`${activeConsole}.querySelector('.db-error-text')?.textContent`)).includes('Unknown name foo at line 1, column 19'), 'a shell syntax error points at the line and column');
  await runLine(b, 15);
  check(q(await gridRows(b)) === q([['orders', 'collection'], ['users', 'collection']]), 'show collections lists the current database');
  await setConsole(b, 'use admin\ndb.runCommand({ping: 1})');
  await runLine(b, 1);
  check((await b.js(`${activeConsole}.querySelector('.db-message')?.textContent`)) === 'Switched to database admin', 'use switches the console database');
  await runLine(b, 2);
  check(fakeCalls().at(-1).op === 'command' && fakeCalls().at(-1).db === 'admin', 'later commands run in the database chosen with use');
  check(b.consoleErrors.length === 0, `no renderer exceptions (MongoDB)${b.consoleErrors.length ? q(b.consoleErrors) : ''}`);
  await b.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  // The test kills the process; safeStorage's key reaches Local State on a timer, and without it the next launch
  // cannot decrypt the saved password.
  const localState = path.join(b.userData, 'Local State');
  for (let i = 0; i < 150 && !(existsSync(localState) && readFileSync(localState, 'utf8').includes('encrypted_key')); i++) await b.sleep(200);
  b.close();

  // ---------- Korean ----------
  k = await launch({ fixture: 'database', port: 9836, name: 'database-nosql-ko', userData: b.userData, lang: 'ko-KR', env: { FAKE_MONGO_LOG: fakeLog } });
  b = null;
  await k.until(`!!ide.database.activeConsole()`, 'console restored', 20000);
  await k.js(`ide.toolWindows.get('Database').show()`);
  await clickText(k, '#dbTree .db-node.db-source', 'shop-db');
  await clickText(k, '#dbTree .db-node.db-database', 'shop');
  await clickText(k, '#dbTree .db-node.db-collection', 'users');
  await k.until(`document.querySelectorAll('#dbTree .db-node.db-field').length >= 6`, 'ko fields');
  await setConsole(k, 'db.users.find({})\nuse shop');
  await runLine(k, 1);
  await clickText(k, `.custom-tab:not(.hidden) .db-view-btn`, 'JSON');
  check((await status(k)).includes('문서 3개') && (await k.js(`[...${activeConsole}.querySelectorAll('.db-view-btn')].map(b => b.textContent).join()`)) === '그리드,JSON', `results are in Korean (${await status(k)})`);
  await runLine(k, 2);
  check((await k.js(`${activeConsole}.querySelector('.db-message')?.textContent`)) === '데이터베이스를 shop(으)로 전환했습니다', 'the use notice is translated');
  const allowed = ['MongoDB', 'Redis', 'SQLite', 'PostgreSQL', 'MySQL', 'MariaDB', 'JSON', 'CSV', 'TSV', 'NULL', 'TLS', 'ms', 'mongodb', 'SELECT', 'localhost', 'admin', 'default'];
  let leaks = await englishLeaks(k, '.db-tool, .db-console', allowed);
  await rightClickText(k, '#dbTree .db-node.db-source', 'shop-db');
  await k.until(`!!document.querySelector('.context-menu')`, 'ko menu');
  leaks = [...leaks, ...await englishLeaks(k, '.context-menu', allowed)];
  await clickText(k, '.context-menu .menu-item', '데이터 소스 편집');
  await k.until(`!!document.querySelector('.db-dialog #dbField-uri')`, 'ko dialog');
  leaks = [...leaks, ...await englishLeaks(k, '.db-dialog', allowed)];
  check(!leaks.length, `MongoDB and Redis UI is in Korean${leaks.length ? ` ${q(leaks)}` : ''}`);
  await k.shot('korean.png');
  await k.press('Escape');
  check(k.consoleErrors.length === 0, 'no renderer exceptions (Korean)');
  k.close();
  k = null;

  if (REAL) await realMongo();
} catch (err) {
  check(false, err.stack || err.message);
} finally {
  a?.close();
  b?.close();
  k?.close();
  await redis.close();
}

// ---------- real portable MongoDB through the Install Manager ----------
async function realMongo() {
  const root = path.join(work, 'root');
  const card = (id) => `.inst-card[data-id="${id}"]`;
  const waitPhase = async (t, id, want, ms) => {
    try {
      await t.until(`document.querySelector('${card(id)}')?.dataset.phase === '${want}'`, `${id} ${want}`, ms);
    } catch (err) {
      const c = await t.js(`(() => { const c = document.querySelector('${card(id)}'); return c && { phase: c.dataset.phase, message: c.querySelector('.inst-message').textContent, log: c.querySelector('.inst-log').textContent.slice(-2000) }; })()`);
      throw new Error(`${err.message}; card: ${q(c)}`);
    }
  };
  const press = async (t, sel) => {
    await t.until(`!!document.querySelector(${q(sel)})`, sel);
    await t.js(`(document.querySelector(${q(sel)}).scrollIntoView({ block: 'center' }), true)`);
    await t.click(sel);
  };
  const showFilter = async (t, filter) => { await t.click(`.inst-nav[data-filter="${filter}"]`); await t.until(`document.querySelector('.inst-nav.selected')?.dataset.filter === '${filter}'`, filter); };
  const realDrivers = path.join(work, 'real-drivers');
  mkdirSync(realDrivers, { recursive: true });
  const r = await launch({ fixture: 'database', port: 9837, name: 'database-nosql-real', env: { PYIDE_INSTALL_ROOT: root, PYIDE_DB_DRIVERS: realDrivers } });
  try {
    await r.js(`ide.installer.open('databases')`);
    await r.until(`!!document.querySelector('${card('server:mongodb')}')`, 'mongodb card', 30000);
    await r.until(`document.querySelector('${card('server:mongodb')}').dataset.phase === 'notInstalled'`, 'mongodb not installed', 60000);
    check((await r.js(`document.querySelector('${card('server:mongodb')}').textContent`)).includes('v8.0.34'), 'the Install Manager offers portable MongoDB 8.0.34');
    const t0 = Date.now();
    await press(r, `${card('server:mongodb')} button[data-op="install"]`);
    await waitPhase(r, 'server:mongodb', 'installed', 60 * 60000);
    const log = await r.js(`document.querySelector('${card('server:mongodb')} .inst-log').textContent`);
    check(log.includes('sha256 6b021a0864494e4decf278b36477a29eb36072432773e4e62c2f42c302630db0') && log.includes('Creating the admin user'),
      `MongoDB downloads, matches its published sha256, extracts and initializes with an admin user (${Math.round((Date.now() - t0) / 1000)} s)`);
    const dir = path.join(root, 'servers', 'mongodb-8.0.34');
    check(!readdirSync(path.join(dir, 'mongodb-win32-x86_64-windows-8.0.34', 'bin')).some((f) => f.endsWith('.pdb')), 'debug symbols are left out of the extraction');
    await press(r, `${card('server:mongodb')} button[data-op="start"]`);
    await waitPhase(r, 'server:mongodb', 'running', 120000);
    const conn = await r.js(`ide.api.invoke('installer:serverConnection', 'mongodb')`);
    check(conn.port >= 27017 && conn.user === 'admin' && conn.authSource === 'admin' && conn.url.startsWith('mongodb://admin:'), `MongoDB runs with auth on 127.0.0.1:${conn.port}`);
    const wire = require('../main/installer/mongo-wire.js');
    let anonymous = null;
    try { await wire.adminCommand(conn.port, { listDatabases: 1 }); } catch (e) { anonymous = e.message; }
    check(/requires authentication/.test(anonymous || ''), 'the server refuses commands without the generated password');

    await showFilter(r, 'cat:drivers');
    await press(r, `${card('db-driver-mongodb')} button[data-op="install"]`);
    await waitPhase(r, 'db-driver-mongodb', 'installed', 10 * 60000);
    check(true, 'the real mongodb driver installs from the Install Manager');
    await showFilter(r, 'cat:databases');
    await r.js(`[...document.querySelectorAll('${card('server:mongodb')} button[data-op="action"]')].find((b) => b.textContent === 'Add as Data Source').click()`);
    await r.until(`ide.database.list().some(s => s.kind === 'mongodb')`, 'data source added');
    const id = await r.js(`ide.database.list().find(s => s.kind === 'mongodb').id`);
    const run = (text) => r.js(`ide.database.query(${q(id)}, ${q(text)})`);
    const ins = await run("db.people.insertMany([{name: 'Ada', born: ISODate('1815-12-10'), langs: ['analytical engine']}, {name: 'Grace', born: ISODate('1906-12-09'), rank: NumberLong('7')}, {name: 'Linus', born: ISODate('1969-12-28')}])");
    check(ins.ok && ins.affected === 3, `insertMany against the real server (${ins.error || ins.affected})`);
    const upd = await run("db.people.updateOne({name: 'Linus'}, {$set: {kernel: true}})");
    const found = await run("db.people.find({born: {$gt: ISODate('1900-01-01')}}, {_id: 0, name: 1, kernel: 1}).sort({born: 1})");
    check(upd.affected === 1 && q(found.rows) === q([['Grace', null], ['Linus', 'true']]), `find with an ISODate filter, projection and sort (${q(found.rows || found.error)})`);
    const agg = await run("db.people.aggregate([{$group: {_id: null, n: {$sum: 1}}}, {$project: {_id: 0, n: 1}}])");
    check(q(agg.rows) === q([[3]]), `aggregate on the real server (${q(agg.rows || agg.error)})`);
    const del = await run("db.people.deleteMany({name: {$in: ['Ada', 'Grace']}})");
    const one = await run("db.people.findOne({name: 'Linus'})");
    check(del.affected === 2 && one.documents.length === 1 && one.documents[0]._id.$oid?.length === 24 && one.documents[0].born.$date === '1969-12-28T00:00:00.000Z',
      'deleteMany and findOne; ObjectId and dates come back tagged for the JSON view');

    // the tree and the console UI
    await r.js(`ide.toolWindows.get('Database').show()`);
    await clickText(r, '#dbTree .db-node.db-source', 'MongoDB');
    await r.until(`[...document.querySelectorAll('#dbTree .db-node.db-database')].some(n => n.textContent.includes('test'))`, 'real databases', 30000);
    if (!(await r.js(`[...document.querySelectorAll('#dbTree .db-node.db-collection')].some(n => n.textContent.includes('people'))`))) await clickText(r, '#dbTree .db-node.db-database', 'test');
    await clickText(r, '#dbTree .db-node.db-collection', 'people');
    await r.until(`[...document.querySelectorAll('#dbTree .db-node.db-field')].some(n => n.querySelector('.db-detail')?.textContent === 'bool')`, 'real fields', 30000);
    check(q(await treeLabels(r, 'field')) === q(['_id objectId', 'name string', 'born date', 'kernel bool']), `the tree samples the real collection's fields (${q(await treeLabels(r, 'field'))})`);
    await doubleClickText(r, '#dbTree .db-node.db-collection', 'people');
    await r.until(`!!ide.database.activeConsole() && ${activeConsole}.querySelectorAll('.db-grid tbody tr').length === 1`, 'real open data', 30000);
    check(q((await gridRows(r))[0].slice(1)) === q(['Linus', '1969-12-28T00:00:00.000Z', 'true']), 'Open Data from the tree shows the real documents');
    await setConsole(r, "db.people.insertOne({name: 'Margaret', missions: NumberInt(6)})\ndb.people.aggregate([\n  {$match: {}},\n  {$count: 'n'}\n])");
    await runLine(r, 1);
    check((await status(r)).startsWith('1 documents affected'), 'insertOne from the console');
    await runLine(r, 3);
    check(q(await gridRows(r)) === q([['2']]), 'a multi-line aggregate from the console');

    await r.js(`ide.installer.open('databases')`);
    await press(r, `${card('server:mongodb')} button[data-op="stop"]`);
    await waitPhase(r, 'server:mongodb', 'installed', 60000);
    let down = false;
    try { await wire.adminCommand(conn.port, { ping: 1 }); } catch { down = true; }
    check(down, 'Stop shuts MongoDB down cleanly over the wire');
    const lock = path.join(dir, 'data', 'mongod.lock');
    check(!existsSync(lock) || readFileSync(lock).length === 0, 'the clean shutdown leaves an empty mongod.lock');
    await press(r, `${card('server:mongodb')} button[data-op="uninstall"]`);
    await r.until(`!!document.querySelector('.dialog')`, 'remove confirmation');
    await r.click('.dialog .primary');
    await waitPhase(r, 'server:mongodb', 'notInstalled', 120000);
    check(!existsSync(dir), 'Remove deletes the MongoDB directory');
    check(r.consoleErrors.length === 0, `no renderer exceptions (real MongoDB)${r.consoleErrors.length ? q(r.consoleErrors) : ''}`);
  } finally { r.close(); }
}

const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
