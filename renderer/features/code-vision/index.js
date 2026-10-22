// Code vision for Python, as in PyCharm (Settings › Editor › Inlay Hints › Code vision): above each top-level and
// class-level `class`/`def`, the number of usages (Pyright's textDocument/references) and the Git authors of its lines
// (one `git blame --porcelain` per file, HEAD and saved text). Monaco code lenses draw them.
//
// Cost model. A references request walks every project file that mentions the name, and Pyright answers one request
// at a time, so the counts must not compete with completion and hover while the user types:
// - the lenses come from a cheap scan of the text and the caches below; providing them never asks Pyright;
// - counts are asked only for symbols in view, only after edits pause (IDLE_MS), one request at a time, and every
//   edit cancels the run (its request in Pyright is cancelled through the token);
// - a count stays valid while the text Pyright sees for that name cannot have changed: the occurrences of the name
//   in every open Python document, Python files changed on disk, the interpreter and project;
// - a stale count stays on screen until its new value arrives, so lenses never blink or move while typing.
(() => {
  const monaco = ide.monaco;
  const { basename } = ide.util;
  const KEYS = { usages: 'editor.codeVision.usages', authors: 'editor.codeVision.authors' };
  const DEFAULTS = { [KEYS.usages]: true, [KEYS.authors]: true };
  const on = (name) => ide.settings.get(KEYS[name], true) !== false;
  const active = () => !ide.powerSave?.on() && (on('usages') || on('authors'));
  const IDLE_MS = 1200;
  const CACHE_LIMIT = 20000;
  const CMD_USAGES = 'pyide.codeVision.usages';
  const CMD_AUTHORS = 'pyide.codeVision.authors';
  const stats = { references: 0, cancelled: 0, blames: 0, runs: 0 };
  const dateLocale = i18n.locale === 'ko' ? 'ko-KR' : 'en-US';

  // ---------- documents ----------
  const isPyPath = (p) => /\.pyi?$/i.test(p || '');
  // The open document a model belongs to (not a notebook cell, a diff side or a viewer's embedded editor).
  function docOf(model) {
    if (!model || model.isDisposed() || model.uri.scheme !== 'file') return null;
    const p = model.uri.fsPath;
    if (!isPyPath(p)) return null;
    const d = ide.getDocument(p);
    return d?.model === model ? d : null;
  }
  const pkey = (doc) => doc.path.toLowerCase();

  // ---------- declarations ----------
  // Top-level classes and functions and the members of top-level (and nested) classes, with the line the lens sits on
  // (the first decorator), the name's place and the last line of the body. A line scanner that knows strings,
  // comments, brackets and backslash continuations; cached per model version (~1 ms for 2,000 lines).
  const IDENT = '[\\p{L}_][\\p{L}\\p{N}_]*';
  const DEF_RE = new RegExp(`^(?:async\\s+)?(def|class)\\s+(${IDENT})`, 'u');
  const scans = new WeakMap();
  function scan(model) {
    const version = model.getVersionId();
    const cached = scans.get(model);
    if (cached?.version === version) return cached.symbols;
    const symbols = [];
    const stack = []; // {indent, kind, name, sym, body}
    const dup = new Map();
    let inStr = null;
    let depth = 0;
    let cont = false;
    let decorator = 0;
    let lastCode = 0;
    const close = (indent) => {
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        const s = stack.pop();
        if (s.sym) s.sym.end = Math.max(s.sym.nameLine, lastCode);
      }
    };
    const n = model.getLineCount();
    for (let ln = 1; ln <= n; ln++) {
      const text = model.getLineContent(ln);
      const body = text.trimStart();
      const logical = !inStr && depth === 0 && !cont;
      let code = !!body;
      if (logical && body) {
        if (body.startsWith('#')) code = false;
        else {
          const indent = text.length - body.length;
          const top = stack[stack.length - 1];
          if (top && top.body === null && indent > top.indent) top.body = indent;
          close(indent);
          const m = body.startsWith('@') ? null : DEF_RE.exec(body);
          if (body.startsWith('@')) {
            if (!decorator) decorator = ln;
          } else if (m) {
            const parent = stack[stack.length - 1];
            const eligible = parent ? stack.every((s) => s.kind === 'class') && parent.body === indent : indent === 0;
            const name = m[2];
            let sym = null;
            if (eligible) {
              const qual = [...stack.map((s) => s.name), name].join('.');
              const k = `${m[1]} ${qual}`;
              const i = dup.get(k) || 0;
              dup.set(k, i + 1);
              const nameCol = indent + m[0].length - name.length + 1;
              sym = { key: `${k}#${i}`, kind: m[1], name, qual, line: decorator || ln, nameLine: ln, nameCol, nameEnd: nameCol + name.length, end: ln };
              symbols.push(sym);
            }
            stack.push({ indent, kind: m[1], name, sym, body: null });
            decorator = 0;
          } else {
            decorator = 0;
          }
        }
      }
      // Strings, comments, brackets and continuations decide where the next logical line starts.
      let comment = false;
      for (let i = 0; i < text.length;) {
        if (inStr) {
          let j = i;
          let found = -1;
          while (j < text.length) {
            if (text[j] === '\\') { j += 2; continue; }
            if (text.startsWith(inStr, j)) { found = j; break; }
            j++;
          }
          if (found < 0) break;
          i = found + inStr.length;
          inStr = null;
          continue;
        }
        const ch = text[i];
        if (ch === '#') { comment = true; break; }
        if (ch === '"' || ch === "'") {
          const triple = ch.repeat(3);
          if (text.startsWith(triple, i)) { inStr = triple; i += 3; continue; }
          let j = i + 1;
          while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
          i = j + 1;
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        i++;
      }
      cont = !inStr && !comment && text.endsWith('\\');
      if (code) lastCode = ln;
    }
    close(-1);
    scans.set(model, { version, symbols });
    return symbols;
  }
  const symbolByKey = (model, key) => scan(model).find((s) => s.key === key) || null;

  // ---------- usages ----------
  // Name occurrences per model version: one pass over the text, done only when a count is checked (after a pause).
  const wordCounts = new WeakMap();
  const WORD_RE = new RegExp(IDENT, 'gu');
  function words(model) {
    const v = model.getVersionId();
    const c = wordCounts.get(model);
    if (c?.version === v) return c.map;
    const map = new Map();
    for (const m of model.getValue().matchAll(WORD_RE)) map.set(m[0], (map.get(m[0]) || 0) + 1);
    wordCounts.set(model, { version: v, map });
    return map;
  }
  // What Pyright's answer for `name` depends on in the open documents: where the name occurs and how often.
  function nameSig(name) {
    const parts = [];
    for (const m of monaco.editor.getModels()) {
      if (!docOf(m)) continue;
      const n = words(m).get(name);
      if (n) parts.push(`${m.uri.toString()}:${n}`);
    }
    return parts.sort().join('|');
  }
  let diskEpoch = 0; // Python files changed on disk outside the open documents
  let lspEpoch = 0; // another interpreter or project
  const usageCache = new Map(); // `${path}|${symbol key}` -> {count | null, sig, disk, lsp}
  const ukey = (doc, sym) => `${pkey(doc)}|${sym.key}`;
  const fresh = (e, sym) => e && e.disk === diskEpoch && e.lsp === lspEpoch && e.sig === nameSig(sym.name);
  function remember(k, entry) {
    usageCache.delete(k);
    usageCache.set(k, entry);
    if (usageCache.size > CACHE_LIMIT) usageCache.delete(usageCache.keys().next().value);
  }
  const referencesParams = (doc, sym) => ({
    textDocument: { uri: doc.model.uri.toString() },
    position: { line: sym.nameLine - 1, character: sym.nameCol - 1 },
    context: { includeDeclaration: false },
  });

  // ---------- authors (git blame) ----------
  // One blame per file, HEAD and saved text: the result is turned into authors per declaration at once (keyed by the
  // declaration, so edits that move lines keep them until the next save re-blames).
  const blames = new Map(); // path -> {key, data: Map(symbol key -> info) | null}
  function authorsBySymbol(r, symbols) {
    const out = new Map();
    for (const s of symbols) {
      const commits = new Map();
      let modified = false;
      for (let ln = s.line; ln <= s.end; ln++) {
        const h = r.lines[ln - 1];
        if (!h) continue;
        if (/^0+$/.test(h)) { modified = true; continue; }
        const c = r.commits[h];
        if (!c) continue;
        const acc = commits.get(h) || { hash: h, author: c.author || '', time: c.time || 0, summary: c.summary || '', lines: 0 };
        acc.lines++;
        commits.set(h, acc);
      }
      if (!commits.size) continue;
      const list = [...commits.values()].sort((a, b) => b.time - a.time);
      const authors = [...new Set(list.map((c) => c.author))];
      out.set(s.key, { author: list[0].author, authors, modified, commits: list, time: list[0].time });
    }
    return out;
  }
  async function ensureBlame(doc) {
    if (!on('authors') || ide.trusted === false || !ide.root || !ide.util.isUnder(doc.path, ide.root)) return;
    const head = ide.vcs?.repo?.()?.head;
    const k = pkey(doc);
    if (!head) { if (blames.get(k)?.data) { blames.delete(k); fireSoon(); } return; }
    const want = `${head}|${doc.savedVersion}`;
    const st = blames.get(k);
    if (st?.key === want) return;
    const next = { key: want, data: st?.data ?? null };
    blames.set(k, next);
    const symbols = scan(doc.model);
    stats.blames++;
    let r = null;
    try { r = await ide.api.invoke('git:blame', ide.root, doc.path, doc.model.getValue()); } catch {}
    if (blames.get(k) !== next) return;
    next.data = r ? authorsBySymbol(r, symbols) : null;
    fireSoon();
  }

  // ---------- lenses ----------
  const changed = new monaco.Emitter();
  let fireTimer = null;
  function fireSoon() {
    if (fireTimer) return;
    fireTimer = setTimeout(() => { fireTimer = null; changed.fire(); }, 150);
  }
  // Monaco reads `$(name)` in a lens title as an icon.
  const plain = (s) => String(s).replace(/\$\(/g, '$​(');
  const usageText = (n) => (n === 0 ? tr('no usages') : n === 1 ? tr('1 usage') : tr('{count} usages', { count: n }));
  const authorText = (a) => plain(`${a.author}${a.authors.length > 1 ? ` +${a.authors.length - 1}` : ''}${a.modified ? ' *' : ''}`);
  const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' });
  function authorTip(a) {
    const lines = [tr('Last changed by {author} on {date}', { author: a.author, date: fmtDate(a.time) })];
    if (a.authors.length > 1) lines.push(tr('Authors: {names}', { names: a.authors.join(', ') }));
    if (a.modified) lines.push(tr('* has uncommitted changes'));
    return plain(lines.join('\n'));
  }

  // Monaco moves every lens of a model on each keystroke (~3 µs a lens), so a file with many declarations gets lenses
  // only within WINDOW_MARGIN lines of what its editors show, and the window follows scrolling. Smaller files get all
  // of them, so nothing appears or moves while scrolling or after a jump.
  const WINDOW_ALL = 300;
  const WINDOW_MARGIN = 200;
  const windows = new WeakMap(); // model -> {from, to} of the lenses last provided
  function viewWindow(model) {
    let from = Infinity;
    let to = -Infinity;
    for (const ed of ide.editors()) {
      if (ed.getModel() !== model) continue;
      for (const r of ed.getVisibleRanges()) { from = Math.min(from, r.startLineNumber); to = Math.max(to, r.endLineNumber); }
    }
    if (from === Infinity) { from = 1; to = 1; }
    return { from: Math.max(1, from - WINDOW_MARGIN), to: Math.min(model.getLineCount(), to + WINDOW_MARGIN) };
  }
  function windowStale(ed) {
    const model = ed.getModel();
    const w = model && windows.get(model);
    const r = w && ed.getVisibleRanges();
    if (!r?.length) return false;
    const from = r[0].startLineNumber;
    const to = r[r.length - 1].endLineNumber;
    return (w.from > 1 && from - w.from < WINDOW_MARGIN / 2) || (w.to < model.getLineCount() && w.to - to < WINDOW_MARGIN / 2);
  }

  function provideCodeLenses(model) {
    const none = { lenses: [], dispose() {} };
    const doc = active() && docOf(model);
    if (!doc) return none;
    const uri = model.uri.toString();
    const usages = on('usages') && ide.lsp;
    // An empty lens for a declaration not counted yet, from the first time the file is shown, so the code moves once
    // when it opens and not again when the counts come in (not when the language server failed).
    const placeholders = usages && ide.lsp.status() !== 'error';
    const authors = on('authors') && ide.trusted !== false ? blames.get(pkey(doc))?.data : null;
    const lenses = [];
    let symbols = scan(model);
    if (symbols.length > WINDOW_ALL) {
      const w = viewWindow(model);
      windows.set(model, w);
      symbols = symbols.filter((s) => s.line >= w.from && s.line <= w.to);
    } else {
      windows.delete(model);
    }
    for (const s of symbols) {
      const range = new monaco.Range(s.line, 1, s.line, model.getLineMaxColumn(s.line));
      const args = [{ uri, key: s.key }];
      if (usages) {
        const e = usageCache.get(ukey(doc, s));
        if (e && e.count !== null) {
          lenses.push({ range, command: { id: CMD_USAGES, title: usageText(e.count), tooltip: tr('Show usages of {name}', { name: s.name }), arguments: args } });
        } else if (!e && placeholders) {
          lenses.push({ range });
        }
      }
      const a = authors?.get(s.key);
      if (a) lenses.push({ range, command: { id: CMD_AUTHORS, title: authorText(a), tooltip: authorTip(a), arguments: args } });
    }
    return { lenses, dispose() {} };
  }
  monaco.languages.registerCodeLensProvider('python', { onDidChange: changed.event, provideCodeLenses });

  // A language server that has just started answers references before it has listed the project's files, with only
  // the usages in the open ones (Shape: 1 instead of 4), so counting waits for its first diagnostics, which come after
  // that. Counts of an earlier server run are asked again. Without diagnostics within WARMUP_MS it counts anyway.
  const WARMUP_MS = 15000;
  let analyzedGen = null;
  let readySince = 0;
  ide.api.on('lsp:diagnostics', (p) => {
    if (p?.gen === undefined || p.gen === analyzedGen) return;
    analyzedGen = p.gen;
    lspEpoch++;
    schedule(300);
  });
  function serverAnalyzed() {
    if (analyzedGen !== null) return true;
    if (!readySince) readySince = Date.now();
    return Date.now() - readySince > WARMUP_MS;
  }

  // ---------- the refresher ----------
  // After edits pause, or when the view moves, asks for what the editors in view are missing: one blame per file whose
  // HEAD or saved text changed, then the counts of the declarations in view that are missing or stale, one at a time.
  let runTimer = null;
  let running = false;
  let rerun = false;
  let runSource = null;
  let lastEdit = 0;
  function schedule(ms = 0) {
    clearTimeout(runTimer);
    runTimer = setTimeout(run, ms);
  }

  // Docs shown in a visible editor, with the declarations whose lens line is in view.
  function inView() {
    const out = new Map(); // path -> {doc, symbols: Set}
    for (const ed of ide.editors()) {
      const doc = docOf(ed.getModel());
      if (!doc || !ed.getContainerDomNode()?.offsetWidth) continue;
      const ranges = ed.getVisibleRanges();
      if (!ranges.length) continue;
      const k = pkey(doc);
      if (!out.has(k)) out.set(k, { doc, symbols: new Set() });
      for (const s of scan(doc.model)) {
        if (ranges.some((r) => s.line >= r.startLineNumber - 1 && s.line <= r.endLineNumber + 1)) out.get(k).symbols.add(s);
      }
    }
    return out;
  }

  async function run() {
    runTimer = null;
    if (!active() || !ide.root) return;
    const wait = lastEdit + IDLE_MS - Date.now();
    if (wait > 0) { schedule(wait); return; }
    if (running) { rerun = true; return; }
    running = true;
    stats.runs++;
    const source = new monaco.CancellationTokenSource();
    runSource = source;
    const token = source.token;
    try {
      const view = inView();
      for (const { doc } of view.values()) ensureBlame(doc);
      if (!on('usages') || !ide.lsp) return;
      const status = ide.lsp.status();
      if (status === 'starting') { ide.lsp.ready().then((ok) => ok && schedule(0)); return; }
      if (status !== 'ready') return;
      if (!serverAnalyzed()) { schedule(1000); return; }
      for (const { doc, symbols } of view.values()) {
        for (const sym of [...symbols].sort((a, b) => a.line - b.line)) {
          if (token.isCancellationRequested) return;
          if (doc.model.isDisposed() || !symbols.has(sym)) continue;
          const k = ukey(doc, sym);
          if (fresh(usageCache.get(k), sym)) continue;
          // The view may have moved on while the previous count was asked.
          const now = inView().get(pkey(doc));
          if (!now?.symbols.has(sym)) continue;
          const sig = nameSig(sym.name);
          const disk = diskEpoch;
          const lsp = lspEpoch;
          stats.references++;
          const refs = await ide.lsp.request('textDocument/references', referencesParams(doc, sym), token);
          if (token.isCancellationRequested) { stats.cancelled++; return; }
          remember(k, { count: Array.isArray(refs) ? refs.length : null, sig, disk, lsp });
          fireSoon();
        }
      }
    } finally {
      running = false;
      if (runSource === source) runSource = null;
      source.dispose();
      if (rerun) { rerun = false; schedule(0); }
    }
  }

  // Any edit of Python text cancels the run (and its request in Pyright) and waits for the next pause.
  function onEdit() {
    lastEdit = Date.now();
    runSource?.cancel();
    schedule(IDLE_MS);
  }
  const hooked = new WeakSet();
  const hook = (model) => {
    if (hooked.has(model)) return;
    hooked.add(model);
    model.onDidChangeContent(() => { if (model.getLanguageId() === 'python') onEdit(); });
  };
  monaco.editor.getModels().forEach(hook);
  monaco.editor.onDidCreateModel(hook);

  ide.onEditor((ed) => {
    ed.onDidScrollChange((e) => {
      if (!e.scrollTopChanged) return;
      if (windowStale(ed)) fireSoon();
      schedule(150);
    });
    ed.onDidChangeModel(() => schedule(50));
    ed.onDidLayoutChange(() => schedule(150));
  });

  function forget() {
    usageCache.clear();
    blames.clear();
    lspEpoch++;
    analyzedGen = null;
    readySince = 0;
    runSource?.cancel();
    changed.fire();
    schedule(100);
  }
  ide.on('projectOpened', forget);
  ide.on('projectClosed', forget);
  ide.on('interpreterChanged', () => { lspEpoch++; schedule(500); });
  ide.on('activeTabChanged', () => schedule(50));
  ide.on('fileOpened', () => schedule(50));
  ide.on('fileSaved', () => schedule(IDLE_MS));
  ide.on('fileClosed', (path) => { if (blames.delete(String(path).toLowerCase())) schedule(50); });
  ide.on('problemsChanged', () => { if (!runTimer && !running) schedule(300); });
  ide.on('vcsHeadChanged', () => schedule(100));
  ide.on('vcsBranchChanged', () => schedule(100));
  ide.on('filesChanged', () => { diskEpoch++; schedule(300); });
  // A Python file changed on disk outside the open documents (a git checkout, a tool, another editor). Writes of open
  // documents are their saves; Pyright already had that text.
  ide.api.on('watch:changed', ({ paths = [], overflow } = {}) => {
    if (overflow || paths.some((p) => isPyPath(p) && !ide.getDocument(p))) { diskEpoch++; schedule(500); }
  });
  ide.on('powerSaveChanged', () => { if (ide.powerSave.on()) runSource?.cancel(); changed.fire(); schedule(100); });
  ide.on('settingsChanged', (key) => {
    if (!Object.values(KEYS).includes(key)) return;
    if (!active()) runSource?.cancel();
    changed.fire();
    schedule(100);
  });

  // ---------- clicks ----------
  function target(arg) {
    const model = arg && monaco.editor.getModel(monaco.Uri.parse(arg.uri));
    const doc = docOf(model);
    const sym = doc && symbolByKey(model, arg.key);
    return sym ? { doc, sym } : null;
  }
  const fileCache = new Map();
  async function lineText(path, line) {
    const d = ide.getDocument(path);
    if (d?.model && !d.model.isDisposed()) return line <= d.model.getLineCount() ? d.model.getLineContent(line) : '';
    if (!fileCache.has(path)) fileCache.set(path, ide.api.read(path).then((t) => t.split(/\r?\n/)).catch(() => []));
    return (await fileCache.get(path))[line - 1] || '';
  }
  const toPath = (uri) => monaco.Uri.parse(uri).fsPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  const hint = (editor, text) => editor?.getContribution('editor.contrib.messageController')?.showMessage(text, editor.getPosition());
  const editorOf = (doc) => ide.editors().find((e) => e.getModel() === doc.model) || ide.editor;
  // A popup that keeps the items in their order (file and line, newest commit first) and filters by the typed words.
  const ordered = (items) => async (query) => {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => words.every((w) => `${it.label} ${it.detail || ''} ${it.hint || ''}`.toLowerCase().includes(w)));
  };

  // "N usages": one usage opens it; more show them in a popup (PyCharm's Show Usages), which can move them to the Find
  // tool window.
  async function showUsages(arg) {
    const t = target(arg);
    if (!t) return;
    const { doc, sym } = t;
    const refs = await ide.lsp.request('textDocument/references', referencesParams(doc, sym));
    if (!Array.isArray(refs)) return hint(editorOf(doc), tr('Cannot search for usages: Pyright is not ready'));
    remember(ukey(doc, sym), { count: refs.length, sig: nameSig(sym.name), disk: diskEpoch, lsp: lspEpoch });
    fireSoon();
    if (!refs.length) return hint(editorOf(doc), tr("No usages of '{name}' found in Project Files", { name: sym.name }));
    const go = (r) => ide.openFile(toPath(r.uri), { line: r.range.start.line + 1, col: r.range.start.character + 1, focus: true });
    if (refs.length === 1) return go(refs[0]);
    fileCache.clear();
    refs.sort((a, b) => a.uri.localeCompare(b.uri) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    const items = await Promise.all(refs.map(async (r) => {
      const path = toPath(r.uri);
      const line = r.range.start.line + 1;
      return { label: (await lineText(path, line)).trim() || basename(path), detail: `${ide.util.rel(path)}:${line}`, icon: ide.fileIcon(path), value: { ref: r } };
    }));
    items.push({ label: tr('Open in Find Tool Window'), icon: '⌕', value: { find: true } });
    const picked = await ide.ui.pick({ placeholder: tr('Usages of {name}', { name: sym.name }), items: ordered(items) });
    if (picked?.ref) go(picked.ref);
    else if (picked?.find) {
      await ide.openFile(doc.path, { line: sym.nameLine, col: sym.nameCol, focus: true });
      ide.runAction('FindUsages');
    }
  }

  // The authors: the commits that last changed the declaration's lines, newest first (each opens in the Git log), and
  // Annotate with Git Blame for the whole file.
  async function showAuthors(arg) {
    const t = target(arg);
    if (!t) return;
    const { doc, sym } = t;
    const a = blames.get(pkey(doc))?.data?.get(sym.key);
    if (!a) return;
    const items = [{ label: tr('Annotate with Git Blame'), value: { annotate: true } }];
    for (const c of a.commits) {
      items.push({ label: c.summary || c.hash.slice(0, 8), detail: `${c.author}, ${fmtDate(c.time)}`, hint: c.hash.slice(0, 8), value: { hash: c.hash } });
    }
    const picked = await ide.ui.pick({ placeholder: tr('Commits that changed {name}', { name: sym.qual }), items: ordered(items) });
    if (picked?.hash) ide.vcs?.showCommit(picked.hash);
    else if (picked?.annotate) {
      await ide.openFile(doc.path, { line: sym.nameLine, col: sym.nameCol, focus: true });
      const annotated = doc.model.getAllDecorations().some((d) => /\bvcs-blame\b/.test(d.options.linesDecorationsClassName || ''));
      if (!annotated) ide.runAction('Annotate');
    }
  }
  monaco.editor.registerCommand(CMD_USAGES, (_accessor, arg) => showUsages(arg));
  monaco.editor.registerCommand(CMD_AUTHORS, (_accessor, arg) => showAuthors(arg));

  // ---------- Settings › Editor › Code Vision ----------
  (ide.settingsPages ||= []).push({
    id: 'code-vision', group: 'editor', title: () => tr('Code Vision'), defaults: DEFAULTS,
    keywords: 'code vision inlay hints usages author git blame 코드 비전 인레이 힌트 사용 위치 작성자',
    mount(host, ctx) {
      const s = ctx.ui.section(host, 'Python');
      s.appendChild(ctx.ui.checkbox(KEYS.usages, tr('Usages')));
      s.appendChild(ctx.ui.checkbox(KEYS.authors, tr('Code author (Git)')));
      host.appendChild(Object.assign(document.createElement('div'), {
        className: 'muted settings-note',
        textContent: tr('Shown above classes and functions. Usages come from Pyright and are counted only for the code in view; authors come from git blame in trusted projects. Code vision is off in Power Save Mode.'),
      }));
    },
  });

  ide.codeVision = {
    symbols: (model) => scan(model),
    // The lenses as the provider returns them now: [{line, kind: 'usages' | 'authors' | 'pending', title}].
    lenses: (model) => provideCodeLenses(model).lenses.map((l) => ({
      line: l.range.startLineNumber,
      kind: !l.command ? 'pending' : l.command.id === CMD_USAGES ? 'usages' : 'authors',
      title: l.command?.title ?? null,
      key: l.command?.arguments?.[0]?.key ?? null,
    })),
    stats: () => ({ ...stats, running, scheduled: !!runTimer }),
    refresh: () => schedule(0),
    showUsages, showAuthors,
  };
})();
