// Semantic Search: natural-language and code-to-code search over the project with EmbeddingGemma 2.
(() => {
  const { el, basename, samePath } = ide.util;
  let status = null;
  let progress = null;
  let indexState = { excluded: [], skipped: [], heavy: [], declined: false }; // from semantic:indexInfo
  let paused = false;
  let tw;
  let input;
  let list;
  let preview;
  let info;
  let setupBox;
  let notice;
  let log;
  let results = [];
  let selected = -1;
  let seq = 0;

  const ready = () => status && status.runtime && status.downloaded;
  const pct = () => (progress?.total ? Math.round((progress.done / progress.total) * 100) : 0);
  const indexing = () => progress?.phase === 'indexing' && progress.total > 0;
  const duration = (s) => (s < 60 ? tr('{n} s', { n: Math.max(1, s) }) : s < 3600 ? tr('{n} min', { n: Math.round(s / 60) })
    : tr('{h} h {m} min', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) }));
  const SKIP_REASONS = { ignored: () => tr('ignored by Git'), venv: () => tr('virtual environment'), data: () => tr('mostly data'), excluded: () => tr('excluded') };
  const slashes = (rel) => rel.replace(/\\/g, '/');
  const languageOf = (p) => ({ py: 'python', md: 'markdown', js: 'javascript', ts: 'typescript', json: 'json', html: 'html',
    css: 'css', java: 'java', lua: 'lua', luau: 'lua', toml: 'ini', yaml: 'yaml', yml: 'yaml', sql: 'sql' })[p.split('.').pop().toLowerCase()] || 'plaintext';

  // ---------- status bar ----------
  const statusItem = el('span', 'sem-status hidden');
  statusItem.id = 'semanticStatus';
  statusItem.onclick = () => tw.show();
  ide.registerStatusItem({ order: 8, el: statusItem });

  function renderStatus() {
    let text = '';
    if (status && !ready()) text = tr('Semantic search: setup needed');
    else if (progress?.phase === 'confirm') text = tr('Semantic index: waiting for your answer');
    else if (indexing() && paused) text = tr('Semantic index paused at {pct}%', { pct: pct() });
    else if (indexing() && progress.eta) text = tr('Semantic index {pct}% · {eta} left', { pct: pct(), eta: duration(progress.eta) });
    else if (indexing()) text = tr('Semantic index {pct}%', { pct: pct() });
    else if (status?.model?.state === 'loading') text = tr('Loading EmbeddingGemma 2…');
    statusItem.textContent = text ? `✦ ${text}` : '';
    statusItem.classList.toggle('hidden', !text);
    if (tw) renderActions();
    if (!info) return;
    const parts = [];
    if (status?.backend === 'fake') parts.push(tr('Test backend'));
    else if (status) parts.push(`EmbeddingGemma 2 · ${status.dim}d${status.model?.device ? ` · ${status.model.device.toUpperCase()}` : ''}`);
    if (indexing() && paused) parts.push(tr('Paused at {done}/{total}', { done: progress.done, total: progress.total }));
    else if (indexing()) parts.push(tr('Indexing {done}/{total}', { done: progress.done, total: progress.total }));
    else if (progress?.chunks !== undefined) parts.push(tr('{files} files, {chunks} chunks', { files: progress.files, chunks: progress.chunks }));
    if (progress?.capped) parts.push(tr('index size limit reached'));
    if (progress?.skipped) parts.push(tr('{n} folders skipped', { n: progress.skipped }));
    if (progress?.phase === 'error') parts.push(tr('Error: {error}', { error: progress.error }));
    info.textContent = parts.join('  ·  ');
    info.title = indexState.skipped.map((f) => `${slashes(f.rel)} (${SKIP_REASONS[f.reason]?.() || f.reason})`).join('\n');
    notice.classList.toggle('hidden', !(ready() && progress?.phase === 'declined'));
    setupBox.classList.toggle('hidden', ready());
    input.disabled = !ready();
  }

  // Pause/Resume shows while there is something to pause; the list is set again only when that changes.
  let actionsKey = '';
  function renderActions() {
    const key = `${indexing()} ${paused}`;
    if (key === actionsKey) return;
    actionsKey = key;
    tw.setActions([
      ...(paused ? [{ icon: '▶', title: tr('Resume Indexing'), run: () => setPaused(false) }]
        : indexing() ? [{ icon: '⏸', title: tr('Pause Indexing'), run: () => setPaused(true) }] : []),
      { icon: '⊘', title: tr('Exclude Folder from Semantic Index…'), run: pickExcluded },
      { icon: '⟳', title: tr('Rebuild Index'), run: () => ide.root && ready() && ide.api.invoke('semantic:rebuild', ide.root) },
    ]);
  }

  async function refreshStatus() {
    status = await ide.api.invoke('semantic:status');
    renderStatus();
    return status;
  }

  // Minutes without a request before the model is unloaded; the field lives in Settings › AI › AI Completion and
  // main owns the default (main/ai/runtime.js). The indexing limits are on Settings › AI › Semantic Search.
  const IDLE_KEY = 'ai.idleUnloadMinutes';
  const KEYS = { dataFiles: 'semantic.dataFolderFiles', dataMB: 'semantic.dataFolderMB', confirmChunks: 'semantic.confirmChunks' };
  const DEFAULTS = { dataFiles: 1000, dataMB: 50, confirmChunks: 5000 };
  const limit = (k) => ide.settings.get(KEYS[k]) ?? DEFAULTS[k];
  const configure = () => ide.api.invoke('semantic:configure', { idleMinutes: ide.settings.get(IDLE_KEY), ...Object.fromEntries(Object.keys(KEYS).map((k) => [k, limit(k)])) });
  configure();
  ide.on('settingsChanged', (key) => {
    if (key === IDLE_KEY) configure();
    if (Object.values(KEYS).includes(key)) configure().then(() => index());
  });

  ide.api.on('semantic:status', (s) => { status = s; renderStatus(); });
  ide.api.on('semantic:progress', (p) => {
    if (p.root && ide.root && p.root.toLowerCase() !== ide.root.toLowerCase()) return;
    progress = p;
    if (p.paused !== undefined) paused = p.paused;
    renderStatus();
    if (p.phase === 'confirm') askSize(p.asking);
    if (p.phase === 'ready' || p.phase === 'declined') refreshIndexState();
    if (p.phase === 'ready' && input?.value.trim()) runQuery(input.value);
  });
  async function refreshIndexState() {
    if (!ide.root || !ready()) return null;
    const i = await ide.api.invoke('semantic:indexInfo', ide.root);
    indexState = i;
    paused = i.paused;
    renderStatus();
    return i;
  }

  // Indexing waits while the user types (main/features/semantic.js waitTurn); edits are reported a few times a second.
  let typedAt = 0;
  ide.onEditor((ed) => ed.onDidChangeModelContent(() => {
    if (!indexing() || Date.now() - typedAt < 400) return;
    typedAt = Date.now();
    ide.api.send('semantic:typing');
  }));

  async function setPaused(on) {
    paused = await ide.api.invoke('semantic:pause', on);
    renderStatus();
  }
  const isExcluded = (p) => indexState.excluded.some((r) => samePath(ide.util.joinPath(ide.root, r), p));
  async function setExcluded(folder, on) {
    indexState.excluded = await ide.api.invoke('semantic:exclude', ide.root, folder, on);
    renderStatus();
  }
  // The folders holding the most chunks, to exclude, and the excluded ones, to index again.
  async function pickExcluded() {
    if (!ide.root || !ready()) return;
    const i = await refreshIndexState();
    const items = [
      ...i.excluded.map((rel) => ({ label: slashes(rel), detail: tr('Excluded · choose to index it again'), value: { rel, on: false } })),
      ...i.heavy.filter((h) => !i.excluded.includes(h.rel)).map((h) => ({ label: slashes(h.rel), detail: tr('{files} files, {chunks} chunks', h), value: { rel: h.rel, on: true } })),
    ];
    const pick = await ide.ui.pick({ placeholder: tr('Exclude a folder from the semantic index'), items });
    if (pick) setExcluded(ide.util.joinPath(ide.root, pick.rel), pick.on);
  }

  // A first index above the threshold in Settings › AI › Semantic Search waits for the user: Index, Not Now, or
  // Index without the folders they untick.
  let asking = null;
  function askSize(a) {
    if (!a || asking) return;
    const root = ide.root;
    const body = el('div', 'sem-confirm');
    body.append(
      el('p', null, tr('The first semantic index of this project covers {files} files in {chunks} chunks.', a)),
      el('p', 'muted', tr('Embedding runs on this computer and can take a while. It waits while you type and can be paused at any time.')),
    );
    const boxes = [];
    const top = (a.heavy || []).filter((h) => !/[\\/]/.test(h.rel)).slice(0, 8);
    if (top.length) body.appendChild(el('div', 'sem-confirm-head', tr('Largest folders (untick to exclude):')));
    for (const h of top) {
      const row = el('label', 'sem-confirm-row');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.rel = h.rel;
      const name = el('span', 'sem-confirm-name', slashes(h.rel));
      name.dataset.userText = '';
      row.append(box, name, el('span', 'muted', tr('{files} files, {chunks} chunks', h)));
      body.appendChild(row);
      boxes.push(box);
    }
    let answered = false;
    const answer = (yes) => {
      answered = true;
      const exclude = yes ? boxes.filter((b) => !b.checked).map((b) => b.dataset.rel) : [];
      ide.api.invoke('semantic:confirm', root, yes, exclude);
    };
    asking = ide.ui.dialog({
      title: tr('Index This Project?'), body, width: 560,
      buttons: [{ label: tr('Not Now'), run: () => answer(false) }, { label: tr('Index'), primary: true, run: () => answer(true) }],
      onClose: () => { asking = null; if (!answered) answer(false); },
    });
    asking.el.id = 'semanticConfirm';
  }
  let logSink = null; // the Install Manager card's log while it runs setup
  ide.api.on('semantic:log', (text) => {
    logSink?.(text);
    if (!log) return;
    // pip and huggingface_hub draw progress bars with carriage returns; keep only the last state of each line.
    const lines = (log.textContent + text).split('\n').map((l) => l.split('\r').filter(Boolean).pop() || '');
    log.textContent = lines.slice(-400).join('\n');
    log.scrollTop = log.scrollHeight;
  });

  // ---------- indexing ----------
  const index = (paths) => ide.root && ready() && ide.api.invoke('semantic:index', ide.root, paths);
  let saveTimer = null;
  const pendingPaths = new Set();
  ide.on('projectOpened', async () => {
    results = [];
    progress = null;
    renderResults();
    await refreshStatus();
    if (ready()) {
      const i = await refreshIndexState();
      progress = { phase: i.asking ? 'confirm' : i.declined ? 'declined' : 'ready', done: 0, total: 0, files: i.files, chunks: i.chunks, capped: i.capped, skipped: i.skipped.length, paused: i.paused };
      renderStatus();
      if (i.asking) askSize(i.asking); else index();
    }
  });
  ide.on('fileSaved', (tab) => {
    if (!tab?.path) return;
    pendingPaths.add(tab.path);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { index([...pendingPaths]); pendingPaths.clear(); }, 1500);
  });
  ide.on('filesChanged', () => index());

  // ---------- searching ----------
  async function query(text, opts = {}) {
    if (!ide.root || !ready()) return [];
    const r = await ide.api.invoke('semantic:query', ide.root, text, opts);
    if (!r.ok) throw new Error(r.error);
    return r.results;
  }

  let debounce = null;
  function runQuery(text, opts) {
    clearTimeout(debounce);
    const my = ++seq;
    if (!text.trim() && !opts?.similarTo) { results = []; renderResults(); return; }
    debounce = setTimeout(async () => {
      list.classList.add('busy');
      try {
        const r = await query(text, opts);
        if (my !== seq) return;
        results = r;
        selected = r.length ? 0 : -1;
      } catch (err) {
        if (my !== seq) return;
        results = [];
        info.textContent = tr('Error: {error}', { error: err.message });
      } finally {
        list.classList.remove('busy');
      }
      renderResults();
    }, opts?.similarTo ? 0 : 250);
  }

  function renderResults() {
    if (!list) return;
    list.replaceChildren();
    if (!results.length) {
      list.appendChild(el('div', 'sem-empty muted', input?.value.trim() ? tr('No matches') : tr('Describe what the code does, in Korean or English, or paste code to find similar code.')));
      preview.replaceChildren();
      return;
    }
    const top = results[0].score || 1;
    results.forEach((r, i) => {
      const row = el('div', 'sem-row' + (i === selected ? ' selected' : ''));
      row.dataset.rel = r.rel;
      const bar = el('span', 'sem-score');
      bar.style.setProperty('--w', `${Math.max(8, Math.round((r.score / top) * 100))}%`);
      bar.title = tr('Similarity {sem}, keyword match {kw}', { sem: r.semantic.toFixed(3), kw: Math.round(r.keyword * 100) + '%' });
      const sym = el('span', 'sem-symbol', r.symbol || basename(r.rel));
      const loc = el('span', 'sem-loc', `${r.rel.replace(/\\/g, '/')}:${r.start + 1}`);
      sym.dataset.userText = loc.dataset.userText = '';
      row.append(bar, sym, loc);
      row.onclick = () => { selected = i; renderResults(); };
      row.ondblclick = () => open(r);
      list.appendChild(row);
    });
    showPreview();
  }

  async function showPreview() {
    const r = results[selected];
    preview.replaceChildren();
    if (!r) return;
    const head = el('div', 'sem-preview-head', `${r.rel.replace(/\\/g, '/')}  ${r.start + 1}–${r.end}`);
    head.dataset.userText = '';
    const code = el('pre', 'sem-preview-code');
    code.innerHTML = await ide.monaco.editor.colorize(r.preview, languageOf(r.rel), { tabSize: 4 });
    preview.append(head, code);
  }

  const open = (r) => ide.openFile(r.path, { line: r.start + 1 });

  // ---------- tool window ----------
  tw = ide.registerToolWindow({
    id: 'SemanticSearch', title: tr('Semantic Search'), icon: '✦', iconName: 'search', side: 'bottom', order: 22,
    mount(container) {
      container.classList.add('sem-tool');
      const bar = el('div', 'sem-bar');
      input = el('input', 'input sem-input');
      input.id = 'semanticInput';
      input.placeholder = tr('Search by meaning, e.g. "reconnect when the websocket drops"');
      input.oninput = () => runQuery(input.value);
      input.onkeydown = (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          selected = Math.max(0, Math.min(results.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
          renderResults();
          list.querySelector('.sem-row.selected')?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && results[selected]) open(results[selected]);
      };
      info = el('span', 'sem-info muted');
      notice = el('span', 'sem-notice hidden');
      const start = el('a', null, tr('Index Now'));
      start.id = 'semanticIndexNow';
      start.href = '#';
      start.onclick = (e) => { e.preventDefault(); ide.api.invoke('semantic:confirm', ide.root, true); };
      notice.append(el('span', 'muted', tr('Not indexed.')), start);
      bar.append(input, notice, info);
      setupBox = el('div', 'sem-setup hidden');
      setupBox.append(
        el('div', 'sem-setup-title', tr('Set up EmbeddingGemma 2')),
        el('p', null, tr('Semantic search uses Google\'s EmbeddingGemma 2 (Apache 2.0) on this computer. Your code never leaves it; only the model is downloaded.')),
        el('p', 'muted', tr('Setup creates a private Python environment that reuses your installed PyTorch, installs sentence-transformers, and downloads the model (about 1.4 GB) from Hugging Face.')),
      );
      const buttons = el('div', 'sem-setup-buttons');
      const go = el('button', 'primary', tr('Download and Set Up'));
      go.id = 'semanticSetup';
      const cancel = el('button', 'secondary hidden', tr('Cancel'));
      go.onclick = async () => {
        go.disabled = true;
        cancel.classList.remove('hidden');
        log.textContent = '';
        const r = await ide.api.invoke('semantic:setup', { interpreter: ide.currentInterp()?.executable });
        go.disabled = false;
        cancel.classList.add('hidden');
        await refreshStatus();
        if (r.ok) index();
        else log.textContent += `\n${tr('Setup failed: {error}', { error: r.error })}\n`;
      };
      cancel.onclick = () => ide.api.invoke('semantic:cancelSetup');
      buttons.append(go, cancel);
      log = el('pre', 'sem-log');
      log.dataset.userText = '';
      setupBox.append(buttons, log);
      const body = el('div', 'sem-body');
      list = el('div', 'sem-list');
      list.id = 'semanticResults';
      preview = el('div', 'sem-preview');
      body.append(list, preview);
      container.append(bar, setupBox, body);
      renderResults();
    },
  });
  renderActions();
  ide.registerTreeAction({ title: tr('Exclude from Semantic Index'), when: (e) => e.dir && ready() && !samePath(e.path, ide.root) && !isExcluded(e.path), run: (e) => setExcluded(e.path, true) });
  ide.registerTreeAction({ title: tr('Include in Semantic Index'), when: (e) => e.dir && ready() && isExcluded(e.path), run: (e) => setExcluded(e.path, false) });
  ide.registerTreeAction({ title: tr('Pause Semantic Indexing'), when: () => indexing() && !paused, run: () => setPaused(true) });
  ide.registerTreeAction({ title: tr('Resume Semantic Indexing'), when: () => paused, run: () => setPaused(false) });

  (ide.settingsPages ||= []).push({
    id: 'semantic', group: 'ai', title: () => tr('Semantic Search'), defaults: Object.fromEntries(Object.keys(KEYS).map((k) => [KEYS[k], DEFAULTS[k]])),
    keywords: 'semantic search index embedding data folder exclude ignore 의미 검색 색인 임베딩 데이터 폴더 제외',
    mount(host, ctx) {
      const sec = ctx.ui.section(host, tr('Indexing'));
      const field = (k, opts) => { const row = ctx.ui.numberInput(KEYS[k], { step: 1, min: 1, fallback: DEFAULTS[k], ...opts }); (row.querySelector('input') || row).id = `sem-${k}`; return row; };
      sec.appendChild(ctx.ui.fieldRow(tr('Skip mostly-data folders with more files than'), field('dataFiles', { step: 100, max: 1000000 })));
      sec.appendChild(ctx.ui.fieldRow(tr('…or more text than (MB)'), field('dataMB', { max: 100000 })));
      sec.appendChild(ctx.ui.fieldRow(tr('Ask before a first index larger than (chunks)'), field('confirmChunks', { step: 500, max: 1000000 })));
      sec.appendChild(el('p', 'muted settings-note', tr("A folder counts as data when less than a fifth of its files are source code. Folders Git ignores and virtual environments are never indexed; exclude other folders from the project tree's context menu.")));
    },
  });
  ide.on('toolWindowShown', (id) => { if (id === 'SemanticSearch') { refreshStatus(); input.focus(); } });

  // ---------- popup and editor actions ----------
  async function searchPopup() {
    if (!ready()) { tw.show(); return; }
    const pick = await ide.ui.pick({
      placeholder: tr('Semantic search (EmbeddingGemma 2)'),
      items: async (q) => {
        if (!q.trim()) return [];
        try {
          const r = await query(q, { limit: 20 });
          return r.map((x) => ({ label: x.symbol || basename(x.rel), detail: `${x.rel.replace(/\\/g, '/')}:${x.start + 1}`, hint: x.semantic.toFixed(2), value: x }));
        } catch { return []; }
      },
    });
    if (pick) open(pick);
  }

  function findSimilar(ed) {
    const model = ed.getModel();
    if (!model) return;
    const sel = ed.getSelection();
    let text = sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';
    if (!text) {
      // No selection: the block around the caret, up to 40 lines.
      const line = ed.getPosition().lineNumber;
      text = model.getLinesContent().slice(Math.max(0, line - 6), line + 34).join('\n');
    }
    tw.show();
    input.value = '';
    results = [];
    renderResults();
    runQuery('', { similarTo: text.slice(0, 4000) });
  }

  ide.registerAction({ id: 'SemanticSearchPopup', title: tr('Semantic Search…'), keys: 'Ctrl+Alt+F', run: searchPopup });
  (ide.installables ||= []).push({
    id: 'ai:embeddinggemma-2', category: 'ai', name: 'EmbeddingGemma 2', size: '1.4 GB', homepage: 'https://huggingface.co/google/embeddinggemma-2',
    description: tr('Google\'s local embedding model behind Semantic Search (Ctrl+Alt+F). Your code never leaves this computer.'),
    status: async () => {
      const s = await refreshStatus();
      return { installed: !!ready(), version: s?.dim ? `${s.dim}d` : undefined, detail: s?.model?.device ? s.model.device.toUpperCase() : undefined };
    },
    install: async (log, _progress, signal) => {
      const abort = () => ide.api.invoke('semantic:cancelSetup');
      signal?.addEventListener('abort', abort);
      logSink = log;
      try {
        const r = await ide.api.invoke('semantic:setup', { interpreter: ide.currentInterp()?.executable });
        if (!r.ok) throw new Error(r.error);
      } finally {
        logSink = null;
        signal?.removeEventListener('abort', abort);
      }
      await refreshStatus();
      index();
    },
  });
  ide.emit('installablesChanged');
  ide.registerAction({ id: 'FindSimilarCode', title: tr('Find Similar Code'), run: () => ide.editor && findSimilar(ide.editor) });
  ide.onEditor((ed) => ed.addAction({
    id: 'pyide.semantic.findSimilar', label: tr('Find Similar Code'), contextMenuGroupId: '8_semantic', run: () => findSimilar(ed),
  }));

  ide.semantic = { query, status: () => status, progress: () => progress, index, open };
  refreshStatus();
})();
