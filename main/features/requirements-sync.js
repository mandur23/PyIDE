// Main side of the requirements-sync plugin: the project's third-party imports, read with Python's own parser in the
// project interpreter, with the installed distributions that provide each one (importlib.metadata), and the top-level
// modules of the distributions the requirements declare. The interpreter only reads: nothing is installed or run.
const { execFile } = require('child_process');
const os = require('os');
const remote = require('../remote');
const trust = require('../trust');

// argv: root, JSON list of declared distribution names. Prints
// {imports: {top: {where: [[file, line]], modules: [imported names], dists: [[name, version]]}}, provides: {declared
// name: [tops]}}.
// Folders of tools and environments are skipped; a module of the project (any .py file or package folder in it) and the
// standard library are not third-party. try/except fallbacks count too: they are imports the program may make.
const SCAN = String.raw`
import ast, json, os, sys
root, declared = sys.argv[1], json.loads(sys.argv[2])
cwd = os.getcwd()
sys.path[:] = [p for p in sys.path if p not in ('', '.', cwd, root)]
SKIP = {'node_modules', '__pycache__', 'site-packages', 'build', 'dist', 'venv', 'env'}
imports, modules, local = {}, {}, set()
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith('.')
                   and not os.path.exists(os.path.join(dirpath, d, 'pyvenv.cfg'))]
    if dirpath != root and any(f.endswith(('.py', '.pyi')) for f in filenames):
        local.add(os.path.basename(dirpath))
    for f in filenames:
        stem, ext = os.path.splitext(f)
        if ext in ('.py', '.pyi', '.pyd'):
            local.add(stem.split('.')[0])
        if ext != '.py':
            continue
        path = os.path.join(dirpath, f)
        try:
            with open(path, 'rb') as fh:
                tree = ast.parse(fh.read(), path)
        except Exception:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
                names = [node.module]
            else:
                continue
            for name in names:
                modules.setdefault(name.split('.')[0], set()).add(name)
                where = imports.setdefault(name.split('.')[0], [])
                if len(where) < 3:
                    where.append([os.path.relpath(path, root), node.lineno])
std = set(getattr(sys, 'stdlib_module_names', ())) | set(sys.builtin_module_names) | {'__future__'}
if not getattr(sys, 'stdlib_module_names', None):
    import importlib.util, sysconfig
    lib = os.path.normcase(sysconfig.get_paths()['stdlib'])
    for top in imports:
        try:
            spec = importlib.util.find_spec(top)
        except Exception:
            spec = None
        origin = os.path.normcase(getattr(spec, 'origin', None) or '')
        if spec and (origin in ('built-in', 'frozen') or (origin.startswith(lib) and 'site-packages' not in origin)):
            std.add(top)
from importlib import metadata
try:
    pd = metadata.packages_distributions()
except AttributeError:
    pd = {}
    for d in metadata.distributions():
        for top in (d.read_text('top_level.txt') or '').split():
            pd.setdefault(top, []).append(d.metadata['Name'])
def version(name):
    try:
        return metadata.version(name)
    except Exception:
        return None
out = {}
for top, where in imports.items():
    if top in std or top in local or top.startswith('_'):
        continue
    names = list(dict.fromkeys(pd.get(top, [])))
    out[top] = {'where': where, 'modules': sorted(modules[top])[:20], 'dists': [[n, version(n)] for n in names]}
import re
norm = lambda s: re.sub(r'[-_.]+', '-', s.lower())
provides = {}
for top, names in pd.items():
    for n in names:
        provides.setdefault(norm(n), set()).add(top)
print(json.dumps({'imports': out, 'provides': {d: sorted(provides.get(norm(d), ())) for d in declared}}))
`;

exports.register = ({ ipcMain }) => {
  // -> {imports, provides} | {error}
  ipcMain.handle('requirements-sync:scan', (_e, root, interp, declared = []) => {
    if (!interp || remote.isRemote(interp)) return { error: 'remote' };
    if (!root || !trust.isTrusted(root)) return { error: 'untrusted' };
    return new Promise((resolve) => execFile(interp.cmd, [...interp.args, '-c', SCAN, root, JSON.stringify(declared)],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, cwd: os.tmpdir(), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        try { resolve(JSON.parse((stdout || '').trim().split(/\r?\n/).pop())); } catch { resolve({ error: (stderr || err?.message || 'scan failed').trim().slice(-2000) }); }
      }));
  });
};
