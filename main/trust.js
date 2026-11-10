// Trusted projects, like PyCharm's "Trust and Open Project". Opening a folder must not run code it ships: until the
// user trusts it, PyIDE does not start the project's own virtualenv Python (interpreter discovery runs it), lets its
// .git/config run nothing through git (core.fsmonitor), and loads no .env from it. Trusting a folder trusts what is
// inside it. The list lives in <userData>/trusted-projects.json.
const fs = require('fs');
const path = require('path');
const { readStore, writeStore } = require('./json-store');

let file = null;
let roots = null; // lower-cased absolute folders
// The file is there but could not be read (locked, no permission): it is not written over, and the folders trusted
// meanwhile stay trusted for this session; each later trust reads it again.
let unread = false;

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isUnder = (p, root) => p === root || p.startsWith(root + path.sep);
const readList = () => readStore(file, Array.isArray);
const fromFile = (list) => list.filter((p) => typeof p === 'string').map(norm);

function load(userData) {
  file = path.join(userData, 'trusted-projects.json');
  const r = readList();
  unread = !r;
  // unreadable or corrupt: trust nothing rather than everything
  if (!r || r.corrupt) { roots = []; return; }
  if (r.value) { roots = fromFile(r.value); return; }
  // First run with this feature: the projects the user already opened stay trusted, so nobody is asked about them.
  roots = [];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    for (const r of settings?.recentProjects || []) if (typeof r?.path === 'string') roots.push(norm(r.path));
  } catch {}
  save();
}

function save() {
  if (unread) {
    const r = readList();
    if (!r) return;
    unread = false;
    if (r.value) roots = [...fromFile(r.value), ...roots];
  }
  try { writeStore(file, [...new Set(roots)]); } catch {}
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

// What starts when Windows opens it (for a shortcut, what it points to), for Open with Default App. Windows drops
// trailing dots and spaces, so `tool.exe.` opens tool.exe.
const RUNS_WHEN_OPENED = /\.(exe|com|scr|pif|cpl|msc|msi|msp|appx|msix|appref-ms|application|bat|cmd|ps1|psm1|vbs|vbe|js|jse|ws|wsf|wsh|hta|lnk|url|scf|reg|inf|jar|py|pyw|pyz|settingcontent-ms|library-ms|diagcab)$/i;
const runsWhenOpened = (p) => RUNS_WHEN_OPENED.test(String(p).replace(/[. ]+$/, ''));
// What an untrusted project may open with its default app without asking: plain documents and media. A list of what
// runs can never be complete (.pyc, .chm, .sh and Office files with macros or remote templates were all missing), so
// everything else asks first. A colon in the name is an alternate data stream (`report.pdf:x`), never a plain document.
const INERT = /\.(pdf|txt|text|log|md|markdown|csv|tsv|json|png|jpe?g|gif|bmp|webp|ico|tiff?|avif|heic|mp3|wav|flac|ogg|oga|m4a|aac|opus|wma|mp4|m4v|mkv|mov|avi|webm|wmv)$/i;
// -> 'program' (refused in Safe Mode), 'document' (opens) or 'ask' (opens after the user agrees).
function openKind(p) {
  if (runsWhenOpened(p)) return 'program';
  const name = path.basename(String(p).replace(/[. ]+$/, ''));
  return !name.includes(':') && INERT.test(name) ? 'document' : 'ask';
}

function register({ ipcMain, app }) {
  load(app.getPath('userData'));
  ipcMain.handle('trust:isTrusted', (_e, dir) => isTrusted(dir));
  ipcMain.handle('trust:add', (_e, dir) => { trust(dir); return true; });
}

module.exports = { register, isTrusted, trust, runsWhenOpened, openKind };
