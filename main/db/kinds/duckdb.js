// DuckDB, embedded like SQLite, through the official @duckdb/node-api package (its prebuilt binding is an N-API
// addon, so the same win32-x64 build loads in Electron's Node). See main/db/drivers.js for the kind module contract.
const path = require('path');

// Console completion data (ui.completion): DuckDB keywords, functions (file readers, lists, structs, dates), and types.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const COMPLETION = {
  keywords: list(`SELECT, FROM, WHERE, GROUP BY, GROUP BY ALL, HAVING, ORDER BY, ORDER BY ALL, ASC, DESC, NULLS FIRST, NULLS LAST,
    LIMIT, OFFSET, DISTINCT, DISTINCT ON, AS, JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, POSITIONAL JOIN,
    ASOF JOIN, ASOF LEFT JOIN, SEMI JOIN, ANTI JOIN, LATERAL, ON, USING, UNION, UNION ALL, UNION BY NAME, UNION ALL BY NAME, INTERSECT,
    EXCEPT, QUALIFY, WINDOW, OVER, PARTITION BY, ROWS BETWEEN, RANGE BETWEEN, UNBOUNDED PRECEDING, CURRENT ROW, FILTER, PIVOT,
    UNPIVOT, PIVOT_LONGER, PIVOT_WIDER, EXCLUDE, REPLACE, COLUMNS, USING SAMPLE, TABLESAMPLE, REPEATABLE, INSERT INTO,
    INSERT OR REPLACE INTO, INSERT OR IGNORE INTO, BY NAME, VALUES, RETURNING, ON CONFLICT DO NOTHING, ON CONFLICT DO UPDATE SET,
    UPDATE, SET, DELETE FROM, CREATE TABLE, CREATE OR REPLACE TABLE, CREATE TEMP TABLE, CREATE VIEW, CREATE OR REPLACE VIEW,
    CREATE MACRO, CREATE SEQUENCE, CREATE SCHEMA, CREATE TYPE, CREATE INDEX, CREATE SECRET, ALTER TABLE, ADD COLUMN, DROP COLUMN,
    RENAME COLUMN, RENAME TO, DROP TABLE, DROP VIEW, DROP MACRO, IF EXISTS, IF NOT EXISTS, PRIMARY KEY, FOREIGN KEY, REFERENCES,
    UNIQUE, CHECK, DEFAULT, NOT NULL, NULL, IS NULL, IS NOT NULL, IS DISTINCT FROM, IS NOT DISTINCT FROM, AND, OR, NOT, IN, EXISTS,
    BETWEEN, LIKE, ILIKE, GLOB, SIMILAR TO, CASE, WHEN, THEN, ELSE, END, WITH, WITH RECURSIVE, MATERIALIZED, COPY, TO, FORMAT,
    HEADER, DELIMITER, PARTITION_BY, ATTACH, DETACH, USE, INSTALL, LOAD, FORCE INSTALL, EXPORT DATABASE, IMPORT DATABASE, DESCRIBE,
    SUMMARIZE, SHOW TABLES, SHOW ALL TABLES, SHOW DATABASES, PRAGMA, SET, RESET, EXPLAIN, EXPLAIN ANALYZE, BEGIN TRANSACTION, COMMIT,
    ROLLBACK, CHECKPOINT, VACUUM, LAMBDA, STRUCT, MAP, INTERVAL`),
  functions: [
    'read_csv_auto(path[, options])', 'read_csv(path[, options])', 'read_parquet(path[, options])', 'read_json_auto(path[, options])',
    'read_json(path[, options])', 'read_ndjson(path[, options])', 'read_text(path)', 'read_blob(path)', 'parquet_schema(path)',
    'parquet_metadata(path)', 'glob(pattern)', 'sniff_csv(path)', 'list_value(value[, ...])', 'list_concat(list1, list2)',
    'list_contains(list, element)', 'list_has_any(list1, list2)', 'list_has_all(list1, list2)', 'list_extract(list, index)',
    'list_slice(list, begin, end[, step])', 'list_sort(list[, order[, nulls]])', 'list_reverse_sort(list)', 'list_distinct(list)',
    'list_unique(list)', 'list_aggregate(list, name)', 'list_transform(list, lambda)', 'list_filter(list, lambda)',
    'list_reduce(list, lambda)', 'list_position(list, element)', 'list_reverse(list)', 'list_zip(list1, list2[, ...])',
    'list_sum(list)', 'list_min(list)', 'list_max(list)', 'list_avg(list)', 'list_count(list)', 'list_string_agg(list)', 'len(list)',
    'unnest(list[, recursive := true])', 'flatten(list_of_lists)', 'array_agg(expr)', 'struct_pack(name := value[, ...])',
    'struct_extract(struct, entry)', 'struct_insert(struct, name := value)', 'row(value[, ...])', 'map(keys, values)',
    'map_from_entries(list)', 'map_keys(map)', 'map_values(map)', 'map_extract(map, key)', 'strftime(timestamp, format)',
    'strptime(text, format)', 'try_strptime(text, format)', 'date_trunc(part, date)', 'date_part(part, date)', 'date_diff(part, start, end)',
    'date_sub(part, start, end)', 'date_add(date, interval)', 'datediff(part, start, end)', 'make_date(year, month, day)',
    'make_timestamp(year, month, day, hour, minute, seconds)', 'epoch(timestamp)', 'epoch_ms(milliseconds)', 'to_timestamp(seconds)',
    'current_date', 'current_timestamp', 'now()', 'today()', 'age(timestamp1[, timestamp2])', 'time_bucket(width, timestamp[, origin])',
    'last_day(date)', 'dayname(date)', 'monthname(date)', 'generate_series(start, stop[, step])', 'range(start, stop[, step])',
    'string_split(string, separator)', 'string_agg(arg, separator)', 'concat(value[, ...])', 'concat_ws(separator, value[, ...])',
    'regexp_matches(string, pattern[, options])', 'regexp_replace(string, pattern, replacement[, options])',
    'regexp_extract(string, pattern[, group[, options]])', 'regexp_split_to_array(string, pattern)', 'contains(string, search)',
    'starts_with(string, prefix)', 'ends_with(string, suffix)', 'lower(string)', 'upper(string)', 'length(string)',
    'substring(string, start[, length])', 'trim(string[, characters])', 'replace(string, source, target)',
    'split_part(string, separator, index)', 'format(format, value[, ...])', 'printf(format, value[, ...])',
    'lpad(string, count, character)', 'rpad(string, count, character)', 'levenshtein(string1, string2)',
    'jaro_winkler_similarity(string1, string2)', 'md5(value)', 'sha256(value)', 'hash(value)', 'coalesce(value[, ...])',
    'ifnull(expr, other)', 'nullif(a, b)', 'greatest(value[, ...])', 'least(value[, ...])', 'try_cast(expr AS type)', 'typeof(expr)',
    'count(expr)', 'count_star()', 'sum(expr)', 'avg(expr)', 'min(expr)', 'max(expr)', 'median(expr)', 'mode(expr)',
    'quantile_cont(expr, position)', 'quantile_disc(expr, position)', 'approx_count_distinct(expr)', 'approx_quantile(expr, position)',
    'arg_max(arg, value)', 'arg_min(arg, value)', 'max_by(arg, value)', 'min_by(arg, value)', 'first(expr)', 'last(expr)',
    'any_value(expr)', 'list(expr)', 'histogram(expr)', 'bool_and(expr)', 'bool_or(expr)', 'stddev(expr)', 'variance(expr)',
    'corr(y, x)', 'regr_slope(y, x)', 'row_number()', 'rank()', 'dense_rank()', 'percent_rank()', 'ntile(buckets)',
    'lag(expr[, offset[, default]])', 'lead(expr[, offset[, default]])', 'first_value(expr)', 'last_value(expr)', 'nth_value(expr, n)',
    'round(number[, digits])', 'floor(number)', 'ceil(number)', 'abs(number)', 'sqrt(number)', 'pow(base, exponent)', 'ln(number)',
    'log10(number)', 'random()', 'setseed(seed)', 'uuid()', 'gen_random_uuid()', 'json_extract(json, path)',
    'json_extract_string(json, path)', 'json_keys(json)', 'json_array_length(json)', 'json_structure(json)', 'json_transform(json, structure)',
    'to_json(value)', 'json_object(key, value[, ...])', 'duckdb_tables()', 'duckdb_columns()', 'duckdb_settings()', 'duckdb_extensions()',
  ].map((signature) => ({ name: signature.match(/^\w+/)[0], signature })),
  dataTypes: list(`BOOLEAN, TINYINT, SMALLINT, INTEGER, BIGINT, HUGEINT, UTINYINT, USMALLINT, UINTEGER, UBIGINT, UHUGEINT, FLOAT, DOUBLE,
    DECIMAL(p, s), VARCHAR, BLOB, BIT, DATE, TIME, TIMETZ, TIMESTAMP, TIMESTAMPTZ, TIMESTAMP_S, TIMESTAMP_MS, TIMESTAMP_NS, INTERVAL,
    UUID, JSON, ENUM, LIST, ARRAY, STRUCT, MAP, UNION, VARIANT, GEOMETRY`),
};

module.exports = ({ loadPackage, jsonSafe, commandOf, timed, groupSchema, exportError }) => {
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

  // Export Data keeps BIGINT/HUGEINT as bigint, DECIMAL as its digits ({$number}) and BLOB as its bytes.
  function exactOf(duck, v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object') return v;
    if (v instanceof duck.DuckDBBlobValue) return v.bytes;
    if (duck.DuckDBDecimalValue && v instanceof duck.DuckDBDecimalValue) return { $number: v.toString() };
    return cellOf(duck, v);
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
      // Export Data: the statement's streaming result read a chunk at a time on the source's connection (an in-memory
      // database exists only there). DuckDB has no read-only transaction per statement, so readOnly changes nothing.
      async cursor(sql) {
        const prepared = await conn.prepare(sql.trim().replace(/;\s*$/, ''));
        let result;
        try { result = await prepared.stream(); } finally { prepared.destroySync(); }
        if (result.returnType !== duck.ResultReturnType.QUERY_RESULT) throw exportError('NO_ROWS');
        const types = result.columnTypes().map(String);
        let buffer = [];
        let done = false;
        return {
          columns: result.columnNames().map((name, i) => ({ name, type: types[i] })),
          async next(n) {
            while (!done && buffer.length < n) {
              const chunk = await result.fetchChunk();
              if (!chunk || !chunk.rowCount) { done = true; break; }
              for (const row of chunk.getRows()) buffer.push(row.map((v) => exactOf(duck, v)));
            }
            if (!buffer.length) return null;
            const out = buffer.length > n ? buffer.splice(0, n) : buffer;
            if (out === buffer) buffer = [];
            return out;
          },
          async close() { done = true; buffer = []; },
        };
      },
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
        label: 'DuckDB', order: 15, package: '@duckdb/node-api', quote: '"', sqlDialect: 'duckdb', implicitSchemas: ['main'], open: openDuckdb,
        fields: [
          { key: 'file', label: 'File', type: 'file', extensions: ['duckdb', 'db', 'ddb'] },
          { key: 'memory', label: 'In-memory database (nothing is saved)', type: 'checkbox', default: false },
          { key: 'readOnly', label: 'Read-only', type: 'checkbox', default: false },
        ],
        ui: {
          fileOptional: 'memory',
          completion: COMPLETION,
          description: "Embedded analytical database in a file or in memory. It queries CSV, Parquet and JSON files directly, e.g. SELECT * FROM read_csv_auto('data.csv').",
        },
      },
    },
  };
};
