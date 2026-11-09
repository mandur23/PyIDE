// The host's language servers for a collaboration session's guests: a guest's completion, hover, signature help and
// Go to Definition in collab:// documents are asked of the host, whose window asks its own language server about the
// same text (the shared document) and answers; the problems the host's window shows in a file are drawn in the
// guests' copies. No language server runs on a guest for the host's files.
(() => {
  const C = ide.collab;
  const monaco = ide.monaco;
  if (!C || !monaco) return;
  const api = ide.api;
  const K = monaco.languages.CompletionItemKind;
  // LSP CompletionItemKind (1-based) -> Monaco's.
  const KIND = [null, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value,
    K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];
  const docText = (d) => (typeof d === 'string' ? d : d && typeof d.value === 'string' ? d.value : '');
  const toRange = (r) => (r?.start && r?.end ? new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1) : null);
  const S1 = (s, max = 2000) => (typeof s === 'string' ? s.slice(0, max) : undefined);

  // ---------- guest ----------
  const guestRel = (model) => (model.uri.scheme === 'collab' ? C.relOfLocal(`collab://${model.uri.authority}${model.uri.path}`) : null);
  async function ask(method, model, position) {
    const rel = guestRel(model);
    if (rel === null || C.state().state !== 'online') return null;
    const r = await api.invoke('collab:lsp', method, rel, { line: position.lineNumber - 1, character: position.column - 1 }).catch(() => null);
    return r?.result ?? null;
  }
  const selector = { scheme: 'collab' };
  monaco.languages.registerCompletionItemProvider(selector, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const res = await ask('completion', model, position);
      if (!Array.isArray(res) || model.isDisposed()) return undefined;
      const word = model.getWordUntilPosition(position);
      const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
      return {
        suggestions: res.map((it) => ({
          label: S1(it.label, 300) || '',
          kind: KIND[it.kind] ?? K.Text,
          detail: S1(it.detail, 500),
          documentation: it.documentation ? { value: S1(it.documentation, 4000) } : undefined,
          sortText: S1(it.sortText, 100),
          filterText: S1(it.filterText, 300),
          insertText: S1(it.insertText, 2000) ?? S1(it.label, 300) ?? '',
          insertTextRules: it.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: toRange(it.range) || wordRange,
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider(selector, {
    async provideHover(model, position) {
      const r = await ask('hover', model, position);
      if (!r?.value) return undefined;
      return { contents: [{ value: S1(r.value, 20000) }], range: toRange(r.range) || undefined };
    },
  });
  monaco.languages.registerSignatureHelpProvider(selector, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const r = await ask('signature', model, position);
      if (!Array.isArray(r?.signatures) || !r.signatures.length) return undefined;
      return {
        value: { activeSignature: r.activeSignature | 0, activeParameter: r.activeParameter | 0,
          signatures: r.signatures.slice(0, 20).map((s) => ({ label: S1(s.label, 1000) || '', documentation: s.documentation ? { value: S1(s.documentation, 4000) } : undefined,
            parameters: (Array.isArray(s.parameters) ? s.parameters : []).slice(0, 50).map((p) => ({ label: Array.isArray(p.label) ? p.label : S1(p.label, 200) || '' })) })) },
        dispose() {},
      };
    },
  });
  const uriOf = (rel) => monaco.Uri.from({ scheme: 'collab', authority: C.state().sid, path: `/${rel}` });
  monaco.languages.registerDefinitionProvider(selector, {
    async provideDefinition(model, position) {
      const r = await ask('definition', model, position);
      if (!Array.isArray(r)) return undefined;
      return r.filter((l) => typeof l.path === 'string' && toRange(l.range)).map((l) => ({ uri: uriOf(l.path), range: toRange(l.range) }));
    },
  });
  // Go to Definition into another of the host's files opens it as a guest document.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, sel) {
      if (resource.scheme !== 'collab') return false;
      const line = sel?.startLineNumber ?? sel?.lineNumber;
      const column = sel?.startColumn ?? sel?.column ?? 1;
      C.opened(`collab://${resource.authority}${resource.path}`).then((tab) => {
        if (!line || ide.activeTab() !== tab) return;
        ide.editor.setPosition({ lineNumber: line, column });
        ide.editor.revealPositionInCenterIfOutsideViewport({ lineNumber: line, column });
        ide.editor.focus();
      });
      return true;
    },
  });

  // PyCharm's keys for these, which the lsp plugin binds only in files of this computer.
  const inGuestDoc = () => ide.editor?.getModel()?.uri.scheme === 'collab';
  for (const [id, title, keys, command] of [
    ['Collab.GotoDeclaration', tr('Go to Declaration'), 'Ctrl+B', 'editor.action.revealDefinition'],
    ['Collab.QuickDoc', tr('Quick Documentation'), 'Ctrl+Q', 'editor.action.showHover'],
    ['Collab.ParameterInfo', tr('Parameter Info'), 'Ctrl+P', 'editor.action.triggerParameterHints'],
  ]) ide.registerAction({ id, title, keys, context: 'editor', when: inGuestDoc, run: () => ide.editor.trigger('collab', command, null) });

  // The host's problems in the guest's copies.
  const known = new Map(); // local path -> markers
  const SEVERITY = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info, hint: monaco.MarkerSeverity.Hint };
  function drawMarkers(path) {
    const doc = ide.getDocument(path);
    if (!doc || doc.model.isDisposed()) return;
    monaco.editor.setModelMarkers(doc.model, 'collab', (known.get(path) || []).map((m) => ({
      severity: SEVERITY[m.severity] ?? monaco.MarkerSeverity.Info, message: S1(m.message, 2000) || '', source: S1(m.source, 60),
      code: S1(typeof m.code === 'string' ? m.code : m.code != null ? String(m.code) : undefined, 100),
      startLineNumber: m.startLineNumber | 0, startColumn: m.startColumn | 0, endLineNumber: m.endLineNumber | 0, endColumn: m.endColumn | 0,
    })));
  }
  C.on('markers', (e) => {
    if (C.state().role !== 'guest' || typeof e.path !== 'string') return;
    known.set(e.path, Array.isArray(e.markers) ? e.markers : []);
    drawMarkers(e.path);
  });
  ide.on('remoteDocumentSynced', (doc) => { if (known.has(doc.path)) drawMarkers(doc.path); });
  C.on('ended', () => known.clear());

  // ---------- host ----------
  const toPath = (uri) => monaco.Uri.parse(uri).fsPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  // What one LSP answer becomes for the guest: small, plain data.
  const SHAPE = {
    completion(res) {
      const items = Array.isArray(res) ? res : res?.items || [];
      return items.slice(0, 300).map((it) => ({
        label: S1(it.label, 300), kind: it.kind, detail: S1(it.detail, 500), documentation: S1(docText(it.documentation), 4000), sortText: S1(it.sortText, 100),
        filterText: S1(it.filterText, 300), insertText: S1(it.textEdit?.newText ?? it.insertText, 2000), snippet: it.insertTextFormat === 2,
        range: it.textEdit?.range || it.textEdit?.replace || undefined,
      }));
    },
    hover(res) {
      if (!res?.contents) return null;
      const parts = [].concat(res.contents).map((c) => (typeof c === 'string' ? c : c.language ? `\`\`\`${c.language}\n${c.value}\n\`\`\`` : docText(c)));
      return { value: parts.filter(Boolean).join('\n\n').slice(0, 20000), range: res.range };
    },
    signature(res) {
      if (!res?.signatures) return null;
      return { activeSignature: res.activeSignature, activeParameter: res.signatures[res.activeSignature ?? 0]?.activeParameter ?? res.activeParameter,
        signatures: res.signatures.slice(0, 20).map((s) => ({ label: S1(s.label, 1000), documentation: S1(docText(s.documentation), 4000), parameters: (s.parameters || []).slice(0, 50).map((p) => ({ label: p.label })) })) };
    },
    definition(res) {
      const list = [].concat(res || []);
      return list.slice(0, 100).map((l) => {
        const uri = l.targetUri || l.uri;
        if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
        return { path: toPath(uri), range: l.targetSelectionRange || l.range };
      }).filter(Boolean);
    },
  };
  const METHOD = { completion: 'textDocument/completion', hover: 'textDocument/hover', signature: 'textDocument/signatureHelp', definition: 'textDocument/definition' };
  C.on('lsp', async (e) => {
    if (C.state().role !== 'host') return;
    const answer = (result) => api.send('collab:lspAnswer', { by: e.by, req: e.req, method: e.method, result });
    try {
      let tab = ide.findTab(e.path);
      if (!tab) tab = await ide.openFile(e.path, { background: true, focus: false });
      const client = ide.lsp?.clientFor?.(e.path);
      if (!tab?.model || !client?.request) return answer(null);
      const params = { textDocument: { uri: tab.model.uri.toString() }, position: { line: e.line, character: e.character } };
      if (e.method === 'completion') params.context = { triggerKind: 1 };
      const res = await client.request(METHOD[e.method], params);
      return answer(SHAPE[e.method](res));
    } catch { return answer(null); }
  });
  // The host's problems in its project files go to the guests.
  const NAMES = { [monaco.MarkerSeverity.Error]: 'error', [monaco.MarkerSeverity.Warning]: 'warning', [monaco.MarkerSeverity.Info]: 'info', [monaco.MarkerSeverity.Hint]: 'hint' };
  const pending = new Map(); // path -> timer
  function sendMarkers(uri) {
    const path = toPath(uri.toString());
    if (!C.inSession(path) || !ide.getDocument(path)) return;
    clearTimeout(pending.get(path));
    pending.set(path, setTimeout(() => {
      pending.delete(path);
      const list = monaco.editor.getModelMarkers({ resource: uri }).filter((m) => m.owner !== 'collab').slice(0, 500).map((m) => ({
        severity: NAMES[m.severity] || 'info', message: m.message.slice(0, 2000), source: m.source, code: typeof m.code === 'object' ? m.code?.value : m.code,
        startLineNumber: m.startLineNumber, startColumn: m.startColumn, endLineNumber: m.endLineNumber, endColumn: m.endColumn,
      }));
      api.send('collab:markers', { path, markers: list });
    }, 300));
  }
  monaco.editor.onDidChangeMarkers((uris) => {
    if (C.state().role !== 'host' || C.state().people.length < 2) return;
    for (const uri of uris) if (uri.scheme === 'file') sendMarkers(uri);
  });
  // A guest who opens a file gets its problems at once (main keeps the last of each file).
  C.on('open', (e) => { if (C.state().role === 'host' && typeof e.path === 'string') setTimeout(() => sendMarkers(monaco.Uri.file(e.path)), 500); });
})();
