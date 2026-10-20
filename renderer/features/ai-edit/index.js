// AI edits with Claude Code: Ctrl+I rewrites the selection and shows the result as an inline diff (Cursor's Ctrl+K),
// and next edit suggestions (NES) predict the edit that follows the user's last one. Model calls run in
// main/features/ai-edit.js through the Claude Code CLI.
//
// Edit session per editor: prompting -> generating -> reviewing -> (follow-up: generating) ... -> applied | rejected.
// While reviewing, the buffer is untouched until a hunk is accepted. Hunks are always derived: diff(region lines in the
// buffer, proposal). Accepting a hunk writes it to the buffer; rejecting one reverts it in the proposal.
(() => {
  const { el } = ide.util;
  const monaco = ide.monaco;
  const { KeyCode } = monaco;

  const SETTINGS = { nes: 'aiEdit.nes.enabled', model: 'aiEdit.model', debounce: 'aiEdit.nes.debounceMs', interval: 'aiEdit.nes.minIntervalMs' };
  const MODELS = [{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }];
  const modelId = () => ide.settings.get(SETTINGS.model, 'haiku');
  const nesEnabled = () => ide.settings.get(SETTINGS.nes, false) === true;
  const CONTEXT_BEFORE = 60;
  const CONTEXT_AFTER = 30;
  const NES_WINDOW = 60;
  const NES_HISTORY = 6;

  // ---------- line diff ----------
  // [{at, atNew, oldLines, newLines}]: `at` indexes `a`, `atNew` indexes `b`. LCS over the part between the common
  // prefix and suffix; regions are small, and a huge middle falls back to one replace hunk.
  function diffLines(a, b) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const n = a.length - pre - suf;
    const m = b.length - pre - suf;
    if (!n && !m) return [];
    if (n * m > 250000) return [{ at: pre, atNew: pre, oldLines: a.slice(pre, pre + n), newLines: b.slice(pre, pre + m) }];
    const w = m + 1;
    const lcs = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[pre + i] === b[pre + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    const hunks = [];
    let cur = null;
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[pre + i] === b[pre + j]) {
        if (cur) hunks.push(cur);
        cur = null;
        i++; j++;
        continue;
      }
      cur ??= { at: pre + i, atNew: pre + j, oldLines: [], newLines: [] };
      if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) cur.oldLines.push(a[pre + i++]);
      else cur.newLines.push(b[pre + j++]);
    }
    if (cur) hunks.push(cur);
    return hunks;
  }

  // ---------- buffer edits ----------
  // Replaces `count` whole lines from `start` with `lines` (count 0 inserts before `start`) as one undo step.
  function replaceLines(model, start, count, lines) {
    const eol = model.getEOL();
    const last = model.getLineCount();
    const max = (n) => model.getLineMaxColumn(n);
    let range;
    let text;
    if (count > 0 && lines.length) {
      range = new monaco.Range(start, 1, start + count - 1, max(start + count - 1));
      text = lines.join(eol);
    } else if (count > 0) {
      if (start + count <= last) range = new monaco.Range(start, 1, start + count, 1);
      else if (start > 1) range = new monaco.Range(start - 1, max(start - 1), last, max(last));
      else range = model.getFullModelRange();
      text = '';
    } else if (start > last) {
      range = new monaco.Range(last, max(last), last, max(last));
      text = eol + lines.join(eol);
    } else if (start === 1) {
      range = new monaco.Range(start, 1, start, 1);
      text = lines.join(eol) + eol;
    } else {
      range = new monaco.Range(start - 1, max(start - 1), start - 1, max(start - 1));
      text = eol + lines.join(eol);
    }
    model.pushStackElement();
    model.pushEditOperations(null, [{ range, text, forceMoveMarkers: true }], () => null);
    model.pushStackElement();
  }

  // A Monaco content change as a whole-line edit {x, y, n}: old lines x..y (none when y = x - 1) become n new lines
  // starting at x. Deleting or inserting whole lines touches the text either from column 1 to column 1 or from line
  // end to line end; only those keep the untouched line on the other side out of the edit. `oldLines` is the text
  // before the change.
  function lineEdit(c, oldLines) {
    const { startLineNumber: sL, startColumn: sC, endLineNumber: eL, endColumn: eC } = c.range;
    const t = c.text.split(/\r\n|\r|\n/);
    const k = t.length - 1;
    const atStarts = sC === 1 && eC === 1 && t[k] === '';
    const atEnds = sC === oldLines[sL - 1].length + 1 && eC === oldLines[eL - 1].length + 1 && t[0] === '';
    // Both hold for blank lines, where either reading gives the same text; Monaco deletes the last line end to end.
    if (atEnds && (!atStarts || eL === oldLines.length)) return { x: sL + 1, y: eL, n: k };
    if (atStarts) return { x: sL, y: eL - 1, n: k };
    return { x: sL, y: eL, n: k + 1 };
  }

  // The whole-line region {start, end} (end = start - 1 when empty) after the buffer changed around or inside it.
  // Lines inserted at the region's edges stay outside, except into an empty region, so undoing a deletion of all its
  // lines brings them back into it. Lines replaced together with region lines join the region.
  function trackRegion(region, changes, oldLines) {
    let { start: S, end: E } = region;
    for (const c of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      const { x, y, n } = lineEdit(c, oldLines);
      const d = n - (y - x + 1);
      if (y < x) {
        if ((S < x && x <= E) || (E < S && x === S)) E += n;
        else if (x <= S) { S += n; E += n; }
      } else if (y < S) {
        S += d; E += d;
      } else if (x <= E) {
        if (E < S) { S = x + n; E = S - 1; } else { E = y <= E ? E + d : x + n - 1; S = Math.min(S, x); }
      }
    }
    return { start: S, end: E };
  }

  // ---------- requests to main ----------
  let nextReq = 1;
  const streams = new Map();
  let inflight = 0;
  ide.api.on('ai-edit:stream', ({ reqId, lines }) => streams.get(reqId)?.(lines));
  // -> {promise, cancel}; the promise resolves to the main handler's {ok, ...} answer and never rejects.
  function request(kind, req, onLines) {
    const reqId = `${kind}-${nextReq++}`;
    if (onLines) streams.set(reqId, onLines);
    inflight++;
    renderStatus();
    const promise = ide.api.invoke(`ai-edit:${kind}`, { ...req, reqId, model: modelId() })
      .catch((err) => ({ ok: false, code: 'cli', message: err.message }))
      .finally(() => { streams.delete(reqId); inflight--; renderStatus(); });
    return { promise, cancel: () => ide.api.invoke('ai-edit:cancel', reqId) };
  }

  const fileLabel = (model) => {
    const tab = ide.tabs.find((t) => t.model === model);
    return tab ? ide.util.rel(tab.path) : model.uri.path.split('/').pop();
  };
  const linesOf = (model, from, to) => (to < from ? [] : model.getLinesContent().slice(from - 1, to));

  // ---------- per-editor state ----------
  const contexts = new Map(); // editor -> ctx
  const focusedCtx = () => [...contexts.values()].find((c) => c.editor.hasTextFocus()) || null;

  function attach(editor) {
    if (contexts.has(editor)) return;
    const ctx = {
      editor,
      session: null,
      nes: { suggestion: null, request: null },
      decos: editor.createDecorationsCollection(),
      zoneIds: [],
      hunkWidgets: [],
      keys: {
        active: editor.createContextKey('aiEditActive', false),
        reviewing: editor.createContextKey('aiEditReviewing', false),
        nes: editor.createContextKey('aiNesVisible', false),
      },
    };
    contexts.set(editor, ctx);
    editor.onDidChangeModelContent((e) => onContentChange(ctx, e));
    // The edit history starts from the text as it was opened, so the first edit is recorded too.
    const track = () => { if (editor.getModel()) historyOf(editor.getModel()); };
    track();
    editor.onDidChangeModel(() => { endSession(ctx); clearNes(ctx); track(); });
    editor.onDidChangeCursorPosition(() => { if (ctx.nes.suggestion) renderNesHint(ctx); });
    editor.onDidDispose(() => { endSession(ctx); clearNes(ctx); contexts.delete(editor); });
  }

  // ---------- Ctrl+I edit session ----------
  function regionLines(ctx) {
    const { start, end } = ctx.session.region;
    return linesOf(ctx.editor.getModel(), start, end);
  }

  // Hunks in buffer coordinates; while generating, the hunk that reaches the region's end may only be unfinished.
  function hunksOf(ctx) {
    const s = ctx.session;
    const proposal = s.phase === 'generating' ? s.streamed : s.proposal;
    if (!proposal) return [];
    const old = regionLines(ctx);
    return diffLines(old, proposal).map((h) => ({
      startLine: s.region.start + h.at,
      endLine: s.region.start + h.at + h.oldLines.length - 1,
      oldLines: h.oldLines,
      newLines: h.newLines,
      atNew: h.atNew,
      tail: s.phase === 'generating' && h.at + h.oldLines.length === old.length,
      state: 'pending',
    }));
  }

  function openPrompt(ctx) {
    if (ctx.session) { focusInput(ctx.session); return; }
    clearNes(ctx);
    const sel = ctx.editor.getSelection();
    const start = sel.startLineNumber;
    const end = sel.endColumn === 1 && sel.endLineNumber > start ? sel.endLineNumber - 1 : sel.endLineNumber;
    ctx.session = { phase: 'prompting', region: { start, end }, lines: ctx.editor.getModel().getLinesContent(), instructions: [], proposal: null, streamed: null, request: null, message: null, ui: null };
    ctx.session.ui = createPromptWidget(ctx);
    // The region's own highlight replaces the selection, which would otherwise cover the diff.
    ctx.editor.setPosition({ lineNumber: start, column: 1 });
    render(ctx);
    ctx.editor.revealLinesInCenterIfOutsideViewport(Math.max(1, start - 2), end);
    focusInput(ctx.session);
  }

  // A proposal made elsewhere (AI Chat's Apply) for lines start..end (end = start - 1 inserts before `start`), reviewed
  // like a Ctrl+I answer: hunk by hunk, with follow-up instructions.
  function openReview(ctx, { start, end, lines }) {
    endSession(ctx);
    clearNes(ctx);
    const model = ctx.editor.getModel();
    ctx.session = { phase: 'reviewing', region: { start, end }, lines: model.getLinesContent(), instructions: [], proposal: [...lines], streamed: null, request: null, message: null, ui: null };
    ctx.session.ui = createPromptWidget(ctx);
    if (!hunksOf(ctx).length) ctx.session.message = { kind: 'info', text: tr('No changes suggested.') };
    ctx.editor.setPosition({ lineNumber: Math.min(start, model.getLineCount()), column: 1 });
    render(ctx);
    ctx.editor.revealLinesInCenterIfOutsideViewport(Math.max(1, start - 2), Math.max(start, end));
    focusInput(ctx.session);
  }

  // Monaco attaches a new content widget on its next render, so the input may not be in the page yet.
  function focusInput(s, tries = 10) {
    s.ui.input.focus();
    if (document.activeElement !== s.ui.input && tries > 0) requestAnimationFrame(() => focusInput(s, tries - 1));
  }

  function submit(ctx) {
    const s = ctx.session;
    const instruction = s.ui.input.value.trim();
    if (!instruction || s.phase === 'generating') return;
    const model = ctx.editor.getModel();
    const { start, end } = s.region;
    const back = { phase: s.phase, proposal: s.proposal };
    const req = {
      path: fileLabel(model),
      language: model.getLanguageId(),
      before: linesOf(model, Math.max(1, start - CONTEXT_BEFORE), start - 1).join('\n'),
      region: regionLines(ctx).join('\n'),
      after: linesOf(model, end + 1, Math.min(model.getLineCount(), end + CONTEXT_AFTER)).join('\n'),
      instruction,
      history: [...s.instructions],
      proposal: s.proposal ? s.proposal.join('\n') : null,
    };
    s.instructions.push(instruction);
    s.phase = 'generating';
    s.streamed = [];
    s.message = null;
    const r = request('edit', req, (lines) => {
      if (ctx.session !== s || s.request !== r) return;
      s.streamed = lines;
      scheduleRender(ctx);
    });
    s.request = r;
    render(ctx);
    r.promise.then((res) => {
      if (ctx.session !== s || s.request !== r) return;
      s.request = null;
      s.streamed = null;
      if (res.ok) {
        s.phase = 'reviewing';
        s.proposal = res.lines;
        s.ms = res.ms;
        s.ui.input.value = '';
        if (!hunksOf(ctx).length) s.message = { kind: 'info', text: tr('No changes suggested.') };
      } else {
        s.phase = back.phase;
        s.proposal = back.proposal;
        s.instructions.pop();
        s.message = errorMessage(res);
      }
      render(ctx);
    });
  }

  function errorMessage(res) {
    if (res.code === 'cancelled') return { kind: 'info', text: tr('Cancelled.') };
    if (res.code === 'not-installed') {
      return { kind: 'error', text: tr('Claude Code is not installed.'), action: { label: tr('Open Install Manager'), run: openInstaller } };
    }
    if (res.code === 'auth') {
      return { kind: 'error', text: tr('Claude Code is not signed in. Open Claude Code and sign in with /login.'), action: { label: tr('Open Claude Code'), run: () => ide.runAction('ClaudeCode') } };
    }
    if (res.code === 'timeout') return { kind: 'error', text: tr('Claude Code did not answer in time.') };
    return { kind: 'error', text: tr('Claude Code failed: {message}', { message: res.message }) };
  }

  function openInstaller() {
    if (ide.installer) ide.installer.open('ai');
    else ide.runAction('InstallClaudeCode');
  }

  function cancelGeneration(ctx) {
    ctx.session?.request?.cancel();
  }

  // The first accept of a session puts a Local History label (local-history plugin) with the text before it.
  function checkpointOnce(ctx) {
    const s = ctx.session;
    if (s.checkpointed) return;
    s.checkpointed = true;
    const path = ide.tabs.find((t) => t.model === ctx.editor.getModel())?.path;
    if (path) ide.localHistory?.checkpoint('Before Accepting AI Edit', { paths: [path] });
  }

  function acceptAll(ctx) {
    const s = ctx.session;
    if (s?.phase !== 'reviewing') return;
    checkpointOnce(ctx);
    const { start, end } = s.region;
    if (hunksOf(ctx).length) replaceLines(ctx.editor.getModel(), start, end - start + 1, s.proposal);
    endSession(ctx);
    ctx.editor.focus();
  }

  function acceptHunk(ctx, index) {
    const s = ctx.session;
    const h = hunksOf(ctx)[index];
    if (!h) return;
    checkpointOnce(ctx);
    const { start, end } = s.region;
    replaceLines(ctx.editor.getModel(), h.startLine, h.oldLines.length, h.newLines);
    // The accepted lines are the region's by definition; tracking would leave lines inserted at an edge outside.
    s.region = { start, end: end + h.newLines.length - h.oldLines.length };
    afterHunkDecision(ctx);
  }

  function rejectHunk(ctx, index) {
    const h = hunksOf(ctx)[index];
    if (!h) return;
    ctx.session.proposal.splice(h.atNew, h.newLines.length, ...h.oldLines);
    afterHunkDecision(ctx);
  }

  function afterHunkDecision(ctx) {
    if (!hunksOf(ctx).length) { endSession(ctx); ctx.editor.focus(); } else render(ctx);
  }

  function escape(ctx) {
    const s = ctx.session;
    if (!s) return;
    if (s.phase === 'generating') cancelGeneration(ctx);
    else { endSession(ctx); ctx.editor.focus(); }
  }

  function endSession(ctx) {
    const s = ctx.session;
    if (!s) return;
    s.request?.cancel();
    ctx.session = null;
    s.ui.dispose();
    render(ctx);
  }

  // ---------- prompt widget ----------
  function createPromptWidget(ctx) {
    const { editor } = ctx;
    const node = el('div', 'ai-edit-widget');
    const row = el('div', 'ai-edit-row');
    const icon = el('span', 'ai-edit-icon', '✳');
    const input = el('input', 'ai-edit-input');
    input.spellcheck = false;
    const spinner = el('span', 'ai-edit-spinner');
    row.append(icon, input, spinner);
    const foot = el('div', 'ai-edit-foot');
    const status = el('span', 'ai-edit-status');
    const actions = el('span', 'ai-edit-actions');
    foot.append(status, actions);
    node.append(row, foot);

    // Clicks inside the widget must not move the editor's caret or focus.
    node.addEventListener('mousedown', (e) => e.stopPropagation());

    const widget = {
      getId: () => `ai-edit.prompt.${editor.getId()}`,
      getDomNode: () => node,
      getPosition: () => ctx.session && {
        position: { lineNumber: ctx.session.region.start, column: 1 },
        preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE],
      },
    };
    editor.addContentWidget(widget);
    let height = 0;
    const observer = ide.util.observeSize(node, () => {
      if (node.offsetHeight && node.offsetHeight !== height) { height = node.offsetHeight; if (ctx.session) render(ctx); }
    });
    return {
      node, input, status, actions, spinner, widget,
      height: () => (height || 62) + 6,
      dispose() { observer.disconnect(); editor.removeContentWidget(widget); },
    };
  }

  const button = (label, cls, run) => {
    const b = el('button', cls, label);
    b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  };

  function renderPrompt(ctx, hunks) {
    const s = ctx.session;
    const { input, status, actions, spinner, node } = s.ui;
    const layout = ctx.editor.getLayoutInfo();
    node.style.width = `${Math.max(320, Math.min(720, layout.contentWidth - 40))}px`;
    node.dataset.phase = s.phase;
    input.readOnly = s.phase === 'generating';
    input.placeholder = s.phase === 'reviewing'
      ? tr('Ask for a follow-up change (Enter)')
      : tr('Describe the change, e.g. "add type hints" (Enter to submit, Esc to close)');
    spinner.classList.toggle('hidden', s.phase !== 'generating');
    status.className = 'ai-edit-status';
    actions.replaceChildren();
    if (s.message) {
      status.textContent = s.message.text;
      status.classList.add(s.message.kind);
      if (s.message.action) actions.append(button(s.message.action.label, 'ai-edit-btn', s.message.action.run));
    } else if (s.phase === 'generating') {
      status.textContent = `${tr('Generating…')} ${tr('Esc to cancel')}`;
    } else if (s.phase === 'reviewing') {
      status.textContent = hunks.length === 1 ? tr('1 change') : tr('{count} changes', { count: hunks.length });
    } else {
      status.textContent = s.region.start === s.region.end ? tr('Edits the current line with Claude') : tr('Edits the selected lines with Claude');
    }
    if (s.phase === 'generating') actions.append(button(tr('Cancel'), 'ai-edit-btn', () => cancelGeneration(ctx)));
    if (s.phase === 'reviewing') {
      actions.append(
        button(`${tr('Accept')} Ctrl+Enter`, 'ai-edit-btn primary ai-edit-accept', () => acceptAll(ctx)),
        button(`${tr('Reject')} Esc`, 'ai-edit-btn ai-edit-reject', () => escape(ctx)),
      );
    }
  }

  // ---------- rendering ----------
  const fontStyle = (editor, node) => {
    const f = editor.getOption(monaco.editor.EditorOption.fontInfo);
    Object.assign(node.style, { fontFamily: f.fontFamily, fontSize: `${f.fontSize}px`, lineHeight: `${f.lineHeight}px` });
  };

  function addedLinesNode(ctx, lines, cls, colorize = true) {
    const node = el('div', cls);
    node.dataset.userText = '';
    fontStyle(ctx.editor, node);
    for (const line of lines) node.appendChild(el('div', 'ai-line', line || ' '));
    const lang = ctx.editor.getModel()?.getLanguageId();
    if (lang && colorize) {
      monaco.editor.colorize(lines.join('\n'), lang, { tabSize: ctx.editor.getModel().getOptions().tabSize }).then((html) => {
        const tmp = el('div');
        tmp.innerHTML = html;
        const colored = tmp.firstElementChild || tmp;
        const parts = [];
        let current = el('div', 'ai-line');
        for (const child of [...colored.childNodes]) {
          if (child.nodeName === 'BR') { parts.push(current); current = el('div', 'ai-line'); } else current.appendChild(child);
        }
        parts.push(current);
        if (parts.length === lines.length) node.replaceChildren(...parts.map((p) => { if (!p.textContent) p.textContent = ' '; return p; }));
      }).catch(() => {});
    }
    return node;
  }

  const lineDeco = (line, className, extra = {}) => ({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className, ...extra } });

  const renderQueued = new Set();
  function scheduleRender(ctx) {
    if (renderQueued.has(ctx)) return;
    renderQueued.add(ctx);
    requestAnimationFrame(() => { renderQueued.delete(ctx); render(ctx); });
  }

  // Draws the edit session and the NES suggestion of one editor from scratch.
  function render(ctx) {
    const { editor } = ctx;
    const s = ctx.session;
    const decos = [];
    const zones = [];
    const hunkWidgets = [];
    if (s) {
      const hunks = hunksOf(ctx);
      if (s.phase !== 'reviewing') {
        for (let l = s.region.start; l <= s.region.end; l++) decos.push(lineDeco(l, 'ai-edit-region'));
      }
      zones.push({ afterLineNumber: s.region.start - 1, heightInPx: s.ui.height(), ordinal: 0, domNode: el('div', 'ai-edit-prompt-space') });
      hunks.forEach((h, index) => {
        for (let l = h.startLine; l <= h.endLine; l++) decos.push(lineDeco(l, h.tail ? 'ai-edit-pending' : 'ai-edit-del', { linesDecorationsClassName: h.tail ? '' : 'ai-edit-del-gutter' }));
        if (h.newLines.length) {
          zones.push({
            afterLineNumber: h.oldLines.length ? h.endLine : h.startLine - 1,
            heightInLines: h.newLines.length,
            ordinal: 1,
            domNode: addedLinesNode(ctx, h.newLines, 'ai-edit-add', s.phase !== 'generating'),
          });
        }
        if (s.phase === 'reviewing') hunkWidgets.push(hunkWidget(ctx, h, index));
      });
      renderPrompt(ctx, hunks);
    }
    const n = ctx.nes.suggestion;
    if (n && !s) {
      const h = n.hunk;
      for (let l = h.startLine; l <= h.endLine; l++) decos.push(lineDeco(l, 'ai-nes-del', l === h.startLine ? { glyphMarginClassName: 'ai-nes-glyph' } : {}));
      if (h.newLines.length) zones.push({ afterLineNumber: h.endLine, heightInLines: h.newLines.length, ordinal: 1, domNode: addedLinesNode(ctx, h.newLines, 'ai-nes-add') });
    }
    ctx.decos.set(decos);
    editor.changeViewZones((acc) => {
      for (const id of ctx.zoneIds) acc.removeZone(id);
      ctx.zoneIds = zones.map((z) => acc.addZone(z));
    });
    for (const w of ctx.hunkWidgets) editor.removeContentWidget(w);
    ctx.hunkWidgets = hunkWidgets;
    for (const w of hunkWidgets) editor.addContentWidget(w);
    if (s) editor.layoutContentWidget(s.ui.widget);
    renderNesHint(ctx);
    ctx.keys.active.set(!!s);
    ctx.keys.reviewing.set(s?.phase === 'reviewing');
    ctx.keys.nes.set(!!n && !s);
  }

  function hunkWidget(ctx, h, index) {
    const node = el('div', 'ai-edit-hunk-actions');
    node.dataset.hunk = String(index);
    node.append(
      button(tr('Accept'), 'ai-edit-btn primary ai-hunk-accept', () => acceptHunk(ctx, index)),
      button(tr('Reject'), 'ai-edit-btn ai-hunk-reject', () => rejectHunk(ctx, index)),
    );
    node.addEventListener('mousedown', (e) => e.stopPropagation());
    const model = ctx.editor.getModel();
    const line = Math.min(h.oldLines.length ? h.startLine : Math.max(1, h.startLine - 1), model.getLineCount());
    return {
      getId: () => `ai-edit.hunk.${ctx.editor.getId()}.${index}`,
      getDomNode: () => node,
      getPosition: () => ({ position: { lineNumber: line, column: model.getLineMaxColumn(line) }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }),
    };
  }

  // ---------- next edit suggestions ----------
  const histories = new WeakMap(); // model -> {snapshot, edits: [text], lastLine, timer}
  const historyOf = (model) => {
    let h = histories.get(model);
    if (!h) {
      histories.set(model, (h = { snapshot: model.getLinesContent(), edits: [], lastLine: 1, timer: null }));
      model.onWillDispose(() => clearTimeout(h.timer));
    }
    return h;
  };
  let lastNesAt = -Infinity;
  let deferredNes = null;

  function onContentChange(ctx, e) {
    const model = ctx.editor.getModel();
    if (ctx.session) {
      ctx.session.region = trackRegion(ctx.session.region, e.changes, ctx.session.lines);
      ctx.session.lines = model.getLinesContent();
      scheduleRender(ctx);
    }
    if (ctx.nes.suggestion || ctx.nes.request) clearNes(ctx);
    const history = historyOf(model);
    if (!ctx.editor.hasTextFocus()) return;
    clearTimeout(history.timer);
    history.timer = setTimeout(() => {
      recordEdits(model, history);
      if (ctx.editor.getModel() === model) maybeRequestNes(ctx);
    }, ide.settings.get(SETTINGS.debounce, 1000));
  }

  function recordEdits(model, history) {
    const now = model.getLinesContent();
    for (const h of diffLines(history.snapshot, now)) {
      const line = h.atNew + 1;
      history.edits.push([`@@ line ${line} @@`, ...h.oldLines.slice(0, 8).map((l) => `-${l}`), ...h.newLines.slice(0, 8).map((l) => `+${l}`)].join('\n'));
      history.lastLine = line;
    }
    history.edits.splice(0, Math.max(0, history.edits.length - NES_HISTORY));
    history.snapshot = now;
  }

  // At most one request per interval: a pause inside the interval is served when the interval ends.
  function maybeRequestNes(ctx) {
    clearTimeout(deferredNes);
    const model = ctx.editor.getModel();
    if (!nesEnabled() || ctx.session || !model || !historyOf(model).edits.length) return;
    const wait = lastNesAt + ide.settings.get(SETTINGS.interval, 5000) - performance.now();
    if (wait > 0) { deferredNes = setTimeout(() => maybeRequestNes(ctx), wait); return; }
    lastNesAt = performance.now();
    requestNes(ctx);
  }

  async function requestNes(ctx) {
    const model = ctx.editor.getModel();
    const history = historyOf(model);
    const version = model.getVersionId();
    const count = model.getLineCount();
    const start = Math.max(1, history.lastLine - NES_WINDOW);
    const r = request('nes', {
      path: fileLabel(model),
      language: model.getLanguageId(),
      excerpt: { start, lines: linesOf(model, start, Math.min(count, history.lastLine + NES_WINDOW)) },
      edits: [...history.edits],
      cursorLine: ctx.editor.getPosition().lineNumber,
    });
    ctx.nes.request = r;
    const res = await r.promise;
    if (ctx.nes.request !== r) return;
    ctx.nes.request = null;
    if (!res.ok) {
      nesProblem = res.code === 'cancelled' ? null : errorMessage(res).text;
      // A missing install or login will not fix itself in seconds; do not call again for a minute.
      if (res.code === 'not-installed' || res.code === 'auth') lastNesAt = performance.now() + 60000;
      renderStatus();
      return;
    }
    nesProblem = null;
    renderStatus();
    const sug = res.suggestion;
    if (!sug || ctx.editor.getModel() !== model || model.getVersionId() !== version || ctx.session) return;
    const current = linesOf(model, sug.startLine, sug.endLine);
    if (current.length !== sug.oldLines.length || current.some((l, i) => l !== sug.oldLines[i])) return;
    ctx.nes.suggestion = { line: sug.startLine, hunk: { ...sug, state: 'pending' }, reason: sug.reason };
    render(ctx);
  }

  function clearNes(ctx) {
    const had = ctx.nes.suggestion;
    ctx.nes.request?.cancel();
    ctx.nes.request = null;
    ctx.nes.suggestion = null;
    if (had) render(ctx);
  }

  const cursorInTarget = (ctx) => {
    const line = ctx.editor.getPosition()?.lineNumber;
    const h = ctx.nes.suggestion.hunk;
    return line >= h.startLine && line <= h.endLine;
  };

  function nesTab(ctx) {
    const n = ctx.nes.suggestion;
    if (!n) return;
    if (!cursorInTarget(ctx)) {
      const model = ctx.editor.getModel();
      ctx.editor.setPosition({ lineNumber: n.line, column: model.getLineFirstNonWhitespaceColumn(n.line) || 1 });
      ctx.editor.revealLineInCenterIfOutsideViewport(n.line);
      renderNesHint(ctx);
      return;
    }
    const { hunk } = n;
    ctx.nes.suggestion = null;
    render(ctx);
    const model = ctx.editor.getModel();
    replaceLines(model, hunk.startLine, hunk.oldLines.length, hunk.newLines);
    const endLine = Math.min(model.getLineCount(), hunk.startLine + Math.max(0, hunk.newLines.length - 1));
    ctx.editor.setPosition({ lineNumber: endLine, column: model.getLineMaxColumn(endLine) });
  }

  // The hint at the end of the suggestion's first line says what Tab does next.
  function renderNesHint(ctx) {
    const n = !ctx.session && ctx.nes.suggestion;
    if (!n) {
      if (ctx.nesHint) { ctx.editor.removeContentWidget(ctx.nesHint.widget); ctx.nesHint = null; }
      return;
    }
    if (!ctx.nesHint) {
      const node = el('div', 'ai-nes-hint');
      const label = el('span', 'ai-nes-key');
      const reason = el('span', 'ai-nes-reason');
      reason.dataset.userText = '';
      node.append(label, reason);
      const widget = {
        getId: () => `ai-edit.nes.${ctx.editor.getId()}`,
        getDomNode: () => node,
        getPosition: () => {
          const s = ctx.nes.suggestion;
          if (!s) return null;
          const model = ctx.editor.getModel();
          return { position: { lineNumber: s.line, column: model.getLineMaxColumn(s.line) }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] };
        },
      };
      ctx.editor.addContentWidget(widget);
      ctx.nesHint = { widget, label, reason };
    }
    ctx.nesHint.label.textContent = cursorInTarget(ctx) ? tr('Tab to apply') : tr('Tab to jump here');
    ctx.nesHint.reason.textContent = n.reason || '';
    ctx.editor.layoutContentWidget(ctx.nesHint.widget);
  }

  // ---------- keys ----------
  // The IDE keymap listens on the document in the capture phase, ahead of the prompt and the editor, so the keys a
  // session owns are taken on the window first; in a query console, Ctrl+Enter would otherwise run the SQL statement
  // instead of accepting the edit.
  addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const ctx = [...contexts.values()].find((c) => c.session && (c.session.ui.input === e.target || c.editor.hasTextFocus()));
    if (!ctx) return;
    const s = ctx.session;
    const inPrompt = s.ui.input === e.target;
    let handled = true;
    if (e.key === 'Enter' && e.ctrlKey && (inPrompt || s.phase === 'reviewing')) acceptAll(ctx);
    else if (!inPrompt) handled = false;
    else if (e.key === 'Enter') submit(ctx);
    else if (e.key === 'Escape') escape(ctx);
    else if (e.key === 'Tab' && s.phase === 'reviewing' && !s.ui.input.value) acceptAll(ctx);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // Monaco keybindings with context keys, so Tab stays with ghost-text completions (inlineSuggestionVisible) and the
  // suggest widget whenever they are showing.
  const command = (id, run) => monaco.editor.addCommand({ id, run: () => { const ctx = focusedCtx(); if (ctx) run(ctx); } });
  command('aiEdit.acceptAll', acceptAll);
  command('aiEdit.escape', escape);
  command('aiEdit.nesTab', nesTab);
  command('aiEdit.nesDismiss', clearNes);
  monaco.editor.addKeybindingRules([
    { keybinding: KeyCode.Tab, command: 'aiEdit.acceptAll', when: 'aiEditReviewing && editorTextFocus && !inlineSuggestionVisible && !suggestWidgetVisible && !inSnippetMode' },
    { keybinding: KeyCode.Escape, command: 'aiEdit.escape', when: 'aiEditActive && editorTextFocus && !suggestWidgetVisible && !findWidgetVisible' },
    { keybinding: KeyCode.Tab, command: 'aiEdit.nesTab', when: 'aiNesVisible && editorTextFocus && !aiEditActive && !inlineSuggestionVisible && !suggestWidgetVisible && !inSnippetMode' },
    { keybinding: KeyCode.Escape, command: 'aiEdit.nesDismiss', when: 'aiNesVisible && editorTextFocus && !aiEditActive && !suggestWidgetVisible && !findWidgetVisible' },
  ]);

  // PyCharm's keymap keeps Ctrl+K for Commit (vcs); Ctrl+I is the inline AI prompt, as in JetBrains AI Assistant.
  ide.registerAction({ id: 'AiEdit.InlineEdit', title: tr('Edit with Claude…'), keys: 'Ctrl+I', when: () => !!focusedCtx(), run: () => openPrompt(focusedCtx()) });
  (ide.settingsPages ||= []).push({
    id: 'ai-edit', group: 'ai', title: () => tr('Claude Edits'), keywords: 'claude ai edit ctrl+i next edit suggestion nes model 수정 제안 모델',
    mount(host, ctx) {
      const main = ctx.ui.section(host, tr('Inline Edit (Ctrl+I)'));
      main.appendChild(ctx.ui.fieldRow(tr('Model:'), ctx.ui.selectInput(SETTINGS.model, MODELS.map((m) => [m.id, m.label]), 'haiku')));
      const nes = ctx.ui.section(host, tr('Next Edit Suggestions'));
      nes.appendChild(ctx.ui.checkbox(SETTINGS.nes, tr('Suggest the next edit after I pause typing')));
      nes.appendChild(ctx.ui.fieldRow(tr('Pause before asking (ms):'), ctx.ui.numberInput(SETTINGS.debounce, { step: 100, min: 200, max: 10000, fallback: 1000 })));
      nes.appendChild(ctx.ui.fieldRow(tr('Minimum time between requests (ms):'), ctx.ui.numberInput(SETTINGS.interval, { step: 500, min: 0, max: 60000, fallback: 5000 })));
      host.appendChild(el('div', 'muted settings-note', tr('Requests go through the Claude Code CLI with your Claude subscription. Only the edited region and nearby lines are sent.')));
    },
  });
  ide.registerAction({ id: 'AiEdit.ToggleNes', title: tr('Toggle Next Edit Suggestions'), run: () => setNes(!nesEnabled()) });

  const setNes = (on) => ide.settings.set(SETTINGS.nes, on);
  // The Settings dialog writes the setting directly, so its effects follow the setting, not setNes.
  ide.on('settingsChanged', (key) => {
    if (key !== SETTINGS.nes) return;
    if (!nesEnabled()) for (const ctx of contexts.values()) clearNes(ctx);
    renderStatus();
  });

  // ---------- status bar ----------
  let nesProblem = null;
  const statusEl = el('span', 'ai-edit-statusbar', '✳');
  function renderStatus() {
    statusEl.classList.toggle('busy', inflight > 0);
    statusEl.classList.toggle('nes-on', nesEnabled());
    statusEl.classList.toggle('problem', !!nesProblem);
    statusEl.title = [
      tr('AI edits with Claude (Ctrl+I)'),
      nesEnabled() ? tr('Next edit suggestions: on') : tr('Next edit suggestions: off'),
      nesProblem,
    ].filter(Boolean).join('\n');
  }
  statusEl.onclick = (e) => {
    const r = statusEl.getBoundingClientRect();
    ide.ui.contextMenu(r.left, r.top - 4, [
      { label: tr('Edit with Claude…'), hint: 'Ctrl+I', disabled: !ide.editor?.getModel(), run: () => { ide.editor.focus(); openPrompt(contexts.get(ide.editor)); } },
      { label: tr('Next Edit Suggestions'), checked: nesEnabled(), run: () => setNes(!nesEnabled()) },
      { label: tr('Model'), submenu: () => MODELS.map((m) => ({ label: m.label, checked: modelId() === m.id, run: () => ide.settings.set(SETTINGS.model, m.id) })) },
      { separator: true },
      { label: tr('Open Install Manager'), run: openInstaller },
    ]);
    e.stopPropagation();
  };
  ide.registerStatusItem({ order: 85, el: statusEl });
  renderStatus();

  ide.onEditor(attach);

  const ctxFor = (editor) => contexts.get(editor || ide.editor) || null;
  ide.aiEdit = {
    open: (editor) => openPrompt(ctxFor(editor)),
    // proposal: {start, end, lines}; end = start - 1 inserts the lines before line `start`.
    review: (editor, proposal) => openReview(ctxFor(editor), proposal),
    session(editor) {
      const ctx = ctxFor(editor);
      const s = ctx?.session;
      return s && { phase: s.phase, region: { ...s.region }, instructions: [...s.instructions], hunks: hunksOf(ctx).map(({ tail, atNew, ...h }) => h), message: s.message?.text || null, ms: s.ms ?? null };
    },
    nes: (editor) => {
      const n = ctxFor(editor)?.nes.suggestion;
      return n ? { line: n.line, hunk: { ...n.hunk }, reason: n.reason } : null;
    },
    nesEnabled,
    setNes,
  };
})();
