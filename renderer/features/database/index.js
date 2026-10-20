// Database: PyCharm-style data sources, a schema tree, and SQL query consoles. Connections, drivers and passwords
// live in the main process (main/features/database.js); this side only sees public records and query results.
(() => {
  const { el, basename, samePath } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(ch, ...args);
  const user = (node) => { node.dataset.userText = ''; return node; };
  const userEl = (tag, cls, text) => user(el(tag, cls, text));
  const SQLITE_FILE = /\.(sqlite3?|db)$/i;
  const MAX_ROWS = 500;

  // ---------- state ----------
  let drivers = [];
  let sources = [];
  const schemas = new Map(); // source id -> {loading} | {schemas} | {error, missingDriver}
  const expanded = new Set();
  let selectedKey = null;
  const consoles = new Map(); // source id -> console
  const logListeners = new Map(); // npm package -> Set(fn)

  const driverOf = (kind) => drivers.find((d) => d.kind === kind);
  const sourceOf = (id) => sources.find((s) => s.id === id);
  const nodeKey = (...parts) => JSON.stringify(parts);

  const loaded = (async () => {
    [drivers, sources] = await Promise.all([invoke('db:drivers'), invoke('db:list')]);
    renderTree();
  })();

  async function reloadSources() {
    sources = await invoke('db:list');
    for (const id of [...schemas.keys()]) if (!sourceOf(id)) schemas.delete(id);
    renderTree();
  }

  ide.api.on('db:state', ({ id, state, message }) => {
    const s = sourceOf(id);
    if (s) Object.assign(s, { state, message });
    // Expanding a source connects, so a disconnected source folds up instead of reconnecting on the next render.
    if (state === 'disconnected') { schemas.delete(id); expanded.delete(nodeKey(id)); }
    renderTree();
    consoles.get(id)?.renderState();
  });
  ide.api.on('db:drivers', (list) => {
    drivers = list;
    ide.emit('installablesChanged');
  });
  ide.api.on('db:log', ({ package: pkg, text }) => { for (const fn of logListeners.get(pkg) || []) fn(text); });
  const onLog = (pkg, fn) => {
    if (!logListeners.has(pkg)) logListeners.set(pkg, new Set());
    logListeners.get(pkg).add(fn);
    return () => logListeners.get(pkg).delete(fn);
  };

  async function installDriver(pkg, log) {
    const off = onLog(pkg, log);
    try { return await invoke('db:installDriver', pkg); } finally { off(); }
  }

  // ---------- SQL text ----------
  // Statements separated by `;`, skipping quoted text, comments and Postgres $tag$ bodies.
  // Each part is {start, end, from, to, text}: [start, end) is its share of the text including the `;`, [from, to) the statement itself.
  function splitStatements(text) {
    const out = [];
    let start = 0;
    let i = 0;
    const push = (end, stop) => {
      const raw = text.slice(start, stop);
      const lead = raw.length - raw.trimStart().length;
      const body = raw.trim();
      out.push({ start, end, from: start + lead, to: start + lead + body.length, text: body });
      start = end;
    };
    while (i < text.length) {
      const ch = text[i];
      const two = text.slice(i, i + 2);
      if (two === '--') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
      if (two === '/*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        while (j < text.length && !(text[j] === ch && text[j + 1] !== ch)) j += text[j] === ch ? 2 : 1;
        i = j + 1;
        continue;
      }
      const dollar = ch === '$' && text.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (dollar) { const e = text.indexOf(dollar[0], i + dollar[0].length); i = e < 0 ? text.length : e + dollar[0].length; continue; }
      if (ch === ';') { push(i + 1, i); i++; continue; }
      i++;
    }
    if (start < text.length || !out.length) push(text.length, text.length);
    return out;
  }
  const isBlank = (sql) => !sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
  const runnable = (text) => splitStatements(text).filter((s) => !isBlank(s.text));

  // The statement the caret is in; in the blank space after the last statement, the one before it.
  function statementAt(text, offset) {
    const parts = splitStatements(text);
    const i = parts.findIndex((p) => offset >= p.start && offset <= p.end);
    const at = i < 0 ? parts.length - 1 : i;
    for (let k = at; k >= 0; k--) if (!isBlank(parts[k].text)) return parts[k];
    return parts.slice(at).find((p) => !isBlank(p.text)) || null;
  }

  function qualifiedName(src, schema, table) {
    const d = driverOf(src.kind);
    const q = (name) => `${d.quote}${name.split(d.quote).join(d.quote + d.quote)}${d.quote}`;
    return d.implicitSchemas.includes(schema) ? q(table) : `${q(schema)}.${q(table)}`;
  }

  // ---------- tool window ----------
  let tw;
  let treeEl;

  function renderTree() {
    if (!treeEl) return;
    const rows = [];
    const add = (depth, node) => rows.push({ depth, ...node });
    for (const s of sources) {
      const sk = nodeKey(s.id);
      add(0, { key: sk, kind: 'source', source: s, label: s.name, detail: driverOf(s.kind)?.label || s.kind, open: expanded.has(sk), leaf: false });
      if (!expanded.has(sk)) continue;
      const sch = schemas.get(s.id);
      if (!sch) { loadSchema(s.id); add(1, { kind: 'info', label: tr('Loading…') }); continue; }
      if (sch.loading) { add(1, { kind: 'info', label: tr('Loading…') }); continue; }
      if (sch.error) { add(1, { kind: 'error', label: sch.missingDriver ? tr('Driver files are missing. Download them in the data source settings.') : sch.error }); continue; }
      for (const schema of sch.schemas) {
        const k = nodeKey(s.id, schema.name);
        add(1, { key: k, kind: 'schema', source: s, schema: schema.name, label: schema.name, open: expanded.has(k), leaf: false });
        if (!expanded.has(k)) continue;
        if (!schema.children.length) add(2, { kind: 'info', label: tr('No tables') });
        for (const t of schema.children) {
          const tk = nodeKey(s.id, schema.name, t.name);
          add(2, { key: tk, kind: t.kind, source: s, schema: schema.name, table: t, label: t.name, open: expanded.has(tk), leaf: false });
          if (!expanded.has(tk)) continue;
          for (const c of t.columns) {
            add(3, { key: nodeKey(s.id, schema.name, t.name, c.name), kind: 'column', source: s, column: c, label: c.name,
              detail: `${c.type || ''}${c.nullable ? '' : ' NOT NULL'}`.trim(), leaf: true });
          }
        }
      }
    }
    treeEl.replaceChildren();
    if (!sources.length) {
      const empty = el('div', 'db-empty muted');
      empty.append(el('div', null, tr('No data sources yet.')));
      const add2 = el('button', 'secondary', tr('Add Data Source…'));
      add2.onclick = (e) => showAddMenu(e.currentTarget);
      empty.append(add2);
      treeEl.append(empty);
      return;
    }
    for (const r of rows) treeEl.append(treeRow(r));
  }

  const ICONS = { source: '⛁', schema: '▤', table: '▦', view: '◫', column: '▫', info: '', error: '' };

  function treeRow(r) {
    const row = el('div', `db-node db-${r.kind}` + (r.key && r.key === selectedKey ? ' selected' : ''));
    row.style.paddingLeft = `${r.depth * 16 + 4}px`;
    if (r.key) row.dataset.key = r.key;
    row.dataset.kind = r.kind;
    row.append(el('span', 'db-arrow', r.leaf === false ? (r.open ? '▾' : '▸') : ''));
    const icon = el('span', 'db-icon', r.column?.pk ? '🔑' : ICONS[r.kind]);
    row.append(icon);
    if (r.kind === 'source') {
      const dot = el('span', `db-dot db-state-${r.source.state}`);
      dot.title = r.source.state === 'error' ? r.source.message : stateLabel(r.source.state);
      row.append(dot);
    }
    const isData = r.kind !== 'info' && r.kind !== 'error';
    row.append((isData || r.kind === 'error' ? userEl : el)('span', 'db-label', r.label));
    if (r.detail) row.append(userEl('span', 'db-detail', r.detail));
    if (!r.key) return row;
    row.onclick = () => {
      selectedKey = r.key;
      if (!r.leaf) { expanded.has(r.key) ? expanded.delete(r.key) : expanded.add(r.key); }
      renderTree();
    };
    row.ondblclick = () => { if (r.kind === 'table' || r.kind === 'view') openData(r.source.id, r.schema, r.table.name); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      selectedKey = r.key;
      renderTree();
      ide.ui.contextMenu(e.clientX, e.clientY, nodeMenu(r));
    };
    return row;
  }

  const stateLabel = (state) => ({ disconnected: tr('Disconnected'), connecting: tr('Connecting…'), connected: tr('Connected'), error: tr('Connection failed') })[state] || state;

  function nodeMenu(r) {
    const s = r.source;
    const common = [
      { separator: true },
      { label: tr('Refresh'), run: () => refreshSchema(s.id) },
      { label: tr('Disconnect'), disabled: s.state !== 'connected', run: () => invoke('db:disconnect', s.id) },
    ];
    if (r.kind === 'table' || r.kind === 'view') {
      return [
        { label: tr('Open Data'), run: () => openData(s.id, r.schema, r.table.name) },
        { label: tr('Generate SELECT'), run: () => generateSelect(s.id, r.schema, r.table) },
        { label: tr('Copy Name'), run: () => invoke('clipboard:writeText', r.table.name) },
        ...common,
      ];
    }
    if (r.kind === 'column') return [{ label: tr('Copy Name'), run: () => invoke('clipboard:writeText', r.column.name) }];
    return [
      { label: tr('New Query Console'), run: () => openConsole(s.id) },
      ...common,
      { separator: true },
      { label: tr('Edit Data Source…'), run: () => editDataSource(s) },
      { label: tr('Remove Data Source'), run: () => removeDataSource(s) },
    ];
  }

  async function loadSchema(id) {
    schemas.set(id, { loading: true });
    const r = await invoke('db:schema', id);
    if (!sourceOf(id)) return;
    schemas.set(id, r.ok ? { schemas: r.schemas } : { error: r.error, missingDriver: r.missingDriver });
    // A single schema (SQLite's main) opens by itself so the tables are one click away.
    if (r.ok && r.schemas.length === 1) expanded.add(nodeKey(id, r.schemas[0].name));
    renderTree();
  }

  function refreshSchema(id) {
    schemas.delete(id);
    if (expanded.has(nodeKey(id))) loadSchema(id);
    else renderTree();
  }

  const selectedSource = () => (selectedKey ? sourceOf(JSON.parse(selectedKey)[0]) : null);

  function toolButton(id, icon, title, run) {
    const b = el('button', 'db-tool-btn');
    b.id = id;
    b.append(typeof icon === 'string' ? el('span', 'db-glyph', icon) : icon);
    b.title = title;
    b.onclick = (e) => run(e.currentTarget);
    return b;
  }

  function showAddMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    ide.ui.contextMenu(r.left, r.bottom + 2, [
      { header: tr('Data Source') },
      ...drivers.map((d) => ({ label: d.label, run: () => editDataSource({ kind: d.kind }) })),
    ]);
  }

  tw = ide.registerToolWindow({
    id: 'Database', title: tr('Database'), icon: '⛁', iconName: 'database', side: 'bottom', order: 55,
    mount(container) {
      container.classList.add('db-tool');
      const bar = el('div', 'db-toolbar');
      bar.append(
        toolButton('dbAdd', ide.icon('add', '+'), tr('New Data Source'), showAddMenu),
        toolButton('dbRefresh', '⟳', tr('Refresh'), () => {
          const s = selectedSource();
          if (s) refreshSchema(s.id);
          else { schemas.clear(); reloadSources(); }
        }),
        toolButton('dbEdit', '✎', tr('Edit Data Source…'), () => { const s = selectedSource(); if (s) editDataSource(s); }),
        toolButton('dbRemove', '−', tr('Remove Data Source'), () => { const s = selectedSource(); if (s) removeDataSource(s); }),
        el('span', 'db-sep'),
        toolButton('dbConsole', '▶', tr('New Query Console'), () => openQueryConsole()),
      );
      treeEl = el('div', 'db-tree');
      treeEl.id = 'dbTree';
      container.append(bar, treeEl);
      renderTree();
    },
  });

  // ---------- data source dialog ----------
  const FIELD_LABELS = () => ({ file: tr('File'), host: tr('Host'), port: tr('Port'), user: tr('User'), password: tr('Password'), database: tr('Database') });

  function editDataSource(existing) {
    const isNew = !existing.id;
    let kind = existing.kind;
    let passwordTouched = false;
    const values = { ...existing };
    const body = el('div', 'db-form');
    const nameInput = el('input');
    nameInput.id = 'dbName';
    nameInput.value = existing.name || '';
    const kindSelect = el('select');
    kindSelect.id = 'dbKind';
    for (const d of drivers) kindSelect.add(new Option(d.label, d.kind));
    kindSelect.value = kind;
    const fieldsHost = el('div');
    const driverHost = el('div', 'db-driver');
    const testRow = el('div', 'db-test');
    const testBtn = el('button', 'secondary', tr('Test Connection'));
    testBtn.id = 'dbTest';
    const testResult = el('div', 'db-test-result');
    testResult.id = 'dbTestResult';
    testRow.append(testBtn, testResult);

    const field = (label, input) => {
      const row = el('label', 'field');
      row.append(el('span', null, label), input);
      return row;
    };
    body.append(field(tr('Name'), nameInput), field(tr('Driver'), kindSelect), fieldsHost, driverHost, testRow);

    const inputs = {};
    function renderFields() {
      fieldsHost.replaceChildren();
      const d = driverOf(kind);
      const labels = FIELD_LABELS();
      // Field specs come from the kind's driver (main/db/drivers.js): built-in names or {key, label, type, options...}.
      for (const spec of d.fields) {
        const f = spec.key;
        const label = spec.builtin ? labels[f] : tr(spec.label);
        let input;
        if (spec.type === 'select') {
          input = el('select');
          for (const [value, text] of spec.options || []) input.add(new Option(tr(text), value));
          input.value = values[f] ?? spec.default ?? spec.options?.[0]?.[0] ?? '';
          input.onchange = () => { values[f] = input.value; };
        } else if (spec.type === 'checkbox') {
          input = el('input');
          input.type = 'checkbox';
          input.checked = values[f] ?? !!spec.default;
          input.onchange = () => { values[f] = input.checked; };
        } else {
          input = el('input');
          if (spec.placeholder) input.placeholder = spec.placeholder;
        }
        input.id = `dbField-${f}`;
        input.dataset.field = f;
        if (f === 'password') {
          input.type = 'password';
          input.autocomplete = 'new-password';
          if (existing.hasPassword && existing.kind === kind) input.placeholder = tr('Saved; type to replace');
          input.oninput = () => { passwordTouched = true; };
        } else if (spec.type !== 'select' && spec.type !== 'checkbox') {
          input.value = values[f] ?? (f === 'port' ? d.defaultPort : spec.default ?? '');
          input.oninput = () => { values[f] = input.value; };
        }
        if (spec.type === 'number') input.type = 'number';
        inputs[f] = input;
        if (spec.type === 'file') {
          const wrap = el('div', 'field-row');
          const browse = el('button', 'secondary', tr('Browse…'));
          browse.id = 'dbBrowse';
          browse.onclick = async () => {
            const exts = spec.extensions || ['sqlite', 'sqlite3', 'db', 'db3'];
            const p = await ide.api.openFileDialog([{ name: tr('{name} database', { name: d.label }), extensions: exts }, { name: tr('All files'), extensions: ['*'] }]);
            if (p) {
              input.value = values[f] = p;
              if (!nameInput.value.trim()) nameInput.value = basename(p);
            }
          };
          wrap.append(input, browse);
          fieldsHost.append(field(label, wrap));
        } else fieldsHost.append(field(label, input));
      }
      renderDriver();
    }

    function renderDriver() {
      driverHost.replaceChildren();
      const d = driverOf(kind);
      if (d.builtin) return;
      if (ide.installer) {
        const local = el('a', 'db-local-server', tr('No server yet? Install one locally in the Install Manager'));
        local.href = '#';
        local.onclick = (e) => { e.preventDefault(); dlg.close(); ide.installer.open('databases'); };
        driverHost.append(local);
      }
      if (d.installed) {
        driverHost.append(userEl('div', 'muted', `${tr('Driver')}: ${d.package} ${d.version}`));
        return;
      }
      const warn = el('div', 'db-driver-missing');
      warn.id = 'dbDriverMissing';
      warn.append(el('span', null, tr('Driver files for {name} are missing.', { name: d.label })));
      const dl = el('button', 'primary', tr('Download Driver'));
      dl.id = 'dbDownloadDriver';
      const log = userEl('pre', 'db-log');
      log.id = 'dbDriverLog';
      dl.onclick = async () => {
        dl.disabled = true;
        dl.textContent = tr('Downloading…');
        log.textContent = '';
        const r = await installDriver(d.package, (text) => {
          log.textContent = (log.textContent + text).split('\n').slice(-300).join('\n');
          log.scrollTop = log.scrollHeight;
        });
        drivers = await invoke('db:drivers');
        if (r.ok) renderDriver();
        else {
          dl.disabled = false;
          dl.textContent = tr('Download Driver');
          log.textContent += `\n${tr('Download failed: {error}', { error: r.error })}\n`;
        }
      };
      warn.append(dl);
      driverHost.append(warn, log);
    }

    function collect() {
      const cfg = { kind, name: nameInput.value.trim() };
      if (!isNew) cfg.id = existing.id;
      for (const { key: f, type } of driverOf(kind).fields) {
        if (f === 'password') { if (passwordTouched) cfg.password = inputs.password.value; } else cfg[f] = type === 'checkbox' ? inputs[f].checked : inputs[f].value.trim();
      }
      return cfg;
    }

    kindSelect.onchange = () => { kind = kindSelect.value; testResult.textContent = ''; renderFields(); };
    testBtn.onclick = async () => {
      testResult.className = 'db-test-result';
      testResult.textContent = tr('Connecting…');
      const r = await invoke('db:test', collect());
      testResult.classList.add(r.ok ? 'ok' : 'err');
      testResult.replaceChildren();
      if (r.ok) testResult.append(el('span', null, tr('Succeeded')), userEl('span', 'db-test-detail', `  ${r.version} · ${r.ms} ms`));
      else if (r.missingDriver) testResult.append(el('span', null, tr('Driver files are missing. Download the driver first.')));
      else testResult.append(el('span', null, `${tr('Failed')}: `), userEl('span', null, r.error));
    };

    renderFields();
    const dlg = ide.ui.dialog({
      title: isNew ? tr('New Data Source') : tr('Data Source: {name}', { name: existing.name }),
      body,
      width: 580,
      buttons: [
        { label: tr('OK'), primary: true, run: async () => {
          const cfg = collect();
          if (driverOf(kind).fields.some((x) => x.type === 'file') && !cfg.file) { testResult.className = 'db-test-result err'; testResult.textContent = tr('Choose a database file.'); return false; }
          const saved = await invoke('db:save', cfg);
          await reloadSources();
          selectedKey = nodeKey(saved.id);
          renderTree();
          const c = consoles.get(saved.id);
          if (c) { c.tab.title = saved.name; ide.renderTabs(); c.renderState(); }
          tw.show();
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
    dlg.el.classList.add('db-dialog');
    nameInput.focus();
    return dlg;
  }

  function removeDataSource(s) {
    ide.ui.dialog({
      title: tr('Remove Data Source'),
      body: (() => { const b = el('div'); b.append(el('span', null, tr('Remove this data source?')), userEl('div', 'db-remove-name', s.name)); return b; })(),
      width: 420,
      buttons: [
        { label: tr('Remove'), primary: true, run: async () => {
          const c = consoles.get(s.id);
          if (c) ide.closeTabObject(c.tab, true);
          await invoke('db:remove', s.id);
          forgetConsole(s.id);
          if (selectedKey && JSON.parse(selectedKey)[0] === s.id) selectedKey = null;
          await reloadSources();
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // ---------- query console ----------
  const OPEN_KEY = 'database.openConsoles';
  const openIds = () => ide.settings.get(OPEN_KEY, []);
  const rememberConsole = (id) => { if (!openIds().includes(id)) ide.settings.set(OPEN_KEY, [...openIds(), id]); };
  const forgetConsole = (id) => { if (openIds().includes(id)) ide.settings.set(OPEN_KEY, openIds().filter((x) => x !== id)); };
  const consoleTabId = (id) => `db-console:${id}`;

  async function openConsole(id) {
    await loaded;
    const src = sourceOf(id);
    if (!src) return null;
    if (consoles.has(id)) {
      const c = consoles.get(id);
      ide.openCustomTab({ id: consoleTabId(id) });
      c.editor.focus();
      return c;
    }
    const text = (await invoke('db:consoleLoad', id)) ?? '';
    if (consoles.has(id)) return openConsole(id);
    ide.openCustomTab({
      id: consoleTabId(id), title: src.name, icon: '⛁',
      mount: (host, tab) => consoles.set(id, mountConsole(host, tab, id, text)),
      onClose: () => closeConsole(id),
    });
    rememberConsole(id);
    const c = consoles.get(id);
    c.editor.focus();
    return c;
  }

  function closeConsole(id) {
    const c = consoles.get(id);
    if (!c) return;
    consoles.delete(id);
    c.flush();
    c.dispose();
    // Switching projects closes every tab; those consoles come back with the next project, so only a close made
    // while the project stays open forgets the console. openProject changes ide.root synchronously after closing tabs.
    const root = ide.root;
    queueMicrotask(() => { if (ide.root === root) forgetConsole(id); });
  }

  function mountConsole(host, tab, id, text) {
    const monaco = ide.monaco;
    host.classList.add('db-console');
    host.dataset.source = id;
    const bar = el('div', 'db-console-bar');
    const runBtn = el('button', 'db-run');
    runBtn.append(ide.icon('runRun', '▶'));
    runBtn.title = tr('Execute (Ctrl+Enter)');
    const sourceLabel = userEl('span', 'db-console-source');
    const stateEl = el('span', 'db-console-state');
    bar.append(runBtn, sourceLabel, stateEl);
    const editorHost = el('div', 'db-console-editor');
    const splitter = el('div', 'db-console-split');
    const results = el('div', 'db-results');
    const resultBar = el('div', 'db-result-bar');
    const status = el('div', 'db-result-status');
    const copyCsv = el('button', 'db-copy', tr('Copy as CSV'));
    const copyTsv = el('button', 'db-copy', tr('Copy as TSV'));
    copyCsv.disabled = copyTsv.disabled = true;
    resultBar.append(status, copyCsv, copyTsv);
    const output = el('div', 'db-output');
    output.append(el('div', 'db-placeholder muted', tr('Press Ctrl+Enter to run the statement at the caret, or the selection.')));
    results.append(resultBar, output);
    host.append(bar, editorHost, splitter, results);

    const model = monaco.editor.createModel(text, 'sql');
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const editor = ide.createEditor(editorHost, { model, glyphMargin: false, rulers: [], folding: false, lineNumbersMinChars: 3, renderLineHighlight: 'line' });
    const executed = editor.createDecorationsCollection();

    let saveTimer = null;
    const flush = () => { clearTimeout(saveTimer); saveTimer = null; invoke('db:consoleSave', id, model.getValue()); };
    model.onDidChangeContent(() => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 300); });

    splitter.onmousedown = (down) => {
      down.preventDefault();
      const startY = down.clientY;
      const startH = editorHost.offsetHeight;
      const total = host.clientHeight - bar.offsetHeight - splitter.offsetHeight;
      const move = (e) => { editorHost.style.flex = `0 0 ${Math.max(60, Math.min(total - 60, startH + e.clientY - startY))}px`; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    };

    let last = null;
    const c = {
      id, tab, editor, model, host, flush,
      runs: 0, // completed runs, so callers can wait for the next result
      dispose() { editor.dispose(); model.dispose(); },
      renderState() {
        const src = sourceOf(id);
        sourceLabel.textContent = src ? `${src.name} · ${driverOf(src.kind)?.label || src.kind}` : '';
        stateEl.className = `db-console-state db-state-${src?.state || 'disconnected'}`;
        stateEl.textContent = stateLabel(src?.state || 'disconnected');
        stateEl.title = src?.state === 'error' ? src.message : '';
      },
      // Runs each statement in order and shows the last result; an error stops the run.
      async execute(statements) {
        if (!statements.length) return;
        runBtn.disabled = true;
        status.textContent = tr('Running…');
        let r = null;
        let done = 0;
        for (const sql of statements) {
          r = await ide.database.query(id, sql, { maxRows: MAX_ROWS });
          if (!r.ok) break;
          done++;
          if (/^(CREATE|DROP|ALTER|RENAME)$/.test(r.command)) refreshSchema(id);
        }
        runBtn.disabled = false;
        last = r;
        showResult(r, done, statements.length);
        c.runs++;
        return r;
      },
      runAtCaret() {
        const sel = editor.getSelection();
        let part;
        if (sel && !sel.isEmpty()) {
          const base = model.getOffsetAt(sel.getStartPosition());
          part = { from: base, to: model.getOffsetAt(sel.getEndPosition()), text: model.getValueInRange(sel) };
        } else part = statementAt(model.getValue(), model.getOffsetAt(editor.getPosition()));
        if (!part) return null;
        const range = monaco.Range.fromPositions(model.getPositionAt(part.from), model.getPositionAt(part.to));
        executed.set([{ range, options: { className: 'db-executed' } }]);
        setTimeout(() => executed.clear(), 700);
        return c.execute(runnable(part.text).map((s) => s.text));
      },
      // Appends a statement on its own line and runs it (Open Data).
      appendAndRun(sql) {
        const lines = model.getLineCount();
        const lastLine = model.getLineContent(lines);
        const prefix = lastLine.trim() ? '\n' : '';
        const at = { lineNumber: lines, column: lastLine.length + 1 };
        editor.executeEdits('database', [{ range: monaco.Range.fromPositions(at, at), text: `${prefix}${sql}` }]);
        const end = model.getLineCount();
        editor.setPosition({ lineNumber: end, column: 1 });
        editor.revealLine(end);
        return c.execute([sql.replace(/;\s*$/, '')]);
      },
      insert(sql) {
        const lines = model.getLineCount();
        const lastLine = model.getLineContent(lines);
        const at = { lineNumber: lines, column: lastLine.length + 1 };
        editor.executeEdits('database', [{ range: monaco.Range.fromPositions(at, at), text: `${lastLine.trim() ? '\n' : ''}${sql}` }]);
        editor.setPosition({ lineNumber: model.getLineCount(), column: 1 });
        editor.focus();
      },
    };

    function showResult(r, done, total) {
      output.replaceChildren();
      copyCsv.disabled = copyTsv.disabled = !(r?.ok && r.columns.length);
      const parts = [];
      if (total > 1) parts.push(tr('{done} of {total} statements executed', { done, total }));
      if (!r.ok) {
        status.textContent = parts.join(' · ');
        const err = el('div', 'db-error');
        err.append(el('span', 'db-error-label', tr('Error')), userEl('span', 'db-error-text', r.missingDriver ? tr('Driver files are missing. Download them in the data source settings.') : r.error));
        output.append(err);
        return;
      }
      if (r.columns.length) {
        parts.push(tr('{n} rows', { n: r.rowCount }));
        if (r.truncated) parts.push(tr('showing the first {n}', { n: r.rowCount }));
      } else if (r.rowCount !== null && r.rowCount !== undefined) parts.push(tr('{n} rows affected', { n: r.rowCount }));
      else parts.push(tr('Statement executed'));
      parts.push(`${r.ms} ms`);
      status.textContent = parts.join(' · ');
      if (r.columns.length) output.append(grid(r));
      else output.append(el('div', 'db-message', parts[parts.length - 2]));
    }

    function grid(r) {
      const wrap = el('div', 'db-grid-wrap');
      const table = el('table', 'db-grid');
      const head = el('tr');
      head.append(el('th', 'db-rownum', ''));
      for (const col of r.columns) {
        const th = userEl('th', null, col.name);
        if (col.type) th.append(userEl('span', 'db-coltype', col.type.toLowerCase()));
        head.append(th);
      }
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      r.rows.forEach((row, i) => {
        const line = el('tr');
        line.append(el('td', 'db-rownum', String(i + 1)));
        for (const v of row) {
          const td = el('td', v === null ? 'db-null' : typeof v === 'number' ? 'db-num' : null, v === null ? 'NULL' : String(v));
          if (v !== null) { user(td); if (String(v).length > 60) td.title = String(v); }
          line.append(td);
        }
        tbody.append(line);
      });
      table.append(thead, tbody);
      wrap.append(table);
      return wrap;
    }

    const delimited = (sep) => {
      const cell = (v) => {
        if (v === null) return '';
        const s = String(v);
        if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ');
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return [last.columns.map((col) => cell(col.name)), ...last.rows.map((row) => row.map(cell))].map((r) => r.join(sep)).join('\r\n');
    };
    copyCsv.onclick = () => last?.ok && invoke('clipboard:writeText', delimited(','));
    copyTsv.onclick = () => last?.ok && invoke('clipboard:writeText', delimited('\t'));
    runBtn.onclick = () => c.runAtCaret();
    c.renderState();
    return c;
  }

  const focusedConsole = () => [...consoles.values()].find((c) => c.editor.hasTextFocus()) || null;
  const activeConsole = () => [...consoles.values()].find((c) => ide.activeTab() === c.tab) || null;

  async function openData(id, schema, table) {
    const src = sourceOf(id);
    const c = await openConsole(id);
    return c?.appendAndRun(`SELECT * FROM ${qualifiedName(src, schema, table)} LIMIT 200;`);
  }

  async function generateSelect(id, schema, table) {
    const src = sourceOf(id);
    const d = driverOf(src.kind);
    const cols = table.columns.map((col) => `${d.quote}${col.name.split(d.quote).join(d.quote + d.quote)}${d.quote}`).join(', ');
    const c = await openConsole(id);
    c?.insert(`SELECT ${cols || '*'}\nFROM ${qualifiedName(src, schema, table.name)};`);
  }

  async function pickSource(placeholder) {
    await loaded;
    if (sources.length <= 1) return sources[0] || null;
    return ide.ui.pick({ placeholder, items: sources.map((s) => ({ label: s.name, detail: driverOf(s.kind)?.label, icon: '⛁', value: s })) });
  }

  async function openQueryConsole() {
    const s = selectedSource() || await pickSource(tr('Choose a data source'));
    if (s) return openConsole(s.id);
    if (!sources.length) { tw.show(); showAddMenu(document.querySelector('#dbAdd')); }
    return null;
  }

  // ---------- SQLite files in the project ----------
  async function sourceForFile(file) {
    await loaded;
    const found = sources.find((s) => s.kind === 'sqlite' && samePath(s.file, file));
    if (found) return { source: found, added: false };
    const saved = await invoke('db:save', { kind: 'sqlite', name: basename(file), file });
    await reloadSources();
    return { source: sourceOf(saved.id), added: true };
  }

  ide.registerFileViewer({
    id: 'database', icon: '⛁', match: (p) => SQLITE_FILE.test(p),
    mount(host, { path }) {
      host.classList.add('db-file-view');
      host.append(userEl('div', 'db-file-title', basename(path)), userEl('div', 'db-file-path muted', path));
      const info = el('div', 'db-file-info');
      host.append(info);
      let disposed = false;
      (async () => {
        if (!(await invoke('db:isSqlite', path))) {
          info.append(el('div', null, tr('This file is not a SQLite database.')));
          const open = el('button', 'secondary', tr('Open with Default App'));
          open.onclick = () => invoke('shell:openPath', path);
          info.append(open);
          return;
        }
        const { source, added } = await sourceForFile(path);
        if (disposed) return;
        info.append(el('div', 'db-file-note', added ? tr('Added as a data source.') : tr('This file is a data source.')));
        const buttons = el('div', 'db-file-buttons');
        const consoleBtn = el('button', 'primary', tr('Open Query Console'));
        consoleBtn.onclick = () => openConsole(source.id);
        const showBtn = el('button', 'secondary', tr('Show in Database Tool Window'));
        showBtn.onclick = () => { selectedKey = nodeKey(source.id); expanded.add(selectedKey); tw.show(); renderTree(); };
        buttons.append(consoleBtn, showBtn);
        info.append(buttons);
        const r = await invoke('db:schema', source.id);
        if (disposed) return;
        const list = el('div', 'db-file-tables');
        if (r.ok) {
          const tables = r.schemas.flatMap((s) => s.children.map((t) => ({ schema: s.name, t })));
          list.append(el('div', 'db-file-heading', tr('Tables ({n})', { n: tables.length })));
          for (const { schema, t } of tables) {
            const row = el('div', 'db-file-table');
            row.append(el('span', 'db-icon', ICONS[t.kind]), userEl('span', null, t.name), userEl('span', 'muted', t.columns.map((c) => c.name).join(', ')));
            row.ondblclick = () => openData(source.id, schema, t.name);
            row.title = tr('Double-click to open the data');
            list.append(row);
          }
        }
        info.append(list);
        setTimeout(() => !disposed && openConsole(source.id));
      })();
      return { dispose: () => { disposed = true; } };
    },
  });

  ide.registerTreeAction({
    title: tr('Add as Data Source'),
    when: (entry) => !entry.dir && SQLITE_FILE.test(entry.name),
    run: async (entry) => {
      if (!(await invoke('db:isSqlite', entry.path))) return;
      const { source } = await sourceForFile(entry.path);
      selectedKey = nodeKey(source.id);
      tw.show();
      renderTree();
      openConsole(source.id);
    },
  });

  // ---------- actions ----------
  ide.registerAction({ id: 'Database.NewDataSource', title: tr('Database: New Data Source…'), run: () => { tw.show(); showAddMenu(document.querySelector('#dbAdd')); } });
  ide.registerAction({ id: 'Database.OpenConsole', title: tr('Database: Open Query Console'), run: openQueryConsole });
  ide.registerAction({
    id: 'Database.RunStatement', title: tr('Database: Execute Statement'), keys: 'Ctrl+Enter',
    when: () => !!focusedConsole(),
    run: () => (focusedConsole() || activeConsole())?.runAtCaret(),
  });

  // Consoles open when the IDE closed come back with the project.
  ide.on('projectOpened', async () => {
    await loaded;
    for (const id of openIds()) {
      if (sourceOf(id)) await openConsole(id);
      else forgetConsole(id);
    }
  });

  // ---------- installables (for the Install Manager plugin) ----------
  // One per npm driver package, named after the kinds that use it (first kind's key in the id: db-driver-postgres).
  ide.installables ||= [];
  loaded.then(() => {
    const byPackage = new Map();
    for (const d of drivers) if (d.package) byPackage.set(d.package, [...(byPackage.get(d.package) || []), d]);
    for (const [pkg, kinds] of byPackage) {
      const names = kinds.map((k) => k.label).join(', ');
      const it = { pkg, id: `db-driver-${kinds[0].kind}`, name: tr('{names} driver ({package})', { names, package: pkg }), description: tr('Lets the Database tool window connect to {names}.', { names }) };
      ide.installables.push({
        id: it.id, category: 'drivers', name: it.name, description: it.description,
        status: async () => {
          const d = (await invoke('db:drivers')).find((x) => x.package === it.pkg);
          return { installed: !!d?.installed, version: d?.version || undefined };
        },
        install: async (log) => {
          const r = await installDriver(it.pkg, log);
          if (!r.ok) throw new Error(r.error);
          return r;
        },
      });
    }
    ide.emit('installablesChanged');
  });

  // ---------- public API ----------
  ide.database = {
    async addDataSource(cfg) {
      const saved = await invoke('db:save', cfg);
      await reloadSources();
      return saved.id;
    },
    list: () => sources.map((s) => ({ ...s })),
    query: (id, sql, opts) => invoke('db:query', id, sql, opts),
    openConsole,
    activeConsole,
    drivers: () => invoke('db:drivers'),
    splitStatements,
    statementAt,
    toolWindow: tw,
  };
})();
