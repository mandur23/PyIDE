// Editor assists: Sticky Lines (PyCharm's name for Monaco's sticky scroll) in the main editor panes, automatic
// f-string conversion when a {name} is typed into a plain Python string, PyCharm's editing actions that Monaco lacks or
// binds to other keys (Start New Line, Complete Current Statement, Move Statement, Toggle Case…), and docstring stubs.
(() => {
  const monaco = ide.monaco;
  const STICKY = 'editor.stickyLines';
  const STICKY_MAX = 'editor.stickyLinesMax';
  const FSTRING = 'editor.autoFString';
  const DOC_STUB = 'editor.docstringStub';
  const DEFAULTS = { [STICKY]: true, [STICKY_MAX]: 5, [FSTRING]: true, [DOC_STUB]: true };
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

  // ---------- PyCharm editing actions ----------
  const { Range, Selection } = monaco;
  const unitOf = (model) => { const o = model.getOptions(); return o.insertSpaces ? ' '.repeat(o.indentSize || o.tabSize) : '\t'; };
  const editable = (ed) => !!ed?.getModel() && !ed.getOption(monaco.editor.EditorOption.readOnly);
  const inEditor = () => !!ide.editor?.hasTextFocus();
  const trigger = (id) => Object.assign(() => ide.editor?.trigger('keymap', id, null), { editorCommand: id });
  // Enter-like keys take the selected completion first, as PyCharm's lookup does.
  const acceptSuggestion = (ed) => {
    if (ed.getDomNode()?.querySelector('.suggest-widget.visible')) ed.trigger('keymap', 'acceptSelectedSuggestion', {});
  };
  const OPENERS = { '(': ')', '[': ']', '{': '}' };
  const isCloser = (t) => t?.type === 'op' && ')]}'.includes(t.value);
  const lineStartAt = (text, o) => text.lastIndexOf('\n', o - 1) + 1;
  const lineEndAt = (text, o) => {
    const nl = text.indexOf('\n', o);
    const end = nl < 0 ? text.length : nl;
    return text[end - 1] === '\r' ? end - 1 : end;
  };
  const leading = (text, lineStart) => /^[ \t]*/.exec(text.slice(lineStart, lineStart + 200))[0];

  // As PyCharm: the line stays as it is and a new line opens below it (End, then Enter).
  function startNewLine(ed = ide.editor) {
    if (!editable(ed)) return;
    acceptSuggestion(ed);
    const model = ed.getModel();
    ed.setSelections(ed.getSelections().map((s) => {
      const c = model.getLineMaxColumn(s.positionLineNumber);
      return new Selection(s.positionLineNumber, c, s.positionLineNumber, c);
    }));
    ed.trigger('keymap', 'type', { text: '\n' });
  }

  // Keywords that start a statement and cannot continue an expression inside brackets; if/for/else also start
  // comprehensions and conditional expressions, but those are indented when they open a line.
  const STATEMENT_KW = new Set(['def', 'class', 'return', 'import', 'from', 'raise', 'pass', 'break', 'continue', 'del', 'global',
    'nonlocal', 'assert', 'try', 'except', 'finally', 'while', 'with', 'if', 'elif', 'else', 'for', 'async']);
  // Keywords that join two operands (`a and b`, `x if c else y`), so an operand cannot end or start with them.
  const JOINING_KW = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'for', 'lambda', 'await', 'yield', 'from', 'as', 'async']);
  const endsOperand = (t) => t.type === 'string' || (t.type === 'name' && !JOINING_KW.has(t.value)) || (t.type === 'op' && (isCloser(t) || /\d/.test(t.value)));
  const startsOperand = (t) => t.type === 'string' || (t.type === 'name' && !JOINING_KW.has(t.value)) || (t.type === 'op' && /\d/.test(t.value));
  // The logical statements of Python code, from its tokens: each is {first, last} (token indexes, comments left out),
  // the brackets left open at its end, and its first line's indentation. Inside brackets the statement goes on over
  // lines of any indentation, as in Python, except that a line not indented past the statement ends it when it starts
  // with a statement keyword or puts an operand right after an operand (`print("a"` then `x = 1`), so an unclosed call
  // does not swallow the statements below it, the way PyCharm's parser recovers.
  function statements(text, tokens) {
    const out = [];
    let cur = null;
    let stack = [];
    let prev = null;
    const close = () => { if (cur) { cur.open = stack; out.push(cur); } stack = []; cur = null; };
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === 'comment') continue;
      const newLine = !prev || (text.slice(prev.end, t.start).includes('\n') && !(prev.type === 'op' && prev.value === '\\'));
      if (newLine && stack.length && cur && !isCloser(t) && leading(text, lineStartAt(text, t.start)).length <= cur.indent.length
        && ((t.type === 'name' && STATEMENT_KW.has(t.value)) || (endsOperand(prev) && startsOperand(t)))) close();
      if (!cur || (newLine && !stack.length) || (prev?.type === 'op' && prev.value === ';' && !stack.length)) {
        close();
        cur = { first: k, last: k, indent: leading(text, lineStartAt(text, t.start)) };
      }
      cur.last = k;
      if (t.type === 'op') {
        if (OPENERS[t.value]) stack.push(t.value);
        else if (isCloser(t) && stack.length) stack.pop();
      }
      prev = t;
    }
    close();
    return out;
  }

  const COMPOUND = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class']);
  // Complete Current Statement at `offset`: {at, insert, end, indent, block} inserts `insert` at `at` (the closing
  // quote and brackets the statement lacks, then `:` for a compound statement, `():` for `def name`) and opens a new
  // line after `end` with `indent` (one level deeper when `block`), or null when the caret is in no statement.
  function statementCompletion(text, offset) {
    const tokens = tokenize(text);
    const lineStart = lineStartAt(text, offset);
    const lineEnd = lineEndAt(text, offset);
    if (tokens.some((t) => t.type === 'string' && t.start < lineStart && t.end > lineEnd)) return null;
    const stmt = statements(text, tokens).findLast((s) => tokens[s.first].start <= lineEnd);
    if (!stmt || tokens[stmt.last].end < lineStart) return null;
    const own = tokens.slice(stmt.first, stmt.last + 1).filter((t) => t.type !== 'comment');
    const last = own.at(-1);
    let insert = last.type === 'string' && !last.triple && last.end === last.contentEnd ? last.quote : '';
    insert += [...stmt.open].reverse().map((o) => OPENERS[o]).join('');
    const isAsync = own[0].type === 'name' && own[0].value === 'async';
    const kw = own[isAsync ? 1 : 0]?.type === 'name' ? own[isAsync ? 1 : 0].value : '';
    let depth = 0;
    let colon = false;
    for (const t of own) {
      if (t.type !== 'op') continue;
      if (OPENERS[t.value]) depth++;
      else if (isCloser(t)) depth--;
      else if (t.value === ':' && depth === 0 && text[t.start + 1] !== '=') colon = true;
    }
    let block = last.type === 'op' && last.value === ':' && !stmt.open.length;
    if (COMPOUND.has(kw) && !colon) {
      if (kw === 'def' && own.length === 2 + isAsync && own.at(-1).type === 'name') insert += '()';
      insert += ':';
      block = true;
    }
    return { at: last.end, insert, end: lineEndAt(text, last.end), indent: stmt.indent, block };
  }

  function completeCurrentStatement(ed = ide.editor) {
    if (!editable(ed)) return;
    acceptSuggestion(ed);
    const model = ed.getModel();
    const c = isPython(model) && model.getValueLength() < 2_000_000 ? statementCompletion(model.getValue(), model.getOffsetAt(ed.getPosition())) : null;
    if (!c) return startNewLine(ed);
    const indent = c.indent + (c.block ? unitOf(model) : '');
    const at = model.getPositionAt(c.at);
    const end = model.getPositionAt(c.end);
    const newLine = model.getEOL() + indent;
    const edits = c.at === c.end ? [{ range: Range.fromPositions(at), text: c.insert + newLine }]
      : [{ range: Range.fromPositions(at), text: c.insert }, { range: Range.fromPositions(end), text: newLine }];
    const caret = new Selection(end.lineNumber + 1, indent.length + 1, end.lineNumber + 1, indent.length + 1);
    ed.pushUndoStop();
    ed.executeEdits('pyide.completeStatement', edits, [caret]);
    ed.pushUndoStop();
    ed.revealPosition(caret.getPosition());
  }

  // Python lines that continue the logical line above them: inside brackets, inside a string over several lines, or
  // after a backslash.
  function continuationLines(text, lineCount) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const lineOf = (o) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= o) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const cont = new Uint8Array(lineCount + 1);
    const mark = (a, b) => { for (let l = a + 1; l <= b && l < cont.length; l++) cont[l] = 1; };
    const stack = [];
    for (const t of tokenize(text)) {
      if (t.type === 'string') mark(lineOf(t.start), lineOf(Math.max(t.start, t.end - 1)));
      else if (t.type === 'op' && OPENERS[t.value]) stack.push(t.start);
      else if (isCloser(t) && stack.length) mark(lineOf(stack.pop()), lineOf(t.start));
      else if (t.type === 'op' && t.value === '\\') mark(lineOf(t.start), lineOf(t.start) + 1);
    }
    return cont;
  }

  const CLAUSE = /^(?:elif|else|except|finally)\b/;
  // Move Statement Up/Down (0-based `line`, dir -1 or 1): the statement at the line, with its decorators, the comment
  // lines right above it, its block and its elif/else/except/finally clauses, trades places with the neighbouring
  // statement of the same block; the blank lines between them stay where they are. {from, to, lines, upper, lower}
  // replaces lines from..to, where `upper` and `lower` ([first, last]) are the two statements that trade places; false at
  // the edge of the block; null on a blank or comment line.
  function statementMove(text, line, dir) {
    const lines = text.split(/\r?\n/);
    const cont = continuationLines(text, lines.length);
    const blank = (l) => !lines[l].trim();
    const comment = (l) => !cont[l] && lines[l].trim().startsWith('#');
    const indent = (l) => /^[ \t]*/.exec(lines[l])[0].length;
    const code = (l) => !blank(l) && !comment(l) && !cont[l];
    let at = line;
    while (at > 0 && cont[at]) at--;
    if (!code(at)) return null;
    const ind = indent(at);
    let top = at;
    while (top > 0 && !(code(top - 1) && indent(top - 1) < ind)) top--;
    let bottom = at;
    while (bottom < lines.length - 1 && !(code(bottom + 1) && indent(bottom + 1) < ind)) bottom++;
    const starts = [];
    for (let l = top; l <= bottom; l++) {
      if (!code(l) || indent(l) !== ind) continue;
      const prev = starts.at(-1);
      if (prev && (CLAUSE.test(lines[l].trim()) || lines[prev.head].trim().startsWith('@'))) { prev.head = l; continue; }
      let first = l;
      while (first - 1 >= top && comment(first - 1)) first--;
      starts.push({ first, head: l });
    }
    const ranges = starts.map((s, i) => {
      let last = i + 1 < starts.length ? starts[i + 1].first - 1 : bottom;
      while (last > s.first && (blank(last) || (comment(last) && indent(last) <= ind))) last--;
      return [s.first, last];
    });
    const i = ranges.findIndex(([a, b]) => a <= line && line <= b);
    if (i < 0) return null;
    const j = i + dir;
    if (j < 0 || j >= ranges.length) return false;
    const [a, b] = dir < 0 ? [ranges[j], ranges[i]] : [ranges[i], ranges[j]];
    const moved = [...lines.slice(b[0], b[1] + 1), ...lines.slice(a[1] + 1, b[0]), ...lines.slice(a[0], a[1] + 1)];
    return { from: a[0], to: b[1], lines: moved, upper: a, lower: b };
  }

  // Where 0-based line `l` is after the move `m`: the upper statement ends where the lower one ended, the lower one
  // starts where the upper one started, the blank lines between them shift by the difference in length.
  function lineAfterMove(m, l) {
    const [[a0, a1], [b0, b1]] = [m.upper, m.lower];
    if (l < a0 || l > b1) return l;
    if (l <= a1) return l + b1 - a1;
    if (l >= b0) return l - b0 + a0;
    return l + (b1 - b0) - (a1 - a0);
  }

  function moveStatement(dir, ed = ide.editor) {
    if (!editable(ed)) return;
    const model = ed.getModel();
    const pos = ed.getPosition();
    const m = isPython(model) && model.getValueLength() < 2_000_000 ? statementMove(model.getValue(), pos.lineNumber - 1, dir) : null;
    if (m === false) return;
    if (!m) return ed.trigger('keymap', dir < 0 ? 'editor.action.moveLinesUpAction' : 'editor.action.moveLinesDownAction', null);
    const range = new Range(m.from + 1, 1, m.to + 1, model.getLineMaxColumn(m.to + 1));
    const after = (lineNumber) => lineAfterMove(m, lineNumber - 1) + 1;
    const sels = ed.getSelections().map((s) => new Selection(after(s.selectionStartLineNumber), s.selectionStartColumn, after(s.positionLineNumber), s.positionColumn));
    ed.pushUndoStop();
    ed.executeEdits('pyide.moveStatement', [{ range, text: m.lines.join(model.getEOL()) }], sels);
    ed.pushUndoStop();
    ed.revealLine(after(pos.lineNumber));
  }

  // PyCharm's Toggle Case: upper case unless the text (the selection, else the word at the caret) has no lower case.
  function toggleCase(ed = ide.editor) {
    if (!editable(ed)) return;
    const model = ed.getModel();
    const sel = ed.getSelection();
    const text = sel.isEmpty() ? model.getWordAtPosition(sel.getPosition())?.word || '' : model.getValueInRange(sel);
    ed.trigger('keymap', /\p{Ll}/u.test(text) ? 'editor.action.transformToUppercase' : 'editor.action.transformToLowercase', null);
  }

  const editorActions = [
    { id: 'EditorStartNewLine', title: tr('Start New Line'), keys: 'Shift+Enter', run: () => startNewLine() },
    { id: 'EditorStartNewLineBefore', title: tr('Start New Line Before Current'), keys: 'Ctrl+Alt+Enter', run: trigger('editor.action.insertLineBefore') },
    { id: 'EditorCompleteStatement', title: tr('Complete Current Statement'), keys: 'Ctrl+Shift+Enter', run: () => completeCurrentStatement() },
    { id: 'EditorJoinLines', title: tr('Join Lines'), keys: 'Ctrl+Shift+J', run: trigger('editor.action.joinLines') },
    { id: 'EditorToggleCase', title: tr('Toggle Case'), keys: 'Ctrl+Shift+U', run: () => toggleCase() },
    { id: 'SelectNextOccurrence', title: tr('Add Selection for Next Occurrence'), keys: 'Alt+J', run: trigger('editor.action.addSelectionToNextFindMatch') },
    { id: 'UnselectPreviousOccurrence', title: tr('Unselect Occurrence'), keys: 'Alt+Shift+J', run: trigger('cursorUndo') },
    { id: 'SelectAllOccurrences', title: tr('Select All Occurrences'), keys: 'Ctrl+Alt+Shift+J', run: trigger('editor.action.selectHighlights') },
    { id: 'MoveStatementUp', title: tr('Move Statement Up'), keys: 'Ctrl+Shift+ArrowUp', run: () => moveStatement(-1) },
    { id: 'MoveStatementDown', title: tr('Move Statement Down'), keys: 'Ctrl+Shift+ArrowDown', run: () => moveStatement(1) },
    { id: 'CollapseAllRegions', title: tr('Collapse All'), keys: 'Ctrl+Shift+-', run: trigger('editor.foldAll') },
    { id: 'ExpandAllRegions', title: tr('Expand All'), keys: ['Ctrl+Shift+=', 'Ctrl+Shift++'], run: trigger('editor.unfoldAll') },
    { id: 'QuickImplementations', title: tr('Quick Definition'), keys: 'Ctrl+Shift+I', run: trigger('editor.action.peekDefinition') },
    { id: 'ExpressionTypeInfo', title: tr('Type Info'), keys: 'Ctrl+Shift+P', run: trigger('editor.action.showHover') },
  ];
  for (const a of editorActions) ide.registerAction({ context: 'editor', when: inEditor, ...a });

  // ---------- docstrings ----------
  const DOC_FORMATS = ['restructuredtext', 'google', 'numpy', 'plain'];
  // Settings › Python Integrated Tools › Docstrings (python.docstringFormat), shared with AI Write Documentation; on
  // Auto-detect the file's own docstrings decide, else reStructuredText, PyCharm's default.
  function docstringFormat(text) {
    const set = ide.settings.get('python.docstringFormat', '');
    if (DOC_FORMATS.includes(set)) return set;
    if (/^[ \t]*(?:Parameters|Returns|Yields|Raises)[ \t]*\r?\n[ \t]*-{3,}[ \t]*$/m.test(text)) return 'numpy';
    if (/^[ \t]*(?:Args|Arguments|Returns|Yields|Raises):[ \t]*\r?\n[ \t]+\S/m.test(text)) return 'google';
    return 'restructuredtext';
  }

  // The stub's lines below the opening quotes, without the docstring's indentation; the caret goes on the first one.
  function docstringBody(format, params, returns, unit = '    ') {
    if (format === 'plain' || (!params.length && !returns)) return [''];
    if (format === 'restructuredtext') return ['', ...params.map((p) => `:param ${p.name}:`), ...(returns ? [':return:'] : [])];
    const sections = format === 'google'
      ? [params.length && ['Args:', ...params.map((p) => `${unit}${p.stars}${p.name}:`)], returns && ['Returns:']]
      : [params.length && ['Parameters', '----------', ...params.map((p) => p.name)], returns && ['Returns', '-------']];
    return ['', ...sections.filter(Boolean).flatMap((s) => ['', ...s])];
  }

  // The def or class whose header (over one or more lines) ends on the line before `lineStart`: {kind, params,
  // returns}, or null when that line ends no header, so the docstring would not open a body.
  // As PyCharm's stub, a function gets a return entry unless it is __init__ or annotated `-> None`.
  const HEADER = /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([\p{ID_Start}_][\p{ID_Continue}]*)/u;
  function headerAbove(text, lineStart, bodyIndent) {
    const lines = text.slice(0, Math.max(0, lineStart - 1)).split('\n');
    for (let k = lines.length - 1; k >= Math.max(0, lines.length - 40); k--) {
      const m = HEADER.exec(lines[k]);
      if (!m) continue;
      if (m[1].length >= bodyIndent) return null;
      const header = lines.slice(k).join('\n');
      const toks = tokenize(header).filter((t) => t.type !== 'comment');
      const last = toks.at(-1);
      let depth = 0;
      let open = -1;
      let close = -1;
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.type !== 'op') continue;
        if (OPENERS[t.value] && depth++ === 0 && open < 0) open = i;
        else if (isCloser(t) && --depth === 0 && close < 0 && open >= 0) close = i;
        else if (t.value === ':' && depth === 0 && t !== last) return null;
      }
      if (!(last?.type === 'op' && last.value === ':') || depth !== 0) return null;
      if (m[2] === 'class' || open < 0 || close < 0) return { kind: m[2], params: [], returns: false };
      const segments = [];
      let segStart = toks[open].end;
      depth = 0;
      for (let i = open + 1; i < close; i++) {
        const t = toks[i];
        if (t.type !== 'op') continue;
        if (OPENERS[t.value]) depth++;
        else if (isCloser(t)) depth--;
        else if (t.value === ',' && depth === 0) { segments.push(header.slice(segStart, t.start)); segStart = t.end; }
      }
      segments.push(header.slice(segStart, toks[close].start));
      const params = segments.map((s) => /^\s*(\**)\s*([\p{ID_Start}_][\p{ID_Continue}]*)/u.exec(s))
        .filter(Boolean).map((p) => ({ stars: p[1], name: p[2] }));
      if (params[0] && !params[0].stars && (params[0].name === 'self' || params[0].name === 'cls')) params.shift();
      const ann = /->\s*([\s\S]*?)\s*$/.exec(header.slice(toks[close].end, last.start));
      return { kind: 'def', params, returns: m[3] !== '__init__' && ann?.[1] !== 'None' };
    }
    return null;
  }

  // `"""` (or `'''`) typed where a string may start, with nothing but the quotes Monaco paired after it, gets its
  // closing quotes, as PyCharm's smart quotes do. Not when it closes a string that is already open, or in a comment.
  function closeTripleQuote(ed) {
    const model = ed.getModel();
    const sels = ed.getSelections();
    if (!isPython(model) || !editable(ed) || sels?.length !== 1 || !sels[0].isEmpty()) return false;
    const pos = sels[0].getPosition();
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    const after = line.slice(pos.column - 1);
    const q = before.at(-1);
    if ((q !== '"' && q !== "'") || !before.endsWith(q.repeat(3)) || before.endsWith(q.repeat(4)) || after.length > 2 || [...after].some((c) => c !== q)) return false;
    const start = model.getOffsetAt(pos) - 3;
    const last = tokenize(model.getValue().slice(0, start)).at(-1);
    if (last && ((last.type === 'string' && last.end === last.contentEnd) || (last.type === 'comment' && last.end === start))) return false;
    ed.executeEdits('pyide.closeQuotes', [{ range: new Range(pos.lineNumber, pos.column, pos.lineNumber, line.length + 1), text: q.repeat(3) }], [sels[0]]);
    return true;
  }

  // The third quote of a typed `"""` that closes the open string drops the closing quotes right after the caret (the
  // ones closeTripleQuote added, or any others), so `"""Summary"""` typed in full stays as typed, as in PyCharm.
  // Monaco overtypes only the quotes it paired itself.
  function overtypeTripleQuote(ed) {
    const model = ed.getModel();
    const sels = ed.getSelections();
    if (!isPython(model) || !editable(ed) || sels?.length !== 1 || !sels[0].isEmpty()) return false;
    const pos = sels[0].getPosition();
    const line = model.getLineContent(pos.lineNumber);
    const q = line[pos.column - 2];
    if ((q !== '"' && q !== "'") || !line.startsWith(q.repeat(3), pos.column - 1)) return false;
    const caret = model.getOffsetAt(pos);
    const last = tokenize(model.getValue().slice(0, caret)).at(-1);
    if (last?.type !== 'string' || !last.triple || last.quote !== q || last.end !== caret || last.contentEnd === last.end) return false;
    ed.executeEdits('pyide.overtypeQuotes', [{ range: new Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column + 3), text: '' }], [sels[0]]);
    return true;
  }

  // Enter between fresh quotes on the first line of a def or class body: the stub in the docstring format.
  function insertDocstringStub(ed) {
    const model = ed.getModel();
    const sels = ed.getSelections();
    if (get(DOC_STUB) === false || !isPython(model) || !editable(ed) || sels?.length !== 1 || !sels[0].isEmpty()) return false;
    const pos = sels[0].getPosition();
    if (pos.lineNumber < 2) return false;
    const line = model.getLineContent(pos.lineNumber);
    const open = /^([ \t]*)[rRuU]?("""|''')[ \t]*$/.exec(model.getLineContent(pos.lineNumber - 1));
    if (!open || line.slice(0, pos.column - 1).trim() || line.slice(pos.column - 1).trim() !== open[2]) return false;
    const text = model.getValue();
    const head = headerAbove(text, model.getOffsetAt({ lineNumber: pos.lineNumber - 1, column: 1 }), open[1].length);
    if (!head) return false;
    const body = docstringBody(docstringFormat(text), head.params, head.returns, unitOf(model));
    const ind = open[1];
    const stub = [...body.map((s, i) => (s || i === 0 ? ind + s : s)), ind + open[2]].join(model.getEOL());
    ed.pushUndoStop();
    ed.executeEdits('pyide.docstringStub', [{ range: new Range(pos.lineNumber, 1, pos.lineNumber, line.length + 1), text: stub }],
      [new Selection(pos.lineNumber, ind.length + 1, pos.lineNumber, ind.length + 1)]);
    ed.pushUndoStop();
    return true;
  }

  // onDidType fires for typed text only (keys, IME), not for pastes, undo or edits other features make.
  ide.onEditor((ed) => {
    if (typeof ed.onDidType !== 'function') return;
    ed.onDidType((typed) => {
      if (typed.endsWith('}')) convertAtCaret(ed);
      else if (typed.endsWith('"') || typed.endsWith("'")) overtypeTripleQuote(ed) || closeTripleQuote(ed);
      else if (typed.endsWith('\n')) insertDocstringStub(ed);
    });
  });

  (ide.settingsPages ||= []).push({
    id: 'smart-keys', group: 'editor', title: () => tr('Smart Keys'), defaults: DEFAULTS,
    keywords: 'smart keys python f-string format string convert automatically brace docstring stub documentation comment 스마트 키 f-문자열 자동 변환 중괄호 독스트링 문서 주석 스텁',
    mount(host, ctx) {
      const s = ctx.ui.section(host, 'Python');
      s.appendChild(ctx.ui.checkbox(FSTRING, tr('Convert to f-string automatically')));
      s.appendChild(ide.util.el('div', 'muted settings-note',
        tr('Typing a closing brace after a name in a plain string literal, as in "Hello {name}", adds the f prefix. Undo removes the prefix only.')));
      s.appendChild(ctx.ui.checkbox(DOC_STUB, tr('Insert documentation comment stub')));
      s.appendChild(ide.util.el('div', 'muted settings-note',
        tr('Enter after the opening triple quotes of a docstring adds the parameters and return value of the function, in the format set under Python Integrated Tools › Docstrings.')));
    },
  });

  ide.editorAssists = {
    stickyOptions, refreshSticky, fstringInsertAt, convertAtCaret, statementCompletion, statementMove, docstringBody, docstringFormat,
    keys: { STICKY, STICKY_MAX, FSTRING, DOC_STUB },
  };
})();
