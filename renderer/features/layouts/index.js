// Window › Layouts, as in PyCharm: tool window layouts saved under a name and restored later, IDE-wide (setting
// `toolWindowLayouts`, a list of {name, layout}). A layout is, per area (left, bottom, right), whether it is open, the
// window it shows (also when closed) and its size, plus the windows pinned to the sidebar stripes. Restore Default
// Layout (PyCharm's RestoreFactoryDefaultLayout) brings back the first-run layout: Project on the left and the
// lowest-ordered bottom window open at their default sizes, the right side closed, the default pinned set.
// Restore Current Layout (Shift+F12) and Save Changes in Current Layout work on the layout last saved or restored.
(() => {
  const KEY = 'toolWindowLayouts';
  const CURRENT = 'toolWindowLayouts.current';
  const SIDES = { sidePanel: 'left', bottom: 'bottom', rightPanel: 'right' };
  const sideOf = (tw) => SIDES[tw.area.panel.id];
  const windowsOn = (side) => [...ide.toolWindows.values()].filter((tw) => sideOf(tw) === side).sort((a, b) => a.order - b.order);
  const sizeOf = (side, panel) => (side === 'bottom' ? panel.style.height : panel.style.width);

  // ---------- capture and apply ----------
  function capture() {
    const areas = {};
    for (const side of Object.values(SIDES)) {
      const list = windowsOn(side);
      if (!list.length) continue;
      const area = list[0].area;
      areas[side] = { visible: !area.panel.classList.contains('hidden'), active: area.active?.id || null, size: sizeOf(side, area.panel) };
    }
    return { areas, pinned: ide.sidebar.pinned() };
  }
  // The first-run layout (see the core's registerToolWindow: an area's default window has the lowest order).
  const defaultLayout = () => ({
    areas: { left: { visible: true, active: null, size: '' }, bottom: { visible: true, active: null, size: '' }, right: { visible: false, active: null, size: '' } },
    pinned: ide.sidebar.defaultPinned(),
  });
  // Settings may hold anything (hand-edited, another version): a layout is read field by field.
  const validSize = (v) => typeof v === 'string' && /^(\d{1,5}(\.\d+)?px)?$/.test(v);
  function normalize(raw) {
    const areas = {};
    for (const side of Object.values(SIDES)) {
      const a = raw?.areas?.[side];
      if (!a || typeof a !== 'object') continue;
      areas[side] = { visible: a.visible === true, active: typeof a.active === 'string' ? a.active : null, size: validSize(a.size) ? a.size : '' };
    }
    const pinned = Array.isArray(raw?.pinned) ? raw.pinned.filter((x) => typeof x === 'string') : null;
    return { areas, pinned };
  }
  async function apply(raw) {
    const layout = normalize(raw);
    // A chromeless appearance mode would put its own saved layout back when it ends; leave it first.
    if (ide.appearanceModes?.mode()) await ide.appearanceModes.exit();
    const focus = document.activeElement;
    for (const [side, s] of Object.entries(layout.areas)) {
      const list = windowsOn(side);
      if (!list.length) continue;
      const area = list[0].area;
      const want = list.find((tw) => tw.id === s.active) || list[0];
      if (s.visible) {
        if (!want.isVisible()) want.show();
      } else {
        // Showing the wanted window first (then hiding it) keeps it as the area's choice for next time.
        if (area.active !== want) want.show();
        list.find((tw) => tw.isVisible())?.hide();
      }
      if (side === 'bottom') area.panel.style.height = s.size; else area.panel.style.width = s.size;
    }
    if (layout.pinned) ide.settings.set('sidebar.pinned', layout.pinned);
    if (focus?.isConnected && focus !== document.body && focus.getClientRects().length) focus.focus();
    else if (ide.editor?.getModel()) ide.editor.focus();
    ide.emit('toolWindowLayoutApplied');
  }

  // ---------- named layouts ----------
  const saved = () => (Array.isArray(ide.settings.get(KEY, [])) ? ide.settings.get(KEY, []) : [])
    .filter((l) => l && typeof l.name === 'string' && l.name && typeof l.layout === 'object');
  const find = (name) => saved().find((l) => l.name === name);
  const current = () => { const n = ide.settings.get(CURRENT, null); return typeof n === 'string' && find(n) ? n : null; };
  function store(name, layout = capture()) {
    const list = saved().filter((l) => l.name !== name);
    list.push({ name, layout });
    ide.settings.set(KEY, list);
    ide.settings.set(CURRENT, name);
  }
  // A dialog with a Name field; resolves to the trimmed name, or null on Cancel.
  function askName(title, initial) {
    return new Promise((resolve) => {
      const input = ide.util.el('input', 'input layout-name');
      input.id = 'layoutName';
      input.value = initial;
      const body = ide.util.el('label', 'layout-name-row');
      body.append(ide.util.el('span', null, tr('Name:')), input);
      let answer = null;
      ide.ui.dialog({
        title, body, width: 420, onClose: () => resolve(answer),
        buttons: [
          { label: tr('OK'), primary: true, run: () => { answer = input.value.trim() || null; return !!answer; } },
          { label: tr('Cancel') },
        ],
      });
      input.select();
    });
  }
  async function saveAs() {
    const name = await askName(tr('Save Current Layout As'), current() || tr('Custom'));
    if (!name) return null;
    store(name);
    return name;
  }
  async function restore(name) {
    const l = find(name);
    if (!l) return false;
    await apply(l.layout);
    ide.settings.set(CURRENT, name);
    return true;
  }
  async function restoreDefault() {
    await apply(defaultLayout());
    ide.settings.set(CURRENT, null);
  }
  async function rename(name) {
    const next = await askName(tr('Rename Layout'), name);
    if (!next || next === name || !find(name)) return;
    const wasCurrent = ide.settings.get(CURRENT) === name;
    ide.settings.set(KEY, saved().filter((l) => l.name !== next).map((l) => (l.name === name ? { ...l, name: next } : l)));
    if (wasCurrent) ide.settings.set(CURRENT, next);
  }
  function remove(name) {
    const wasCurrent = ide.settings.get(CURRENT) === name;
    ide.settings.set(KEY, saved().filter((l) => l.name !== name));
    if (wasCurrent) ide.settings.set(CURRENT, null);
  }

  // ---------- actions and the Window › Layouts menu ----------
  [
    { id: 'StoreNewLayout', title: tr('Save Current Layout As…'), run: saveAs },
    { id: 'RestoreFactoryDefaultLayout', title: tr('Restore Default Layout'), run: restoreDefault },
    // PyCharm: Shift+F12 restores the layout chosen last, the default one until another is saved or restored.
    { id: 'RestoreDefaultLayout', title: tr('Restore Current Layout'), keys: 'Shift+F12', run: () => (current() ? restore(current()) : restoreDefault()) },
    { id: 'StoreDefaultLayout', title: tr('Save Changes in Current Layout'), run: () => (current() ? store(current()) : saveAs()) },
  ].forEach(ide.registerAction);

  const act = (id, extra = {}) => {
    const a = ide.actions.find((x) => x.id === id);
    return a && { label: a.title, hint: ide.keymap.hint(id), run: () => ide.runAction(id), ...extra };
  };
  function menuItems() {
    const list = saved();
    const cur = current();
    return [
      act('StoreNewLayout'),
      act('StoreDefaultLayout', cur ? { detail: cur, userText: true } : {}),
      act('RestoreDefaultLayout', cur ? { detail: cur, userText: true } : {}),
      { separator: true },
      act('RestoreFactoryDefaultLayout', { checked: !cur }),
      ...list.map((l) => ({ label: l.name, userText: true, checked: l.name === cur, submenu: () => [
        { label: tr('Restore'), run: () => restore(l.name) },
        { label: tr('Rename…'), run: () => rename(l.name) },
        { label: tr('Delete'), run: () => remove(l.name) },
      ] })),
    ].filter(Boolean);
  }
  // ---------- what a project had open ----------
  // Setting `project.session`, {[project]: {groups: [{tabs: [{path, pinned, view}], active}], focus, layout}}, kept for
  // the recent projects: closing Nano Studio or the project and coming back shows the same files, carets and tool
  // windows. Written when the tabs change, before the project changes and as the window closes. A project's record is
  // written only once its own tabs are back, or a project still opening would save its empty tab bar over them.
  const SESSION = 'project.session';
  const MAX_TABS = 40;
  const keyOf = (dir) => ide.util.pathKey(dir);
  const tabsBackFor = { root: null };
  let timer = null;

  // Monaco's own form, which it can restore; folds and other contributions may not fit a file changed since.
  const viewOf = (group, tab) => {
    const state = group.active === tab && tab.kind === 'file' ? group.editor.saveViewState() : tab.viewState;
    return state?.cursorState ? { cursorState: state.cursorState, viewState: state.viewState, contributionsState: {} } : null;
  };
  function saveSession() {
    clearTimeout(timer);
    timer = null;
    if (!ide.root || tabsBackFor.root !== keyOf(ide.root)) return;
    const openTabs = (group) => group.tabs.filter((t) => t.path && !t.doc?.untitled && (t.kind === 'file' || t.viewer));
    const groups = ide.groups().filter((g) => openTabs(g).length).map((group) => ({
      tabs: openTabs(group).slice(0, MAX_TABS).map((t) => ({ path: t.path, pinned: !!t.pinned, view: viewOf(group, t) })),
      active: group.active?.path || null,
    }));
    const focus = Math.max(0, ide.groups().filter((g) => openTabs(g).length).findIndex((g) => g.editor === ide.editor));
    const { areas } = capture();
    const keep = new Set(ide.settings.get('recentProjects', []).map((p) => keyOf(p.path)));
    const all = Object.fromEntries(Object.entries(ide.settings.get(SESSION, {})).filter(([k]) => keep.has(k)));
    ide.settings.set(SESSION, { ...all, [keyOf(ide.root)]: { groups, focus, layout: { areas } } });
  }
  const saveSoon = () => { clearTimeout(timer); timer = setTimeout(saveSession, 1000); };

  // Two editor groups at most (a third joins the second), and a file that has gone is left out.
  async function openGroup(group, into) {
    let first = true;
    let last = null;
    for (const { path, pinned, view } of group.tabs) {
      if (!(await ide.api.exists(path))) continue;
      const tab = await ide.openFile(path, { focus: false, ...(first && into ? { group: into } : {}) });
      if (!tab) continue;
      first = false;
      if (view && tab.kind === 'file') { tab.viewState = view; ide.editor.restoreViewState(view); }
      if (pinned && !tab.pinned) ide.runAction('PinActiveTab');
      last = tab;
    }
    return last;
  }
  async function restoreSession(root) {
    const saved = ide.settings.get(SESSION, {})[keyOf(root)];
    const groups = Array.isArray(saved?.groups) ? saved.groups.filter((g) => Array.isArray(g?.tabs)) : [];
    const [one, ...rest] = groups;
    const two = rest.length ? { tabs: rest.flatMap((g) => g.tabs), active: rest.at(-1).active } : null;
    const sameProject = () => ide.root && keyOf(ide.root) === keyOf(root);
    const show = async (path, group) => { if (path && sameProject() && await ide.api.exists(path)) await ide.openFile(path, { focus: false, group }); };
    if (one) await openGroup(one);
    if (two && sameProject()) await openGroup(two, 'right');
    // 'right' is the other group from the one in use, and each show moves to the group it shows.
    if (two) await show(two.active);
    await show(one?.active, two ? 'right' : undefined);
    if (two && saved.focus === 1) await show(two.active, 'right');
    if (saved?.layout && sameProject()) await apply(saved.layout);
    if (sameProject()) tabsBackFor.root = keyOf(root);
  }
  ide.on('projectOpened', (root) => { tabsBackFor.root = null; restoreSession(root).catch((err) => ide.log.error(`restoring ${root}: ${err?.stack || err}`)); });
  ide.on('activeTabChanged', saveSoon);
  ide.on('fileClosed', saveSoon);
  ide.beforeProjectChange.push(() => { saveSession(); tabsBackFor.root = null; });
  addEventListener('beforeunload', saveSession);

  ide.layouts = {
    capture, apply, defaultLayout, list: () => saved().map((l) => l.name), current, save: store, saveAs, restore, restoreDefault, rename, remove,
    menu: () => ({ label: tr('Layouts'), submenu: menuItems }),
  };
})();
