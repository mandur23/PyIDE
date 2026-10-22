// Export Data… (PyCharm's data extractors) for a query console's result or a table/view in the Database tool window.
// The dialog picks the format and its options, the Save dialog (in main) picks the file, and main streams the rows to it
// (main/db/export.js) while a background task shows the progress and offers Cancel. The options are remembered in the
// `database.export` setting.
(() => {
  // ---------- may the statement run again? ----------
  // Export Data for a console result streams every row by running the statement again, which only a statement that
  // just reads may do unasked: a plain SELECT / WITH / VALUES / TABLE without INTO, data-modifying CTEs, locking clauses
  // or functions known to change something; EXPLAIN without ANALYZE; SHOW; DESCRIBE; a PRAGMA that reads. Anything
  // else, or anything this cannot read with certainty (several statements, backslash escapes in strings), is not
  // read-only and the user is asked. Pure: verify/db-export.mjs loads it in Node.
  // Comments go, string literals become '', quoted identifiers keep their text (a quoted "nextval"( is still a call).
  const LEXEMES = /--[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|'(?:[^']|'')*'|"((?:[^"]|"")*)"|`((?:[^`]|``)*)`/g;
  const WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|INTO|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE|CALL|EXEC|EXECUTE|COPY|LOCK|DBCC|BACKUP|RESTORE|SHUTDOWN|RECONFIGURE|BULK|WAITFOR|DECLARE|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH|VACUUM|ANALY[SZ]E|REINDEX|NOTIFY|LISTEN|PREPARE|DEALLOCATE)\b|\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE)\b|\bNEXT\s+VALUE\s+FOR\b|\.\s*NEXTVAL\b/i;
  const SIDE_EFFECTS = /\b(nextval|setval|pg_advisory_\w+|pg_try_advisory_\w+|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_notify|pg_sleep\w*|set_config|lo_\w+|dblink\w*|txid_current\w*|pg_current_xact_id\w*|sleep|benchmark|get_lock|release_lock|release_all_locks|last_insert_id|load_extension|writefile|sys_\w+|xp_\w+|sp_\w+|dbms_\w+|utl_\w+)\s*\(/i;
  // PRAGMAs that do something rather than report (with or without an argument), and those whose argument form reads.
  const PRAGMA_ACTIONS = /^(optimize|wal_checkpoint|incremental_vacuum|shrink_memory)$/i;
  const PRAGMA_READ_CALLS = /^(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|foreign_key_check|integrity_check|quick_check|database_list|collation_list|function_list|module_list|pragma_list|compile_options)$/i;
  function isReadOnlyStatement(sql) {
    if (typeof sql !== 'string' || /\\'/.test(sql)) return false;
    const text = sql.replace(LEXEMES, (m, _tag, dq, bq) => (m.startsWith("'") || m.startsWith('$') ? "''" : dq !== undefined ? ` ${dq} ` : bq !== undefined ? ` ${bq} ` : ' '))
      .trim().replace(/[;\s]+$/, '');
    if (!text || text.includes(';')) return false;
    const command = (text.match(/^[A-Za-z]+/)?.[0] || '').toUpperCase();
    switch (command) {
      case 'SELECT': case 'WITH': case 'VALUES': case 'TABLE':
        return !WRITES.test(text) && !SIDE_EFFECTS.test(text);
      case 'EXPLAIN':
        return !/\bANALY[SZ]E\b/i.test(text);
      case 'SHOW': case 'DESCRIBE': case 'DESC':
        return true;
      case 'PRAGMA': {
        const m = text.match(/^PRAGMA\s+(?:\w+\s*\.\s*)?(\w+)\s*(\(\s*[^()]*\))?$/i);
        return !!m && !PRAGMA_ACTIONS.test(m[1]) && (!m[2] || PRAGMA_READ_CALLS.test(m[1]));
      }
      default:
        return false;
    }
  }
  if (typeof ide === 'undefined') {
    module.exports = { isReadOnlyStatement };
    return;
  }

  const { el, basename } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(ch, ...args);
  const KEY = 'database.export';
  const DEFAULTS = { format: 'csv', delimiter: ',', header: true, quote: 'needed', encoding: 'utf8', jsonStyle: 'array' };

  const FORMATS = () => [
    ['csv', 'CSV'], ['tsv', 'TSV'], ['json', 'JSON'], ['sql', tr('SQL INSERT statements')], ['markdown', tr('Markdown table')], ['xlsx', 'Excel (.xlsx)'],
  ];
  // Which options each format has.
  const HAS = {
    delimiter: ['csv'], header: ['csv', 'tsv', 'xlsx'], quote: ['csv', 'tsv'], encoding: ['csv', 'tsv', 'json', 'sql', 'markdown'],
    jsonStyle: ['json'], table: ['sql'],
  };

  const progressListeners = new Map(); // job -> fn
  ide.api.on('db:exportProgress', (p) => progressListeners.get(p.job)?.(p));
  let seq = 0;

  function select(id, options, value) {
    const s = el('select');
    s.id = id;
    for (const [v, label] of options) s.add(new Option(label, v));
    s.value = value;
    return s;
  }
  function field(label, input) {
    const row = el('label', 'field db-export-field');
    row.append(el('span', null, label), input);
    return row;
  }

  // Resolves {format, options} or null when cancelled.
  function chooseOptions(spec) {
    return new Promise((resolve) => {
      const saved = { ...DEFAULTS, ...ide.settings.get(KEY, {}) };
      let picked = null;
      const body = el('div', 'db-export-dialog');
      const what = el('div', 'db-export-what');
      if (spec.table) what.append(el('span', null, `${tr('Table')}: `), el('span', 'db-export-name', spec.name));
      else if (spec.sql) what.append(el('span', null, `${tr('Query')}: `), el('span', 'db-export-name', spec.sql.trim().split('\n')[0].slice(0, 120)));
      else what.append(el('span', null, tr('The {n} rows shown in the result', { n: spec.rows.length })));
      for (const n of what.querySelectorAll('.db-export-name')) n.dataset.userText = '';
      body.append(what);

      const format = select('dbExportFormat', FORMATS(), saved.format);
      const delimiter = select('dbExportDelimiter', [[',', tr('Comma (,)')], [';', tr('Semicolon (;)')], ['\t', tr('Tab')], ['|', tr('Pipe (|)')]], saved.delimiter);
      const header = el('input');
      header.type = 'checkbox';
      header.id = 'dbExportHeader';
      header.checked = saved.header !== false;
      const quote = select('dbExportQuote', [['needed', tr('When needed')], ['always', tr('Always')], ['never', tr('Never')]], saved.quote);
      const encoding = select('dbExportEncoding', [['utf8', 'UTF-8'], ['utf8bom', tr('UTF-8 with BOM (Excel)')], ['utf16le', 'UTF-16 LE']], saved.encoding);
      const jsonStyle = select('dbExportJsonStyle', [['array', tr('Array of objects')], ['lines', tr('JSON Lines (one object per line)')]], saved.jsonStyle);
      const table = el('input');
      table.id = 'dbExportTable';
      table.value = spec.table ? spec.table.name : 'MY_TABLE';
      table.spellcheck = false;
      const headerLabel = el('label', 'db-export-check');
      headerLabel.append(header, el('span', null, tr('Add column header')));
      const rows = {
        delimiter: field(tr('Value separator'), delimiter),
        quote: field(tr('Quote values'), quote),
        header: headerLabel,
        encoding: field(tr('Encoding'), encoding),
        jsonStyle: field(tr('Style'), jsonStyle),
        table: field(tr('Table name'), table),
      };
      body.append(field(tr('Format'), format), ...Object.values(rows));
      const sync = () => { for (const [k, row] of Object.entries(rows)) row.classList.toggle('hidden', !HAS[k].includes(format.value)); };
      format.addEventListener('change', sync);
      sync();

      ide.ui.dialog({
        title: tr('Export Data'),
        body,
        width: 480,
        onClose: () => resolve(picked),
        buttons: [
          { label: tr('Export to File…'), primary: true, run: () => {
            const choice = { format: format.value, delimiter: delimiter.value, header: header.checked, quote: quote.value, encoding: encoding.value, jsonStyle: jsonStyle.value };
            ide.settings.set(KEY, choice);
            const f = choice.format;
            const options = {};
            if (HAS.delimiter.includes(f)) options.delimiter = choice.delimiter;
            if (HAS.header.includes(f)) options.header = choice.header;
            if (HAS.quote.includes(f)) options.quote = choice.quote;
            if (HAS.encoding.includes(f)) options.encoding = choice.encoding;
            if (f === 'json') options.style = choice.jsonStyle;
            // The table typed for an exported table is its own (quoted) name unless the user changed it.
            if (f === 'sql' && !(spec.table && table.value.trim() === spec.table.name)) options.table = table.value.trim() || 'MY_TABLE';
            if (f === 'xlsx') options.sheet = spec.name;
            picked = { format: f, options };
            return true;
          } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  // Errors main reports by code (main/db/cursors.js EXPORT_ERRORS), in the user's language.
  const ERRORS = {
    NO_ROWS: 'The statement returns no rows',
    NOTHING_TO_EXPORT: 'Nothing to export',
    FILE_NOT_CHOSEN: 'The file was not chosen in the Save dialog',
    UNKNOWN_FORMAT: 'Unknown export format',
    EXPORT_UNSUPPORTED: 'This data source cannot export rows',
  };

  // spec: {sourceId, table: {schema, name}} | {sourceId, sql, readOnly?} | {sourceId?, columns, rows}; name names the
  // file; readOnly: the statement was judged read-only (main may run it in a read-only transaction).
  // Resolves the export's result ({ok, rows, file, ...} | {ok: false, cancelled} | {ok: false, error, code?}) or null
  // when the dialog or Save dialog was cancelled.
  async function exportData(spec) {
    const choice = await chooseOptions(spec);
    if (!choice) return null;
    const file = await invoke('db:chooseExportFile', { title: tr('Export Data'), name: spec.name, format: choice.format });
    if (!file) return null;
    const job = `export-${Date.now()}-${++seq}`;
    const task = ide.tasks.start({
      title: tr('Exporting data to {file}', { file: basename(file) }),
      text: tr('Starting…'),
      fraction: spec.table ? 0 : null,
      onCancel: () => invoke('db:exportCancel', job),
    });
    progressListeners.set(job, ({ rows, total }) => {
      task.update({ fraction: total ? Math.min(1, rows / total) : null, text: total ? tr('{n} of {total} rows', { n: rows, total }) : tr('{n} rows', { n: rows }) });
    });
    let r;
    try {
      r = await invoke('db:export', {
        job, sourceId: spec.sourceId, format: choice.format, options: choice.options, file, table: spec.table, sql: spec.sql,
        readOnly: spec.readOnly === true, columns: spec.columns, rows: spec.rows,
      });
    } catch (err) {
      r = { ok: false, error: err.message };
    } finally {
      progressListeners.delete(job);
    }
    task.done();
    if (r.ok) {
      const notes = [];
      if (r.truncated) notes.push(tr('(Excel holds at most 1,048,576 rows; the rest was left out)'));
      if (r.capped) notes.push(tr('Only the first {n} rows were exported: this statement cannot be streamed from the database.', { n: r.capped }));
      ide.notifications.notify({
        title: tr('Data exported'),
        text: [tr('{n} rows written to {file}', { n: r.rows, file }), ...notes].join(' '),
        kind: r.capped ? 'warn' : 'ok', raw: true,
        actions: [{ label: tr('Show in Explorer'), run: () => invoke('shell:showInFolder', file) }],
      });
    } else if (!r.cancelled) {
      const known = r.missingDriver ? 'Driver files are missing. Download them in the data source settings.' : ERRORS[r.code];
      ide.notifications.notify({ title: tr('Export failed'), text: known ? tr(known) : r.error, kind: 'error', raw: !known });
    }
    return r;
  }

  // Asks before running a statement again that is not known to only read. Resolves 'shown', 'run' or null (cancelled).
  function askRerun(shown) {
    return new Promise((resolve) => {
      let answer = null;
      const body = el('div', 'db-export-rerun');
      body.append(
        el('div', 'dialog-message', tr('Run the statement again to export all rows?')),
        el('div', 'db-export-rerun-detail', tr('The statement may change data, so it is not run again without asking. Export Shown Rows writes the {n} rows the result shows.', { n: shown })),
      );
      ide.ui.dialog({
        title: tr('Export Data'),
        body,
        width: 480,
        onClose: () => resolve(answer),
        buttons: [
          { label: tr('Export Shown Rows'), primary: true, run: () => { answer = 'shown'; } },
          { label: tr('Run and Export'), run: () => { answer = 'run'; } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  // Export Data… for a console's result: {sourceId, sql (the statement that produced it), language, result, name}.
  // A read-only SQL statement runs again and streams every row to the file. Any other result exports the rows the grid
  // holds when they are all of them; when the grid holds only the first rows, the user chooses between those and
  // running the statement again. Non-SQL results (MongoDB, Redis) export the grid's rows.
  async function exportResult({ sourceId, sql, language, result, name }) {
    const shown = { sourceId, columns: result.columns.map((col) => ({ name: col.name })), rows: result.rows, name };
    if (language !== 'sql' || !sql) return exportData(shown);
    if (isReadOnlyStatement(sql)) return exportData({ sourceId, sql, readOnly: true, name });
    if (!result.truncated) return exportData(shown);
    const answer = await askRerun(result.rows.length);
    if (!answer) return null;
    return exportData(answer === 'run' ? { sourceId, sql, readOnly: false, name } : shown);
  }

  ide.database.exportData = exportData;
  ide.database.exportResult = exportResult;
  ide.database.isReadOnlyStatement = isReadOnlyStatement;
})();
