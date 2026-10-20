// Directory scans behind the core fs handlers (the project tree's folder listing, Go to File's project walk and the
// interpreter list's virtualenv search) and the interpreter probes. They run on a worker thread (main/worker-host.js
// evaluates this file with the role checked below): a 10,000-entry folder or a 20,000-file project otherwise stalls
// every IPC call for tens of milliseconds, and so does starting each Python (a spawn costs the thread that makes it
// 15 ms). The worker's results arrive as plain data the handlers return as they are.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { isMainThread, parentPort, workerData } = require('worker_threads');

const IGNORED = new Set(['.git', '__pycache__', 'node_modules', '.idea', '.mypy_cache', '.pytest_cache', '.ruff_cache']);
// Virtual environments are folders with a pyvenv.cfg; they are never part of the project's own sources.
const isVenv = (dir) => fs.existsSync(path.join(dir, 'pyvenv.cfg'));

// A junction or a symbolic link (mklink /J data D:\data) to a folder is a folder in the project tree, which lists it
// when it is opened; the project walks below do not follow links, so a link back to the project cannot loop them.
const isFolderLink = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const SCANS = {
  // Entries of one folder, folders first: [{name, path, dir}].
  list: (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => !IGNORED.has(d.name))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() || (d.isSymbolicLink() && isFolderLink(path.join(dir, d.name))) }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)),
  // Every file under root (at most 20,000), skipping caches, virtualenvs and the excluded folders.
  walk(root, excludedDirs = []) {
    const out = [];
    const excluded = new Set(excludedDirs.map((d) => d.toLowerCase()));
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= 20000) return;
        if (IGNORED.has(d.name) || ['.venv', 'venv', 'env'].includes(d.name)) continue;
        const p = path.join(dir, d.name);
        if (d.isDirectory() && (isVenv(p) || excluded.has(p.toLowerCase()))) continue;
        if (d.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(root);
    return out;
  },
  // Every venv in the project, up to two levels deep (.venv, .venv-rvc, ai/.venv...), nearest first.
  venvs(root) {
    const venvs = [];
    const scan = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        if (!d.isDirectory() || IGNORED.has(d.name)) continue;
        const p = path.join(dir, d.name);
        if (isVenv(p)) venvs.push(p);
        else if (depth < 2) scan(p, depth + 1);
      }
    };
    scan(root, 1);
    return venvs.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  },
  ping: () => true,
  // Version, real executable and base interpreter (itself, or the one a venv was made from) of the Python that
  // `cmd args` starts; null when it does not start.
  probe: (cmd, args) => new Promise((resolve) => {
    execFile(cmd, [...args, '-c', 'import sys,platform;print(platform.python_version());print(sys.executable);print(getattr(sys, "_base_executable", sys.executable))'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, out) => {
        const lines = err ? [] : out.trim().split(/\r?\n/);
        resolve(lines[1] ? { version: lines[0], executable: lines[1], base: lines[2] || lines[1] } : null);
      });
  }),
};
if (!isMainThread && workerData?.role === 'pyide-fs') {
  parentPort.on('message', ({ id, op, args }) => {
    Promise.resolve().then(() => SCANS[op](...args))
      .then((result) => parentPort.postMessage({ id, result }), (e) => parentPort.postMessage({ id, error: e.message }));
  });
}

// Main side: scan(op, ...args) -> Promise of the result above. The worker boots now, while the window is still
// loading, so the first folder listing (the project tree at startup) does not wait the 50 ms a worker takes to start.
const scan = isMainThread ? require('./worker-host').fileWorker(__filename, 'pyide-fs') : null;
if (scan) scan('ping').catch(() => {});
module.exports = { scan };
