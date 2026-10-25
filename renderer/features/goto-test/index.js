// PyCharm's Navigate › Test (action GotoTest; the keymap gives it Ctrl+Shift+T): from a module, class or function to
// its tests, test_<module>.py or <module>_test.py anywhere in the project (nearest first), and from a test file back to
// the module it tests, at the matching class or function (Square <-> TestSquare, area <-> test_area). Create New Test…
// writes a pytest file, or adds to one, with a test class or functions for the chosen methods.
(() => {
  const tests = ide.tests;
  if (!tests) return;
  const { el, basename, dirname, joinPath, isUnder, samePath } = ide.util;
  const isPy = (p) => /\.py$/i.test(p || '');
  const IDENT = /^[\p{L}_][\p{L}\p{N}_]*$/u;
  const moduleBase = (p) => basename(p).replace(/\.py$/i, '');

  // ---------- what a file defines ----------
  // Top-level classes and functions, found by indentation, with each class's methods:
  // [{kind: 'class' | 'function', name, line, end, methods: [{name, line}]}] (1-based lines, end exclusive).
  function outline(lines) {
    const out = [];
    let cur = null;
    let methodIndent = null;
    lines.forEach((text, i) => {
      if (!text.trim() || /^\s*#/.test(text)) return;
      const indent = text.match(/^\s*/)[0].length;
      let m;
      if (indent === 0) {
        if (cur) cur.end = i + 1;
        cur = null;
        if ((m = /^(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(text))) cur = { kind: 'function', name: m[1], line: i + 1, methods: [] };
        else if ((m = /^class\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(text))) cur = { kind: 'class', name: m[1], line: i + 1, methods: [] };
        if (cur) { cur.end = lines.length + 1; methodIndent = null; out.push(cur); }
      } else if (cur?.kind === 'class' && (m = /^\s*(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(text))) {
        methodIndent ??= indent;
        if (indent === methodIndent) cur.methods.push({ name: m[1], line: i + 1 });
      }
    });
    return out;
  }
  // The class or function around a line, with the method around it: {kind, name, line, methods, method?}.
  function elementAt(lines, lineNumber) {
    const top = outline(lines).find((e) => lineNumber >= e.line && lineNumber < e.end);
    if (!top) return null;
    const method = top.methods.filter((m) => m.line <= lineNumber).pop();
    return { ...top, method: method?.name || null };
  }

  // Square <-> TestSquare, area <-> test_area; a test method test_area in TestSquare <-> Square.area.
  const testName = (name, kind) => (kind === 'class' ? `Test${name}` : `test_${name.replace(/^_+|_+$/g, '')}`);
  function subjectOf(element) {
    if (!element) return null;
    if (element.kind === 'class') {
      const cls = element.name.replace(/^Test_?/, '');
      return cls ? { name: cls, method: element.method?.replace(/^test_?/, '') || null } : null;
    }
    const fn = element.name.replace(/^test_?/, '');
    return fn ? { name: fn, method: null } : null;
  }

  // ---------- which files ----------
  const subjectFileOf = (testPath) => `${moduleBase(testPath).replace(/^test_/i, '').replace(/_test$/i, '')}.py`.toLowerCase();
  const testFilesOf = (path) => [`test_${moduleBase(path)}.py`.toLowerCase(), `${moduleBase(path)}_test.py`.toLowerCase()];
  // Nearest first: the most folders in common with `from`, then the shorter path.
  function nearest(files, from) {
    const parts = (p) => dirname(p).toLowerCase().split(/[\\/]/);
    const here = parts(from);
    const common = (p) => { const d = parts(p); let n = 0; while (n < d.length && d[n] === here[n]) n++; return n; };
    return files.map((f) => [f, common(f)]).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([f]) => f);
  }
  const projectFiles = async () => (ide.root ? ide.api.walk(ide.root).catch(() => []) : []);

  const textOf = async (path) => {
    const model = ide.getDocument?.(path)?.model;
    return model && !model.isDisposed() ? model.getValue() : ide.api.read(path).catch(() => '');
  };
  // Opens a file at the class or function `name` (and its method) when it has it, else at the top.
  async function openAt(path, want) {
    let line = 1;
    if (want) {
      const items = outline((await textOf(path)).split(/\r?\n/));
      const top = items.find((e) => e.name === want.name);
      line = top ? (top.methods.find((m) => m.name === want.method)?.line || top.line) : 1;
    }
    return ide.openFile(path, { line, focus: true });
  }

  const hint = (ed, text) => ed.getContribution('editor.contrib.messageController')?.showMessage(text, ed.getPosition());
  const pythonEditor = () => {
    const tab = ide.activeTab();
    return tab?.kind === 'file' && isPy(tab.path) && ide.editor?.getModel() === tab.model ? tab : null;
  };

  async function gotoTest() {
    const tab = pythonEditor();
    if (!tab || !ide.root) return;
    const ed = ide.editor;
    const lines = tab.model.getLinesContent();
    const element = elementAt(lines, ed.getPosition()?.lineNumber || 1);
    const files = await projectFiles();
    if (tests.isTestFileName(basename(tab.path))) {
      const name = subjectFileOf(tab.path);
      const found = nearest(files.filter((f) => basename(f).toLowerCase() === name && !samePath(f, tab.path)), tab.path);
      if (!found.length) return hint(ed, tr('No test subjects found'));
      const want = subjectOf(element);
      if (found.length === 1) return openAt(found[0], want);
      const picked = await ide.ui.pick({
        placeholder: tr('Choose Test Subject for {name} ({n} found)', { name: element?.name || moduleBase(tab.path), n: found.length }),
        items: found.map((f) => ({ label: basename(f), hint: ide.util.rel(dirname(f)) || '.', value: f })),
      });
      return picked && openAt(picked, want);
    }
    const names = testFilesOf(tab.path);
    const found = nearest(files.filter((f) => names.includes(basename(f).toLowerCase())), tab.path);
    const want = element ? { name: testName(element.name, element.kind), method: element.kind === 'class' && element.method ? testName(element.method) : null } : null;
    if (found.length === 1) return openAt(found[0], want);
    // As in PyCharm, Create New Test… comes first, also when tests exist.
    const picked = await ide.ui.pick({
      placeholder: tr('Choose Test for {name} ({n} found)', { name: element?.name || moduleBase(tab.path), n: found.length }),
      items: [{ label: tr('Create New Test…'), value: { create: true } },
        // The folder as a hint, not a detail: the popup ranks items with a detail first.
        ...found.map((f) => ({ label: basename(f), hint: ide.util.rel(dirname(f)) || '.', value: { file: f } }))],
    });
    if (picked?.create) return createTest(tab.path, element);
    if (picked?.file) return openAt(picked.file, want);
  }

  // ---------- Create New Test ----------
  // The module to import: the packages (folders with __init__.py) above the file; when they stop below the project
  // root, at a folder named src (the src layout), from there, else from the project root.
  async function moduleOf(path) {
    const parts = [moduleBase(path)];
    let dir = dirname(path);
    while (!samePath(dir, ide.root) && isUnder(dir, ide.root) && await ide.api.exists(joinPath(dir, '__init__.py'))) {
      parts.unshift(basename(dir));
      dir = dirname(dir);
    }
    if (!samePath(dir, ide.root) && basename(dir).toLowerCase() !== 'src') {
      return ide.util.rel(path).replace(/\.py$/i, '').split(/[\\/]/).join('.');
    }
    return parts.join('.');
  }

  // The text of the test: a class with test methods, or test functions, after the import of what they test.
  function testCode({ module, subject, className, chosen }) {
    const imported = subject.kind === 'class' ? [subject.name] : chosen;
    const importLine = imported.length ? `from ${module} import ${imported.join(', ')}` : `import ${module}`;
    let body;
    if (className) {
      body = `class ${className}:\n${chosen.length ? chosen.map((n) => `    def ${testName(n)}(self):\n        assert False\n`).join('\n') : '    pass\n'}`;
    } else {
      body = (chosen.length ? chosen : [module.split('.').pop()]).map((n) => `def ${testName(n)}():\n    assert False\n`).join('\n\n');
    }
    return { importLine, body };
  }

  // `existing` with the import added after its imports (unless it is there) and the body at the end.
  function addTo(existing, { importLine, body }) {
    const lines = existing.replace(/\s+$/, '').split(/\r?\n/);
    if (!lines.some((l) => l.trim() === importLine)) {
      let at = 0;
      // After a module docstring, then after the last import before the first definition.
      const first = lines.findIndex((l) => l.trim());
      if (first >= 0 && /^[rbuRBU]?("""|''')/.test(lines[first].trim())) {
        const q = lines[first].trim().match(/("""|''')/)[1];
        let end = first;
        if (lines[first].trim().split(q).length < 3) while (end + 1 < lines.length && !lines[++end].includes(q));
        at = end + 1;
      }
      for (let i = at; i < lines.length && !/^(class|def|async\s+def|@)\b/.test(lines[i]); i++) if (/^(import|from)\s/.test(lines[i])) at = i + 1;
      lines.splice(at, 0, importLine);
    }
    return `${lines.join('\n')}\n\n\n${body}`;
  }

  async function writeTest(file, code, className) {
    const doc = ide.getDocument?.(file);
    const exists = !!doc || await ide.api.exists(file);
    const before = exists ? await textOf(file) : '';
    if (className && new RegExp(`^class\\s+${className}\\b`, 'm').test(before)) {
      throw new Error(tr('{name} already exists in {file}', { name: className, file: basename(file) }));
    }
    const text = exists && before.trim() ? addTo(before, code) : `${code.importLine}\n\n\n${code.body}`;
    const created = [];
    if (doc && !doc.model.isDisposed()) {
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null);
      const tab = ide.findTab(file);
      if (tab) await ide.saveTab?.(tab);
    } else {
      if (!(await ide.api.exists(dirname(file)))) { await ide.api.create(dirname(file), true); created.push(dirname(file)); }
      if (!exists) { await ide.api.create(file, false); created.push(file); }
      await ide.api.write(file, ide.lineSeparators?.forNewFile(text) ?? text);
    }
    await ide.refreshTree();
    if (created.length) ide.emit('filesChanged', { created });
  }

  async function defaultTargetDir(path) {
    for (const name of ['tests', 'test']) {
      const dir = joinPath(ide.root, name);
      if ((await ide.api.stat(dir).catch(() => null))?.isDirectory) return dir;
    }
    return dirname(path);
  }

  // PyCharm's Create Test dialog. element: the class or function at the caret (null: the module).
  async function createTest(path, element) {
    const lines = (await textOf(path)).split(/\r?\n/);
    const items = outline(lines);
    const cls = element?.kind === 'class' ? items.find((e) => e.kind === 'class' && e.name === element.name) : null;
    const subject = cls ? { kind: 'class', name: cls.name } : { kind: 'module', name: moduleBase(path) };
    const candidates = cls ? cls.methods.map((m) => m.name) : items.filter((e) => e.kind === 'function').map((e) => e.name);
    const module = await moduleOf(path);

    const body = el('div', 'gt-create');
    const field = (label, input) => {
      const row = el('label', 'field');
      row.append(el('span', null, label), input);
      body.append(row);
      return input;
    };
    const input = (value, name) => { const i = el('input', 'input'); i.value = value; i.name = name; i.spellcheck = false; return i; };
    const dirIn = field(tr('Target directory:'), input(await defaultTargetDir(path), 'dir'));
    const fileIn = field(tr('Test file name:'), input(`test_${moduleBase(path)}.py`, 'file'));
    const classIn = field(tr('Test class name:'), input(cls ? testName(cls.name, 'class') : '', 'class'));
    const checks = [];
    if (candidates.length) {
      body.append(el('div', 'gt-list-title', cls ? tr('Test methods:') : tr('Test functions:')));
      const list = el('div', 'gt-list');
      for (const name of candidates) {
        const row = el('label', 'gt-check');
        const box = el('input');
        box.type = 'checkbox';
        box.value = name;
        // Private and special methods start unchecked, the public ones checked.
        box.checked = !name.startsWith('_');
        const label = el('span', null, testName(name));
        label.dataset.userText = '';
        row.append(box, label);
        list.append(row);
        checks.push(box);
      }
      body.append(list);
    }

    let made = null;
    await new Promise((resolve) => ide.ui.dialog({
      title: tr('Create Test'), body, width: 560, onClose: resolve,
      buttons: [{ label: tr('OK'), primary: true, run: async () => {
        const dir = dirIn.value.trim();
        const fileName = fileIn.value.trim();
        const className = classIn.value.trim();
        if (!/^[^\\/:*?"<>|]+\.py$/i.test(fileName)) { ide.ui.alert(tr('The test file name must end with .py')); return false; }
        if (className && !IDENT.test(className)) { ide.ui.alert(tr("'{name}' is not a valid class name", { name: className })); return false; }
        const target = joinPath(/^[a-z]:|^[\\/]/i.test(dir) ? dir : joinPath(ide.root, dir), fileName);
        const chosen = checks.filter((c) => c.checked).map((c) => c.value);
        const code = testCode({ module, subject, className, chosen });
        try {
          await writeTest(target, code, className);
        } catch (err) {
          ide.ui.alert(tr('Cannot create the test: {error}', { error: ide.util.errorText(err) }));
          return false;
        }
        made = { target, want: className ? { name: className, method: chosen[0] ? testName(chosen[0]) : null } : chosen[0] ? { name: testName(chosen[0]) } : null };
        return true;
      } }, { label: tr('Cancel') }],
    }));
    if (made) await openAt(made.target, made.want);
    return made?.target || null;
  }

  ide.registerAction({ id: 'GotoTest', title: tr('Go to Test'), when: () => !!pythonEditor() && ide.editor.hasTextFocus(), run: () => gotoTest() });
  ide.registerAction({ id: 'CreateTest', title: tr('Create New Test…'), when: () => !!pythonEditor(), run: () => {
    const tab = pythonEditor();
    if (tab) createTest(tab.path, elementAt(tab.model.getLinesContent(), ide.editor.getPosition()?.lineNumber || 1));
  } });
  ide.onEditor((ed) => ed.addAction({
    id: 'pyide.gotoTest', label: tr('Go to Test'), contextMenuGroupId: 'navigation', contextMenuOrder: 3.4,
    precondition: 'editorLangId == python', run: () => { if (ed === ide.editor) gotoTest(); },
  }));

  ide.gotoTest = { go: gotoTest, create: createTest, outline, moduleOf };
})();
