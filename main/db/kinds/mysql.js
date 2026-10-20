// MySQL and MariaDB through the mysql2 package. See main/db/drivers.js for the kind module contract.
module.exports = ({ loadPackage, jsonSafe, commandOf, DML, timed, groupSchema, NETWORK_FIELDS }) => {
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

  return {
    packages: { mysql2: 'mysql2@3' },
    kinds: {
      mysql: { label: 'MySQL', order: 30, package: 'mysql2', defaultPort: 3306, fields: NETWORK_FIELDS, quote: '`', implicitSchemas: [], open: openMysql },
      mariadb: { label: 'MariaDB', order: 31, package: 'mysql2', defaultPort: 3306, fields: NETWORK_FIELDS, quote: '`', implicitSchemas: [], open: openMysql },
    },
  };
};
