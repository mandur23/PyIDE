const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const trust = require('../trust');

// Symbols for the node palette (renderer/features/visual-script/python/vs_symbols.py, run in the project interpreter
// with -I). Project files are read with `ast` only and cached per project by path, modification time and size, so a
// refresh after a save parses only what changed. A package module is imported to be described, so only one that
// resolves outside the project folder is (the script checks where it would load from before importing anything), with
// a 10 s limit, cached per interpreter. Nothing runs for a project the user has not trusted (Safe Mode).
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '__pycache__', 'node_modules', '.idea', '.vscode', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.venv', 'venv', 'env', 'site-packages', '.eggs', 'build', 'dist']);
const MAX_FILES = 3000;
const MAX_BYTES = 1024 * 1024;
const PROJECT_SECONDS = 20;
const MODULE_MS = 10000;
const MARKER = '@@PYIDE-VS@@';
const IDENT = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const DOTTED = /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u;

const validInterp = (i) => i && typeof i.cmd === 'string' && i.cmd && (i.args === undefined || (Array.isArray(i.args) && i.args.every((a) => typeof a === 'string')));
const interpKey = (i) => JSON.stringify([i.cmd.toLowerCase(), i.args || []]);

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  else try { proc.kill('SIGKILL'); } catch {}
}

// Runs the helper; resolves {stdout, stderr, code, timedOut}.
function runHelper(script, interp, args, { input = '', timeoutMs }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(interp.cmd, [...(interp.args || []), '-I', '-X', 'utf8', script, ...args], {
        windowsHide: true, cwd: path.dirname(script),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      });
    } catch (err) {
      resolve({ stdout: '', stderr: err.message, code: -1, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(proc); }, timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr: err.message, code: -1, timedOut }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); });
    proc.stdin.end(input);
  });
}
const marked = (stdout) => {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(MARKER));
  try { return line ? JSON.parse(line.slice(MARKER.length)) : null; } catch { return null; }
};

async function isVenv(dir) {
  for (const marker of ['pyvenv.cfg', 'conda-meta']) {
    try { await fs.promises.access(path.join(dir, marker)); return true; } catch {}
  }
  return false;
}

// The project's .py files (at most MAX_FILES, none over MAX_BYTES), with their module names: `pkg.sub.mod` from the
// project root, or from root/src in a src layout.
async function projectFiles(root) {
  const srcRoot = path.join(root, 'src');
  let srcLayout = false;
  try { srcLayout = (await fs.promises.stat(srcRoot)).isDirectory() && !fs.existsSync(path.join(srcRoot, '__init__.py')); } catch {}
  const files = [];
  let truncated = false;
  const moduleOf = (file) => {
    const base = srcLayout && file.toLowerCase().startsWith(srcRoot.toLowerCase() + path.sep) ? srcRoot : root;
    const parts = path.relative(base, file).replace(/\.py$/i, '').split(path.sep);
    if (parts[parts.length - 1] === '__init__') parts.pop();
    return parts.length && parts.every((p) => IDENT.test(p)) ? parts.join('.') : null;
  };
  const walk = async (dir) => {
    if (truncated) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs = [];
    for (const d of entries) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.') && !/^\.?venv/i.test(d.name)) dirs.push(p);
      } else if (d.isFile() && /\.py$/i.test(d.name)) {
        const module = moduleOf(p);
        if (!module) continue;
        if (files.length >= MAX_FILES) { truncated = true; return; }
        files.push({ path: p, module });
      }
    }
    for (const p of dirs) if (!(await isVenv(p))) await walk(p);
  };
  await walk(root);
  return { files, truncated };
}

// A JDK to run Java visual scripts with (`java File.java`, source-file mode, needs Java 11): JAVA_HOME, a JDK PyIDE
// installed under ~/.pyide, java on PATH, then the usual install folders. -> {java, version} or {error}.
async function findJava() {
  const os = require('os');
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  const own = path.join(process.env.PYIDE_INSTALL_ROOT || path.join(os.homedir(), '.pyide'));
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'bin' && fs.existsSync(path.join(p, 'java.exe')) && fs.existsSync(path.join(p, 'javac.exe'))) candidates.push(path.join(p, 'java.exe'));
      else walk(p, depth - 1);
    }
  };
  walk(own, 4);
  candidates.push('java');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft']) walk(path.join(pf, vendor), 2);
  for (const java of candidates) {
    const r = await runHelperless(java, ['-version']);
    const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(r);
    if (!m) continue;
    const major = Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]);
    if (major >= 11) return { java, version: major };
  }
  return { error: 'No JDK 11 or newer was found. Install one (or set JAVA_HOME) to run Java visual scripts.' };
}
const runHelperless = (cmd, args) => new Promise((resolve) => {
  let out = '';
  let proc;
  try { proc = spawn(cmd, args, { windowsHide: true }); } catch { resolve(''); return; }
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  proc.on('error', () => resolve(''));
  proc.on('close', () => resolve(out));
});

exports.register = ({ ipcMain, app, appDir, unpackedDir = appDir, startProcess }) => {
  // The Python a visual script runs as: <userData>/visual-script/<sha1 of the .pyflow path>/<name>_pyflow.py. One
  // folder per script keeps the script's name in tracebacks while two demo.pyflow files in different folders never
  // share a file. The path is hashed in lower case because Windows paths are case-insensitive. Python puts the
  // script's folder first on sys.path, so the file is never named like a module: random.py would be imported by any
  // `import random`, including one deep inside another module (json imports re), instead of the real module.
  ipcMain.handle('visual-script:write', (_e, pyflowPath, code) => {
    if (typeof pyflowPath !== 'string' || !path.isAbsolute(pyflowPath) || typeof code !== 'string') throw new Error('visual-script:write needs an absolute .pyflow path and the code');
    const hash = crypto.createHash('sha1').update(path.resolve(pyflowPath).toLowerCase()).digest('hex');
    const dir = path.join(app.getPath('userData'), 'visual-script', hash);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(pyflowPath).replace(/\.pyflow$/i, '') || 'script';
    const file = path.join(dir, `${base}_pyflow.py`);
    // A file an older version wrote here as <name>.py would still shadow the module.
    for (const old of fs.readdirSync(dir)) {
      if (/\.py$/i.test(old) && old !== path.basename(file)) fs.rmSync(path.join(dir, old), { force: true });
    }
    fs.writeFileSync(file, code, 'utf8');
    // The long form of the path: debugpy reports frames by it, so a user data folder reached through an 8.3 short
    // name (C:\Users\RUNNER~1\…) would otherwise not match the file the script registered its breakpoints on.
    return fs.realpathSync.native(file);
  });

  // A Java visual script runs as <userData>/visual-script/<sha1 of the .jflow path>/<name>_jflow.java in source-file
  // mode, which takes any file name for the class it declares.
  const javaDir = (jflowPath) => path.join(app.getPath('userData'), 'visual-script', crypto.createHash('sha1').update(path.resolve(jflowPath).toLowerCase()).digest('hex'));
  ipcMain.handle('visual-script:writeJava', (_e, jflowPath, code) => {
    if (typeof jflowPath !== 'string' || !path.isAbsolute(jflowPath) || typeof code !== 'string') throw new Error('visual-script:writeJava needs an absolute .jflow path and the code');
    const dir = javaDir(jflowPath);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${path.basename(jflowPath).replace(/\.jflow$/i, '') || 'script'}_jflow.java`);
    for (const old of fs.readdirSync(dir)) if (/\.java$/i.test(old) && old !== path.basename(file)) fs.rmSync(path.join(dir, old), { force: true });
    fs.writeFileSync(file, code, 'utf8');
    return fs.realpathSync.native(file);
  });
  let javaFound = null;
  ipcMain.handle('visual-script:java', async (_e, { refresh = false } = {}) => {
    if (!javaFound || refresh || javaFound.error) javaFound = await findJava();
    return javaFound;
  });
  // Runs a generated file of visual-script:writeJava with the JDK visual-script:java found; output and exit stream as a
  // process of the IDE (ide.proc).
  ipcMain.handle('visual-script:runJava', async (_e, { file, cwd, params = [], env = {} } = {}) => {
    const base = path.join(app.getPath('userData'), 'visual-script');
    if (typeof file !== 'string' || !path.resolve(file).toLowerCase().startsWith(base.toLowerCase() + path.sep) || !/_jflow\.java$/i.test(file)) throw new Error('visual-script:runJava runs only generated Java files');
    const found = javaFound && !javaFound.error ? javaFound : (javaFound = await findJava());
    if (found.error) return { error: found.error };
    const args = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', file, ...params.map(String)];
    const id = startProcess(found.java, args, { cwd: typeof cwd === 'string' && fs.existsSync(cwd) ? cwd : path.dirname(file), env: { ...env } });
    return { id, java: found.java, args };
  });

  const script = path.join(unpackedDir, 'renderer', 'features', 'visual-script', 'python', 'vs_symbols.py');
  const parsed = new Map(); // lower-case root -> Map(lower-case path -> {mtimeMs, size, module, result})
  const queues = new Map(); // lower-case root -> the scan running now
  const modules = new Map(); // interpreter + module name -> {ok, module}
  const packageLists = new Map(); // interpreter -> names

  async function scan(root, interp) {
    const started = Date.now();
    const { files, truncated } = await projectFiles(root);
    const cache = parsed.get(root.toLowerCase()) || new Map();
    parsed.set(root.toLowerCase(), cache);
    const seen = new Set();
    const need = [];
    const skipped = [];
    for (const f of files) {
      const k = f.path.toLowerCase();
      seen.add(k);
      let st;
      try { st = await fs.promises.stat(f.path); } catch { continue; }
      if (st.size > MAX_BYTES) { skipped.push(f.module); cache.delete(k); continue; }
      const c = cache.get(k);
      if (c && c.mtimeMs === st.mtimeMs && c.size === st.size && c.module === f.module) continue;
      need.push({ ...f, mtimeMs: st.mtimeMs, size: st.size });
    }
    for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
    let partial = false;
    if (need.length) {
      const seconds = Math.max(1, PROJECT_SECONDS - (Date.now() - started) / 1000);
      const r = await runHelper(script, interp, ['project'], {
        input: JSON.stringify({ files: need.map((f) => ({ path: f.path, module: f.module })), seconds }), timeoutMs: (seconds + 5) * 1000,
      });
      const byPath = new Map(need.map((f) => [f.path, f]));
      for (const line of r.stdout.split(/\r?\n/)) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.done) { partial = partial || msg.truncated; continue; }
        const f = byPath.get(msg.path);
        if (f) cache.set(f.path.toLowerCase(), { mtimeMs: f.mtimeMs, size: f.size, module: f.module, result: msg.ok ? msg.module : { name: f.module, error: msg.error } });
      }
      if (r.timedOut) partial = true;
      if (!r.stdout.trim() && r.code !== 0) return { trusted: true, error: r.stderr.trim().split(/\r?\n/).pop() || `exit code ${r.code}`, modules: [] };
    }
    const byName = new Map();
    for (const c of cache.values()) if (c.result && !byName.has(c.result.name)) byName.set(c.result.name, { ...c.result });
    const list = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { trusted: true, modules: list, truncated: truncated || partial, skipped, parsed: need.length, ms: Date.now() - started };
  }

  // req: {root, interp: {cmd, args}} -> {trusted, modules, truncated, skipped, parsed, ms} | {trusted: false}.
  // truncated: not every file was read (too many, or out of time); skipped: the modules of files too large to read.
  ipcMain.handle('visual-script:symbols', async (_e, req) => {
    const root = typeof req?.root === 'string' && path.isAbsolute(req.root) ? path.resolve(req.root) : null;
    if (!root || !trust.isTrusted(root)) return { trusted: false, modules: [] };
    if (!validInterp(req.interp)) return { trusted: true, error: 'No Python interpreter', modules: [] };
    const k = root.toLowerCase();
    const run = (queues.get(k) || Promise.resolve()).catch(() => {}).then(() => scan(root, req.interp));
    queues.set(k, run);
    try { return await run; } finally { if (queues.get(k) === run) queues.delete(k); }
  });

  // A module of the project itself is never imported: its top-level name is a file or folder of the project root
  // (or src/), and the helper refuses anything that would load from inside the project folder.
  const projectTop = (root, top) => ['', 'src'].some((dir) => fs.existsSync(path.join(root, dir, `${top}.py`)) || fs.existsSync(path.join(root, dir, top)));

  // req: {root, interp, name} -> {ok: true, module} | {ok: false, reason, error}
  ipcMain.handle('visual-script:module', async (_e, req) => {
    const root = typeof req?.root === 'string' && path.isAbsolute(req.root) ? path.resolve(req.root) : null;
    if (!root || !trust.isTrusted(root)) return { ok: false, reason: 'untrusted', error: 'The project is not trusted.' };
    const name = String(req.name || '');
    if (!DOTTED.test(name)) return { ok: false, reason: 'refused', error: `${name} is not a module name.` };
    if (projectTop(root, name.split('.')[0])) return { ok: false, reason: 'project', error: `${name} is part of the project` };
    if (!validInterp(req.interp)) return { ok: false, reason: 'interpreter', error: 'No Python interpreter' };
    const key = `${interpKey(req.interp)}\u0000${name}`;
    if (modules.has(key)) return modules.get(key);
    const r = await runHelper(script, req.interp, ['module', name, root], { timeoutMs: MODULE_MS });
    if (r.timedOut) return { ok: false, reason: 'timeout', error: `Loading ${name} took longer than ${MODULE_MS / 1000} seconds.` };
    const result = marked(r.stdout) || { ok: false, reason: 'error', error: r.stderr.trim().split(/\r?\n/).pop() || `exit code ${r.code}` };
    if (result.ok || result.reason === 'missing') modules.set(key, result);
    return result;
  });

  // req: {root, interp} -> {ok: true, packages: [names]} | {ok: false, reason, error}
  ipcMain.handle('visual-script:packages', async (_e, req) => {
    const root = typeof req?.root === 'string' && path.isAbsolute(req.root) ? path.resolve(req.root) : null;
    if (!root || !trust.isTrusted(root)) return { ok: false, reason: 'untrusted', error: 'The project is not trusted.' };
    if (!validInterp(req.interp)) return { ok: false, reason: 'interpreter', error: 'No Python interpreter' };
    const key = interpKey(req.interp);
    if (packageLists.has(key)) return packageLists.get(key);
    const r = await runHelper(script, req.interp, ['packages', root], { timeoutMs: MODULE_MS });
    const result = (!r.timedOut && marked(r.stdout)) || { ok: false, reason: r.timedOut ? 'timeout' : 'error', error: r.stderr.trim().split(/\r?\n/).pop() || 'timeout' };
    if (result.ok) packageLists.set(key, result);
    return result;
  });

  // A .py file as a graph (python/py2flow.py: parsed with `ast`, never run), for the preview and Convert to Visual
  // Script. req: {root, interp, source} -> {ok: true, graph, lines, statements, fallback} | {ok: false, error, reason?}
  const fromPython = path.join(unpackedDir, 'renderer', 'features', 'visual-script', 'python', 'py2flow.py');
  ipcMain.handle('visual-script:fromPython', async (_e, req) => {
    const root = typeof req?.root === 'string' && path.isAbsolute(req.root) ? path.resolve(req.root) : null;
    if (!root || !trust.isTrusted(root)) return { ok: false, reason: 'untrusted', error: { message: 'The project is not trusted.' } };
    if (!validInterp(req.interp)) return { ok: false, reason: 'interpreter', error: { message: 'No Python interpreter' } };
    if (typeof req.source !== 'string' || req.source.length > MAX_BYTES) return { ok: false, reason: 'size', error: { message: 'The file is larger than 1 MB.' } };
    const r = await runHelper(fromPython, req.interp, [], { input: req.source, timeoutMs: MODULE_MS });
    if (r.timedOut) return { ok: false, reason: 'timeout', error: { message: `Reading the file took longer than ${MODULE_MS / 1000} seconds.` } };
    return marked(r.stdout) || { ok: false, reason: 'error', error: { message: r.stderr.trim().split(/\r?\n/).pop() || `exit code ${r.code}` } };
  });

  // Installed packages changed (pip install, another interpreter's venv): describe modules again when asked.
  ipcMain.handle('visual-script:forgetPackages', () => { modules.clear(); packageLists.clear(); return true; });
};
