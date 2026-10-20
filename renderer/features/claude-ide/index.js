// Claude Code in PyIDE's terminals connects to this window (main/features/claude-ide.js): this side tells it the
// selection as it changes and answers its tool calls (open a file, the open editors, problems, show an edit as a diff).
(() => {
  if (ide.detached) return;
  const { el, basename, joinPath } = ide.util;
  const fileUrl = (p) => `file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const absPath = (p) => (/^[a-zA-Z]:[\\/]|^\\\\/.test(p) ? p : joinPath(ide.root || '', p)).replace(/\//g, '\\');
  const textResult = (text) => [{ type: 'text', text }];
  const jsonResult = (value) => textResult(JSON.stringify(value));
  const range = (s) => ({ start: { line: s.startLineNumber - 1, character: s.startColumn - 1 }, end: { line: s.endLineNumber - 1, character: s.endColumn - 1 } });

  // ---------- connection status ----------
  let state = { port: null, connected: 0 };
  const statusItem = el('span', 'cide-status hidden');
  statusItem.id = 'claudeIdeStatus';
  ide.registerStatusItem({ order: 84, el: statusItem });
  const render = () => {
    statusItem.classList.toggle('hidden', !state.connected);
    statusItem.textContent = '✳ Claude Code';
    statusItem.title = tr('Claude Code is connected to this window: it sees the open files, the selection and the problems, and shows its edits here as diffs.');
  };
  ide.api.on('claudeIde:status', (s) => { state = s; render(); });
  ide.api.invoke('claudeIde:status').then((s) => { state = s; render(); });

  const sendWorkspace = () => ide.api.send('claudeIde:workspace', ide.root ? [ide.root] : []);
  ide.on('projectOpened', sendWorkspace);
  ide.on('projectClosed', sendWorkspace);
  sendWorkspace();

  // ---------- selection ----------
  let latest = null;
  const selectionOf = (ed) => {
    const model = ed?.getModel();
    const tab = ide.activeTab();
    if (!model || !tab?.path || tab.kind === 'custom' || ed.getModel() !== tab.model) return null;
    const sel = ed.getSelection();
    return { text: model.getValueInRange(sel), filePath: tab.path, fileUrl: fileUrl(tab.path), selection: { ...range(sel), isEmpty: sel.isEmpty() } };
  };
  let timer = null;
  const pushSelection = (ed) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = selectionOf(ed);
      if (!s) return;
      latest = s;
      if (state.connected) ide.api.send('claudeIde:notify', { method: 'selection_changed', params: s });
    }, 120);
  };
  ide.onEditor((ed) => {
    ed.onDidChangeCursorSelection(() => pushSelection(ed));
    ed.onDidChangeModel(() => pushSelection(ed));
    ed.onDidFocusEditorText(() => pushSelection(ed));
  });

  // Mentioning a file or the selected lines (the terminal plugin's Send to Claude Code) as an IDE notification.
  ide.claudeIde = {
    connected: () => state.connected > 0,
    mention: (filePath, lineStart, lineEnd) => ide.api.send('claudeIde:notify', { method: 'at_mentioned', params: { filePath, lineStart, lineEnd } }),
  };

  // ---------- diffs ----------
  const diffs = new Map(); // tab_name -> {tab, resolve}
  function openDiff({ old_file_path: oldPath, new_file_path: newPath, new_file_contents: contents, tab_name: name }) {
    return new Promise(async (resolve) => {
      const old = await ide.api.invoke('fs:readText', absPath(oldPath)).catch(() => null);
      const original = typeof old?.text === 'string' ? old.text : '';
      let done = false;
      const finish = (result) => { if (done) return; done = true; diffs.delete(name); resolve(result); };
      const id = `claude-diff:${name}`;
      // A diff that reuses an open one's tab name replaces it; reopening the old tab would show the old proposal.
      const prev = diffs.get(name);
      if (prev) { prev.finish(textResult('DIFF_REJECTED')); prev.close(); }
      ide.openCustomTab({
        id, title: `${basename(newPath)} ⟷ Claude`, icon: '✳',
        onClose: () => finish([...textResult('DIFF_REJECTED'), ...textResult(name)]),
        mount(host, tab) {
          host.classList.add('cide-diff');
          const bar = el('div', 'cide-bar');
          bar.append(el('span', 'cide-title', tr('Claude Code proposes changes to {file}', { file: basename(newPath) })));
          const accept = el('button', 'primary', tr('Accept'));
          const reject = el('button', 'secondary', tr('Reject'));
          accept.id = 'claudeDiffAccept';
          reject.id = 'claudeDiffReject';
          bar.append(el('span', 'cide-spacer'), el('span', 'muted', tr('You can edit the right side before accepting.')), reject, accept);
          const box = el('div', 'cide-editor');
          host.append(bar, box);
          const lang = ide.monaco.languages.getLanguages().find((l) => l.extensions?.some((e) => newPath.toLowerCase().endsWith(e)))?.id || 'plaintext';
          const editor = ide.monaco.editor.createDiffEditor(box, { ...ide.editorOptions(), automaticLayout: true, renderSideBySide: true, originalEditable: false });
          const models = [ide.monaco.editor.createModel(original, lang), ide.monaco.editor.createModel(contents, lang)];
          editor.setModel({ original: models[0], modified: models[1] });
          // Closing the tab any way (buttons, ×, Close All) disposes the diff editor and its models.
          tab.dispose = () => { editor.dispose(); models.forEach((m) => m.dispose()); };
          const close = () => ide.closeTabObject(tab, true);
          accept.onclick = async () => {
            const text = models[1].getValue();
            try {
              await ide.api.invoke('fs:writeText', absPath(newPath), text);
            } catch (err) {
              // The diff stays open: the user can fix the cause and accept again, or reject.
              const body = el('div', null, tr('Cannot save {file}: {error}', { file: absPath(newPath), error: ide.util.errorText(err) }));
              ide.ui.dialog({ title: 'Claude Code', body });
              return;
            }
            await ide.reloadFromDisk([absPath(newPath)]);
            finish([...textResult('FILE_SAVED'), ...textResult(text)]);
            close();
          };
          reject.onclick = () => { finish([...textResult('DIFF_REJECTED'), ...textResult(name)]); close(); };
          diffs.set(name, { tab, finish, close });
        },
      });
    });
  }

  // ---------- tools ----------
  const TOOLS = {
    async openFile({ filePath, startText, endText, selectToEndOfLine = false, makeFrontmost = true }) {
      const p = absPath(filePath);
      await ide.openFile(p);
      const ed = ide.editor;
      const model = ed?.getModel();
      if (model && startText) {
        const start = model.findNextMatch(startText, { lineNumber: 1, column: 1 }, false, true, null, false);
        if (start) {
          let endRange = start.range;
          if (endText) endRange = model.findNextMatch(endText, start.range.getEndPosition(), false, true, null, false)?.range || endRange;
          const endCol = selectToEndOfLine ? model.getLineMaxColumn(endRange.endLineNumber) : endRange.endColumn;
          const sel = new ide.monaco.Selection(start.range.startLineNumber, start.range.startColumn, endRange.endLineNumber, endCol);
          ed.setSelection(sel);
          ed.revealRangeInCenter(sel);
        }
      }
      if (makeFrontmost) { ed?.focus(); return textResult(`Opened file: ${p}`); }
      return jsonResult({ success: true, filePath: p, languageId: model?.getLanguageId() || 'plaintext', lineCount: model?.getLineCount() || 0 });
    },
    openDiff,
    getCurrentSelection() {
      const s = selectionOf(ide.editor);
      return jsonResult(s ? { success: true, ...s } : { success: false, message: 'No active editor found' });
    },
    getLatestSelection() {
      return jsonResult(latest ? { success: true, ...latest } : { success: false, message: 'No selection available' });
    },
    getOpenEditors() {
      const active = ide.activeTab();
      const tabs = ide.groups().flatMap((g) => g.tabs).filter((t) => t.kind !== 'custom' && t.path)
        .map((t) => ({ uri: fileUrl(t.path), isActive: t === active, label: t.title, languageId: t.model?.getLanguageId() || 'plaintext', isDirty: ide.isDirty(t) }));
      return jsonResult({ tabs });
    },
    getWorkspaceFolders() {
      const folders = ide.root ? [{ name: basename(ide.root), uri: fileUrl(ide.root), path: ide.root }] : [];
      return jsonResult({ success: true, folders, rootPath: ide.root || null });
    },
    getDiagnostics({ uri } = {}) {
      const want = uri ? decodeURIComponent(uri.replace(/^file:\/\/\/?/, '')).replace(/\//g, '\\').toLowerCase() : null;
      const SEVERITY = { error: 'Error', warning: 'Warning', info: 'Information' };
      const byFile = new Map();
      for (const p of ide.problems.all()) {
        if (want && p.path.toLowerCase() !== want) continue;
        if (!byFile.has(p.path)) byFile.set(p.path, []);
        byFile.get(p.path).push({
          message: p.msg, severity: SEVERITY[p.severity] || 'Information', source: p.source,
          range: { start: { line: p.line - 1, character: (p.col || 1) - 1 }, end: { line: (p.endLine || p.line) - 1, character: (p.endCol || p.col || 1) - 1 } },
        });
      }
      return jsonResult([...byFile].map(([p, diagnostics]) => ({ uri: fileUrl(p), diagnostics })));
    },
    checkDocumentDirty({ filePath }) {
      const tab = ide.findTab(absPath(filePath));
      return jsonResult(tab ? { success: true, filePath, isDirty: ide.isDirty(tab), isUntitled: false } : { success: false, message: `Document not open: ${filePath}` });
    },
    async saveDocument({ filePath }) {
      const tab = ide.findTab(absPath(filePath));
      if (!tab) return jsonResult({ success: false, message: `Document not open: ${filePath}` });
      await ide.saveTab(tab);
      return jsonResult({ success: true, filePath, saved: true, message: 'Document saved successfully' });
    },
    close_tab({ tab_name: name }) {
      const d = diffs.get(name);
      if (d) { d.finish([...textResult('DIFF_REJECTED'), ...textResult(name)]); d.close(); }
      return textResult('TAB_CLOSED');
    },
    closeAllDiffTabs() {
      const n = diffs.size;
      for (const [name, d] of [...diffs]) { d.finish([...textResult('DIFF_REJECTED'), ...textResult(name)]); d.close(); }
      return textResult(`CLOSED_${n}_DIFF_TABS`);
    },
  };

  ide.api.on('claudeIde:call', async ({ id, name, args }) => {
    let content;
    try { content = await TOOLS[name](args || {}); } catch (err) { content = textResult(`Error: ${err.message}`); }
    ide.api.send('claudeIde:result', { id, content });
  });
})();
