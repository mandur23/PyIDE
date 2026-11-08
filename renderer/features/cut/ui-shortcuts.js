// The editor's keyboard shortcut editor and the "?" cheat sheet (video-editor-features.md section 18 [2]).
//
// Every Cut action is an IDE action `Cut.<id>` (ui-keys.js, plus the Window, Automation and other actions panels
// register), so the IDE keymap machinery does the work: ide.keymap.comboOf records a key, ide.keymap.parse checks the
// stored lists, and an action's `defaultKeys`/`keys` are what the core keydown handler fires. The user's Cut keys are
// the setting `cut.keys` ({actionId: [keys]}, only what differs from the built-in keys); apply() puts them on the
// actions at once whenever it changes. The IDE's own `keymap.overrides` (Settings › Keymap in Code) still wins when it
// names a Cut action, as it does for every action. Keeping Cut's keys apart means Code's Reset All never resets them.
//
// The editor lists every Cut action by kind, filters by name or key, records a key (the next key press), removes or
// resets one, and Reset All; two Cut actions with one key are marked and Save waits until each is resolved. A key
// that also belongs to an IDE action (Find Action...) is noted: inside the editor Cut takes it.
//
// The built-in keys are those of the keyboard preset (ui-keys.js: Adobe Premiere Pro or the classic Cut keys); the editor's
// preset menu switches it, which starts the draft from that preset's keys as Premiere's own Keyboard Shortcuts does.
//
// Cut.ui.shortcuts: apply(), open() -> the dialog, sheet() (toggles the cheat sheet), builtin(id), current(id).
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, button } = ui;

  const KEY = 'cut.keys';
  const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta']);
  const own = new Set((ui.keys?.actions || []).map((id) => `Cut.${id}`));
  const registered = new Map(); // action id -> the keys it was registered with (for actions no preset names)
  // An action's built-in keys in a preset (the current one by default).
  const builtinOf = (id, preset) => ui.keys?.presetKeys?.(id.slice(4), preset) ?? registered.get(id) ?? [];
  const isCut = (a) => typeof a.id === 'string' && a.id.startsWith('Cut.') && !!a.title;
  const cutActions = () => ide.actions.filter(isCut);
  const fmt = (k) => ide.keymap.format(k);
  const same = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
  const stored = () => { const v = ide.settings.get(KEY, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  const kindOf = (a) => ui.keys?.kindOf?.(a.id.slice(4)) || 'editing';

  // Puts the stored keys on every Cut action registered so far. Actions that do not go through ui-keys.js (Window,
  // Automation) get the typing guard ui-keys.js gives its own: a single-letter key must not fire inside a field.
  function apply() {
    const ov = ide.keymap.parse(stored());
    for (const a of cutActions()) {
      if (!registered.has(a.id)) registered.set(a.id, [...(a.defaultKeys || a.keys || [])]);
      const want = ov.get(a.id) || builtinOf(a.id);
      a.defaultKeys = [...want];
      if (!ide.keymap.isModified(a.id)) a.keys = [...want];
      if (!own.has(a.id) && !a.cutGuard) {
        const when = a.when;
        a.when = () => (!when || when()) && !ui.isTyping();
        a.cutGuard = true;
      }
    }
    ide.emit('keymapChanged');
  }
  ide.on('settingsChanged', (k) => { if (k === KEY) apply(); });

  // ---------- the editor ----------
  let editor = null;
  function open() {
    if (editor) return editor;
    apply();
    const actions = cutActions();
    const kinds = ui.keys?.kinds || [{ id: 'editing', title: () => tr('Editing') }];
    const order = new Map(kinds.map((k, i) => [k.id, i]));
    actions.sort((a, b) => (order.get(kindOf(a)) - order.get(kindOf(b))) || a.title.localeCompare(b.title));
    const draft = new Map(actions.map((a) => [a.id, [...(a.defaultKeys || a.keys || [])]]));
    let preset = ui.keys?.preset || 'premiere';
    const builtin = (id) => builtinOf(id, preset);
    let recording = null;
    let query = '';

    const body = el('div', 'cut-keys');
    // The keyboard preset: another one starts every key from that preset (the person's own keys go).
    const presetSelect = ui.select({ options: (ui.keys?.presets || []).map((p) => ({ value: p.id, label: p.title() })), value: preset, cls: 'cut-keys-preset', title: tr('Keyboard Layout Preset'),
      onChange: (v) => { preset = v; recording = null; for (const id of draft.keys()) draft.set(id, [...builtin(id)]); render(); } });
    const presetRow = el('label', 'cut-keys-preset-row');
    presetRow.append(el('span', null, tr('Keyboard Layout Preset')), presetSelect);
    const search = el('input', 'cut-keys-search', undefined, { type: 'search', placeholder: tr('Search actions or keys'), spellcheck: 'false' });
    search.dataset.enter = 'ignore';
    const list = el('div', 'cut-keys-list', undefined, { tabindex: -1 });
    const status = el('div', 'cut-keys-status');
    body.append(presetRow, el('div', 'cut-dialog-note', tr('Click Record, then press the key. Keys apply as soon as you save; a key two actions share must be changed first.')), search, list, status);

    const conflicts = () => {
      const by = new Map();
      for (const [id, keys] of draft) for (const k of keys) (by.get(k) || by.set(k, []).get(k)).push(id);
      return new Map([...by].filter(([, ids]) => ids.length > 1));
    };
    // IDE actions outside Cut with that key (Find Action, Settings...): only noted.
    const outside = (k) => ide.actions.filter((a) => !isCut(a) && a.title && (a.keys || []).includes(k));
    const titleOf = (id) => actions.find((a) => a.id === id)?.title || id;

    function render() {
      const clash = conflicts();
      const q = query.toLowerCase();
      list.replaceChildren();
      for (const kind of kinds) {
        const rows = actions.filter((a) => kindOf(a) === kind.id).filter((a) => {
          if (!q) return true;
          const keys = draft.get(a.id);
          return a.title.toLowerCase().includes(q) || keys.some((k) => k.toLowerCase().includes(q) || fmt(k).toLowerCase().includes(q));
        });
        if (!rows.length) continue;
        list.appendChild(el('div', 'cut-keys-kind', kind.title()));
        for (const a of rows) list.appendChild(row(a, clash));
      }
      if (!list.childElementCount) list.appendChild(el('div', 'cut-empty', tr('No actions found')));
      const n = clash.size;
      status.textContent = n ? tr('Keys used by more than one action: {n}. Change or remove them to save.', { n }) : '';
      status.dataset.state = n ? 'conflict' : 'ok';
      if (saveBtn) saveBtn.disabled = n > 0;
      if (resetAllBtn) resetAllBtn.disabled = [...draft].every(([id, keys]) => same(keys, builtin(id)));
    }
    function row(a, clash) {
      const keys = draft.get(a.id);
      const r = el('div', 'cut-keys-row', undefined, { 'data-id': a.id });
      const changed = !same(keys, builtin(a.id));
      r.classList.toggle('modified', changed);
      const title = el('span', 'cut-keys-title', a.title);
      const cell = el('span', 'cut-keys-keys');
      for (const k of keys) {
        const chip = el('span', `cut-key-chip${clash.has(k) ? ' conflict' : ''}`, undefined, { 'data-key': k });
        chip.appendChild(el('kbd', null, fmt(k)));
        const x = el('button', 'cut-key-remove', '×', { type: 'button', title: tr('Remove {key}', { key: fmt(k) }), 'aria-label': tr('Remove {key}', { key: fmt(k) }) });
        x.addEventListener('mousedown', (e) => e.preventDefault());
        x.addEventListener('click', () => { draft.set(a.id, draft.get(a.id).filter((y) => y !== k)); render(); });
        chip.appendChild(x);
        cell.appendChild(chip);
      }
      if (recording === a.id) cell.appendChild(el('span', 'cut-keys-listening', tr('Press a key…')));
      const rec = button({ label: recording === a.id ? tr('Cancel') : tr('Record'), cls: 'cut-keys-record', onClick: () => { recording = recording === a.id ? null : a.id; render(); } });
      const reset = button({ label: tr('Reset'), cls: 'cut-keys-reset', disabled: !changed, onClick: () => { draft.set(a.id, [...builtin(a.id)]); render(); } });
      r.append(title, cell, rec, reset);
      const notes = [];
      for (const k of keys) {
        if (clash.has(k)) notes.push(el('div', 'cut-keys-conflict', tr('{key} is also {actions}', { key: fmt(k), actions: clash.get(k).filter((id) => id !== a.id).map(titleOf).join(', ') })));
        else {
          const ide2 = outside(k);
          if (ide2.length) notes.push(el('div', 'cut-keys-shadow', tr('{key} is also {actions} outside the editor; here the editor takes it.', { key: fmt(k), actions: ide2.map((x) => x.title).join(', ') })));
        }
      }
      if (notes.length) { const n = el('div', 'cut-keys-notes'); n.append(...notes); r.appendChild(n); }
      if (recording === a.id) r.classList.add('recording');
      return r;
    }
    search.addEventListener('input', () => { query = search.value.trim(); render(); });

    // The next key press is the key (Tab still moves between the controls); registered before the dialog's own key
    // handler, so Enter and Esc are recorded instead of closing it.
    const onKey = (e) => {
      if (!recording || e.isComposing) return;
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (MODIFIERS.has(e.key)) return;
      const combo = ide.keymap.comboOf(e);
      const id = recording;
      recording = null;
      if (ide.keymap.isValid(combo) && !draft.get(id).includes(combo)) draft.set(id, [...draft.get(id), combo]);
      render();
      list.querySelector(`.cut-keys-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    addEventListener('keydown', onKey, true);

    let saveBtn = null;
    let resetAllBtn = null;
    const dlg = ui.dialog({
      title: tr('Keyboard Shortcuts'),
      id: 'cutKeysDialog',
      body,
      width: 720,
      onClose: () => { removeEventListener('keydown', onKey, true); editor = null; },
      buttons: [
        { label: tr('Save'), primary: true, run: () => {
          if (conflicts().size) return false;
          const out = {};
          // Keys of actions not loaded now stay as they are.
          for (const [id, keys] of Object.entries(stored())) if (!draft.has(id)) out[id] = keys;
          for (const [id, keys] of draft) if (!same(keys, builtin(id))) out[id] = keys;
          if (preset !== ui.keys?.preset) ui.keys?.setPreset?.(preset);
          ide.settings.set(KEY, out);
          ui.toast(tr('Keyboard shortcuts saved'));
          return undefined;
        } },
        { label: tr('Reset All'), run: () => { for (const id of draft.keys()) draft.set(id, [...builtin(id)]); recording = null; render(); return false; } },
        { label: tr('Cancel') },
      ],
    });
    dlg.el.classList.add('cut-keys-dialog');
    [saveBtn, resetAllBtn] = dlg.el.querySelectorAll('.dialog-buttons button');
    saveBtn.classList.add('cut-keys-save');
    resetAllBtn.classList.add('cut-keys-reset-all');
    render();
    search.focus();
    editor = { dialog: dlg, draft, render, get recording() { return recording; }, get preset() { return preset; }, presetSelect };
    return editor;
  }

  // ---------- the cheat sheet ----------
  let sheet = null;
  const helpKeys = () => ide.actions.find((a) => a.id === 'Cut.keyHelp')?.keys || ['Shift+/'];
  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    removeEventListener('keydown', sheetKey, true);
  }
  function sheetKey(e) {
    if (e.isComposing || MODIFIERS.has(e.key)) return;
    if (e.key === 'Escape' || helpKeys().includes(ide.keymap.comboOf(e))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSheet();
    }
  }
  function openSheet() {
    const root = document.querySelector('.cut-root');
    if (!root || sheet) return;
    apply();
    sheet = el('div', 'cut-keysheet', undefined, { role: 'dialog', 'aria-label': tr('Keyboard Shortcuts') });
    const box = el('div', 'cut-keysheet-box');
    const head = el('div', 'cut-keysheet-head');
    head.append(el('span', 'cut-keysheet-title', tr('Keyboard Shortcuts')),
      el('span', 'cut-keysheet-hint', tr('Press {key} or Esc to close', { key: helpKeys().map(fmt).join(' / ') })),
      button({ label: tr('Edit Shortcuts…'), cls: 'cut-keysheet-edit', onClick: () => { closeSheet(); open(); } }));
    const grid = el('div', 'cut-keysheet-grid');
    for (const kind of ui.keys?.kinds || []) {
      const list = cutActions().filter((a) => kindOf(a) === kind.id && a.keys?.length).sort((a, b) => a.title.localeCompare(b.title));
      if (!list.length) continue;
      const group = el('section', 'cut-keysheet-group', undefined, { 'data-kind': kind.id });
      group.appendChild(el('h3', null, kind.title()));
      for (const a of list) {
        const r = el('div', 'cut-keysheet-row', undefined, { 'data-id': a.id });
        const keys = el('span', 'cut-keysheet-keys');
        for (const k of a.keys) keys.appendChild(el('kbd', null, fmt(k)));
        r.append(el('span', 'cut-keysheet-name', a.title), keys);
        group.appendChild(r);
      }
      grid.appendChild(group);
    }
    box.append(head, grid);
    sheet.appendChild(box);
    sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) closeSheet(); });
    root.appendChild(sheet);
    addEventListener('keydown', sheetKey, true);
  }
  const toggleSheet = () => (sheet ? closeSheet() : openSheet());

  ui.onAction('keyHelp', () => { toggleSheet(); });
  ui.onAction('keyboardShortcuts', () => { open(); });
  apply();

  ui.shortcuts = {
    apply, open, sheet: toggleSheet, closeSheet,
    get sheetOpen() { return !!sheet; },
    get editor() { return editor; },
    builtin: (id) => [...builtinOf(id)],
    current: (id) => [...(ide.actions.find((a) => a.id === id)?.keys || [])],
  };
})();
