// A stand-in for the `pg` package with two schemas, so verify/database-completion.mjs can check schema-qualified
// completions through the real PostgreSQL kind without a server. It answers the kind's tree and version queries.
const COLUMNS = [
  ['public', 'customers', 'id', 'integer', true], ['public', 'customers', 'name', 'text', false],
  ['public', 'products', 'id', 'integer', true], ['public', 'products', 'title', 'text', false],
  ['sales', 'invoices', 'id', 'integer', true], ['sales', 'invoices', 'customer_id', 'integer', false], ['sales', 'invoices', 'amount', 'numeric', false],
  ['sales', 'refunds', 'id', 'integer', true], ['sales', 'refunds', 'invoice_id', 'integer', false],
];

class Client {
  on() { return this; }
  async connect() {}
  async end() {}
  async query(q) {
    const text = typeof q === 'string' ? q : q.text;
    if (/version\(\)/.test(text)) return { rows: [{ v: 'PostgreSQL 16.0 (fake), compiled by hand' }] };
    if (/information_schema\.columns/.test(text)) {
      return { rows: COLUMNS.map(([s, t, c, type, pk]) => ({ table_schema: s, table_name: t, table_type: 'BASE TABLE', column_name: c, data_type: type, is_nullable: pk ? 'NO' : 'YES', pk })) };
    }
    return { command: 'SELECT', fields: [], rows: [] };
  }
}

module.exports = { Client };
