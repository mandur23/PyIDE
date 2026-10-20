// MySQL and MariaDB through the mysql2 package. See main/db/drivers.js for the kind module contract.
// Console completion data (ui.completion): MySQL and MariaDB keywords, built-in functions with their signatures, and types.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const COMPLETION = {
  keywords: list(`AUTO_INCREMENT, ON DUPLICATE KEY UPDATE, REPLACE INTO, INSERT IGNORE, SHOW DATABASES, SHOW TABLES, SHOW COLUMNS FROM, SHOW INDEX FROM,
    SHOW CREATE TABLE, SHOW PROCESSLIST, SHOW VARIABLES, DESCRIBE, USE, ENGINE, InnoDB, DEFAULT CHARSET, COLLATE, UNSIGNED, ZEROFILL, STRAIGHT_JOIN,
    LOCK TABLES, UNLOCK TABLES, EXPLAIN, EXPLAIN ANALYZE, CREATE DATABASE, DROP DATABASE, CREATE PROCEDURE, CREATE FUNCTION, CREATE TRIGGER,
    DELIMITER, CALL, IF NOT EXISTS, MODIFY COLUMN, CHANGE COLUMN, RENAME TABLE, REGEXP, RLIKE, SOUNDS LIKE, FOR UPDATE, WITH ROLLUP, PARTITION`),
  functions: [
    'NOW()', 'CURDATE()', 'CURTIME()', 'SYSDATE()', 'UTC_TIMESTAMP()', 'DATE(expr)', 'TIME(expr)', 'YEAR(date)', 'MONTH(date)', 'DAY(date)',
    'HOUR(time)', 'DATE_FORMAT(date, format)', 'DATE_ADD(date, INTERVAL expr unit)', 'DATE_SUB(date, INTERVAL expr unit)',
    'DATEDIFF(date1, date2)', 'TIMESTAMPDIFF(unit, datetime1, datetime2)', 'STR_TO_DATE(string, format)', 'UNIX_TIMESTAMP([date])',
    'FROM_UNIXTIME(timestamp[, format])', 'LAST_DAY(date)', 'CONCAT(str1, str2[, ...])', 'CONCAT_WS(separator, str1, str2[, ...])',
    'LENGTH(str)', 'CHAR_LENGTH(str)', 'LOWER(str)', 'UPPER(str)', 'SUBSTRING(str, pos[, len])', 'SUBSTRING_INDEX(str, delim, count)',
    'LEFT(str, len)', 'RIGHT(str, len)', 'LOCATE(substr, str[, pos])', 'INSTR(str, substr)', 'REPLACE(str, from_str, to_str)',
    'TRIM([{BOTH | LEADING | TRAILING} [remstr] FROM] str)', 'LPAD(str, len, padstr)', 'RPAD(str, len, padstr)',
    'REGEXP_REPLACE(expr, pattern, replacement)', 'FORMAT(x, decimals)', 'FIND_IN_SET(str, strlist)', 'IFNULL(expr1, expr2)',
    'IF(condition, then, else)', 'NULLIF(expr1, expr2)', 'COALESCE(value[, ...])', 'GREATEST(value1, value2[, ...])',
    'LEAST(value1, value2[, ...])', 'CAST(expr AS type)', 'CONVERT(expr, type)', 'ABS(x)', 'ROUND(x[, d])', 'CEIL(x)', 'FLOOR(x)',
    'TRUNCATE(x, d)', 'MOD(n, m)', 'POW(x, y)', 'RAND([seed])', 'COUNT(expr)', 'SUM(expr)', 'AVG(expr)', 'MIN(expr)', 'MAX(expr)',
    'GROUP_CONCAT(expr [ORDER BY ...] [SEPARATOR sep])', 'JSON_EXTRACT(json_doc, path[, ...])', 'JSON_UNQUOTE(json_val)',
    'JSON_OBJECT(key, val[, ...])', 'JSON_ARRAY(val[, ...])', 'JSON_SET(json_doc, path, val[, ...])',
    'JSON_CONTAINS(target, candidate[, path])', 'JSON_LENGTH(json_doc[, path])', 'JSON_ARRAYAGG(expr)', 'JSON_OBJECTAGG(key, value)',
    'LAST_INSERT_ID()', 'UUID()', 'DATABASE()', 'USER()', 'VERSION()', 'ROW_NUMBER()', 'RANK()', 'DENSE_RANK()',
    'LAG(expr[, n[, default]])', 'LEAD(expr[, n[, default]])',
  ].map((signature) => ({ name: signature.match(/^\w+/)[0], signature })),
  dataTypes: list('TINYINT, SMALLINT, MEDIUMINT, INT, BIGINT, DECIMAL, FLOAT, DOUBLE, BIT, BOOLEAN, CHAR, VARCHAR, BINARY, VARBINARY, TINYTEXT, TEXT, MEDIUMTEXT, LONGTEXT, BLOB, MEDIUMBLOB, LONGBLOB, ENUM, SET, DATE, TIME, DATETIME, TIMESTAMP, YEAR, JSON, GEOMETRY, POINT'),
};

module.exports = ({ loadPackage, jsonSafe, commandOf, DML, timed, groupSchema, NETWORK_FIELDS }) => {
  async function openMysql(cfg, { onLost = () => {} } = {}) {
    const mysql = loadPackage('mysql2', 'mysql2/promise');
    const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database || undefined,
      connectTimeout: 10000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    conn.on('error', onLost);
    conn.on('end', () => onLost(new Error('Connection closed')));
    return {
      // Rows stream in through the core connection's events: those past maxRows are read and dropped, so a large result
      // never sits whole in the main process. A CALL answers with several result sets; the last one with rows is shown.
      query: (sql, { maxRows }) => timed(() => new Promise((resolve, reject) => {
        const command = commandOf(sql);
        const sets = [];
        let failed = null;
        // A query without a callback hears nothing when the connection drops (the error goes to the connection).
        const core = conn.connection;
        const lost = (err) => { core.off('error', lost); core.off('end', lost); reject(err || new Error('Connection closed')); };
        core.once('error', lost);
        core.once('end', lost);
        const q = core.query({ sql, rowsAsArray: true });
        q.on('fields', (fields) => sets.push({ fields, rows: [], truncated: false, header: null }));
        q.on('result', (r) => {
          const set = sets[sets.length - 1];
          if (!set?.fields) { if (set) set.header = r; } else if (set.rows.length < maxRows) set.rows.push(r);
          else set.truncated = true;
        });
        q.on('error', (err) => { failed = err; });
        q.on('end', () => {
          core.off('error', lost);
          core.off('end', lost);
          if (failed) return reject(failed);
          const set = [...sets].reverse().find((s) => s.fields) || null;
          if (!set) {
            const header = sets[sets.length - 1]?.header;
            return resolve({ columns: [], rows: [], rowCount: DML.has(command) ? header?.affectedRows ?? null : null, truncated: false, command });
          }
          resolve({
            columns: set.fields.map((f) => ({ name: f.name, type: String(f.columnType ?? f.type ?? '') })),
            rows: set.rows.map((row) => row.map(jsonSafe)),
            rowCount: set.rows.length,
            truncated: set.truncated,
            command,
          });
        });
      })),
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
      mysql: { label: 'MySQL', order: 30, package: 'mysql2', defaultPort: 3306, fields: NETWORK_FIELDS, quote: '`', implicitSchemas: [], open: openMysql, ui: { completion: COMPLETION } },
      mariadb: { label: 'MariaDB', order: 31, package: 'mysql2', defaultPort: 3306, fields: NETWORK_FIELDS, quote: '`', implicitSchemas: [], open: openMysql, ui: { completion: COMPLETION } },
    },
  };
};
