// File viewers (main side): raw file bytes for the renderer (audio decoding, model headers), saving video frames,
// opening links externally, and small Python probes (NumPy arrays, ONNX and PyTorch checkpoints) run with the
// selected interpreter.
const { shell, protocol } = require('electron');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_READ = 512 * 1024 * 1024;

// One script, three modes. Prints a single JSON object on stdout. Never unpickles (allow_pickle=False, weights_only=True).
const PROBE = String.raw`
import sys, json, os
mode, path = sys.argv[1], sys.argv[2]
arg = sys.argv[3] if len(sys.argv) > 3 else None
ROWS, COLS = 200, 50

def out(obj):
    sys.stdout.write(json.dumps(obj, default=str))
    sys.stdout.flush()

def need(mod):
    try:
        return __import__(mod)
    except Exception as e:
        out({"ok": False, "missing": mod, "error": "%s: %s" % (type(e).__name__, e)})
        sys.exit(0)

def fmt(v):
    try:
        if isinstance(v, float):
            return "%.6g" % v
        if isinstance(v, bytes):
            v = v.decode("utf-8", "replace")
        s = str(v)
        return s if len(s) <= 80 else s[:79] + "…"
    except Exception:
        return "?"

def cell(v):
    if hasattr(v, "item") and getattr(v, "shape", None) == ():
        try:
            v = v.item()
        except Exception:
            pass
    if isinstance(v, (tuple, list)):
        return fmt("(" + ", ".join(fmt(x) for x in v) + ")")
    return fmt(v)

def describe(np, name, a, full=True):
    d = {"name": name, "shape": list(a.shape), "dtype": str(a.dtype), "size": int(a.size),
         "nbytes": int(a.nbytes), "fortran": bool(a.flags.f_contiguous and not a.flags.c_contiguous and a.ndim > 1)}
    if not full:
        return d
    kind = a.dtype.kind
    if a.size and kind in "biuf" and a.dtype.names is None:
        x = a.astype(np.float64) if kind == "b" else a
        with np.errstate(all="ignore"):
            st = {"min": float(np.nanmin(x)) if kind == "f" else float(x.min()),
                  "max": float(np.nanmax(x)) if kind == "f" else float(x.max()),
                  "mean": float(np.nanmean(x)) if kind == "f" else float(x.mean()),
                  "std": float(np.nanstd(x)) if kind == "f" else float(x.std())}
            if kind == "f":
                st["nan"] = int(np.isnan(a).sum())
                st["inf"] = int(np.isinf(a).sum())
        d["stats"] = st
    view, sl = a, []
    while view.ndim > 2:
        view = view[0]
        sl.append("0")
    if sl:
        d["slice"] = "[" + ", ".join(sl + [":", ":"]) + "]"
    if view.ndim == 0:
        d["columns"] = ["value"]
        d["rows"] = [[cell(view[()])]]
    elif a.dtype.names:
        names = list(a.dtype.names)[:COLS]
        d["columns"] = names
        flat = view.reshape(-1)[:ROWS]
        d["rows"] = [[cell(r[n]) for n in names] for r in flat]
    elif view.ndim == 1:
        d["columns"] = ["0"]
        d["rows"] = [[cell(v)] for v in view[:ROWS]]
    else:
        part = view[:ROWS, :COLS]
        d["columns"] = [str(i) for i in range(part.shape[1])]
        d["rows"] = [[cell(v) for v in r] for r in part]
    d["truncatedRows"] = bool(view.ndim >= 1 and view.shape[0] > ROWS)
    d["truncatedCols"] = bool(view.ndim == 2 and view.shape[1] > COLS)
    return d

def numpy_probe():
    np = need("numpy")
    try:
        if path.lower().endswith(".npz"):
            z = np.load(path, allow_pickle=False)
            names = list(z.files)
            if arg is not None:
                out({"ok": True, "arrays": [describe(np, arg, z[arg])]})
                return
            # Small archives come back complete; large ones list headers and load arrays on demand.
            full = os.path.getsize(path) <= 64 * 1024 * 1024 and len(names) <= 64
            arrays = []
            for i, n in enumerate(names):
                if full or i == 0:
                    arrays.append(describe(np, n, z[n]))
                else:
                    arrays.append(header(np, z, n))
            out({"ok": True, "npz": True, "arrays": arrays, "numpy": np.__version__})
        else:
            a = np.load(path, allow_pickle=False, mmap_mode="r")
            out({"ok": True, "arrays": [describe(np, os.path.basename(path), np.asarray(a))], "numpy": np.__version__})
    except Exception as e:
        out({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})

def header(np, z, n):
    try:
        import zipfile
        with zipfile.ZipFile(path) as zf:
            with zf.open(n + ".npy") as f:
                ver = np.lib.format.read_magic(f)
                rd = np.lib.format.read_array_header_1_0 if ver == (1, 0) else np.lib.format.read_array_header_2_0
                shape, fortran, dtype = rd(f)
        return {"name": n, "shape": list(shape), "dtype": str(dtype), "lazy": True}
    except Exception:
        return describe(np, n, z[n])

def onnx_probe():
    onnx = need("onnx")
    try:
        m = onnx.load(path, load_external_data=False)
        def vi(v):
            t = v.type.tensor_type
            dims = [d.dim_param or (d.dim_value if d.HasField("dim_value") else "?") for d in t.shape.dim] if t.HasField("shape") else None
            try:
                dt = onnx.helper.tensor_dtype_to_np_dtype(t.elem_type).name
            except Exception:
                dt = str(t.elem_type)
            return {"name": v.name, "dtype": dt, "shape": dims}
        inits = {i.name for i in m.graph.initializer}
        params = 0
        for i in m.graph.initializer:
            n = 1
            for d in i.dims:
                n *= d
            params += n
        ops = {}
        for node in m.graph.node:
            ops[node.op_type] = ops.get(node.op_type, 0) + 1
        out({"ok": True, "onnx": onnx.__version__, "irVersion": m.ir_version, "producer": (m.producer_name + " " + m.producer_version).strip(),
             "opset": [{"domain": o.domain or "ai.onnx", "version": o.version} for o in m.opset_import],
             "inputs": [vi(v) for v in m.graph.input if v.name not in inits], "outputs": [vi(v) for v in m.graph.output],
             "nodes": len(m.graph.node), "initializers": len(inits), "params": params,
             "ops": sorted(ops.items(), key=lambda kv: -kv[1])[:30]})
    except Exception as e:
        out({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})

def torch_probe():
    torch = need("torch")
    try:
        try:
            obj = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
        except Exception:
            obj = torch.load(path, map_location="cpu", weights_only=True)
    except Exception as e:
        out({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e).strip().splitlines()[0] if str(e).strip() else "")})
        return
    tensors, other = [], []
    def walk(prefix, v, depth):
        if len(tensors) >= 5000:
            return
        if isinstance(v, torch.Tensor):
            tensors.append({"name": prefix, "dtype": str(v.dtype).replace("torch.", ""), "shape": list(v.shape), "numel": int(v.numel())})
        elif isinstance(v, dict) and depth < 6:
            for k, x in v.items():
                walk(prefix + "." + str(k) if prefix else str(k), x, depth + 1)
        elif isinstance(v, (list, tuple)) and depth < 6 and any(isinstance(x, (torch.Tensor, dict)) for x in v[:50]):
            for i, x in enumerate(v):
                walk("%s[%d]" % (prefix, i), x, depth + 1)
        elif len(other) < 200:
            other.append({"name": prefix or "(root)", "type": type(v).__name__, "value": fmt(v)})
    walk("", obj, 0)
    out({"ok": True, "torch": torch.__version__, "root": type(obj).__name__, "tensors": tensors, "other": other,
         "params": sum(t["numel"] for t in tensors), "truncated": len(tensors) >= 5000})

{"numpy": numpy_probe, "onnx": onnx_probe, "torch": torch_probe}[mode]()
`;

// The probe lives in its own temp folder (sys.path[0] when it runs), written once per session.
let probeFile = null;
function probeScript() {
  if (probeFile && fs.existsSync(probeFile)) return probeFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-viewers-'));
  probeFile = path.join(dir, 'pyide_viewers_probe.py');
  fs.writeFileSync(probeFile, PROBE, 'utf8');
  return probeFile;
}

const TIMEOUTS = { numpy: 60000, onnx: 60000, torch: 120000 };

// Unique "<stem>_frame_<n>.png" next to the video.
function framePath(video, frame) {
  const dir = path.dirname(video);
  const stem = path.basename(video, path.extname(video));
  let p = path.join(dir, `${stem}_frame_${frame}.png`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem}_frame_${frame}_${i}.png`);
  return p;
}

// ---------- HTML preview server ----------
// pyide-preview://<site>/<path>: a site is a folder (the project, or the HTML file's own folder outside a project), so
// relative and root-relative URLs (css/site.css, /img/logo.png) resolve as on a web server. Unsaved editor text
// overrides the file on disk. HTML pages get a small helper that keeps the scroll position across reloads, reports
// script errors to the IDE, and hands links that leave the site to the IDE.
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'application/xhtml+xml', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml', wasm: 'application/wasm', pdf: 'application/pdf',
};
const PREVIEW_HELPER = `<script>(() => {
  const post = (m) => parent.postMessage({ pyidePreview: true, ...m }, '*');
  const y = Number(new URLSearchParams(location.search).get('__pyide_y') || 0);
  if (y) addEventListener('load', () => scrollTo(0, y));
  let t = 0;
  addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(() => post({ type: 'scroll', y: scrollY }), 80); });
  addEventListener('error', (e) => post({ type: 'error', message: String(e.message || 'Error'), source: e.filename || '', line: e.lineno || 0 }));
  addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String((e.reason && e.reason.message) || e.reason) }));
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const u = new URL(a.getAttribute('href'), location.href);
    if (u.protocol !== location.protocol) { e.preventDefault(); post({ type: 'open', url: u.href }); }
  }, true);
})();</script>`;
const sites = new Map(); // id -> root folder
const overrides = new Map(); // lowercase absolute path -> unsaved text
const isInside = (p, root) => { const r = path.relative(root, p); return !r.startsWith('..') && !path.isAbsolute(r); };
const injectHelper = (html) => (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + PREVIEW_HELPER) : PREVIEW_HELPER + html);

function siteFor(root) {
  for (const [id, r] of sites) if (r.toLowerCase() === root.toLowerCase()) return id;
  const id = crypto.randomBytes(6).toString('hex');
  sites.set(id, root);
  return id;
}

async function servePreview(req) {
  const u = new URL(req.url);
  const root = sites.get(u.hostname);
  if (!root) return new Response('Unknown preview site', { status: 404 });
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return new Response('Bad path', { status: 400 }); }
  let file = path.resolve(root, `.${rel}`);
  if (!isInside(file, root) && file.toLowerCase() !== root.toLowerCase()) return new Response('Outside the preview folder', { status: 403 });
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch {}
  const over = overrides.get(file.toLowerCase());
  let body = over !== undefined ? Buffer.from(over, 'utf8') : await fs.promises.readFile(file).catch(() => null);
  if (!body) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  if (type.startsWith('text/html')) body = Buffer.from(injectHelper(body.toString('utf8')), 'utf8');
  return new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}
exports.register = ({ ipcMain }) => {
  protocol.handle('pyide-preview', servePreview);
  // -> {url} for an HTML file, served from the project (or from the file's folder when it is outside the project).
  ipcMain.handle('viewers:previewUrl', (_e, file, projectRoot) => {
    const root = projectRoot && isInside(file, projectRoot) ? projectRoot : path.dirname(file);
    const rel = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
    return { url: `pyide-preview://${siteFor(root)}/${rel}`, root };
  });
  // The unsaved text of open documents: {absolutePath: text}; replaces the previous set.
  ipcMain.handle('viewers:previewOverrides', (_e, map) => {
    overrides.clear();
    for (const [p, text] of Object.entries(map || {})) overrides.set(p.toLowerCase(), String(text));
    return true;
  });
  // Opens a saved HTML file in the system browser.
  ipcMain.handle('viewers:openInBrowser', (_e, file) => {
    if (!/\.x?html?$/i.test(String(file)) || !fs.existsSync(file)) return false;
    shell.openExternal(pathToFileURL(file).href);
    return true;
  });
  ipcMain.handle('viewers:stat', (_e, p) => {
    const s = fs.statSync(p);
    return { size: s.size, mtime: s.mtimeMs };
  });

  // -> Buffer (arrives as Uint8Array). start/length select a range; without them the whole file (up to MAX_READ).
  ipcMain.handle('viewers:readBytes', async (_e, p, start = 0, length) => {
    const size = fs.statSync(p).size;
    const len = Math.max(0, Math.min(length ?? size - start, size - start, MAX_READ));
    const fh = await fs.promises.open(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf;
    } finally {
      await fh.close();
    }
  });

  ipcMain.handle('viewers:saveFrame', (_e, video, bytes, frame) => {
    const p = framePath(video, frame);
    fs.writeFileSync(p, Buffer.from(bytes));
    return p;
  });

  ipcMain.handle('viewers:openExternal', (_e, url) => {
    if (!/^https?:\/\//i.test(String(url))) return false;
    shell.openExternal(url);
    return true;
  });

  // mode: 'numpy' | 'onnx' | 'torch'. -> {ok, ...} | {ok: false, missing?, error, timeout?}
  ipcMain.handle('viewers:probe', (_e, interp, mode, file, arg) => new Promise((resolve) => {
    if (!interp?.cmd) return resolve({ ok: false, noInterpreter: true });
    if (!TIMEOUTS[mode]) return resolve({ ok: false, error: `unknown mode ${mode}` });
    let script;
    try { script = probeScript(); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const args = [...(interp.args || []), script, mode, file, ...(arg != null ? [arg] : [])];
    // The probe runs from its own folder, so project files (a numpy.py, json.py...) cannot shadow the modules it imports.
    execFile(interp.cmd, args, {
      cwd: path.dirname(script), encoding: 'utf8', timeout: TIMEOUTS[mode], maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }, (err, stdout, stderr) => {
      try { return resolve(JSON.parse(stdout)); } catch {}
      if (err?.killed) return resolve({ ok: false, timeout: true, error: `timed out after ${TIMEOUTS[mode] / 1000}s` });
      resolve({ ok: false, error: (stderr || err?.message || 'no output').trim().split(/\r?\n/).slice(-3).join('\n') });
    });
  }));
};
