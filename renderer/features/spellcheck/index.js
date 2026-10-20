// Spell checker, PyCharm's "Typo" inspection: English words in comments, docstrings and strings, the names a Python
// file defines (split on camelCase and snake_case), Markdown text and the commit message. Hunspell en_US runs on a
// worker in the main process (main/features/spellcheck.js); this side extracts the words of the lines in view, asks
// only about words it has not seen before, and keeps each line's typos so an edit rechecks just the changed lines.
(() => {
  const { monaco } = ide;
  const { el } = ide.util;
  const OWNER = 'spellcheck';
  const KEY_ENABLED = 'spellcheck.enabled';
  const KEY_USER = 'spellcheck.userWords';
  // Set by the Settings page on OK/Apply, written to the project dictionary file here, then cleared.
  const KEY_PROJECT_EDIT = 'spellcheck.projectWordsEdit';
  const LANGS = new Set(['python', 'markdown']);
  const MARGIN = 10; // lines checked above and below the viewport
  const SLICE_MS = 8; // longest stretch of word extraction per idle callback

  // Never flagged: Python keywords and builtins (names are checked) and programming words an English dictionary lacks.
  const KEYWORDS = `false none true and as assert async await break class continue def del elif else except finally for
    from global if import in is lambda nonlocal not or pass raise return try while with yield match case type self cls`;
  const BUILTINS = `abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex
    delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id
    input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print
    property range repr reversed round set setattr slice sorted staticmethod str sum super tuple vars zip
    basestring unicode xrange ellipsis notimplemented arithmeticerror assertionerror attributeerror baseexception
    blockingioerror brokenpipeerror buffererror byteswarning childprocesserror connectionabortederror connectionerror
    connectionrefusederror connectionreseterror deprecationwarning eoferror environmenterror exceptiongroup
    fileexistserror filenotfounderror floatingpointerror futurewarning generatorexit importerror importwarning
    indentationerror indexerror interruptederror isadirectoryerror keyerror keyboardinterrupt lookuperror memoryerror
    modulenotfounderror nameerror notadirectoryerror notimplementederror oserror overflowerror pendingdeprecationwarning
    permissionerror processlookuperror recursionerror referenceerror resourcewarning runtimeerror runtimewarning
    stopasynciteration stopiteration syntaxerror syntaxwarning systemerror systemexit taberror timeouterror typeerror
    unboundlocalerror unicodedecodeerror unicodeencodeerror unicodeerror unicodetranslateerror unicodewarning
    userwarning valueerror warning zerodivisionerror __init__ __main__ __name__ __file__ __doc__ __dict__`;
  const PROGRAMMING = `args kwargs kwarg argv argc json jsonl http https utf ascii stdout stderr stdin init str dict bool len
    repr func funcs param params config configs conf src dst tmp temp env envs url urls uri uris api apis cli gui regex
    regexp impl util utils lib libs dir dirs cwd ctx obj objs idx num nums cnt msg msgs err errs req reqs res resp
    async await dtype dtypes ndarray numpy pandas dataframe dataframes matplotlib pyplot plt sklearn scipy pytest
    unittest setattr getattr hasattr delattr isinstance issubclass iter iterable iterables iterator iterators enum enums
    namespace namespaces tuple tuples nonlocal lambda lambdas todo fixme xxx docstring docstrings stacktrace traceback
    tracebacks localhost auth oauth admin username usernames hostname hostnames filename filenames filepath filepaths
    dirname dirnames basename pathname pathlib toml yaml yml csv tsv xml html css sql sqlite postgres postgresql mysql
    mariadb redis mongo mongodb django flask fastapi pydantic starlette uvicorn gunicorn jinja asyncio coroutine
    coroutines unicode endian bitmask mutex mutexes stdlib subclass subclasses subclassing superclass metaclass
    metaclasses mixin mixins middleware middlewares runtime runtimes timestamp timestamps datetime datetimes timezone
    timezones tzinfo uuid uuids sha md5 base64 hashable callable callables awaitable awaitables serializer serializers
    deserialize deserialized deserializer serialize serialized serialization plugin plugins webhook webhooks websocket
    websockets frontend backend backends repo repos github gitlab bitbucket dev devs prod venv venvs virtualenv
    pip pipenv pipfile conda pypi npm npx workspace workspaces linter linters lint linting pyright pylance mypy ruff
    flake pylint refactor refactors refactoring refactored dedent dedented newline newlines whitespace whitespaces
    lookup lookups getter getters setter setters ctor dtor deque heapq itertools functools contextlib dataclass
    dataclasses typing typeddict namedtuple preprocess preprocessing preprocessed postprocess postprocessing tokenizer
    tokenizers tokenize tokenized embedding embeddings softmax relu sigmoid tensor tensors torch pytorch tensorflow keras
    cuda gpu gpus cpu cpus subprocess subprocesses multiprocessing threading async sys os boolean booleans int ints
    float floats bytestring bytestrings charset charsets codec codecs encodings unescape unescaped escaped quoted
    readonly readline readlines writelines stdio ipc rpc grpc tcp udp ssl tls ssh ftp smtp imap dns ipv ip
    cdn cors csrf jwt saml ldap xss sdk sdks ide ides vscode pycharm jupyter ipython ipykernel notebook notebooks
    matplotlib seaborn plotly bokeh scikit sympy numba cython pypy mkdir rmdir chdir chmod chown symlink symlinks
    filesystem filesystems pathname pathnames glob globs globbing wildcard wildcards dict dicts str strs args'
    config's app's url's backend's frontend's async's num's subdir subdirs subfolder subfolders submodule submodules
    subpackage subpackages subcommand subcommands substring substrings sublist sublists subprocess's eof crlf utf8
    utf16 sep delim delimiter delimiters prefixed suffixed lowercase uppercase lowercased uppercased camelcase
    snakecase kebab kebabcase alphanumeric nullable truthy falsy falsey inlined inline inlining unpack unpacked
    unpacking repack iterate iterates iterating iteration overridable overridden override overrides misc etc
    approx calc decrement incrementing decrementing init'd parallelize parallelized parallelism multiline
    autocomplete autocompletion autoformat autosave autoreload autoload hotkey hotkeys keymap keymaps keybinding
    keybindings checkbox checkboxes dropdown dropdowns tooltip tooltips popup popups navbar sidebar statusbar toolbar
    toolbars viewport viewports scrollbar scrollbars stylesheet stylesheets favicon favicons screenshot screenshots
    cpython numpy's pandas' dtype's pre post mid fallback fallbacks rollback rollbacks gzip zip unzip tarball
    tarballs untar binaries changelog changelogs readme roadmap todos signup login logout logins signin signout
    whitelist blacklist allowlist denylist blocklist natively hardcode hardcoded hardcoding versioning versioned
    unversioned stateful stateless idempotent idempotency memoize memoized memoization cacheable uncached
    enqueue dequeue enqueued dequeued`;
  const IGNORE = new Set();
  for (const block of [KEYWORDS, BUILTINS, PROGRAMMING]) for (const w of block.split(/\s+/)) if (w) IGNORE.add(w);

  let enabled = ide.settings.get(KEY_ENABLED, true) !== false;
  let userWords = new Set((ide.settings.get(KEY_USER, []) || []).map((w) => w.toLowerCase()));
  let projectWords = new Set();
  // Names that code imports or reads as attributes in the open files (library names such as linspace, getcwd).
  const knownCode = new Set();
  const verdicts = new Map(); // lower-case word -> true when it is a typo
  const suggestions = new Map(); // word -> Promise<string[]>
  const stats = { passes: 0, maxSliceMs: 0, checked: 0, requests: 0 };

  const ignored = (lower) => IGNORE.has(lower) || userWords.has(lower) || projectWords.has(lower) || knownCode.has(lower);
  const isTypo = (w) => verdicts.get(w.lower) === true && !ignored(w.lower);

  // ---------- words ----------
  // Spans that are not prose: URLs, e-mail addresses, paths, HTML entities, %-placeholders. E-mail addresses and paths
  // are tried only where their run of characters starts (the leftmost match starts there anyway): tried at every
  // character, a long run without @ or a slash (base64 in a string) cost time quadratic in its length.
  const SKIP = /\b[a-z][\w+.-]*:\/\/[^\s"'<>()`]+|\bwww\.[^\s"'<>()`]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<!\S)\S*[\\/]\S*|&#?\w+;|%[-#0 +]*\d*(?:\.\d+)?[a-zA-Z]/g;
  const TOKEN = /[\p{L}\p{N}_'’]+/gu;
  const PART = /[A-Z]+(?![a-z])|[A-Z]?[a-z']+/g;
  const HEX = /^(?:0x[0-9a-f]+|(?=[0-9a-f]*\d)[0-9a-f]{6,})$/i;
  const mask = (text, re) => text.replace(re, (m) => ' '.repeat(m.length));

  // Words of an identifier or a prose token: snake_case and camelCase parts, digits as separators.
  function partsOf(token, offset, out) {
    if (/[^\x00-\x7f]/.test(token) || HEX.test(token)) return; // Hangul, other scripts and accented words are left alone
    for (const chunk of token.matchAll(/[A-Za-z']+/g)) {
      for (const p of chunk[0].matchAll(PART)) {
        let word = p[0];
        let start = offset + chunk.index + p.index;
        const lead = word.length - word.replace(/^'+/, '').length;
        word = word.slice(lead).replace(/'+$/, '');
        start += lead;
        if (word.replace(/'/g, '').length < 3 || word === word.toUpperCase()) continue;
        const lower = word.toLowerCase();
        if (!ignored(lower)) out.push({ word, lower, start, end: start + word.length });
      }
    }
  }
  function proseWords(text, offset, out) {
    for (const t of mask(text, SKIP).matchAll(TOKEN)) partsOf(t[0], offset + t.index, out);
  }

  // Names a line of Python code defines: def/class names and parameters, assignment targets, loop and `as` names.
  const DEF = /\b(def|class)\s+([A-Za-z_]\w*)/;
  const PARAM = /(?:^|[(,])\s*\*{0,2}([A-Za-z_]\w*)\s*(?=[:=,)]|$)/g;
  const ASSIGN = /^\s*((?:(?:self|cls)\.)?[A-Za-z_]\w*(?:\s*,\s*(?:(?:self|cls)\.)?[A-Za-z_]\w*)*)\s*(?::[^=]+)?=(?!=)/;
  const LOOP = /\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\b|\bas\s+([A-Za-z_]\w*)/g;
  function definedNames(code, out) {
    const names = (text, base) => { for (const m of text.matchAll(/[A-Za-z_]\w*/g)) if (m[0] !== 'self' && m[0] !== 'cls') partsOf(m[0], base + m.index, out); };
    const def = DEF.exec(code);
    if (def) {
      const at = def.index + def[0].length - def[2].length;
      partsOf(def[2], at, out);
      const paren = code.indexOf('(', at);
      if (def[1] === 'def' && paren >= 0) for (const m of code.slice(paren).matchAll(PARAM)) names(m[1], paren + m.index + m[0].indexOf(m[1]));
      return;
    }
    const assign = ASSIGN.exec(code);
    if (assign) names(assign[1], assign.index + assign[0].indexOf(assign[1]));
    for (const m of code.matchAll(LOOP)) {
      const n = m[1] || m[2];
      names(n, m.index + m[0].indexOf(n));
    }
  }

  // Imported names and attributes read from anything but self/cls count as known words in every file.
  function harvestKnown(text) {
    let added = false;
    const add = (name) => {
      const out = [];
      partsOf(name, 0, out);
      for (const w of out) if (!knownCode.has(w.lower)) { knownCode.add(w.lower); added = true; }
    };
    for (const m of text.matchAll(/^[ \t]*(?:from|import)[ \t].*$/gm)) for (const n of m[0].matchAll(/[A-Za-z_]\w*/g)) add(n[0]);
    // A name starts only where a word starts: tried at every letter of a long word (a 100 KB string literal), the
    // pattern backtracked over the rest of it each time, and a 400 KB line took two minutes.
    for (const m of text.matchAll(/((?<!\w)[A-Za-z_]\w*|[)\]])\s*\.\s*([A-Za-z_]\w*)/g)) if (m[1] !== 'self' && m[1] !== 'cls') add(m[2]);
    return added;
  }

  function pythonLine(model, ln) {
    model.tokenization.forceTokenization(ln);
    const lt = model.tokenization.getLineTokens(ln);
    const text = model.getLineContent(ln);
    const out = [];
    let code = '';
    for (let i = 0; i < lt.getCount(); i++) {
      const s = lt.getStartOffset(i);
      const e = lt.getEndOffset(i);
      const type = lt.getStandardTokenType(i); // 1 comment, 2 string
      if (type === 1 || type === 2) {
        proseWords(text.slice(s, e), s, out);
        code += ' '.repeat(e - s);
      } else code += text.slice(s, e);
    }
    definedNames(code, out);
    return out;
  }

  // Fenced code blocks are skipped; the fence state is computed once per model version.
  const fences = new WeakMap();
  function inFence(model, ln) {
    let f = fences.get(model);
    if (!f || f.version !== model.getVersionId()) {
      const inside = [];
      let open = null;
      const n = model.getLineCount();
      for (let i = 1; i <= n; i++) {
        const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(model.getLineContent(i))?.[1];
        if (fence && (!open || (fence[0] === open[0] && fence.length >= open.length))) { inside[i] = true; open = open ? null : fence; } else inside[i] = !!open;
      }
      f = { version: model.getVersionId(), inside };
      fences.set(model, f);
    }
    return !!f.inside[ln];
  }
  function markdownText(text) {
    return mask(mask(mask(mask(text, /`[^`]*`/g), /\]\([^)]*\)/g), /<[^>]+>/g), /^\s*\[[^\]]+\]:\s*\S+/);
  }
  function markdownLine(model, ln) {
    if (inFence(model, ln)) return [];
    const out = [];
    proseWords(markdownText(model.getLineContent(ln)), 0, out);
    return out;
  }
  const lineWords = (model, ln) => (model.getLanguageId() === 'python' ? pythonLine(model, ln) : markdownLine(model, ln));

  // Unknown words go to the worker in one batch per pass.
  let inflight = null;
  async function resolve(words) {
    const unknown = [...new Set(words.filter((w) => !verdicts.has(w.lower)).map((w) => w.lower))];
    if (!unknown.length) return;
    stats.requests++;
    stats.checked += unknown.length;
    const typos = new Set(await ide.api.invoke('spellcheck:check', unknown));
    for (const w of unknown) verdicts.set(w, typos.has(w));
  }

  // ---------- editors ----------
  // model -> {lines: Map<line, typos[]>, dirty: lines whose tokens changed (their typos stay until rechecked)}
  const states = new Map();
  function stateOf(model) {
    let st = states.get(model);
    if (st) return st;
    st = { lines: new Map(), dirty: new Set(), timer: 0, idle: 0, retries: 0, harvested: false };
    states.set(model, st);
    const subs = [
      model.onDidChangeContent((e) => {
        for (const c of [...e.changes].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber)) {
          const start = c.range.startLineNumber;
          const end = c.range.endLineNumber;
          const delta = c.text.split('\n').length - 1 - (end - start);
          const next = new Map();
          for (const [ln, typos] of st.lines) {
            if (ln < start) next.set(ln, typos);
            else if (ln > end) next.set(ln + delta, typos);
          }
          st.lines = next;
          st.dirty = new Set([...st.dirty].filter((ln) => ln < start || ln > end).map((ln) => (ln > end ? ln + delta : ln)));
        }
        schedule(model, 300);
      }),
      // A quote or comment start changes how later lines tokenize.
      model.tokenization.onDidChangeTokens((e) => {
        for (const r of e.ranges) {
          if (r.toLineNumber - r.fromLineNumber > st.lines.size) {
            for (const ln of st.lines.keys()) if (ln >= r.fromLineNumber && ln <= r.toLineNumber) st.dirty.add(ln);
          } else {
            for (let ln = r.fromLineNumber; ln <= r.toLineNumber; ln++) if (st.lines.has(ln)) st.dirty.add(ln);
          }
        }
        if (st.dirty.size) schedule(model, 300);
      }),
      model.onDidChangeLanguage(() => { st.lines.clear(); st.dirty.clear(); publish(model); schedule(model, 0); }),
    ];
    model.onWillDispose(() => {
      clearTimeout(st.timer);
      cancelIdleCallback(st.idle);
      subs.forEach((s) => s.dispose());
      states.delete(model);
    });
    return st;
  }

  const checks = (model) => !!model && !model.isDisposed() && LANGS.has(model.getLanguageId()) && model.uri.scheme !== 'inmemory';
  function visibleLines(model) {
    const n = model.getLineCount();
    const lines = new Set();
    for (const ed of editors) {
      if (ed.getModel() !== model) continue;
      for (const r of ed.getVisibleRanges()) {
        for (let ln = Math.max(1, r.startLineNumber - MARGIN); ln <= Math.min(n, r.endLineNumber + MARGIN); ln++) lines.add(ln);
      }
    }
    return [...lines].sort((a, b) => a - b);
  }

  function schedule(model, delay) {
    if (!enabled || !checks(model)) return;
    const st = stateOf(model);
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      cancelIdleCallback(st.idle);
      st.idle = requestIdleCallback(() => pass(model), { timeout: 1000 });
    }, delay);
  }

  async function pass(model) {
    if (!enabled || !checks(model)) return;
    const st = stateOf(model);
    if (!st.harvested && model.getLanguageId() === 'python') {
      st.harvested = true;
      if (harvestKnown(model.getValue())) dropKnown();
    }
    const version = model.getVersionId();
    const found = new Map();
    const t0 = performance.now();
    const lines = visibleLines(model);
    // An editor that just switched to this model has no visible ranges until it renders.
    if (!lines.length && [...editors].some((ed) => ed.getModel() === model) && st.retries++ < 10) schedule(model, 100);
    if (lines.length) st.retries = 0;
    for (const ln of lines) {
      if (st.lines.has(ln) && !st.dirty.has(ln)) continue;
      found.set(ln, lineWords(model, ln));
      // Yield to input after a slice; the next idle callback continues with the lines still missing.
      if (performance.now() - t0 > SLICE_MS) { schedule(model, 0); break; }
    }
    stats.maxSliceMs = Math.max(stats.maxSliceMs, performance.now() - t0);
    stats.passes++;
    if (!found.size) return;
    const all = [...found.values()].flat();
    try {
      await (inflight = resolve(all));
    } catch (err) {
      ide.log.warn(`spellcheck: ${err.message}`);
      return;
    }
    if (model.isDisposed() || !enabled) return;
    if (model.getVersionId() !== version) { schedule(model, 100); return; }
    for (const [ln, words] of found) {
      st.lines.set(ln, words.filter(isTypo));
      st.dirty.delete(ln);
    }
    publish(model);
  }

  const published = new WeakMap(); // model -> signature of the markers last set
  const message = (word) => tr("Typo: In word '{word}'", { word });
  function publish(model) {
    const st = states.get(model);
    if (model.isDisposed()) return;
    const markers = [];
    if (enabled && st) {
      for (const [ln, typos] of st.lines) {
        for (const t of typos) {
          markers.push({ startLineNumber: ln, startColumn: t.start + 1, endLineNumber: ln, endColumn: t.end + 1, message: message(t.word), severity: monaco.MarkerSeverity.Hint, code: 'typo' });
        }
      }
    }
    // An unchanged set is not published again: a marker change restarts an open Alt+Enter request in Monaco.
    const sig = markers.map((m) => `${m.startLineNumber}:${m.startColumn}:${m.message}`).join('|');
    if (published.get(model) === sig) return;
    published.set(model, sig);
    monaco.editor.setModelMarkers(model, OWNER, markers);
  }

  function refilter() {
    for (const [model, st] of states) {
      for (const [ln, typos] of st.lines) st.lines.set(ln, typos.filter(isTypo));
      publish(model);
    }
    commit.render();
  }
  const dropKnown = refilter;
  // After a dictionary lost words (or the checker was switched on), check every visible line again.
  function rescanAll() {
    for (const [model, st] of states) { st.lines.clear(); st.dirty.clear(); publish(model); }
    for (const ed of editors) schedule(ed.getModel(), 0);
    commit.check();
  }
  function clearAll() {
    for (const [model, st] of states) { st.lines.clear(); st.dirty.clear(); clearTimeout(st.timer); cancelIdleCallback(st.idle); publish(model); }
    commit.render();
  }

  // Group editors and the ones viewers embed (the Markdown split view); ide.editors() lists only the former.
  const editors = new Set();
  function attach(editor) {
    editors.add(editor);
    editor.onDidDispose(() => editors.delete(editor));
    const kick = () => schedule(editor.getModel(), 0);
    editor.onDidChangeModel(kick);
    editor.onDidScrollChange((e) => { if (e.scrollTopChanged) schedule(editor.getModel(), 150); });
    editor.onDidLayoutChange(() => schedule(editor.getModel(), 150));
    kick();
  }
  ide.onEditor(attach);

  // ---------- quick fixes ----------
  function suggest(word) {
    if (!suggestions.has(word)) {
      const p = ide.api.invoke('spellcheck:suggest', word, 5).catch(() => []);
      p.then((list) => { p.value = list; });
      suggestions.set(word, p);
    }
    return suggestions.get(word);
  }
  function typosAt(model, range) {
    const st = states.get(model);
    if (!enabled || !st) return [];
    const out = [];
    for (let ln = range.startLineNumber; ln <= range.endLineNumber; ln++) {
      for (const t of st.lines.get(ln) || []) {
        const from = ln === range.startLineNumber ? range.startColumn : 1;
        const to = ln === range.endLineNumber ? range.endColumn : Infinity;
        if (t.start + 1 <= to && t.end + 1 >= from) out.push({ ...t, line: ln });
      }
    }
    return out;
  }

  // The project dictionary is a file in the project, which may be read-only; the word still counts for this session.
  const writeProjectDictionary = (root, words) => ide.api.invoke('spellcheck:writeProjectDictionary', root, words)
    .catch((err) => ide.log.warn(`spellcheck: cannot write the project dictionary: ${err.message}`));

  const SAVE = 'pyide.spellcheck.saveWord';
  monaco.editor.registerCommand(SAVE, (_accessor, word, scope) => saveWord(word, scope));
  async function saveWord(word, scope) {
    const lower = word.toLowerCase();
    if (scope === 'project' && ide.root) {
      projectWords.add(lower);
      await writeProjectDictionary(ide.root, [...projectWords]);
    } else {
      userWords.add(lower);
      ide.settings.set(KEY_USER, [...userWords].sort());
    }
    refilter();
  }

  const provider = {
    async provideCodeActions(model, range, context) {
      const typos = typosAt(model, range);
      if (!typos.length) return undefined;
      // The lightbulb asks on every caret move: answer it from cached suggestions and fetch the rest for Alt+Enter.
      const invoked = context.trigger === monaco.languages.CodeActionTriggerType.Invoke;
      const actions = [];
      for (const t of typos) {
        const p = suggest(t.word);
        const list = invoked ? await p : p.value || [];
        const range = new monaco.Range(t.line, t.start + 1, t.line, t.end + 1);
        const diagnostics = context.markers.filter((m) => m.code === 'typo' && m.startLineNumber === t.line && m.startColumn === t.start + 1);
        list.forEach((s, i) => actions.push({
          title: tr("Change to '{word}'", { word: s }), kind: 'quickfix', isPreferred: i === 0 && actions.length === 0, diagnostics,
          edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range, text: s } }] },
        }));
        if (ide.root) actions.push({ title: tr("Save '{word}' to project dictionary", { word: t.word }), kind: 'quickfix', diagnostics, command: { id: SAVE, title: '', arguments: [t.word, 'project'] } });
        actions.push({ title: tr("Save '{word}' to user dictionary", { word: t.word }), kind: 'quickfix', diagnostics, command: { id: SAVE, title: '', arguments: [t.word, 'user'] } });
      }
      return { actions, dispose() {} };
    },
  };
  for (const lang of LANGS) monaco.languages.registerCodeActionProvider(lang, provider, { providedCodeActionKinds: ['quickfix'] });

  // Alt+Enter on a typo in any checked file (the lsp feature's Alt+Enter covers Python; Markdown has none).
  const focusedEditor = () => [...editors].find((ed) => ed.hasTextFocus());
  const caretOnTypo = () => {
    const ed = focusedEditor();
    const model = ed?.getModel();
    if (!checks(model) || model.uri.scheme !== 'file') return false;
    const p = ed.getPosition();
    return typosAt(model, new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column)).length > 0;
  };
  ide.registerAction({ id: 'Spelling.ShowActions', title: tr('Show Context Actions'), keys: 'Alt+Enter', when: () => caretOnTypo() || commit.caretOnTypo(), run: () => (commit.caretOnTypo() ? commit.showActions() : focusedEditor().trigger('spellcheck', 'editor.action.quickFix', null)) });

  // ---------- commit message ----------
  // The vcs commit message is a textarea; an overlay of the same metrics draws the wavy underlines over it.
  const commit = (() => {
    let box = null;
    let overlay = null;
    let typos = [];
    let timer = 0;
    const wordsOf = (text) => {
      const out = [];
      let offset = 0;
      for (const line of text.split('\n')) {
        proseWords(markdownText(line), offset, out);
        offset += line.length + 1;
      }
      return out;
    };
    function render() {
      if (!box || !overlay) return;
      overlay.replaceChildren();
      if (!enabled) return;
      const text = box.value;
      let at = 0;
      for (const t of typos.filter(isTypo)) {
        if (t.start < at || text.slice(t.start, t.end) !== t.word) continue;
        overlay.append(text.slice(at, t.start), el('span', 'spell-typo', t.word));
        at = t.end;
      }
      overlay.append(text.slice(at), '\n');
      overlay.scrollTop = box.scrollTop;
    }
    async function check() {
      if (!box || !enabled) return render();
      const text = box.value;
      const words = wordsOf(text);
      await resolve(words).catch(() => {});
      if (box.value !== text) return;
      typos = words.filter(isTypo);
      render();
    }
    function place() {
      if (!box || !overlay) return;
      const cs = getComputedStyle(box);
      Object.assign(overlay.style, {
        left: `${box.offsetLeft}px`, top: `${box.offsetTop}px`, width: `${box.offsetWidth}px`, height: `${box.offsetHeight}px`,
        padding: cs.padding, borderWidth: cs.borderWidth, font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing,
      });
    }
    function bind(textarea) {
      if (box === textarea) return;
      box = textarea;
      overlay?.remove();
      overlay = el('div', 'spell-overlay');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.dataset.userText = ''; // mirrors the user's commit message
      box.after(overlay);
      place();
      ide.util.observeSize(box, place);
      box.addEventListener('input', () => { typos = []; render(); clearTimeout(timer); timer = setTimeout(check, 300); });
      box.addEventListener('scroll', () => { overlay.scrollTop = box.scrollTop; });
      check();
    }
    // The vcs plugin builds the box when the Commit window first opens.
    document.addEventListener('focusin', (e) => { if (e.target.matches?.('textarea.vcs-msg')) bind(e.target); });
    ide.on('toolWindowShown', () => { const t = document.querySelector('textarea.vcs-msg'); if (t) bind(t); });

    const typoAtCaret = () => {
      if (!box || document.activeElement !== box || !enabled) return null;
      const at = box.selectionStart;
      return typos.filter(isTypo).find((t) => t.start <= at && at <= t.end && box.value.slice(t.start, t.end) === t.word) || null;
    };
    async function showActions() {
      const t = typoAtCaret();
      if (!t) return;
      const r = overlay.querySelector('.spell-typo')?.getBoundingClientRect() || box.getBoundingClientRect();
      const replace = (s) => {
        box.focus();
        box.setSelectionRange(t.start, t.end);
        document.execCommand('insertText', false, s); // keeps the textarea's undo stack
      };
      const list = await suggest(t.word);
      ide.ui.contextMenu(r.left, r.bottom + 2, [
        ...list.map((s) => ({ label: tr("Change to '{word}'", { word: s }), run: () => replace(s) })),
        ...(list.length ? [{ separator: true }] : []),
        ...(ide.root ? [{ label: tr("Save '{word}' to project dictionary", { word: t.word }), run: () => saveWord(t.word, 'project') }] : []),
        { label: tr("Save '{word}' to user dictionary", { word: t.word }), run: () => saveWord(t.word, 'user') },
      ]);
    }
    return { render, check, caretOnTypo: () => !!typoAtCaret(), showActions, typos: () => typos.filter(isTypo).map((t) => t.word) };
  })();

  // ---------- dictionaries and settings ----------
  async function loadProjectDictionary() {
    projectWords = new Set(ide.root ? (await ide.api.invoke('spellcheck:readProjectDictionary', ide.root)).map((w) => w.toLowerCase()) : []);
  }
  ide.on('projectOpened', async () => { await loadProjectDictionary(); rescanAll(); });
  ide.on('projectClosed', () => { projectWords = new Set(); });
  ide.on('fileSaved', async (tab) => {
    if (/[\\/]\.pyide[\\/]dictionary\.txt$/i.test(tab.path)) { await loadProjectDictionary(); rescanAll(); }
    const st = tab.model && states.get(tab.model);
    if (st && tab.model.getLanguageId() === 'python' && harvestKnown(tab.model.getValue())) dropKnown();
  });
  ide.on('settingsChanged', async (key, value) => {
    if (key === KEY_ENABLED) {
      enabled = value !== false;
      if (enabled) rescanAll(); else clearAll();
    } else if (key === KEY_USER) {
      userWords = new Set((value || []).map((w) => w.toLowerCase()));
      rescanAll();
    } else if (key === KEY_PROJECT_EDIT && value && ide.root && ide.util.samePath(value.root, ide.root)) {
      ide.settings.set(KEY_PROJECT_EDIT, undefined);
      await writeProjectDictionary(ide.root, value.words);
      await loadProjectDictionary();
      rescanAll();
    }
  });

  const splitWords = (text) => text.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
  (ide.settingsPages ||= []).push({
    id: 'spelling', group: 'editor', title: () => tr('Spelling'), defaults: { [KEY_ENABLED]: true },
    keywords: 'spelling spell checker typo dictionary words proofreading 맞춤법 오타 사전 단어',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Spelling'));
      s.appendChild(ctx.ui.checkbox(KEY_ENABLED, tr('Check spelling in comments, strings, names, Markdown and commit messages (Typo inspection)')));

      const words = (title, hint, initial, onChange) => {
        const sec = ctx.ui.section(host, title);
        const area = el('textarea', 'spell-words');
        area.spellcheck = false;
        area.value = initial.join('\n');
        area.oninput = () => onChange(splitWords(area.value));
        sec.append(el('div', 'muted settings-note', hint), area);
        return area;
      };
      const user = words(tr('User dictionary'), tr('Accepted in every project. One word per line.'), [...(ctx.value(KEY_USER) || [])], (list) => ctx.set(KEY_USER, list.map((w) => w.toLowerCase()).sort()));
      user.id = 'spellUserWords';
      if (ide.root) {
        const root = ide.root;
        const project = words(tr('Project dictionary'), tr('Stored in {file}, so it can be shared with the project. One word per line.', { file: '.pyide/dictionary.txt' }), [...projectWords].sort(), (list) => ctx.set(KEY_PROJECT_EDIT, { root, words: list }));
        project.id = 'spellProjectWords';
      }
    },
  });

  ide.spellcheck = {
    enabled: () => enabled,
    markers: (model) => monaco.editor.getModelMarkers({ owner: OWNER, resource: model.uri }),
    checkedLines: (model) => states.get(model)?.lines.size || 0,
    at: (model, line, col) => typosAt(model, new monaco.Range(line, col, line, col)).map((t) => t.word),
    suggest,
    saveWord,
    commitTypos: () => commit.typos(),
    stats: () => ({ ...stats }),
    idle: () => inflight || Promise.resolve(),
  };
})();
