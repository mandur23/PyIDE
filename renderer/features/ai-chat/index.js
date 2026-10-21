// AI Chat tool window (right side, Ctrl+Shift+L) and AI commit messages (✨ on the Commit window's message box).
// Model calls run in main/features/ai-chat.js through the Claude Code CLI, the same runtime as ai-edit.
//
// A chat is {id, title, created, updated, messages: [{role: 'user'|'assistant', text, context?, stopped?, error?}]}.
// Chats are kept per project in <userData>/ai-chat. Context chips (current file, selection, @file mentions) are read
// when a message is sent; the message keeps only their paths and line ranges.
(() => {
  const { el, basename, joinPath, samePath } = ide.util;
  const monaco = ide.monaco;

  const SETTINGS = { model: 'aiChat.model', commitLanguage: 'aiChat.commitLanguage' };
  const MODELS = [{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }];
  const modelId = () => ide.settings.get(SETTINGS.model, 'sonnet');
  const MAX_CHATS = 50;
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };
  const rel = (p) => ide.util.rel(p).replace(/\\/g, '/');
  const absPath = (r) => (/^[a-zA-Z]:[\\/]/.test(r) ? r : joinPath(ide.root, r.replace(/\//g, '\\')));

  // ---------- Markdown ----------
  // marked's UMD wrapper registers with Monaco's AMD loader when it sees define.amd, so that flag is hidden while it loads.
  let markedLoad = null;
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

  // Allowlist sanitizer for the model's Markdown: unknown elements are unwrapped, active content dropped, links kept
  // only for http(s) (opened in the browser), no images.
  const MD_TAGS = new Set(['a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'kbd',
    'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul', 'input']);
  const MD_DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'button', 'textarea',
    'select', 'img', 'svg', 'math', 'video', 'audio', 'template', 'noscript']);
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walk = (node) => {
      for (const n of [...node.children]) {
        const tag = n.tagName.toLowerCase();
        if (MD_DROP.has(tag)) { n.remove(); continue; }
        walk(n);
        if (!MD_TAGS.has(tag)) { n.replaceWith(...n.childNodes); continue; }
        for (const a of [...n.attributes]) if (!['href', 'align', 'type', 'checked', 'start'].includes(a.name)) n.removeAttribute(a.name);
        if (tag === 'input') {
          if (n.getAttribute('type') !== 'checkbox') { n.remove(); continue; }
          n.setAttribute('disabled', '');
        }
        if (n.hasAttribute('href') && !/^https?:\/\//i.test(n.getAttribute('href').trim())) n.removeAttribute('href');
      }
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }

  const languageOf = (lang) => {
    const l = (lang || '').toLowerCase();
    if (!l) return null;
    const found = monaco.languages.getLanguages().find((x) => x.id === l || x.aliases?.some((a) => a.toLowerCase() === l) || x.extensions?.includes(`.${l}`));
    return found?.id || null;
  };

  // "python path=src/app.py", "python src/app.py" or "python:src/app.py" -> {lang, path}
  function parseInfo(info) {
    const [first = '', ...rest] = (info || '').trim().split(/\s+/);
    const [lang, colonPath] = first.split(':');
    const attr = rest.join(' ').match(/(?:path|file|title)=["']?([^\s"']+)/)?.[1];
    const bare = rest.find((r) => !r.includes('=') && /[\\/.]/.test(r));
    return { lang, path: colonPath || attr || bare || null };
  }

  function renderMarkdown(host, text, msg) {
    const marked = window.marked;
    if (!marked) {
      host.appendChild(el('div', 'aic-plain', text));
      loadMarked().then(() => renderMessage(msg)).catch(() => {});
      return;
    }
    const tokens = marked.lexer(text);
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const div = el('div', 'aic-md');
      div.innerHTML = sanitize(marked.parser(group));
      host.appendChild(div);
      group = [];
    };
    for (const t of tokens) {
      if (t.type === 'code' && t.codeBlockStyle !== 'indented') { flush(); host.appendChild(codeBlock(t, msg)); } else group.push(t);
    }
    flush();
  }

  function codeBlock(token, msg) {
    const info = parseInfo(token.lang);
    const code = token.text;
    const node = el('div', 'aic-code');
    const head = el('div', 'aic-code-head');
    head.appendChild(userText('span', 'aic-code-lang', info.path || info.lang || ''));
    const actions = el('span', 'aic-code-actions');
    const action = (id, label, run, disabled) => {
      const b = el('button', 'aic-code-btn', label);
      b.dataset.action = id;
      b.disabled = !!disabled;
      b.onclick = run;
      actions.appendChild(b);
      return b;
    };
    const copy = action('copy', tr('Copy'), async () => {
      await navigator.clipboard.writeText(code).catch(() => {});
      copy.textContent = tr('Copied');
      setTimeout(() => { copy.textContent = tr('Copy'); }, 1200);
    });
    const done = !msg.pending;
    action('insert', tr('Insert at Cursor'), () => insertAtCursor(code), !done);
    action('apply', tr('Apply to File'), () => applyToFile(code, info, msg), !done || !ide.aiEdit?.review);
    head.appendChild(actions);
    const pre = el('pre', 'aic-pre');
    const codeEl = el('code', null, code);
    pre.appendChild(codeEl);
    const language = languageOf(info.lang);
    if (done && language) {
      monaco.editor.colorize(code, language, { tabSize: 4 }).then((html) => { codeEl.innerHTML = html; }).catch(() => {});
    }
    node.append(head, pre);
    return node;
  }

  // ---------- code block actions ----------
  // The editor the user worked in last; the chat's input has focus while its buttons are clicked.
  const fileEditor = () => {
    const editor = ide.editor;
    return editor?.getModel() && ide.tabs.some((t) => t.kind === 'file' && t.model === editor.getModel()) ? editor : null;
  };

  function insertAtCursor(code) {
    const editor = fileEditor();
    if (!editor) return setStatus(tr('Open a file to insert the code into.'), 'error');
    const sel = editor.getSelection();
    editor.pushUndoStop();
    editor.executeEdits('ai-chat', [{ range: sel, text: code, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.focus();
  }

  const DEF = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/;
  const leading = (s) => s.match(/^[ \t]*/)[0];

  // Where a code block goes in a file: the selection the question was about, the function or class it redefines,
  // the whole file when the block is most of it, or else after the caret's line.
  function applyRegion(fileLines, lines, selection, caretLine) {
    if (selection && selection.endLine <= fileLines.length) return { start: selection.startLine, end: selection.endLine, lines };
    if (!fileLines.some((l) => l.trim())) return { start: 1, end: fileLines.length, lines };
    const di = lines.findIndex((l) => DEF.test(l));
    if (di >= 0) {
      const [, , kind, name] = lines[di].match(DEF);
      const at = fileLines.findIndex((l) => { const m = l.match(DEF); return m && m[2] === kind && m[3] === name; });
      if (at >= 0) {
        const indent = leading(fileLines[at]);
        let end = at;
        for (let i = at + 1; i < fileLines.length; i++) {
          if (!fileLines[i].trim()) continue;
          if (leading(fileLines[i]).length <= indent.length) break;
          end = i;
        }
        let start = at;
        if (di > 0) while (start > 0 && /^\s*@/.test(fileLines[start - 1])) start--;
        // A method answered flush left goes back to the method's indentation.
        const got = leading(lines[di]);
        const add = got.length < indent.length && indent.startsWith(got) ? indent.slice(got.length) : '';
        return { start: start + 1, end: end + 1, lines: add ? lines.map((l) => (l.trim() ? add + l : l)) : lines };
      }
    }
    if (lines.length >= fileLines.length * 0.5) return { start: 1, end: fileLines.length, lines };
    return { start: caretLine + 1, end: caretLine, lines };
  }

  async function applyToFile(code, info, msg) {
    if (!ide.aiEdit?.review) return;
    const chat = currentChat();
    const question = chat?.messages[chat.messages.indexOf(msg) - 1];
    const ctx = question?.context || [];
    const selection = ctx.find((c) => c.kind === 'selection');
    let path = info.path && ide.root ? absPath(info.path) : null;
    if (path && !(await ide.api.exists(path))) path = null;
    path ||= (selection && absPath(selection.path)) || (ctx.find((c) => c.current) && absPath(ctx.find((c) => c.current).path))
      || (ide.activeTab()?.kind === 'file' ? ide.activeTab().path : null);
    if (!path) return setStatus(tr('Open a file to apply the code to.'), 'error');
    await ide.openFile(path, { focus: true });
    const editor = ide.editor;
    const model = editor?.getModel();
    if (!model || ide.findTab(path)?.model !== model) return;
    const lines = code.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const sel = selection && samePath(absPath(selection.path), path) ? selection : null;
    ide.aiEdit.review(editor, applyRegion(model.getLinesContent(), lines, sel, editor.getPosition().lineNumber));
  }

  // ---------- state ----------
  let history = { current: null, chats: [] };
  let loadedFor = null;
  let pending = null; // {reqId, chat, reply}
  let seq = 1;
  const chips = { selection: null, mentions: [], hideCurrent: null };
  const currentChat = () => history.chats.find((c) => c.id === history.current) || null;

  function newChat() {
    if (pending) stop();
    const chat = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, title: '', created: Date.now(), updated: Date.now(), messages: [] };
    history.chats.unshift(chat);
    history.current = chat.id;
    // An empty chat left behind is not worth keeping.
    history.chats = history.chats.filter((c) => c === chat || c.messages.length).slice(0, MAX_CHATS);
    renderAll();
    focusInput();
    return chat;
  }

  let saveTimer = null;
  let saving = Promise.resolve();
  // Writes `hist` as the history of `root`; both are passed in, since the project may change before it runs.
  function persist(root, hist) {
    const chats = hist.chats.filter((c) => c.messages.length).map((c) => ({
      ...c, messages: c.messages.map(({ pending: _p, ...m }) => m),
    }));
    saving = ide.api.invoke('ai-chat:saveHistory', root, { current: hist.current, chats }).catch((err) => ide.log.warn(`ai-chat: ${err.message}`));
  }
  function save() {
    clearTimeout(saveTimer);
    const root = ide.root;
    const hist = history;
    if (!root || loadedFor !== root) return;
    saveTimer = setTimeout(() => persist(root, hist), 200);
  }

  async function loadHistory() {
    const root = ide.root;
    loadedFor = null;
    history = { current: null, chats: [] };
    if (!root) return renderAll();
    const data = await ide.api.invoke('ai-chat:loadHistory', root).catch(() => null);
    if (ide.root !== root) return;
    history = { current: data?.current || null, chats: Array.isArray(data?.chats) ? data.chats : [] };
    if (!currentChat()) history.current = history.chats[0]?.id || null;
    loadedFor = root;
    renderAll();
  }

  // ---------- requests ----------
  const streams = new Map();
  ide.api.on('ai-chat:stream', ({ reqId, text }) => streams.get(reqId)?.(text));
  ide.api.on('ai-chat:commit-stream', ({ reqId, text }) => streams.get(reqId)?.(text));

  function errorText(res) {
    if (res.code === 'not-installed') return tr('Claude Code is not installed.');
    if (res.code === 'auth') return tr('Claude Code is not signed in. Open Claude Code and sign in with /login.');
    if (res.code === 'timeout') return tr('Claude Code did not answer in time.');
    return tr('Claude Code failed: {message}', { message: res.message });
  }

  // ---------- project files for @ mentions ----------
  let fileList = null;
  const projectFiles = async () => {
    if (!ide.root) return [];
    fileList ||= ide.api.walk(ide.root).then((list) => list.map((p) => ({ path: p, rel: rel(p), name: basename(p).toLowerCase() }))).catch(() => []);
    return fileList;
  };
  ide.on('filesChanged', () => { fileList = null; });

  function rankFiles(files, query) {
    const q = query.toLowerCase().replace(/\\/g, '/');
    const scored = [];
    for (const f of files) {
      const r = f.rel.toLowerCase();
      const score = !q ? 3 : f.name.startsWith(q) ? 0 : f.name.includes(q) ? 1 : r.includes(q) ? 2 : -1;
      if (score >= 0) scored.push({ f, score });
    }
    return scored.sort((a, b) => a.score - b.score || a.f.rel.length - b.f.rel.length).slice(0, 8).map((s) => s.f);
  }

  // ---------- context ----------
  const currentFilePath = () => {
    const tab = ide.activeTab();
    if (tab?.kind !== 'file' || samePath(tab.path, chips.hideCurrent || '')) return null;
    return tab.path;
  };

  async function fileText(path) {
    const doc = ide.getDocument(path);
    if (doc) return doc.model.getValue();
    return ide.api.read(path).catch(() => '');
  }
  const languageFor = (path) => ide.getDocument(path)?.model.getLanguageId()
    || languageOf(path.split('.').pop()) || 'plaintext';

  // The chips as sent: [{kind, path (relative), language, text, ...}], and as remembered in the message.
  async function gatherContext(text) {
    const files = await projectFiles();
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const f = files.find((x) => x.rel.toLowerCase() === m[1].toLowerCase().replace(/\\/g, '/'));
      if (f && !chips.mentions.some((p) => samePath(p, f.path))) chips.mentions.push(f.path);
    }
    const items = [];
    const current = currentFilePath();
    const paths = [...new Set([current, ...chips.mentions].filter(Boolean))];
    for (const path of paths) {
      items.push({ kind: 'file', path: rel(path), language: languageFor(path), text: await fileText(path), current: path === current });
    }
    const s = chips.selection;
    if (s) items.push({ kind: 'selection', path: rel(s.path), language: s.language, text: s.text, startLine: s.startLine, endLine: s.endLine });
    return items;
  }

  // ---------- sending ----------
  async function send(textArg) {
    const text = (textArg ?? input.value).trim();
    if (!text || pending) return;
    if (!ide.root) return setStatus(tr('Open a project to chat about it.'), 'error');
    if (loadedFor !== ide.root) await loadHistory();
    const project = ide.root;
    const hist = history;
    const chat = currentChat() || newChat();
    const context = await gatherContext(text);
    chat.messages.push({ role: 'user', text, at: Date.now(), context: context.map(({ text: _t, language: _l, ...c }) => c) });
    chat.title ||= text.split('\n')[0].slice(0, 60);
    const reply = { role: 'assistant', text: '', at: Date.now(), pending: true };
    chat.messages.push(reply);
    chat.updated = Date.now();
    input.value = '';
    chips.selection = null;
    chips.mentions = [];
    closeComplete();
    const reqId = `chat-${seq++}`;
    pending = { reqId, chat, reply };
    renderAll();
    save();
    streams.set(reqId, (t) => { reply.text = t; scheduleRender(reply); });
    const messages = chat.messages.slice(0, -1).filter((m) => m.text && !m.error).map(({ role, text: t }) => ({ role, text: t }));
    const res = await ide.api.invoke('ai-chat:send', { reqId, model: modelId(), messages, context })
      .catch((err) => ({ ok: false, code: 'cli', message: err.message }));
    streams.delete(reqId);
    delete reply.pending;
    if (res.ok) reply.text = res.text;
    else if (res.code === 'cancelled') reply.stopped = true;
    else reply.error = errorText(res);
    if (pending?.reqId === reqId) pending = null;
    chat.updated = Date.now();
    // Another project was opened meanwhile: the reply belongs to the chat history of the one it was asked in.
    if (history !== hist) { persist(project, hist); renderAll(); return; }
    renderAll();
    save();
  }

  function stop() {
    if (pending) ide.api.invoke('ai-chat:cancel', pending.reqId);
  }

  // ---------- UI ----------
  let root, list, chipsEl, input, sendBtn, statusEl, completeEl, tw;
  let complete = null; // {items, index, start}

  tw = ide.registerToolWindow({
    id: 'AIChat', title: tr('AI Chat'), icon: '✦', side: 'right', order: 10,
    mount(container) {
      root = el('div', 'aic');
      list = el('div', 'aic-list');
      const composer = el('div', 'aic-composer');
      chipsEl = el('div', 'aic-chips');
      input = el('textarea', 'aic-input');
      input.rows = 3;
      input.spellcheck = false;
      input.placeholder = tr('Ask about your code. @ adds a file, Enter sends, Shift+Enter adds a line.');
      completeEl = el('div', 'aic-complete hidden');
      const foot = el('div', 'aic-foot');
      statusEl = el('span', 'aic-status');
      sendBtn = el('button', 'primary aic-send');
      sendBtn.onclick = () => (pending ? stop() : send());
      foot.append(statusEl, sendBtn);
      composer.append(completeEl, chipsEl, input, foot);
      root.append(list, composer);
      container.appendChild(root);
      input.addEventListener('keydown', onInputKey);
      input.addEventListener('input', updateComplete);
      input.addEventListener('blur', () => setTimeout(closeComplete, 150));
      list.addEventListener('click', (e) => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        ide.api.invoke('shell:openExternal', a.getAttribute('href'));
      });
    },
  });
  // The window's shortcut is AiChat.Toggle's (registered below), as the keymap has it.
  tw.keyAction = 'AiChat.Toggle';
  ide.keymap.tooltip(tw.button, tr('AI Chat'), 'AiChat.Toggle');
  tw.setActions([
    { icon: '＋', title: tr('New Chat'), run: newChat },
    { icon: '🕘', title: tr('Chat History'), run: showHistory },
  ]);

  function focusInput() {
    if (!tw.isVisible()) tw.show();
    input.focus();
  }

  function setStatus(text, kind = '') {
    statusEl.textContent = text || '';
    statusEl.className = `aic-status ${kind}`;
  }

  async function showHistory() {
    if (loadedFor !== ide.root) await loadHistory();
    const chats = history.chats.filter((c) => c.messages.length);
    const fmt = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    const choice = await ide.ui.pick({
      placeholder: chats.length ? tr('Open a chat') : tr('No chats yet'),
      items: chats.map((c) => ({ label: c.title || tr('New Chat'), detail: fmt(c.updated), hint: tr('{n} messages', { n: c.messages.length }), value: c.id })),
    });
    if (!choice) return;
    history.current = choice;
    renderAll();
    save();
    focusInput();
  }

  const msgNodes = new Map(); // message -> element
  function renderAll() {
    if (!list) return;
    const chat = currentChat();
    msgNodes.clear();
    list.replaceChildren();
    if (!chat?.messages.length) {
      const empty = el('div', 'aic-empty');
      empty.append(el('div', 'aic-empty-title', tr('Chat with Claude about your code')),
        ide.keymap.text(el('div', 'muted'), () => tr('The current file goes along with each question. Type @ to add more files, or select code and use {action} › Ask AI about Selection.',
          { action: ide.keymap.withKeys(tr('Show Context Actions'), 'ShowIntentionActions') })));
      list.appendChild(empty);
    }
    for (const m of chat?.messages || []) {
      const node = el('div', `aic-msg ${m.role}`);
      msgNodes.set(m, node);
      list.appendChild(node);
      renderMessage(m);
    }
    list.scrollTop = list.scrollHeight;
    renderChips();
    renderComposer();
  }

  function renderMessage(m) {
    const node = msgNodes.get(m);
    if (!node) return;
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    node.replaceChildren();
    node.classList.toggle('pending', !!m.pending);
    if (m.role === 'user') {
      if (m.context?.length) {
        const row = el('div', 'aic-msg-chips');
        for (const c of m.context) row.appendChild(chipNode(c.kind === 'selection' ? `${basename(c.path)}:${c.startLine}-${c.endLine}` : basename(c.path), c.kind, c.path));
        node.appendChild(row);
      }
      node.appendChild(userText('div', 'aic-user-text', m.text));
    } else {
      const body = el('div', 'aic-body');
      body.dataset.userText = '';
      node.appendChild(body);
      if (m.text) renderMarkdown(body, m.text, m);
      if (m.pending && !m.text) node.appendChild(el('div', 'aic-typing', tr('Thinking…')));
      if (m.stopped) node.appendChild(el('div', 'aic-note', tr('Stopped.')));
      if (m.error) node.appendChild(el('div', 'aic-note error', m.error));
    }
    if (stick) list.scrollTop = list.scrollHeight;
  }

  const queued = new Set();
  function scheduleRender(m) {
    if (queued.has(m)) return;
    queued.add(m);
    requestAnimationFrame(() => { queued.delete(m); renderMessage(m); });
  }

  function renderComposer() {
    if (!sendBtn) return;
    sendBtn.textContent = pending ? tr('Stop') : tr('Send');
    sendBtn.classList.toggle('stop', !!pending);
    sendBtn.title = pending ? tr('Stop generating') : tr('Send (Enter)');
    if (!pending) setStatus('');
  }

  function chipNode(label, kind, title, onRemove) {
    const chip = el('span', `aic-chip ${kind}`);
    chip.dataset.kind = kind;
    chip.title = title || '';
    chip.appendChild(el('span', 'aic-chip-icon', kind === 'selection' ? '⌶' : '📄'));
    chip.appendChild(userText('span', 'aic-chip-label', label));
    if (onRemove) {
      const x = el('button', 'aic-chip-x', '×');
      x.title = tr('Remove');
      x.onclick = (e) => { e.stopPropagation(); onRemove(); renderChips(); };
      chip.appendChild(x);
    }
    return chip;
  }

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.replaceChildren();
    const current = currentFilePath();
    if (current) {
      const chip = chipNode(basename(current), 'current', rel(current), () => { chips.hideCurrent = current; });
      chip.appendChild(el('span', 'aic-chip-note', tr('current file')));
      chipsEl.appendChild(chip);
    }
    for (const p of chips.mentions) {
      if (current && samePath(p, current)) continue;
      chipsEl.appendChild(chipNode(basename(p), 'file', rel(p), () => { chips.mentions = chips.mentions.filter((x) => x !== p); }));
    }
    const s = chips.selection;
    if (s) chipsEl.appendChild(chipNode(`${basename(s.path)}:${s.startLine}-${s.endLine}`, 'selection', rel(s.path), () => { chips.selection = null; }));
  }

  // ---------- @ completion ----------
  async function updateComplete() {
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m || input.selectionStart !== input.selectionEnd) return closeComplete();
    const query = m[1];
    const items = rankFiles(await projectFiles(), query);
    if (input.value.slice(0, input.selectionStart) !== before) return; // typed on meanwhile
    if (!items.length) return closeComplete();
    complete = { items, index: 0, start: before.length - query.length - 1 };
    completeEl.replaceChildren(...items.map((f, i) => {
      const row = el('div', 'aic-complete-item' + (i === 0 ? ' active' : ''));
      row.append(ide.fileIcon(f.path), userText('span', 'aic-complete-name', basename(f.path)), userText('span', 'aic-complete-dir', f.rel));
      row.onmousedown = (e) => { e.preventDefault(); pickComplete(i); };
      return row;
    }));
    completeEl.classList.remove('hidden');
  }

  function closeComplete() {
    complete = null;
    completeEl?.classList.add('hidden');
  }

  function pickComplete(i) {
    const f = complete?.items[i];
    if (!f) return;
    const end = input.selectionStart;
    const insert = `@${f.rel} `;
    input.value = input.value.slice(0, complete.start) + insert + input.value.slice(end);
    const caret = complete.start + insert.length;
    input.setSelectionRange(caret, caret);
    if (!chips.mentions.some((p) => samePath(p, f.path))) chips.mentions.push(f.path);
    closeComplete();
    renderChips();
    input.focus();
  }

  function onInputKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (complete) {
      const n = complete.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        complete.index = (complete.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        [...completeEl.children].forEach((r, i) => r.classList.toggle('active', i === complete.index));
      } else if (e.key === 'Enter' || e.key === 'Tab') pickComplete(complete.index);
      else if (e.key === 'Escape') closeComplete();
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && pending) { e.preventDefault(); e.stopPropagation(); stop(); }
  }

  // ---------- entry points ----------
  function askAboutSelection(editor = ide.editor) {
    const model = editor?.getModel();
    const sel = editor?.getSelection();
    const tab = model && ide.tabs.find((t) => t.kind === 'file' && t.model === model);
    if (tab && sel && !sel.isEmpty()) {
      const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
      chips.selection = { path: tab.path, startLine: sel.startLineNumber, endLine, text: model.getValueInRange(sel), language: model.getLanguageId() };
    }
    renderChips();
    focusInput();
  }

  function toggleChat() {
    const editor = fileEditor();
    if (editor?.hasTextFocus() && !editor.getSelection().isEmpty()) return askAboutSelection(editor);
    if (tw.isVisible() && root.contains(document.activeElement)) { tw.hide(); return; }
    focusInput();
  }

  ide.registerAction({ id: 'AiChat.Toggle', title: tr('AI Chat'), keys: 'Ctrl+Shift+L', run: toggleChat, terminal: true });
  ide.registerAction({ id: 'AiChat.AskAboutSelection', title: tr('Ask AI about Selection'), run: () => askAboutSelection() });
  ide.registerAction({ id: 'AiChat.NewChat', title: tr('New AI Chat'), run: newChat });

  const ASK_COMMAND = 'pyide.aiChat.askAboutSelection';
  monaco.editor.registerCommand(ASK_COMMAND, () => askAboutSelection());
  // Alt+Enter (context actions) offers the chat for any selection. Monaco's quick fix menu lists only 'quickfix' kinds;
  // automatic requests (the lightbulb) get nothing, so a selection does not light it up.
  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, range, context) {
      if (range.isEmpty() || context.trigger !== monaco.languages.CodeActionTriggerType.Invoke) return undefined;
      if (!ide.tabs.some((t) => t.kind === 'file' && t.model === model)) return undefined;
      return { actions: [{ title: tr('Ask AI about Selection'), kind: 'quickfix', command: { id: ASK_COMMAND, title: tr('Ask AI about Selection') } }], dispose() {} };
    },
  });
  ide.onEditor((ed) => {
    ed.addAction({ id: 'aiChat.askAboutSelection', label: tr('Ask AI about Selection'), contextMenuGroupId: '9_claude', contextMenuOrder: 0, precondition: 'editorHasSelection', run: () => askAboutSelection(ed) });
    ed.addAction({ id: 'aiChat.open', label: tr('Open AI Chat'), contextMenuGroupId: '9_claude', contextMenuOrder: 1, run: () => focusInput() });
  });

  ide.on('activeTabChanged', () => { chips.hideCurrent = null; renderChips(); });
  ide.on('projectOpened', () => {
    fileList = null;
    chips.selection = null;
    chips.mentions = [];
    // A reply still streaming is stopped (and kept in the previous project's history), and a commit message being
    // written for the previous project must not land in this one's commit box.
    stop();
    if (commitReq) { commitReq.edited = true; ide.api.invoke('ai-chat:cancel', commitReq.reqId); }
    loadHistory();
  });

  // ---------- commit messages ----------
  let commitReq = null;
  let commitBtn = null;

  async function generateCommitMessage() {
    const vcs = ide.vcs;
    if (commitReq || !vcs?.repo() || !ide.root) return;
    await ide.saveAll();
    await vcs.refresh();
    const box = vcs.commitMessage();
    const files = vcs.includedFiles().map((f) => ({ path: f.path, status: f.status }));
    const reqId = `commit-${seq++}`;
    const before = box.value;
    const req = (commitReq = { reqId, edited: false });
    renderCommitBtn();
    // Typing into the box takes it back from the generator.
    const onInput = (e) => { if (e.isTrusted && !req.edited) { req.edited = true; ide.api.invoke('ai-chat:cancel', reqId); } };
    box.addEventListener('input', onInput);
    streams.set(reqId, (text) => { if (!req.edited) box.value = text; });
    const res = await ide.api.invoke('ai-chat:commitMessage', {
      reqId, root: ide.root, files, language: ide.settings.get(SETTINGS.commitLanguage, 'ko'), model: modelId(),
    }).catch((err) => ({ ok: false, code: 'cli', message: err.message }));
    streams.delete(reqId);
    box.removeEventListener('input', onInput);
    commitReq = null;
    renderCommitBtn();
    if (req.edited) return;
    if (res.ok) {
      box.value = res.text;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    } else if (res.code !== 'cancelled') {
      box.value = before;
      if (res.code === 'empty') vcs.notify(tr('No changes to describe'), tr('Stage changes or tick files in the Commit window.'), 'warn');
      else vcs.notify(tr('Could not generate a commit message'), errorText(res), 'error');
    }
  }

  function renderCommitBtn() {
    if (!commitBtn) return;
    commitBtn.classList.toggle('busy', !!commitReq);
    commitBtn.title = commitReq ? tr('Stop generating') : tr('Generate Commit Message with AI');
  }

  ide.on('ready', () => {
    if (!ide.vcs?.addMessageAction) return;
    commitBtn = el('button', 'aic-commit-gen', '✨');
    commitBtn.onclick = () => (commitReq ? ide.api.invoke('ai-chat:cancel', commitReq.reqId) : generateCommitMessage());
    renderCommitBtn();
    ide.vcs.addMessageAction(commitBtn);
  });

  // ---------- settings ----------
  (ide.settingsPages ||= []).push({
    id: 'ai-chat', group: 'ai', title: () => tr('AI Chat'), keywords: 'ai chat claude commit message conventional language 채팅 커밋 메시지 언어',
    defaults: { [SETTINGS.model]: 'sonnet', [SETTINGS.commitLanguage]: 'ko' },
    mount(host, ctx) {
      const chat = ctx.ui.section(host, tr('AI Chat'));
      chat.appendChild(ctx.ui.fieldRow(tr('Model:'), ctx.ui.selectInput(SETTINGS.model, MODELS.map((m) => [m.id, m.label]), 'sonnet')));
      const commit = ctx.ui.section(host, tr('Commit Messages'));
      commit.appendChild(ctx.ui.fieldRow(tr('Language:'), ctx.ui.selectInput(SETTINGS.commitLanguage, [['ko', '한국어'], ['en', 'English']], 'ko')));
      host.appendChild(el('div', 'muted settings-note', tr('Requests go through the Claude Code CLI with your Claude subscription. The chat sends the files and selections you attach; commit messages send the staged diff, shortened when it is large.')));
    },
  });

  renderAll();

  ide.aiChat = {
    open: focusInput,
    askAboutSelection,
    send,
    stop,
    newChat,
    generateCommitMessage,
    // For tests: the visible chat and the composer.
    state: () => ({
      root: loadedFor,
      current: history.current,
      chats: history.chats.filter((c) => c.messages.length).length,
      pending: !!pending,
      commitPending: !!commitReq,
      messages: (currentChat()?.messages || []).map((m) => ({ role: m.role, text: m.text, context: m.context || null, stopped: !!m.stopped, error: m.error || null, pending: !!m.pending })),
      chips: [...(chipsEl?.querySelectorAll('.aic-chip') || [])].map((c) => ({ kind: c.dataset.kind, label: c.querySelector('.aic-chip-label').textContent })),
    }),
    saved: () => new Promise((r) => setTimeout(r, 250)).then(() => saving).then(() => true),
  };
})();
