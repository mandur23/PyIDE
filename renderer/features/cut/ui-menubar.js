// The menu bar over the top bar (ui-shell.js builds it at start): Premiere Pro's top-level menus File, Edit, Clip,
// Sequence, Markers, Graphics and Titles, View, Window and Help, each holding the Cut commands Premiere keeps there.
// Every item that is a Cut action runs it (Cut.ui.runAction, given to the timeline so it acts on the active sequence
// whichever panel has the keyboard) and shows its key from the keymap, so the menus follow the keyboard preset.
// A click opens a menu; while one is open, moving over another title opens that one, and Left/Right go to the
// neighbouring menus, as in a desktop menu bar.
//
// Cut.ui.menubar: { build(app) -> element, MENUS (ids), open(id) -> the menu element, items(id) -> the items }
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el } = ui;

  // An item for a Cut action: its title from the keymap list, its key as the hint. panel: where the action goes.
  const action = (id, { label, panel = 'timeline', disabled = false, checked } = {}) => ({
    label: label || ui.keys?.title?.(id) || id,
    keyAction: `Cut.${id}`,
    disabled,
    checked,
    run: () => ui.runAction(id, { source: 'menu', panel }),
  });
  const sep = { separator: true };
  const setting = (key, fallback) => ide.settings.get(key, fallback);
  // A text or color clip at the playhead on the patched video track (the project panel's New Item does the same).
  function newGenerated(app, source, name) {
    const seq = app.sequence;
    const track = ui.patchFor(app).video;
    if (!seq || !track) return void ui.toast(tr('There is no video track.'));
    const r = ui.exec(app, Cut.commands.addGenerated(seq.id, { track, at: app.t, source, name, mode: 'overwrite' }));
    if (r?.id) { app.select([r.id]); ui.showPanel?.(source.generator === 'text' ? 'text' : 'timeline'); }
  }

  const MENUS = [
    { id: 'file', title: 'File', items: (app) => [
      { label: tr('New'), submenu: [
        action('newProject', { label: tr('Project…') }),
        action('newSequence', { label: tr('Sequence…') }),
        action('newBin', { label: tr('Bin') }),
      ] },
      action('open'),
      sep,
      action('save', { label: tr('Save') }),
      action('saveAs', { label: tr('Save As…') }),
      action('saveCopy'),
      sep,
      action('import', { label: tr('Import…') }),
      { label: tr('Import Folder…'), run: () => ui.media?.importFolder?.(app) },
      action('findMissing'),
      sep,
      { label: tr('Export'), submenu: [
        action('export', { label: tr('Media…') }),
        action('exportFrame', { label: tr('Frame…') }),
        { label: tr('Captions…'), disabled: !app.sequence?.captions?.length, run: () => ui.captions?.exportDialog?.(app) },
      ] },
    ] },
    { id: 'edit', title: 'Edit', items: (app) => {
      const none = !app.selection.size;
      return [
        action('undo', { disabled: !app.history?.canUndo }),
        action('redo', { disabled: !app.history?.canRedo }),
        sep,
        action('cut', { disabled: none }),
        action('copy', { disabled: none }),
        action('paste'),
        action('pasteInsert'),
        sep,
        action('delete', { disabled: none }),
        action('rippleDelete', { disabled: none }),
        sep,
        action('selectAll'),
        action('deselect', { disabled: none }),
        sep,
        action('selectUnused', { panel: 'project' }),
        action('removeUnused', { panel: 'project' }),
        sep,
        action('keyboardShortcuts'),
        action('settings', { label: tr('Preferences…') }),
      ];
    } },
    { id: 'clip', title: 'Clip', items: (app) => {
      const none = !app.selection.size;
      return [
        action('speed', { disabled: none }),
        sep,
        action('insert', { panel: 'source', disabled: !app.source }),
        action('overwrite', { panel: 'source', disabled: !app.source }),
        sep,
        action('toggleEnabled', { disabled: none }),
        action('link', { disabled: none }),
        action('group', { disabled: app.selection.size < 2 }),
        action('ungroup', { disabled: none }),
        sep,
        { label: tr('Video Options'), submenu: [action('freezeFrame')] },
        { label: tr('Proxy'), submenu: [action('createProxy', { panel: 'project' })] },
        sep,
        action('nudgeUp', { disabled: none }),
        action('nudgeDown', { disabled: none }),
      ];
    } },
    { id: 'sequence', title: 'Sequence', items: (app) => [
      { label: tr('Sequence Settings…'), disabled: !app.sequence, run: () => ui.media?.newSequenceDialog?.(app, app.sequence) },
      sep,
      action('matchFrame'),
      action('split'),
      action('splitAll'),
      action('rippleStart'),
      action('rippleEnd'),
      action('extendEdit'),
      sep,
      action('transitionVideo'),
      action('transitionAudio'),
      action('transitionBoth'),
      sep,
      action('lift'),
      action('extract'),
      sep,
      action('zoomIn'),
      action('zoomOut'),
      action('zoomFit'),
      sep,
      action('snap', { checked: !!ui.editing.snapping }),
      sep,
      { label: tr('Add Video Track'), disabled: !app.sequence, run: () => ui.exec(app, Cut.commands.addTrack(app.sequence.id, 'video')) },
      { label: tr('Add Audio Track'), disabled: !app.sequence, run: () => ui.exec(app, Cut.commands.addTrack(app.sequence.id, 'audio')) },
    ] },
    { id: 'markers', title: 'Markers', items: (app) => {
      const io = app.inOut;
      const marks = app.sequence?.markers || [];
      const here = marks.find((m) => m.t === app.t);
      return [
        action('markIn'),
        action('markOut'),
        action('markClip'),
        action('markSelection', { disabled: !app.selection.size }),
        sep,
        action('goIn', { disabled: io.in == null }),
        action('goOut', { disabled: io.out == null }),
        sep,
        action('clearIn', { disabled: io.in == null }),
        action('clearOut', { disabled: io.out == null }),
        action('clearInOut', { disabled: io.in == null && io.out == null }),
        sep,
        action('addMarker'),
        action('nextMarker', { disabled: !marks.some((m) => m.t > app.t) }),
        action('prevMarker', { disabled: !marks.some((m) => m.t < app.t) }),
        action('clearMarker', { disabled: !here }),
        action('clearAllMarkers', { disabled: !marks.length }),
        { label: tr('Edit Marker…'), disabled: !here, run: () => ui.markers?.edit?.(app, here.id) },
      ];
    } },
    { id: 'graphics', title: 'Graphics and Titles', items: (app) => [
      { label: tr('New Layer'), submenu: [
        { label: tr('Text'), run: () => newGenerated(app, { generator: 'text', layers: [Cut.model.createTextLayer({ text: tr('Title') })] }, tr('Text')) },
        { label: tr('Color Matte'), run: () => newGenerated(app, { generator: 'solid', color: '#2f6fdb' }, tr('Color Matte')) },
      ] },
      action('tool.text'),
      sep,
      { label: tr('Import Captions…'), run: () => ui.captions?.importDialog?.(app) },
      { label: tr('Export Captions…'), disabled: !app.sequence?.captions?.length, run: () => ui.captions?.exportDialog?.(app) },
      { label: tr('Caption Style…'), disabled: !app.sequence?.captions?.length, run: () => ui.captions?.styleDialog?.(app) },
    ] },
    { id: 'view', title: 'View', items: () => {
      const q = Number(setting('cut.program.quality', 1)) || 1;
      return [
        { label: tr('Playback Resolution'), submenu: [[1, 'Full'], [0.5, '1/2'], [0.25, '1/4']].map(([v, l]) => ({ label: tr(l), checked: q === v, run: () => ide.settings.set('cut.program.quality', v) })) },
        { label: tr('Play Proxies'), checked: !!setting('cut.proxy', false), run: () => ide.settings.set('cut.proxy', !setting('cut.proxy', false)) },
        { label: tr('Safe Margins'), checked: !!setting('cut.program.safe', false), run: () => ide.settings.set('cut.program.safe', !setting('cut.program.safe', false)) },
        sep,
        action('fullscreen', { panel: 'program' }),
        action('maximizePanel'),
        sep,
        { label: tr('Timeline Tool Bar'), checked: !!setting('cut.timelineTools', false), run: () => ide.settings.set('cut.timelineTools', !setting('cut.timelineTools', false)) },
        action('keyHelp'),
      ];
    } },
    { id: 'window', title: 'Window', items: () => [
      { label: tr('Workspaces'), submenu: () => ui.workspaceItems?.() || [] },
      sep,
      ...(ui.panelItems?.() || []),
    ] },
    { id: 'help', title: 'Help', items: () => [
      action('keyHelp'),
      action('keyboardShortcuts'),
      { label: tr('Find Action…'), keyAction: 'GotoAction', run: () => ide.runAction('GotoAction') },
    ] },
  ];

  let bar = null;
  let open = null; // {id, button}
  const titles = new Map();
  function show(m, b) {
    const menu = ui.menu(b, m.items(Cut.app));
    open = { id: m.id, button: b };
    for (const n of bar.children) n.classList.toggle('open', n === b);
    return menu;
  }
  // The open state ends when the menu closes, however it closed.
  const watch = new MutationObserver(() => {
    if (open && !ide.ui.menuOpen()) { open = null; for (const n of bar?.children || []) n.classList.remove('open'); }
  });

  function build() {
    bar = el('nav', 'cut-menubar', undefined, { role: 'menubar', 'aria-label': tr('Menu Bar') });
    for (const m of MENUS) {
      const b = el('button', 'cut-menubar-item', tr(m.title), { type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'data-menu': m.id });
      titles.set(m.id, b);
      let wasOpen = false;
      // The IDE closes an open menu on any press outside it before this button hears it: a press on the title of the
      // menu that is open only closes it.
      b.addEventListener('pointerdown', () => { wasOpen = open?.id === m.id && ide.ui.menuOpen(); });
      b.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (wasOpen) { ide.ui.closeMenus(); return; }
        show(m, b);
      });
      b.addEventListener('mouseenter', () => { if (open && open.id !== m.id && ide.ui.menuOpen()) show(m, b); });
      bar.appendChild(b);
    }
    const host = document.getElementById('menuHost');
    if (host) watch.observe(host, { childList: true });
    return bar;
  }
  // Left and Right on a top-level menu go to the neighbouring menu.
  addEventListener('keydown', (e) => {
    if (!open || !ide.ui.menuOpen() || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    if (document.querySelectorAll('.context-menu').length > 1) return;
    if (e.key === 'ArrowRight' && document.querySelector('.context-menu .menu-item.active.has-sub')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const i = MENUS.findIndex((m) => m.id === open.id);
    const next = MENUS[(i + (e.key === 'ArrowRight' ? 1 : MENUS.length - 1)) % MENUS.length];
    show(next, titles.get(next.id));
  }, true);

  ui.menubar = {
    build,
    MENUS: MENUS.map((m) => m.id),
    items: (id) => MENUS.find((m) => m.id === id)?.items(Cut.app) || [],
    open: (id) => { const m = MENUS.find((x) => x.id === id); return m && bar ? show(m, titles.get(id)) : null; },
  };
})();
