// ClickHouse over HTTP(S) through the official @clickhouse/client package. See main/db/drivers.js for the kind module
// contract. Results are read as TabSeparatedWithNamesAndTypes and typed here: JSON formats would turn UInt64 into
// lossy numbers whenever the server does not quote 64-bit integers, and a read-only user cannot change that setting.

// One TSV cell to a JSON-safe value by its ClickHouse type. Exported for verify/database-sql.mjs.
const TSV_ESCAPES = { b: '\b', f: '\f', r: '\r', n: '\n', t: '\t', 0: '\0', "'": "'", '\\': '\\' };
function tsvValue(raw, type) {
  if (raw === '\\N') return null;
  const s = raw.replace(/\\(.)/g, (_m, c) => TSV_ESCAPES[c] ?? c);
  const base = type.replace(/^(?:LowCardinality\(|Nullable\()+/, '').replace(/\)+$/, '');
  if (/^U?Int\d+$/.test(base)) return Number.isSafeInteger(Number(s)) ? Number(s) : s;
  if (/^(Float\d+|BFloat16)$/.test(base)) return Number.isFinite(Number(s)) ? Number(s) : s;
  if (base === 'Bool') return s === 'true';
  if (/^DateTime(64)?\b/.test(base)) return s.replace(' ', 'T');
  return s;
}

// Console completion data (ui.completion): ClickHouse keywords, engines and formats, functions, and types.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const COMPLETION = {
  keywords: list(`SELECT, FROM, WHERE, PREWHERE, GROUP BY, WITH ROLLUP, WITH CUBE, WITH TOTALS, GROUPING SETS, HAVING, ORDER BY, ASC,
    DESC, NULLS FIRST, NULLS LAST, WITH FILL, LIMIT, LIMIT BY, OFFSET, DISTINCT, DISTINCT ON, AS, FINAL, SAMPLE, ARRAY JOIN,
    LEFT ARRAY JOIN, JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, ANY JOIN, ALL JOIN, ASOF JOIN, SEMI JOIN,
    ANTI JOIN, PASTE JOIN, GLOBAL JOIN, GLOBAL IN, ON, USING, UNION ALL, UNION DISTINCT, INTERSECT, EXCEPT, WITH, WINDOW, OVER,
    PARTITION BY, ROWS BETWEEN, QUALIFY, SETTINGS, FORMAT, INTO OUTFILE, INSERT INTO, VALUES, CREATE TABLE, CREATE DATABASE,
    CREATE VIEW, CREATE MATERIALIZED VIEW, CREATE DICTIONARY, CREATE FUNCTION, ENGINE, ON CLUSTER, PRIMARY KEY, TTL, CODEC,
    ALTER TABLE, ADD COLUMN, DROP COLUMN, MODIFY COLUMN, RENAME COLUMN, COMMENT COLUMN, ADD INDEX, UPDATE, DELETE, DELETE FROM,
    DETACH, ATTACH, OPTIMIZE TABLE, DEDUPLICATE, TRUNCATE TABLE, DROP TABLE, DROP DATABASE, RENAME TABLE, EXCHANGE TABLES,
    SHOW TABLES, SHOW DATABASES, SHOW CREATE TABLE, SHOW PROCESSLIST, DESCRIBE TABLE, EXPLAIN, EXPLAIN PIPELINE, EXISTS, KILL QUERY,
    SYSTEM, SYSTEM FLUSH LOGS, IF EXISTS, IF NOT EXISTS, AND, OR, NOT, IN, NOT IN, BETWEEN, LIKE, ILIKE, IS NULL, IS NOT NULL, CASE,
    WHEN, THEN, ELSE, END, INTERVAL, MergeTree, ReplacingMergeTree, SummingMergeTree, AggregatingMergeTree, CollapsingMergeTree,
    VersionedCollapsingMergeTree, ReplicatedMergeTree, Distributed, Memory, Log, TinyLog, Null, Buffer, Kafka, JSONEachRow,
    JSONCompact, CSV, CSVWithNames, TabSeparated, TabSeparatedWithNames, Parquet, Arrow, ORC, Native, Pretty, PrettyCompact, Vertical`),
  functions: [
    'toDate(expr)', 'toDate32(expr)', 'toDateTime(expr[, timezone])', 'toDateTime64(expr, precision[, timezone])',
    'toDateOrNull(expr)', 'toString(value)', 'toInt32(value)', 'toInt64(value)', 'toUInt32(value)', 'toUInt64(value)',
    'toFloat64(value)', 'toDecimal64(value, scale)', 'toTypeName(value)', 'toStartOfMinute(datetime)', 'toStartOfFiveMinutes(datetime)',
    'toStartOfHour(datetime)', 'toStartOfDay(datetime)', 'toStartOfWeek(date[, mode])', 'toStartOfMonth(date)', 'toStartOfQuarter(date)',
    'toStartOfYear(date)', 'toStartOfInterval(datetime, INTERVAL n unit)', 'toMonday(date)', 'toYear(date)', 'toMonth(date)',
    'toDayOfMonth(date)', 'toDayOfWeek(date)', 'toHour(datetime)', 'toMinute(datetime)', 'toYYYYMM(date)', 'toYYYYMMDD(date)',
    'toUnixTimestamp(datetime)', 'fromUnixTimestamp(seconds)', 'now()', 'now64([precision])', 'today()', 'yesterday()',
    'dateDiff(unit, start, end)', 'dateAdd(unit, value, date)', 'dateSub(unit, value, date)', 'dateTrunc(unit, datetime)',
    'formatDateTime(datetime, format[, timezone])', 'parseDateTimeBestEffort(string[, timezone])', 'count()', 'uniq(x[, ...])',
    'uniqExact(x[, ...])', 'uniqCombined(x[, ...])', 'uniqHLL12(x[, ...])', 'sum(x)', 'avg(x)', 'min(x)', 'max(x)', 'any(x)', 'anyLast(x)',
    'argMax(arg, value)', 'argMin(arg, value)', 'groupArray(x)', 'groupArray(max_size)(x)', 'groupUniqArray(x)', 'groupArraySample(n)(x)',
    'quantile(level)(x)', 'quantiles(level1, level2[, ...])(x)', 'quantileExact(level)(x)', 'median(x)', 'topK(n)(x)', 'countIf(condition)',
    'sumIf(x, condition)', 'avgIf(x, condition)', 'uniqIf(x, condition)', 'sumMap(keys, values)', 'histogram(bins)(x)',
    'stddevPop(x)', 'varPop(x)', 'corr(x, y)', 'arrayJoin(array)', 'arrayMap(func, array)', 'arrayFilter(func, array)',
    'arrayExists(func, array)', 'arrayAll(func, array)', 'arraySort([func,] array)', 'arrayReverseSort([func,] array)',
    'arrayDistinct(array)', 'arrayConcat(array1, array2[, ...])', 'arraySlice(array, offset[, length])', 'arrayReduce(agg_name, array)',
    'arrayEnumerate(array)', 'arrayFlatten(array)', 'arrayZip(array1, array2[, ...])', 'arrayStringConcat(array[, separator])',
    'has(array, element)', 'hasAny(array1, array2)', 'hasAll(array1, array2)', 'indexOf(array, element)', 'length(value)',
    'empty(value)', 'notEmpty(value)', 'range([start,] end[, step])', 'splitByChar(separator, string)',
    'splitByString(separator, string)', 'concat(value1, value2[, ...])', 'substring(string, offset[, length])', 'lower(string)',
    'upper(string)', 'trim(string)', 'trimBoth(string)', 'replaceAll(haystack, pattern, replacement)',
    'replaceRegexpAll(haystack, pattern, replacement)', 'match(haystack, pattern)', 'extract(haystack, pattern)',
    'extractAll(haystack, pattern)', 'position(haystack, needle)', 'positionCaseInsensitive(haystack, needle)', 'lengthUTF8(string)',
    'format(pattern, value[, ...])', 'leftPad(string, length[, pad])', 'base64Encode(string)', 'base64Decode(string)',
    'JSONExtractString(json, key[, ...])', 'JSONExtractInt(json, key[, ...])', 'JSONExtractFloat(json, key[, ...])',
    'JSONExtract(json, key[, ...], type)', 'JSONExtractKeys(json[, key])', 'JSONHas(json, key[, ...])', 'if(condition, then, else)',
    'multiIf(condition1, then1[, condition2, then2 ...], else)', 'ifNull(x, alternative)', 'coalesce(x[, ...])', 'nullIf(x, y)',
    'isNull(x)', 'isNotNull(x)', 'assumeNotNull(x)', 'cityHash64(value[, ...])', 'sipHash64(value[, ...])', 'xxHash64(value)',
    'MD5(string)', 'SHA256(string)', 'rand()', 'rand64()', 'generateUUIDv4()', 'round(x[, n])', 'floor(x[, n])', 'ceil(x[, n])',
    'intDiv(a, b)', 'modulo(a, b)', 'abs(x)', 'greatest(a, b)', 'least(a, b)', 'exp(x)', 'log(x)', 'sqrt(x)', 'pow(x, y)',
    'dictGet(dictionary, attribute, key)', 'dictGetOrDefault(dictionary, attribute, key, default)', 'row_number()', 'rank()',
    'dense_rank()', 'lagInFrame(x[, offset[, default]])', 'leadInFrame(x[, offset[, default]])', 'numbers(n)', 'numbers(start, count)',
    'file(path[, format[, structure]])', 'url(url, format[, structure])', 's3(path[, access_key, secret_key][, format[, structure]])',
    'remote(addresses, database, table)', 'generateRandom(structure)', 'input(structure)', 'currentDatabase()', 'version()',
    'hostName()', 'formatReadableSize(bytes)', 'formatReadableQuantity(number)', 'formatReadableTimeDelta(seconds)',
  ].map((signature) => ({ name: signature.match(/^\w+/)[0], signature })),
  dataTypes: list(`UInt8, UInt16, UInt32, UInt64, UInt128, UInt256, Int8, Int16, Int32, Int64, Int128, Int256, Float32, Float64,
    BFloat16, Decimal(P, S), Decimal32(S), Decimal64(S), Decimal128(S), Decimal256(S), Bool, String, FixedString(N), UUID, Date,
    Date32, DateTime, DateTime(timezone), DateTime64(precision[, timezone]), Time, Enum8, Enum16, LowCardinality(T), Nullable(T),
    Array(T), Tuple(T1[, ...]), Map(K, V), Nested, JSON, Dynamic, Variant(T1[, ...]), IPv4, IPv6, AggregateFunction(name, T),
    SimpleAggregateFunction(name, T), Point, Ring, Polygon, MultiPolygon, Interval`),
};

module.exports = ({ loadPackage, commandOf, DML, timed, groupSchema, NETWORK_FIELDS }) => {
  // Statements that answer with rows; everything else (DDL, INSERT, SET...) is sent as a command.
  const ROWS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'EXISTS', 'VALUES']);
  const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNABORTED']);

  const urlOf = (cfg) => (cfg.url ? cfg.url : `${cfg.https ? 'https' : 'http'}://${cfg.host || 'localhost'}:${cfg.port || (cfg.https ? 8443 : 8123)}`);

  async function openClickhouse(cfg, { onLost = () => {} } = {}) {
    const { createClient, ClickHouseLogLevel } = loadPackage('@clickhouse/client');
    const url = urlOf(cfg);
    const client = createClient({
      url, username: cfg.user || 'default', password: cfg.password || '', database: cfg.database || undefined,
      application: 'PyIDE', request_timeout: 300000, log: { level: ClickHouseLogLevel.OFF },
    });
    // HTTP has no connection to lose; a request that cannot reach the server marks the source as lost instead.
    const call = async (fn) => {
      try { return await fn(); } catch (err) {
        if (NETWORK.has(err.code) || /socket hang up/i.test(err.message)) {
          const lost = new Error(`Cannot reach ClickHouse at ${url}: ${err.message}`);
          onLost(lost);
          throw lost;
        }
        throw new Error(String(err.message || err).trim());
      }
    };
    const json = (query) => call(async () => (await client.query({ query, format: 'JSONEachRow' })).json());
    let version;
    try { version = (await json('SELECT version() AS v'))[0].v; } catch (err) { await client.close(); throw err; }

    async function run(sql, maxRows) {
      // The client appends its own FORMAT clause, after which a `;` would be a syntax error.
      const query = sql.replace(/(\s|;)+$/, '');
      const command = commandOf(query);
      if (!ROWS.has(command)) {
        const r = await call(() => client.command({ query }));
        return { columns: [], rows: [], rowCount: DML.has(command) ? Number(r.summary?.written_rows ?? 0) : null, truncated: false, command };
      }
      return call(async () => {
        const rs = await client.query({ query, format: 'TabSeparatedWithNamesAndTypes' });
        let names = null;
        let types = null;
        const rows = [];
        let truncated = false;
        read: for await (const batch of rs.stream()) {
          for (const row of batch) {
            const cells = row.text.split('\t');
            if (!names) names = cells;
            else if (!types) types = cells;
            else if (rows.length >= maxRows) { truncated = true; break read; }
            else rows.push(cells.map((c, i) => tsvValue(c, types[i])));
          }
        }
        if (truncated) rs.close();
        return { columns: (names || []).map((name, i) => ({ name, type: types?.[i] || '' })), rows, rowCount: rows.length, truncated, command };
      });
    }

    return {
      query: (sql, { maxRows }) => timed(() => run(sql, maxRows)),
      async schema() {
        const rows = await json(`
          SELECT c.database AS s, c.table AS t, t.engine AS e, c.name AS col, c.type AS ty, c.is_in_primary_key AS pk
          FROM system.columns AS c LEFT JOIN system.tables AS t ON t.database = c.database AND t.name = c.table
          WHERE c.database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
          ORDER BY c.database, c.table, c.position`);
        return groupSchema(rows.map((r) => ({
          schema: r.s, table: r.t, view: /View$/.test(r.e || ''), column: r.col, type: r.ty, nullable: /^(LowCardinality\()?Nullable\(/.test(r.ty), pk: !!Number(r.pk),
        })));
      },
      async version() { return `ClickHouse ${version}`; },
      close: () => client.close(),
    };
  }

  const [host, port, user, password, database] = NETWORK_FIELDS;
  return {
    packages: { '@clickhouse/client': '@clickhouse/client@1.24.0' },
    kinds: {
      clickhouse: {
        label: 'ClickHouse', order: 50, package: '@clickhouse/client', defaultPort: 8123, quote: '`', implicitSchemas: ['default'], open: openClickhouse,
        fields: [
          { key: 'url', label: 'URL (instead of host and port)', type: 'url', placeholder: 'https://example.clickhouse.cloud:8443' },
          host, port,
          { key: 'https', label: 'Use HTTPS', type: 'checkbox', default: false },
          user, password, database,
        ],
        ui: { completion: COMPLETION },
      },
    },
  };
};
module.exports.tsvValue = tsvValue;
