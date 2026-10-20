// Syntax highlighting for .env files (.env, .env.local, prod.env), following the dotenv rules of main/dotenv.js.
(() => {
  const { monaco } = ide;
  const LANG = 'dotenv';
  const isEnvFile = (p) => /(^|[\\/])\.env(\.[^\\/]+)?$|\.env$/i.test(p);

  monaco.languages.register({ id: LANG, aliases: ['.env', 'dotenv'] });
  monaco.languages.setLanguageConfiguration(LANG, {
    comments: { lineComment: '#' },
    autoClosingPairs: [{ open: '"', close: '"' }, { open: "'", close: "'" }, { open: '${', close: '}' }],
  });
  monaco.languages.setMonarchTokensProvider(LANG, {
    defaultToken: '',
    tokenizer: {
      // Keys only match at the start of a line, so the rest of the line is the value. Monarch cannot leave a state
      // at the end of a line, so unquoted values are tokenized here; quoted ones get states, since they may span lines.
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^(\s*)(export)(\s+)([A-Za-z_][\w.-]*)(\s*)(=)/, ['', 'builtin', '', 'keyword', '', 'delimiter']],
        [/^(\s*)([A-Za-z_][\w.-]*)(\s*)(=)/, ['', 'keyword', '', 'delimiter']],
        [/^\s*\S.*$/, 'invalid'],
        [/"/, 'string', '@dquoted'],
        [/'/, 'string', '@squoted'],
        [/\$\{[^}]*\}/, 'variable'],
        [/\s+#.*$/, 'comment'],
        [/[^\s$"']+|\$|\s+/, 'string'],
      ],
      dquoted: [
        [/[^"\\$]+/, 'string'],
        [/\\./, 'string.escape'],
        [/\$\{[^}"]*\}/, 'variable'],
        [/\$/, 'string'],
        [/"/, 'string', '@pop'],
      ],
      squoted: [
        [/[^']+/, 'string'],
        [/'/, 'string', '@pop'],
      ],
    },
  });

  // The core picks a language by extension, and ".env" has none it knows.
  const apply = (model) => {
    if (model.uri.scheme === 'file' && isEnvFile(model.uri.fsPath) && model.getLanguageId() !== LANG) monaco.editor.setModelLanguage(model, LANG);
  };
  monaco.editor.getModels().forEach(apply);
  monaco.editor.onDidCreateModel(apply);
})();
