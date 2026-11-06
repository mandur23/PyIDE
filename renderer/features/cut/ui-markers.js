// The markers panel (video-editor-features.md section 14 [2]): the active sequence's markers and its clips' markers in
// time order, with their time, length (range markers), name, type and colour; filtered by type, by colour and by a
// search of the name and the comment. A click moves the playhead to the marker, a double click (or Enter) opens the
// marker dialog, Delete removes it, M adds one at the playhead. The list keeps only the rows in view in the DOM, so
// hundreds of beat markers stay fast.
//
// Also the marker dialog the timeline ruler opens: Cut.ui.markers.edit(app, markerId) (name, comment, time, duration,
// type, colour; one undo step).
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const { el } = ui;
  const C = () => Cut.commands;
  const ROW = 24;
  const KINDS = [['comment', 'Comment'], ['chapter', 'Chapter'], ['beat', 'Beat']];
  const colors = () => ui.timeline.MARKER_COLORS || {};
  const colorNames = () => ui.timeline.MARKER_NAMES || {};

  // Every marker of a sequence: {m, clip (null for a sequence marker), t (sequence time)}, by time.
  function markersOf(seq) {
    if (!seq) return [];
    const out = seq.markers.map((m) => ({ m, clip: null, t: m.t }));
    for (const c of seq.clips) for (const m of c.markers || []) out.push({ m, clip: c, t: c.start + m.t });
    return out.sort((a, b) => a.t - b.t || (a.clip ? 1 : 0) - (b.clip ? 1 : 0));
  }
  const findMarker = (seq, id) => markersOf(seq).find((x) => x.m.id === id) || null;

  // The marker dialog. -> the dialog, or null when the marker is gone.
  function edit(app, id) {
    const seq = app.sequence;
    const found = findMarker(seq, id);
    if (!found) return null;
    const { m } = found;
    const fps = () => app.sequence?.fps || [30, 1];
    const name = el('input', 'cut-input cut-marker-name', undefined, { type: 'text', value: m.name });
    name.dataset.userText = '';
    const note = el('textarea', 'cut-input cut-marker-note', undefined, { rows: 3 });
    note.value = m.note || '';
    const at = ui.timecodeField({ fps, value: found.t, cls: 'cut-marker-time' });
    const dur = ui.timecodeField({ fps, value: m.duration || 0, cls: 'cut-marker-duration' });
    const kind = ui.select({ options: KINDS.map(([value, label]) => ({ value, label: tr(label) })), value: m.kind, cls: 'cut-marker-kind' });
    const color = ui.select({ options: Object.keys(colors()).map((k) => ({ value: k, label: tr(colorNames()[k] || k) })), value: m.color, cls: 'cut-marker-color' });
    const body = el('div', 'cut-form');
    body.append(ui.row(tr('Name'), name), ui.row(tr('Comment'), note), ui.row(tr('Time'), at), ui.row(tr('Duration'), dur), ui.row(tr('Type'), kind), ui.row(tr('Color'), color));
    // The dialog takes Enter before a timecode field being typed in: leave the field first so its value counts.
    const settle = () => { if (body.contains(document.activeElement) && document.activeElement !== note && document.activeElement !== name) document.activeElement.blur(); };
    const dlg = ui.dialog({
      title: found.clip ? tr('Clip Marker') : tr('Marker'), body, width: 440, id: 'cutMarkerDialog',
      buttons: [
        { label: tr('OK'), primary: true, run: () => {
          settle();
          const now = findMarker(app.sequence, id);
          if (!now) return;
          const patch = { name: name.value, note: note.value, kind: kind.value, color: color.value, duration: dur.value };
          if (at.value !== now.t) patch.t = at.value;
          const same = Object.entries(patch).every(([k, v]) => (k === 't' ? false : now.m[k] === v));
          if (!same) ui.exec(app, C().setMarker(app.sequence.id, id, patch));
        } },
        { label: tr('Delete'), run: () => { ui.exec(app, C().removeMarker(app.sequence.id, id)); } },
        { label: tr('Cancel') },
      ],
    });
    setTimeout(() => { name.focus(); name.select(); });
    return dlg;
  }

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-markers');
    const bar = el('div', 'cut-panel-toolbar');
    const search = el('input', 'cut-search cut-markers-search', undefined, { type: 'search', placeholder: tr('Search'), spellcheck: 'false' });
    const kindSel = ui.select({ options: [{ value: '', label: tr('All Types') }, ...KINDS.map(([value, label]) => ({ value, label: tr(label) }))], value: '', cls: 'cut-markers-kind', title: tr('Type'), onChange: () => refresh() });
    const colorSel = ui.select({ options: [{ value: '', label: tr('All Colors') }, ...Object.keys(colors()).map((k) => ({ value: k, label: tr(colorNames()[k] || k) }))], value: '', cls: 'cut-markers-color', title: tr('Color'), onChange: () => refresh() });
    const add = ui.button({ icon: 'add', title: tr('Add Marker'), cls: 'cut-markers-add', onClick: () => addHere() });
    bar.append(search, kindSel, colorSel, add);
    const head = el('div', 'cut-markers-head');
    for (const [cls, text] of [['swatch', ''], ['time', tr('Time')], ['dur', tr('Duration')], ['name', tr('Name')], ['kind', tr('Type')]]) head.appendChild(el('span', `cut-mk-col ${cls}`, text));
    let items = [];
    let all = [];
    let selected = null; // marker id
    const list = ui.virtualList({ rowHeight: ROW, cls: 'cut-markers-list', render });
    list.el.setAttribute('role', 'listbox');
    const empty = el('div', 'cut-empty cut-markers-empty');
    const foot = el('div', 'cut-panel-foot');
    root.append(bar, head, list.el, empty, foot);
    host.appendChild(root);
    const fps = () => app.sequence?.fps || [30, 1];

    function render(i) {
      const x = items[i];
      const r = el('div', 'cut-mk-row', undefined, { role: 'option', 'data-id': x.m.id });
      const sw = el('span', 'cut-mk-col swatch');
      const dot = el('span', 'cut-mk-swatch');
      dot.style.background = colors()[x.m.color] || colors().green || '#5fb236';
      sw.appendChild(dot);
      const name = el('span', 'cut-mk-col name', x.m.name || (x.clip ? x.clip.name : ''));
      name.dataset.userText = '';
      if (x.clip) name.classList.add('clip');
      const kindName = KINDS.find(([k]) => k === x.m.kind)?.[1] || x.m.kind;
      r.append(sw, el('span', 'cut-mk-col time', Cut.time.timecode(x.t, fps())), el('span', 'cut-mk-col dur', x.m.duration ? Cut.time.timecode(x.m.duration, fps()) : ''), name,
        el('span', 'cut-mk-col kind', x.clip ? tr('{kind} (clip)', { kind: tr(kindName) }) : tr(kindName)));
      r.title = [x.m.name, x.m.note].filter(Boolean).join('\n');
      if (x.m.id === selected) { r.classList.add('selected'); r.setAttribute('aria-selected', 'true'); }
      return r;
    }

    function refresh() {
      all = markersOf(app.sequence);
      const q = search.value.trim().toLowerCase();
      const k = kindSel.value;
      const c = colorSel.value;
      items = all.filter((x) => (!k || x.m.kind === k) && (!c || x.m.color === c) && (!q || `${x.m.name}\n${x.m.note}`.toLowerCase().includes(q)));
      if (selected && !all.some((x) => x.m.id === selected)) selected = null;
      list.setCount(items.length);
      list.drawNow();
      empty.hidden = items.length > 0;
      list.el.hidden = !items.length;
      empty.textContent = all.length ? tr('No marker matches the filter.') : tr('No markers. Press M to add one at the playhead.');
      foot.textContent = items.length === all.length ? tr('{n} markers', { n: all.length }) : tr('{n} of {total} markers', { n: items.length, total: all.length });
    }
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refresh(); }); };
    offs.push(() => cancelAnimationFrame(raf));

    const select = (id, { go = true } = {}) => {
      const i = items.findIndex((x) => x.m.id === id);
      // The rows stay as they are when nothing changes, so the second click of a double click lands on the same row.
      if (id !== selected) {
        selected = id;
        if (i >= 0) list.scrollTo(i);
        list.drawNow();
      }
      const x = items[i];
      if (go && x) app.setTime(x.t);
    };
    function remove(id) {
      if (!id || !app.sequence) return false;
      const i = items.findIndex((x) => x.m.id === id);
      const r = ui.exec(app, C().removeMarker(app.sequence.id, id));
      if (!r) return false;
      refresh();
      const next = items[Math.min(i, items.length - 1)];
      selected = next ? next.m.id : null;
      list.drawNow();
      return true;
    }
    function addHere() {
      if (!app.sequence) return;
      const r = ui.exec(app, C().addMarker(app.sequence.id, { t: app.t }));
      if (r?.id) { refresh(); select(r.id, { go: false }); }
    }

    search.addEventListener('input', () => refresh());
    list.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const i = list.indexAt(e.clientY);
      if (i < 0) return;
      e.preventDefault();
      list.el.focus({ preventScroll: true });
      select(items[i].m.id);
    });
    list.el.addEventListener('dblclick', (e) => {
      const i = list.indexAt(e.clientY);
      if (i >= 0) edit(app, items[i].m.id);
    });
    list.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const i = list.indexAt(e.clientY);
      if (i < 0) return;
      const id = items[i].m.id;
      select(id);
      const m = items[i].m;
      ui.menu(e.clientX, e.clientY, [
        { label: tr('Edit Marker…'), run: () => edit(app, id) },
        { label: tr('Color'), submenu: Object.keys(colors()).map((k) => ({ label: tr(colorNames()[k] || k), checked: m.color === k, run: () => ui.exec(app, C().setMarker(app.sequence.id, id, { color: k })) })) },
        { separator: true },
        { label: tr('Remove Marker'), hint: 'Delete', run: () => remove(id) },
      ]);
    });
    list.el.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const i = items.findIndex((x) => x.m.id === selected);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const j = Math.max(0, Math.min(items.length - 1, (i < 0 ? -1 : i) + (e.key === 'ArrowDown' ? 1 : -1)));
        if (items[j]) select(items[j].m.id);
      } else if (e.key === 'Enter' && selected) {
        e.preventDefault();
        e.stopPropagation();
        edit(app, selected);
      }
    });
    offs.push(ui.onAction('delete', () => (selected ? remove(selected) : false), { panels: ['markers'] }));
    offs.push(ui.onAction('addMarker', () => { addHere(); }, { panels: ['markers'] }));

    offs.push(app.on('project', later));
    offs.push(app.on('sequence', () => { selected = null; later(); }));
    refresh();
    ui.markers.panel = {
      get items() { return items.map((x) => ({ id: x.m.id, t: x.t, name: x.m.name, kind: x.m.kind, color: x.m.color, duration: x.m.duration, clip: x.clip?.id || null })); },
      get selected() { return selected; },
      rowRect(id) {
        const i = items.findIndex((x) => x.m.id === id);
        if (i < 0) return null;
        list.scrollTo(i);
        list.drawNow();
        return list.el.querySelector(`.cut-mk-row[data-id="${id}"]`)?.getBoundingClientRect() || null;
      },
      refresh,
    };
    return {
      dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } list.dispose(); root.remove(); if (ui.markers.panel) ui.markers.panel = null; },
      focus() { list.el.focus({ preventScroll: true }); },
    };
  }

  ui.markers = { edit, markersOf, panel: null };
  ui.registerPanel('markers', { title: () => tr('Markers'), mount });
})();
