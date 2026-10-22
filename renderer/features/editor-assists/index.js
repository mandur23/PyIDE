// Editor assists: Sticky Lines (PyCharm's name for Monaco's sticky scroll) in the main editor panes, and automatic
// f-string conversion when a {name} is typed into a plain Python string.
(() => {
  const monaco = ide.monaco;
  const STICKY = 'editor.stickyLines';
  const STICKY_MAX = 'editor.stickyLinesMax';
  const FSTRING = 'editor.autoFString';
  const DEFAULTS = { [STICKY]: true, [STICKY_MAX]: 5, [FSTRING]: true };
  const get = (k) => ide.settings.get(k, DEFAULTS[k]);
  const isPython = (model) => !!model && !model.isDisposed() && model.getLanguageId() === 'python';

  // ---------- Sticky Lines ----------
  // Monaco turns sticky scroll on in every editor it creates. Editors other than the group editors (notebook cells,
  // query consoles, viewers, diff views, the Python Console) keep it off; the group editors follow the setting.
  const OFF = { enabled: false };
  const withStickyOff = (options) => ({ ...options, stickyScroll: options?.stickyScroll ?? OFF });
  const create = monaco.editor.create;
  monaco.editor.create = (host, options, override) => create(host, withStickyOff(options), override);
  const createDiff = monaco.editor.createDiffEditor;
  monaco.editor.createDiffEditor = (host, options, override) => createDiff(host, withStickyOff(options), override);

  const maxLines = () => Math.min(20, Math.max(1, Math.round(Number(get(STICKY_MAX)) || DEFAULTS[STICKY_MAX])));
  // The outline model takes the classes and functions from Pyright's document symbols and puts each sticky line on the
  // symbol's name, so a decorated function sticks as its `def` line and a signature over several lines as its first
  // line. Monaco's indentation model would stick `) -> int:` of such a signature. Until Pyright answers (and for
  // languages without a symbol provider) Monaco falls back to folding ranges, then to indentation.
  const stickyOptions = () => ({ enabled: get(STICKY) !== false, maxLineCount: maxLines(), defaultModel: 'outlineModel', scrollWithEditor: true });
  const isGroupEditor = (ed) => ide.editors().includes(ed);
  const applySticky = (ed) => ed.updateOptions({ stickyScroll: isGroupEditor(ed) ? stickyOptions() : OFF });
  ide.onEditor(applySticky);
  ide.on('settingsChanged', (k) => { if (k === STICKY || k === STICKY_MAX) for (const ed of ide.editors()) applySticky(ed); });

  // A file opened before Pyright had analyzed it got indentation-based sticky lines; Monaco asks the symbol providers
  // again only when the file changes or a provider is (un)registered. Once Pyright has symbols for a shown file,
  // registering and dropping an empty provider makes every sticky scroll ask again.
  const outlined = new WeakSet();
  let refreshTimer = 0;
  let refreshing = false;
  async function refreshSticky() {
    if (refreshing || !ide.lsp || get(STICKY) === false) return;
    refreshing = true;
    try {
      let poke = false;
      for (const ed of ide.editors()) {
        const model = ed.getModel();
        if (!isPython(model) || outlined.has(model) || model.uri.scheme !== 'file') continue;
        const symbols = await ide.lsp.documentSymbols(model.uri.fsPath).catch(() => null);
        if (symbols?.length && !model.isDisposed()) { outlined.add(model); poke = true; }
      }
      if (poke) monaco.languages.registerDocumentSymbolProvider({ language: 'pyide-sticky-refresh' }, { provideDocumentSymbols: () => [] }).dispose();
    } finally { refreshing = false; }
  }
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshSticky, 300); };
  ide.on('problemsChanged', scheduleRefresh);
  ide.on('activeTabChanged', scheduleRefresh);

  // ---------- f-string conversion ----------
  // As PyCharm: typing the `}` that closes `{expr}` inside a plain str literal adds the `f` prefix, as its own undo step.
  // Conservative: only plain (no prefix) strings whose every replacement field is a simple expression starting with a
  // name the file uses as code (or a builtin), and not docstrings, strings followed by .format(...) or `%`, strings
  // with %-placeholders or {{ }} escapes, or messages passed to logging calls.
  const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
  const BUILTINS = new Set(['abs', 'all', 'any', 'ascii', 'bin', 'bool', 'bytes', 'chr', 'dict', 'dir', 'divmod', 'enumerate',
    'filter', 'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash', 'hex', 'id', 'int', 'isinstance', 'len', 'list',
    'map', 'max', 'min', 'next', 'oct', 'ord', 'pow', 'range', 'repr', 'reversed', 'round', 'set', 'sorted', 'str', 'sum',
    'tuple', 'type', 'vars', 'zip', '__name__', '__file__']);
  const PREFIXES = new Set(['r', 'u', 'b', 'br', 'rb', 'f', 'fr', 'rf', 't', 'tr', 'rt']);
  const ID_START = /[\p{ID_Start}_]/u;
  const ID_CONT = /[\p{ID_Continue}]/u;
  const NAME = /^[\p{ID_Start}_][\p{ID_Continue}]*/u;

  // Python tokens enough to tell code from strings: names, strings (with prefix, quotes and content bounds) and
  // one-character operators; comments are skipped. Unterminated strings end at the line end (or the file end).
  function tokenize(text, stopAfter = Infinity) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n && i <= stopAfter) {
      const c = text[i];
      if (c === '#') { const eol = text.indexOf('\n', i); out.push({ type: 'comment', start: i, end: eol < 0 ? n : eol }); i = eol < 0 ? n : eol; continue; }
      const start = i;
      let prefix = '';
      if (ID_START.test(c)) {
        let j = i + 1;
        while (j < n && ID_CONT.test(text[j])) j++;
        const word = text.slice(i, j);
        if ((text[j] === '"' || text[j] === "'") && PREFIXES.has(word.toLowerCase())) { prefix = word; i = j; } else {
          out.push({ type: 'name', start, end: j, value: word });
          i = j;
          continue;
        }
      } else if (c !== '"' && c !== "'") {
        if (!/\s/.test(c)) out.push({ type: 'op', start: i, end: i + 1, value: c });
        i++;
        continue;
      }
      const q = text[i];
      const triple = text[i + 1] === q && text[i + 2] === q;
      const contentStart = i + (triple ? 3 : 1);
      let j = contentStart;
      let contentEnd = -1;
      let end = -1;
      while (j < n) {
        const ch = text[j];
        if (ch === '\\') { j += 2; continue; }
        if (!triple && ch === '\n') break;
        if (ch === q && (!triple || (text[j + 1] === q && text[j + 2] === q))) { contentEnd = j; end = j + (triple ? 3 : 1); break; }
        j++;
      }
      if (contentEnd < 0) {
        contentEnd = Math.min(j, n);
        if (text[contentEnd - 1] === '\r') contentEnd--;
        end = contentEnd;
      }
      out.push({ type: 'string', start, contentStart, contentEnd, end, prefix, quote: q, triple });
      i = Math.max(end, i + 1);
    }
    return out;
  }

  // Names the code uses: not attributes (`.name`), keyword arguments (`f(name=…)`) or anything inside strings.
  function codeNames(tokens, text) {
    const names = new Set();
    let depth = 0;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === 'op') {
        if ('([{'.includes(t.value)) depth++;
        else if (')]}'.includes(t.value)) depth = Math.max(0, depth - 1);
        continue;
      }
      if (t.type !== 'name' || KEYWORDS.has(t.value)) continue;
      const prev = tokens[k - 1];
      if (prev?.type === 'op' && prev.value === '.') continue;
      const next = tokens[k + 1];
      if (depth > 0 && next?.type === 'op' && next.value === '=' && text[next.start + 1] !== '=') continue;
      names.add(t.value);
    }
    return names;
  }

  // The replacement fields of a plain string's content, or null when a brace does not belong to one ({{, }}, a lone
  // brace, a nested field or a field over several lines).
  function replacementFields(content) {
    const fields = [];
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (c === '}') return null;
      if (c !== '{') continue;
      if (content[i + 1] === '{') return null;
      let depth = 0;
      let close = -1;
      for (let j = i + 1; j < content.length; j++) {
        const d = content[j];
        if (d === '(' || d === '[') depth++;
        else if (d === ')' || d === ']') depth--;
        else if (d === '{' || d === '\n') return null;
        else if (d === '}' && depth <= 0) { close = j; break; }
      }
      if (close < 0) return null;
      fields.push({ start: i, end: close + 1, body: content.slice(i + 1, close) });
      i = close;
    }
    return fields;
  }

  function balanced(expr) {
    const stack = [];
    for (const c of expr) {
      if (c === '(' || c === '[') stack.push(c === '(' ? ')' : ']');
      else if ((c === ')' || c === ']') && stack.pop() !== c) return false;
    }
    return !stack.length;
  }

  // `expr[=][!r|!s|!a][:spec]` whose expression starts with a known name and holds only names, numbers, operators,
  // brackets and strings in the other quote.
  function fieldRoot(body, quote) {
    let depth = 0;
    let exprEnd = body.length;
    for (let k = 0; k < body.length; k++) {
      const d = body[k];
      if (d === '(' || d === '[') depth++;
      else if (d === ')' || d === ']') depth--;
      else if (depth === 0 && (d === ':' || (d === '!' && body[k + 1] !== '='))) { exprEnd = k; break; }
    }
    const rest = body.slice(exprEnd);
    if (rest && !/^(![rsa])?(:[^{}]*)?$/.test(rest)) return null;
    let expr = body.slice(0, exprEnd).replace(/(^|[^=!<>])=\s*$/, '$1').trim();
    if (!expr || /[\\#\n]/.test(expr) || expr.includes(quote)) return null;
    // Strings in the other quote (`d['key']` inside "…") count as one operand.
    const parts = expr.split(quote === '"' ? "'" : '"');
    if (parts.length % 2 === 0) return null;
    expr = parts.map((part, k) => (k % 2 ? '' : part)).join('0');
    const m = NAME.exec(expr);
    if (!m || KEYWORDS.has(m[0])) return null;
    if (!/^[\p{ID_Continue}\s.,+\-*/%<>=!&|^~()[\]]*$/u.test(expr) || !balanced(expr)) return null;
    return m[0];
  }

  // The previous line with code before `lineStart`, comments and blank lines skipped ('' at the top of the file).
  function previousCodeLine(text, lineStart) {
    let k = lineStart - 1;
    while (k > 0) {
      const ls = text.lastIndexOf('\n', k - 1) + 1;
      const code = text.slice(ls, k).replace(/#.*$/, '').trim();
      if (code) return code;
      k = ls - 1;
    }
    return '';
  }

  const LOGGING_CALL = /(?:^|[^\w.])(?:\w+\s*\.\s*)*\w*log\w*\s*\.\s*(?:debug|info|warning|warn|error|exception|critical|fatal|log)\s*\(\s*(?:[\w.]+\s*,\s*)?$/i;
  const PERCENT_PLACEHOLDER = /%(\([^)]*\))?[-#0 +]*(\d+|\*)?(\.(\d+|\*))?[diouxXeEfFgGcrsa]/;

  // Where to insert `f` when the `}` at text[brace] has just been typed, or null to leave the text alone.
  function fstringInsertAt(text, brace) {
    if (text[brace] !== '}' || text.length > 2_000_000) return null;
    const tokens = tokenize(text, brace);
    const s = tokens.findLast((t) => t.type === 'string' && t.contentStart <= brace && brace < t.contentEnd);
    if (!s || s.prefix) return null;
    // A docstring: a triple-quoted string that starts its line, at the top of the file or right after a `…:` line.
    const lineStart = text.lastIndexOf('\n', s.start - 1) + 1;
    if (s.triple && !text.slice(lineStart, s.start).trim()) {
      const prev = previousCodeLine(text, lineStart);
      if (!prev || prev.endsWith(':')) return null;
    }
    const after = text.slice(s.end, s.end + 200);
    if (/^\s*(\\\r?\n\s*)?\.\s*format(_map)?\b/.test(after) || /^\s*%(?!=)/.test(after)) return null;
    if (LOGGING_CALL.test(text.slice(Math.max(0, s.start - 300), s.start))) return null;
    const content = text.slice(s.contentStart, s.contentEnd);
    if (PERCENT_PLACEHOLDER.test(content)) return null;
    const fields = replacementFields(content);
    const rel = brace - s.contentStart;
    if (!fields?.length || !fields.some((f) => f.end - 1 === rel)) return null;
    const roots = fields.map((f) => fieldRoot(f.body, s.quote));
    if (roots.some((r) => !r)) return null;
    const names = codeNames(tokenize(text), text);
    if (!roots.every((r) => names.has(r) || BUILTINS.has(r))) return null;
    return s.start;
  }

  function convertAtCaret(ed) {
    if (get(FSTRING) === false) return false;
    const model = ed.getModel();
    if (!isPython(model) || ed.getOption(monaco.editor.EditorOption.readOnly)) return false;
    const sels = ed.getSelections();
    if (!sels || sels.length !== 1 || !sels[0].isEmpty()) return false;
    const pos = sels[0].getPosition();
    const at = fstringInsertAt(model.getValue(), model.getOffsetAt(pos) - 1);
    if (at == null) return false;
    const p = model.getPositionAt(at);
    const caret = p.lineNumber === pos.lineNumber ? new monaco.Selection(pos.lineNumber, pos.column + 1, pos.lineNumber, pos.column + 1) : sels[0];
    // Its own undo step: Ctrl+Z takes the prefix away and keeps what was typed.
    ed.pushUndoStop();
    ed.executeEdits('pyide.fstring', [{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: 'f' }], [caret]);
    ed.pushUndoStop();
    return true;
  }

  // onDidType fires for typed text only (keys, IME), not for pastes, undo or edits other features make.
  ide.onEditor((ed) => {
    if (typeof ed.onDidType !== 'function') return;
    ed.onDidType((typed) => { if (typed.endsWith('}')) convertAtCaret(ed); });
  });

  (ide.settingsPages ||= []).push({
    id: 'smart-keys', group: 'editor', title: () => tr('Smart Keys'), defaults: DEFAULTS,
    keywords: 'smart keys python f-string format string convert automatically brace 스마트 키 f-문자열 자동 변환 중괄호',
    mount(host, ctx) {
      const s = ctx.ui.section(host, 'Python');
      s.appendChild(ctx.ui.checkbox(FSTRING, tr('Convert to f-string automatically')));
      host.appendChild(ide.util.el('div', 'muted settings-note',
        tr('Typing a closing brace after a name in a plain string literal, as in "Hello {name}", adds the f prefix. Undo removes the prefix only.')));
    },
  });

  ide.editorAssists = { stickyOptions, refreshSticky, fstringInsertAt, convertAtCaret, keys: { STICKY, STICKY_MAX, FSTRING } };
})();
