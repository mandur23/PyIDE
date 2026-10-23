// AI Completion: Cursor-style "Tab" ghost text from a local fill-in-the-middle code model (main/features/ai-complete.js).
// Tab accepts, Ctrl+Right accepts a word, Esc dismisses (Monaco's inline suggestion commands). Alt+\ asks explicitly.
(() => {
  const { el } = ide.util;
  const monaco = ide.monaco;

  // `idle` is shared with Semantic Search: minutes without a request before a local model is unloaded (0 keeps it).
  // Main owns its default (main/ai/runtime.js); the one here only fills the settings field.
  const KEYS = { enabled: 'aiComplete.enabled', model: 'aiComplete.model', delay: 'aiComplete.delay', multiline: 'aiComplete.multiline', snoozeUntil: 'aiComplete.snoozeUntil', idle: 'ai.idleUnloadMinutes' };
  const DEFAULTS = { enabled: true, model: 'qwen2.5-coder-0.5b', delay: 200, multiline: true, snoozeUntil: 0, idle: 10 };
  const setting = (k) => ide.settings.get(KEYS[k], DEFAULTS[k]);
  const configure = () => ide.api.invoke('ai-complete:configure', { idleMinutes: ide.settings.get(KEYS.idle) });
  const LANGUAGES = ['python', 'javascript', 'typescript', 'java', 'go', 'rust', 'c', 'cpp', 'csharp', 'lua', 'sql', 'shell',
    'powershell', 'html', 'css', 'yaml', 'ini', 'json', 'markdown', 'plaintext'];
  // Prompt windows, in characters. The prefix starts on a line boundary that only moves in steps of PREFIX_STEP lines,
  // so consecutive prompts share their beginning and the server reuses its cache for it.
  const PREFIX_CHARS = 3000;
  const PREFIX_STEP = 16;
  const SUFFIX_CHARS = 800;
  const SUFFIX_LINES = 40;
  const CONTEXT_CHARS = 1600;
  const SNIPPET_LINES = 30;
  const CACHE_SIZE = 64;

  let status = null; // main's view: {backend, runtime, models: [{id, name, size, installed}], engine: {state, model, error}}
  const selectedModel = () => status?.models.find((m) => m.id === setting('model')) || status?.models[0];
  const snoozed = () => Number(setting('snoozeUntil')) > Date.now();

  // ---------- state shown in the status bar ----------
  // One mode at a time, derived from main's status and the settings; each mode owns its label and tooltip.
  const MODES = {
    starting: { label: () => '' },
    setup: { label: () => tr('AI Completion: set up'), title: () => tr('Download a local code model to get AI completions.') },
    off: { label: () => tr('AI Completion: off'), title: () => tr('Click to turn AI completion on.') },
    powerSave: { label: () => tr('AI Completion: paused'), title: () => tr('Paused in Power Save Mode.') },
    snoozed: { label: () => tr('AI Completion: snoozed'), title: () => tr('Snoozed until {time}', { time: new Date(Number(setting('snoozeUntil'))).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) },
    loading: { label: () => tr('AI Completion: loading…'), title: () => tr('Loading {model}…', { model: selectedModel()?.name }) },
    error: { label: () => tr('AI Completion: error'), title: () => status.engine.error },
    on: { label: () => tr('AI Completion'), title: () => tr('{model} on this computer. Tab accepts, Ctrl+Right accepts a word, Esc dismisses.', { model: selectedModel()?.name }) },
  };
  function mode() {
    if (!status) return 'starting';
    if (!selectedModel()?.installed) return 'setup';
    if (!setting('enabled')) return 'off';
    if (snoozed()) return 'snoozed';
    if (ide.powerSave?.on()) return 'powerSave';
    if (status.engine.state === 'loading') return 'loading';
    if (status.engine.error) return 'error';
    return 'on';
  }

  const item = el('span', 'aic-status');
  item.id = 'aiCompleteStatus';
  ide.registerStatusItem({ order: 82, el: item });
  function render() {
    const m = mode();
    item.dataset.mode = m;
    item.textContent = MODES[m].label() ? `✦ ${MODES[m].label()}` : '';
    item.title = MODES[m].title?.() || '';
    item.classList.toggle('hidden', m === 'starting');
  }
  async function refresh() {
    status = await ide.api.invoke('ai-complete:status');
    render();
    return status;
  }
  ide.api.on('ai-complete:status', (s) => { status = s; render(); });
  ide.on('settingsChanged', (key) => {
    if (key === KEYS.idle) configure();
    if (Object.values(KEYS).includes(key)) render();
  });
  // Power Save Mode: automatic suggestions stop (Trigger AI Completion still works) and visible ghost text goes.
  ide.on('powerSaveChanged', (on) => {
    render();
    if (on) for (const ed of ide.editors()) ed.trigger('powerSave', 'editor.action.inlineSuggest.hide', null);
  });
  configure();
  let snoozeTimer = null;
  const scheduleWake = () => {
    clearTimeout(snoozeTimer);
    if (snoozed()) snoozeTimer = setTimeout(render, Number(setting('snoozeUntil')) - Date.now() + 50);
  };

  const setEnabled = (on) => { ide.settings.set(KEYS.enabled, on); if (on) ide.settings.set(KEYS.snoozeUntil, 0); };
  const snooze = (minutes) => { ide.settings.set(KEYS.snoozeUntil, minutes ? Date.now() + minutes * 60000 : 0); scheduleWake(); };
  const openSetup = () => (ide.installer ? ide.installer.open('ai') : ide.ui.dialog({ title: tr('AI Completion'), body: el('div', null, tr('Install the code model from the Install Manager.')) }));

  item.onclick = () => {
    const r = item.getBoundingClientRect();
    const installed = !!selectedModel()?.installed;
    const menu = ide.ui.contextMenu(r.left, r.top - 4, [
      { header: tr('AI Completion') },
      ...(installed ? [] : [{ label: tr('Set Up AI Completion…'), run: openSetup }, { separator: true }]),
      { label: tr('Enable AI Completion'), checked: !!setting('enabled'), run: () => setEnabled(!setting('enabled')) },
      snoozed()
        ? { label: tr('Resume Now'), run: () => snooze(0) }
        : { label: tr('Snooze'), disabled: !setting('enabled'), submenu: () => [
          { label: tr('For 15 Minutes'), run: () => snooze(15) },
          { label: tr('For 1 Hour'), run: () => snooze(60) },
        ] },
      { label: tr('Multi-line Suggestions'), checked: !!setting('multiline'), run: () => ide.settings.set(KEYS.multiline, !setting('multiline')) },
      { label: tr('Model'), submenu: () => (status?.models || []).map((m) => ({
        label: m.name, detail: m.installed ? m.size : tr('not installed ({size})', { size: m.size }), checked: m.id === selectedModel()?.id,
        run: () => { ide.settings.set(KEYS.model, m.id); if (!m.installed) openSetup(); },
      })) },
      { separator: true },
      { label: tr('AI Completion Settings…'), run: openSettings },
    ]);
    menu.id = 'aiCompleteMenu';
  };

  // Settings › AI › AI Completion. Values go through the dialog's pending state, so OK/Apply/Cancel cover them.
  (ide.settingsPages ||= []).push({
    id: 'ai-complete', group: 'ai', title: () => tr('AI Completion'), keywords: 'ai completion tab ghost text inline suggestion qwen llama model 자동 완성 코드 예측 모델',
    mount(host, ctx) {
      const main = ctx.ui.section(host, tr('Code Prediction (Tab)'));
      const field = (row, id) => { (row.querySelector('input, select') || row).id = id; return row; };
      main.appendChild(field(ctx.ui.checkbox(KEYS.enabled, tr('Show AI completions while typing')), 'aicEnabled'));
      main.appendChild(field(ctx.ui.checkbox(KEYS.multiline, tr('Suggest whole blocks (multi-line)')), 'aicMultiline'));
      // An unset key reads as unchecked, so show the defaults explicitly.
      for (const k of ['enabled', 'multiline']) if (ctx.value(KEYS[k]) === undefined) host.querySelector(`[data-key="${KEYS[k]}"]`).checked = DEFAULTS[k];
      const models = (status?.models || []).map((m) => [m.id, `${m.name} (${m.size})${m.installed ? '' : ` · ${tr('not installed')}`}`]);
      const model = field(ctx.ui.selectInput(KEYS.model, models, DEFAULTS.model), 'aicModel');
      main.appendChild(ctx.ui.fieldRow(tr('Model'), model));
      main.appendChild(ctx.ui.fieldRow(tr('Delay after typing (ms)'), field(ctx.ui.numberInput(KEYS.delay, { step: 10, min: 50, max: 2000, fallback: DEFAULTS.delay }), 'aicDelay')));
      const local = ctx.ui.section(host, tr('Local Models'));
      local.appendChild(ctx.ui.fieldRow(tr('Unload idle models after (minutes)'), field(ctx.ui.numberInput(KEYS.idle, { step: 1, min: 0, max: 1440, fallback: DEFAULTS.idle }), 'aicIdle'), tr('0 keeps them loaded')));
      local.appendChild(el('p', 'muted settings-note', tr('Applies to the completion model and to EmbeddingGemma 2 (Semantic Search). An unloaded model loads again on the next request.')));
      const install = el('a', 'aic-install', tr('Download models in the Install Manager'));
      install.href = '#';
      install.onclick = (e) => { e.preventDefault(); openSetup(); };
      host.append(install, el('p', 'muted settings-note', tr('The model runs on this computer with llama.cpp. Your code never leaves it.')));
    },
  });
  const openSettings = () => ide.openSettings('ai-complete');
  // ---------- context ----------
  const relPath = (p) => ide.util.rel(p).replace(/\\/g, '/');
  const docTab = (model) => ide.tabs.find((t) => t.kind === 'file' && t.model === model);
  const lineAt = (model, n) => model.getLineContent(n);

  function windows(model, position) {
    const line = position.lineNumber;
    const caret = model.getOffsetAt(position);
    let start = Math.max(1, Math.floor((line - 120) / PREFIX_STEP) * PREFIX_STEP + 1);
    while (start + PREFIX_STEP <= line && caret - model.getOffsetAt({ lineNumber: start, column: 1 }) > PREFIX_CHARS) start += PREFIX_STEP;
    // Very long lines near the caret: the window ends exactly at the caret instead of starting on a line.
    let prefix = model.getValueInRange(new monaco.Range(start, 1, line, position.column));
    if (prefix.length > PREFIX_CHARS) prefix = prefix.slice(-PREFIX_CHARS);
    const endLine = Math.min(model.getLineCount(), line + SUFFIX_LINES);
    let suffix = model.getValueInRange(new monaco.Range(line, position.column, endLine, model.getLineMaxColumn(endLine)));
    if (suffix.length > SUFFIX_CHARS) {
      const cut = suffix.lastIndexOf('\n', SUFFIX_CHARS);
      suffix = suffix.slice(0, cut > 0 ? cut : SUFFIX_CHARS);
    }
    return { prefix, suffix };
  }

  // Related code from other open tabs (the best-matching window by shared identifiers, as Copilot's neighboring-tabs
  // snippets do) and from the semantic index when it is available. Cached per region of the file so the start of the
  // prompt stays the same while typing; semantic hits arrive asynchronously and join the next request.
  const identifiers = (text) => new Set(text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []);
  const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
  const related = new Map(); // `${uri}:${region}` -> {snippets, at}
  function relatedSnippets(model, position) {
    const key = `${model.uri}:${Math.floor((position.lineNumber - 1) / PREFIX_STEP)}`;
    const hit = related.get(key);
    if (hit && Date.now() - hit.at < 300000) return hit.snippets;
    const here = docTab(model)?.path;
    const before = model.getValueInRange(new monaco.Range(Math.max(1, position.lineNumber - SNIPPET_LINES), 1, position.lineNumber, position.column));
    const want = identifiers(before);
    const scored = [];
    const others = ide.tabs.filter((t) => t.kind === 'file' && t.model && !t.model.isDisposed() && t.model !== model).slice(0, 12);
    for (const t of others) {
      const lines = t.model.getLinesContent().slice(0, 3000);
      let best = null;
      for (let i = 0; i < lines.length; i += SNIPPET_LINES / 2) {
        const text = lines.slice(i, i + SNIPPET_LINES).join('\n');
        const score = jaccard(want, identifiers(text));
        if (!best || score > best.score) best = { path: relPath(t.path), text, score };
      }
      if (best && best.score >= 0.08) scored.push(best);
    }
    scored.sort((a, b) => b.score - a.score);
    const entry = { snippets: pack(scored.slice(0, 2)), at: Date.now() };
    related.set(key, entry);
    if (related.size > 50) related.delete(related.keys().next().value);
    if (ide.semantic?.status()?.runtime && ide.semantic.status().downloaded) {
      ide.semantic.query('', { limit: 6, similarTo: before.slice(-1500) }).then((hits) => {
        const h = hits.find((x) => !here || !ide.util.samePath(x.path, here) || x.end < position.lineNumber - SNIPPET_LINES || x.start > position.lineNumber + SNIPPET_LINES);
        if (h) entry.snippets = pack([...scored.slice(0, 2), { path: h.rel.replace(/\\/g, '/'), text: h.preview }]);
      }).catch(() => {});
    }
    return entry.snippets;
  }
  function pack(snippets) {
    const out = [];
    let budget = CONTEXT_CHARS;
    for (const s of snippets) {
      if (budget <= 200) break;
      const text = s.text.slice(0, budget);
      out.push({ path: s.path, text });
      budget -= text.length;
    }
    return out;
  }

  // ---------- when to suggest ----------
  const suggestWidgetOpen = () => !!document.querySelector('.suggest-widget.visible');
  const inSnippet = (editor) => !!editor.getContribution('snippetController2')?.isInSnippet?.();
  // Comments are prose: a small code model's continuations there are mostly noise, and they are where people stop to
  // think. Alt+\ still asks inside a comment.
  function inComment(model, position) {
    const linePrefix = lineAt(model, position.lineNumber).slice(0, position.column - 1);
    if (!linePrefix.trim()) return false;
    const tokens = monaco.editor.tokenize(linePrefix, model.getLanguageId())[0] || [];
    return !!tokens.length && /comment/.test(tokens[tokens.length - 1].type);
  }
  const midWord = (model, position) => /\w/.test(lineAt(model, position.lineNumber).charAt(position.column - 1));
  const editorFor = (model) => ide.editors().find((e) => e.getModel() === model && e.hasTextFocus()) || ide.editors().find((e) => e.getModel() === model);

  // ---------- requests ----------
  const cache = new Map(); // LRU: model, mode, path, prefix tail, suffix head -> {text, replace}
  const cacheKey = (path, { prefix, suffix }) => [selectedModel()?.id, setting('multiline'), path, prefix.slice(-400), suffix.slice(0, 200)].join('\u0000');
  const remember = (key, suggestion) => {
    cache.delete(key);
    cache.set(key, suggestion);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  };
  // The suggestion on screen, so typing its next characters keeps it without asking the model again.
  let shown = null; // {model, offset, before, after, text, replace, key}
  const session = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const inflight = new Map(); // editor -> request id

  const sleep = (ms, token) => new Promise((resolve) => {
    const timer = setTimeout(() => { sub.dispose(); resolve(true); }, ms);
    const sub = token.onCancellationRequested(() => { clearTimeout(timer); sub.dispose(); resolve(false); });
  });
  // `replace` characters after the caret (closing brackets the suggestion writes itself) are part of the edit.
  const itemAt = (position, { text, replace }) => ({ items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + replace) }] });
  const NONE = { items: [] };

  // The rest of the caret's line, which typing through must leave alone (an auto-closed bracket changes it).
  const lineAfter = (model, offset) => {
    const p = model.getPositionAt(offset);
    return model.getLineContent(p.lineNumber).slice(p.column - 1);
  };
  function continuation(model, offset) {
    if (!shown || shown.model !== model || offset < shown.offset || offset - shown.offset >= shown.text.length) return null;
    if (lineAfter(model, offset) !== shown.after) return null;
    const typed = model.getValueInRange(monaco.Range.fromPositions(model.getPositionAt(shown.offset), model.getPositionAt(offset)));
    const before = model.getValueInRange(monaco.Range.fromPositions(model.getPositionAt(Math.max(0, shown.offset - 120)), model.getPositionAt(shown.offset)));
    return shown.text.startsWith(typed) && before === shown.before ? { text: shown.text.slice(typed.length), replace: shown.replace } : null;
  }
  function show(model, offset, { text, replace }, key) {
    const before = model.getValueInRange(monaco.Range.fromPositions(model.getPositionAt(Math.max(0, offset - 120)), model.getPositionAt(offset)));
    shown = { model, offset, before, after: lineAfter(model, offset), text, replace, key };
  }

  async function provideInlineCompletions(model, position, context, token) {
    const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
    const tab = docTab(model);
    const editor = editorFor(model);
    if (!tab || !editor || !selectedModel()?.installed) return NONE;
    if (!explicit && (!setting('enabled') || snoozed() || ide.powerSave?.on())) return NONE;
    if (context.selectedSuggestionInfo || suggestWidgetOpen() || inSnippet(editor)) return NONE;
    if (editor.getSelections().some((s) => !s.isEmpty()) || editor.getSelections().length > 1) return NONE;

    const offset = model.getOffsetAt(position);
    const rest = continuation(model, offset);
    if (rest) return itemAt(position, rest);
    if (!explicit && (midWord(model, position) || inComment(model, position))) return NONE;

    const win = windows(model, position);
    const path = relPath(tab.path);
    const key = cacheKey(path, win);
    // An empty answer is remembered too, except when the user asks explicitly.
    if (cache.has(key) && (cache.get(key).text || !explicit)) {
      const suggestion = cache.get(key);
      remember(key, suggestion);
      if (!suggestion.text) return NONE;
      show(model, offset, suggestion, key);
      return itemAt(position, suggestion);
    }
    if (!explicit && !(await sleep(Number(setting('delay')) || DEFAULTS.delay, token))) return NONE;
    if (suggestWidgetOpen() || inSnippet(editor)) return NONE;

    const previous = inflight.get(editor);
    if (previous) ide.api.invoke('ai-complete:cancel', previous);
    const id = `${session}-${++seq}`;
    inflight.set(editor, id);
    const sub = token.onCancellationRequested(() => ide.api.invoke('ai-complete:cancel', id));
    let reply;
    try {
      reply = await ide.api.invoke('ai-complete:complete', {
        id, ...win, path, language: model.getLanguageId(), context: relatedSnippets(model, position),
        multiline: !!setting('multiline'), model: selectedModel().id, repo: ide.root ? ide.util.basename(ide.root) : 'project',
      });
    } finally {
      sub.dispose();
      if (inflight.get(editor) === id) inflight.delete(editor);
    }
    if (reply.cancelled || reply.error) return NONE;
    const suggestion = { text: reply.text, replace: reply.replace };
    remember(key, suggestion);
    if (token.isCancellationRequested || !suggestion.text) return NONE;
    show(model, offset, suggestion, key);
    return itemAt(position, suggestion);
  }

  for (const language of LANGUAGES) {
    monaco.languages.registerInlineCompletionsProvider(language, { provideInlineCompletions, disposeInlineCompletions() {} });
  }
  // Monaco's hover toolbar on ghost text is English-only and duplicates the keys shown in the status bar tooltip.
  ide.updateEditorOptions({ inlineSuggest: { enabled: true, showToolbar: 'never' } });
  // Monaco lets Tab indent instead when a suggestion starts with a full indent at the start of a line; here Tab always
  // accepts a visible suggestion, as in Cursor.
  monaco.editor.addKeybindingRules([{
    keybinding: monaco.KeyCode.Tab, command: 'editor.action.inlineSuggest.commit',
    when: 'inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible && !editorTabMovesFocus',
  }]);

  const ghostVisible = (editor) => !!editor?.getDomNode()?.querySelector('.ghost-text-decoration, .ghost-text-decoration-preview, .ghost-text');
  ide.onEditor((editor) => editor.onKeyDown((e) => {
    // Esc dismisses for good: the same suggestion does not come back at this caret from the cache.
    if (e.keyCode === monaco.KeyCode.Escape && ghostVisible(editor)) {
      if (shown) cache.delete(shown.key);
      shown = null;
    }
  }));

  // ---------- actions ----------
  const editorFocused = () => !!ide.editor?.hasTextFocus();
  ide.registerAction({ id: 'ToggleAICompletion', title: tr('Toggle AI Completion'), run: () => setEnabled(!setting('enabled')) });
  ide.registerAction({
    id: 'TriggerAICompletion', title: tr('Trigger AI Completion'), keys: 'Ctrl+Alt+\\', when: editorFocused,
    run: () => ide.editor.trigger('ai-complete', 'editor.action.inlineSuggest.trigger', {}),
  });
  ide.registerAction({ id: 'AICompletionSettings', title: tr('AI Completion Settings…'), run: openSettings });

  // ---------- Install Manager ----------
  const logSinks = new Map(); // model id -> the Install Manager card's log while it runs setup
  ide.api.on('ai-complete:log', (msg) => logSinks.get(msg.model)?.(msg.text));
  refresh().then((s) => {
    for (const m of s.models) {
      (ide.installables ||= []).push({
        id: `ai:${m.id}`, category: 'ai', name: m.name, size: m.size, homepage: m.homepage,
        description: tr('Local code model behind AI completion (Tab). It runs on this computer with llama.cpp; your code never leaves it.'),
        status: async () => {
          const st = (await refresh()).models.find((x) => x.id === m.id);
          return { installed: st.installed, detail: st.installed && st.id === selectedModel()?.id ? tr('In use') : undefined };
        },
        install: async (log, _progress, signal) => {
          const abort = () => ide.api.invoke('ai-complete:cancelSetup', m.id);
          signal?.addEventListener('abort', abort);
          logSinks.set(m.id, log);
          try {
            const r = await ide.api.invoke('ai-complete:setup', { model: m.id, interpreter: ide.currentInterp()?.executable });
            if (!r.ok) throw new Error(r.error);
          } finally {
            logSinks.delete(m.id);
            signal?.removeEventListener('abort', abort);
          }
          await refresh();
        },
        uninstall: async () => { await ide.api.invoke('ai-complete:remove', m.id); await refresh(); },
      });
    }
    ide.emit('installablesChanged');
  });
  scheduleWake();

  ide.aiComplete = { status: () => status, mode, isVisible: ghostVisible };
})();
