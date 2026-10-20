// Settings dialog (Ctrl+Alt+S): themes, language, keymap, editor, plugins, interpreter, tools.
// Preferences apply at startup and live on change; language and plugin changes need a restart, as in PyCharm.
(() => {
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const monaco = ide.monaco;

  // Light colors from PyCharm expUI_light.theme.json / expUI_lightScheme.xml (Python colors from the Python plugin's Light scheme).
  monaco.editor.defineTheme('pycharm-light', {
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
  // Plugin settings pages may declare defaults for their keys ({defaults: {key: value}}).
  const pluginDefault = (k) => (ide.settingsPages || []).find((p) => p.defaults && k in p.defaults)?.defaults[k];
  const get = (k) => ide.settings.get(k, k in DEFAULTS ? DEFAULTS[k] : pluginDefault(k));

  function applyTheme() {
    const light = get('appearance.theme') === 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    monaco.editor.setTheme(light ? 'pycharm-light' : 'pycharm-dark');
  }

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
    { id: 'keymap', title: () => tr('Keymap'), keywords: 'keymap shortcut hotkey key 단축키 키맵', mount: mountKeymap },
    { group: 'editor-group', title: () => tr('Editor'), children: [
      { id: 'editor', title: () => tr('General'), keywords: 'font size line height whitespace soft wrap tabs preview tab limit 글꼴 크기 줄 높이 공백 탭 미리보기', mount: mountEditor },
      { id: 'codestyle', title: () => tr('Code Style'), keywords: 'tab size indent ruler hard wrap 탭 들여쓰기 눈금자', mount: mountCodeStyle },
    ] },
    { id: 'plugins', title: () => tr('Plugins'), keywords: 'plugin marketplace install extension 플러그인 마켓플레이스 설치', mount: mountPlugins },
    { group: 'project', title: projectGroup, children: [
      { id: 'interpreter', title: () => tr('Python Interpreter'), keywords: 'interpreter venv virtualenv environment packages python sdk 인터프리터 가상 환경 패키지', mount: mountInterpreter },
    ] },
    { id: 'tools', title: () => tr('Tools'), keywords: 'ruff actions on save reformat format lint check line length 저장 시 서식 린트 도구', mount: mountTools },
  ];
  // Other plugins add pages by pushing {id, title: () => string, keywords, group?: 'ai' | 'editor' | 'appearance', defaults?, mount(host, ctx)}
  // to ide.settingsPages, so plugin load order does not matter; the tree is rebuilt each time the dialog opens.
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
      p.mount(pageHost, ctx);
    }

    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      let firstVisible = null;
      for (const node of TREE) {
        let any = false;
        for (const p of node.children || [node]) {
          const hit = !q || `${p.title()} ${p.keywords}`.toLowerCase().includes(q);
          rows.get(p.id).classList.toggle('hidden', !hit);
          if (hit) { any = true; firstVisible ??= p.id; }
        }
        if (node.children) groupRows.get(node.group).classList.toggle('hidden', !any);
      }
      if (q) { collapsed.clear(); renderCollapse(); }
      if (firstVisible && rows.get(current).classList.contains('hidden')) show(firstVisible);
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
    s.appendChild(fieldRow(tr('Theme:'), selectInput(ctx, 'appearance.theme', [['dark', tr('Dark')], ['light', tr('Light')]])));
  }

  function mountLanguage(host, ctx) {
    const s = section(host, tr('Language'));
    const options = i18n.languages.map(([v, label]) => [v, v === 'system'
      ? `${tr('System default')} (${i18n.systemLocale === 'ko' ? '한국어' : 'English'})` : label]);
    s.appendChild(fieldRow(tr('Language:'), selectInput(ctx, 'appearance.language', options)));
    s.appendChild(el('div', 'muted settings-note', tr('Changing the language requires restarting the IDE.')));
    s.appendChild(el('div', 'muted settings-note', tr('Current language: {name}', { name: i18n.locale === 'ko' ? '한국어' : 'English' })));
  }

  const ARROWS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
  const prettyKeys = (k) => k.replace(/Arrow(Up|Down|Left|Right)|Escape/g, (m) => ARROWS[m]);

  function mountKeymap(host) {
    host.appendChild(el('div', 'muted settings-note', tr('PyCharm default keymap for Windows. Search by action name or shortcut.')));
    const filter = el('input', 'input keymap-filter');
    filter.placeholder = tr('Search actions or shortcuts');
    filter.dataset.enter = 'ignore';
    const table = el('div', 'keymap-table');
    host.append(filter, table);
    const actions = ide.actions.filter((a) => a.title).sort((a, b) => a.title.localeCompare(b.title));
    function render() {
      const q = filter.value.trim().toLowerCase();
      table.replaceChildren();
      const head = el('div', 'keymap-head');
      head.append(el('span', null, tr('Action')), el('span', null, tr('Shortcut')));
      table.appendChild(head);
      for (const a of actions) {
        const keys = a.keys.join(', ');
        if (q && !a.title.toLowerCase().includes(q) && !keys.toLowerCase().includes(q)) continue;
        const row = el('div', 'keymap-row');
        const keyCell = el('span', 'keymap-keys');
        for (const k of a.keys) keyCell.appendChild(el('kbd', null, k === 'Shift Shift' ? tr('Double Shift') : prettyKeys(k)));
        row.append(el('span', null, a.title), keyCell);
        table.appendChild(row);
      }
    }
    filter.oninput = render;
    render();
  }

  function mountEditor(host, ctx) {
    const font = section(host, tr('Font'));
    font.appendChild(fieldRow(tr('Size:'), numberInput(ctx, 'editor.fontSize'), '6 – 48'));
    font.appendChild(fieldRow(tr('Line height:'), numberInput(ctx, 'editor.lineHeight', { step: 0.1 }), '1.0 – 3.0'));
    const look = section(host, tr('Appearance'));
    look.appendChild(checkbox(ctx, 'editor.showWhitespace', tr('Show whitespaces')));
    look.appendChild(checkbox(ctx, 'editor.softWrap', tr('Soft-wrap files')));
    const tabs = section(host, tr('Editor Tabs'));
    tabs.appendChild(checkbox(ctx, 'editor.previewTab', tr('Open files in a preview tab on single click')));
    tabs.appendChild(fieldRow(tr('Tab limit:'), numberInput(ctx, 'editor.tabLimit'), tr('0 means no limit')));
  }

  function mountCodeStyle(host, ctx) {
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
    let catalog = [];
    let selectedId = null;

    const effectiveEnabled = (p) => (ctx.pluginChanges.has(p.id) ? ctx.pluginChanges.get(p.id) : p.enabled);
    const needsRestart = (p) => p.loaded !== effectiveEnabled(p) || p.justInstalled;

    async function load() {
      [installed, catalog] = await Promise.all([ide.api.invoke('plugins:list'), ide.api.invoke('plugins:catalog')]);
      render();
    }

    function badge(text, cls = '') { return el('span', `plugin-badge ${cls}`, text); }

    function render() {
      tabMarket.classList.toggle('active', tab === 'marketplace');
      tabInstalled.classList.toggle('active', tab === 'installed');
      const q = filter.value.trim().toLowerCase();
      const items = (tab === 'installed' ? installed : catalog).filter((p) => {
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
        for (const p of items) list.appendChild(row(p));
      }
      if (!list.querySelector('.plugin-row')) list.appendChild(el('div', 'muted plugins-empty', tr('No plugins found')));
      const all = tab === 'installed' ? installed : catalog;
      if (!all.some((p) => p.id === selectedId)) selectedId = items[0]?.id || null;
      for (const r of list.querySelectorAll('.plugin-row')) r.classList.toggle('selected', r.dataset.id === selectedId);
      renderDetail(all.find((p) => p.id === selectedId));
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
        const isInstalled = installed.some((x) => x.id === p.id);
        const b = el('button', isInstalled ? 'secondary plugin-install' : 'primary plugin-install', isInstalled ? tr('Installed') : tr('Install'));
        b.disabled = isInstalled;
        b.onclick = (e) => { e.stopPropagation(); installFromCatalog(p); };
        r.appendChild(b);
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
      if (inst?.bundled) badges.appendChild(badge(tr('Bundled')));
      if (inst?.required) badges.appendChild(badge(tr('Required')));
      if (inst && !effectiveEnabled(inst)) badges.appendChild(badge(tr('Disabled'), 'off'));
      if (inst?.blockedBy) badges.appendChild(badge(tr('Needs {id}', { id: inst.blockedBy }), 'warn'));
      if (inst && needsRestart(inst)) badges.appendChild(badge(tr('Restart required'), 'warn'));
      const actions = el('div', 'plugin-actions');
      if (tab === 'installed' && inst) {
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
        const b = el('button', inst ? 'secondary' : 'primary', inst ? tr('Installed') : tr('Install'));
        b.disabled = !!inst;
        b.onclick = () => installFromCatalog(p);
        actions.appendChild(b);
      }
      const desc = el('p', 'plugin-desc', l.description || tr('No description'));
      detail.append(head, badges, actions, desc);
      if (p.depends?.length) detail.appendChild(el('div', 'muted settings-note', tr('Depends on: {list}', { list: p.depends.join(', ') })));
      if (inst && !inst.bundled) detail.appendChild(el('div', 'muted settings-note plugin-path', inst.dir));
    }

    async function installFrom(source, label) {
      try {
        const r = await ide.api.invoke('plugins:install', source);
        status.textContent = tr('Installed {name}. Restart the IDE to activate it.', { name: label || r.name });
        await load();
        const p = installed.find((x) => x.id === r.id);
        if (p) p.justInstalled = true;
        ctx.markRestart();
        render();
      } catch (e) {
        status.textContent = tr('Could not install the plugin: {error}', { error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      }
    }
    const installFromCatalog = (p) => installFrom(p.dir, localized(p).name);

    async function uninstall(p) {
      if (!confirm(tr('Uninstall {name}?', { name: localized(p).name }))) return;
      // Windows refuses to delete a folder another program has open.
      try { await ide.api.invoke('plugins:uninstall', p.id); } catch (e) {
        status.textContent = tr('Could not uninstall {name}: {error}', { name: localized(p).name, error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
        return;
      }
      ctx.pluginChanges.delete(p.id);
      status.textContent = tr('Uninstalled {name}. Restart the IDE to unload it.', { name: localized(p).name });
      ctx.markRestart();
      await load();
    }

    gear.onclick = () => dialogMenu(gear, [
      [tr('Install Plugin from Disk…'), async () => {
        const source = await ide.api.invoke('dialog:openPlugin');
        if (source) installFrom(source);
      }],
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
  const themeItem = (value, label) => ({ label, checked: get('appearance.theme') === value, run: () => ide.settings.set('appearance.theme', value) });
  gear.onclick = () => {
    const r = gear.getBoundingClientRect();
    const menu = ide.ui.contextMenu(r.right - 240, r.bottom + 4, [
      { label: tr('Settings…'), hint: 'Ctrl+Alt+S', icon: 'settings', run: () => openSettings('appearance') },
      { label: tr('Plugins…'), run: () => openSettings('plugins') },
      { label: tr('Python Interpreter…'), hint: 'Ctrl+Alt+Shift+S', icon: 'python', run: () => openSettings('interpreter') },
      { separator: true },
      { label: tr('Theme'), submenu: () => [themeItem('dark', tr('Dark')), themeItem('light', tr('Light'))] },
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
