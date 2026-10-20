// Database drivers: the shared helpers and the registry of data source kinds (main/db/kinds/*.js). SQLite is built in
// (node:sqlite); the others load an npm package from the driver directory, installed on demand like PyCharm's
// "Download driver files".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const driverDir = () => process.env.PYIDE_DB_DRIVERS || path.join(os.homedir(), '.pyide', 'db-drivers');

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

// ---------- kinds ----------
// Every file in main/db/kinds/ is a kind module: module.exports = (lib) => ({ kinds: {key: kind}, packages?: {name: spec} }),
// where lib is the shared helpers below and packages are the npm specs its kinds load with lib.loadPackage(name).
// A kind: { label, order (menu position), open(cfg, {onLost}) -> adapter, fields, builtin? | package, defaultPort?,
//   quote (identifier quote), implicitSchemas (schemas generated SQL leaves unqualified), ui? (passed to the renderer
//   as is: console language, statement splitting, tree shape) }.
// fields: built-in names ('file', 'host', 'port', 'user', 'password', 'database') or specs
//   { key, label (English, translated in the renderer), type: 'text' | 'number' | 'password' | 'checkbox' | 'select' | 'file',
//     options?: [[value, label]], placeholder?, default?, extensions? (for 'file') }.
// The adapter: { query(text, {maxRows}) -> {columns: [{name, type}], rows: [[...]], rowCount, truncated, command, ms},
//   schema() -> [{name, kind, children: [{name, kind, columns: [{name, type, pk, nullable}]}]}], version(), close() },
// every value JSON-safe (lib.jsonSafe). Adding a database is adding one file here.
const lib = { loadPackage, jsonSafe, commandOf, DML, timed, groupSchema, NETWORK_FIELDS: ['host', 'port', 'user', 'password', 'database'] };
const DRIVERS = {};
const PACKAGES = {};
for (const file of fs.readdirSync(path.join(__dirname, 'kinds')).filter((f) => f.endsWith('.js')).sort()) {
  const mod = require(path.join(__dirname, 'kinds', file))(lib);
  Object.assign(PACKAGES, mod.packages);
  Object.assign(DRIVERS, mod.kinds);
}
const ordered = Object.fromEntries(Object.entries(DRIVERS).sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999)));

module.exports = { DRIVERS: ordered, PACKAGES, driverDir, packageVersion, jsonSafe };