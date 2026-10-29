// Database: PyCharm-style data sources, a schema tree, and SQL query consoles. Connections, drivers and passwords
// live in the main process (main/features/database.js); this side only sees public records and query results.
(() => {
  const { el, basename, samePath } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(ch, ...args);
  const user = (node) => { node.dataset.userText = ''; return node; };
  const userEl = (tag, cls, text) => user(el(tag, cls, text));
  const SQLITE_FILE = /\.(sqlite3?|db)$/i;
  const MAX_ROWS = 500;
  // A cell value: null, a number, {$number: 'exact text'} (a number JS would print differently: SQLite REAL 2.0,
  // integers past 2^53), or text. The grid, Copy as CSV/TSV and Export Data all show a number by its database text.
  const isNumber = (v) => typeof v === 'number' || typeof v?.$number === 'string';
  const cellText = (v) => (v === null ? 'NULL' : typeof v?.$number === 'string' ? v.$number : String(v));

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
    for (const id of [...schemas.keys()]) if (!sourceOf(id)) { schemas.delete(id); forgetLazy(id); }
    renderTree();
    ide.emit('dataSourcesChanged');
  }

  ide.api.on('db:state', ({ id, state, message }) => {
    const s = sourceOf(id);
    if (s) Object.assign(s, { state, message });
    // Expanding a source connects, so a disconnected source folds up instead of reconnecting on the next render.
    if (state === 'disconnected') { schemas.delete(id); forgetLazy(id); expanded.delete(nodeKey(id)); }
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

  // ---------- kind ui ----------
  // A kind's `ui` (main/db/kinds/*.js) shapes its console and tree: language ('sql', 'mongosh' or 'plaintext'),
  // statementSeparator (see splitStatements), and openData, templates of the Open Data command per tree node kind
  // ({qualified} is the quoted schema.table, {schema} and {name} the raw names). Tree nodes may also carry their own
  // `open` command, which wins. SQL kinds need no ui: these defaults are SQL.
  const SQL_OPEN = 'SELECT * FROM {qualified} LIMIT 200;';
  const uiOf = (kind) => {
    const ui = driverOf(kind)?.ui || {};
    const language = ui.language || 'sql';
    return { language, statementSeparator: ui.statementSeparator || 'semicolon', openData: ui.openData || (language === 'sql' ? { table: SQL_OPEN, view: SQL_OPEN } : {}) };
  };

  // ---------- statements ----------
  // How a console splits its text, by the kind's ui.statementSeparator:
  //   'semicolon': `;` outside quoted text, comments and Postgres $tag$ bodies (SQL);
  //   'go-line': a line holding only GO (optionally with a count) ends a batch, and `;` stays inside it (T-SQL);
  //   'lines': one command per line (Redis);
  //   'mongo': a top-level shell expression, running across lines until its brackets balance; a line that starts with
  //     `.` or follows one ending in `.` or `,` continues it, and `;` also ends it (MongoDB shell).
  // Each part is {start, end, from, to, text}: [start, end) is its share of the text including the separator, [from, to) the statement itself.
  function splitter(text) {
    const out = [];
    let start = 0;
    return {
      push(stop, end) {
        const raw = text.slice(start, stop);
        const lead = raw.length - raw.trimStart().length;
        const body = raw.trim();
        out.push({ start, end, from: start + lead, to: start + lead + body.length, text: body });
        start = end;
      },
      finish() { if (start < text.length || !out.length) this.push(text.length, text.length); return out; },
    };
  }

  // Skips a quoted string, comment or $tag$ body starting at i in SQL text; returns the index after it, or -1.
  // brackets: T-SQL [names]; qQuotes: Oracle q'[...]' literals.
  const Q_CLOSE = { '[': ']', '{': '}', '(': ')', '<': '>' };
  function skipSql(text, i, { brackets = false, qQuotes = false } = {}) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (two === '--') { const e = text.indexOf('\n', i); return e < 0 ? text.length : e; }
    if (two === '/*') { const e = text.indexOf('*/', i + 2); return e < 0 ? text.length : e + 2; }
    const q = qQuotes && !/\w/.test(text[i - 1] || '') && text.slice(i, i + 4).match(/^[nN]?[qQ]'(.)/);
    if (q) {
      const e = text.indexOf(`${Q_CLOSE[q[1]] || q[1]}'`, i + q[0].length);
      return e < 0 ? text.length : e + 2;
    }
    const close = ch === '[' && brackets ? ']' : (ch === "'" || ch === '"' || ch === '`') ? ch : null;
    if (close) {
      let j = i + 1;
      while (j < text.length && !(text[j] === close && text[j + 1] !== close)) j += text[j] === close ? 2 : 1;
      return j + 1;
    }
    const dollar = ch === '$' && text.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
    if (dollar) { const e = text.indexOf(dollar[0], i + dollar[0].length); return e < 0 ? text.length : e + dollar[0].length; }
    return -1;
  }

  const SPLITTERS = {
    semicolon(text) {
      const s = splitter(text);
      for (let i = 0; i < text.length;) {
        const skip = skipSql(text, i);
        if (skip >= 0) { i = skip; continue; }
        if (text[i] === ';') s.push(i, i + 1);
        i++;
      }
      return s.finish();
    },
    'go-line'(text) {
      const s = splitter(text);
      const GO = /^[ \t]*go(?:[ \t]+\d+)?[ \t]*(?:\r?\n|$)/i;
      for (let i = 0; i < text.length;) {
        if (i === 0 || text[i - 1] === '\n') {
          const eol = text.indexOf('\n', i);
          const m = text.slice(i, eol < 0 ? text.length : eol + 1).match(GO);
          if (m) { s.push(i, i + m[0].length); i += m[0].length; continue; }
        }
        const skip = skipSql(text, i, { brackets: true });
        i = skip >= 0 ? skip : i + 1;
      }
      return s.finish();
    },
    // SQL*Plus rules: `;` ends a SQL statement, while a PL/SQL unit keeps its inner `;` and ends at a line holding only `/`.
    plsql(text) {
      const s = splitter(text);
      const UNIT = /^(?:DECLARE|BEGIN|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY))\b/i;
      const SLASH = /^[ \t]*\/[ \t]*(?:\r?\n|$)/;
      let unit = null; // whether the current statement is a PL/SQL unit, decided at its first token
      for (let i = 0; i < text.length;) {
        if (i === 0 || text[i - 1] === '\n') {
          const eol = text.indexOf('\n', i);
          const m = text.slice(i, eol < 0 ? text.length : eol + 1).match(SLASH);
          if (m) { s.push(i, i + m[0].length); unit = null; i += m[0].length; continue; }
        }
        if (/\s/.test(text[i]) || text.startsWith('--', i) || text.startsWith('/*', i)) { i = Math.max(i + 1, skipSql(text, i)); continue; }
        if (unit === null) unit = UNIT.test(text.slice(i, i + 120));
        const skip = skipSql(text, i, { qQuotes: true });
        if (skip >= 0) { i = skip; continue; }
        if (text[i] === ';' && !unit) { s.push(i, i + 1); unit = null; }
        i++;
      }
      return s.finish();
    },
    lines(text) {
      const s = splitter(text);
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) s.push(i, i + 1);
      return s.finish();
    },
    mongo(text) {
      const s = splitter(text);
      let depth = 0;
      let last = ''; // the last significant character, for telling a regex literal from a division
      for (let i = 0; i < text.length;) {
        const ch = text[i];
        const two = text.slice(i, i + 2);
        if (two === '//') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
        if (two === '/*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
        if (ch === "'" || ch === '"' || ch === '`' || (ch === '/' && (!last || '(,:[{;=!&|?'.includes(last)))) {
          let j = i + 1;
          let inClass = false;
          while (j < text.length && (text[j] !== ch || inClass) && (ch === '`' || text[j] !== '\n')) {
            if (text[j] === '\\') j++;
            else if (ch === '/' && text[j] === '[') inClass = true;
            else if (ch === '/' && text[j] === ']') inClass = false;
            j++;
          }
          i = j + 1;
          last = 'x';
          continue;
        }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
        if (depth === 0 && ch === ';') { s.push(i, i + 1); last = ''; i++; continue; }
        if (depth === 0 && ch === '\n') {
          const next = text.slice(i + 1).match(/^\s*(.)/)?.[1];
          if (last && last !== '.' && last !== ',' && next !== '.') { s.push(i, i + 1); last = ''; i++; continue; }
        }
        if (!/\s/.test(ch)) last = ch;
        i++;
      }
      return s.finish();
    },
  };
  const COMMENTS = { semicolon: /--[^\n]*|\/\*[\s\S]*?\*\//g, 'go-line': /--[^\n]*|\/\*[\s\S]*?\*\//g, plsql: /--[^\n]*|\/\*[\s\S]*?\*\//g, lines: /^\s*#.*$/gm, mongo: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g };
  const splitStatements = (text, mode = 'semicolon') => (SPLITTERS[mode] || SPLITTERS.semicolon)(text);
  const isBlank = (stmt, mode = 'semicolon') => !stmt.replace(COMMENTS[mode] || COMMENTS.semicolon, '').trim();
  const runnable = (text, mode) => splitStatements(text, mode).filter((s) => !isBlank(s.text, mode));

  // The statement the caret is in; in the blank space after the last statement, the one before it.
  function statementAt(text, offset, mode) {
    const parts = splitStatements(text, mode);
    const i = parts.findIndex((p) => offset >= p.start && offset <= p.end);
    const at = i < 0 ? parts.length - 1 : i;
    for (let k = at; k >= 0; k--) if (!isBlank(parts[k].text, mode)) return parts[k];
    return parts.slice(at).find((p) => !isBlank(p.text, mode)) || null;
  }

  function qualifiedName(src, schema, table) {
    const d = driverOf(src.kind);
    const q = (name) => `${d.quote}${name.split(d.quote).join(d.quote + d.quote)}${d.quote}`;
    return schema === null || d.implicitSchemas.includes(schema) ? q(table) : `${q(schema)}.${q(table)}`;
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
      addNodes(add, s, sch.schemas, 1, []);
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
    shownRows = rows;
    for (const r of rows) treeEl.append(treeRow(r));
  }
  let shownRows = [];

  // The tree below a source is what the kind's schema() returns: nodes {name, kind, detail?, children?, lazy?, open?,
  // emptyText?} (schemas/tables, databases/collections/fields, databases/key groups/keys). SQL tables list `columns`
  // instead of children; a lazy node's children come from db:children when it is first expanded.
  const childNodes = (n) => n.children || n.columns?.map((c) => ({ name: c.name, kind: 'column', pk: c.pk, detail: `${c.type || ''}${c.nullable ? '' : ' NOT NULL'}`.trim() })) || null;
  const lazy = new Map(); // nodeKey -> {loading} | {nodes} | {error}

  function addNodes(add, s, nodes, depth, path) {
    for (const n of nodes) {
      if (n.kind === 'info') { add(depth, { kind: 'info', label: tr(n.label, n.args) }); continue; }
      const p = [...path, n.name];
      const key = nodeKey(s.id, ...p);
      let items = childNodes(n);
      const leaf = !n.lazy && !items;
      const open = !leaf && expanded.has(key);
      add(depth, { key, kind: n.kind, source: s, node: n, path: p, label: n.name, detail: n.detail, open, leaf });
      if (!open) continue;
      if (n.lazy) {
        const st = lazy.get(key);
        if (!st) loadChildren(s.id, key, p);
        if (!st || st.loading) { add(depth + 1, { kind: 'info', label: tr('Loading…') }); continue; }
        if (st.error) { add(depth + 1, { kind: 'error', label: st.error }); continue; }
        items = st.nodes;
      }
      if (!items.length) {
        if (n.emptyText || n.kind === 'schema') add(depth + 1, { kind: 'info', label: n.emptyText ? tr(n.emptyText) : tr('No tables') });
        continue;
      }
      addNodes(add, s, items, depth + 1, p);
    }
  }

  function loadChildren(id, key, path) {
    if (lazy.get(key)?.loading) return lazy.get(key).promise;
    const entry = { loading: true };
    entry.promise = (async () => {
      const r = await invoke('db:children', id, path);
      if (lazy.get(key) !== entry) return;
      lazy.set(key, r.ok ? { nodes: r.nodes } : { error: r.error });
      renderTree();
    })();
    lazy.set(key, entry);
    return entry.promise;
  }

  const forgetLazy = (id) => { for (const k of [...lazy.keys()]) if (JSON.parse(k)[0] === id) lazy.delete(k); };

  const ICONS = { source: '⛁', schema: '▤', database: '▤', table: '▦', collection: '▦', view: '◫', column: '▫', field: '▫', group: '▣', key: '⚿', info: '', error: '' };

  // The command Open Data appends to the console for a tree row, or null when the row has no data to open.
  function openCommand(r) {
    if (r.node?.open) return r.node.open;
    const template = uiOf(r.source.kind).openData[r.kind];
    if (!template) return null;
    const name = r.path[r.path.length - 1];
    const schema = r.path.length > 1 ? r.path[r.path.length - 2] : null;
    const vars = { qualified: () => qualifiedName(r.source, schema, name), schema: () => schema ?? '', name: () => name };
    return template.replace(/\{(qualified|schema|name)\}/g, (_m, k) => vars[k]());
  }

  function treeRow(r) {
    const row = el('div', `db-node db-${r.kind}` + (r.key && r.key === selectedKey ? ' selected' : ''));
    row.style.paddingLeft = `${r.depth * 16 + 4}px`;
    row.dataset.depth = r.depth;
    if (r.key) row.dataset.key = r.key;
    row.dataset.kind = r.kind;
    row.append(el('span', 'db-arrow', r.leaf === false ? (r.open ? '▾' : '▸') : ''));
    const icon = el('span', 'db-icon', r.node?.pk ? '🔑' : ICONS[r.kind] ?? '▫');
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
    row.ondblclick = () => { const cmd = r.kind !== 'source' && openCommand(r); if (cmd) openData(r.source.id, cmd); };
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
    if (r.kind !== 'source') {
      const cmd = openCommand(r);
      return [
        ...(cmd ? [{ label: tr('Open Data'), run: () => openData(s.id, cmd) }] : []),
        ...(r.node.columns && uiOf(s.kind).language === 'sql' ? [{ label: tr('Generate SELECT'), run: () => generateSelect(s.id, r.path, r.node) }] : []),
        ...(exportableNode(r) ? [{ label: tr('Export Data…'), run: () => exportTable(s.id, r.path, r.node) }] : []),
        { label: tr('Copy Name'), run: () => invoke('clipboard:writeText', r.node.name) },
        ...(r.leaf ? [] : common),
      ];
    }
    return [
      { label: tr('New Query Console'), run: () => openConsole(s.id) },
      ...common,
      { separator: true },
      { label: tr('Edit Data Source…'), run: () => editDataSource(s) },
      { label: tr('Remove Data Source'), run: () => removeDataSource(s) },
    ];
  }

  // Loads a source's tree once; callers (the tree, console completions) share a running load.
  function loadSchema(id) {
    if (schemas.get(id)?.loading) return schemas.get(id).promise;
    const entry = { loading: true };
    entry.promise = (async () => {
      const r = await invoke('db:schema', id);
      if (!sourceOf(id) || schemas.get(id) !== entry) return;
      schemas.set(id, r.ok ? { schemas: r.schemas } : { error: r.error, missingDriver: r.missingDriver });
      // A single schema (SQLite's main) opens by itself so the tables are one click away.
      if (r.ok && r.schemas.length === 1) expanded.add(nodeKey(id, r.schemas[0].name));
      renderTree();
    })();
    schemas.set(id, entry);
    return entry.promise;
  }

  function refreshSchema(id) {
    schemas.delete(id);
    forgetLazy(id);
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
      // Up/Down select, Right/Left open and close a node, Enter opens a node or a leaf's data (its double-click).
      ide.ui.listKeys(treeEl, {
        rows: '.db-node[data-key]',
        select: (row) => { selectedKey = row.dataset.key; renderTree(); },
        expanded: (row) => ({ '▾': true, '▸': false })[row.querySelector('.db-arrow').textContent] ?? null,
        open: (row) => (row.querySelector('.db-arrow').textContent ? row.click() : row.ondblclick()),
      });
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
    const descHost = el('div', 'db-kind-description muted');
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
    body.append(field(tr('Name'), nameInput), field(tr('Driver'), kindSelect), descHost, fieldsHost, driverHost, testRow);

    const inputs = {};
    function renderFields() {
      fieldsHost.replaceChildren();
      const d = driverOf(kind);
      const labels = FIELD_LABELS();
      descHost.textContent = d.ui?.description ? tr(d.ui.description) : '';
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
      // ui.fileOptional names a checkbox (DuckDB's in-memory) that makes the file field unnecessary while checked.
      const optional = d.ui?.fileOptional && inputs[d.ui.fileOptional];
      const fileSpec = d.fields.find((x) => x.type === 'file');
      if (optional && fileSpec) {
        const sync = () => { inputs[fileSpec.key].disabled = optional.checked; fieldsHost.querySelector('#dbBrowse')?.toggleAttribute('disabled', optional.checked); };
        optional.addEventListener('change', sync);
        sync();
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
          const dk = driverOf(kind);
          if (dk.fields.some((x) => x.type === 'file') && !cfg.file && !(dk.ui?.fileOptional && cfg[dk.ui.fileOptional])) { testResult.className = 'db-test-result err'; testResult.textContent = tr('Choose a database file.'); return false; }
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
          ide.database.sqlFiles?.sourceRemoved(s.id);
          if (selectedKey && JSON.parse(selectedKey)[0] === s.id) selectedKey = null;
          await reloadSources();
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // ---------- console languages ----------
  // 'mongosh' is Monaco's JavaScript grammar plus the shell's show/use, without the TypeScript worker's diagnostics
  // (which would flag `show dbs`). Console completions live in completion.js.
  let mongosh = null;
  function registerMongosh() {
    if (mongosh) return mongosh;
    const monaco = ide.monaco;
    monaco.languages.register({ id: 'mongosh', aliases: ['MongoDB Shell'] });
    mongosh = (async () => {
      const js = monaco.languages.getLanguages().find((l) => l.id === 'javascript');
      const mod = js?.loader ? await js.loader() : null;
      if (!mod?.language) return;
      const language = structuredClone(mod.language);
      language.keywords = [...(language.keywords || []), 'show', 'use'];
      monaco.languages.setMonarchTokensProvider('mongosh', language);
      monaco.languages.setLanguageConfiguration('mongosh', mod.conf);
    })();
    return mongosh;
  }

  function consoleLanguage(kind) {
    const { language } = uiOf(kind);
    if (language === 'mongosh') registerMongosh();
    return language;
  }

  // ---------- results ----------
  // Tagged values in document results ({$oid}, {$date}, ...) as the MongoDB shell prints them.
  const TAGS = {
    $oid: (v) => `ObjectId('${v}')`, $date: (v) => `ISODate('${v}')`, $numberLong: (v) => `NumberLong('${v}')`, $numberDecimal: (v) => `NumberDecimal('${v}')`,
    $numberDouble: (v) => v, $uuid: (v) => `UUID('${v}')`, $timestamp: (v) => `Timestamp(${v.t}, ${v.i})`, $binary: (v) => `BinData(${parseInt(v.subType, 16)}, '${v.base64}')`,
    $minKey: () => 'MinKey()', $maxKey: () => 'MaxKey()', $code: (v) => `Code(${JSON.stringify(v)})`,
  };
  const tagOf = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const keys = Object.keys(v);
    if (keys.length === 1 && TAGS[keys[0]]) return keys[0];
    return keys.length === 2 && typeof v.$regex === 'string' && '$options' in v ? '$regex' : null;
  };
  const literal = (v) => {
    const tag = tagOf(v);
    if (tag === '$regex') return `/${v.$regex}/${v.$options}`;
    if (tag) return TAGS[tag](v[tag]);
    return v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v);
  };
  const isContainer = (v) => v !== null && typeof v === 'object' && !tagOf(v);
  const keyText = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  function preview(v, budget = 160) {
    const arr = Array.isArray(v);
    const pieces = [];
    let used = 0;
    for (const [k, x] of Object.entries(v)) {
      const piece = `${arr ? '' : `${keyText(k)}: `}${isContainer(x) ? (Array.isArray(x) ? `[…${x.length}]` : '{…}') : literal(x)}`;
      if (used + piece.length > budget) { pieces.push('…'); break; }
      pieces.push(piece);
      used += piece.length + 2;
    }
    if (arr) return `[${pieces.join(', ')}]`;
    return pieces.length ? `{ ${pieces.join(', ')} }` : '{}';
  }

  // The document view: one expandable JSON tree per document; children are built when a node first opens.
  function jsonTree(docs) {
    const wrap = el('div', 'db-json');
    docs.forEach((d, i) => wrap.append(jsonNode(`(${i + 1})`, d, 0, docs.length === 1)));
    return wrap;
  }
  function jsonNode(label, v, depth, open = false) {
    const node = el('div', 'db-json-node');
    const line = el('div', 'db-json-line');
    line.style.paddingLeft = `${depth * 16 + 4}px`;
    const container = isContainer(v);
    const arrow = el('span', 'db-arrow', container ? '▸' : '');
    line.append(arrow, userEl('span', depth ? 'db-json-key' : 'db-json-index', label));
    if (container) line.append(userEl('span', 'db-json-summary', preview(v)));
    else {
      const cls = tagOf(v) ? 'tagged' : v === null ? 'null' : typeof v;
      line.append(userEl('span', `db-json-value db-json-${cls}`, literal(v)));
    }
    node.append(line);
    if (container) {
      let kids = null;
      const toggle = () => {
        if (!kids) {
          kids = el('div', 'db-json-children');
          for (const [k, x] of Object.entries(v)) kids.append(jsonNode(Array.isArray(v) ? `[${k}]` : k, x, depth + 1));
          node.append(kids);
        } else kids.classList.toggle('hidden');
        const shown = !kids.classList.contains('hidden');
        arrow.textContent = shown ? '▾' : '▸';
        node.classList.toggle('open', shown);
      };
      line.onclick = toggle;
      if (open) toggle();
    }
    return node;
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
        const text = cellText(v);
        const td = el('td', v === null ? 'db-null' : isNumber(v) ? 'db-num' : null, text);
        if (v !== null) { user(td); if (text.length > 60) td.title = text; }
        line.append(td);
      }
      tbody.append(line);
    });
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  // ---------- query console ----------
  const OPEN_KEY = 'database.openConsoles';
  const openIds = () => ide.settings.get(OPEN_KEY, []);
  const rememberConsole = (id) => { if (!openIds().includes(id)) ide.settings.set(OPEN_KEY, [...openIds(), id]); };
  const forgetConsole = (id) => { if (openIds().includes(id)) ide.settings.set(OPEN_KEY, openIds().filter((x) => x !== id)); };
  const consoleTabId = (id) => `db-console:${id}`;
  const VIEW_KEY = 'database.resultView';

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

  // The part of an editor's text Execute runs: the selection, else the statement at the caret ({from, to, text} or null).
  function partToRun(editor, mode) {
    const model = editor.getModel();
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) {
      const base = model.getOffsetAt(sel.getStartPosition());
      return { from: base, to: model.getOffsetAt(sel.getEndPosition()), text: model.getValueInRange(sel) };
    }
    return statementAt(model.getValue(), model.getOffsetAt(editor.getPosition()), mode);
  }
  // Briefly marks the text that runs.
  function flashRange(editor, from, to) {
    const model = editor.getModel();
    const marks = editor.createDecorationsCollection([{ range: ide.monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to)), options: { className: 'db-executed' } }]);
    setTimeout(() => marks.clear(), 700);
  }

  // ---------- result view ----------
  // The result bar (status, Grid/JSON switch, Copy as CSV/TSV, Export Data…) over the grid, JSON tree or message of the
  // last run, and the run itself. A query console has one; so has each project SQL file with an attached data source
  // (sql-files.js). sourceId() is the source the statements run on; onBusy(running) follows a run.
  function resultView(sourceId, { onBusy = () => {} } = {}) {
    const results = el('div', 'db-results');
    const resultBar = el('div', 'db-result-bar');
    const status = el('div', 'db-result-status');
    // Document results (MongoDB) switch between the grid of top-level fields and a JSON tree per document.
    const viewSwitch = el('div', 'db-view-switch hidden');
    const viewButtons = ['grid', 'json'].map((v) => {
      const b = el('button', 'db-view-btn', v === 'grid' ? tr('Grid') : 'JSON');
      b.dataset.view = v;
      b.onclick = () => { ide.settings.set(VIEW_KEY, v); if (last?.ok) showResult(last, lastDone, lastTotal); };
      return b;
    });
    viewSwitch.append(...viewButtons);
    const copyCsv = el('button', 'db-copy', tr('Copy as CSV'));
    const copyTsv = el('button', 'db-copy', tr('Copy as TSV'));
    const exportBtn = el('button', 'db-export', tr('Export Data…'));
    copyCsv.disabled = copyTsv.disabled = exportBtn.disabled = true;
    resultBar.append(status, viewSwitch, copyCsv, copyTsv, exportBtn);
    const output = el('div', 'db-output');
    output.append(ide.keymap.text(el('div', 'db-placeholder muted'),
      () => tr('Use {action} to run the statement at the caret, or the selection.', { action: ide.keymap.withKeys(tr('Execute'), 'Database.RunStatement') })));
    results.append(resultBar, output);

    let last = null;
    let lastDone = 0;
    let lastTotal = 0;
    const c = {
      el: results,
      runs: 0, // completed runs, so callers can wait for the next result
      // Runs each statement in order and shows the last result; an error stops the run. One run at a time: Ctrl+Enter
      // during a run would otherwise interleave two runs' statements and results.
      running: false,
      async execute(statements) {
        const id = sourceId();
        if (!statements.length || c.running || !id) return;
        c.running = true;
        onBusy(true);
        status.textContent = tr('Running…');
        let r = null;
        let done = 0;
        try {
          for (const stmt of statements) {
            r = await ide.database.query(id, stmt, { maxRows: MAX_ROWS });
            c.lastStatement = stmt;
            c.lastSource = id;
            if (!r.ok) break;
            done++;
            if (r.schemaChanged || /^(CREATE|DROP|ALTER|RENAME)$/.test(r.command)) refreshSchema(id);
          }
        } finally {
          c.running = false;
          onBusy(false);
        }
        showResult(r, done, statements.length);
        c.runs++;
        return r;
      },
      // 'grid' or 'json': how the current result shows (JSON only for document results).
      view: () => (last?.documents ? ide.settings.get(VIEW_KEY, 'grid') : 'grid'),
      lastStatement: null,
      lastSource: null,
      result: () => last,
      // Export Data… for the shown result: a read-only SQL statement runs again and streams every row to the file; for
      // anything else the user chooses between the rows shown and running it again (export.js exportResult).
      exportResult() {
        if (!(last?.ok && last.columns.length)) return null;
        const id = c.lastSource || sourceId();
        const src = sourceOf(id);
        return ide.database.exportResult({ sourceId: id, sql: c.lastStatement || '', language: uiOf(src?.kind).language, result: last, name: src?.name || 'result' });
      },
    };

    // Status line and output for a result: {columns, rows, rowCount, truncated, ms} plus, from some kinds, documents
    // (Grid/JSON views), affected (documents written), message (a reply such as Redis's OK, shown as data) and notice
    // ({text, args}: an English UI message from the kind, translated here).
    function showResult(r, done, total) {
      last = r;
      lastDone = done;
      lastTotal = total;
      output.replaceChildren();
      copyCsv.disabled = copyTsv.disabled = exportBtn.disabled = !(r?.ok && r.columns.length);
      viewSwitch.classList.toggle('hidden', !(r?.ok && r.documents));
      const parts = [];
      if (total > 1) parts.push(tr('{done} of {total} statements executed', { done, total }));
      if (!r.ok) {
        status.textContent = parts.join(' · ');
        const err = el('div', 'db-error');
        err.append(el('span', 'db-error-label', tr('Error')), userEl('span', 'db-error-text', r.missingDriver ? tr('Driver files are missing. Download them in the data source settings.') : r.error));
        output.append(err);
        return;
      }
      const docs = !!r.documents;
      let summary = null;
      if (r.affected !== null && r.affected !== undefined) summary = docs ? tr('{n} documents affected', { n: r.affected }) : tr('{n} rows affected', { n: r.affected });
      else if (r.columns.length) {
        summary = docs ? tr('{n} documents', { n: r.rowCount }) : tr('{n} rows', { n: r.rowCount });
        if (r.truncated) summary += ` · ${tr('showing the first {n}', { n: r.rowCount })}`;
      } else if (r.rowCount !== null && r.rowCount !== undefined) summary = tr('{n} rows affected', { n: r.rowCount });
      else if (r.notice) summary = tr(r.notice.text, r.notice.args);
      else if (!r.message) summary = tr('Statement executed');
      if (summary) parts.push(summary);
      status.replaceChildren(parts.length ? `${parts.join(' · ')} · ` : '');
      if (r.message && r.columns.length) status.append(userEl('span', 'db-result-message', r.message), ' · ');
      status.append(`${r.ms} ms`);
      for (const b of viewButtons) b.classList.toggle('selected', b.dataset.view === c.view());
      if (r.columns.length) output.append(c.view() === 'json' ? jsonTree(r.documents) : grid(r));
      else if (r.message) output.append(userEl('div', 'db-message db-reply', r.message));
      else output.append(el('div', 'db-message', summary));
    }

    const delimited = (sep) => {
      const cell = (v) => {
        if (v === null) return '';
        const s = cellText(v);
        if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ');
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return [last.columns.map((col) => cell(col.name)), ...last.rows.map((row) => row.map(cell))].map((r) => r.join(sep)).join('\r\n');
    };
    copyCsv.onclick = () => last?.ok && invoke('clipboard:writeText', delimited(','));
    copyTsv.onclick = () => last?.ok && invoke('clipboard:writeText', delimited('\t'));
    exportBtn.onclick = () => c.exportResult();
    output.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.db-grid') || !(last?.ok && last.columns.length)) return;
      e.preventDefault();
      ide.ui.contextMenu(e.clientX, e.clientY, [
        { label: tr('Export Data…'), keyAction: 'Database.ExportData', run: () => c.exportResult() },
        { separator: true },
        { label: tr('Copy as CSV'), run: () => invoke('clipboard:writeText', delimited(',')) },
        { label: tr('Copy as TSV'), run: () => invoke('clipboard:writeText', delimited('\t')) },
      ]);
    });
    return c;
  }

  function mountConsole(host, tab, id, text) {
    const monaco = ide.monaco;
    const mode = () => uiOf(sourceOf(id)?.kind).statementSeparator;
    host.classList.add('db-console');
    host.dataset.source = id;
    const bar = el('div', 'db-console-bar');
    const runBtn = el('button', 'db-run');
    runBtn.append(ide.icon('runRun', '▶'));
    ide.keymap.tooltip(runBtn, tr('Execute'), 'Database.RunStatement');
    const sourceLabel = userEl('span', 'db-console-source');
    const stateEl = el('span', 'db-console-state');
    bar.append(runBtn, sourceLabel, stateEl);
    const editorHost = el('div', 'db-console-editor');
    const splitter = el('div', 'db-console-split');
    const results = resultView(() => id, { onBusy: (busy) => { runBtn.disabled = busy; } });
    host.append(bar, editorHost, splitter, results.el);

    const model = monaco.editor.createModel(text, consoleLanguage(sourceOf(id)?.kind));
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const editor = ide.createEditor(editorHost, { model, glyphMargin: false, rulers: [], folding: false, lineNumbersMinChars: 3, renderLineHighlight: 'line' });

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

    const c = {
      id, tab, editor, model, host, flush, results,
      get runs() { return results.runs; }, // completed runs, so callers can wait for the next result
      get running() { return results.running; },
      get lastStatement() { return results.lastStatement; },
      dispose() { editor.dispose(); model.dispose(); },
      renderState() {
        const src = sourceOf(id);
        sourceLabel.textContent = src ? `${src.name} · ${driverOf(src.kind)?.label || src.kind}` : '';
        stateEl.className = `db-console-state db-state-${src?.state || 'disconnected'}`;
        stateEl.textContent = stateLabel(src?.state || 'disconnected');
        stateEl.title = src?.state === 'error' ? src.message : '';
        const language = src && consoleLanguage(src.kind);
        if (language && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
      },
      execute: (statements) => results.execute(statements),
      runAtCaret() {
        const part = partToRun(editor, mode());
        if (!part) return null;
        flashRange(editor, part.from, part.to);
        return c.execute(runnable(part.text, mode()).map((s) => s.text));
      },
      // Appends command text on its own line(s) and runs every statement in it (Open Data).
      appendAndRun(text) {
        const lines = model.getLineCount();
        const lastLine = model.getLineContent(lines);
        const prefix = lastLine.trim() ? '\n' : '';
        const at = { lineNumber: lines, column: lastLine.length + 1 };
        const from = model.getOffsetAt(at) + prefix.length;
        editor.executeEdits('database', [{ range: monaco.Range.fromPositions(at, at), text: `${prefix}${text}` }]);
        const end = model.getLineCount();
        editor.setPosition({ lineNumber: end, column: 1 });
        editor.revealLine(end);
        flashRange(editor, from, from + text.length);
        return c.execute(runnable(text, mode()).map((s) => s.text));
      },
      insert(text) {
        const lines = model.getLineCount();
        const lastLine = model.getLineContent(lines);
        const at = { lineNumber: lines, column: lastLine.length + 1 };
        editor.executeEdits('database', [{ range: monaco.Range.fromPositions(at, at), text: `${lastLine.trim() ? '\n' : ''}${text}` }]);
        editor.setPosition({ lineNumber: model.getLineCount(), column: 1 });
        editor.focus();
      },
      view: () => results.view(),
      result: () => results.result(),
      exportResult: () => results.exportResult(),
    };
    runBtn.onclick = () => c.runAtCaret();
    c.renderState();
    return c;
  }

  const focusedConsole = () => [...consoles.values()].find((c) => c.editor.hasTextFocus()) || null;
  const activeConsole = () => [...consoles.values()].find((c) => ide.activeTab() === c.tab) || null;

  async function openData(id, command) {
    const c = await openConsole(id);
    return c?.appendAndRun(command);
  }

  // ---------- Export Data ----------
  const exportableNode = (r) => !!r.node?.columns && ['table', 'view'].includes(r.kind) && uiOf(r.source.kind).language === 'sql';
  function exportTable(id, path, table) {
    const schema = path.length > 1 ? path[path.length - 2] : null;
    return ide.database.exportData({ sourceId: id, table: { schema, name: table.name }, name: table.name });
  }

  async function generateSelect(id, path, table) {
    const src = sourceOf(id);
    const d = driverOf(src.kind);
    const cols = table.columns.map((col) => `${d.quote}${col.name.split(d.quote).join(d.quote + d.quote)}${d.quote}`).join(', ');
    const c = await openConsole(id);
    c?.insert(`SELECT ${cols || '*'}\nFROM ${qualifiedName(src, path.length > 1 ? path[path.length - 2] : null, table.name)};`);
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
            row.ondblclick = () => { const cmd = openCommand({ source, kind: t.kind, node: t, path: [schema, t.name] }); if (cmd) openData(source.id, cmd); };
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
  // Export Data… for the active console's result, else for the table or view selected in the tree.
  ide.registerAction({
    id: 'Database.ExportData', title: tr('Database: Export Data…'),
    run: () => {
      const c = activeConsole();
      if (c?.result()?.ok && c.result().columns.length) return c.exportResult();
      const r = selectedKey && shownRows.find((x) => x.key === selectedKey);
      return r && exportableNode(r) ? exportTable(r.source.id, r.path, r.node) : null;
    },
  });
  ide.registerAction({
    id: 'Database.RunStatement', title: tr('Database: Execute Statement'), keys: 'Ctrl+Enter',
    // In a query console, or in a project SQL file (sql-files.js: its attached data source, chosen first if it has none).
    when: () => !!focusedConsole() || !!ide.database.sqlFiles?.focusedEditor(),
    run: () => {
      const c = focusedConsole();
      const ed = !c && ide.database.sqlFiles?.focusedEditor();
      return ed ? ide.database.sqlFiles.runAtCaret(ed) : (c || activeConsole())?.runAtCaret();
    },
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
    cellText,
    isNumber,
    exportTable,
    // For sql-files.js: the console's run and result view, the statement splitter and the source list.
    fileHost: { loaded, sourceOf, driverOf, uiOf, stateLabel, resultView, partToRun, flashRange, runnable, newDataSource: () => ide.runAction('Database.NewDataSource') },
    // exportData(spec) comes from export.js: {sourceId, table: {schema, name}} | {sourceId, sql} | {columns, rows}, plus name.
    // For completion.js: console lookup and the trees the tool window loads (shared cache, refreshed after DDL).
    completionHost: {
      // A console's model, or a project SQL file's with an attached data source ({..., schema}: the file's schema).
      consoleFor(model) {
        const c = [...consoles.values()].find((x) => x.model === model);
        const source = c && sourceOf(c.id);
        if (!source) return ide.database.sqlFiles?.contextFor(model) || null;
        const driver = driverOf(source.kind);
        return { id: c.id, source, driver, ui: uiOf(source.kind), completion: driver?.ui?.completion || null };
      },
      async tree(id) {
        if (!schemas.get(id)?.schemas) await loadSchema(id);
        return schemas.get(id)?.schemas || [];
      },
      // Children of the node at path: its own children/columns, or a lazy node's loaded children.
      async children(id, path) {
        const tree = await this.tree(id);
        let nodes = tree;
        let node = null;
        for (const name of path) {
          node = nodes.find((n) => n.name === name);
          if (!node) return [];
          nodes = childNodes(node) || [];
        }
        if (!node?.lazy) return nodes;
        const key = nodeKey(id, ...path);
        if (!lazy.get(key)?.nodes) await loadChildren(id, key, path);
        return lazy.get(key)?.nodes || [];
      },
      query: (id, text) => invoke('db:query', id, text, { maxRows: 200 }),
      splitStatements,
    },
  };

  const here = document.currentScript.src.replace(/[^/]*$/, '');
  const script = el('script');
  script.src = `${here}completion.js`;
  script.async = false;
  document.body.appendChild(script);
  const sqlFilesScript = el('script');
  sqlFilesScript.src = `${here}sql-files.js`;
  sqlFilesScript.async = false;
  document.body.appendChild(sqlFilesScript);
  const exportScript = el('script');
  exportScript.src = `${here}export.js`;
  exportScript.async = false;
  document.body.appendChild(exportScript);
})();
