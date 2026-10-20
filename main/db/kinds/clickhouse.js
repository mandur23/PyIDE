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
      },
    },
  };
};
module.exports.tsvValue = tsvValue;
