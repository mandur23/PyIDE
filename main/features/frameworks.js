// Django, Flask and FastAPI backend: the static project inspector (pyide_frameworks.py, run with the project
// interpreter), `manage.py help --commands`, readiness probes for dev servers, and framing for the browser pane.
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { session } = require('electron');
const { withPath } = require('./run.js');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);

function runPython(interp, args, { cwd, env, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(interp.cmd, [...interp.args, ...args], {
      cwd, env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' }, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr), error: err?.message }));
  });
}

// Resolves with the HTTP status once something answers at `url`, or null when nothing did before the deadline.
function probe(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(url, { timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => (Date.now() > end ? resolve(null) : setTimeout(attempt, 250)));
    };
    attempt();
  });
}

exports.register = ({ ipcMain, app, unpackedDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'frameworks', 'pyide_frameworks.py');

  ipcMain.handle('frameworks:inspect', async (_e, interp, root) => {
    const r = await runPython(interp, ['-I', script, root], { cwd: root });
    if (!r.ok) return { ok: false, error: (r.stderr.trim().split('\n').pop() || r.error || '').trim() };
    try { return { ok: true, info: JSON.parse(r.stdout) }; } catch (err) { return { ok: false, error: err.message }; }
  });

  // Command names, one per line, as `manage.py help --commands` prints them; the error text when Django fails to load.
  ipcMain.handle('frameworks:manageCommands', async (_e, interp, manage, env = {}, roots = []) => {
    const r = await runPython(interp, [manage, 'help', '--commands'], { cwd: path.dirname(manage), env: withPath(env, roots) });
    if (!r.ok) return { ok: false, error: r.stderr.trim().split('\n').slice(-3).join('\n') || r.error };
    return { ok: true, commands: r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[\w-]+$/.test(s)) };
  });

  ipcMain.handle('frameworks:probe', (_e, url, timeoutMs = 30000) => probe(url, timeoutMs));

  // Dev servers refuse to be framed (Django sends X-Frame-Options: DENY); the browser pane frames only loopback pages.
  app.whenReady().then(() => session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let host = '';
    try { host = new URL(details.url).hostname; } catch {}
    if (details.resourceType !== 'subFrame' || !LOOPBACK.has(host)) return callback({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      const key = k.toLowerCase();
      if (key === 'x-frame-options') continue;
      headers[k] = key === 'content-security-policy' ? v.map((p) => p.replace(/frame-ancestors[^;]*;?/gi, '')) : v;
    }
    callback({ responseHeaders: headers });
  }));
};
