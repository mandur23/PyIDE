// SQLite, built in through Electron's node:sqlite. See main/db/drivers.js for the kind module contract.
module.exports = ({ jsonSafe, commandOf, DML, timed }) => {
  function openSqlite(cfg) {
    const { DatabaseSync } = require('node:sqlite');
    if (!cfg.file) throw new Error('No database file is set');
    const db = new DatabaseSync(cfg.file);
    return {
      query: (sql, { maxRows }) => timed(() => {
        const stmt = db.prepare(sql);
        const command = commandOf(sql);
        const cols = stmt.columns();
        if (!cols.length) {
          const r = stmt.run();
          return { columns: [], rows: [], rowCount: DML.has(command) ? Number(r.changes) : null, truncated: false, command };
        }
        stmt.setReadBigInts(true);
        stmt.setReturnArrays(true);
        const rows = [];
        let truncated = false;
        for (const row of stmt.iterate()) {
          if (rows.length >= maxRows) { truncated = true; break; }
          rows.push(row.map(jsonSafe));
        }
        return { columns: cols.map((c) => ({ name: c.name, type: c.type || '' })), rows, rowCount: rows.length, truncated, command };
      }),
      async schema() {
        const tables = db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        return [{
          name: 'main',
          kind: 'schema',
          children: tables.map((t) => ({
            name: t.name,
            kind: t.type,
            columns: db.prepare(`PRAGMA table_xinfo("${t.name.replace(/"/g, '""')}")`).all()
              .filter((c) => !c.hidden).map((c) => ({ name: c.name, type: c.type, pk: c.pk > 0, nullable: !c.notnull })),
          })),
        }];
      },
      async version() { return `SQLite ${db.prepare('SELECT sqlite_version() AS v').get().v}`; },
      close: () => db.close(),
    };
  }

  return {
    kinds: {
      sqlite: { label: 'SQLite', order: 10, builtin: true, fields: ['file'], quote: '"', implicitSchemas: ['main'], open: openSqlite },
    },
  };
};
