// Main side of the exe-builder plugin: whether PyInstaller is installed in an interpreter, and the PyInstaller command
// line for a build configuration with where its program lands. The build itself runs through run:start like a script.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const remote = require('../remote');
const trust = require('../trust');

const VERSION = 'import PyInstaller\nprint(PyInstaller.__version__)\n';

function pyinstallerVersion(interp) {
  return new Promise((resolve) => execFile(interp.cmd, [...interp.args, '-c', VERSION],
    { encoding: 'utf8', timeout: 60000, cwd: os.tmpdir(), windowsHide: true },
    (err, stdout) => resolve(err ? null : (stdout || '').trim().split(/\r?\n/).pop() || null)));
}

const inRoot = (root, p) => (path.isAbsolute(p) ? p : path.join(root, p));

// opts: {script, name, mode: 'onefile'|'onedir', windowed, icon, data: project paths, extra: argv}
// -> {args, output, dist} | {error: 'script'|'icon'|'data'|'name', path?}
function plan(root, opts) {
  const script = inRoot(root, opts.script);
  if (!fs.existsSync(script)) return { error: 'script', path: script };
  const name = (opts.name || '').replace(/\.exe$/i, '') || path.basename(script).replace(/\.pyw?$/i, '');
  // A file name in dist and a folder in build: "..\x", "a/b" or ".." would put the program and the work files (which
  // --clean empties) elsewhere.
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name) || /^[.\s]*$/.test(name)) return { error: 'name', path: name };
  const dist = path.join(root, 'dist');
  const work = path.join(root, 'build', name);
  const args = ['PyInstaller', '--noconfirm', '--clean', opts.mode === 'onedir' ? '--onedir' : '--onefile', '--name', name,
    '--distpath', dist, '--workpath', work, '--specpath', work];
  if (opts.windowed) args.push('--windowed');
  if (opts.icon) {
    const icon = inRoot(root, opts.icon);
    if (!fs.existsSync(icon)) return { error: 'icon', path: icon };
    args.push('--icon', icon);
  }
  // A file or folder of the project is bundled at the same relative place, so the program finds it next to itself;
  // one from elsewhere goes to the top.
  for (const item of opts.data || []) {
    const src = inRoot(root, item);
    if (!fs.existsSync(src)) return { error: 'data', path: src };
    const dir = fs.statSync(src).isDirectory();
    const rel = path.relative(root, src);
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const dest = inside ? (dir ? rel : path.dirname(rel)) : (dir ? path.basename(src) : '.');
    args.push('--add-data', `${src}${path.delimiter}${dest}`);
  }
  args.push(...(opts.extra || []), script);
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return { args, dist, output: opts.mode === 'onedir' ? path.join(dist, name, exe) : path.join(dist, exe) };
}

// Bytes of a file, or of everything in a folder (a one-folder build is the program and its libraries).
async function sizeOf(p) {
  const st = await fs.promises.stat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const d of await fs.promises.readdir(p, { withFileTypes: true })) total += await sizeOf(path.join(p, d.name));
  return total;
}

exports.register = ({ ipcMain }) => {
  ipcMain.handle('exe-builder:size', (_e, p) => sizeOf(p).catch(() => null));
  // -> {version, ...plan} | {missing: true} | {error}
  ipcMain.handle('exe-builder:prepare', async (_e, interp, root, opts) => {
    if (!interp || remote.isRemote(interp)) return { error: 'remote' };
    if (!root || !trust.isTrusted(root)) return { error: 'untrusted' };
    const p = plan(root, opts);
    if (p.error) return p;
    const version = await pyinstallerVersion(interp);
    return version ? { version, ...p } : { missing: true };
  });
};
