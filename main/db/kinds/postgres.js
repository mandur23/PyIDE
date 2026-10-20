// PostgreSQL through the pg package. See main/db/drivers.js for the kind module contract.
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
      postgres: { label: 'PostgreSQL', order: 20, package: 'pg', defaultPort: 5432, fields: NETWORK_FIELDS, quote: '"', implicitSchemas: ['public'], open: openPostgres },
    },
  };
};
