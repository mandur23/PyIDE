// Commit checks (vcs-checks plugin): the Analyze Code step runs the bundled Pyright command line on the files being
// committed, as they are on disk (the renderer saves them first). The language server only analyzes open files, and
// asking it about others would disturb the editors' state, so a one-off CLI run is used instead.
//
// The files go on Pyright's command line, relative to the project where they are inside it, in as many runs as it
// takes to stay under Windows' 32767-character command line (Pyright's `-` reads a stdin list split at spaces, which
// breaks paths with spaces; a temporary --project would lose the project's own Pyright configuration). A run belongs
// to the window that asked: its whole process tree (Pyright starts the interpreter to find its search paths) is killed
// on Cancel, when that window reloads or closes, and at quit, so nothing outlives the IDE.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const trust = require('../trust');

const SEVERITY = { error: 'error', warning: 'warning' };
// CreateProcess takes at most 32767 characters; the rest is margin.
const MAX_COMMAND_LINE = 32767;
const COMMAND_LINE_BUDGET = 30000;
// What an argument adds to the Windows command line at most: Node quotes one with spaces (2) and separates it (1).
// Paths cannot contain quotes, so no backslash doubling applies.
const argCost = (a) => String(a).length + 3;

// Splits `files` into lists that fit on one command line after the `fixed` arguments (the program included).
function chunkFiles(fixed, files, budget = COMMAND_LINE_BUDGET) {
  const base = fixed.reduce((n, a) => n + argCost(a), 0);
  const chunks = [];
  let cur = [];
  let len = base;
  for (const f of files) {
    const c = argCost(f);
    if (cur.length && len + c > budget) { chunks.push(cur); cur = []; len = base; }
    cur.push(f);
    len += c;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// The whole tree: Pyright's own children (the interpreter it asks for search paths) would outlive a plain kill.
// sync: at quit, where an asynchronous taskkill might never run.
function killTree(p, { sync = false } = {}) {
  if (!p?.pid || p.exitCode !== null || p.signalCode) return;
  if (process.platform !== 'win32') { try { p.kill(); } catch {} return; }
  const args = ['/pid', String(p.pid), '/T', '/F'];
  if (sync) spawnSync('taskkill', args, { windowsHide: true, timeout: 5000 });
  else spawn('taskkill', args, { windowsHide: true }).on('error', () => {});
}

const runs = new Map(); // request id -> {proc (the Pyright process running now), cancelled, owner}

function cancel(id, opts) {
  const run = runs.get(id);
  if (!run) return false;
  runs.delete(id);
  run.cancelled = true;
  killTree(run.proc, opts);
  return true;
}
function cancelAll(opts, owner = null) {
  for (const [id, run] of [...runs]) if (!owner || run.owner === owner) cancel(id, opts);
}

// One Pyright process on a list of files -> {ok, json} | {ok: false, error, cancelled?}
function runPyright(run, cli, fixedArgs, files, root) {
  return new Promise((resolve) => {
    if (run.cancelled) return resolve({ ok: false, cancelled: true, error: 'Cancelled' });
    let p;
    try {
      p = spawn(process.execPath, [cli, ...fixedArgs, ...files], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    run.proc = p;
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.stdin.on('error', () => {});
    p.stdin.end();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; if (run.proc === p) run.proc = null; resolve(r); } };
    p.on('error', (e) => done({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (run.cancelled) return done({ ok: false, cancelled: true, error: 'Cancelled' });
      // Exit codes: 0 no errors, 1 errors found, 2 fatal, 3 bad configuration.
      let json = null;
      try { json = JSON.parse(out); } catch {}
      if (!json || code > 1) return done({ ok: false, error: (err || out).trim().split(/\r?\n/).slice(-3).join('\n') || `Pyright exited with code ${code}` });
      done({ ok: true, json });
    });
  });
}

// -> {ok, diagnostics: [{path, line, col, endLine, endCol, severity, message, rule}]} | {ok: false, error, cancelled?}
async function analyze(unpackedDir, id, root, files, python, owner = null) {
  if (!trust.isTrusted(root)) return { ok: false, error: 'This project is not trusted' };
  const py = files.filter((f) => /\.pyi?$/i.test(f));
  if (!py.length) return { ok: true, diagnostics: [] };
  // PYIDE_PYRIGHT_CLI: a stand-in Pyright for tests (verify/commit-checks.mjs: one that never finishes).
  const cli = process.env.PYIDE_PYRIGHT_CLI || path.join(unpackedDir, 'node_modules', 'pyright', 'index.js');
  const fixedArgs = ['--outputjson', ...(python ? ['--pythonpath', python] : [])];
  // Pyright reports absolute paths with its own drive letter case; give back the caller's spelling.
  const byLower = new Map(py.map((f) => [path.resolve(root, f).toLowerCase(), f]));
  const arg = (f) => {
    const rel = path.relative(root, f);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : f;
  };
  const run = { proc: null, cancelled: false, owner };
  cancel(id);
  runs.set(id, run);
  try {
    const diagnostics = [];
    for (const chunk of chunkFiles([process.execPath, cli, ...fixedArgs], py.map(arg))) {
      const r = await runPyright(run, cli, fixedArgs, chunk, root);
      if (!r.ok) return r;
      for (const d of r.json.generalDiagnostics || []) {
        if (!SEVERITY[d.severity]) continue;
        diagnostics.push({
          path: byLower.get(path.resolve(root, d.file || '').toLowerCase()) || d.file,
          line: (d.range?.start?.line ?? 0) + 1, col: (d.range?.start?.character ?? 0) + 1,
          endLine: (d.range?.end?.line ?? 0) + 1, endCol: (d.range?.end?.character ?? 0) + 1,
          severity: SEVERITY[d.severity], message: d.message, rule: d.rule || '',
        });
      }
    }
    return run.cancelled ? { ok: false, cancelled: true, error: 'Cancelled' } : { ok: true, diagnostics };
  } finally {
    if (runs.get(id) === run) runs.delete(id);
  }
}

exports.register = ({ ipcMain, app, unpackedDir }) => {
  // A reloaded or closed window can no longer cancel its run or use the result.
  const watched = new WeakSet();
  const watch = (wc) => {
    if (!wc?.on || watched.has(wc)) return;
    watched.add(wc);
    const gone = () => cancelAll({}, wc);
    wc.on('did-navigate', gone);
    wc.on('render-process-gone', gone);
    wc.once('destroyed', gone);
  };
  ipcMain.handle('vcs-checks:analyze', (e, id, root, files, python) => {
    watch(e?.sender);
    return analyze(unpackedDir, id, root, files, python, e?.sender || null);
  });
  ipcMain.handle('vcs-checks:cancel', (_e, id) => cancel(id));
  app?.on('will-quit', () => cancelAll({ sync: true }));
};

// For verify/commit-checks.mjs.
exports.chunkFiles = chunkFiles;
exports.MAX_COMMAND_LINE = MAX_COMMAND_LINE;
exports.runningPids = () => [...runs.values()].map((r) => r.proc?.pid).filter(Boolean);
