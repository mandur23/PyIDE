// Oracle Database through oracledb in Thin mode (pure JS, no Instant Client). See main/db/drivers.js for the kind
// module contract.

// Scripts follow SQL*Plus / SQL Developer: a SQL statement ends at `;` (which Oracle itself does not accept, so it is
// dropped), while a PL/SQL unit (an anonymous block, or CREATE PROCEDURE / FUNCTION / PACKAGE / TRIGGER / TYPE) keeps
// its inner semicolons and ends at a line holding only `/`, or at the end of the text. Strings (with q'[...]' quoting),
// "names" and comments are skipped. Returns [{text, line, plsql}], line being the 1-based line the statement starts on.
const PLSQL_START = /(?:DECLARE|BEGIN|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY))\b/iy;
const SLASH_LINE = /[ \t]*\/[ \t]*(?=\r?\n|$)/y;
const Q_CLOSE = { '[': ']', '{': '}', '(': ')', '<': '>' };
function splitOracleScript(text) {
  const out = [];
  let i = 0;
  let line = 1;
  const advance = (to) => { for (; i < to; i++) if (text[i] === '\n') line++; };
  const atLineStart = (k) => k === 0 || text[k - 1] === '\n';
  // End of a line holding only `/` that starts at k (or has only blanks before k), else 0.
  const slashLine = (k) => {
    if (text.slice(text.lastIndexOf('\n', k - 1) + 1, k).trim()) return 0;
    SLASH_LINE.lastIndex = k;
    return SLASH_LINE.exec(text) ? SLASH_LINE.lastIndex : 0;
  };
  // q'[...]' and nq'[...]', when the q does not end a longer name.
  const qQuoteAt = (k) => /q/i.test(text[k]) && text[k + 1] === "'" && !!text[k + 2]
    && (!/\w/.test(text[k - 1] || '') || (/n/i.test(text[k - 1]) && !/\w/.test(text[k - 2] || '')));
  while (i < text.length) {
    // Skip blanks, comments and stray `/` lines between statements.
    const gap = /(?:\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))+/y;
    gap.lastIndex = i;
    if (gap.exec(text)) { advance(gap.lastIndex); continue; }
    const slash = slashLine(i);
    if (slash) { advance(slash); continue; }
    PLSQL_START.lastIndex = i;
    const plsql = PLSQL_START.test(text);
    const start = i;
    const startLine = line;
    let end = text.length;
    let next = text.length;
    while (i < text.length) {
      const c = text[i];
      const slash = atLineStart(i) && i > start ? slashLine(i) : 0;
      if (slash) { end = i; next = slash; break; }
      if (c === '-' && text[i + 1] === '-') { const nl = text.indexOf('\n', i); advance(nl < 0 ? text.length : nl); continue; }
      if (c === '/' && text[i + 1] === '*') { const close = text.indexOf('*/', i + 2); advance(close < 0 ? text.length : close + 2); continue; }
      if (qQuoteAt(i)) {
        const close = `${Q_CLOSE[text[i + 2]] || text[i + 2]}'`;
        const k = text.indexOf(close, i + 3);
        advance(k < 0 ? text.length : k + 2);
        continue;
      }
      if (c === "'" || c === '"') {
        let k = i + 1;
        for (; k < text.length; k++) {
          if (text[k] === c) { if (text[k + 1] === c) k++; else break; }
        }
        advance(Math.min(k + 1, text.length));
        continue;
      }
      if (c === ';' && !plsql) { end = i; next = i + 1; break; }
      advance(i + 1);
    }
    const body = text.slice(start, end).trim();
    if (body) out.push({ text: body, line: startLine, plsql });
    advance(next);
  }
  return out;
}

module.exports = ({ loadPackage, jsonSafe, commandOf, DML, timed, groupSchema }) => {
  // NUMBER comes as text so big or precise values survive; it becomes a JS number only when that is exact.
  const numberOf = (s) => {
    if (s === null || s === undefined) return null;
    const n = Number(s);
    return Number.isFinite(n) && String(n) === s ? n : s;
  };

  // Codes for a connection that is gone (network down, server stopped, session killed).
  const LOST = /^(NJS-500|NJS-521|ORA-03113|ORA-03114|ORA-03135|ORA-00028|DPI-1010|DPI-1080)\b/;
  const readable = (err, prefix = '') => new Error(`${prefix}${String(err.message || err).replace(/\s*\(CONNECTION_ID=[^)]*\)/, '').trim()}`);

  async function openOracle(cfg, { onLost = () => {} } = {}) {
    const oracledb = loadPackage('oracledb');
    const host = cfg.host || 'localhost';
    const port = cfg.port || 1521;
    const target = cfg.service || (cfg.connectBy === 'sid' ? 'XE' : 'FREEPDB1');
    const connectString = cfg.connectBy === 'sid'
      ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${target})))`
      : `${host}:${port}/${target}`;
    let conn;
    try {
      conn = await oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString, connectTimeout: 10 });
    } catch (err) { throw readable(err); }

    const fetchTypeHandler = (meta) => {
      if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING, converter: numberOf };
      if (meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
      if (meta.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
      return undefined;
    };

    async function execute(stmt, maxRows) {
      // A PL/SQL unit keeps its final `END;`; plain SQL must not end with `;`.
      const r = await conn.execute(stmt.text, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: maxRows + 1, autoCommit: true, fetchTypeHandler });
      // CREATE PROCEDURE with errors still creates the (invalid) unit; say so instead of reporting success.
      if (r.warning) throw r.warning;
      return r;
    }

    async function run(text, maxRows) {
      const statements = splitOracleScript(text);
      let last = null;
      let stmt = null;
      for (stmt of statements) {
        try {
          last = await execute(stmt, maxRows);
        } catch (err) {
          if (LOST.test(err.message || '')) onLost(err);
          throw readable(err, statements.length > 1 ? `Line ${stmt.line}: ` : '');
        }
      }
      const command = commandOf(stmt?.text || '');
      if (!last?.metaData) return { columns: [], rows: [], rowCount: DML.has(command) ? last?.rowsAffected ?? 0 : null, truncated: false, command };
      const rows = last.rows.slice(0, maxRows);
      return {
        columns: last.metaData.map((m) => ({ name: m.name, type: m.dbTypeName || '' })),
        rows: rows.map((row) => row.map(jsonSafe)),
        rowCount: rows.length,
        truncated: last.rows.length > maxRows,
        command,
      };
    }

    const typeName = (r) => {
      if (r.DATA_TYPE === 'NUMBER' && r.DATA_PRECISION != null) return `NUMBER(${r.DATA_PRECISION}${r.DATA_SCALE ? `,${r.DATA_SCALE}` : ''})`;
      if (/CHAR|RAW/.test(r.DATA_TYPE)) return `${r.DATA_TYPE}(${r.CHAR_LENGTH || r.DATA_LENGTH})`;
      return r.DATA_TYPE;
    };

    return {
      query: (text, { maxRows }) => timed(() => run(text, maxRows)),
      async schema() {
        // The user's own schema, or every schema they can see that Oracle does not maintain itself.
        const owners = cfg.allSchemas ? "c.OWNER IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N')" : 'c.OWNER = USER';
        const r = await conn.execute(`
          SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.CHAR_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE,
                 CASE WHEN v.VIEW_NAME IS NULL THEN 0 ELSE 1 END IS_VIEW, CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END IS_PK
          FROM ALL_TAB_COLUMNS c
          LEFT JOIN ALL_VIEWS v ON v.OWNER = c.OWNER AND v.VIEW_NAME = c.TABLE_NAME
          LEFT JOIN (SELECT cc.OWNER, cc.TABLE_NAME, cc.COLUMN_NAME FROM ALL_CONSTRAINTS k
                     JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = k.OWNER AND cc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                     WHERE k.CONSTRAINT_TYPE = 'P') pk
            ON pk.OWNER = c.OWNER AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
          WHERE ${owners} AND c.TABLE_NAME NOT LIKE 'BIN$%'
          ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler });
        return groupSchema(r.rows.map((x) => ({ schema: x.OWNER, table: x.TABLE_NAME, view: !!x.IS_VIEW, column: x.COLUMN_NAME, type: typeName(x), nullable: x.NULLABLE === 'Y', pk: !!x.IS_PK })));
      },
      async version() { return `Oracle Database ${conn.oracleServerVersionString}`; },
      close: () => conn.close(),
    };
  }

  const OPEN = 'SELECT * FROM {qualified} FETCH FIRST 200 ROWS ONLY;';
  return {
    packages: { oracledb: 'oracledb@7.0.1' },
    kinds: {
      oracle: {
        label: 'Oracle', order: 45, package: 'oracledb', defaultPort: 1521, quote: '"', implicitSchemas: [], open: openOracle,
        fields: [
          'host', 'port', 'user', 'password',
          { key: 'connectBy', label: 'Connect by', type: 'select', options: [['service', 'Service name'], ['sid', 'SID']], default: 'service' },
          { key: 'service', label: 'Service name or SID', placeholder: 'FREEPDB1' },
          { key: 'allSchemas', label: 'Show all accessible schemas', type: 'checkbox', default: false },
        ],
        ui: { statementSeparator: 'plsql', openData: { table: OPEN, view: OPEN } },
      },
    },
  };
};
module.exports.splitOracleScript = splitOracleScript;
