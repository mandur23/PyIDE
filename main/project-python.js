// Whether a project has anything of Python in it: a marker file or a virtual environment at its top, or a Python file
// within a few folders. The IDE shows its Python parts (the interpreter in the status bar, the Workspace's virtual
// environments, Pyright) only then: a Java or web project is not offered a Python it does not use.
const fs = require('fs');
const path = require('path');

const MARKERS = new Set(['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pipfile', 'poetry.lock', 'uv.lock',
  'manage.py', 'tox.ini', 'pytest.ini', '.python-version', 'environment.yml', 'conftest.py']);
const VENV_DIRS = new Set(['.venv', 'venv', 'env', '.env']);
// Folders that hold what a build or a package manager wrote, not the project's own sources.
const SKIP = new Set(['node_modules', '.git', '.gradle', '.idea', '.vscode', 'build', 'dist', 'target', 'out', 'bin', 'obj',
  '__pycache__', '.next', '.nuxt', 'vendor']);
const PYTHON_FILE = /\.(py|pyw|pyi|ipynb|pyflow)$/i;
const DEPTH = 4;
const BUDGET = 4000; // entries looked at before the answer is no

async function usesPython(root) {
  if (typeof root !== 'string' || !root) return true;
  let left = BUDGET;
  let level = [root];
  for (let depth = 0; depth <= DEPTH && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      // A project that cannot be read (a share that does not answer) is not known to be without Python.
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { if (depth === 0) return true; continue; }
      for (const e of entries) {
        if (--left < 0) return false;
        const name = e.name.toLowerCase();
        if (e.isDirectory()) {
          if (depth === 0 && VENV_DIRS.has(name) && fs.existsSync(path.join(dir, e.name, 'pyvenv.cfg'))) return true;
          if (!SKIP.has(name) && !name.startsWith('.')) next.push(path.join(dir, e.name));
        } else if (PYTHON_FILE.test(name) || (depth === 0 && (MARKERS.has(name) || /^requirements[\w.-]*\.txt$/.test(name)))) return true;
      }
    }
    level = next;
  }
  return false;
}

module.exports = { usesPython };
