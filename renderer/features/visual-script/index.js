// Visual Scripting: *.pyflow files open as a node graph (Blueprint style) that compiles to Python. model.js owns the
// file format and the pure edit helpers, nodes.js the node types, codegen.js the Python generator and editor.js the
// canvas tab; all four add to window.PyideVisualScript. This file loads them, registers the viewer, and connects the
// graph to the IDE: a run configuration type (Shift+F10, Rerun, stdin, tracebacks mapped to nodes), the Show Python
// Code pane, Export as Python… and Project tree › New › Visual Script.
(() => {
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const here = document.currentScript.src.replace(/[^/]*$/, '');
  const VS = window.PyideVisualScript || (window.PyideVisualScript = {});

  let markLoaded;
  const loaded = new Promise((resolve) => { markLoaded = resolve; });
  for (const file of ['model.js', 'nodes.js', 'codegen.js', 'editor.js']) {
    const s = el('script');
    s.src = here + file;
    s.async = false;
    if (file === 'editor.js') { s.onload = markLoaded; s.onerror = markLoaded; }
    document.body.appendChild(s);
  }

  const SCRIPT = /\.pyflow$/i;
  const isScript = (p) => SCRIPT.test(p || '');
  const nameOf = (p) => basename(p).replace(SCRIPT, '');
  const SHOW_CODE = 'visualScript.showCode';
  // Every canvas showing the file (one per editor group it is open in).
  const viewsOf = (path) => ide.groups().flatMap((g) => g.tabs).filter((t) => t.visualScript && samePath(t.path, path)).map((t) => t.visualScript);
  const activeScriptPath = () => { const t = ide.activeTab(); return t?.visualScript ? t.path : null; };
  const quoteArg = (a) => (/\s/.test(a) ? `"${a}"` : a);

  // The script as the user sees it: the open document (saved or not), else the file on disk.
  async function readGraph(path) {
    return VS.parse(ide.getDocument(path)?.model.getValue() ?? await ide.api.read(path));
  }
  const compile = (graph, path) => VS.compile(graph, { fileName: basename(path) });
  const describe = (graph, e) => {
    const node = e.node && graph.nodes.find((n) => n.id === e.node);
    return node ? `${VS.titleOf(node)} (${node.id}): ${e.message}` : e.message;
  };

  // Opens the script and shows the node: selected, in the middle of the canvas, and with `message` as its runtime error.
  async function revealNode(path, node, message) {
    const tab = await ide.openFile(path);
    const view = tab?.visualScript;
    if (!view) return;
    view.select([node]);
    view.centerOn(node);
    if (message !== undefined) view.markRuntimeError(node, message);
  }
  // Why a script cannot run or be exported: its canvas shows the problems and selects the first node in error.
  async function revealProblems(path, errors) {
    const tab = await ide.openFile(path);
    const view = tab?.visualScript;
    if (!view) return;
    view.markErrors(errors);
    const first = errors.find((e) => !e.warning && e.node);
    if (first) { view.select([first.node]); view.centerOn(first.node); }
  }

  // ---------- run ----------
  // Traceback frames in the generated file point at nodes through the compile map: their console links select the
  // node instead of opening the generated file, and a failed run marks the innermost one with the exception line.
  function followTraceback(con, path, file, map) {
    let errText = '';
    const nodeAt = (frameFile, line) => (samePath(ide.toLocalPath(frameFile), file) ? map[line] || null : null);
    const failure = () => {
      const at = errText.lastIndexOf('Traceback (most recent call last):');
      if (at < 0) return null;
      const tb = errText.slice(at);
      let node = null;
      for (const m of tb.matchAll(/File "([^"]+)", line (\d+)/g)) node = nodeAt(m[1], Number(m[2])) || node;
      const message = tb.split(/\r?\n/).filter((l) => l.trim() && !/^\s/.test(l) && !l.startsWith('Traceback')).pop() || '';
      return node && { node, message: message.trim() };
    };
    const append = con.append;
    con.append = (text, cls) => {
      append(text, cls);
      if (cls === 'err') errText += text;
      for (const a of con.out.lastElementChild?.querySelectorAll('a') || []) {
        const m = /^File "(.+)", line (\d+)$/.exec(a.textContent);
        const node = m && nodeAt(m[1], Number(m[2]));
        if (!node) continue;
        a.title = tr('Show the node in {name}', { name: basename(path) });
        a.onclick = () => revealNode(path, node, failure()?.message);
      }
    };
    return {
      markFailure() {
        const f = failure();
        if (f) for (const view of viewsOf(path)) view.markRuntimeError(f.node, f.message);
      },
    };
  }

  async function startScript(cfg, s, interp) {
    const run = ide.run;
    const con = s.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
    const path = run.resolvePath(cfg.file);
    if (!path) return con.append(`${tr('The visual script is not specified. Edit the configuration first.')}\n`, 'err');
    for (const view of viewsOf(path)) view.markRuntimeError(null);
    let graph;
    try { graph = await readGraph(path); } catch (err) {
      return con.append(`${tr('Cannot run {name}: {error}', { name: basename(path), error: ide.util.errorText(err) })}\n`, 'err');
    }
    const result = compile(graph, path);
    if (VS.hasErrors(result)) {
      const bad = result.errors.filter((e) => !e.warning);
      con.append(`${tr('Fix the problems in {name} before running it:', { name: basename(path) })}\n${bad.map((e) => `  ${describe(graph, e)}\n`).join('')}`, 'err');
      await revealProblems(path, result.errors);
      return;
    }
    const file = await ide.api.invoke('visual-script:write', path, result.code);
    const cwd = dirname(path);
    const params = run.parseArgs(cfg.params);
    con.append(`${[interp.cmd, ...interp.args, file, ...params].map(quoteArg).join(' ')}\n`, 'sys');
    await run.warnMissingEnvFiles(cfg, (text) => con.append(text, 'err'));
    const trace = followTraceback(con, path, file, result.map);
    // The script's folder is on PYTHONPATH too: the generated file lives elsewhere, and modules beside the .pyflow
    // must import as they would beside a .py file.
    const roots = [...new Set([ide.root, cwd].filter(Boolean))];
    const id = await ide.api.invoke('run:start', interp, file, cwd, params, run.parseEnv(cfg.env), roots, run.envFiles(cfg));
    s.attach(id, { onExit: (code) => { if (code !== 0) trace.markFailure(); } });
  }

  const configFor = (path) => ({ type: 'visual-script', name: nameOf(path), file: path });
  if (ide.run) {
    ide.run.registerType({
      type: 'visual-script', title: tr('Visual Script'), icon: '🧩',
      fields: [
        { key: 'file', label: tr('Visual script'), placeholder: tr('path\\to\\script.pyflow') },
        { key: 'params', label: tr('Script parameters') },
        { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
        ide.run.envFilesField,
        { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
      ],
      defaults: () => ({ file: '', params: '', env: '', envFiles: ide.run.defaultEnvFiles, interp: '' }),
      identity: (c) => ide.run.resolvePath(c.file).toLowerCase(),
      file: (c) => ide.run.resolvePath(c.file),
      forFile: (path) => (isScript(path) ? configFor(path) : null),
      start: startScript,
    });
    ide.registerTreeAction({
      title: tr("Run '…'"),
      keyAction: 'RunClass',
      when: (e) => !e.dir && isScript(e.name),
      run: (e) => ide.run.runContext(configFor(e.path)),
    });
  }

  // ---------- Export as Python… ----------
  async function exportPython(path) {
    let graph;
    try { graph = await readGraph(path); } catch (err) { ide.ui.alert(ide.util.errorText(err)); return null; }
    const result = compile(graph, path);
    if (VS.hasErrors(result)) {
      await revealProblems(path, result.errors);
      ide.ui.alert(tr('Fix the problems in {name} before exporting it.', { name: basename(path) }));
      return null;
    }
    const target = joinPath(dirname(path), `${nameOf(path)}.py`);
    const existed = await ide.api.exists(target);
    try {
      if (existed) {
        const ok = await ide.ui.confirm(tr('{name} already exists. Overwrite it?', { name: basename(target) }), { title: tr('Export as Python'), ok: tr('Overwrite') });
        if (!ok) return null;
        await ide.localHistory?.checkpoint('Before Export as Python', { paths: [target] });
      }
      await ide.api.write(target, ide.lineSeparators?.forNewFile(result.code) ?? result.code);
    } catch (err) { ide.ui.alert(ide.util.errorText(err)); return null; }
    await ide.reloadFromDisk([target]);
    await ide.refreshTree();
    if (!existed) ide.emit('filesChanged', { created: [target] });
    await ide.openFile(target);
    return target;
  }
  ide.registerAction({
    id: 'VisualScript.ExportPython', title: tr('Export as Python…'),
    when: () => !!activeScriptPath(), run: () => { const p = activeScriptPath(); if (p) exportPython(p); },
  });

  // ---------- Project tree › New › Visual Script ----------
  // A new script says hello: Start wired to a Print of "Hello".
  function helloGraph() {
    let g = VS.newGraph();
    const start = g.nodes[0];
    const id = VS.nextId(g);
    g = VS.addNode(g, { id, type: 'io.print', x: start.x + 240, y: start.y });
    g = VS.setInputLiteral(g, id, 'value', 'Hello');
    return VS.connect(g, { node: start.id, pin: 'next' }, { node: id, pin: 'in' });
  }
  async function newVisualScript(dir) {
    const name = (await ide.ui.prompt(tr('New visual script name'), ''))?.trim();
    if (!name) return null;
    const target = joinPath(dir, isScript(name) ? name : `${name}.pyflow`);
    if (await ide.api.exists(target)) { ide.ui.alert(tr('{path} already exists', { path: basename(target) })); return null; }
    const text = VS.serialize(helloGraph());
    try {
      await ide.api.write(target, ide.lineSeparators?.forNewFile(text) ?? text);
    } catch (err) { ide.ui.alert(ide.util.errorText(err)); return null; }
    await ide.refreshTree();
    ide.emit('filesChanged', { created: [target] });
    await ide.revealInTree?.(target);
    await ide.openFile(target);
    return target;
  }
  // file-templates owns the tree's New › submenu, so Visual Script joins it there, after Python Package; without that
  // plugin it gets a New › of its own. The other plugins' items are known once every plugin has loaded.
  const dirOf = (entry) => (!entry ? ide.root : entry.dir ? entry.path : dirname(entry.path));
  function withScriptItem(items, item) {
    const list = [...items];
    const after = list.findIndex((it) => it.label === tr('Python Package'));
    const at = after >= 0 ? after + 1 : list.findIndex((it) => it.separator);
    list.splice(at >= 0 ? at : list.length, 0, item);
    return list;
  }
  ide.on('ready', () => {
    const producers = ide.treeNewItems.splice(0);
    ide.treeNewItems.push((entry) => {
      const items = producers.flatMap((fn) => { try { return fn(entry) || []; } catch (err) { console.error(err); return []; } });
      if (!ide.root) return items;
      const item = { label: tr('Visual Script'), detail: '.pyflow', run: () => newVisualScript(dirOf(entry)) };
      const menu = items.find((it) => it.label === tr('New') && it.submenu);
      if (!menu) return [...items, { label: tr('New'), submenu: [item] }];
      const inner = menu.submenu;
      menu.submenu = () => withScriptItem(typeof inner === 'function' ? inner() : inner, item);
      return items;
    });
  });

  // ---------- the tab: Run, Show Python Code, Export ----------
  let codeModels = 0;
  // The read-only Python beside the canvas follows the graph; a node's lines are highlighted while it is selected,
  // and clicking a line selects its node.
  function codePane(view, path) {
    const head = el('div', 'vs-code-head', tr('Python code (read-only)'));
    const box = el('div', 'vs-code');
    view.side.append(head, box);
    const monaco = ide.monaco;
    const model = monaco.editor.createModel('', 'python', monaco.Uri.parse(`pyide-visual-script:/${++codeModels}/${nameOf(path)}.py`));
    const ed = ide.createEditor(box, {
      model, readOnly: true, domReadOnly: true, glyphMargin: false, folding: false, lineNumbersMinChars: 3,
      rulers: [], renderLineHighlight: 'none', contextmenu: false, minimap: { enabled: false },
    });
    const lines = ed.createDecorationsCollection();
    let map = [];
    let timer = 0;
    let fromCode = false;
    function highlight() {
      const selected = new Set(view.selection());
      const hit = [];
      map.forEach((id, line) => { if (id && selected.has(id)) hit.push(line); });
      lines.set(hit.map((line) => ({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'vs-code-sel', linesDecorationsClassName: 'vs-code-sel-mark' } })));
      if (hit.length && !fromCode) ed.revealLinesInCenterIfOutsideViewport(hit[0], hit[hit.length - 1]);
      view.side.dataset.lines = hit.join(',');
    }
    function update() {
      timer = 0;
      const graph = view.graph();
      if (!graph) return;
      const result = compile(graph, path);
      map = result.map;
      if (model.getValue() !== result.code) {
        const state = ed.saveViewState();
        model.setValue(result.code);
        ed.restoreViewState(state);
      }
      highlight();
    }
    const schedule = () => { if (!timer) timer = setTimeout(update, 100); };
    const unsubChange = view.onChange(schedule);
    const unsubSelect = view.onSelect(highlight);
    ed.onMouseDown((e) => {
      const id = map[e.target.position?.lineNumber];
      if (!id || !view.graph()?.nodes.some((n) => n.id === id)) return;
      fromCode = true;
      try { view.select([id]); view.centerOn(id); } finally { fromCode = false; }
    });
    update();
    return {
      editor: ed,
      update,
      dispose() { clearTimeout(timer); unsubChange(); unsubSelect(); ed.dispose(); model.dispose(); },
    };
  }

  function integrate(view, path) {
    const button = (cls, label, title, run, icon) => {
      const b = el('button', `vs-btn ${cls}`);
      b.type = 'button';
      if (icon) b.append(ide.icon(icon, ''));
      b.append(label);
      b.title = title;
      b.addEventListener('click', run);
      view.toolbar.appendChild(b);
      return b;
    };
    const runBtn = button('vs-run', tr('Run'), '', () => ide.run?.runContext(configFor(path)), 'runRun');
    ide.keymap.tooltip(runBtn, tr("Run '{name}'", { name: nameOf(path) }), 'RunClass');
    runBtn.hidden = !ide.run;
    let pane = null;
    const codeBtn = button('vs-show-code', tr('Show Code'), tr('Show the Python code of this script'), () => {
      const on = codeBtn.getAttribute('aria-pressed') !== 'true';
      ide.settings.set(SHOW_CODE, on);
      showCode(on);
    });
    function showCode(on) {
      codeBtn.setAttribute('aria-pressed', String(on));
      view.side.classList.toggle('hidden', !on);
      if (on && !pane) pane = codePane(view, path);
      else if (on) pane.update();
    }
    button('vs-export', tr('Export as Python…'), tr('Write this script as {name} next to it', { name: `${nameOf(path)}.py` }), () => exportPython(path));
    showCode(!!ide.settings.get(SHOW_CODE, false));
    view.codePane = () => pane;
    return { dispose: () => pane?.dispose() };
  }

  // A tab restored at startup can mount before the scripts above have run; it mounts once they have.
  function mount(host, ctx) {
    let view = null;
    let extras = null;
    let disposed = false;
    const start = () => {
      if (disposed) return;
      if (!VS.mountEditor) { host.textContent = tr('Visual Scripting could not be loaded.'); return; }
      view = VS.mountEditor(host, ctx);
      ctx.tab.visualScript = view;
      extras = integrate(view, ctx.path);
    };
    if (VS.mountEditor) start();
    else loaded.then(start);
    return {
      dispose() {
        disposed = true;
        extras?.dispose();
        view?.dispose();
        if (ctx.tab.visualScript === view) delete ctx.tab.visualScript;
      },
    };
  }

  ide.registerFileViewer({ id: 'visual-script', icon: '🧩', text: true, match: isScript, mount });
})();
