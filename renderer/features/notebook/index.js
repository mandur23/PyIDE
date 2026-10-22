// Jupyter notebooks: .ipynb files open as cells instead of JSON. The notebook is a text viewer over the file's
// document, so dirty state, Ctrl+S, encodings and detached windows come from the core; every change is written back
// into the document as nbformat 4 JSON (sorted keys, one-space indent, like Jupyter) with unknown fields kept.
// Each open notebook gets its own kernel: kernel_bridge.py runs in the project interpreter, starts ipykernel through
// jupyter_client and speaks JSON lines (see main/features/notebook.js).
(() => {
  const { el, basename, dirname, joinPath } = ide.util;
  const { monaco } = ide;
  const SCHEME = 'pyide-nb';
  const user = (n) => { n.dataset.userText = ''; return n; };
  const userEl = (tag, cls, text) => user(el(tag, cls, text));
  const cleanError = (e) => ide.util.errorText(e);
  const views = new Map(); // model authority -> view, for the kernel completion and hover providers
  let viewSeq = 0;

  // ---------- nbformat ----------
  const joinText = (v) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');
  const splitLines = (s) => s.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
  const isJsonMime = (m) => m === 'application/json' || (m.startsWith('application/') && m.endsWith('+json'));
  const SPLIT_MIMES = new Set(['application/javascript', 'image/svg+xml']);
  const newCellId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);

  function rejoinBundle(data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) out[k] = !isJsonMime(k) && Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join('') : v;
    return out;
  }
  function splitBundle(data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) out[k] = typeof v === 'string' && (k.startsWith('text/') || SPLIT_MIMES.has(k)) ? splitLines(v) : v;
    return out;
  }
  function readOutput(o) {
    if (o.output_type === 'stream') return { ...o, text: joinText(o.text) };
    if (o.output_type === 'display_data' || o.output_type === 'execute_result') return { ...o, data: rejoinBundle(o.data), metadata: o.metadata || {} };
    return { ...o };
  }
  function writeOutput(o) {
    const out = { ...o };
    delete out.displayId;
    delete out.dropped;
    if (o.output_type === 'stream') out.text = splitLines(o.text);
    if (o.data) out.data = splitBundle(o.data);
    return out;
  }

  // -> { meta: top-level fields except cells, cells: [{type, source, outputs, count, raw}] }; throws on invalid input.
  function parseNotebook(text) {
    if (!text.trim()) return { meta: newNotebookMeta(), cells: [newCell('code', '', true)] };
    const nb = JSON.parse(text);
    if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) throw new Error(tr('This file has no notebook cells.'));
    if (nb.nbformat !== 4) throw new Error(tr('Only nbformat 4 notebooks are supported (this file is nbformat {version}).', { version: String(nb.nbformat) }));
    const { cells, ...meta } = nb;
    return {
      meta,
      cells: cells.map((c) => ({
        type: ['code', 'markdown', 'raw'].includes(c.cell_type) ? c.cell_type : 'raw',
        source: joinText(c.source),
        outputs: c.cell_type === 'code' && Array.isArray(c.outputs) ? c.outputs.map(readOutput) : [],
        count: c.cell_type === 'code' ? c.execution_count ?? null : null,
        raw: c,
      })),
    };
  }

  function newNotebookMeta() {
    return {
      metadata: {
        kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
  }
  function newCell(type, source = '', withId = true) {
    const raw = { cell_type: type, metadata: {} };
    if (withId) raw.id = newCellId();
    return { type, source, outputs: [], count: null, raw };
  }

  function cellJson(c) {
    const out = { ...c.raw, cell_type: c.type, metadata: c.raw.metadata || {}, source: splitLines(c.source) };
    if (c.type === 'code') {
      out.outputs = c.outputs.map(writeOutput);
      out.execution_count = c.count ?? null;
    } else {
      delete out.outputs;
      delete out.execution_count;
    }
    if (c.type !== 'markdown' && c.type !== 'raw') delete out.attachments;
    return out;
  }

  // Jupyter writes json.dumps(nb, sort_keys=True, indent=1, ensure_ascii=False) plus a newline.
  function stringify(v, ind = '') {
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const i2 = `${ind} `;
      return `[\n${v.map((x) => i2 + stringify(x, i2)).join(',\n')}\n${ind}]`;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      if (!keys.length) return '{}';
      const i2 = `${ind} `;
      return `{\n${keys.map((k) => `${i2}${JSON.stringify(k)}: ${stringify(v[k], i2)}`).join(',\n')}\n${ind}}`;
    }
    return JSON.stringify(v) ?? 'null';
  }

  // ---------- console text: carriage returns and ANSI colors ----------
  // A lone \r rewinds to the start of the line (progress bars); \b deletes the previous character.
  function fixConsole(text) {
    if (!/[\r\b]/.test(text)) return text;
    return text.replace(/\r\n/g, '\n').split('\n').map((line) => {
      let cur = line;
      if (cur.includes('\r')) {
        const parts = cur.split('\r');
        cur = parts.reduce((acc, p) => p + acc.slice(p.length), '');
      }
      if (!cur.includes('\b')) return cur;
      // (\b outside a character class is a word boundary in a regex, so the deletion is done by hand.)
      const out = [];
      for (const ch of cur) { if (ch === '\b') out.pop(); else out.push(ch); }
      return out.join('');
    }).join('\n');
  }

  // A cell that prints without end would grow its output (rendered again on every message, and written into the
  // document) until the window runs out of memory. A stream output keeps its last 1 MB, like PyCharm's console buffer;
  // `dropped` (not saved) counts the characters cut from the front.
  const MAX_STREAM = 1024 * 1024;
  const MAX_OUTPUTS = 500;
  function capStream(o) {
    if (o.text.length <= MAX_STREAM) return;
    let from = o.text.length - MAX_STREAM;
    const nl = o.text.indexOf('\n', from);
    if (nl >= 0 && nl - from < 4096) from = nl + 1;
    o.text = o.text.slice(from);
    o.dropped = (o.dropped || 0) + from;
  }

  const ANSI_RE =/\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  const stripAnsi = (s) => s.replace(ANSI_RE, '');
  function color256(n) {
    if (n < 16) return null;
    if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
    const i = n - 16;
    const lv = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${lv(Math.floor(i / 36))},${lv(Math.floor(i / 6) % 6)},${lv(i % 6)})`;
  }
  function ansiFragment(text) {
    const frag = document.createDocumentFragment();
    const st = { fg: null, bg: null, bold: false, italic: false, underline: false };
    let last = 0;
    const push = (s) => {
      if (!s) return;
      if (st.fg === null && st.bg === null && !st.bold && !st.italic && !st.underline) { frag.append(s); return; }
      const span = document.createElement('span');
      const classes = [];
      if (typeof st.fg === 'number') classes.push(`nb-fg${st.fg}`); else if (st.fg) span.style.color = st.fg;
      if (typeof st.bg === 'number') classes.push(`nb-bg${st.bg}`); else if (st.bg) span.style.background = st.bg;
      if (st.bold) classes.push('nb-bold');
      if (st.italic) classes.push('nb-italic');
      if (st.underline) classes.push('nb-underline');
      span.className = classes.join(' ');
      span.textContent = s;
      frag.append(span);
    };
    for (const m of text.matchAll(ANSI_RE)) {
      push(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] === undefined) continue;
      const codes = m[1] ? m[1].split(';').map(Number) : [0];
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) Object.assign(st, { fg: null, bg: null, bold: false, italic: false, underline: false });
        else if (c === 1) st.bold = true;
        else if (c === 3) st.italic = true;
        else if (c === 4) st.underline = true;
        else if (c === 22) st.bold = false;
        else if (c === 23) st.italic = false;
        else if (c === 24) st.underline = false;
        else if (c >= 30 && c <= 37) st.fg = c - 30;
        else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
        else if (c === 39) st.fg = null;
        else if (c >= 40 && c <= 47) st.bg = c - 40;
        else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
        else if (c === 49) st.bg = null;
        else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
          const n = codes[i + 2];
          const v = n < 16 ? n : color256(n);
          if (c === 38) st.fg = v; else st.bg = v;
          i += 2;
        } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
          const v = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          if (c === 38) st.fg = v; else st.bg = v;
          i += 4;
        }
      }
    }
    push(text.slice(last));
    return frag;
  }

  // ---------- Markdown ----------
  let markedLoad = null;
  // marked's UMD wrapper registers with Monaco's AMD loader when it sees define.amd, so that flag is hidden while it loads.
  function loadMarked() {
    if (window.marked) return Promise.resolve(window.marked);
    markedLoad ||= new Promise((resolve, reject) => {
      const amd = window.define?.amd;
      if (window.define) window.define.amd = undefined;
      const restore = () => { if (window.define && amd) window.define.amd = amd; };
      const s = document.createElement('script');
      s.src = '../node_modules/marked/marked.min.js';
      s.onload = () => { restore(); resolve(window.marked); };
      s.onerror = () => { restore(); markedLoad = null; reject(new Error('marked.min.js failed to load')); };
      document.head.appendChild(s);
    });
    return markedLoad;
  }

  function fileUrl(p) {
    const parts = p.replace(/\\/g, '/').split('/');
    return `file:///${parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/')}`;
  }
  function resolveRel(dir, ref) {
    let rel = ref.split(/[?#]/)[0];
    try { rel = decodeURIComponent(rel); } catch {}
    if (/^[a-zA-Z]:[\\/]/.test(rel)) return rel.replace(/\//g, '\\');
    const out = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
    for (const seg of rel.split(/[\\/]/)) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length <= 1) return null; out.pop(); } else out.push(seg);
    }
    return out.join('\\');
  }

  // Allowlist sanitizer for rendered Markdown: unknown elements are unwrapped, scripts and styles dropped, links and
  // images limited to safe schemes. Notebook attachments and relative images resolve against the notebook.
  const MD_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'mark', 'center', 'font', 'figure', 'figcaption']);
  const MD_DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base',
    'form', 'button', 'textarea', 'select', 'option', 'noscript', 'template', 'svg', 'math', 'video', 'audio', 'title', 'head']);
  const MD_ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'align', 'width', 'height', 'id', 'checked', 'open', 'start']);
  function sanitizeMarkdown(html, { baseDir, attachments }) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walk = (node) => {
      for (const n of [...node.children]) {
        const tag = n.tagName.toLowerCase();
        if (MD_DROP.has(tag)) { n.remove(); continue; }
        walk(n);
        if (!MD_TAGS.has(tag)) { n.replaceWith(...n.childNodes); continue; }
        for (const a of [...n.attributes]) if (!MD_ATTRS.has(a.name.toLowerCase())) n.removeAttribute(a.name);
        if (tag === 'input') {
          if ((n.getAttribute('type') || '') !== 'checkbox') { n.remove(); continue; }
          n.setAttribute('type', 'checkbox');
          n.setAttribute('disabled', '');
        }
        if (n.hasAttribute('href')) {
          const h = n.getAttribute('href').trim();
          if (!/^(https?:|mailto:|#)/i.test(h)) n.removeAttribute('href');
        }
        if (n.hasAttribute('src')) {
          const s = n.getAttribute('src').trim();
          if (tag !== 'img') n.removeAttribute('src');
          else if (/^attachment:/i.test(s)) {
            const bundle = attachments?.[decodeURIComponent(s.slice(11))];
            const mime = bundle && Object.keys(bundle).find((k) => k.startsWith('image/'));
            if (mime) n.setAttribute('src', imageSrc(mime, joinText(bundle[mime]))); else n.removeAttribute('src');
          } else if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) { /* kept */ } else if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) n.removeAttribute('src');
          else {
            const p = resolveRel(baseDir, s);
            if (p) n.setAttribute('src', fileUrl(p)); else n.removeAttribute('src');
          }
        }
      }
    };
    walk(tpl.content);
    return tpl.content;
  }

  function renderMarkdownInto(target, text, ctx) {
    const marked = window.marked;
    target.replaceChildren(sanitizeMarkdown(marked.parse(text, { gfm: true }), ctx));
    for (const code of target.querySelectorAll('pre > code[class*="language-"]')) {
      const lang = (code.className.match(/language-([\w+-]+)/) || [])[1]?.toLowerCase();
      const id = lang === 'py' ? 'python' : lang;
      if (!id || !monaco.languages.getLanguages().some((l) => l.id === id)) continue;
      monaco.editor.colorize(code.textContent, id, { tabSize: 4 }).then((h) => { if (code.isConnected) code.innerHTML = h; }).catch(() => {});
    }
  }

  // ---------- rich outputs ----------
  const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp'];
  const MIME_ORDER = ['text/html', 'text/markdown', 'image/svg+xml', ...IMAGE_MIMES, 'text/latex', 'application/json', 'text/plain'];
  function imageSrc(mime, data) {
    if (mime === 'image/svg+xml') return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
    return `data:${mime};base64,${String(data).replace(/\s+/g, '')}`;
  }

  // HTML outputs run in a sandboxed iframe: an opaque origin with scripts but no access to the IDE, its storage,
  // Node or the parent DOM. A tiny script reports the content height so the frame fits it.
  const frames = new Set();
  addEventListener('message', (e) => {
    if (typeof e.data?.nbFrameHeight !== 'number') return;
    for (const f of frames) {
      if (!f.isConnected) { frames.delete(f); continue; }
      if (f.contentWindow === e.source) f.style.height = `${Math.min(4000, Math.max(16, Math.ceil(e.data.nbFrameHeight)))}px`;
    }
  });
  function htmlFrame(html) {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const f = document.createElement('iframe');
    f.className = 'nb-html';
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.height = '24px';
    f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
html{color-scheme:${document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}}
body{margin:0;display:flow-root;font:13px system-ui,'Segoe UI','Malgun Gothic',sans-serif;color:${v('--text')};background:transparent;overflow-x:auto}
table{border-collapse:collapse;font-size:12px}th,td{border:1px solid ${v('--gray4')};padding:3px 8px;text-align:right}
thead th,tbody th{background:${v('--gray2')};font-weight:600}tbody tr:nth-child(odd){background:${v('--gray2')}55}a{color:${v('--blue8')}}
pre,code{font-family:${v('--mono')}}</style></head><body>${html}<script>(()=>{const post=()=>parent.postMessage({nbFrameHeight:document.body.getBoundingClientRect().height},'*');
new ResizeObserver(post).observe(document.body);addEventListener('load',post);post();})()<\/script></body></html>`;
    frames.add(f);
    return f;
  }

  function renderData(data, metadata, ctx) {
    const mime = MIME_ORDER.find((m) => data[m] !== undefined) || Object.keys(data)[0];
    if (!mime) return el('div');
    const value = data[mime];
    if (mime === 'text/html') return htmlFrame(joinText(value));
    if (mime === 'text/markdown') {
      const box = userEl('div', 'nb-out-md nb-markdown');
      loadMarked().then(() => renderMarkdownInto(box, joinText(value), ctx)).catch(() => { box.textContent = joinText(value); });
      return box;
    }
    if (mime === 'image/svg+xml' || IMAGE_MIMES.includes(mime)) {
      const img = el('img', 'nb-image');
      img.src = imageSrc(mime, joinText(value));
      const m = metadata?.[mime] || metadata || {};
      if (m.width) img.width = m.width;
      if (m.height) img.height = m.height;
      img.dataset.mime = mime;
      return img;
    }
    if (mime === 'application/json' || typeof value === 'object') return userEl('pre', 'nb-text', JSON.stringify(value, null, 2));
    const pre = userEl('pre', 'nb-text');
    pre.appendChild(ansiFragment(joinText(value)));
    return pre;
  }

  // Other plugins add to rendered outputs (the Data View's "View as DataFrame"): fn(wrap, output, {baseDir, host}).
  const outputDecorators = [];
  function renderOutput(o, ctx) {
    const wrap = renderOutputBody(o, ctx);
    for (const fn of outputDecorators) { try { fn(wrap, o, ctx); } catch (err) { console.error(err); } }
    return wrap;
  }
  function renderOutputBody(o, ctx) {
    const wrap = el('div', `nb-output nb-out-${o.output_type}`);
    if (o.output_type === 'stream') {
      // A saved notebook can hold more than a run here keeps (Jupyter writes it all): only its last 1 MB is drawn and
      // the file keeps the rest. Drawn whole, 200,000 lines held the window for two seconds when the notebook opened.
      const long = o.text.length > MAX_STREAM;
      if (o.dropped) wrap.appendChild(el('div', 'nb-dropped', tr('The output is too long; only its last 1 MB is kept.')));
      else if (long) wrap.appendChild(el('div', 'nb-dropped', tr('The output is too long; only its last 1 MB is shown.')));
      const pre = userEl('pre', `nb-text nb-stream nb-${o.name === 'stderr' ? 'stderr' : 'stdout'}`);
      pre.appendChild(ansiFragment(long ? o.text.slice(o.text.indexOf('\n', o.text.length - MAX_STREAM) + 1 || o.text.length - MAX_STREAM) : o.text));
      wrap.appendChild(pre);
    } else if (o.output_type === 'error') {
      const pre = userEl('pre', 'nb-text nb-error');
      const tb = Array.isArray(o.traceback) && o.traceback.length ? o.traceback.join('\n') : `${o.ename}: ${o.evalue}`;
      pre.appendChild(ansiFragment(tb));
      wrap.appendChild(pre);
    } else if (o.data) wrap.appendChild(renderData(o.data, o.metadata, ctx));
    return wrap;
  }

  // ---------- kernel ----------
  // One bridge process per notebook. Requests are written straight away; the bridge queues them until the kernel is up.
  function createKernel(onEvent, onExit) {
    const k = { state: 'none', procId: null, info: null, log: '', interp: null };
    const pending = new Map();
    let seq = 0;
    let buf = '';
    k.running = () => !!k.procId;
    k.start = async (interp, cwd, paths) => {
      if (k.procId) return true;
      k.interp = interp;
      k.log = '';
      buf = '';
      const id = await ide.api.invoke('notebook:start', interp, cwd, paths);
      k.procId = id;
      ide.proc.attach(id, {
        data(text, stream) {
          if (stream === 'err') { k.log = (k.log + text).slice(-20000); return; }
          buf += text;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.ev === 'reply' && pending.has(msg.id)) { pending.get(msg.id)(msg.content); pending.delete(msg.id); } else onEvent(msg);
          }
        },
        exit(code) {
          if (k.procId !== id) return;
          k.procId = null;
          for (const resolve of pending.values()) resolve(null);
          pending.clear();
          onExit(code);
        },
      });
      return true;
    };
    k.send = (msg) => { if (k.procId) ide.proc.input(k.procId, `${JSON.stringify(msg)}\n`); };
    k.request = (op, args, timeout = 4000) => new Promise((resolve) => {
      if (!k.procId) { resolve(null); return; }
      const id = `q${++seq}`;
      pending.set(id, resolve);
      k.send({ op, id, ...args });
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, timeout);
    });
    k.stop = () => {
      const id = k.procId;
      if (!id) return;
      k.send({ op: 'shutdown' });
      k.procId = null;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      setTimeout(() => ide.proc.kill(id), 4000);
    };
    return k;
  }

  // Jupyter counts cursor positions in code points; Monaco in UTF-16 units.
  const toCodePoints = (s, utf16) => [...s.slice(0, utf16)].length;
  const fromCodePoints = (s, cp) => [...s].slice(0, cp).join('').length;

  // ---------- the notebook view ----------
  const CELL_TYPES = () => [
    { value: 'code', label: tr('Code') },
    { value: 'markdown', label: tr('Markdown') },
    { value: 'raw', label: tr('Raw') },
  ];
  const STATE_LABELS = () => ({
    none: tr('Kernel not started'), starting: tr('Starting kernel…'), idle: tr('Idle'), busy: tr('Busy'),
    restarting: tr('Restarting kernel…'), dead: tr('Kernel died'), missing: tr('No kernel'), error: tr('Kernel error'), stopped: tr('Kernel stopped'),
  });
  let clipboard = null; // copied cells, shared by every notebook

  function mountNotebook(host, { path, doc, tab }) {
    host.classList.add('nb-host');
    const authority = `nb${++viewSeq}`;
    const theme = () => (document.documentElement.dataset.theme === 'light' ? 'pycharm-light' : 'pycharm-dark');
    const baseDir = dirname(path);
    const disposers = [];
    let meta = null;
    let cells = []; // {data, el, prompt, input, md, outputs, status, model, editor, editing, runs, started}
    let sel = 0;
    let mode = 'command';
    let applying = false;
    let disposed = false;
    let lastDeleted = [];
    let pendingD = 0;
    let pendingI = 0;
    let pending0 = 0;
    const runs = new Map(); // run id -> cell
    let runSeq = 0;

    // ---------- DOM ----------
    const bar = el('div', 'nb-toolbar');
    const banner = el('div', 'nb-banner hidden');
    const scroller = el('div', 'nb-scroll');
    scroller.tabIndex = 0;
    const list = el('div', 'nb-cells');
    const tail = el('div', 'nb-tail');
    scroller.append(list, tail);
    host.append(bar, banner, scroller);

    const tbtn = (icon, glyph, title, run, cls = '') => {
      const b = el('button', `nb-tbtn ${cls}`);
      b.appendChild(icon ? ide.icon(icon, glyph) : el('span', 'nb-glyph', glyph));
      b.title = title;
      b.onmousedown = (e) => e.preventDefault(); // keep the cell editor focused
      b.onclick = () => run();
      return b;
    };
    const sep = () => el('span', 'nb-sep');
    const runBtn = tbtn('runRun', '▶', `${tr('Run Cell and Select Below')} (Shift+Enter)`, () => runSelected('next'), 'nb-run-cell');
    const runAllBtn = tbtn(null, '⏩', tr('Run All Cells'), () => runAll(), 'nb-run-all');
    const runAboveBtn = tbtn(null, '⤒', tr('Run All Above'), () => runRange(0, sel), 'nb-run-above');
    const runBelowBtn = tbtn(null, '⤓', tr('Run Cell and All Below'), () => runRange(sel, cells.length), 'nb-run-below');
    const interruptBtn = tbtn('runStop', '■', tr('Interrupt Kernel'), () => interrupt(), 'nb-interrupt');
    const restartBtn = tbtn(null, '⟳', tr('Restart Kernel'), () => restartKernel(), 'nb-restart');
    const addCodeBtn = tbtn('add', '+', tr('Add Code Cell Below'), () => insertCell(sel + 1, 'code', { edit: true }), 'nb-add-code');
    const addMdBtn = tbtn(null, 'M↓', tr('Add Markdown Cell Below'), () => insertCell(sel + 1, 'markdown', { edit: true }), 'nb-add-md');
    const upBtn = tbtn(null, '↑', tr('Move Cell Up'), () => moveCell(sel, -1), 'nb-move-up');
    const downBtn = tbtn(null, '↓', tr('Move Cell Down'), () => moveCell(sel, 1), 'nb-move-down');
    const delBtn = tbtn(null, '🗑', tr('Delete Cell'), () => deleteCells(sel), 'nb-delete');
    const clearBtn = tbtn(null, '⌫', tr('Clear All Outputs'), () => clearAllOutputs(), 'nb-clear-all');
    const typeSel = el('select', 'nb-type');
    typeSel.title = tr('Cell Type');
    for (const t of CELL_TYPES()) typeSel.add(new Option(t.label, t.value));
    typeSel.onchange = () => { changeType(sel, typeSel.value); scroller.focus(); };
    const kernelEl = el('span', 'nb-kernel');
    const kernelDot = el('span', 'nb-kernel-dot');
    const kernelText = el('span', 'nb-kernel-text');
    kernelEl.append(kernelDot, kernelText);
    bar.append(runBtn, runAllBtn, runAboveBtn, runBelowBtn, sep(), interruptBtn, restartBtn, sep(), addCodeBtn, addMdBtn, sep(),
      upBtn, downBtn, delBtn, sep(), clearBtn, typeSel, el('span', 'nb-spacer'), kernelEl);

    const addTail = (type, label) => {
      const b = el('button', 'nb-tail-btn', label);
      b.onclick = () => insertCell(cells.length, type, { edit: true });
      return b;
    };
    tail.append(addTail('code', `+ ${tr('Code')}`), addTail('markdown', `+ ${tr('Markdown')}`));

    // ---------- kernel state ----------
    const kernel = createKernel(onKernelEvent, onKernelExit);
    function setKernelState(state) {
      kernel.state = state;
      host.dataset.kernel = state;
      kernelDot.className = `nb-kernel-dot ${state}`;
      const label = STATE_LABELS()[state] || state;
      kernelText.textContent = kernel.info && ['idle', 'busy'].includes(state) ? `Python ${kernel.info.version}: ${label}` : label;
      kernelEl.title = kernel.info ? kernel.info.python : '';
      interruptBtn.disabled = state !== 'busy';
      // Starting or restarting shows as a background task in the status bar; Cancel stops the kernel.
      const starting = state === 'starting' || state === 'restarting';
      if (starting && !kernelTask?.active && ide.tasks) {
        kernelTask = ide.tasks.start({ title: tr('Starting Jupyter kernel: {name}', { name: basename(path) }), text: label,
          onCancel: () => { kernel.stop(); setKernelState('stopped'); } });
      } else if (!starting && kernelTask) { kernelTask.done(); kernelTask = null; }
    }
    let kernelTask = null;
    setKernelState('none');

    function showBanner(kind, text, buttons = [], detail = '') {
      banner.className = `nb-banner ${kind}`;
      banner.dataset.kind = kind;
      const msg = el('span', 'nb-banner-text', text);
      const row = el('span', 'nb-banner-actions');
      for (const b of buttons) {
        const btn = el('button', b.primary ? 'primary' : 'secondary', b.label);
        btn.onclick = b.run;
        if (b.cls) btn.classList.add(b.cls);
        row.appendChild(btn);
      }
      banner.replaceChildren(msg, row);
      if (detail) {
        const pre = userEl('pre', 'nb-banner-log', detail);
        banner.appendChild(pre);
      }
    }
    const hideBanner = () => { banner.className = 'nb-banner hidden'; banner.replaceChildren(); delete banner.dataset.kind; };

    async function ensureKernel() {
      if (kernel.running()) return true;
      const interp = ide.currentInterp();
      if (!interp) {
        showBanner('error', tr('No Python interpreter found. Choose one in Settings › Python Interpreter.'));
        return false;
      }
      hideBanner();
      setKernelState('starting');
      try {
        await kernel.start(interp, baseDir, ide.root ? [ide.root] : []);
      } catch (e) {
        setKernelState('error');
        showBanner('error', tr('Could not start the kernel: {error}', { error: cleanError(e) }));
        return false;
      }
      return true;
    }

    function onKernelEvent(msg) {
      if (disposed) return;
      switch (msg.ev) {
        case 'ready':
          kernel.info = { python: msg.python, version: msg.version };
          setKernelState('idle');
          break;
        case 'restarted':
          setKernelState('idle');
          break;
        case 'status':
          if (['idle', 'busy'].includes(kernel.state)) setKernelState(msg.state === 'busy' ? 'busy' : 'idle');
          break;
        case 'count': {
          const c = runs.get(msg.id);
          if (c) { c.running = true; c.started = performance.now(); renderPrompt(c); }
          break;
        }
        case 'output': addOutput(runs.get(msg.id), msg.output, msg.display_id); break;
        case 'update': updateDisplay(msg.display_id, msg.data, msg.metadata); break;
        case 'clear': {
          const c = runs.get(msg.id);
          if (!c) break;
          if (msg.wait) c.clearPending = true; else setOutputs(c, []);
          break;
        }
        case 'stdin': askInput(runs.get(msg.id), msg.prompt, msg.password); break;
        case 'done': finishRun(msg.id, msg.status, msg.n); break;
        case 'dead':
          setKernelState('dead');
          showBanner('error', tr('The kernel died. Restart it to run cells again.'), [{ label: tr('Restart Kernel'), primary: true, run: () => restartKernel() }]);
          break;
        case 'fatal':
          if (msg.kind === 'missing') offerInstall(msg.module, msg.python);
          else {
            setKernelState('error');
            showBanner('error', tr('Could not start the kernel: {error}', { error: msg.message }), [], kernel.log.trim());
          }
          break;
        default:
      }
    }

    function onKernelExit() {
      if (disposed) return;
      for (const id of [...runs.keys()]) finishRun(id, 'dead', null);
      if (!['missing', 'error', 'dead'].includes(kernel.state)) setKernelState('stopped');
    }

    // ipykernel missing from the interpreter: install it through the Install Manager's pip queue.
    function offerInstall(module, python) {
      setKernelState('missing');
      const pkg = module === 'jupyter_client' || module === 'zmq' ? 'ipykernel' : module || 'ipykernel';
      const item = installItem();
      const text = tr('{package} is not installed for this interpreter ({python}). Notebooks need it to run code.', { package: pkg, python });
      if (!item) {
        showBanner('warn', `${text} ${tr('Install it with pip, then run the cell again.')}`);
        return;
      }
      showBanner('warn', text, [
        { label: tr('Install ipykernel'), primary: true, cls: 'nb-install', run: () => installKernel(item) },
        { label: tr('Open Install Manager'), run: () => ide.installer.open('python') },
      ]);
    }
    async function installKernel(item) {
      let log = '';
      showBanner('info', tr('Installing ipykernel…'), [], ' ');
      const logEl = banner.querySelector('.nb-banner-log');
      const write = (t) => { log = (log + t).slice(-8000); logEl.textContent = log; logEl.scrollTop = logEl.scrollHeight; };
      const logger = (t) => write(String(t).endsWith('\n') ? String(t) : `${t}\n`);
      logger.raw = write;
      const task = ide.tasks?.start({ title: tr('Installing ipykernel…') });
      try {
        await item.install(logger, () => {}, new AbortController().signal);
        task?.done();
      } catch (e) {
        task?.done();
        showBanner('error', tr('Could not install ipykernel: {error}', { error: cleanError(e) }), [
          { label: tr('Open Install Manager'), run: () => ide.installer.open('python') },
        ], log.trim());
        return;
      }
      ide.installer.refresh?.();
      showBanner('info', tr('ipykernel installed. Starting the kernel…'));
      setKernelState('none');
      if (await ensureKernel()) setTimeout(() => { if (banner.dataset.kind === 'info') hideBanner(); }, 1500);
    }

    async function restartKernel() {
      for (const id of [...runs.keys()]) finishRun(id, 'aborted', null);
      if (kernel.running() && !['missing', 'error', 'dead', 'stopped'].includes(kernel.state)) {
        setKernelState('restarting');
        kernel.send({ op: 'restart' });
        return;
      }
      kernel.stop();
      setKernelState('none');
      hideBanner();
      await ensureKernel();
    }
    function interrupt() {
      if (kernel.running()) kernel.send({ op: 'interrupt' });
    }

    // ---------- cells ----------
    let modelSeq = 0;
    function makeCell(data) {
      const c = { data, editing: data.type !== 'markdown', runs: 0, running: false, clearPending: false, elapsed: null };
      c.el = el('div', 'nb-cell');
      const gutter = el('div', 'nb-gutter');
      const run = el('button', 'nb-cell-run');
      run.appendChild(ide.icon('runRun', '▶'));
      run.title = tr('Run Cell');
      run.onclick = (e) => { e.stopPropagation(); select(cells.indexOf(c)); runCell(c, 'stay'); };
      c.prompt = el('div', 'nb-prompt');
      gutter.append(run, c.prompt);
      const body = el('div', 'nb-body');
      c.input = el('div', 'nb-input');
      c.placeholder = userEl('pre', 'nb-placeholder');
      c.input.appendChild(c.placeholder);
      c.md = userEl('div', 'nb-md nb-markdown');
      c.status = el('div', 'nb-status');
      c.outputs = el('div', 'nb-outputs');
      body.append(c.input, c.md, c.status, c.outputs);
      const tools = el('div', 'nb-cell-tools');
      const tool = (glyph, title, fn) => {
        const b = el('button', 'nb-cell-tool', glyph);
        b.title = title;
        b.onmousedown = (e) => e.preventDefault();
        b.onclick = (e) => { e.stopPropagation(); fn(cells.indexOf(c)); };
        return b;
      };
      tools.append(tool('↑', tr('Move Cell Up'), (i) => moveCell(i, -1)), tool('↓', tr('Move Cell Down'), (i) => moveCell(i, 1)),
        tool('⌫', tr('Clear Outputs'), (i) => setOutputs(cells[i], [])), tool('🗑', tr('Delete Cell'), (i) => deleteCells(i)));
      c.el.append(gutter, body, tools);
      c.model = monaco.editor.createModel(data.source, langOf(data.type),
        monaco.Uri.from({ scheme: SCHEME, authority, path: `/cell${++modelSeq}.${data.type === 'code' ? 'py' : data.type === 'markdown' ? 'md' : 'txt'}` }));
      c.model.updateOptions({ tabSize: 4, insertSpaces: true });
      c.model.setEOL(monaco.editor.EndOfLineSequence.LF); // Jupyter sources use LF line breaks on every OS
      c.model.onDidChangeContent(() => {
        c.data.source = c.model.getValue();
        if (!c.editor) c.placeholder.textContent = c.data.source || ' ';
        changed();
      });
      c.el.addEventListener('mousedown', (e) => {
        const i = cells.indexOf(c);
        if (e.target.closest('.nb-input') && c.editor) return; // the editor's focus handler selects it
        select(i);
        if (!e.target.closest('input, .nb-html, a, select')) setTimeout(() => { if (mode === 'command' && !scroller.contains(document.activeElement)) scroller.focus(); });
      });
      c.input.addEventListener('mousedown', () => {
        if (c.editor) return;
        select(cells.indexOf(c));
        setTimeout(() => edit(c));
      });
      c.md.addEventListener('dblclick', () => edit(c));
      c.md.addEventListener('click', (e) => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        const h = a.getAttribute('href');
        if (/^https?:/i.test(h)) ide.api.invoke('shell:openExternal', h);
        else if (h.startsWith('#')) {
          const id = decodeURIComponent(h.slice(1));
          [...list.querySelectorAll('.nb-md [id]')].find((n) => n.id === id)?.scrollIntoView({ block: 'start' });
        }
      });
      renderCell(c);
      observer.observe(c.input);
      return c;
    }
    const langOf = (type) => (type === 'code' ? 'python' : type === 'markdown' ? 'markdown' : 'plaintext');

    // Monaco editors are created when a cell comes near the viewport; until then a plain copy of the source stands in.
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const c = cells.find((x) => x.input === e.target);
        if (c && c.editing) ensureEditor(c);
      }
    }, { root: scroller, rootMargin: '800px 0px' });

    function ensureEditor(c) {
      if (c.editor || disposed) return c.editor;
      c.placeholder.remove();
      const host2 = el('div', 'nb-editor');
      c.input.appendChild(host2);
      const ed = ide.createEditor(host2, {
        model: c.model, theme: theme(), automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
        lineNumbers: 'off', glyphMargin: false, folding: false, lineDecorationsWidth: 8, overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true, overviewRulerBorder: false, renderLineHighlight: 'none', fixedOverflowWidgets: true,
        stickyScroll: { enabled: false }, wordWrap: 'off', rulers: [], padding: { top: 6, bottom: 6 },
        scrollbar: { vertical: 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false, verticalScrollbarSize: 0, horizontalScrollbarSize: 8 },
      });
      c.editor = ed;
      const fit = () => {
        const h = Math.max(ed.getContentHeight(), 20);
        if (host2.style.height !== `${h}px`) { host2.style.height = `${h}px`; ed.layout(); }
      };
      ed.onDidContentSizeChange(fit);
      fit();
      ed.onDidFocusEditorText(() => {
        const i = cells.indexOf(c);
        if (i >= 0) { select(i, { scroll: false }); setMode('edit'); }
      });
      ed.onDidBlurEditorText(() => {
        setTimeout(() => {
          if (disposed || cells.some((x) => x.editor?.hasTextFocus())) return;
          setMode('command');
        });
      });
      ed.onKeyDown((e) => editorKey(c, e));
      return ed;
    }

    function disposeCell(c) {
      observer.unobserve(c.input);
      c.editor?.dispose();
      c.model.dispose();
      c.el.remove();
    }

    function renderPrompt(c) {
      if (c.data.type !== 'code') { c.prompt.textContent = ''; return; }
      c.prompt.textContent = c.runs > 0 ? '[*]:' : `[${c.data.count ?? ' '}]:`;
      c.el.classList.toggle('running', c.running);
      c.el.classList.toggle('queued', c.runs > 0 && !c.running);
    }

    function renderCell(c) {
      const { type } = c.data;
      c.el.dataset.type = type;
      c.el.classList.toggle('editing', c.editing);
      c.input.classList.toggle('hidden', !c.editing);
      c.md.classList.toggle('hidden', type !== 'markdown' || c.editing);
      c.outputs.classList.toggle('hidden', type !== 'code');
      if (!c.editor) c.placeholder.textContent = c.data.source || ' ';
      if (type === 'markdown' && !c.editing) renderMd(c);
      renderPrompt(c);
      renderStatus(c);
      renderOutputs(c);
    }

    function renderMd(c) {
      const text = c.data.source;
      if (!text.trim()) {
        c.md.replaceChildren(el('div', 'nb-md-empty', tr('Empty Markdown cell. Double-click to edit.')));
        return;
      }
      loadMarked().then(() => {
        if (!disposed) renderMarkdownInto(c.md, text, { baseDir, attachments: c.data.raw.attachments });
        c.md.dataset.rendered = String(Number(c.md.dataset.rendered || 0) + 1);
      }).catch((e) => { c.md.textContent = text; console.warn(e); });
    }

    function renderStatus(c) {
      if (c.data.type !== 'code' || c.elapsed === null) { c.status.textContent = ''; c.status.className = 'nb-status'; return; }
      const ms = c.elapsed.ms;
      c.status.className = `nb-status ${c.elapsed.ok ? 'ok' : 'failed'}`;
      c.status.textContent = `${c.elapsed.ok ? '✓' : '✗'} ${ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}`;
    }

    const outputCtx = () => ({ baseDir, attachments: null, host });
    function renderOutputs(c) {
      if (c.data.type !== 'code') { c.outputs.replaceChildren(); return; }
      c.outputs.replaceChildren(...c.data.outputs.map((o) => renderOutput(o, outputCtx())));
      if (c.outputsDropped) c.outputs.prepend(droppedNote());
      if (c.stdin) c.outputs.appendChild(c.stdin);
    }

    function setOutputs(c, outputs) {
      if (!c) return;
      c.data.outputs = outputs;
      c.clearPending = false;
      c.outputsDropped = false;
      renderOutputs(c);
      changed();
    }

    function addOutput(c, output, displayId) {
      if (!c) return;
      // clear_output(wait=True): the old outputs go when the next one arrives, from the page as well.
      if (c.clearPending) { c.data.outputs = []; c.clearPending = false; c.outputsDropped = false; renderOutputs(c); }
      const outs = c.data.outputs;
      const o = readOutput(output);
      if (displayId) o.displayId = displayId;
      const last = outs[outs.length - 1];
      if (o.output_type === 'stream' && last?.output_type === 'stream' && last.name === o.name) {
        last.text = fixConsole(last.text + o.text);
        capStream(last);
        const node = c.outputs.querySelectorAll('.nb-output')[outs.length - 1];
        node?.replaceWith(renderOutput(last, outputCtx()));
      } else {
        if (o.output_type === 'stream') { o.text = fixConsole(o.text); capStream(o); }
        outs.push(o);
        const node = renderOutput(o, outputCtx());
        if (c.stdin?.isConnected) c.outputs.insertBefore(node, c.stdin); else c.outputs.appendChild(node);
      }
      capOutputs(c);
      changed();
    }

    // Each switch between stdout and stderr (and each display() call) starts a new output, so a cell printing
    // without end would also grow without bound in outputs: it keeps its last MAX_OUTPUTS outputs and the last
    // MAX_STREAM characters of stream text over all of them, dropping the oldest outputs (and noting it) beyond that.
    function capOutputs(c) {
      const outs = c.data.outputs;
      let text = 0;
      for (const o of outs) if (o.output_type === 'stream') text += o.text.length;
      let drop = 0;
      while (outs.length - drop > 1 && (outs.length - drop > MAX_OUTPUTS || text > MAX_STREAM)) {
        if (outs[drop].output_type === 'stream') text -= outs[drop].text.length;
        drop++;
      }
      if (!drop) return;
      const nodes = c.outputs.querySelectorAll('.nb-output');
      for (let i = 0; i < drop; i++) nodes[i]?.remove();
      outs.splice(0, drop);
      if (!c.outputsDropped) c.outputs.prepend(droppedNote());
      c.outputsDropped = true;
    }
    const droppedNote = () => el('div', 'nb-dropped', tr('The cell has too much output; only its latest outputs are kept.'));

    function updateDisplay(displayId, data, metadata) {
      if (!displayId) return;
      for (const c of cells) {
        let hit = false;
        for (const o of c.data.outputs) {
          if (o.displayId !== displayId) continue;
          o.data = rejoinBundle(data);
          o.metadata = metadata || {};
          hit = true;
        }
        if (hit) { renderOutputs(c); changed(); }
      }
    }

    function askInput(c, prompt, password) {
      if (!c) return;
      const row = el('div', 'nb-stdin');
      const label = userEl('span', 'nb-stdin-prompt', prompt);
      const input = el('input', 'nb-stdin-input');
      input.type = password ? 'password' : 'text';
      input.placeholder = tr('Input for the running cell; Enter sends it');
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key !== 'Enter') return;
        const value = input.value;
        row.remove();
        c.stdin = null;
        addOutput(c, { output_type: 'stream', name: 'stdout', text: `${prompt}${password ? '········' : value}\n` });
        kernel.send({ op: 'input', value });
      };
      row.append(label, input);
      c.stdin = row;
      c.outputs.appendChild(row);
      input.focus();
    }

    function finishRun(id, status, n) {
      const c = runs.get(id);
      runs.delete(id);
      if (!c) return;
      c.runs = Math.max(0, c.runs - 1);
      if (c.runs === 0) {
        c.running = false;
        c.stdin?.remove();
        c.stdin = null;
        if (c.clearPending) { c.clearPending = false; c.data.outputs = []; c.outputsDropped = false; renderOutputs(c); }
      }
      if (n !== null && n !== undefined) c.data.count = n;
      if (status === 'ok' || status === 'error') c.elapsed = { ms: performance.now() - (c.started || performance.now()), ok: status === 'ok' };
      renderPrompt(c);
      renderStatus(c);
      changed();
      ide.emit('notebookExecuted', host.notebook);
    }

    // ---------- running ----------
    async function runCell(c, advance) {
      if (!c) return;
      const i = cells.indexOf(c);
      if (c.data.type === 'markdown') {
        c.editing = false;
        renderCell(c);
      } else if (c.data.type === 'code') {
        await execute(c);
      }
      if (advance === 'insert') insertCell(i + 1, 'code', { edit: true });
      else if (advance === 'next') {
        if (i === cells.length - 1) insertCell(i + 1, 'code', { edit: true });
        else {
          select(i + 1);
          if (mode === 'edit' && cells[i + 1].data.type === 'code') edit(cells[i + 1]);
          else { setMode('command'); scroller.focus(); }
        }
      } else if (c.data.type === 'markdown') { setMode('command'); scroller.focus(); }
    }

    async function execute(c) {
      setOutputs(c, []);
      c.elapsed = null;
      c.runs++;
      c.started = performance.now();
      renderPrompt(c);
      renderStatus(c);
      if (!(await ensureKernel())) { c.runs--; renderPrompt(c); return; }
      const id = `r${++runSeq}`;
      runs.set(id, c);
      kernel.send({ op: 'execute', id, code: c.data.source });
    }

    async function runRange(from, to) {
      for (const c of cells.slice(from, to)) {
        if (c.data.type === 'markdown' && c.editing) { c.editing = false; renderCell(c); }
        if (c.data.type === 'code') await execute(c);
      }
    }
    const runAll = () => runRange(0, cells.length);
    function runSelected(advance) {
      const c = cells[sel];
      if (c) runCell(c, advance);
    }

    // ---------- selection, editing and structure ----------
    function select(i, { scroll = true } = {}) {
      if (!cells.length) return;
      sel = Math.max(0, Math.min(cells.length - 1, i));
      cells.forEach((c, k) => c.el.classList.toggle('selected', k === sel));
      typeSel.value = cells[sel].data.type;
      host.dataset.selected = String(sel);
      if (scroll) {
        const r = cells[sel].el.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        if (r.top < s.top || r.top > s.bottom - 40) cells[sel].el.scrollIntoView({ block: r.height > s.height ? 'start' : 'nearest' });
      }
    }
    function setMode(m) {
      mode = m;
      host.dataset.mode = m;
    }
    function edit(c, where) {
      if (!c.editing) { c.editing = true; renderCell(c); }
      const ed = ensureEditor(c);
      if (!ed) return;
      select(cells.indexOf(c));
      setMode('edit');
      ed.focus();
      if (where === 'end') {
        const last = c.model.getLineCount();
        ed.setPosition({ lineNumber: last, column: c.model.getLineMaxColumn(last) });
      } else if (where === 'start') ed.setPosition({ lineNumber: 1, column: 1 });
    }
    function toCommand() {
      const c = cells[sel];
      if (c?.data.type === 'markdown' && c.editing && c.data.source.trim()) { c.editing = false; renderCell(c); }
      setMode('command');
      scroller.focus();
    }

    function insertCell(i, type, { edit: startEdit = false, data } = {}) {
      const d = data || newCell(type, '', (meta.nbformat_minor ?? 0) >= 5);
      const c = makeCell(d);
      i = Math.max(0, Math.min(cells.length, i));
      list.insertBefore(c.el, cells[i]?.el || null);
      cells.splice(i, 0, c);
      host.dataset.cells = String(cells.length);
      select(i);
      changed();
      if (startEdit) edit(c); else { setMode('command'); scroller.focus(); }
      return c;
    }

    function deleteCells(i) {
      const c = cells[i];
      if (!c) return;
      lastDeleted.push({ index: i, data: snapshot(c) });
      if (lastDeleted.length > 20) lastDeleted.shift();
      for (const [id, x] of runs) if (x === c) runs.delete(id);
      disposeCell(c);
      cells.splice(i, 1);
      host.dataset.cells = String(cells.length);
      if (!cells.length) insertCell(0, 'code');
      select(Math.min(i, cells.length - 1));
      setMode('command');
      scroller.focus();
      changed();
    }
    function undoDelete() {
      const last = lastDeleted.pop();
      if (last) insertCell(last.index, last.data.type, { data: last.data });
    }
    const snapshot = (c) => ({ ...c.data, raw: structuredClone(c.data.raw), outputs: c.data.outputs.map((o) => ({ ...o })) });

    function moveCell(i, delta) {
      const j = i + delta;
      if (!cells[i] || j < 0 || j >= cells.length) return;
      const [c] = cells.splice(i, 1);
      cells.splice(j, 0, c);
      list.insertBefore(c.el, j + 1 < cells.length ? cells[j + 1].el : null);
      select(j);
      if (c.editor?.hasTextFocus()) c.editor.focus();
      changed();
    }

    function changeType(i, type) {
      const c = cells[i];
      if (!c || c.data.type === type) return;
      c.data.type = type;
      if (type !== 'code') { c.data.outputs = []; c.data.count = null; c.elapsed = null; c.outputsDropped = false; }
      c.editing = true;
      monaco.editor.setModelLanguage(c.model, langOf(type));
      renderCell(c);
      if (c.editing && c.editor) c.editor.layout();
      select(i);
      changed();
    }

    function clearAllOutputs() {
      for (const c of cells) {
        if (c.data.type !== 'code') continue;
        c.data.outputs = [];
        c.data.count = null;
        c.elapsed = null;
        c.outputsDropped = false;
        renderCell(c);
      }
      changed();
    }

    // ---------- keyboard ----------
    // Esc first closes what Monaco or other plugins show in the cell (suggestions, find, hints, AI ghost text).
  const widgetOpen = (ed) => !!ed.getDomNode()?.querySelector('.suggest-widget.visible, .find-widget.visible, .parameter-hints-widget.visible, .rename-box, .ghost-text-decoration, .ghost-text');
    function editorKey(c, e) {
      const K = monaco.KeyCode;
        if (e.keyCode === K.Enter && (e.shiftKey || e.ctrlKey || e.altKey) && !(e.shiftKey && e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        runCell(c, e.shiftKey ? 'next' : e.altKey ? 'insert' : 'stay');
        return;
      }
      if (e.keyCode === K.Escape && !widgetOpen(c.editor)) {
        e.preventDefault();
        toCommand();
        return;
      }
      const noMods = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (noMods && (e.keyCode === K.UpArrow || e.keyCode === K.DownArrow) && !widgetOpen(c.editor)) {
        const pos = c.editor.getPosition();
        const i = cells.indexOf(c);
        if (e.keyCode === K.UpArrow && pos.lineNumber === 1 && i > 0) {
          e.preventDefault();
          editOrSelect(i - 1, 'end');
        } else if (e.keyCode === K.DownArrow && pos.lineNumber === c.model.getLineCount() && i < cells.length - 1) {
          e.preventDefault();
          editOrSelect(i + 1, 'start');
        }
      }
    }
    function editOrSelect(i, where) {
      const c = cells[i];
      if (c.data.type === 'markdown' && !c.editing) { select(i); setMode('command'); scroller.focus(); } else edit(c, where);
    }

    scroller.addEventListener('keydown', (e) => {
      if (e.target !== scroller || !cells.length) return;
      const k = e.key;
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      const c = cells[sel];
      const consume = () => { e.preventDefault(); e.stopPropagation(); };
      if (k === 'Enter' && (e.shiftKey || e.ctrlKey || e.altKey)) { consume(); runCell(c, e.shiftKey ? 'next' : e.altKey ? 'insert' : 'stay'); return; }
      if (!plain) return;
      if (k !== 'd') pendingD = 0;
      if (k !== 'i') pendingI = 0;
      if (k !== '0') pending0 = 0;
      const now = performance.now();
      switch (e.shiftKey ? `Shift+${k}` : k) {
        case 'Enter': consume(); edit(c, 'start'); break;
        case 'ArrowUp': case 'k': consume(); select(sel - 1); break;
        case 'ArrowDown': case 'j': consume(); select(sel + 1); break;
        case 'Home': consume(); select(0); break;
        case 'End': consume(); select(cells.length - 1); break;
        case 'a': consume(); insertCell(sel, 'code'); break;
        case 'b': consume(); insertCell(sel + 1, 'code'); break;
        case 'm': consume(); changeType(sel, 'markdown'); break;
        case 'y': consume(); changeType(sel, 'code'); break;
        case 'r': consume(); changeType(sel, 'raw'); break;
        case 'z': consume(); undoDelete(); break;
        case 'c': consume(); clipboard = [snapshot(c)]; break;
        case 'x': consume(); clipboard = [snapshot(c)]; deleteCells(sel); break;
        case 'v': case 'Shift+V':
          consume();
          if (clipboard) for (const d of [...clipboard].reverse()) insertCell(k === 'V' ? sel : sel + 1, d.type, { data: { ...structuredClone(d), raw: withNewId(d.raw) } });
          break;
        case 'd':
          consume();
          if (pendingD && now - pendingD < 800) { pendingD = 0; deleteCells(sel); } else pendingD = now;
          break;
        case 'i':
          consume();
          if (pendingI && now - pendingI < 800) { pendingI = 0; interrupt(); } else pendingI = now;
          break;
        case '0':
          consume();
          if (pending0 && now - pending0 < 800) { pending0 = 0; restartKernel(); } else pending0 = now;
          break;
        default:
      }
    });
    const withNewId = (raw) => {
      const copy = structuredClone(raw);
      if (copy.id) copy.id = newCellId();
      return copy;
    };

    // ---------- document sync ----------
    function serialize() {
      return `${stringify({ ...meta, cells: cells.map((c) => cellJson(c.data)) })}\n`;
    }
    let flushTimer = 0;
    function flush() {
      clearTimeout(flushTimer);
      flushTimer = 0;
      if (disposed || !meta) return;
      const text = serialize();
      if (text === doc.model.getValue()) return;
      applying = true;
      try { doc.model.setValue(text); } finally { applying = false; }
      ide.renderTabs();
    }
    // The first change after a save is written at once so the tab turns dirty before a quick Ctrl+S; later ones batch.
    function changed() {
      if (applying || !meta) return;
      if (!ide.isDirty(tab)) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, 300);
    }
    disposers.push(ide.on('beforeSave', (t) => { if (t?.doc === doc || t?.path === path) flush(); }));

    function load(text) {
      let parsed;
      try { parsed = parseNotebook(text); } catch (e) {
        host.dataset.invalid = 'true';
        meta = null;
        for (const c of cells) disposeCell(c);
        cells = [];
        showBanner('error', tr('This notebook cannot be opened: {error}', { error: cleanError(e) }), [
          { label: tr('Open as Text'), primary: true, run: () => ide.openFile(path, { asText: true }) },
        ]);
        return;
      }
      delete host.dataset.invalid;
      if (banner.dataset.kind === 'error' && !kernel.running()) hideBanner();
      for (const c of cells) disposeCell(c);
      runs.clear();
      meta = parsed.meta;
      cells = parsed.cells.map(makeCell);
      list.replaceChildren(...cells.map((c) => c.el));
      select(Math.min(sel, cells.length - 1), { scroll: false });
      host.dataset.cells = String(cells.length);
    }
    let reloadTimer = 0;
    disposers.push(doc.model.onDidChangeContent(() => {
      if (applying) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load(doc.model.getValue()), 200);
    }));

    disposers.push(ide.on('interpreterChanged', () => {
      if (!kernel.running() || disposed) return;
      showBanner('info', tr('The project interpreter changed. Restart the kernel to use it.'), [
        { label: tr('Restart Kernel'), primary: true, run: () => { kernel.stop(); setKernelState('none'); hideBanner(); ensureKernel(); } },
      ]);
    }));

    load(doc.model.getValue());
    setMode('command');

    const view = {
      path, tab, host, kernel, authority,
      cells: () => cells,
      runAll, restartKernel, interrupt, clearAllOutputs, select, edit: (i) => edit(cells[i]), runCell: (i, adv = 'stay') => runCell(cells[i], adv),
      insertCell, deleteCells, moveCell, changeType, flush, serialize,
      cellOfModel: (model) => cells.find((c) => c.model === model),
    };
    views.set(authority, view);
    tab.notebook = view;
    host.notebook = view;

    return {
      dispose() {
        disposed = true;
        flush();
        clearTimeout(reloadTimer);
        views.delete(authority);
        kernelTask?.done();
        kernel.stop();
        observer.disconnect();
        for (const c of cells) disposeCell(c);
        for (const d of disposers) (typeof d === 'function' ? d() : d.dispose());
      },
    };
  }

  // ---------- kernel completion and hover for code cells ----------
  const KINDS = monaco.languages.CompletionItemKind;
  const KIND_OF = { function: KINDS.Function, class: KINDS.Class, module: KINDS.Module, instance: KINDS.Variable, statement: KINDS.Variable,
    keyword: KINDS.Keyword, param: KINDS.Variable, path: KINDS.File, property: KINDS.Property, magic: KINDS.Function };
  const viewOf = (model) => (model.uri.scheme === SCHEME ? views.get(model.uri.authority) : null);
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, _ctx, token) {
      const view = viewOf(model);
      if (!view || view.kernel.state !== 'idle') return undefined;
      const code = model.getValue();
      const r = await view.kernel.request('complete', { code, pos: toCodePoints(code, model.getOffsetAt(position)) });
      if (!r || r.status !== 'ok' || token.isCancellationRequested || model.isDisposed()) return undefined;
      const start = model.getPositionAt(fromCodePoints(code, r.cursor_start));
      const end = model.getPositionAt(fromCodePoints(code, r.cursor_end));
      const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
      const types = r.metadata?._jupyter_types_experimental || [];
      return {
        suggestions: r.matches.map((m, i) => ({
          label: m, insertText: m, range, kind: KIND_OF[types[i]?.type] ?? KINDS.Text,
          detail: types[i]?.signature || types[i]?.type || undefined, sortText: String(i).padStart(5, '0'),
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, position, token) {
      const view = viewOf(model);
      if (!view || view.kernel.state !== 'idle') return undefined;
      const word = model.getWordAtPosition(position);
      if (!word) return undefined;
      const code = model.getValue();
      const r = await view.kernel.request('inspect', { code, pos: toCodePoints(code, model.getOffsetAt({ lineNumber: position.lineNumber, column: word.endColumn })) }, 2500);
      const text = r?.found && r.data?.['text/plain'] ? stripAnsi(r.data['text/plain']).trim() : '';
      if (!text || token.isCancellationRequested) return undefined;
      const short = text.length > 3000 ? `${text.slice(0, 3000)}…` : text;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value: `\`\`\`text\n${short.replace(/```/g, '`​``')}\n\`\`\`` }],
      };
    },
  });

  // ---------- registration ----------
  ide.registerFileViewer({ id: 'notebook', icon: '📓', text: true, match: (p) => /\.ipynb$/i.test(p), mount: mountNotebook });

  const activeView = () => ide.activeTab()?.notebook || null;
  const onNotebook = () => !!activeView();
  ide.registerAction({ id: 'Notebook.RunAll', title: tr('Run All Cells'), when: onNotebook, run: () => activeView()?.runAll() });
  ide.registerAction({ id: 'Notebook.RestartKernel', title: tr('Restart Kernel'), when: onNotebook, run: () => activeView()?.restartKernel() });
  ide.registerAction({ id: 'Notebook.InterruptKernel', title: tr('Interrupt Kernel'), when: onNotebook, run: () => activeView()?.interrupt() });
  ide.registerAction({ id: 'Notebook.ClearOutputs', title: tr('Clear All Outputs'), when: onNotebook, run: () => activeView()?.clearAllOutputs() });

  async function newNotebook(dir = ide.root) {
    if (!dir) return;
    const name = await ide.ui.prompt(tr('New Jupyter Notebook name'), 'Untitled.ipynb');
    if (!name) return;
    const target = joinPath(dir, /\.ipynb$/i.test(name) ? name : `${name}.ipynb`);
    if (await ide.api.exists(target)) { ide.ui.alert(tr('{name} already exists', { name: basename(target) })); return; }
    const nb = { ...newNotebookMeta(), cells: [cellJson(newCell('code', '', true))] };
    await ide.api.write(target, `${stringify(nb)}\n`);
    ide.refreshTree?.();
    ide.emit('filesChanged', { created: [target] });
    ide.openFile(target);
  }
  ide.registerAction({ id: 'NewJupyterNotebook', title: tr('New Jupyter Notebook'), run: () => newNotebook() });
  ide.registerTreeAction({ title: tr('New Jupyter Notebook'), run: (e) => newNotebook(e.dir ? e.path : dirname(e.path)) });

  // ipykernel in the project interpreter, listed with the other Python tools in the Install Manager.
  let kernelItem = null;
  function installItem() {
    if (kernelItem || !ide.installer?.pip) return kernelItem;
    // register() emits installablesChanged, which calls back here; the item is assigned before that.
    kernelItem = ide.installer.pip({ package: 'ipykernel', name: 'ipykernel', description: tr('The IPython kernel that runs Jupyter notebook cells.') });
    ide.installer.register(kernelItem);
    return kernelItem;
  }
  ide.on('installablesChanged', () => { if (!kernelItem && ide.installer?.pip) installItem(); });
  if (ide.installer?.pip) installItem();

  // 'notebookExecuted' (view) fires after each cell run; view.kernel.request('evaluate', {expr}) evaluates an expression
  // silently in the kernel (the reply's user_expressions.r).
  ide.notebook = {
    addOutputDecorator: (fn) => outputDecorators.push(fn),
    views: () => [...views.values()],
    parse: parseNotebook,
    stringify: (nb) => `${stringify(nb)}\n`,
  };
})();
