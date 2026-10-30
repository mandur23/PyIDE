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

// Console completion data (ui.completion): Oracle SQL and PL/SQL keywords, built-in functions, and types.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const COMPLETION = {
  keywords: list(`SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, ASC, DESC, NULLS FIRST, NULLS LAST, DISTINCT, UNIQUE, AS, JOIN,
    INNER JOIN, LEFT OUTER JOIN, RIGHT OUTER JOIN, FULL OUTER JOIN, CROSS JOIN, NATURAL JOIN, CROSS APPLY, OUTER APPLY, LATERAL, ON,
    USING, UNION, UNION ALL, INTERSECT, MINUS, INSERT INTO, INSERT ALL, INSERT FIRST, VALUES, RETURNING, UPDATE, SET, DELETE FROM,
    MERGE INTO, WHEN MATCHED THEN, WHEN NOT MATCHED THEN, ROWNUM, ROWID, LEVEL, CONNECT BY, START WITH, PRIOR, NOCYCLE,
    CONNECT_BY_ROOT, CONNECT_BY_ISLEAF, ORDER SIBLINGS BY, FETCH FIRST, FETCH NEXT, ROWS ONLY, OFFSET, WITH TIES, DUAL,
    CREATE TABLE, CREATE GLOBAL TEMPORARY TABLE, CREATE OR REPLACE VIEW, CREATE MATERIALIZED VIEW, CREATE INDEX, CREATE UNIQUE INDEX,
    CREATE SEQUENCE, CREATE SYNONYM, CREATE OR REPLACE PROCEDURE, CREATE OR REPLACE FUNCTION, CREATE OR REPLACE PACKAGE,
    CREATE OR REPLACE PACKAGE BODY, CREATE OR REPLACE TRIGGER, CREATE OR REPLACE TYPE, ALTER TABLE, ADD, MODIFY, DROP COLUMN,
    RENAME COLUMN, RENAME TO, DROP TABLE, DROP VIEW, DROP SEQUENCE, DROP PROCEDURE, PURGE, CASCADE CONSTRAINTS, TRUNCATE TABLE,
    PRIMARY KEY, FOREIGN KEY, REFERENCES, ON DELETE CASCADE, CHECK, DEFAULT, CONSTRAINT, GENERATED ALWAYS AS IDENTITY, NOT NULL,
    NULL, IS NULL, IS NOT NULL, AND, OR, NOT, IN, EXISTS, BETWEEN, LIKE, ESCAPE, CASE, WHEN, THEN, ELSE, END, WITH, OVER,
    PARTITION BY, ROWS BETWEEN, RANGE BETWEEN, UNBOUNDED PRECEDING, UNBOUNDED FOLLOWING, CURRENT ROW, KEEP, DENSE_RANK FIRST,
    WITHIN GROUP, PIVOT, UNPIVOT, MODEL, MATCH_RECOGNIZE, DECLARE, BEGIN, EXCEPTION, WHEN OTHERS THEN, RAISE,
    RAISE_APPLICATION_ERROR, RETURN, RETURNING INTO, IS, LOOP, END LOOP, FOR, IN REVERSE, WHILE, EXIT, EXIT WHEN, CONTINUE, IF,
    ELSIF, END IF, CURSOR, OPEN, FETCH, INTO, CLOSE, BULK COLLECT INTO, FORALL, EXECUTE IMMEDIATE, PRAGMA AUTONOMOUS_TRANSACTION,
    %TYPE, %ROWTYPE, NEXTVAL, CURRVAL, COMMIT, ROLLBACK, SAVEPOINT, ROLLBACK TO, GRANT, REVOKE, FOR UPDATE, FOR UPDATE OF, NOWAIT,
    SKIP LOCKED, AS OF TIMESTAMP, AS OF SCN, VERSIONS BETWEEN, SAMPLE, PARALLEL, ANALYZE, EXPLAIN PLAN FOR, COMMENT ON`),
  functions: [
    'NVL(expr1, expr2)', 'NVL2(expr, value_if_not_null, value_if_null)',
    'DECODE(expr, search, result[, search, result ...][, default])', 'COALESCE(expr1, expr2[, ...])', 'NULLIF(expr1, expr2)',
    'TO_CHAR(value[, format[, nls_params]])', 'TO_DATE(string[, format[, nls_params]])', 'TO_NUMBER(string[, format[, nls_params]])',
    'TO_TIMESTAMP(string[, format[, nls_params]])', 'TO_TIMESTAMP_TZ(string[, format[, nls_params]])', 'TO_CLOB(value)',
    'TO_BLOB(raw)', 'CAST(expr AS type)', 'SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'LOCALTIMESTAMP',
    'ADD_MONTHS(date, months)', 'MONTHS_BETWEEN(date1, date2)', 'LAST_DAY(date)', 'NEXT_DAY(date, weekday)',
    'TRUNC(date_or_number[, format_or_places])', 'ROUND(date_or_number[, format_or_places])', 'EXTRACT(part FROM datetime)',
    'NUMTODSINTERVAL(number, unit)', 'NUMTOYMINTERVAL(number, unit)', 'FROM_TZ(timestamp, time_zone)',
    'SUBSTR(string, position[, length])', 'INSTR(string, substring[, position[, occurrence]])', 'LENGTH(string)',
    'LENGTHB(string)', 'UPPER(string)', 'LOWER(string)', 'INITCAP(string)', 'LPAD(string, length[, pad])', 'RPAD(string, length[, pad])',
    'TRIM([LEADING | TRAILING | BOTH] [chars FROM] string)', 'LTRIM(string[, set])', 'RTRIM(string[, set])',
    'REPLACE(string, search[, replacement])', 'TRANSLATE(string, from_chars, to_chars)', 'CONCAT(string1, string2)', 'CHR(code)',
    'ASCII(character)', 'SOUNDEX(string)', 'REGEXP_LIKE(string, pattern[, flags])',
    'REGEXP_SUBSTR(string, pattern[, position[, occurrence[, flags[, group]]]])',
    'REGEXP_REPLACE(string, pattern[, replacement[, position[, occurrence[, flags]]]])',
    'REGEXP_INSTR(string, pattern[, position[, occurrence[, return_option[, flags]]]])', 'REGEXP_COUNT(string, pattern[, position[, flags]])',
    'LISTAGG(expr[, delimiter])', 'COUNT(expr)', 'SUM(expr)', 'AVG(expr)', 'MIN(expr)', 'MAX(expr)', 'MEDIAN(expr)', 'STDDEV(expr)',
    'VARIANCE(expr)', 'APPROX_COUNT_DISTINCT(expr)', 'COLLECT(expr)', 'ROW_NUMBER()', 'RANK()', 'DENSE_RANK()', 'NTILE(buckets)',
    'LAG(expr[, offset[, default]])', 'LEAD(expr[, offset[, default]])', 'FIRST_VALUE(expr)', 'LAST_VALUE(expr)',
    'RATIO_TO_REPORT(expr)', 'PERCENT_RANK()', 'CUME_DIST()', 'PERCENTILE_CONT(fraction)', 'ABS(number)', 'CEIL(number)',
    'FLOOR(number)', 'MOD(number, divisor)', 'REMAINDER(number, divisor)', 'POWER(number, exponent)', 'SQRT(number)', 'EXP(number)',
    'LN(number)', 'LOG(base, number)', 'SIGN(number)', 'GREATEST(expr1, expr2[, ...])', 'LEAST(expr1, expr2[, ...])', 'SYS_GUID()',
    'USER', 'UID', 'SYS_CONTEXT(namespace, parameter)', 'USERENV(parameter)', 'SYS_CONNECT_BY_PATH(column, separator)',
    'RAWTOHEX(raw)', 'HEXTORAW(string)', 'ORA_HASH(expr[, max_bucket[, seed]])', 'STANDARD_HASH(expr[, method])', 'EMPTY_CLOB()',
    'EMPTY_BLOB()', 'JSON_VALUE(expr, path)', 'JSON_QUERY(expr, path)', 'JSON_EXISTS(expr, path)', 'JSON_TABLE(expr, path COLUMNS (...))',
    'JSON_OBJECT(key VALUE expr[, ...])', 'JSON_ARRAY(expr[, ...])', 'JSON_ARRAYAGG(expr)', 'JSON_OBJECTAGG(key VALUE expr)',
    'XMLAGG(xml_expr)', 'XMLELEMENT(NAME name, expr)', 'DBMS_OUTPUT.PUT_LINE(text)', 'DBMS_RANDOM.VALUE([low, high])',
    'DBMS_LOB.SUBSTR(lob[, amount[, offset]])', 'DBMS_LOB.GETLENGTH(lob)', 'DBMS_METADATA.GET_DDL(object_type, name[, schema])',
    'DBMS_STATS.GATHER_TABLE_STATS(owner, table)', 'DBMS_XPLAN.DISPLAY()', 'DBMS_SESSION.SLEEP(seconds)',
  ].map((signature) => ({ name: signature.match(/^[\w.]+/)[0], signature })),
  dataTypes: list(`VARCHAR2(n), NVARCHAR2(n), CHAR(n), NCHAR(n), NUMBER, NUMBER(p, s), INTEGER, FLOAT, BINARY_FLOAT, BINARY_DOUBLE,
    DATE, TIMESTAMP, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH LOCAL TIME ZONE, INTERVAL YEAR TO MONTH, INTERVAL DAY TO SECOND, CLOB,
    NCLOB, BLOB, BFILE, RAW(n), LONG, ROWID, UROWID, XMLTYPE, JSON, BOOLEAN, VECTOR, PLS_INTEGER, BINARY_INTEGER, SYS_REFCURSOR`),
};

module.exports = ({ loadPackage, jsonSafe, commandOf, DML, timed, groupSchema, groupForeignKeys, exportError }) => {
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
    const connect = async () => {
      try {
        return await oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString, connectTimeout: 10 });
      } catch (err) { throw readable(err); }
    };
    const conn = await connect();

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
      async foreignKeys() {
        const owners = cfg.allSchemas ? "a.OWNER IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N')" : 'a.OWNER = USER';
        const r = await conn.execute(`
          SELECT a.OWNER, a.TABLE_NAME, a.CONSTRAINT_NAME, ac.COLUMN_NAME, p.OWNER R_OWNER, p.TABLE_NAME R_TABLE, pc.COLUMN_NAME R_COLUMN
          FROM ALL_CONSTRAINTS a
          JOIN ALL_CONS_COLUMNS ac ON ac.OWNER = a.OWNER AND ac.CONSTRAINT_NAME = a.CONSTRAINT_NAME
          JOIN ALL_CONSTRAINTS p ON p.OWNER = a.R_OWNER AND p.CONSTRAINT_NAME = a.R_CONSTRAINT_NAME
          JOIN ALL_CONS_COLUMNS pc ON pc.OWNER = p.OWNER AND pc.CONSTRAINT_NAME = p.CONSTRAINT_NAME AND pc.POSITION = ac.POSITION
          WHERE a.CONSTRAINT_TYPE = 'R' AND ${owners}
          ORDER BY a.OWNER, a.TABLE_NAME, a.CONSTRAINT_NAME, ac.POSITION`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        return groupForeignKeys(r.rows.map((x) => ({ schema: x.OWNER, table: x.TABLE_NAME, name: x.CONSTRAINT_NAME, column: x.COLUMN_NAME, refSchema: x.R_OWNER, refTable: x.R_TABLE, refColumn: x.R_COLUMN })));
      },
      async version() { return `Oracle Database ${conn.oracleServerVersionString}`; },
      // Export Data: a result set (getRows(n)) on a connection of its own, so the console stays usable. NUMBER keeps
      // Oracle's digits ({$number}), BLOB and RAW their bytes. readOnly makes it a read-only transaction (SET
      // TRANSACTION READ ONLY), rolled back at the end.
      async cursor(sql, { readOnly = false } = {}) {
        const text = splitOracleScript(sql)[0]?.text || sql.trim();
        const own = await connect();
        const exactTypes = (meta) => {
          if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING, converter: (s) => (s === null || s === undefined ? null : { $number: s }) };
          return fetchTypeHandler(meta);
        };
        let rs = null;
        let closed = false;
        try {
          if (readOnly) await own.execute('SET TRANSACTION READ ONLY');
          const r = await own.execute(text, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, resultSet: true, autoCommit: !readOnly, fetchTypeHandler: exactTypes });
          rs = r.resultSet;
          if (!rs || !r.metaData) throw exportError('NO_ROWS');
          let done = false;
          return {
            columns: r.metaData.map((m) => ({ name: m.name, type: m.dbTypeName || '' })),
            async next(n) {
              if (done) return null;
              const rows = await rs.getRows(n);
              if (rows.length < n) done = true;
              return rows.length ? rows : null;
            },
            async close() {
              if (closed) return;
              closed = true;
              // Closed early (Cancel), a fetch may still be running: break it off first.
              if (!done) await own.break().catch(() => {});
              try { await rs.close(); } catch {}
              if (readOnly) await own.rollback().catch(() => {});
              await own.close().catch(() => {});
            },
          };
        } catch (err) {
          try { await rs?.close(); } catch {}
          own.close().catch(() => {});
          throw err.exportCode ? err : readable(err);
        }
      },
      close: () => conn.close(),
    };
  }

  const OPEN = 'SELECT * FROM {qualified} FETCH FIRST 200 ROWS ONLY;';
  return {
    packages: { oracledb: 'oracledb@7.0.1' },
    kinds: {
      oracle: {
        label: 'Oracle', order: 45, package: 'oracledb', defaultPort: 1521, quote: '"', sqlDialect: 'oracle', implicitSchemas: [], open: openOracle,
        fields: [
          'host', 'port', 'user', 'password',
          { key: 'connectBy', label: 'Connect by', type: 'select', options: [['service', 'Service name'], ['sid', 'SID']], default: 'service' },
          { key: 'service', label: 'Service name or SID', placeholder: 'FREEPDB1' },
          { key: 'allSchemas', label: 'Show all accessible schemas', type: 'checkbox', default: false },
        ],
        ui: { statementSeparator: 'plsql', openData: { table: OPEN, view: OPEN }, completion: COMPLETION },
      },
    },
  };
};
module.exports.splitOracleScript = splitOracleScript;
