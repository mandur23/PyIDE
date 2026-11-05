// The effects panel of Nano Studio Cut (video-editor-features.md section 8): the video and audio effects and
// transitions of the registry (Cut.effects) by category, a search over their names, and favorites. An item is dragged
// onto a clip (effects) or an edit point (transitions) in the timeline, or onto the effect controls panel; a double
// click applies it to the selected clips (a transition: at their ends, or at the edit point nearest the playhead).
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const el = ui.el;

  const FAV_KEY = 'cut.effectFavorites';
  const svg = (body) => `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const GLYPHS = {
    folder: svg('<path d="M1.5 4V13h13V5.5H7.5L6 4z" stroke="currentColor"/>'),
    effect: svg('<rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor"/><path d="M5.5 10.5 7 5.5h2M5.8 8h2.2M9.5 7.5l2 3M11.5 7.5l-2 3" stroke="currentColor"/>'),
    audio: svg('<path d="M2 8h1M4.5 5v6M7 3v10M9.5 5.5v5M12 4v8M14 7v2" stroke="currentColor" stroke-width="1.3"/>'),
    transition: svg('<rect x="1.5" y="4" width="6" height="8" rx="1" stroke="currentColor"/><rect x="8.5" y="4" width="6" height="8" rx="1" stroke="currentColor" opacity=".6"/><path d="M5 12 11 4" stroke="currentColor"/>'),
    star: svg('<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" fill="currentColor"/>'),
    twisty: svg('<path d="m5.5 4 4 4-4 4" stroke="currentColor" stroke-width="1.4"/>'),
  };
  const glyph = (name) => {
    const s = el('span', 'ide-icon cut-icon');
    s.innerHTML = GLYPHS[name];
    return s;
  };

  function catalog() {
    const fx = Cut.effects;
    if (!fx) return [];
    const groups = [
      { id: 'video', name: 'Video Effects', items: fx.list('video').map((d) => ({ ...d, what: 'effect' })) },
      { id: 'audio', name: 'Audio Effects', items: fx.list('audio').map((d) => ({ ...d, what: 'effect' })) },
      { id: 'vtrans', name: 'Video Transitions', items: fx.transitions('video').map((d) => ({ ...d, what: 'transition' })) },
      { id: 'atrans', name: 'Audio Transitions', items: fx.transitions('audio').map((d) => ({ ...d, what: 'transition' })) },
    ];
    for (const g of groups) {
      const cats = new Map();
      for (const it of g.items) {
        if (!cats.has(it.category)) cats.set(it.category, []);
        cats.get(it.category).push(it);
      }
      g.categories = [...cats].map(([name, items]) => ({ name, items }));
    }
    return groups;
  }

  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-fx', undefined, { tabindex: -1 });
    const search = el('input', 'cut-fx-search', undefined, { type: 'search', placeholder: tr('Search effects and transitions'), spellcheck: false });
    const tree = el('div', 'cut-fx-tree', undefined, { role: 'tree' });
    root.append(search, tree);
    host.appendChild(root);
    const open = new Set(['video', 'vtrans']);
    let favorites = new Set(ide.settings.get(FAV_KEY, []));
    let selected = null;

    const label = (it) => tr(it.name);
    const matches = (it, q) => !q || [tr(it.name), it.name, tr(it.category), it.category, it.type].some((s) => String(s).toLowerCase().includes(q));

    function itemRow(it, depth) {
      const row = el('div', `cut-fx-item${selected === it.type ? ' selected' : ''}`, undefined, { role: 'treeitem', 'data-type': it.type, 'data-what': it.what, title: label(it) });
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.appendChild(glyph(it.what === 'transition' ? 'transition' : it.kind === 'audio' ? 'audio' : 'effect'));
      row.appendChild(el('span', 'cut-fx-name', label(it)));
      const dflt = it.what === 'transition' && isDefault(it);
      if (dflt) row.appendChild(el('span', 'cut-fx-badge', tr('Default')));
      if (favorites.has(it.type)) row.appendChild(el('span', 'cut-fx-fav', undefined, { title: tr('Favorite') })).appendChild(glyph('star'));
      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        selected = it.type;
        for (const n of tree.querySelectorAll('.cut-fx-item.selected')) n.classList.remove('selected');
        row.classList.add('selected');
        ui.dnd.start(e, { kind: it.what, type: it.type }, { label: label(it) });
      });
      row.addEventListener('dblclick', () => apply(it));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const items = [
          { label: tr('Apply to Selected Clips'), run: () => apply(it) },
          { label: favorites.has(it.type) ? tr('Remove from Favorites') : tr('Add to Favorites'), run: () => toggleFavorite(it.type) },
        ];
        if (it.what === 'transition') items.push({ label: tr('Set Selected as Default Transition'), checked: isDefault(it), run: () => { ide.settings.set(it.kind === 'audio' ? 'cut.defaultAudioTransition' : 'cut.defaultVideoTransition', it.type); draw(); } });
        ui.menu(e.clientX, e.clientY, items);
      });
      return row;
    }
    const isDefault = (it) => (ide.settings.get(it.kind === 'audio' ? 'cut.defaultAudioTransition' : 'cut.defaultVideoTransition', '') || Cut.effects?.defaultTransition?.(it.kind)) === it.type;
    function folderRow(id, name, depth, count) {
      const row = el('div', `cut-fx-folder${open.has(id) ? ' open' : ''}`, undefined, { role: 'treeitem', 'data-folder': id, 'aria-expanded': String(open.has(id)) });
      row.style.paddingLeft = `${4 + depth * 14}px`;
      row.append(glyph('twisty'), glyph('folder'), el('span', 'cut-fx-name', name));
      if (count != null) row.appendChild(el('span', 'cut-fx-count', String(count)));
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => { if (open.has(id)) open.delete(id); else open.add(id); draw(); });
      return row;
    }
    function draw() {
      const q = search.value.trim().toLowerCase();
      const groups = catalog();
      const rows = [];
      if (!groups.length) { tree.replaceChildren(el('div', 'cut-ec-empty', tr('The effects are not available.'))); return; }
      const favItems = groups.flatMap((g) => g.items).filter((it) => favorites.has(it.type) && matches(it, q));
      if (favItems.length) {
        rows.push(folderRow('fav', tr('Favorites'), 0));
        if (open.has('fav') || q) for (const it of favItems) rows.push(itemRow(it, 1));
      }
      for (const g of groups) {
        const cats = g.categories.map((c) => ({ ...c, items: c.items.filter((it) => matches(it, q)) })).filter((c) => c.items.length);
        if (q && !cats.length) continue;
        rows.push(folderRow(g.id, tr(g.name), 0));
        if (!open.has(g.id) && !q) continue;
        for (const c of cats) {
          const cid = `${g.id}/${c.name}`;
          rows.push(folderRow(cid, tr(c.name), 1, c.items.length));
          if (open.has(cid) || q) for (const it of c.items) rows.push(itemRow(it, 2));
        }
      }
      if (q && rows.length === 0) rows.push(el('div', 'cut-ec-empty', tr('Nothing matches “{q}”.', { q: search.value.trim() })));
      tree.replaceChildren(...rows);
    }
    function toggleFavorite(type) {
      if (favorites.has(type)) favorites.delete(type); else { favorites.add(type); open.add('fav'); }
      ide.settings.set(FAV_KEY, [...favorites]);
      draw();
    }
    // Effects go on every selected clip of their kind; transitions at the selected clips' ends or the nearest edit point.
    function apply(it) {
      const seq = app.sequence;
      if (!seq) return null;
      if (it.what === 'transition') return ui.timeline.addTransitions?.({ video: it.kind !== 'audio', audio: it.kind === 'audio', type: it.type });
      const clips = [...app.selection].map((id) => ui.edit.clipById(seq, id)).filter((c) => c && ui.edit.kindOf(seq, c) === (it.kind || 'video'));
      if (!clips.length) { ui.toast(it.kind === 'audio' ? tr('Select an audio clip first.') : tr('Select a video clip first.')); return null; }
      app.history.begin('Add Effect');
      try {
        for (const c of clips) app.history.do(C.addEffect(seq.id, c.id, it.type));
        app.history.commit();
      } catch (err) {
        app.history.cancel();
        ui.report(err);
        return null;
      }
      return { clips: clips.map((c) => c.id) };
    }
    search.addEventListener('input', () => draw());
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ''; draw(); } });
    offs.push(ide.on('settingsChanged', (key) => { if (key === FAV_KEY) { favorites = new Set(ide.settings.get(FAV_KEY, [])); draw(); } }));
    draw();
    ui.effectsPanel = { apply: (type) => { const it = catalog().flatMap((g) => g.items).find((x) => x.type === type); return it ? apply(it) : null; }, search: (q) => { search.value = q; draw(); } };
    return {
      dispose() { for (const off of offs.splice(0)) { try { off(); } catch {} } root.remove(); },
      focus() { root.focus({ preventScroll: true }); },
    };
  }

  ui.registerPanel('effects', { title: () => tr('Effects'), mount });
})();
