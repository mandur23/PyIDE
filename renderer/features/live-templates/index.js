// Live templates and postfix completion, as in PyCharm's Editor › Live Templates and Postfix Completion, for Python and,
// with IntelliJ IDEA's, WebStorm's and CLion's built-in sets, for Java, JavaScript/TypeScript and C/C++.
// An abbreviation followed by Tab (or picked from the completion list) expands into a Monaco snippet; `expr.key` after an
// expression rewrites the expression with a postfix template; Ctrl+Alt+J wraps the selection in a template.
(() => {
  const monaco = ide.monaco;
  const { el } = ide.util;
  const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  // Python's templates and postfix keys are stored by name, other languages' as `group:name` (`java:sout`).
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
  // langs: the languages of its group a template is for (all when absent).
  const JAVA = [
    { abbr: 'psvm', description: tr('main() method declaration'), body: 'public static void main(String[] args) {\n\t$END$\n}' },
    { abbr: 'main', description: tr('main() method declaration'), body: 'public static void main(String[] args) {\n\t$END$\n}' },
    { abbr: 'sout', description: tr('Print a line to System.out'), body: 'System.out.println($END$);' },
    { abbr: 'souf', description: tr('Print a formatted string to System.out'), body: 'System.out.printf("$FORMAT$"$END$);', vars: { FORMAT: '%s%n' } },
    { abbr: 'soutv', description: tr('Print a value to System.out'), body: 'System.out.println("$EXPR$ = " + $EXPR$);$END$', vars: { EXPR: 'value' } },
    { abbr: 'serr', description: tr('Print a line to System.err'), body: 'System.err.println($END$);' },
    { abbr: 'fori', description: tr('Create an indexed for loop'), body: 'for (int $INDEX$ = 0; $INDEX$ < $LIMIT$; $INDEX$++) {\n\t$SELECTION$$END$\n}', vars: { INDEX: 'i', LIMIT: 'n' } },
    { abbr: 'iter', description: tr('Iterate over an Iterable or array (for-each)'), body: 'for ($TYPE$ $VAR$ : $ITERABLE$) {\n\t$SELECTION$$END$\n}', vars: { TYPE: 'var', VAR: 'item', ITERABLE: 'items' } },
    { abbr: 'itar', description: tr('Iterate over the elements of an array'), body: 'for (int $INDEX$ = 0; $INDEX$ < $ARRAY$.length; $INDEX$++) {\n\t$TYPE$ $VAR$ = $ARRAY$[$INDEX$];\n\t$END$\n}', vars: { INDEX: 'i', ARRAY: 'array', TYPE: 'var', VAR: 'item' } },
    { abbr: 'ifn', description: tr('Insert a null check (== null)'), body: 'if ($VAR$ == null) {\n\t$SELECTION$$END$\n}', vars: { VAR: 'value' } },
    { abbr: 'inn', description: tr('Insert a not-null check (!= null)'), body: 'if ($VAR$ != null) {\n\t$SELECTION$$END$\n}', vars: { VAR: 'value' } },
    { abbr: 'thr', description: tr('throw new'), body: 'throw new $END$' },
    { abbr: 'psf', description: 'public static final', body: 'public static final $END$' },
    { abbr: 'psfs', description: 'public static final String', body: 'public static final String $END$' },
    { abbr: 'psfi', description: 'public static final int', body: 'public static final int $END$' },
    { abbr: 'prsf', description: 'private static final', body: 'private static final $END$' },
    { abbr: 'St', description: 'String', body: 'String $END$' },
  ];
  const JS = [
    { abbr: 'log', description: tr('Print to the console (console.log)'), body: 'console.log($END$)' },
    { abbr: 'fori', description: tr('Create an indexed for loop'), body: 'for (let $INDEX$ = 0; $INDEX$ < $LIMIT$; $INDEX$++) {\n\t$SELECTION$$END$\n}', vars: { INDEX: 'i', LIMIT: 'n' } },
    { abbr: 'iter', description: tr('Iterate over an iterable (for … of …)'), body: 'for (const $VAR$ of $ITERABLE$) {\n\t$SELECTION$$END$\n}', vars: { VAR: 'item', ITERABLE: 'items' } },
    { abbr: 'itin', description: tr('Iterate over the keys of an object (for … in …)'), body: 'for (const $KEY$ in $OBJECT$) {\n\t$SELECTION$$END$\n}', vars: { KEY: 'key', OBJECT: 'object' } },
    { abbr: 'imp', description: tr('Import a module member'), body: "import { $MEMBER$ } from '$MODULE$';$END$", vars: { MEMBER: 'name', MODULE: 'module' } },
    { abbr: 'fn', description: tr('Function declaration'), body: 'function $NAME$($PARAMS$) {\n\t$SELECTION$$END$\n}', vars: { NAME: 'name' } },
    { abbr: 'af', description: tr('Arrow function'), body: '($PARAMS$) => {\n\t$END$\n}' },
    { abbr: 'try', description: tr('try / catch'), body: 'try {\n\t$SELECTION$$END$\n} catch ($ERROR$) {\n\tconsole.error($ERROR$);\n}', vars: { ERROR: 'error' } },
  ];
  const C = [
    { abbr: 'main', description: tr('main() function'), body: 'int main() {\n\t$END$\n\treturn 0;\n}' },
    { abbr: 'fori', description: tr('Create an indexed for loop'), body: 'for (int $INDEX$ = 0; $INDEX$ < $LIMIT$; $INDEX$++) {\n\t$SELECTION$$END$\n}', vars: { INDEX: 'i', LIMIT: 'n' } },
    { abbr: 'inc', description: tr('#include a system header'), body: '#include <$HEADER$>$END$', vars: { HEADER: 'stdio.h' } },
    { abbr: 'incl', description: tr('#include a project header'), body: '#include "$HEADER$"$END$', vars: { HEADER: 'header.h' } },
    { abbr: 'guard', description: tr('Header guard'), body: '#ifndef $NAME$\n#define $NAME$\n\n$SELECTION$$END$\n\n#endif', vars: { NAME: 'HEADER_H' } },
    { abbr: 'pf', description: tr('Print with printf'), body: 'printf("$FORMAT$\\n"$END$);', vars: { FORMAT: '%d' } },
    { abbr: 'cout', description: tr('Print to std::cout'), body: 'std::cout << $END$ << std::endl;', langs: ['cpp'] },
    { abbr: 'forr', description: tr('Range-based for loop'), body: 'for (auto &$VAR$ : $RANGE$) {\n\t$SELECTION$$END$\n}', vars: { VAR: 'item', RANGE: 'items' }, langs: ['cpp'] },
  ];
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
  const codeDoc = (text, lang = 'python') => ({ value: '```' + lang + '\n' + text + '\n```' });

  // ---------- effective templates ----------
  // A group's stored name for a template or postfix key: the name for Python, `group:name` for the others.
  const keyOf = (g, name) => (g.id === 'python' ? name : `${g.id}:${name}`);
  const nameIn = (g, key) => {
    const i = key.indexOf(':');
    if (g.id === 'python') return i < 0 ? key : null;
    return key.slice(0, i) === g.id ? key.slice(i + 1) : null;
  };
  let postfixOff = new Set();
  function merge(custom, g = GROUPS[0]) {
    const out = g.builtin.map((b) => {
      const k = keyOf(g, b.abbr);
      const c = Object.hasOwn(custom, k) ? custom[k] : {};
      return { ...b, builtin: true, body: c.body ?? b.body, description: c.description ?? b.description, enabled: c.enabled ?? true, modified: c.body != null || c.description != null };
    });
    for (const [k, c] of Object.entries(custom)) {
      const abbr = nameIn(g, k);
      if (abbr && !g.builtinByAbbr.has(abbr)) out.push({ abbr, builtin: false, body: c.body || '', description: c.description || '', enabled: c.enabled ?? true });
    }
    return out;
  }
  function reload() {
    const custom = ide.settings.get(CUSTOM, {}) || {};
    for (const g of GROUPS) {
      g.templates = merge(custom, g);
      g.byAbbr = new Map(g.templates.filter((t) => t.enabled).map((t) => [t.abbr, t]));
    }
    postfixOff = new Set(ide.settings.get(POSTFIX_OFF, []) || []);
  }

  // ---------- context: code, string or comment ----------
  const COMMENT_TOKEN = 1;
  const STRING_TOKEN = 2;
  // Python: its own scan (Monaco's tokens are not always ready for the line being typed). Other languages: the token
  // of the character at pos (a template's first letter, a postfix template's dot).
  function contextAt(model, pos) {
    if (model.getLanguageId() === 'python') return pyContextAt(model, pos);
    try {
      const tokens = model.tokenization.getLineTokens(pos.lineNumber);
      const type = tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(pos.column - 1));
      return type === COMMENT_TOKEN ? 'comment' : type === STRING_TOKEN ? 'string' : 'code';
    } catch { return 'code'; }
  }
  // A lightweight Python scan from the top of the file to pos: comments, '…', "…", '''…''' and """…""" (with escapes).
  function pyContextAt(model, pos) {
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
  // Java and JavaScript postfix templates: `head` with $E for the expression, and a braced block.
  const BLOCK = (head, e) => `${head.replace('$E', () => e)} {\n\t$0\n}`;
  const JAVA_POSTFIX = [
    { key: 'sout', description: tr('Print the expression to System.out'), statement: true, body: (e) => `System.out.println(${e});$0` },
    { key: 'if', description: tr('if (expr)'), statement: true, body: (e) => BLOCK('if ($E)', e) },
    { key: 'nn', description: tr('if (expr != null)'), statement: true, body: (e) => BLOCK('if ($E != null)', e) },
    { key: 'null', description: tr('if (expr == null)'), statement: true, body: (e) => BLOCK('if ($E == null)', e) },
    { key: 'not', description: tr('Negate the expression'), body: (e) => `!${e}$0` },
    { key: 'for', description: tr('Iterate over the expression'), statement: true, body: (e, x) => `for (var \${1:${itemName(x)}} : ${e}) {\n\t$0\n}` },
    { key: 'fori', description: tr('Indexed for loop up to the expression'), statement: true, body: (e) => `for (int \${1:i} = 0; \${1:i} < ${e}; \${1:i}++) {\n\t$0\n}` },
    { key: 'while', description: tr('while (expr)'), statement: true, body: (e) => BLOCK('while ($E)', e) },
    { key: 'var', description: tr('Introduce a variable'), statement: true, body: (e) => `var \${1:name} = ${e};$0` },
    { key: 'return', description: tr('Return the expression'), statement: true, body: (e) => `return ${e};$0` },
    { key: 'par', description: tr('Parenthesize the expression'), body: (e) => `(${e})$0` },
  ];
  const JS_POSTFIX = [
    { key: 'log', description: tr('Print the expression to the console'), body: (e) => `console.log(${e})$0` },
    { key: 'if', description: tr('if (expr)'), statement: true, body: (e) => BLOCK('if ($E)', e) },
    { key: 'not', description: tr('Negate the expression'), body: (e) => `!${e}$0` },
    { key: 'for', description: tr('Iterate over the expression'), statement: true, body: (e, x) => `for (const \${1:${itemName(x)}} of ${e}) {\n\t$0\n}` },
    { key: 'const', description: tr('Introduce a constant'), statement: true, body: (e) => `const \${1:name} = ${e}$0` },
    { key: 'let', description: tr('Introduce a variable'), statement: true, body: (e) => `let \${1:name} = ${e}$0` },
    { key: 'return', description: tr('Return the expression'), statement: true, body: (e) => `return ${e}$0` },
    { key: 'await', description: tr('Await the expression'), body: (e) => `await ${e}$0` },
    { key: 'par', description: tr('Parenthesize the expression'), body: (e) => `(${e})$0` },
  ];

  // ---------- language groups ----------
  // A group has its own built-in templates, postfix templates and settings list; lang is its code fences' language.
  const GROUPS = [
    { id: 'python', title: () => tr('Python'), langs: ['python'], lang: 'python', builtin: BUILTIN, postfix: POSTFIX },
    { id: 'java', title: () => 'Java', langs: ['java'], lang: 'java', builtin: JAVA, postfix: JAVA_POSTFIX },
    { id: 'js', title: () => tr('JavaScript and TypeScript'), langs: ['javascript', 'typescript'], lang: 'javascript', builtin: JS, postfix: JS_POSTFIX },
    { id: 'c', title: () => tr('C and C++'), langs: ['c', 'cpp'], lang: 'cpp', builtin: C, postfix: [] },
  ];
  for (const g of GROUPS) {
    g.builtinByAbbr = new Map(g.builtin.map((t) => [t.abbr, t]));
    g.postfixByKey = new Map(g.postfix.map((p) => [p.key, p]));
  }
  const groupById = (id) => GROUPS.find((g) => g.id === id) || GROUPS[0];
  const groupOf = (model) => (model && !model.isDisposed() && GROUPS.find((g) => g.langs.includes(model.getLanguageId()))) || null;
  // Whether template t is for the language of model (a group may have templates for one of its languages only).
  const forModel = (t, model) => !t.langs || t.langs.includes(model.getLanguageId());
  reload();
  ide.on('settingsChanged', (key) => { if (key === CUSTOM || key === POSTFIX_OFF) reload(); });

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
  // The exact template or postfix template that Tab would expand at the caret, or null.
  function candidateAt(editor) {
    const model = editor.getModel();
    const g = groupOf(model);
    const sels = editor.getSelections();
    if (!g || !sels || sels.length !== 1 || !sels[0].isEmpty()) return null;
    const pos = sels[0].getPosition();
    const w = wordAt(model, pos);
    if (!w) return null;
    if (w.kind === 'template') {
      const tpl = g.byAbbr.get(w.word);
      if (!tpl || !forModel(tpl, model)) return null;
      if (contextAt(model, { lineNumber: pos.lineNumber, column: w.start + 1 }) !== 'code') return null;
      return { ...w, tpl };
    }
    const p = g.postfixByKey.get(w.word);
    if (!p || postfixOff.has(keyOf(g, p.key)) || (p.statement && !w.statement)) return null;
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
    const g = groupOf(model);
    if (!g) return false;
    const sel = editor.getSelection();
    let first = sel.startLineNumber;
    let last = sel.endLineNumber;
    if (last > first && sel.endColumn === 1) last--;
    const choices = g.templates.filter((t) => t.enabled && forModel(t, model) && t.body.includes('$SELECTION$'));
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
    when: () => !!groupOf(focused()?.getModel()),
    run: () => { const e = focused(); if (e) surround(e); },
  });

  // ---------- completion list ----------
  const provider = {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const g = groupOf(model);
      const w = g && wordAt(model, position);
      if (!w) return undefined;
      const K = monaco.languages.CompletionItemKind;
      const range = new monaco.Range(position.lineNumber, w.start + 1, position.lineNumber, position.column);
      if (w.kind === 'template') {
        if (contextAt(model, { lineNumber: position.lineNumber, column: w.start + 1 }) !== 'code') return undefined;
        const suggestions = [...g.byAbbr.values()].filter((t) => forModel(t, model)).map((t) => {
          const snippet = toSnippet(t);
          return {
            label: { label: t.abbr, description: t.description }, kind: K.Snippet, detail: t.description, documentation: codeDoc(previewOf(snippet), g.lang),
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
      // ranked by the key like the members the language server lists there, and sorts after them.
      const line = position.lineNumber;
      const keyRange = new monaco.Range(line, w.dot + 2, line, position.column);
      const dropExpr = [{ range: new monaco.Range(line, w.start + 1, line, w.dot + 2), text: '' }];
      for (const p of g.postfix) {
        if (postfixOff.has(keyOf(g, p.key)) || (p.statement && !w.statement)) continue;
        const snippet = p.body(e, w.expr);
        if (snippet == null) continue;
        suggestions.push({
          label: { label: p.key, description: tr('postfix') }, kind: K.Snippet, detail: p.description,
          documentation: codeDoc(previewOf(snippet), g.lang), insertText: snippet, insertTextRules: SNIPPET, range: keyRange,
          additionalTextEdits: dropExpr, filterText: p.key, sortText: `~${p.key}`,
        });
      }
      return { suggestions };
    },
  };
  for (const lang of GROUPS.flatMap((g) => g.langs)) monaco.languages.registerCompletionItemProvider(lang, provider);

  // ---------- Settings › Editor › Live Templates ----------
  function mountPage(host, ctx) {
    const custom = structuredClone(ctx.value(CUSTOM) || {});
    const off = new Set(ctx.value(POSTFIX_OFF) || []);
    let g = GROUPS[0];
    const save = () => {
      for (const [k, c] of Object.entries(custom)) {
        const owner = GROUPS.find((x) => nameIn(x, k) != null);
        if (owner?.builtinByAbbr.has(nameIn(owner, k)) && !Object.keys(c).length) delete custom[k];
      }
      ctx.set(CUSTOM, structuredClone(custom));
    };
    let selected = g.builtin[0].abbr;
    const s = ctx.ui.section(host, tr('Templates'));
    const root = el('div', 'lt-page');
    const bar = el('div', 'lt-toolbar');
    const langIn = el('select', 'lt-lang');
    langIn.title = tr('Language');
    for (const x of GROUPS) {
      const o = el('option', null, x.title());
      o.value = x.id;
      langIn.appendChild(o);
    }
    bar.appendChild(langIn);
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
      el('div', 'field-hint muted', tr('$NAME$ is a variable the caret visits in order, $END$ is where the caret ends, and $SELECTION$ is the text that {action} wraps.',
        { action: ide.keymap.withKeys(tr('Surround With'), 'SurroundWithLiveTemplate') })));

    const current = () => merge(custom, g).find((t) => t.abbr === selected);
    const entry = (abbr) => (custom[keyOf(g, abbr)] ||= {});
    btn('lt-add', '+', tr('Add Template'), () => {
      let n = 1;
      while (merge(custom, g).some((t) => t.abbr === `abbr${n}`)) n++;
      custom[keyOf(g, `abbr${n}`)] = { description: '', body: '', enabled: true };
      selected = `abbr${n}`;
      save();
      render();
      abbrIn.focus();
      abbrIn.select();
    });
    const removeBtn = btn('lt-remove', '−', tr('Remove Template'), () => {
      const t = current();
      if (!t || t.builtin) return;
      delete custom[keyOf(g, t.abbr)];
      selected = g.builtin[0].abbr;
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
    langIn.onchange = () => {
      g = groupById(langIn.value);
      selected = g.builtin[0].abbr;
      render();
      renderPostfix();
    };
    abbrIn.onchange = () => {
      const t = current();
      const v = abbrIn.value.trim();
      const ok = ABBR.test(v) && (v === t.abbr || !merge(custom, g).some((x) => x.abbr === v));
      abbrIn.classList.toggle('invalid', !ok);
      if (!ok || t.builtin || v === t.abbr) return;
      custom[keyOf(g, v)] = custom[keyOf(g, t.abbr)];
      delete custom[keyOf(g, t.abbr)];
      selected = v;
      save();
      renderList();
    };
    descIn.oninput = () => {
      const t = current();
      if (t.builtin && descIn.value === g.builtinByAbbr.get(t.abbr).description) delete entry(t.abbr).description;
      else entry(t.abbr).description = descIn.value;
      save();
      renderList();
    };
    bodyIn.oninput = () => {
      const t = current();
      if (t.builtin && bodyIn.value === g.builtinByAbbr.get(t.abbr).body) delete entry(t.abbr).body;
      else entry(t.abbr).body = bodyIn.value;
      save();
      resetBtn.disabled = !current().modified;
    };

    function renderList() {
      list.replaceChildren();
      for (const t of merge(custom, g)) {
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
    ps.appendChild(plist);
    function renderPostfix() {
      ps.hidden = !g.postfix.length;
      plist.replaceChildren();
      for (const p of g.postfix) {
        const k = keyOf(g, p.key);
        const r = el('label', 'lt-postfix-row');
        r.dataset.key = p.key;
        const c = el('input');
        c.type = 'checkbox';
        c.checked = !off.has(k);
        c.onchange = () => {
          if (c.checked) off.delete(k); else off.add(k);
          ctx.set(POSTFIX_OFF, [...off]);
        };
        r.append(c, el('span', 'lt-name', `.${p.key}`), el('span', 'lt-row-desc muted', p.description));
        plist.appendChild(r);
      }
    }
    renderPostfix();
  }
  (ide.settingsPages ||= []).push({
    id: 'live-templates', group: 'editor', title: () => tr('Live Templates'),
    keywords: 'live templates postfix completion snippet abbreviation surround tab java javascript typescript c++ psvm sout fori 라이브 템플릿 후위 완성 약어 감싸기',
    defaults: { [CUSTOM]: {}, [POSTFIX_OFF]: [] },
    mount: mountPage,
  });

  // templates(group) / postfix(group): a group's ('python', 'java', 'js', 'c') effective templates and postfix templates.
  ide.liveTemplates = {
    groups: () => GROUPS.map((g) => g.id), templates: (id = 'python') => groupById(id).templates, postfix: (id = 'python') => groupById(id).postfix,
    expand, surround, toSnippet, exprStart, contextAt, candidateAt,
  };
})();
