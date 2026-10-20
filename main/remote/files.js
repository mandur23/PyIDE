// The local side of file transfers with a target: listing the project, the IDE helpers or a library mirror, packing
// files for an upload and unpacking a download. All of it runs on a worker thread (main/worker-host.js evaluates this
// file with the role checked below): packing a 20,000-file project for an SSH target took the main process, and with
// it every window, more than a second otherwise.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { isMainThread, parentPort, workerData } = require('worker_threads');

const SKIP = new Set(['.git', '__pycache__', 'node_modules', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.venv', 'venv', 'env']);
const BINARY = /\.(exe|dll|pyd|pdb|so|dylib)$/i;

// Files under dir as rel (with '/') -> {size, mtime (whole seconds), abs}, skipping caches and virtualenvs.
// filter: {ext: only names with this suffix, noBinary: skip executables and native libraries, maxSize: in bytes}.
function walkLocal(dir, { ext, noBinary, maxSize } = {}, limit = 20000) {
  const out = new Map();
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !fs.existsSync(path.join(p, 'pyvenv.cfg'))) walk(p);
      } else if (e.isFile() && (!ext || e.name.endsWith(ext)) && !(noBinary && BINARY.test(e.name))) {
        // A file the project's own programs delete while this runs is skipped, as the target's manifest does.
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (maxSize && st.size > maxSize) continue;
        out.set(path.relative(dir, p).split(path.sep).join('/'), { size: st.size, mtime: Math.floor(st.mtimeMs / 1000), abs: p });
      }
    }
  };
  walk(dir);
  return out;
}

// The transfer stream of pyide_remote.py: header line + bytes per file, {"d": rel} for deletions, gzip-compressed.
function packStream(files, deleted = []) {
  const parts = [];
  for (const [rel, f] of files) {
    let data;
    try { data = fs.readFileSync(f.abs); } catch { continue; } // deleted since the walk
    parts.push(Buffer.from(`${JSON.stringify({ p: rel, n: data.length, m: f.mtime })}\n`), data);
  }
  for (const rel of deleted) parts.push(Buffer.from(`${JSON.stringify({ d: rel })}\n`));
  return zlib.gzipSync(Buffer.concat(parts));
}
function unpackStream(buf, dest) {
  const data = zlib.gunzipSync(buf);
  let i = 0;
  let n = 0;
  while (i < data.length) {
    const nl = data.indexOf(0x0a, i);
    if (nl < 0) break;
    const h = JSON.parse(data.subarray(i, nl).toString('utf8'));
    i = nl + 1;
    if (h.d) continue;
    // A Linux file name may hold '\' or ':', which Windows paths treat as separators or a drive: '..\..\x' must not
    // climb out of dest.
    const file = path.resolve(dest, ...h.p.split('/'));
    if (/[\\:]/.test(h.p) || h.p.split('/').includes('..') || !file.startsWith(path.resolve(dest) + path.sep)) throw new Error(`unsafe path ${h.p}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data.subarray(i, i + h.n));
    fs.utimesSync(file, h.m, h.m);
    i += h.n;
    n++;
  }
  return n;
}

const OPS = { walk: walkLocal, pack: packStream, unpack: unpackStream };
if (!isMainThread && workerData?.role === 'pyide-remote-files') {
  parentPort.on('message', ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: OPS[op](...args) }); } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  });
}

// Main side. A packed stream crosses the thread boundary as a plain Uint8Array; callers get a Buffer back.
const run = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-remote-files') : null;
module.exports = isMainThread ? {
  walk: (dir, filter, limit) => run('walk', dir, filter, limit),
  pack: async (files, deleted) => { const u8 = await run('pack', [...files], deleted); return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength); },
  unpack: (buf, dest) => run('unpack', buf, dest),
} : {};
