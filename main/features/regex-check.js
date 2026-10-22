// Check RegExp, main side: runs renderer/features/regex-check/regex_check.py in a local Python interpreter (the project's
// unless that one is remote) and relays JSON-lines requests to it, so patterns are checked with Python's own `re`.
// One helper per interpreter, started on first use and replaced when the interpreter changes. A pattern that backtracks
// for longer than TIMEOUT_MS (catastrophic backtracking cannot be interrupted inside `re`) stops the helper; the next
// request starts a new one. Python runs the script from the unpacked copy in packaged builds; it cannot read app.asar.
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const TIMEOUT_MS = Number(process.env.PYIDE_REGEX_TIMEOUT_MS) || 3000;

exports.register = ({ ipcMain, app, appDir, unpackedDir = appDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'regex-check', 'regex_check.py');
  let side = null;

  function start(interp) {
    const exe = interp.executable || interp.cmd;
    const args = interp.executable ? [] : [...(interp.args || [])];
    // -I: the project's files (a re.py next to nothing, PYTHONPATH) cannot shadow the standard library.
    const s = { key: exe, pending: new Map(), nextId: 1, buf: '', dead: false, stderr: '' };
    s.proc = spawn(exe, [...args, '-I', '-X', 'utf8', '-u', script], { windowsHide: true });
    const fail = (message) => {
      if (s.dead) return;
      s.dead = true;
      for (const p of s.pending.values()) p({ ok: false, error: { kind: 'internal', msg: message, detail: s.stderr.slice(-2000) } });
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
    s.proc.on('exit', (code) => fail(`The regular expression helper exited with code ${code}`));
    s.fail = fail;
    return s;
  }

  function stop(sync = false) {
    if (side && !side.dead) {
      side.fail('The regular expression helper was stopped');
      const { proc } = side;
      if (process.platform !== 'win32' || !proc.pid) {
        try { proc.kill(); } catch {}
      } else if (sync) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      else spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    }
    side = null;
  }

  // JSON with every non-ASCII character escaped, so the helper's stdin encoding never matters.
  const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

  // req: {literal, flags: ['I', ...], mode, text, limit}. Resolves the helper's answer (see regex_check.py) or
  // {ok: false, error: {kind: 'timeout' | 'no-interpreter' | 'internal', msg}}; never rejects.
  ipcMain.handle('regex-check:eval', (_e, interp, req) => {
    if (!interp?.cmd && !interp?.executable) return { ok: false, error: { kind: 'no-interpreter', msg: 'No local Python interpreter' } };
    const key = interp.executable || interp.cmd;
    if (!side || side.dead || side.key !== key) { stop(); side = start(interp); }
    const s = side;
    return new Promise((resolve) => {
      const id = s.nextId++;
      const timer = setTimeout(() => {
        if (!s.pending.delete(id)) return;
        resolve({ ok: false, error: { kind: 'timeout', msg: `No answer in ${TIMEOUT_MS} ms`, ms: TIMEOUT_MS } });
        if (side === s) stop();
      }, TIMEOUT_MS);
      s.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      const text = typeof req?.text === 'string' ? req.text.slice(0, 200000) : '';
      s.proc.stdin.write(`${asciiJson({ id, literal: String(req?.literal || ''), flags: Array.isArray(req?.flags) ? req.flags : [], mode: req?.mode || 'search', text, limit: req?.limit || 1000 })}\n`);
    });
  });
  ipcMain.handle('regex-check:stop', () => stop());
  // The running helper's process id, or null (tests check that it stops with the project).
  ipcMain.handle('regex-check:helperPid', () => (side && !side.dead ? side.proc.pid ?? null : null));
  app.on('will-quit', () => stop(true));
};
