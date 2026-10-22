// Database Export Data… end to end over SQLite (ports 9395-9396): a fixture with REAL/INTEGER/TEXT/NULL/BLOB/Korean
// values; the number fidelity fix (REAL 2.0 stays 2.0 in the grid, Copy as CSV and every export; integers past 2^53
// stay exact); each format's exact bytes (CSV with options and a BOM, TSV, JSON array and lines, SQL INSERT, Markdown);
// an .xlsx read back with a ZIP reader written here (parts, inline strings, numbers, header style); Export Data from the
// result bar, the grid's context menu and the Database tree; a DML result exported from the grid without running it
// again; the Save-dialog guard; a 1,000,000-row table streamed in batches with progress, cancelled from the Background
// Tasks popup (no file, no partial file) and then exported whole; and the Korean dialog without English or missing
// translations. The Save dialog is answered through PYIDE_DB_EXPORT_DIALOG.
// First, in Node (`--unit` runs only this part): each network kind's streaming cursor against fake pg / mysql2 / mssql /
// oracledb packages in a temp PYIDE_DB_DRIVERS (one execution, pages in order without duplicates, the driver paused
// while rows wait so memory stays bounded, read-only transactions, Cancel stopping the source, NO_ROWS), the exact
// value encoding of every format and SQL dialect (blobs, bigint, decimals, booleans), and which statements Export Data
// may run again without asking (renderer/features/database/export.js isReadOnlyStatement).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import zlib from 'zlib';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const q = JSON.stringify;
const outDir = tempDir('db-export-out');
const dialogFile = path.join(outDir, 'dialog.json');
const answerSave = (file) => writeFileSync(dialogFile, q({ save: file }));
answerSave(null);
const env = { PYIDE_DB_EXPORT_DIALOG: dialogFile };

// ---------- a ZIP reader (central directory, stored and deflate) ----------
function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataAt = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const packed = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? zlib.inflateRawSync(packed) : packed;
    if (data.length !== size || zlib.crc32(data) !== crc) throw new Error(`size or CRC mismatch in ${name}`);
    entries.set(name, data.toString('utf8'));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- fixture database ----------
function makeDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, price REAL, qty INTEGER, name TEXT, note TEXT, data BLOB);
    INSERT INTO items VALUES (1, 2.0, 3, 'Ada, "L"', NULL, x'00ff10');
    INSERT INTO items VALUES (2, 0.1, 9007199254740993, '한글 텍스트', 'line1' || char(10) || 'line2', NULL);
    INSERT INTO items VALUES (3, -1.5, 0, 'pipe | tab' || char(9) || 'end', '', x'');
    INSERT INTO items VALUES (4, 1e20, -7, ' padded ', 'it''s', NULL);
    CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT, ratio REAL);
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000)
      INSERT INTO big SELECT x, 'row ' || x, x / 4.0 FROM c;
  `);
  db.close();
}

const results = [];
let a;
let b;

// ---------- pure Node: fake drivers ----------
// Each fake is a function whose source becomes the package's index file; they share globalThis.__fakeDb (the "server":
// N rows, what ran, how far the producer ran ahead, pauses, cancels, open connections).
function fakePg() {
  const S = () => globalThis.__fakeDb;
  const FIELDS = [{ name: 'id', dataTypeID: 20 }, { name: 'amount', dataTypeID: 1700 }, { name: 'data', dataTypeID: 17 }, { name: 'ok', dataTypeID: 16 }, { name: 'label', dataTypeID: 25 }];
  const raw = (i) => [String(9007199254740993n + BigInt(i)), i % 2 ? '12345678901234567890.10' : null, i % 3 ? `\\x00ff${(i % 256).toString(16).padStart(2, '0')}` : null, i % 2 ? 't' : 'f', `row ${i}`];
  const parse = (types, row, fields) => row.map((v, c) => (v === null ? null : types.getTypeParser(fields[c].dataTypeID, 'text')(v)));
  class Client {
    constructor() { S().open++; this.ended = false; this.tx = false; this.cur = null; }
    on() {}
    async connect() {}
    async query(cfg) {
      const text = typeof cfg === 'string' ? cfg : cfg.text;
      if (this.ended) throw new Error('Client was closed and is not queryable');
      S().log.push(text);
      if (/^BEGIN/.test(text)) { this.tx = true; return { command: 'BEGIN', fields: [], rows: [] }; }
      if (text === 'ROLLBACK' || text === 'COMMIT') { this.tx = false; this.cur = null; return { command: text, fields: [], rows: [] }; }
      let m = /^DECLARE (\w+) NO SCROLL CURSOR FOR ([\s\S]*)$/.exec(text);
      if (m) {
        if (!this.tx) throw Object.assign(new Error('DECLARE CURSOR can only be used in transaction blocks'), { code: '25P01' });
        if (!/^SELECT\b/i.test(m[2])) throw Object.assign(new Error('syntax error'), { code: '42601' });
        S().executions++;
        this.cur = { at: 0 };
        return { command: 'DECLARE CURSOR', fields: [], rows: [] };
      }
      m = /^FETCH (\d+) FROM (\w+)$/.exec(text);
      if (m) {
        const n = Number(m[1]);
        S().maxFetch = Math.max(S().maxFetch, n);
        await new Promise((r) => setTimeout(r, S().delay));
        if (this.ended) throw new Error('Connection terminated');
        const rows = [];
        while (rows.length < n && this.cur.at < S().N) rows.push(parse(cfg.types, raw(this.cur.at++), FIELDS));
        S().emitted += rows.length;
        return { command: 'FETCH', fields: FIELDS, rows };
      }
      if (/^SHOW\b/i.test(text)) { S().executions++; return { command: 'SHOW', fields: [{ name: 'setting', dataTypeID: 25 }], rows: [['on'], ['off']] }; }
      throw new Error(`fake pg: unexpected ${text}`);
    }
    async end() { if (!this.ended) { this.ended = true; S().open--; } }
  }
  module.exports = { Client, types: { getTypeParser: (oid) => (oid === 17 ? (s) => Buffer.from(s.slice(2), 'hex') : (s) => s) } };
}

function fakeMysql() {
  const { EventEmitter } = require('events');
  const S = () => globalThis.__fakeDb;
  const FIELDS = [{ name: 'id', type: 'LONGLONG', columnType: 8 }, { name: 'price', type: 'NEWDECIMAL', columnType: 246 }, { name: 'data', type: 'BLOB', columnType: 252 }, { name: 'label', type: 'VAR_STRING', columnType: 253 }];
  const raw = (i) => [String(9007199254740993n + BigInt(i)), i % 2 ? '0.10' : null, i % 3 ? Buffer.from([0, 255, i % 256]) : null, `row ${i}`];
  class Core extends EventEmitter {
    constructor() { super(); this.paused = false; this.destroyed = false; this.pump = null; }
    pause() { if (!this.paused) S().pauses++; this.paused = true; }
    resume() { if (!this.paused) return; this.paused = false; if (this.pump) setImmediate(this.pump); }
    query({ sql, typeCast }) {
      const q = new EventEmitter();
      S().log.push(sql);
      S().executions++;
      if (/^UPDATE\b/i.test(sql)) { setImmediate(() => q.emit('end')); return q; }
      let i = 0;
      const cell = (f, v) => typeCast({ type: f.type, string: () => (v === null ? null : String(v)), buffer: () => v }, () => v);
      // Rows arrive in packets of 50; a packet already read still comes out whole after pause().
      this.pump = () => {
        let packets = 0;
        while (!this.paused && !this.destroyed && i < S().N) {
          for (const end = Math.min(i + 50, S().N); i < end; i++) {
            const r = raw(i);
            S().emitted++;
            q.emit('result', FIELDS.map((f, c) => cell(f, r[c])));
          }
          if (++packets === 10) { setImmediate(this.pump); return; }
        }
        if (!this.destroyed && i >= S().N && !q.ended) { q.ended = true; q.emit('end'); }
      };
      setImmediate(() => { q.emit('fields', FIELDS); this.pump(); });
      return q;
    }
  }
  module.exports = {
    async createConnection() {
      S().open++;
      const core = new Core();
      let closed = false;
      const close = () => { if (!closed) { closed = true; S().open--; core.emit('end'); } };
      return {
        connection: core,
        on() {},
        async query(sql) { S().log.push(sql); return [[], []]; },
        async end() { close(); },
        destroy() { S().destroyed++; core.destroyed = true; close(); },
      };
    },
  };
}

function fakeMssql() {
  const { EventEmitter } = require('events');
  const S = () => globalThis.__fakeDb;
  const COLUMNS = [{ name: 'id', type: { declaration: 'bigint' } }, { name: 'data', type: { declaration: 'varbinary' } }, { name: 'day', type: { declaration: 'date' } }, { name: 'price', type: { declaration: 'decimal' } }];
  const raw = (i) => [String(9007199254740993n + BigInt(i)), i % 3 ? Buffer.from([1, 2, i % 256]) : null, new Date(Date.UTC(2024, 0, 1 + (i % 28))), i % 2 ? 1.5 : null];
  class Request extends EventEmitter {
    pause() { if (!this.paused) S().pauses++; this.paused = true; }
    resume() { if (this.paused) { this.paused = false; if (this.pump) setImmediate(this.pump); } }
    cancel() {
      S().cancels++;
      this.cancelled = true;
      setImmediate(() => { this.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' })); this.emit('done'); });
    }
    query(text) {
      S().log.push(text);
      S().executions++;
      let i = 0;
      this.pump = () => {
        let n = 0;
        while (!this.paused && !this.cancelled && i < S().N) {
          S().emitted++;
          this.emit('row', raw(i++));
          if (++n === 500) { setImmediate(this.pump); return; }
        }
        if (!this.cancelled && i >= S().N && !this.ended) { this.ended = true; this.emit('done'); }
      };
      setImmediate(() => { this.emit('recordset', COLUMNS); this.pump(); });
    }
  }
  class ConnectionPool extends EventEmitter {
    constructor() { super(); S().open++; this.closed = false; }
    async connect() {}
    request() { return new Request(); }
    async close() { if (!this.closed) { this.closed = true; S().open--; } }
  }
  module.exports = { ConnectionPool };
}

function fakeOracle() {
  const S = () => globalThis.__fakeDb;
  const T = { DB_TYPE_NUMBER: { name: 'NUMBER' }, DB_TYPE_BLOB: { name: 'BLOB' }, DB_TYPE_CLOB: { name: 'CLOB' }, DB_TYPE_NCLOB: { name: 'NCLOB' }, DB_TYPE_VARCHAR: { name: 'VARCHAR2' } };
  const STRING = 2001;
  const BUFFER = 2006;
  const META = [{ name: 'ID', dbType: T.DB_TYPE_NUMBER, dbTypeName: 'NUMBER' }, { name: 'DATA', dbType: T.DB_TYPE_BLOB, dbTypeName: 'BLOB' }, { name: 'LABEL', dbType: T.DB_TYPE_VARCHAR, dbTypeName: 'VARCHAR2' }];
  // What the driver gives for a column fetched as `type` (a NUMBER fetched as a JS number would lose digits).
  const value = (meta, i, type) => {
    if (meta.name === 'ID') return type === STRING ? String(9007199254740993n + BigInt(i)) : Number(9007199254740993n + BigInt(i));
    if (meta.name === 'DATA') return i % 3 ? (type === BUFFER ? Buffer.from([9, i % 256]) : { lob: true }) : null;
    return `row ${i}`;
  };
  module.exports = {
    ...T, STRING, BUFFER, OUT_FORMAT_ARRAY: 4001, OUT_FORMAT_OBJECT: 4002,
    async getConnection() {
      S().open++;
      let closed = false;
      return {
        oracleServerVersionString: '23.0',
        async execute(sql, _binds, opts = {}) {
          S().log.push(sql);
          if (sql === 'SET TRANSACTION READ ONLY') return {};
          if (!opts.resultSet) throw new Error('fake oracledb: expected a result set');
          if (!/^SELECT\b/i.test(sql)) return { rowsAffected: 1 };
          S().executions++;
          const handlers = META.map((m) => opts.fetchTypeHandler?.(m) || {});
          let at = 0;
          let rsClosed = false;
          return {
            metaData: META,
            resultSet: {
              async getRows(n) {
                if (rsClosed) throw new Error('NJS-018: invalid ResultSet');
                S().maxFetch = Math.max(S().maxFetch, n);
                await new Promise((r) => setTimeout(r, S().delay));
                const rows = [];
                while (rows.length < n && at < S().N) {
                  const i = at++;
                  rows.push(META.map((m, c) => { const v = value(m, i, handlers[c].type); return v !== null && handlers[c].converter ? handlers[c].converter(v) : v; }));
                }
                S().emitted += rows.length;
                return rows;
              },
              async close() { rsClosed = true; S().rsClosed++; },
            },
          };
        },
        async rollback() { S().log.push('ROLLBACK'); },
        async break() { S().breaks++; },
        async close() { if (!closed) { closed = true; S().open--; } },
      };
    },
  };
}

const ucheck = (ok, label) => { results.push({ ok: !!ok, label }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function unitChecks() {
  const require = createRequire(import.meta.url);
  const driversDir = tempDir('db-export-drivers');
  const fakes = { pg: ['index.js', fakePg], mysql2: ['promise.js', fakeMysql], mssql: ['index.js', fakeMssql], oracledb: ['index.js', fakeOracle] };
  for (const [name, [entry, fn]] of Object.entries(fakes)) {
    const dir = path.join(driversDir, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), q({ name, version: '0.0.0-fake', main: entry }));
    writeFileSync(path.join(dir, entry), `(${fn})();\n`);
  }
  const savedDrivers = process.env.PYIDE_DB_DRIVERS;
  process.env.PYIDE_DB_DRIVERS = driversDir;
  try {
    const { DRIVERS } = require('../main/db/drivers.js');
    const dataExport = require('../main/db/export.js');
    const { pushCursor, resultCursor } = require('../main/db/cursors.js');
    const { isReadOnlyStatement } = require('../renderer/features/database/export.js');
    const reset = (N, delay = 0) => {
      globalThis.__fakeDb = { N, delay, log: [], open: 0, executions: 0, maxFetch: 0, emitted: 0, pauses: 0, cancels: 0, destroyed: 0, breaks: 0, rsClosed: 0 };
      return globalThis.__fakeDb;
    };
    const CFG = { host: 'fake', port: 1, user: 'u', password: 'p', database: 'd' };
    const KINDS = ['postgres', 'mysql', 'mssql', 'oracle'];
    const PUSH = new Set(['mysql', 'mssql']); // drivers that push rows (paused/resumed); the others are pulled a page at a time
    const idOf = (row) => row[0]?.$number;

    // ---------- streaming: order, one execution, bounded memory, read-only transactions ----------
    for (const kind of KINDS) {
      const S = reset(25000);
      const adapter = await DRIVERS[kind].open(CFG);
      const consoleOpen = S.open;
      const cursor = await adapter.cursor('SELECT * FROM big', { readOnly: true });
      ucheck(S.open === consoleOpen + 1, `${kind}: the export streams on a connection of its own (${S.open - consoleOpen} more)`);
      let got = 0;
      let inOrder = true;
      let maxLead = 0;
      for (;;) {
        const rows = await cursor.next(1000);
        if (!rows) break;
        for (const r of rows) { if (idOf(r) !== String(9007199254740993n + BigInt(got))) inOrder = false; got++; }
        maxLead = Math.max(maxLead, S.emitted - got);
        await sleep(3); // a slow file: the driver gets time to run ahead
      }
      await cursor.close();
      ucheck(got === 25000 && inOrder, `${kind}: 25,000 rows arrive once each and in order (${got}, in order: ${inOrder})`);
      ucheck(S.executions === 1, `${kind}: the statement runs once, not once per page (${S.executions})`);
      // Memory stays bounded either way; a pause is only needed once the rows waiting reach the limit (a busy machine may
      // read as fast as the driver sends, so it never has to pause).
      if (PUSH.has(kind)) ucheck(maxLead <= 2100 && (S.pauses > 0 || maxLead < 2000), `${kind}: the driver is paused while rows wait, so at most ~2000 rows are held (${S.pauses} pauses, ${maxLead} ahead at most)`);
      else ucheck(S.maxFetch <= 1000 && maxLead <= 1000, `${kind}: pages of at most 1000 rows are fetched only when asked for (largest ${S.maxFetch}, ${maxLead} ahead at most)`);
      ucheck(S.open === consoleOpen, `${kind}: closing the cursor closes its connection`);
      const log = S.log.join(' | ');
      if (kind === 'postgres') ucheck(/BEGIN TRANSACTION READ ONLY \| DECLARE pyide_export NO SCROLL CURSOR FOR SELECT \* FROM big \| FETCH 1000 FROM pyide_export/.test(log) && S.log.at(-1) === 'ROLLBACK', `postgres: a server-side cursor in a read-only transaction, rolled back (${log.slice(0, 160)} … ${S.log.at(-1)})`);
      if (kind === 'mysql') ucheck(S.log[0] === 'START TRANSACTION READ ONLY' && S.log.at(-1) === 'ROLLBACK', `mysql: a read-only transaction, rolled back (${q(S.log)})`);
      if (kind === 'oracle') ucheck(S.log[0] === 'SET TRANSACTION READ ONLY' && S.log.at(-1) === 'ROLLBACK' && S.rsClosed === 1, `oracle: SET TRANSACTION READ ONLY, result set closed, rolled back (${q(S.log)})`);
      await adapter.close();
    }
    {
      const S = reset(10);
      const adapter = await DRIVERS.postgres.open(CFG);
      const cursor = await adapter.cursor('SELECT * FROM t', { readOnly: false });
      while (await cursor.next(1000));
      await cursor.close();
      ucheck(S.log[0] === 'BEGIN' && S.log.at(-1) === 'COMMIT', `postgres: a statement the user chose to run again commits like the console (${q(S.log)})`);
      reset(0);
      const show = await adapter.cursor('SHOW search_path;', { readOnly: true });
      const rows = await show.next(1000);
      await show.close();
      ucheck(q(show.columns.map((c) => c.name)) === q(['setting']) && q(rows) === q([['on'], ['off']]) && show.capped === null && globalThis.__fakeDb.log.at(-1) === 'ROLLBACK' && globalThis.__fakeDb.open === 0 /* counted since reset(0): its own connection, closed */,
        `postgres: a statement no cursor can hold (SHOW) runs whole, still read-only (${q(globalThis.__fakeDb.log)})`);
      await adapter.close();
    }

    // ---------- Cancel stops the source ----------
    for (const kind of KINDS) {
      const S = reset(200000);
      const adapter = await DRIVERS[kind].open(CFG);
      const consoleOpen = S.open;
      const cursor = await adapter.cursor('SELECT * FROM big', { readOnly: true });
      let batches = 0;
      const file = path.join(outDir, `cancel-${kind}.csv`);
      let err = null;
      try {
        await dataExport.exportCursor(cursor, { format: 'csv', file, onProgress: () => { batches++; }, isCancelled: () => batches >= 3 });
      } catch (e) { err = e; }
      const emitted = S.emitted;
      await sleep(60);
      ucheck(err?.cancelled && !existsSync(file) && !existsSync(`${file}.pyide-export`), `${kind}: a cancelled export rejects as cancelled and leaves no file`);
      ucheck(S.emitted === emitted && emitted < 6000, `${kind}: the driver stops producing rows (${emitted} of 200,000 read, none after)`);
      ucheck(S.open === consoleOpen && (kind !== 'mysql' || S.destroyed === 1) && (kind !== 'mssql' || S.cancels === 1) && (kind !== 'oracle' || (S.breaks === 1 && S.rsClosed === 1)),
        `${kind}: the export's connection is gone (destroyed ${S.destroyed}, cancels ${S.cancels}, breaks ${S.breaks})`);
      await adapter.close();
    }
    {
      // Cancel during a running fetch (db:exportCancel closes the cursor under it).
      const S = reset(100000, 40);
      const adapter = await DRIVERS.postgres.open(CFG);
      const cursor = await adapter.cursor('SELECT * FROM big', { readOnly: true });
      await cursor.next(1000);
      const pending = cursor.next(1000).then(() => 'rows', (e) => e.message);
      await sleep(5);
      await cursor.close();
      ucheck((await pending) !== 'rows' && S.open === 1, `postgres: closing the cursor during a FETCH ends its connection and the fetch fails (${await pending})`);
      await adapter.close();
      let stopped = false;
      const { cursor: pc, feed } = pushCursor({ pause() {}, resume() {}, cancel: () => { stopped = true; } });
      feed.columns([{ name: 'x' }]);
      const waiting = pc.next(10).then(() => null, (e) => e);
      await pc.close();
      const e = await waiting;
      ucheck(e?.cancelled && stopped, 'a push cursor closed while next() waits rejects it as cancelled and cancels the driver');
    }

    // ---------- statements without rows; capped results ----------
    {
      reset(10);
      const adapter = await DRIVERS.mysql.open(CFG);
      const err = await adapter.cursor('UPDATE t SET a = 1').then(() => null, (e) => e);
      ucheck(err?.exportCode === 'NO_ROWS' && globalThis.__fakeDb.open === 1, `mysql: a statement without a result set fails with the NO_ROWS code and closes its connection (${err?.message})`);
      await adapter.close();
      const capped = resultCursor([{ name: 'x' }], [[1], [2], [3], [4], [5]], 3);
      const got = [await capped.next(2), await capped.next(2), await capped.next(2)];
      ucheck(q(got) === q([[[1], [2]], [[3]], null]) && capped.capped === 3, `a result that cannot be streamed is cut at the cap and says so (${q(got)}, capped ${capped.capped})`);
    }

    // ---------- exact values from each kind ----------
    const VALUES = {
      postgres: ['{"id": 9007199254740994, "amount": 12345678901234567890.10, "data": {"$base64": "AP8B"}, "ok": true, "label": "row 1"}', "VALUES (9007199254740994, 12345678901234567890.10, '\\x00ff01'::bytea, TRUE, 'row 1');"],
      mysql: ['{"id": 9007199254740994, "price": 0.10, "data": {"$base64": "AP8B"}, "label": "row 1"}', "VALUES (9007199254740994, 0.10, X'00FF01', 'row 1');"],
      mssql: ['{"id": 9007199254740994, "data": {"$base64": "AQIB"}, "day": "2024-01-02", "price": 1.5}', "VALUES (9007199254740994, 0x010201, N'2024-01-02', 1.5);"],
      oracle: ['{"ID": 9007199254740994, "DATA": {"$base64": "CQE="}, "LABEL": "row 1"}', "VALUES (9007199254740994, HEXTORAW('0901'), 'row 1');"],
    };
    for (const kind of KINDS) {
      const lines = {};
      for (const format of ['json', 'sql']) {
        reset(3);
        const adapter = await DRIVERS[kind].open(CFG);
        const cursor = await adapter.cursor('SELECT * FROM t', { readOnly: true });
        const file = path.join(outDir, `values-${kind}.${format}`);
        await dataExport.exportCursor(cursor, { format, file, options: { style: 'lines', table: ['t'], quote: DRIVERS[kind].quote, dialect: DRIVERS[kind].sqlDialect } });
        lines[format] = readFileSync(file, 'utf8').split('\n')[1];
        await adapter.close();
      }
      ucheck(lines.json === VALUES[kind][0], `${kind}: JSON keeps BIGINT and DECIMAL digits unquoted and binary as {"$base64"} (${lines.json})`);
      ucheck(lines.sql?.endsWith(VALUES[kind][1]), `${kind}: SQL INSERT writes the database's own literals (${lines.sql})`);
    }

    // ---------- the value encoding table: every format and SQL dialect ----------
    const COLS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((name) => ({ name }));
    const ROW = [null, Buffer.from([0, 255, 16]), new Uint8Array(0), 9007199254740993n, { $number: '12345678901234567890.123' }, { $number: 'NaN' }, true, 'it\'s \\ "x"', 2.5];
    const exportRow = async (format, options = {}) => {
      const file = path.join(outDir, `table.${format}`);
      await dataExport.exportCursor(dataExport.arrayCursor(COLS, [ROW]), { format, file, options });
      return format === 'xlsx' ? readFileSync(file) : readFileSync(file, 'utf8');
    };
    const ENCODED = {
      csv: ',0x00ff10,0x,9007199254740993,12345678901234567890.123,NaN,true,"it\'s \\ ""x""",2.5',
      json: '{"c0": null, "c1": {"$base64": "AP8Q"}, "c2": {"$base64": ""}, "c3": 9007199254740993, "c4": 12345678901234567890.123, "c5": "NaN", "c6": true, "c7": "it\'s \\\\ \\"x\\"", "c8": 2.5}',
      markdown: '|  | 0x00ff10 | 0x | 9007199254740993 | 12345678901234567890.123 | NaN | true | it\'s \\\\ "x" | 2.5 |',
    };
    ucheck((await exportRow('csv', { header: false })) === `${ENCODED.csv}\r\n`, 'CSV: blobs as 0x hex, bigint and decimals exact, NULL empty');
    ucheck((await exportRow('json', { style: 'lines' })) === `${ENCODED.json}\n`, `JSON: blobs as {"$base64": …}, bigint/decimal unquoted, NaN as a string (${await exportRow('json', { style: 'lines' })})`);
    ucheck((await exportRow('markdown')).split('\n')[2] === ENCODED.markdown, 'Markdown: blobs as 0x hex, backslashes escaped');
    const DIALECTS = {
      standard: "NULL, X'00FF10', X'', 9007199254740993, 12345678901234567890.123, 'NaN', TRUE, 'it''s \\ \"x\"', 2.5",
      mysql: "NULL, X'00FF10', X'', 9007199254740993, 12345678901234567890.123, 'NaN', TRUE, 'it''s \\\\ \"x\"', 2.5",
      clickhouse: "NULL, unhex('00FF10'), unhex(''), 9007199254740993, 12345678901234567890.123, 'NaN', TRUE, 'it''s \\\\ \"x\"', 2.5",
      postgres: "NULL, '\\x00ff10'::bytea, '\\x'::bytea, 9007199254740993, 12345678901234567890.123, 'NaN', TRUE, 'it''s \\ \"x\"', 2.5",
      duckdb: "NULL, '\\x00\\xFF\\x10'::BLOB, ''::BLOB, 9007199254740993, 12345678901234567890.123, 'NaN', TRUE, 'it''s \\ \"x\"', 2.5",
      mssql: "NULL, 0x00FF10, 0x, 9007199254740993, 12345678901234567890.123, N'NaN', 1, N'it''s \\ \"x\"', 2.5",
      oracle: "NULL, HEXTORAW('00FF10'), HEXTORAW(''), 9007199254740993, 12345678901234567890.123, 'NaN', 1, 'it''s \\ \"x\"', 2.5",
    };
    for (const [dialect, values] of Object.entries(DIALECTS)) {
      const text = await exportRow('sql', { table: ['t'], dialect });
      ucheck(text === `INSERT INTO "t" ("c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8") VALUES (${values});\n`, `SQL INSERT, ${dialect}: ${text.slice(text.indexOf('VALUES'), -1)}`);
    }
    const sheet = unzip(await exportRow('xlsx', { header: false })).get('xl/worksheets/sheet1.xml') || '';
    const cellsXml = [...sheet.matchAll(/<c r="([A-Z]+)1"([^>]*)>(.*?)<\/c>/g)].map((m) => `${m[1]}${m[2]}:${m[3]}`);
    ucheck(q(cellsXml) === q(['B t="inlineStr":<is><t>0x00ff10</t></is>', 'C t="inlineStr":<is><t>0x</t></is>', 'D t="inlineStr":<is><t>9007199254740993</t></is>',
      'E t="inlineStr":<is><t>12345678901234567890.123</t></is>', 'F t="inlineStr":<is><t>NaN</t></is>', 'G t="b":<v>1</v>', 'H t="inlineStr":<is><t>it\'s \\ &quot;x&quot;</t></is>','I:<v>2.5</v>']),
    `Excel: blobs as hex text, numbers Excel cannot hold exactly as text, NULL no cell (${q(cellsXml)})`);

    // ---------- which statements run again without asking ----------
    const READ = ['SELECT * FROM t', '  -- why\nSELECT 1;', 'WITH x AS (SELECT 1) SELECT * FROM x', 'VALUES (1), (2)', 'TABLE t', 'SHOW TABLES', 'DESCRIBE t',
      'EXPLAIN SELECT * FROM t', 'EXPLAIN DELETE FROM t', "PRAGMA table_info('t')", 'PRAGMA user_version', "SELECT 'DELETE FROM t; SELECT 1 INTO x' AS s",
      "SELECT currval('s')", 'SELECT "into_count" FROM t', 'SELECT * FROM t /* UPDATE t SET a = 1 */', 'SELECT count(*) FROM t WHERE a IN (1, 2)'];
    const ASK = ['EXPLAIN ANALYZE DELETE FROM t', 'EXPLAIN (ANALYZE, BUFFERS) SELECT 1', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
      'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'SELECT * INTO t2 FROM t',
      'SELECT a INTO @v FROM t', "SELECT nextval('s')", "SELECT setval('s', 1)", 'SELECT "nextval"(\'s\')', 'SELECT s.NEXTVAL FROM dual', 'SELECT NEXT VALUE FOR s',
      'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t FOR SHARE', 'SELECT * FROM t LOCK IN SHARE MODE', 'SELECT 1; DELETE FROM t', 'SELECT 1\nDELETE FROM t',
      'SELECT pg_advisory_lock(1)', 'SELECT pg_sleep(1)', "SELECT GET_LOCK('x', 1)", "SELECT 'a\\'b', nextval('s')", 'INSERT INTO t VALUES (1) RETURNING id',
      'UPDATE t SET a = 1 RETURNING *', 'DELETE FROM t RETURNING *', 'PRAGMA journal_mode = WAL', 'PRAGMA optimize', 'PRAGMA cache_size(100)', 'CALL p()',
      'EXEC sp_who', 'ANALYZE SELECT 1', 'DO $$ BEGIN END $$', ''];
    const wrongRead = READ.filter((s) => !isReadOnlyStatement(s));
    const wrongAsk = ASK.filter((s) => isReadOnlyStatement(s));
    ucheck(!wrongRead.length, `read-only statements run again without asking (${READ.length} cases; wrong: ${q(wrongRead)})`);
    ucheck(!wrongAsk.length, `EXPLAIN ANALYZE, data-modifying CTEs, SELECT INTO, sequences, locks, several statements and DML ask first (${ASK.length} cases; wrong: ${q(wrongAsk)})`);
  } finally {
    if (savedDrivers === undefined) delete process.env.PYIDE_DB_DRIVERS; else process.env.PYIDE_DB_DRIVERS = savedDrivers;
    delete globalThis.__fakeDb;
  }
}
try { await unitChecks(); } catch (err) { console.log(`FAIL unit checks: ${err.stack || err.message}`); results.push({ ok: false }); }
if (process.argv.includes('--unit')) {
  const failedUnit = results.filter((x) => !x.ok).length;
  console.log(`${results.length - failedUnit}/${results.length} passed`);
  process.exit(failedUnit ? 1 : 0);
}

try {
  a = await launch({ fixture: 'db-export', port: 9395, name: 'db-export', env });
  const { js, until, check } = a;
  const dbFile = path.join(a.project, 'shop.sqlite');
  makeDb(dbFile);
  const id = await js(`ide.database.addDataSource({ kind: 'sqlite', name: 'shop', file: ${q(dbFile)} })`);

  // ---------- fidelity in the grid and Copy as CSV ----------
  const consoleSel = `document.querySelector('.custom-tab:not(.hidden) .db-console, .custom-tab.db-console:not(.hidden)')`;
  await js(`ide.database.openConsole(${q(id)})`);
  await until(`!!ide.database.activeConsole()`, 'console');
  const run = async (sql) => {
    const before = await js(`ide.database.activeConsole().runs`);
    await js(`(() => { const c = ide.database.activeConsole(); c.model.setValue(${q(sql)}); c.editor.focus(); c.editor.setPosition({ lineNumber: 1, column: 1 }); return true; })()`);
    await a.press('Ctrl+Enter');
    await until(`ide.database.activeConsole().runs > ${before}`, `ran ${sql}`);
  };
  const gridRows = () => js(`[...${consoleSel}.querySelectorAll('.db-grid tbody tr')].map(r => [...r.children].slice(1).map(td => td.textContent + (td.classList.contains('db-num') ? '#' : '')))`);
  await run('SELECT 2.0 AS r, 2 AS i, 1e20 AS e, 9007199254740993 AS big, 0.1 AS f, typeof(2.0) AS t');
  let grid = await gridRows();
  check(q(grid) === q([['2.0#', '2#', '1.0e+20#', '9007199254740993#', '0.1#', 'real']]), `REAL 2.0 shows as 2.0, 1e20 as 1.0e+20 and an integer past 2^53 exactly, all as numbers (${q(grid)})`);
  await run('SELECT id, price, qty FROM items ORDER BY id');
  grid = await gridRows();
  check(q(grid.map((r) => r[1])) === q(['2.0#', '0.1#', '-1.5#', '1.0e+20#']) && grid[1][2] === '9007199254740993#', `table REAL and INTEGER columns keep their text (${q(grid)})`);
  await a.click('.custom-tab:not(.hidden) .db-copy');
  await until(`ide.api.invoke('clipboard:readText').then(t => t.startsWith('id,price,qty'))`, 'clipboard csv');
  check(await js(`ide.api.invoke('clipboard:readText')`) === 'id,price,qty\r\n1,2.0,3\r\n2,0.1,9007199254740993\r\n3,-1.5,0\r\n4,1.0e+20,-7', 'Copy as CSV copies 2.0 and the big integer as the database has them');

  // ---------- the export dialog, driven like a user ----------
  const setSelect = (sel, value) => js(`(() => { const n = document.querySelector(${q(sel)}); n.value = ${q(value)}; n.dispatchEvent(new Event('change', { bubbles: true })); return n.value === ${q(value)}; })()`);
  const setValue = (sel, value) => js(`(() => { const n = document.querySelector(${q(sel)}); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const setCheck = (sel, value) => js(`(() => { const n = document.querySelector(${q(sel)}); if (n.checked !== ${value}) n.click(); return n.checked === ${value}; })()`);
  // Starts an export with `start` (a JS expression returning the export promise into window.__exp, or a click), fills
  // the dialog with `fill`, presses Export to File… and waits for the result.
  let n = 0;
  async function exportWith(start, fill, ext) {
    const file = path.join(outDir, `out-${++n}.${ext}`);
    answerSave(file);
    // Earlier exports' balloons sit over the lower right of the window, where the result bar's buttons are.
    await js(`(window.__exp = null, ide.notifications.clear(), true)`);
    await start();
    await until(`!!document.querySelector('#dbExportFormat')`, 'export dialog');
    await fill();
    await a.click('.dialog .dialog-buttons .primary');
    return file;
  }
  const viaApi = (expr) => () => js(`(window.__exp = ${expr}, true)`);
  const tableExport = viaApi(`ide.database.exportData({ sourceId: ${q(id)}, table: { schema: 'main', name: 'items' }, name: 'items' })`);
  const waitResult = async (label) => { await until(`window.__exp !== null`, label); return js(`window.__exp`); };

  // Later exports set every CSV option, since the dialog remembers the last ones.
  const plainCsv = async () => {
    await setSelect('#dbExportFormat', 'csv');
    await setSelect('#dbExportDelimiter', ',');
    await setSelect('#dbExportQuote', 'needed');
    await setSelect('#dbExportEncoding', 'utf8');
    await setCheck('#dbExportHeader', true);
  };
  // CSV defaults: comma, header, quotes when needed, UTF-8 without BOM, CRLF.
  let file = await exportWith(tableExport, () => setSelect('#dbExportFormat', 'csv'), 'csv');
  let r = await waitResult('csv export');
  let text = readFileSync(file, 'utf8');
  const CSV = 'id,price,qty,name,note,data\r\n1,2.0,3,"Ada, ""L""",,0x00ff10\r\n2,0.1,9007199254740993,한글 텍스트,"line1\nline2",\r\n3,-1.5,0,pipe | tab\tend,,0x\r\n4,1.0e+20,-7," padded ",it\'s,\r\n';
  check(r.ok && r.rows === 4 && text === CSV, `CSV: header, quoting when needed, NULL empty, blob hex, 2.0 and the big integer exact (${q(text)})`);
  check(await js(`ide.settings.get('database.export').format`) === 'csv', 'the chosen options are remembered');

  file = await exportWith(tableExport, async () => {
    await setSelect('#dbExportFormat', 'csv');
    await setSelect('#dbExportDelimiter', ';');
    await setSelect('#dbExportQuote', 'always');
    await setSelect('#dbExportEncoding', 'utf8bom');
    await setCheck('#dbExportHeader', false);
  }, 'csv');
  r = await waitResult('csv options export');
  let bytes = readFileSync(file);
  check(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, 'UTF-8 with BOM (Excel) starts the file with EF BB BF');
  text = bytes.subarray(3).toString('utf8');
  check(text === '"1";"2.0";"3";"Ada, ""L""";;"0x00ff10"\r\n"2";"0.1";"9007199254740993";"한글 텍스트";"line1\nline2";\r\n"3";"-1.5";"0";"pipe | tab\tend";"";"0x"\r\n"4";"1.0e+20";"-7";" padded ";"it\'s";\r\n',
    `CSV with ; separator, always quoted, no header; NULL stays empty while '' is quoted (${q(text)})`);

  file = await exportWith(tableExport, async () => {
    await setSelect('#dbExportFormat', 'tsv');
    check(await js(`document.querySelector('#dbExportDelimiter').closest('.field').classList.contains('hidden') && !document.querySelector('#dbExportQuote').closest('.field').classList.contains('hidden')`), 'TSV hides the separator and keeps quoting');
    await setSelect('#dbExportQuote', 'needed');
    await setSelect('#dbExportEncoding', 'utf16le');
    await setCheck('#dbExportHeader', true);
  }, 'tsv');
  r = await waitResult('tsv export');
  bytes = readFileSync(file);
  text = bytes.subarray(2).toString('utf16le');
  check(bytes[0] === 0xff && bytes[1] === 0xfe && text === 'id\tprice\tqty\tname\tnote\tdata\r\n1\t2.0\t3\t"Ada, ""L"""\t\t0x00ff10\r\n2\t0.1\t9007199254740993\t한글 텍스트\t"line1\nline2"\t\r\n3\t-1.5\t0\t"pipe | tab\tend"\t\t0x\r\n4\t1.0e+20\t-7\t" padded "\tit\'s\t\r\n',
    `TSV in UTF-16 LE with BOM; a tab inside a value is quoted (${q(text)})`);

  file = await exportWith(tableExport, async () => { await setSelect('#dbExportFormat', 'json'); await setSelect('#dbExportJsonStyle', 'array'); await setSelect('#dbExportEncoding', 'utf8'); }, 'json');
  r = await waitResult('json export');
  text = readFileSync(file, 'utf8');
  const JSON_ROWS = [
    '{"id": 1, "price": 2.0, "qty": 3, "name": "Ada, \\"L\\"", "note": null, "data": {"$base64": "AP8Q"}}',
    '{"id": 2, "price": 0.1, "qty": 9007199254740993, "name": "한글 텍스트", "note": "line1\\nline2", "data": null}',
    '{"id": 3, "price": -1.5, "qty": 0, "name": "pipe | tab\\tend", "note": "", "data": {"$base64": ""}}',
    '{"id": 4, "price": 1.0e+20, "qty": -7, "name": " padded ", "note": "it\'s", "data": null}',
  ];
  check(text === `[\n  ${JSON_ROWS.join(',\n  ')}\n]\n`, `JSON array of objects with exact numbers (2.0, 9007199254740993) (${q(text)})`);
  let parsedOk = false;
  try { parsedOk = JSON.parse(text).length === 4; } catch {}
  check(parsedOk, 'the JSON file parses');
  file = await exportWith(tableExport, async () => { await setSelect('#dbExportFormat', 'json'); await setSelect('#dbExportJsonStyle', 'lines'); }, 'jsonl');
  r = await waitResult('json lines export');
  text = readFileSync(file, 'utf8');
  check(text === `${JSON_ROWS.join('\n')}\n`, `JSON Lines: one object per line (${q(text)})`);

  file = await exportWith(tableExport, async () => {
    await setSelect('#dbExportFormat', 'sql');
    check(await js(`document.querySelector('#dbExportTable').value === 'items'`), 'SQL INSERT offers the table name');
  }, 'sql');
  r = await waitResult('sql export');
  text = readFileSync(file, 'utf8');
  const INSERT = 'INSERT INTO "items" ("id", "price", "qty", "name", "note", "data") VALUES ';
  const SQL_ROWS = [
    "(1, 2.0, 3, 'Ada, \"L\"', NULL, X'00FF10');", "(2, 0.1, 9007199254740993, '한글 텍스트', 'line1\nline2', NULL);",
    "(3, -1.5, 0, 'pipe | tab\tend', '', X'');", "(4, 1.0e+20, -7, ' padded ', 'it''s', NULL);",
  ];
  check(text === SQL_ROWS.map((v) => `${INSERT}${v}\n`).join(''), `SQL INSERT statements with the quoted table, X'' blobs and '' escapes (${q(text)})`);
  // The statements recreate the data exactly in a fresh database.
  const copy = new DatabaseSync(':memory:');
  copy.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, price REAL, qty INTEGER, name TEXT, note TEXT, data BLOB);');
  copy.exec(text);
  const back = copy.prepare('SELECT quote(price) p, quote(qty) q, typeof(data) t FROM items ORDER BY id').all();
  copy.close();
  check(q(back.map((x) => `${x.p}|${x.q}|${x.t}`)) === q(['2.0|3|blob', '0.1|9007199254740993|null', '-1.5|0|blob', '1.0e+20|-7|null']), `running the INSERTs gives back the same values (${q(back)})`);
  file = await exportWith(tableExport, async () => { await setSelect('#dbExportFormat', 'sql'); await setValue('#dbExportTable', 'archive.items_copy'); }, 'sql');
  r = await waitResult('sql renamed export');
  check(readFileSync(file, 'utf8').startsWith('INSERT INTO archive.items_copy ("id", '), 'a typed table name is used as written');

  file = await exportWith(tableExport, () => setSelect('#dbExportFormat', 'markdown'), 'md');
  r = await waitResult('markdown export');
  text = readFileSync(file, 'utf8');
  check(text === '| id | price | qty | name | note | data |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 2.0 | 3 | Ada, "L" |  | 0x00ff10 |\n| 2 | 0.1 | 9007199254740993 | 한글 텍스트 | line1<br>line2 |  |\n| 3 | -1.5 | 0 | pipe \\| tab\tend |  | 0x |\n| 4 | 1.0e+20 | -7 |  padded  | it\'s |  |\n',
    `Markdown table with | escaped and line breaks as <br> (${q(text)})`);

  file = await exportWith(tableExport, () => setSelect('#dbExportFormat', 'xlsx'), 'xlsx');
  r = await waitResult('xlsx export');
  let parts;
  try { parts = unzip(readFileSync(file)); } catch (err) { parts = new Map(); check(false, `the .xlsx is a valid ZIP (${err.message})`); }
  check(q([...parts.keys()].sort()) === q(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']), `the .xlsx holds the workbook parts (${q([...parts.keys()])})`);
  check((parts.get('[Content_Types].xml') || '').includes('PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"')
    && (parts.get('xl/workbook.xml') || '').includes('<sheet name="items" sheetId="1" r:id="rId1"/>')
    && (parts.get('xl/_rels/workbook.xml.rels') || '').includes('Target="worksheets/sheet1.xml"')
    && (parts.get('xl/styles.xml') || '').includes('<font><b/>'), 'content types, the workbook with the sheet named after the table, its relationship and a bold header style');
  const sheet = parts.get('xl/worksheets/sheet1.xml') || '';
  const rowsXml = [...sheet.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)].map((m) => m[2]);
  const cells = (xmlRow) => [...xmlRow.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/gs)].map((m) => ({ ref: m[1], attrs: m[2], body: m[3] }));
  const header = cells(rowsXml[0] || '');
  check(rowsXml.length === 5 && header.length === 6 && header.every((c) => c.attrs.includes('s="1"') && c.attrs.includes('t="inlineStr"')) && header[5].body === '<is><t>data</t></is>', 'row 1 is the bold header as inline strings');
  const r2 = cells(rowsXml[1]);
  const r3 = cells(rowsXml[2]);
  const r5 = cells(rowsXml[4]);
  check(r2[0].body === '<v>1</v>' && r2[1].ref === 'B2' && r2[1].body === '<v>2.0</v>' && r2[3].body === '<is><t>Ada, &quot;L&quot;</t></is>' && r2[4].ref === 'F2' && r2[4].body === '<is><t>0x00ff10</t></is>',
    `numbers are numbers (2.0 kept), text is escaped, NULL is no cell, blobs are hex text (${q(r2)})`);
  check(r3[2].attrs.includes('t="inlineStr"') && r3[2].body === '<is><t>9007199254740993</t></is>' && r3[3].body === '<is><t>한글 텍스트</t></is>' && r3[4].body === '<is><t>line1\nline2</t></is>',
    'an integer Excel cannot hold exactly is text; Korean and line breaks are kept');
  check(r5[1].body === '<v>1.0e+20</v>' && r5[3].body === '<is><t xml:space="preserve"> padded </t></is>', 'exponents stay numbers and edge spaces are preserved');

  // ---------- from the result bar, the grid menu and the tree ----------
  await run('SELECT id, price FROM items WHERE id <= 2 ORDER BY id DESC');
  file = await exportWith(async () => { await js(`(window.__exp = null, true)`); await a.click('.custom-tab:not(.hidden) .db-export'); }, plainCsv, 'csv');
  await until(`ide.notifications.list().some(n => n.title === 'Data exported' && n.text.includes(${q(path.basename(file))}))`, 'result bar export notification');
  text = readFileSync(file, 'utf8');
  check(text === 'id,price\r\n2,0.1\r\n1,2.0\r\n', `Export Data… in the result bar runs the query again and writes its rows (${q(text)})`);
  check(await js(`!!document.querySelector('.ide-balloon') && [...document.querySelectorAll('.ide-balloon')].some(b => b.textContent.includes('Show in Explorer'))`), 'a balloon reports the export with Show in Explorer');

  await js(`(ide.notifications.clear(), true)`);
  const box = await js(`(() => { const r = ${consoleSel}.querySelector('.db-grid tbody td:nth-child(2)').getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await a.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.includes('Export Data'))`, 'grid context menu');
  file = await exportWith(async () => {
    await js(`([...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes('Export Data')).dataset.testTarget = '1', true)`);
    await a.click('[data-test-target="1"]');
  }, () => setSelect('#dbExportFormat', 'markdown'), 'md');
  await until(`ide.notifications.list().some(n => n.text.includes(${q(path.basename(file))}))`, 'grid menu export');
  check(readFileSync(file, 'utf8') === '| id | price |\n| --- | --- |\n| 2 | 0.1 |\n| 1 | 2.0 |\n', 'the grid\'s context menu has Export Data… too');

  // A DML result exports what the grid shows; the statement does not run a second time.
  await run("INSERT INTO items (id, name, price) VALUES (10, 'returned', 4.0) RETURNING id, name, price");
  file = await exportWith(viaApi(`ide.database.activeConsole().exportResult()`), plainCsv, 'csv');
  r = await waitResult('returning export');
  const count = new DatabaseSync(dbFile, { readOnly: true });
  const total = count.prepare('SELECT count(*) n FROM items').get().n;
  count.close();
  text = readFileSync(file, 'utf8');
  check(text === 'id,name,price\r\n10,returned,4.0\r\n' && total === 5, `an INSERT … RETURNING result is exported from the grid without running it again (${total} rows in the table, ${q(text)})`);

  // The tree: right-click the table, Export Data….
  await js(`ide.toolWindows.get('Database').show()`);
  await until(`[...document.querySelectorAll('#dbTree .db-source')].some(n => n.textContent.includes('shop'))`, 'source in tree');
  // Real clicks on tree rows (each opens the node).
  const clickRow = async (pred) => {
    await js(`(document.querySelectorAll('[data-test-target]').forEach(n => n.removeAttribute('data-test-target')), [...document.querySelectorAll('#dbTree .db-node')].find(n => ${pred}).dataset.testTarget = '1', true)`);
    await a.click('[data-test-target="1"]');
  };
  await clickRow("n.dataset.kind === 'source' && n.textContent.includes('shop')");
  // A SQLite source opens with its main schema open.
  await until(`[...document.querySelectorAll('#dbTree .db-node')].some(n => n.dataset.kind === 'table' && n.textContent.includes('items'))`, 'items node').catch(async (err) => {
    throw new Error(`${err.message}: ${await js(`[...document.querySelectorAll('#dbTree .db-node')].map(n => n.dataset.kind + ':' + n.textContent).join(' / ')`)}`);
  });
  const nodeBox = await js(`(() => { const r = [...document.querySelectorAll('#dbTree .db-node')].find(n => n.dataset.kind === 'table' && n.textContent.includes('items')).getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await a.cdp('Input.dispatchMouseEvent', { type, x: nodeBox.x, y: nodeBox.y, button: 'right', clickCount: 1 });
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.includes('Export Data'))`, 'tree context menu');
  file = await exportWith(async () => {
    await js(`(document.querySelectorAll('[data-test-target]').forEach(n => n.removeAttribute('data-test-target')), [...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes('Export Data')).dataset.testTarget = '1', true)`);
    await a.click('[data-test-target="1"]');
  }, async () => {
    check(await js(`document.querySelector('.db-export-what').textContent.includes('items')`), 'the dialog names the table');
    await setSelect('#dbExportFormat', 'json');
    await setSelect('#dbExportJsonStyle', 'lines');
  }, 'jsonl');
  await until(`ide.notifications.list().some(n => n.text.includes(${q(path.basename(file))}))`, 'tree export');
  text = readFileSync(file, 'utf8');
  check(text.split('\n').length === 6 && text.endsWith('{"id": 10, "price": 4.0, "qty": null, "name": "returned", "note": null, "data": null}\n'), `the tree's Export Data… writes the whole table (${q(text.slice(-90))})`);

  // ---------- the Save dialog guard ----------
  const forged = path.join(outDir, 'forged.csv');
  r = await js(`ide.api.invoke('db:export', { job: 'x', sourceId: ${q(id)}, format: 'csv', file: ${q(forged)}, table: { schema: 'main', name: 'items' } })`);
  check(!r.ok && /not chosen/.test(r.error) && !existsSync(forged), 'main writes only to a file its Save dialog returned');
  answerSave(null);
  await js(`(window.__exp = null, true)`);
  await tableExport();
  await until(`!!document.querySelector('#dbExportFormat')`, 'dialog');
  await a.click('.dialog .dialog-buttons .primary');
  check((await waitResult('cancelled save dialog')) === null, 'cancelling the Save dialog exports nothing');

  // ---------- a million rows: streamed, cancelled, then whole ----------
  const bigSpec = `ide.database.exportData({ sourceId: ${q(id)}, table: { schema: 'main', name: 'big' }, name: 'big' })`;
  file = await exportWith(viaApi(bigSpec), plainCsv, 'csv');
  await until(`ide.tasks.list().some(t => t.title.includes(${q(path.basename(file))}) && t.fraction > 0)`, 'export task with progress', 30000);
  const task = await js(`(() => { const t = ide.tasks.list().find(t => t.title.includes(${q(path.basename(file))})); return { title: t.title, fraction: t.fraction, text: t.text, cancellable: t.cancellable }; })()`);
  check(task.cancellable && task.fraction > 0 && task.fraction < 1 && /of 1000000 rows/.test(task.text), `a background task shows the progress against the table's row count (${q(task)})`);
  await a.click('#bgTasks');
  await until(`!!document.querySelector('#bgTasksPopup .bg-popup-row .bg-popup-cancel')`, 'tasks popup');
  await a.click('#bgTasksPopup .bg-popup-row .bg-popup-cancel');
  r = await waitResult('cancelled export');
  check(r && !r.ok && r.cancelled, 'Cancel in the Background Tasks popup stops the export');
  check(!existsSync(file) && !readdirSync(outDir).some((f) => f.endsWith('.pyide-export')), 'a cancelled export leaves neither the file nor a partial file');
  check(await js(`!ide.tasks.list().length`), 'the task is gone');
  await a.press('Escape');

  file = await exportWith(viaApi(bigSpec), plainCsv, 'csv');
  r = await waitResult('big export');
  const lines = readFileSync(file, 'utf8').split('\r\n');
  check(r.ok && r.rows === 1000000 && r.batches >= 1000 && lines.length === 1000002 && lines[1] === '1,row 1,0.25' && lines[4] === '4,row 4,1.0' && lines[1000000] === '1000000,row 1000000,250000.0',
    `1,000,000 rows stream to the file in ${r.batches} batches of 1000 (never all in memory), REAL 1.0 kept`);
  rmSync(file, { force: true });

  const errs = await js(`ide.api.invoke('diagnostics:errors')`);
  check(!errs.length && !a.consoleErrors.length, `no internal errors or renderer exceptions (${q(errs.slice(0, 2))} ${q(a.consoleErrors.slice(0, 2))})`);
  await a.shot('db-export.png');
  results.push(...a.results);
  a.close();
  a = null;

  // ---------- Korean ----------
  b = await launch({ fixture: 'db-export', port: 9396, name: 'db-export-ko', lang: 'ko-KR', env });
  const bFile = path.join(b.project, 'shop.sqlite');
  const db = new DatabaseSync(bFile);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, price REAL); INSERT INTO items VALUES (1, 2.0);");
  db.close();
  const bid = await b.js(`ide.database.addDataSource({ kind: 'sqlite', name: 'shop', file: ${q(bFile)} })`);
  await b.js(`(window.__exp = ide.database.exportData({ sourceId: ${q(bid)}, table: { schema: 'main', name: 'items' }, name: 'items' }), true)`);
  await b.until(`!!document.querySelector('#dbExportFormat')`, 'Korean dialog');
  for (const f of ['csv', 'json', 'sql', 'xlsx']) {
    await b.js(`(() => { const n = document.querySelector('#dbExportFormat'); n.value = ${q(f)}; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const leaks = await englishLeaks(b, '.dialog');
    b.check(!leaks.length, `Korean Export Data dialog (${f}) has no English UI text (${q(leaks)})`);
  }
  b.check((await b.js(`document.querySelector('.dialog .dialog-title').textContent`)) === '데이터 내보내기', 'the dialog title is Korean');
  const kfile = path.join(outDir, 'ko.csv');
  writeFileSync(dialogFile, q({ save: kfile }));
  await b.js(`(() => { const n = document.querySelector('#dbExportFormat'); n.value = 'csv'; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await b.click('.dialog .dialog-buttons .primary');
  await b.until(`window.__exp.then(r => r && r.ok)`, 'Korean export');
  await b.until(`ide.notifications.list().some(n => n.title === '데이터를 내보냈습니다')`, 'Korean notification');
  b.check(readFileSync(kfile, 'utf8') === 'id,price\r\n1,2.0\r\n', 'the export works in the Korean UI');
  const missing = (await missingTranslations(b)).filter((s) => /Export|export|rows|Comma|Semicolon|Pipe|Quote|Encoding|BOM|JSON Lines|Array of objects|column header|Table|Query|Format|Style|separator|Starting|Data exported|INSERT|Markdown|needed|Always|Never/.test(s));
  b.check(!missing.length, `no missing translations for Export Data (${q(missing)})`);
  b.check(!b.consoleErrors.length, `no renderer exceptions (${q(b.consoleErrors)})`);
  results.push(...b.results);
  b.close();
  b = null;
} catch (err) {
  console.log(`FAIL ${err.stack || err.message}`);
  results.push({ ok: false });
} finally {
  a?.close();
  b?.close();
}
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
