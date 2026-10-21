// JetBrains-style HTTP Client for .http and .rest files: highlighting, a ▶ gutter icon and Ctrl+Enter on each
// request, environments, and the HTTP Client tool window with the response and a history. Requests run in the main
// process (main/features/http-client.js), which also resolves {{variables}}, so private environment values stay there.
(() => {
  const { monaco } = ide;
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const LANG = 'http';
  const isHttpPath = (p) => /\.(http|rest)$/i.test(p || '');
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
  const METHOD_RE = METHODS.join('|');
  const userText = (node) => ((node.dataset.userText = ''), node);

  // ---------- parsing ----------
  // Requests are separated by lines starting with ###. Before a request line come comments (# or //), `# @name x`
  // and `@var = value` lines; then the request line (`METHOD URL [HTTP/1.1]`, or a URL alone for GET) with indented
  // `?a=1` / `&b=2` continuation lines, the headers, an empty line and the body.
  const REQUEST_LINE = new RegExp(`^(?:(${METHOD_RE})\\s+)?(\\S+)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`);
  const looksLikeUrl = (s) => /^(https?:\/\/|\{\{|\/)/i.test(s);

  function parse(text) {
    const lines = text.split(/\r?\n/);
    const vars = [];
    const requests = [];
    let i = 0;
    while (i < lines.length) {
      const start = i;
      const title = /^###/.test(lines[i]) ? lines[i++].replace(/^#+/, '').trim() : '';
      let end = i;
      while (end < lines.length && !/^###/.test(lines[end])) end++;
      const req = parseBlock(lines, i, end, vars);
      if (req) requests.push({ ...req, title: title || null, start: start + 1, end });
      i = end;
    }
    return { vars, requests };
  }

  function parseBlock(lines, from, to, vars) {
    let name = null;
    let j = from;
    for (; j < to; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      let m = /^(?:#|\/\/)\s*@name\s*=?\s*(\S+)/.exec(t);
      if (m) { name = m[1]; continue; }
      if (/^(#|\/\/)/.test(t)) continue;
      m = /^@([\w.-]+)\s*=\s*(.*)$/.exec(t);
      if (m) { vars.push({ name: m[1], value: m[2].trim(), line: j + 1 }); continue; }
      break;
    }
    if (j >= to) return null;
    const m = REQUEST_LINE.exec(lines[j].trim());
    if (!m || (!m[1] && !looksLikeUrl(m[2]))) return null;
    const line = j + 1;
    let url = m[2];
    for (j++; j < to && /^\s+[?&]/.test(lines[j]); j++) url += lines[j].trim();
    const headers = [];
    for (; j < to && lines[j].trim(); j++) {
      const t = lines[j].trim();
      if (/^(#|\/\/)/.test(t)) continue;
      const h = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(t);
      if (!h || /^[{["<]/.test(t)) break;
      headers.push([h[1], h[2]]);
    }
    if (j < to && !lines[j].trim()) j++;
    const body = [];
    for (; j < to; j++) {
      const l = lines[j];
      if (/^>\s*\{%/.test(l)) { while (j < to && !lines[j].includes('%}')) j++; continue; }
      if (/^(>>!?|<>)\s/.test(l)) continue;
      body.push(l);
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    return { name, line, method: m[1] || 'GET', url, headers, body: body.length ? body.join('\n') : null };
  }

  // ---------- language ----------
  monaco.languages.register({ id: LANG, extensions: ['.http', '.rest'], aliases: ['HTTP Request', 'http'] });
  monaco.languages.setLanguageConfiguration(LANG, {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
  });
  const VAR = /\{\{[^{}]*\}\}/;
  // JSON with {{variables}}: request bodies, and (as the http-json language) the pretty-printed response bodies.
  const JSON_RULES = [
    [VAR, 'variable'],
    [/"(?=(?:[^"\\]|\\.)*"\s*:)/, 'string.key.json', '@key'],
    [/"/, 'string', '@string'],
    [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
    [/\b(true|false|null)\b/, 'keyword'],
    [/[{}[\],:]/, 'delimiter'],
    [/[^"{}[\],:\d\s-]+|./, ''],
  ];
  const JSON_STATES = {
    key: [
      [/[^"\\]+/, 'string.key.json'],
      [/\\./, 'string.key.json'],
      [/"/, 'string.key.json', '@pop'],
    ],
    string: [
      [VAR, 'variable'],
      [/[^"\\{]+/, 'string'],
      [/\\./, 'string.escape'],
      [/\{/, 'string'],
      [/"/, 'string', '@pop'],
    ],
  };
  monaco.languages.register({ id: 'http-json' });
  monaco.languages.setMonarchTokensProvider('http-json', { defaultToken: '', tokenizer: { root: JSON_RULES, ...JSON_STATES } });
  monaco.languages.setMonarchTokensProvider(LANG, {
    defaultToken: '',
    tokenizer: {
      // Monarch never sees empty lines, so the line after the headers that is not a header starts the body.
      root: [
        [/^###.*$/, 'comment.separator'],
        [/^\s*(#|\/\/)\s*@[\w-]+.*$/, 'tag'],
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^(\s*)(@[\w.-]+)(\s*)(=)/, ['', 'variable', '', 'delimiter']],
        [new RegExp(`^(${METHOD_RE})(?=\\s)`), 'keyword', '@headers'],
        [/^(?=(https?:\/\/|\{\{|\/))/, '', '@headers'],
        [VAR, 'variable'],
        [/[^{]+|\{/, ''],
      ],
      headers: [
        [/^###/, { token: '@rematch', next: '@popall' }],
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)(\s*)(:)/, ['attribute.name', '', 'delimiter']],
        [/^\s+[?&]/, 'delimiter'],
        [/^\S/, { token: '@rematch', next: '@body' }],
        [VAR, 'variable'],
        [/HTTP\/[\d.]+/, 'keyword'],
        [/[^{\s]+|\{|\s+/, ''],
      ],
      body: [
        [/^###/, { token: '@rematch', next: '@popall' }],
        [/^<@?\s.*$/, 'tag'],
        [/^(>>!?|<>)\s.*$/, 'comment'],
        ...JSON_RULES,
      ],
      ...JSON_STATES,
    },
  });
  const applyLanguage = (model) => {
    if (model.uri.scheme === 'file' && isHttpPath(model.uri.fsPath) && model.getLanguageId() !== LANG) monaco.editor.setModelLanguage(model, LANG);
  };
  monaco.editor.getModels().forEach(applyLanguage);
  monaco.editor.onDidCreateModel(applyLanguage);

  // ---------- environments ----------
  const envKey = () => `httpClient.env.${(ide.root || '').toLowerCase()}`;
  const currentEnv = () => ide.settings.get(envKey(), '') || '';
  let envNames = [];
  const envListeners = new Set();
  const activeHttpPath = () => { const t = ide.activeTab(); return t?.kind === 'file' && isHttpPath(t.path) ? t.path : null; };

  async function refreshEnvs(path = activeHttpPath()) {
    if (!ide.root) { envNames = []; } else {
      const r = await ide.api.invoke('http-client:envs', path || joinPath(ide.root, 'requests.http'), ide.root);
      envNames = r?.names || [];
    }
    for (const fn of envListeners) fn();
    return envNames;
  }
  function setEnv(name) {
    ide.settings.set(envKey(), name || '');
    for (const fn of envListeners) fn();
  }
  async function pickEnv() {
    await refreshEnvs();
    const choice = await ide.ui.pick({
      placeholder: tr('Select environment'),
      items: [{ label: tr('No Environment'), value: '' }, ...envNames.map((n) => ({ label: n, userText: true, value: n }))],
    });
    if (choice !== null && choice !== undefined) setEnv(typeof choice === 'string' ? choice : choice.value);
  }

  // ---------- running ----------
  const history = [];
  let selected = null;
  let seq = 0;
  const historySize = () => Math.max(1, Number(ide.settings.get('httpClient.historySize', 50)) || 50);
  // Bodies are kept up to 5 MB of text or 20 MB of image each, so 50 entries could hold a gigabyte. Past this many
  // characters of bodies, older responses keep their status, headers and timing but not their body.
  const HISTORY_BODY_BUDGET = 64 * 1024 * 1024;
  function trimHistoryBodies() {
    let total = 0;
    for (const e of history) {
      const r = e.result?.response;
      if (!r || r.bodyDropped) continue;
      const n = (r.text?.length || 0) + (r.base64?.length || 0);
      if (total && total + n > HISTORY_BODY_BUDGET) {
        delete r.text;
        delete r.base64;
        r.bodyDropped = true;
      } else total += n;
    }
  }

  function requestAt(model, lineNumber) {
    const parsed = parse(model.getValue());
    const req = parsed.requests.find((r) => lineNumber >= r.start && lineNumber <= Math.max(r.end, r.line));
    return req ? { parsed, req } : null;
  }

  async function runRequest(path, model, req, parsed) {
    const fileVars = parsed.vars.filter((v) => v.line < req.line).map((v) => [v.name, v.value]);
    const entry = { id: ++seq, at: new Date(), path, line: req.line, title: req.title || req.name, env: currentEnv(), pending: true,
      request: { method: req.method, url: req.url, headers: req.headers } };
    history.unshift(entry);
    history.splice(historySize());
    selected = entry;
    tw.show();
    render();
    const result = await ide.api.invoke('http-client:send', {
      file: path, root: ide.root, env: entry.env, fileVars,
      request: { method: req.method, url: req.url, headers: req.headers, body: req.body, name: req.name },
      timeoutMs: Number(ide.settings.get('httpClient.timeoutSeconds', 60)) * 1000,
    });
    Object.assign(entry, { pending: false, result, request: result.request || entry.request });
    trimHistoryBodies();
    render();
    ide.emit('httpResponse', entry);
    return entry;
  }

  function runAtLine(ed, lineNumber) {
    const model = ed.getModel();
    const path = model && pathOf(model);
    if (!path) return null;
    const found = requestAt(model, lineNumber);
    if (!found) return null;
    return runRequest(path, model, found.req, found.parsed);
  }

  const pathOf = (model) => (model ? ide.tabs.find((t) => t.model === model)?.path || (model.uri.scheme === 'file' ? model.uri.fsPath : null) : null);
  const isHttpModel = (model) => !!model && model.getLanguageId() === LANG;

  ide.registerAction({
    id: 'HttpClient.RunRequest', title: tr('Run HTTP Request'), keys: 'Ctrl+Enter',
    when: () => !!ide.editor?.hasTextFocus() && isHttpModel(ide.editor.getModel()),
    run: () => runAtLine(ide.editor, ide.editor.getPosition().lineNumber),
  });
  ide.registerAction({ id: 'HttpClient.SelectEnvironment', title: tr('HTTP Client: Select Environment…'), run: pickEnv });
  ide.registerAction({ id: 'HttpClient.ShowHistory', title: tr('HTTP Client: Show Responses'), run: () => tw.show() });

  // ---------- gutter ----------
  const gutters = new Map(); // editor -> {deco, lines: Set, timer}
  function refreshGutter(ed) {
    const g = gutters.get(ed);
    const model = ed.getModel();
    const reqs = isHttpModel(model) ? parse(model.getValue()).requests : [];
    g.lines = new Set(reqs.map((r) => r.line));
    g.deco.set(reqs.map((r) => ({
      range: new monaco.Range(r.line, 1, r.line, 1),
      options: {
        glyphMarginClassName: 'http-run-gutter',
        glyphMarginHoverMessage: { value: ide.keymap.withKeys(tr('Run {method} request', { method: r.method }), 'HttpClient.RunRequest') },
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Left },
      },
    })));
  }
  const iconAt = (e) => e.button === 0 && e.target.closest?.('.http-run-gutter');
  ide.onEditor((ed) => {
    const g = { deco: ed.createDecorationsCollection(), lines: new Set(), timer: null };
    gutters.set(ed, g);
    const dom = ed.getContainerDomNode();
    for (const type of ['pointerdown', 'mousedown']) {
      dom.addEventListener(type, (e) => {
        if (!iconAt(e)) return;
        e.stopPropagation();
        if (type !== 'mousedown') return;
        e.preventDefault();
        const pos = ed.getTargetAtClientPoint(e.clientX, e.clientY)?.position;
        if (pos && g.lines.has(pos.lineNumber)) runAtLine(ed, pos.lineNumber);
      }, true);
    }
    for (const type of ['pointerup', 'mouseup', 'click']) dom.addEventListener(type, (e) => iconAt(e) && e.stopPropagation(), true);
    ed.onDidChangeModel(() => refreshGutter(ed));
    ed.onDidChangeModelLanguage(() => refreshGutter(ed));
    ed.onDidChangeModelContent(() => { clearTimeout(g.timer); g.timer = setTimeout(() => refreshGutter(ed), 250); });
    ed.onDidDispose(() => { clearTimeout(g.timer); gutters.delete(ed); });
    refreshGutter(ed);
  });
  // The gutter hover names Run HTTP Request's current shortcut.
  ide.on('keymapChanged', () => { for (const ed of gutters.keys()) refreshGutter(ed); });

  // ---------- tool window ----------
  let ui = null;
  const tw = ide.registerToolWindow({
    id: 'HttpClient', title: tr('HTTP Client'), icon: '⇅', iconName: 'services', side: 'bottom', order: 68,
    mount(container) {
      container.classList.add('http-tool');
      const bar = el('div', 'http-bar');
      const envLabel = el('span', 'muted', tr('Environment:'));
      const envSelect = el('select', 'http-env');
      envSelect.onchange = () => setEnv(envSelect.value);
      const clear = el('button', 'http-btn', tr('Clear History'));
      clear.onclick = () => { history.length = 0; selected = null; render(); };
      bar.append(envLabel, envSelect, el('span', 'http-spacer'), clear);
      const split = el('div', 'http-split');
      const list = el('div', 'http-history');
      const detail = el('div', 'http-detail');
      split.append(list, detail);
      container.append(bar, split);
      ui = { envSelect, list, detail, tab: 'body' };
      renderEnvSelect();
      render();
      refreshEnvs();
    },
  });

  function renderEnvSelect() {
    if (!ui) return;
    const cur = currentEnv();
    const names = cur && !envNames.includes(cur) ? [...envNames, cur] : envNames;
    ui.envSelect.replaceChildren(new Option(tr('No Environment'), ''), ...names.map((n) => new Option(n, n)));
    ui.envSelect.value = cur;
  }
  envListeners.add(renderEnvSelect);

  const formatSize = (n) => (n < 1024 ? tr('{n} bytes', { n }) : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const statusClass = (s) => `http-s${Math.min(5, Math.max(2, Math.floor(s / 100)))}`;

  function errorText(error) {
    const p = { target: error.target || '', seconds: error.seconds || 0, detail: error.detail || '' };
    switch (error.kind) {
      case 'refused': return tr('Connection refused: nothing is listening at {target}.', p);
      case 'dns': return tr('Unknown host: {target} could not be resolved.', p);
      case 'reset': return tr('The connection to {target} was closed by the server.', p);
      case 'timeout': return tr('The request to {target} timed out after {seconds} s.', p);
      case 'url': return tr('Invalid URL: {detail}', p);
      case 'file': return tr('Cannot read the body file: {detail}', p);
      default: return tr('The request failed: {detail}', p);
    }
  }

  function render() {
    if (!ui) return;
    ui.list.replaceChildren(...(history.length ? history.map(historyRow) : [ide.keymap.text(el('div', 'http-empty muted'), () => {
      const keys = ide.keymap.label('HttpClient.RunRequest');
      return keys ? tr('Run a request from a .http file with ▶ or {keys}.', { keys }) : tr('Run a request from a .http file with ▶.');
    })]));
    renderDetail();
  }

  function historyRow(entry) {
    const row = el('div', `http-row${entry === selected ? ' selected' : ''}`);
    const r = entry.result;
    const status = el('span', `http-row-status ${entry.pending ? '' : r?.ok ? statusClass(r.response.status) : 'http-err'}`,
      entry.pending ? '…' : r?.ok ? String(r.response.status) : '✕');
    const method = el('span', `http-method m-${entry.request.method.toLowerCase()}`, entry.request.method);
    const url = userText(el('span', 'http-row-url', entry.title || entry.request.url));
    url.title = entry.request.url;
    const time = el('span', 'http-row-time muted', entry.at.toLocaleTimeString());
    row.append(status, method, url, time);
    row.onclick = () => { selected = entry; render(); };
    row.ondblclick = () => ide.openFile(entry.path, { line: entry.line, col: 1 });
    return row;
  }

  function renderDetail() {
    const d = ui.detail;
    d.replaceChildren();
    const entry = selected;
    if (!entry) return;
    const head = el('div', 'http-detail-head');
    head.append(el('span', `http-method m-${entry.request.method.toLowerCase()}`, entry.request.method), userText(el('span', 'http-url', entry.request.url)));
    const jump = el('button', 'http-btn', tr('Go to Request'));
    jump.onclick = () => ide.openFile(entry.path, { line: entry.line, col: 1 });
    head.append(el('span', 'http-spacer'), jump);
    d.append(head);
    if (entry.pending) { d.append(el('div', 'http-pending muted', tr('Sending request…'))); return; }
    const r = entry.result;
    if (r.unresolved?.length) d.append(el('div', 'http-warn', tr('Unresolved variables: {names}', { names: r.unresolved.join(', ') })));
    if (!r.ok) {
      d.append(el('div', 'http-error', errorText(r.error)));
      return;
    }
    const resp = r.response;
    const status = el('div', 'http-status-line');
    status.append(el('span', `http-status ${statusClass(resp.status)}`, `${resp.status} ${resp.statusText || ''}`.trim()),
      el('span', 'http-meta', tr('{ms} ms', { ms: resp.timeMs })), el('span', 'http-meta', formatSize(resp.size)));
    if (entry.env) status.append(userText(el('span', 'http-meta', entry.env)));
    d.append(status);
    const tabs = el('div', 'http-tabs');
    const pane = el('div', 'http-pane');
    const TABS = [['body', tr('Body')], ['headers', tr('Headers')], ['request', tr('Request')]];
    for (const [id, label] of TABS) {
      const b = el('button', `http-tab${ui.tab === id ? ' active' : ''}`, label);
      b.dataset.tab = id;
      b.onclick = () => { ui.tab = id; renderDetail(); };
      tabs.append(b);
    }
    d.append(tabs, pane);
    if (ui.tab === 'headers') pane.append(headerTable(resp.headers));
    else if (ui.tab === 'request') pane.append(requestView(r.request));
    else renderBody(pane, resp);
  }

  function headerTable(headers) {
    const table = el('div', 'http-headers');
    for (const [k, v] of headers) table.append(userText(el('span', 'http-h-name', k)), userText(el('span', 'http-h-value', v)));
    return table;
  }

  function requestView(req) {
    const box = el('div', 'http-request');
    box.append(userText(el('div', 'http-request-line', `${req.method} ${req.url}`)), headerTable(req.headers || []));
    if (req.body) box.append(userText(el('pre', 'http-body', req.body)));
    return box;
  }

  function colorized(text, language) {
    const pre = userText(el('pre', 'http-body'));
    pre.textContent = text;
    if (text.length < 500000) monaco.editor.colorize(text, language, { tabSize: 2 }).then((html) => { pre.innerHTML = html; });
    return pre;
  }

  function renderBody(pane, resp) {
    pane.dataset.kind = resp.kind;
    if (resp.bodyDropped) { pane.append(el('div', 'muted', tr('The body of this older response is no longer kept.'))); return; }
    if (resp.kind === 'image') {
      const img = el('img', 'http-image');
      img.src = `data:${resp.contentType.split(';')[0]};base64,${resp.base64}`;
      pane.append(img);
      return;
    }
    if (resp.kind === 'binary') { pane.append(el('div', 'muted', tr('Binary content, {size}.', { size: formatSize(resp.size) }))); return; }
    if (!resp.text) { pane.append(el('div', 'muted', tr('The response has no body.'))); return; }
    if (resp.kind === 'json') {
      let text = resp.text;
      try { text = JSON.stringify(JSON.parse(resp.text), null, 2); } catch {}
      pane.append(colorized(text, 'http-json'));
    } else if (resp.kind === 'html') {
      const toggle = el('div', 'http-tabs');
      const source = colorized(resp.text, 'html');
      const frame = el('iframe', 'http-preview');
      frame.setAttribute('sandbox', '');
      frame.srcdoc = resp.text;
      frame.hidden = true;
      for (const [id, label] of [['source', tr('Source')], ['preview', tr('Preview')]]) {
        const b = el('button', `http-tab${id === 'source' ? ' active' : ''}`, label);
        b.onclick = () => {
          toggle.querySelectorAll('.http-tab').forEach((x) => x.classList.toggle('active', x === b));
          source.hidden = id !== 'source';
          frame.hidden = id !== 'preview';
        };
        toggle.append(b);
      }
      pane.append(toggle, source, frame);
    } else {
      pane.append(resp.kind === 'xml' ? colorized(resp.text, 'xml') : userText(el('pre', 'http-body', resp.text)));
    }
    if (resp.truncated) pane.append(el('div', 'muted', tr('The body was cut at 5 MB.')));
  }

  // ---------- status bar: the environment of .http files ----------
  const statusEl = el('span', 'http-env-status');
  statusEl.onclick = pickEnv;
  statusEl.title = tr('HTTP Client environment');
  ide.registerStatusItem({ order: 30, el: statusEl });
  const renderStatus = () => {
    const show = !!activeHttpPath();
    statusEl.hidden = !show;
    statusEl.textContent = show ? tr('Env: {name}', { name: currentEnv() || tr('none') }) : '';
  };
  envListeners.add(renderStatus);
  ide.on('activeTabChanged', () => { renderStatus(); if (activeHttpPath()) refreshEnvs(); });
  ide.on('fileSaved', (tab) => { if (/http-client(\.private)?\.env\.json$/i.test(tab?.path || '')) refreshEnvs(); });
  ide.on('projectOpened', () => { refreshEnvs(); renderStatus(); });
  renderStatus();

  // ---------- new file ----------
  const TEMPLATE = [
    '### Example request',
    '# @name example',
    'GET http://localhost:8000/',
    'Accept: application/json',
    '',
    '###',
    '',
  ].join('\n');
  async function newRequestFile(dir = ide.root) {
    if (!dir) return;
    const name = await ide.ui.prompt(tr('New HTTP Request file name'), 'requests.http');
    if (!name) return;
    const target = joinPath(dir, isHttpPath(name) ? name : `${name}.http`);
    if (await ide.api.exists(target)) { ide.ui.alert(tr('{name} already exists', { name: basename(target) })); return; }
    await ide.api.write(target, TEMPLATE);
    ide.refreshTree?.();
    ide.emit('filesChanged', { created: [target] });
    await ide.openFile(target, { line: 3, col: 1 });
  }
  ide.registerAction({ id: 'NewHttpRequest', title: tr('New HTTP Request'), run: () => newRequestFile() });
  ide.registerTreeAction({ title: tr('New HTTP Request'), run: (e) => newRequestFile(e.dir ? e.path : dirname(e.path)) });

  // ---------- frameworks: generate a request for a route ----------
  async function generateRequest(route) {
    if (!ide.root) return null;
    const target = joinPath(ide.root, 'generated-requests.http');
    const method = route.methods.find((m) => m !== 'HEAD' && m !== 'OPTIONS') || 'GET';
    const url = ide.frameworks?.routeUrl ? ide.frameworks.routeUrl(route) : route.path;
    const block = [`### ${method} ${route.path}`, `${method} ${url}`];
    if (['POST', 'PUT', 'PATCH'].includes(method)) block.push('Content-Type: application/json', '', '{}');
    const tab = ide.tabs.find((t) => t.kind === 'file' && samePath(t.path, target));
    const existing = tab ? tab.model.getValue() : (await ide.api.exists(target)) ? await ide.api.read(target) : '';
    const prefix = existing && !/\n\s*$/.test(existing) ? '\n\n' : existing ? '\n' : '';
    const text = `${prefix}${block.join('\n')}\n`;
    const line = (existing + prefix).split('\n').length + 1;
    if (tab) {
      const end = tab.model.getFullModelRange().getEndPosition();
      tab.model.pushEditOperations([], [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text }], () => null);
      await ide.saveTab?.(tab);
    } else {
      await ide.api.write(target, existing + text);
      ide.refreshTree?.();
      if (!existing) ide.emit('filesChanged', { created: [target] });
    }
    await ide.openFile(target, { line, col: 1 });
    return { path: target, line };
  }
  if (ide.frameworks?.routeActions) ide.frameworks.routeActions.push({ title: () => tr('Generate Request in HTTP Client'), run: generateRequest });

  ide.httpClient = {
    parse,
    history: () => history,
    environment: currentEnv,
    environments: () => envNames,
    setEnvironment: setEnv,
    refreshEnvironments: refreshEnvs,
    runAtLine,
    generateRequest,
    toolWindow: () => tw,
  };
})();
