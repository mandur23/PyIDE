// Database drivers: one table entry per data source kind. SQLite is built in (node:sqlite); the others load an npm
// package from the driver directory, installed on demand like PyCharm's "Download driver files".
// open(cfg, pkg) returns an adapter { query(sql, {maxRows}), schema(), close() } whose results are JSON-safe.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const driverDir = () => process.env.PYIDE_DB_DRIVERS || path.join(os.homedir(), '.pyide', 'db-drivers');

// npm packages a kind can need; MySQL and MariaDB share mysql2.
const PACKAGES = { pg: 'pg@8', mysql2: 'mysql2@3' };

function packageVersion(name) {
  try { return JSON.parse(fs.readFileSync(path.join(driverDir(), 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; }
}

function loadPackage(name, entry = name) {
  if (!packageVersion(name)) {
    const err = new Error(`The ${name} driver is not installed`);
    err.missingDriver = name;
    throw err;
  }
  return createRequire(path.join(driverDir(), 'package.json'))(entry);
}

// ---------- values ----------
function jsonSafe(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) return v.length <= 32 ? `0x${Buffer.from(v).toString('hex')}` : `<${v.length} bytes>`;
  if (typeof v === 'object') { try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return String(v); } }
  return v;
}

// First keyword of a statement, past comments: SELECT, INSERT, CREATE...
const commandOf = (sql) => (sql.replace(/^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '').match(/^[A-Za-z]+/)?.[0] || '').toUpperCase();
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT']);

const timed = async (fn) => {
  const t0 = performance.now();
  const r = await fn();
  return { ...r, ms: Math.round((performance.now() - t0) * 10) / 10 };
};

// ---------- SQLite ----------
function openSqlite(cfg) {
  const { DatabaseSync } = require('node:sqlite');
  if (!cfg.file) throw new Error('No database file is set');
  const db = new DatabaseSync(cfg.file);
  return {
    query: (sql, { maxRows }) => timed(() => {
      const stmt = db.prepare(sql);
      const command = commandOf(sql);
      const cols = stmt.columns();
      if (!cols.length) {
        const r = stmt.run();
        return { columns: [], rows: [], rowCount: DML.has(command) ? Number(r.changes) : null, truncated: false, command };
      }
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const rows = [];
      let truncated = false;
      for (const row of stmt.iterate()) {
        if (rows.length >= maxRows) { truncated = true; break; }
        rows.push(row.map(jsonSafe));
      }
      return { columns: cols.map((c) => ({ name: c.name, type: c.type || '' })), rows, rowCount: rows.length, truncated, command };
    }),
    async schema() {
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
    async version() { return `SQLite ${db.prepare('SELECT sqlite_version() AS v').get().v}`; },
    close: () => db.close(),
  };
}

// ---------- PostgreSQL ----------
const PG_TYPES = { 16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4', 701: 'float8',
  1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb' };

// onLost(err) runs when an open connection drops (server stopped, network gone). The listeners also keep the driver's
// 'error' event from becoming an uncaught exception in the main process.
async function openPostgres(cfg, { onLost = () => {} } = {}) {
  const { Client } = loadPackage('pg');
  const client = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, connectionTimeoutMillis: 10000 });
  client.on('error', onLost);
  client.on('end', () => onLost(new Error('Connection closed')));
  await client.connect();
  return {
    query: (sql, { maxRows }) => timed(async () => {
      const r = await client.query({ text: sql, rowMode: 'array' });
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      const command = last.command || commandOf(sql);
      if (!last.fields?.length) return { columns: [], rows: [], rowCount: DML.has(command) ? last.rowCount : null, truncated: false, command };
      return {
        columns: last.fields.map((f) => ({ name: f.name, type: PG_TYPES[f.dataTypeID] || String(f.dataTypeID) })),
        rows: last.rows.slice(0, maxRows).map((row) => row.map(jsonSafe)),
        rowCount: Math.min(last.rows.length, maxRows),
        truncated: last.rows.length > maxRows,
        command,
      };
    }),
    async schema() {
      const { rows } = await client.query(`
        SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable,
               EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                       JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
                       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS pk
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`);
      return groupSchema(rows.map((r) => ({ schema: r.table_schema, table: r.table_name, view: r.table_type === 'VIEW', column: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', pk: r.pk })));
    },
    async version() { return (await client.query('SELECT version() AS v')).rows[0].v.split(',')[0]; },
    close: () => client.end(),
  };
}

// ---------- MySQL / MariaDB ----------
async function openMysql(cfg, { onLost = () => {} } = {}) {
  const mysql = loadPackage('mysql2', 'mysql2/promise');
  const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database || undefined,
    connectTimeout: 10000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  conn.on('error', onLost);
  conn.on('end', () => onLost(new Error('Connection closed')));
  return {
    query: (sql, { maxRows }) => timed(async () => {
      const [result, fields] = await conn.query({ sql, rowsAsArray: true });
      const command = commandOf(sql);
      if (!Array.isArray(result)) return { columns: [], rows: [], rowCount: DML.has(command) ? result.affectedRows : null, truncated: false, command };
      return {
        columns: (fields || []).map((f) => ({ name: f.name, type: String(f.columnType ?? f.type ?? '') })),
        rows: result.slice(0, maxRows).map((row) => row.map(jsonSafe)),
        rowCount: Math.min(result.length, maxRows),
        truncated: result.length > maxRows,
        command,
      };
    }),
    async schema() {
      const [rows] = await conn.query(`
        SELECT c.TABLE_SCHEMA s, c.TABLE_NAME t, tb.TABLE_TYPE tt, c.COLUMN_NAME col, c.COLUMN_TYPE ty, c.IS_NULLABLE n, c.COLUMN_KEY k
        FROM information_schema.COLUMNS c JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
      return groupSchema(rows.map((r) => ({ schema: r.s, table: r.t, view: r.tt === 'VIEW', column: r.col, type: r.ty, nullable: r.n === 'YES', pk: r.k === 'PRI' })));
    },
    async version() { const [rows] = await conn.query('SELECT VERSION() AS v'); return rows[0].v; },
    close: () => conn.end(),
  };
}

// Flat information_schema rows -> schema / table / column tree.
function groupSchema(rows) {
  const schemas = new Map();
  for (const r of rows) {
    if (!schemas.has(r.schema)) schemas.set(r.schema, new Map());
    const tables = schemas.get(r.schema);
    if (!tables.has(r.table)) tables.set(r.table, { name: r.table, kind: r.view ? 'view' : 'table', columns: [] });
    tables.get(r.table).columns.push({ name: r.column, type: r.type, pk: !!r.pk, nullable: r.nullable });
  }
  return [...schemas].map(([name, tables]) => ({ name, kind: 'schema', children: [...tables.values()] }));
}

const NETWORK_FIELDS = ['host', 'port', 'user', 'password', 'database'];

// quote: identifier quote character; implicitSchemas: schemas that need no qualifier in generated SQL.
const DRIVERS = {
  sqlite: { label: 'SQLite', builtin: true, fields: ['file'], quote: '"', implicitSchemas: ['main'], open: openSqlite },
  postgres: { label: 'PostgreSQL', package: 'pg', defaultPort: 5432, fields: NETWORK_FIELDS, quote: '"', implicitSchemas: ['public'], open: openPostgres },
  mysql: { label: 'MySQL', package: 'mysql2', defaultPort: 3306, fields: NETWORK_FIELDS, quote: '`', implicitSchemas: [], open: openMysql },
  mariadb: { label: 'MariaDB', package: 'mysql2', defaultPort: 3306, fields: NETWORK_FIELDS, quote: '`', implicitSchemas: [], open: openMysql },
};

module.exports = { DRIVERS, PACKAGES, driverDir, packageVersion, jsonSafe };
