// Live templates and postfix completion for Python, as in PyCharm's Editor › Live Templates and Postfix Completion.
// An abbreviation followed by Tab (or picked from the completion list) expands into a Monaco snippet; `expr.key` after an
// expression rewrites the expression with a postfix template; Ctrl+Alt+J wraps the selection in a template.
(() => {
  const monaco = ide.monaco;
  const { el } = ide.util;
  const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const CUSTOM = 'liveTemplates.custom'; // {abbr: {description?, body?, enabled?}}: edits of built-ins and user templates
  const POSTFIX_OFF = 'liveTemplates.postfixDisabled'; // [key]

  // Built-in templates in PyCharm's syntax: $NAME$ is a variable (its default comes from vars), $END$ the final caret,
  // $SELECTION$ the text Surround With wraps, $$ a literal dollar. Bodies indent with a tab, which Monaco turns into the
  // file's indentation.
  const LOGGING = { line: 'import logging', test: /^\s*import\s+logging\b/m };
  const DATACLASS = { line: 'from dataclasses import dataclass', test: /^\s*from\s+dataclasses\s+import\s+.*\bdataclass\b/m };
  const BUILTIN = [
    { abbr: 'main', description: tr('if __name__ == "__main__"'), body: 'if __name__ == "__main__":\n\t$SELECTION$$END$' },
    { abbr: 'iter', description: tr('Iterate over an iterable (for … in …)'), body: 'for $VAR$ in $ITERABLE$:\n\t$SELECTION$$END$', vars: { VAR: 'item', ITERABLE: 'items' } },
    { abbr: 'itere', description: tr('Iterate with enumerate'), body: 'for $INDEX$, $VAR$ in enumerate($ITERABLE$):\n\t$SELECTION$$END$', vars: { INDEX: 'i', VAR: 'item', ITERABLE: 'items' } },
    { abbr: 'compl', description: tr('List comprehension'), body: '[$EXPR$ for $VAR$ in $ITERABLE$]$END$', vars: { EXPR: 'x', VAR: 'x', ITERABLE: 'items' } },
    { abbr: 'compli', description: tr('List comprehension with a condition'), body: '[$EXPR$ for $VAR$ in $ITERABLE$ if $CONDITION$]$END$', vars: { EXPR: 'x', VAR: 'x', ITERABLE: 'items', CONDITION: 'x' } },
    { abbr: 'prop', description: tr('Property getter'), body: '@property\ndef $NAME$(self):\n\treturn self._$NAME$$END$', vars: { NAME: 'name' } },
    { abbr: 'super', description: tr('Call the superclass method'), body: 'super().$METHOD$($END$)', vars: { METHOD: '__init__' } },
    { abbr: 'defm', description: tr('Method'), body: 'def $NAME$(self$PARAMS$):\n\t$END$', vars: { NAME: 'method' } },
    { abbr: 'defs', description: tr('Static method'), body: '@staticmethod\ndef $NAME$($PARAMS$):\n\t$END$', vars: { NAME: 'method' } },
    { abbr: 'defc', description: tr('Class method'), body: '@classmethod\ndef $NAME$(cls$PARAMS$):\n\t$END$', vars: { NAME: 'method' } },
    { abbr: 'with', description: tr('with statement'), body: 'with $EXPR$ as $VAR$:\n\t$SELECTION$$END$', vars: { EXPR: 'open(path)', VAR: 'f' } },
    { abbr: 'try', description: tr('try / except'), body: 'try:\n\t$SELECTION$$END$\nexcept $EXCEPTION$ as e:\n\traise', vars: { EXCEPTION: 'Exception' } },
    { abbr: 'pt', description: tr('pytest test function'), body: 'def test_$NAME$():\n\t$END$', vars: { NAME: 'name' } },
    { abbr: 'dataclass', description: tr('Data class'), body: '@dataclass\nclass $NAME$:\n\t$FIELD$: $TYPE$$END$', vars: { NAME: 'Name', FIELD: 'name', TYPE: 'str' }, imports: [DATACLASS] },
    { abbr: 'fstr', description: tr('f-string'), body: 'f"{$EXPR$}$END$"', vars: { EXPR: 'value' } },
    { abbr: 'log', description: tr('Module logger'), body: 'logger = logging.getLogger(__name__)$END$', imports: [LOGGING] },
  ];
  const BUILTIN_BY_ABBR = new Map(BUILTIN.map((t) => [t.abbr, t]));
  const ABBR = /^[A-Za-z_][A-Za-z0-9_]*$/;

  // ---------- template text -> Monaco snippet ----------
  const esc = (s) => s.replace(/[\\$}]/g, '\\$&');
  // selection: text that replaces $SELECTION$ (already indented for the template line it sits on).
  function toSnippet(t, selection = '') {
    const order = new Map();
    return t.body.replace(/\$\$|\$([A-Za-z_]\w*)\$|[\\}$]/g, (m, name) => {
      if (!name) return `\\${m === '$$' ? '$' : m}`;
      if (name === 'END') return '$0';
      if (name === 'SELECTION') return esc(selection);
      if (!order.has(name)) order.set(name, order.size + 1);
      return `\${${order.get(name)}:${esc(t.vars?.[name] ?? '')}}`;
    });
  }
  // What a snippet looks like once expanded with its defaults, for the completion list's preview.
  const previewOf = (snippet) => snippet
    .replace(/\$\{\d+:((?:\\.|[^\\}])*)\}/g, '$1').replace(/\$\d+/g, '').replace(/\\(.)/g, '$1').replace(/\t/g, '    ');
  const codeDoc = (text) => ({ value: '```python\n' + text + '\n```' });

  // ---------- effective templates ----------
  let templates = [];
  let byAbbr = new Map();
  let postfixOff = new Set();
  function merge(custom) {
    const out = BUILTIN.map((b) => {
      const c = Object.hasOwn(custom, b.abbr) ? custom[b.abbr] : {};
      return { ...b, builtin: true, body: c.body ?? b.body, description: c.description ?? b.description, enabled: c.enabled ?? true, modified: c.body != null || c.description != null };
    });
    for (const [abbr, c] of Object.entries(custom)) {
      if (!BUILTIN_BY_ABBR.has(abbr)) out.push({ abbr, builtin: false, body: c.body || '', description: c.description || '', enabled: c.enabled ?? true });
    }
    return out;
  }
  function reload() {
    templates = merge(ide.settings.get(CUSTOM, {}) || {});
    byAbbr = new Map(templates.filter((t) => t.enabled).map((t) => [t.abbr, t]));
    postfixOff = new Set(ide.settings.get(POSTFIX_OFF, []) || []);
  }
  reload();
  ide.on('settingsChanged', (key) => { if (key === CUSTOM || key === POSTFIX_OFF) reload(); });

  // ---------- context: code, string or comment ----------
  // A lightweight Python scan from the top of the file to pos: comments, '…', "…", '''…''' and """…""" (with escapes).
  function contextAt(model, pos) {
    const text = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: pos.column });
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === '#') {
        const nl = text.indexOf('\n', i);
        if (nl < 0) return 'comment';
        i = nl + 1;
      } else if (c === '"' || c === "'") {
        const q = text.startsWith(c + c + c, i) ? c + c + c : c;
        i += q.length;
        for (;;) {
          if (i >= n) return 'string';
          if (text[i] === '\\') i += 2;
          else if (q.length === 1 && text[i] === '\n') { i++; break; }
          else if (text.startsWith(q, i)) { i += q.length; break; }
          else i++;
        }
      } else i++;
    }
    return 'code';
  }

  // ---------- postfix: the expression left of the dot ----------
  const IDENT = /[\p{L}\p{N}_]/u;
  const PREFIX = /[rRbBuUfF]/;
  // Index where the string literal that ends at line[end] (its closing quote) starts, prefix letters included.
  function stringStart(line, end) {
    const c = line[end];
    const triple = end >= 2 && line[end - 1] === c && line[end - 2] === c && line.lastIndexOf(c + c + c, end - 3) >= 0;
    const q = triple ? c + c + c : c;
    let j = end - q.length;
    for (;;) {
      j = line.lastIndexOf(q, j);
      if (j < 0) return -1;
      let slashes = 0;
      while (line[j - 1 - slashes] === '\\') slashes++;
      if (slashes % 2 === 0) break;
      j--;
    }
    let k = j;
    while (k > 0 && j - k < 2 && PREFIX.test(line[k - 1])) k--;
    return k > 0 && IDENT.test(line[k - 1]) ? j : k;
  }
  const OPEN = { ')': '(', ']': '[', '}': '{' };
  function matchOpen(line, end) {
    const stack = [];
    for (let j = end; j >= 0; j--) {
      const c = line[j];
      if (c === '"' || c === "'") { j = stringStart(line, j); if (j < 0) return -1; continue; }
      if (OPEN[c]) stack.push(OPEN[c]);
      else if (c === '(' || c === '[' || c === '{') {
        if (stack.pop() !== c) return -1;
        if (!stack.length) return j;
      }
    }
    return -1;
  }
  // Start index of the expression that ends right before line[dot]: names, attribute access, calls, subscripts,
  // bracketed groups and string literals, scanned back without leaving the line. -1 when there is none.
  function exprStart(line, dot) {
    let i = dot;
    while (i > 0) {
      const c = line[i - 1];
      if (IDENT.test(c)) i--;
      else if (c === '.' && i < dot && i > 1 && !/[\s.]/.test(line[i - 2])) i--;
      else if (OPEN[c]) { const j = matchOpen(line, i - 1); if (j < 0) return -1; i = j; }
      else if (c === '"' || c === "'") { const j = stringStart(line, i - 1); if (j < 0) return -1; i = j; }
      else break;
    }
    return i < dot ? i : -1;
  }

  const lastName = (expr) => /([\p{L}_][\p{L}\p{N}_]*)\s*$/u.exec(expr)?.[1] || '';
  function itemName(expr) {
    if (/^range\(/.test(expr)) return 'i';
    const name = lastName(expr);
    if (/ies$/.test(name) && name.length > 3) return name.slice(0, -3) + 'y';
    if (/(ss|us|is)$/.test(name)) return 'item';
    if (/s$/.test(name) && name.length > 1) return name.slice(0, -1);
    return 'item';
  }
  const isStringLiteral = (expr) => /^[rRbBuU]{0,2}("|')/.test(expr);
  // statement: only where the expression starts the line, as in PyCharm. body(e, expr) gets the escaped expression.
  const POSTFIX = [
    { key: 'if', description: tr('if expr'), statement: true, body: (e) => `if ${e}:\n\t$0` },
    { key: 'ifn', description: tr('if expr is None'), statement: true, body: (e) => `if ${e} is None:\n\t$0` },
    { key: 'nn', description: tr('if expr is not None'), statement: true, body: (e) => `if ${e} is not None:\n\t$0` },
    { key: 'not', description: tr('Negate the expression'), body: (e) => `not ${e}$0` },
    { key: 'for', description: tr('Iterate over the expression'), statement: true, body: (e, x) => `for \${1:${itemName(x)}} in ${e}:\n\t$0` },
    { key: 'enum', description: tr('Iterate with enumerate'), statement: true, body: (e, x) => `for \${1:i}, \${2:${itemName(x)}} in enumerate(${e}):\n\t$0` },
    { key: 'print', description: tr('Print the expression'), body: (e) => `print(${e})$0` },
    { key: 'return', description: tr('Return the expression'), statement: true, body: (e) => `return ${e}$0` },
    { key: 'len', description: tr('Length of the expression'), body: (e) => `len(${e})$0` },
    { key: 'par', description: tr('Parenthesize the expression'), body: (e) => `(${e})$0` },
    { key: 'with', description: tr('Use as a context manager'), statement: true, body: (e) => `with ${e} as \${1:f}:\n\t$0` },
    { key: 'try', description: tr('Wrap in try / except'), statement: true, body: (e) => `try:\n\t${e}\nexcept \${1:Exception} as e:\n\t\${0:raise}` },
    { key: 'main', description: tr('Run under if __name__ == "__main__"'), statement: true, body: (e) => `if __name__ == "__main__":\n\t${e}$0` },
    { key: 'f', description: tr('Make an f-string'), body: (e, x) => (isStringLiteral(x) ? `f${e}$0` : /^[rR]?[fF][rR]?["']/.test(x) ? null : `f"{${e}}$0"`) },
  ];
  const POSTFIX_BY_KEY = new Map(POSTFIX.map((p) => [p.key, p]));

  // ---------- what is at the caret ----------
  // {kind: 'template', tpl, start} or {kind: 'postfix', start, expr, statement} for the word that ends at the caret;
  // partial: the word may be the beginning of an abbreviation or key (for the completion list).
  function wordAt(model, pos) {
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    const m = /[\p{L}\p{N}_]*$/u.exec(before);
    const word = m[0];
    const start = before.length - word.length;
    if (IDENT.test(line[pos.column - 1] || '')) return null; // mid-word
    if (before[start - 1] === '.') {
      const dot = start - 1;
      const e = exprStart(line, dot);
      if (e < 0) return null;
      const expr = line.slice(e, dot);
      return { kind: 'postfix', word, start: e, dot, expr, statement: !line.slice(0, e).trim() };
    }
    if (!word || /^\d/.test(word)) return null;
    return { kind: 'template', word, start };
  }
  const isPython = (model) => model && !model.isDisposed() && model.getLanguageId() === 'python';
  // The exact template or postfix template that Tab would expand at the caret, or null.
  function candidateAt(editor) {
    const model = editor.getModel();
    const sels = editor.getSelections();
    if (!isPython(model) || !sels || sels.length !== 1 || !sels[0].isEmpty()) return null;
    const pos = sels[0].getPosition();
    const w = wordAt(model, pos);
    if (!w) return null;
    if (w.kind === 'template') {
      const tpl = byAbbr.get(w.word);
      if (!tpl) return null;
      if (contextAt(model, { lineNumber: pos.lineNumber, column: w.start + 1 }) !== 'code') return null;
      return { ...w, tpl };
    }
    const p = POSTFIX_BY_KEY.get(w.word);
    if (!p || postfixOff.has(p.key) || (p.statement && !w.statement)) return null;
    if (contextAt(model, { lineNumber: pos.lineNumber, column: w.dot + 1 }) !== 'code') return null;
    const snippet = p.body(esc(w.expr), w.expr);
    return snippet == null ? null : { ...w, postfix: p, snippet };
  }

  // Import lines a template needs and the file lacks, inserted after the imports at the top of the file.
  function importEdits(model, imports) {
    const text = model.getValue();
    const missing = (imports || []).filter((i) => !i.test.test(text));
    if (!missing.length) return [];
    let after = 0;
    for (let n = 1; n <= model.getLineCount(); n++) {
      const l = model.getLineContent(n);
      if (/^(import|from)\s/.test(l)) after = n;
      else if (l.trim() && !l.startsWith('#')) break;
    }
    const text2 = missing.map((i) => i.line).join('\n');
    return after
      ? [{ range: new monaco.Range(after, model.getLineMaxColumn(after), after, model.getLineMaxColumn(after)), text: '\n' + text2 }]
      : [{ range: new monaco.Range(1, 1, 1, 1), text: text2 + '\n\n' }];
  }

  const snippetController = (editor) => editor.getContribution('snippetController2');
  function insertSnippet(editor, snippet, range, imports) {
    editor.trigger('live-templates', 'hideSuggestWidget', {});
    editor.pushUndoStop();
    const model = editor.getModel();
    const deco = model.deltaDecorations([], [{ range, options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
    const edits = importEdits(model, imports);
    if (edits.length) editor.executeEdits('live-templates', edits);
    const target = model.getDecorationRange(deco[0]) || range;
    model.deltaDecorations(deco, []);
    editor.setSelection(target);
    snippetController(editor).insert(snippet, { undoStopBefore: false });
    editor.focus();
  }

  function expand(editor) {
    const c = candidateAt(editor);
    if (!c) return false;
    const line = editor.getPosition().lineNumber;
    const range = new monaco.Range(line, c.start + 1, line, editor.getPosition().column);
    if (c.kind === 'template') insertSnippet(editor, toSnippet(c.tpl), range, c.tpl.imports);
    else insertSnippet(editor, c.snippet, range);
    return true;
  }

  // ---------- Surround With (Ctrl+Alt+J) ----------
  async function surround(editor, abbr) {
    const model = editor.getModel();
    if (!isPython(model)) return false;
    const sel = editor.getSelection();
    let first = sel.startLineNumber;
    let last = sel.endLineNumber;
    if (last > first && sel.endColumn === 1) last--;
    const choices = templates.filter((t) => t.enabled && t.body.includes('$SELECTION$'));
    let tpl = abbr ? choices.find((t) => t.abbr === abbr) : null;
    if (!tpl) {
      tpl = await ide.ui.pick({
        placeholder: tr('Surround With Live Template'),
        items: choices.map((t) => ({ label: t.abbr, detail: t.description, value: t })),
      });
    }
    if (!tpl) return false;
    const lines = [];
    for (let n = first; n <= last; n++) lines.push(model.getLineContent(n));
    const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length);
    const base = indents.length ? Math.min(...indents) : 0;
    const lead = /^([ \t]*).*\$SELECTION\$/m.exec(tpl.body)?.[1] ?? '';
    const selection = lines.map((l, i) => (i ? (l.trim() ? lead : '') : '') + l.slice(base)).join('\n');
    const range = new monaco.Range(first, base + 1, last, model.getLineMaxColumn(last));
    insertSnippet(editor, toSnippet(tpl, selection), range, tpl.imports);
    return true;
  }

  // ---------- editors: Tab expands ----------
  const editors = new Map(); // editor -> recompute its liveTemplateAtCaret context key
  const focused = () => [...editors.keys()].find((e) => e.hasTextFocus()) || null;
  ide.onEditor((editor) => {
    const key = editor.createContextKey('liveTemplateAtCaret', false);
    const update = () => key.set(!!candidateAt(editor));
    editors.set(editor, update);
    editor.onDidChangeCursorPosition(update);
    editor.onDidChangeModel(update);
    editor.onDidDispose(() => editors.delete(editor));
  });
  ide.on('settingsChanged', (k) => { if (k === CUSTOM || k === POSTFIX_OFF) for (const update of editors.values()) update(); });
  monaco.editor.addCommand({ id: 'liveTemplates.expand', run: () => { const e = focused(); if (e) expand(e); } });
  // Tab expands an exact abbreviation even while the suggest widget shows (as in PyCharm); visible ghost text and an
  // active snippet keep Tab.
  monaco.editor.addKeybindingRules([{
    keybinding: monaco.KeyCode.Tab, command: 'liveTemplates.expand',
    when: 'liveTemplateAtCaret && editorTextFocus && !editorReadonly && !inlineSuggestionVisible && !inSnippetMode && !editorTabMovesFocus',
  }]);

  ide.registerAction({
    id: 'SurroundWithLiveTemplate', title: tr('Surround With Live Template…'), keys: 'Ctrl+Alt+J',
    when: () => isPython(focused()?.getModel()),
    run: () => { const e = focused(); if (e) surround(e); },
  });

  // ---------- completion list ----------
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const w = wordAt(model, position);
      if (!w) return undefined;
      const K = monaco.languages.CompletionItemKind;
      const range = new monaco.Range(position.lineNumber, w.start + 1, position.lineNumber, position.column);
      if (w.kind === 'template') {
        if (contextAt(model, { lineNumber: position.lineNumber, column: w.start + 1 }) !== 'code') return undefined;
        const suggestions = [...byAbbr.values()].map((t) => {
          const snippet = toSnippet(t);
          return {
            label: { label: t.abbr, description: t.description }, kind: K.Snippet, detail: t.description, documentation: codeDoc(previewOf(snippet)),
            insertText: snippet, insertTextRules: SNIPPET, range, filterText: t.abbr, sortText: `~${t.abbr}`,
            additionalTextEdits: importEdits(model, t.imports),
          };
        });
        return { suggestions };
      }
      if (contextAt(model, { lineNumber: position.lineNumber, column: w.dot + 1 }) !== 'code') return undefined;
      const e = esc(w.expr);
      const suggestions = [];
      // The item replaces only the key after the dot and deletes `expr.` with an additional edit, so it is filtered and
      // ranked by the key like the members Pyright lists there, and sorts after them.
      const line = position.lineNumber;
      const keyRange = new monaco.Range(line, w.dot + 2, line, position.column);
      const dropExpr = [{ range: new monaco.Range(line, w.start + 1, line, w.dot + 2), text: '' }];
      for (const p of POSTFIX) {
        if (postfixOff.has(p.key) || (p.statement && !w.statement)) continue;
        const snippet = p.body(e, w.expr);
        if (snippet == null) continue;
        suggestions.push({
          label: { label: p.key, description: tr('postfix') }, kind: K.Snippet, detail: p.description,
          documentation: codeDoc(previewOf(snippet)), insertText: snippet, insertTextRules: SNIPPET, range: keyRange,
          additionalTextEdits: dropExpr, filterText: p.key, sortText: `~${p.key}`,
        });
      }
      return { suggestions };
    },
  });

  // ---------- Settings › Editor › Live Templates ----------
  function mountPage(host, ctx) {
    const custom = structuredClone(ctx.value(CUSTOM) || {});
    const off = new Set(ctx.value(POSTFIX_OFF) || []);
    const save = () => {
      for (const [abbr, c] of Object.entries(custom)) if (BUILTIN_BY_ABBR.has(abbr) && !Object.keys(c).length) delete custom[abbr];
      ctx.set(CUSTOM, structuredClone(custom));
    };
    let selected = BUILTIN[0].abbr;
    const s = ctx.ui.section(host, tr('Python'));
    const root = el('div', 'lt-page');
    const bar = el('div', 'lt-toolbar');
    const btn = (cls, text, title, run) => { const b = el('button', `secondary ${cls}`, text); b.title = title; b.onclick = run; bar.appendChild(b); return b; };
    const list = el('div', 'lt-list');
    const form = el('div', 'lt-form');
    root.append(bar, list, form);
    s.appendChild(root);

    const abbrIn = el('input', 'lt-abbr');
    const descIn = el('input', 'lt-desc');
    const bodyIn = el('textarea', 'lt-body');
    bodyIn.spellcheck = false;
    bodyIn.rows = 6;
    const row = (label, control) => { const r = el('label', 'lt-field'); r.append(el('span', null, label), control); return r; };
    form.append(row(tr('Abbreviation'), abbrIn), row(tr('Description'), descIn), row(tr('Template text'), bodyIn),
      el('div', 'field-hint muted', tr('$NAME$ is a variable the caret visits in order, $END$ is where the caret ends, and $SELECTION$ is the text that Surround With (Ctrl+Alt+J) wraps.')));

    const current = () => merge(custom).find((t) => t.abbr === selected);
    const entry = (abbr) => (custom[abbr] ||= {});
    btn('lt-add', '+', tr('Add Template'), () => {
      let n = 1;
      while (merge(custom).some((t) => t.abbr === `abbr${n}`)) n++;
      custom[`abbr${n}`] = { description: '', body: '', enabled: true };
      selected = `abbr${n}`;
      save();
      render();
      abbrIn.focus();
      abbrIn.select();
    });
    const removeBtn = btn('lt-remove', '−', tr('Remove Template'), () => {
      const t = current();
      if (!t || t.builtin) return;
      delete custom[t.abbr];
      selected = BUILTIN[0].abbr;
      save();
      render();
    });
    const resetBtn = btn('lt-reset', tr('Restore Default'), tr('Restore the built-in template text'), () => {
      const t = current();
      if (!t?.builtin) return;
      delete entry(t.abbr).body;
      delete entry(t.abbr).description;
      save();
      render();
    });

    abbrIn.onchange = () => {
      const t = current();
      const v = abbrIn.value.trim();
      const ok = ABBR.test(v) && (v === t.abbr || !merge(custom).some((x) => x.abbr === v));
      abbrIn.classList.toggle('invalid', !ok);
      if (!ok || t.builtin || v === t.abbr) return;
      custom[v] = custom[t.abbr];
      delete custom[t.abbr];
      selected = v;
      save();
      renderList();
    };
    descIn.oninput = () => {
      const t = current();
      if (t.builtin && descIn.value === BUILTIN_BY_ABBR.get(t.abbr).description) delete entry(t.abbr).description;
      else entry(t.abbr).description = descIn.value;
      save();
      renderList();
    };
    bodyIn.oninput = () => {
      const t = current();
      if (t.builtin && bodyIn.value === BUILTIN_BY_ABBR.get(t.abbr).body) delete entry(t.abbr).body;
      else entry(t.abbr).body = bodyIn.value;
      save();
      resetBtn.disabled = !current().modified;
    };

    function renderList() {
      list.replaceChildren();
      for (const t of merge(custom)) {
        const r = el('div', 'lt-row' + (t.abbr === selected ? ' selected' : ''));
        r.dataset.abbr = t.abbr;
        const c = el('input');
        c.type = 'checkbox';
        c.checked = t.enabled;
        c.onclick = (e) => e.stopPropagation();
        c.onchange = () => {
          if (t.builtin && c.checked) delete entry(t.abbr).enabled; else entry(t.abbr).enabled = c.checked;
          save();
        };
        r.append(c, el('span', 'lt-name', t.abbr), el('span', 'lt-row-desc muted', t.description));
        if (!t.builtin) r.appendChild(el('span', 'lt-tag muted', tr('user')));
        r.onclick = () => { selected = t.abbr; render(); };
        list.appendChild(r);
      }
    }
    function render() {
      renderList();
      const t = current();
      abbrIn.value = t.abbr;
      abbrIn.disabled = t.builtin;
      abbrIn.classList.remove('invalid');
      descIn.value = t.description;
      bodyIn.value = t.body;
      removeBtn.disabled = t.builtin;
      resetBtn.disabled = !t.modified;
    }
    render();

    const ps = ctx.ui.section(host, tr('Postfix Completion'));
    ps.appendChild(el('div', 'field-hint muted', tr('Type a dot and the key after an expression, then press Tab or pick it from the completion list.')));
    const plist = el('div', 'lt-postfix');
    for (const p of POSTFIX) {
      const r = el('label', 'lt-postfix-row');
      r.dataset.key = p.key;
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !off.has(p.key);
      c.onchange = () => {
        if (c.checked) off.delete(p.key); else off.add(p.key);
        ctx.set(POSTFIX_OFF, [...off]);
      };
      r.append(c, el('span', 'lt-name', `.${p.key}`), el('span', 'lt-row-desc muted', p.description));
      plist.appendChild(r);
    }
    ps.appendChild(plist);
  }
  (ide.settingsPages ||= []).push({
    id: 'live-templates', group: 'editor', title: () => tr('Live Templates'),
    keywords: 'live templates postfix completion snippet abbreviation surround tab 라이브 템플릿 후위 완성 약어 감싸기',
    defaults: { [CUSTOM]: {}, [POSTFIX_OFF]: [] },
    mount: mountPage,
  });

  ide.liveTemplates = { templates: () => templates, postfix: () => POSTFIX, expand, surround, toSnippet, exprStart, contextAt, candidateAt };
})();
