// Run Anything (PyCharm's action RunAnything, Double Ctrl): one popup that runs a run configuration, a Python file
// (`python app.py args`), `python -m …` / `python -c …`, `pytest …` (both in the Run tool window through ide.run, with
// the project interpreter), and anything else (`pip install x`, `git status`, `echo hi`) in a new Terminal session in
// the project folder, whose venv is on PATH. Holding Shift (Shift+Enter) debugs instead where that is possible.
// Commands typed here are remembered per project (`runAnything.history:<project>`, never exported: a per-project key)
// and suggested as you type together with configurations and the project's Python files. In Safe Mode nothing runs:
// Run Anything asks to trust the project first (core's Trust Project, which reopens the page) and offers the command
// again afterwards.
(() => {
  const { el, basename } = ide.util;
  const run = ide.run;
  const HISTORY_MAX = 50;
  const PENDING = 'runAnything.pending';
  const historyKey = () => `runAnything.history:${ide.root}`;
  const history = () => (ide.root ? ide.settings.get(historyKey(), []).filter((c) => typeof c === 'string' && c) : []);
  const remember = (cmd) => { if (ide.root) ide.settings.set(historyKey(), [cmd, ...history().filter((c) => c !== cmd)].slice(0, HISTORY_MAX)); };
  const forget = (cmd) => { if (ide.root) ide.settings.set(historyKey(), history().filter((c) => c !== cmd)); };
  const quote = (a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

  // ---------- what a command line does ----------
  const PYTHON = /^(python(\d+(\.\d+)?)?|py)(\.exe)?$/i;
  // -> {kind: 'python-script' | 'python' | 'pytest' | 'terminal', argv}
  function classify(cmd) {
    const argv = run.parseArgs(cmd);
    const head = argv[0] || '';
    if (PYTHON.test(head) && argv.length > 1) return { kind: argv[1].startsWith('-') ? 'python' : 'python-script', argv };
    if (/^pytest(\.exe)?$/i.test(head)) return { kind: 'pytest', argv };
    return { kind: 'terminal', argv };
  }
  const where = (kind) => (kind === 'terminal' ? tr('Terminal') : tr('Run tool window'));

  // `python -m module …` / `python -c …`: a configuration type of its own, since the Python script type takes a file.
  run.registerType({
    type: 'pythonCommand', title: tr('Python Command'), icon: 'python',
    fields: [
      { key: 'args', label: tr('Python arguments'), placeholder: '-m http.server 8000' },
      { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the project root') },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      run.envFilesField,
      { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
    ],
    defaults: () => ({ args: '', cwd: '', env: '', envFiles: run.defaultEnvFiles, interp: '' }),
    identity: (c) => (c.args || '').trim().toLowerCase(),
    file: () => null,
    async start(cfg, s, interp) {
      const con = s.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
      const argv = run.parseArgs(cfg.args);
      if (!argv.length) return con.append(`${tr('No Python arguments given. Edit the configuration first.')}\n`, 'err');
      const cwd = run.resolvePath(cfg.cwd) || ide.root || '';
      con.append(`${[interp.cmd, ...interp.args, ...argv].map(quote).join(' ')}\n`, 'sys');
      await run.warnMissingEnvFiles(cfg, (text) => con.append(text, 'err'));
      // run:start runs `python -u <first> <rest…>`, so '-m' or '-c' goes where the script would.
      const id = await ide.api.invoke('run:start', interp, argv[0], cwd, argv.slice(1), run.parseEnv(cfg.env), ide.root ? [ide.root] : [], run.envFiles(cfg));
      s.attach(id);
    },
    // debugpy runs a module (`-m module`, debugged from Run Anything) or a file; `-c code` cannot be debugged.
    debugTarget: (cfg) => {
      const argv = run.parseArgs(cfg.args);
      return { script: argv[0] || '', params: argv.slice(1), cwd: run.resolvePath(cfg.cwd) || ide.root || '', env: run.parseEnv(cfg.env) };
    },
  });
  const debuggable = (cfg) => !!cfg && run.canDebug(cfg) && (cfg.type !== 'pythonCommand' || run.parseArgs(cfg.args)[0] === '-m');

  // The configuration a Run-tool-window command becomes (not saved; its Run tab is named after the command).
  function configFor(cmd, { kind, argv }) {
    const id = `runAnything:${cmd}`;
    if (kind === 'python-script') {
      return { ...run.types.get('python').defaults(), id, type: 'python', name: cmd, script: argv[1], params: argv.slice(2).map(quote).join(' '), cwd: ide.root || '' };
    }
    if (kind === 'pytest' && run.types.has('pytest')) {
      return { ...run.types.get('pytest').defaults(), id, type: 'pytest', name: cmd, target: '', args: argv.slice(1).map(quote).join(' ') };
    }
    const args = kind === 'pytest' ? ['-m', 'pytest', ...argv.slice(1)] : argv.slice(1);
    return { ...run.types.get('pythonCommand').defaults(), id, type: 'pythonCommand', name: cmd, args: args.map(quote).join(' ') };
  }

  // Safe Mode runs nothing from the project: ask to trust it first. Trusting reopens the page; the command comes back
  // in the popup there (it is not run without another Enter).
  function trusted(cmd) {
    if (ide.trusted !== false) return Promise.resolve(true);
    return new Promise((resolve) => {
      ide.ui.dialog({
        title: tr('Trust Project?'),
        body: el('div', 'dialog-message', tr('{name} is open in Safe Mode, where Nano Studio runs nothing from it. Run Anything starts programs and commands in the project, so trust it first.', { name: basename(ide.root || '') })),
        width: 520,
        onClose: () => resolve(false),
        buttons: [
          { label: tr('Trust Project'), primary: true, run: () => { try { sessionStorage.setItem(PENDING, cmd); } catch {} ide.trustProject?.(); } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  async function execute(cmd, { debug = false } = {}) {
    cmd = cmd.trim();
    if (!cmd || !(await trusted(cmd))) return;
    remember(cmd);
    const plan = classify(cmd);
    if (plan.kind === 'terminal') {
      if (!ide.terminal) return ide.ui.alert(tr('The Terminal plugin is disabled.'));
      return ide.terminal.open({ name: cmd.length > 40 ? `${cmd.slice(0, 39)}…` : cmd, command: cmd, cwd: ide.root || undefined });
    }
    const cfg = configFor(cmd, plan);
    if (debug && debuggable(cfg)) return run.debugConfig(cfg);
    return run.runConfig(cfg);
  }

  async function runConfiguration(cfg, debug) {
    if (!(await trusted(''))) return;
    run.select(cfg.id);
    if (!debug) return run.runConfig(cfg);
    if (run.canDebug(cfg)) return run.debugConfig(cfg);
    ide.ui.alert(tr("Debugging '{name}' is not supported yet; it can be run.", { name: cfg.name }));
  }

  // ---------- suggestions ----------
  const SKIP = /[\\/](\.?venv[^\\/]*|site-packages|__pycache__|node_modules|\.git|\.tox|build|dist)[\\/]/i;
  const relPosix = (p) => ide.util.rel(p).replace(/\\/g, '/');
  const PIP = ['pip install ', 'pip install -r requirements.txt', 'pip install -U ', 'pip uninstall ', 'pip list', 'pip freeze', 'pip show '];
  const MODULES = ['python -m pytest', 'python -m pip ', 'python -m http.server', 'python -m venv .venv', 'python -m unittest', 'python -m json.tool '];
  const score = (text, q) => {
    const t = text.toLowerCase();
    if (!q) return 1;
    if (t.startsWith(q)) return 3;
    if (t.includes(q)) return 2;
    return 0;
  };
  const best = (list, q, text, limit) => list.map((x) => [x, score(text(x), q)]).filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([x]) => x);

  function commandItem(cmd, extra = {}) {
    const plan = classify(cmd);
    return { key: `cmd:${cmd}`, label: cmd, user: true, detail: where(plan.kind), icon: plan.kind === 'terminal' ? '>_' : plan.kind === 'pytest' ? '🧪' : '🐍',
      command: cmd, run: (debug) => execute(cmd, { debug }), ...extra };
  }

  // Groups of rows for the text typed so far: [{title, items}].
  function suggest(text, files) {
    const q = text.trim();
    const ql = q.toLowerCase();
    const groups = [];
    const seen = new Set();
    const push = (title, items) => {
      const fresh = items.filter((it) => !seen.has(it.key));
      fresh.forEach((it) => seen.add(it.key));
      if (fresh.length) groups.push({ title, items: fresh });
    };
    const configs = best(run.configs(), ql, (c) => c.name, q ? 8 : 20).map((c) => ({
      key: `cfg:${c.id}`, label: c.name, user: true, detail: run.types.get(c.type)?.title || '', icon: run.types.get(c.type)?.icon || '▶',
      complete: c.name, run: (debug) => runConfiguration(c, debug),
    }));
    // Python files: `python <file>` for a name, `pytest <file>` after "pytest ".
    let fileItems = [];
    const m = /^(python|pytest)\s+(\S*)$/i.exec(q);
    const needle = !q ? null : m ? m[2].toLowerCase() : !/\s/.test(q) ? ql : null;
    if (needle !== null && files) {
      const verb = m?.[1].toLowerCase() === 'pytest' ? 'pytest' : 'python';
      fileItems = best(files.filter((f) => verb === 'python' || /(^|[\\/])(test_[^\\/]*|[^\\/]*_test)\.py$/i.test(f)), needle, relPosix, 8)
        .map((f) => commandItem(`${verb} ${quote(relPosix(f))}`, { key: `cmd:${verb} ${quote(relPosix(f))}` }));
    }
    const typedFirst = q && (/\s/.test(q) || (!configs.length && !fileItems.length));
    if (typedFirst) push(tr('Command'), [commandItem(q)]);
    // Typed text looks for configurations first; the empty popup leads with what was run last.
    const recent = best(history(), ql, (c) => c, q ? 5 : 10).map((c) => commandItem(c, { recent: true }));
    if (q) push(tr('Run Configurations'), configs);
    push(tr('Recent'), recent);
    if (!q) push(tr('Run Configurations'), configs);
    push(tr('Python Files'), fileItems);
    if (q) {
      const templates = [...PIP, ...MODULES, 'pytest', 'pytest -x', 'pytest --lf'];
      push(tr('Suggestions'), templates.filter((t) => t.toLowerCase().startsWith(ql) && t.trim() !== q).slice(0, 5)
        .map((t) => commandItem(t.trim(), { label: t, complete: t, key: `tpl:${t}` })));
    }
    if (q && !typedFirst) push(tr('Command'), [commandItem(q)]);
    return groups;
  }

  // ---------- the popup ----------
  let state = null;
  async function projectFiles() {
    if (!ide.root) return [];
    try { return (await ide.api.walk(ide.root)).filter((p) => /\.pyw?$/i.test(p) && !SKIP.test(p)).slice(0, 20000); } catch { return []; }
  }

  function open({ query = '' } = {}) {
    if (state) return;
    const prevFocus = document.activeElement;
    const backdrop = el('div', 'ra-backdrop');
    const box = el('div', 'ra-popup');
    box.id = 'runAnything';
    const head = el('div', 'ra-head');
    const title = el('span', 'ra-title', tr('Run Anything'));
    const mode = el('span', 'ra-mode hidden', tr('Debug'));
    head.append(title, mode);
    const input = el('input', 'ra-input');
    input.id = 'runAnythingInput';
    input.spellcheck = false;
    input.placeholder = tr('Run a configuration, a Python file or a command');
    const list = el('div', 'ra-list');
    list.id = 'runAnythingList';
    const foot = el('div', 'ra-foot muted', tr('Enter runs, Shift+Enter debugs, Tab completes. Commands other than python and pytest run in a new Terminal session.'));
    box.append(head, input, list, foot);
    backdrop.append(box);
    // Living in #dialogHost suspends the global keymap while the popup is open.
    document.getElementById('dialogHost').appendChild(backdrop);

    let files = null;
    let rows = [];
    let activeKey = null;
    const setMode = (debug) => { mode.classList.toggle('hidden', !debug); box.classList.toggle('debug', debug); };
    function setActive(row) {
      for (const r of rows) r.classList.toggle('active', r === row);
      activeKey = row?._item.key ?? null;
      row?.scrollIntoView({ block: 'nearest' });
    }
    function render() {
      const groups = suggest(input.value, files);
      const nodes = [];
      for (const g of groups) {
        nodes.push(el('div', 'ra-group', g.title));
        for (const it of g.items) {
          const row = el('div', 'ra-row');
          row._item = it;
          row.dataset.key = it.key;
          const label = el('span', 'ra-label', it.label);
          if (it.user) label.dataset.userText = '';
          row.append(Object.assign(ide.icon(it.icon || ''), { className: 'ide-icon ra-icon' }), label);
          if (it.detail) row.append(el('span', 'ra-detail', it.detail));
          row.onmousedown = (e) => { e.preventDefault(); choose(row, e.shiftKey); };
          row.onmousemove = () => !row.classList.contains('active') && setActive(row);
          nodes.push(row);
        }
      }
      if (!nodes.length) nodes.push(el('div', 'ra-empty muted', tr('Type a command: python app.py, pytest, pip install requests, or anything for the terminal')));
      list.replaceChildren(...nodes);
      rows = [...list.querySelectorAll('.ra-row')];
      setActive(rows.find((r) => r._item.key === activeKey) || rows[0]);
    }
    function close() {
      if (state !== me) return;
      state = null;
      backdrop.remove();
      if (prevFocus?.isConnected && prevFocus !== document.body) prevFocus.focus(); else ide.editor?.focus();
    }
    function choose(row, debug) {
      const it = row?._item;
      if (!it) return;
      close();
      it.run(debug);
    }
    input.oninput = () => { activeKey = null; render(); };
    input.onkeydown = (e) => {
      if (e.key === 'Shift') setMode(true);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!rows.length) return;
        const i = rows.findIndex((r) => r.classList.contains('active'));
        setActive(rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]);
      } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        // Tab completes the input with the selected suggestion, as in PyCharm.
        e.preventDefault();
        const it = rows.find((r) => r.classList.contains('active'))?._item;
        const text = it?.complete ?? it?.command;
        if (text) { input.value = text; activeKey = null; render(); }
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        choose(rows.find((r) => r.classList.contains('active')), e.shiftKey);
      } else if (e.key === 'Delete' && input.selectionStart === input.value.length) {
        // Delete at the end of the text removes the selected command from the history.
        const it = rows.find((r) => r.classList.contains('active'))?._item;
        if (it?.recent) { e.preventDefault(); forget(it.command); render(); }
      }
    };
    input.onkeyup = (e) => { if (e.key === 'Shift') setMode(false); };
    backdrop.onmousedown = (e) => { if (e.target === backdrop) close(); };
    input.onblur = () => setTimeout(() => !box.contains(document.activeElement) && close(), 120);

    const me = { close, input };
    state = me;
    input.value = query;
    render();
    input.focus();
    projectFiles().then((list) => { if (state !== me) return; files = list; render(); });
  }

  ide.registerAction({ id: 'RunAnything', title: tr('Run Anything'), keys: 'Ctrl Ctrl', run: () => open() });

  // After Trust Project reopened the page, the command that asked for it comes back, waiting for Enter. Looked up in
  // the next task, not while the project opens: a page's first sessionStorage access waits on the browser process
  // (~20 ms at startup).
  ide.on('projectOpened', () => setTimeout(() => {
    let pending = null;
    try { pending = sessionStorage.getItem(PENDING); sessionStorage.removeItem(PENDING); } catch {}
    if (pending !== null && ide.trusted !== false) open({ query: pending });
  }, 0));

  ide.runAnything = { open, close: () => state?.close(), isOpen: () => !!state, execute, classify, history, suggest };
})();
