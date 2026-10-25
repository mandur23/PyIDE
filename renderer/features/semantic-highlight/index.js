// Semantic highlighting for Python, as in PyCharm: names are colored by what they are (parameters, self and cls,
// classes, functions and methods, properties, modules, constants, builtins, decorators, type parameters), not only by
// how they look. Monaco asks for document semantic tokens once typing pauses; the tokens come from
// semantic_server.py (main/features/semantic-highlight.js), which reads the syntax tree and resolves imports through
// typeshed and the interpreter's sources without running anything. Pyright 1.1.406 has no semantic tokens, and
// basedpyright's cost Pyright's queue too much while typing (FEATURES.md, Semantic highlighting).
// Colors are theme rules for the token types ('py-<type>[.<modifier>]'), so Dark and Light each have their own;
// Settings › Editor › Color Scheme lets the user change them.
(() => {
  const monaco = ide.monaco;
  const { el } = ide.util;
  const KEY = 'editor.semanticHighlighting';
  const COLORS_KEY = 'editor.colorScheme.python';
  const MAX_TEXT = 3_000_000;
  // Must match semantic_server.py's TYPES and MODS (the indexes in its data).
  const TYPES = ['namespace', 'class', 'typeParameter', 'parameter', 'selfParameter', 'clsParameter', 'variable',
    'property', 'function', 'method', 'decorator'];
  const MODS = ['declaration', 'readonly', 'defaultLibrary'];
  const legend = { tokenTypes: TYPES.map((t) => `py-${t}`), tokenModifiers: MODS };

  // The color settings: PyCharm's Python colors where it has them (self parameter, builtins, decorators, function
  // declarations and calls, fields and constants of the New UI schemes), and colors that sit well beside them for the
  // kinds PyCharm leaves plain.
  const KINDS = [
    { id: 'parameter', label: () => tr('Parameter'), dark: '#E6C07B', light: '#A0522D' },
    { id: 'self', label: () => tr('Self parameter'), dark: '#94558D', light: '#94558D' },
    { id: 'class', label: () => tr('Class'), dark: '#2FBAA3', light: '#0E7C7B' },
    { id: 'typeParameter', label: () => tr('Type parameter'), dark: '#A3BE8C', light: '#3E7D1E', italic: true },
    { id: 'function', label: () => tr('Function'), dark: '#56A8F5', light: '#00627A' },
    { id: 'method', label: () => tr('Method'), dark: '#57AAF7', light: '#006E87' },
    { id: 'property', label: () => tr('Property or attribute'), dark: '#C77DBB', light: '#871094' },
    { id: 'module', label: () => tr('Module'), dark: '#8DA4C8', light: '#3E6D9C' },
    { id: 'constant', label: () => tr('Constant'), dark: '#C77DBB', light: '#871094', italic: true },
    { id: 'builtin', label: () => tr('Builtin name'), dark: '#8888C6', light: '#000080' },
    { id: 'decorator', label: () => tr('Decorator'), dark: '#B3AE60', light: '#9E880D' },
  ];
  const DEFAULT_FG = { dark: '#BCBEC4', light: '#080808' };

  const enabled = () => ide.settings.get(KEY, true) !== false;
  const validColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  function colorsFor(theme, overrides = ide.settings.get(COLORS_KEY, null)) {
    const out = {};
    for (const k of KINDS) {
      const o = overrides?.[theme]?.[k.id];
      out[k.id] = validColor(o) ? o : k[theme];
    }
    return out;
  }

  function rulesFor(theme) {
    const c = colorsFor(theme);
    const fg = (hex) => hex.slice(1);
    const italic = (id) => (KINDS.find((k) => k.id === id).italic ? 'italic' : '');
    const rule = (token, kind) => ({ token, foreground: fg(c[kind]), fontStyle: italic(kind) });
    return [
      rule('py-parameter', 'parameter'), rule('py-selfParameter', 'self'), rule('py-clsParameter', 'self'),
      rule('py-class', 'class'), rule('py-typeParameter', 'typeParameter'),
      rule('py-function', 'function'), rule('py-method', 'method'), rule('py-property', 'property'),
      rule('py-namespace', 'module'), rule('py-variable.readonly', 'constant'), rule('py-decorator', 'decorator'),
      rule('py-class.defaultLibrary', 'builtin'), rule('py-function.defaultLibrary', 'builtin'), rule('py-variable.defaultLibrary', 'builtin'),
      // A local variable keeps the plain text color (no rule would give it the theme's default anyway).
      { token: 'py-variable', foreground: fg(DEFAULT_FG[theme]) },
    ];
  }

  // Core defines pycharm-dark (window.PYCHARM_DARK) and the settings plugin pycharm-light (window.PYCHARM_LIGHT);
  // they are defined again with the semantic rules added. Monaco repaints when the current theme is redefined.
  function defineThemes() {
    const add = (name, base, theme) => {
      if (base) monaco.editor.defineTheme(name, { ...base, rules: [...base.rules, ...rulesFor(theme)] });
    };
    add('pycharm-dark', window.PYCHARM_DARK, 'dark');
    add('pycharm-light', window.PYCHARM_LIGHT, 'light');
  }

  // ---------- the tokens ----------
  const local = (i) => i && i.cmd && !i.target; // remote interpreters (WSL, SSH, Docker) cannot run the sidecar here
  function candidates() {
    const cur = ide.currentInterp?.();
    const rest = (ide.interps || []).filter((i) => i !== cur && !i.invalid)
      .sort((a, b) => String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true }));
    return [cur, ...rest].filter(local).map((i) => ({ cmd: i.cmd, args: i.args || [], executable: i.executable }));
  }

  const stats = { requests: 0, errors: 0, lastMs: 0 };
  let warnedNoPython = false;
  // A failed request throws an error Monaco treats as "busy": it keeps the last tokens (moved with the edits made
  // since) instead of clearing them, so a syntax error while typing does not flash the colors away.
  const busy = (why) => new Error(`busy: ${why}`);

  // Monaco throttles document semantic tokens instead of debouncing them: while the user types it asks every few
  // hundred ms, and each request makes the sidecar parse the whole file (about a second for 20,000 lines). The provider
  // first waits until the text has not changed for EDIT_PAUSE ms (LARGE_PAUSE above LARGE_LINES lines, as document
  // symbols do); an edit meanwhile answers busy, so Monaco keeps the last colors, moves them with the edits and asks
  // again. Monaco moves an answer by the edits made after it asked, so the text sent must be the text it asked about.
  const EDIT_PAUSE = 400;
  const LARGE_LINES = 5000;
  const LARGE_PAUSE = 1000;
  const lastEdit = new WeakMap();
  const track = (m) => m.onDidChangeContent(() => lastEdit.set(m, Date.now()));
  monaco.editor.getModels().forEach(track);
  monaco.editor.onDidCreateModel(track);
  // -> true once the model has rested for the pause, false if it was edited (or the request cancelled) first.
  function typingPaused(model, token) {
    const pause = model.getLineCount() > LARGE_LINES ? LARGE_PAUSE : EDIT_PAUSE;
    const wait = (lastEdit.get(model) || 0) + pause - Date.now();
    if (wait <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const subs = [];
      const done = (ok) => { clearTimeout(timer); subs.forEach((s) => s.dispose()); resolve(ok); };
      const timer = setTimeout(() => done(true), wait);
      subs.push(model.onDidChangeContent(() => done(false)), token.onCancellationRequested(() => done(false)));
    });
  }

  async function compute(model) {
    const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
    if (text.length > MAX_TEXT) return null;
    const path = model.uri.scheme === 'file' ? model.uri.fsPath : '';
    const t0 = performance.now();
    stats.requests++;
    const ask = () => ide.api.invoke('semantic-highlight:tokens', candidates(), { text, path, root: ide.root || '' });
    let r = await ask();
    // The sidecar was stopped under the request (an interpreter change, another project): ask the new one.
    if (r?.error?.code === 'sidecar') r = await ask();
    stats.lastMs = Math.round(performance.now() - t0);
    if (r?.error) {
      stats.errors++;
      if (r.error.code === 'no-python') {
        if (!warnedNoPython) ide.log.info(`Semantic highlighting is off: ${r.error.message}`);
        warnedNoPython = true;
        return null;
      }
      if (r.error.code !== 'syntax' && r.error.code !== 'superseded') ide.log.warn(`Semantic highlighting: ${r.error.message}`);
      throw busy(r.error.code);
    }
    return r.result.data;
  }

  let registration = null;
  function register() {
    if (registration) return;
    registration = monaco.languages.registerDocumentSemanticTokensProvider('python', {
      getLegend: () => legend,
      async provideDocumentSemanticTokens(model, _lastResultId, token) {
        if (!enabled()) return null;
        if (!(await typingPaused(model, token))) throw busy('typing');
        const data = await compute(model);
        if (token.isCancellationRequested) throw busy('cancelled');
        return data ? { data: Uint32Array.from(data) } : null;
      },
      releaseDocumentSemanticTokens() {},
    });
  }

  function apply() {
    const on = enabled();
    ide.updateEditorOptions({ 'semanticHighlighting.enabled': on });
    if (on) register();
    else { registration?.dispose(); registration = null; }
  }

  defineThemes();
  apply();
  ide.on('ready', () => { defineThemes(); apply(); });
  ide.on('settingsChanged', (key) => {
    if (key === KEY) apply();
    else if (key === COLORS_KEY) defineThemes();
  });
  // The sidecar runs in the project interpreter (often the project's venv), so it stops when the project closes or
  // another opens, and on an interpreter change, where interpreters that could not run it get another chance; the
  // next request starts it again.
  const stopSidecar = () => ide.api.invoke('semantic-highlight:stop').catch(() => {});
  ide.on('interpreterChanged', () => { ide.api.invoke('semantic-highlight:reset').catch(() => {}); stopSidecar(); });
  ide.on('projectClosed', stopSidecar);
  ide.on('projectOpened', stopSidecar);

  // ---------- Settings › Editor › Color Scheme ----------
  (ide.settingsPages ||= []).push({
    id: 'color-scheme', group: 'editor', title: () => tr('Color Scheme'), defaults: { [KEY]: true },
    keywords: 'color scheme colors semantic highlighting python parameter self class method function property module constant builtin decorator type parameter 색 구성표 색상 의미 강조 매개변수 클래스 메서드 함수 프로퍼티 모듈 상수 내장 데코레이터 타입',
    mount(host, ctx) {
      const s = ctx.ui.section(host, 'Python');
      s.appendChild(ctx.ui.checkbox(KEY, tr('Semantic highlighting')));
      s.appendChild(el('div', 'muted settings-note', tr('Colors names by what they are, such as parameters, classes, methods and modules.')));
      const head = el('div', 'field sh-row sh-head');
      head.append(el('span'), el('span', 'sh-swatches', null));
      head.lastChild.append(el('span', 'sh-col', tr('Dark')), el('span', 'sh-col', tr('Light')));
      s.appendChild(head);
      const current = () => ctx.value(COLORS_KEY) || {};
      const inputs = [];
      for (const k of KINDS) {
        const row = el('div', 'field sh-row');
        row.dataset.kind = k.id;
        const sw = el('span', 'sh-swatches');
        for (const theme of ['dark', 'light']) {
          const i = el('input', 'sh-color');
          i.type = 'color';
          i.dataset.theme = theme;
          i.dataset.kind = k.id;
          i.title = `${k.label()} (${theme === 'dark' ? tr('Dark') : tr('Light')})`;
          i.setAttribute('aria-label', i.title);
          i.value = colorsFor(theme, current())[k.id].toLowerCase();
          i.oninput = () => {
            const next = structuredClone(current());
            (next[theme] ||= {})[k.id] = i.value;
            ctx.set(COLORS_KEY, next);
          };
          inputs.push(i);
          sw.appendChild(i);
        }
        row.append(el('span', null, k.label()), sw);
        s.appendChild(row);
      }
      const reset = el('button', 'secondary sh-reset', tr('Restore Defaults'));
      reset.type = 'button';
      reset.onclick = () => {
        ctx.set(COLORS_KEY, null);
        for (const i of inputs) i.value = KINDS.find((k) => k.id === i.dataset.kind)[i.dataset.theme].toLowerCase();
      };
      s.appendChild(reset);
    },
  });

  // For tests and other plugins: the tokens of a model as the sidecar computes them, decoded.
  ide.semanticHighlight = {
    enabled,
    stats: () => ({ ...stats }),
    colors: (theme = ide.theme?.current?.() || 'dark') => colorsFor(theme),
    async tokens(model) {
      const data = await compute(model);
      if (!data) return [];
      const out = [];
      let line = 0;
      let col = 0;
      for (let i = 0; i < data.length; i += 5) {
        line += data[i];
        col = data[i] ? data[i + 1] : col + data[i + 1];
        const mods = MODS.filter((_, b) => data[i + 4] & (1 << b));
        out.push({ line: line + 1, col: col + 1, text: model.getLineContent(line + 1).slice(col, col + data[i + 2]), type: TYPES[data[i + 3]], mods });
      }
      return out;
    },
  };
})();
