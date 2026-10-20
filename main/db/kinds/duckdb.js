// DuckDB, embedded like SQLite, through the official @duckdb/node-api package (its prebuilt binding is an N-API
// addon, so the same win32-x64 build loads in Electron's Node). See main/db/drivers.js for the kind module contract.
const path = require('path');

module.exports = ({ loadPackage, jsonSafe, commandOf, timed, groupSchema }) => {
  // DuckDB locks a database file per process, so connections to one file share an instance; the last close
  // releases the file for other programs (a Python script using duckdb, say).
  const shared = new Map(); // key -> {instance: Promise, refs}
  async function acquire(duck, file, readOnly) {
    if (!file) return { instance: await duck.DuckDBInstance.create(':memory:'), release: (i) => i.closeSync() };
    const key = `${path.resolve(file).toLowerCase()}|${readOnly ? 'ro' : 'rw'}`;
    if (!shared.has(key)) shared.set(key, { instance: duck.DuckDBInstance.create(file, readOnly ? { access_mode: 'READ_ONLY' } : {}), refs: 0 });
    const entry = shared.get(key);
    entry.refs++;
    try {
      return {
        instance: await entry.instance,
        release: (i) => { if (--entry.refs === 0) { shared.delete(key); i.closeSync(); } },
      };
    } catch (err) {
      if (--entry.refs === 0) shared.delete(key);
      throw err;
    }
  }

  function cellOf(duck, v) {
    if (v === null || v === undefined || typeof v !== 'object') return jsonSafe(v);
    if (v instanceof duck.DuckDBBlobValue) return jsonSafe(v.bytes);
    if (v instanceof duck.DuckDBTimestampTZValue) {
      const d = new Date(Number(v.micros / 1000n));
      return v.isFinite && !Number.isNaN(d.getTime()) ? d.toISOString() : v.toString();
    }
    // Timestamps without a zone: their wall-clock text in ISO form.
    if (v instanceof duck.DuckDBTimestampValue || v instanceof duck.DuckDBTimestampSecondsValue
      || v instanceof duck.DuckDBTimestampMillisecondsValue || v instanceof duck.DuckDBTimestampNanosecondsValue) return v.toString().replace(' ', 'T');
    // Decimals, dates, UUIDs, intervals, lists, structs, maps: DuckDB's own text.
    return v.toString();
  }

  async function openDuckdb(cfg) {
    const duck = loadPackage('@duckdb/node-api');
    const file = cfg.memory || !cfg.file || cfg.file === ':memory:' ? null : cfg.file;
    const { instance, release } = await acquire(duck, file, cfg.readOnly);
    let conn;
    try { conn = await instance.connect(); } catch (err) { release(instance); throw err; }

    async function rowsOf(result, maxRows) {
      const rows = [];
      let truncated = false;
      for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount; chunk = await result.fetchChunk()) {
        for (const row of chunk.getRows()) {
          if (rows.length >= maxRows) { truncated = true; break; }
          rows.push(row.map((v) => cellOf(duck, v)));
        }
        if (truncated) break;
      }
      return { rows, truncated };
    }

    // Statements run one by one; the last one streams, so a large result stops at maxRows without a LIMIT.
    async function run(sql, maxRows) {
      const extracted = await conn.extractStatements(sql);
      if (!extracted.count) return { columns: [], rows: [], rowCount: null, truncated: false, command: commandOf(sql) };
      let result;
      for (let i = 0; i < extracted.count; i++) {
        const prepared = await extracted.prepare(i);
        try {
          if (i < extracted.count - 1) await prepared.run();
          else result = await prepared.stream();
        } finally { prepared.destroySync(); }
      }
      const command = duck.StatementType[result.statementType] || commandOf(sql);
      if (result.returnType === duck.ResultReturnType.CHANGED_ROWS) return { columns: [], rows: [], rowCount: Number(result.rowsChanged), truncated: false, command };
      if (result.returnType !== duck.ResultReturnType.QUERY_RESULT) return { columns: [], rows: [], rowCount: null, truncated: false, command };
      const types = result.columnTypes().map(String);
      const { rows, truncated } = await rowsOf(result, maxRows);
      return { columns: result.columnNames().map((name, i) => ({ name, type: types[i] })), rows, rowCount: rows.length, truncated, command };
    }

    const all = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJS();

    return {
      query: (sql, { maxRows }) => timed(() => run(sql, maxRows)),
      async schema() {
        const [columns, keys] = await Promise.all([
          all(`SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable
               FROM information_schema.columns c
               JOIN information_schema.tables t USING (table_catalog, table_schema, table_name)
               WHERE c.table_catalog = current_database()
               ORDER BY c.table_schema, c.table_name, c.ordinal_position`),
          all(`SELECT schema_name, table_name, unnest(constraint_column_names) AS column_name FROM duckdb_constraints()
               WHERE constraint_type = 'PRIMARY KEY' AND database_name = current_database()`),
        ]);
        const pk = new Set(keys.map((k) => `${k.schema_name}\0${k.table_name}\0${k.column_name}`));
        return groupSchema(columns.map((r) => ({
          schema: r.table_schema, table: r.table_name, view: r.table_type === 'VIEW', column: r.column_name, type: r.data_type,
          nullable: r.is_nullable === 'YES', pk: pk.has(`${r.table_schema}\0${r.table_name}\0${r.column_name}`),
        })));
      },
      async version() { return `DuckDB ${(await all('SELECT version() AS v'))[0].v}`; },
      async close() {
        conn.closeSync();
        release(instance);
      },
    };
  }

  return {
    packages: { '@duckdb/node-api': '@duckdb/node-api@1.5.6-r.1' },
    kinds: {
      duckdb: {
        label: 'DuckDB', order: 15, package: '@duckdb/node-api', quote: '"', implicitSchemas: ['main'], open: openDuckdb,
        fields: [
          { key: 'file', label: 'File', type: 'file', extensions: ['duckdb', 'db', 'ddb'] },
          { key: 'memory', label: 'In-memory database (nothing is saved)', type: 'checkbox', default: false },
          { key: 'readOnly', label: 'Read-only', type: 'checkbox', default: false },
        ],
        ui: {
          fileOptional: 'memory',
          description: "Embedded analytical database in a file or in memory. It queries CSV, Parquet and JSON files directly, e.g. SELECT * FROM read_csv_auto('data.csv').",
        },
      },
    },
  };
};
