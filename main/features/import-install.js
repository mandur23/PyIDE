// Main side of the import-install plugin: whether an import name is one of the project's own modules, and the
// version of a distribution once it is installed (for "Install and add to requirements").
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const remote = require('../remote');
const trust = require('../trust');
const { scan } = require('../fs-scan');

// The project's files from the worker walk (venvs and caches left out), kept for a few seconds: the lightbulb asks
// on caret moves.
const walks = new Map(); // root lower-case -> {at, files: Promise<string[]>}
function projectFiles(root) {
  const key = root.toLowerCase();
  const hit = walks.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.files;
  const files = scan('walk', root).catch(() => []);
  walks.set(key, { at: Date.now(), files });
  return files;
}

// A module `name` exists in the project: name.py / name.pyi / an extension module, or a folder `name` holding Python
// files (a package, also a namespace package), anywhere in the project.
async function isLocalModule(root, name) {
  if (!root || !/^[A-Za-z_][\w]*$/.test(name)) return false;
  const lower = name.toLowerCase();
  for (const file of await projectFiles(root)) {
    const base = path.basename(file);
    const ext = path.extname(base).toLowerCase();
    const stem = base.slice(0, base.length - ext.length);
    if (['.py', '.pyi'].includes(ext) && path.basename(path.dirname(file)).toLowerCase() === lower) return true;
    // Windows file names ignore case, and so does Python's import of them here.
    if (ext === '.pyd' ? stem.split('.')[0].toLowerCase() === lower : ['.py', '.pyi'].includes(ext) && stem.toLowerCase() === lower) return true;
  }
  return false;
}

const VERSION = 'import sys\nfrom importlib import metadata\ntry:\n    print(metadata.version(sys.argv[1]))\nexcept Exception:\n    print("")\n';

exports.register = ({ ipcMain }) => {
  ipcMain.handle('import-install:isLocal', (_e, root, name) => isLocalModule(root, name));
  // -> the installed version of a distribution in the interpreter, or null.
  ipcMain.handle('import-install:version', async (_e, root, interp, dist) => {
    if (!interp || !trust.isTrusted(root)) return null;
    const pick = (out) => (out || '').trim().split(/\r?\n/).pop() || null;
    if (remote.isRemote(interp)) return pick((await remote.execPython(interp, ['-c', VERSION, dist], { timeout: 60000 })).stdout);
    return new Promise((resolve) => execFile(interp.cmd, [...interp.args, '-c', VERSION, dist],
      { encoding: 'utf8', timeout: 60000, cwd: os.tmpdir(), windowsHide: true }, (_err, stdout) => resolve(pick(stdout))));
  });
};
