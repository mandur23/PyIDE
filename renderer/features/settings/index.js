// Settings dialog (Ctrl+Alt+S), Light theme and editor preferences, applied at startup and live on change.
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
    'editor.fontSize': 14,
    'editor.lineHeight': 1.6,
    'editor.tabSize': 4,
    'editor.showWhitespace': false,
    'editor.softWrap': false,
    'editor.ruler': 120,
    'tools.formatOnSave': false,
    'tools.ruffOnSave': true,
    'tools.ruffLineLength': 0,
  };
  const get = (k) => ide.settings.get(k, DEFAULTS[k]);

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
    ide.editor.updateOptions({
      fontSize,
      lineHeight: Math.round(fontSize * (Number(get('editor.lineHeight')) || 1.6)),
      renderWhitespace: get('editor.showWhitespace') ? 'all' : 'none',
      wordWrap: get('editor.softWrap') ? 'on' : 'off',
      rulers: ruler > 0 ? [ruler] : [],
    });
    for (const t of ide.tabs) if (t.kind === 'file') applyModel(t.model);
  }

  ide.on('ready', () => { applyTheme(); applyEditor(); });
  ide.on('fileOpened', (tab) => tab.kind === 'file' && applyModel(tab.model));
  ide.on('settingsChanged', (key) => {
    if (key === 'appearance.theme') applyTheme();
    else if (key.startsWith('editor.')) applyEditor();
  });

  // ---------- dialog ----------
  let open = null; // {dlg, show(pageId)}

  const PAGES = [
    { id: 'appearance', group: 'Appearance & Behavior', title: 'Appearance', keywords: 'theme dark light look feel', mount: mountAppearance },
    { id: 'editor', title: 'Editor', keywords: 'font size line height tab size indent whitespace soft wrap ruler hard wrap code style', mount: mountEditor },
    { id: 'interpreter', group: () => `Project: ${ide.root ? basename(ide.root) : '<none>'}`, title: 'Python Interpreter', keywords: 'interpreter venv virtualenv environment packages python sdk', mount: mountInterpreter },
    { id: 'tools', title: 'Tools', keywords: 'ruff actions on save reformat format lint check line length', mount: mountTools },
  ];

  function openSettings(pageId = 'appearance') {
    if (open) return open.show(pageId);
    let pending = {};
    const value = (k) => (k in pending ? pending[k] : get(k));
    const set = (k, v) => {
      if (v === get(k)) delete pending[k]; else pending[k] = v;
      updateApply();
    };
    const ctx = { value, set };

    const root = el('div', 'settings');
    const left = el('div', 'settings-nav');
    const search = el('input', 'settings-search');
    search.placeholder = '🔍 Search settings';
    search.dataset.enter = 'ignore';
    const nav = el('div', 'settings-pages');
    left.append(search, nav);
    const right = el('div', 'settings-main');
    const crumb = el('div', 'settings-crumb');
    const pageHost = el('div', 'settings-page');
    right.append(crumb, pageHost);
    root.append(left, right);

    let current = null;
    const rows = new Map();
    for (const p of PAGES) {
      const group = typeof p.group === 'function' ? p.group() : p.group;
      if (group) nav.appendChild(el('div', 'settings-group', group));
      const row = el('div', 'settings-nav-row' + (group ? ' child' : ''), p.title);
      row.dataset.page = p.id;
      row.onclick = () => show(p.id);
      nav.appendChild(row);
      rows.set(p.id, row);
    }

    function show(id) {
      const p = PAGES.find((x) => x.id === id) || PAGES[0];
      current = p.id;
      for (const [pid, row] of rows) row.classList.toggle('selected', pid === p.id);
      const group = typeof p.group === 'function' ? p.group() : p.group;
      crumb.textContent = group ? `${group}  ›  ${p.title}` : p.title;
      pageHost.replaceChildren();
      pageHost.dataset.page = p.id;
      p.mount(pageHost, ctx);
    }

    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      let firstVisible = null;
      for (const p of PAGES) {
        const hit = !q || `${p.title} ${p.keywords}`.toLowerCase().includes(q);
        rows.get(p.id).classList.toggle('hidden', !hit);
        if (hit && !firstVisible) firstVisible = p.id;
      }
      if (firstVisible && rows.get(current).classList.contains('hidden')) show(firstVisible);
    };

    function applyPending() {
      const changed = pending;
      pending = {};
      for (const [k, v] of Object.entries(changed)) ide.settings.set(k, v);
      if (Object.keys(changed).some((k) => k.startsWith('interpreter.'))) ide.reloadInterpreters();
      updateApply();
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

    const dlg = ide.ui.dialog({
      title: 'Settings',
      body: root,
      width: 900,
      buttons: [
        { label: 'OK', primary: true, run: applyPending },
        { label: 'Cancel' },
        { label: 'Apply', run: () => { applyPending(); return false; } },
      ],
      onClose() { removeEventListener('keydown', enterGuard, true); open = null; },
    });
    dlg.el.classList.add('settings-dialog');
    dlg.body.classList.add('settings-body');
    const [okBtn, cancelBtn, applyBtn] = dlg.el.querySelectorAll('.dialog-buttons button');
    okBtn.id = 'settingsOk';
    cancelBtn.id = 'settingsCancel';
    applyBtn.id = 'settingsApply';
    function updateApply() { applyBtn.disabled = !Object.keys(pending).length; }
    updateApply();
    show(pageId);
    search.focus();
    open = { dlg, show };
  }

  // ---------- controls ----------
  const fieldRow = (label, control) => {
    const row = el('label', 'field');
    row.append(el('span', null, label), control);
    return row;
  };
  const section = (host, title) => {
    const s = el('fieldset', 'settings-section');
    s.appendChild(el('legend', null, title));
    host.appendChild(s);
    return s;
  };
  function numberInput(ctx, key, { min, max, step = 1, placeholder } = {}) {
    const i = el('input');
    i.type = 'number';
    if (min !== undefined) i.min = min;
    if (max !== undefined) i.max = max;
    i.step = step;
    if (placeholder) i.placeholder = placeholder;
    i.dataset.key = key;
    const v = ctx.value(key);
    i.value = placeholder && !v ? '' : v;
    i.oninput = () => {
      const n = i.value === '' ? 0 : Number(i.value);
      if (!Number.isNaN(n)) ctx.set(key, n);
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
  function selectInput(ctx, key, options) {
    const s = el('select');
    s.dataset.key = key;
    for (const [v, label] of options) s.add(new Option(label, v));
    s.value = ctx.value(key);
    s.onchange = () => ctx.set(key, s.value);
    return s;
  }

  function mountAppearance(host, ctx) {
    const s = section(host, 'Theme');
    s.appendChild(fieldRow('Theme:', selectInput(ctx, 'appearance.theme', [['dark', 'Dark'], ['light', 'Light']])));
  }

  function mountEditor(host, ctx) {
    const font = section(host, 'Font');
    font.appendChild(fieldRow('Size:', numberInput(ctx, 'editor.fontSize', { min: 6, max: 48 })));
    font.appendChild(fieldRow('Line height:', numberInput(ctx, 'editor.lineHeight', { min: 1, max: 3, step: 0.1 })));
    const look = section(host, 'Appearance');
    look.appendChild(checkbox(ctx, 'editor.showWhitespace', 'Show whitespaces'));
    look.appendChild(checkbox(ctx, 'editor.softWrap', 'Soft-wrap files'));
    const style = section(host, 'Code Style: Python');
    style.appendChild(fieldRow('Tab size / Indent:', numberInput(ctx, 'editor.tabSize', { min: 1, max: 16 })));
    style.appendChild(fieldRow('Hard wrap at (ruler):', numberInput(ctx, 'editor.ruler', { min: 0, max: 400 })));
  }

  function mountTools(host, ctx) {
    const save = section(host, 'Actions on Save');
    save.appendChild(checkbox(ctx, 'tools.formatOnSave', 'Reformat code (ruff format)'));
    save.appendChild(checkbox(ctx, 'tools.ruffOnSave', 'Run ruff checks on open and save'));
    const ruff = section(host, 'Ruff');
    ruff.appendChild(fieldRow('Line length:', numberInput(ctx, 'tools.ruffLineLength', { min: 0, max: 400, placeholder: 'from project config (88)' })));
    const ver = el('div', 'muted settings-note', 'ruff: bundled vendor/bin/ruff.exe');
    ruff.appendChild(ver);
    ide.api.invoke('tooling:ruffVersion').then((v) => v && (ver.textContent = `Bundled ${v} (vendor/bin/ruff.exe)`)).catch(() => {});
  }

  // ---------- Python Interpreter page ----------
  function mountInterpreter(host, ctx) {
    if (!ide.root) {
      host.appendChild(el('div', 'muted', 'Open a project to configure its interpreter.'));
      return;
    }
    const key = `interpreter.${ide.root}`;
    const top = el('div', 'interp-row');
    const sel = el('select', 'interp-select');
    sel.id = 'settingsInterp';
    const addBtn = el('button', 'secondary', 'Add Interpreter ▾');
    addBtn.id = 'addInterpBtn';
    top.append(el('span', null, 'Python Interpreter:'), sel, addBtn);
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
      table.replaceChildren(el('div', 'muted', interp ? 'Loading packages…' : 'No interpreter'));
      if (!interp) return;
      const r = await ide.api.invoke('packages:list', interp);
      if (my !== loadSeq || !host.isConnected) return;
      table.replaceChildren();
      const head = el('div', 'pkg-head');
      head.append(el('span', null, 'Package'), el('span', null, 'Version'));
      table.appendChild(head);
      if (!r.ok) return table.appendChild(el('div', 'muted', r.error));
      for (const p of r.packages) {
        const row = el('div', 'pkg-trow');
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
      const file = await ide.api.openFileDialog([{ name: 'Python interpreter', extensions: ['exe'] }]);
      if (!file) return;
      const extra = ide.settings.get('interpreters.extra', []);
      if (!extra.some((p) => samePath(p, file))) ide.settings.set('interpreters.extra', [...extra, file]);
      await ide.reloadInterpreters();
      const it = ide.interps.find((i) => samePath(i.executable, file));
      if (!it) {
        ide.settings.set('interpreters.extra', extra);
        status.textContent = `${file} is not a working Python interpreter`;
        return fillSelect();
      }
      status.textContent = `Added ${it.label}`;
      await useInterpreter(it.executable);
    }

    async function showVenvForm() {
      form.classList.remove('hidden');
      form.replaceChildren();
      form.dataset.enter = 'create';
      form.appendChild(el('div', 'settings-subtitle', 'New Virtualenv Environment'));
      const loc = el('input');
      loc.id = 'venvLocation';
      let dir = joinPath(ide.root, '.venv');
      if (await ide.api.exists(dir)) dir = joinPath(ide.root, 'venv');
      loc.value = dir;
      const base = el('select');
      base.id = 'venvBase';
      const bases = ide.interps.filter((i) => !samePath(dirname(dirname(i.executable)), dir));
      for (const it of bases) base.add(new Option(`${it.label}   ${it.executable}`, it.executable));
      const create = el('button', 'primary', 'Create');
      create.id = 'venvCreate';
      const cancel = el('button', 'secondary', 'Cancel');
      const log = el('pre', 'venv-log');
      log.id = 'venvLog';
      const btns = el('div', 'venv-buttons');
      btns.append(create, cancel);
      form.append(fieldRow('Location:', loc), fieldRow('Base interpreter:', base), btns, log);
      cancel.onclick = () => form.classList.add('hidden');
      const run = async () => {
        const target = loc.value.trim();
        const interp = bases[base.selectedIndex];
        if (!target || !interp) return;
        if (await ide.api.exists(target)) { log.textContent = `${target} already exists`; return; }
        create.disabled = true;
        log.textContent = `${[interp.cmd, ...interp.args].join(' ')} -m venv ${target}\n`;
        const id = await ide.api.invoke('tooling:createVenv', interp, target);
        ide.proc.attach(id, {
          data: (text) => (log.textContent += text),
          async exit(code) {
            create.disabled = false;
            if (code !== 0) { log.textContent += `\nFailed with exit code ${code}\n`; return; }
            const exe = joinPath(target, 'Scripts\\python.exe');
            const autoFound = samePath(dirname(target), ide.root) && ['.venv', 'venv', 'env'].includes(basename(target).toLowerCase());
            const extra = ide.settings.get('interpreters.extra', []);
            if (!autoFound && !extra.some((p) => samePath(p, exe))) ide.settings.set('interpreters.extra', [...extra, exe]);
            log.textContent += 'Virtual environment created.\n';
            status.textContent = `Created ${target}`;
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

    // The core context menu renders beneath dialogs, so this dropdown lives inside the dialog's backdrop.
    addBtn.onclick = () => {
      const menu = el('div', 'context-menu settings-menu');
      menu.id = 'addInterpMenu';
      for (const [label, run] of [['Add Local Interpreter…', addExisting], ['Create Virtualenv Environment…', showVenvForm]]) {
        const item = el('div', 'menu-item', label);
        item.onmousedown = (e) => { e.preventDefault(); close(); run(); };
        menu.appendChild(item);
      }
      const r = addBtn.getBoundingClientRect();
      menu.style.left = `${r.left}px`;
      menu.style.top = `${r.bottom + 2}px`;
      host.closest('.dialog-backdrop').appendChild(menu);
      const dismiss = (e) => { if (!menu.contains(e.target)) close(); };
      function close() { menu.remove(); removeEventListener('mousedown', dismiss, true); }
      setTimeout(() => addEventListener('mousedown', dismiss, true));
    };
  }

  // ---------- actions ----------
  ide.registerAction({ id: 'ShowSettings', title: 'Settings…', keys: 'Ctrl+Alt+S', run: () => openSettings('appearance') });
  ide.registerAction({ id: 'ShowProjectStructureSettings', title: 'Python Interpreter Settings…', keys: 'Ctrl+Alt+Shift+S', run: () => openSettings('interpreter') });

  const gear = el('button', 'tb-icon settings-gear', '⚙');
  gear.title = 'Settings (Ctrl+Alt+S)';
  gear.onclick = () => openSettings();
  ide.registerToolbarItem({ side: 'right', order: 200, el: gear });

  ide.openSettings = openSettings;
})();
