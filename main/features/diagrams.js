// Class diagrams (renderer/features/diagrams): finds the Python files of a scope, reads them with
// renderer/features/diagrams/python/diagram_model.py in the project interpreter (ast only: user code is never
// imported or run) and resolves the result into classes, bases and associations (main/diagrams/model.js).
// Parsed files are cached per path, modification time and size for the session, so a second diagram of the same
// project only parses what changed. Modules a scope's classes import from outside it are parsed on demand so
// cross-module bases resolve. A request can be cancelled (the renderer's background task), which kills its Python.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dialog } = require('electron');
const { moduleNames, buildModel, candidateFiles } = require('../diagrams/model');

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '__pycache__', 'node_modules', '.idea', '.vscode', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.venv', 'venv', 'env', 'site-packages', '.eggs']);
const DEFAULT_MAX_FILES = 5000;

exports.register = ({ ipcMain, send, getWindow, appDir, unpackedDir = appDir }) => {
  const script = path.join(unpackedDir, 'renderer', 'features', 'diagrams', 'python', 'diagram_model.py');
  const cache = new Map(); // lower-case path -> {mtimeMs, size, info, error}
  const running = new Map(); // request id -> {cancelled, proc}
  const initCache = new Map();
  const existsInit = (dir) => {
    const k = dir.toLowerCase();
    if (!initCache.has(k)) initCache.set(k, fs.existsSync(path.join(dir, '__init__.py')));
    return initCache.get(k);
  };

  async function isVenv(dir) {
    try { await fs.promises.access(path.join(dir, 'pyvenv.cfg')); return true; } catch {}
    try { await fs.promises.access(path.join(dir, 'conda-meta')); return true; } catch {}
    return false;
  }

  // The .py files under the scope's paths (files or folders), at most max of them.
  async function collect(paths, max, job) {
    const out = [];
    const seen = new Set();
    let truncated = false;
    const add = (p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return;
      if (out.length >= max) { truncated = true; return; }
      seen.add(k);
      out.push(p);
    };
    const walk = async (dir) => {
      if (job.cancelled || truncated) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const dirs = [];
      for (const d of entries) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) dirs.push(p);
        } else if (d.isFile() && /\.py$/i.test(d.name)) add(p);
      }
      for (const p of dirs) if (!(await isVenv(p))) await walk(p);
    };
    for (const p of paths) {
      let st;
      try { st = await fs.promises.stat(p); } catch { continue; }
      if (st.isDirectory()) await walk(p);
      else if (/\.pyi?$/i.test(p)) add(p);
    }
    return { files: out, truncated };
  }

  // Runs the helper over items [{path, text?}]; resolves {path -> {info} | {error}}.
  function parse(job, interp, items, onProgress) {
    return new Promise((resolve) => {
      const results = new Map();
      if (!items.length) return resolve(results);
      const args = [...(interp.args || []), '-I', '-X', 'utf8', script];
      if (job.slowMs) args.push('--slow-ms', String(job.slowMs));
      let proc;
      try {
        proc = spawn(interp.cmd, args, { windowsHide: true, cwd: path.dirname(script), env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
      } catch (err) {
        return resolve({ error: err.message });
      }
      job.proc = proc;
      let buf = '';
      let stderr = '';
      let finished = false;
      const finish = (extra) => {
        if (finished) return;
        finished = true;
        job.proc = null;
        resolve(extra ? Object.assign(results, extra) : results);
      };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.done) continue;
          results.set(msg.path, msg.ok ? { info: msg.info } : { error: msg.error });
          onProgress(results.size);
        }
      });
      proc.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
      proc.stdin.on('error', () => {});
      proc.on('error', (err) => finish({ error: err.message }));
      proc.on('exit', (code) => finish(code && results.size < items.length && !job.cancelled ? { error: stderr.trim().split(/\r?\n/).pop() || `exit code ${code}` } : null));
      proc.stdin.end(JSON.stringify(items));
    });
  }

  const killTree = (proc) => {
    if (!proc?.pid) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    else try { proc.kill(); } catch {}
  };

  // req: {id, interp: {cmd, args}, root, scope: [paths], overlay?: {path: text}, maxFiles?, slowMs?}
  ipcMain.handle('diagrams:model', async (_e, req) => {
    const started = Date.now();
    const job = { cancelled: false, proc: null, slowMs: Number(req.slowMs) || 0 };
    running.set(req.id, job);
    try {
      const interp = req.interp?.cmd ? req.interp : process.platform === 'win32' ? { cmd: 'py', args: ['-3'] } : { cmd: 'python3', args: [] };
      const root = req.root || '';
      const overlay = req.overlay || {};
      const { files: scopeFiles, truncated } = await collect(req.scope || [root], req.maxFiles || DEFAULT_MAX_FILES, job);
      if (job.cancelled) return { cancelled: true };
      const records = new Map(); // lower path -> {path, inScope}
      for (const p of scopeFiles) records.set(p.toLowerCase(), { path: p, inScope: true });
      const stats = { files: scopeFiles.length, parsed: 0, cached: 0, extra: 0, errors: [], truncated };
      const notFound = new Set();
      let total = scopeFiles.length;
      let done = 0;
      let lastSent = 0;
      const progress = (force) => {
        const now = Date.now();
        if (!force && now - lastSent < 100) return;
        lastSent = now;
        send('diagrams:progress', { id: req.id, done, total });
      };

      const ensureParsed = async (list) => {
        const need = [];
        for (const r of list) {
          const k = r.path.toLowerCase();
          if (typeof overlay[r.path] === 'string') { need.push({ path: r.path, text: overlay[r.path] }); continue; }
          let st;
          try { st = await fs.promises.stat(r.path); } catch { r.result = { error: 'missing' }; continue; }
          const c = cache.get(k);
          if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) { r.result = c; stats.cached++; done++; continue; }
          r.stat = st;
          need.push({ path: r.path });
        }
        progress(true);
        if (!need.length) return null;
        const base = done;
        const res = await parse(job, interp, need, (n) => { done = base + n; progress(); });
        if (res.error && !res.size) return res.error;
        for (const r of list) {
          const got = res.get(r.path);
          if (!got) continue;
          stats.parsed++;
          r.result = got;
          if (r.stat) cache.set(r.path.toLowerCase(), { mtimeMs: r.stat.mtimeMs, size: r.stat.size, ...got });
        }
        return res.error || null;
      };

      let failure = await ensureParsed([...records.values()]);
      if (job.cancelled) return { cancelled: true };
      if (failure && !stats.parsed && !stats.cached) return { error: failure };

      const sourceRoots = () => {
        const roots = new Set();
        if (root) { roots.add(root); roots.add(path.join(root, 'src')); }
        for (const r of records.values()) {
          const mod = r.modules?.[0];
          if (!mod) continue;
          let dir = path.dirname(r.path);
          const depth = mod.split('.').length - (/^__init__\.py$/i.test(path.basename(r.path)) ? 0 : 1);
          for (let i = 0; i < depth; i++) dir = path.dirname(dir);
          roots.add(dir);
        }
        return [...roots];
      };
      let model;
      for (let round = 0; ; round++) {
        const files = [];
        for (const r of records.values()) {
          r.modules ||= moduleNames(r.path, root, existsInit);
          if (r.result?.info) files.push({ path: r.path, modules: r.modules, info: r.result.info, inScope: r.inScope });
        }
        model = buildModel(files);
        if (round >= 4 || job.cancelled) break;
        // Modules imported from outside the scope: parse the project files that define them, then resolve again.
        const extra = [];
        const roots = sourceRoots();
        for (const mod of model.missing) {
          if (notFound.has(mod)) continue;
          notFound.add(mod);
          for (const f of candidateFiles(mod, roots)) {
            if (records.has(f.toLowerCase())) continue;
            if (root && path.relative(root, f).startsWith('..')) continue;
            try { if (!(await fs.promises.stat(f)).isFile()) continue; } catch { continue; }
            const r = { path: f, inScope: false };
            records.set(f.toLowerCase(), r);
            extra.push(r);
            break;
          }
        }
        if (!extra.length) break;
        stats.extra += extra.length;
        total += extra.length;
        failure = await ensureParsed(extra);
        if (job.cancelled) return { cancelled: true };
      }
      if (job.cancelled) return { cancelled: true };
      for (const r of records.values()) if (r.result?.error && r.result.error !== 'missing') stats.errors.push({ path: r.path, error: r.result.error });
      stats.ms = Date.now() - started;
      return { classes: model.classes, edges: model.edges, stats };
    } catch (err) {
      return { error: err?.message || String(err) };
    } finally {
      running.delete(req.id);
    }
  });

  ipcMain.handle('diagrams:cancel', (_e, id) => {
    const job = running.get(id);
    if (!job) return false;
    job.cancelled = true;
    killTree(job.proc);
    return true;
  });

  ipcMain.handle('diagrams:cacheSize', () => cache.size);

  // Export writes only a path the Save dialog returned in this session (like Export Settings and the database export);
  // with PYIDE_DIAGRAMS_SAVE_DIR (tests) also a file directly in that folder.
  const chosen = new Set();
  const keyOf = (p) => path.resolve(p).toLowerCase();
  const saveDir = () => process.env.PYIDE_DIAGRAMS_SAVE_DIR || '';
  const writable = (file) => chosen.has(keyOf(file)) || (!!saveDir() && keyOf(path.dirname(file)) === keyOf(saveDir()));

  // kind: 'svg' | 'png'. PYIDE_DIAGRAMS_SAVE_DIR (tests) answers <dir>/<defaultName> without the dialog.
  ipcMain.handle('diagrams:savePath', async (_e, kind, defaultName) => {
    const safe = String(defaultName || `diagram.${kind}`).replace(/[\\/:*?"<>|]+/g, '_');
    if (saveDir()) return path.join(saveDir(), safe);
    const filters = kind === 'png' ? [{ name: 'PNG', extensions: ['png'] }] : [{ name: 'SVG', extensions: ['svg'] }];
    const r = await dialog.showSaveDialog(getWindow(), { defaultPath: safe, filters });
    if (r.canceled || !r.filePath) return null;
    chosen.add(keyOf(r.filePath));
    return r.filePath;
  });
  // data: base64 for 'png', text for 'svg'.
  ipcMain.handle('diagrams:write', async (_e, file, kind, data) => {
    if (typeof file !== 'string' || !/\.(svg|png)$/i.test(file)) throw new Error('Not an SVG or PNG file name');
    if (!writable(file)) throw new Error('The file was not chosen in the Save dialog');
    await fs.promises.writeFile(file, kind === 'png' ? Buffer.from(String(data), 'base64') : String(data), kind === 'png' ? undefined : 'utf8');
    return true;
  });
};
