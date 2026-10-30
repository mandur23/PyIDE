// AI actions for the def or class at the caret, like PyCharm's AI Assistant: Write Documentation (a docstring in the
// project's format, reviewed in ai-edit's inline diff) and Generate Unit Tests (tests/test_<module>.py, previewed in a
// tab before anything is written). Offered by Alt+Enter on a def/class header, the editor context menu's AI Actions…
// and Find Action. Model calls run in main/features/ai-generate.js through the Claude Code CLI.
(() => {
  const { el, basename } = ide.util;
  const monaco = ide.monaco;
  const FORMAT_KEY = 'python.docstringFormat';
  const FORMATS = [['', tr('Auto-detect')], ['restructuredtext', 'reStructuredText'], ['google', 'Google'], ['numpy', 'NumPy'], ['plain', tr('Plain')]];
  // The same model setting as AI Chat (Settings › AI › AI Chat).
  const modelId = () => ide.settings.get('aiChat.model', 'sonnet');
  const DOC_TITLE = () => tr('Write Documentation');
  const TESTS_TITLE = () => tr('Generate Unit Tests');

  let nextReq = 1;
  const state = { running: 0, last: null, preview: null, written: null };

  const fileTabOf = (model) => (model ? ide.tabs.find((t) => t.kind === 'file' && t.model === model) : null);
  function target(editor = ide.editor) {
    const model = editor?.getModel();
    const tab = fileTabOf(model);
    return model && tab && model.getLanguageId() === 'python' ? { editor, model, tab } : null;
  }
  const editorFor = (model) => (ide.editor?.getModel() === model ? ide.editor : ide.editors().find((e) => e.getModel() === model)) || null;
  const indentUnit = (model) => { const o = model.getOptions(); return o.insertSpaces ? ' '.repeat(o.tabSize) : '\t'; };
  const relPosix = (p) => ide.util.rel(p).replace(/\\/g, '/');
  const safeMode = () => ide.trusted === false;
  const SAFE_NOTE = () => tr('Not available in Safe Mode. Trust the project to use AI actions.');

  // ---------- notifications ----------
  function safeModeNote(title) {
    ide.notifications.notify({
      title, kind: 'warn', group: 'AI Actions', text: SAFE_NOTE(),
      actions: [{ label: tr('Trust Project…'), run: (note) => { note.expire(); ide.trustProject(); } }],
    });
  }

  function openInstaller() {
    if (ide.installer) ide.installer.open('ai');
    else ide.runAction('InstallClaudeCode');
  }

  const MESSAGES = {
    'not-installed': () => tr('Claude Code is not installed.'),
    auth: () => tr('Claude Code is not signed in, or its sign-in has expired. Claude Code signs in separately from the Claude app.'),
    timeout: () => tr('Claude Code did not answer in time.'),
    untrusted: SAFE_NOTE,
    'no-target': () => tr('Put the caret on a function, method or class.'),
    'one-line': () => tr('The body is on the same line as the definition. Move it to its own line first.'),
    'not-importable': (r) => tr('{path} is not in an importable package, so tests cannot import it.', { path: r.message }),
    'is-test': () => tr('This is a test file. Generate tests from the code it tests.'),
    outside: () => tr('The file is not inside the project.'),
    changed: () => tr('The test file changed after the preview was made. Generate the tests again.'),
    empty: () => tr('Claude Code returned nothing that could be used.'),
    'too-large': (r) => tr('{file} is larger than 4 MB, so the tests are not merged into it on disk. Open it in the editor and generate the tests again.', { file: r.testRel }),
    unreadable: (r) => tr('{file} cannot be read as text.', { file: r.testRel }),
    encoding: (r) => tr('{file} would not keep its exact bytes if it were written back in its encoding ({encoding}). Open it in the editor and generate the tests again.', { file: r.testRel, encoding: r.encoding }),
    unencodable: (r) => tr('The generated tests contain characters that {file}\'s encoding ({encoding}) cannot hold. Open the file, convert it to UTF-8, and generate the tests again.', { file: r.testRel, encoding: r.encoding }),
  };
  // Failures about the existing test file offer to open it (the editor reads it in its own encoding and saves it so).
  const OPEN_FILE_CODES = new Set(['too-large', 'unreadable', 'encoding', 'unencodable']);

  function failNote(title, res) {
    const actions = [];
    if (res.code === 'not-installed') actions.push({ label: tr('Open Install Manager'), run: openInstaller });
    if (res.code === 'auth') actions.push({ label: tr('Sign in to Claude Code'), run: () => ide.runAction('ClaudeCodeLogin') });
    if (OPEN_FILE_CODES.has(res.code) && res.testPath) actions.push({ label: tr('Open {file}', { file: basename(res.testPath) }), run: (note) => { note.expire(); ide.openFile(res.testPath); } });
    const text = MESSAGES[res.code]?.(res) ?? tr('Claude Code failed: {message}', { message: res.message || res.code });
    const kind = ['no-target', 'one-line', 'is-test', 'outside', 'too-large', 'encoding', 'unencodable'].includes(res.code) ? 'warn' : 'error';
    ide.notifications.notify({ title: tr('{action} failed', { action: title }), text, kind, group: 'AI Actions', actions });
  }

  // A request through main with a background task whose Cancel stops the CLI. -> the answer, {code: 'cancelled'} after Cancel.
  async function withTask(channel, req, { title, text }) {
    const reqId = `aig-${nextReq++}`;
    const task = ide.tasks.start({ title, text, onCancel: () => ide.api.invoke('ai-generate:cancel', reqId) });
    state.running++;
    let res;
    try {
      res = await ide.api.invoke(channel, { ...req, reqId, model: modelId() });
    } catch (err) {
      res = { ok: false, code: 'cli', message: err.message };
    } finally {
      state.running--;
    }
    if (task.cancelled) return { ok: false, code: 'cancelled' };
    task.done();
    return res;
  }

  function confirmReplace(name) {
    return new Promise((resolve) => {
      let yes = false;
      ide.ui.dialog({
        title: tr('Replace Docstring?'),
        body: tr('{name} already has a docstring. Write a new one? You review the replacement before it is applied.', { name }),
        buttons: [{ label: tr('Replace'), primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }],
        onClose: () => resolve(yes),
      });
    });
  }

  // ---------- Write Documentation ----------
  async function writeDocumentation(editor) {
    const t = target(editor);
    if (!t) return;
    if (safeMode()) return safeModeNote(DOC_TITLE());
    const { model, tab } = t;
    const line = t.editor.getPosition().lineNumber;
    const text = model.getValue();
    const a = await ide.api.invoke('ai-generate:analyze', { text, line });
    if (!a) return failNote(DOC_TITLE(), { code: 'no-target' });
    if (a.oneLiner) return failNote(DOC_TITLE(), { code: 'one-line' });
    if (a.hasDocstring && !(await confirmReplace(a.qualname))) { state.last = { action: 'docstring', declined: true, name: a.qualname }; return; }
    // The def line is tracked while Claude writes, so edits elsewhere in the file do not misplace the docstring.
    const [mark] = model.deltaDecorations([], [{ range: new monaco.Range(a.line, 1, a.line, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
    const res = await withTask('ai-generate:docstring', { root: ide.root, path: tab.path, text, line, format: ide.settings.get(FORMAT_KEY, '') },
      { title: tr('Writing documentation for {name}', { name: a.qualname }), text: tr('Waiting for Claude Code…') });
    const at = model.isDisposed() ? null : model.getDecorationRange(mark)?.startLineNumber;
    if (!model.isDisposed()) model.deltaDecorations([mark], []);
    state.last = { action: 'docstring', name: a.qualname, ...res };
    if (res.code === 'cancelled' || model.isDisposed()) return;
    if (!res.ok) return failNote(DOC_TITLE(), res);
    const placed = await ide.api.invoke('ai-generate:place', { text: model.getValue(), line: at ?? a.line, name: a.name, content: res.content, quote: res.quote, indentUnit: indentUnit(model) });
    if (placed.error) return failNote(DOC_TITLE(), { code: placed.error === 'one-line' ? 'one-line' : 'no-target' });
    state.last.placed = placed;
    let ed = editorFor(model);
    if (!ed) { await ide.openFile(tab.path); ed = editorFor(model); }
    if (!ed) return;
    ed.focus();
    ide.aiEdit.review(ed, { start: placed.start, end: placed.end, lines: placed.lines });
  }

  // ---------- Generate Unit Tests ----------
  async function generateTests(editor) {
    const t = target(editor);
    if (!t) return;
    if (safeMode()) return safeModeNote(TESTS_TITLE());
    const { model, tab } = t;
    const line = t.editor.getPosition().lineNumber;
    const text = model.getValue();
    const plan = await ide.api.invoke('ai-generate:planTests', { root: ide.root, path: tab.path, text, line });
    if (!plan.ok) { state.last = { action: 'tests', ...plan }; return failNote(TESTS_TITLE(), plan); }
    // An open test file's text (saved or not) is what the tests are merged into.
    const doc = ide.getDocument(plan.testPath);
    const res = await withTask('ai-generate:tests', { root: ide.root, path: tab.path, text, line, existingText: doc ? doc.model.getValue() : undefined,
      newFileSeparator: ide.lineSeparators?.newFile() },
      { title: tr('Generating tests for {name}', { name: plan.qualname }), text: tr('Waiting for Claude Code…') });
    state.last = { action: 'tests', name: plan.qualname, ...res };
    if (res.code === 'cancelled') return;
    if (!res.ok) return failNote(TESTS_TITLE(), res);
    showPreview(res);
  }

  const previewId = (res) => `ai-generate:preview:${res.testPath}`;
  const NOTES = {
    'src-path': () => tr('The tests import from src/, which is not on pytest\'s path. Add pythonpath = ["src"] under [tool.pytest.ini_options] in pyproject.toml, or install the project with pip install -e .'),
    nested: () => tr('A nested function cannot be imported, so the tests call it through the function that defines it.'),
  };

  // The merged test file in a read-only diff against what is there now; nothing is written before Write.
  function showPreview(res) {
    const id = previewId(res);
    ide.closeTab(id, true);
    let diff = null;
    const models = [];
    state.preview = { id, testPath: res.testPath, testRel: res.testRel, before: res.before, after: res.after, added: res.added, renamed: res.renamed,
      framework: res.framework, importLine: res.importLine, notes: res.notes, exists: res.exists };
    ide.openCustomTab({
      id, title: tr('Preview: {name}', { name: basename(res.testPath) }), icon: 'test',
      mount(host) {
        host.classList.add('aig-preview');
        const bar = el('div', 'aig-bar');
        const info = el('div', 'aig-info');
        const file = el('span', 'aig-file', res.testRel);
        file.dataset.userText = '';
        const n = res.added.length;
        const what = res.exists
          ? (n === 1 ? tr('1 test to append') : tr('{count} tests to append', { count: n }))
          : (n === 1 ? tr('New file with 1 test') : tr('New file with {count} tests', { count: n }));
        info.append(file, el('span', 'aig-summary muted', `${what} · ${res.framework}`));
        if (res.renamed.length) {
          const r = el('span', 'aig-renamed muted', tr('Renamed to avoid clashes: {names}', { names: res.renamed.map((x) => `${x.from} → ${x.to}`).join(', ') }));
          r.dataset.userText = '';
          info.append(r);
        }
        const buttons = el('div', 'aig-buttons');
        const write = el('button', 'primary aig-write', res.exists ? tr('Append to File') : tr('Create File'));
        const cancel = el('button', 'secondary aig-cancel', tr('Cancel'));
        write.onclick = () => writeTests(res);
        cancel.onclick = () => { state.preview = null; ide.closeTab(id, true); };
        buttons.append(write, cancel);
        bar.append(info, buttons);
        host.append(bar);
        for (const n of res.notes || []) if (NOTES[n]) host.append(el('div', 'aig-note', NOTES[n]()));
        const box = el('div', 'aig-diff');
        host.append(box);
        const uri = (side) => monaco.Uri.parse(`pyide-ai-generate:/${nextReq++}/${side}/${basename(res.testPath)}`);
        models.push(monaco.editor.createModel(res.before ?? '', 'python', uri('a')), monaco.editor.createModel(res.after, 'python', uri('b')));
        diff = monaco.editor.createDiffEditor(box, {
          ...ide.editorOptions?.(), automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: false,
          minimap: { enabled: false }, scrollBeyondLastLine: false, renderMarginRevertIcon: false, ignoreTrimWhitespace: false,
        });
        diff.setModel({ original: models[0], modified: models[1] });
      },
      onClose() {
        if (diff) {
          diff.dispose();
          // Monaco keeps a global hover-delegate factory bound to the last editor's scoped services; a throwaway editor
          // rebinds it to the root after a diff editor goes away (as refactor and local-history do).
          monaco.editor.create(el('div')).dispose();
        }
        // A diff computation still in flight fails if its models go away first.
        setTimeout(() => { for (const m of models) m.dispose(); }, 2000);
        if (state.preview?.id === id) state.preview = null;
      },
    });
  }

  async function writeTests(res) {
    const doc = ide.getDocument(res.testPath);
    const fail = (code) => failNote(TESTS_TITLE(), { code });
    if (doc) {
      // The open document is the file: the tests go in as one undo step and the file is saved.
      if (doc.model.getValue() !== (res.before ?? '')) return fail('changed');
      ide.localHistory?.checkpoint('Before Generating Tests', { paths: [res.testPath] });
      doc.model.pushStackElement();
      doc.model.pushEditOperations(null, [{ range: doc.model.getFullModelRange(), text: res.after }], () => null);
      doc.model.pushStackElement();
      await ide.saveTab(ide.findTab(res.testPath));
    } else {
      if (res.exists) ide.localHistory?.checkpoint('Before Generating Tests', { paths: [res.testPath] });
      const w = await ide.api.invoke('ai-generate:writeTests', { root: ide.root, testPath: res.testPath, before: res.before, after: res.after, createInit: res.createInit });
      if (!w.ok) return failNote(TESTS_TITLE(), { ...w, testPath: res.testPath, testRel: res.testRel });
    }
    state.preview = null;
    state.written = { testPath: res.testPath, added: res.added, renamed: res.renamed };
    ide.closeTab(previewId(res), true);
    ide.refreshTree();
    await ide.openFile(res.testPath);
    ide.notifications.notify({
      title: tr('Tests generated'), kind: 'ok', group: 'AI Actions',
      text: res.added.length === 1 ? tr('1 test written to {file}', { file: res.testRel }) : tr('{count} tests written to {file}', { count: res.added.length, file: res.testRel }),
      actions: [{ label: tr('Run Tests'), run: (note) => { note.expire(); runTests(res.testPath); } }],
    });
  }

  function runTests(testPath) {
    if (!ide.run) return;
    ide.run.runContext({ type: 'pytest', name: tr('pytest in {name}', { name: basename(testPath) }), target: relPosix(testPath) });
  }

  // ---------- entry points ----------
  const DOC_CMD = 'pyide.aiGenerate.writeDocumentation';
  const TESTS_CMD = 'pyide.aiGenerate.generateTests';
  monaco.editor.registerCommand(DOC_CMD, () => writeDocumentation());
  monaco.editor.registerCommand(TESTS_CMD, () => generateTests());
  // Alt+Enter on a def/class header (decorators to the colon). Only explicit requests: the lightbulb stays off.
  monaco.languages.registerCodeActionProvider('python', {
    async provideCodeActions(model, range, context) {
      if (context.trigger !== monaco.languages.CodeActionTriggerType.Invoke || !fileTabOf(model)) return undefined;
      const a = await ide.api.invoke('ai-generate:analyze', { text: model.getValue(), line: range.startLineNumber, header: true });
      if (!a || model.isDisposed()) return undefined;
      const disabled = safeMode() ? SAFE_NOTE() : undefined;
      return {
        actions: [
          { title: DOC_TITLE(), kind: 'quickfix', command: { id: DOC_CMD, title: DOC_TITLE() }, disabled },
          { title: TESTS_TITLE(), kind: 'quickfix', command: { id: TESTS_CMD, title: TESTS_TITLE() }, disabled },
        ],
        dispose() {},
      };
    },
  });

  // Editor context menu › AI Actions… opens the two actions at the caret (Monaco's menu has no submenus).
  function showMenu(editor = ide.editor) {
    const t = target(editor);
    if (!t) return;
    const pos = t.editor.getPosition();
    const vis = t.editor.getScrolledVisiblePosition(pos);
    const r = t.editor.getDomNode().getBoundingClientRect();
    const safe = safeMode();
    const detail = safe ? tr('Safe Mode') : undefined;
    ide.ui.contextMenu(r.left + (vis?.left ?? 40), r.top + (vis ? vis.top + vis.height : 40), [
      { header: tr('AI Actions') },
      { label: DOC_TITLE(), disabled: safe, detail, run: () => writeDocumentation(t.editor) },
      { label: TESTS_TITLE(), disabled: safe, detail, run: () => generateTests(t.editor) },
      ...(safe ? [{ separator: true }, { label: tr('Trust Project…'), run: () => ide.trustProject() }] : []),
    ]);
  }
  ide.onEditor((ed) => {
    ed.addAction({ id: 'aiGenerate.menu', label: tr('AI Actions…'), contextMenuGroupId: '9_claude', contextMenuOrder: 2, precondition: 'editorLangId == python', run: () => showMenu(ed) });
  });
  const inPython = () => !!target();
  ide.registerAction({ id: 'AiGenerate.WriteDocumentation', title: DOC_TITLE(), when: inPython, run: () => writeDocumentation() });
  ide.registerAction({ id: 'AiGenerate.GenerateTests', title: TESTS_TITLE(), when: inPython, run: () => generateTests() });
  ide.registerAction({ id: 'AiGenerate.Menu', title: tr('AI Actions…'), when: inPython, run: () => showMenu() });

  // ---------- settings: Python Integrated Tools › Docstrings ----------
  function docstringSection(host, ctx) {
    const s = ctx.ui.section(host, tr('Docstrings'));
    s.appendChild(ctx.ui.fieldRow(tr('Docstring format:'), ctx.ui.selectInput(FORMAT_KEY, FORMATS, '')));
    s.appendChild(el('div', 'muted settings-note', tr('Write Documentation uses this format. Auto-detect follows the docstrings already in the project (reStructuredText when there are none).')));
  }
  (ide.pythonToolsSections ||= []).push(docstringSection);
  // Without the test runner plugin (which owns the page) the section gets a page of its own.
  ide.on('ready', () => {
    if ((ide.settingsPages || []).some((p) => p.id === 'python-tests')) return;
    (ide.settingsPages ||= []).push({ id: 'python-docstrings', title: () => tr('Python Integrated Tools'), keywords: 'docstring format restructuredtext google numpy 독스트링', mount: docstringSection });
  });

  ide.aiGenerate = {
    writeDocumentation: (editor) => writeDocumentation(editor),
    generateTests: (editor) => generateTests(editor),
    showMenu,
    runTests,
    state: () => JSON.parse(JSON.stringify(state)),
  };
})();
