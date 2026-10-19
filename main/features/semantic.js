// Semantic code search with Google's EmbeddingGemma 2 (Apache 2.0, google/embeddinggemma-2).
// The model runs in a Python sidecar (main/semantic/embed_server.py) inside a private venv that reuses the system
// torch. Project files are split into code-aware chunks (functions, classes, methods, doc sections), embedded once,
// and stored per project; only files that changed are embedded again. Queries mix cosine similarity with a small
// keyword score so exact identifiers still rank well.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_ID = 'google/embeddinggemma-2';
const DIM = 256; // Matryoshka truncation: a quarter of the storage of 768 with little loss for code retrieval
const INDEX_VERSION = 2;
const MAX_FILE_BYTES = 300 * 1024;
const MAX_CHUNKS = 30000;
const CHUNK_CHARS = 1800;
const BATCH = 24;
const TEXT_EXT = new Set(['py', 'pyi', 'md', 'rst', 'txt', 'toml', 'cfg', 'ini', 'yaml', 'yml', 'json', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'html', 'css', 'java', 'kt', 'lua', 'luau', 'sql', 'sh', 'ps1', 'bat', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'jsp']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.idea', '.vscode', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.cache', 'site-packages', 'dist', 'build', '.tox', '.next', 'target']);

// ---------- chunking ----------
const DEF = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/;

function windows(lines, start, end, symbol, size = 40, overlap = 8) {
  const out = [];
  for (let s = start; s < end; s += size - overlap) {
    const e = Math.min(end, s + size);
    out.push({ start: s, end: e, symbol });
    if (e === end) break;
  }
  return out;
}

// Python: one chunk per top-level function/class (decorators included), one per method, and windows over the
// module-level code in between. Long blocks are split so each chunk stays within the model's sweet spot.
function chunkPython(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEF);
    if (!m || m[1].length) continue;
    let s = i;
    while (s > 0 && /^@/.test(lines[s - 1])) s--;
    blocks.push({ start: s, header: i, name: m[2], isClass: /^class\b/.test(lines[i]) });
  }
  const out = [];
  let cursor = 0;
  blocks.forEach((b, k) => {
    let end = k + 1 < blocks.length ? blocks[k + 1].start : lines.length;
    while (end > b.start + 1 && !lines[end - 1].trim()) end--;
    if (b.start > cursor) out.push(...windows(lines, cursor, b.start, '<module>'));
    const label = `${b.isClass ? 'class' : 'def'} ${b.name}`;
    // A class with methods becomes its header (docstring, class attributes) plus one chunk per method.
    const firstMethod = b.isClass ? lines.slice(b.header + 1, end).findIndex((l) => { const m = l.match(DEF); return m && m[1].length; }) : -1;
    if (firstMethod >= 0) out.push({ start: b.start, end: Math.min(b.header + 1 + firstMethod, b.start + 40), symbol: label });
    else if (end - b.start > 80) out.push(...windows(lines, b.start, end, label, 60, 10));
    else out.push({ start: b.start, end, symbol: label });
    if (firstMethod >= 0) {
      for (let i = b.header + 1; i < end; i++) {
        const m = lines[i].match(DEF);
        if (!m || !m[1].length) continue;
        let mEnd = i + 1;
        while (mEnd < end && (!lines[mEnd].trim() || lines[mEnd].search(/\S/) > m[1].length)) mEnd++;
        let ms = i;
        while (ms > b.header + 1 && /^\s*@/.test(lines[ms - 1])) ms--;
        const sym = `${b.name}.${m[2]}`;
        if (mEnd - ms > 80) out.push(...windows(lines, ms, mEnd, sym, 60, 10));
        else if (mEnd - ms > 2) out.push({ start: ms, end: mEnd, symbol: sym });
      }
    }
    cursor = end;
  });
  if (cursor < lines.length) out.push(...windows(lines, cursor, lines.length, '<module>'));
  return out.filter((c) => lines.slice(c.start, c.end).some((l) => l.trim()));
}

function chunkMarkdown(lines) {
  const heads = [];
  lines.forEach((l, i) => { if (/^#{1,4}\s/.test(l)) heads.push(i); });
  if (!heads.length) return windows(lines, 0, lines.length, '');
  const out = heads[0] > 0 ? windows(lines, 0, heads[0], '') : [];
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const title = lines[h].replace(/^#+\s*/, '').trim();
    out.push(...(end - h > 60 ? windows(lines, h, end, title, 50, 8) : [{ start: h, end, symbol: title }]));
  });
  return out;
}

function chunkFile(rel, text) {
  const lines = text.split(/\r?\n/);
  const ext = rel.split('.').pop().toLowerCase();
  const chunks = ext === 'py' || ext === 'pyi' ? chunkPython(lines) : ext === 'md' ? chunkMarkdown(lines) : windows(lines, 0, lines.length, '');
  return chunks.map((c) => ({ ...c, text: lines.slice(c.start, c.end).join('\n').slice(0, CHUNK_CHARS) }));
}

// ---------- keyword score ----------
const tokens = (s) => (s.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])
  .flatMap((t) => [t, ...t.split('_').filter((p) => p.length > 1)]);
function keywordScore(queryTokens, chunk) {
  if (!queryTokens.length) return 0;
  const hay = `${chunk.symbol} ${chunk.title} ${chunk.text}`.toLowerCase();
  return queryTokens.filter((t) => hay.includes(t)).length / queryTokens.length;
}

// ---------- backends ----------
// A deterministic stand-in (hashed bag of words and identifier parts) used by tests and when no model is installed.
function fakeEmbed(text) {
  const v = new Float32Array(DIM);
  const parts = tokens(text.replace(/([a-z])([A-Z])/g, '$1 $2'));
  for (const t of parts) {
    const h = crypto.createHash('md5').update(t).digest();
    v[h.readUInt16LE(0) % DIM] += 1;
    v[h.readUInt16LE(2) % DIM] -= 0.5;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

function hfCacheDir() {
  const home = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
  return process.env.HF_HUB_CACHE || path.join(home, 'hub');
}
function modelDownloaded() {
  const snaps = path.join(hfCacheDir(), 'models--google--embeddinggemma-2', 'snapshots');
  try { return fs.readdirSync(snaps).some((s) => fs.existsSync(path.join(snaps, s, 'model.safetensors'))); } catch { return false; }
}

exports.register = ({ ipcMain, app, send, appDir }) => {
  const base = path.join(app.getPath('userData'), 'semantic');
  // The runtime is shared by every PyIDE profile (like the Hugging Face model cache); indexes stay per profile.
  // It lives under the home folder: packaged launchers virtualize %LOCALAPPDATA%, which would hide it from other launches.
  const runtimeDir = path.join(os.homedir(), '.pyide', 'semantic');
  const venv = path.join(runtimeDir, 'venv');
  const venvPython = path.join(venv, 'Scripts', 'python.exe');
  const server = path.join(appDir, 'main', 'semantic', 'embed_server.py');
  const fake = process.env.PYIDE_SEMANTIC_BACKEND === 'fake';

  // ---------- runtime state ----------
  // A file check, not an import: importing torch takes seconds and this runs on the main process during startup.
  // Setup only installs torchvision after torch is importable, so its presence stands for the whole runtime.
  const sitePackages = path.join(venv, 'Lib', 'site-packages');
  const runtimeInstalled = () => ['sentence_transformers', 'transformers', 'torchvision'].every((p) => fs.existsSync(path.join(sitePackages, p)));
  let model = { state: 'idle', device: null, error: null };
  const status = () => (fake
    ? { backend: 'fake', runtime: true, downloaded: true, model: { state: 'ready', device: 'cpu' }, modelId: 'hashing (test)', dim: DIM }
    : { backend: 'embeddinggemma-2', runtime: fs.existsSync(venvPython) && runtimeInstalled(), downloaded: modelDownloaded(), model, modelId: MODEL_ID, dim: DIM });
  const pushStatus = () => send('semantic:status', status());

  // ---------- sidecar ----------
  let proc = null;
  let nextReq = 1;
  const pending = new Map();
  let buffer = '';
  function startServer() {
    if (proc) return proc;
    proc = spawn(venvPython, ['-u', server], {
      cwd: runtimeDir,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
    });
    proc.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === 'loading') { model = { state: 'loading', device: null, error: null }; pushStatus(); }
        else if (msg.event === 'ready') { model = { state: 'ready', device: msg.device, error: null }; pushStatus(); }
        else if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    });
    proc.stderr.on('data', (d) => send('semantic:log', d.toString('utf8')));
    proc.on('exit', (code) => {
      proc = null;
      for (const resolve of pending.values()) resolve({ error: `embedding server exited (${code})` });
      pending.clear();
      if (model.state !== 'ready') model = { state: 'error', device: null, error: `embedding server exited (${code})` };
      else model = { state: 'idle', device: null, error: null };
      pushStatus();
    });
    return proc;
  }

  async function embed(items, kind) {
    if (fake) return items.map((it) => fakeEmbed(`${it.title || ''} ${it.text}`));
    if (!status().runtime) throw new Error('EmbeddingGemma 2 is not set up');
    startServer();
    const id = nextReq++;
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ id, op: 'embed', kind, items, dim: DIM })}\n`);
    });
    if (reply.error) {
      model = { ...model, error: reply.error };
      throw new Error(reply.error);
    }
    const buf = Buffer.from(reply.data, 'base64');
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from({ length: reply.n }, (_, i) => all.slice(i * reply.dim, (i + 1) * reply.dim));
  }

  // ---------- per-project index ----------
  const indexes = new Map(); // root key -> {root, dir, files: {rel: {mtime, size, chunks}}, job}
  const keyOf = (root) => crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16);

  function loadIndex(root) {
    const k = keyOf(root);
    if (indexes.has(k)) return indexes.get(k);
    const dir = path.join(base, 'indexes', k);
    const idx = { root, dir, files: {}, job: null, done: 0, total: 0, capped: false };
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      const backend = fake ? 'fake' : MODEL_ID;
      if (meta.version === INDEX_VERSION && meta.backend === backend && meta.dim === DIM) {
        const vec = fs.readFileSync(path.join(dir, 'vectors.bin'));
        const all = new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength / 4);
        for (const [rel, f] of Object.entries(meta.files)) {
          for (const c of f.chunks) c.vector = all.slice(c.v * DIM, (c.v + 1) * DIM);
          idx.files[rel] = f;
        }
      }
    } catch {}
    indexes.set(k, idx);
    return idx;
  }

  function saveIndex(idx) {
    fs.mkdirSync(idx.dir, { recursive: true });
    const files = {};
    const parts = [];
    let n = 0;
    for (const [rel, f] of Object.entries(idx.files)) {
      files[rel] = { mtime: f.mtime, size: f.size, chunks: f.chunks.map((c) => { parts.push(c.vector); return { ...c, vector: undefined, v: n++ }; }) };
    }
    const all = new Float32Array(n * DIM);
    parts.forEach((v, i) => all.set(v, i * DIM));
    fs.writeFileSync(path.join(idx.dir, 'vectors.bin'), Buffer.from(all.buffer));
    fs.writeFileSync(path.join(idx.dir, 'index.json'), JSON.stringify({ version: INDEX_VERSION, backend: fake ? 'fake' : MODEL_ID, dim: DIM, root: idx.root, files }));
  }

  function walk(root) {
    const out = [];
    const visit = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (SKIP_DIRS.has(d.name) || /^\.?venv/i.test(d.name) || fs.existsSync(path.join(p, 'pyvenv.cfg'))) continue;
          visit(p);
        } else if (TEXT_EXT.has(d.name.split('.').pop().toLowerCase())) {
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (st.size > 0 && st.size <= MAX_FILE_BYTES) out.push({ abs: p, rel: path.relative(root, p), mtime: st.mtimeMs, size: st.size });
        }
      }
    };
    visit(root);
    return out;
  }

  const progress = (idx, phase) => send('semantic:progress', {
    root: idx.root, phase, done: idx.done, total: idx.total, files: Object.keys(idx.files).length,
    chunks: Object.values(idx.files).reduce((n, f) => n + f.chunks.length, 0), capped: idx.capped,
  });

  // Brings the index up to date with the files on disk; concurrent calls share one run.
  function update(root, onlyPaths) {
    const idx = loadIndex(root);
    if (idx.job) { idx.rerun = true; return idx.job; }
    idx.job = (async () => {
      try {
        do {
          idx.rerun = false;
          const disk = walk(root);
          const seen = new Set(disk.map((f) => f.rel.toLowerCase()));
          for (const rel of Object.keys(idx.files)) if (!seen.has(rel.toLowerCase())) delete idx.files[rel];
          let stale = disk.filter((f) => { const old = idx.files[f.rel]; return !old || old.mtime !== f.mtime || old.size !== f.size; });
          if (onlyPaths) stale = stale.filter((f) => onlyPaths.some((p) => p.toLowerCase() === f.abs.toLowerCase()) || !idx.files[f.rel]);
          const work = [];
          let budget = MAX_CHUNKS - Object.entries(idx.files).filter(([rel]) => !stale.some((s) => s.rel === rel)).reduce((n, [, f]) => n + f.chunks.length, 0);
          idx.capped = false;
          for (const f of stale) {
            let text;
            try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
            if (text.includes('\u0000')) continue;
            const chunks = chunkFile(f.rel, text).map((c) => ({ ...c, title: f.rel.replace(/\\/g, '/') }));
            if (chunks.length > budget) { idx.capped = true; break; }
            budget -= chunks.length;
            work.push({ f, chunks });
          }
          const items = work.flatMap((w) => w.chunks);
          idx.total = items.length;
          idx.done = 0;
          progress(idx, 'indexing');
          for (let i = 0; i < items.length; i += BATCH) {
            const batch = items.slice(i, i + BATCH);
            const vecs = await embed(batch.map((c) => ({ title: c.symbol ? `${c.title} ${c.symbol}` : c.title, text: c.text })), 'document');
            batch.forEach((c, j) => { c.vector = vecs[j]; });
            idx.done = Math.min(items.length, i + BATCH);
            progress(idx, 'indexing');
          }
          for (const w of work) idx.files[w.f.rel] = { mtime: w.f.mtime, size: w.f.size, chunks: w.chunks };
          if (work.length) saveIndex(idx);
          onlyPaths = null;
        } while (idx.rerun);
        progress(idx, 'ready');
      } catch (err) {
        send('semantic:progress', { root, phase: 'error', error: String(err.message || err) });
      } finally {
        idx.job = null;
      }
    })();
    return idx.job;
  }

  async function search(root, query, { limit = 30, similarTo } = {}) {
    const idx = loadIndex(root);
    // Code-to-code similarity compares like with like: the selection is embedded as a document, the space the index lives in.
    const [q] = similarTo ? await embed([{ text: similarTo }], 'document') : await embed([{ text: query }], 'query');
    const qt = tokens(query || '');
    const results = [];
    for (const [rel, f] of Object.entries(idx.files)) {
      for (const c of f.chunks) {
        if (!c.vector) continue;
        let dot = 0;
        for (let i = 0; i < DIM; i++) dot += c.vector[i] * q[i];
        const kw = similarTo ? 0 : keywordScore(qt, c);
        results.push({ rel, path: path.join(root, rel), start: c.start, end: c.end, symbol: c.symbol, score: dot + 0.15 * kw, semantic: dot, keyword: kw, text: c.text });
      }
    }
    results.sort((a, b) => b.score - a.score);
    // One hit per symbol region: drop overlapping windows of an already listed chunk.
    const out = [];
    for (const r of results) {
      if (out.some((o) => o.rel === r.rel && r.start < o.end && o.start < r.end)) continue;
      out.push({ ...r, preview: r.text.split('\n').slice(0, 12).join('\n'), text: undefined });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------- setup: private venv reusing system torch, packages, model download ----------
  let setupProc = null;
  function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      send('semantic:log', `> ${[cmd, ...args].join(' ')}\n`);
      setupProc = spawn(cmd, args, { windowsHide: true, ...opts, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...opts.env } });
      setupProc.stdout.on('data', (d) => send('semantic:log', d.toString('utf8')));
      setupProc.stderr.on('data', (d) => send('semantic:log', d.toString('utf8')));
      setupProc.on('error', reject);
      setupProc.on('close', (code) => { setupProc = null; code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`)); });
    });
  }
  function findTorchPython(preferred) {
    const candidates = [...(preferred ? [[preferred, []]] : []), ['py', ['-3']], ['python', []]];
    for (const [cmd, args] of candidates) {
      try {
        execFileSync(cmd, [...args, '-c', 'import torch'], { timeout: 60000, windowsHide: true });
        return { cmd, args, torch: true };
      } catch {}
    }
    for (const [cmd, args] of candidates) {
      try { execFileSync(cmd, [...args, '--version'], { timeout: 15000, windowsHide: true }); return { cmd, args, torch: false }; } catch {}
    }
    return null;
  }

  ipcMain.handle('semantic:setup', async (_e, { interpreter } = {}) => {
    if (fake) return { ok: true };
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      if (!fs.existsSync(venvPython)) {
        const py = findTorchPython(interpreter);
        if (!py) throw new Error('No Python interpreter found');
        // Reusing an installed torch avoids a second multi-hundred-MB download.
        await run(py.cmd, [...py.args, '-m', 'venv', ...(py.torch ? ['--system-site-packages'] : []), venv]);
      }
      if (!runtimeInstalled()) {
        let hasTorch = true;
        try { execFileSync(venvPython, ['-c', 'import torch'], { timeout: 60000, windowsHide: true }); } catch { hasTorch = false; }
        // Upgrading only the small packages keeps the reused system torch instead of downloading a new one.
        await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'sentence-transformers>=6.1', 'transformers', 'huggingface_hub', ...(hasTorch ? [] : ['torch'])]);
        // EmbeddingGemma 2's processor loads its video processor even for text, and that needs torchvision. It must be
        // the build paired with the installed torch (2.X.Y pairs with 0.(X+15).Y) from PyTorch's index for the same
        // variant (cpu, cu128, ...); --no-deps stops pip from replacing the reused torch.
        const torchVersion = execFileSync(venvPython, ['-c', 'import torch; print(torch.__version__)'], { timeout: 60000, windowsHide: true, encoding: 'utf8' }).trim();
        const [, minor, patch, variant] = torchVersion.match(/^2\.(\d+)\.(\d+)(?:\+(\w+))?/) || [];
        if (minor) {
          await run(venvPython, ['-m', 'pip', 'install', '--no-deps', 'pillow', `torchvision==0.${+minor + 15}.${patch}${variant ? `+${variant}` : ''}`,
            '--extra-index-url', `https://download.pytorch.org/whl/${variant || 'cpu'}`]);
        } else await run(venvPython, ['-m', 'pip', 'install', 'torchvision']);
        }
      pushStatus();
      if (!modelDownloaded()) {
        await run(venvPython, ['-c', `from huggingface_hub import snapshot_download; snapshot_download('${MODEL_ID}')`], { env: { HF_HUB_DISABLE_TELEMETRY: '1' } });
      }
      pushStatus();
      return { ok: true };
    } catch (err) {
      pushStatus();
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('semantic:cancelSetup', () => {
    if (setupProc) spawn('taskkill', ['/pid', String(setupProc.pid), '/T', '/F']);
  });

  ipcMain.handle('semantic:status', () => status());
  ipcMain.handle('semantic:index', (_e, root, paths) => { update(root, paths); return true; });
  ipcMain.handle('semantic:rebuild', async (_e, root) => {
    const idx = loadIndex(root);
    idx.files = {};
    try { fs.rmSync(idx.dir, { recursive: true, force: true }); } catch {}
    update(root);
    return true;
  });
  ipcMain.handle('semantic:query', async (_e, root, query, opts) => {
    try { return { ok: true, results: await search(root, query, opts) }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('semantic:indexInfo', (_e, root) => {
    const idx = loadIndex(root);
    return { files: Object.keys(idx.files).length, chunks: Object.values(idx.files).reduce((n, f) => n + f.chunks.length, 0), indexing: !!idx.job, capped: idx.capped };
  });

  app.on('before-quit', () => { if (proc) { try { proc.kill(); } catch {} } });
};

exports._test = { chunkFile, chunkPython, keywordScore, tokens, fakeEmbed };
