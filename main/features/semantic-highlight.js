// Runs the semantic highlighting sidecar (renderer/features/semantic-highlight/semantic_server.py) and relays
// JSON-lines requests to it. The sidecar only parses text with `ast` and reads other modules' source, so any local
// Python 3.8+ can run it: the renderer passes the project interpreter first and the other local interpreters after
// it, and the first one that starts is kept (an interpreter that fails is skipped until the list changes).
// Imported names resolve through Pyright's bundled typeshed stubs for the standard library, then the project and the
// interpreter's sys.path. Python runs the script from the unpacked copy in packaged builds; it cannot read app.asar.
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const TIMEOUT_MS = 15000;

exports.register = ({ ipcMain, app, appDir, unpackedDir = appDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'semantic-highlight', 'semantic_server.py');
  const stubs = [path.join(unpackedDir, 'node_modules', 'pyright', 'dist', 'typeshed-fallback', 'stdlib')];
  let side = null;
  const failed = new Set(); // interpreter keys that could not run the sidecar

  function start(interp) {
    const s = { key: interp.executable || interp.cmd, pending: new Map(), nextId: 1, buf: '', dead: false, stderr: '' };
    // -I (isolated, like regex-check): no PYTHONPATH, user site-packages, usercustomize or script folder on sys.path,
    // so nothing outside the interpreter's own library can shadow a module the sidecar imports. -I ignores PYTHON*
    // variables, hence -X utf8 and -B as options; the server still reads (never imports) PYTHONPATH and the user
    // site-packages when it resolves names (semantic_server.py: search_paths).
    s.proc = spawn(interp.cmd, [...(interp.args || []), '-I', '-X', 'utf8', '-B', '-u', script], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    s.fail = (message) => {
      if (s.dead) return;
      s.dead = true;
      for (const p of s.pending.values()) p({ error: { code: 'sidecar', message, detail: s.stderr.slice(-2000) } });
      s.pending.clear();
    };
    s.proc.stdout.setEncoding('utf8');
    s.proc.stdout.on('data', (d) => {
      s.buf += d;
      let nl;
      while ((nl = s.buf.indexOf('\n')) >= 0) {
        const line = s.buf.slice(0, nl);
        s.buf = s.buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = s.pending.get(msg.id);
        if (p) { s.pending.delete(msg.id); p(msg); }
      }
    });
    s.proc.stderr.on('data', (d) => { s.stderr = (s.stderr + d.toString('utf8')).slice(-8000); });
    s.proc.stdin.on('error', () => {});
    s.proc.on('error', (err) => s.fail(err.message));
    s.proc.on('exit', (code) => s.fail(`The semantic highlighting process exited with code ${code}`));
    return s;
  }

  // The whole tree is killed: interp.cmd can be a launcher (py.exe, a venv's python.exe) whose Python would outlive it.
  function stop(sync = false) {
    if (side && !side.dead) {
      side.fail('stopped');
      const { proc } = side;
      if (process.platform !== 'win32' || !proc.pid) {
        try { proc.kill(); } catch {}
      } else {
        const args = ['/pid', String(proc.pid), '/T', '/F'];
        if (sync) spawnSync('taskkill', args, { windowsHide: true, timeout: 5000 });
        else spawn('taskkill', args, { windowsHide: true }).on('error', () => {});
      }
    }
    side = null;
  }

  function send(s, method, params) {
    return new Promise((resolve) => {
      const id = s.nextId++;
      const timer = setTimeout(() => {
        if (!s.pending.delete(id)) return;
        resolve({ error: { code: 'timeout', message: `No answer in ${TIMEOUT_MS / 1000} s` } });
        if (side === s) stop();
      }, TIMEOUT_MS);
      s.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      s.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  // A sidecar that answers the version check is kept; one that cannot start (no such program, Python 2, a broken
  // venv) marks its interpreter as failed and the next candidate is tried.
  let starting = null;
  async function sidecar(candidates) {
    while (starting) await starting;
    const preferred = candidates.find((c) => c.cmd && !failed.has(c.executable || c.cmd));
    if (side && !side.dead && preferred && (preferred.executable || preferred.cmd) === side.key) return side;
    starting = pick(candidates);
    try { return await starting; } finally { starting = null; }
  }

  async function pick(candidates) {
    stop();
    for (const interp of candidates) {
      const key = interp.executable || interp.cmd;
      if (!interp.cmd || failed.has(key)) continue;
      const s = start(interp);
      const r = await send(s, 'hello', {});
      if (r.result?.ok) return (side = s);
      failed.add(key);
      side = s;
      stop();
    }
    return null;
  }

  // -> {result: {data}} | {error: {code, message}}; never rejects.
  // candidates: [{cmd, args, executable}] in order of preference; params: {text, path, root}.
  ipcMain.handle('semantic-highlight:tokens', async (_e, candidates, params) => {
    const s = await sidecar(candidates || []);
    if (!s) return { error: { code: 'no-python', message: 'No local Python 3.8 or later can run the semantic highlighter' } };
    return send(s, 'tokens', { ...params, stubs });
  });
  // The interpreter list changed: interpreters that failed get another chance.
  ipcMain.handle('semantic-highlight:reset', () => { failed.clear(); });
  ipcMain.handle('semantic-highlight:stop', () => stop());
  app.on('will-quit', () => stop(true));
};
