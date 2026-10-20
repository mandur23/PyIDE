window.PY_KEYWORDS = ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case'];

window.PY_BUILTINS = ['abs', 'all', 'any', 'bin', 'bool', 'bytes', 'callable', 'chr', 'dict', 'dir', 'divmod',
  'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash', 'help', 'hex',
  'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'object',
  'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
  'sorted', 'staticmethod', 'classmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', 'Exception',
  'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'StopIteration', 'NotImplementedError'];

window.PYTHON_GRAMMAR = {
  keywords: PY_KEYWORDS,
  builtins: PY_BUILTINS,
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/@[\w.]+/, 'tag'],
      [/\b(def)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'function']],
      [/\b(class)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'type.identifier']],
      [/\b(self|cls)\b/, 'self'],
      [/[rRbBuUfF]{0,2}"""/, 'string', '@tdq'],
      [/[rRbBuUfF]{0,2}'''/, 'string', '@tsq'],
      [/[rRbBuUfF]{0,2}"/, 'string', '@dq'],
      [/[rRbBuUfF]{0,2}'/, 'string', '@sq'],
      [/\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*(\.\d*)?([eE][+-]?\d+)?j?\b/, 'number'],
      [/[A-Za-z_]\w*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@builtins': 'builtin', '@default': 'function.call' } }],
      [/[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '@builtins': 'builtin', '@default': 'identifier' } }],
      [/[{}()[\]]/, '@brackets'],
      [/[-+*/%=<>!&|^~:.,;]+/, 'delimiter'],
    ],
    tdq: [[/\\./, 'string.escape'], [/"""/, 'string', '@pop'], [/./, 'string']],
    tsq: [[/\\./, 'string.escape'], [/'''/, 'string', '@pop'], [/./, 'string']],
    dq: [[/\\./, 'string.escape'], [/"/, 'string', '@pop'], [/[^\\"]+$/, 'string', '@pop'], [/[^\\"]+/, 'string']],
    sq: [[/\\./, 'string.escape'], [/'/, 'string', '@pop'], [/[^\\']+$/, 'string', '@pop'], [/[^\\']+/, 'string']],
  },
};

// Fallback completions; a language-server feature can register a richer provider alongside this one.
window.pythonBasicCompletions = (monaco) => (model, position) => {
  const word = model.getWordUntilPosition(position);
  const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
    startColumn: word.startColumn, endColumn: word.endColumn };
  const K = monaco.languages.CompletionItemKind;
  // After a dot (os.pa|) only members make sense: no keywords or statement snippets.
  const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
  if (/\.\s*$/.test(before)) return { suggestions: [] };
  // main, try and the other Python templates are live templates (renderer/features/live-templates).
  const snippets = [
    ['def', 'def ${1:name}(${2}):\n    ${0:pass}', 'function'],
    ['class', 'class ${1:Name}:\n    def __init__(self${2}):\n        ${0:pass}', 'class'],
    ['for', 'for ${1:item} in ${2:items}:\n    ${0:pass}', 'for loop'],
  ];
  return {
    suggestions: [
      ...PY_KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: 'z' + k })),
      ...snippets.map(([label, body, detail]) => ({ label, kind: K.Snippet, detail, insertText: body, range,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
    ],
  };
};
