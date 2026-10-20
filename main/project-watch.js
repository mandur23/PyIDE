// Tells a window which project files changed outside the IDE (git pull in a terminal, a script writing output,
// another editor), so the tree and open documents follow the disk. One recursive watcher per window; events are
// batched until 300 ms pass without one, as a checkout produces thousands.
const fs = require('fs');
const path = require('path');
const { allowShare } = require('./security');

// Paths under these folders never matter to the tree or open documents.
const NOISE = /(^|[\\/])(\.git|__pycache__|node_modules|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.tox|\.nox|\.idea)([\\/]|$)/i;

function register({ ipcMain }) {
  const watchers = new Map(); // webContents id -> {close()}

  function watch(sender, root) {
    watchers.get(sender.id)?.close();
    watchers.delete(sender.id);
    if (!root) return false;
    const pending = new Set();
    let overflow = false;
    let timer = null;
    let last = 0;
    let watcher;
    const flush = () => {
      const quiet = Date.now() - last;
      if (quiet < 300) { timer = setTimeout(flush, 300 - quiet); return; }
      timer = null;
      const paths = [...pending].map((n) => path.join(root, n));
      const lost = overflow;
      pending.clear();
      overflow = false;
      if (!sender.isDestroyed()) sender.send('watch:changed', { root, paths, overflow: lost });
    };
    const start = () => {
      try {
        watcher = fs.watch(root, { recursive: true }, (_event, name) => {
          // No name: the change buffer overflowed (a large checkout); everything may have changed.
          if (!name) overflow = true;
          else if (!NOISE.test(name)) pending.add(name);
          else return;
          last = Date.now();
          if (!timer) timer = setTimeout(flush, 300);
        });
        // The project folder was deleted or became unreachable: stop quietly, the window still works.
        watcher.on('error', () => { try { watcher.close(); } catch {} });
      } catch {
        watcher = null;
      }
    };
    start();
    const entry = { close: () => { clearTimeout(timer); try { watcher?.close(); } catch {} } };
    watchers.set(sender.id, entry);
    sender.once('destroyed', () => { if (watchers.get(sender.id) === entry) { entry.close(); watchers.delete(sender.id); } });
    return !!watcher;
  }

  // root: the window's project folder, or null to stop watching. A project on a network share may show its images
  // (main/security.js).
  ipcMain.handle('watch:project', (e, root) => {
    if (root) allowShare(root);
    return watch(e.sender, root && fs.existsSync(root) ? root : null);
  });
}

module.exports = { register };
