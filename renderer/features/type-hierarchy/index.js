// PyCharm's Type Hierarchy (Ctrl+H) for Python classes, in navigation-bar's Hierarchy tool window.
// Pyright 1.1.406 has no textDocument/prepareTypeHierarchy (nor does basedpyright 1.40), so the hierarchy is built from
// requests it has: the class at the caret from definition + documentSymbol, supertypes by reading the class
// statement's bases and asking for each one's definition, subtypes from the class's references that sit in another
// class statement's bases. Children load when a node is expanded.
(() => {
  const nav = ide.navigationBar;
  if (!nav?.showHierarchy) return;
  const CLASS = 5; // LSP SymbolKind.Class

  // file:///c%3A/x.py -> C:\x.py; file://server/share/x.py (UNC) -> \\server\share\x.py
  const toPath = (uri) => decodeURIComponent(String(uri).replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '//'))
    .replace(/\//g, '\\').replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  const modelPath = (model) => (model?.uri.scheme === 'file' ? toPath(model.uri.toString()) : null);
  const isPy = (p) => /\.pyi?$/i.test(p || '');
  const before = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  const within = (r, p) => before(r.start, p) && before(p, r.end);

  // ---------- sources ----------
  // The text of a file as the editor has it (unsaved changes included), else as it is on disk.
  async function linesOf(uri) {
    const path = toPath(uri);
    const model = ide.getDocument?.(path)?.model;
    const text = model && !model.isDisposed() ? model.getValue() : await ide.api.read(path).catch(() => '');
    return text.split(/\r?\n/);
  }

  const flatten = (list, out = []) => {
    for (const s of list || []) { out.push(s); flatten(s.children, out); }
    return out;
  };
  async function classSymbols(uri) {
    return flatten(await ide.lsp.documentSymbols(toPath(uri)).catch(() => [])).filter((s) => s.kind === CLASS && s.selectionRange);
  }

  // The dotted module a file is (pets.py -> animals.pets), shown beside each class as PyCharm does.
  function moduleOf(uri) {
    const path = toPath(uri);
    const m = /[\\/](?:stdlib|site-packages|dist-packages)[\\/](.+)$/i.exec(path);
    const rel = ide.root && ide.util.isUnder(path, ide.root) ? ide.util.rel(path) : m ? m[1] : ide.util.basename(path);
    return rel.replace(/\.pyi?$/i, '').split(/[\\/]/).filter((p) => p && p !== '__init__').join('.');
  }
  const itemOf = (sym, uri) => ({ name: sym.name, kind: CLASS, detail: moduleOf(uri), uri, range: sym.range, selectionRange: sym.selectionRange });

  // The class statement's bases: [{text, head: {line, character}}], head being the class name of the base (`Box` in
  // `pkg.Box[int]`). Keyword arguments (metaclass=...) and unpacking are not bases.
  function basesOf(lines, nameRange) {
    let line = nameRange.end.line;
    let ch = nameRange.end.character;
    const next = () => {
      while (line < lines.length && ch >= lines[line].length) { line++; ch = 0; }
      return line < lines.length ? lines[line][ch] : null;
    };
    // Skip PEP 695 type parameters, then expect '('.
    let c = next();
    while (c === ' ' || c === '\t') { ch++; c = next(); }
    if (c === '[') {
      let depth = 0;
      for (; (c = next()) !== null; ch++) {
        if (c === '[') depth++;
        else if (c === ']' && --depth === 0) { ch++; break; }
      }
      c = next();
      while (c === ' ' || c === '\t') { ch++; c = next(); }
    }
    if (c !== '(') return [];
    ch++;
    const bases = [];
    let depth = 0;
    let cur = { text: '', head: null, headDone: false };
    const finish = () => {
      const t = cur.text.trim();
      if (t && !/^\*|^\w+\s*=[^=]/.test(t) && cur.head) bases.push({ text: t.replace(/\s+/g, ' '), head: cur.head });
      cur = { text: '', head: null, headDone: false };
    };
    for (; (c = next()) !== null; ch++) {
      if (c === '#') { ch = lines[line].length - 1; continue; }
      if (depth === 0 && c === ')') { finish(); break; }
      if (depth === 0 && c === ',') { finish(); continue; }
      if ('([{'.includes(c)) { depth++; if (c === '[' && depth === 1) cur.headDone = true; }
      else if (')]}'.includes(c)) depth--;
      // The head is the last name of the dotted name before any subscript or call.
      if (depth === 0 && !cur.headDone && /[A-Za-z_\u00c0-\uffff]/.test(c) && !/[\w\u00c0-\uffff]/.test(lines[line][ch - 1] || '')) {
        cur.head = { line, character: ch };
      }
      if (depth === 0 && c === '(') cur.headDone = true;
      cur.text += c;
    }
    return bases;
  }

  // ---------- the class at the caret ----------
  // The class the name at the caret refers to, else the innermost class around the caret (as PyCharm does).
  async function classAt(model, pos) {
    const uri = model.uri.toString();
    const position = { line: pos.lineNumber - 1, character: pos.column - 1 };
    if (model.getWordAtPosition(pos)) {
      const defs = await ide.lsp.request('textDocument/definition', { textDocument: { uri }, position });
      for (const d of [].concat(defs || [])) {
        const target = d.targetUri || d.uri;
        const at = (d.targetSelectionRange || d.range)?.start;
        if (!target || !at) continue;
        const sym = (await classSymbols(target)).find((s) => within(s.selectionRange, at));
        if (sym) return itemOf(sym, target);
      }
    }
    const around = (await classSymbols(uri)).filter((s) => within(s.range, position));
    const inner = around.sort((a, b) => (before(a.range.start, b.range.start) ? 1 : -1))[0];
    return inner ? itemOf(inner, uri) : null;
  }

  // ---------- supertypes and subtypes ----------
  async function supertypes(item) {
    const lines = await linesOf(item.uri);
    const bases = basesOf(lines, item.selectionRange);
    if (!bases.length) {
      // Every class without bases derives from object (except object itself, in builtins.pyi).
      if (item.name === 'object' && /builtins\.pyi$/i.test(toPath(item.uri))) return [];
      return [{ item: { ...item, name: 'object', detail: 'builtins', range: item.selectionRange, leaf: true }, leaf: true }];
    }
    const out = [];
    for (const b of bases) {
      const defs = await ide.lsp.request('textDocument/definition', { textDocument: { uri: item.uri }, position: b.head });
      let found = null;
      for (const d of [].concat(defs || [])) {
        const target = d.targetUri || d.uri;
        const at = (d.targetSelectionRange || d.range)?.start;
        if (!target || !at) continue;
        const sym = (await classSymbols(target)).find((s) => within(s.selectionRange, at));
        found = sym ? itemOf(sym, target)
          : { name: b.text.replace(/\s*\[[\s\S]*$/, ''), kind: CLASS, detail: moduleOf(target), uri: target, range: d.targetRange || d.range, selectionRange: d.targetSelectionRange || d.range, leaf: true };
        if (sym) break;
      }
      // A base Pyright cannot resolve still shows, at the place it is written.
      const here = { start: b.head, end: { line: b.head.line, character: b.head.character + 1 } };
      const item2 = found || { name: b.text, kind: CLASS, detail: '', uri: item.uri, range: here, selectionRange: here, leaf: true };
      out.push({ item: item2, leaf: !!item2.leaf });
    }
    return out;
  }

  async function subtypes(item) {
    const refs = await ide.lsp.request('textDocument/references', { textDocument: { uri: item.uri }, position: item.selectionRange.start, context: { includeDeclaration: false } });
    const out = [];
    const seen = new Set();
    const byUri = new Map();
    for (const r of refs || []) {
      if (!byUri.has(r.uri)) byUri.set(r.uri, []);
      byUri.get(r.uri).push(r.range.start);
    }
    for (const [uri, starts] of byUri) {
      const lines = await linesOf(uri);
      for (const sym of await classSymbols(uri)) {
        const heads = basesOf(lines, sym.selectionRange).map((b) => b.head);
        if (!heads.some((h) => starts.some((s) => s.line === h.line && s.character === h.character))) continue;
        const key = `${uri}:${sym.selectionRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ item: itemOf(sym, uri) });
      }
    }
    return out;
  }

  const typeKind = {
    id: 'type',
    mode: 'subtypes',
    modes: () => [['supertypes', tr('Supertypes Hierarchy')], ['subtypes', tr('Subtypes Hierarchy')]],
    head: (m) => (m === 'supertypes' ? tr('Supertypes of {name}') : tr('Subtypes of {name}')),
    // Bases keep their declaration order.
    sort: false,
    async children(node, m) {
      if (node.item.leaf) return [];
      const kids = await (m === 'supertypes' ? supertypes(node.item) : subtypes(node.item));
      if (m === 'subtypes') kids.sort((a, b) => a.item.detail.localeCompare(b.item.detail) || a.item.selectionRange.start.line - b.item.selectionRange.start.line);
      return kids;
    },
  };

  async function showTypeHierarchy(ed, mode) {
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    if (!model || !pos || !isPy(modelPath(model))) return;
    const item = await classAt(model, pos);
    if (!item) return nav.hint(ed, tr('No type hierarchy for the element at the caret'));
    nav.showHierarchy(typeKind, item, mode);
  }

  const editorPython = () => !!ide.editor?.hasTextFocus() && isPy(modelPath(ide.editor.getModel()));
  ide.registerAction({ id: 'TypeHierarchy', title: tr('Type Hierarchy'), keys: 'Ctrl+H', when: editorPython, run: () => showTypeHierarchy(ide.editor) });
  ide.onEditor((ed) => ed.addAction({
    id: 'pyide.typeHierarchy', label: tr('Type Hierarchy'), contextMenuGroupId: 'navigation', contextMenuOrder: 3.1,
    precondition: 'editorLangId == python', run: () => showTypeHierarchy(ed),
  }));

  ide.typeHierarchy = {
    show: (mode) => showTypeHierarchy(ide.editor, mode),
    // For tests: the class at a position and its direct supertypes/subtypes, as the window gets them.
    classAt, supertypes, subtypes, basesOf,
  };
})();
