// Test runner: the 'pytest' run configuration type, the Test Results view inside the Run tool window,
// gutter icons on tests, and Ctrl+Shift+F10 on the test at the caret.
(() => {
  const { el, basename, samePath } = ide.util;
  const run = ide.run;
  const lastResults = new Map(); // node id -> 'passed' | 'failed' (for gutter icons)

  const isTestFileName = (name) => /^test_.*\.py$|_test\.py$/i.test(name);
  const relPosix = (p) => ide.util.rel(p).replace(/\\/g, '/');
  const moduleName = (p) => basename(p).replace(/\.py$/i, '');

  // Finds test functions, test classes and their test methods by indentation, like PyCharm's pytest/unittest
  // run-line markers. Returns [{line, end, kind, name, cls}].
  function testsIn(lines) {
    const out = [];
    let cls = null;
    const open = [];
    const indentOf = (s) => s.match(/^\s*/)[0].length;
    lines.forEach((text, i) => {
      if (!text.trim() || /^\s*#/.test(text)) return;
      const ind = indentOf(text);
      while (open.length && ind <= open[open.length - 1].indent) open.pop().item.end = i;
      if (ind === 0 && !/^\s*@/.test(text)) cls = null;
      let m;
      if (ind === 0 && (m = text.match(/^class\s+(\w+)\s*(\(([^)]*)\))?\s*:/))) {
        if (/^Test/.test(m[1]) || /TestCase/.test(m[3] || '')) {
          cls = { line: i + 1, kind: 'class', name: m[1], cls: m[1], end: lines.length };
          out.push(cls);
          open.push({ indent: 0, item: cls });
        }
      } else if ((m = text.match(/^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/))) {
        if (ind === 0) {
          const item = { line: i + 1, kind: 'function', name: m[2], cls: null, end: lines.length };
          out.push(item);
          open.push({ indent: 0, item });
        } else if (cls && open.length === 1) {
          const item = { line: i + 1, kind: 'method', name: m[2], cls: cls.name, end: lines.length };
          out.push(item);
          open.push({ indent: ind, item });
        }
      }
    });
    return out;
  }

  const nodeIdFor = (path, item) => [relPosix(path), item.cls, item.kind === 'class' ? null : item.name].filter(Boolean).join('::');
  const titleFor = (path, item) => tr('pytest for {name}', { name: [moduleName(path), item.cls, item.kind === 'class' ? null : item.name].filter(Boolean).join('.') });
  const configFor = (path, item) => (item
    ? { type: 'pytest', name: titleFor(path, item), target: nodeIdFor(path, item) }
    : { type: 'pytest', name: tr('pytest in {name}', { name: basename(path) }), target: relPosix(path) });

  // The innermost test around a line, or null.
  function contextAt(model, lineNumber) {
    const items = testsIn(model.getLinesContent()).filter((t) => lineNumber >= t.line && lineNumber <= t.end);
    return items.sort((a, b) => b.line - a.line)[0] || null;
  }

  // ---------- run configuration type ----------
  run.registerType({
    type: 'pytest', title: 'pytest', icon: '🧪',
    fields: [
      { key: 'target', label: tr('Target'), placeholder: tr('Script, folder, or node id (test_x.py::TestY::test_z)') },
      { key: 'args', label: tr('Additional arguments'), placeholder: tr('e.g. -x -k "fast"') },
      { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the project root') },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      run.envFilesField,
      { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
    ],
    defaults: () => ({ target: '', args: '', cwd: '', env: '', envFiles: run.defaultEnvFiles, interp: '' }),
    identity: (c) => (c.target || '').toLowerCase(),
    file: (c) => {
      const p = (c.target || '').split('::')[0];
      return p && /\.py$/i.test(p) ? run.resolvePath(p) : null;
    },
    forFile: (path) => (isTestFileName(basename(path)) ? configFor(path, null) : null),
    start: (cfg, s, interp, opts) => startTests(cfg, s, interp, opts),
  });

  // ---------- Test Results view ----------
  const ICONS = { passed: '✓', failed: '✗', error: '✗', skipped: '⊘', running: '◷', pending: '○' };
  const fmtMs = (sec) => {
    const ms = Math.round((sec || 0) * 1000);
    return ms >= 1000 ? tr('{n} sec', { n: (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) }) : tr('{n} ms', { n: ms });
  };
  const RANK = { error: 5, failed: 5, running: 4, pending: 3, passed: 2, skipped: 1 };
  const STATUS_TEXT = { passed: tr('Passed'), failed: tr('Failed'), error: tr('Error'), skipped: tr('Ignored'), running: tr('Running'), pending: tr('Pending') };

  function createView(s) {
    const root = el('div', 'tr-view');
    const left = el('div', 'tr-left');
    const status = el('div', 'tr-status');
    const hint = el('div', 'tr-hint hidden');
    const tree = el('div', 'tr-tree');
    tree.tabIndex = 0;
    const split = el('div', 'tr-split');
    const right = el('div', 'tr-right');
    left.append(status, hint, tree);
    root.append(left, split, right);
    s.host.appendChild(root);
    const con = s.console({ parent: right });

    split.onmousedown = (down) => {
      const start = down.clientX;
      const w = left.offsetWidth;
      const move = (e) => (left.style.width = `${Math.max(180, w + e.clientX - start)}px`);
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    };

    const log = []; // full console output, restored when the root is selected
    const nodes = new Map();
    const rootNode = { id: '', kind: 'root', name: tr('Test Results'), children: [], status: 'pending', duration: 0, collapsed: false };
    nodes.set('', rootNode);
    let selected = rootNode;
    let finished = false;
    let started = performance.now();
    let elapsed = 0;

    const add = (parent, node) => { node.children = node.children || []; node.parent = parent; parent.children.push(node); nodes.set(node.id, node); return node; };
    function groupFor(t) {
      const fileKey = `file:${t.id.split('::')[0]}`;
      let fileNode = nodes.get(fileKey);
      if (!fileNode) {
        fileNode = add(rootNode, { id: fileKey, kind: 'file', name: t.id.split('::')[0].split('/').pop(), file: t.file, line: 1, status: 'pending' });
      }
      if (!t.cls) return fileNode;
      const clsKey = `${fileKey}::${t.cls}`;
      return nodes.get(clsKey) || add(fileNode, { id: clsKey, kind: 'class', name: t.cls, file: t.file, status: 'pending' });
    }

    const statusOf = (n) => {
      if (!n.children?.length || n.kind === 'test') return n.status;
      let best = null;
      for (const c of n.children) {
        const st = statusOf(c);
        if (!best || RANK[st] > RANK[best]) best = st;
      }
      if (finished && (best === 'running' || best === 'pending')) best = 'skipped';
      return best || (finished ? 'passed' : 'pending');
    };
    const durationOf = (n) => (n.kind === 'test' ? n.duration || 0 : n.children.reduce((a, c) => a + durationOf(c), 0));
    const leaves = () => [...nodes.values()].filter((n) => n.kind === 'test');

    function counts() {
      const c = { passed: 0, failed: 0, skipped: 0, total: 0, done: 0 };
      for (const n of leaves()) {
        c.total++;
        if (n.status === 'passed') c.passed++;
        else if (n.status === 'failed' || n.status === 'error') c.failed++;
        else if (n.status === 'skipped') c.skipped++;
        if (!['pending', 'running'].includes(n.status)) c.done++;
      }
      return c;
    }

    function renderStatus() {
      const c = counts();
      const time = fmtMs((finished ? elapsed : performance.now() - started) / 1000);
      let text;
      let cls;
      if (!finished) { text = tr('Running: {done} of {total} tests', { done: c.done, total: c.total }); cls = 'running'; }
      else if (!c.total) { text = tr('No tests were found'); cls = c.failed ? 'failed' : 'skipped'; }
      else {
        // PyCharm's wording: "Tests failed: 2, passed: 3, ignored: 1 of 6 tests – 120 ms"
        const parts = c.failed
          ? [tr('Tests failed: {failed}', { failed: c.failed }), c.passed && tr('passed: {passed}', { passed: c.passed })]
          : [tr('Tests passed: {passed}', { passed: c.passed })];
        if (c.skipped) parts.push(tr('ignored: {skipped}', { skipped: c.skipped }));
        const vars = { counts: parts.filter(Boolean).join(', '), total: c.total, time };
        text = c.total === 1 ? tr('{counts} of {total} test – {time}', vars) : tr('{counts} of {total} tests – {time}', vars);
        cls = c.failed ? 'failed' : 'passed';
      }
      status.replaceChildren(el('span', `tr-icon ${cls}`, finished ? ICONS[cls === 'passed' ? 'passed' : cls === 'failed' ? 'failed' : 'skipped'] : ICONS.running), el('span', null, text));
      status.dataset.state = cls;
    }

    function renderTree() {
      const frag = document.createDocumentFragment();
      const walk = (n, depth) => {
        const st = statusOf(n);
        const row = el('div', `tr-row${n === selected ? ' selected' : ''}`);
        row.dataset.id = n.id;
        row.dataset.kind = n.kind;
        row.dataset.status = st;
        row.style.paddingLeft = `${depth * 16 + 4}px`;
        const hasKids = n.children?.length;
        const arrow = el('span', 'tr-arrow', hasKids ? (n.collapsed ? '▸' : '▾') : '');
        arrow.onclick = (e) => { e.stopPropagation(); n.collapsed = !n.collapsed; renderTree(); };
        const name = el('span', 'tr-name', n.name);
        // Test, class and file names are user data; the root and "collection error" rows are UI text.
        if (n.kind !== 'root' && !n.uiName) name.dataset.userText = '';
        row.title = STATUS_TEXT[st] || '';
        row.append(arrow, el('span', `tr-icon ${st}`, ICONS[st]), name);
        if (n.kind === 'test' ? n.duration != null : st !== 'pending') row.appendChild(el('span', 'tr-time', fmtMs(n.kind === 'root' && finished ? elapsed / 1000 : durationOf(n))));
        row.onclick = () => selectNode(n, false);
        row.ondblclick = () => selectNode(n, true);
        frag.appendChild(row);
        if (hasKids && !n.collapsed) for (const c of n.children) walk(c, depth + 1);
      };
      walk(rootNode, 0);
      tree.replaceChildren(frag);
    }

    function showOutput(n) {
      con.clear();
      if (n === rootNode) { for (const [text, cls] of log) con.append(text, cls); return; }
      const tests = n.kind === 'test' ? [n] : leaves().filter((t) => { for (let p = t; p; p = p.parent) if (p === n) return true; return false; });
      for (const t of tests) {
        if (n.kind !== 'test') con.append(`${ICONS[t.status]} ${t.id}\n`, t.status === 'failed' || t.status === 'error' ? 'err' : 'sys');
        if (n.kind === 'test' || t.status === 'failed' || t.status === 'error') {
          if (t.status === 'skipped' && t.text) con.append(`${tr('Skipped: {reason}', { reason: t.text.replace(/^Skipped: /, '') })}\n`, 'sys');
          else if (t.text) con.append(`${t.text}\n`, 'err');
          if (t.output) con.append(`${t.output}\n`);
          if (n.kind === 'test' && !t.text && !t.output) con.append(`${t.status === 'passed' ? tr('Test passed.') : STATUS_TEXT[t.status] || t.status}\n`, 'sys');
        }
      }
    }

    // Single click shows the output and navigates without leaving the tree; double click focuses the editor.
    function selectNode(n, focusEditor) {
      selected = n;
      renderTree();
      showOutput(n);
      if (n.file && n.kind !== 'root') ide.openFile(n.file, { line: n.line || 1, focus: !!focusEditor });
      if (!focusEditor) tree.focus();
    }

    tree.onkeydown = (e) => {
      const rows = [...tree.querySelectorAll('.tr-row')];
      const i = rows.findIndex((r) => r.classList.contains('selected'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) { const n = nodes.get(next.dataset.id); selected = n; renderTree(); showOutput(n); tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }); }
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // Right/Left expand and collapse a file or class, Left on anything else goes to its parent.
        e.preventDefault();
        const kids = !!selected?.children?.length;
        if (kids && !!selected.collapsed === (e.key === 'ArrowRight')) { selected.collapsed = !selected.collapsed; renderTree(); }
        else if (e.key === 'ArrowLeft' && selected?.parent) { selected = selected.parent; renderTree(); showOutput(selected); tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }); }
      } else if ((e.key === 'Enter' || e.key === 'F4') && selected?.file) {
        e.preventDefault();
        e.stopPropagation();
        ide.openFile(selected.file, { line: selected.line || 1 });
      }
    };

    const view = {
      con,
      log(text, cls) { log.push([text, cls]); if (selected === rootNode) con.append(text, cls); },
      hint(text) { hint.textContent = text; hint.classList.remove('hidden'); },
      apply(events) {
        for (const ev of events) {
          if (ev.e === 'collected') {
            for (const t of ev.tests) {
              if (nodes.has(t.id)) continue;
              add(groupFor(t), { id: t.id, kind: 'test', name: t.name, file: t.file, line: t.line, status: 'pending', duration: null });
              const grp = nodes.get(`file:${t.id.split('::')[0]}`);
              if (grp && t.file) grp.file = t.file;
              if (t.cls) {
                const c = nodes.get(`file:${t.id.split('::')[0]}::${t.cls}`);
                if (c && (!c.line || t.line < c.line)) c.line = classLine(t.file, t.cls) || t.line;
              }
            }
          } else if (ev.e === 'start') {
            const n = nodes.get(ev.id);
            if (n) n.status = 'running';
          } else if (ev.e === 'result') {
            const n = nodes.get(ev.id);
            if (!n) continue;
            const worse = !n.result || RANK[ev.outcome] > RANK[n.status];
            n.duration = (n.duration || 0) + (ev.duration || 0);
            n.result = true;
            if (worse) {
              n.status = ev.outcome;
              if (ev.text) n.text = ev.text;
            }
            if (ev.output) n.output = (n.output || '') + ev.output;
            if (n === selected) showOutput(n);
          } else if (ev.e === 'collecterror') {
            const id = ev.id || 'collection';
            const fileNode = nodes.get(`file:${id}`) || add(rootNode, { id: `file:${id}`, kind: 'file', name: id.split('/').pop(), status: 'error' });
            add(fileNode, { id: `${id}::<collection>`, kind: 'test', name: tr('collection error'), uiName: true, file: fileNode.file, line: 1, status: 'error', text: ev.text, duration: 0 });
          }
        }
        renderStatus();
        renderTree();
      },
      finish() {
        finished = true;
        elapsed = performance.now() - started;
        for (const n of leaves()) if (n.status === 'running' || n.status === 'pending') n.status = 'skipped';
        renderStatus();
        renderTree();
        if (selected === rootNode) {
          // PyCharm selects the first failed test when a run finishes.
          const failed = leaves().find((n) => n.status === 'failed' || n.status === 'error');
          if (failed) { selected = failed; renderTree(); showOutput(failed); }
        }
        return counts();
      },
      failedIds: () => leaves().filter((n) => (n.status === 'failed' || n.status === 'error') && !n.id.endsWith('::<collection>')).map((n) => n.id),
      results: () => leaves().map((n) => ({ id: n.id, status: n.status })),
    };
    renderStatus();
    renderTree();
    return view;
  }

  // Test classes navigate to their own line, found from the open model or the file text cache.
  const classLines = new Map();
  function classLine(file, cls) {
    const key = `${file}::${cls}`.toLowerCase();
    if (classLines.has(key)) return classLines.get(key);
    const model = ide.findTab(file)?.model;
    const lines = model ? model.getLinesContent() : null;
    const i = lines ? lines.findIndex((l) => new RegExp(`^class\\s+${cls}\\b`).test(l)) : -1;
    const line = i >= 0 ? i + 1 : null;
    if (line) classLines.set(key, line);
    return line;
  }

  async function startTests(cfg, s, interp, opts = {}) {
    // What auto-test runs again: the same tests as this run (all of them, or the failed ones a rerun picked).
    s.autoTestLast = { targets: opts.targets, executor: s.executor };
    clearTimeout(s.autoTestTimer); // this run already includes the saves that armed the timer
    const view = createView(s);
    s.setActions([
      { id: 'rerunFailed', icon: '⟲', title: tr('Rerun Failed Tests'), run: () => {
        const failed = view.failedIds();
        if (failed.length) run.runConfig(s.cfg, { targets: failed });
      } },
      autoTestAction(s),
    ]);
    const fresh = !!opts.fresh;
    const version = await ide.api.invoke('tests:hasPytest', interp, fresh);
    const runner = version ? 'pytest' : 'unittest';
    if (!version) {
      const install = `${[interp.cmd, ...interp.args].join(' ')} -m pip install pytest`;
      view.hint(tr('pytest is not installed for {interp}. Running with unittest instead. Install pytest: {command}', { interp: interp.label || interp.cmd, command: install }));
      view.log(`${tr('pytest is not installed in the selected interpreter; falling back to unittest discovery.')}\n${tr('To install it: {command}', { command: install })}\n\n`, 'sys');
    }
    const targets = opts.targets || (cfg.target ? [cfg.target] : []);
    const cwd = run.resolvePath(cfg.cwd) || ide.root;
    await run.warnMissingEnvFiles(cfg, (text) => view.log(text, 'err'));
    const { id, command } = await ide.api.invoke('tests:start', interp, {
      runner, targets, args: runner === 'pytest' ? run.parseArgs(cfg.args) : [], cwd, root: ide.root, env: run.parseEnv(cfg.env), envFiles: run.envFiles(cfg),
    });
    view.log(`${command}\n`, 'sys');

    let polling = false;
    const poll = async (final) => {
      if (polling && !final) return;
      polling = true;
      try { view.apply(await ide.api.invoke('tests:poll', id, final)); } finally { polling = false; }
    };
    const timer = setInterval(() => poll(false), 250);
    s.dispose = () => clearInterval(timer);
    s.started(id);
    s.setIcon('◷', 'running');
    ide.proc.attach(id, {
      data: (text, stream) => view.log(text, stream === 'err' ? 'err' : null),
      async exit(code) {
        clearInterval(timer);
        await poll(true);
        view.log(`\n${tr('Process finished with exit code {code}', { code: code ?? 1 })}\n`, 'sys');
        const c = view.finish();
        for (const r of view.results()) {
          if (r.status === 'passed' || r.status === 'failed' || r.status === 'error') lastResults.set(r.id, r.status === 'passed' ? 'passed' : 'failed');
        }
        run.refreshGutter();
        if (s.procId === id) s.setIcon(c.failed ? '✗' : '✓', c.failed ? 'failed' : 'passed');
        s.exited(id);
      },
    });
  }

  // ---------- gutter, actions, tree ----------
  run.registerGutterProvider((model, path) => {
    if (!isTestFileName(basename(path))) return [];
    return testsIn(model.getLinesContent()).map((item) => {
      const id = nodeIdFor(path, item);
      let state = lastResults.get(id);
      if (item.kind === 'class') {
        const kids = [...lastResults].filter(([k]) => k.startsWith(`${id}::`)).map(([, v]) => v);
        state = kids.includes('failed') ? 'failed' : kids.length ? 'passed' : undefined;
      }
      return { line: item.line, title: titleFor(path, item), state, config: () => configFor(path, item) };
    });
  });

  function caretTest() {
    const tab = ide.activeTab();
    if (tab?.kind !== 'file' || !isTestFileName(basename(tab.path))) return null;
    const pos = ide.editor.getPosition();
    return { path: tab.path, item: pos ? contextAt(tab.model, pos.lineNumber) : null };
  }

  // Registered after the run feature's Ctrl+Shift+F10, so it wins inside test files and falls back elsewhere.
  ide.registerAction({
    id: 'RunTestAtCaret', title: tr('Run Test at Caret'), keys: 'Ctrl+Shift+F10',
    when: () => !!caretTest(),
    run: () => {
      const ctx = caretTest();
      if (ctx) run.runContext(configFor(ctx.path, ctx.item));
    },
  });
  ide.registerAction({ id: 'RerunFailedTests', title: tr('Rerun Failed Tests'), run: () => {
    const s = run.activeSession();
    s?.extraActions.find((a) => a.id === 'rerunFailed')?.run();
  } });
  ide.registerTreeAction({
    title: tr("Run 'pytest in …'"),
    hint: 'Ctrl+Shift+F10',
    when: (e) => e.dir || isTestFileName(e.name),
    run: (e) => run.runContext({ type: 'pytest', name: tr('pytest in {name}', { name: e.name }), target: samePath(e.path, ide.root) ? '.' : relPosix(e.path) }),
  });

  // ---------- auto-test ----------
  // PyCharm's Toggle Auto-test: per test tab, off by default and not kept across restarts. While it is on, saving a
  // .py file in the project runs that tab's last tests again, autoTestDelay ms after the last save. A run in progress
  // is stopped first and one run follows; saves during that wait fold into it, so runs never overlap or pile up.
  const AUTO_TEST_DELAY = 1000;
  const autoTestDelay = () => Math.max(100, Number(ide.settings.get('tests.autoTestDelay', AUTO_TEST_DELAY)) || AUTO_TEST_DELAY);
  let debugActive = false;
  ide.on('debugSessionChanged', (active) => { debugActive = active; });
  let autoStarting = 0; // auto-test runs being set up; their own Save All before the run is not a new change

  function autoTestAction(s) {
    return {
      id: 'autoTest', icon: '↻',
      get title() { return tr('Toggle Auto-test'); },
      get toggled() { return !!s.autoTest; },
      run: () => setAutoTest(s, !s.autoTest),
    };
  }

  function setAutoTest(s, on) {
    s.autoTest = !!on && !s.closed;
    clearTimeout(s.autoTestTimer);
    if (!s.autoTestBadge) {
      s.autoTestBadge = el('span', 'run-tab-autotest hidden', tr('Auto-test'));
      s.tab.insertBefore(s.autoTestBadge, s.tab.querySelector('.run-tab-close'));
    }
    s.autoTestBadge.classList.toggle('hidden', !s.autoTest);
    s.tab.classList.toggle('auto-test', s.autoTest);
    s.setActions(s.extraActions); // redraw the toolbar's toggle state
  }

  async function autoRun(s) {
    if (s.autoTestBusy) { s.autoTestAgain = true; return; }
    s.autoTestBusy = true;
    try {
      do {
        s.autoTestAgain = false;
        while (s.starting) await s.starting;
        if (s.running) {
          // Stop the current run and wait for its process to end (the timeout covers a process that never reports).
          const ended = new Promise((resolve) => { s.exitHooks.push(resolve); setTimeout(resolve, 15000); });
          s.stop();
          await ended;
        }
        if (!s.autoTest || s.closed || debugActive || ide.trusted === false || !run.sessions().includes(s)) return;
        // Keep the keyboard where the user is typing (showing the Run window may focus a field in it).
        const focused = document.activeElement;
        autoStarting++;
        try {
          await run.runConfig(s.cfg, { targets: s.autoTestLast?.targets, executor: s.autoTestLast?.executor || undefined });
        } finally { autoStarting--; }
        if (focused && focused !== document.activeElement && document.contains(focused)) focused.focus();
      } while (s.autoTestAgain && s.autoTest && !s.closed);
    } finally { s.autoTestBusy = false; }
  }

  // Run tabs survive a project switch, but auto-test belongs to the project it was turned on in: another project's
  // save must not re-run the old configuration against the new root.
  const autoTestOffAll = () => {
    for (const s of run.sessions()) {
      clearTimeout(s.autoTestTimer);
      s.autoTestAgain = false;
      if (s.autoTest) setAutoTest(s, false);
    }
  };
  ide.on('projectOpened', autoTestOffAll);
  ide.on('projectClosed', autoTestOffAll);

  ide.on('fileSaved', (tab) => {
    if (ide.trusted === false) return;
    if (autoStarting || debugActive || !tab?.path || !/\.pyw?$/i.test(tab.path) || !ide.root || !ide.util.isUnder(tab.path, ide.root)) return;
    for (const s of run.sessions()) {
      if (!s.autoTest || s.closed || s.cfg?.type !== 'pytest') continue;
      clearTimeout(s.autoTestTimer);
      s.autoTestTimer = setTimeout(() => autoRun(s), autoTestDelay());
    }
  });

  const testSession = () => {
    const s = run.activeSession();
    return s?.cfg?.type === 'pytest' ? s : null;
  };
  ide.registerAction({ id: 'ToggleAutoTest', title: tr('Toggle Auto-test'), run: () => {
    const s = testSession();
    if (s) setAutoTest(s, !s.autoTest);
  } });

  (ide.settingsPages ||= []).push({
    id: 'python-tests', title: () => tr('Python Integrated Tools'), defaults: { 'tests.autoTestDelay': AUTO_TEST_DELAY },
    keywords: 'testing pytest unittest auto-test autotest delay 테스트 자동 테스트 지연',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Testing'));
      s.appendChild(ctx.ui.fieldRow(tr('Auto-test delay (ms):'), ctx.ui.numberInput('tests.autoTestDelay', { min: 100, max: 60000, fallback: AUTO_TEST_DELAY })));
      s.appendChild(el('div', 'muted settings-note', tr('With Toggle Auto-test on in a test tab, saving a Python file in the project runs its tests again after this delay.')));
    },
  });

  ide.on('fileSaved', () => classLines.clear());
  ide.tests = {
    isTestFileName, testsIn, contextAt, configFor,
    // Auto-test of a test session (default: the active Run tab).
    autoTest: {
      enabled: (s = testSession()) => !!s?.autoTest,
      set: (on, s = testSession()) => { if (s) setAutoTest(s, on); },
    },
  };
})();
