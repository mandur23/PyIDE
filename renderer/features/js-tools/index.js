// Prettier and ESLint, as WebStorm uses them: the project's own packages in node_modules (main/features/js-tools.js
// finds and runs them, in trusted projects only). Reformat Code (Ctrl+Alt+L) formats a JavaScript, TypeScript, CSS,
// JSON, Markdown, YAML, HTML or Vue file with Prettier when the project has it, and optionally on save; ESLint checks
// open JavaScript and TypeScript files when they open, after typing and on save, its findings shown as editor markers
// and in Problems, with quick fixes (the rule's fix, its suggestions, suppress for the line, fix all in the file).
// Settings › Prettier and ESLint.
(() => {
  const monaco = ide.monaco;
  const KEYS = { reformat: 'jsTools.prettierOnReformat', onSave: 'jsTools.prettierOnSave', eslint: 'jsTools.eslint' };
  const DEFAULTS = { [KEYS.reformat]: true, [KEYS.onSave]: false, [KEYS.eslint]: true };
  const get = (k) => ide.settings.get(k, DEFAULTS[k]);
  const PRETTIER_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|css|scss|less|json|json5|jsonc|md|markdown|yaml|yml|html|htm|vue)$/i;
  const ESLINT_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;
  const SOURCE = 'eslint';
  const isFileTab = (tab) => tab?.kind === 'file' && tab.model && !tab.model.isDisposed();
  // Nothing runs before a project is open or in Safe Mode (the main process refuses as well).
  const usable = () => !!ide.root && ide.trusted !== false;

  // Replaces only the changed middle of the buffer as one undoable edit, so the caret and folding mostly survive.
  function applyText(model, text) {
    const old = model.getValue();
    if (old === text) return false;
    const n = Math.min(old.length, text.length);
    let s = 0;
    while (s < n && old[s] === text[s]) s++;
    let e = 0;
    while (e < n - s && old[old.length - 1 - e] === text[text.length - 1 - e]) e++;
    const edit = { range: monaco.Range.fromPositions(model.getPositionAt(s), model.getPositionAt(old.length - e)), text: text.slice(s, text.length - e), forceMoveMarkers: true };
    const ed = monaco.editor.getEditors().find((x) => x.getModel() === model && x.getDomNode()?.isConnected);
    if (ed) {
      ed.pushUndoStop();
      ed.executeEdits(SOURCE, [edit]);
      ed.pushUndoStop();
    } else {
      model.pushStackElement();
      model.pushEditOperations([], [edit], () => null);
      model.pushStackElement();
    }
    return true;
  }

  const withEol = (model, text) => text.replace(/\r?\n/g, model.getEOL());

  // ---------- Prettier ----------
  const prettier = (text, path) => ide.api.invoke('js-tools:prettier', text, path, ide.root);
  // Output that cannot be the file formatted, from a broken Prettier that exits 0: nothing for a file with text, or
  // characters Prettier never adds (NUL, and U+FFFD for bytes that were not UTF-8). The file would be replaced by it.
  const strange = (s) => (s.match(/[\u0000�]/g) || []).length;
  const unusable = (out, text) => (!out.trim() && !!text.trim()) || strange(out) > strange(text);

  // Reformat Code asks this before the language server and Monaco (renderer/features/tooling): null leaves the file to
  // them (not a Prettier file, no Prettier in the project, Safe Mode, turned off).
  async function prettierFormat(tab) {
    if (!isFileTab(tab) || !PRETTIER_FILE.test(tab.path) || !usable() || !get(KEYS.reformat)) return null;
    const text = tab.model.getValue();
    const r = await prettier(text, tab.path).catch((err) => ({ error: ide.util.errorText(err) }));
    if (!r || r.skipped) return null;
    if (r.error) return { error: tr('Prettier cannot format the file: {error}', { error: r.error }) };
    if (unusable(r.text, text)) return { error: tr('Prettier cannot format the file: {error}', { error: tr('its output is not the formatted file') }) };
    // Prettier writes LF (its endOfLine default); the file keeps its own line separators.
    return { text: withEol(tab.model, r.text) };
  }
  let hooked = false;
  const hook = () => {
    if (hooked || !ide.tooling?.addFormatter) return;
    hooked = true;
    ide.tooling.addFormatter(prettierFormat);
  };
  hook();
  ide.on('ready', hook);

  // Actions on Save: after ruff's (order 40), on explicit and auto saves; a file Prettier cannot parse is saved as it is.
  ide.registerSaveAction({
    id: 'prettier', order: 45,
    async run(text, ctx) {
      if (!get(KEYS.onSave) || !PRETTIER_FILE.test(ctx.path) || !usable()) return undefined;
      const r = await prettier(text, ctx.path).catch(() => null);
      return r && typeof r.text === 'string' && !unusable(r.text, text) ? r.text.replace(/\r?\n/g, ctx.eol || '\n') : undefined;
    },
  });

  // ---------- ESLint ----------
  const lintState = new Map(); // path lower -> {version, messages}
  const isLintable = (tab) => isFileTab(tab) && ESLINT_FILE.test(tab.path);
  const toProblem = (m) => ({
    line: m.line, col: m.column, endLine: m.endLine || m.line, endCol: m.endColumn || m.column + 1,
    msg: m.ruleId ? `${m.message} (${m.ruleId})` : m.message, severity: m.severity === 2 ? 'error' : 'warning',
  });

  // ESLint that cannot lint at all (a configuration it cannot load, a crash) fails the same way for every file: one
  // notification until it works again or says something else, not one per file and keystroke.
  let failure = null;
  function setFailure(error) {
    if (error && error !== failure) {
      ide.notifications?.notify({ title: tr('ESLint cannot check files'), text: error, kind: 'error', group: 'ESLint', raw: true });
    }
    failure = error || null;
  }

  async function lint(tab, opts = {}) {
    if (!isLintable(tab) || !usable() || !get(KEYS.eslint)) return null;
    const model = tab.model;
    const version = model.getVersionId();
    const r = await ide.api.invoke('js-tools:eslint', model.getValue(), tab.path, ide.root, opts).catch((err) => ({ error: ide.util.errorText(err) }));
    if (model.isDisposed() || model.getVersionId() !== version || !ide.findTab(tab.path)) return null;
    if (!r || r.skipped) {
      lintState.delete(tab.path.toLowerCase());
      ide.problems.set(SOURCE, tab.path, []);
      return null;
    }
    if (r.error) {
      lintState.delete(tab.path.toLowerCase());
      ide.problems.set(SOURCE, tab.path, []);
      setFailure(r.error);
      return r;
    }
    setFailure(null);
    if (opts.fix) return r;
    lintState.set(tab.path.toLowerCase(), { version, messages: r.messages });
    ide.problems.set(SOURCE, tab.path, r.messages.map(toProblem));
    return r;
  }

  const timers = new Map();
  const running = new Map(); // path -> the lint lintSoon started, until it settles
  // A file larger than this (in characters) is linted when it opens and when it is saved, not after every pause.
  const LINT_WHILE_TYPING_MAX = 1024 * 1024;
  function lintSoon(tab, ms = 800) {
    clearTimeout(timers.get(tab.path));
    if (tab.model.getValueLength() > LINT_WHILE_TYPING_MAX) return;
    timers.set(tab.path, setTimeout(() => {
      // One ESLint per file at a time: one that hangs (until its 30 s timeout) is not joined by another per pause.
      const busy = running.get(tab.path);
      if (busy) { busy.then(() => isFileTab(tab) && ide.findTab(tab.path) && lintSoon(tab, 0)); return; }
      const p = lint(tab).catch(() => null).finally(() => running.delete(tab.path));
      running.set(tab.path, p);
    }, ms));
  }

  async function fixAll(tab = ide.activeTab()) {
    if (!isLintable(tab)) return;
    const model = tab.model;
    const version = model.getVersionId();
    const r = await lint(tab, { fix: true });
    if (!r || r.error || model.isDisposed() || model.getVersionId() !== version) return;
    if (typeof r.output === 'string') applyText(model, withEol(model, r.output));
    lint(tab);
  }

  ide.on('fileOpened', (tab) => {
    if (!isLintable(tab)) return;
    lint(tab);
    tab.model.onDidChangeContent(() => get(KEYS.eslint) && usable() && lintSoon(tab));
  });
  ide.on('fileSaved', (tab) => { if (isLintable(tab)) lint(tab); });
  ide.on('fileClosed', (path) => {
    clearTimeout(timers.get(path));
    lintState.delete(path.toLowerCase());
    ide.problems.set(SOURCE, path, []);
  });
  ide.on('projectOpened', () => { lintState.clear(); failure = null; ide.problems.clear(SOURCE); });
  ide.on('settingsChanged', (key) => {
    if (key !== KEYS.eslint) return;
    if (!get(KEYS.eslint)) { lintState.clear(); failure = null; ide.problems.clear(SOURCE); return; }
    ide.tabs.filter(isLintable).forEach((t) => lint(t));
  });

  // ---------- quick fixes (Alt+Enter, the lightbulb) ----------
  monaco.editor.registerCommand('jsTools.eslintFixAll', () => fixAll());

  const offsetEdit = (model, fix) => ({
    range: monaco.Range.fromPositions(model.getPositionAt(fix.range[0]), model.getPositionAt(fix.range[1])), text: fix.text || '',
  });
  function suppressEdit(model, m) {
    const line = m.line;
    const indent = /^\s*/.exec(model.getLineContent(line))[0];
    const above = line > 1 ? model.getLineContent(line - 1) : '';
    const existing = /\/\/\s*eslint-disable-next-line\s+(.+?)\s*$/.exec(above);
    if (existing) {
      if (existing[1].split(/\s*,\s*/).includes(m.ruleId)) return null;
      const col = above.length + 1;
      return { range: new monaco.Range(line - 1, col, line - 1, col), text: `, ${m.ruleId}` };
    }
    return { range: new monaco.Range(line, 1, line, 1), text: `${indent}// eslint-disable-next-line ${m.ruleId}${model.getEOL()}` };
  }

  const provider = {
    // Synchronous: a stale result offers nothing, and the lint it starts updates the markers, so Monaco asks again.
    provideCodeActions(model, range, context) {
      const tab = ide.tabs.find((t) => t.model === model);
      const state = isLintable(tab) && get(KEYS.eslint) && lintState.get(tab.path.toLowerCase());
      if (!state || state.version !== model.getVersionId()) {
        if (state) lintSoon(tab, 0);
        return { actions: [], dispose() {} };
      }
      const span = (m) => ((m.endLine || m.line) - m.line) * 1e4 + (m.endColumn || m.column) - m.column;
      const hits = state.messages
        .filter((m) => m.line <= range.endLineNumber && (m.endLine || m.line) >= range.startLineNumber)
        .sort((a, b) => span(a) - span(b));
      const markersFor = (m) => context.markers.filter((k) => k.source === SOURCE && k.startLineNumber === m.line && k.message.startsWith(m.message));
      const edits = (list) => ({ edits: list.map((textEdit) => ({ resource: model.uri, versionId: model.getVersionId(), textEdit })) });
      const actions = [];
      for (const m of hits) {
        if (!m.fix) continue;
        actions.push({
          title: tr('Fix with ESLint: {message} ({rule})', { message: m.message, rule: m.ruleId }),
          kind: 'quickfix', diagnostics: markersFor(m), isPreferred: actions.length === 0, edit: edits([offsetEdit(model, m.fix)]),
        });
      }
      for (const m of hits) {
        for (const s of m.suggestions || []) {
          if (!s.fix) continue;
          actions.push({ title: tr('ESLint: {suggestion} ({rule})', { suggestion: s.desc, rule: m.ruleId }), kind: 'quickfix', diagnostics: markersFor(m), edit: edits([offsetEdit(model, s.fix)]) });
        }
      }
      const suppressed = new Set();
      for (const m of hits) {
        if (!m.ruleId || suppressed.has(`${m.line}:${m.ruleId}`)) continue;
        const textEdit = suppressEdit(model, m);
        if (!textEdit) continue;
        suppressed.add(`${m.line}:${m.ruleId}`);
        actions.push({ title: tr('Suppress {rule} for line with // eslint-disable-next-line', { rule: m.ruleId }), kind: 'quickfix', diagnostics: markersFor(m), edit: edits([textEdit]) });
      }
      if (hits.length && state.messages.some((m) => m.fix)) {
        actions.push({ title: tr('Fix all ESLint problems in file'), kind: 'quickfix', command: { id: 'jsTools.eslintFixAll', title: tr('Fix all ESLint problems in file') } });
      }
      return { actions, dispose() {} };
    },
  };
  for (const language of ['javascript', 'typescript']) monaco.languages.registerCodeActionProvider(language, provider, { providedCodeActionKinds: ['quickfix'] });

  ide.registerAction({ id: 'ESLintFixAll', title: tr('Fix All ESLint Problems in File'), run: () => fixAll() });

  // ---------- Settings › Prettier and ESLint ----------
  (ide.settingsPages ||= []).push({
    id: 'js-tools', title: () => tr('Prettier and ESLint'), defaults: DEFAULTS,
    keywords: 'prettier eslint javascript typescript node_modules format reformat lint on save 서식 린트 저장 시 자바스크립트 타입스크립트',
    mount(host, ctx) {
      const p = ctx.ui.section(host, tr('Prettier'));
      p.appendChild(ide.util.el('div', 'muted', tr("Uses the project's own Prettier (node_modules/prettier) with its .prettierrc and .prettierignore.")));
      p.appendChild(ctx.ui.checkbox(KEYS.reformat, tr('Run Prettier on Reformat Code')));
      p.appendChild(ctx.ui.checkbox(KEYS.onSave, tr('Run Prettier on save')));
      const e = ctx.ui.section(host, tr('ESLint'));
      e.appendChild(ide.util.el('div', 'muted', tr("Uses the project's own ESLint (node_modules/eslint) with its eslint.config.js or .eslintrc file.")));
      e.appendChild(ctx.ui.checkbox(KEYS.eslint, tr('Check JavaScript and TypeScript files with ESLint')));
      if (ide.trusted === false) e.appendChild(ide.util.el('div', 'muted', tr('Safe Mode: Prettier and ESLint do not run, since this project is not trusted.')));
    },
  });

  ide.jsTools = { lint, fixAll, prettierFormat, keys: KEYS, state: (path) => lintState.get(String(path).toLowerCase()) || null };
})();
