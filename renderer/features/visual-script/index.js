// Visual Scripting: *.pyflow files open as a node graph (Blueprint style) that compiles to Python. model.js owns the
// file format and the pure edit helpers, nodes.js the node types, codegen.js the Python generator and editor.js the
// canvas tab; all four add to window.PyideVisualScript. This file loads them, registers the viewer, and connects the
// graph to the IDE: a run configuration type (Shift+F10, Rerun, stdin, tracebacks mapped to nodes; Shift+F9 debugs it
// with debug.js mapping breakpoints and the paused position to nodes), the Show Python Code pane, Export as Python…
// and Project tree › New › Visual Script.
(() => {
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const here = document.currentScript.src.replace(/[^/]*$/, '');
  const VS = window.PyideVisualScript || (window.PyideVisualScript = {});

  let markLoaded;
  const loaded = new Promise((resolve) => { markLoaded = resolve; });
  for (const file of ['model.js', 'nodes.js', 'codegen.js', 'symbols.js', 'editor.js', 'debug.js']) {
    const s = el('script');
    s.src = here + file;
    s.async = false;
    if (file === 'debug.js') { s.onload = markLoaded; s.onerror = markLoaded; }
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

  // Where the generated file imports the project from: the project root, its src/ folder in a src layout (the symbol
  // index names src/shop/cart.py shop.cart), and the script's folder, since the generated file lives elsewhere and
  // modules beside the .pyflow must import as they would beside a .py file.
  async function importRoots(cwd) {
    const src = ide.root && joinPath(ide.root, 'src');
    const srcLayout = src && (await ide.api.exists(src)) && !(await ide.api.exists(joinPath(src, '__init__.py')));
    return [...new Set([ide.root, srcLayout ? src : null, cwd].filter(Boolean))];
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
    const roots = await importRoots(cwd);
    const id = await ide.api.invoke('run:start', interp, file, cwd, params, run.parseEnv(cfg.env), roots, run.envFiles(cfg));
    s.attach(id, { onExit: (code) => { if (code !== 0) trace.markFailure(); } });
  }

  // Shift+F9: the debugger runs the generated file with debugpy; debug.js maps its lines, breakpoints and values to
  // nodes. A script with problems is not debugged ({script: null} starts nothing), as it is not run.
  async function debugTarget(cfg) {
    const none = { script: null };
    const path = ide.run.resolvePath(cfg.file);
    if (!path) { ide.ui.alert(tr('The visual script is not specified. Edit the configuration first.')); return none; }
    let graph;
    try { graph = await readGraph(path); } catch (err) {
      ide.ui.alert(tr('Cannot debug {name}: {error}', { name: basename(path), error: ide.util.errorText(err) }));
      return none;
    }
    for (const view of viewsOf(path)) view.markRuntimeError(null);
    const result = compile(graph, path);
    if (VS.hasErrors(result)) {
      await revealProblems(path, result.errors);
      const bad = result.errors.filter((e) => !e.warning);
      ide.ui.alert(`${tr('Fix the problems in {name} before debugging it:', { name: basename(path) })}\n${bad.map((e) => describe(graph, e)).join('\n')}`);
      return none;
    }
    const file = await ide.api.invoke('visual-script:write', path, result.code);
    await loaded;
    VS.debugSession({ path, file, graph, result });
    const cwd = dirname(path);
    const env = ide.run.parseEnv(cfg.env);
    // As for Run (the debugger adds the project root itself).
    const roots = (await importRoots(cwd)).filter((r) => !samePath(r, ide.root));
    env.PYTHONPATH = [...roots, env.PYTHONPATH].filter(Boolean).join(/Win/i.test(navigator.platform) ? ';' : ':');
    return { script: file, cwd, params: ide.run.parseArgs(cfg.params), env };
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
      debugTarget,
    });
    ide.registerTreeAction({
      title: tr("Run '…'"),
      keyAction: 'RunClass',
      when: (e) => !e.dir && isScript(e.name),
      run: (e) => ide.run.runContext(configFor(e.path)),
    });
  }

  // ---------- Export as Python… ----------
  // Python's standard modules (sys.stdlib_module_names of 3.14 and those older versions still have), for when the
  // interpreter cannot be asked (Safe Mode, no interpreter).
  const STDLIB = new Set(('abc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb '
    + 'binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys '
    + 'compileall compression concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses '
    + 'datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp '
    + 'fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq '
    + 'hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache '
    + 'locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis '
    + 'nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes '
    + 'pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data '
    + 'pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex '
    + 'shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat '
    + 'statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile '
    + 'termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle '
    + 'turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound '
    + 'wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo').split(' '));
  // The top-level modules `code` imports, at any indentation (a Python Code node's import inside main()).
  function importedModules(code) {
    const out = new Set();
    for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
      for (const part of m[1].split(',')) { const name = part.trim().split(/[\s.]/)[0]; if (name) out.add(name); }
    }
    for (const m of code.matchAll(/^[ \t]*from[ \t]+([^\s.]+)/gm)) out.add(m[1]);
    return out;
  }
  // Would `<name>.py` beside the script hide a module: one the code imports, a standard one or an installed one?
  async function hidesModule(name, code) {
    if (importedModules(code).has(name) || STDLIB.has(name)) return true;
    const installed = await VS.symbols?.packages().catch(() => []);
    return !!installed?.includes(name);
  }
  // Asks for a file name that hides no module; resolves the name (with .py) or null.
  async function exportName(stem, code) {
    if (!(await hidesModule(stem, code))) return `${stem}.py`;
    let suggestion = `${stem}_script`;
    for (let i = 2; await hidesModule(suggestion, code); i++) suggestion = `${stem}_script${i}`;
    return new Promise((resolve) => {
      let chosen = null;
      const message = el('div', 'dialog-message');
      const say = (module) => {
        message.textContent = tr('{file} would hide the Python module {module}: "import {module}" in this script or in a file next to it would load {file} instead. Export it under another name:', { file: `${module}.py`, module });
      };
      say(stem);
      const input = el('input', 'vs-export-input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = `${suggestion}.py`;
      input.setAttribute('aria-label', tr('File name'));
      const body = el('div');
      body.append(message, input);
      const refuse = () => { input.classList.add('vs-invalid'); input.focus(); return false; };
      ide.ui.dialog({
        title: tr('Export as Python'),
        body,
        onClose: () => resolve(chosen),
        buttons: [
          {
            label: tr('Export'), primary: true,
            run: async () => {
              const name = input.value.trim().replace(/\.py$/i, '');
              if (!name || /[\\/:*?"<>|]/.test(name)) return refuse();
              if (await hidesModule(name, code)) { say(name); return refuse(); }
              chosen = `${name}.py`;
              return true;
            },
          },
          { label: tr('Cancel') },
        ],
      });
      input.select();
    });
  }
  async function exportPython(path) {
    let graph;
    try { graph = await readGraph(path); } catch (err) { ide.ui.alert(ide.util.errorText(err)); return null; }
    const result = compile(graph, path);
    if (VS.hasErrors(result)) {
      await revealProblems(path, result.errors);
      ide.ui.alert(tr('Fix the problems in {name} before exporting it.', { name: basename(path) }));
      return null;
    }
    const fileName = await exportName(nameOf(path), result.code);
    if (!fileName) return null;
    const target = joinPath(dirname(path), fileName);
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
      detachDebug = VS.attachDebug?.(view, ctx.path);
    };
    let detachDebug = null;
    if (VS.mountEditor && VS.attachDebug) start();
    else loaded.then(start);
    return {
      dispose() {
        disposed = true;
        detachDebug?.();
        extras?.dispose();
        view?.dispose();
        if (ctx.tab.visualScript === view) delete ctx.tab.visualScript;
      },
    };
  }

  ide.registerFileViewer({ id: 'visual-script', icon: '🧩', text: true, match: isScript, mount });

  // ---------- a .py file as a visual script: the preview and Convert to Visual Script ----------
  // python/py2flow.py reads the file (the open document's text) with `ast` in the project interpreter and lays it out
  // as a graph; statements the graph cannot run the same way stay Python Code nodes, so a converted file runs as before.
  const isPython = (p) => /\.pyw?$/i.test(p || '');
  const activePythonPath = () => { const t = ide.activeTab(); return t?.kind === 'file' && isPython(t.path) ? t.path : null; };
  async function pythonGraph(path) {
    const interp = VS.localInterp?.();
    if (!interp) return { ok: false, error: { message: tr('No Python interpreter found.') } };
    const source = ide.getDocument(path)?.model.getValue() ?? await ide.api.read(path);
    return ide.api.invoke('visual-script:fromPython', { root: ide.root, interp, source })
      .catch((err) => ({ ok: false, error: { message: ide.util.errorText(err) } }));
  }
  const problemText = (r) => (r.reason === 'untrusted' ? tr('Trust the project to show its Python files as visual scripts.')
    : r.error?.line ? tr('Line {line}: {message}', { line: r.error.line, message: r.error.message }) : r.error?.message || tr('The file could not be read.'));
  const fallbackText = (r) => (r.fallback
    ? tr('{count} of {total} statements stay Python Code nodes, since nodes would not run them the same way.', { count: r.fallback, total: r.statements })
    : tr('Every statement is a node.'));

  async function convertToScript(path) {
    const r = await pythonGraph(path);
    if (!r.ok) { ide.ui.alert(problemText(r)); return null; }
    const text = VS.serialize(VS.parse(JSON.stringify(r.graph)));
    const target = joinPath(dirname(path), `${basename(path).replace(/\.pyw?$/i, '')}.pyflow`);
    const existed = await ide.api.exists(target);
    try {
      if (existed) {
        const ok = await ide.ui.confirm(tr('{name} already exists. Overwrite it?', { name: basename(target) }), { title: tr('Convert to Visual Script'), ok: tr('Overwrite') });
        if (!ok) return null;
        await ide.localHistory?.checkpoint('Before Convert to Visual Script', { paths: [target] });
      }
      await ide.api.write(target, ide.lineSeparators?.forNewFile(text) ?? text);
    } catch (err) { ide.ui.alert(ide.util.errorText(err)); return null; }
    if (existed) await ide.reloadFromDisk([target]);
    await ide.refreshTree();
    if (!existed) ide.emit('filesChanged', { created: [target] });
    await ide.openFile(target);
    ide.notifications?.notify({ title: tr('Converted {name} to {target}', { name: basename(path), target: basename(target) }), text: fallbackText(r), kind: r.fallback ? 'info' : 'ok', group: 'Visual Scripting' });
    return target;
  }

  const PREVIEW = 'visual-script-preview:';
  let previewModels = 0;
  // The read-only canvas of a .py file, in its own tab beside it. It follows the file as it is typed; a node selects
  // its lines in the editor, and the caret selects the node of its line.
  function mountPreview(host, tab, path) {
    const monaco = ide.monaco;
    const model = monaco.editor.createModel('', 'json', monaco.Uri.parse(`pyide-visual-script-preview:/${++previewModels}/${nameOf(basename(path))}.pyflow`));
    const view = VS.mountEditor(host, { doc: { model }, path: `${path}.pyflow`, tab, readOnly: true });
    host.classList.add('vs-preview');
    const note = el('span', 'vs-preview-note');
    const convertBtn = el('button', 'vs-btn vs-convert', tr('Convert to Visual Script…'));
    convertBtn.type = 'button';
    convertBtn.title = tr('Write this file as {name} next to it', { name: `${basename(path).replace(/\.pyw?$/i, '')}.pyflow` });
    convertBtn.addEventListener('click', () => convertToScript(path));
    view.toolbar.append(convertBtn, note);
    let lines = {};
    let generation = 0;
    let fitted = false;
    async function update() {
      const my = ++generation;
      const r = await pythonGraph(path);
      if (my !== generation || disposed) return;
      host.classList.toggle('vs-preview-stale', !r.ok);
      note.textContent = r.ok ? fallbackText(r) : problemText(r);
      host.dataset.preview = r.ok ? 'ok' : r.reason || 'error';
      if (!r.ok) return;
      lines = r.lines || {};
      const text = VS.serialize(VS.parse(JSON.stringify(r.graph)));
      if (model.getValue() !== text) model.setValue(text);
      // The canvas fitted the empty document it mounted with; the first graph is shown whole.
      if (!fitted) { fitted = true; view.fit(); }
      host.dataset.version = String((Number(host.dataset.version) || 0) + 1);
    }
    let timer = 0;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 500); };
    const disposers = [];
    const doc = ide.getDocument(path);
    if (doc) disposers.push(doc.model.onDidChangeContent(schedule));
    disposers.push(ide.on('interpreterChanged', schedule));
    const editorsOf = () => (doc ? ide.editors().filter((e) => e.getModel() === doc.model) : []);
    // The node whose lines hold `line` most closely (a statement's step before the values inside it).
    const nodeAt = (line) => Object.entries(lines).filter(([, [a, b]]) => a <= line && line <= b)
      .sort(([, [a1, b1]], [, [a2, b2]]) => (b1 - a1) - (b2 - a2) || a2 - a1)[0]?.[0];
    let fromEditor = false;
    disposers.push(view.onSelect((ids) => {
      if (fromEditor || ids.length !== 1 || !lines[ids[0]]) return;
      const [a, b] = lines[ids[0]];
      for (const ed of editorsOf()) {
        ed.setSelection(new monaco.Selection(a, 1, a, 1));
        ed.revealLinesInCenterIfOutsideViewport(a, b);
      }
    }));
    disposers.push(ide.onEditor((ed) => {
      const sub = ed.onDidChangeCursorPosition((e) => {
        if (!doc || ed.getModel() !== doc.model || !ed.hasTextFocus() || e.source === 'api') return;
        const id = nodeAt(e.position.lineNumber);
        if (!id) return;
        fromEditor = true;
        try { view.select([id]); view.revealNode(id); } finally { fromEditor = false; }
      });
      disposers.push(sub);
    }));
    let disposed = false;
    tab.preview = { view, update, lines: () => lines, path };
    // The core calls a custom tab's dispose when it closes.
    tab.dispose = () => {
      disposed = true;
      clearTimeout(timer);
      for (const d of disposers) (typeof d === 'function' ? d() : d.dispose());
      view.dispose();
      model.dispose();
    };
    update();
  }
  async function showPreview(path) {
    const id = PREVIEW + ide.util.pathKey(path);
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    await loaded;
    return ide.openCustomTab({
      id, title: tr('{name} (Visual Script)', { name: basename(path) }), icon: '🧩', group: 'right',
      mount: (host, tab) => mountPreview(host, tab, path),
    });
  }
  ide.on('fileClosed', (path) => { if (path && isPython(path)) ide.closeTab(PREVIEW + ide.util.pathKey(path), true); });

  ide.registerAction({
    id: 'VisualScript.ShowAsFlow', title: tr('Show as Visual Script'), context: 'editor',
    when: () => !!activePythonPath() && !!ide.root, run: () => { const p = activePythonPath(); if (p) showPreview(p); },
  });
  ide.registerAction({
    id: 'VisualScript.ConvertFromPython', title: tr('Convert to Visual Script…'),
    when: () => !!activePythonPath() && !!ide.root, run: () => { const p = activePythonPath(); if (p) convertToScript(p); },
  });
  const pythonEntry = (e) => !e.dir && isPython(e.name) && !!ide.root;
  ide.registerTreeAction({ title: tr('Show as Visual Script'), when: pythonEntry, run: async (e) => { await ide.openFile(e.path); showPreview(e.path); } });
  ide.registerTreeAction({ title: tr('Convert to Visual Script…'), when: pythonEntry, run: (e) => convertToScript(e.path) });
  VS.showPreview = showPreview;
  VS.convertToScript = convertToScript;
})();
