// Microsoft SQL Server through the mssql package (tedious, pure JS). See main/db/drivers.js for the kind module contract.
// Identifiers are quoted with double quotes, not brackets: the renderer quotes with one character on both sides, and
// tedious opens every connection with QUOTED_IDENTIFIER ON, so "name" is an identifier there as in standard SQL.

// T-SQL scripts: a line holding only GO (optionally `GO 3` and a trailing -- comment) ends a batch, as in sqlcmd and
// SSMS. GO inside a string, a [bracketed] or "quoted" name, or a /* comment */ (which nests in T-SQL) is text.
// Returns [{text, line, repeat}], line being the 1-based line the batch starts on; blank batches are dropped.
const GO_LINE = /[ \t]*GO(?:[ \t]+(\d+))?[ \t]*(?:--[^\n]*)?(?=\r?\n|$)/iy;
function splitGoBatches(text) {
  const batches = [];
  let start = 0;
  let startLine = 1;
  let line = 1;
  let depth = 0; // block comment nesting
  let quote = null; // ', " or ]
  const push = (end, repeat) => {
    const body = text.slice(start, end);
    if (body.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) {
      const lead = body.match(/^\s*/)[0];
      batches.push({ text: body.trim(), line: startLine + (lead.match(/\n/g) || []).length, repeat });
    }
  };
  for (let i = 0; i <= text.length; i++) {
    const atLineStart = i === 0 || text[i - 1] === '\n';
    if (atLineStart && !depth && !quote) {
      GO_LINE.lastIndex = i;
      const m = GO_LINE.exec(text);
      if (m) {
        push(i, m[1] ? Math.max(1, Number(m[1])) : 1);
        i += m[0].length;
        if (text[i] === '\r') i++;
        start = i + 1;
        line++;
        startLine = line;
        continue;
      }
    }
    if (i === text.length) break;
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') line++;
    if (quote) {
      if (c === quote) {
        if (next === quote) i++;
        else quote = null;
      }
    } else if (depth) {
      if (c === '/' && next === '*') { depth++; i++; } else if (c === '*' && next === '/') { depth--; i++; }
    } else if (c === '/' && next === '*') { depth = 1; i++; } else if (c === '-' && next === '-') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '[') quote = ']';
  }
  push(text.length, 1);
  return batches;
}

// Console completion data (ui.completion): T-SQL keywords, built-in functions with their signatures, and types.
const list = (s) => s.split(/\s*,\s*/).filter(Boolean);
const COMPLETION = {
  keywords: list(`SELECT, TOP, PERCENT, WITH TIES, DISTINCT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, ASC, DESC, OFFSET, FETCH NEXT,
    ROWS ONLY, AS, JOIN, INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN, CROSS APPLY, OUTER APPLY, ON, UNION, UNION ALL,
    INTERSECT, EXCEPT, INSERT INTO, VALUES, OUTPUT, INSERTED, DELETED, UPDATE, SET, DELETE, MERGE, USING, WHEN MATCHED,
    WHEN NOT MATCHED, WHEN NOT MATCHED BY SOURCE, THEN, CREATE TABLE, CREATE VIEW, CREATE INDEX, CREATE UNIQUE INDEX,
    CREATE PROCEDURE, CREATE FUNCTION, CREATE TRIGGER, CREATE SCHEMA, CREATE OR ALTER, ALTER TABLE, ALTER PROCEDURE, ALTER VIEW,
    ADD, ALTER COLUMN, DROP TABLE, DROP VIEW, DROP PROCEDURE, DROP FUNCTION, DROP INDEX, IF EXISTS, TRUNCATE TABLE, PRIMARY KEY,
    FOREIGN KEY, REFERENCES, UNIQUE, CHECK, DEFAULT, IDENTITY, CONSTRAINT, CLUSTERED, NONCLUSTERED, NOT NULL, NULL, IS NULL,
    IS NOT NULL, AND, OR, NOT, IN, EXISTS, BETWEEN, LIKE, ESCAPE, CASE, WHEN, ELSE, END, WITH, OVER, PARTITION BY, ROWS BETWEEN,
    UNBOUNDED PRECEDING, CURRENT ROW, PIVOT, UNPIVOT, DECLARE, BEGIN, IF, WHILE, BREAK, CONTINUE, RETURN, RETURNS, EXEC, EXECUTE,
    PRINT, RAISERROR, THROW, BEGIN TRY, END TRY, BEGIN CATCH, END CATCH, BEGIN TRANSACTION, COMMIT, COMMIT TRANSACTION, ROLLBACK,
    ROLLBACK TRANSACTION, SAVE TRANSACTION, GO, USE, SET NOCOUNT ON, SET XACT_ABORT ON, NOLOCK, READPAST, UPDLOCK, HOLDLOCK,
    COLLATE, GRANT, REVOKE, DENY, INTO, FOR JSON PATH, FOR JSON AUTO, FOR XML PATH, WITHIN GROUP, CURSOR, FETCH, OPEN, CLOSE,
    DEALLOCATE, WAITFOR DELAY, TABLESAMPLE, OPTION, RECOMPILE, MAXDOP, SCHEMABINDING, NOCHECK, CASCADE, SEQUENCE,
    NEXT VALUE FOR, SYNONYM, TEMPORAL, SYSTEM_VERSIONING, FOR SYSTEM_TIME AS OF`),
  functions: list(`GETDATE(), GETUTCDATE(), SYSDATETIME(), SYSUTCDATETIME(), SYSDATETIMEOFFSET(), CURRENT_TIMESTAMP`)
    .concat([
      'DATEADD(datepart, number, date)', 'DATEDIFF(datepart, startdate, enddate)', 'DATEDIFF_BIG(datepart, startdate, enddate)',
      'DATEPART(datepart, date)', 'DATENAME(datepart, date)', 'DATETRUNC(datepart, date)', 'DATEFROMPARTS(year, month, day)',
      'DATETIMEFROMPARTS(year, month, day, hour, minute, seconds, milliseconds)', 'EOMONTH(start_date[, month_to_add])',
      'YEAR(date)', 'MONTH(date)', 'DAY(date)', 'ISDATE(expression)', 'SWITCHOFFSET(datetimeoffset, timezone)',
      'TODATETIMEOFFSET(datetime, timezone)', 'FORMAT(value, format[, culture])', 'CONVERT(data_type, expression[, style])',
      'CAST(expression AS data_type)', 'TRY_CAST(expression AS data_type)', 'TRY_CONVERT(data_type, expression[, style])',
      'PARSE(string AS data_type[ USING culture])', 'TRY_PARSE(string AS data_type[ USING culture])',
      'ISNULL(check_expression, replacement_value)', 'COALESCE(expression1, expression2[, ...])', 'NULLIF(expression1, expression2)',
      'IIF(condition, true_value, false_value)', 'CHOOSE(index, value1, value2[, ...])', 'GREATEST(expression1, expression2[, ...])',
      'LEAST(expression1, expression2[, ...])', 'LEN(string)', 'DATALENGTH(expression)', 'LEFT(string, count)', 'RIGHT(string, count)',
      'SUBSTRING(string, start, length)', 'CHARINDEX(substring, string[, start])', 'PATINDEX(pattern, string)',
      'REPLACE(string, pattern, replacement)', 'REPLICATE(string, count)', 'REVERSE(string)', 'STUFF(string, start, length, insert)',
      'LTRIM(string[, characters])', 'RTRIM(string[, characters])', 'TRIM([characters FROM] string)', 'UPPER(string)', 'LOWER(string)',
      'CONCAT(string1, string2[, ...])', 'CONCAT_WS(separator, string1, string2[, ...])', 'STRING_AGG(expression, separator)',
      'STRING_SPLIT(string, separator[, enable_ordinal])', 'STRING_ESCAPE(text, type)', 'TRANSLATE(string, characters, translations)',
      'QUOTENAME(name[, quote_character])', 'SPACE(count)', 'STR(float[, length[, decimals]])', 'CHAR(code)', 'NCHAR(code)',
      'ASCII(character)', 'UNICODE(character)', 'SOUNDEX(string)', 'DIFFERENCE(string1, string2)', 'COUNT(expression)',
      'COUNT_BIG(expression)', 'SUM(expression)', 'AVG(expression)', 'MIN(expression)', 'MAX(expression)', 'STDEV(expression)',
      'STDEVP(expression)', 'VAR(expression)', 'VARP(expression)', 'APPROX_COUNT_DISTINCT(expression)', 'GROUPING(column)',
      'ROW_NUMBER()', 'RANK()', 'DENSE_RANK()', 'NTILE(groups)', 'LAG(expression[, offset[, default]])',
      'LEAD(expression[, offset[, default]])', 'FIRST_VALUE(expression)', 'LAST_VALUE(expression)', 'PERCENT_RANK()', 'CUME_DIST()',
      'PERCENTILE_CONT(fraction)', 'PERCENTILE_DISC(fraction)', 'ABS(number)', 'CEILING(number)', 'FLOOR(number)',
      'ROUND(number, length[, function])', 'POWER(number, exponent)', 'SQRT(number)', 'SQUARE(number)', 'EXP(number)',
      'LOG(number[, base])', 'LOG10(number)', 'SIGN(number)', 'PI()', 'RAND([seed])', 'NEWID()', 'NEWSEQUENTIALID()', 'SCOPE_IDENTITY()',
      'IDENT_CURRENT(table_name)', 'OBJECT_ID(object_name[, object_type])', 'OBJECT_NAME(object_id)', 'COL_LENGTH(table, column)',
      'DB_NAME([database_id])', 'DB_ID([database_name])', 'SCHEMA_NAME([schema_id])', 'USER_NAME([user_id])', 'SUSER_SNAME()',
      'HOST_NAME()', 'APP_NAME()', 'SERVERPROPERTY(property)', 'JSON_VALUE(expression, path)', 'JSON_QUERY(expression[, path])',
      'JSON_MODIFY(expression, path, value)', 'JSON_OBJECT(key: value[, ...])', 'JSON_ARRAY(value[, ...])', 'ISJSON(expression)',
      'OPENJSON(json[, path])', 'OPENROWSET(provider, data_source, query)', 'ERROR_MESSAGE()', 'ERROR_NUMBER()', 'ERROR_LINE()',
      'ERROR_SEVERITY()', 'ERROR_STATE()', 'ERROR_PROCEDURE()', 'XACT_STATE()', 'HASHBYTES(algorithm, input)',
      'CHECKSUM(expression[, ...])', 'COMPRESS(expression)', 'DECOMPRESS(expression)', 'ISNUMERIC(expression)',
    ])
    .map((signature) => ({ name: signature.match(/^\w+/)[0], signature })),
  dataTypes: list(`BIT, TINYINT, SMALLINT, INT, BIGINT, DECIMAL(p, s), NUMERIC(p, s), MONEY, SMALLMONEY, FLOAT, REAL, DATE, TIME,
    DATETIME, DATETIME2, DATETIMEOFFSET, SMALLDATETIME, CHAR(n), VARCHAR(n), VARCHAR(MAX), NCHAR(n), NVARCHAR(n), NVARCHAR(MAX), TEXT,
    NTEXT, BINARY(n), VARBINARY(n), VARBINARY(MAX), IMAGE, UNIQUEIDENTIFIER, XML, JSON, SQL_VARIANT, ROWVERSION, HIERARCHYID,
    GEOGRAPHY, GEOMETRY, TABLE, CURSOR`),
};

module.exports = ({ loadPackage, jsonSafe, commandOf, DML, timed, groupSchema, pushCursor, NETWORK_FIELDS }) => {
  // tedious gives BIGINT as a string, DATE/TIME as a Date, and binary as a Buffer.
  const dateText = (value, type) => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
    if (type === 'date') return value.toISOString().slice(0, 10);
    if (type === 'time') return value.toISOString().slice(11, 23);
    return value;
  };
  function cellOf(value, type) {
    if (value === null || value === undefined) return null;
    if (type === 'bigint' && typeof value === 'string') return Number.isSafeInteger(Number(value)) ? Number(value) : value;
    return jsonSafe(dateText(value, type));
  }
  // Export Data keeps the bytes (Buffer) and BIGINT's digits ({$number}). DECIMAL and MONEY come from tedious as JS
  // numbers already, so they are exact up to 15 significant digits.
  function exactOf(value, type) {
    if (value === null || value === undefined) return null;
    if (type === 'bigint' && typeof value === 'string') return { $number: value };
    return dateText(value, type);
  }

  const LOST = new Set(['ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ENOTOPEN']);

  // Messages from tedious that say little on their own.
  function readable(err, cfg, lineBase) {
    let message = err.message || String(err);
    if (/Could not connect \(sequence\)/.test(message)) {
      message = `${message.replace(/ - Could not connect \(sequence\)/, '')}: nothing accepted the connection. Check that SQL Server is running and that TCP/IP is enabled for this port${cfg.instance ? ' (and the SQL Server Browser service for a named instance)' : ''}.`;
    } else if (/self[- ]signed|certificate/i.test(message) && !cfg.trustServerCertificate) {
      message += ' Turn on "Trust server certificate" for a server with a self-signed certificate.';
    }
    const lineNumber = err.lineNumber ?? err.originalError?.info?.lineNumber;
    if (lineBase && lineNumber) message = `Line ${lineBase + lineNumber - 1}: ${message}`;
    const out = new Error(message);
    out.code = err.code;
    return out;
  }

  async function openMssql(cfg, { onLost = () => {} } = {}) {
    const sql = loadPackage('mssql');
    // One connection that stays open, so session state (USE, #temp tables, SET options) lasts across queries.
    const poolConfig = {
      server: cfg.host || 'localhost',
      port: cfg.instance ? undefined : cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database || undefined,
      connectionTimeout: 10000,
      requestTimeout: 0,
      pool: { max: 1, min: 0, idleTimeoutMillis: 2 ** 31 - 1 },
      options: { instanceName: cfg.instance || undefined, encrypt: !!cfg.encrypt, trustServerCertificate: !!cfg.trustServerCertificate, appName: 'PyIDE' },
    };
    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', onLost);
    try {
      await pool.connect();
    } catch (err) {
      pool.close().catch(() => {});
      throw readable(err, cfg);
    }

    // Streams one batch: the rows of each result set up to maxRows are kept, the rest are read and dropped, so no
    // TOP is added to the user's SQL and every statement of the batch still runs.
    const runBatch = (text, maxRows) => new Promise((resolve, reject) => {
      const req = pool.request();
      req.stream = true;
      req.arrayRowMode = true;
      const sets = [];
      let affected = null;
      let failed = null;
      req.on('recordset', (columns) => sets.push({ columns, rows: [], total: 0 }));
      req.on('row', (row) => {
        const set = sets[sets.length - 1];
        set.total++;
        if (set.rows.length < maxRows) set.rows.push(row);
      });
      req.on('rowsaffected', (n) => { affected = (affected || 0) + n; });
      req.on('error', (err) => { failed ||= err; });
      req.on('done', () => (failed ? reject(failed) : resolve({ sets, affected })));
      req.query(text);
    });

    async function run(text, maxRows) {
      const batches = splitGoBatches(text);
      const many = batches.length > 1 || text.includes('\n');
      let last = { sets: [], affected: null, text: '' };
      for (const b of batches) {
        for (let n = 0; n < b.repeat; n++) {
          try {
            last = { ...(await runBatch(b.text, maxRows)), text: b.text };
          } catch (err) {
            if (LOST.has(err.code)) onLost(err);
            throw readable(err, cfg, many ? b.line : 0);
          }
        }
      }
      const command = commandOf(last.text);
      const set = last.sets.filter((s) => s.columns.length).pop();
      if (!set) return { columns: [], rows: [], rowCount: DML.has(command) ? last.affected : null, truncated: false, command };
      const types = set.columns.map((c) => String(c.type?.declaration || '').toLowerCase());
      return {
        columns: set.columns.map((c, i) => ({ name: c.name, type: types[i] })),
        rows: set.rows.map((row) => row.map((v, i) => cellOf(v, types[i]))),
        rowCount: set.rows.length,
        truncated: set.total > set.rows.length,
        command,
      };
    }

    const typeName = (r) => {
      if (r.len === -1) return `${r.ty}(max)`;
      if (r.len && /char|binary/.test(r.ty)) return `${r.ty}(${r.len})`;
      if (/^(decimal|numeric)$/.test(r.ty)) return `${r.ty}(${r.p},${r.sc})`;
      return r.ty;
    };

    return {
      query: (text, { maxRows }) => timed(() => run(text, maxRows)),
      async schema() {
        const { recordset } = await pool.request().query(`
          SELECT c.TABLE_SCHEMA s, c.TABLE_NAME t, tb.TABLE_TYPE tt, c.COLUMN_NAME col, c.DATA_TYPE ty, c.CHARACTER_MAXIMUM_LENGTH len,
                 c.NUMERIC_PRECISION p, c.NUMERIC_SCALE sc, c.IS_NULLABLE n, CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END pk
          FROM INFORMATION_SCHEMA.COLUMNS c
          JOIN INFORMATION_SCHEMA.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
          LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON ku.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                     WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') k
            ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
          ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
        return groupSchema(recordset.map((r) => ({ schema: r.s, table: r.t, view: r.tt === 'VIEW', column: r.col, type: typeName(r), nullable: r.n === 'YES', pk: !!r.pk })));
      },
      async version() {
        const { recordset } = await pool.request().query('SELECT @@VERSION AS v');
        return recordset[0].v.split('\n')[0].replace(/\s*\(KB\d+\)/, '').trim();
      },
      // Export Data: the batch's rows streamed (request.stream) on a connection of its own, paused while rows wait for
      // the file; Cancel cancels the request. The first result set with columns is exported. SQL Server has no
      // read-only transaction to put it in, so readOnly changes nothing here: the renderer runs again only statements
      // it judged read-only or the user confirmed.
      async cursor(text) {
        const own = new sql.ConnectionPool(poolConfig);
        own.on('error', () => {});
        try { await own.connect(); } catch (err) { own.close().catch(() => {}); throw readable(err, cfg); }
        const req = own.request();
        req.stream = true;
        req.arrayRowMode = true;
        let set = 0;
        let exported = 0;
        let types = [];
        const { cursor, feed, ready } = pushCursor({
          pause: () => req.pause(),
          resume: () => req.resume(),
          cancel: () => req.cancel(),
          finish: () => own.close().catch(() => {}),
        });
        req.on('recordset', (columns) => {
          set++;
          if (exported || !columns?.length) return;
          exported = set;
          types = columns.map((c) => String(c.type?.declaration || '').toLowerCase());
          feed.columns(columns.map((c, i) => ({ name: c.name, type: types[i] })));
        });
        req.on('row', (row) => { if (set === exported) feed.row(row.map((v, i) => exactOf(v, types[i]))); });
        req.on('error', (err) => feed.fail(readable(err, cfg)));
        req.on('done', () => feed.end());
        req.query(text);
        try { return await ready; } catch (err) { own.close().catch(() => {}); throw err; }
      },
      close: () => pool.close(),
    };
  }

  const [host, port, user, password, database] = NETWORK_FIELDS;
  const OPEN = 'SELECT TOP 200 * FROM {qualified};';
  return {
    packages: { mssql: 'mssql@12.7.4' },
    kinds: {
      mssql: {
        label: 'Microsoft SQL Server', order: 40, package: 'mssql', defaultPort: 1433, quote: '"', sqlDialect: 'mssql', implicitSchemas: ['dbo'], open: openMssql,
        fields: [
          host, port,
          { key: 'instance', label: 'Instance name', placeholder: 'SQLEXPRESS' },
          user, password, database,
          { key: 'encrypt', label: 'Encrypt connection', type: 'checkbox', default: true },
          { key: 'trustServerCertificate', label: 'Trust server certificate', type: 'checkbox', default: false },
        ],
        ui: { statementSeparator: 'go-line', openData: { table: OPEN, view: OPEN }, completion: COMPLETION },
      },
    },
  };
};
module.exports.splitGoBatches = splitGoBatches;
