// Code intelligence from the bundled Pyright language server (main/features/lsp.js runs the server).
(() => {
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const monaco = ide.monaco;
  const SOURCE = 'pyright';
  const HINT_OWNER = 'pyright.hints';
  const PROBE_NAME = '__pyide_probe__.py';
  const CHANGE_DEBOUNCE = 300;

  // ---------- uris, positions, ranges ----------
  const toUri = (p) => monaco.Uri.file(p).toString();
  // file:///c%3A/x.py -> C:\x.py; file://server/share/x.py (UNC) -> \\server\share\x.py
  const toPath = (uri) => decodeURIComponent(String(uri).replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '//'))
    .replace(/\//g, '\\').replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  const isPy = (p) => /\.pyi?$/i.test(p || '');
  const lspPos = (pos) => ({ line: pos.lineNumber - 1, character: pos.column - 1 });
  const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  const modelPath = (model) => (model?.uri.scheme === 'file' ? toPath(model.uri.toString()) : null);
  const inRange = (r, pos) => {
    const l = pos.lineNumber - 1;
    const c = pos.column - 1;
    if (l < r.start.line || l > r.end.line) return false;
    if (l === r.start.line && c < r.start.character) return false;
    return !(l === r.end.line && c > r.end.character);
  };

  const toMarkdown = (contents) => {
    if (!contents) return '';
    if (Array.isArray(contents)) return contents.map(toMarkdown).filter(Boolean).join('\n\n---\n\n');
    if (typeof contents === 'string') return contents;
    if (contents.kind === 'plaintext') return contents.value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, '\\$&');
    if (contents.language) return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
    return contents.value || '';
  };
  const docOf = (d) => (d ? { value: toMarkdown(d) } : undefined);

  // ---------- server lifecycle & status ----------
  let status = 'off';
  let gen = 0;
  let incremental = false; // the server takes edits (TextDocumentSyncKind.Incremental), not only the whole text
  let serverKey = null;
  let startSeq = 0; // the latest start; an earlier one still in flight was superseded
  let readyWaiters = [];

  // Each status text is a complete entry in the locale files.
  const STATUS_TEXT = {
    off: () => tr('Pyright: off'), starting: () => tr('Pyright: starting'),
    ready: () => tr('Pyright: ready'), error: () => tr('Pyright: error'),
  };
  const statusTitle = (message) => tr('{message}. Click to restart.', { message: message || tr('Pyright language server') });
  const statusEl = el('span', 'lsp-status', STATUS_TEXT.off());
  statusEl.id = 'lspStatus';
  statusEl.title = statusTitle();
  statusEl.onclick = () => restart();
  ide.registerStatusItem({ order: 20, el: statusEl });

  function setStatus(state, message) {
    status = state;
    statusEl.textContent = STATUS_TEXT[state]();
    statusEl.dataset.state = state;
    statusEl.title = statusTitle(message);
    if (state === 'ready' || state === 'error' || state === 'off') {
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const w of waiters) w(state === 'ready');
    }
  }

  const ready = () => (status === 'ready' ? Promise.resolve(true)
    : status === 'starting' ? new Promise((r) => readyWaiters.push(r)) : Promise.resolve(false));

  async function ensureServer(force) {
    const root = ide.root;
    if (!root) return;
    const python = ide.currentInterp()?.executable || null;
    const key = `${root}|${python}`;
    if (!force && key === serverKey) return;
    serverKey = key;
    const my = ++startSeq;
    for (const doc of docs.values()) doc.opened = 0;
    ide.problems.clear(SOURCE);
    for (const tab of ide.tabs) if (tab.model) monaco.editor.setModelMarkers(tab.model, HINT_OWNER, []);
    rawDiagnostics.clear();
    probeCache.clear();
    setStatus('starting', tr('Starting Pyright for {name}', { name: basename(root) }));
    let started = null;
    try { started = await ide.api.invoke('lsp:start', root, python); } catch (err) { console.warn('pyright failed to start', err); }
    // A restart while this start was in flight stopped its server; that is not a failure to report.
    if (my !== startSeq) return;
    if (!started) return setStatus('error', tr('Pyright failed to start'));
    ({ gen, incremental } = started);
    for (const doc of docs.values()) sendOpen(doc);
    setStatus('ready', python ? tr('Pyright ready ({python})', { python }) : tr('Pyright ready'));
  }
  const restart = () => ensureServer(true);

  // main/features/lsp.js reports 'Pyright exited with code N', 'Pyright stopped' or a raw system error.
  const serverError = (message = '') => {
    const exit = /^Pyright exited with code (.*)$/.exec(message);
    if (exit) return tr('Pyright exited with code {code}', { code: exit[1] });
    if (message === 'Pyright stopped') return tr('Pyright stopped');
    return tr('Pyright error: {message}', { message });
  };
  ide.api.on('lsp:status', (p) => {
    if (p.gen === gen && p.state === 'error') setStatus('error', serverError(p.message));
  });
  ide.api.on('lsp:message', (p) => {
    if (p.gen === gen && p.type === 1) console.warn(`Pyright: ${p.message}`);
  });

  const notify = (method, params) => ide.api.invoke('lsp:notify', method, params).catch(() => {});

  // Resolves to the result, or null when the server is unavailable or the request failed.
  async function request(method, params) {
    flushAll();
    if (!(await ready())) return null;
    try {
      return await ide.api.invoke('lsp:request', method, params);
    } catch (err) {
      console.warn(`pyright ${method} failed:`, err.message);
      return null;
    }
  }

  // ---------- document sync ----------
  // pathLower -> {path, uri, model, opened (gen), timer, pending, changes, sub}. changes: the edits since the last
  // sync, in order, or null when the whole text has to be sent.
  const docs = new Map();
  // More edits than this in one sync (a Replace All) are sent as the whole text.
  const MAX_CHANGES = 1000;

  function sendOpen(doc) {
    if (status === 'off' || !gen || doc.model.isDisposed()) return;
    clearTimeout(doc.timer);
    doc.pending = false;
    doc.changes = [];
    doc.opened = gen;
    notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: 'python', version: doc.model.getVersionId(), text: doc.model.getValue() } });
  }

  function flush(doc) {
    clearTimeout(doc.timer);
    if (!doc.pending || doc.opened !== gen || doc.model.isDisposed()) return;
    const changes = doc.changes || [{ text: doc.model.getValue() }];
    doc.pending = false;
    doc.changes = [];
    notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.model.getVersionId() }, contentChanges: changes });
  }
  const flushAll = () => docs.forEach(flush);

  // Monaco lists an event's edits from the end of the document to the start, so applied in order they give the new
  // text; its columns count UTF-16 code units, as LSP positions do.
  function recordChanges(doc, e) {
    if (!doc.changes) return;
    if (!incremental || e.isFlush || e.isEolChange) { doc.changes = null; return; }
    for (const c of e.changes) {
      doc.changes.push({
        range: { start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 }, end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 } },
        text: c.text,
      });
    }
    if (doc.changes.length > MAX_CHANGES) doc.changes = null;
  }

  function trackTab(tab) {
    if (tab?.kind !== 'file' || !isPy(tab.path) || docs.has(tab.path.toLowerCase())) return;
    const doc = { path: tab.path, uri: tab.model.uri.toString(), model: tab.model, opened: 0, pending: false, changes: [], timer: null };
    doc.sub = tab.model.onDidChangeContent((e) => {
      if (doc.opened !== gen) return;
      recordChanges(doc, e);
      doc.pending = true;
      clearTimeout(doc.timer);
      doc.timer = setTimeout(() => flush(doc), CHANGE_DEBOUNCE);
    });
    docs.set(tab.path.toLowerCase(), doc);
    if (status === 'ready') sendOpen(doc);
  }

  ide.on('fileOpened', trackTab);
  ide.on('fileSaved', (tab) => {
    const doc = docs.get(tab.path.toLowerCase());
    if (!doc || doc.opened !== gen) return;
    flush(doc);
    notify('textDocument/didSave', { textDocument: { uri: doc.uri } });
  });
  ide.on('fileClosed', (path) => {
    const doc = docs.get(path.toLowerCase());
    if (!doc) return;
    docs.delete(path.toLowerCase());
    clearTimeout(doc.timer);
    doc.sub.dispose();
    if (doc.opened === gen && status === 'ready') notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
  });
  ide.on('projectOpened', () => ensureServer());
  ide.on('interpreterChanged', () => ensureServer());
  // Pyright holds the closed project's analysis (hundreds of MB on a large one); the welcome screen needs none.
  ide.on('projectClosed', () => {
    startSeq++;
    serverKey = null;
    ide.problems.clear(SOURCE);
    rawDiagnostics.clear();
    probeCache.clear();
    ide.api.invoke('lsp:stop').catch(() => {});
    setStatus('off');
  });

  const docFor = (model) => {
    const p = modelPath(model);
    const doc = p && docs.get(p.toLowerCase());
    return doc && doc.opened === gen && status === 'ready' ? doc : null;
  };

  // ---------- diagnostics ----------
  const rawDiagnostics = new Map(); // pathLower -> LSP diagnostics
  const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info' };

  ide.api.on('lsp:diagnostics', (p) => {
    if (p.gen !== gen || status === 'off') return;
    const path = toPath(p.uri);
    if (basename(path) === PROBE_NAME) return;
    rawDiagnostics.set(path.toLowerCase(), p.diagnostics);
    // Hints (unused names, deprecated) are greyed out in the editor like PyCharm, not listed as problems.
    const isHint = (d) => !d.severity || d.severity === 4;
    ide.problems.set(SOURCE, path, p.diagnostics.filter((d) => !isHint(d)).map((d) => ({
      line: d.range.start.line + 1, col: d.range.start.character + 1,
      endLine: d.range.end.line + 1, endCol: d.range.end.character + 1,
      msg: d.message, severity: SEVERITY[d.severity] || 'info',
    })));
    const tab = ide.findTab(path);
    if (tab?.model && !tab.model.isDisposed()) {
      monaco.editor.setModelMarkers(tab.model, HINT_OWNER, p.diagnostics.filter(isHint).map((d) => ({
        startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
        message: d.message, severity: monaco.MarkerSeverity.Hint, source: SOURCE,
        tags: (d.tags || []).filter((t) => t === 1 || t === 2),
      })));
    }
  });

  // ---------- workspace edits ----------
  function applyTextEdits(text, edits) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const off = (p) => Math.min((starts[p.line] ?? text.length) + p.character, text.length);
    const sorted = edits.map((e) => ({ s: off(e.range.start), e: off(e.range.end), t: e.newText }))
      .sort((a, b) => b.s - a.s || b.e - a.e);
    for (const e of sorted) text = text.slice(0, e.s) + e.t + text.slice(e.e);
    return text;
  }

  function editsByUri(we) {
    const out = new Map();
    const add = (uri, edits) => out.set(uri, [...(out.get(uri) || []), ...edits]);
    for (const [uri, edits] of Object.entries(we?.changes || {})) add(uri, edits);
    for (const dc of we?.documentChanges || []) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
    return out;
  }

  // Pyright reads a closed file from disk as UTF-8, so its positions are in that text. A CP949 file is rewritten in
  // CP949 (writing it as UTF-8 broke it), which is only safe where the text before each edit on its line is ASCII:
  // there both readings agree. Otherwise, and for UTF-16, the edit is refused rather than applied at wrong columns.
  const ASCII = /^[\x00-\x7f]*$/;
  function closedFileEdit(file, edits) {
    if (file.encoding === 'utf-8') return applyTextEdits(file.text, edits);
    // Node's UTF-8 reading keeps the BOM as U+FEFF, and line 0's columns count it.
    if (file.encoding === 'utf-8-bom') return applyTextEdits(`﻿${file.text}`, edits).replace(/^﻿/, '');
    if (file.encoding !== 'cp949') return null;
    const lines = file.text.split('\n');
    const asciiBefore = (p) => ASCII.test((lines[p.line] ?? '').slice(0, p.character));
    return edits.every((e) => asciiBefore(e.range.start) && asciiBefore(e.range.end)) ? applyTextEdits(file.text, edits) : null;
  }

  // Applies edits to open models (undoable) and rewrites closed files on disk, in their own encoding. With
  // keepOpenEdits the edits for open models are returned as Monaco workspace edits instead (rename applies them
  // itself). Nothing is applied when a closed file cannot take its edits: {refused} says why.
  async function applyWorkspaceEdit(we, { keepOpenEdits = false } = {}) {
    const closed = [];
    for (const [uri, edits] of editsByUri(we)) {
      const path = toPath(uri);
      if (ide.findTab(path)?.model) continue;
      let file;
      try {
        file = await ide.api.invoke('fs:readText', path);
      } catch (err) {
        console.warn(`could not apply edit to ${path}`, err);
        continue;
      }
      if (file.text === undefined) {
        console.warn(`could not apply edit to ${path}: binary or too large`);
        continue;
      }
      const text = closedFileEdit(file, edits);
      if (text === null) {
        return { edits: [], written: [], refused: tr('{name} cannot be changed: it is not a UTF-8 file and the change is on a line with non-ASCII text.', { name: basename(path) }) };
      }
      closed.push({ path, text, encoding: file.encoding });
    }
    await ide.localHistory?.checkpoint('Before Refactoring', { paths: [...editsByUri(we).keys()].map(toPath) });
    const monacoEdits = [];
    const written = [];
    for (const [uri, edits] of editsByUri(we)) {
      const tab = ide.findTab(toPath(uri));
      if (!tab?.model) continue;
      const ops = edits.map((e) => ({ range: toRange(e.range), text: e.newText }));
      if (keepOpenEdits) for (const op of ops) monacoEdits.push({ resource: tab.model.uri, textEdit: op, versionId: undefined });
      else tab.model.pushEditOperations([], ops, () => null);
    }
    for (const { path, text, encoding } of closed) {
      try {
        await ide.api.invoke('fs:writeText', path, text, encoding);
        written.push(path);
      } catch (err) {
        console.warn(`could not apply edit to ${path}`, err);
      }
    }
    if (written.length) await ide.reloadFromDisk(written);
    if (!keepOpenEdits) ide.renderTabs();
    return { edits: monacoEdits, written };
  }
  const applyOrExplain = async (we) => {
    const { refused } = await applyWorkspaceEdit(we);
    if (refused) ide.ui.alert(refused);
  };
  ide.api.on('lsp:applyEdit', (p) => { if (p.gen === gen) applyOrExplain(p.edit).catch((err) => console.warn('workspace edit failed', err)); });

  // ---------- Monaco providers ----------
  const K = monaco.languages.CompletionItemKind;
  const LSP_KIND = [null, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module,
    K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember,
    K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];
  // The core already contributes keyword completions; skip Pyright's copies so they do not show twice.
  const coreKeywords = new Set(typeof PY_KEYWORDS !== 'undefined' ? PY_KEYWORDS : []);
  const monacoEdit = (e) => ({ range: toRange(e.range), text: e.newText });

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, context, token) {
      const doc = docFor(model);
      if (!doc) return undefined;
      const res = await request('textDocument/completion', {
        textDocument: { uri: doc.uri }, position: lspPos(position),
        context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
      });
      if (!res || token.isCancellationRequested || model.isDisposed()) return undefined;
      const items = Array.isArray(res) ? res : res.items || [];
      const word = model.getWordUntilPosition(position);
      const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
      const suggestions = items.filter((it) => !(it.kind === 14 && coreKeywords.has(it.label))).map((it) => {
        let range = wordRange;
        let insertText = it.insertText ?? it.label;
        if (it.textEdit) {
          insertText = it.textEdit.newText;
          range = it.textEdit.range ? toRange(it.textEdit.range) : { insert: toRange(it.textEdit.insert), replace: toRange(it.textEdit.replace) };
        }
        return {
          label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
          kind: LSP_KIND[it.kind] ?? K.Text,
          detail: it.detail,
          documentation: docOf(it.documentation),
          sortText: it.sortText,
          filterText: it.filterText,
          insertText,
          insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range,
          additionalTextEdits: it.additionalTextEdits?.map(monacoEdit),
          tags: it.deprecated || it.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
          commitCharacters: it.commitCharacters,
          lsp: it,
        };
      });
      return { suggestions, incomplete: !!res.isIncomplete };
    },
    async resolveCompletionItem(item, token) {
      if (!item.lsp || item.lsp.documentation) return item;
      const r = await request('completionItem/resolve', item.lsp);
      if (!r || token.isCancellationRequested) return item;
      if (r.documentation) item.documentation = docOf(r.documentation);
      if (r.detail) item.detail = r.detail;
      if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(monacoEdit);
      return item;
    },
  });

  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, position, token) {
      const doc = docFor(model);
      if (!doc) return undefined;
      const r = await request('textDocument/hover', { textDocument: { uri: doc.uri }, position: lspPos(position) });
      if (!r?.contents || token.isCancellationRequested) return undefined;
      const value = toMarkdown(r.contents);
      return value ? { contents: [{ value }], range: r.range ? toRange(r.range) : undefined } : undefined;
    },
  });

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position, token, context) {
      const doc = docFor(model);
      if (!doc) return undefined;
      const r = await request('textDocument/signatureHelp', {
        textDocument: { uri: doc.uri }, position: lspPos(position),
        context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger },
      });
      if (!r?.signatures?.length || token.isCancellationRequested) return undefined;
      return {
        value: {
          activeSignature: r.activeSignature ?? 0,
          activeParameter: r.signatures[r.activeSignature ?? 0]?.activeParameter ?? r.activeParameter ?? 0,
          signatures: r.signatures.map((s) => ({
            label: s.label,
            documentation: docOf(s.documentation),
            activeParameter: s.activeParameter,
            parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: docOf(p.documentation) })),
          })),
        },
        dispose() {},
      };
    },
  });

  const toLocations = (res) => (res ? (Array.isArray(res) ? res : [res]) : []).map((l) => ({
    uri: l.targetUri || l.uri,
    range: l.targetSelectionRange || l.range,
    fullRange: l.targetRange || l.range,
    origin: l.originSelectionRange,
  }));
  const toMonacoLinks = (locs) => locs.map((l) => ({
    uri: monaco.Uri.parse(l.uri), range: toRange(l.fullRange), targetSelectionRange: toRange(l.range),
    originSelectionRange: l.origin ? toRange(l.origin) : undefined,
  }));
  const locationProvider = (method) => async (model, position, token) => {
    const doc = docFor(model);
    if (!doc) return undefined;
    const r = await request(method, { textDocument: { uri: doc.uri }, position: lspPos(position) });
    return token.isCancellationRequested ? undefined : toMonacoLinks(toLocations(r));
  };
  monaco.languages.registerDefinitionProvider('python', { provideDefinition: locationProvider('textDocument/definition') });
  monaco.languages.registerTypeDefinitionProvider('python', { provideTypeDefinition: locationProvider('textDocument/typeDefinition') });

  monaco.languages.registerReferenceProvider('python', {
    async provideReferences(model, position, context, token) {
      const doc = docFor(model);
      if (!doc) return undefined;
      const r = await request('textDocument/references', { textDocument: { uri: doc.uri }, position: lspPos(position), context: { includeDeclaration: context.includeDeclaration } });
      return token.isCancellationRequested ? undefined : (r || []).map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
    },
  });

  monaco.languages.registerDocumentHighlightProvider('python', {
    async provideDocumentHighlights(model, position, token) {
      const doc = docFor(model);
      if (!doc) return undefined;
      const r = await request('textDocument/documentHighlight', { textDocument: { uri: doc.uri }, position: lspPos(position) });
      if (!r || token.isCancellationRequested) return undefined;
      return r.map((h) => ({ range: toRange(h.range), kind: (h.kind || 1) - 1 }));
    },
  });

  const SYMBOL_KINDS = ['', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum',
    'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null',
    'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];
  const toMonacoSymbol = (s) => ({
    name: s.name, detail: s.detail || '', kind: s.kind - 1, tags: [],
    range: toRange(s.range), selectionRange: toRange(s.selectionRange || s.range),
    children: (s.children || []).map(toMonacoSymbol),
  });
  monaco.languages.registerDocumentSymbolProvider('python', {
    displayName: 'Pyright',
    async provideDocumentSymbols(model, token) {
      const doc = docFor(model);
      if (!doc) return undefined;
      const r = await request('textDocument/documentSymbol', { textDocument: { uri: doc.uri } });
      return !r || token.isCancellationRequested ? undefined : r.filter((s) => s.range).map(toMonacoSymbol);
    },
  });

  // Hierarchical DocumentSymbols (LSP shape) plus kindName and 1-based line/col of the name, for other features.
  async function documentSymbols(path) {
    const doc = docs.get(path.toLowerCase());
    const r = await request('textDocument/documentSymbol', { textDocument: { uri: doc?.uri || toUri(path) } });
    const decorate = (s) => {
      const sel = s.selectionRange || s.range || s.location?.range;
      return { ...s, kindName: SYMBOL_KINDS[s.kind] || 'Symbol', line: sel.start.line + 1, col: sel.start.character + 1, children: (s.children || []).map(decorate) };
    };
    return (r || []).map(decorate);
  }

  monaco.languages.registerRenameProvider('python', {
    async resolveRenameLocation(model, position) {
      const doc = docFor(model);
      const r = doc && await request('textDocument/prepareRename', { textDocument: { uri: doc.uri }, position: lspPos(position) });
      const word = model.getWordAtPosition(position);
      const fallback = new monaco.Range(position.lineNumber, word?.startColumn || position.column, position.lineNumber, word?.endColumn || position.column);
      if (!r) return { range: fallback, text: word?.word || '', rejectReason: tr('This element cannot be renamed') };
      const range = toRange(r.range || r);
      return { range, text: r.placeholder || model.getValueInRange(range) };
    },
    async provideRenameEdits(model, position, newName) {
      const doc = docFor(model);
      if (!/^[A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*$/.test(newName)) return { edits: [], rejectReason: tr("'{name}' is not a valid identifier", { name: newName }) };
      const we = doc && await request('textDocument/rename', { textDocument: { uri: doc.uri }, position: lspPos(position), newName });
      if (!we) return { edits: [], rejectReason: tr('Rename failed') };
      const { edits, refused } = await applyWorkspaceEdit(we, { keepOpenEdits: true });
      return refused ? { edits: [], rejectReason: refused } : { edits };
    },
  });

  // ---------- quick fixes (Alt+Enter) ----------
  const APPLY_ACTION = 'pyide.lsp.applyCodeAction';
  monaco.editor.registerCommand(APPLY_ACTION, async (_accessor, action) => {
    if (action.edit) await applyOrExplain(action.edit);
    const cmd = typeof action.command === 'string' ? action : action.command;
    if (cmd?.command) await request('workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments });
  });

  // Module names are checked once per server by hovering an import in a scratch document Pyright never sees on disk.
  const probeCache = new Map();
  let probeChain = Promise.resolve();
  function isImportableModule(name) {
    if (probeCache.has(name)) return probeCache.get(name);
    const p = (probeChain = probeChain.then(async () => {
      const uri = toUri(joinPath(ide.root, PROBE_NAME));
      await notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text: `import ${name}\n` } });
      const r = await request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 7 } });
      await notify('textDocument/didClose', { textDocument: { uri } });
      return /\(module\)/.test(toMarkdown(r?.contents));
    }).catch(() => false));
    probeCache.set(name, p);
    return p;
  }

  const moduleNameOf = (path) => ide.util.rel(path).replace(/\.pyi?$/i, '').replace(/[\\/]__init__$/, '').split(/[\\/]/).join('.');

  async function importCandidates(name, path) {
    const out = [];
    const symbols = (await request('workspace/symbol', { query: name })) || [];
    for (const s of symbols) {
      const file = toPath(s.location.uri);
      if (s.name !== name || s.containerName || samePath(file, path) || ![5, 12, 13, 14].includes(s.kind)) continue;
      if (!ide.root || !file.toLowerCase().startsWith(ide.root.toLowerCase())) continue;
      const mod = moduleNameOf(file);
      if (!out.some((c) => c.module === mod)) out.push({ title: tr("Import '{name}' from '{module}'", { name, module: mod }), line: `from ${mod} import ${name}` });
    }
    if (await isImportableModule(name)) out.unshift({ title: tr("Import '{name}'", { name }), line: `import ${name}` });
    return out;
  }

  // Inserts after the module docstring and existing top-level imports, as PyCharm's auto-import does.
  function importInsertLine(model) {
    const n = model.getLineCount();
    const text = (i) => model.getLineContent(i);
    let i = 1;
    let after = 0;
    while (i <= n && (!text(i).trim() || text(i).startsWith('#'))) i++;
    const doc = i <= n && /^[rRuUbB]*("""|''')/.exec(text(i));
    if (doc) {
      let j = i;
      if (text(i).split(doc[1]).length < 3) while (j < n && !text(++j).includes(doc[1]));
      after = j;
      i = j + 1;
    }
    for (; i <= n; i++) {
      const t = text(i);
      if (/^(import|from)\s/.test(t)) {
        if (t.includes('(') && !t.includes(')')) while (i < n && !text(++i).includes(')'));
        after = i;
      } else if (t.trim() && !t.startsWith('#')) break;
    }
    return after + 1;
  }

  monaco.languages.registerCodeActionProvider('python', {
    async provideCodeActions(model, range, context, token) {
      const doc = docFor(model);
      if (!doc) return undefined;
      const diags = (rawDiagnostics.get(doc.path.toLowerCase()) || [])
        .filter((d) => d.range.start.line + 1 <= range.endLineNumber && d.range.end.line + 1 >= range.startLineNumber);
      const actions = [];
      // The lightbulb asks on every caret move; answer it synchronously from the cached diagnostics and leave
      // the server round trips (Pyright actions, import lookup) to an explicit Alt+Enter.
      const invoked = context.trigger === monaco.languages.CodeActionTriggerType.Invoke;
      const lspActions = invoked && await request('textDocument/codeAction', {
        textDocument: { uri: doc.uri },
        range: { start: lspPos(range.getStartPosition()), end: lspPos(range.getEndPosition()) },
        context: { diagnostics: diags, triggerKind: context.trigger === 1 ? 1 : 2 },
      });
      for (const a of lspActions || []) {
        actions.push({ title: a.title, kind: a.kind || 'quickfix', isPreferred: a.isPreferred, command: { id: APPLY_ACTION, title: a.title, arguments: [a] } });
      }
      for (const d of diags) {
        const undefinedName = d.code === 'reportUndefinedVariable' && /"([\w]+)" is not defined/.exec(d.message)?.[1];
        if (undefinedName && invoked) {
          const at = importInsertLine(model);
          const last = model.getLineCount();
          for (const c of await importCandidates(undefinedName, doc.path)) {
            const textEdit = at > last
              ? { range: new monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last)), text: `\n${c.line}` }
              : { range: new monaco.Range(at, 1, at, 1), text: `${c.line}\n` };
            actions.push({
              title: c.title, kind: 'quickfix', isPreferred: !actions.some((a) => a.isPreferred), diagnostics: [],
              edit: { edits: [{ resource: model.uri, versionId: undefined, textEdit }] },
            });
          }
        }
        if (d.code && d.source !== 'Pylance') {
          const line = d.range.start.line + 1;
          if (line > model.getLineCount()) continue;
          const end = model.getLineMaxColumn(line);
          const text = model.getLineContent(line);
          const existing = /# pyright: ignore\[([^\]]*)\]/.exec(text);
          if (existing?.[1].split(',').map((s) => s.trim()).includes(d.code)) continue;
          // Extend an existing ignore comment (before its closing bracket) rather than adding a second one.
          const at = existing ? existing.index + existing[0].length : end;
          const edit = { range: new monaco.Range(line, at, line, at), text: existing ? `, ${d.code}` : `  # pyright: ignore[${d.code}]` };
          actions.push({ title: tr("Suppress '{code}' for statement", { code: d.code }), kind: 'quickfix', edit: { edits: [{ resource: model.uri, versionId: undefined, textEdit: edit }] } });
        }
      }
      if (token.isCancellationRequested) return undefined;
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  // Cross-file navigation from Monaco itself (Ctrl+Click, peek) goes through the IDE's tabs.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, sel) {
      if (resource.scheme !== 'file') return false;
      const line = sel ? sel.startLineNumber ?? sel.lineNumber : undefined;
      const col = sel ? sel.startColumn ?? sel.column : undefined;
      ide.openFile(toPath(resource.toString()), { line, col });
      return true;
    },
  });

  // ---------- actions ----------
  const editorPython = () => !!ide.editor?.hasTextFocus() && isPy(modelPath(ide.editor.getModel()));
  const editorTrigger = (id) => () => ide.editor.trigger('keyboard', id, null);
  const hint = (text) => {
    const ctl = ide.editor.getContribution('editor.contrib.messageController');
    if (ctl) ctl.showMessage(text, ide.editor.getPosition());
  };

  function cursorContext() {
    const model = ide.editor?.getModel();
    const doc = model && docFor(model);
    const position = ide.editor.getPosition();
    return doc && position ? { doc, model, position, params: { textDocument: { uri: doc.uri }, position: lspPos(position) } } : null;
  }

  const navigate = (loc) => ide.openFile(toPath(loc.uri), { line: loc.range.start.line + 1, col: loc.range.start.character + 1 });

  async function chooseAndNavigate(locs, title) {
    if (locs.length === 1) return navigate(locs[0]);
    fileCache.clear();
    const lines = await Promise.all(locs.map((l) => lineText(toPath(l.uri), l.range.start.line + 1)));
    const picked = await ide.ui.pick({
      placeholder: title,
      items: locs.map((l, i) => ({ label: lines[i].trim() || basename(toPath(l.uri)), detail: `${ide.util.rel(toPath(l.uri))}:${l.range.start.line + 1}`, icon: ide.fileIcon(toPath(l.uri)), value: l })),
    });
    if (picked) navigate(picked);
  }

  async function gotoDeclaration() {
    const ctx = cursorContext();
    if (!ctx) return;
    const locs = toLocations(await request('textDocument/definition', ctx.params));
    if (!locs.length) return hint(tr('Cannot find declaration to go to'));
    // On the declaration itself Ctrl+B shows its usages, as in PyCharm.
    if (locs.length === 1 && samePath(toPath(locs[0].uri), ctx.doc.path) && inRange(locs[0].range, ctx.position)) return findUsages();
    return chooseAndNavigate(locs, tr('Choose Declaration'));
  }

  async function gotoTypeDeclaration() {
    const ctx = cursorContext();
    if (!ctx) return;
    const locs = toLocations(await request('textDocument/typeDefinition', ctx.params));
    if (!locs.length) return hint(tr('Cannot find type declaration to go to'));
    return chooseAndNavigate(locs, tr('Choose Type Declaration'));
  }

  // Next/previous highlighted problem in the current file (F2 / Shift+F2), with its description shown.
  // Like PyCharm's "go to errors first": while the file has errors, warnings are skipped.
  function gotoProblem(dir) {
    const model = ide.editor?.getModel();
    if (!model) return;
    const all = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.severity >= monaco.MarkerSeverity.Info);
    const errors = all.filter((m) => m.severity === monaco.MarkerSeverity.Error);
    const markers = (errors.length ? errors : all)
      .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
    if (!markers.length) return hint(tr('No problems found'));
    const pos = ide.editor.getPosition();
    const cmp = (m) => m.startLineNumber - pos.lineNumber || m.startColumn - pos.column;
    const target = dir > 0 ? markers.find((m) => cmp(m) > 0) || markers[0] : [...markers].reverse().find((m) => cmp(m) < 0) || markers[markers.length - 1];
    const p = { lineNumber: target.startLineNumber, column: target.startColumn };
    ide.editor.setPosition(p);
    ide.editor.revealPositionInCenterIfOutsideViewport(p);
    ide.editor.trigger('keyboard', 'editor.action.showHover', null);
  }

  // ---------- Find tool window (usages) ----------
  let findList;
  let findHead;
  const findTw = ide.registerToolWindow({
    id: 'FindUsages', title: tr('Find'), icon: '⌕', side: 'bottom', order: 18,
    mount(container) {
      findHead = el('div', 'lsp-find-head muted');
      findHead.append(ide.keymap.text(el('span'), () => tr('Use {action} on a symbol to find its usages', { action: ide.keymap.withKeys(tr('Find Usages'), 'FindUsages') })));
      findList = el('div', 'list lsp-find');
      findList.id = 'lspFindList';
      container.append(findHead, findList);
    },
  });

  const fileCache = new Map();
  async function lineText(path, line) {
    const tab = ide.findTab(path);
    if (tab?.model && !tab.model.isDisposed()) return line <= tab.model.getLineCount() ? tab.model.getLineContent(line) : '';
    if (!fileCache.has(path)) fileCache.set(path, ide.api.read(path).then((t) => t.split(/\r?\n/)).catch(() => []));
    return (await fileCache.get(path))[line - 1] || '';
  }

  // Symbol names, file names and code lines are data, not UI text (verify/i18n-lib.mjs skips them).
  const userText = (node) => ((node.dataset.userText = ''), node);
  const usageCount = (count) => (count === 1 ? tr('1 usage') : tr('{count} usages', { count }));
  const usageTotal = (count, files) => (count === 1 ? tr('1 usage in 1 file')
    : files === 1 ? tr('{count} usages in 1 file', { count }) : tr('{count} usages in {files} files', { count, files }));

  async function findUsages() {
    const ctx = cursorContext();
    if (!ctx) return;
    const word = ctx.model.getWordAtPosition(ctx.position)?.word || '';
    const refs = await request('textDocument/references', { ...ctx.params, context: { includeDeclaration: false } });
    if (!refs) return hint(tr('Cannot search for usages: Pyright is not ready'));
    if (!refs.length) return hint(tr("No usages of '{name}' found in Project Files", { name: word }));
    fileCache.clear();
    const groups = new Map();
    for (const r of refs) {
      const path = toPath(r.uri);
      if (!groups.has(path.toLowerCase())) groups.set(path.toLowerCase(), { path, refs: [] });
      groups.get(path.toLowerCase()).refs.push(r);
    }
    const sorted = [...groups.values()].sort((a, b) => ide.util.rel(a.path).localeCompare(ide.util.rel(b.path)));
    // The symbol is bold wherever the translation places {name}.
    const [before, after = ''] = tr('Usages of {name}').split('{name}');
    const sym = userText(el('b', 'lsp-find-sym', word));
    findHead.replaceChildren(el('span', null, before), sym, el('span', null, after),
      el('span', 'muted', `  ${usageTotal(refs.length, sorted.length)}`));
    findHead.classList.remove('muted');
    const frag = document.createDocumentFragment();
    for (const g of sorted) {
      g.refs.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
      const head = el('div', 'list-row lsp-find-file');
      const arrow = el('span', 'arrow', '▾');
      const rel = ide.util.rel(g.path);
      const dir = /[\\/]/.test(rel) ? dirname(rel) : '';
      head.append(arrow, Object.assign(ide.fileIcon(g.path), { className: 'file-icon icon' }), userText(el('span', 'name', basename(g.path))),
        userText(el('span', 'muted', dir ? `  ${dir}` : '')), el('span', 'muted', `  ${usageCount(g.refs.length)}`));
      const rows = el('div', 'lsp-find-rows');
      head.onclick = () => { rows.classList.toggle('hidden'); arrow.textContent = rows.classList.contains('hidden') ? '▸' : '▾'; };
      for (const r of g.refs) {
        const line = r.range.start.line + 1;
        const text = await lineText(g.path, line);
        const s = r.range.start.character;
        const e = r.range.end.line === r.range.start.line ? r.range.end.character : text.length;
        const lead = text.length - text.trimStart().length;
        const row = el('div', 'list-row lsp-find-row');
        row.dataset.path = g.path;
        row.dataset.line = line;
        const code = userText(el('span', 'code'));
        code.append(text.slice(lead, s), el('span', 'hit', text.slice(s, e)), text.slice(e).trimEnd());
        row.append(el('span', 'ln', String(line)), code);
        row.onclick = () => {
          findList.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
          row.classList.add('selected');
          navigate(r);
        };
        rows.appendChild(row);
      }
      frag.append(head, rows);
    }
    findList.replaceChildren(frag);
    findTw.show();
    findTw.setBadge(String(refs.length));
  }

  [
    { id: 'GotoDeclaration', title: tr('Go to Declaration or Usages'), keys: 'Ctrl+B', when: editorPython, run: gotoDeclaration },
    { id: 'GotoTypeDeclaration', title: tr('Go to Type Declaration'), keys: 'Ctrl+Alt+B', when: editorPython, run: gotoTypeDeclaration },
    { id: 'FindUsages', title: tr('Find Usages'), keys: 'Alt+F7', when: editorPython, run: findUsages },
    { id: 'RenameElement', title: tr('Rename…'), keys: 'Shift+F6', when: editorPython, run: editorTrigger('editor.action.rename') },
    { id: 'QuickJavaDoc', title: tr('Quick Documentation'), keys: 'Ctrl+Q', when: editorPython, run: editorTrigger('editor.action.showHover') },
    { id: 'ParameterInfo', title: tr('Parameter Info'), keys: 'Ctrl+P', when: editorPython, run: editorTrigger('editor.action.triggerParameterHints') },
    { id: 'ShowIntentionActions', title: tr('Show Context Actions'), keys: 'Alt+Enter', when: editorPython, run: editorTrigger('editor.action.quickFix') },
    { id: 'GotoNextError', title: tr('Next Highlighted Error'), keys: 'F2', when: editorPython, run: () => gotoProblem(1) },
    { id: 'GotoPreviousError', title: tr('Previous Highlighted Error'), keys: 'Shift+F2', when: editorPython, run: () => gotoProblem(-1) },
    { id: 'Pyright.Restart', title: tr('Restart Pyright Language Server'), run: restart },
  ].forEach(ide.registerAction);

  ide.lsp = { request, documentSymbols, ready, status: () => status, restart };
})();
