// PostgreSQL through the pg package. See main/db/drivers.js for the kind module contract.
// Console completion data (ui.completion): PostgreSQL keywords, built-in functions with their signatures, and types.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const COMPLETION = {
  keywords: list(`RETURNING, ILIKE, SIMILAR TO, ON CONFLICT, DO NOTHING, DO UPDATE SET, DISTINCT ON, LATERAL, WITH RECURSIVE, FILTER, WITHIN GROUP,
    NULLS FIRST, NULLS LAST, FETCH FIRST, ROWS ONLY, FOR UPDATE, SKIP LOCKED, CREATE SCHEMA, CREATE MATERIALIZED VIEW, REFRESH MATERIALIZED VIEW,
    CREATE EXTENSION, CREATE TYPE, CREATE FUNCTION, CREATE OR REPLACE FUNCTION, CREATE TRIGGER, CREATE SEQUENCE, LANGUAGE plpgsql, RETURNS,
    GENERATED ALWAYS AS IDENTITY, TRUNCATE, VACUUM, ANALYZE, EXPLAIN, EXPLAIN ANALYZE, COPY, LISTEN, NOTIFY, GRANT, REVOKE, SET search_path,
    SHOW, ARRAY, ANY, ALL, SOME, IS DISTINCT FROM, TABLESAMPLE`),
  functions: [
    'now()', 'current_date', 'current_timestamp', 'date_trunc(field, source)', 'date_part(field, source)', 'extract(field FROM source)',
    'age(timestamp[, timestamp])', 'to_char(value, format)', 'to_date(text, format)', 'to_timestamp(text, format)',
    'make_date(year, month, day)', 'make_interval([years[, months[, weeks[, days[, hours[, mins[, secs]]]]]]])',
    'generate_series(start, stop[, step])', 'coalesce(value[, ...])', 'nullif(value1, value2)', 'greatest(value[, ...])',
    'least(value[, ...])', 'length(string)', 'char_length(string)', 'lower(string)', 'upper(string)', 'initcap(string)',
    'concat(value[, ...])', 'concat_ws(separator, value[, ...])', 'substring(string from start[ for count])', 'left(string, n)',
    'right(string, n)', 'position(substring in string)', 'strpos(string, substring)', 'replace(string, from, to)',
    'split_part(string, delimiter, n)', 'regexp_replace(source, pattern, replacement[, flags])', 'regexp_match(string, pattern[, flags])',
    'string_to_array(string, delimiter)', 'trim([leading | trailing | both] [characters from] string)', 'lpad(string, length[, fill])',
    'rpad(string, length[, fill])', 'md5(string)', 'format(formatstr, ...)', 'abs(x)', 'round(x[, digits])', 'ceil(x)', 'floor(x)',
    'trunc(x[, digits])', 'mod(y, x)', 'power(a, b)', 'sqrt(x)', 'random()', 'gen_random_uuid()', 'count(expression)', 'sum(expression)',
    'avg(expression)', 'min(expression)', 'max(expression)', 'string_agg(expression, delimiter)', 'array_agg(expression)',
    'bool_and(expression)', 'bool_or(expression)', 'json_agg(expression)', 'jsonb_agg(expression)', 'json_build_object(key, value[, ...])',
    'jsonb_build_object(key, value[, ...])', 'jsonb_set(target, path, new_value[, create_missing])',
    'jsonb_extract_path_text(from_json, path[, ...])', 'jsonb_array_elements(jsonb)', 'jsonb_each(jsonb)', 'to_jsonb(value)',
    'array_length(array, dimension)', 'unnest(array)', 'array_to_string(array, delimiter)', 'cardinality(array)', 'row_number()', 'rank()',
    'dense_rank()', 'ntile(n)', 'lag(value[, offset[, default]])', 'lead(value[, offset[, default]])', 'first_value(value)',
    'last_value(value)', 'percentile_cont(fraction)', 'currval(sequence)', 'nextval(sequence)', 'setval(sequence, value)',
    'pg_size_pretty(bytes)', 'pg_total_relation_size(relation)', 'current_user', 'current_schema()', 'version()',
  ].map((signature) => ({ name: signature.match(/^\w+/)[0], signature })),
  dataTypes: list('integer, bigint, smallint, serial, bigserial, numeric, decimal, real, double precision, money, text, varchar, char, boolean, date, time, timestamp, timestamptz, interval, uuid, json, jsonb, bytea, inet, cidr, macaddr, xml, tsvector, tsquery, int4range, tstzrange, point'),
};

module.exports = ({ loadPackage, jsonSafe, commandOf, DML, timed, groupSchema, exportError, resultCursor, EXPORT_ROW_CAP, NETWORK_FIELDS }) => {
  const PG_TYPES = { 16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4', 701: 'float8',
    1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb' };

  // onLost(err) runs when an open connection drops (server stopped, network gone). The listeners also keep the driver's
  // 'error' event from becoming an uncaught exception in the main process.
  // Export Data's values: PostgreSQL's own text, except numbers ({$number: text}, exact past 2^53 and for numeric),
  // bytea (a Buffer of the bytes) and booleans. Dates, json, arrays, uuid... stay as the server prints them.
  const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
  const exactTypes = (pg) => ({
    getTypeParser(oid, format) {
      if (oid === 17) return pg.types.getTypeParser(17, format);
      if (oid === 16) return (s) => s === 't' || s === 'true';
      if (NUMERIC_OIDS.has(oid)) return (s) => ({ $number: s });
      return (s) => s;
    },
  });
  // DECLARE refuses what is not a query (SHOW, EXPLAIN, INSERT … RETURNING): a syntax error, or "not supported".
  const CANNOT_DECLARE = new Set(['42601', '0A000']);

  async function openPostgres(cfg, { onLost = () => {} } = {}) {
    const pg = loadPackage('pg');
    const { Client } = pg;
    const config = { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, connectionTimeoutMillis: 10000 };
    const client = new Client(config);
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
      // Export Data: the statement as a server-side cursor (DECLARE … NO SCROLL CURSOR, FETCH n) in a transaction on a
      // connection of its own, so pages come from one execution in order and the console can go on meanwhile.
      // readOnly makes it a read-only transaction that is rolled back; otherwise it commits like the console would.
      // A statement no cursor can hold runs whole instead, and at most EXPORT_ROW_CAP of its rows are exported.
      async cursor(sql, { readOnly = false } = {}) {
        const text = sql.trim().replace(/;\s*$/, '');
        const types = exactTypes(pg);
        const own = new Client(config);
        own.on('error', () => {});
        await own.connect();
        const run = (t) => own.query({ text: t, rowMode: 'array', types });
        const begin = readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN';
        const columnsOf = (fields) => fields.map((f) => ({ name: f.name, type: PG_TYPES[f.dataTypeID] || String(f.dataTypeID) }));
        try {
          await own.query(begin);
          let first;
          try {
            await own.query(`DECLARE pyide_export NO SCROLL CURSOR FOR ${text}`);
            first = await run('FETCH 1000 FROM pyide_export');
          } catch (err) {
            if (!CANNOT_DECLARE.has(err.code)) throw err;
            await own.query('ROLLBACK');
            if (readOnly) await own.query(begin);
            const whole = await run(text);
            const last = Array.isArray(whole) ? whole[whole.length - 1] : whole;
            if (!last.fields?.length) throw exportError('NO_ROWS');
            return resultCursor(columnsOf(last.fields), last.rows, EXPORT_ROW_CAP, async () => {
              if (readOnly) await own.query('ROLLBACK').catch(() => {});
              await own.end();
            });
          }
          if (!first.fields?.length) throw exportError('NO_ROWS');
          let pending = first.rows;
          let done = first.rows.length < 1000;
          let closed = false;
          return {
            columns: columnsOf(first.fields),
            async next(n) {
              if (pending) { const out = pending; pending = null; if (out.length) return out; }
              if (done) return null;
              const r = await run(`FETCH ${Math.max(1, n | 0)} FROM pyide_export`);
              if (r.rows.length < n) done = true;
              return r.rows.length ? r.rows : null;
            },
            // Closed early (Cancel, a failed write), the connection just ends: the server rolls the transaction back
            // and stops the statement.
            async close() {
              if (closed) return;
              closed = true;
              try { if (done) await own.query(readOnly ? 'ROLLBACK' : 'COMMIT'); } finally { await own.end().catch(() => {}); }
            },
          };
        } catch (err) {
          own.end().catch(() => {});
          throw err;
        }
      },
      close: () => client.end(),
    };
  }

  return {
    packages: { pg: 'pg@8' },
    kinds: {
      postgres: { label: 'PostgreSQL', order: 20, package: 'pg', defaultPort: 5432, fields: NETWORK_FIELDS, quote: '"', sqlDialect: 'postgres', implicitSchemas: ['public'], open: openPostgres, ui: { completion: COMPLETION } },
    },
  };
};
