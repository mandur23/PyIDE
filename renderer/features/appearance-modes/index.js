// View › Appearance modes, as in PyCharm: Distraction-Free Mode (no toolbar, stripes, tool windows, status bar, editor
// tabs or breadcrumbs; the editor centered without line numbers or gutter icons), Zen Mode (distraction-free in full
// screen), Full Screen, and Presentation Mode (full screen, no chrome, a larger editor font). One mode at a time;
// leaving it restores the tool windows that were open, their sizes and the editor options. Modes are not saved
// across restarts.
(() => {
  const { el } = ide.util;
  const monaco = ide.monaco;

  const MODES = {
    distractionFree: { action: 'ToggleDistractionFreeMode', name: () => tr('Distraction-Free Mode'),
      enter: () => tr('Enter Distraction-Free Mode'), exit: () => tr('Exit Distraction-Free Mode'), chrome: true, centered: true, gutter: false },
    zen: { action: 'ToggleZenMode', name: () => tr('Zen Mode'),
      enter: () => tr('Enter Zen Mode'), exit: () => tr('Exit Zen Mode'), chrome: true, centered: true, gutter: false, full: true },
    fullScreen: { action: 'ToggleFullScreen', name: () => tr('Full Screen'),
      enter: () => tr('Enter Full Screen'), exit: () => tr('Exit Full Screen'), full: true },
    presentation: { action: 'TogglePresentationMode', name: () => tr('Presentation Mode'),
      enter: () => tr('Enter Presentation Mode'), exit: () => tr('Exit Presentation Mode'), chrome: true, full: true, font: true },
  };
  const DEFAULTS = { 'appearance.presentationFontSize': 24, 'appearance.distractionFreeColumns': 100 };
  const setting = (k, lo, hi) => Math.min(hi, Math.max(lo, Number(ide.settings.get(k, DEFAULTS[k])) || DEFAULTS[k]));

  let mode = null;
  let saved = null; // {layout, focus}

  // ---------- tool windows ----------
  // Per area: whether it was open, which window it showed (also when hidden) and its size.
  function captureLayout() {
    const out = new Map();
    for (const tw of ide.toolWindows.values()) {
      const a = tw.area;
      if (!out.has(a)) out.set(a, { visible: !a.panel.classList.contains('hidden'), active: null, width: a.panel.style.width, height: a.panel.style.height });
      if (tw.container.classList.contains('active')) out.get(a).active = tw;
    }
    return out;
  }
  function restoreLayout(layout) {
    for (const [a, s] of layout) {
      const current = [...ide.toolWindows.values()].find((tw) => tw.area === a && tw.isVisible());
      if (s.visible && s.active) { if (!s.active.isVisible()) s.active.show(); } else {
        // Showing the window it had before (then hiding it) keeps the area's choice as it was.
        if (s.active && current && current !== s.active) s.active.show();
        (s.active?.isVisible() ? s.active : current)?.hide();
      }
      a.panel.style.width = s.width;
      a.panel.style.height = s.height;
    }
  }

  // ---------- editor options (group editors only; editors embedded in viewers keep theirs) ----------
  const GUTTER_OFF = { lineNumbers: 'off', glyphMargin: false, folding: false, minimap: { enabled: false } };
  const GUTTER_DEFAULTS = { lineNumbers: 'on', glyphMargin: true, folding: true, minimap: { enabled: false } };
  // editor -> its own values of the GUTTER_OFF keys the mode changed. An editor disposed during the mode (a split
  // closed) leaves the map at once.
  const savedOptions = new Map();
  const watchedEditors = new WeakSet();
  // Compares a gutter option as Monaco renders it (the minimap by `enabled` only).
  const sameOption = (k, a, b) => (k === 'minimap'
    ? !!(a?.enabled ?? GUTTER_DEFAULTS.minimap.enabled) === !!(b?.enabled ?? GUTTER_DEFAULTS.minimap.enabled)
    : (a ?? GUTTER_DEFAULTS[k]) === (b ?? GUTTER_DEFAULTS[k]));
  function fontOptions() {
    const g = ide.editorOptions();
    const size = setting('appearance.presentationFontSize', 8, 72);
    return { fontSize: size, lineHeight: Math.round(size * ((g.lineHeight || 22) / (g.fontSize || 14))) };
  }
  // The gutter goes off once per editor when the mode reaches it; later calls (a settings change) only set the font,
  // so a gutter option the user turns back on during the mode stays on.
  function applyEditor(ed) {
    const m = MODES[mode];
    if (!m || !ide.editors().includes(ed)) return;
    const opts = m.font ? fontOptions() : {};
    if (m.gutter === false && !savedOptions.has(ed)) {
      const raw = ed.getRawOptions();
      const own = {};
      for (const [k, v] of Object.entries(GUTTER_OFF)) {
        if (sameOption(k, raw[k], v)) continue;
        own[k] = raw[k] ?? GUTTER_DEFAULTS[k];
        opts[k] = v;
      }
      savedOptions.set(ed, own);
      if (!watchedEditors.has(ed)) {
        watchedEditors.add(ed);
        ed.onDidDispose(() => savedOptions.delete(ed));
      }
    }
    if (Object.keys(opts).length) ed.updateOptions(opts);
  }
  // Puts back only what the mode changed and what still holds the mode's value: an option the user changed during
  // the mode keeps the user's value. The font follows the editor setting (it may have changed meanwhile).
  function restoreEditors(m) {
    const { fontSize, lineHeight } = ide.editorOptions();
    for (const ed of ide.editors()) {
      const opts = m.font ? { fontSize, lineHeight } : {};
      const raw = ed.getRawOptions();
      for (const [k, v] of Object.entries(savedOptions.get(ed) || {})) if (sameOption(k, raw[k], GUTTER_OFF[k])) opts[k] = v;
      if (Object.keys(opts).length) ed.updateOptions(opts);
    }
    savedOptions.clear();
  }
  ide.onEditor((ed) => { if (mode) { applyEditor(ed); updateWidth(); } });

  // The centered editor is as wide as the column setting at the editor's font, plus its gutter and scrollbar.
  function updateWidth() {
    const ed = ide.editor || ide.editors()[0];
    if (!MODES[mode]?.centered || !ed) { document.body.style.removeProperty('--appearance-editor-width'); return; }
    const cw = ed.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
    const li = ed.getLayoutInfo();
    const cols = setting('appearance.distractionFreeColumns', 20, 400);
    document.body.style.setProperty('--appearance-editor-width', `${Math.ceil(cols * cw + li.contentLeft + li.verticalScrollbarWidth + 4)}px`);
  }

  // ---------- notice ----------
  let noticeTimer = 0;
  function notice(m) {
    let n = document.getElementById('appearanceModeNotice');
    if (!n) {
      n = el('div', 'appearance-notice hidden');
      n.id = 'appearanceModeNotice';
      document.body.appendChild(n);
    }
    const keys = ide.keymap.hint(m.action);
    n.textContent = keys
      ? tr('{mode}: press {keys} to exit.', { mode: m.name(), keys })
      : tr('{mode}: to exit, choose {exit} in View › Appearance or {findAction}.',
        { mode: m.name(), exit: m.exit(), findAction: ide.keymap.withKeys(tr('Find Action'), 'GotoAction') });
    n.classList.remove('hidden');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => n.classList.add('hidden'), 5000);
  }
  const hideNotice = () => { clearTimeout(noticeTimer); document.getElementById('appearanceModeNotice')?.classList.add('hidden'); };

  // ---------- modes ----------
  const setFullScreen = (on) => ide.api.invoke('appearance-modes:setFullScreen', on).catch(() => false);
  function setTitles() {
    for (const [id, m] of Object.entries(MODES)) {
      const a = ide.actions.find((x) => x.id === m.action);
      if (a) a.title = mode === id ? m.exit() : m.enter();
    }
  }
  function setBodyClasses() {
    const m = MODES[mode] || {};
    document.body.classList.toggle('appearance-chromeless', !!m.chrome);
    document.body.classList.toggle('appearance-centered', !!m.centered);
    if (mode) document.body.dataset.appearanceMode = mode; else delete document.body.dataset.appearanceMode;
  }

  async function enter(id) {
    const m = MODES[id];
    mode = id;
    saved = { focus: document.activeElement, layout: m.chrome ? captureLayout() : null };
    if (m.chrome) for (const tw of ide.toolWindows.values()) if (tw.isVisible()) tw.hide();
    setBodyClasses();
    for (const ed of ide.editors()) applyEditor(ed);
    updateWidth();
    setTitles();
    if (m.full) await setFullScreen(true);
    notice(m);
    ide.emit('appearanceModeChanged', mode);
  }

  async function exit({ keepFullScreen = false } = {}) {
    const m = MODES[mode];
    if (!m) return;
    const s = saved;
    mode = null;
    saved = null;
    hideNotice();
    setBodyClasses();
    restoreEditors(m);
    updateWidth();
    if (s.layout) restoreLayout(s.layout);
    setTitles();
    if (m.full && !keepFullScreen) await setFullScreen(false);
    if (s.focus?.isConnected && s.focus !== document.body && s.focus.getClientRects().length) s.focus.focus();
    else if (ide.editor?.getModel()) ide.editor.focus();
    ide.emit('appearanceModeChanged', null);
  }

  // Switching from one mode to another leaves the first (restoring the layout) and enters the second.
  let busy = Promise.resolve();
  function toggle(id) {
    busy = busy.then(async () => {
      if (mode === id) return exit();
      if (mode) await exit({ keepFullScreen: MODES[mode].full && MODES[id].full });
      return enter(id);
    }).catch((e) => ide.log.error(`appearance-modes: ${e?.stack || e}`));
    return busy;
  }

  // Leaving full screen some other way ends the mode that needed it.
  ide.api.on('appearance-modes:fullScreenChanged', async (on) => {
    if (on || !MODES[mode]?.full) return;
    if (await ide.api.invoke('appearance-modes:isFullScreen')) return;
    busy = busy.then(() => (MODES[mode]?.full ? exit({ keepFullScreen: true }) : undefined));
  });

  ide.on('settingsChanged', (key) => {
    if (!mode || !(key.startsWith('editor.') || key in DEFAULTS)) return;
    // After the settings plugin applied the editor settings to every editor.
    setTimeout(() => { if (!mode) return; for (const ed of ide.editors()) applyEditor(ed); updateWidth(); });
  });
  ide.on('activeEditorChanged', () => { if (mode) updateWidth(); });

  for (const [id, m] of Object.entries(MODES)) ide.registerAction({ id: m.action, title: m.enter(), run: () => toggle(id), terminal: true });

  // A page reload during Zen, Presentation or Full Screen (Trust Project reopens the page) leaves the window full
  // screen with no mode to leave it. Only these modes make the window full screen and they are not kept across a
  // reload, so a page that starts in full screen leaves it.
  busy = busy.then(async () => {
    if (!mode && (await ide.api.invoke('appearance-modes:isFullScreen'))) await setFullScreen(false);
  }).catch(() => {});

  // savedEditors: how many editors have gutter options to restore (for verify/appearance-modes.mjs).
  ide.appearanceModes = { mode: () => mode, toggle, exit: () => (busy = busy.then(() => exit())), savedEditors: () => savedOptions.size };

  // ---------- settings ----------
  (ide.settingsPages ||= []).push({
    id: 'appearanceModes', group: 'appearance', title: () => tr('Presentation and Distraction-Free Modes'), defaults: DEFAULTS,
    keywords: 'presentation mode font size distraction free zen full screen columns width 프레젠테이션 모드 글꼴 크기 방해 금지 Zen 전체 화면 열 너비',
    mount(host, ctx) {
      const p = ctx.ui.section(host, tr('Presentation Mode'));
      p.appendChild(ctx.ui.fieldRow(tr('Font size:'), ctx.ui.numberInput('appearance.presentationFontSize', { min: 8, max: 72, fallback: 24 })));
      const d = ctx.ui.section(host, tr('Distraction-Free Mode'));
      d.appendChild(ctx.ui.fieldRow(tr('Editor width (columns):'), ctx.ui.numberInput('appearance.distractionFreeColumns', { min: 20, max: 400, fallback: 100 })));
      d.appendChild(el('div', 'muted settings-note', tr('Distraction-Free and Zen modes center the editor at this width and hide line numbers and gutter icons.')));
    },
  });
})();
