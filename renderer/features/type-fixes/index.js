// Quick fixes (Alt+Enter, the lightbulb) for Pyright's type warnings, where a value's type is wider than what the code
// does with it. BeautifulSoup is the usual case: find() returns Tag | None and a["href"] is str | AttributeValueList.
// - A value that may be None (the reportOptional* rules), when it is a name: "Add 'assert x is not None'" before the
//   statement, and for a one-line expression statement "Wrap in 'if x is not None:'".
// - An attribute one member of a union lacks (reportAttributeAccessIssue), when the value is a name: "Add 'assert
//   isinstance(x, T)'" with the members that are not the failing one (builtins, or names the file imports or defines),
//   read from Pyright's hover.
// - The same where the attribute is a str method and the value cannot be None: "Convert '<value>' with str()".
// The None-able value is the diagnostic's range, except for attribute rules, whose range is the attribute name: the
// value is then the expression before its dot.
(() => {
  const { monaco } = ide;
  const OPTIONAL = new Set(['reportOptionalMemberAccess', 'reportOptionalSubscript', 'reportOptionalIterable',
    'reportOptionalCall', 'reportOptionalContextManager', 'reportOptionalOperand']);
  const ATTRIBUTE = 'reportAttributeAccessIssue';
  const NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
  const STR_METHODS = new Set(('capitalize casefold center count encode endswith expandtabs find format format_map index isalnum '
    + 'isalpha isascii isdecimal isdigit isidentifier islower isnumeric isprintable isspace istitle isupper join ljust lower '
    + 'lstrip partition removeprefix removesuffix replace rfind rindex rjust rpartition rsplit rstrip split splitlines '
    + 'startswith strip swapcase title translate upper zfill').split(' '));
  const BUILTIN_TYPES = new Set(['str', 'bytes', 'bytearray', 'int', 'float', 'complex', 'bool', 'list', 'tuple', 'dict', 'set', 'frozenset']);
  // Lines that continue a compound statement: nothing can be put before them.
  const CONTINUATION = /^\s*(elif|else|except|finally|case)\b/;
  const NOT_EXPRESSION = /^\s*(return|yield|raise|del|pass|import|from|global|nonlocal|assert|break|continue|def|class|if|for|while|with|try|elif|else|except|finally|match|case|async|@)\b/;

  // Whether a one-line statement assigns: an = outside brackets and strings that is not part of ==, !=, <= or >=
  // (x = …, x: list[str] = …, d["k"] = …, x += …). Keyword arguments and := sit inside brackets.
  function isAssignment(line) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\') i++;
        else if (line.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
        continue;
      }
      if (c === '#') return false;
      if (c === '"' || c === "'") { quote = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c; i += quote.length - 1; }
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      else if (c === '=' && depth === 0) {
        if (line[i + 1] === '=') { i++; continue; }
        if (!'=!<>'.includes(line[i - 1] || '')) return true;
      }
    }
    return false;
  }

  const tabOf = (model) => ide.tabs.find((t) => t.kind === 'file' && t.model === model);
  const rangeOf = (d) => new monaco.Range(d.range.start.line + 1, d.range.start.character + 1, d.range.end.line + 1, d.range.end.character + 1);

  // The expression that ends just before the dot before `col` (0-based) on `text`: names, dots, and calls or
  // subscripts with their brackets (strings inside them may hold brackets). Null when there is no dot.
  function objectBefore(text, col) {
    let end = col;
    while (end > 0 && text[end - 1] === ' ') end--;
    if (text[end - 1] !== '.') return null;
    end--;
    let i = end;
    for (;;) {
      if (i > 0 && (text[i - 1] === ')' || text[i - 1] === ']')) {
        let depth = 0;
        let j = i - 1;
        for (; j >= 0; j--) {
          const c = text[j];
          if (c === '"' || c === "'") { j = text.lastIndexOf(c, j - 1); if (j < 0) return null; continue; }
          if (c === ')' || c === ']' || c === '}') depth++;
          else if ((c === '(' || c === '[' || c === '{') && --depth === 0) break;
        }
        if (j < 0) return null;
        i = j;
        continue;
      }
      const m = /[A-Za-z_]\w*$/.exec(text.slice(0, i));
      if (!m) break;
      i = m.index;
      if (i > 0 && text[i - 1] === '.') { i--; continue; }
      break;
    }
    return i < end ? { start: i, end, text: text.slice(i, end) } : null;
  }

  // The line (1-based) where the statement holding line `upto` starts, scanning from the top of the file: a line
  // starts one when it is not inside brackets or a string and the line before does not end in a backslash outside a
  // comment. Past the last line it is `upto` itself (a statement could start there).
  function statementStart(model, upto) {
    const last = Math.min(upto, model.getLineCount());
    let depth = 0;
    let quote = null; // ', ", ''' or """
    let continued = false;
    let start = 1;
    for (let l = 1; l <= last; l++) {
      const text = model.getLineContent(l);
      if (depth === 0 && !quote && !continued) start = l;
      let comment = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
          if (c === '\\') i++;
          else if (text.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
          continue;
        }
        if (c === '#') { comment = true; break; }
        if (c === '"' || c === "'") quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
        if (quote) i += quote.length - 1;
      }
      continued = !comment && /\\$/.test(text);
      if (quote && quote.length === 1 && !continued) quote = null;
    }
    if (upto > last) return depth === 0 && !quote && !continued ? upto : start;
    return start;
  }

  const indentOf = (text) => /^\s*/.exec(text)[0];
  const unitOf = (model) => (model.getOptions().insertSpaces ? ' '.repeat(model.getOptions().indentSize || 4) : '\t');
  const edit = (model, range, text) => ({ resource: model.uri, textEdit: { range, text }, versionId: model.getVersionId() });

  // The fixes that put a line before the statement the diagnostic is in, or none where that cannot work: a line that
  // continues a compound statement, or a name bound by the statement itself (a comprehension or lambda variable).
  function statementOf(model, d, name) {
    const line = statementStart(model, d.range.start.line + 1);
    const text = model.getLineContent(line);
    if (CONTINUATION.test(text)) return null;
    const root = name.split('.')[0];
    const whole = model.getValueInRange(new monaco.Range(line, 1, d.range.end.line + 1, model.getLineMaxColumn(d.range.end.line + 1)));
    if (new RegExp(`\\bfor\\s+(?:[\\w\\s,()]*,\\s*)?${root}\\b[\\w\\s,()]*\\s+in\\b|\\blambda\\b[^:]*\\b${root}\\b`).test(whole)) return null;
    return { line, text, single: line === d.range.start.line + 1 && line === d.range.end.line + 1 };
  }

  function noneFixes(model, d, value, markers) {
    if (!NAME.test(value)) return [];
    const st = statementOf(model, d, value);
    if (!st) return [];
    const indent = indentOf(st.text);
    const out = [{
      title: tr("Add 'assert {name} is not None'", { name: value }), kind: 'quickfix', isPreferred: true, diagnostics: markers,
      edit: { edits: [edit(model, new monaco.Range(st.line, 1, st.line, 1), `${indent}assert ${value} is not None\n`)] },
    }];
    const body = st.text.trim();
    const oneLine = st.single && !/[:\\]\s*(#.*)?$/.test(body) && statementStart(model, st.line + 1) === st.line + 1;
    if (oneLine && !NOT_EXPRESSION.test(body) && !isAssignment(body)) {
      out.push({
        title: tr("Wrap in 'if {name} is not None:'", { name: value }), kind: 'quickfix', diagnostics: markers,
        edit: { edits: [edit(model, new monaco.Range(st.line, 1, st.line, st.text.length + 1), `${indent}if ${value} is not None:\n${indent}${unitOf(model)}${body}`)] },
      });
    }
    return out;
  }

  // The members of a hovered name's type, split at top-level " | ".
  function membersOf(code) {
    const m = /^\((?:variable|constant|parameter)\)\s+[\w.]+:\s*([\s\S]+)$/.exec(code.split('\n\n')[0]);
    if (!m) return null;
    const out = [];
    let depth = 0;
    let from = 0;
    const s = m[1].replace(/\s*\n\s*/g, ' ').trim();
    for (let i = 0; i < s.length; i++) {
      if ('[('.includes(s[i])) depth++;
      else if ('])'.includes(s[i])) depth--;
      else if (depth === 0 && s.startsWith(' | ', i)) { out.push(s.slice(from, i)); from = i + 3; }
    }
    out.push(s.slice(from));
    return out.map((t) => t.trim());
  }
  const codeOf = (contents) => {
    const v = typeof contents === 'string' ? contents : Array.isArray(contents) ? contents.map((c) => c.value || c).join('\n') : contents?.value || '';
    const m = /```(?:python)?\n([\s\S]*?)```/.exec(v);
    return (m ? m[1] : v).trim();
  };
  // A type the code can name in isinstance(): a builtin, or a class the file imports or defines.
  // An import under another name (`import Tag as BsTag`) does not make `Tag` a name in the file; `... as Tag` does.
  const nameable = (model, type) => BUILTIN_TYPES.has(type)
    || (/^[A-Za-z_]\w*$/.test(type) && new RegExp(`^\\s*(class\\s+${type}\\b|(from\\s+\\S+\\s+)?import\\b.*\\b${type}\\b(?!\\s+as\\b))`, 'm').test(model.getValue()));

  async function unionFixes(model, d, obj, attr, failing, noneToo, markers, token) {
    const out = [];
    if (NAME.test(obj.text) && !noneToo) {
      const st = statementOf(model, d, obj.text);
      const r = st && await ide.lsp.request('textDocument/hover', { textDocument: { uri: model.uri.toString() }, position: { line: d.range.start.line, character: obj.end - 1 } }, token);
      const members = r && membersOf(codeOf(r.contents));
      const keep = members?.filter((t) => t !== failing && t !== 'None');
      if (keep?.length && keep.every((t) => nameable(model, t))) {
        const types = keep.length === 1 ? keep[0] : `(${keep.join(', ')})`;
        out.push({
          title: tr("Add 'assert isinstance({name}, {types})'", { name: obj.text, types }), kind: 'quickfix', isPreferred: true, diagnostics: markers,
          edit: { edits: [edit(model, new monaco.Range(st.line, 1, st.line, 1), `${indentOf(st.text)}assert isinstance(${obj.text}, ${types})\n`)] },
        });
      }
    }
    if (STR_METHODS.has(attr) && !noneToo && !/^str\(/.test(obj.text)) {
      const line = d.range.start.line + 1;
      out.push({
        title: tr("Convert '{value}' with str()", { value: obj.text }), kind: 'quickfix', isPreferred: !out.length, diagnostics: markers,
        edit: { edits: [edit(model, new monaco.Range(line, obj.start + 1, line, obj.end + 1), `str(${obj.text})`)] },
      });
    }
    return out;
  }

  monaco.languages.registerCodeActionProvider('python', {
    async provideCodeActions(model, range, context, token) {
      if (!ide.lsp?.diagnostics || ide.trusted === false) return undefined;
      const all = ide.lsp.diagnostics(tabOf(model)?.path);
      const diags = all.filter((d) => (OPTIONAL.has(d.code) || d.code === ATTRIBUTE)
        && d.range.start.line + 1 <= range.endLineNumber && d.range.end.line + 1 >= range.startLineNumber);
      if (!diags.length) return undefined;
      const actions = [];
      for (const d of diags) {
        const line = model.getLineContent(d.range.start.line + 1);
        const markers = context.markers.filter((m) => m.source === 'pyright' && rangeOf(d).intersectRanges(new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn)));
        const memberRule = d.code === ATTRIBUTE || d.code === 'reportOptionalMemberAccess';
        const obj = memberRule ? objectBefore(line, d.range.start.character) : { text: model.getValueInRange(rangeOf(d)), start: d.range.start.character, end: d.range.end.character };
        if (!obj) continue;
        let found = [];
        if (OPTIONAL.has(d.code)) found = noneFixes(model, d, obj.text, markers);
        else {
          const attr = model.getValueInRange(rangeOf(d));
          const failing = [...d.message.matchAll(/"([^"]+)"/g)].map((m) => m[1]).find((n) => n !== attr);
          if (!failing || failing === 'None') continue;
          // The same value may also be None: then neither isinstance alone nor str() is the fix (str(None) is 'None').
          const noneToo = all.some((x) => OPTIONAL.has(x.code) && x.range.start.line === d.range.start.line && x.range.start.character === d.range.start.character);
          found = await unionFixes(model, d, obj, attr, failing, noneToo, markers, token);
        }
        for (const a of found) if (!actions.some((x) => x.title === a.title)) actions.push(a);
      }
      if (token.isCancellationRequested || !actions.length) return undefined;
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  ide.typeFixes = { objectBefore, statementStart };
})();
