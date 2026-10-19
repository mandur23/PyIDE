// Runs the refactoring sidecar (renderer/features/refactor/refactor_server.py, rope) in the project interpreter and
// relays JSON-lines requests to it. One process per interpreter; it is replaced when the interpreter changes.
// Python runs the script from the unpacked copy in packaged builds; it cannot read app.asar.
const { spawn } = require('child_process');
const path = require('path');

exports.register = ({ ipcMain, app, appDir, unpackedDir = appDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'refactor', 'refactor_server.py');
  let side = null;

  function start(interp) {
    const s = { key: interp.executable || interp.cmd, pending: new Map(), nextId: 1, buf: '', dead: false, stderr: '' };
    s.proc = spawn(interp.cmd, [...(interp.args || []), '-u', script], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const fail = (message) => {
      if (s.dead) return;
      s.dead = true;
      for (const p of s.pending.values()) p({ error: { code: 'sidecar', message, params: { detail: s.stderr.slice(-2000) } } });
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
    s.proc.on('error', (err) => fail(err.message));
    s.proc.on('exit', (code) => fail(`The refactoring process exited with code ${code}`));
    return s;
  }

  function stop() {
    if (side && !side.dead) { side.dead = true; try { side.proc.kill(); } catch {} }
    side = null;
  }

  // Resolves to {result} or {error: {code, message, params}}; never rejects.
  ipcMain.handle('refactor:call', (_e, interp, method, params) => {
    if (!interp?.cmd) return { error: { code: 'no-interpreter', message: 'No project interpreter' } };
    const k = interp.executable || interp.cmd;
    if (!side || side.dead || side.key !== k) { stop(); side = start(interp); }
    const s = side;
    return new Promise((resolve) => {
      const id = s.nextId++;
      s.pending.set(id, resolve);
      s.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  });
  ipcMain.handle('refactor:stop', () => stop());
  app.on('will-quit', stop);
};
