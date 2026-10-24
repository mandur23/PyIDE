// Settings dialog (Ctrl+Alt+S): themes, language, keymap, editor, plugins, interpreter, tools.
// Preferences apply at startup and live on change; language and plugin changes need a restart, as in PyCharm.
(() => {
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const monaco = ide.monaco;

  // Light colors from PyCharm expUI_light.theme.json / expUI_lightScheme.xml (Python colors from the Python plugin's Light scheme).
  // window.PYCHARM_LIGHT, like core's PYCHARM_DARK, lets semantic-highlight define the theme again with its rules added.
  monaco.editor.defineTheme('pycharm-light', window.PYCHARM_LIGHT = {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '080808' },
      { token: 'keyword', foreground: '0033b3' },
      { token: 'string', foreground: '067d17' },
      { token: 'string.escape', foreground: '0037a6' },
      { token: 'number', foreground: '1750eb' },
      { token: 'comment', foreground: '8c8c8c', fontStyle: 'italic' },
      { token: 'tag', foreground: '9e880d' },
      { token: 'identifier', foreground: '080808' },
      { token: 'type.identifier', foreground: '080808' },
      { token: 'delimiter', foreground: '080808' },
      { token: 'function', foreground: '00627a' },
      { token: 'function.call', foreground: '080808' },
      { token: 'self', foreground: '94558d' },
      { token: 'builtin', foreground: '000080' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#080808',
      'editor.lineHighlightBackground': '#f5f8fe',
      'editor.lineHighlightBorder': '#f5f8fe',
      'editorLineNumber.foreground': '#aeb3c2',
      'editorLineNumber.activeForeground': '#767a8a',
      'editor.selectionBackground': '#a6d2ff',
      'editorCursor.foreground': '#000000',
      'editorIndentGuide.background1': '#ebecf0',
      'editorIndentGuide.activeBackground1': '#aeb3c2',
      'editorRuler.foreground': '#ebecf0',
      'editorWhitespace.foreground': '#adadad',
      'editorGutter.background': '#ffffff',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#b9bdc9',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.selectedBackground': '#d4e2ff',
      'editorHoverWidget.background': '#ffffff',
      'scrollbarSlider.background': '#a8adbd66',
    },
  });

  const DEFAULTS = {
    'appearance.theme': 'dark',
    'appearance.language': 'system',
    'editor.fontSize': 14,
    'editor.wheelZoom': true,
    'editor.lineHeight': 1.6,
    'editor.tabSize': 4,
    'editor.showWhitespace': false,
    'editor.softWrap': false,
    'editor.ruler': 120,
    'editor.previewTab': false,
    'editor.tabLimit': 10,
    'tools.formatOnSave': false,
    'tools.ruffOnSave': true,
    'tools.ruffLineLength': 0,
  };
  // Numeric settings are validated before they become a pending change.
  const RANGES = {
    'editor.fontSize': [6, 48],
    'editor.lineHeight': [1, 3],
    'editor.tabSize': [1, 16],
    'editor.ruler': [0, 400],
    'editor.tabLimit': [0, 50],
    'tools.ruffLineLength': [0, 400],
  };
  const RESTART_KEYS = new Set(['appearance.language']);
  // The theme choices of Settings › Appearance, the gear's Theme menu and View › Appearance.
  const THEMES = () => [['dark', tr('Dark')], ['light', tr('Light')], ['system', tr('Sync with OS')]];
  // Plugin settings pages may declare defaults for their keys ({defaults: {key: value}}).
  const pluginDefault = (k) => (ide.settingsPages || []).find((p) => p.defaults && k in p.defaults)?.defaults[k];
  const get = (k) => ide.settings.get(k, k in DEFAULTS ? DEFAULTS[k] : pluginDefault(k));

  // appearance.theme: 'dark', 'light' or 'system' (Sync with OS, the default of new installs; renderer/core/i18n.js). The OS
  // mode is main's nativeTheme (main/system-theme.js); prefers-color-scheme, which follows it, is the first paint's guess.
  let systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const effectiveTheme = () => {
    const t = get('appearance.theme');
    return t === 'system' ? (systemDark ? 'dark' : 'light') : t === 'light' ? 'light' : 'dark';
  };
  function applyTheme() {
    const theme = effectiveTheme();
    const changed = document.documentElement.dataset.theme !== theme;
    document.documentElement.dataset.theme = theme;
    monaco.editor.setTheme(theme === 'light' ? 'pycharm-light' : 'pycharm-dark');
    if (changed) ide.emit('themeChanged', theme);
  }
  const setSystemDark = (dark) => {
    if (typeof dark !== 'boolean' || dark === systemDark) return;
    systemDark = dark;
    if (get('appearance.theme') === 'system') applyTheme();
  };
  ide.api.invoke('theme:system').then((s) => setSystemDark(s?.dark)).catch(() => {});
  ide.api.on('theme:systemChanged', (s) => setSystemDark(s?.dark));
  // current(): the theme shown ('dark' | 'light'); preference(): the setting; systemDark(): the OS mode main reported.
  // menuItems(): Dark / Light / Sync with OS as checked menu items.
  ide.theme = { current: effectiveTheme, preference: () => get('appearance.theme'), systemDark: () => systemDark,
    menuItems: () => THEMES().map(([value, label]) => ({ label, checked: get('appearance.theme') === value, run: () => ide.settings.set('appearance.theme', value) })) };

  function applyModel(model) {
    const n = Math.max(1, Number(get('editor.tabSize')) || 4);
    if (!model.isDisposed()) model.updateOptions({ tabSize: n, indentSize: n, insertSpaces: true });
  }

  function applyEditor() {
    const fontSize = Math.max(6, Number(get('editor.fontSize')) || 14);
    const ruler = Number(get('editor.ruler')) || 0;
    // Every pane and every editor embedded in a viewer, now and later.
    ide.updateEditorOptions({
      fontSize,
      lineHeight: Math.round(fontSize * (Number(get('editor.lineHeight')) || 1.6)),
      renderWhitespace: get('editor.showWhitespace') ? 'all' : 'none',
      wordWrap: get('editor.softWrap') ? 'on' : 'off',
      rulers: ruler > 0 ? [ruler] : [],
    });
    for (const t of ide.tabs) if (t.model) applyModel(t.model);
  }

  // The theme is applied before features finish loading so the first paint is already in the right theme.
  applyTheme();
  ide.on('ready', () => { applyTheme(); applyEditor(); });
  ide.on('fileOpened', (tab) => tab.model && applyModel(tab.model));
  ide.on('settingsChanged', (key) => {
    if (key === 'appearance.theme') applyTheme();
    else if (key.startsWith('editor.')) applyEditor();
  });

  // ---------- font size: Ctrl+Mouse Wheel, Increase/Decrease/Reset Font Size ----------
  // As PyCharm's "Change font size with Ctrl+Mouse Wheel in: All editors": every editor follows and the size is kept as
  // the editor font setting. During Presentation Mode the presentation font size changes instead, so leaving the mode
  // still restores the editor font (appearance-modes plugin).
  const presenting = () => ide.appearanceModes?.mode() === 'presentation';
  const fontKey = () => (presenting() ? 'appearance.presentationFontSize' : 'editor.fontSize');
  const fontRange = () => (presenting() ? [8, 72] : RANGES['editor.fontSize']);
  const fontDefault = () => (presenting() ? 24 : DEFAULTS['editor.fontSize']);
  const clampFont = (n) => { const [lo, hi] = fontRange(); return Math.min(hi, Math.max(lo, Math.round(n))); };
  // A Ctrl+wheel size the editors show but settings.json does not hold yet: {key, size}.
  let zoom = null;
  let zoomFrame = 0;
  let zoomFrameTimer = 0;
  let zoomTimer = 0;
  const currentFont = () => (zoom && zoom.key === fontKey() ? zoom.size : clampFont(Number(ide.settings.get(fontKey(), fontDefault())) || fontDefault()));
  let fontHint = null;
  let fontHintTimer = 0;
  // A short note at the editor's top right, like PyCharm's zoom indicator: the size and a reset link.
  function showFontHint(size) {
    if (!fontHint) {
      fontHint = el('div', 'font-zoom-hint hidden');
      fontHint.id = 'fontZoomHint';
      fontHint.onmouseenter = () => clearTimeout(fontHintTimer);
      fontHint.onmouseleave = () => { fontHintTimer = setTimeout(() => fontHint.classList.add('hidden'), 1500); };
    }
    (document.getElementById('editorArea') || document.body).appendChild(fontHint);
    fontHint.replaceChildren(el('span', 'font-zoom-size', tr('Font size: {size}pt', { size })));
    if (size !== fontDefault()) {
      const reset = el('a', 'font-zoom-reset', tr('Reset to {size}pt', { size: fontDefault() }));
      reset.onclick = () => setFontSize(fontDefault());
      fontHint.appendChild(reset);
    }
    fontHint.classList.remove('hidden');
    clearTimeout(fontHintTimer);
    fontHintTimer = setTimeout(() => fontHint.classList.add('hidden'), 2500);
  }
  function dropZoom() {
    clearTimeout(zoomTimer);
    cancelAnimationFrame(zoomFrame);
    clearTimeout(zoomFrameTimer);
    zoomFrame = 0;
    zoom = null;
  }
  function setFontSize(n) {
    const size = clampFont(n);
    // The editors may show an unsaved wheel size: setting the value again makes them follow the saved one.
    const previewed = !!zoom;
    dropZoom();
    if (previewed || size !== Number(ide.settings.get(fontKey()))) ide.settings.set(fontKey(), size);
    showFontHint(size);
    return size;
  }
  // Ctrl+wheel over any editor; a wheel notch (100 px) or several small trackpad deltas make one step. Saving a size
  // writes settings.json and lays out every editor again, so a wheel burst only resizes the open editors (once per
  // frame) and the size is saved once, 300 ms after the last step (or when the window closes).
  function saveZoom() {
    const pending = zoom;
    dropZoom();
    if (pending && pending.size !== Number(ide.settings.get(pending.key))) ide.settings.set(pending.key, pending.size);
  }
  function previewZoom() {
    cancelAnimationFrame(zoomFrame);
    clearTimeout(zoomFrameTimer);
    zoomFrame = 0;
    if (!zoom || zoom.key !== fontKey()) return;
    // The line height as applyEditor and Presentation Mode will set it.
    const g = ide.editorOptions?.() || {};
    const ratio = zoom.key === 'editor.fontSize' ? Number(get('editor.lineHeight')) || 1.6 : (g.lineHeight || 22) / (g.fontSize || 14);
    for (const ed of ide.editors()) ed.updateOptions({ fontSize: zoom.size, lineHeight: Math.round(zoom.size * ratio) });
  }
  addEventListener('beforeunload', saveZoom);
  let wheelDelta = 0;
  addEventListener('wheel', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || !e.target.closest?.('.monaco-editor') || get('editor.wheelZoom') === false) return;
    e.preventDefault();
    e.stopPropagation();
    const d = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    wheelDelta = Math.abs(d) >= 50 ? d : wheelDelta + d;
    if (Math.abs(wheelDelta) < 50) return;
    const step = wheelDelta < 0 ? 1 : -1;
    wheelDelta = 0;
    if (zoom && zoom.key !== fontKey()) saveZoom();
    zoom = { key: fontKey(), size: clampFont(currentFont() + step) };
    showFontHint(zoom.size);
    if (!zoomFrame) {
      zoomFrame = requestAnimationFrame(previewZoom);
      // A window that gets no frames (hidden, occluded) resizes anyway.
      zoomFrameTimer = setTimeout(previewZoom, 100);
    }
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(saveZoom, 300);
  }, { capture: true, passive: false });
  // PyCharm's Windows keymap binds only the "in All Editors" variants; here all of them change every editor.
  const changeFont = (d) => () => setFontSize(currentFont() + d);
  const resetFont = () => setFontSize(fontDefault());
  [
    { id: 'EditorIncreaseFontSize', title: tr('Increase Font Size'), run: changeFont(1) },
    { id: 'EditorDecreaseFontSize', title: tr('Decrease Font Size'), run: changeFont(-1) },
    { id: 'EditorResetFontSize', title: tr('Reset Font Size'), run: resetFont },
    { id: 'EditorIncreaseFontSizeGlobal', title: tr('Increase Font Size in All Editors'), keys: 'Alt+Shift+.', run: changeFont(1) },
    { id: 'EditorDecreaseFontSizeGlobal', title: tr('Decrease Font Size in All Editors'), keys: 'Alt+Shift+,', run: changeFont(-1) },
    { id: 'EditorResetFontSizeGlobal', title: tr('Reset Font Size in All Editors'), run: resetFont },
  ].forEach(ide.registerAction);
  // size(): the size the zoom actions change (the presentation size during Presentation Mode).
  ide.fontZoom = { size: currentFont, set: setFontSize, reset: resetFont };

  // ---------- restart ----------
  let restartPending = false;
  function askRestart() {
    ide.ui.dialog({
      title: tr('Restart IDE'),
      body: el('div', 'settings-restart-msg', tr('Restart PyIDE to apply the changes?')),
      width: 420,
      buttons: [
        { label: tr('Restart'), primary: true, run: () => ide.restart() },
        { label: tr('Not Now') },
      ],
    });
  }

  // ---------- dialog ----------
  let open = null; // {dlg, show(pageId)}

  const projectGroup = () => tr('Project: {name}', { name: ide.root ? basename(ide.root) : tr('<none>') });
  const BASE_TREE = [
    { group: 'appearance-behavior', title: () => tr('Appearance & Behavior'), children: [
      { id: 'appearance', title: () => tr('Appearance'), keywords: 'theme dark light look feel 테마 다크 라이트', mount: mountAppearance },
      { id: 'language', title: () => tr('Language and Region'), keywords: 'language korean english locale 언어 한국어 영어', mount: mountLanguage },
    ] },
    { id: 'keymap', title: () => tr('Keymap'), keywords: 'keymap shortcut hotkey key 단축키 키맵', mount: mountKeymap, index: false },
    { group: 'editor-group', title: () => tr('Editor'), children: [
      { id: 'editor', title: () => tr('General'), keywords: 'font size line height whitespace soft wrap tabs preview tab limit mouse wheel zoom sticky lines 글꼴 크기 줄 높이 공백 탭 미리보기 마우스 휠 확대 고정 줄', mount: mountEditor },
      { id: 'codestyle', title: () => tr('Code Style'), keywords: 'tab size indent ruler hard wrap line separator crlf lf 탭 들여쓰기 눈금자 줄 구분자', mount: mountCodeStyle },
    ] },
    { id: 'plugins', title: () => tr('Plugins'), keywords: 'plugin marketplace install extension 플러그인 마켓플레이스 설치', mount: mountPlugins, index: false },
    { group: 'project', title: projectGroup, children: [
      { id: 'interpreter', title: () => tr('Python Interpreter'), keywords: 'interpreter venv virtualenv environment packages python sdk 인터프리터 가상 환경 패키지', mount: mountInterpreter, index: false },
    ] },
    { id: 'tools', title: () => tr('Tools'), keywords: 'ruff actions on save reformat format lint check line length 저장 시 서식 린트 도구', mount: mountTools },
  ];
  // Other plugins add pages by pushing {id, title: () => string, keywords, group?: 'ai' | 'editor' | 'appearance', defaults?, index?, mount(host, ctx)}
  // to ide.settingsPages, so plugin load order does not matter; the tree is rebuilt each time the dialog opens.
  // Search mounts every page off screen once per dialog to read its labels; index: false (a page whose mount lists
  // data or starts slow work) is found by its title and keywords only.
  let TREE, PAGES;
  function buildTree() {
    const pluginPages = ide.settingsPages || [];
    const ai = pluginPages.filter((p) => p.group === 'ai');
    const nested = { 'editor-group': 'editor', 'appearance-behavior': 'appearance' };
    const base = BASE_TREE.map((n) => (nested[n.group] ? { ...n, children: [...n.children, ...pluginPages.filter((p) => p.group === nested[n.group])] } : n));
    return [...base, ...(ai.length ? [{ group: 'ai-group', title: () => tr('AI'), children: ai }] : []), ...pluginPages.filter((p) => p.group !== 'ai' && !Object.values(nested).includes(p.group))];
  }
  function rebuildTree() {
    TREE = buildTree();
    PAGES = TREE.flatMap((n) => n.children || [n]);
  }
  // Every page with its group's title, for Search Everywhere: [{id, title, group, keywords}].
  ide.settingsPageList = () => buildTree().flatMap((n) => (n.children || [n]).map((p) => ({
    id: p.id, title: p.title(), group: n.children ? n.title() : '', keywords: p.keywords || '' })));
  rebuildTree();
  const groupOf = (id) => TREE.find((n) => n.children?.some((c) => c.id === id));

  // A settings page's labelled rows (a section title, a field with its label and hint, a check box, a note, a button),
  // outermost only, and the text the user reads on one: not the choices of a list or what a field holds.
  const LABEL_ROWS = 'legend, label, .field, .settings-check, .settings-note, .settings-subtitle, button, h3, h4';
  const labelRows = (host) => {
    const all = [...host.querySelectorAll(LABEL_ROWS)];
    return all.filter((r) => !host.contains(r.parentElement.closest(LABEL_ROWS)));
  };
  function labelText(row) {
    let text = '';
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement.closest('select, textarea')) text += ` ${n.nodeValue}`;
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }
  // {own, section}: a row's text and its section's title, so "글꼴 크기" finds "Size:" in the Font section.
  const rowLabel = (row) => {
    const legend = row.tagName === 'LEGEND' ? null : row.closest('fieldset')?.querySelector(':scope > legend');
    return { own: labelText(row), section: legend ? labelText(legend) : '' };
  };
  // A row matches when its own text holds every word, or holds one and its section title the rest.
  const rowMatches = ({ own, section }, q) => q.every((w) => own.includes(w)) || (q.some((w) => own.includes(w)) && q.every((w) => own.includes(w) || section.includes(w)));

  function openSettings(pageId = 'appearance') {
    if (open) return open.show(pageId);
    rebuildTree();
    let pending = {};
    const value = (k) => (k in pending ? pending[k] : get(k));
    const set = (k, v) => {
      if (v === get(k)) delete pending[k]; else pending[k] = v;
      updateButtons();
    };
    // Plugin enable/disable choices are pending until OK/Apply, like the other settings.
    const pluginChanges = new Map();
    const ctx = { value, set, pluginChanges, changed: updateButtons, markRestart: () => { restartPending = true; updateButtons(); },
      // Form helpers for pages registered by other plugins; values go through value/set, so OK/Apply/Cancel cover them.
      ui: { section, fieldRow, checkbox: (key, label) => checkbox(ctx, key, label), numberInput: (key, opts) => numberInput(ctx, key, opts), selectInput: (key, options, fallback) => selectInput(ctx, key, options, fallback) } };

    const root = el('div', 'settings');
    const left = el('div', 'settings-nav');
    const searchWrap = el('div', 'settings-search-wrap');
    const search = el('input', 'settings-search');
    search.placeholder = tr('Search settings');
    search.dataset.enter = 'ignore';
    searchWrap.append(el('span', 'settings-search-icon', '⌕'), search);
    const nav = el('div', 'settings-pages');
    left.append(searchWrap, nav);
    const right = el('div', 'settings-main');
    const crumb = el('div', 'settings-crumb');
    const pageHost = el('div', 'settings-page');
    right.append(crumb, pageHost);
    root.append(left, right);

    let current = null;
    const rows = new Map();
    const groupRows = new Map();
    const collapsed = new Set();
    for (const node of TREE) {
      if (node.children) {
        const g = el('div', 'settings-nav-row settings-group');
        g.dataset.group = node.group;
        g.append(el('span', 'settings-arrow', '▾'), el('span', 'settings-nav-label', node.title()));
        g.onclick = () => {
          if (collapsed.has(node.group)) collapsed.delete(node.group); else collapsed.add(node.group);
          renderCollapse();
          if (!collapsed.has(node.group) && !node.children.some((c) => c.id === current)) show(node.children[0].id);
        };
        nav.appendChild(g);
        groupRows.set(node.group, g);
      }
      for (const p of node.children || [node]) {
        const row = el('div', 'settings-nav-row' + (node.children ? ' child' : ''));
        row.dataset.page = p.id;
        row.append(el('span', 'settings-arrow'), el('span', 'settings-nav-label', p.title()));
        row.onclick = () => show(p.id);
        nav.appendChild(row);
        rows.set(p.id, row);
      }
    }
    function renderCollapse() {
      for (const node of TREE) {
        if (!node.children) continue;
        const isCollapsed = collapsed.has(node.group);
        groupRows.get(node.group).querySelector('.settings-arrow').textContent = isCollapsed ? '▸' : '▾';
        for (const c of node.children) rows.get(c.id).classList.toggle('collapsed', isCollapsed);
      }
    }
    // The category list is a tree for the keyboard, as in PyCharm: Up/Down/Home/End switch pages, Left/Right collapse
    // and expand a group or go to it. A group chosen with the keys is drawn selected in place of the page's row.
    let chosenGroup = null;
    const chooseGroup = (row) => {
      chosenGroup?.classList.remove('selected');
      chosenGroup = row;
      row?.classList.add('selected');
      rows.get(current)?.classList.toggle('selected', !row);
    };
    nav.addEventListener('mousedown', () => chooseGroup(null));
    ide.ui.listKeys(nav, {
      rows: '.settings-nav-row',
      selected: () => chosenGroup || rows.get(current) || null,
      select: (row) => {
        chooseGroup(row.dataset.page ? null : row);
        if (row.dataset.page) show(row.dataset.page);
      },
      expanded: (row) => (row.dataset.page ? null : !collapsed.has(row.dataset.group)),
      toggle: (row) => {
        if (!collapsed.delete(row.dataset.group)) collapsed.add(row.dataset.group);
        renderCollapse();
      },
      parent: (row) => (row.classList.contains('child') ? groupRows.get(groupOf(row.dataset.page).group) : null),
      id: (row) => row.dataset.page || row.dataset.group,
    });

    function show(id) {
      const p = PAGES.find((x) => x.id === id) || PAGES[0];
      current = p.id;
      const group = groupOf(p.id);
      if (group && collapsed.delete(group.group)) renderCollapse();
      for (const [pid, row] of rows) row.classList.toggle('selected', pid === p.id);
      crumb.replaceChildren();
      if (group) crumb.append(el('span', 'muted', group.title()), el('span', 'settings-crumb-sep', '›'));
      crumb.append(el('span', null, p.title()));
      pageHost.replaceChildren();
      pageHost.dataset.page = p.id;
      const mounted = p.mount(pageHost, ctx);
      markHits();
      if (mounted?.then) mounted.then(() => { if (current === p.id) markHits(); }, () => {});
    }

    // ---------- search ----------
    // Each page's labels as rendered in this session's language ({id -> [rowLabel]}), read once per dialog from off-screen
    // mounts, so "탭 크기" finds Code Style by its "탭 크기:" field. Pages are ranked by how many of their rows match
    // every word of the query, and the shown page highlights those rows.
    let labels = null;
    let indexing = null;
    const words = () => search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hasAll = (text, q) => q.every((w) => text.includes(w));
    function indexPages() {
      indexing ||= (async () => {
        const mounts = PAGES.filter((p) => p.index !== false).map((p) => {
          const host = el('div', 'settings-page');
          let done = null;
          try { done = p.mount(host, ctx); } catch {}
          return { p, host, done };
        });
        await Promise.race([Promise.allSettled(mounts.map((m) => m.done)), new Promise((r) => setTimeout(r, 500))]);
        labels = new Map(mounts.map(({ p, host }) => [p.id, labelRows(host).map(rowLabel).filter((l) => l.own)]));
        if (!root.isConnected) return;
        // A page keeps references to what it mounted last: the shown one is mounted again so they point at it.
        if (labels.has(current)) show(current);
        runSearch();
      })();
    }
    // -1: no match; else higher ranks first.
    function score(p, q) {
      const title = p.title().toLowerCase();
      const own = labels?.get(p.id) || [];
      if (!hasAll([title, p.keywords || '', ...own.map((l) => l.own)].join(' ').toLowerCase(), q)) return -1;
      return (hasAll(title, q) ? 1000 : 0) + 10 * own.filter((l) => rowMatches(l, q)).length + (q.some((w) => title.includes(w)) ? 1 : 0);
    }
    function runSearch() {
      const q = words();
      let best = null;
      let bestScore = -1;
      for (const node of TREE) {
        let any = false;
        for (const p of node.children || [node]) {
          const s = q.length ? score(p, q) : 0;
          rows.get(p.id).classList.toggle('hidden', s < 0);
          if (s >= 0) any = true;
          if (s > bestScore) { best = p.id; bestScore = s; }
        }
        if (node.children) groupRows.get(node.group).classList.toggle('hidden', !any);
      }
      if (!q.length) return markHits();
      collapsed.clear();
      renderCollapse();
      if (best && best !== current) show(best);
      else markHits();
    }
    function markHits() {
      const q = words();
      for (const r of pageHost.querySelectorAll('.settings-hit')) r.classList.remove('settings-hit');
      if (!q.length) return;
      const hits = labelRows(pageHost).filter((r) => rowMatches(rowLabel(r), q));
      for (const r of hits) r.classList.add('settings-hit');
      hits[0]?.scrollIntoView({ block: 'nearest' });
    }
    search.oninput = () => {
      if (words().length && !labels) indexPages();
      runSearch();
    };

    async function applyPending() {
      const changed = pending;
      pending = {};
      for (const [k, v] of Object.entries(changed)) ide.settings.set(k, v);
      if (Object.keys(changed).some((k) => k.startsWith('interpreter.'))) ide.reloadInterpreters();
      if (Object.keys(changed).some((k) => RESTART_KEYS.has(k))) restartPending = true;
      if (pluginChanges.size) {
        for (const [id, enabled] of pluginChanges) await ide.api.invoke('plugins:setEnabled', id, enabled);
        pluginChanges.clear();
        restartPending = true;
        if (current === 'plugins') show('plugins');
      }
      updateButtons();
    }

    // Enter inside an inline form runs that form instead of the dialog's OK button.
    const enterGuard = (e) => {
      if (e.key !== 'Enter') return;
      const owner = e.target.closest?.('[data-enter]');
      if (!owner) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (owner.dataset.enter !== 'ignore') owner.dispatchEvent(new CustomEvent('enter'));
    };
    addEventListener('keydown', enterGuard, true);

    let closedByOk = false;
    const dlg = ide.ui.dialog({
      title: tr('Settings'),
      body: root,
      width: 960,
      buttons: [
        { label: tr('OK'), primary: true, run: async () => { await applyPending(); closedByOk = true; } },
        { label: tr('Cancel') },
        { label: tr('Apply'), run: async () => { await applyPending(); return false; } },
      ],
      onClose() {
        removeEventListener('keydown', enterGuard, true);
        open = null;
        if (closedByOk && restartPending) askRestart();
      },
    });
    dlg.el.classList.add('settings-dialog');
    dlg.body.classList.add('settings-body');
    const foot = dlg.el.querySelector('.dialog-buttons');
    const restartNote = el('span', 'settings-restart-note hidden', tr('Restart required to apply some changes'));
    foot.prepend(restartNote);
    const [okBtn, cancelBtn, applyBtn] = foot.querySelectorAll('button');
    okBtn.id = 'settingsOk';
    cancelBtn.id = 'settingsCancel';
    applyBtn.id = 'settingsApply';
    function updateButtons() {
      applyBtn.disabled = !Object.keys(pending).length && !pluginChanges.size;
      restartNote.classList.toggle('hidden', !restartPending);
    }
    updateButtons();
    renderCollapse();
    show(pageId);
    search.focus();
    open = { dlg, show };
  }

  // ---------- controls ----------
  const fieldRow = (label, control, hint) => {
    const row = el('label', 'field');
    row.append(el('span', null, label), control);
    if (hint) row.appendChild(el('span', 'field-hint muted', hint));
    return row;
  };
  const section = (host, title) => {
    const s = el('fieldset', 'settings-section');
    s.appendChild(el('legend', null, title));
    host.appendChild(s);
    return s;
  };
  function numberInput(ctx, key, { step = 1, placeholder, min: lo = 0, max: hi = 1e9, fallback } = {}) {
    const [min, max] = RANGES[key] || [lo, hi];
    const i = el('input');
    i.type = 'number';
    i.min = min;
    i.max = max;
    i.step = step;
    if (placeholder) i.placeholder = placeholder;
    i.dataset.key = key;
    const v = ctx.value(key) ?? fallback;
    i.value = placeholder && !v ? '' : v;
    i.oninput = () => {
      const n = i.value === '' ? (placeholder ? 0 : NaN) : Number(i.value);
      const ok = !Number.isNaN(n) && (n === 0 && placeholder ? true : n >= min && n <= max);
      i.classList.toggle('invalid', !ok);
      i.title = ok ? '' : tr('Enter a value between {min} and {max}', { min, max });
      if (ok) ctx.set(key, n);
    };
    return i;
  }
  function checkbox(ctx, key, label) {
    const row = el('label', 'settings-check');
    const c = el('input');
    c.type = 'checkbox';
    c.dataset.key = key;
    c.checked = !!ctx.value(key);
    c.onchange = () => ctx.set(key, c.checked);
    row.append(c, el('span', null, label));
    return row;
  }
  function selectInput(ctx, key, options, fallback) {
    const s = el('select');
    s.dataset.key = key;
    for (const [v, label] of options) s.add(new Option(label, v));
    s.value = ctx.value(key) ?? fallback;
    s.onchange = () => ctx.set(key, s.value);
    return s;
  }
  // Dropdown menus must live inside the dialog backdrop: the core context menu renders beneath dialogs.
  function dialogMenu(anchor, items, id) {
    const menu = el('div', 'context-menu settings-menu');
    if (id) menu.id = id;
    for (const [label, run] of items) {
      const item = el('div', 'menu-item', label);
      item.onmousedown = (e) => { e.preventDefault(); close(); run(); };
      menu.appendChild(item);
    }
    const r = anchor.getBoundingClientRect();
    anchor.closest('.dialog-backdrop').appendChild(menu);
    const m = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(r.left, innerWidth - m.width - 8)}px`;
    menu.style.top = `${r.bottom + 2}px`;
    const dismiss = (e) => { if (!menu.contains(e.target)) close(); };
    function close() { menu.remove(); removeEventListener('mousedown', dismiss, true); }
    setTimeout(() => addEventListener('mousedown', dismiss, true));
  }

  function mountAppearance(host, ctx) {
    const s = section(host, tr('Theme'));
    s.appendChild(fieldRow(tr('Theme:'), selectInput(ctx, 'appearance.theme', THEMES())));
  }

  function mountLanguage(host, ctx) {
    const s = section(host, tr('Language'));
    const options = i18n.languages.map(([v, label]) => [v, v === 'system'
      ? `${tr('System default')} (${i18n.systemLocale === 'ko' ? '한국어' : 'English'})` : label]);
    s.appendChild(fieldRow(tr('Language:'), selectInput(ctx, 'appearance.language', options)));
    s.appendChild(el('div', 'muted settings-note', tr('Changing the language requires restarting the IDE.')));
    s.appendChild(el('div', 'muted settings-note', tr('Current language: {name}', { name: i18n.locale === 'ko' ? '한국어' : 'English' })));
  }

  // ---------- Keymap page ----------
  // Edits the `keymap.overrides` setting (action id -> keys) like PyCharm's Settings › Keymap; the core applies it to the
  // actions (ide.keymap). Changes wait for OK / Apply like the other pages.
  const KEYMAP_KEY = 'keymap.overrides';
  const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'];
  const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
  const actionName = (a) => a.title || a.id;

  function mountKeymap(host, ctx) {
    host.classList.add('keymap-page');
    host.appendChild(el('div', 'muted settings-note', tr('PyCharm default keymap for Windows. Search by action name or shortcut.')));
    const bar = el('div', 'keymap-bar');
    const filter = el('input', 'input keymap-filter');
    filter.placeholder = tr('Search actions or shortcuts');
    filter.dataset.enter = 'ignore';
    const modifiedOnly = el('label', 'settings-check keymap-modified-only');
    const modifiedBox = el('input');
    modifiedBox.type = 'checkbox';
    modifiedBox.id = 'keymapModifiedOnly';
    modifiedOnly.append(modifiedBox, el('span', null, tr('Show modified only')));
    const button = (id, label) => { const b = el('button', 'secondary', label); b.id = id; return b; };
    const addBtn = button('keymapAdd', tr('Add Keyboard Shortcut…'));
    const removeBtn = button('keymapRemove', tr('Remove Shortcut'));
    const resetBtn = button('keymapReset', tr('Reset Shortcuts'));
    const resetAllBtn = button('keymapResetAll', tr('Reset All'));
    bar.append(filter, modifiedOnly);
    const buttons = el('div', 'keymap-buttons');
    buttons.append(addBtn, removeBtn, resetBtn, el('span', 'keymap-spacer'), resetAllBtn);
    const table = el('div', 'keymap-table');
    table.tabIndex = 0;
    host.append(bar, buttons, table);

    // The setting as edited so far. Ids of actions that are not loaded now (a disabled plugin's) are kept as they are.
    const raw = () => { const v = ctx.value(KEYMAP_KEY); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
    const overrides = () => ide.keymap.parse(raw());
    const defaultsOf = (a) => a.defaultKeys || a.keys;
    const keysOf = (a, ov = overrides()) => ov.get(a.id) || defaultsOf(a);
    // changes: [[actionId, keys | null (back to the defaults)]]
    function setKeys(changes) {
      const next = { ...raw() };
      for (const [id, keys] of changes) {
        const a = ide.actions.find((x) => x.id === id);
        if (!keys || (a && sameKeys(keys, defaultsOf(a)))) delete next[id]; else next[id] = keys;
      }
      ctx.set(KEYMAP_KEY, next);
      render();
    }
    // Actions whose keys clash with `key`: the same key, or one is the first stroke of the other. Actions of another
    // context (editor, project view) never fire together with `self`, so they do not clash.
    function conflicts(key, self) {
      const ov = overrides();
      const clash = (k) => k === key || (k !== 'Shift Shift' && key !== 'Shift Shift' && (k.startsWith(`${key} `) || key.startsWith(`${k} `)));
      const together = (a) => !a.context || !self.context || a.context === self.context;
      return ide.actions.filter((a) => a !== self && together(a)).map((a) => ({ action: a, keys: keysOf(a, ov).filter(clash) })).filter((c) => c.keys.length);
    }

    let selectedId = null;
    const selected = () => ide.actions.find((a) => a.id === selectedId);
    let shown = [];
    function render() {
      const q = filter.value.trim().toLowerCase();
      const ov = overrides();
      shown = ide.actions.filter((a) => a.title).sort((a, b) => a.title.localeCompare(b.title)).filter((a) => {
        const keys = keysOf(a, ov);
        if (modifiedBox.checked && !ov.has(a.id)) return false;
        return !q || a.title.toLowerCase().includes(q) || `${keys.join(' ')} ${keys.map(ide.keymap.format).join(' ')}`.toLowerCase().includes(q);
      });
      if (!shown.some((a) => a.id === selectedId)) selectedId = shown[0]?.id || null;
      table.replaceChildren();
      const head = el('div', 'keymap-head');
      head.append(el('span', null, tr('Action')), el('span', null, tr('Shortcut')));
      table.appendChild(head);
      for (const a of shown) {
        const modified = ov.has(a.id);
        const row = el('div', `keymap-row${modified ? ' modified' : ''}${a.id === selectedId ? ' selected' : ''}`);
        row.dataset.id = a.id;
        const title = el('span', 'keymap-title', a.title);
        if (modified) title.title = tr('Modified');
        const keyCell = el('span', 'keymap-keys');
        for (const k of keysOf(a, ov)) keyCell.appendChild(el('kbd', null, ide.keymap.format(k)));
        row.append(title, keyCell);
        row.onclick = () => select(a.id);
        row.ondblclick = () => { select(a.id); addShortcut(a); };
        row.oncontextmenu = (e) => { e.preventDefault(); select(a.id); actionMenu(row); };
        table.appendChild(row);
      }
      if (!shown.length) table.appendChild(el('div', 'muted keymap-empty', tr('No actions found')));
      updateButtons();
    }
    function select(id) {
      selectedId = id;
      for (const r of table.querySelectorAll('.keymap-row')) r.classList.toggle('selected', r.dataset.id === id);
      table.querySelector('.keymap-row.selected')?.scrollIntoView({ block: 'nearest' });
      updateButtons();
    }
    function updateButtons() {
      const a = selected();
      addBtn.disabled = !a;
      removeBtn.disabled = !a || !keysOf(a).length;
      resetBtn.disabled = !a || !overrides().has(a.id);
      resetAllBtn.disabled = !Object.keys(raw()).length;
    }
    const removeKey = (a, k) => setKeys([[a.id, keysOf(a).filter((x) => x !== k)]]);
    function actionMenu(anchor) {
      const a = selected();
      if (!a) return;
      dialogMenu(anchor, [
        [tr('Add Keyboard Shortcut…'), () => addShortcut(a)],
        ...keysOf(a).map((k) => [tr('Remove {key}', { key: ide.keymap.format(k) }), () => removeKey(a, k)]),
        ...(overrides().has(a.id) ? [[tr('Reset Shortcuts'), () => setKeys([[a.id, null]])]] : []),
      ], 'keymapMenu');
    }

    filter.oninput = render;
    modifiedBox.onchange = render;
    addBtn.onclick = () => selected() && addShortcut(selected());
    removeBtn.onclick = () => {
      const a = selected();
      const keys = a ? keysOf(a) : [];
      if (keys.length === 1) removeKey(a, keys[0]);
      else if (keys.length) dialogMenu(removeBtn, keys.map((k) => [tr('Remove {key}', { key: ide.keymap.format(k) }), () => removeKey(a, k)]), 'keymapRemoveMenu');
    };
    resetBtn.onclick = () => selected() && setKeys([[selected().id, null]]);
    resetAllBtn.onclick = () => { ctx.set(KEYMAP_KEY, {}); render(); };
    table.onkeydown = (e) => {
      const i = shown.findIndex((a) => a.id === selectedId);
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: shown.length - 1 }[e.key];
      if (to === undefined || !shown.length) return;
      e.preventDefault();
      select(shown[Math.max(0, Math.min(shown.length - 1, to))].id);
    };

    // PyCharm's Keyboard Shortcut dialog: the next key press (with its modifiers) is the stroke, Shift twice is Double
    // Shift, and a second stroke makes a two-stroke shortcut. Tab and Shift+Tab still move between the controls.
    function addShortcut(a) {
      const strokes = ['', ''];
      const field = (id) => { const f = el('input', 'input keymap-capture'); f.id = id; f.readOnly = true; f.placeholder = tr('Press a key combination'); return f; };
      const first = field('keymapFirstStroke');
      const second = field('keymapSecondStroke');
      second.disabled = true;
      const twoBox = el('input');
      twoBox.type = 'checkbox';
      twoBox.id = 'keymapTwoStrokes';
      const twoRow = el('label', 'settings-check');
      twoRow.append(twoBox, el('span', null, tr('Second stroke:')));
      const warn = el('div', 'keymap-conflicts');
      warn.id = 'keymapConflicts';
      const body = el('div', 'keymap-capture-body');
      body.append(fieldRow(tr('First stroke:'), first), twoRow, second, warn);
      const chord = () => (strokes[0] === 'Shift Shift' || strokes[0] === 'Ctrl Ctrl' || !twoBox.checked || !strokes[1] ? strokes[0] : `${strokes[0]} ${strokes[1]}`);
      function update() {
        first.value = strokes[0] ? ide.keymap.format(strokes[0]) : '';
        second.value = strokes[1] ? ide.keymap.format(strokes[1]) : '';
        const k = chord();
        const found = k ? conflicts(k, a) : [];
        warn.replaceChildren();
        if (k && keysOf(a).includes(k)) warn.append(el('div', null, tr('The action already has this shortcut.')));
        else if (found.length) {
          warn.append(el('div', 'keymap-conflict-title', tr('Conflicts with:')));
          for (const c of found) warn.append(el('div', 'keymap-conflict', `${actionName(c.action)} (${c.keys.map(ide.keymap.format).join(' / ')})`));
        }
      }
      twoBox.onchange = () => {
        second.disabled = !twoBox.checked || strokes[0] === 'Shift Shift' || strokes[0] === 'Ctrl Ctrl';
        if (!second.disabled) second.focus();
        update();
      };
      let lastShift = 0;
      // Double Ctrl: Ctrl pressed and released twice with nothing in between (see the core keymap); recorded on release.
      let ctrlTap = null;
      const onKeyUp = (e) => {
        if (e.key !== 'Control' || !ctrlTap || document.activeElement !== first) return;
        if (ctrlTap.step === 'first') { ctrlTap = { step: 'released', t: e.timeStamp }; return; }
        ctrlTap = null;
        strokes[0] = 'Ctrl Ctrl';
        second.disabled = true;
        update();
      };
      addEventListener('keyup', onKeyUp, true);
      const onKey = (e) => {
        const target = document.activeElement;
        if ((target !== first && target !== second) || e.isComposing) return;
        if (e.key === 'Control' && !e.altKey && !e.shiftKey && !e.metaKey && target === first) {
          if (!e.repeat) ctrlTap = ctrlTap?.step === 'released' && e.timeStamp - ctrlTap.t < 350 ? { step: 'second' } : { step: 'first' };
        } else ctrlTap = null;
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const i = target === first ? 0 : 1;
        if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (i === 0 && !e.repeat && e.timeStamp - lastShift < 350) {
            strokes[0] = 'Shift Shift';
            lastShift = 0;
            second.disabled = true;
            update();
          } else lastShift = e.timeStamp;
          return;
        }
        if (MODIFIERS.includes(e.key)) return;
        lastShift = 0;
        strokes[i] = ide.keymap.comboOf(e);
        if (i === 0) second.disabled = !twoBox.checked;
        update();
      };
      // Registered before the dialog's own key handler, so Enter and Esc are recorded instead of closing it.
      addEventListener('keydown', onKey, true);
      const dlg = ide.ui.dialog({
        title: tr('Keyboard Shortcut: {action}', { action: a.title }),
        body,
        width: 440,
        onClose: () => { removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKeyUp, true); },
        buttons: [
          { label: tr('OK'), primary: true, run: async () => {
            const k = chord();
            if (!k) return false;
            if (keysOf(a).includes(k)) return undefined;
            const found = conflicts(k, a);
            const changes = [[a.id, [...keysOf(a), k]]];
            if (found.length) {
              const choice = await askConflict(k, found);
              if (!choice) return false;
              if (choice === 'remove') for (const c of found) changes.push([c.action.id, keysOf(c.action).filter((x) => !c.keys.includes(x))]);
            }
            setKeys(changes);
            return undefined;
          } },
          { label: tr('Cancel') },
        ],
      });
      dlg.el.classList.add('keymap-capture-dialog');
      dlg.el.id = 'keymapCaptureDialog';
    }

    // PyCharm's question when a new shortcut is taken: Remove (the other assignments), Leave (both keep it), Cancel.
    const askConflict = (key, found) => new Promise((resolve) => {
      let choice = null;
      const body = el('div', 'keymap-conflict-ask');
      body.append(el('div', 'dialog-message', tr('The shortcut {key} is already assigned to other actions. Do you want to remove other assignments?', { key: ide.keymap.format(key) })));
      for (const c of found) body.append(el('div', 'keymap-conflict', actionName(c.action)));
      const dlg = ide.ui.dialog({
        title: tr('Warning'),
        body,
        width: 460,
        onClose: () => resolve(choice),
        buttons: [
          { label: tr('Remove'), primary: true, run: () => { choice = 'remove'; } },
          { label: tr('Leave'), run: () => { choice = 'leave'; } },
          { label: tr('Cancel') },
        ],
      });
      dlg.el.id = 'keymapConflictDialog';
    });

    render();
  }

  // Monaco's own keybindings of editor actions (editorCommand on the action or on its run function, such as Comment
  // with Line Comment) stay as they are while the action is unmodified. A modified one drops them and binds the
  // keymap's keys instead, so editors embedded in viewers, notebook cells and consoles follow the keymap too, and the
  // old key no longer runs the command anywhere.
  const MONACO_KEYS = { ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow',
    '/': 'Slash', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period', ';': 'Semicolon',
    "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote' };
  function monacoStroke(stroke) {
    const [, mods, key] = /^((?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?)(.+)$/.exec(stroke) || [];
    const name = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : MONACO_KEYS[key] || key;
    const code = monaco.KeyCode[name];
    if (typeof code !== 'number' || !code) return 0;
    const { KeyMod } = monaco;
    return code | (mods.includes('Ctrl') ? KeyMod.CtrlCmd : 0) | (mods.includes('Alt') ? KeyMod.Alt : 0) | (mods.includes('Shift') ? KeyMod.Shift : 0);
  }
  function monacoKeybinding(key) {
    if (key === 'Shift Shift' || key === 'Ctrl Ctrl') return 0;
    const strokes = key.split(' ').map(monacoStroke);
    if (strokes.some((s) => !s)) return 0;
    return strokes.length === 2 ? monaco.KeyMod.chord(strokes[0], strokes[1]) : strokes[0];
  }
  let monacoRules = null;
  let monacoRulesKey = '[]';
  function syncMonacoKeymap() {
    const rules = [];
    for (const a of ide.actions) {
      const command = a.editorCommand || a.run?.editorCommand;
      if (!command || !ide.keymap?.isModified(a.id)) continue;
      // No keybinding: removes every default Monaco keybinding of the command.
      rules.push({ keybinding: 0, command: `-${command}` });
      for (const k of a.keys) { const kb = monacoKeybinding(k); if (kb) rules.push({ keybinding: kb, command }); }
    }
    const key = JSON.stringify(rules);
    if (key === monacoRulesKey) return;
    monacoRulesKey = key;
    monacoRules?.dispose();
    monacoRules = rules.length ? monaco.editor.addKeybindingRules(rules) : null;
  }
  ide.on('keymapChanged', syncMonacoKeymap);
  ide.on('ready', syncMonacoKeymap);
  syncMonacoKeymap();

  function mountEditor(host, ctx) {
    const font = section(host, tr('Font'));
    font.appendChild(fieldRow(tr('Size:'), numberInput(ctx, 'editor.fontSize'), '6 – 48'));
    font.appendChild(fieldRow(tr('Line height:'), numberInput(ctx, 'editor.lineHeight', { step: 0.1 }), '1.0 – 3.0'));
    const mouse = section(host, tr('Mouse Control'));
    mouse.appendChild(checkbox(ctx, 'editor.wheelZoom', tr('Change font size with Ctrl+Mouse Wheel')));
    const look = section(host, tr('Appearance'));
    look.appendChild(checkbox(ctx, 'editor.showWhitespace', tr('Show whitespaces')));
    look.appendChild(checkbox(ctx, 'editor.softWrap', tr('Soft-wrap files')));
    // Sticky lines belong to the editor-assists plugin, which also holds their defaults.
    if (ide.editorAssists) {
      look.appendChild(checkbox(ctx, 'editor.stickyLines', tr('Show sticky lines')));
      look.appendChild(fieldRow(tr('Maximum number of sticky lines:'), numberInput(ctx, 'editor.stickyLinesMax', { min: 1, max: 20 }), '1 – 20'));
    }
    const tabs = section(host, tr('Editor Tabs'));
    tabs.appendChild(checkbox(ctx, 'editor.previewTab', tr('Open files in a preview tab on single click')));
    tabs.appendChild(fieldRow(tr('Tab limit:'), numberInput(ctx, 'editor.tabLimit'), tr('0 means no limit')));
  }

  function mountCodeStyle(host, ctx) {
    const general = section(host, tr('General'));
    // Used by new files and file templates; an existing file keeps its own separator (core editors.js).
    general.appendChild(fieldRow(tr('Line separator for new files:'), selectInput(ctx, 'editor.lineSeparator',
      [['system', tr('System-Dependent')], ['lf', tr('Unix and macOS (\\n)')], ['crlf', tr('Windows (\\r\\n)')]], 'system')));
    const style = section(host, tr('Python'));
    style.appendChild(fieldRow(tr('Tab size / Indent:'), numberInput(ctx, 'editor.tabSize')));
    style.appendChild(fieldRow(tr('Hard wrap at (ruler):'), numberInput(ctx, 'editor.ruler'), tr('0 hides the ruler')));
  }

  function mountTools(host, ctx) {
    const ruff = section(host, 'Ruff');
    ruff.appendChild(checkbox(ctx, 'tools.ruffOnSave', tr('Run ruff checks on open and save')));
    ruff.appendChild(fieldRow(tr('Line length:'), numberInput(ctx, 'tools.ruffLineLength', { placeholder: tr('from project config (88)') })));
    const ver = el('div', 'muted settings-note', tr('Bundled ruff (vendor/bin/ruff.exe)'));
    ruff.appendChild(ver);
    ide.api.invoke('tooling:ruffVersion')
      .then((v) => v && (ver.textContent = tr('Bundled {version} (vendor/bin/ruff.exe)', { version: v })))
      .catch(() => (ver.textContent = tr('The Ruff plugin is disabled.')));
  }

  // ---------- Plugins page ----------
  const localized = (p) => {
    const l = p.i18n?.[i18n.locale];
    if (l) return { name: l.name || p.name, description: l.description || p.description };
    return p.bundled ? { name: tr(p.name), description: tr(p.description) } : { name: p.name, description: p.description };
  };

  // plugins.marketplaceUrl: the online Marketplace index (an https URL, or a local folder or .json file). Unset means
  // the installation's default (main/marketplace.js), and an empty one turns the online Marketplace off.
  const MARKET_KEY = 'plugins.marketplaceUrl';
  const sizeText = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

  function mountPlugins(host, ctx) {
    host.classList.add('plugins-page');
    const bar = el('div', 'plugins-bar');
    const tabs = el('div', 'plugins-tabs');
    const tabMarket = el('button', 'plugins-tab', tr('Marketplace'));
    const tabInstalled = el('button', 'plugins-tab', tr('Installed'));
    tabMarket.dataset.tab = 'marketplace';
    tabInstalled.dataset.tab = 'installed';
    tabs.append(tabMarket, tabInstalled);
    const filter = el('input', 'input plugins-filter');
    filter.placeholder = tr('Search plugins');
    filter.dataset.enter = 'ignore';
    const gear = el('button', 'secondary plugins-gear', '⚙');
    gear.id = 'pluginsGear';
    gear.title = tr('Manage plugins');
    bar.append(tabs, filter, gear);
    const body = el('div', 'plugins-body');
    const list = el('div', 'plugins-list');
    list.id = 'pluginsList';
    const detail = el('div', 'plugins-detail');
    detail.id = 'pluginsDetail';
    body.append(list, detail);
    const status = el('div', 'muted settings-note plugins-status');
    status.id = 'pluginsStatus';
    host.append(bar, body, status);

    let tab = 'installed';
    let installed = [];
    // {plugins: [{id, name, version, vendor, description, i18n, origin: 'bundled' | 'online', url?, size?, homepage?,
    // installedVersion, update}], online: {state: 'off' | 'ok' | 'error', source?, hidden?, error?}, defaultUrl}; null
    // while it loads.
    let market = null;
    let selectedId = null;

    const effectiveEnabled = (p) => (ctx.pluginChanges.has(p.id) ? ctx.pluginChanges.get(p.id) : p.enabled);
    const needsRestart = (p) => p.loaded !== effectiveEnabled(p) || p.justInstalled;
    const updateOf = (p) => (p.bundled ? null : market?.plugins.find((m) => m.id === p.id && m.update));

    async function load({ refresh = false } = {}) {
      const justInstalled = new Set(installed.filter((p) => p.justInstalled).map((p) => p.id));
      installed = await ide.api.invoke('plugins:list');
      for (const p of installed) if (justInstalled.has(p.id)) p.justInstalled = true;
      if (refresh) market = null;
      render();
      market = await ide.api.invoke('plugins:marketplace', ide.settings.get(MARKET_KEY, null), { refresh });
      render();
    }

    function badge(text, cls = '') { return el('span', `plugin-badge ${cls}`, text); }

    // The online index's state above the Marketplace list: loading, could not be read (with Retry), or plugins that
    // need a newer PyIDE.
    function onlineNote() {
      const o = market?.online;
      if (market && o.state !== 'error' && !o.hidden) return null;
      const n = el('div', 'plugins-online muted');
      n.id = 'pluginsOnline';
      if (!market) n.textContent = tr('Loading the online Marketplace…');
      else if (o.state === 'ok') n.textContent = tr('Not shown because they need a newer PyIDE: {count}', { count: o.hidden });
      else {
        n.classList.add('error');
        const why = el('div', 'plugins-online-error', o.error);
        why.dataset.userText = '';
        const retry = el('button', 'secondary', tr('Retry'));
        retry.id = 'pluginsRetry';
        retry.onclick = () => load({ refresh: true });
        n.append(el('div', null, tr('Could not load the online Marketplace')), why, retry);
      }
      return n;
    }

    function render() {
      tabMarket.classList.toggle('active', tab === 'marketplace');
      tabInstalled.classList.toggle('active', tab === 'installed');
      const q = filter.value.trim().toLowerCase();
      const all = tab === 'installed' ? installed : market?.plugins || [];
      const items = all.filter((p) => {
        const l = localized(p);
        return !q || `${l.name} ${p.name} ${l.description} ${p.vendor}`.toLowerCase().includes(q);
      });
      list.replaceChildren();
      if (tab === 'installed') {
        const groups = [[tr('Downloaded'), items.filter((p) => !p.bundled)], [tr('Bundled'), items.filter((p) => p.bundled)]];
        for (const [title, group] of groups) {
          if (!group.length) continue;
          list.appendChild(el('div', 'plugins-group', `${title} (${group.length})`));
          for (const p of group) list.appendChild(row(p));
        }
      } else {
        const note = onlineNote();
        if (note) list.appendChild(note);
        for (const p of items) list.appendChild(row(p));
      }
      if (!list.querySelector('.plugin-row') && market) list.appendChild(el('div', 'muted plugins-empty', tr('No plugins found')));
      if (!all.some((p) => p.id === selectedId)) selectedId = items[0]?.id || null;
      for (const r of list.querySelectorAll('.plugin-row')) r.classList.toggle('selected', r.dataset.id === selectedId);
      renderDetail(all.find((p) => p.id === selectedId));
    }

    // The Marketplace button of a listed plugin: Install, Update (an older version is installed) or Installed.
    function marketButton(m, cls) {
      const current = m.installedVersion != null && !m.update;
      const b = el('button', `${current ? 'secondary' : 'primary'} ${cls}`, m.update ? tr('Update') : current ? tr('Installed') : tr('Install'));
      b.disabled = current;
      b.onclick = (e) => { e.stopPropagation(); installListed(m); };
      return b;
    }

    function row(p) {
      const l = localized(p);
      const r = el('div', 'plugin-row');
      r.dataset.id = p.id;
      const icon = el('span', 'plugin-icon', (l.name.match(/[A-Za-z가-힣]/)?.[0] || '?').toUpperCase());
      const text = el('div', 'plugin-text');
      const sub = el('div', 'plugin-sub muted', [p.vendor, p.version].filter(Boolean).join(' · '));
      sub.dataset.userText = '';
      text.append(el('div', 'plugin-name', l.name), sub);
      r.append(icon, text);
      if (tab === 'installed') {
        const update = updateOf(p);
        if (update) r.appendChild(marketButton(update, 'plugin-install plugin-update'));
        const c = el('input');
        c.type = 'checkbox';
        c.className = 'plugin-toggle';
        c.checked = effectiveEnabled(p);
        c.disabled = p.required;
        c.title = p.required ? tr('Required by PyIDE') : '';
        c.onclick = (e) => e.stopPropagation();
        c.onchange = () => toggle(p, c.checked);
        r.appendChild(c);
      } else {
        r.appendChild(marketButton(p, 'plugin-install'));
      }
      r.onclick = () => { selectedId = p.id; render(); };
      return r;
    }

    function toggle(p, enabled) {
      if (enabled === p.enabled) ctx.pluginChanges.delete(p.id); else ctx.pluginChanges.set(p.id, enabled);
      ctx.changed();
      render();
    }

    function renderDetail(p) {
      detail.replaceChildren();
      if (!p) return detail.appendChild(el('div', 'muted plugins-empty', tr('Select a plugin to see its details')));
      const l = localized(p);
      const head = el('div', 'plugin-detail-head');
      head.append(el('span', 'plugin-icon big', (l.name.match(/[A-Za-z가-힣]/)?.[0] || '?').toUpperCase()));
      const titles = el('div');
      const vendor = el('div', 'muted', [p.vendor, p.version && `v${p.version}`].filter(Boolean).join(' · '));
      vendor.dataset.userText = '';
      titles.append(el('div', 'plugin-detail-name', l.name), vendor);
      head.appendChild(titles);
      const badges = el('div', 'plugin-badges');
      const inst = installed.find((x) => x.id === p.id);
      const listed = tab === 'installed' ? updateOf(p) : p;
      if (inst?.bundled) badges.appendChild(badge(tr('Bundled')));
      if (inst?.required) badges.appendChild(badge(tr('Required')));
      if (inst && !effectiveEnabled(inst)) badges.appendChild(badge(tr('Disabled'), 'off'));
      if (inst?.blockedBy) badges.appendChild(badge(tr('Needs {id}', { id: inst.blockedBy }), 'warn'));
      if (inst && needsRestart(inst)) badges.appendChild(badge(tr('Restart required'), 'warn'));
      if (tab === 'installed' && listed) badges.appendChild(badge(tr('Version {version} available', { version: listed.version }), 'new'));
      const actions = el('div', 'plugin-actions');
      if (tab === 'installed' && inst) {
        if (listed) {
          const b = marketButton(listed, '');
          b.id = 'pluginUpdateBtn';
          actions.appendChild(b);
        }
        if (!inst.required) {
          const b = el('button', 'secondary', effectiveEnabled(inst) ? tr('Disable') : tr('Enable'));
          b.id = 'pluginEnableBtn';
          b.onclick = () => toggle(inst, !effectiveEnabled(inst));
          actions.appendChild(b);
        }
        if (!inst.bundled) {
          const u = el('button', 'secondary', tr('Uninstall'));
          u.id = 'pluginUninstallBtn';
          u.onclick = () => uninstall(inst);
          actions.appendChild(u);
        }
      } else if (tab === 'marketplace') {
        const b = marketButton(p, '');
        b.id = 'pluginMarketBtn';
        actions.appendChild(b);
      }
      if (listed?.homepage) {
        const h = el('button', 'secondary', tr('Homepage'));
        h.id = 'pluginHomepageBtn';
        h.onclick = () => ide.api.invoke('shell:openExternal', listed.homepage);
        actions.appendChild(h);
      }
      const desc = el('p', 'plugin-desc', l.description || tr('No description'));
      detail.append(head, badges, actions, desc);
      if (p.depends?.length) detail.appendChild(el('div', 'muted settings-note', tr('Depends on: {list}', { list: p.depends.join(', ') })));
      if (listed?.origin === 'online') {
        const from = el('div', 'muted settings-note plugin-source');
        const url = el('span', 'plugin-path', listed.url);
        url.dataset.userText = '';
        from.append(el('span', null, tr('Download ({size}):', { size: sizeText(listed.size) })), ' ', url);
        detail.appendChild(from);
      }
      if (inst && !inst.bundled) detail.appendChild(el('div', 'muted settings-note plugin-path', inst.dir));
    }

    async function install(run, label) {
      try {
        const r = await run();
        status.textContent = tr('Installed {name}. Restart the IDE to activate it.', { name: label || r.name });
        await load();
        const p = installed.find((x) => x.id === r.id);
        if (p) p.justInstalled = true;
        ctx.markRestart();
        render();
      } catch (e) {
        status.textContent = tr('Could not install the plugin: {error}', { error: ide.util.errorText(e) });
      }
    }

    // Plugins are code with the IDE's full access, so a download names its vendor and source and asks first.
    function trustOnline(m) {
      const field = (label, value) => {
        const r = el('div', 'plugin-trust-row');
        const v = el('span', 'plugin-trust-value', value);
        v.dataset.userText = '';
        r.append(el('span', 'muted', label), v);
        return r;
      };
      const box = el('div', 'plugin-trust');
      box.append(
        field(tr('Plugin:'), `${localized(m).name} ${m.version}`),
        field(tr('Vendor:'), m.vendor),
        field(tr('Source:'), m.url),
        el('p', 'plugin-trust-warning', tr('Plugins run with the same access as PyIDE: they can read and change your files, start programs and use the network. Install plugins only from vendors you trust.')),
      );
      return new Promise((resolve) => {
        let yes = false;
        ide.ui.dialog({
          title: m.update ? tr('Update Third-Party Plugin') : tr('Install Third-Party Plugin'),
          body: box,
          width: 560,
          onClose: () => resolve(yes),
          buttons: [{ label: m.update ? tr('Update') : tr('Install'), primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }],
        }).el.id = 'pluginTrustDialog';
      });
    }

    async function installListed(m) {
      if (m.origin === 'online') {
        if (!(await trustOnline(m))) return;
        status.textContent = tr('Downloading {name}…', { name: localized(m).name });
      }
      await install(() => ide.api.invoke('plugins:installListed', m.id), localized(m).name);
    }

    async function uninstall(p) {
      if (!(await ide.ui.confirm(tr('Uninstall {name}?', { name: localized(p).name }), { ok: tr('Uninstall') }))) return;
      // Windows refuses to delete a folder another program has open.
      try { await ide.api.invoke('plugins:uninstall', p.id); } catch (e) {
        status.textContent = tr('Could not uninstall {name}: {error}', { name: localized(p).name, error: ide.util.errorText(e) });
        return;
      }
      ctx.pluginChanges.delete(p.id);
      status.textContent = tr('Uninstalled {name}. Restart the IDE to unload it.', { name: localized(p).name });
      ctx.markRestart();
      await load();
    }

    // The online index location. Saved at once, as PyCharm's Manage Plugin Repositories does.
    function editRepository() {
      const form = el('div', 'plugin-repo');
      const input = el('input', 'input');
      input.id = 'pluginsRepoUrl';
      input.value = ide.settings.get(MARKET_KEY, null) ?? market?.defaultUrl ?? '';
      form.append(
        el('div', null, tr('Marketplace index (https URL, or a local folder or .json file):')),
        input,
        el('div', 'muted settings-note', tr('Leave it empty to turn the online Marketplace off.')),
      );
      const save = (value) => {
        ide.settings.set(MARKET_KEY, value === (market?.defaultUrl ?? '') ? undefined : value);
        tab = 'marketplace';
        load({ refresh: true });
      };
      ide.ui.dialog({
        title: tr('Manage Plugin Repositories'),
        body: form,
        width: 560,
        buttons: [
          { label: tr('OK'), primary: true, run: () => save(input.value.trim()) },
          { label: tr('Reset to Default'), run: () => save(market?.defaultUrl ?? '') },
          { label: tr('Cancel') },
        ],
      }).el.id = 'pluginRepoDialog';
    }

    gear.onclick = () => dialogMenu(gear, [
      [tr('Install Plugin from Disk…'), async () => {
        const source = await ide.api.invoke('dialog:openPlugin');
        if (source) install(() => ide.api.invoke('plugins:install', source));
      }],
      [tr('Manage Plugin Repositories…'), editRepository],
      [tr('Disable All Downloaded Plugins'), () => { for (const p of installed.filter((x) => !x.bundled && x.enabled)) toggle(p, false); }],
    ], 'pluginsGearMenu');
    tabMarket.onclick = () => { tab = 'marketplace'; selectedId = null; render(); };
    tabInstalled.onclick = () => { tab = 'installed'; selectedId = null; render(); };
    filter.oninput = render;
    load();
  }

  // ---------- Python Interpreter page ----------
  function mountInterpreter(host, ctx) {
    if (!ide.root) {
      host.appendChild(el('div', 'muted', tr('Open a project to configure its interpreter.')));
      return;
    }
    const key = `interpreter.${ide.root}`;
    const top = el('div', 'interp-row');
    const sel = el('select', 'interp-select');
    sel.id = 'settingsInterp';
    const addBtn = el('button', 'secondary', tr('Add Interpreter ▾'));
    addBtn.id = 'addInterpBtn';
    top.append(el('span', null, tr('Python Interpreter:')), sel, addBtn);
    const status = el('div', 'muted settings-note');
    status.id = 'interpStatus';
    const form = el('div', 'venv-form hidden');
    const table = el('div', 'pkg-table');
    table.id = 'settingsPackages';
    host.append(top, status, form, table);

    const selectedExe = () => ctx.value(key) || ide.currentInterp()?.executable;
    function fillSelect() {
      sel.replaceChildren();
      for (const it of ide.interps) sel.add(new Option(`${it.label}   ${it.executable}`, it.executable));
      const idx = ide.interps.findIndex((i) => samePath(i.executable, selectedExe()));
      sel.selectedIndex = Math.max(0, idx);
      loadPackages();
    }
    let loadSeq = 0;
    async function loadPackages() {
      const interp = ide.interps[sel.selectedIndex];
      const my = ++loadSeq;
      table.replaceChildren(el('div', 'muted', interp ? tr('Loading packages…') : tr('No interpreter')));
      if (!interp) return;
      let r;
      try { r = await ide.api.invoke('packages:list', interp); } catch { r = { ok: false, error: tr('The Python Packages plugin is disabled.') }; }
      if (my !== loadSeq || !host.isConnected) return;
      table.replaceChildren();
      const head = el('div', 'pkg-head');
      head.append(el('span', null, tr('Package')), el('span', null, tr('Version')));
      table.appendChild(head);
      if (!r.ok) return table.appendChild(el('div', 'muted', r.error));
      for (const p of r.packages) {
        const row = el('div', 'pkg-trow');
        row.dataset.userText = '';
        row.append(el('span', null, p.name), el('span', null, p.version));
        table.appendChild(row);
      }
    }
    sel.onchange = () => { ctx.set(key, ide.interps[sel.selectedIndex]?.executable); loadPackages(); };
    fillSelect();

    async function useInterpreter(exe) {
      ide.settings.set(key, exe);
      ctx.set(key, exe);
      await ide.reloadInterpreters();
      fillSelect();
    }

    async function addExisting() {
      const file = await ide.api.openFileDialog([{ name: tr('Python interpreter'), extensions: ['exe'] }]);
      if (!file) return;
      const extra = ide.settings.get('interpreters.extra', []);
      if (!extra.some((p) => samePath(p, file))) ide.settings.set('interpreters.extra', [...extra, file]);
      await ide.reloadInterpreters();
      const it = ide.interps.find((i) => samePath(i.executable, file));
      if (!it) {
        ide.settings.set('interpreters.extra', extra);
        status.textContent = tr('{path} is not a working Python interpreter', { path: file });
        return fillSelect();
      }
      status.textContent = tr('Added {name}', { name: it.label });
      await useInterpreter(it.executable);
    }

    async function showVenvForm() {
      form.classList.remove('hidden');
      form.replaceChildren();
      form.dataset.enter = 'create';
      form.appendChild(el('div', 'settings-subtitle', tr('New Virtualenv Environment')));
      const loc = el('input');
      loc.id = 'venvLocation';
      let dir = joinPath(ide.root, '.venv');
      if (await ide.api.exists(dir)) dir = joinPath(ide.root, 'venv');
      loc.value = dir;
      const base = el('select');
      base.id = 'venvBase';
      const bases = ide.interps.filter((i) => !samePath(dirname(dirname(i.executable)), dir));
      for (const it of bases) base.add(new Option(`${it.label}   ${it.executable}`, it.executable));
      const create = el('button', 'primary', tr('Create'));
      create.id = 'venvCreate';
      const cancel = el('button', 'secondary', tr('Cancel'));
      const log = el('pre', 'venv-log');
      log.id = 'venvLog';
      const btns = el('div', 'venv-buttons');
      btns.append(create, cancel);
      form.append(fieldRow(tr('Location:'), loc), fieldRow(tr('Base interpreter:'), base), btns, log);
      cancel.onclick = () => form.classList.add('hidden');
      const run = async () => {
        const target = loc.value.trim();
        const interp = bases[base.selectedIndex];
        if (!target || !interp) return;
        if (await ide.api.exists(target)) { log.textContent = tr('{path} already exists', { path: target }); return; }
        create.disabled = true;
        log.textContent = `${[interp.cmd, ...interp.args].join(' ')} -m venv ${target}\n`;
        let id;
        try { id = await ide.api.invoke('tooling:createVenv', interp, target); } catch {
          create.disabled = false;
          log.textContent += `${tr('The Ruff plugin, which creates environments, is disabled.')}\n`;
          return;
        }
        ide.proc.attach(id, {
          data: (text) => (log.textContent += text),
          async exit(code) {
            create.disabled = false;
            if (code !== 0) { log.textContent += `\n${tr('Failed with exit code {code}', { code })}\n`; return; }
            const exe = joinPath(target, 'Scripts\\python.exe');
            const autoFound = samePath(dirname(target), ide.root) && ['.venv', 'venv', 'env'].includes(basename(target).toLowerCase());
            const extra = ide.settings.get('interpreters.extra', []);
            if (!autoFound && !extra.some((p) => samePath(p, exe))) ide.settings.set('interpreters.extra', [...extra, exe]);
            log.textContent += `${tr('Virtual environment created.')}\n`;
            status.textContent = tr('Created {path}', { path: target });
            await useInterpreter(exe);
            ide.refreshTree();
            form.classList.add('hidden');
          },
        });
      };
      create.onclick = run;
      form.addEventListener('enter', run);
      loc.focus();
    }

    // Plugins add kinds such as On WSL… / On SSH… / On Docker… (remote-interp): {label() -> string, run({form, status, useInterpreter})}.
    addBtn.onclick = () => dialogMenu(addBtn, [
      [tr('Add Local Interpreter…'), addExisting],
      [tr('Create Virtualenv Environment…'), showVenvForm],
      ...(ide.interpreterAddActions || []).map((a) => [a.label(), () => a.run({ form, status, useInterpreter })]),
    ], 'addInterpMenu');
  }

  // ---------- actions ----------
  ide.registerAction({ id: 'ShowSettings', title: tr('Settings…'), keys: 'Ctrl+Alt+S', run: () => openSettings('appearance') });
  ide.registerAction({ id: 'ShowProjectStructureSettings', title: tr('Python Interpreter Settings…'), keys: 'Ctrl+Alt+Shift+S', run: () => openSettings('interpreter') });
  ide.registerAction({ id: 'ShowPlugins', title: tr('Plugins…'), run: () => openSettings('plugins') });
  ide.registerAction({ id: 'RestartIde', title: tr('Restart IDE'), run: () => ide.restart() });

  // PyCharm's toolbar gear: a menu of IDE-wide settings rather than the dialog itself.
  const gear = el('button', 'tb-icon settings-gear');
  gear.appendChild(ide.icon('settings', '⚙'));
  gear.title = tr('IDE and Project Settings');
  gear.onclick = () => {
    const r = gear.getBoundingClientRect();
    const menu = ide.ui.contextMenu(r.right - 240, r.bottom + 4, [
      { label: tr('Settings…'), hint: ide.keymap.label('ShowSettings'), icon: 'settings', run: () => openSettings('appearance') },
      { label: tr('Plugins…'), run: () => openSettings('plugins') },
      { label: tr('Python Interpreter…'), hint: ide.keymap.label('ShowProjectStructureSettings'), icon: 'python', run: () => openSettings('interpreter') },
      { separator: true },
      { label: tr('Theme'), submenu: ide.theme.menuItems },
      { label: tr('Keymap…'), run: () => openSettings('keymap') },
      { label: tr('Language and Region'), run: () => openSettings('language') },
      { separator: true },
      { label: tr('Restart IDE'), run: () => ide.restart() },
    ]);
    menu.id = 'settingsGearMenu';
  };
  ide.registerToolbarItem({ side: 'right', order: 200, el: gear });

  ide.openSettings = openSettings;
})();
