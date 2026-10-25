// PyIDE core: editor, tabs, project tree, and the registries features plug into (see FEATURES.md).
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const basename = (p) => p.split(/[\\/]/).pop();

// ResizeObserver with its work moved to the next animation frame, and skipped while the size stays the same. A callback
// that changes layout (a redraw, a terminal fit, a scrollbar appearing) then cannot re-trigger itself within the same
// frame, which the browser reports as "ResizeObserver loop completed with undelivered notifications".
function observeSize(target, fn) {
  let frame = 0;
  let last = '';
  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (size === last) return;
    last = size;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fn(r));
  });
  ro.observe(target);
  return { disconnect: () => { cancelAnimationFrame(frame); ro.disconnect(); } };
}
const dirname = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const joinPath = (a, b) => `${a.replace(/[\\/]+$/, '')}\\${b}`;
// A file's identity: its path in lower case, except the names inside folders with case sensitivity turned on, where
// a.py and A.py are two files. Main finds those folders (main/path-case.js, which keys paths the same way) when a
// project or document opens (learnPathCase), before the document is keyed.
const caseSensitive = new Set(); // dirKey of each case-sensitive folder
const caseSensitiveLower = [];
const dirKey = (key) => key.replace(/[\\/]+/g, '\\').replace(/\\$/, '');
const pathKey = (p) => {
  const lower = p.toLowerCase();
  if (!caseSensitive.size) return lower;
  const probe = `${dirKey(lower)}\\`;
  if (!caseSensitiveLower.some((d) => probe.startsWith(`${d}\\`))) return lower;
  const parts = p.split(/([\\/]+)/);
  let key = '';
  for (let i = 0; i < parts.length; i += 2) key += (i && caseSensitive.has(dirKey(key)) ? parts[i] : parts[i].toLowerCase()) + (parts[i + 1] || '');
  return key;
};
const learnPathCase = async (folder) => {
  for (const k of await window.api.invoke('fs:caseSensitiveDirs', folder).catch(() => [])) {
    if (!caseSensitive.has(k)) { caseSensitive.add(k); caseSensitiveLower.push(k.toLowerCase()); }
  }
};
const samePath = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
// `p` is `dir` itself or inside it: a whole-segment prefix, so C:\proj\pkg does not contain C:\proj\pkg2.
const isUnder = (p, dir) => {
  if (!p || !dir) return false;
  const a = pathKey(p);
  const b = pathKey(dir.replace(/[\\/]+$/, ''));
  return a === b || (a.startsWith(b) && '\\/'.includes(a[b.length]));
};

const ide = (window.ide = {
  t: tr,
  // The IDE log (<userData>/logs/pyide.log): ide.log.info(msg), or ide.logger('#my-plugin').warn(msg).
  log: ideDiagnostics.logger('#renderer'),
  logger: ideDiagnostics.logger,
  // A detached window ("Open in New Window") shows only editors; see editors.js.
  detached: new URLSearchParams(location.search).has('detached'),
  root: null,
  monaco: null,
  editor: null,
  tabs: [],
  active: null,
  interps: [],
  actions: [],
  toolWindows: new Map(),
  util: { $, el, basename, dirname, joinPath, samePath, isUnder, pathKey, observeSize, rel: (p) => (ide.root && p.toLowerCase().startsWith(ide.root.toLowerCase()) ? p.slice(ide.root.length + 1) : p) },
});

if (ide.detached) document.body.classList.add('detached');
// Which of `folder` and its parents are case-sensitive; editors ask for each document they open, before keying it.
ide.learnPathCase = learnPathCase;

// ---------- events ----------
const listeners = new Map();
ide.on = (evt, fn) => {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
};
ide.emit = (evt, ...args) => {
  for (const fn of listeners.get(evt) || []) {
    try { fn(...args); } catch (err) { console.error(`listener for ${evt} failed`, err); }
  }
};

// ---------- settings ----------
// Persisted by the main process (userData/settings.json). The changes made in one task are written together right
// after it, synchronously, and pending changes are written before the window unloads or the app restarts.
const settingsCache = window.__initialSettings || {};
// settings.json is the user's file (hand-edited, written by another version): a value of another kind than the
// caller's fallback reads as the fallback, so a list read as a list never meets a number. Number fallbacks are
// left alone (their readers convert), and so are recent projects without a path string, which are dropped here.
const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
if (Array.isArray(settingsCache.recentProjects)) settingsCache.recentProjects = settingsCache.recentProjects.filter((p) => typeof p?.path === 'string' && p.path);
// The keys set since the last write: only these are written onto the file, so another PyIDE instance on the same
// user data (or a detached window) keeps the keys it set.
const changedKeys = new Set();
let retryTimer = 0;
let failedWrites = 0;
const flushSettings = () => {
  if (!changedKeys.size) return;
  const keys = [...changedKeys];
  changedKeys.clear();
  const result = api.saveSettingsSync(settingsCache, keys);
  if (result === true) { failedWrites = 0; return; }
  // The main process could not write the file (it was locked, the disk full): keep the changes pending and retry.
  // When the retry fails too, say so, once until a write succeeds again.
  for (const k of keys) changedKeys.add(k);
  if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = 0; flushSettings(); }, 2000);
  if (++failedWrites !== 2) return;
  ide.notifications?.notify({
    title: tr('Settings cannot be saved'), kind: 'warning', group: 'Settings', raw: true,
    text: tr('PyIDE cannot write settings.json: {error}. Your changes stay in effect and PyIDE keeps retrying.', { error: ipcError(result) }),
  });
};
// pagehide comes after every beforeunload listener, so changes those listeners make are written too.
addEventListener('beforeunload', flushSettings);
addEventListener('pagehide', flushSettings);
ide.settings = {
  get: (key, fallback) => {
    if (!(key in settingsCache)) return fallback;
    const v = settingsCache[key];
    return fallback == null || typeof fallback === 'number' || kindOf(v) === kindOf(fallback) ? v : fallback;
  },
  set(key, value) {
    settingsCache[key] = value;
    if (!changedKeys.size) setTimeout(flushSettings);
    changedKeys.add(key);
    ide.emit('settingsChanged', key, value);
  },
  all: () => ({ ...settingsCache }),
  flush: flushSettings,
};

// ---------- power save mode ----------
// File › Power Save Mode (power-save plugin), kept across restarts like PyCharm's. Background work that can wait checks
// ide.powerSave.on() and listens for powerSaveChanged(on): semantic indexing, AI completion, next edit suggestions,
// spell checking and automatic vulnerability checks pause while it is on.
ide.powerSave = { on: () => ide.settings.get('powerSave.enabled', false) === true, set: (on) => ide.settings.set('powerSave.enabled', !!on) };
ide.on('settingsChanged', (key, value) => { if (key === 'powerSave.enabled') ide.emit('powerSaveChanged', value === true); });

// ---------- processes ----------
const procHandlers = new Map();
const procBuffers = new Map();
api.on('proc:data', (m) => {
  const h = procHandlers.get(m.id);
  if (h) h.data?.(m.text, m.stream);
  else (procBuffers.get(m.id) || procBuffers.set(m.id, []).get(m.id)).push(m);
});
api.on('proc:exit', (m) => {
  const h = procHandlers.get(m.id);
  if (h) { procHandlers.delete(m.id); h.exit?.(m.code); }
  else (procBuffers.get(m.id) || procBuffers.set(m.id, []).get(m.id)).push({ ...m, exit: true });
});
ide.proc = {
  // Routes output of a process started by a feature's main-side handler; output that arrived early is replayed.
  attach(id, handlers) {
    procHandlers.set(id, handlers);
    for (const m of procBuffers.get(id) || []) {
      if (m.exit) { procHandlers.delete(id); handlers.exit?.(m.code); } else handlers.data?.(m.text, m.stream);
    }
    procBuffers.delete(id);
  },
  input: (id, text) => api.input(id, text),
  closeInput: (id) => api.closeInput(id),
  kill: (id) => api.kill(id),
};

// ---------- UI primitives ----------
// Frames from code without a file ("<string>", "<frozen runpy>", "<stdin>") are not links.
const TRACEBACK = /File "([^"<][^"]*)", line (\d+)/g;

ide.ui = {};

// ---------- ANSI text ----------
// SGR sequences (`ESC[...m`) set colors and weight, `ESC[K` erases to the end of the line; other CSI sequences and
// OSC ones (window titles, hyperlinks) are dropped. Colors 0-15 are classes (core/ansi.css follows the theme), the
// 256-color cube and 24-bit colors are inline.
const ANSI = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const PLAIN = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false });
document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'core/ansi.css' }));
function color256(n) {
  if (n < 16) return n;
  if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
  const i = n - 16;
  const lv = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${lv(Math.floor(i / 36))},${lv(Math.floor(i / 6) % 6)},${lv(i % 6)})`;
}
// The style after an SGR sequence with parameters `params` ("1;31", "38;5;208", "" for a reset).
function sgr(st, params) {
  const codes = params ? params.split(';').map(Number) : [0];
  const s = { ...st };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(s, PLAIN);
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) s.bold = s.dim = false;
    else if (c === 23) s.italic = false;
    else if (c === 24) s.underline = false;
    else if (c >= 30 && c <= 37) s.fg = c - 30;
    else if (c >= 90 && c <= 97) s.fg = c - 90 + 8;
    else if (c === 39) s.fg = null;
    else if (c >= 40 && c <= 47) s.bg = c - 40;
    else if (c >= 100 && c <= 107) s.bg = c - 100 + 8;
    else if (c === 49) s.bg = null;
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
      s[c === 38 ? 'fg' : 'bg'] = color256(codes[i + 2]);
      i += 2;
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
      s[c === 38 ? 'fg' : 'bg'] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
      i += 4;
    }
  }
  return Object.keys(PLAIN).every((k) => s[k] === PLAIN[k]) ? PLAIN : s;
}
function styleSpan(st) {
  const span = document.createElement('span');
  const cls = [];
  if (typeof st.fg === 'number') cls.push(`ansi-fg${st.fg}`); else if (st.fg) span.style.color = st.fg;
  if (typeof st.bg === 'number') cls.push(`ansi-bg${st.bg}`); else if (st.bg) span.style.background = st.bg;
  for (const k of ['bold', 'dim', 'italic', 'underline']) if (st[k]) cls.push(`ansi-${k}`);
  span.className = cls.join(' ');
  return span;
}
const appendText = (host, s) => {
  if (!s) return;
  const t = host.lastChild;
  if (t?.nodeType === Node.TEXT_NODE) t.appendData(s); else host.append(s);
};
// Writes `text` in style `st` at the end of `host`; with `links`, traceback frames become links to the file and line.
function writeStyled(host, text, st, links) {
  if (st !== PLAIN) host = host.appendChild(styleSpan(st));
  let last = 0;
  if (links) {
    for (const m of text.matchAll(TRACEBACK)) {
      appendText(host, text.slice(last, m.index));
      const a = el('a', null, m[0]);
      a.onclick = () => ide.openFile(ide.toLocalPath(m[1]), { line: Number(m[2]) });
      host.append(a);
      last = m.index + m[0].length;
    }
  }
  appendText(host, text.slice(last));
}
ide.ui.ansi = {
  strip: (text) => text.replace(ANSI, ''),
  // Text with SGR colors as a fragment of styled spans.
  fragment(text) {
    const frag = document.createDocumentFragment();
    let st = PLAIN;
    let last = 0;
    for (const m of text.matchAll(ANSI)) {
      if (m.index > last) writeStyled(frag, text.slice(last, m.index), st, false);
      last = m.index + m[0].length;
      if (m[2] === 'm') st = sgr(st, m[1]);
    }
    if (last < text.length) writeStyled(frag, text.slice(last), st, false);
    return frag;
  },
};

// Characters a console keeps, like PyCharm's console cycle buffer (1024 KB by default): the oldest lines go first.
const consoleCap = () => Math.max(64, Number(ide.settings.get('console.cycleBufferKB', 1024)) || 1024) * 1024;
// A line longer than this without a line break is written out as it is; \r then rewinds only within what follows.
const LIVE_MAX = 4096;
// Finished output goes into spans of at most this many characters, so appending to one stays cheap.
const SPAN_MAX = 16384;
// An OSC sequence (a window title, a hyperlink) never holds a line break, so a stray ESC ] in binary output does not
// hide the lines after it.
const CONTROL = /\r?\n|\r|\x08|\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)/g;
// What a chunk may end with that the next chunk completes: the \r of a \r\n, or the start of an escape sequence. A
// start longer than any real sequence is not held but written out as text, so later output does not wait behind it.
const SPLIT_TAIL = /\r$|\x1b(?:\[[0-9;?]{0,32}|\][^\x07\x1b\n]{0,510}\x1b?)?$/;

// When the page last got a key that scrolls up the scroller the user clicked (the console's <pre> takes no focus, so
// its keys go to the body).
let scrollUpKeyAt = -Infinity;
document.addEventListener('keydown', (e) => {
  if ((e.target === document.body || e.target?.closest?.('.console')) && /^(PageUp|ArrowUp|Home)$/.test(e.key)) scrollUpKeyAt = performance.now();
}, true);

// Program output as a terminal shows it. The unfinished last line stays editable: \r returns to its start and later
// text overwrites it (progress bars), \b steps back, colors carry across chunks. Finished lines are written once.
// append() writes at once and only the scroll to the end, which lays out the whole output, waits for the next frame,
// so a flood of output costs one layout per frame instead of one per chunk.
ide.ui.console = (host, { input = false, placeholder = '', onInput } = {}) => {
  host.classList.add('console-host');
  const out = el('pre', 'console');
  host.appendChild(out);
  // Output follows the end unless the user scrolled up. Measured on scroll, not on append: a hidden console (a tool
  // window or tab not shown) has no size, and once shown it must open at its latest output, not at its first line.
  // What stops the following is the user's own input (the wheel turned up, or a scrollbar drag, touch scroll or
  // PageUp/Up/Home away from the end), not the scroll position alone: in a flood the oldest lines are trimmed every
  // frame and scroll anchoring moves the view by itself. Scrolling back to the end follows again. The browser clamps
  // a scroll to the end it last laid out while more output may have come since, so that end is the one measured at
  // the last frame.
  let stick = true;
  let endTop = 0;
  let pointerDown = false;
  const toEnd = () => {
    out.scrollTop = out.scrollHeight;
    endTop = out.scrollTop;
  };
  out.addEventListener('wheel', (e) => { if (e.deltaY < 0) stick = false; }, { passive: true });
  out.addEventListener('pointerdown', () => {
    pointerDown = true;
    const up = () => {
      pointerDown = false;
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  });
  out.addEventListener('scroll', () => {
    if (!out.clientHeight) return;
    if (out.scrollTop >= Math.min(endTop, out.scrollHeight - out.clientHeight) - 40) stick = true;
    else if (pointerDown || performance.now() - scrollUpKeyAt < 500) stick = false;
  });
  observeSize(out, () => { if (stick) toEnd(); });
  let frameQueued = false;
  const follow = () => {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      if (stick) toEnd();
      else endTop = out.scrollHeight - out.clientHeight;
    });
  };
  let inp;
  if (input) {
    inp = el('input', 'console-in');
    inp.placeholder = placeholder;
    inp.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const text = inp.value;
      inp.value = '';
      onInput?.(text);
    };
    host.appendChild(inp);
  }

  let st = PLAIN;
  // Per stream class, the \r or escape sequence start a chunk ended with: stdout and stderr come interleaved, so the
  // rest may arrive after the other stream's text.
  const held = new Map();
  // The unfinished line: runs of {text, cls, st}, its length and the caret column.
  let line = [];
  let len = 0;
  let col = 0;
  let live = null; // the element showing `line`, last in `out` while the line is not empty
  let tail = null; // the last span of finished output, and its length
  let tailLen = 0;
  let kept = 0;
  const reset = () => {
    st = PLAIN; held.clear(); line = []; len = 0; col = 0; live = null; tail = null; tailLen = 0; kept = 0;
    stick = true;
    endTop = 0;
  };
  const pushRun = (runs, run) => {
    const last = runs[runs.length - 1];
    if (last && last.cls === run.cls && last.st === run.st) last.text += run.text;
    else runs.push({ ...run });
  };
  const slice = (from, to) => {
    const res = [];
    let at = 0;
    for (const r of line) {
      const s = Math.max(from, at);
      const e = Math.min(to, at + r.text.length);
      if (s < e) res.push({ ...r, text: r.text.slice(s - at, e - at) });
      at += r.text.length;
    }
    return res;
  };
  const put = (text, cls) => {
    if (col > len) { pushRun(line, { text: ' '.repeat(col - len), cls, st: PLAIN }); len = col; }
    if (col === len) pushRun(line, { text, cls, st });
    else line = [...slice(0, col), { text, cls, st }, ...slice(col + text.length, Infinity)];
    col += text.length;
    len = Math.max(len, col);
  };

  function writeFinished(runs) {
    for (const r of runs) {
      if (!tail || tail.className !== (r.cls || '') || tailLen >= SPAN_MAX) {
        tail = el('span', r.cls);
        tailLen = 0;
        out.insertBefore(tail, live?.parentNode === out ? live : null);
      }
      writeStyled(tail, r.text, r.st, true);
      tailLen += r.text.length;
      kept += r.text.length;
    }
    if (kept > consoleCap() + 65536) trim(kept - consoleCap());
  }
  // Drops the first `n` characters of finished output, up to the end of that line when it is near.
  function trim(n) {
    const walker = document.createTreeWalker(out, NodeFilter.SHOW_TEXT);
    let removed = 0;
    for (let node = walker.nextNode(); node && removed < n;) {
      if (live?.contains(node)) break;
      const next = walker.nextNode();
      if (removed + node.length <= n) {
        removed += node.length;
        node.remove();
      } else {
        let at = n - removed;
        const nl = node.data.indexOf('\n', at);
        if (nl >= 0 && nl - at < 4096) at = nl + 1;
        node.deleteData(0, at);
        removed += at;
        break;
      }
      node = next;
    }
    kept -= removed;
    while (out.firstChild && out.firstChild !== live && !out.firstChild.textContent) out.firstChild.remove();
    for (const e of [...(out.firstChild?.querySelectorAll?.('*') || [])]) if (!e.textContent) e.remove();
    if (tail && !tail.isConnected) { tail = null; tailLen = 0; }
  }
  function drawLine() {
    if (!len) { live?.remove(); return; }
    live ||= el('span');
    live.replaceChildren();
    for (const r of line) writeStyled(r.cls ? live.appendChild(el('span', r.cls)) : live, r.text, r.st, true);
    if (live.parentNode !== out) out.appendChild(live);
  }

  function feed(text, cls) {
    if (!text) return;
    const done = [];
    if (col === len && !/\r(?!\n)|[\x08\x1b]/.test(text)) {
      // Plain lines, the common case of a flood.
      text = text.replace(/\r\n/g, '\n');
      const nl = text.lastIndexOf('\n');
      if (nl < 0) put(text, cls);
      else {
        for (const r of line) pushRun(done, r);
        pushRun(done, { text: text.slice(0, nl + 1), cls, st });
        line = [];
        len = col = 0;
        if (nl + 1 < text.length) put(text.slice(nl + 1), cls);
      }
    } else {
      let last = 0;
      // An ESC that starts no sequence (a stray one, or the start of an over-long one) is dropped, as a terminal does.
      const textOf = (a, b) => text.slice(a, b).replaceAll('\x1b', '');
      for (const m of text.matchAll(CONTROL)) {
        if (m.index > last) put(textOf(last, m.index), cls);
        last = m.index + m[0].length;
        const c = m[0];
        if (c === '\n' || c === '\r\n') {
          for (const r of line) pushRun(done, r);
          pushRun(done, { text: '\n', cls, st });
          line = [];
          len = col = 0;
        } else if (c === '\r') col = 0;
        else if (c === '\x08') {
          // At the end of the line a backspace deletes, as in Jupyter; inside it, it moves the caret back.
          if (col && col === len) { line = slice(0, col - 1); len--; }
          col = Math.max(0, col - 1);
        } else if (m[2] === 'm') st = sgr(st, m[1]);
        else if (m[2] === 'K') {
          if (m[1] === '2') { line = []; len = 0; } else if (!m[1] || m[1] === '0') { line = slice(0, col); len = Math.min(len, col); }
        }
      }
      if (last < text.length) put(textOf(last), cls);
    }
    if (len > LIVE_MAX) {
      for (const r of line) pushRun(done, r);
      line = [];
      len = col = 0;
    }
    if (done.length) writeFinished(done);
    drawLine();
  }

  return {
    out,
    input: inp,
    append(text, cls) {
      cls ||= null;
      text = String(text);
      // Another stream comes in between: a held \r can no longer start a \r\n, so it rewinds the line now.
      for (const [c, h] of held) if (c !== cls && h === '\r') { held.delete(c); feed(h, c); }
      text = (held.get(cls) || '') + text;
      held.delete(cls);
      const split = SPLIT_TAIL.exec(text);
      if (split) {
        held.set(cls, split[0]);
        text = text.slice(0, split.index);
      }
      feed(text, cls);
      follow();
    },
    clear: () => { out.replaceChildren(); reset(); },
    text: () => out.textContent,
  };
};

// Keyboard for a tool window's list or tree of rows, as in PyCharm: the list takes focus, Up/Down/Home/End move the
// selection over the shown rows matching `rows`, Enter opens the selected one, Right expands it (or enters it when it is
// open) and Left collapses it (or goes to its parent). The plugin says what its rows mean: selected() -> row, select(row),
// open(row) (a click by default), and for a tree expanded(row) -> true | false | null (a leaf), toggle(row) (a click) and
// parent(row, rows) (by data-depth). select and toggle may redraw the rows: the row with the same id(row) (data-key) is
// looked up again.
const rowAbove = (row, list) => {
  const depth = Number(row.dataset.depth);
  for (let j = list.indexOf(row) - 1; depth > 0 && j >= 0; j--) if (Number(list[j].dataset.depth || 0) < depth) return list[j];
  return null;
};
ide.ui.listKeys = (host, { rows, selected, select, open = (row) => row.click(), expanded = () => null, toggle = (row) => row.click(),
  parent = rowAbove, id = (row) => row.dataset.key ?? null }) => {
  const shownRows = () => [...host.querySelectorAll(rows)].filter((r) => r.getClientRects().length);
  selected ||= () => shownRows().find((r) => r.classList.contains('selected')) || null;
  select ||= (row) => {
    for (const r of host.querySelectorAll(rows)) r.classList.toggle('selected', r === row);
  };
  const again = (key) => key != null && shownRows().find((r) => id(r) === key);
  const go = (row) => {
    if (!row) return;
    const key = id(row);
    select(row);
    (again(key) || selected() || row).scrollIntoView({ block: 'nearest' });
  };
  host.tabIndex = 0;
  host.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.target !== host) return;
    const list = shownRows();
    const cur = selected();
    const i = list.indexOf(cur);
    const state = i === -1 ? null : expanded(cur);
    const keys = {
      ArrowDown: () => go(list[Math.min(i + 1, list.length - 1)]),
      ArrowUp: () => go(list[Math.max(i - 1, 0)]),
      Home: () => go(list[0]),
      End: () => go(list[list.length - 1]),
      Enter: () => i !== -1 && open(cur),
      ArrowRight: () => {
        if (state === false) { const key = id(cur); toggle(cur); go(again(key)); }
        else if (state === true && list[i + 1] && parent(list[i + 1], list) === cur) go(list[i + 1]);
      },
      ArrowLeft: () => {
        if (state === true) { const key = id(cur); toggle(cur); go(again(key)); }
        else if (i !== -1) go(parent(cur, list));
      },
    };
    if (!keys[e.key] || !list.length) return;
    e.preventDefault();
    e.stopPropagation();
    keys[e.key]();
  });
};

// Popup chooser used by search everywhere, find action, recent files, and prompts.
let popupState = null;
const fuzzyScore = (text, q) => {
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.includes(q)) return 3;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
};

function renderPopup() {
  const s = popupState;
  const list = $('popupList');
  list.innerHTML = '';
  if (s.mode === 'prompt') {
    list.appendChild(el('div', 'popup-item hint', tr('{label} — Enter to confirm, Esc to cancel', { label: s.placeholder })));
    return;
  }
  const q = $('popupIn').value.trim().toLowerCase();
  const items = s.filter === false ? s.items
    : s.items.map((it) => [it, fuzzyScore(it.label, q) * 2 + (it.detail ? fuzzyScore(it.detail, q) && 1 : 0)])
      .filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1]).map(([it]) => it);
  items.slice(0, 200).forEach((it, i) => {
    const row = el('div', 'popup-item' + (i === 0 ? ' active' : ''));
    if (it.icon) row.appendChild(typeof it.icon === 'string' ? el('span', 'icon', it.icon) : Object.assign(it.icon.cloneNode(true), { className: `${it.icon.className} icon` }));
    row.appendChild(el('span', 'label', it.label));
    if (it.detail) row.appendChild(el('span', 'detail', it.detail));
    if (it.hint) row.appendChild(el('span', 'hint-right', it.hint));
    row.onmousedown = (e) => { e.preventDefault(); closePopup(it.value ?? it); };
    row._item = it;
    list.appendChild(row);
  });
  if (!items.length) list.appendChild(el('div', 'popup-item hint', tr('Nothing found')));
}

// Where the keyboard goes when a popup or dialog closes: back to the element that had it if it is still shown, else the
// editor; never left on the closed popup's hidden input, where keys would go nowhere.
const focusBack = (prev) => {
  if (prev?.isConnected && prev !== document.body && prev.getClientRects().length) prev.focus();
  else ide.editor?.focus();
};

function closePopup(value = null) {
  if (!popupState) return;
  const { resolve, prevFocus } = popupState;
  popupState = null;
  $('popup').classList.add('hidden');
  if (document.activeElement === $('popupIn')) focusBack(prevFocus);
  resolve(value);
}

function openPopup(state) {
  const prevFocus = popupState ? popupState.prevFocus : document.activeElement;
  if (popupState) closePopup();
  return new Promise((resolve) => {
    popupState = { ...state, resolve, prevFocus };
    $('popupIn').placeholder = state.placeholder || '';
    $('popupIn').value = state.initial || '';
    $('popup').classList.remove('hidden');
    $('popupIn').focus();
    if (state.mode === 'prompt') $('popupIn').select();
    renderPopup();
  });
}

// items: [{label, detail?, hint?, icon?, value?}] or an async function(query) returning that list
ide.ui.pick = ({ placeholder, items, initial }) => {
  if (typeof items === 'function') {
    const load = items;
    const p = openPopup({ placeholder, items: [], filter: false, initial });
    let seq = 0;
    const refresh = async () => {
      const my = ++seq;
      const res = await load($('popupIn').value);
      if (popupState && my === seq) { popupState.items = res; renderPopup(); }
    };
    popupState.onQuery = refresh;
    refresh();
    return p;
  }
  return openPopup({ placeholder, items, initial });
};
ide.ui.prompt = (placeholder, initial = '') => openPopup({ placeholder, mode: 'prompt', initial });

$('popupIn').oninput = () => (popupState?.onQuery ? popupState.onQuery() : popupState && renderPopup());
$('popupIn').onkeydown = (e) => {
  if (!popupState) return;
  if (e.key === 'Escape') { e.stopPropagation(); return closePopup(); }
  // preventDefault: the Enter must not also reach the editor that gets the keyboard back.
  if (popupState.mode === 'prompt') { if (e.key === 'Enter') { e.preventDefault(); closePopup($('popupIn').value.trim() || null); } return; }
  const rows = [...$('popupList').querySelectorAll('.popup-item:not(.hint)')];
  const i = rows.findIndex((r) => r.classList.contains('active'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[i]?.classList.remove('active');
    const next = rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
    next?.classList.add('active');
    next?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && rows[i]) {
    e.preventDefault();
    closePopup(rows[i]._item.value ?? rows[i]._item);
  }
};
$('popupIn').onblur = () => setTimeout(() => document.activeElement !== $('popupIn') && closePopup(), 120);

// Menus: items are [{label, hint?, keyAction?, icon?, checked?, disabled?, run?, submenu?: items | () => items} | {separator: true}].
// keyAction: the id of the action whose current shortcut is the hint (none when the user removed it), instead of a fixed hint.
// Submenus open on hover or Right; Up/Down move, Enter runs, Left closes a submenu, Esc closes the menu.
const menuStack = [];
let menuCleanup = null;

function closeMenus(level = 0) {
  while (menuStack.length > level) menuStack.pop().el.remove();
  if (!menuStack.length && menuCleanup) { menuCleanup(); menuCleanup = null; }
}
ide.ui.closeMenus = () => closeMenus(0);
// A menu removed from the page by other code counts as closed (and its key handlers are dropped).
function menusOpen() {
  if (menuStack.length && !menuStack[0].el.isConnected) closeMenus(0);
  return menuStack.length > 0;
}

function setActiveRow(level, row) {
  const m = menuStack[level];
  if (!m) return;
  m.el.querySelectorAll('.menu-item.active').forEach((n) => n.classList.remove('active'));
  if (row) { row.classList.add('active'); row.scrollIntoView({ block: 'nearest' }); }
  m.active = row || null;
}

function openSubmenu(level, row) {
  closeMenus(level + 1);
  const items = typeof row._item.submenu === 'function' ? row._item.submenu() : row._item.submenu;
  const r = row.getBoundingClientRect();
  showMenu(r.right - 2, r.top - 5, items, level + 1, r.left);
}

function activate(level, row) {
  const it = row?._item;
  if (!it || it.disabled) return;
  if (it.submenu) { openSubmenu(level, row); setActiveRow(level + 1, menuStack[level + 1]?.el.querySelector('.menu-item:not(.disabled)')); return; }
  closeMenus(0);
  it.run?.();
}

function showMenu(x, y, items, level, leftEdge) {
  const menu = el('div', 'context-menu');
  menu.dataset.level = level;
  let hoverTimer = null;
  for (const it of items.filter(Boolean)) {
    if (it.separator) { menu.appendChild(el('div', 'menu-sep')); continue; }
    if (it.header) { menu.appendChild(el('div', 'menu-header', it.header)); continue; }
    const row = el('div', 'menu-item' + (it.disabled ? ' disabled' : '') + (it.submenu ? ' has-sub' : ''));
    row._item = it;
    const icon = el('span', 'menu-icon');
    if (it.checked) icon.textContent = '✓';
    else if (it.icon) icon.appendChild(ide.icon(it.icon, it.glyph || ''));
    else if (it.glyph) icon.textContent = it.glyph;
    const label = el('span', 'menu-label', it.label);
    if (it.userText) label.dataset.userText = '';
    // The label stays the first child (callers read row.firstChild); CSS order draws the icon before it.
    row.append(label, icon);
    if (it.detail) { const d = el('span', 'menu-detail', it.detail); d.dataset.userText = ''; row.appendChild(d); }
    const hint = it.keyAction ? ide.keymap.hint(it.keyAction) : it.hint;
    if (hint) row.appendChild(el('span', 'hint-right', hint));
    if (it.submenu) row.appendChild(el('span', 'menu-arrow', '›'));
    row.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); activate(level, row); };
    row.onmouseenter = () => {
      setActiveRow(level, it.disabled ? null : row);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (it.submenu && !it.disabled) openSubmenu(level, row);
        else closeMenus(level + 1);
      }, it.submenu ? 120 : 200);
    };
    menu.appendChild(row);
  }
  $('menuHost').appendChild(menu);
  menuStack[level] = { el: menu, active: null };
  const r = menu.getBoundingClientRect();
  let left = x;
  if (left + r.width > innerWidth - 4) left = leftEdge !== undefined ? leftEdge - r.width + 2 : innerWidth - r.width - 4;
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  return menu;
}

ide.ui.contextMenu = (x, y, items) => {
  closeMenus(0);
  showMenu(x, y, items, 0);
  const dismiss = (e) => { if (!e.target.closest?.('.context-menu')) closeMenus(0); };
  const keys = (e) => {
    if (!menusOpen()) return;
    const level = menuStack.length - 1;
    const m = menuStack[level];
    if (!m) return;
    const rows = [...m.el.querySelectorAll('.menu-item:not(.disabled)')];
    const i = rows.indexOf(m.active);
    const handled = {
      ArrowDown: () => setActiveRow(level, rows[(i + 1) % rows.length]),
      ArrowUp: () => setActiveRow(level, rows[(i - 1 + rows.length) % rows.length]),
      ArrowRight: () => m.active?._item.submenu && activate(level, m.active),
      ArrowLeft: () => level > 0 && closeMenus(level),
      Enter: () => activate(level, m.active),
      Escape: () => (level > 0 ? closeMenus(level) : closeMenus(0)),
    }[e.key];
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    handled();
  };
  setTimeout(() => {
    if (!menuStack.length) return;
    addEventListener('mousedown', dismiss, true);
    addEventListener('keydown', keys, true);
    addEventListener('blur', ide.ui.closeMenus);
  });
  menuCleanup = () => {
    removeEventListener('mousedown', dismiss, true);
    removeEventListener('keydown', keys, true);
    removeEventListener('blur', ide.ui.closeMenus);
  };
  return menuStack[0].el;
};
ide.ui.menuOpen = menusOpen;

// buttons: [{label, primary?, run?(dialog) -> false keeps it open}]
ide.ui.dialog = ({ title, body, buttons = [{ label: tr('OK'), primary: true }], width = 520, onClose }) => {
  const backdrop = el('div', 'dialog-backdrop');
  const box = el('div', 'dialog');
  box.style.width = `${width}px`;
  const head = el('div', 'dialog-title', title);
  const content = el('div', 'dialog-body');
  // A string body is text: messages carry names (run configurations, files) that must never become markup.
  if (typeof body === 'string') content.textContent = body; else if (body) content.appendChild(body);
  const foot = el('div', 'dialog-buttons');
  const prevFocus = document.activeElement;
  const dlg = {
    el: box,
    body: content,
    close() {
      const hadFocus = box.contains(document.activeElement) || document.activeElement === document.body;
      backdrop.remove();
      removeEventListener('keydown', onKey, true);
      if (hadFocus) focusBack(prevFocus);
      onClose?.();
    },
  };
  for (const b of buttons) {
    const btn = el('button', b.primary ? 'primary' : 'secondary', b.label);
    btn.onclick = async () => { if ((await b.run?.(dlg)) !== false) dlg.close(); };
    foot.appendChild(btn);
  }
  const shown = (n) => !n.disabled && n.getClientRects().length > 0;
  // Only the topmost dialog takes keys, and none while a menu opened from it is up (the menu's Esc and Enter come first).
  // Tab and Shift+Tab cycle inside it (never into the editor behind); Enter on a focused button presses that button, in
  // a textarea or a Monaco editor (whose input is an EditContext element, .native-edit-context) it is a new line, and
  // while an IME composes it commits the text. A dialog without a primary button leaves Enter to its content (the
  // Conflicts dialog's file list merges the selected file).
  const onKey = (e) => {
    if (backdrop !== $('dialogHost').lastElementChild || menusOpen()) return;
    if (e.key === 'Escape') { e.stopPropagation(); dlg.close(); }
    const primary = foot.querySelector('.primary');
    if (e.key === 'Enter' && primary && !e.isComposing && !['TEXTAREA', 'BUTTON', 'A'].includes(e.target.tagName) && !e.target.matches?.('.native-edit-context')) {
      e.preventDefault(); // the keystroke must not also type into the field that gets the keyboard back
      e.stopPropagation();
      primary.click();
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.target.closest?.('.monaco-editor')) {
      const stops = [...box.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter((n) => n.tabIndex >= 0 && shown(n));
      const now = document.activeElement;
      const i = stops.indexOf(now);
      if (i !== -1 && i !== (e.shiftKey ? 0 : stops.length - 1)) return;
      e.preventDefault();
      // Focus on something in the dialog that is no stop (a scroller Chromium focuses, a list row) goes on from where
      // it is, not back to the first stop.
      const pos = (n) => now.compareDocumentPosition(n);
      const next = i !== -1 || !box.contains(now) ? null : e.shiftKey
        ? stops.findLast((n) => pos(n) & Node.DOCUMENT_POSITION_PRECEDING && !(pos(n) & Node.DOCUMENT_POSITION_CONTAINS))
        : stops.find((n) => pos(n) & Node.DOCUMENT_POSITION_FOLLOWING);
      (next || stops[e.shiftKey ? stops.length - 1 : 0])?.focus();
    }
  };
  addEventListener('keydown', onKey, true);
  box.append(head, content, foot);
  backdrop.appendChild(box);
  $('dialogHost').appendChild(backdrop);
  // The keyboard starts in the first field (a Monaco editor's is its EditContext element; its .ime-text-area is only
  // Monaco's IME helper), or on the primary button of a dialog without fields.
  ([...content.querySelectorAll('input,select,textarea:not(.ime-text-area),.native-edit-context')].find(shown) || foot.querySelector('.primary') || foot.querySelector('button'))?.focus();
  return dlg;
};
// A message in the IDE's own dialog. window.alert() blocks the whole renderer until it is dismissed.
ide.ui.alert = (text) => {
  ide.ui.dialog({ title: '', body: el('div', 'dialog-message', text) });
};
// A yes/no question in the IDE's own dialog; resolves true for `ok`. window.confirm() would block the renderer.
ide.ui.confirm = (text, { title = '', ok = tr('OK') } = {}) => new Promise((resolve) => {
  let yes = false;
  ide.ui.dialog({
    title,
    body: el('div', 'dialog-message', text),
    onClose: () => resolve(yes),
    buttons: [{ label: ok, primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }],
  });
});

// ---------- actions & keymap ----------
const CODE_KEYS = { Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', Comma: ',', Period: '.', Semicolon: ';',
  Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', NumpadDivide: '/', Space: 'Space' };
const keyName = (e) => {
  const c = e.code || '';
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
};
const comboOf = (e) => `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${keyName(e)}`;
const normalizeKeys = (keys) => (Array.isArray(keys) ? keys : keys ? [keys] : []);
const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta'];

// User keymap (Settings › Keymap). The `keymap.overrides` setting holds only what the user changed, {actionId: [keys]},
// which replaces that action's defaults (`defaultKeys`), so a later version can change the defaults of untouched
// actions; an override for an action registered later (a plugin, an action added on `ready`) applies when it registers.
// A key is one stroke as comboOf() writes it ('Ctrl+Alt+Shift+K'), two strokes ('Ctrl+K C') or 'Shift Shift'. Values
// that are not lists of such keys are ignored.
const STROKE = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(\S|[A-Z][A-Za-z0-9]+)$/;
const validStroke = (s) => { const m = STROKE.exec(s); return !!m && !MODIFIER_KEYS.includes(m[1]); };
const validKey = (k) => typeof k === 'string' && (k === 'Shift Shift' || k === 'Ctrl Ctrl' || (k.split(' ').length <= 2 && k.split(' ').every(validStroke)));
function parseKeymap(raw) {
  const map = new Map();
  for (const [id, keys] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    if (!Array.isArray(keys)) continue;
    const ok = [...new Set(keys.filter(validKey))];
    if (ok.length || !keys.length) map.set(id, ok);
  }
  return map;
}
let keymapOverrides = parseKeymap(ide.settings.get('keymap.overrides', {}));
ide.keymap = {
  comboOf,
  isValid: validKey,
  parse: parseKeymap,
  isModified: (id) => keymapOverrides.has(id),
  // As menus show a key: 'Ctrl+K, C' for two strokes (PyCharm's way), arrows and Esc shortened.
  format: (k) => (k === 'Shift Shift' ? tr('Double Shift') : k === 'Ctrl Ctrl' ? tr('Double Ctrl') : k.split(' ').join(', ')
    .replace(/Arrow(Up|Down|Left|Right)/g, (m) => ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' })[m]).replace(/Escape/g, 'Esc')),
  label: (id) => (ide.actions.find((a) => a.id === id)?.keys || []).map(ide.keymap.format).join(' / '),
  // As menus and lists (main menu, context menus, Find Action, Search Everywhere) show an action's keys.
  hint: (id) => (ide.actions.find((a) => a.id === id)?.keys || []).map(ide.keymap.format).join(', '),
  // 'Run (Shift+F10)', or just the text when the action has no shortcut, so a removed shortcut never shows.
  withKeys: (text, id) => { const k = ide.keymap.label(id); return k ? `${text} (${k})` : text; },
  // A tooltip that follows the keymap (see data-keymap-action below).
  tooltip: (node, text, id) => {
    node.dataset.keymapAction = id;
    node.dataset.tooltip = text;
    node.title = ide.keymap.withKeys(text, id);
    return node;
  },
  // Text that names a shortcut: fn() fills the node now and again whenever the keymap changes.
  text: (node, fn) => { node._keymapText = fn; node.dataset.keymapText = ''; node.textContent = fn(); return node; },
};
const keymapTooltip = (n) => {
  n.dataset.tooltip ??= n.title.replace(/\s*\([^()]*\)$/, '');
  n.title = ide.keymap.withKeys(n.dataset.tooltip, n.dataset.keymapAction);
};
const refreshKeymapTexts = () => {
  for (const n of document.querySelectorAll('[data-keymap-text]')) if (n._keymapText) n.textContent = n._keymapText();
  for (const n of document.querySelectorAll('[data-keymap-action]')) keymapTooltip(n);
};
ide.on('settingsChanged', (key) => {
  if (key !== 'keymap.overrides') return;
  keymapOverrides = parseKeymap(ide.settings.get('keymap.overrides', {}));
  for (const a of ide.actions) a.keys = keymapOverrides.get(a.id) || (a.defaultKeys ??= normalizeKeys(a.keys));
  ide.emit('keymapChanged');
});
// Texts made before the action they name registered (plugins load later) get its keys once everything is loaded.
ide.on('keymapChanged', refreshKeymapTexts);
ide.on('ready', refreshKeymapTexts);
// Elements with data-keymap-action="<action id>" show that action's current shortcut in their tooltip: "Run (Shift+F10)".
addEventListener('mouseover', (e) => {
  const n = e.target.closest?.('[data-keymap-action]');
  if (n) keymapTooltip(n);
}, true);

// {id, title, keys?: 'Ctrl+Shift+F' | [...], run, when?: () => bool, context?: 'editor' | 'projectView'}. Later
// registrations win on key clashes. context names where `when` lets the action fire (PyCharm's Editor Actions and
// Project View): actions of two different contexts never fire together, so the keymap page does not report them as
// conflicts (Ctrl+D is Duplicate Line in the editor and Compare in the project tree).
// PyCharm's keys for actions whose plugin registers them without `keys`, so the keymap binds them by id (as PyCharm's
// keymap does) whichever plugin provides the action. `keys: []` still means no shortcut.
const KEYMAP_DEFAULTS = {
  GotoImplementation: 'Ctrl+Alt+B', GotoSuperMethod: 'Ctrl+U', GotoTest: 'Ctrl+Shift+T', Rerun: 'Ctrl+F5',
};
ide.registerAction = (action) => {
  ide.actions = ide.actions.filter((a) => a.id !== action.id);
  const defaultKeys = normalizeKeys(action.keys ?? KEYMAP_DEFAULTS[action.id]);
  ide.actions.push({ ...action, defaultKeys, keys: keymapOverrides.get(action.id) || defaultKeys });
  if (keymapOverrides.has(action.id)) ide.emit('keymapChanged', action.id);
  return action;
};
// With no project the window is PyCharm's welcome screen: tool windows and what runs or debugs code do nothing (their
// stripes, panels and the run widget are hidden by body.no-project in styles.css).
const PROJECT_ACTIONS = new Set(['Run', 'Debug', 'RunClass', 'Rerun', 'ChooseRunConfiguration', 'ChooseDebugConfiguration',
  'editRunConfigurations', 'RunCoverage', 'Profile', 'RunAnything', 'AttachToProcess', 'RunPythonConsole', 'TerminalNewSession']);
ide.actionEnabled = (a) => !!ide.root || !(a.needsProject || PROJECT_ACTIONS.has(a.id));
ide.runAction = (id) => {
  const a = ide.actions.find((x) => x.id === id);
  return a && ide.actionEnabled(a) ? a.run() : undefined;
};
ide.keysFor = (id) => ide.actions.find((a) => a.id === id)?.keys.join(', ') || '';

let lastShift = 0;
// The first stroke of a two-stroke shortcut waits up to CHORD_MS for the second. As in PyCharm and VS Code, when the
// wait runs out or the second stroke completes no chord, the first stroke's own single-stroke action (Ctrl+K: Commit
// beside a Ctrl+K C chord) runs, and that second stroke is then handled as an ordinary key. Escape just cancels.
const CHORD_MS = 1500;
let firstStroke = null;
let chordTimer = null;
const cancelChord = () => { clearTimeout(chordTimer); firstStroke = null; };
const startsChord = (combo) => {
  const terminalFocused = inTerminal();
  return ide.actions.some((a) => a.keys.some((k) => k.startsWith(`${combo} `) && k !== 'Shift Shift')
    && !(terminalFocused && !a.terminal) && (!a.when || a.when()));
};
document.addEventListener('keydown', (e) => {
  if (popupState || $('dialogHost').childElementCount || menusOpen()) { cancelChord(); return; }
  if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.repeat && !firstStroke) {
    // The key's own time, not the handling time: a busy renderer must not split one Double Shift into two Shifts.
    const now = e.timeStamp;
    if (now - lastShift < 350) { lastShift = 0; return fireCombo('Shift Shift', e); }
    lastShift = now;
    return;
  }
  const modifier = MODIFIER_KEYS.includes(e.key);
  if (!modifier) lastShift = 0;
  else if (firstStroke) return;
  const combo = comboOf(e);
  if (firstStroke) {
    const first = firstStroke;
    cancelChord();
    if (fireCombo(`${first.combo} ${combo}`, e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    fireCombo(first.combo, null);
  }
  if (!modifier && startsChord(combo)) {
    const first = { combo };
    firstStroke = first;
    chordTimer = setTimeout(() => {
      if (firstStroke !== first) return;
      firstStroke = null;
      if (!popupState && !$('dialogHost').childElementCount && !menusOpen()) fireCombo(first.combo, null);
    }, CHORD_MS);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  fireCombo(combo, e);
}, true);

// Double Ctrl ('Ctrl Ctrl', PyCharm's Run Anything): Ctrl pressed and released twice with no other key, mouse button or
// wheel in between, the second press within 350 ms of the first release. It fires on the second release, so Ctrl+C,
// Ctrl+S or Ctrl+click right after a Ctrl tap never count, and holding Ctrl for a chord never does. Listened to on the
// window in the capture phase, before dialogs and editors can swallow the keys in between.
let ctrlTap = null; // {step: 'first' | 'released' | 'second', t}
addEventListener('keydown', (e) => {
  if (e.key !== 'Control' || e.altKey || e.shiftKey || e.metaKey) { ctrlTap = null; return; }
  if (e.repeat) return;
  ctrlTap = ctrlTap?.step === 'released' && e.timeStamp - ctrlTap.t < 350 ? { step: 'second' } : { step: 'first' };
}, true);
addEventListener('keyup', (e) => {
  if (e.key !== 'Control' || !ctrlTap) return;
  if (ctrlTap.step === 'first') { ctrlTap = { step: 'released', t: e.timeStamp }; return; }
  const fire = ctrlTap.step === 'second';
  ctrlTap = null;
  if (fire && !popupState && !$('dialogHost').childElementCount && !menusOpen()) { cancelChord(); fireCombo('Ctrl Ctrl', e); }
}, true);
for (const type of ['mousedown', 'wheel', 'blur']) addEventListener(type, (e) => { if (type !== 'blur' || e.target === window) ctrlTap = null; }, true);

// Inside a terminal, keys belong to the program running there (Esc, Ctrl+T, Ctrl+K... matter to Claude Code, readline,
// vim); only actions marked terminal: true (tool windows and a few window-level ones) still fire, like PyCharm's
// "Override IDE shortcuts" terminal option.
const inTerminal = () => !!document.activeElement?.closest('[data-terminal]');

function fireCombo(combo, e) {
  const terminalFocused = inTerminal();
  for (let i = ide.actions.length - 1; i >= 0; i--) {
    const a = ide.actions[i];
    if (!a.keys.includes(combo) || (a.when && !a.when()) || !ide.actionEnabled(a)) continue;
    if (terminalFocused && !a.terminal) continue;
    // No event when the first stroke of a chord runs late: its keydown was already taken.
    e?.preventDefault();
    e?.stopPropagation();
    a.run();
    return true;
  }
  return false;
}

// ---------- toolbar & status bar ----------
const placeOrdered = (host, node, order) => {
  node.dataset.order = order;
  const before = [...host.children].find((c) => Number(c.dataset.order ?? 0) > order);
  host.insertBefore(node, before || null);
};
// Items ordered 60-99 on the right form the run widget (configuration, Run, Debug, Stop), drawn as one pill.
ide.registerToolbarItem = ({ side = 'right', order = 100, el: node }) => placeOrdered(
  side === 'left' ? $('toolbarLeft') : order >= 60 && order < 100 ? $('runWidget') : $('toolbarRight'), node, order);
ide.registerStatusItem = ({ order = 100, el: node }) => placeOrdered($('statusItems'), node, order);
$('projectWidget').dataset.order = 0;
// Status bar widgets never wrap (styles.css). When they do not all fit, the file path gives way first (down to 120px,
// with an ellipsis), then the widgets with the highest order are hidden (.status-overflow), as PyCharm drops the
// widgets that do not fit, so the caret position, encoding and interpreter always stay on screen.
{
  const bar = $('status'), path = $('statusPath'), items = $('statusItems');
  let frame = 0;
  const fit = () => {
    frame = 0;
    for (const n of items.querySelectorAll(':scope > .status-overflow')) n.classList.remove('status-overflow');
    const crowded = () => bar.scrollWidth > bar.clientWidth + 1 || (path.scrollWidth > path.clientWidth && path.clientWidth < 120);
    while (crowded()) {
      const last = [...items.children].reverse().find((n) => !n.classList.contains('status-overflow') && n.getClientRects().length);
      if (!last) break;
      last.classList.add('status-overflow');
    }
    mo.takeRecords();
  };
  const later = () => { if (!frame) frame = requestAnimationFrame(fit); };
  const mo = new MutationObserver((records) => { if (records.some((r) => !$('statusPos').contains(r.target))) later(); });
  mo.observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  observeSize(bar, later);
  // A font that loads after the first fit changes the widgets' widths without any DOM change.
  document.fonts?.addEventListener?.('loadingdone', later);
  document.fonts?.ready?.then(later);
}

// ---------- tool windows ----------
const areas = {
  left: { panel: $('sidePanel'), splitter: $('sideSplitter'), body: $('sideBody'), actions: $('sideActions'), stripe: $('stripeTop'), title: $('sideTitle'), active: null },
  bottom: { panel: $('bottom'), splitter: $('bottomSplitter'), body: $('bottomBody'), actions: $('bottomActions'), stripe: $('stripeBottom'), active: null },
  right: { panel: $('rightPanel'), splitter: $('rightSplitter'), body: $('rightBody'), actions: $('rightActions'), stripe: $('stripeRightTop'), title: $('rightTitle'), active: null },
};

// PyCharm New UI icons (icons.js) for the built-in tool windows; plugins may pass iconName, or a text glyph as icon.
const TOOL_ICONS = { Project: 'project', Commit: 'commit', Structure: 'structure', Launchers: 'services', Run: 'run',
  Debug: 'debug', FindUsages: 'find', FindInFiles: 'find', PythonConsole: 'pythonConsole', Terminal: 'terminal',
  Problems: 'problems', Git: 'vcs', TODO: 'todo', PythonPackages: 'pythonPackages', AIChat: 'aiChat', CallHierarchy: 'hierarchy' };
ide.icon = (name, fallback = '') => {
  const svg = window.PYIDE_ICONS?.[name];
  const span = el('span', 'ide-icon');
  if (svg) span.innerHTML = svg; else span.textContent = fallback;
  return span;
};

// Like PyCharm's New UI, the sidebar shows only pinned tool windows (plus whichever is open right now); the rest live
// behind the "More" button. The pinned set is a user setting.
const DEFAULT_PINNED = ['Project', 'Commit', 'Structure', 'Run', 'Debug', 'Terminal', 'Problems', 'Notifications'];
const pinnedIds = () => ide.settings.get('sidebar.pinned', DEFAULT_PINNED);
const isPinned = (id) => pinnedIds().includes(id);
function setPinned(id, pinned) {
  const list = pinnedIds().filter((x) => x !== id);
  if (pinned) list.push(id);
  ide.settings.set('sidebar.pinned', list);
  refreshStripe();
}
function refreshStripe() {
  for (const tw of ide.toolWindows.values()) {
    const shown = isPinned(tw.id) || tw.isVisible();
    tw.button.classList.toggle('hidden', !shown);
    tw.button.classList.toggle('unpinned', !isPinned(tw.id));
    tw.tab?.classList.toggle('hidden', !shown);
  }
}
ide.sidebar = { isPinned, setPinned, pinned: pinnedIds, defaultPinned: () => [...DEFAULT_PINNED] };

function renderAreaActions(area) {
  area.actions.innerHTML = '';
  for (const a of area.active?.actionList || []) {
    const b = el('button', null, a.icon);
    // keyAction: the action whose current shortcut the tooltip shows.
    if (a.keyAction) ide.keymap.tooltip(b, a.title, a.keyAction);
    else b.title = a.title;
    b.onclick = a.run;
    if (a.id) b.dataset.action = a.id;
    // A toggle action ({toggled: boolean}) shows its state like PyCharm's toggle buttons.
    if (typeof a.toggled === 'boolean') { b.classList.toggle('toggled', a.toggled); b.setAttribute('aria-pressed', String(a.toggled)); }
    area.actions.appendChild(b);
  }
}

function setAreaVisible(area, visible) {
  area.panel.classList.toggle('hidden', !visible);
  area.splitter.classList.toggle('hidden', !visible);
  for (const tw of ide.toolWindows.values()) {
    if (tw.area === area) tw.button.classList.toggle('active', visible && area.active === tw);
  }
  refreshStripe();
}

// {id, title, icon, iconName?, side: 'left'|'bottom'|'right', keys?, order?, mount(container, tw)} -> tw {show, hide, toggle, setActions, setBadge, isVisible}
ide.registerToolWindow = ({ id, title, icon, iconName, side = 'bottom', keys, order = 100, mount }) => {
  const area = areas[side];
  const container = el('div', 'tool');
  area.body.appendChild(container);
  const button = el('button', 'stripe-btn');
  button.appendChild(ide.icon(iconName || TOOL_ICONS[id], icon));
  // The shortcut shown in the tooltip, the More list and menus follows the keymap (keyAction, see data-keymap-action).
  let keyText = keys ? normalizeKeys(keys).join(', ') : '';
  button.title = `${title}${keyText ? ` (${keyText})` : ''}`;
  button.dataset.tooltip = title;
  button.dataset.tool = id;
  placeOrdered(area.stripe, button, order);
  let tab;
  if (side === 'bottom') {
    tab = el('button', 'bottom-tab');
    tab.appendChild(el('span', null, title));
    tab.appendChild(el('span', 'badge'));
    placeOrdered($('bottomTabs'), tab, order);
  }
  const tw = {
    id, title, area, container, button, actionList: [], keyAction: keys ? `Activate${id}ToolWindow` : null,
    get keys() { return tw.keyAction && ide.actions.some((x) => x.id === tw.keyAction) ? ide.keymap.label(tw.keyAction) : keyText; },
    set keys(v) { keyText = v; }, iconName: iconName || TOOL_ICONS[id], glyph: icon,
    isVisible: () => !area.panel.classList.contains('hidden') && area.active === tw,
    show() {
      area.active = tw;
      area.picked = true;
      for (const other of ide.toolWindows.values()) {
        if (other.area !== area) continue;
        other.container.classList.toggle('active', other === tw);
        other.tab?.classList.toggle('active', other === tw);
      }
      if (area.title) area.title.textContent = title;
      setAreaVisible(area, true);
      renderAreaActions(area);
      ide.emit('toolWindowShown', id);
      container.querySelector('input.console-in:not([disabled]), input:not([disabled])')?.focus();
    },
    hide() { if (area.active === tw) { setAreaVisible(area, false); ide.editor?.focus(); } },
    toggle() { tw.isVisible() ? tw.hide() : tw.show(); },
    setActions(list) { tw.actionList = list; if (area.active === tw) renderAreaActions(area); },
    setBadge(text) { if (tab) tab.querySelector('.badge').textContent = text || ''; button.dataset.badge = text || ''; },
    tab,
  };
  button.onclick = tw.toggle;
  button.oncontextmenu = (e) => {
    e.preventDefault();
    ide.ui.contextMenu(e.clientX, e.clientY, [
      { label: tw.isVisible() ? tr('Hide') : tr('Show'), hint: tw.keys, run: tw.toggle },
      isPinned(id)
        ? { label: tr('Remove from Sidebar'), run: () => setPinned(id, false) }
        : { label: tr('Pin to Sidebar'), run: () => setPinned(id, true) },
    ]);
  };
  if (tab) tab.onclick = tw.show;
  ide.toolWindows.set(id, tw);
  // A window opened by its shortcut takes the keyboard, as in PyCharm: its field or list (show() already focuses a field),
  // else the window itself, so Esc (back to the editor) and Shift+Esc (hide) work from it. Other ways of showing it
  // leave the focus alone.
  const activate = () => {
    tw.toggle();
    if (!tw.isVisible() || container.contains(document.activeElement)) return;
    const target = [...container.querySelectorAll('[tabindex="0"], input:not([disabled]), textarea:not([disabled])')].find((n) => n.getClientRects().length);
    if (target) return target.focus();
    container.tabIndex = -1;
    container.focus();
  };
  if (keys) {
    ide.registerAction({ id: tw.keyAction, title: tr('Tool Window: {title}', { title }), keys, run: activate, terminal: true, needsProject: true });
    button.dataset.keymapAction = tw.keyAction;
    button.title = `${title}${tw.keys ? ` (${tw.keys})` : ''}`;
  }
  mount?.(container, tw);
  // Until something is shown explicitly, the default window of an area is the one with the lowest order
  // (features load alphabetically, so registration order is not meaningful).
  tw.order = order;
  if (!area.active || (!area.picked && order < area.active.order)) {
    area.active?.container.classList.remove('active');
    area.active?.tab?.classList.remove('active');
    area.active = tw; container.classList.add('active'); tab?.classList.add('active'); if (area.title) area.title.textContent = title; renderAreaActions(area);
  }
  refreshStripe();
  return tw;
};
$('hideBottomBtn').onclick = () => areas.bottom.active?.hide();

// "More Tool Windows": every tool window, with a pin to keep it on the sidebar.
const moreBtn = $('stripeMore');
moreBtn.appendChild(ide.icon('more', '⋯'));
moreBtn.title = tr('More Tool Windows');
let morePanel = null;
function closeMore() {
  morePanel?.remove();
  morePanel = null;
  removeEventListener('mousedown', outsideMore, true);
  removeEventListener('keydown', escMore, true);
}
const outsideMore = (e) => { if (!morePanel?.contains(e.target) && !moreBtn.contains(e.target)) closeMore(); };
const escMore = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMore(); } };
function renderMore() {
  morePanel.replaceChildren();
  for (const [side, label] of [['left', tr('Left')], ['bottom', tr('Bottom')], ['right', tr('Right')]]) {
    const list = [...ide.toolWindows.values()].filter((tw) => tw.area === areas[side]).sort((a, b) => a.order - b.order);
    if (!list.length) continue;
    morePanel.appendChild(el('div', 'more-group', label));
    for (const tw of list) {
      const row = el('div', 'more-row' + (tw.isVisible() ? ' visible' : ''));
      row.dataset.tool = tw.id;
      row.append(ide.icon(tw.iconName, tw.glyph), el('span', 'more-title', tw.title), el('span', 'more-keys', tw.keys));
      const pin = el('button', 'more-pin' + (isPinned(tw.id) ? ' pinned' : ''));
      pin.appendChild(ide.icon(isPinned(tw.id) ? 'pinSelected' : 'pin', '📌'));
      pin.title = isPinned(tw.id) ? tr('Remove from Sidebar') : tr('Pin to Sidebar');
      pin.onclick = (e) => { e.stopPropagation(); setPinned(tw.id, !isPinned(tw.id)); renderMore(); };
      row.appendChild(pin);
      row.onclick = () => { closeMore(); tw.show(); };
      morePanel.appendChild(row);
    }
  }
}
moreBtn.onclick = () => {
  if (morePanel) return closeMore();
  morePanel = el('div', 'more-panel');
  morePanel.id = 'moreToolWindows';
  document.body.appendChild(morePanel);
  renderMore();
  const r = moreBtn.getBoundingClientRect();
  morePanel.style.left = `${r.right + 6}px`;
  morePanel.style.top = `${Math.max(8, Math.min(r.bottom - morePanel.offsetHeight, innerHeight - morePanel.offsetHeight - 8))}px`;
  setTimeout(() => { addEventListener('mousedown', outsideMore, true); addEventListener('keydown', escMore, true); });
};
ide.on('settingsChanged', (key) => { if (key === 'sidebar.pinned') refreshStripe(); });

// ---------- problems ----------
const problemStore = new Map(); // source -> Map(pathKey -> {path, items})
const SEVERITY = () => ({ error: ide.monaco.MarkerSeverity.Error, warning: ide.monaco.MarkerSeverity.Warning, info: ide.monaco.MarkerSeverity.Info });

function applyMarkers(tab) {
  if (!tab?.model) return;
  for (const [source, files] of problemStore) {
    const entry = files.get(pathKey(tab.path));
    ide.monaco.editor.setModelMarkers(tab.model, source, (entry?.items || []).map((p) => ({
      severity: SEVERITY()[p.severity || 'error'], message: p.msg, source,
      startLineNumber: p.line, startColumn: p.col || 1,
      endLineNumber: p.endLine || p.line, endColumn: Math.max(p.endCol || 0, (p.col || 1) + 1),
    })));
  }
}

ide.problems = {
  // items: [{line, col, endLine?, endCol?, msg, severity: 'error'|'warning'|'info'}]
  set(source, path, items) {
    if (!problemStore.has(source)) problemStore.set(source, new Map());
    const files = problemStore.get(source);
    if (items?.length) files.set(pathKey(path), { path, items }); else files.delete(pathKey(path));
    const tab = ide.findTab(path);
    if (tab) applyMarkers(tab);
    ide.emit('problemsChanged');
  },
  clear(source) {
    const files = problemStore.get(source);
    if (!files) return;
    problemStore.delete(source);
    for (const { path } of files.values()) {
      const tab = ide.findTab(path);
      if (tab?.model) ide.monaco.editor.setModelMarkers(tab.model, source, []);
    }
    ide.emit('problemsChanged');
  },
  all() {
    const out = [];
    for (const [source, files] of problemStore) for (const { path, items } of files.values()) for (const p of items) out.push({ ...p, path, source });
    return out;
  },
};

// ---------- project tree ----------
// The tree is a flat list of visible rows ({entry, depth}) built from listings of the open folders. Expanding or
// collapsing a folder splices only its rows, and only the rows in view (plus a margin) have DOM nodes, so a folder
// with 10,000 files costs one listing and about 60 nodes. Tree operations run one at a time in `treeQueue`.
const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const EXPANDED_KEY = 'projectTree.expanded';
const keyOf = (p) => p.toLowerCase();
const expanded = new Set(); // keyOf(path) of every open folder
const treeDecorators = [];
const treeActions = [];
let rows = [];
let selected = null;
// More rows added to the selection with Ctrl+click (two files for Compare Files); any plain selection clears them.
let alsoSelected = [];
const sameEntry = (a, b) => samePath(a.path, b.path) && (a.treeRoot || null) === (b.treeRoot || null);
const inSelection = (entry) => !!selected && (sameEntry(entry, selected) || alsoSelected.some((s) => sameEntry(entry, s)));
// The entry cut with Ctrl+X (or Cut), drawn dimmed until it is pasted, Escape in the tree, another cut, or the project
// closes. setCut redraws, so the mark follows the entry through scrolling and refreshes.
let cutEntry = null;
const setCut = (entry) => { cutEntry = entry; drawTree(); };

ide.registerTreeDecorator = (fn) => { treeDecorators.push(fn); };
// {title, when?(entry, selection), run(entry, selection)}; entry = {name, path, dir}; selection = the selected entries.
ide.registerTreeAction = (action) => { treeActions.push(action); };
ide.selectedTreeEntry = () => selected;
// Every selected entry, the focused one first (Ctrl+click adds and removes rows).
ide.selectedTreeEntries = () => (selected ? [selected, ...alsoSelected] : []);
// Top-level nodes after the project (PyCharm's Scratches and Consoles): {id, order, entry: {name, path, dir: true, label?,
// iconType?}, list?(dir) -> entries | null (null: list the folder), menu?(entry) -> context menu items}. Their rows'
// entries carry treeRoot (the id); a `fixed` entry cannot be renamed, deleted or dragged, and none of them is a drop target.
const treeRoots = [];
ide.registerTreeRoot = (root) => {
  treeRoots.push(root);
  treeRoots.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  restoreRootExpanded(root);
  if (ide.root) renderTree();
};
const treeRootOf = (entry) => (entry?.treeRoot ? treeRoots.find((r) => r.id === entry.treeRoot) : null);

let treeQueue = Promise.resolve();
const enqueueTree = (fn) => (treeQueue = treeQueue.catch(() => {}).then(fn));
const listDir = (dir) => ide.api.list(dir).catch(() => []);
// A path can be listed twice (a project folder that holds the user-data folder also lists the scratches): a row is
// looked up under its own top-level node, the project's (treeRoot null) or an extra one's (its id).
const rowIndexOf = (path, treeRoot = null) => rows.findIndex((r) => samePath(r.entry.path, path) && (r.entry.treeRoot || null) === (treeRoot || null));
// The top-level node a path is shown under: the one whose folder is the longest whole-segment prefix of it, so a
// scratch file goes under Scratches even inside the project folder. {path, id} or null when none holds it.
function treeBaseOf(path) {
  const len = (p) => p.replace(/[\\/]+$/, '').length;
  let base = isUnder(path, ide.root) ? { path: ide.root, id: null } : null;
  for (const r of treeRoots) {
    if (isUnder(path, r.entry.path) && (!base || len(r.entry.path) > len(base.path))) base = { path: r.entry.path, id: r.id };
  }
  return base;
}

// The rows below an open folder: its open subfolders are listed level by level, each level in parallel.
async function subtreeRows(entry, depth) {
  const treeRoot = treeRootOf(entry);
  const list = !treeRoot ? listDir : async (dir) => {
    const items = (await treeRoot.list?.(dir)) || await listDir(dir);
    return items.map((c) => ({ ...c, treeRoot: treeRoot.id }));
  };
  const listings = new Map();
  for (let level = [entry.path]; level.length;) {
    const lists = await Promise.all(level.map(list));
    const next = [];
    level.forEach((dir, i) => {
      listings.set(keyOf(dir), lists[i]);
      for (const c of lists[i]) if (c.dir && expanded.has(keyOf(c.path))) next.push(c.path);
    });
    level = next;
  }
  const out = [];
  const add = (dir, d) => {
    for (const c of listings.get(keyOf(dir)) || []) {
      out.push({ entry: c, depth: d });
      if (c.dir && expanded.has(keyOf(c.path))) add(c.path, d + 1);
    }
  };
  add(entry.path, depth + 1);
  return out;
}

function rowNode({ entry, depth }, index) {
  const open = entry.dir && expanded.has(keyOf(entry.path));
  const node = el('div', 'node' + (inSelection(entry) ? ' selected' : ''));
  node._entry = entry;
  node.style.top = `${index * ROW_HEIGHT}px`;
  node.style.paddingLeft = `${depth * 16 + 4}px`;
  node.draggable = depth > 0 && !entry.treeRoot;
  if (entry.treeRoot) node.classList.add('tree-extra');
  else if (cutEntry && samePath(entry.path, cutEntry.path)) node.classList.add('cut');
  node.appendChild(el('span', 'arrow', entry.dir ? (open ? '▾' : '▸') : ''));
  const decorations = treeDecorators.map((deco) => deco(entry)).filter(Boolean);
  // A decorator's iconType draws another icon for the entry (a sources root's blue folder, Mark Directory As).
  const icon = ide.fileIcon(entry.name, { dir: entry.dir, type: decorations.find((d) => d.iconType)?.iconType || entry.iconType });
  icon.classList.add('icon');
  node.appendChild(icon);
  const name = el('span', 'name', entry.label || entry.name);
  node.appendChild(name);
  for (const d of decorations) {
    if (d.color) name.style.color = d.color;
    if (d.badge) node.appendChild(el('span', 'tree-badge', d.badge));
  }
  return node;
}

// Draws the rows in view. A hidden tree (no height yet) still draws a screenful, so its first rows exist.
function drawTree() {
  const tree = $('tree');
  if (!tree) return;
  const canvas = tree.firstChild;
  canvas.style.height = `${rows.length * ROW_HEIGHT}px`;
  const view = tree.clientHeight || 40 * ROW_HEIGHT;
  const first = Math.max(0, Math.floor(tree.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((tree.scrollTop + view) / ROW_HEIGHT) + OVERSCAN);
  const nodes = [];
  for (let i = first; i < last; i++) nodes.push(rowNode(rows[i], i));
  canvas.replaceChildren(...nodes);
}

function scrollToRow(i) {
  const tree = $('tree');
  if (i * ROW_HEIGHT < tree.scrollTop) tree.scrollTop = i * ROW_HEIGHT;
  else if ((i + 1) * ROW_HEIGHT > tree.scrollTop + tree.clientHeight) tree.scrollTop = (i + 1) * ROW_HEIGHT - tree.clientHeight;
}

function selectRow(i) {
  if (!rows.length) return;
  i = Math.max(0, Math.min(rows.length - 1, i));
  selected = rows[i].entry;
  alsoSelected = [];
  scrollToRow(i);
  drawTree();
}

// Open folders are remembered per project (relative, lower-cased paths) and listed again when it opens.
let saveExpandedTimer = null;
function saveExpanded() {
  clearTimeout(saveExpandedTimer);
  const root = ide.root;
  saveExpandedTimer = setTimeout(() => {
    if (!root || !samePath(root, ide.root)) return;
    const open = rows.filter((r) => r.depth > 0 && !r.entry.treeRoot && r.entry.dir && expanded.has(keyOf(r.entry.path))).map((r) => keyOf(r.entry.path).slice(root.replace(/[\\/]+$/, '').length + 1));
    const keep = new Set(ide.settings.get('recentProjects', []).map((p) => keyOf(p.path)));
    const all = Object.fromEntries(Object.entries(ide.settings.get(EXPANDED_KEY, {})).filter(([k]) => keep.has(k)));
    ide.settings.set(EXPANDED_KEY, { ...all, [keyOf(root)]: open.slice(0, 500) });
  }, 1000);
}

// The extra top-level nodes (Scratches and Consoles) show the same folders in every project, so their open folders
// are one global setting: {rootId: [lower-cased paths relative to the node, '' for the node itself]}. A folder inside
// a closed node keeps its state, as in PyCharm.
const ROOTS_EXPANDED_KEY = 'projectTree.rootsExpanded';
const rootsExpanded = () => {
  const v = ide.settings.get(ROOTS_EXPANDED_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};
function restoreRootExpanded(r) {
  const saved = Object.hasOwn(rootsExpanded(), r.id) ? rootsExpanded()[r.id] : null;
  if (!Array.isArray(saved)) return;
  for (const rel of saved) if (typeof rel === 'string') expanded.add(keyOf(rel ? joinPath(r.entry.path, rel) : r.entry.path));
}
function saveRootsExpanded() {
  const saved = { ...rootsExpanded() };
  for (const r of treeRoots) {
    const base = keyOf(r.entry.path).replace(/[\\/]+$/, '');
    saved[r.id] = [...expanded].filter((k) => isUnder(k, base)).map((k) => (samePath(k, base) ? '' : k.slice(base.length + 1))).slice(0, 200);
  }
  ide.settings.set(ROOTS_EXPANDED_KEY, saved);
}

// Lists every open folder again (files may have changed on disk) and redraws. Calls made while one is waiting to
// start share it; a call made while one runs gets its own run afterwards.
let pendingRefresh = null;
function renderTree() {
  pendingRefresh ||= enqueueTree(async () => {
    pendingRefresh = null;
    const rootPath = ide.root;
    if (!rootPath || !$('tree')) return;
    const root = { name: basename(rootPath), path: rootPath, dir: true };
    const below = expanded.has(keyOf(rootPath)) ? await subtreeRows(root, 0) : [];
    const extra = [];
    for (const r of treeRoots) {
      const entry = { ...r.entry, treeRoot: r.id };
      extra.push({ entry, depth: 0 }, ...(expanded.has(keyOf(entry.path)) ? await subtreeRows(entry, 0) : []));
    }
    if (!samePath(rootPath, ide.root)) return;
    rows = [{ entry: root, depth: 0 }, ...below, ...extra];
    drawTree();
    if (!performance.getEntriesByName('pyide:tree').length) performance.mark('pyide:tree');
    ide.emit('treeRefreshed');
  });
  return pendingRefresh;
}
ide.refreshTree = renderTree;

const toggleDir = (entry) => enqueueTree(async () => {
  const i = rowIndexOf(entry.path, entry.treeRoot);
  if (i < 0) return;
  const { depth } = rows[i];
  const k = keyOf(entry.path);
  if (expanded.has(k)) {
    expanded.delete(k);
    let end = i + 1;
    while (end < rows.length && rows[end].depth > depth) end++;
    rows.splice(i + 1, end - i - 1);
  } else {
    const rootPath = ide.root;
    expanded.add(k);
    const below = await subtreeRows(rows[i].entry, depth);
    if (!samePath(rootPath, ide.root)) return;
    rows = rows.slice(0, i + 1).concat(below, rows.slice(i + 1));
  }
  if (entry.treeRoot) saveRootsExpanded(); else saveExpanded();
  drawTree();
});

ide.revealInTree = async (path) => {
  const base = treeBaseOf(path);
  if (!base) return;
  for (let d = dirname(path); d && isUnder(d, base.path); d = dirname(d)) expanded.add(keyOf(d));
  selected = { name: basename(path), path, dir: false, ...(base.id ? { treeRoot: base.id } : {}) };
  alsoSelected = [];
  await renderTree();
  const i = rowIndexOf(path, base.id);
  if (i >= 0) selectRow(i);
  if (base.id) saveRootsExpanded(); else saveExpanded();
};

const selectedDir = () => (!selected || selected.treeRoot ? ide.root : selected.dir ? selected.path : dirname(selected.path));
// The message of an error a main-process handler threw, without Electron's "Error invoking remote method" prefix.
// The file-system errors users meet read as a sentence instead of Node's "EBUSY: resource busy or locked, open '…'".
const FS_ERRORS = {
  EBUSY: tr('The file is in use by another program'),
  EPERM: tr('Access is denied (the file may be read-only)'),
  EACCES: tr('Access is denied (the file may be read-only)'),
  ENOENT: tr('The file or folder does not exist'),
  EISDIR: tr('It is a folder, not a file'),
  ENOTDIR: tr('A part of the path is a file, not a folder'),
  ENOSPC: tr('The disk is full'),
  EROFS: tr('The disk is read-only'),
  ENAMETOOLONG: tr('The path is too long'),
};
// Node's and Chromium's network failures (connect ECONNREFUSED 203.0.113.5:443, getaddrinfo ENOTFOUND host,
// net::ERR_CONNECTION_REFUSED), and a program spawn could not find (spawn git ENOENT), read as a sentence too. A
// failure on this computer's own address (a debugger or helper on 127.0.0.1) is not the internet's: it keeps its text.
const NETWORK = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|\bnet::ERR_[A-Z_]+/;
const LOOPBACK = /\b127\.\d+\.\d+\.\d+\b|\blocalhost\b|(?<![\w:])::1(?![\w.])/i;
const ipcError = (e) => {
  const text = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const code = /^([A-Z]+): /.exec(text)?.[1];
  if (FS_ERRORS[code]) return FS_ERRORS[code];
  const network = NETWORK.exec(text);
  if (network && !LOOPBACK.test(text)) return tr('Cannot reach the server ({code}). Check the internet connection or the proxy settings.', { code: network[0] });
  const program = /^spawn (.+) ENOENT$/.exec(text)?.[1];
  if (program) return tr('{program} is not installed or not on PATH.', { program: basename(program) });
  return text;
};
ide.util.errorText = ipcError;

// Hooks that give a new file (New Python File) its first text: `async (path) => text | false | undefined`; the first
// string wins (file-templates: the "Python Script" template), false cancels the new file (a template variable dialog
// was cancelled), and a hook that throws is skipped.
ide.newFileHooks = [];
async function newFileText(path) {
  for (const hook of ide.newFileHooks) {
    try {
      const text = await hook(path);
      if (text === false) return null;
      if (typeof text === 'string') return text;
    } catch (e) { ide.log.warn(`newFileHooks: ${e?.message || e}`); }
  }
  return '';
}

// Items for the project tree's context menu: `(entry) => [menu items]`. An item labelled New with a submenu is merged
// into the menu's New › (file-templates: File, Python File, Python Package…).
ide.treeNewItems = [];
async function createEntry(isDir) {
  if (!ide.root) return;
  const name = await ide.ui.prompt(isDir ? tr('New directory name') : tr('New Python file name'), isDir ? '' : 'main.py');
  if (!name) return;
  const target = joinPath(selectedDir(), !isDir && !name.includes('.') ? `${name}.py` : name);
  if (await ide.api.exists(target)) return void ide.ui.alert(tr('{path} already exists', { path: basename(target) }));
  try {
    const text = isDir ? '' : await newFileText(target);
    if (text === null) return;
    await ide.api.create(target, isDir);
    // Written with Settings › Editor › Code Style › Line separator for new files.
    if (text) await ide.api.write(target, ide.lineSeparators.forNewFile(text));
    expanded.add(keyOf(dirname(target)));
    await renderTree();
    ide.emit('filesChanged', { created: [target] });
    if (!isDir) ide.openFile(target);
  } catch (e) { ide.ui.alert(ipcError(e)); }
}

// Renames or moves a file or folder. Windows' rename replaces an existing file, so an existing target is refused.
// Open documents under it, in every window, move along with their unsaved text: nothing is saved first, so a save
// that fails (a read-only file) or is cancelled (File Cache Conflict) cannot lose an edit.
async function moveTo(entry, to) {
  if (!samePath(entry.path, to) && await ide.api.exists(to)) return void ide.ui.alert(tr('{path} already exists', { path: to }));
  try { await ide.api.rename(entry.path, to); } catch (e) { return void ide.ui.alert(ipcError(e)); }
  await ide.documentsMoved(entry.path, to);
  renderTree();
  ide.emit('filesChanged', { renamed: [[entry.path, to]] });
}

// A plugin can take over a rename or move from the tree (refactor: a Python module with its imports):
// handler({kind: 'rename'|'move', entry, dir}) resolves true when it handled it (done or cancelled), else the plain
// rename or move below runs. ide.moveTreeEntry(entry, to) is that plain rename or move.
ide.treeMoveHandlers = [];
ide.moveTreeEntry = moveTo;
const handledByPlugin = async (request) => {
  for (const handler of ide.treeMoveHandlers) {
    try { if (await handler(request)) return true; } catch (e) { console.error(e); }
  }
  return false;
};

async function renameEntry(entry) {
  if (await handledByPlugin({ kind: 'rename', entry })) return;
  const name = await ide.ui.prompt(tr('New name'), entry.name);
  if (!name || name === entry.name) return;
  await moveTo(entry, joinPath(dirname(entry.path), name));
}

// Dropping a row on a folder (or Ctrl+X, Ctrl+V) moves it there, after a confirmation.
async function moveEntry(entry, dir) {
  if (samePath(dirname(entry.path), dir) || isUnder(dir, entry.path)) return;
  if (await handledByPlugin({ kind: 'move', entry, dir })) return;
  if (!(await ide.ui.confirm(tr('Move {name} to {dir}?', { name: entry.name, dir: ide.util.rel(dir) || basename(dir) }), { ok: tr('Move') }))) return;
  expanded.add(keyOf(dir));
  await moveTo(entry, joinPath(dir, entry.name));
}

// fs:copyInto's failures that Node words as a long sentence with both paths in it.
const COPY_ERRORS = {
  ESAMENAME: tr('another dropped item has the same name'),
  ERR_FS_CP_DIR_TO_NON_DIR: tr('a file with this name is already there'),
  ERR_FS_CP_NON_DIR_TO_DIR: tr('a folder with this name is already there'),
};
// Files and folders dropped from Explorer are copied into dir, as PyCharm does. A source already in dir, or one that
// holds dir, is left out; names that exist there are overwritten or skipped as the user chooses.
async function copyDropped(paths, dir) {
  const sources = paths.filter((p) => !samePath(dirname(p), dir) && !isUnder(dir, p));
  if (!sources.length) return;
  const where = ide.util.rel(dir) || basename(dir);
  const existing = [];
  for (const p of sources) if (await ide.api.exists(joinPath(dir, basename(p)))) existing.push(basename(p));
  let overwrite = false;
  if (existing.length) {
    const choice = await new Promise((resolve) => ide.ui.dialog({
      title: tr('Copy'),
      body: tr('{names} already exist in {dir}.', { names: existing.join(', '), dir: where }),
      buttons: [{ label: tr('Overwrite'), run: () => resolve('overwrite') }, { label: tr('Skip'), primary: true, run: () => resolve('skip') }, { label: tr('Cancel'), run: () => resolve(null) }],
      width: 460,
      onClose: () => resolve(null),
    }));
    if (!choice) return;
    overwrite = choice === 'overwrite';
  }
  let result;
  try { result = await ide.api.copyInto(sources, dir, overwrite); } catch (e) {
    return void ide.ui.alert(tr('Could not copy to {dir}: {error}', { dir: where, error: ipcError(e) }));
  }
  const { copied, failed } = result;
  if (failed.length) {
    const lines = failed.map((f) => `${f.name}: ${COPY_ERRORS[f.code] || ipcError(f.error)}`);
    ide.ui.alert(`${tr('Could not copy to {dir}:', { dir: where })}\n${lines.join('\n')}`);
  }
  if (!copied.length) return;
  if (!samePath(dir, ide.root)) expanded.add(keyOf(dir));
  renderTree();
  ide.emit('filesChanged', { created: copied });
}

async function deleteEntry(entry) {
  if (!(await ide.ui.confirm(tr('Move {name} to the Recycle Bin?', { name: entry.name }), { ok: tr('Delete') }))) return;
  // A file another program holds open, or a drive without a Recycle Bin, stays where it is.
  try { await ide.api.trash(entry.path); } catch (e) {
    return void ide.ui.alert(tr('Could not move {name} to the Recycle Bin: {error}', { name: entry.name, error: ipcError(e) }));
  }
  // Every tab of a deleted file closes, in every window, so nothing saves the document back to the deleted path.
  await ide.documentsMoved(entry.path, null);
  renderTree();
  ide.emit('filesChanged', { deleted: [entry.path] });
}

// PyCharm's New ›: File, Directory, Python File (Alt+Insert), Python Package… Core adds Directory, and Python File when
// no plugin offers one; plugins' other items stay beside it.
function newItems(entry) {
  const items = ide.treeNewItems.flatMap((fn) => { try { return fn(entry) || []; } catch (e) { console.error(e); return []; } });
  const isNew = (it) => it.label === tr('New') && it.submenu;
  const submenu = () => {
    const sub = items.filter(isNew).flatMap((it) => (typeof it.submenu === 'function' ? it.submenu() : it.submenu));
    const python = sub.find((it) => it.label === tr('Python File'));
    if (python) python.keyAction = 'NewPythonFile';
    else sub.unshift({ label: tr('Python File'), keyAction: 'NewPythonFile', run: () => createEntry(false) });
    sub.splice(sub.findIndex((it) => it.label === tr('File')) + 1, 0, { label: tr('Directory'), run: () => createEntry(true) });
    return sub;
  };
  return [{ label: tr('New'), submenu }, ...items.filter((it) => !isNew(it))];
}

function showTreeMenu(entry, x, y) {
  // A row under an extra top-level node gets that node's own items instead of the project's.
  const treeRoot = treeRootOf(entry);
  const own = treeRoot && (treeRoot.menu?.(entry) || []);
  const sel = ide.selectedTreeEntries();
  const extra = treeRoot ? own : treeActions.filter((a) => !a.when || a.when(entry, sel)).map((a) => ({ label: a.title, hint: a.hint, keyAction: a.keyAction, run: () => a.run(entry, sel) }));
  const fixed = samePath(entry.path, ide.root) || !!entry.fixed;
  ide.ui.contextMenu(x, y, [
    ...(treeRoot ? [] : [
      ...newItems(entry),
      { separator: true },
    ]),
    ...(extra.length ? [...extra, { separator: true }] : []),
    ...(treeRoot ? [] : [
      { label: tr('Cut'), hint: 'Ctrl+X', run: () => setCut(entry), disabled: fixed },
      { label: tr('Paste'), hint: 'Ctrl+V', run: () => pasteInto({ entry }), disabled: !cutEntry },
    ]),
    { label: tr('Rename…'), keyAction: 'RenameElement', run: () => renameEntry(entry), disabled: fixed },
    { label: tr('Delete'), hint: 'Delete', run: () => deleteEntry(entry), disabled: fixed },
  ]);
}

// Up/Down/Home/End/PageUp/PageDown move the selection, Right opens a folder or enters it, Left closes it or goes to
// the parent, Enter opens a file or toggles a folder, Delete moves the selection to the Recycle Bin.
// Shift+F6 renames the selection; Ctrl+X and then Ctrl+V on a folder (or a file in it) moves it there, Escape
// cancels the cut. Escape is an action registered on ready, after core's FocusEditor (also Escape), so it wins while
// the tree has the keyboard and something is cut; the global keymap handler runs before the tree's own keys.
ide.on('ready', () => ide.registerAction({
  id: 'ProjectView.CancelCut', keys: 'Escape',
  when: () => !!cutEntry && document.activeElement === $('tree'),
  run: () => setCut(null),
}));
const movable = (row) => !!row && row.depth > 0 && !row.entry.fixed && !row.entry.treeRoot && !treeRootOf(row.entry);
// Only into the project: rows under Scratches and Consoles (and their nodes) are not paste targets, even when the
// project folder contains them, and the cut entry stays cut for another try.
const pasteInto = (row) => {
  const entry = cutEntry;
  if (!entry || row?.entry.treeRoot) return;
  const dir = !row ? ide.root : row.entry.dir ? row.entry.path : dirname(row.entry.path);
  if (!isUnder(dir, ide.root) || !isUnder(entry.path, ide.root) || treeRoots.some((r) => isUnder(dir, r.entry.path) && !isUnder(ide.root, r.entry.path))) return;
  setCut(null);
  moveEntry(entry, dir);
};
function treeKey(e) {
  if (!rows.length || e.altKey || e.metaKey) return;
  const i = selected ? rowIndexOf(selected.path, selected.treeRoot) : -1;
  const row = rows[i];
  const special = e.ctrlKey && !e.shiftKey ? { KeyX: () => { if (movable(row)) setCut(row.entry); }, KeyV: () => pasteInto(row) }[e.code]
    : !e.ctrlKey && e.shiftKey && e.key === 'F6' ? () => movable(row) && renameEntry(row.entry) : null;
  if (special) {
    e.preventDefault();
    e.stopPropagation();
    return void special();
  }
  if (e.ctrlKey) return;
  const page = Math.max(1, Math.floor($('tree').clientHeight / ROW_HEIGHT) - 1);
  const isOpen = row?.entry.dir && expanded.has(keyOf(row.entry.path));
  const keys = {
    ArrowDown: () => selectRow(i + 1),
    ArrowUp: () => selectRow(i < 0 ? 0 : i - 1),
    Home: () => selectRow(0),
    End: () => selectRow(rows.length - 1),
    PageDown: () => selectRow(i + page),
    PageUp: () => selectRow(i - page),
    ArrowRight: () => row?.entry.dir && (isOpen ? rows[i + 1]?.depth > row.depth && selectRow(i + 1) : toggleDir(row.entry)),
    ArrowLeft: () => {
      if (!row) return;
      if (isOpen) return toggleDir(row.entry);
      let j = i - 1;
      while (j >= 0 && rows[j].depth >= row.depth) j--;
      if (j >= 0) selectRow(j);
    },
    Enter: () => row && (row.entry.dir ? toggleDir(row.entry) : ide.openFile(row.entry.path)),
    Delete: () => row && row.depth > 0 && !row.entry.fixed && deleteEntry(row.entry),
  };
  if (!keys[e.key]) return;
  e.preventDefault();
  e.stopPropagation();
  keys[e.key]();
}

function wireTree(tree) {
  const entryAt = (e) => e.target.closest?.('.node')?._entry;
  tree.addEventListener('scroll', drawTree, { passive: true });
  observeSize(tree, () => drawTree());
  tree.addEventListener('keydown', treeKey);
  tree.addEventListener('click', (e) => {
    const entry = entryAt(e);
    if (!entry) return;
    // Ctrl+click adds the row to the selection or takes it out, and opens nothing.
    if (e.ctrlKey && selected) {
      if (sameEntry(entry, selected)) [selected, ...alsoSelected] = alsoSelected.length ? alsoSelected : [selected];
      else if (alsoSelected.some((s) => sameEntry(s, entry))) alsoSelected = alsoSelected.filter((s) => !sameEntry(s, entry));
      else alsoSelected.push(entry);
      return drawTree();
    }
    selected = entry;
    alsoSelected = [];
    drawTree();
    // Shift+click opens a file beside the current pane; a single click opens it as a preview tab.
    if (entry.dir) toggleDir(entry);
    else ide.openFile(entry.path, e.shiftKey ? { group: 'right' } : { preview: true });
  });
  // Double-click keeps a file that a single click opened as a preview tab.
  tree.addEventListener('dblclick', (e) => {
    const entry = entryAt(e);
    if (entry && !entry.dir) ide.openFile(entry.path);
  });
  tree.addEventListener('contextmenu', (e) => {
    const entry = entryAt(e);
    if (!entry) return;
    e.preventDefault();
    // A right-click inside a multiple selection keeps it (Compare Files acts on both).
    if (!inSelection(entry)) { selected = entry; alsoSelected = []; }
    drawTree();
    showTreeMenu(entry, e.clientX, e.clientY);
  });
  // Drag a row onto a folder to move it, or onto an editor to open it there (editors.js reads the path type).
  let dragged = null;
  const dropDir = (e) => {
    const entry = entryAt(e);
    return entry && dragged && !entry.treeRoot && (entry.dir ? entry.path : dirname(entry.path));
  };
  const clearDropMark = () => tree.querySelectorAll('.drop-into').forEach((n) => n.classList.remove('drop-into'));
  const markDrop = (dir) => {
    const i = rowIndexOf(dir);
    [...tree.firstChild.children].find((n) => n._entry === rows[i]?.entry)?.classList.add('drop-into');
  };
  // From Explorer: the folder under the pointer, the folder of the file under it, or the project root below the rows.
  // Elsewhere in the window, dropped files open (editors.js).
  const fromOutside = (e) => !dragged && [...e.dataTransfer.types].includes('Files');
  const outsideDir = (e) => {
    const entry = entryAt(e);
    const dir = !entry ? ide.root : entry.dir ? entry.path : dirname(entry.path);
    return dir && ide.root && isUnder(dir, ide.root) && !treeRoots.some((r) => isUnder(dir, r.entry.path) && !isUnder(ide.root, r.entry.path)) ? dir : null;
  };
  tree.addEventListener('dragstart', (e) => {
    dragged = entryAt(e);
    if (!dragged) return;
    // No text/plain: Monaco would type the path into the editor it is dropped on.
    e.dataTransfer.setData(ide.TREE_PATH_TYPE, dragged.path);
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  // On the document: the row the drag started from may have been redrawn (auto-scroll, a refresh) and detached.
  document.addEventListener('dragend', () => { dragged = null; clearDropMark(); });
  tree.addEventListener('dragover', (e) => {
    if (fromOutside(e)) {
      const dir = outsideDir(e);
      clearDropMark();
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (!samePath(dir, ide.root)) markDrop(dir);
      return;
    }
    const dir = dropDir(e);
    clearDropMark();
    if (!dir || samePath(dirname(dragged.path), dir) || isUnder(dir, dragged.path)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    markDrop(dir);
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) clearDropMark(); });
  tree.addEventListener('drop', (e) => {
    if (fromOutside(e)) {
      const dir = outsideDir(e);
      clearDropMark();
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      copyDropped([...e.dataTransfer.files].map((f) => ide.api.pathForFile(f)).filter(Boolean), dir);
      return;
    }
    const dir = dropDir(e);
    const entry = dragged;
    clearDropMark();
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    moveEntry(entry, dir);
  });
}
ide.TREE_PATH_TYPE = 'application/x-pyide-path';

ide.registerToolWindow({
  id: 'Project', title: tr('Project'), icon: '▤', side: 'left', keys: 'Alt+1', order: 0,
  mount(container, tw) {
    const tree = el('div');
    tree.id = 'tree';
    tree.tabIndex = 0;
    tree.appendChild(el('div', 'tree-canvas'));
    container.appendChild(tree);
    wireTree(tree);
    tw.setActions([
      { icon: '＋', title: tr('New Python File'), run: () => createEntry(false) },
      { icon: '▣', title: tr('New Directory'), run: () => createEntry(true) },
      { icon: '⟳', title: tr('Refresh'), run: renderTree },
    ]);
  },
});

// ---------- interpreters ----------
// interpreterProviders: async (root) => interps, for interpreters that are not local executables.
// pathMappers: (path) => local path or null, so a path a remote interpreter printed (a traceback) opens here.
ide.interpreterProviders = [];
ide.pathMappers = [];
ide.toLocalPath = (p) => {
  for (const map of ide.pathMappers) {
    const local = map(p);
    if (local) return local;
  }
  return p;
};
// The selected interpreter, or null: none found, or the project's chosen one is invalid (see invalidInterp).
ide.currentInterp = () => {
  const it = ide.interps[$('interpSelect').selectedIndex];
  return it && !it.invalid ? it : null;
};
function showInterp(it) {
  $('statusInterpLabel').textContent = it?.invalid ? tr('Invalid interpreter: {name}', { name: it.name }) : it?.label || tr('No interpreter');
  $('statusInterp').classList.toggle('invalid', !!it?.invalid);
}
// The IDE's helper scripts (console, debugger, package tools) need Python 3.8 or newer.
const tooOld = (version) => {
  const [major, minor] = String(version || '').split('.').map((n) => parseInt(n, 10));
  return Number.isInteger(major) && Number.isInteger(minor) && (major < 3 || (major === 3 && minor < 8));
};
// The project's chosen interpreter is not in the list: its python.exe is gone, or it does not start (a venv whose
// base Python was uninstalled). Another Python does not silently take its place: it is listed as invalid and stays
// selected, so nothing runs until the user chooses (PyCharm's "Invalid Python interpreter selected for the project").
// One that starts but is not found by the list (a Python the py launcher no longer names) is listed as it is.
// Safe Mode keeps the project's own venvs unstarted, so there a venv is not checked.
async function chosenInterp(root, interps) {
  const chosen = root ? ide.settings.get(`interpreter.${root}`, '') : '';
  if (!/^([a-z]:[\\/]|\\\\)/i.test(chosen) || interps.some((i) => samePath(i.executable, chosen))) return null;
  const d = await ide.api.invoke('py:diagnose', root, chosen).catch(() => null);
  const venv = /[\\/]Scripts[\\/]python\.exe$/i.test(chosen) ? dirname(dirname(chosen)) : null;
  const name = venv ? (isUnder(venv, root) ? ide.util.rel(venv) : basename(venv)) : chosen;
  if (d?.state === 'ok') return { cmd: chosen, args: [], label: `${name} (Python ${d.version})`, executable: chosen, version: d.version };
  if (d?.state !== 'missing' && d?.state !== 'fails') return null;
  const reason = d.state === 'missing' ? tr('{path} does not exist.', { path: chosen }) : tr('{path} does not start: {detail}', { path: chosen, detail: d.detail });
  return { cmd: chosen, args: [], label: tr('{name} (invalid)', { name }), name, executable: chosen, invalid: true, reason, venv, state: d.state };
}
const toldInvalid = new Set();
function tellInvalid(it) {
  const key = `${ide.root}|${it.executable}|${it.state}`.toLowerCase();
  if (toldInvalid.has(key)) return;
  toldInvalid.add(key);
  const actions = [{ label: tr('Choose Interpreter…'), run: () => ide.openSettings?.('interpreter') }];
  if (it.venv && isUnder(it.venv, ide.root) && ide.venvSetup?.recreate) actions.push({ label: tr('Recreate {name}', { name: basename(it.venv) }), run: () => ide.venvSetup.recreate(it.venv) });
  ide.notifications?.notify({
    title: tr('Invalid Python interpreter selected for the project'), kind: 'warning', group: 'Python Interpreter', raw: true, actions,
    text: `${it.reason}\n${tr('PyIDE does not run the project with another Python in its place. Choose an interpreter, or recreate the virtual environment.')}`,
  });
}
const toldOld = new Set();
ide.on('interpreterChanged', (it) => {
  if (!it?.unsupported || toldOld.has(it.executable.toLowerCase())) return;
  toldOld.add(it.executable.toLowerCase());
  ide.notifications?.notify({
    title: tr('Unsupported Python version'), kind: 'warning', group: 'Python Interpreter', raw: true,
    text: tr('{name} is Python {version}. The Python Console, the debugger and the package tools need Python 3.8 or newer.', { name: it.executable, version: it.version }),
    actions: [{ label: tr('Choose Interpreter…'), run: () => ide.openSettings?.('interpreter') }],
  });
});
// Only the latest call applies its list: probing a project's venvs can take seconds, and a call for the project
// that was open before must not replace the list of the one opened since. An overtaken call resolves with the latest.
let interpSeq = 0;
let interpLoad = null;
ide.reloadInterpreters = () => (interpLoad = loadInterpreters(++interpSeq));
async function loadInterpreters(seq) {
  const root = ide.root;
  const found = await ide.api.interpreters(root, ide.settings.get('interpreters.extra', []));
  // Plugins add interpreters that are not local executables (remote-interp: WSL, SSH, Docker targets).
  for (const provide of ide.interpreterProviders) {
    try { found.push(...await provide(root)); } catch (err) { console.warn('interpreter provider failed', err); }
  }
  const chosen = await chosenInterp(root, found);
  if (seq !== interpSeq) return interpLoad;
  if (chosen) found.push(chosen);
  ide.interps = found.map((it) => (!it.invalid && tooOld(it.version) ? { ...it, unsupported: true, label: tr('{label} [unsupported]', { label: it.label }) } : it));
  const sel = $('interpSelect');
  sel.innerHTML = '';
  for (const it of ide.interps) sel.add(new Option(it.label));
  if (!ide.interps.length) sel.add(new Option(tr('<No interpreter>')));
  const preferred = ide.settings.get(`interpreter.${ide.root}`, '');
  const idx = ide.interps.findIndex((i) => samePath(i.executable, preferred));
  if (idx >= 0) sel.selectedIndex = idx;
  showInterp(ide.interps[sel.selectedIndex]);
  if (chosen?.invalid) tellInvalid(chosen);
  ide.emit('interpreterChanged', ide.currentInterp());
}
// Selects an interpreter by its python.exe (the status-bar widget and the New Project wizard use this).
ide.setInterpreter = (executable) => {
  const i = ide.interps.findIndex((x) => samePath(x.executable, executable));
  if (i < 0) return false;
  $('interpSelect').selectedIndex = i;
  $('interpSelect').onchange();
  return true;
};
$('interpSelect').onchange = () => {
  const it = ide.currentInterp();
  showInterp(ide.interps[$('interpSelect').selectedIndex]);
  if (it && ide.root) ide.settings.set(`interpreter.${ide.root}`, it.executable);
  ide.emit('interpreterChanged', it);
};

// ---------- project ----------
// A folder the user has not trusted (main/trust.js) asks first, like PyCharm's "Trust and Open Project": trusted, it
// opens normally; in Safe Mode it opens without running anything it ships (its venv's Python, git, its .env).
// Resolves 'trusted', 'safe' or null (cancelled).
async function askTrust(dir) {
  if (await ide.api.invoke('trust:isTrusted', dir)) return 'trusted';
  return new Promise((resolve) => {
    let answer = null;
    ide.ui.dialog({
      title: tr('Trust and Open Project?'),
      body: el('div', 'dialog-message', tr('{name} can run code when PyIDE works with it: its virtual environment\'s Python, its Git configuration and its .env file. Trust it only if you know where it comes from. Safe Mode opens it without running anything from it.', { name: basename(dir) })),
      width: 560,
      onClose: () => resolve(answer),
      buttons: [
        { label: tr('Trust Project'), primary: true, run: async () => { await ide.api.invoke('trust:add', dir); answer = 'trusted'; } },
        { label: tr('Preview in Safe Mode'), run: () => { answer = 'safe'; } },
        { label: tr('Cancel') },
      ],
    });
  });
}

const trustBar = el('div', 'trust-bar hidden');
trustBar.id = 'trustBar';
$('center').prepend(trustBar);
function showTrustBar(dir) {
  trustBar.replaceChildren(el('span', null, tr('Safe Mode: PyIDE runs nothing from this project (its venv, Git, .env).')));
  const btn = el('button', 'primary', tr('Trust Project'));
  btn.onclick = async () => {
    await ide.api.invoke('trust:add', dir);
    // Every feature starts over as for a trusted project: interpreters, Git, Pyright with the project venv. The page
    // reopens this project (the window's own ?open= is the folder it was started with).
    if (!(await projectChangeAllowed(dir, { reload: true })) || !(await ide.closeAllTabs(false))) return;
    const url = new URL(location.href);
    url.searchParams.set('open', dir);
    url.searchParams.delete('file');
    location.replace(url.href);
  };
  trustBar.appendChild(btn);
  trustBar.classList.remove('hidden');
}
// The trust bar's Trust Project for plugins that need a trusted project (Run Anything): trusts it and reopens the page.
// Returns false when the project is not in Safe Mode.
ide.trustProject = () => {
  const btn = !trustBar.classList.contains('hidden') && trustBar.querySelector('button.primary');
  if (btn) btn.click();
  return !!btn;
};

// Hooks that may veto opening another project, closing it, or reloading the page for Trust Project:
// `async (next, {reload}) => false` cancels (next is the folder to open, null when closing). They run before unsaved
// files are asked about, so a cancel leaves everything as it was. The terminal asks before ending running sessions.
ide.beforeProjectChange = [];
async function projectChangeAllowed(next, opts = {}) {
  for (const fn of ide.beforeProjectChange) {
    try { if ((await fn(next, opts)) === false) return false; } catch (e) { ide.log.error(`beforeProjectChange: ${e?.stack || e}`); }
  }
  return true;
}

// Returns false if the user kept unsaved files of the current project open (each one asks, as Close Project does),
// did not open an untrusted folder, a beforeProjectChange hook cancelled, or another open (or Close Project) started
// meanwhile: only the latest one goes on after each wait, so two Recent Projects clicks in a row end on the second
// project with one projectOpened, and every plugin follows that one.
let openSeq = 0;
ide.openProject = async (dir) => {
  const my = ++openSeq;
  const latest = () => my === openSeq;
  const trust = await askTrust(dir);
  if (!trust || !latest()) return false;
  await learnPathCase(dir);
  if (!(await projectChangeAllowed(dir)) || !latest() || !(await ide.closeAllTabs(false)) || !latest()) return false;
  ide.trusted = trust === 'trusted';
  if (ide.trusted) trustBar.classList.add('hidden'); else showTrustBar(dir);
  ide.root = dir;
  cutEntry = null;
  expanded.clear();
  expanded.add(keyOf(dir));
  for (const rel of ide.settings.get(EXPANDED_KEY, {})[keyOf(dir)] || []) expanded.add(keyOf(joinPath(dir, rel)));
  for (const r of treeRoots) restoreRootExpanded(r);
  selected = null;
  alsoSelected = [];
  rows = [];
  drawTree();
  $('tree').scrollTop = 0;
  document.title = `${basename(dir)} - PyIDE`;
  $('welcome').classList.add('hidden');
  document.body.classList.remove('no-project');
  await Promise.all([renderTree(), ide.reloadInterpreters()]);
  if (!latest()) return false;
  try { localStorage.setItem('lastProject', dir); } catch {}
  // The list as the settings file has it now: another PyIDE instance on the same user data may have opened a project
  // since this window read it (unless this window's own change to it is not written yet).
  const onDisk = changedKeys.has('recentProjects') ? null : api.loadSettingsSync()?.recentProjects;
  const recent = (Array.isArray(onDisk) ? onDisk : ide.settings.get('recentProjects', []))
    .filter((p) => typeof p?.path === 'string' && p.path && !samePath(p.path, dir));
  ide.settings.set('recentProjects', [{ path: dir, opened: Date.now() }, ...recent].slice(0, 15));
  ide.emit('projectOpened', dir);
  return true;
};

// Whether a recent project's folder can be opened: 'exists', 'missing' (deleted; its drive or share is there), or
// null when it cannot be reached (a network share that does not answer, a drive that is not connected; the user is
// told, and it stays in the lists since it may come back) or the user cancelled. Such a share takes ~20 s to fail,
// so after a moment a dialog says it is connecting and offers Cancel, and after PROBE_MS it is reported unreachable.
const PROBE_MS = 5000;
let probing = false;
ide.probeProject = async (dir) => {
  if (probing) return null;
  probing = true;
  let dlg = null;
  let done = false;
  let cancelled = false;
  const later = setTimeout(() => {
    dlg = ide.ui.dialog({ title: tr('Opening Project'), body: tr('Connecting to {path}…', { path: dir }), width: 460,
      buttons: [{ label: tr('Cancel') }], onClose: () => { if (!done) cancelled = true; } });
  }, 300);
  let state;
  try { state = await ide.api.invoke('fs:probe', dir, PROBE_MS); } catch { state = 'unreachable'; }
  done = true;
  probing = false;
  clearTimeout(later);
  if (cancelled) return null;
  dlg?.close();
  if (state !== 'unreachable') return state;
  ide.ui.alert(tr('{path} cannot be reached. Check the network connection or that the drive is connected, then try again.', { path: dir }));
  return null;
};

// Back to the welcome screen, like PyCharm's File > Close Project. Returns false if the user kept unsaved files open
// or a beforeProjectChange hook cancelled.
ide.closeProject = async () => {
  if (!ide.root || !(await projectChangeAllowed(null)) || !(await ide.closeAllTabs(false))) return false;
  openSeq++;
  ide.root = null;
  cutEntry = null;
  trustBar.classList.add('hidden');
  expanded.clear();
  selected = null;
  alsoSelected = [];
  rows = [];
  drawTree();
  document.title = 'PyIDE';
  $('welcome').classList.remove('hidden');
  document.body.classList.add('no-project');
  try { localStorage.removeItem('lastProject'); } catch {}
  await ide.reloadInterpreters();
  ide.emit('projectClosed');
  return true;
};

ide.pickAndOpenProject = pickFolder;
async function pickFolder() {
  const dir = await ide.api.openFolder();
  if (dir) ide.openProject(dir);
}

// ---------- splitters ----------
document.querySelectorAll('.splitter').forEach((s) => {
  s.onmousedown = (down) => {
    const target = $(s.dataset.target);
    const vertical = s.classList.contains('v');
    const start = vertical ? down.clientX : down.clientY;
    const size = vertical ? target.offsetWidth : target.offsetHeight;
    const move = (e) => {
      const delta = ((vertical ? e.clientX : e.clientY) - start) * (s.dataset.grow === 'left' ? -1 : 1);
      if (vertical) target.style.width = `${Math.max(140, size + delta)}px`;
      else target.style.height = `${Math.max(80, size - delta)}px`;
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
});

// ---------- core actions (PyCharm $default keymap, extracted with REA) ----------
async function gotoFile() {
  if (!ide.root) return;
  let files;
  try { files = await ide.api.walk(ide.root); } catch (e) {
    return void ide.ui.alert(tr('Cannot open {name}: {error}', { name: basename(ide.root), error: ipcError(e) }));
  }
  const path = await ide.ui.pick({
    placeholder: tr('Search files'),
    items: files.map((p) => ({ label: basename(p), detail: ide.util.rel(dirname(p)), icon: ide.fileIcon(p), value: p })),
  });
  if (path) ide.openFile(path);
}

// Find Action also lists the editor's own Monaco actions (Sort Lines Ascending, Transform to Title Case, Fold All…)
// that no IDE action already runs. They show no shortcut: the IDE keymap may give their Monaco key to another action.
function monacoActions() {
  const ed = ide.editor;
  if (!ed?.getModel()) return [];
  const covered = new Set(ide.actions.map((a) => a.editorCommand || a.run?.editorCommand).filter(Boolean));
  return ed.getSupportedActions()
    .filter((m) => /^(editor|actions)\./.test(m.id) && m.id !== 'editor.action.quickCommand' && m.label && !covered.has(m.id) && m.isSupported())
    .map((m) => ({ label: m.label, value: { run: () => { ed.focus(); return m.run(); } } }));
}
async function findAction() {
  const action = await ide.ui.pick({
    placeholder: tr('Search actions'),
    items: [...ide.actions.filter((a) => a.title).map((a) => ({ label: a.title, hint: a.keys.map(ide.keymap.format).join(', '), value: a })), ...monacoActions()],
  });
  action?.run();
}

const inEditor = () => ide.editor?.hasTextFocus();
// editorCommand: the Monaco command, whose own Monaco keybindings follow the keymap too (settings plugin).
const editorAction = (id) => Object.assign(() => ide.editor?.trigger('keymap', id, null), { editorCommand: id });
[
  { id: 'SaveAll', title: tr('Save All'), keys: 'Ctrl+S', run: () => ide.saveAll() },
  // No key, as in PyCharm: Ctrl+O is Override Methods.
  { id: 'OpenProject', title: tr('Open Folder…'), run: pickFolder },
  { id: 'GotoFile', title: tr('Go to File…'), keys: 'Ctrl+Shift+N', run: gotoFile },
  { id: 'GotoAction', title: tr('Find Action…'), keys: 'Ctrl+Shift+A', run: findAction, terminal: true },
  { id: 'NewPythonFile', title: tr('New Python File'), keys: 'Alt+Insert', run: () => createEntry(false) },
  // The window that has the keyboard (left, right or bottom), else the bottom one.
  { id: 'HideBottom', title: tr('Hide Active Tool Window'), keys: 'Shift+Escape', terminal: true,
    run: () => (Object.values(areas).find((a) => a.panel.contains(document.activeElement)) || areas.bottom).active?.hide() },
  { id: 'FocusEditor', keys: 'Escape', when: () => !inEditor() && !document.activeElement?.closest('.editor-group') && !!ide.editor?.getModel(), run: () => ide.editor.focus() },
  { id: 'EditorDuplicate', title: tr('Duplicate Line'), keys: 'Ctrl+D', when: inEditor, run: editorAction('editor.action.copyLinesDownAction') },
  { id: 'EditorDeleteLine', title: tr('Delete Line'), keys: 'Ctrl+Y', when: inEditor, run: editorAction('editor.action.deleteLines') },
  { id: 'CommentByLineComment', title: tr('Comment with Line Comment'), keys: 'Ctrl+/', when: inEditor, run: editorAction('editor.action.commentLine') },
  { id: 'GotoLine', title: tr('Go to Line…'), keys: 'Ctrl+G', when: inEditor, run: editorAction('editor.action.gotoLine') },
  { id: 'Find', title: tr('Find'), keys: 'Ctrl+F', when: inEditor, run: editorAction('actions.find') },
  { id: 'Replace', title: tr('Replace'), keys: 'Ctrl+R', when: inEditor, run: editorAction('editor.action.startFindReplaceAction') },
  { id: 'EditorSelectWord', title: tr('Extend Selection'), keys: 'Ctrl+W', when: inEditor, run: editorAction('editor.action.smartSelect.expand') },
  { id: 'EditorUnSelectWord', title: tr('Shrink Selection'), keys: 'Ctrl+Shift+W', when: inEditor, run: editorAction('editor.action.smartSelect.shrink') },
  { id: 'MoveLineUp', title: tr('Move Line Up'), keys: 'Alt+Shift+ArrowUp', when: inEditor, run: editorAction('editor.action.moveLinesUpAction') },
  { id: 'MoveLineDown', title: tr('Move Line Down'), keys: 'Alt+Shift+ArrowDown', when: inEditor, run: editorAction('editor.action.moveLinesDownAction') },
  { id: 'CollapseRegion', title: tr('Collapse'), keys: 'Ctrl+-', when: inEditor, run: editorAction('editor.fold') },
  { id: 'ExpandRegion', title: tr('Expand'), keys: 'Ctrl+=', when: inEditor, run: editorAction('editor.unfold') },
].forEach((a) => ide.registerAction(a.when === inEditor ? { context: 'editor', ...a } : a));

$('welcomeOpen').onclick = pickFolder;

// ---------- boot ----------
// Text the IDE puts on the clipboard (Copy Path, terminal and console copies...) is announced as
// `clipboardWritten(text)`, so Paste from History (clipboard-history plugin) keeps it.
ide.api = { ...window.api, invoke: (channel, ...args) => {
  if (channel === 'clipboard:writeText' && typeof args[0] === 'string') ide.emit('clipboardWritten', args[0]);
  return window.api.invoke(channel, ...args);
} };

// Plugin scripts are fetched in parallel; async = false still runs them in list order (dependencies first). Each runs
// as its own script, so one that cannot be read or throws stops only itself; diagnostics.js reports it and keeps the
// reason for the Plugins page (ideDiagnostics.pluginLoadErrors), told apart from later errors by data-plugin.
async function loadFeatures() {
  const plugins = await ide.api.invoke('core:features');
  await Promise.all(plugins.map((p) => {
    if (p.css) {
      const link = el('link');
      link.rel = 'stylesheet';
      link.href = p.css;
      document.head.appendChild(link);
    }
    return new Promise((resolve) => {
      const s = el('script');
      s.src = p.script;
      s.async = false;
      Object.assign(s.dataset, { plugin: p.id, pluginName: p.name });
      s.onload = s.onerror = resolve;
      document.body.appendChild(s);
    });
  }));
}

// The relaunch exits without unloading the window, so pending settings are written first.
ide.restart = () => { flushSettings(); return ide.api.relaunch(); };

require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
// Monaco's own UI strings (find widget, context menu, command palette) come from its message bundle for the locale,
// vs/nls/lang/<locale>.js: a plain script that sets the globals Monaco reads, so it runs before editor.main. (Monaco's
// vs/nls loader plugin would require() it as an AMD module, which never resolves: the script calls no define().)
const monacoNls = new Promise((resolve) => {
  if (i18n.locale === 'en') return resolve();
  const s = document.createElement('script');
  s.src = `../node_modules/monaco-editor/min/vs/nls/lang/${i18n.locale}.js`;
  s.onload = s.onerror = resolve;
  document.head.appendChild(s);
});
monacoNls.then(() => require(['vs/editor/editor.main'], async () => {
  const monaco = (ide.monaco = window.monaco);
  // Diff editors leave their hunk gutter menu subscribed after dispose, and it throws "AbstractContextKeyService has
  // been disposed" whenever an editor action is registered later. PyIDE puts nothing in that menu.
  // Disposed with its models attached, a diff editor also stays subscribed to theme changes, which keeps the whole
  // widget (~230 KB, its DOM and listeners) alive: every diff view closed leaked one. Detaching the models first does not.
  // An editor's context menu is drawn in a shadow root appended to the editor's container, and Monaco defines the theme
  // colors (--vscode-menu-background…) only on .monaco-editor and .monaco-component in the document, so the menu got
  // no background and its items were drawn over the code. As a .monaco-component the container passes them down.
  const create = monaco.editor.create;
  monaco.editor.create = (el, options, override) => { el.classList.add('monaco-component'); return create(el, options, override); };
  const createDiffEditor = monaco.editor.createDiffEditor;
  monaco.editor.createDiffEditor = (el, options, override) => {
    el.classList.add('monaco-component');
    const diff = createDiffEditor(el, { renderGutterMenu: false, ...options }, override);
    const dispose = diff.dispose.bind(diff);
    diff.dispose = () => {
      try { diff.setModel(null); } catch {}
      dispose();
    };
    return diff;
  };
  monaco.languages.setMonarchTokensProvider('python', PYTHON_GRAMMAR);
  monaco.languages.setLanguageConfiguration('python', {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string', 'comment'] }],
    onEnterRules: [{ beforeText: /:\s*(#.*)?$/, action: { indentAction: monaco.languages.IndentAction.Indent } }],
    indentationRules: { increaseIndentPattern: /^\s*.*:\s*(#.*)?$/, decreaseIndentPattern: /^\s*(return|pass|break|continue|raise)\b.*$/ },
  });
  // PyCharm pairs a bracket only where it starts code: not in a string literal or a comment, except in an f-string,
  // where `{` opens a replacement field and the field is code. Monaco's notIn judges by the character before the caret,
  // which would also stop `"abc"[` and every f-string `{` from pairing, so each typed bracket is judged here by the
  // token it lands in, and auto-closing is off for that typing when it lands in text. Monaco closes the brackets of text
  // typed at once (an IME commit) one character at a time, so each bracket in it is judged, against the line as it
  // will read.
  const COMMENT = 1;
  const STRING = 2;
  const OPENERS = new Set(['(', '[', '{']);
  // Whether the bracket at `offset` of the line `text` (tokenized as `tokens`) is in a string literal or comment.
  function bracketInText(text, tokens, offset) {
    let i = tokens.findTokenIndexAtOffset(offset);
    const type = tokens.getStandardTokenType(i);
    if (type !== STRING) return type === COMMENT;
    // The string from its prefix. One continued from an earlier line counts as plain text.
    while (i > 0 && tokens.getStandardTokenType(i - 1) === STRING) i--;
    const before = text.slice(tokens.getStartOffset(i), offset);
    const fstring = /^[rR]?[fF][rR]?("""|'''|"|')/.exec(before);
    if (!fstring) return true;
    if (text[offset] === '{') return false;
    let depth = 0;
    for (const [m] of before.slice(fstring[0].length).matchAll(/\{\{|\}\}|[{}]/g)) if (m.length === 1) depth = Math.max(0, depth + (m === '{' ? 1 : -1));
    return depth === 0;
  }
  function typedBracketInText(model, selections, typed) {
    if (/[\r\n]/.test(typed) || ![...typed].some((c) => OPENERS.has(c))) return false;
    return selections.some((s) => {
      const { lineNumber, column } = s.getPosition();
      if (!s.isEmpty() || !model.tokenization.isCheapToTokenize(lineNumber)) return false;
      const line = model.getLineContent(lineNumber);
      const text = line.slice(0, column - 1) + typed + line.slice(column - 1);
      const tokens = model.tokenization.tokenizeLinesAt(lineNumber, [text])?.[0];
      if (!tokens?.getCount()) return false;
      for (let k = 0; k < typed.length; k++) if (OPENERS.has(typed[k]) && bracketInText(text, tokens, column - 1 + k)) return true;
      return false;
    });
  }
  monaco.editor.onDidCreateEditor((ed) => {
    let restore;
    ed.onWillType((typed) => {
      const model = ed.getModel();
      if (model?.getLanguageId() !== 'python' || !typedBracketInText(model, ed.getSelections(), typed)) return;
      restore = ed.getRawOptions().autoClosingBrackets ?? 'languageDefined';
      ed.updateOptions({ autoClosingBrackets: 'never' });
    });
    ed.onDidType(() => {
      if (restore === undefined) return;
      ed.updateOptions({ autoClosingBrackets: restore });
      restore = undefined;
    });
  });
  monaco.languages.registerCompletionItemProvider('python', { provideCompletionItems: pythonBasicCompletions(monaco) });
  monaco.editor.defineTheme('pycharm-dark', PYCHARM_DARK);

  ide.initEditors({
    theme: 'pycharm-dark',
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 14,
    lineHeight: 22,
    minimap: { enabled: false },
    automaticLayout: true,
    tabSize: 4,
    insertSpaces: true,
    rulers: [120],
    glyphMargin: true,
    scrollBeyondLastLine: false,
    cursorBlinking: 'solid',
    bracketPairColorization: { enabled: false },
    fixedOverflowWidgets: true,
  });

  performance.mark('pyide:monaco');
  await loadFeatures();
  performance.mark('pyide:features');
  ide.emit('ready');
  if (ide.detached) {
    await ide.initDetachedWindow();
    window.__ideReady = true;
    return;
  }

  const params = new URLSearchParams(location.search);
  const last = params.get('open') || (() => { try { return localStorage.getItem('lastProject'); } catch { return null; } })();
  // A last project on a network share that does not answer (~20 s to fail) leaves the welcome screen up after 3 s;
  // Recent Projects opens it once the share is back.
  const reachable = (p) => Promise.race([ide.api.exists(p), new Promise((r) => { setTimeout(r, 3000, false); })]);
  if (last && await reachable(last)) await ide.openProject(last);
  else await ide.reloadInterpreters();
  if (!ide.root) document.body.classList.add('no-project');
  if (params.get('file') && ide.root) await ide.openFile(params.get('file'));
  performance.mark('pyide:ready');
  window.__ideReady = true;
}));
