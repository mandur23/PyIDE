// What every editable language gets in PyCharm even without a language plugin: keyword and word completion (from the
// keywords of Monaco's grammar for the language), Markdown folding by headings and list continuation on Enter, Enter
// indentation for Lua and shell scripts, and JSX in .jsx and .tsx files.
(() => {
  const monaco = ide.monaco;
  const K = monaco.languages.CompletionItemKind;
  const COMMENT = 1;
  const STRING = 2;

  // ---------- keyword and word completion ----------
  // Languages that complete through a language service of their own (Pyright, Monaco's TypeScript, CSS, HTML and JSON
  // workers) or have no keywords to offer.
  const OWN_COMPLETION = new Set(['python', 'javascript', 'typescript', 'css', 'scss', 'less', 'html', 'json', 'markdown', 'plaintext',
    'handlebars', 'razor', 'mdx']);
  const KEYWORD_LISTS = ['keywords', 'typeKeywords', 'builtinFunctions', 'builtinVariables', 'builtins', 'constants'];
  const keywordsOf = new Map(); // language id -> Promise<string[]>
  function keywords(id) {
    if (!keywordsOf.has(id)) {
      const lang = monaco.languages.getLanguages().find((l) => l.id === id);
      keywordsOf.set(id, (async () => {
        const mod = lang?.loader ? await lang.loader().catch(() => null) : null;
        const words = new Set();
        for (const list of KEYWORD_LISTS) for (const w of mod?.language?.[list] || []) if (typeof w === 'string' && /^[A-Za-z_][\w-]*$/.test(w)) words.add(w);
        return [...words];
      })());
    }
    return keywordsOf.get(id);
  }
  // Whether the caret is in a string or comment token.
  function inText(model, position) {
    try {
      const tokens = model.tokenization.getLineTokens(position.lineNumber);
      const type = tokens.getStandardTokenType(tokens.findTokenIndexAtOffset(Math.max(0, position.column - 2)));
      return type === COMMENT || type === STRING;
    } catch { return false; }
  }
  // Identifiers of the file, as Monaco's word completion lists them: with this provider answering, Monaco's own word
  // completion stays out (it only answers when no provider for the language has items).
  const MAX_WORDS = 5000;
  function documentWords(model, current) {
    const words = new Set();
    for (const m of model.getValue().matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) {
      if (m[0] !== current) words.add(m[0]);
      if (words.size >= MAX_WORDS) break;
    }
    return words;
  }
  // Java's own server (JDT LS) lists keywords itself once it runs.
  const serverRuns = (model) => ide.lsp?.clientFor?.(model.uri.fsPath)?.status?.() === 'ready';
  const provider = {
    async provideCompletionItems(model, position) {
      if (model.uri.scheme !== 'file' || serverRuns(model) || inText(model, position) || ide.database?.completionHost?.consoleFor(model)) return undefined;
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const kws = await keywords(model.getLanguageId());
      const seen = new Set(kws);
      const suggestions = kws.map((w) => ({ label: w, kind: K.Keyword, insertText: w, range }));
      for (const w of documentWords(model, model.getWordAtPosition(position)?.word)) if (!seen.has(w)) suggestions.push({ label: w, kind: K.Text, insertText: w, range, sortText: `~${w}` });
      return { suggestions };
    },
  };
  const registered = new Set();
  function registerKeywords() {
    for (const l of monaco.languages.getLanguages()) {
      if (!l.loader || OWN_COMPLETION.has(l.id) || registered.has(l.id)) continue;
      registered.add(l.id);
      monaco.languages.registerCompletionItemProvider(l.id, provider);
    }
  }
  registerKeywords();

  // ---------- Enter indentation (Lua, shell) ----------
  // Monaco's grammars for the two indent nothing on Enter. Enter after a line that opens a block (VS Code's patterns)
  // indents the new line, and typing the word that closes the block (end, fi, done…) on a line of its own moves it back
  // to the opening line's indentation. Monaco sets a language's own configuration when the language is first used, so
  // the Enter rule is added after it, over its configuration.
  const BLOCKS = {
    lua: {
      open: /^((?!(--)).)*((\b(else|function|then|do|repeat)\b((?!\b(end|until)\b).)*)|(\{\s*))$/,
      close: /^\s*(end|else|elseif|until|\})$/,
    },
    shell: {
      open: /^\s*((if|elif|while|until|for|select)\b.*\b(then|do)\s*(#.*)?|else\s*(#.*)?|case\b.*\bin\s*(#.*)?|.*[{(]\s*(#.*)?)$/,
      close: /^\s*(fi|done|esac|else|elif|\})$/,
    },
  };
  for (const [id, { open }] of Object.entries(BLOCKS)) {
    const lang = monaco.languages.getLanguages().find((l) => l.id === id);
    if (!lang?.loader) continue;
    monaco.languages.onLanguage(id, async () => {
      const mod = await lang.loader();
      await new Promise((r) => setTimeout(r));
      const onEnterRules = [...(mod.conf.onEnterRules || []), { beforeText: open, action: { indentAction: monaco.languages.IndentAction.Indent } }];
      monaco.languages.setLanguageConfiguration(id, { ...mod.conf, onEnterRules });
    });
  }
  const indentOf = (text) => /^\s*/.exec(text)[0];
  function outdentClosingLine(ed) {
    const model = ed.getModel();
    const block = BLOCKS[model?.getLanguageId()];
    const sels = ed.getSelections();
    if (!block || sels?.length !== 1 || !sels[0].isEmpty()) return;
    const line = sels[0].positionLineNumber;
    const text = model.getLineContent(line);
    if (!block.close.test(text)) return;
    let prev = line - 1;
    while (prev >= 1 && !model.getLineContent(prev).trim()) prev--;
    if (prev < 1) return;
    const prevText = model.getLineContent(prev);
    const { indentSize, insertSpaces } = model.getOptions();
    const unit = insertSpaces ? ' '.repeat(indentSize) : '\t';
    let want = indentOf(prevText);
    if (!block.open.test(prevText)) want = want.endsWith(unit) ? want.slice(0, -unit.length) : want.replace(/[ \t]$/, '');
    const has = indentOf(text);
    if (has.length <= want.length) return;
    // Its own undo step: Ctrl+Z puts the word back where it was typed.
    ed.pushUndoStop();
    ed.executeEdits('outdent', [{ range: new monaco.Range(line, 1, line, has.length + 1), text: want }]);
    ed.pushUndoStop();
  }
  ide.onEditor((ed) => ed.onDidType(() => outdentClosingLine(ed)));

  // ---------- Markdown: folding ----------
  // Each heading folds its section (up to the next heading of the same or a higher level), and fenced code blocks and
  // <!-- #region --> … <!-- #endregion --> fold as well. A provider replaces Monaco's folding by indentation, which folds
  // nothing in most Markdown.
  const FENCE = /^ {0,3}(`{3,}|~{3,})/;
  function markdownFolds(model) {
    const ranges = [];
    const open = []; // [level, line]
    const regions = [];
    let fence = null;
    const n = model.getLineCount();
    const lastText = (before) => { let l = before; while (l > 1 && !model.getLineContent(l).trim()) l--; return l; };
    const closeTo = (level, before) => {
      while (open.length && open.at(-1)[0] >= level) {
        const [, start] = open.pop();
        const end = lastText(before);
        if (end > start) ranges.push({ start, end });
      }
    };
    for (let line = 1; line <= n; line++) {
      const text = model.getLineContent(line);
      const f = FENCE.exec(text);
      if (fence) {
        if (f && f[1][0] === fence.mark[0] && f[1].length >= fence.mark.length && !text.slice(f[0].length).trim()) {
          if (line > fence.line) ranges.push({ start: fence.line, end: line, kind: monaco.languages.FoldingRangeKind.Region });
          fence = null;
        }
        continue;
      }
      if (f) { fence = { mark: f[1], line }; continue; }
      if (/^\s*<!--\s*#region\b/.test(text)) regions.push(line);
      else if (/^\s*<!--\s*#endregion\b/.test(text) && regions.length) ranges.push({ start: regions.pop(), end: line, kind: monaco.languages.FoldingRangeKind.Region });
      const h = /^ {0,3}(#{1,6})(\s|$)/.exec(text);
      if (h) {
        closeTo(h[1].length, line - 1);
        open.push([h[1].length, line]);
      }
    }
    closeTo(1, n);
    return ranges;
  }
  monaco.languages.registerFoldingRangeProvider('markdown', { provideFoldingRanges: (model) => markdownFolds(model) });

  // ---------- Markdown: list continuation ----------
  // Enter in a list item starts the next item (the same bullet, the next number, an unchecked box for a task); Enter in
  // an empty item ends the list, as in PyCharm's Markdown editor. Not in fenced code blocks.
  const ITEM = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/;
  function inFence(model, lineNumber) {
    let fence = null;
    for (let l = 1; l < lineNumber; l++) {
      const f = FENCE.exec(model.getLineContent(l));
      if (!f) continue;
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    }
    return !!fence;
  }
  // The list item the caret is in, past its marker: {m, line} or null.
  function itemAt(ed) {
    const model = ed.getModel();
    const sels = ed.getSelections();
    if (model?.getLanguageId() !== 'markdown' || sels?.length !== 1 || !sels[0].isEmpty()) return null;
    const { lineNumber, column } = sels[0].getPosition();
    const m = ITEM.exec(model.getLineContent(lineNumber));
    if (!m || column - 1 < m[0].length || inFence(model, lineNumber)) return null;
    return { m, lineNumber, column };
  }
  function continueList(ed) {
    const at = itemAt(ed);
    if (!at) return false;
    const { m, lineNumber, column } = at;
    const model = ed.getModel();
    const line = model.getLineContent(lineNumber);
    ed.pushUndoStop();
    if (!line.slice(m[0].length).trim()) {
      ed.executeEdits('markdown-list', [{ range: new monaco.Range(lineNumber, 1, lineNumber, line.length + 1), text: '' }],
        [new monaco.Selection(lineNumber, 1, lineNumber, 1)]);
    } else {
      const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
      const next = `${model.getEOL()}${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`;
      const rest = line.slice(column - 1).replace(/^[ \t]+/, '');
      const range = new monaco.Range(lineNumber, column, lineNumber, line.length + 1);
      const caretCol = m[1].length + marker.length + m[5].length + (m[6] ? 4 : 0) + 1;
      ed.executeEdits('markdown-list', [{ range, text: next + rest }], [new monaco.Selection(lineNumber + 1, caretCol, lineNumber + 1, caretCol)]);
    }
    ed.pushUndoStop();
    ed.revealPosition(ed.getPosition());
    return true;
  }
  ide.onEditor((ed) => {
    const key = ed.createContextKey('markdownListItem', false);
    const update = () => key.set(!!itemAt(ed));
    ed.onDidChangeCursorSelection(update);
    ed.onDidChangeModel(update);
    ed.onDidChangeModelContent(update);
  });
  monaco.editor.addCommand({ id: 'languageBasics.continueList', run: () => { const ed = monaco.editor.getEditors().find((e) => e.hasTextFocus()); if (ed) continueList(ed); } });
  monaco.editor.addKeybindingRules([{
    keybinding: monaco.KeyCode.Enter, command: 'languageBasics.continueList',
    when: 'markdownListItem && editorTextFocus && !editorReadonly && !suggestWidgetVisible && !inSnippetMode',
  }]);

  // ---------- JSX ----------
  // .jsx and .tsx files hold JSX: without the option, Monaco's TypeScript service reports every element as an error.
  const ts = monaco.typescript || monaco.languages.typescript;
  for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
    if (d && ts.JsxEmit) d.setCompilerOptions({ ...d.getCompilerOptions(), jsx: ts.JsxEmit.Preserve });
  }

  ide.languageBasics = { keywords, markdownFolds, continueList, registerKeywords };
})();
