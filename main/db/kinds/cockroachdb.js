// CockroachDB speaks the PostgreSQL wire protocol, so it reuses the postgres kind and its pg driver; only the tree
// (no crdb_internal / pg_extension, no hidden rowid) and the version text differ. See main/db/drivers.js for the
// kind module contract.
module.exports = (lib) => {
  const { postgres } = require('./postgres')(lib).kinds;
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
      async version() {
        const v = (await pg.query('SELECT version()', ALL)).rows[0][0];
        return v.match(/^CockroachDB \S+ v[\w.-]+/)?.[0] || v;
      },
    };
  }

  return {
    kinds: {
      cockroachdb: { ...postgres, label: 'CockroachDB', order: 22, defaultPort: 26257, open: openCockroach },
    },
  };
};
