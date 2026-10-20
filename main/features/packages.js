const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const remote = require('../remote');
const deps = require('../packages/deps');

const PIP = ['-m', 'pip', '--disable-pip-version-check', '--no-color'];

const parseList = (stdout, stderr, message) => {
  try { return { ok: true, packages: JSON.parse(stdout) }; } catch {}
  return { ok: false, error: (stderr || message || 'pip list failed').trim() };
};

// Installed distributions and the PEP 508 marker variables of an interpreter. importlib.metadata, not pip: venvs
// made by uv have no pip. The current directory is left off sys.path so the project's own metadata does not count.
const PROBE = `
import json, os, platform, sys
cwd = os.getcwd()
sys.path[:] = [p for p in sys.path if p not in ('', '.', cwd)]
from importlib import metadata
pk = {}
for d in metadata.distributions():
    try:
        n = d.metadata['Name']
    except Exception:
        n = None
    if n and n.lower() not in pk:
        pk[n.lower()] = [n, d.version]
impl = sys.implementation
iv = '%d.%d.%d' % tuple(impl.version[:3])
if impl.version.releaselevel != 'final':
    iv += impl.version.releaselevel[0] + str(impl.version.serial)
env = dict(implementation_name=impl.name, implementation_version=iv, os_name=os.name, platform_machine=platform.machine(),
           platform_release=platform.release(), platform_system=platform.system(), platform_version=platform.version(),
           python_full_version=platform.python_version(), platform_python_implementation=platform.python_implementation(),
           python_version='.'.join(platform.python_version_tuple()[:2]), sys_platform=sys.platform, extra='')
print(json.dumps({'packages': list(pk.values()), 'env': env}))
`;

const interpKey = (interp) => interp.executable || [interp.cmd, ...interp.args].join(' ');

// uv / poetry: next to the interpreter (the Install Manager installs uv there with pip), on PATH, or in the
// folders their own installers use.
function findTool(name, interp) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  const dirs = [
    ...(interp?.executable && !remote.isRemote(interp) ? [path.dirname(interp.executable)] : []),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'Python', 'Scripts')] : []),
  ];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

// The virtual environment an interpreter belongs to, or null for a base interpreter.
function venvOf(executable) {
  if (!executable) return null;
  const dir = path.dirname(executable);
  const root = /^(scripts|bin)$/i.test(path.basename(dir)) ? path.dirname(dir) : dir;
  return fs.existsSync(path.join(root, 'pyvenv.cfg')) ? root : null;
}

exports.register = (ctx) => {
  const { ipcMain, startProcess } = ctx;
  // -> {ok, packages: [{name, version}]} | {ok: false, error}
  ipcMain.handle('packages:list', async (_e, interp) => {
    if (remote.isRemote(interp)) {
      const r = await remote.execPython(interp, [...PIP, 'list', '--format=json'], { timeout: 120000 });
      return parseList(r.stdout, r.stderr);
    }
    return new Promise((resolve) => {
      execFile(interp.cmd, [...interp.args, ...PIP, 'list', '--format=json'],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
        (err, stdout, stderr) => resolve(parseList(stdout, stderr, err?.message)));
    });
  });

  const pip = (interp, args) => (remote.isRemote(interp)
    ? remote.startPython(ctx, interp, [...PIP, ...args], {})
    : startProcess(interp.cmd, [...interp.args, ...PIP, ...args], {}));
  ipcMain.handle('packages:install', (_e, interp, spec) => pip(interp, ['install', spec]));
  ipcMain.handle('packages:upgrade', (_e, interp, name) => pip(interp, ['install', '--upgrade', name]));
  ipcMain.handle('packages:uninstall', (_e, interp, name) => pip(interp, ['uninstall', '-y', name]));

  // ---------- project dependencies ----------
  const installedCache = new Map(); // interpKey -> Promise<{ok, packages: Map, env} | {ok: false, error}>
  function installed(interp, fresh) {
    const key = interpKey(interp);
    if (!fresh && installedCache.has(key)) return installedCache.get(key);
    const parse = (stdout, stderr, message) => {
      try {
        const r = JSON.parse(stdout.trim().split(/\r?\n/).pop());
        return { ok: true, env: r.env, packages: new Map(r.packages.map(([name, version]) => [deps.normName(name), { name, version }])) };
      } catch { return { ok: false, error: (stderr || message || 'could not list the installed packages').trim() }; }
    };
    const job = remote.isRemote(interp)
      ? remote.execPython(interp, ['-c', PROBE], { timeout: 120000 }).then((r) => parse(r.stdout || '', r.stderr))
      : new Promise((resolve) => execFile(interp.cmd, [...interp.args, '-c', PROBE],
        { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, cwd: os.tmpdir(), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
        (err, stdout, stderr) => resolve(parse(stdout || '', stderr, err?.message))));
    installedCache.set(key, job);
    job.then((r) => { if (!r.ok && installedCache.get(key) === job) installedCache.delete(key); });
    return job;
  }

  // The dependency files of the project root checked against the interpreter.
  // opts: {texts: {path: unsaved text}, fresh: re-read the installed packages}
  // -> {manager: 'pip'|'uv'|'poetry', lock, tool: {name, path|null}|null, files: [{path, kind, reqs: [{name, spec, raw,
  //     line, col, endCol, status: 'ok'|'missing'|'outdated', installed}]}], error?}
  ipcMain.handle('packages:deps', async (_e, root, interp, opts = {}) => {
    const found = deps.detect(root, opts.texts);
    const isRemote = interp && remote.isRemote(interp);
    const tool = found.manager === 'pip' || isRemote ? null : { name: found.manager, path: findTool(found.manager, interp) };
    const base = { manager: isRemote ? 'pip' : found.manager, lock: found.lock, tool };
    // editable: "Add to requirements" can write to it (requirements.txt, pyproject.toml with a [project] table).
    const files = (checked) => found.files.map((f, i) => ({ path: f.path, kind: f.kind, editable: f.kind === 'requirements' || !!f.hasProject, reqs: checked?.[i].reqs || [] }));
    if (!found.files.length || !interp) return { ...base, files: files() };
    const inst = await installed(interp, opts.fresh);
    if (!inst.ok) return { ...base, files: files(), error: inst.error };
    return { ...base, files: files(deps.check(found.files, inst.packages, inst.env)) };
  });

  // Installs what a dependency file declares, with the project's manager, in a process the renderer shows.
  // opts: {file, kind, specs?: only these requirement strings (a quick fix), unsatisfied: the file's unsatisfied
  // requirement strings (installed instead of the file where pip cannot read it), pip?: use pip anyway}
  // -> {id, command} | {error}
  ipcMain.handle('packages:depsInstall', async (_e, root, interp, opts) => {
    const { file, kind, specs } = opts;
    const wanted = specs || opts.unsatisfied || [];
    const isRemote = remote.isRemote(interp);
    const manager = opts.pip || isRemote ? 'pip' : deps.detect(root).manager;
    const exe = interp.executable;
    const venv = isRemote ? null : venvOf(exe);
    const env = {};
    let cwd = root;
    let cmd;
    let args;
    if (manager === 'uv' || (manager === 'poetry' && kind === 'pyproject' && !specs)) {
      cmd = findTool(manager, interp);
      if (!cmd) return { error: `${manager} not found` };
      if (manager === 'poetry') {
        args = ['install', '--no-root'];
        if (venv) env.VIRTUAL_ENV = venv;
      } else if (specs || kind === 'pipfile') args = ['pip', 'install', '--python', exe, ...wanted];
      else if (kind === 'pyproject' && venv) {
        // Into the selected interpreter's venv; --inexact keeps packages the lock file does not list.
        args = ['sync', '--inexact'];
        env.UV_PROJECT_ENVIRONMENT = venv;
      } else {
        args = ['pip', 'install', '--python', exe, '-r', file];
        cwd = path.dirname(file);
      }
    } else {
      cmd = interp.cmd;
      if (kind === 'requirements' && !specs && !isRemote) {
        args = [...interp.args, ...PIP, 'install', '-r', file];
        cwd = path.dirname(file);
      } else args = [...interp.args, ...PIP, 'install', ...wanted];
    }
    const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
    const command = (cmd === interp.cmd
      ? ['python', '-m', 'pip', ...args.slice(interp.args.length + PIP.length)]
      : [path.basename(cmd).replace(/\.(exe|cmd|bat)$/i, ''), ...args]).map(quote).join(' ');
    if (isRemote) return { id: await remote.startPython(ctx, interp, args.slice(interp.args.length), {}), command };
    return { id: startProcess(cmd, args, { cwd, env }), command };
  });

  // The text of a dependency file with one more requirement (requirements.txt line, pyproject.toml array item).
  ipcMain.handle('packages:depsAdd', (_e, kind, text, requirement) => deps.addRequirement(kind, text, requirement));
};
