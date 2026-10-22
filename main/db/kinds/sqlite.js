// SQLite, built in through Electron's node:sqlite. See main/db/drivers.js for the kind module contract.
// Console completion data (ui.completion): SQLite keywords, built-in functions with their signatures, and types.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const COMPLETION = {
  keywords: list(`PRAGMA, AUTOINCREMENT, WITHOUT ROWID, STRICT, INSERT OR REPLACE, INSERT OR IGNORE, REPLACE INTO, ON CONFLICT, DO NOTHING,
    DO UPDATE SET, RETURNING, ATTACH DATABASE, DETACH DATABASE, VACUUM, REINDEX, ANALYZE, EXPLAIN QUERY PLAN, GLOB, REGEXP, COLLATE NOCASE,
    CREATE TEMP TABLE, CREATE VIRTUAL TABLE, CREATE TRIGGER, BEFORE, AFTER, INSTEAD OF, FOR EACH ROW, IF NOT EXISTS, BEGIN TRANSACTION,
    SAVEPOINT, RELEASE, ROWID, WINDOW, FILTER, NULLS FIRST, NULLS LAST`),
  functions: [
    'abs(x)', 'changes()', 'char(x1, x2[, ...])', 'coalesce(x, y[, ...])', 'format(format, ...)', 'glob(pattern, string)', 'hex(x)',
    'ifnull(x, y)', 'iif(condition, x, y)', 'instr(string, substring)', 'last_insert_rowid()', 'length(x)',
    'like(pattern, string[, escape])', 'lower(x)', 'ltrim(x[, characters])', 'max(x, y[, ...])', 'min(x, y[, ...])', 'nullif(x, y)',
    'printf(format, ...)', 'quote(x)', 'random()', 'randomblob(n)', 'replace(string, pattern, replacement)', 'round(x[, digits])',
    'rtrim(x[, characters])', 'sign(x)', 'substr(string, start[, length])', 'total_changes()', 'trim(x[, characters])', 'typeof(x)',
    'unicode(x)', 'upper(x)', 'zeroblob(n)', 'date(time_value[, modifier, ...])', 'time(time_value[, modifier, ...])',
    'datetime(time_value[, modifier, ...])', 'julianday(time_value[, modifier, ...])', 'unixepoch(time_value[, modifier, ...])',
    'strftime(format, time_value[, modifier, ...])', 'avg(x)', 'count(x)', 'group_concat(x[, separator])', 'sum(x)', 'total(x)', 'json(x)',
    'json_array(value[, ...])', 'json_object(label, value[, ...])', 'json_extract(json, path[, ...])', 'json_set(json, path, value[, ...])',
    'json_insert(json, path, value[, ...])', 'json_remove(json, path[, ...])', 'json_type(json[, path])', 'json_valid(json)',
    'json_group_array(value)', 'json_group_object(name, value)', 'json_each(json[, path])', 'json_tree(json[, path])', 'row_number()',
    'rank()', 'dense_rank()', 'ntile(n)', 'lag(expr[, offset[, default]])', 'lead(expr[, offset[, default]])', 'first_value(expr)',
    'last_value(expr)', 'nth_value(expr, n)',
  ].map((signature) => ({ name: signature.match(/^\w+/)[0], signature })),
  dataTypes: list('INTEGER, REAL, TEXT, BLOB, NUMERIC, ANY'),
};

// The database lives on a worker thread: node:sqlite is synchronous, and a long statement (a recursive CTE, a scan of a
// large file) run in the main process would stop every window's IPC until it ended. The worker evaluates this function's
// text, so it needs nothing but built-in modules; values come back raw (BigInt, Uint8Array) and are made JSON-safe here.
function sqliteWorker() {
  const { parentPort } = require('worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  let db = null;
  const cursors = new Map();
  let cursorSeq = 0;
  const ops = {
    open(file) { db = new DatabaseSync(file); },
    query(sql, maxRows) {
      const stmt = db.prepare(sql);
      const cols = stmt.columns();
      if (!cols.length) return { columns: [], changes: Number(stmt.run().changes) };
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const rows = [];
      let truncated = false;
      for (const row of stmt.iterate()) {
        if (rows.length >= maxRows) { truncated = true; break; }
        rows.push(row);
      }
      return { columns: cols.map((c) => ({ name: c.name, type: c.type || '' })), rows, truncated };
    },
    schema() {
      const tables = db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return [{
        name: 'main',
        kind: 'schema',
        children: tables.map((t) => ({
          name: t.name,
          kind: t.type,
          columns: db.prepare(`PRAGMA table_xinfo("${t.name.replace(/"/g, '""')}")`).all()
            .filter((c) => !c.hidden).map((c) => ({ name: c.name, type: c.type, pk: c.pk > 0, nullable: !c.notnull })),
        })),
      }];
    },
    version() { return db.prepare('SELECT sqlite_version() AS v').get().v; },
    // Export Data pages a statement through an open iterator, a batch per call, so a large table never sits whole in
    // either thread. Other statements may run between batches.
    cursorOpen(sql) {
      const stmt = db.prepare(sql);
      const cols = stmt.columns();
      if (!cols.length) return { id: null, columns: [] };
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const id = ++cursorSeq;
      cursors.set(id, stmt.iterate());
      return { id, columns: cols.map((c) => ({ name: c.name, type: c.type || '' })) };
    },
    cursorNext(id, n) {
      const it = cursors.get(id);
      if (!it) return { rows: [], done: true };
      const rows = [];
      while (rows.length < n) {
        const r = it.next();
        if (r.done) { cursors.delete(id); return { rows, done: true }; }
        rows.push(r.value);
      }
      return { rows, done: false };
    },
    cursorClose(id) {
      const it = cursors.get(id);
      cursors.delete(id);
      try { it?.return?.(); } catch {}
    },
    close() { cursors.clear(); db?.close(); db = null; },
  };
  parentPort.on('message', ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: ops[op](...args) }); } catch (err) { parentPort.postMessage({ id, error: String(err?.message || err) }); }
  });
}

// SQLite's own text for a REAL, which JS would shorten: 2.0 stays 2.0 (not 2), 1e20 is 1.0e+20, infinities are Inf.
function realText(v) {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Inf' : '-Inf';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return (Object.is(v, -0) ? '-0' : String(v)) + '.0';
  if (Number.isInteger(v)) return v.toExponential().replace(/^(-?\d+)e/, '$1.0e');
  return String(v);
}

// Values keep the database's text: rows are read with BigInts, so a JS number is always a REAL. A REAL whose JS text
// would lose its fraction and an INTEGER beyond 2^53 become {$number: text} (shown, copied and exported as that text);
// blobs stay whole for export (exact) and become hex or a size for the grid (jsonSafe).
function fidelity(v) {
  if (typeof v === 'number') return Number.isInteger(v) || !Number.isFinite(v) ? { $number: realText(v) } : v;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : { $number: v.toString() };
  return v;
}

module.exports = ({ jsonSafe, commandOf, DML, timed, exportError }) => {
  const gridValue = (v) => { const f = fidelity(v); return f !== null && typeof f === 'object' && '$number' in f ? f : jsonSafe(f); };
  async function openSqlite(cfg, { onLost = () => {} } = {}) {
    if (!cfg.file) throw new Error('No database file is set');
    const { Worker } = require('worker_threads');
    const worker = new Worker(`(${sqliteWorker})()`, { eval: true });
    worker.unref();
    const waiting = new Map();
    let seq = 0;
    let closed = false;
    const settle = (err) => {
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
    };
    worker.on('message', ({ id, result, error }) => {
      const w = waiting.get(id);
      waiting.delete(id);
      if (error !== undefined) w?.reject(new Error(error)); else w?.resolve(result);
    });
    const lost = (err) => {
      settle(err);
      if (!closed) { closed = true; onLost(err); }
    };
    worker.on('error', lost);
    worker.on('exit', () => lost(new Error('Connection closed')));
    const call = (op, ...args) => new Promise((resolve, reject) => {
      if (closed) { reject(new Error('Connection closed')); return; }
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, op, args });
    });
    try {
      await call('open', cfg.file);
    } catch (err) {
      closed = true;
      worker.terminate();
      throw err;
    }
    return {
      query: (sql, { maxRows }) => timed(async () => {
        const command = commandOf(sql);
        const r = await call('query', sql, maxRows);
        if (!r.columns.length) return { columns: [], rows: [], rowCount: DML.has(command) ? r.changes : null, truncated: false, command };
        return { columns: r.columns, rows: r.rows.map((row) => row.map(gridValue)), rowCount: r.rows.length, truncated: r.truncated, command };
      }),
      // {columns, next(n) -> rows | null, close()}: rows with exact values (see fidelity) for Export Data.
      async cursor(sql) {
        const { id, columns } = await call('cursorOpen', sql);
        if (id === null) throw exportError('NO_ROWS');
        let done = false;
        return {
          columns,
          async next(n) {
            if (done) return null;
            const r = await call('cursorNext', id, n);
            done = r.done;
            return r.rows.length || !done ? r.rows.map((row) => row.map(fidelity)) : null;
          },
          close: () => (done ? Promise.resolve() : call('cursorClose', id).catch(() => {})),
        };
      },
      schema: () => call('schema'),
      async version() { return `SQLite ${await call('version')}`; },
      // A statement still running is abandoned: its caller gets an error now, and the thread ends when SQLite returns.
      async close() {
        if (closed) return;
        if (!waiting.size) await call('close').catch(() => {});
        closed = true;
        settle(new Error('Disconnected'));
        worker.terminate();
      },
    };
  }

  return {
    kinds: {
      sqlite: { label: 'SQLite', order: 10, builtin: true, fields: ['file'], quote: '"', implicitSchemas: ['main'], open: openSqlite, ui: { completion: COMPLETION } },
    },
  };
};
