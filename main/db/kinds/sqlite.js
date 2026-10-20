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
    close() { db?.close(); db = null; },
  };
  parentPort.on('message', ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: ops[op](...args) }); } catch (err) { parentPort.postMessage({ id, error: String(err?.message || err) }); }
  });
}

module.exports = ({ jsonSafe, commandOf, DML, timed }) => {
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
        return { columns: r.columns, rows: r.rows.map((row) => row.map(jsonSafe)), rowCount: r.rows.length, truncated: r.truncated, command };
      }),
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
