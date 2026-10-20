// Trusted projects, like PyCharm's "Trust and Open Project". Opening a folder must not run code it ships: until the
// user trusts it, PyIDE does not start the project's own virtualenv Python (interpreter discovery runs it), lets its
// .git/config run nothing through git (core.fsmonitor), and loads no .env from it. Trusting a folder trusts what is
// inside it. The list lives in <userData>/trusted-projects.json.
const fs = require('fs');
const path = require('path');

let file = null;
let roots = null; // lower-cased absolute folders

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isUnder = (p, root) => p === root || p.startsWith(root + path.sep);

function load(userData) {
  file = path.join(userData, 'trusted-projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(list)) { roots = list.filter((p) => typeof p === 'string').map(norm); return; }
  } catch (err) {
    if (err.code !== 'ENOENT') { roots = []; return; } // unreadable: trust nothing rather than everything
  }
  // First run with this feature: the projects the user already opened stay trusted, so nobody is asked about them.
  roots = [];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    for (const r of settings?.recentProjects || []) if (typeof r?.path === 'string') roots.push(norm(r.path));
  } catch {}
  save();
}

function save() {
  try { fs.writeFileSync(file, JSON.stringify([...new Set(roots)], null, 1)); } catch {}
}

function isTrusted(dir) {
  if (process.env.PYIDE_TRUST_ALL === '1') return true;
  if (!dir || !roots) return false;
  const p = norm(dir);
  return roots.some((r) => isUnder(p, r));
}

function trust(dir) {
  if (!dir) return;
  roots.push(norm(dir));
  save();
}

function register({ ipcMain, app }) {
  load(app.getPath('userData'));
  ipcMain.handle('trust:isTrusted', (_e, dir) => isTrusted(dir));
  ipcMain.handle('trust:add', (_e, dir) => { trust(dir); return true; });
}

module.exports = { register, isTrusted, trust };
