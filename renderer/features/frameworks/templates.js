// Django and Jinja2 template languages ('django-html', 'jinja2'): Monaco's HTML grammar with {% %}, {{ }} and {# #}
// regions, HTML completion from Monaco's HTML service, tag/filter/template-name/URL-name completion, and Ctrl+B
// (or Ctrl+Click) from {% extends/include %}, {% url %}, url_for(), render('x.html'), include('app.urls'),
// reverse('name') and urls.py patterns to the template, module or view they name.
(() => {
  const fw = ide.frameworks;
  const monaco = ide.monaco;
  const LANGS = ['django-html', 'jinja2'];

  const DJANGO_TAGS = ['autoescape', 'block', 'comment', 'csrf_token', 'cycle', 'debug', 'extends', 'filter', 'firstof',
    'for', 'empty', 'if', 'elif', 'else', 'ifchanged', 'include', 'load', 'lorem', 'now', 'regroup', 'resetcycle',
    'spaceless', 'templatetag', 'url', 'verbatim', 'widthratio', 'with', 'partialdef', 'partial'];
  const DJANGO_LIB_TAGS = { static: ['static', 'get_static_prefix', 'get_media_prefix'],
    i18n: ['trans', 'translate', 'blocktrans', 'blocktranslate', 'plural', 'get_current_language', 'get_available_languages', 'language'],
    tz: ['localtime', 'timezone', 'get_current_timezone'], l10n: ['localize'], cache: ['cache'] };
  const DJANGO_FILTERS = ['add', 'addslashes', 'capfirst', 'center', 'cut', 'date', 'default', 'default_if_none', 'dictsort',
    'dictsortreversed', 'divisibleby', 'escape', 'escapejs', 'escapeseq', 'filesizeformat', 'first', 'floatformat',
    'force_escape', 'get_digit', 'iriencode', 'join', 'json_script', 'last', 'length', 'linebreaks', 'linebreaksbr',
    'linenumbers', 'ljust', 'lower', 'make_list', 'phone2numeric', 'pluralize', 'pprint', 'random', 'rjust', 'safe',
    'safeseq', 'slice', 'slugify', 'stringformat', 'striptags', 'time', 'timesince', 'timeuntil', 'title',
    'truncatechars', 'truncatechars_html', 'truncatewords', 'truncatewords_html', 'unordered_list', 'upper',
    'urlencode', 'urlize', 'urlizetrunc', 'wordcount', 'wordwrap', 'yesno'];
  const JINJA_TAGS = ['autoescape', 'block', 'call', 'do', 'extends', 'filter', 'for', 'from', 'if', 'elif', 'else',
    'import', 'include', 'macro', 'raw', 'set', 'trans', 'pluralize', 'with', 'break', 'continue'];
  const JINJA_FILTERS = ['abs', 'attr', 'batch', 'capitalize', 'center', 'count', 'default', 'dictsort', 'escape',
    'filesizeformat', 'first', 'float', 'forceescape', 'format', 'groupby', 'indent', 'int', 'items', 'join', 'last',
    'length', 'list', 'lower', 'map', 'max', 'min', 'pprint', 'random', 'reject', 'rejectattr', 'replace', 'reverse',
    'round', 'safe', 'select', 'selectattr', 'slice', 'sort', 'string', 'striptags', 'sum', 'title', 'tojson', 'trim',
    'truncate', 'unique', 'upper', 'urlencode', 'urlize', 'wordcount', 'wordwrap', 'xmlattr'];
  const JINJA_GLOBALS = ['url_for', 'get_flashed_messages', 'config', 'request', 'session', 'g', 'range', 'lipsum',
    'dict', 'cycler', 'joiner', 'namespace', 'loop', 'self', 'super', 'caller', 'varargs', 'kwargs'];
  // Tags that open a block closed by end<name>.
  const BLOCK_TAGS = new Set(['autoescape', 'block', 'comment', 'filter', 'for', 'if', 'ifchanged', 'spaceless', 'verbatim',
    'with', 'blocktrans', 'blocktranslate', 'cache', 'localize', 'localtime', 'timezone', 'language', 'call', 'macro',
    'raw', 'trans', 'partialdef']);
  const TEMPLATE_STRING_TAGS = /\{%-?\s*(?:extends|include|import|from|embed)\s+(?:[^%]*?\s)?$/;

  // ---------- grammar ----------
  const TEMPLATE_STATES = {
    tplOpen: [
      [/\{%-?\s*(comment)\s*-?%\}/, { token: 'comment', next: '@tplLongComment' }],
      [/(\{%-?)(\s*)(verbatim|raw)(\s*-?%\})/, ['keyword', '', 'keyword', { token: 'keyword', next: '@tplVerbatim' }]],
      [/\{%-?/, { token: 'keyword', next: '@tplTagName' }],
      [/\{\{-?/, { token: 'keyword', next: '@tplExpr' }],
      [/\{#/, { token: 'comment', next: '@tplComment' }],
    ],
    tplTagName: [
      [/\s+/, ''],
      [/[a-zA-Z_]\w*/, { token: 'keyword', switchTo: '@tplTag' }],
      [/-?%\}/, { token: 'keyword', next: '@pop' }],
      [/./, { token: '', switchTo: '@tplTag' }],
    ],
    tplTag: [[/-?%\}/, { token: 'keyword', next: '@pop' }], { include: '@tplInner' }],
    tplExpr: [[/-?\}\}/, { token: 'keyword', next: '@pop' }], { include: '@tplInner' }],
    tplInner: [
      [/\s+/, ''],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/\d+(\.\d+)?/, 'number'],
      [/(\|)(\s*)([a-zA-Z_]\w*)/, ['delimiter', '', 'function']],
      [/\b(in|not|and|or|is|as|with|only|by|from|import|if|else|true|false|none|True|False|None|reversed|silent|context|without|ignore|missing|recursive)\b/, 'keyword'],
      [/[a-zA-Z_]\w*(?=\s*\()/, 'function'],
      [/[a-zA-Z_]\w*/, 'identifier'],
      [/[=<>!+\-*/%~.,:()[\]]/, 'delimiter'],
      [/./, ''],
    ],
    tplComment: [[/#\}/, { token: 'comment', next: '@pop' }], [/[^#]+/, 'comment'], [/#/, 'comment']],
    tplLongComment: [[/\{%-?\s*endcomment\s*-?%\}/, { token: 'comment', next: '@pop' }], [/[^{]+/, 'comment'], [/\{/, 'comment']],
    tplVerbatim: [[/(\{%-?)(\s*)(endverbatim|endraw)(\s*-?%\})/, ['keyword', '', 'keyword', { token: 'keyword', next: '@pop' }]], [/[^{]+/, ''], [/\{/, '']],
  };

  // Monaco's own HTML grammar, with the template openers tried first in every HTML state.
  async function grammar() {
    const html = monaco.languages.getLanguages().find((l) => l.id === 'html');
    const mod = html?.loader ? await html.loader() : null;
    if (!mod?.language) return { language: { defaultToken: '', tokenPostfix: '.html', tokenizer: { root: [{ include: '@tplOpen' }, [/<\/?[\w-]+/, 'tag'], [/[^<{]+/, ''], [/./, '']], ...TEMPLATE_STATES } }, conf: {} };
    const language = structuredClone(mod.language);
    for (const [name, rules] of Object.entries(language.tokenizer)) language.tokenizer[name] = [{ include: '@tplOpen' }, ...rules];
    Object.assign(language.tokenizer, TEMPLATE_STATES);
    return { language, conf: { ...mod.conf, comments: { blockComment: ['{#', '#}'] } } };
  }

  // Monaco starts a language's worker by its label (the language id) and gives the HTML worker only to html, handlebars
  // and razor; any other label gets the plain editor worker, which has no HTML service (findDocumentLinks fails there).
  const env = self.MonacoEnvironment;
  const getWorker = env?.getWorker;
  if (getWorker) env.getWorker = (moduleId, label) => getWorker.call(env, moduleId, LANGS.includes(label) ? 'html' : label);

  const ready = (async () => {
    const { language, conf } = await grammar();
    for (const id of LANGS) {
      monaco.languages.register({ id, aliases: [id === 'jinja2' ? 'Jinja2' : 'Django Template'] });
      monaco.languages.setMonarchTokensProvider(id, language);
      monaco.languages.setLanguageConfiguration(id, conf);
      monaco.languages.html?.registerHTMLLanguageService?.(id, {}, {
        completionItems: true, hovers: true, documentHighlights: true, links: true, foldingRanges: true, selectionRanges: true,
        documentSymbols: true, documentFormattingEdits: false, documentRangeFormattingEdits: false, colors: false, diagnostics: false, rename: false,
      });
    }
  })();

  // Template files get the project's template language; everything else keeps what the core picked.
  async function applyLanguages() {
    await ready;
    for (const tab of ide.tabs) {
      if (tab.kind !== 'file' || !tab.model || tab.model.isDisposed()) continue;
      const lang = fw.templateLanguage(tab.path);
      const now = tab.model.getLanguageId();
      if (lang && now !== lang) monaco.editor.setModelLanguage(tab.model, lang);
      else if (!lang && LANGS.includes(now)) monaco.editor.setModelLanguage(tab.model, 'html');
    }
  }
  ide.on('fileOpened', applyLanguages);
  fw.onChange(applyLanguages);

  // ---------- context ----------
  const modelPath = (model) => ide.tabs.find((t) => t.model === model)?.path || model.uri.fsPath;
  const isDjango = (model) => model.getLanguageId() === 'django-html';

  // The unclosed {% or {{ before the caret: {kind: '%'|'{', inner}.
  function openRegion(model, position) {
    const start = Math.max(1, position.lineNumber - 5);
    const before = model.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
    const i = Math.max(before.lastIndexOf('{%'), before.lastIndexOf('{{'));
    if (i < 0) return null;
    const kind = before[i + 1];
    if (before.indexOf(kind === '%' ? '%}' : '}}', i) >= 0) return null;
    return { kind, inner: before.slice(i + 2).replace(/^-/, '') };
  }

  // Libraries named by {% load %} in the document (Django).
  function loadedLibraries(model) {
    const libs = new Set();
    for (const m of model.getValue().matchAll(/\{%-?\s*load\s+([^%]+?)\s*-?%\}/g)) {
      const words = m[1].split(/\s+/);
      const from = words.indexOf('from');
      for (const w of from >= 0 ? words.slice(from + 1) : words) libs.add(w);
    }
    return libs;
  }

  function libraries() {
    const project = fw.info()?.templateLibs || {};
    const all = { ...Object.fromEntries(Object.entries(DJANGO_LIB_TAGS).map(([k, tags]) => [k, { tags, filters: [] }])), ...project };
    return all;
  }

  // Block tags still open at the caret, innermost last.
  function openBlocks(model, position) {
    const text = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
    const stack = [];
    for (const m of text.matchAll(/\{%-?\s*(\w+)/g)) {
      const name = m[1];
      if (name.startsWith('end')) {
        const i = stack.lastIndexOf(name.slice(3));
        if (i >= 0) stack.splice(i);
      } else if (BLOCK_TAGS.has(name)) stack.push(name);
    }
    return stack;
  }

  // Blocks defined in the templates this one extends.
  async function parentBlocks(model) {
    const names = new Set();
    let text = model.getValue();
    for (let depth = 0; depth < 6; depth++) {
      const m = text.match(/\{%-?\s*extends\s+["']([^"']+)["']/);
      const t = m && fw.templateByName(m[1]);
      if (!t) break;
      const tab = ide.findTab(t.path);
      text = tab?.model && !tab.model.isDisposed() ? tab.model.getValue() : await ide.api.read(t.path).catch(() => '');
      for (const b of text.matchAll(/\{%-?\s*block\s+(\w+)/g)) names.add(b[1]);
    }
    return [...names];
  }

  // ---------- completion ----------
  const K = monaco.languages.CompletionItemKind;
  const item = (label, kind, range, extra = {}) => ({ label, kind, insertText: label, range, ...extra });
  function wordRange(model, position, prefix) {
    return { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column - prefix.length, endColumn: position.column };
  }

  async function completions(model, position) {
    const region = openRegion(model, position);
    if (!region) return [];
    const django = isDjango(model);
    const info = fw.info();
    const { inner } = region;
    let m;
    const filters = () => {
      const extra = django ? [...loadedLibraries(model)].flatMap((l) => libraries()[l]?.filters || []) : [];
      return [...(django ? DJANGO_FILTERS : JINJA_FILTERS), ...extra];
    };
    if ((m = inner.match(/\|\s*(\w*)$/))) {
      const r = wordRange(model, position, m[1]);
      return [...new Set(filters())].map((f) => item(f, K.Function, r));
    }
    if (region.kind === '%') {
      if ((m = inner.match(/^\s*(\w*)$/))) {
        const r = wordRange(model, position, m[1]);
        const custom = django ? [...loadedLibraries(model)].flatMap((l) => libraries()[l]?.tags || []) : [];
        const ends = openBlocks(model, position).reverse().map((t, i) => item(`end${t}`, K.Keyword, r, { sortText: `0${i}` }));
        return [...ends, ...[...new Set([...(django ? DJANGO_TAGS : JINJA_TAGS), ...custom])].map((t) => item(t, K.Keyword, r, { sortText: `1${t}` }))];
      }
      if ((m = inner.match(/^\s*(?:extends|include|import|from|embed)\s+(?:[^"']*\s)?(["'])([^"']*)$/))) {
        const r = wordRange(model, position, m[2]);
        const self = modelPath(model);
        return (info?.templates || []).filter((t) => !ide.util.samePath(t.path, self)).map((t) => item(t.name, K.File, r));
      }
      if (django && (m = inner.match(/^\s*url\s+(["'])([^"']*)$/))) {
        const r = wordRange(model, position, m[2]);
        return (info?.routes || []).filter((x) => x.framework === 'django' && x.name).map((x) => item(x.name, K.Reference, r, { detail: x.path }));
      }
      if (django && (m = inner.match(/^\s*load\s+(?:[\w.]+\s+)*([\w.]*)$/))) {
        const r = wordRange(model, position, m[1]);
        return Object.keys(libraries()).map((l) => item(l, K.Module, r));
      }
      if ((m = inner.match(/^\s*block\s+(\w*)$/))) {
        const r = wordRange(model, position, m[1]);
        return (await parentBlocks(model)).map((b) => item(b, K.Property, r));
      }
    }
    if (!django && (m = inner.match(/url_for\(\s*(["'])([^"']*)$/))) {
      const r = wordRange(model, position, m[2]);
      return ['static', ...(info?.routes || []).filter((x) => x.framework === 'flask').map((x) => x.name)].map((n) => item(n, K.Reference, r));
    }
    if (!django && region.kind === '{' && (m = inner.match(/(?:^|[\s(,[])(\w*)$/))) {
      const r = wordRange(model, position, m[1]);
      return JINJA_GLOBALS.map((g) => item(g, K.Variable, r));
    }
    return [];
  }

  for (const id of LANGS) {
    monaco.languages.registerCompletionItemProvider(id, {
      triggerCharacters: ['%', '{', '|', ' ', '"', "'", '/', ':'],
      provideCompletionItems: async (model, position) => ({ suggestions: await completions(model, position) }),
    });
  }

  // ---------- navigation ----------
  // The string literal around caret offset `at` in `text`: {value, before} where `before` is the text before it.
  function stringAt(text, at) {
    for (const m of text.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)) {
      if (at > m.index && at < m.index + m[0].length) return { value: m[2], before: text.slice(0, m.index) };
    }
    return null;
  }

  // In a template the string is looked for inside the {% %} or {{ }} around the caret, which may itself sit in an
  // HTML attribute's quotes (href="{% url 'x' %}").
  function templateStringAt(line, at) {
    const open = Math.max(line.lastIndexOf('{%', at - 1), line.lastIndexOf('{{', at - 1));
    if (open < 0) return null;
    const close = line.indexOf(line[open + 1] === '%' ? '%}' : '}}', open + 2);
    if (close >= 0 && close + 2 <= at) return null;
    return stringAt(line.slice(open, close < 0 ? line.length : close + 2), at - open);
  }

  const routeByName = (name, framework) => fw.info()?.routes.find((r) => r.name === name && (!framework || r.framework === framework)) || null;
  const viewOf = (r) => (r?.viewFile ? { path: r.viewFile, line: r.viewLine } : null);

  // {path, line} the caret's reference leads to, or null so Ctrl+B falls through to Pyright.
  function targetAt(model, position) {
    const info = fw.info();
    if (!info) return null;
    const lang = model.getLanguageId();
    const line = model.getLineContent(position.lineNumber);
    const s = LANGS.includes(lang) ? templateStringAt(line, position.column - 1) : stringAt(line, position.column - 1);
    if (!s) return null;
    if (LANGS.includes(lang)) {
      if (TEMPLATE_STRING_TAGS.test(s.before)) {
        const t = fw.templateByName(s.value);
        return t ? { path: t.path, line: 1 } : null;
      }
      if (/\{%-?\s*url\s+$/.test(s.before)) return viewOf(routeByName(s.value, 'django'));
      if (/url_for\(\s*$/.test(s.before)) return viewOf(routeByName(s.value, 'flask'));
      return null;
    }
    if (lang !== 'python') return null;
    const path = modelPath(model);
    const urlconf = Object.values(info.django?.urlconfs || {}).some((p) => ide.util.samePath(p, path));
    if (urlconf && /\binclude\(\s*\(?\s*$/.test(s.before)) {
      const file = info.django.urlconfs[s.value];
      return file ? { path: file, line: 1 } : null;
    }
    if (urlconf && /\b(re_)?path\(\s*$/.test(s.before)) {
      return viewOf(info.routes.find((r) => ide.util.samePath(r.file, path) && r.line === position.lineNumber));
    }
    if (/\b(reverse|reverse_lazy|redirect|resolve_url|url_for)\(\s*$/.test(s.before)) {
      const r = routeByName(s.value);
      if (r) return viewOf(r);
    }
    const t = fw.templateByName(s.value);
    return t ? { path: t.path, line: 1 } : null;
  }

  function gotoTarget(target) {
    return ide.openFile(target.path, { line: target.line, col: 1 });
  }

  for (const id of [...LANGS, 'python']) {
    monaco.languages.registerDefinitionProvider(id, {
      async provideDefinition(model, position) {
        const t = targetAt(model, position);
        if (t) await ide.previewModel?.(t.path); // Ctrl+hover previews the target through its model
        return t ? [{ uri: monaco.Uri.file(t.path), range: new monaco.Range(t.line, 1, t.line, 1) }] : null;
      },
    });
  }

  // Registered once every plugin has loaded, so it runs before Pyright's Ctrl+B and falls through to it otherwise.
  let pending = null;
  fw.onReady(() => ide.registerAction({
    id: 'Frameworks.GotoDeclaration', title: tr('Go to Template or View'), keys: 'Ctrl+B',
    when: () => {
      const ed = ide.editor;
      const model = ed?.hasTextFocus() && ed.getModel();
      pending = model ? targetAt(model, ed.getPosition()) : null;
      return !!pending;
    },
    run: () => pending && gotoTarget(pending),
  }));

  fw.templates = { ready: () => ready, completions, targetAt, languages: LANGS };
})();
