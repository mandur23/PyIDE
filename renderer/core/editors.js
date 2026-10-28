// Editor area: documents, editor groups (split panes) with their tabs, file viewers, and detached windows.
//
// A document (one per file) owns the Monaco model, its saved version and its encoding. A group is one pane with a
// tab bar and its own Monaco editor; the same document can be open in several groups (they share the model, so
// edits show everywhere). Groups are arranged in a binary split tree. `ide.editor` is the active group's editor.
(() => {
  const { $, el, basename, dirname, samePath, isUnder, pathKey: key } = ide.util;

  const LANG_BY_EXT = { py: 'python', pyw: 'python', pyi: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', json: 'json', jsonl: 'json', md: 'markdown', html: 'html', htm: 'html', css: 'css', yml: 'yaml',
    yaml: 'yaml', toml: 'ini', cfg: 'ini', ini: 'ini', xml: 'xml', sh: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell',
    sql: 'sql', txt: 'plaintext', log: 'plaintext', java: 'java', kt: 'kotlin', lua: 'lua', luau: 'lua', cs: 'csharp',
    c: 'c', cpp: 'cpp', h: 'cpp', go: 'go', rs: 'rust', jsp: 'html', fxml: 'xml', dockerfile: 'dockerfile' };
  const languageFor = (p) => LANG_BY_EXT[p.split('.').pop().toLowerCase()] || 'plaintext';

  const docs = new Map(); // path key -> {path, model, savedVersion, encoding}
  const groups = [];
  let layout = null; // {kind: 'leaf', group} | {kind: 'split', dir: 'row'|'column', a, b, ratio}
  let activeGroup = null;
  let groupSeq = 0;
  const viewers = [];
  const editorHooks = new Set();
  const embedded = new Set(); // editors created by viewers through ide.createEditor
  const closedTabs = [];
  const mru = []; // most recently activated tabs, newest first
  let editorOptions = {};
  // A detached window always has the main window as a peer, also before main's first window:peers arrives.
  let peers = ide.detached ? 2 : 1;
  let applyingRemote = false;

  const settingOn = (k, d) => ide.settings.get(k, d);

  // ---------- line separators ----------
  // A document keeps its file's line separator (doc.lineSeparator: '\n', '\r\n' or '\r'), as PyCharm does: the most
  // frequent one in the file (doc.mixedSeparators when there are several), or the new-file setting for a file without
  // any. Monaco knows only LF and CRLF, so the model holds CRLF for a CR file and the text is turned back on save.
  const NEW_FILE_SEPARATOR = { lf: '\n', crlf: '\r\n' };
  const newFileSeparator = () => NEW_FILE_SEPARATOR[settingOn('editor.lineSeparator', 'system')]
    || (/Win/i.test(navigator.platform) ? '\r\n' : '\n');
  function detectSeparator(text) {
    let crlf = 0, lf = 0, cr = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 13) { if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++; } else if (c === 10) lf++;
    }
    const kinds = [['\n', lf], ['\r\n', crlf], ['\r', cr]].filter(([, n]) => n);
    if (!kinds.length) return { sep: newFileSeparator(), mixed: false };
    kinds.sort((a, b) => b[1] - a[1]);
    return { sep: kinds[0][0], mixed: kinds.length > 1 };
  }
  // Makes the model use the separator found in `text` (setEOL is not an undo step). -> true when the model changed.
  // lineSeparatorChanged(doc) tells the status bar widget (line-separators plugin).
  function adoptSeparator(doc, text) {
    const { sep, mixed } = detectSeparator(text);
    Object.assign(doc, { lineSeparator: sep, mixedSeparators: mixed });
    const eol = sep === '\n' ? '\n' : '\r\n';
    const changed = doc.model.getEOL() !== eol;
    if (changed) doc.model.setEOL(eol === '\n' ? ide.monaco.editor.EndOfLineSequence.LF : ide.monaco.editor.EndOfLineSequence.CRLF);
    ide.emit('lineSeparatorChanged', doc);
    return changed;
  }
  // The text written to disk: the model's, with a CR file's separators turned back from CRLF.
  const diskText = (doc) => (doc.lineSeparator === '\r' ? doc.model.getValue().replace(/\r\n/g, '\r') : doc.model.getValue());
  ide.lineSeparators = {
    detect: detectSeparator,
    newFile: newFileSeparator,
    // Text for a new file (New Python File, file templates) with the new-file separator.
    forNewFile: (text) => String(text).replace(/\r\n|\r|\n/g, newFileSeparator()),
    diskText,
  };

  // ---------- documents ----------
  // asText (Open as Text): a file that looks binary is read as text all the same, in the encoding detected.
  async function loadDoc(path, { asText } = {}) {
    const existing = docs.get(key(path));
    if (existing) return existing;
    // The folder's case sensitivity is known before the document is keyed (a.py and A.py may be two files).
    let [r] = await Promise.all([ide.api.invoke('fs:readText', path), ide.learnPathCase(dirname(path))]);
    if (r.binary && asText) r = { ...(await ide.api.invoke('fs:decode', path, 'auto')), forcedText: true };
    if (r.binary || r.tooLarge) return { unsupported: r };
    const again = docs.get(key(path));
    if (again) return again;
    const uri = ide.monaco.Uri.file(path);
    const preview = adoptPreview(uri, r.text);
    const model = preview?.model || ide.monaco.editor.getModel(uri) || ide.monaco.editor.createModel(r.text, languageFor(path), uri);
    // fresh: fileOpened is announced once the first tab for it exists. diskHash fingerprints the text last read from
    // or written to the file, so auto save can tell when the file changed underneath.
    // encodingPinned: the user chose the encoding (Reload in, Convert to, Open as Text), so a reload decodes the file
    // in it instead of detecting one again.
    const doc = { path, model, savedVersion: preview ? preview.savedVersion : model.getAlternativeVersionId(), encoding: r.encoding, encodingPinned: !!r.forcedText, fresh: true, diskHash: textHash(r.text), changed: [], forcedText: !!r.forcedText, sync: newSync() };
    const clean = doc.savedVersion === model.getAlternativeVersionId();
    if (adoptSeparator(doc, r.text) && clean) doc.savedVersion = model.getAlternativeVersionId();
    docs.set(key(path), doc);
    let eol = model.getEOL();
    model.onDidChangeContent((e) => {
      const eolBefore = eol;
      eol = e.eol;
      // The tab bars change only when the modified mark does, not on every keystroke.
      if (docDirty(doc) !== doc.shownDirty) scheduleRender(); else reportDirty();
      markChanged(doc, e);
      if (!applyingRemote) localEdit(doc, e, eolBefore);
    });
    doc.sync.joining = lfText(model.getValue());
    ide.api.send('doc:join', { path });
    return doc;
  }

  // ---------- preview models ----------
  // Monaco's Ctrl+hover preview and peek views open a definition or usage through its model service, which only knows
  // models that exist ("Model not found" otherwise). A target file with no tab gets a preview model read from disk;
  // it is disposed once no editor (a peek view) has shown it for a while, or adopted by loadDoc when a tab opens it.
  const previews = new Map(); // uri string -> {model, timer, version}
  const PREVIEW_TTL = 120000;
  function expirePreview(uri) {
    const p = previews.get(uri);
    if (!p) return;
    if (p.model.isAttachedToEditor()) { p.timer = setTimeout(() => expirePreview(uri), PREVIEW_TTL); return; }
    previews.delete(uri);
    if (!p.model.isDisposed()) p.model.dispose();
  }
  ide.previewModel = async (path) => {
    const uri = ide.monaco.Uri.file(path);
    const id = uri.toString();
    const live = ide.monaco.editor.getModel(uri);
    if (live) {
      const p = previews.get(id);
      if (p) { clearTimeout(p.timer); p.timer = setTimeout(() => expirePreview(id), PREVIEW_TTL); }
      return live;
    }
    let r;
    try { r = await ide.api.invoke('fs:readText', path); } catch { return null; }
    if (!r || r.binary || r.tooLarge || typeof r.text !== 'string') return null;
    const raced = ide.monaco.editor.getModel(uri);
    if (raced) return raced;
    const model = ide.monaco.editor.createModel(r.text, languageFor(path), uri);
    previews.set(id, { model, version: model.getAlternativeVersionId(), timer: setTimeout(() => expirePreview(id), PREVIEW_TTL) });
    return model;
  };
  // A tab takes over a preview model: unedited, it is brought up to the disk text; edited in a peek view, it keeps
  // those edits as unsaved changes.
  function adoptPreview(uri, text) {
    const p = previews.get(uri.toString());
    if (!p) return null;
    previews.delete(uri.toString());
    clearTimeout(p.timer);
    if (p.model.isDisposed()) return null;
    const edited = p.model.getAlternativeVersionId() !== p.version;
    if (!edited && p.model.getValue() !== text) p.model.setValue(text);
    return { model: p.model, savedVersion: edited ? p.version : p.model.getAlternativeVersionId() };
  }

  // The file's text in the document's own encoding, to tell whether the file changed since PyIDE read or wrote it.
  // Detecting the encoding again could decode the same bytes differently (after Reload in another encoding, or BOM-less
  // UTF-16 that is mostly Korean, which detection takes for binary) and report a change that is not there.
  const readDisk = (doc) => ide.api.invoke('fs:decode', doc.path, doc.encoding);
  // The file's text for a reload: in the encoding the user chose, else detected again, since a program outside PyIDE
  // may have re-encoded the file.
  const readForReload = (doc) => (doc.encodingPinned ? readDisk(doc) : ide.api.invoke('fs:readText', doc.path));
  const docDirty = (doc) => !!doc && !doc.model.isDisposed() && doc.model.getAlternativeVersionId() !== doc.savedVersion;
  const tabsOfDoc = (doc) => groups.flatMap((g) => g.tabs.filter((t) => t.doc === doc));
  const firstTabFor = (doc) => tabsOfDoc(doc)[0] || null;

  function releaseDoc(doc) {
    if (tabsOfDoc(doc).length) return;
    docs.delete(key(doc.path));
    ide.api.send('doc:leave', { path: doc.path });
    doc.model.dispose();
    ide.emit('fileClosed', doc.path);
  }

  const textHash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `${s.length}:${h >>> 0}`;
  };

  // Lines edited since the last save, kept as whole-line decorations so they move with the text.
  function markChanged(doc, e) {
    const m = doc.model;
    if (e.isFlush) return;
    const marks = e.changes.map((c) => {
      const start = Math.min(c.range.startLineNumber, m.getLineCount());
      const end = Math.min(start + (c.text.match(/\n/g)?.length || 0), m.getLineCount());
      return { range: new ide.monaco.Range(start, 1, end, m.getLineMaxColumn(end)), options: { isWholeLine: true } };
    });
    if (doc.changed.length > 200) doc.changed = m.deltaDecorations(doc.changed, lineRanges(changedLines(doc)));
    doc.changed = doc.changed.concat(m.deltaDecorations([], marks));
  }
  function changedLines(doc) {
    const lines = new Set();
    for (const id of doc.changed) {
      const r = doc.model.getDecorationRange(id);
      if (r) for (let l = r.startLineNumber; l <= r.endLineNumber; l++) lines.add(l);
    }
    return lines;
  }
  function lineRanges(lines) {
    const out = [];
    for (const l of [...lines].sort((a, b) => a - b)) {
      const last = out[out.length - 1];
      if (last && last.range.endLineNumber === l - 1) last.range = last.range.setEndPosition(l, 1);
      else out.push({ range: new ide.monaco.Range(l, 1, l, 1), options: { isWholeLine: true } });
    }
    return out;
  }
  const clearChanged = (doc) => { if (!doc.model.isDisposed()) doc.changed = doc.model.deltaDecorations(doc.changed, []); };

  // ---------- multi-window document sync ----------
  // A document open in several windows is one sequence of edits. While it is shared, every window sends its edits to the
  // main process (main/windows.js) with the revision they were made on; the main process puts them in one order and
  // refuses an edit made on an older revision. A window applies the other windows' edits shifted past its own
  // unconfirmed ones, and sends a refused edit again shifted past the ones it had not seen (operational
  // transformation), so edits typed in two windows at the same moment are all kept, in every window.
  // An op is {c: [{at, del, ins}], eol?}: changes sorted by `at`, positions in the text before the op; eol when the op
  // switched the model's line separator. Positions and text count every line break as one '\n', whatever the
  // separator, so a conversion ({c: [], eol}) moves nothing and the edits other windows made beside it keep their place.
  // joining: this window's text (as LF) when it asked to join; what it types until the shared text arrives is kept in
  // `buffer` and moved past the difference then.
  const newSync = () => ({ rev: 0, shared: false, sent: null, buffer: [] });
  const lfText = (s) => s.replace(/\r\n?/g, '\n');
  function opOf(e, eolBefore) {
    if (e.isEolChange) return { c: [], eol: e.eol };
    const n = eolBefore.length - 1;
    const c = e.changes.map((x) => ({
      at: x.rangeOffset - (x.range.startLineNumber - 1) * n,
      del: x.rangeLength - (x.range.endLineNumber - x.range.startLineNumber) * n,
      ins: lfText(x.text),
    })).sort((x, y) => x.at - y.at);
    return e.eol !== eolBefore ? { c, eol: e.eol } : { c };
  }
  // The model position of an op position.
  function positionAt(m, at) {
    if (m.getEOL() === '\n') return m.getPositionAt(at);
    const lineStart = (l) => m.getOffsetAt({ lineNumber: l, column: 1 }) - (l - 1);
    let lo = 1;
    let hi = m.getLineCount();
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStart(mid) <= at) lo = mid; else hi = mid - 1;
    }
    return { lineNumber: lo, column: Math.min(at - lineStart(lo) + 1, m.getLineMaxColumn(lo)) };
  }
  // One change that turns text a into text b (both as LF).
  function diffOp(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    return { c: a === b ? [] : [{ at: start, del: endA - start, ins: b.slice(start, endB) }] };
  }

  // `pos` in the text after `op`. after: a point where op inserted text goes behind that text.
  // A point inside a range op replaced lands after op's new text, whatever `after`: the windows must agree, and the
  // replacing window puts its text at the start of the range, before what the other window typed inside it. A point at
  // the start of a replaced range is a tie with op's text and follows `after`.
  function mapPoint(pos, op, after) {
    let shift = 0;
    for (const c of op.c) {
      const end = c.at + c.del;
      if (end < pos || (end === pos && (c.del > 0 || after))) { shift += c.ins.length - c.del; continue; }
      if (c.at < pos) return c.at + shift + c.ins.length;
      if (c.at === pos && after) return pos + shift + c.ins.length;
      break;
    }
    return pos + shift;
  }
  // The parts of [s, e) that `op` left in place, as [start, length] in the text after it: text another window inserted
  // inside a range this one deletes is kept.
  function survivors(s, e, op) {
    const parts = [];
    let x = s;
    for (const c of op.c) {
      if (c.at >= e) break;
      if (c.at + c.del < x) continue;
      if (c.at > x) parts.push([x, c.at]);
      x = Math.max(x, c.at + c.del);
    }
    if (x < e) parts.push([x, e]);
    return parts.map(([p, q]) => [mapPoint(p, op, true), q - p]);
  }
  // Op a made on the same text as op b, moved to apply after b. aFirst: a comes first in the shared order, so at the
  // same point a's insertion goes before b's.
  function over(a, b, aFirst) {
    const out = [];
    const put = (at, del, ins) => {
      const last = out[out.length - 1];
      if (last && last.at + last.del === at) Object.assign(last, { del: last.del + del, ins: last.ins + ins });
      else out.push({ at, del, ins });
    };
    for (const c of a.c) {
      if (!c.del) { put(mapPoint(c.at, b, !aFirst), 0, c.ins); continue; }
      const parts = survivors(c.at, c.at + c.del, b);
      // The new text goes where a plain insertion at the range's start would: the shared order breaks a tie there.
      put(mapPoint(c.at, b, !aFirst), 0, c.ins);
      for (const [p, n] of parts) put(p, n, '');
    }
    return { ...a, c: out.filter((c) => c.del || c.ins) };
  }
  // Two op lists made on the same text -> [as after bs, bs after as].
  function xform(as, bs, aFirst) {
    const a = [...as];
    const b2 = bs.map((b) => {
      for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        a[i] = over(ai, b, aFirst);
        b = over(b, ai, !aFirst);
      }
      return b;
    });
    return [a, b2];
  }

  const setModelEOL = (model, eol) => model.setEOL(eol === '\n' ? ide.monaco.editor.EndOfLineSequence.LF : ide.monaco.editor.EndOfLineSequence.CRLF);
  function applyOps(doc, ops) {
    const m = doc.model;
    applyingRemote = true;
    try {
      for (const op of ops) {
        const edits = op.c.map((c) => ({ range: ide.monaco.Range.fromPositions(positionAt(m, c.at), positionAt(m, c.at + c.del)), text: c.ins }));
        if (edits.length) m.pushEditOperations([], edits, () => null);
        if (op.eol && m.getEOL() !== op.eol) setModelEOL(m, op.eol);
      }
    } finally { applyingRemote = false; }
    // A save announced by another window before its last edits arrived (see doc:saved).
    if (doc.savedText !== undefined && m.getValue() === doc.savedText) markSaved(doc, doc.savedText);
  }

  function localEdit(doc, e, eolBefore) {
    doc.savedText = undefined;
    const s = doc.sync;
    if (!s.shared && s.joining === undefined) return;
    s.buffer.push(opOf(e, eolBefore));
    flushSync(doc);
  }
  function flushSync(doc) {
    const s = doc.sync;
    if (!s.shared || s.sent || !s.buffer.length) return;
    s.sent = s.buffer;
    s.buffer = [];
    ide.api.send('doc:op', { path: doc.path, base: s.rev, ops: s.sent });
  }

  // Applies another window's text as one minimal edit so cursors and undo history survive. remote: the text is the
  // shared document's already, so it is not sent on as this window's edit.
  function applyText(doc, text, { remote = true } = {}) {
    const [c] = diffOp(doc.model.getValue(), text).c;
    if (!c) return;
    const range = ide.monaco.Range.fromPositions(doc.model.getPositionAt(c.at), doc.model.getPositionAt(c.at + c.del));
    applyingRemote = remote;
    try { doc.model.pushEditOperations([], [{ range, text: c.ins }], () => null); } finally { applyingRemote = false; }
  }

  const docAt = (path) => docs.get(key(path));
  ide.api.on('window:peers', (n) => { peers = n; });
  // Joined: alone with the document (shared false, its own text stands), or sharing it from revision `rev` on, with the
  // shared text (as LF) and line separator. What was typed meanwhile was made on this window's text when it joined:
  // moved past the difference to the shared text, it is kept and sent.
  ide.api.on('doc:synced', ({ path, rev, text, eol, shared }) => {
    const d = docAt(path);
    if (!d) return;
    const { joining, buffer } = d.sync;
    d.sync = { ...newSync(), rev, shared };
    if (text === undefined) return;
    const [[toShared], typed] = xform([diffOp(joining ?? lfText(d.model.getValue()), text)], buffer, true);
    const ownEol = typed.some((op) => op.eol);
    applyOps(d, [ownEol ? toShared : { ...toShared, eol }]);
    d.sync.buffer = typed;
    flushSync(d);
  });
  // Another window opened this document: this one hands over the text, and from now on sends its edits.
  ide.api.on('doc:share', ({ path }) => {
    const d = docAt(path);
    if (!d) return void ide.api.send('doc:leave', { path });
    Object.assign(d.sync, { shared: true, sent: null, buffer: [] });
    ide.api.send('doc:snapshot', { path, rev: d.sync.rev, text: lfText(d.model.getValue()), eol: d.model.getEOL() });
  });
  ide.api.on('doc:unshared', ({ path }) => { const d = docAt(path); if (d) d.sync = { ...newSync(), rev: d.sync.rev }; });
  ide.api.on('doc:op', ({ path, rev, ops, mine }) => {
    const d = docAt(path);
    if (!d || !d.sync.shared) return;
    const s = d.sync;
    s.rev = rev;
    if (mine) { s.sent = null; flushSync(d); return; }
    let remote = ops;
    if (s.sent) [remote, s.sent] = xform(remote, s.sent, true);
    [remote, s.buffer] = xform(remote, s.buffer, true);
    applyOps(d, remote);
  });
  // Refused (another window's edit came first, and has arrived here since): sent again on top of it.
  ide.api.on('doc:nack', ({ path }) => {
    const d = docAt(path);
    if (!d?.sync.sent) return;
    d.sync.buffer = [...d.sync.sent, ...d.sync.buffer];
    d.sync.sent = null;
    flushSync(d);
  });

  // A save (or reload) in another window. Its last edits may still be on their way: the document turns unmodified once
  // its text is the saved one.
  function markSaved(d, text) {
    d.savedText = undefined;
    d.savedVersion = d.model.getAlternativeVersionId();
    Object.assign(d, { diskHash: textHash(text), conflict: false, skipNoted: false });
    clearChanged(d);
    renderAllTabs();
  }
  ide.api.on('doc:saved', ({ path, text, encoding, encodingPinned }) => {
    const d = docAt(path);
    if (!d) return;
    if (encoding) { Object.assign(d, { encoding, encodingPinned }); updateStatus(); }
    if (d.model.getValue() === text) markSaved(d, text); else d.savedText = text;
  });
  // Tells the other windows that the document's text is now the file's (saved, reloaded, converted).
  function announceSaved(doc, text = doc.model.getValue()) {
    if (peers > 1) ide.api.send('doc:saved', { path: doc.path, text, encoding: doc.encoding, encodingPinned: doc.encodingPinned });
  }

  // ---------- tabs ----------
  function makeFileTab(doc, group) {
    return {
      kind: 'file', group, doc, pinned: false, preview: false, viewState: null,
      get path() { return doc.path; },
      get title() { return basename(doc.path); },
      get model() { return doc.model; },
      get savedVersion() { return doc.savedVersion; },
      // A plugin marking the tab saved (it just wrote or reloaded the file, e.g. a git rollback) means the editor text is
      // what is on disk; without the disk fingerprint the next save would report a false File Cache Conflict.
      set savedVersion(v) {
        doc.savedVersion = v;
        if (v === doc.model.getAlternativeVersionId()) Object.assign(doc, { diskHash: textHash(doc.model.getValue()), conflict: false, skipNoted: false });
      },
    };
  }

  const tabIcon = (t) => (t.kind === 'custom' ? el('span', 'tab-icon', t.icon) : Object.assign(ide.fileIcon(t.path), { className: 'file-icon tab-icon' }));

  function addTab(g, tab, index) {
    tab.group = g;
    const pinnedCount = g.tabs.filter((t) => t.pinned).length;
    const at = index === undefined ? g.tabs.length : Math.max(tab.pinned ? 0 : pinnedCount, Math.min(index, g.tabs.length));
    g.tabs.splice(at, 0, tab);
    enforceTabLimit(g, tab);
  }

  // PyCharm's tab limit: the least recently used unpinned, unmodified tab closes when a group overflows.
  function enforceTabLimit(g, keep) {
    const limit = Number(settingOn('editor.tabLimit', 10)) || 0;
    while (limit > 0 && g.tabs.length > limit) {
      const victim = [...g.tabs].sort((a, b) => mruRank(b) - mruRank(a))
        .find((t) => t !== keep && !t.pinned && !ide.isDirty(t));
      if (!victim) break;
      closeTabObj(victim, true);
    }
  }
  const mruRank = (t) => { const i = mru.indexOf(t); return i < 0 ? Infinity : i; };

  function activateTab(g, tab, { focus = false } = {}) {
    if (g.active && g.active !== tab && g.active.kind === 'file' && g.editor.getModel() === g.active.model) {
      g.active.viewState = g.editor.saveViewState();
    }
    g.active = tab;
    if (tab) {
      const i = mru.indexOf(tab);
      if (i >= 0) mru.splice(i, 1);
      mru.unshift(tab);
    }
    showSurface(g);
    if (tab?.kind === 'file') {
      if (g.editor.getModel() !== tab.model) g.editor.setModel(tab.model);
      if (tab.viewState) g.editor.restoreViewState(tab.viewState);
    } else g.editor.setModel(null);
    renderTabs(g);
    if (g === activeGroup) { updateStatus(); ide.emit('activeTabChanged', tab || null); }
    if (focus) focusGroup(g);
  }

  function showSurface(g) {
    const t = g.active;
    g.editorHost.classList.toggle('hidden', !t || t.kind !== 'file');
    for (const o of g.tabs) o.host?.classList.toggle('hidden', o !== t);
    g.empty.classList.toggle('hidden', !!t || ide.detached);
    if (t?.kind === 'file') g.editor.layout();
  }

  function focusGroup(g) {
    if (g.active?.kind === 'file') g.editor.focus();
    else g.active?.host?.focus?.();
  }

  function setActiveGroup(g) {
    if (!g || activeGroup === g) return;
    activeGroup = g;
    for (const o of groups) o.el.classList.toggle('active-group', o === g);
    updateStatus();
    ide.emit('activeEditorChanged', g.editor);
    ide.emit('activeTabChanged', g.active || null);
  }

  function renderTabs(g) {
    const bar = g.tabList;
    bar.replaceChildren();
    for (const t of g.tabs) {
      const node = el('div', 'tab' + (t === g.active ? ' active' : '') + (t.preview ? ' preview' : '') + (t.pinned ? ' pinned' : ''));
      // A file's tooltip is its path; a custom tab's path is an internal id (workspace:home), so it shows its title.
      node.title = /^([a-z]:[\\/]|\\\\)/i.test(t.path || '') ? t.path : t.title;
      node.draggable = true;
      node.dataset.path = t.path;
      node.appendChild(tabIcon(t));
      node.appendChild(el('span', 'name', t.title));
      const dirty = ide.isDirty(t);
      if (t.doc) t.doc.shownDirty = dirty;
      if (dirty) node.appendChild(el('span', 'dirty', '●'));
      if (t.pinned) node.appendChild(el('span', 'pin', '📌'));
      const close = el('button', 'close', '×');
      close.title = tr('Close');
      node.appendChild(close);
      node.onclick = () => { setActiveGroup(g); activateTab(g, t, { focus: true }); };
      node.ondblclick = () => { if (t.preview) { t.preview = false; renderTabs(g); } else toggleMaximizeEditor(); };
      node.onauxclick = (e) => e.button === 1 && closeTabObj(t);
      node.oncontextmenu = (e) => { e.preventDefault(); setActiveGroup(g); showTabMenu(t, e.clientX, e.clientY); };
      node.ondragstart = (e) => {
        e.dataTransfer.setData('application/x-pyide-tab', JSON.stringify({ group: g.id, path: t.path }));
        e.dataTransfer.effectAllowed = 'copyMove';
        dragging = t;
      };
      node.ondragend = () => { dragging = null; hideDropOverlay(); };
      close.onclick = (e) => { e.stopPropagation(); closeTabObj(t); };
      bar.appendChild(node);
    }
    bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderAllTabs() {
    for (const g of groups) renderTabs(g);
    reportDirty();
  }
  let renderQueued = false;
  const scheduleRender = () => {
    // Reported now, not on the next frame: a window that renders no frames (hidden, occluded) must still ask
    // before closing with unsaved changes.
    reportDirty();
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderAllTabs(); });
  };

  // The main process keeps every window's modified files, so closing the main window can ask about all of them at once.
  let lastDirty = '[]';
  function reportDirty() {
    const paths = [...docs.values()].filter(docDirty).map((d) => d.path);
    const now = JSON.stringify(paths);
    if (now !== lastDirty) { lastDirty = now; ide.api.send('window:setDirty', paths); }
  }

  // Returns true once closed; when a modified document has to ask first, a promise of whether it closed (false: the
  // user kept it). Callers that need the answer await it.
  function closeTabObj(tab, force = false, { moving = false } = {}) {
    const g = tab.group;
    if (g.tabs.indexOf(tab) < 0) return true;
    const last = tab.doc && tabsOfDoc(tab.doc).length === 1;
    if (!force && last && docDirty(tab.doc)) {
      return ide.ui.confirm(tr('{name} has unsaved changes. Close anyway?', { name: tab.title }), { ok: tr('Close') })
        .then((yes) => yes && closeTabObj(tab, true, { moving }));
    }
    const i = g.tabs.indexOf(tab);
    g.tabs.splice(i, 1);
    const m = mru.indexOf(tab);
    if (m >= 0) mru.splice(m, 1);
    if (!moving) {
      closedTabs.push({ path: tab.path, kind: tab.kind, viewer: tab.viewer?.id });
      if (closedTabs.length > 30) closedTabs.shift();
    }
    // A viewer or plugin tab that fails to clean up must not leave the tab half closed.
    if (tab.kind === 'custom') {
      safe(() => tab.dispose?.());
      safe(() => tab.onClose?.());
      tab.host.remove();
    }
    if (tab.doc) releaseDoc(tab.doc);
    else if (tab.kind === 'custom') ide.emit('fileClosed', tab.path);
    if (g.active === tab) {
      const next = mru.find((t) => t.group === g) || g.tabs[Math.min(i, g.tabs.length - 1)] || null;
      activateTab(g, next);
    } else renderTabs(g);
    if (!g.tabs.length) {
      if (groups.length > 1) removeGroup(g);
      else if (ide.detached) ide.api.invoke('window:close');
    }
    reportDirty();
    return true;
  }

  // ---------- groups and split layout ----------
  function createGroup() {
    const g = { id: ++groupSeq, tabs: [], active: null };
    g.el = el('div', 'editor-group');
    g.el.dataset.group = g.id;
    const bar = el('div', 'group-tabs');
    g.tabList = el('div', 'tab-list');
    // A tab bar that gets narrower (a tool window opened beside it, a smaller window) keeps the active tab in view.
    g.tabListSize = ide.util.observeSize(g.tabList, () => g.tabList.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    const actions = el('div', 'group-actions');
    const splitBtn = el('button', null, '◫');
    ide.keymap.tooltip(splitBtn, tr('Split Right'), 'SplitVertically');
    splitBtn.onclick = () => splitGroup(g, 'right', g.active, { clone: true });
    const more = el('button', null, '⋮');
    more.title = tr('More');
    more.onclick = (e) => { const r = more.getBoundingClientRect(); showGroupMenu(g, r.left, r.bottom); e.stopPropagation(); };
    actions.append(splitBtn, more);
    bar.append(g.tabList, actions);
    g.body = el('div', 'group-body');
    g.editorHost = el('div', 'editor-host');
    g.customHost = el('div', 'custom-host');
    g.empty = el('div', 'group-empty');
    // The shortcuts follow the keymap (RecentFiles and Search Everywhere's own action come from plugins, later); a row
    // whose action has no shortcut (unbound, or its plugin disabled) is hidden.
    for (const [label, id] of [[tr('Search Everywhere'), 'SearchEverywhere'], [tr('Go to File'), 'GotoFile'], [tr('Recent Files'), 'RecentFiles'], [tr('Split Right'), 'SplitVertically'], [tr('Drop files here to open them')]]) {
      const row = el('div', 'empty-row');
      row.append(el('span', null, label));
      if (id) {
        row.dataset.action = id;
        row.appendChild(ide.keymap.text(el('kbd'), () => { const keys = ide.keymap.hint(id); row.style.display = keys ? '' : 'none'; return keys; }));
      }
      g.empty.appendChild(row);
    }
    if (!groups.length) { g.editorHost.id = 'editor'; g.customHost.id = 'customHost'; g.tabList.id = 'tabs'; }
    g.body.append(g.editorHost, g.customHost, g.empty);
    g.el.append(bar, g.body);
    g.editor = ide.monaco.editor.create(g.editorHost, { ...editorOptions, model: null });
    g.editor.onDidFocusEditorWidget(() => setActiveGroup(g));
    g.el.addEventListener('mousedown', () => setActiveGroup(g), true);
    g.editor.onDidChangeCursorPosition((e) => { if (g === activeGroup) $('statusPos').textContent = `${e.position.lineNumber}:${e.position.column}`; });
    g.editor.onDidChangeModelContent(() => {
      const t = g.active;
      if (t?.preview) { t.preview = false; renderTabs(g); }
    });
    wireDrop(g);
    groups.push(g);
    ownActions(g.editor);
    for (const fn of editorHooks) safe(() => fn(g.editor));
    ide.emit('editorCreated', g.editor);
    return g;
  }
  // Monaco leaves an editor's addAction/addCommand registrations (a global command, keybinding and menu item whose
  // handler holds the editor) in place when the editor is disposed, so every embedded editor that plugins added
  // actions to stayed in memory with its DOM: one per Markdown or HTML file opened, per notebook cell. They now go
  // with the editor.
  // The context menu actions are remembered for the IDE's editor context menu (ide.ui.editorContextMenu in mainmenu.js),
  // which replaces Monaco's.
  const menuActions = new WeakMap(); // editor -> [{id, group, order}]
  function ownActions(ed) {
    const addAction = ed.addAction.bind(ed);
    const listed = [];
    menuActions.set(ed, listed);
    ed.addAction = (...args) => {
      const reg = addAction(...args);
      const d = args[0];
      if (d?.contextMenuGroupId) listed.push({ id: d.id, group: d.contextMenuGroupId, order: d.contextMenuOrder });
      if (reg?.dispose) ed.onDidDispose(() => reg.dispose());
      return reg;
    };
    ed.updateOptions({ contextmenu: false });
    // A right click outside the selection moves the caret there and focuses the editor before the items are chosen
    // (Run Context Configuration, the actions' `when`); Monaco's context menu controller, even with the menu off, does
    // the same, but only after this listener.
    // Only the text area has the menu, as with Monaco's: the gutter's right click is the breakpoint's (debugger).
    const { CONTENT_TEXT, CONTENT_EMPTY } = ide.monaco.editor.MouseTargetType;
    ed.onContextMenu((e) => {
      if (e.target.type !== CONTENT_TEXT && e.target.type !== CONTENT_EMPTY) return;
      e.event.preventDefault();
      const pos = e.target.position;
      const sel = ed.getSelection();
      if (pos && !(sel && !sel.isEmpty() && sel.containsPosition(pos))) ed.setPosition(pos);
      ed.focus();
      ide.ui.editorContextMenu?.(ed, e.event.browserEvent.clientX, e.event.browserEvent.clientY);
    });
    // The Menu key and Shift+F10 send a contextmenu event of no right button, placed at the start of the caret's line,
    // where that controller would move the caret. Monaco never gets it, and the menu opens below the caret.
    ed.getContainerDomNode().addEventListener('contextmenu', (e) => {
      if (e.button === 2 || !ed.getDomNode()?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const at = ed.getScrolledVisiblePosition(ed.getPosition());
      const r = ed.getDomNode().getBoundingClientRect();
      ide.ui.editorContextMenu?.(ed, r.left + (at?.left ?? 0), r.top + (at?.top ?? 0) + (at?.height ?? 0));
    }, true);
  }
  ide.editorMenuActions = (ed) => [...(menuActions.get(ed) || [])];
  const safe = (fn) => { try { fn(); } catch (err) { console.error(err); } };

  function findParent(node, target, parent = null) {
    if (node === target) return { parent };
    if (node.kind !== 'split') return null;
    return findParent(node.a, target, node) || findParent(node.b, target, node);
  }
  const leafOf = (node, g) => (node.kind === 'leaf' ? (node.group === g ? node : null) : leafOf(node.a, g) || leafOf(node.b, g));
  const firstGroup = (node) => (node.kind === 'leaf' ? node.group : firstGroup(node.a));

  function renderLayout() {
    const area = $('editorGroups');
    const build = (node) => {
      if (node.kind === 'leaf') { node.group.el.style.flex = ''; return node.group.el; }
      const box = el('div', `split split-${node.dir}`);
      const a = build(node.a);
      const b = build(node.b);
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
      const handle = el('div', 'split-handle');
      handle.onmousedown = (down) => {
        down.preventDefault();
        const r = box.getBoundingClientRect();
        const move = (e) => {
          const pos = node.dir === 'row' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
          node.ratio = Math.min(0.9, Math.max(0.1, pos));
          a.style.flex = `${node.ratio} 1 0`;
          b.style.flex = `${1 - node.ratio} 1 0`;
        };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      };
      handle.ondblclick = () => { node.ratio = 0.5; renderLayout(); };
      box.append(a, handle, b);
      return box;
    };
    area.replaceChildren(build(layout));
    for (const g of groups) g.editor.layout();
  }

  // side: 'right' | 'left' | 'down' | 'up'. With a tab: clone it into the new group, or move it when clone is false.
  function splitGroup(g, side, tab, { clone = true } = {}) {
    const ng = createGroup();
    const leaf = leafOf(layout, g);
    const newLeaf = { kind: 'leaf', group: ng };
    const before = side === 'left' || side === 'up';
    const split = { kind: 'split', dir: side === 'left' || side === 'right' ? 'row' : 'column', ratio: 0.5,
      a: before ? newLeaf : { ...leaf }, b: before ? { ...leaf } : newLeaf };
    Object.keys(leaf).forEach((k) => delete leaf[k]);
    Object.assign(leaf, split);
    renderLayout();
    if (tab) placeTab(tab, ng, { clone });
    else activateTab(ng, null);
    setActiveGroup(ng);
    focusGroup(ng);
    return ng;
  }

  function removeGroup(g) {
    const leaf = leafOf(layout, g);
    const { parent } = findParent(layout, leaf) || {};
    if (!parent) return;
    const sibling = parent.a === leaf ? parent.b : parent.a;
    Object.keys(parent).forEach((k) => delete parent[k]);
    Object.assign(parent, sibling);
    groups.splice(groups.indexOf(g), 1);
    g.tabListSize?.disconnect();
    g.editor.dispose();
    g.el.remove();
    // The first group keeps the stable ids (#editor, #customHost, #tabs) that plugins and tests rely on.
    if (g.editorHost.id === 'editor' && groups[0]) {
      groups[0].editorHost.id = 'editor';
      groups[0].customHost.id = 'customHost';
      groups[0].tabList.id = 'tabs';
    }
    renderLayout();
    if (activeGroup === g) { activeGroup = null; setActiveGroup(firstGroup(layout)); }
  }

  // Moves or clones a tab into a group. Custom tabs (viewers, diffs) always move.
  function placeTab(tab, target, { clone = false, index } = {}) {
    if (tab.group === target) {
      if (index !== undefined) {
        const from = target.tabs.indexOf(tab);
        target.tabs.splice(from, 1);
        target.tabs.splice(index > from ? index - 1 : index, 0, tab);
      }
      activateTab(target, tab, { focus: true });
      return tab;
    }
    if (tab.kind === 'file') {
      let t = target.tabs.find((o) => o.doc === tab.doc);
      if (!t) {
        t = makeFileTab(tab.doc, target);
        t.viewState = tab.group.editor.getModel() === tab.model ? tab.group.editor.saveViewState() : tab.viewState;
        t.pinned = tab.pinned;
        addTab(target, t, index);
      }
      if (!clone) closeTabObj(tab, true, { moving: true });
      setActiveGroup(target);
      activateTab(target, t, { focus: true });
      return t;
    }
    const src = tab.group;
    src.tabs.splice(src.tabs.indexOf(tab), 1);
    target.customHost.appendChild(tab.host);
    addTab(target, tab, index);
    if (src.active === tab) activateTab(src, mru.find((t) => t.group === src) || src.tabs[0] || null);
    else renderTabs(src);
    setActiveGroup(target);
    activateTab(target, tab, { focus: true });
    if (!src.tabs.length && groups.length > 1) removeGroup(src);
    return tab;
  }

  function oppositeGroup(g) {
    if (groups.length < 2) return null;
    return groups[(groups.indexOf(g) + 1) % groups.length];
  }

  function unsplitAll() {
    const keep = activeGroup;
    for (const g of [...groups]) {
      if (g === keep) continue;
      for (const t of [...g.tabs]) placeTab(t, keep, { clone: false });
    }
  }

  // ---------- drag and drop ----------
  let dragging = null;
  const overlay = el('div', 'drop-overlay hidden');
  document.body.appendChild(overlay);
  const hideDropOverlay = () => overlay.classList.add('hidden');

  function dropZone(g, e) {
    const r = g.body.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edge = 0.22;
    if (x < edge) return 'left';
    if (x > 1 - edge) return 'right';
    if (y < edge) return 'up';
    if (y > 1 - edge) return 'down';
    return 'center';
  }

  function showDropOverlay(g, zone) {
    const r = g.body.getBoundingClientRect();
    const box = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (zone === 'left' || zone === 'right') box.width = r.width / 2;
    if (zone === 'right') box.left = r.left + r.width / 2;
    if (zone === 'up' || zone === 'down') box.height = r.height / 2;
    if (zone === 'down') box.top = r.top + r.height / 2;
    Object.assign(overlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    overlay.classList.remove('hidden');
  }

  const hasTabData = (e) => [...e.dataTransfer.types].includes('application/x-pyide-tab');
  const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
  // A row dragged from the project tree carries its path.
  const treePath = (e) => ([...e.dataTransfer.types].includes(ide.TREE_PATH_TYPE) ? e.dataTransfer.getData(ide.TREE_PATH_TYPE) || true : null);

  // The pane's own drags are taken in the capture phase, before Monaco's drop-into-editor sees them over the text. Files
  // from Explorer are always a copy: a drag source that allows only copying refuses 'move', and the drop never comes.
  function wireDrop(g) {
    g.body.addEventListener('dragover', (e) => {
      if (!hasTabData(e) && !hasFiles(e) && !treePath(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = hasFiles(e) || e.ctrlKey ? 'copy' : 'move';
      showDropOverlay(g, dropZone(g, e));
    }, true);
    g.body.addEventListener('dragleave', (e) => { if (!g.body.contains(e.relatedTarget)) hideDropOverlay(); });
    g.body.addEventListener('drop', (e) => {
      if (!hasTabData(e) && !hasFiles(e) && !treePath(e)) return;
      e.preventDefault();
      e.stopPropagation();
      hideDropOverlay();
      const zone = dropZone(g, e);
      if (hasFiles(e)) return openDroppedFiles(e, zone === 'center' ? g : splitGroup(g, zone, null));
      if (treePath(e)) return ide.openFile(treePath(e), { group: zone === 'center' ? g : splitGroup(g, zone, null) });
      const tab = dragging;
      if (!tab) return;
      if (zone === 'center') placeTab(tab, g, { clone: e.ctrlKey });
      else if (tab.group === g && g.tabs.length === 1) return;
      else {
        const ng = splitGroup(g, zone, null);
        placeTab(tab, ng, { clone: e.ctrlKey });
      }
    }, true);
    g.tabList.addEventListener('dragover', (e) => {
      if (!hasTabData(e) && !hasFiles(e) && !treePath(e)) return;
      e.preventDefault();
      hideDropOverlay();
      for (const n of g.tabList.children) n.classList.remove('drop-before', 'drop-after');
      const target = e.target.closest('.tab');
      if (target) target.classList.add(e.clientX < target.getBoundingClientRect().left + target.offsetWidth / 2 ? 'drop-before' : 'drop-after');
    });
    g.tabList.addEventListener('dragleave', () => { for (const n of g.tabList.children) n.classList.remove('drop-before', 'drop-after'); });
    g.tabList.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      for (const n of g.tabList.children) n.classList.remove('drop-before', 'drop-after');
      if (hasFiles(e)) return openDroppedFiles(e, g);
      if (treePath(e)) return ide.openFile(treePath(e), { group: g });
      const tab = dragging;
      if (!tab) return;
      const target = e.target.closest('.tab');
      let index = g.tabs.length;
      if (target) {
        const i = [...g.tabList.children].indexOf(target);
        index = e.clientX < target.getBoundingClientRect().left + target.offsetWidth / 2 ? i : i + 1;
      }
      placeTab(tab, g, { clone: e.ctrlKey, index });
    });
  }

  // Files and folders dragged in from Explorer: a folder opens as the project, files open in the target group. Rows
  // dragged from the project tree arrive the same way (a system drag); their folders are not a project to open.
  async function openDroppedFiles(e, group) {
    const paths = [...e.dataTransfer.files].map((f) => ide.api.pathForFile(f)).filter(Boolean);
    const fromTree = !!ide.treeDrag && paths.every((p) => ide.treeDrag.paths.some((q) => ide.util.samePath(p, q)));
    if (fromTree) ide.treeDrag = null;
    for (const p of paths) {
      const st = await ide.api.stat(p);
      if (st?.isDirectory && fromTree) continue;
      if (st?.isDirectory && !ide.detached) { await ide.openProject(p); return; }
      if (st && !st.isDirectory) await ide.openFile(p, { group });
    }
  }
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideDropOverlay();
    openDroppedFiles(e, activeGroup);
  });

  // ---------- public API ----------
  delete ide.editor;
  Object.defineProperty(ide, 'editor', { get: () => activeGroup?.editor || null, configurable: true });
  delete ide.tabs;
  // One entry per open document (the copy in the active group when it is split) plus custom tabs.
  Object.defineProperty(ide, 'tabs', { get: () => {
    const seen = new Set();
    const out = [];
    const ordered = activeGroup ? [activeGroup, ...groups.filter((g) => g !== activeGroup)] : groups;
    for (const g of ordered) for (const t of g.tabs) {
      const k = t.doc || t;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }, configurable: true });
  delete ide.active;
  Object.defineProperty(ide, 'active', { get: () => activeGroup?.active?.path || null, configurable: true });

  ide.editors = () => groups.map((g) => g.editor);
  ide.groups = () => groups.map((g) => ({ id: g.id, tabs: [...g.tabs], active: g.active, editor: g.editor, el: g.el }));
  ide.activeGroup = () => activeGroup;
  // Runs fn for every editor, now and when new split panes are created. Returns an unsubscribe function.
  ide.onEditor = (fn) => {
    editorHooks.add(fn);
    for (const g of groups) safe(() => fn(g.editor));
    return () => editorHooks.delete(fn);
  };
  // Options that apply to every editor, current and future (font, wrapping, rulers...).
  ide.updateEditorOptions = ({ theme, ...opts }) => {
    if (theme) ide.monaco.editor.setTheme(theme);
    editorOptions = { ...editorOptions, ...opts };
    for (const g of groups) g.editor.updateOptions(opts);
    for (const ed of embedded) ed.updateOptions(opts);
  };
  ide.editorOptions = () => ({ ...editorOptions });
  // An extra Monaco editor (inside a viewer) that behaves like a group editor for plugins.
  ide.createEditor = (host, opts = {}) => {
    const ed = ide.monaco.editor.create(host, { ...editorOptions, ...opts });
    embedded.add(ed);
    ed.onDidDispose(() => embedded.delete(ed));
    ownActions(ed);
    for (const fn of editorHooks) safe(() => fn(ed));
    ide.emit('editorCreated', ed);
    return ed;
  };

  ide.findTab = (path) => {
    if (!path) return null;
    const ordered = activeGroup ? [activeGroup, ...groups.filter((g) => g !== activeGroup)] : groups;
    for (const g of ordered) for (const t of g.tabs) if (samePath(t.path, path)) return t;
    return null;
  };
  ide.activeTab = () => activeGroup?.active || null;
  ide.isDirty = (t) => !!t?.doc && docDirty(t.doc);
  ide.getDocument = (path) => docs.get(key(path)) || null;
  // The document for `path`, loaded without opening a tab -> doc | {unsupported: {binary | tooLarge, size}}. A loaded
  // document is released when its last tab closes, so hand it to ide.openCustomTab({doc}) (or open the file) at once.
  ide.loadDocument = (path) => loadDoc(path);
  // Releases a document from ide.loadDocument that no tab took after all (a no-op while a tab holds it).
  ide.releaseDocument = (doc) => { if (doc?.model && !doc.model.isDisposed() && docs.get(key(doc.path)) === doc) releaseDoc(doc); };

  function resolveGroup(target) {
    if (target && typeof target === 'object') return groups.includes(target) ? target : activeGroup;
    if (target === 'right' || target === 'down') {
      const other = oppositeGroup(activeGroup);
      return other && target === 'right' ? other : splitGroup(activeGroup, target, null);
    }
    return activeGroup;
  }

  // File viewers take over files a text editor cannot show (images, media, arrays) or add a richer view.
  // {id, title, icon, match(path) -> bool, binaryOnly?: true, text?: true, mount(host, {path, doc, tab}) -> {dispose?}}
  ide.registerFileViewer = (viewer) => { viewers.push(viewer); };
  const viewerFor = (path, { binary = false } = {}) => viewers.find((v) => v.match(path) && (!v.binaryOnly || binary)) || null;

  // opts: {line, col, focus = true, group: 'active'|'right'|'down'|'window'|group, preview, asText, text}
  ide.openFile = async (path, opts = {}) => {
    if (opts.group === 'window') { await openInNewWindow([{ path, line: opts.line }]); return null; }
    let viewer = opts.asText ? null : viewerFor(path);
    let doc = null;
    let unsupported = null; // {binary} or {tooLarge}: why the text editor cannot show the file
    if (!viewer || viewer.text) {
      doc = await loadDoc(path, { asText: opts.asText }).catch((e) => ({ error: e }));
      if (doc.error) {
        ide.ui.alert(tr('Cannot open {name}: {error}', { name: basename(path), error: ide.util.errorText(doc.error) }));
        return null;
      }
      if (doc.unsupported) {
        viewer = viewerFor(path, { binary: true }) || binaryViewer;
        unsupported = doc.unsupported;
        doc = null;
      }
    }
    const g = resolveGroup(opts.group);
    // A viewer (also one that edits text, like Markdown) is found by path and viewer; a plain editor by its document.
    let tab = g.tabs.find((t) => (viewer ? samePath(t.path, path) && t.kind === 'custom' && t.viewer === viewer : t.doc === doc && t.kind === 'file'));
    if (!tab && viewer) tab = openViewerTab(g, path, viewer, doc, unsupported);
    else if (!tab) {
      const preview = opts.preview && settingOn('editor.previewTab', false);
      const old = preview ? g.tabs.find((t) => t.preview && !ide.isDirty(t)) : null;
      tab = makeFileTab(doc, g);
      tab.preview = !!preview;
      addTab(g, tab, old ? g.tabs.indexOf(old) + 1 : undefined);
      if (old) closeTabObj(old, true);
    } else if (!opts.preview && tab.preview) tab.preview = false;
    if (doc?.fresh) { delete doc.fresh; ide.emit('fileOpened', tab); }
    setActiveGroup(g);
    activateTab(g, tab);
    if (opts.text !== undefined && doc) applyText(doc, opts.text, { remote: false });
    if (opts.line && tab.kind === 'file') {
      const pos = { lineNumber: opts.line, column: opts.col || 1 };
      g.editor.setPosition(pos);
      g.editor.revealPositionInCenterIfOutsideViewport(pos);
    }
    if (opts.focus !== false) focusGroup(g);
    return tab;
  };

  function openViewerTab(g, path, viewer, doc, unsupported = null) {
    const host = el('div', 'custom-tab hidden');
    host.tabIndex = -1;
    g.customHost.appendChild(host);
    const tab = { kind: 'custom', group: g, path, title: basename(path), icon: viewer.icon || '◆', host, viewer, doc, model: doc?.model, pinned: false, unsupported };
    addTab(g, tab);
    const r = safeMount(() => viewer.mount(host, { path, doc, tab }));
    tab.dispose = () => r?.dispose?.();
    return tab;
  }
  const safeMount = (fn) => { try { return fn(); } catch (err) { console.error(err); return null; } };

  const binaryViewer = {
    id: 'binary', icon: '📦', match: () => false,
    mount(host, { path, tab }) {
      host.classList.add('binary-viewer');
      host.appendChild(el('div', 'binary-title', basename(path)));
      host.appendChild(el('div', 'muted', tr('This file is binary or too large to show as text.')));
      const row = el('div', 'binary-actions');
      const open = el('button', 'secondary', tr('Open with Default App'));
      open.onclick = () => ide.api.invoke('shell:openPath', path);
      const reveal = el('button', 'secondary', tr('Show in Explorer'));
      reveal.onclick = () => ide.api.invoke('shell:showInFolder', path);
      row.append(open, reveal);
      if (!tab.unsupported?.tooLarge) {
        const asText = el('button', 'secondary', tr('Open as Text'));
        asText.onclick = () => ide.openFile(path, { asText: true, group: tab.group });
        row.prepend(asText);
      }
      host.appendChild(row);
    },
  };

  // {id, title, icon?, mount(host, tab), onClose?(), doc?} -> tab; reopening an existing id just activates it.
  // doc (from ide.loadDocument) makes the tab hold that file's document like a viewer tab: it stays loaded while the tab
  // is open, Save All writes it, closing the tab asks about unsaved changes, and the status bar shows its encoding.
  ide.openCustomTab = ({ id, title, icon = '◆', mount, onClose, group, doc }) => {
    let tab = ide.findTab(id);
    if (!tab) {
      const g = resolveGroup(group);
      const host = el('div', 'custom-tab hidden');
      g.customHost.appendChild(host);
      tab = { kind: 'custom', group: g, path: id, title, icon, host, onClose, pinned: false, ...(doc ? { doc, model: doc.model } : {}) };
      addTab(g, tab);
      mount(host, tab);
    }
    setActiveGroup(tab.group);
    activateTab(tab.group, tab);
    return tab;
  };

  ide.renderTabs = renderAllTabs;

  // Closes the tab for `path` in the active group (or wherever it is open).
  ide.closeTab = (path, force) => {
    const tab = ide.findTab(path);
    return tab ? closeTabObj(tab, force) : true;
  };
  ide.closeTabObject = closeTabObj;
  // Resolves false if the user kept a modified document open.
  ide.closeAllTabs = async (force) => {
    for (const g of [...groups]) for (const t of [...g.tabs]) if (!(await closeTabObj(t, force))) return false;
    return true;
  };

  // ---------- saving ----------
  // Save actions rewrite the text before it is written, on explicit and auto saves alike: {id, order, run(text, ctx) ->
  // new text | undefined}, ctx = {doc, path, auto, eol, modifiedLines, caretLines} (Sets of 1-based line numbers).
  // They run in order on the text, and the result lands in the model as one undo step of line-level edits.
  const saveActions = [];
  ide.registerSaveAction = (a) => { saveActions.push(a); saveActions.sort((x, y) => (x.order ?? 50) - (y.order ?? 50)); };

  const editorsOf = (model) => [...groups.map((g) => g.editor), ...embedded].filter((ed) => ed.getModel() === model);

  // Returns false when the text changed while the actions ran (their result is then dropped).
  async function runSaveActions(doc, auto) {
    const model = doc.model;
    const version = model.getVersionId();
    const before = model.getValue();
    const caretLines = new Set(editorsOf(model).flatMap((ed) => ed.getSelections().map((s) => s.positionLineNumber)));
    const ctx = { doc, path: doc.path, auto, eol: model.getEOL(), modifiedLines: changedLines(doc), caretLines };
    let text = before;
    for (const a of saveActions) {
      try {
        const out = await a.run(text, ctx);
        if (typeof out === 'string') text = out;
      } catch (err) { ide.log.warn(`save action ${a.id} failed: ${err?.message || err}`); }
      if (model.isDisposed() || model.getVersionId() !== version) return false;
    }
    if (text !== before) {
      const ed = editorsOf(model).find((e) => e.hasTextFocus()) || editorsOf(model)[0];
      model.pushStackElement();
      model.pushEditOperations(ed?.getSelections() || null, lineEdits(model, text), () => null);
      model.pushStackElement();
    }
    return true;
  }

  // Minimal whole-line edits turning the model's text into `text`, so carets outside changed lines stay put.
  function lineEdits(model, text) {
    const eol = model.getEOL();
    const a = model.getLinesContent();
    const b = text.split(/\r\n|\n/);
    const { Range } = ide.monaco;
    return diffLines(a, b).map(([s, e, t, u]) => {
      const lines = b.slice(t, u);
      if (e < a.length) return { range: new Range(s + 1, 1, e + 1, 1), text: lines.map((l) => l + eol).join('') };
      if (s > 0) return { range: new Range(s, model.getLineMaxColumn(s), a.length, model.getLineMaxColumn(a.length)), text: lines.map((l) => eol + l).join('') };
      return { range: model.getFullModelRange(), text: lines.join(eol) };
    });
  }

  // Myers line diff -> hunks [aStart, aEnd, bStart, bEnd]; one hunk for the whole middle when the diff is too large.
  function diffLines(a, b) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const n = a.length - pre - suf;
    const m = b.length - pre - suf;
    if (!n && !m) return [];
    const max = n + m;
    const off = max + 1;
    const v = new Int32Array(2 * max + 2);
    const trace = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      if ((d + 1) * v.length > 4e6) return [[pre, pre + n, pre, pre + m]];
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[pre + x] === b[pre + y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = true; break; }
      }
    }
    const matches = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const w = trace[d];
      const k = x - y;
      const pk = k === -d || (k !== d && w[off + k - 1] < w[off + k + 1]) ? k + 1 : k - 1;
      const px = d ? w[off + pk] : 0;
      const py = d ? px - pk : 0;
      while (x > px && y > py) { x--; y--; matches.push([x, y]); }
      x = px;
      y = py;
    }
    matches.reverse();
    const hunks = [];
    let i = 0;
    let j = 0;
    for (const [mx, my] of [...matches, [n, m]]) {
      if (mx > i || my > j) hunks.push([pre + i, pre + mx, pre + j, pre + my]);
      i = mx + 1;
      j = my + 1;
    }
    return hunks;
  }

  // Auto save leaves alone what nobody would expect it to write: untitled documents, read-only ones, documents shown
  // only in a viewer, files whose disk text changed since PyIDE read or wrote them, files it cannot read (a deleted
  // file, an unreachable network or remote path), and a version whose auto save already failed.
  async function autoSavable(doc) {
    if (doc.untitled || doc.readOnly || doc.model.uri.scheme !== 'file') return false;
    if (!tabsOfDoc(doc).some((t) => t.kind === 'file')) return false;
    if (doc.autoSaveFailed === doc.model.getAlternativeVersionId()) return false;
    let r = null;
    try { r = await readDisk(doc); } catch {}
    if (r?.text !== undefined && textHash(r.text) === doc.diskHash) return true;
    // Announced once per conflict, whether auto save or the project watcher (checkDisk) noticed the change first.
    doc.conflict = true;
    if (!doc.skipNoted) { doc.skipNoted = true; ide.emit('autoSaveSkipped', { path: doc.path, reason: r ? 'changedOnDisk' : 'unreadable' }); }
    return false;
  }

  // An explicit save of a file that also changed on disk asks first, as PyCharm's File Cache Conflict does, instead of
  // silently writing over the other change (a git pull in the terminal, another editor). True: go ahead and write.
  async function confirmOverwrite(doc) {
    if (doc.untitled || doc.model.uri.scheme !== 'file') return true;
    let r = null;
    try { r = await readDisk(doc); } catch {
      // Renamed or deleted elsewhere (another window, Explorer, git): bringing the file back is the user's call. A file
      // that exists but cannot be read is written, as before.
      if (await ide.api.exists(doc.path).catch(() => true)) return true;
      return ide.ui.confirm(tr('{name} no longer exists on disk. Save it again?', { name: basename(doc.path) }), { ok: tr('Save') });
    }
    if (r?.text === undefined || textHash(r.text) === doc.diskHash) return true;
    if (r.text === diskText(doc)) return true;
    return new Promise((resolve) => {
      let choice = false;
      ide.ui.dialog({
        title: tr('File Cache Conflict'),
        body: el('div', 'dialog-message', tr('{name} was changed both in the editor and on disk.', { name: basename(doc.path) })),
        width: 480,
        onClose: () => resolve(choice),
        buttons: [
          { label: tr('Load File System Changes'), run: async () => {
            let fresh = r;
            try { fresh = await readForReload(doc); } catch {}
            if (!doc.model.isDisposed() && fresh.text !== undefined) adoptDisk(doc, fresh);
          } },
          // The disk version is now acknowledged: a save that then fails (read-only file) does not ask again.
          { label: tr('Keep Memory Changes'), primary: true, run: () => { choice = true; doc.diskHash = textHash(r.text); } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  // force: write a document without unsaved changes too (Convert to). -> the text written, or null.
  async function saveDoc(doc, { auto = false, overwrite = false, force = false } = {}) {
    while (doc.saving) await doc.saving;
    if (doc.model.isDisposed() || !(docDirty(doc) || force)) return null;
    if (auto && !(await autoSavable(doc))) return null;
    if (!auto && !overwrite && !(await confirmOverwrite(doc))) return null;
    let done;
    doc.saving = new Promise((r) => { done = r; });
    try { return await writeDoc(doc, auto); } finally { doc.saving = null; done(); }
  }

  // A refused CP949 save says so in the UI language.
  const saveError = (e) => (/\bCP949\b/.test(String(e?.message || e))
    ? tr('Some characters cannot be saved in CP949. Convert the file to UTF-8 first.') : ide.util.errorText(e));

  async function writeDoc(doc, auto) {
    const tab = firstTabFor(doc) || { kind: 'file', path: doc.path, model: doc.model, doc };
    ide.emit('beforeSave', tab);
    if (!(await runSaveActions(doc, auto)) && auto) return null;
    if (doc.model.isDisposed()) return null;
    // The version written, not the one after the write: edits typed while it runs are not on disk yet.
    // In the file's own line separator (diskText); a file with mixed ones is written with the main one only.
    const text = diskText(doc);
    const version = doc.model.getAlternativeVersionId();
    try {
      await ide.api.invoke('fs:writeText', doc.path, text, doc.encoding);
    } catch (e) {
      const error = saveError(e);
      if (!auto) ide.ui.alert(tr('Could not save {name}: {error}', { name: basename(doc.path), error }));
      else {
        doc.autoSaveFailed = version;
        ide.emit('autoSaveSkipped', { path: doc.path, reason: 'failed', error });
      }
      return null;
    }
    doc.savedVersion = version;
    doc.diskHash = textHash(text);
    doc.conflict = doc.skipNoted = false;
    doc.mixedSeparators = false;
    if (!docDirty(doc)) clearChanged(doc);
    announceSaved(doc, doc.lineSeparator === '\r' ? text.replace(/\r/g, '\r\n') : text);
    for (const t of tabsOfDoc(doc)) t.preview = false;
    ide.emit('fileSaved', tab);
    return text;
  }
  // overwrite: the user already chose to write over a disk change (no File Cache Conflict question).
  ide.saveTab = async (tab, { overwrite = false } = {}) => { if (tab?.doc) await saveDoc(tab.doc, { overwrite }); renderAllTabs(); };
  ide.saveAll = async () => {
    await Promise.all([...docs.values()].map((d) => saveDoc(d)));
    renderAllTabs();
  };
  // Saves modified documents (all, or those at `paths`) the way auto save does; see autoSavable.
  ide.autoSave = async (paths) => {
    const list = [...docs.values()].filter((d) => docDirty(d) && (!paths || paths.some((p) => samePath(p, d.path))));
    await Promise.all(list.map((d) => saveDoc(d, { auto: true })));
    if (list.length) renderAllTabs();
  };

  // Takes text just read from the file as the document's saved state, with the file's line separator and the encoding
  // it was read in (a file re-encoded outside PyIDE keeps its new encoding on the next save). Other windows showing the
  // document take it as saved too.
  function adoptDisk(doc, r) {
    if (r.text !== diskText(doc)) doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: r.text }], () => null);
    adoptSeparator(doc, r.text);
    if (r.encoding) doc.encoding = r.encoding;
    doc.savedVersion = doc.model.getAlternativeVersionId();
    Object.assign(doc, { diskHash: textHash(r.text), conflict: false, skipNoted: false });
    clearChanged(doc);
    announceSaved(doc);
    renderAllTabs();
    updateStatus();
  }

  async function reloadDoc(doc) {
    if (docDirty(doc)) return;
    let r;
    try { r = await readForReload(doc); } catch { return; }
    // Typed into or closed while the file was read: the editor's text wins.
    if (doc.model.isDisposed() || docDirty(doc) || r.text === undefined) return;
    if (r.text !== diskText(doc)) return adoptDisk(doc, r);
    // The same text in another encoding: re-encoded outside PyIDE when the document's own encoding no longer reads it
    // (not a CP949 file that is all ASCII, which detection calls UTF-8).
    if (r.encoding !== doc.encoding && (await readDisk(doc).catch(() => null))?.text !== r.text) adoptDisk(doc, r);
  }
  // Reloads open documents whose file changed on disk (after formatters, git checkout, replace-in-files...).
  ide.reloadFromDisk = async (paths) => {
    for (const doc of [...docs.values()].filter((d) => !paths || paths.some((p) => samePath(p, d.path)))) await reloadDoc(doc);
    renderAllTabs();
  };

  // ---------- files changed outside the IDE ----------
  // Open documents follow the disk: an unmodified one reloads; a modified one is marked, and its next explicit save
  // asks (confirmOverwrite). The project watcher (main/project-watch.js) reports changes; window focus checks again,
  // since a watcher can miss changes (network drives, an overflowed change buffer).
  async function checkDisk(list) {
    for (const doc of list) {
      if (doc.untitled || doc.saving || doc.model.isDisposed() || doc.model.uri.scheme !== 'file') continue;
      let r;
      try { r = await readDisk(doc); } catch { continue; }
      if (r?.text === undefined || doc.model.isDisposed() || doc.saving || textHash(r.text) === doc.diskHash) continue;
      if (!docDirty(doc)) await reloadDoc(doc);
      else doc.conflict = true;
    }
  }
  const watchProject = (root) => { if (!ide.detached) ide.api.invoke('watch:project', root || null).catch(() => {}); };
  ide.on('projectOpened', watchProject);
  ide.on('projectClosed', () => watchProject(null));
  let treeTimer = null;
  ide.api.on('watch:changed', ({ root, paths, overflow }) => {
    if (!ide.root || !samePath(root, ide.root)) return;
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => ide.refreshTree(), 200);
    checkDisk([...docs.values()].filter((d) => overflow || paths.some((p) => samePath(p, d.path))));
  });
  window.addEventListener('focus', () => checkDisk([...docs.values()]));

  // ---------- files renamed, moved or deleted ----------
  // A document follows its file in every window. Renamed or moved (to: the new path), its tabs keep their place, pin and
  // caret, and its unsaved text stays unsaved under the new name; deleted (to: null), its tabs close. The window that
  // renamed or deleted calls ide.documentsMoved once the disk operation succeeded; the other windows hear doc:moved.
  async function followMove(from, to) {
    for (const doc of [...docs.values()].filter((d) => isUnder(d.path, from))) {
      const tabs = groups.flatMap((g) => g.tabs.filter((t) => t.doc === doc));
      if (!to) { for (const t of tabs) closeTabObj(t, true); continue; }
      const target = to + doc.path.slice(from.length);
      if (key(target) === key(doc.path)) { doc.path = target; continue; }
      const moved = await loadDoc(target, { asText: doc.forcedText }).catch(() => null);
      if (!moved?.model) continue;
      // A tab that shows the file (not a compare tab holding its document) is replaced in its place, without becoming
      // active (no tab switch, so nothing is auto-saved); a modified document shown nowhere else gets a tab so its text
      // is not lost. The unsaved text stays unsaved.
      const shown = tabs.filter((t) => t.kind === 'file' || t.viewer);
      const places = shown.length ? shown : docDirty(doc) ? [null] : [];
      for (const t of places) {
        const g = t?.group || activeGroup;
        let nt;
        if (t?.viewer) {
          nt = openViewerTab(g, target, t.viewer, moved);
          g.tabs.splice(g.tabs.indexOf(nt), 1);
          g.tabs.splice(g.tabs.indexOf(t), 0, nt);
        } else {
          nt = makeFileTab(moved, g);
          addTab(g, nt, t ? g.tabs.indexOf(t) : undefined);
        }
        if (t) Object.assign(nt, { pinned: t.pinned, viewState: g.active === t && t.kind === 'file' ? g.editor.saveViewState() : t.viewState });
        if (moved.fresh) { delete moved.fresh; ide.emit('fileOpened', nt); }
        if (t && g.active === t) activateTab(g, nt);
      }
      // While the moved document joins, its unsaved text is where this window starts from, not an edit typed while
      // joining: the other windows that follow the move bring the same text, which would otherwise be added twice.
      if (docDirty(doc) && moved.sync.joining !== undefined) {
        applyText(moved, doc.model.getValue());
        moved.sync.joining = lfText(moved.model.getValue());
      } else if (docDirty(doc)) applyText(moved, doc.model.getValue(), { remote: false });
      for (const t of tabs) closeTabObj(t, true, { moving: true });
      if (!tabsOfDoc(moved).length) releaseDoc(moved);
    }
    renderAllTabs();
    updateStatus();
  }
  let moves = Promise.resolve();
  const queueMove = (from, to) => (moves = moves.then(() => followMove(from, to)).catch((err) => console.error(err)));
  ide.documentsMoved = (from, to) => {
    if (peers > 1) ide.api.send('doc:moved', { from, to });
    return queueMove(from, to);
  };
  ide.api.on('doc:moved', ({ from, to }) => queueMove(from, to));

  // ---------- status bar: encoding ----------
  const ENCODING_LABEL = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 BOM', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'utf-16le-nobom': 'UTF-16 LE (no BOM)', 'utf-16be-nobom': 'UTF-16 BE (no BOM)', cp949: 'CP949 (EUC-KR)' };
  const encodingItem = el('span', 'status-encoding');
  encodingItem.id = 'statusEncoding';
  encodingItem.title = tr('File encoding');
  $('statusEncodingSlot').replaceWith(encodingItem);
  function updateStatus() {
    const t = activeGroup?.active;
    $('statusPath').textContent = !t ? '' : t.kind === 'file' || t.doc || t.viewer ? ide.util.rel(t.path) : t.title;
    encodingItem.textContent = t?.doc ? ENCODING_LABEL[t.doc.encoding] || t.doc.encoding : '';
    const pos = t?.kind === 'file' ? activeGroup.editor.getPosition() : null;
    $('statusPos').textContent = pos ? `${pos.lineNumber}:${pos.column}` : '';
    if (ide.detached) ide.api.invoke('window:setTitle', t ? `${t.title} - PyIDE` : 'PyIDE');
  }
  encodingItem.onclick = () => {
    const doc = ide.activeTab()?.doc;
    if (!doc) return;
    const r = encodingItem.getBoundingClientRect();
    ide.ui.contextMenu(r.left, r.top - 8, [
      ...Object.entries(ENCODING_LABEL).map(([enc, label]) => ({
        label: tr('Reload in {encoding}', { encoding: label }), hint: enc === doc.encoding ? '✓' : '', disabled: docDirty(doc),
        run: async () => {
          let res;
          try { res = await ide.api.invoke('fs:decode', doc.path, enc); } catch (e) {
            ide.ui.alert(tr('Cannot open {name}: {error}', { name: basename(doc.path), error: ide.util.errorText(e) }));
            return;
          }
          // Too large to read as text, or the tab was closed or edited while the file was read.
          if (res.text === undefined || doc.model.isDisposed() || docDirty(doc)) return;
          doc.encodingPinned = true;
          adoptDisk(doc, { text: res.text, encoding: enc });
        },
      })),
      { separator: true },
      ...Object.entries(ENCODING_LABEL).filter(([enc]) => enc !== doc.encoding).map(([enc, label]) => ({
        label: tr('Convert to {encoding}', { encoding: label }), run: () => convertTo(doc, enc, label),
      })),
    ]);
  };

  // Writes the document in another encoding through the normal save (save actions, File Cache Conflict, the other
  // windows told), unsaved changes included. A file PyIDE would not read back as the same text (BOM-less UTF-16 of
  // text with hardly any ASCII looks binary to detection) goes back to its old encoding instead.
  async function convertTo(doc, enc, label) {
    // Asked in the old encoding, which is the one the file on disk is in.
    if (!(await confirmOverwrite(doc))) return;
    const prev = { encoding: doc.encoding, encodingPinned: doc.encodingPinned };
    Object.assign(doc, { encoding: enc, encodingPinned: true });
    const written = await saveDoc(doc, { force: true, overwrite: true });
    if (written === null) { Object.assign(doc, prev); updateStatus(); return; }
    let back = null;
    try { back = await ide.api.invoke('fs:readText', doc.path); } catch {}
    if (back && back.text !== written) {
      Object.assign(doc, prev);
      await saveDoc(doc, { force: true, overwrite: true });
      ide.ui.alert(tr('{name} was not converted to {encoding}: PyIDE could not read the file back as text in that encoding when it is opened again.', { name: basename(doc.path), encoding: label }));
    }
    renderAllTabs();
    updateStatus();
  }

  // ---------- menus ----------
  const fileTabs = (g) => g.tabs;
  async function closeMany(list) { for (const t of list) if (!(await closeTabObj(t))) break; }

  function showTabMenu(t, x, y) {
    const g = t.group;
    const i = g.tabs.indexOf(t);
    const other = oppositeGroup(g);
    // A custom tab that only holds a document (a compare diff) is not that file's tab: its path is an id.
    const isFile = t.kind === 'file' || !!t.viewer;
    ide.ui.contextMenu(x, y, [
      { label: tr('Close'), keyAction: 'CloseContent', run: () => closeTabObj(t) },
      { label: tr('Close Other Tabs'), run: () => closeMany(fileTabs(g).filter((o) => o !== t && !o.pinned)) },
      { label: tr('Close All Tabs'), run: () => closeMany(fileTabs(g).filter((o) => !o.pinned)) },
      { label: tr('Close Tabs to the Left'), disabled: i === 0, run: () => closeMany(g.tabs.slice(0, i).filter((o) => !o.pinned)) },
      { label: tr('Close Tabs to the Right'), disabled: i === g.tabs.length - 1, run: () => closeMany(g.tabs.slice(i + 1).filter((o) => !o.pinned)) },
      { label: tr('Close Unmodified Tabs'), run: () => closeMany(g.tabs.filter((o) => !ide.isDirty(o) && !o.pinned)) },
      { separator: true },
      { label: t.pinned ? tr('Unpin Tab') : tr('Pin Tab'), run: () => togglePin(t) },
      { separator: true },
      { label: tr('Split Right'), keyAction: 'SplitVertically', run: () => splitGroup(g, 'right', t, { clone: true }) },
      { label: tr('Split Down'), keyAction: 'SplitHorizontally', run: () => splitGroup(g, 'down', t, { clone: true }) },
      { label: tr('Split and Move Right'), disabled: g.tabs.length < 2, run: () => splitGroup(g, 'right', t, { clone: false }) },
      { label: tr('Split and Move Down'), disabled: g.tabs.length < 2, run: () => splitGroup(g, 'down', t, { clone: false }) },
      { label: tr('Move to Opposite Group'), disabled: !other, run: () => placeTab(t, other, { clone: false }) },
      { label: tr('Open in New Window'), keyAction: 'OpenInNewWindow', disabled: !isFile, run: () => openInNewWindow([tabPayload(t)]) },
      { label: tr('Move to New Window'), disabled: !isFile, run: () => moveToNewWindow(t) },
      ...(ide.detached ? [{ label: tr('Move to Main Window'), disabled: !isFile, run: () => dockToMain([t]) }] : []),
      ...(t.viewer && !t.unsupported?.tooLarge ? [{ label: tr('Open as Text'), run: () => ide.openFile(t.path, { asText: true, group: g }) }] : []),
      { separator: true },
      { label: tr('Copy Path'), keyAction: 'CopyPaths', disabled: !isFile, run: () => copyPath(t.path) },
      { label: tr('Copy Relative Path'), disabled: !isFile, run: () => copyPath(ide.util.rel(t.path)) },
      { label: tr('Select in Project View'), keyAction: 'SelectInProjectView', disabled: !isFile || ide.detached, run: () => selectInProject(t.path) },
      { label: tr('Show in Explorer'), disabled: !isFile, run: () => ide.api.invoke('shell:showInFolder', t.path) },
      { label: tr('Open with Default App'), disabled: !isFile, run: () => ide.api.invoke('shell:openPath', t.path) },
    ]);
  }

  function showGroupMenu(g, x, y) {
    setActiveGroup(g);
    ide.ui.contextMenu(x, y, [
      { label: tr('Split Right'), keyAction: 'SplitVertically', run: () => splitGroup(g, 'right', g.active, { clone: true }) },
      { label: tr('Split Down'), keyAction: 'SplitHorizontally', run: () => splitGroup(g, 'down', g.active, { clone: true }) },
      { label: tr('Unsplit'), disabled: groups.length < 2, run: () => unsplit(g) },
      { label: tr('Unsplit All'), disabled: groups.length < 2, run: unsplitAll },
      { label: tr('Change Splitter Orientation'), disabled: groups.length < 2, run: () => flipOrientation(g) },
      { separator: true },
      { label: tr('Close All Tabs'), run: () => closeMany(g.tabs.filter((o) => !o.pinned)) },
      { label: tr('Reopen Closed Tab'), keyAction: 'ReopenClosedTab', disabled: !closedTabs.length, run: reopenClosed },
    ]);
  }

  function togglePin(t) {
    t.pinned = !t.pinned;
    t.preview = false;
    const g = t.group;
    g.tabs.splice(g.tabs.indexOf(t), 1);
    const pinnedCount = g.tabs.filter((o) => o.pinned).length;
    g.tabs.splice(t.pinned ? pinnedCount : pinnedCount, 0, t);
    renderTabs(g);
  }

  // Unsplit merges a group's tabs into its neighbour.
  function unsplit(g) {
    const other = oppositeGroup(g);
    if (!other) return;
    for (const t of [...g.tabs]) placeTab(t, other, { clone: false });
  }

  function flipOrientation(g) {
    const leaf = leafOf(layout, g);
    const { parent } = findParent(layout, leaf) || {};
    if (!parent) return;
    parent.dir = parent.dir === 'row' ? 'column' : 'row';
    renderLayout();
  }

  async function reopenClosed() {
    const last = closedTabs.pop();
    if (!last || last.kind === 'custom' && !last.viewer) return;
    await ide.openFile(last.path);
  }

  const copyPath = (text) => ide.api.invoke('clipboard:writeText', text);

  async function selectInProject(path) {
    if (!ide.root || !isUnder(path, ide.root)) return;
    ide.toolWindows.get('Project')?.show();
    await ide.revealInTree(path);
  }

  function cycleTab(dir) {
    const g = activeGroup;
    if (!g?.tabs.length) return;
    const i = g.tabs.indexOf(g.active);
    activateTab(g, g.tabs[(i + dir + g.tabs.length) % g.tabs.length], { focus: true });
  }

  function focusGroupAt(n) {
    const ordered = [];
    const walk = (node) => (node.kind === 'leaf' ? ordered.push(node.group) : (walk(node.a), walk(node.b)));
    walk(layout);
    const g = ordered[n];
    if (g) { setActiveGroup(g); focusGroup(g); }
  }

  // Tool windows hidden by "Hide All Tool Windows" come back on the next toggle.
  let hiddenToolWindows = null;
  function toggleMaximizeEditor() {
    if (hiddenToolWindows) {
      for (const tw of hiddenToolWindows) tw.show();
      hiddenToolWindows = null;
      focusGroup(activeGroup);
      return;
    }
    hiddenToolWindows = [...ide.toolWindows.values()].filter((tw) => tw.isVisible());
    for (const tw of hiddenToolWindows) tw.hide();
    focusGroup(activeGroup);
  }

  // ---------- detached windows ----------
  const tabPayload = (t) => {
    const pos = t.kind === 'file' && t.group.active === t ? t.group.editor.getPosition() : null;
    return { path: t.path, line: pos?.lineNumber, col: pos?.column, text: t.doc && docDirty(t.doc) ? t.doc.model.getValue() : undefined, asText: t.kind === 'file' && (!!viewerFor(t.path) || !!t.doc?.forcedText) };
  };
  const openInNewWindow = (files) => ide.api.invoke('window:openDetached', { files });
  async function moveToNewWindow(t) {
    const payload = tabPayload(t);
    await openInNewWindow([payload]);
    // The new window now holds any unsaved text; drop this copy without asking.
    closeTabObj(t, true);
  }
  async function dockToMain(tabs) {
    const files = tabs.map(tabPayload);
    if (await ide.api.invoke('window:dockToMain', { files })) for (const t of tabs) closeTabObj(t, true);
  }
  ide.api.on('window:dock', async ({ files }) => {
    for (const f of files) await ide.openFile(f.path, { line: f.line, col: f.col, text: f.text, asText: f.asText });
  });

  // A window with unsaved documents asks before it closes (the main process holds the close until then). Closing the
  // main window closes them all, so it asks about every window's files at once (others: modified files open only in
  // other windows) and nothing closes before the answer. Clicking the close button again while it asks does not stack
  // a second dialog.
  let confirmingClose = false;
  ide.api.on('window:confirmClose', ({ others = [] } = {}) => {
    if (confirmingClose) return;
    const own = [...docs.values()].filter(docDirty).map((d) => d.path);
    const paths = [...own, ...others.filter((p) => !own.some((o) => samePath(o, p)))];
    if (!paths.length) { ide.api.invoke('window:closeNow'); return; }
    const list = el('ul', 'close-confirm-list');
    for (const p of paths) list.appendChild(el('li', null, ide.util.rel(p)));
    const body = el('div');
    body.append(el('div', null, tr('These files have unsaved changes:')), list);
    confirmingClose = true;
    ide.ui.dialog({
      title: tr('Save Changes?'),
      body,
      width: 460,
      onClose: () => { confirmingClose = false; },
      buttons: [
        // A file that could not be saved (its error was shown) keeps the windows open.
        { label: tr('Save All'), primary: true, run: async () => {
          await ide.saveAll();
          const othersSaved = !others.length || await ide.api.invoke('window:saveOthers');
          if (othersSaved && ![...docs.values()].some(docDirty)) ide.api.invoke('window:closeNow');
        } },
        { label: tr("Don't Save"), run: () => ide.api.invoke('window:closeNow') },
        { label: tr('Cancel') },
      ],
    });
  });
  // The main window's Save All, for the files open only here.
  ide.api.on('window:saveAll', async (id) => {
    await ide.saveAll();
    reportDirty();
    ide.api.send('window:saved', id);
  });

  // ---------- actions ----------
  const inGroup = () => !!activeGroup;
  // The active tab when it is a file (or a viewer of one): a compare or custom tab's path is only a title, and its
  // document must not be sent to another window under that name.
  const activeFileTab = () => { const t = activeGroup?.active; return t && (t.kind === 'file' || t.viewer) ? t : null; };
  const onFile = (fn) => () => { const t = activeFileTab(); if (t) fn(t); };
  [
    { id: 'CloseContent', title: tr('Close Tab'), keys: 'Ctrl+F4', run: () => activeGroup?.active && closeTabObj(activeGroup.active) },
    { id: 'PreviousTab', title: tr('Previous Tab'), keys: 'Alt+ArrowLeft', run: () => cycleTab(-1) },
    { id: 'NextTab', title: tr('Next Tab'), keys: 'Alt+ArrowRight', run: () => cycleTab(1) },
    { id: 'Switcher', title: tr('Switch to Previous Tab'), keys: 'Ctrl+Tab', run: () => { const t = mru[1]; if (t) { setActiveGroup(t.group); activateTab(t.group, t, { focus: true }); } } },
    { id: 'SplitVertically', title: tr('Split Right'), keys: 'Ctrl+\\', when: inGroup, run: () => splitGroup(activeGroup, 'right', activeGroup.active, { clone: true }) },
    { id: 'SplitHorizontally', title: tr('Split Down'), keys: 'Ctrl+Shift+\\', when: inGroup, run: () => splitGroup(activeGroup, 'down', activeGroup.active, { clone: true }) },
    { id: 'SplitAndMoveRight', title: tr('Split and Move Right'), run: () => activeGroup.tabs.length > 1 && splitGroup(activeGroup, 'right', activeGroup.active, { clone: false }) },
    { id: 'SplitAndMoveDown', title: tr('Split and Move Down'), run: () => activeGroup.tabs.length > 1 && splitGroup(activeGroup, 'down', activeGroup.active, { clone: false }) },
    { id: 'MoveEditorToOppositeTabGroup', title: tr('Move to Opposite Group'), run: () => { const o = oppositeGroup(activeGroup); if (o && activeGroup.active) placeTab(activeGroup.active, o, { clone: false }); } },
    { id: 'Unsplit', title: tr('Unsplit'), run: () => unsplit(activeGroup) },
    { id: 'UnsplitAll', title: tr('Unsplit All'), run: unsplitAll },
    { id: 'ChangeSplitOrientation', title: tr('Change Splitter Orientation'), run: () => flipOrientation(activeGroup) },
    { id: 'NextSplitter', title: tr('Go to Next Splitter'), keys: 'Ctrl+Alt+]', run: () => { const o = oppositeGroup(activeGroup); if (o) { setActiveGroup(o); focusGroup(o); } } },
    { id: 'FocusGroup1', title: tr('Focus Editor Group {n}', { n: 1 }), keys: 'Ctrl+1', run: () => focusGroupAt(0) },
    { id: 'FocusGroup2', title: tr('Focus Editor Group {n}', { n: 2 }), keys: 'Ctrl+2', run: () => focusGroupAt(1) },
    { id: 'FocusGroup3', title: tr('Focus Editor Group {n}', { n: 3 }), keys: 'Ctrl+3', run: () => focusGroupAt(2) },
    { id: 'PinActiveTab', title: tr('Pin Tab'), run: () => activeGroup?.active && togglePin(activeGroup.active) },
    // No key, as in PyCharm: Ctrl+Shift+T is Go to Test.
    { id: 'ReopenClosedTab', title: tr('Reopen Closed Tab'), run: reopenClosed },
    { id: 'OpenInNewWindow', title: tr('Open in New Window'), keys: 'Shift+F4', run: onFile((t) => openInNewWindow([tabPayload(t)])) },
    { id: 'MoveToNewWindow', title: tr('Move to New Window'), run: onFile(moveToNewWindow) },
    { id: 'CopyPaths', title: tr('Copy Path'), keys: 'Ctrl+Shift+C', run: onFile((t) => copyPath(t.path)) },
    { id: 'SelectInProjectView', title: tr('Select in Project View'), keys: 'Alt+F1', run: onFile((t) => selectInProject(t.path)) },
    { id: 'ShowInExplorer', title: tr('Show in Explorer'), run: onFile((t) => ide.api.invoke('shell:showInFolder', t.path)) },
    { id: 'OpenFile', title: tr('Open File…'), run: async () => { const p = await ide.api.openFileDialog(); if (p) ide.openFile(p); } },
    { id: 'HideAllWindows', title: tr('Hide All Tool Windows'), keys: 'Ctrl+Shift+F12', run: toggleMaximizeEditor, terminal: true },
  ].forEach(ide.registerAction);

  // ---------- boot ----------
  ide.initEditors = (options) => {
    // Monaco's theme is global: passing it to each new editor would reset the current theme (e.g. Light) to the startup one.
    const { theme, ...rest } = options;
    editorOptions = rest;
    if (theme) ide.monaco.editor.setTheme(theme);
    const g = createGroup();
    layout = { kind: 'leaf', group: g };
    renderLayout();
    activeGroup = null;
    setActiveGroup(g);
    activateTab(g, null);
  };

  // Detached windows show only the editor area and open the files they were given.
  ide.initDetachedWindow = async () => {
    const state = await ide.api.invoke('window:initialState');
    for (const f of state?.files || []) {
      await ide.openFile(f.path, { line: f.line, col: f.col, text: f.text, asText: f.asText });
    }
  };
})();
