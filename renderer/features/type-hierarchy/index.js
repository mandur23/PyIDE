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
  // Files that are not open are read, and their symbols asked for, once until a file event or a save: the gutter
  // markers below look at the same base and subclass files for every class of a file.
  const closed = new Map(); // 'l' | 's' + uri -> Promise
  const closedOnce = (kind, uri, load) => {
    const key = kind + uri;
    // An empty answer (Pyright not started yet, a failed read) is not kept.
    if (!closed.has(key)) closed.set(key, load().catch(() => null).then((r) => { if (!r?.length) closed.delete(key); return r || (kind === 'l' ? '' : []); }));
    return closed.get(key);
  };
  for (const ev of ['filesChanged', 'fileSaved', 'fileOpened', 'fileClosed', 'projectOpened']) ide.on(ev, () => closed.clear());
  const openModel = (uri) => {
    const model = ide.getDocument?.(toPath(uri))?.model;
    return model && !model.isDisposed() ? model : null;
  };

  // The text of a file as the editor has it (unsaved changes included), else as it is on disk.
  async function linesOf(uri) {
    const model = openModel(uri);
    const text = model ? model.getValue() : await closedOnce('l', uri, () => ide.api.read(toPath(uri)));
    return text.split(/\r?\n/);
  }

  const flatten = (list, out = []) => {
    for (const s of list || []) { out.push(s); flatten(s.children, out); }
    return out;
  };
  const symbolsOf = (uri) => (openModel(uri) ? ide.lsp.documentSymbols(toPath(uri)).catch(() => [])
    : closedOnce('s', uri, () => ide.lsp.documentSymbols(toPath(uri))));
  async function classSymbols(uri) {
    return flatten(await symbolsOf(uri)).filter((s) => s.kind === CLASS && s.selectionRange);
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

  // ---------- implementations and super methods ----------
  // PyCharm's Navigate › Implementation(s) and Super Method, and the gutter markers below. Pyright has no
  // implementation request: the implementations of a method are the same-named methods of the class's subtypes (found
  // as above, all levels down), its super methods the nearest class defining the name on each path up through the bases.
  const METHOD_KINDS = new Set([6, 7, 12]); // LSP SymbolKind Method, Property, Function
  const ABSTRACT = /@\s*(?:abc\.)?abstractmethod\b/;
  const keyOf = (item) => `${item.uri}:${item.selectionRange.start.line}`;
  const isObject = (item) => item.name === 'object' && /builtins\.pyi$/i.test(toPath(item.uri));

  // A class item with its methods: name -> {sym, abstract}.
  async function classInfo(item) {
    const sym = (await classSymbols(item.uri)).find((s) => s.name === item.name && s.selectionRange.start.line === item.selectionRange.start.line);
    if (!sym) return { item, methods: new Map() };
    const lines = await linesOf(item.uri);
    const methods = new Map();
    for (const c of sym.children || []) {
      if (!METHOD_KINDS.has(c.kind) || !c.selectionRange || methods.has(c.name)) continue;
      methods.set(c.name, { sym: c, abstract: ABSTRACT.test(lines.slice(c.range.start.line, c.selectionRange.start.line).join('\n')) });
    }
    return { item, methods };
  }

  // The classes above a class as a tree in base order, [{info, bases}], without object.
  async function baseTree(item, seen = new Set([keyOf(item)]), depth = 0) {
    const out = [];
    if (depth > 30) return out;
    for (const { item: base, leaf } of await supertypes(item)) {
      if (leaf || isObject(base) || seen.has(keyOf(base))) continue;
      seen.add(keyOf(base));
      out.push({ info: await classInfo(base), bases: await baseTree(base, seen, depth + 1) });
    }
    return out;
  }
  // On each path up, the nearest class that defines `name`: [{cls, sym, abstract}].
  const findUp = (tree, name) => tree.flatMap((node) => {
    const m = node.info.methods.get(name);
    return m ? [{ cls: node.info.item, sym: m.sym, abstract: m.abstract }] : findUp(node.bases, name);
  });

  // Every class below a class, nearest first, at most `limit`.
  async function allSubtypes(item, limit = 100) {
    const out = [];
    const seen = new Set([keyOf(item)]);
    for (let level = [item]; level.length && out.length < limit;) {
      const next = [];
      for (const cls of level) {
        for (const { item: sub } of await subtypes(cls)) {
          if (seen.has(keyOf(sub)) || out.length >= limit) continue;
          seen.add(keyOf(sub));
          out.push(sub);
          next.push(sub);
        }
      }
      level = next;
    }
    return out;
  }
  const findDown = (infos, name) => infos.flatMap((info) => {
    const m = info.methods.get(name);
    return m ? [{ cls: info.item, sym: m.sym, abstract: m.abstract }] : [];
  });

  // The class or method a position names (byName: the position is a definition's name), else the innermost class or
  // method around it: {cls, method: {name, sym} | null}. Functions nested in a method are not methods.
  async function memberAt(uri, position, byName) {
    let found = null;
    const walk = (list, cls) => {
      for (const s of list || []) {
        if (!s.selectionRange || !within(s.range, position)) continue;
        if (s.kind === CLASS) found = { cls: itemOf(s, uri), method: null, sym: s };
        else if (cls && METHOD_KINDS.has(s.kind)) found = { cls, method: { name: s.name, sym: s }, sym: s };
        walk(s.children, s.kind === CLASS ? itemOf(s, uri) : null);
      }
    };
    walk(await symbolsOf(uri), null);
    return found && (!byName || within(found.sym.selectionRange, position)) ? found : null;
  }

  // The element at the caret for Go to Implementation: what the name at the caret refers to, else the method or class
  // around the caret.
  async function targetAt(model, pos) {
    const uri = model.uri.toString();
    const position = { line: pos.lineNumber - 1, character: pos.column - 1 };
    if (model.getWordAtPosition(pos)) {
      const defs = await ide.lsp.request('textDocument/definition', { textDocument: { uri }, position });
      for (const d of [].concat(defs || [])) {
        const target = d.targetUri || d.uri;
        const at = (d.targetSelectionRange || d.range)?.start;
        const found = target && at ? await memberAt(target, at, true) : null;
        if (found) return found;
      }
    }
    return memberAt(uri, position, false);
  }

  async function implementations(t) {
    if (!t.method) return (await allSubtypes(t.cls)).map((cls) => ({ cls, sym: null }));
    const infos = [];
    for (const sub of await allSubtypes(t.cls)) infos.push(await classInfo(sub));
    return findDown(infos, t.method.name);
  }
  async function superMethods(t) {
    if (t.method) return findUp(await baseTree(t.cls), t.method.name);
    return (await supertypes(t.cls)).filter((b) => !b.leaf && !isObject(b.item)).map((b) => ({ cls: b.item, sym: null }));
  }

  // Opens a target ({cls, sym}: the method, or the class when sym is null) at its name.
  function goTo(target) {
    const at = (target.sym || target.cls).selectionRange.start;
    return ide.openFile(toPath(target.cls.uri), { line: at.line + 1, col: at.character + 1, focus: true });
  }
  const targetLabel = (target) => (target.sym ? `${target.cls.name}.${target.sym.name}` : target.cls.name);
  const byLabel = (targets) => [...targets].sort((a, b) => targetLabel(a).localeCompare(targetLabel(b)));
  // One target opens; several are listed to choose from, as PyCharm's "Choose Implementation of …" popup.
  async function choose(title, targets) {
    if (targets.length === 1) return goTo(targets[0]);
    const picked = await ide.ui.pick({ placeholder: title, items: byLabel(targets).map((t) => ({ label: targetLabel(t), detail: t.cls.detail, value: t })) });
    if (picked) goTo(picked);
  }

  async function gotoImplementation(ed) {
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    if (!model || !pos || !isPy(modelPath(model))) return;
    const t = await targetAt(model, pos);
    const found = t ? await implementations(t) : [];
    if (!found.length) return nav.hint(ed, tr('No implementations found'));
    const name = t.method ? t.method.name : t.cls.name;
    await choose(tr('Choose Implementation of {name} ({n} found)', { name, n: found.length }), found);
  }

  async function gotoSuperMethod(ed) {
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    if (!model || !pos || !isPy(modelPath(model))) return;
    // As in PyCharm, the method (or class) the caret is in, not the name under it.
    const t = await memberAt(model.uri.toString(), { line: pos.lineNumber - 1, character: pos.column - 1 }, false);
    const found = t ? await superMethods(t) : [];
    if (!found.length) return nav.hint(ed, t?.method || !t ? tr('No super method found') : tr('No super class found'));
    await choose(t.method ? tr('Choose Super Method of {name}', { name: t.method.name }) : tr('Choose Super Class of {name}', { name: t.cls.name }), found);
  }

  // ---------- gutter markers ----------
  // A method that overrides (or implements, when that one is abstract) a method of a base gets an up marker; one that
  // subclasses override (implement, when it is abstract) a down marker, a class with subclasses a down marker; clicking
  // one opens the target or lists them. Worked out per file after a pause in typing, at most MAX_CLASSES classes.
  const MAX_CLASSES = 40;
  const names = (targets) => {
    const list = [...new Set(byLabel(targets).map((t) => t.cls.name))];
    return list.length > 5 ? `${list.slice(0, 5).join(', ')}, …` : list.join(', ');
  };

  // -> Map(line -> {up: targets, down: targets, upAbstract, downAbstract, isClass}), or null when the file changed
  // meanwhile (stale()).
  async function markersOf(uri, stale) {
    const marks = new Map();
    for (const sym of (await classSymbols(uri)).slice(0, MAX_CLASSES)) {
      if (stale()) return null;
      const cls = itemOf(sym, uri);
      const [own, tree, subs] = await Promise.all([classInfo(cls), baseTree(cls), allSubtypes(cls, 50)]);
      const subInfos = [];
      for (const sub of subs) subInfos.push(await classInfo(sub));
      if (subs.length) marks.set(sym.selectionRange.start.line + 1, { up: [], down: subs.map((c) => ({ cls: c, sym: null })), isClass: true });
      for (const [name, m] of own.methods) {
        const up = findUp(tree, name);
        const down = findDown(subInfos, name);
        if (!up.length && !down.length) continue;
        marks.set(m.sym.selectionRange.start.line + 1, { up, down, upAbstract: up.length > 0 && up.every((u) => u.abstract), downAbstract: m.abstract });
      }
    }
    return marks;
  }

  function hoverOf(mark) {
    const lines = [];
    if (mark.isClass) lines.push(tr('Is subclassed by {names}', { names: names(mark.down) }));
    else {
      if (mark.up.length) lines.push(mark.upAbstract ? tr('Implements method in {names}', { names: names(mark.up) }) : tr('Overrides method in {names}', { names: names(mark.up) }));
      if (mark.down.length) lines.push(mark.downAbstract ? tr('Is implemented in {names}', { names: names(mark.down) }) : tr('Is overridden in {names}', { names: names(mark.down) }));
    }
    return lines.join('  \n');
  }
  const markClass = (mark) => `th-gutter ${mark.up.length && mark.down.length ? 'th-updown' : mark.up.length ? 'th-up' : 'th-down'}${(mark.up.length ? mark.upAbstract : mark.downAbstract) ? ' th-impl' : ''}`;

  let epoch = 0; // bumped when another file may have changed what a file's markers are
  const cache = new Map(); // `${uri}@${version}#${epoch}` -> Promise<marks | null>
  const gutters = new Map(); // editor -> {deco, marks, timer}

  async function refreshGutter(ed) {
    const g = gutters.get(ed);
    const model = ed.getModel();
    const path = model && modelPath(model);
    if (!g || !path || !isPy(path) || !ide.findTab?.(path)) { g?.deco.clear(); if (g) g.marks = new Map(); return; }
    if (!(await ide.lsp.ready())) return;
    const uri = model.uri.toString();
    const version = model.getVersionId();
    const key = `${uri}@${version}#${epoch}`;
    if (!cache.has(key)) {
      for (const k of cache.keys()) if (k.startsWith(`${uri}@`)) cache.delete(k);
      const mine = epoch;
      cache.set(key, markersOf(uri, () => model.isDisposed() || model.getVersionId() !== version || epoch !== mine).catch(() => null));
    }
    const marks = await cache.get(key);
    if (!marks) { cache.delete(key); return; }
    if (ed.getModel() !== model || model.getVersionId() !== version) return;
    g.marks = marks;
    g.deco.set([...marks].map(([line, mark]) => ({
      range: new ide.monaco.Range(line, 1, line, 1),
      options: { glyphMarginClassName: markClass(mark), glyphMarginHoverMessage: { value: hoverOf(mark) }, glyphMargin: { position: ide.monaco.editor.GlyphMarginLane.Left } },
    })));
  }
  const schedule = (ed, ms) => {
    const g = gutters.get(ed);
    if (!g) return;
    clearTimeout(g.timer);
    g.timer = setTimeout(() => refreshGutter(ed), ms);
  };
  const scheduleAll = (ms) => { for (const ed of gutters.keys()) schedule(ed, ms); };

  function gutterClick(mark, x, y) {
    const all = [...mark.up, ...mark.down];
    if (all.length === 1) return goTo(all[0]);
    const item = (t) => ({ label: targetLabel(t), detail: t.cls.detail, userText: true, run: () => goTo(t) });
    const items = [];
    if (mark.up.length) items.push({ header: mark.upAbstract ? tr('Implements method in') : tr('Overrides method in') }, ...byLabel(mark.up).map(item));
    if (mark.down.length) items.push({ header: mark.isClass ? tr('Subclasses') : mark.downAbstract ? tr('Implementations') : tr('Overriding methods') }, ...byLabel(mark.down).map(item));
    ide.ui.contextMenu(x, y, items);
  }

  const iconAt = (e) => e.button === 0 && e.target.closest?.('.th-gutter');
  ide.onEditor((ed) => {
    const g = { deco: ed.createDecorationsCollection(), marks: new Map(), timer: null };
    gutters.set(ed, g);
    const dom = ed.getContainerDomNode();
    // The capture phase, so the click neither sets a breakpoint nor moves the caret.
    for (const type of ['pointerdown', 'mousedown']) {
      dom.addEventListener(type, (e) => {
        if (!iconAt(e)) return;
        e.stopPropagation();
        if (type !== 'mousedown') return;
        e.preventDefault();
        const pos = ed.getTargetAtClientPoint(e.clientX, e.clientY)?.position;
        const mark = pos && g.marks.get(pos.lineNumber);
        if (mark) gutterClick(mark, e.clientX, e.clientY);
      }, true);
    }
    for (const type of ['pointerup', 'mouseup', 'click']) dom.addEventListener(type, (e) => iconAt(e) && e.stopPropagation(), true);
    // Another file's markers never stay up while this file's are worked out.
    ed.onDidChangeModel(() => { g.deco.clear(); g.marks = new Map(); schedule(ed, 300); });
    ed.onDidChangeModelContent(() => schedule(ed, 1500));
    ed.onDidDispose(() => { clearTimeout(g.timer); gutters.delete(ed); });
    schedule(ed, 300);
  });
  const otherFilesChanged = () => { epoch++; scheduleAll(1500); };
  ide.on('fileSaved', otherFilesChanged);
  ide.on('filesChanged', otherFilesChanged);
  ide.on('activeTabChanged', () => scheduleAll(300));

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
  // Keys come from the keymap (PyCharm: Ctrl+Alt+B, Ctrl+U), which editor keybindings own.
  ide.registerAction({ id: 'GotoImplementation', title: tr('Go to Implementation(s)'), when: editorPython, run: () => gotoImplementation(ide.editor) });
  ide.registerAction({ id: 'GotoSuperMethod', title: tr('Go to Super Method'), when: editorPython, run: () => gotoSuperMethod(ide.editor) });
  ide.onEditor((ed) => {
    ed.addAction({
      id: 'pyide.typeHierarchy', label: tr('Type Hierarchy'), contextMenuGroupId: 'navigation', contextMenuOrder: 3.1,
      precondition: 'editorLangId == python', run: () => showTypeHierarchy(ed),
    });
    ed.addAction({
      id: 'pyide.gotoImplementation', label: tr('Go to Implementation(s)'), contextMenuGroupId: 'navigation', contextMenuOrder: 3.2,
      precondition: 'editorLangId == python', run: () => gotoImplementation(ed),
    });
    ed.addAction({
      id: 'pyide.gotoSuperMethod', label: tr('Go to Super Method'), contextMenuGroupId: 'navigation', contextMenuOrder: 3.3,
      precondition: 'editorLangId == python', run: () => gotoSuperMethod(ed),
    });
  });

  ide.typeHierarchy = {
    show: (mode) => showTypeHierarchy(ide.editor, mode),
    // For tests: the class at a position and its direct supertypes/subtypes, as the window gets them.
    classAt, supertypes, subtypes, basesOf,
    // The gutter markers of an editor: [{line, kind: 'up' | 'down' | 'updown', implements, hover}].
    gutterMarks: (ed = ide.editor) => [...(gutters.get(ed)?.marks || [])].map(([line, mark]) => ({
      line, kind: markClass(mark).split(' ')[1].slice(3), implements: markClass(mark).includes('th-impl'), hover: hoverOf(mark),
    })),
  };
})();
