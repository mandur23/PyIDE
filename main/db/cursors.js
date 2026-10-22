// Cursors for Export Data (main/db/export.js reads them): {columns, next(n) -> rows | null at the end, close(), capped?}.
// Each SQL kind's adapter.cursor(sql, {readOnly}) streams the statement's rows from its driver with exact values (see
// the kind modules); these are the shared pieces. Pure Node: verify/db-export.mjs drives them with fake drivers.

// An error Export Data reports by a code the renderer translates (renderer/features/database/export.js), with English
// text for logs: NO_ROWS (the statement answers without a result set), NOTHING_TO_EXPORT, FILE_NOT_CHOSEN,
// UNKNOWN_FORMAT, EXPORT_UNSUPPORTED (the data source cannot stream rows).
const EXPORT_ERRORS = {
  NO_ROWS: 'The statement returns no rows',
  NOTHING_TO_EXPORT: 'Nothing to export',
  FILE_NOT_CHOSEN: 'The file was not chosen in the Save dialog',
  UNKNOWN_FORMAT: 'Unknown export format',
  EXPORT_UNSUPPORTED: 'This data source cannot export rows',
};
function exportError(code) {
  const err = new Error(EXPORT_ERRORS[code] || code);
  err.exportCode = code;
  return err;
}

// Rows of a statement a driver cannot stream (PostgreSQL's SHOW, EXPLAIN, INSERT … RETURNING, which no cursor can
// hold): the driver has already read the result, and at most `cap` rows of it are exported; `capped` tells the user
// how many when there were more.
const EXPORT_ROW_CAP = 1000000;
function resultCursor(columns, rows, cap = Infinity, onClose = async () => {}) {
  let at = 0;
  const end = Math.min(rows.length, cap);
  return {
    columns,
    capped: rows.length > cap ? cap : null,
    async next(n) { if (at >= end) return null; const out = rows.slice(at, Math.min(end, at + n)); at += out.length; return out; },
    close: onClose,
  };
}

// A cursor over a driver that pushes rows as events (mysql2, tedious). Rows wait in a queue until next(n) takes them;
// the driver is paused while `high` rows wait and resumed when next() needs more, so a slow file (or a slow disk) never
// lets the result pile up in memory. The driver side calls feed.columns(cols) once, feed.row(row) per row, then
// feed.end() or feed.fail(err); control = {pause(), resume(), cancel(), finish?(early)}: cancel stops the driver on an
// early close (Cancel, a failed write), and finish releases what the cursor holds (its connection) on every close.
// ready resolves when the columns are known (or rejects: NO_ROWS when the statement ends without a result set).
function pushCursor(control, { high = 2000 } = {}) {
  let queue = [];
  let columns = null;
  let ended = false;
  let failed = null;
  let paused = false;
  let closed = false;
  let want = 1;
  let wake = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => {});
  const poke = () => { const w = wake; wake = null; w?.(); };
  const pause = () => { if (!paused && !ended) { paused = true; control.pause(); } };
  const resume = () => { if (paused) { paused = false; control.resume(); } };
  const feed = {
    columns(cols) { if (columns) return; columns = cols; readyResolve(cursor); },
    row(row) {
      if (closed) return;
      queue.push(row);
      if (queue.length >= high) pause();
      if (queue.length >= want || paused) poke();
    },
    end() {
      if (ended) return;
      ended = true;
      paused = false;
      if (!columns) readyReject(exportError('NO_ROWS'));
      poke();
    },
    fail(err) {
      if (ended) return;
      failed = err;
      ended = true;
      readyReject(failed);
      poke();
    },
  };
  const cursor = {
    get columns() { return columns; },
    async next(n) {
      want = n;
      if (n > high) high = n;
      for (;;) {
        if (failed) throw failed;
        if (queue.length >= n || (ended && queue.length)) {
          const out = queue.length > n ? queue.splice(0, n) : queue;
          if (out === queue) queue = [];
          if (queue.length < high) resume();
          return out;
        }
        if (ended) return null;
        resume();
        await new Promise((res) => { wake = res; });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      queue = [];
      const early = !ended;
      if (early) {
        failed ||= Object.assign(new Error('Export cancelled'), { cancelled: true });
        ended = true;
        poke();
        try { await control.cancel(); } catch {}
      }
      await control.finish?.(early);
    },
  };
  return { cursor, feed, ready };
}

module.exports = { exportError, EXPORT_ERRORS, EXPORT_ROW_CAP, resultCursor, pushCursor };
