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

module.exports = ({ loadPackage, jsonSafe, commandOf, DML, timed, groupSchema, NETWORK_FIELDS }) => {
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

  return {
    packages: { pg: 'pg@8' },
    kinds: {
      postgres: { label: 'PostgreSQL', order: 20, package: 'pg', defaultPort: 5432, fields: NETWORK_FIELDS, quote: '"', implicitSchemas: ['public'], open: openPostgres, ui: { completion: COMPLETION } },
    },
  };
};
