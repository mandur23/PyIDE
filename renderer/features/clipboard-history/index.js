// Paste from History (PyCharm's Edit › Paste from History…, action PasteMultiple, Ctrl+Shift+V).
// The history holds the last texts (30 by default) copied or cut in PyIDE: Monaco editors (with their multi-caret
// pieces and Monaco's whole-line copy), text fields, and the IDE's own copy actions (Copy Path, terminal, consoles…,
// which core announces as `clipboardWritten`). Text copied in other applications is added only with
// clipboardHistory.captureSystem on (off by default): PyCharm reads the system clipboard when its window gets focus,
// but that also catches passwords that password managers put there and clear a few seconds later. The history lives
// in memory for the session; clipboardHistory.persist (off by default) keeps it across restarts, encrypted with
// safeStorage (main/features/clipboard-history.js).
(() => {
  const { el } = ide.util;
  const LIMIT = 'clipboardHistory.limit';
  const PERSIST = 'clipboardHistory.persist';
  const SYSTEM = 'clipboardHistory.captureSystem';
  const DEFAULT_LIMIT = 30;
  const MAX_TEXT = 1024 * 1024; // a larger copy is pasted normally but not kept
  const limit = () => Math.min(100, Math.max(1, Math.round(Number(ide.settings.get(LIMIT, DEFAULT_LIMIT))) || DEFAULT_LIMIT));

  // Newest first: {text, time, multicursor?: [one text per caret], wholeLine?: Monaco copied a line without a selection}.
  let items = [];
  let lastSystem = null; // the system clipboard text last seen or written by Nano Studio
  let popup = null;

  function add(text, meta = {}) {
    if (typeof text !== 'string' || !text || text.length > MAX_TEXT) return;
    lastSystem = text;
    const old = items.find((i) => i.text === text);
    const item = { ...old, text, time: Date.now() };
    if (meta.multicursor !== undefined) {
      if (Array.isArray(meta.multicursor) && meta.multicursor.length > 1) item.multicursor = meta.multicursor.map(String);
      else delete item.multicursor;
    }
    if (meta.wholeLine !== undefined) { if (meta.wholeLine) item.wholeLine = true; else delete item.wholeLine; }
    items = [item, ...items.filter((i) => i !== old)].slice(0, limit());
    changed();
  }
  function remove(item) {
    items = items.filter((i) => i !== item);
    changed();
  }
  function clear() {
    items = [];
    changed();
  }

  // ---------- persistence (opt-in) ----------
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = null; return ide.api.invoke('clipboard-history:save', items).catch(() => {}); };
  function changed() {
    if (ide.settings.get(PERSIST, false) === true) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
    popup?.refresh();
  }
  addEventListener('beforeunload', () => { if (saveTimer) save(); });
  const loaded = (async () => {
    if (ide.settings.get(PERSIST, false) !== true) return;
    const stored = await ide.api.invoke('clipboard-history:load').catch(() => []);
    const seen = new Set(items.map((i) => i.text));
    items = [...items, ...stored.filter((i) => !seen.has(i.text))].slice(0, limit());
    popup?.refresh();
  })();
  ide.on('settingsChanged', (key, value) => {
    if (key === PERSIST) {
      if (value === true) save(); else { clearTimeout(saveTimer); saveTimer = null; ide.api.invoke('clipboard-history:clear').catch(() => {}); }
    } else if (key === LIMIT && items.length > limit()) {
      items = items.slice(0, limit());
      changed();
    }
  });

  // ---------- what gets recorded ----------
  // Copy and cut anywhere in the IDE page. Monaco fills the event's data itself (plain text plus its own metadata with
  // the text of each caret); a text field or plain DOM selection is copied by the browser after the event.
  function selectionText(target) {
    if (target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && /^(text|search|url|email|tel|number|)$/i.test(target.type)))) {
      try { return target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0); } catch { return ''; }
    }
    return String(getSelection() || '');
  }
  const onCopy = (e) => {
    const data = e.clipboardData;
    let text = data?.getData('text/plain') || '';
    let meta = null;
    try { meta = JSON.parse(data?.getData('vscode-editor-data') || 'null'); } catch {}
    if (!text && !e.defaultPrevented) text = selectionText(e.target);
    if (text) add(text, { multicursor: meta?.multicursorText || null, wholeLine: !!meta?.isFromEmptySelection });
  };
  addEventListener('copy', onCopy);
  addEventListener('cut', onCopy);
  ide.on('clipboardWritten', (text) => add(text));
  // Other applications' copies, only when the user asked for them: read when the window gets focus.
  addEventListener('focus', async (e) => {
    if (e.target !== window || ide.settings.get(SYSTEM, false) !== true) return;
    const text = await ide.api.invoke('clipboard:readText').catch(() => '');
    if (text && text !== lastSystem) add(text);
  });

  // ---------- pasting ----------
  const isReadOnly = (ed) => { try { return !!ed.getOption(ide.monaco.editor.EditorOption.readOnly); } catch { return true; } };
  // Pastes like Ctrl+V: with as many carets as the copy had, each caret gets its own piece; a text with one line per
  // caret is spread over them (Monaco's multiCursorPaste); otherwise every caret gets the whole text.
  function pasteInto(ed, item) {
    if (!ed || isReadOnly(ed)) return false;
    ed.focus();
    const carets = ed.getSelections()?.length || 1;
    ed.pushUndoStop();
    ed.trigger('keyboard', 'paste', {
      text: item.text,
      pasteOnNewLine: !!item.wholeLine,
      multicursorText: item.multicursor?.length === carets ? item.multicursor : null,
    });
    ed.pushUndoStop();
    return true;
  }
  // As in PyCharm, the chosen text also goes back on the system clipboard and to the top of the history.
  async function choose(item, ed) {
    pasteInto(ed, item);
    await ide.api.invoke('clipboard:writeText', item.text).catch(() => {});
  }

  // ---------- the popup ----------
  const firstLine = (text) => {
    const lines = text.split(/\r\n|\r|\n/);
    const i = lines.findIndex((l) => l.trim());
    return { line: (lines[Math.max(0, i)] || '').trim(), count: lines.length };
  };
  const matches = (text, q) => q.split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w.toLowerCase()));

  function open(target = ide.editor) {
    if (popup) return;
    const prevFocus = document.activeElement;
    const editor = target;
    const backdrop = el('div', 'ch-backdrop');
    const box = el('div', 'ch-popup');
    box.id = 'pasteFromHistory';
    const title = el('div', 'ch-title', tr('Paste from History'));
    const input = el('input', 'ch-filter');
    input.id = 'pasteHistoryFilter';
    input.spellcheck = false;
    input.placeholder = tr('Type to filter');
    const list = el('div', 'ch-list');
    list.id = 'pasteHistoryList';
    const preview = el('pre', 'ch-preview');
    preview.id = 'pasteHistoryPreview';
    preview.dataset.userText = '';
    const foot = el('div', 'ch-foot muted', tr('Enter pastes the selected text, Delete removes it from the history, Esc closes.'));
    box.append(title, input, list, preview, foot);
    backdrop.append(box);
    // Living in #dialogHost suspends the global keymap while the popup is open.
    document.getElementById('dialogHost').appendChild(backdrop);

    let shown = [];
    let selected = null;
    function select(item) {
      selected = item;
      for (const r of list.children) r.classList.toggle('active', r._item === item);
      list.querySelector('.ch-row.active')?.scrollIntoView({ block: 'nearest' });
      const text = item?.text || '';
      const lines = text.split(/\r\n|\r|\n/);
      preview.textContent = lines.length > 200 ? `${lines.slice(0, 200).join('\n')}\n…` : text;
    }
    function refresh() {
      const q = input.value.trim();
      shown = items.filter((i) => matches(i.text, q));
      list.replaceChildren(...shown.map((item, n) => {
        const row = el('div', 'ch-row');
        row._item = item;
        const { line, count } = firstLine(item.text);
        const label = el('span', 'ch-label', line || tr('(whitespace)'));
        if (line) label.dataset.userText = '';
        row.append(el('span', 'ch-index muted', String(n + 1)), label);
        const hint = item.multicursor ? tr('{n} carets', { n: item.multicursor.length }) : count > 1 ? tr('{n} lines', { n: count }) : '';
        if (hint) row.append(el('span', 'ch-hint muted', hint));
        row.onmousedown = (e) => { e.preventDefault(); select(item); };
        row.ondblclick = () => pick(item);
        return row;
      }));
      if (!shown.length) list.append(el('div', 'ch-empty muted', items.length ? tr('Nothing found') : tr('Nothing has been copied yet')));
      select(shown.includes(selected) ? selected : shown[0] || null);
    }
    function close() {
      if (popup !== me) return;
      popup = null;
      backdrop.remove();
      if (prevFocus?.isConnected && prevFocus !== document.body) prevFocus.focus(); else ide.editor?.focus();
    }
    function pick(item) {
      if (!item) return;
      close();
      choose(item, editor && ide.editors().includes(editor) ? editor : ide.editor);
    }
    function move(step, abs) {
      if (!shown.length) return;
      const i = shown.indexOf(selected);
      const next = abs !== undefined ? abs : Math.min(shown.length - 1, Math.max(0, (i < 0 ? 0 : i) + step));
      select(shown[next]);
    }
    input.oninput = refresh;
    input.onkeydown = (e) => {
      const page = Math.max(1, Math.floor(list.clientHeight / 24) - 1);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } else if (e.key === 'PageDown') { e.preventDefault(); move(page); } else if (e.key === 'PageUp') { e.preventDefault(); move(-page); } else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); pick(selected); } else if (e.key === 'Delete' && selected && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
        // Delete edits the filter while there is text after the caret; at its end it removes the selected item.
        e.preventDefault();
        const i = shown.indexOf(selected);
        const gone = selected;
        selected = shown[i + 1] || shown[i - 1] || null;
        remove(gone);
      }
    };
    backdrop.onmousedown = (e) => { if (e.target === backdrop) close(); };
    input.onblur = () => setTimeout(() => !box.contains(document.activeElement) && close(), 120);
    const me = { close, refresh };
    popup = me;
    refresh();
    input.focus();
    loaded.then(() => popup === me && refresh());
  }

  ide.registerAction({ id: 'PasteMultiple', title: tr('Paste from History…'), keys: 'Ctrl+Shift+V', run: () => open() });
  // The editor's context menu, next to Monaco's Cut / Copy / Paste.
  ide.onEditor((ed) => {
    ed.addAction({ id: 'pyide.pasteFromHistory', label: tr('Paste from History…'), contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 4.5, precondition: '!editorReadonly', run: () => open(ed) });
  });

  // ---------- Settings › Editor › Clipboard ----------
  (ide.settingsPages ||= []).push({
    id: 'clipboard', group: 'editor', title: () => tr('Clipboard'),
    keywords: 'clipboard paste history copy 클립보드 붙여넣기 기록 복사',
    defaults: { [LIMIT]: DEFAULT_LIMIT, [PERSIST]: false, [SYSTEM]: false },
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Paste from History'));
      s.appendChild(ctx.ui.fieldRow(tr('Maximum number of contents to keep in clipboard:'), ctx.ui.numberInput(LIMIT, { min: 1, max: 100, fallback: DEFAULT_LIMIT }), '1 – 100'));
      s.appendChild(ctx.ui.checkbox(SYSTEM, tr('Also keep text copied in other applications (read when Nano Studio gets focus)')));
      s.appendChild(ctx.ui.checkbox(PERSIST, tr('Keep the history after a restart (encrypted on this computer)')));
      s.appendChild(el('div', 'muted settings-note', tr('Copied text can hold passwords and tokens, so both are off by default: the history then lives only until Nano Studio closes.')));
      const clearBtn = el('button', 'secondary ch-clear', tr('Clear History'));
      clearBtn.onclick = () => { clear(); clearBtn.disabled = true; };
      clearBtn.disabled = !items.length;
      s.appendChild(clearBtn);
    },
  });

  ide.clipboardHistory = {
    items: () => items.map((i) => ({ ...i })),
    add, clear,
    remove: (text) => { const it = items.find((i) => i.text === text); if (it) remove(it); },
    open, isOpen: () => !!popup, close: () => popup?.close(),
    paste: (text, ed = ide.editor) => { const it = items.find((i) => i.text === text) || { text }; return choose(it, ed); },
    loaded: () => loaded,
  };
})();
