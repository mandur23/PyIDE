// CockroachDB speaks the PostgreSQL wire protocol, so it reuses the postgres kind and its pg driver; only the tree
// (no crdb_internal / pg_extension, no hidden rowid) and the version text differ. See main/db/drivers.js for the
// kind module contract.
// Console completion data (ui.completion): the PostgreSQL dialect CockroachDB speaks plus its own statements (AS OF
// SYSTEM TIME, SHOW RANGES, zone configs, jobs, multi-region) and functions. Merged with the postgres kind's lists.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const OWN = {
  keywords: list(`SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, ASC, DESC, NULLS FIRST, NULLS LAST, LIMIT, OFFSET, FETCH FIRST,
    DISTINCT, DISTINCT ON, AS, JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, LATERAL, ON, USING, UNION, UNION ALL,
    INTERSECT, EXCEPT, INSERT INTO, VALUES, RETURNING, ON CONFLICT DO NOTHING, ON CONFLICT DO UPDATE SET, EXCLUDED, UPSERT INTO,
    UPDATE, SET, DELETE FROM, CREATE TABLE, CREATE TABLE AS, CREATE VIEW, CREATE MATERIALIZED VIEW, CREATE INDEX,
    CREATE UNIQUE INDEX, CREATE INVERTED INDEX, CREATE DATABASE, CREATE SCHEMA, CREATE SEQUENCE, CREATE TYPE, CREATE FUNCTION,
    CREATE PROCEDURE, CREATE CHANGEFEED FOR, CREATE USER, CREATE ROLE, ALTER TABLE, ADD COLUMN, DROP COLUMN, ALTER COLUMN,
    RENAME TO, RENAME COLUMN, ALTER PRIMARY KEY USING COLUMNS, DROP TABLE, DROP DATABASE, IF EXISTS, IF NOT EXISTS, CASCADE,
    TRUNCATE, PRIMARY KEY, FOREIGN KEY, REFERENCES, UNIQUE, CHECK, DEFAULT, NOT NULL, NULL, IS NULL, IS NOT NULL,
    IS DISTINCT FROM, AND, OR, NOT, IN, EXISTS, BETWEEN, LIKE, ILIKE, SIMILAR TO, CASE, WHEN, THEN, ELSE, END, WITH,
    WITH RECURSIVE, OVER, PARTITION BY, WINDOW, FILTER, BEGIN, COMMIT, ROLLBACK, SAVEPOINT, RELEASE SAVEPOINT, EXPLAIN,
    EXPLAIN ANALYZE, GRANT, REVOKE, USE, AS OF SYSTEM TIME, SHOW TABLES, SHOW DATABASES, SHOW SCHEMAS, SHOW COLUMNS FROM,
    SHOW CREATE TABLE, SHOW INDEXES FROM, SHOW CONSTRAINTS FROM, SHOW RANGES, SHOW RANGES FROM TABLE, SHOW RANGES FROM INDEX,
    SHOW RANGE FROM TABLE, SHOW REGIONS, SHOW REGIONS FROM DATABASE, SHOW ZONE CONFIGURATIONS, SHOW ZONE CONFIGURATION FROM TABLE,
    SHOW JOBS, SHOW CHANGEFEED JOBS, SHOW SESSIONS, SHOW STATEMENTS, SHOW TRANSACTIONS, SHOW USERS, SHOW ROLES, SHOW GRANTS,
    SHOW STATISTICS FOR TABLE, SHOW CLUSTER SETTING, SHOW ALL CLUSTER SETTINGS, SET CLUSTER SETTING, CONFIGURE ZONE USING,
    ALTER RANGE, SPLIT AT, UNSPLIT AT, SCATTER, BACKUP INTO, RESTORE FROM, IMPORT INTO, EXPORT INTO, CANCEL JOB, PAUSE JOB,
    RESUME JOB, CANCEL QUERY, CANCEL SESSION, PRIMARY REGION, ADD REGION, SURVIVE REGION FAILURE, SURVIVE ZONE FAILURE,
    REGIONAL BY ROW, REGIONAL BY TABLE, LOCALITY GLOBAL, FAMILY, STORING, USING HASH, VISIBLE, NOT VISIBLE, PRIORITY HIGH`),
  functions: [
    'now()', 'current_timestamp()', 'current_date()', 'clock_timestamp()', 'statement_timestamp()', 'transaction_timestamp()',
    'date_trunc(field, source)', 'extract(field FROM source)', 'age(timestamp1[, timestamp2])', 'to_char(value, format)',
    'to_timestamp(text, format)', 'to_date(text, format)', 'make_date(year, month, day)', 'coalesce(value[, ...])', 'nullif(a, b)',
    'greatest(value[, ...])', 'least(value[, ...])', 'length(string)', 'lower(string)', 'upper(string)',
    'substring(string, start[, length])', 'strpos(string, substring)', 'replace(string, from, to)', 'split_part(string, delimiter, n)',
    'concat(value[, ...])', 'concat_ws(separator, value[, ...])', 'left(string, n)', 'right(string, n)', 'lpad(string, length[, fill])',
    'rpad(string, length[, fill])', 'trim(string)', 'btrim(string[, characters])', 'regexp_replace(string, pattern, replacement[, flags])',
    'regexp_extract(string, pattern)', 'string_agg(expr, delimiter)', 'array_agg(expr)', 'array_length(array, dimension)',
    'array_append(array, element)', 'array_cat(array1, array2)', 'array_position(array, element)', 'array_to_string(array, delimiter)',
    'string_to_array(string, delimiter)', 'unnest(array)', 'jsonb_agg(expr)', 'jsonb_object_agg(key, value)',
    'jsonb_build_object(key, value[, ...])', 'jsonb_build_array(value[, ...])', 'jsonb_extract_path(json, path[, ...])',
    'jsonb_extract_path_text(json, path[, ...])', 'jsonb_array_elements(json)', 'jsonb_each(json)', 'jsonb_set(json, path, value)',
    'jsonb_pretty(json)', 'to_jsonb(value)', 'gen_random_uuid()', 'unique_rowid()', 'unordered_unique_rowid()', 'random()',
    'round(number[, digits])', 'floor(number)', 'ceil(number)', 'abs(number)', 'mod(a, b)', 'power(a, b)', 'sqrt(number)',
    'count(expr)', 'sum(expr)', 'avg(expr)', 'min(expr)', 'max(expr)', 'bool_and(expr)', 'bool_or(expr)', 'stddev(expr)',
    'percentile_cont(fraction)', 'row_number()', 'rank()', 'dense_rank()', 'ntile(buckets)', 'lag(expr[, offset[, default]])',
    'lead(expr[, offset[, default]])', 'first_value(expr)', 'last_value(expr)', 'generate_series(start, stop[, step])',
    'follower_read_timestamp()', 'with_min_timestamp(timestamp)', 'with_max_staleness(interval)', 'cluster_logical_timestamp()',
    'crdb_internal.cluster_id()', 'crdb_internal.node_id()', 'crdb_internal.range_stats(range_id)', 'gateway_region()',
    'default_to_database_primary_region(region)', 'rehome_row()', 'sha256(string)', 'md5(string)', 'to_hex(number)', 'encode(bytes, format)',
    'decode(string, format)', 'pg_typeof(value)', 'current_user()', 'current_database()', 'version()',
  ].map((signature) => ({ name: signature.match(/^[\w.]+/)[0], signature })),
  dataTypes: list(`BOOL, INT2, INT4, INT8, INT, SERIAL, DECIMAL(p, s), FLOAT4, FLOAT8, STRING, VARCHAR(n), CHAR(n), TEXT, BYTES, DATE,
    TIME, TIMETZ, TIMESTAMP, TIMESTAMPTZ, INTERVAL, UUID, INET, JSONB, ARRAY, ENUM, BIT(n), VARBIT, GEOMETRY, GEOGRAPHY, OID,
    TSVECTOR, TSQUERY, VECTOR(n)`),
};
const union = (a = [], b = [], key = (x) => x) => [...new Map([...a, ...b].map((x) => [key(x), x])).values()];

module.exports = (lib) => {
  const { postgres } = require('./postgres')(lib).kinds;
  const pg = postgres.ui?.completion || {};
  const completion = {
    keywords: union(pg.keywords, OWN.keywords),
    functions: union(pg.functions, OWN.functions, (f) => f.signature),
    dataTypes: union(pg.dataTypes, OWN.dataTypes),
  };
  const ALL = { maxRows: Number.MAX_SAFE_INTEGER };

  async function openCockroach(cfg, opts) {
    const pg = await postgres.open({ ...cfg, user: cfg.user || 'root', database: cfg.database || 'defaultdb' }, opts);
    return {
      ...pg,
      async schema() {
        const { rows } = await pg.query(`
          SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable, k.column_name IS NOT NULL
          FROM information_schema.columns c
          JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          LEFT JOIN (SELECT ku.table_schema, ku.table_name, ku.column_name FROM information_schema.table_constraints tc
                     JOIN information_schema.key_column_usage ku ON ku.constraint_name = tc.constraint_name AND ku.table_schema = tc.table_schema AND ku.table_name = tc.table_name
                     WHERE tc.constraint_type = 'PRIMARY KEY') k
            ON k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name
          WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension') AND c.is_hidden = 'NO'
          ORDER BY c.table_schema, c.table_name, c.ordinal_position`, ALL);
        return lib.groupSchema(rows.map(([schema, table, type, column, dataType, nullable, pk]) => ({ schema, table, view: type === 'VIEW', column, type: dataType, nullable: nullable === 'YES', pk })));
      },
      async foreignKeys() {
        const { rows } = await pg.query(`
          SELECT ns.nspname AS s, cl.relname AS t, con.conname AS n, a.attname AS col, rns.nspname AS rs, rcl.relname AS rt, ra.attname AS rcol
          FROM pg_constraint con
          JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
          JOIN pg_class rcl ON rcl.oid = con.confrelid JOIN pg_namespace rns ON rns.oid = rcl.relnamespace
          CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, rcol, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
          JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rcol
          WHERE con.contype = 'f' AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY ns.nspname, cl.relname, con.conname, k.ord`, ALL);
        return lib.groupForeignKeys(rows.map(([schema, table, name, column, refSchema, refTable, refColumn]) => ({ schema, table, name, column, refSchema, refTable, refColumn })));
      },
      async version() {
        const v = (await pg.query('SELECT version()', ALL)).rows[0][0];
        return v.match(/^CockroachDB \S+ v[\w.-]+/)?.[0] || v;
      },
    };
  }

  return {
    kinds: {
      cockroachdb: { ...postgres, label: 'CockroachDB', order: 22, defaultPort: 26257, open: openCockroach, ui: { ...postgres.ui, completion } },
    },
  };
};
