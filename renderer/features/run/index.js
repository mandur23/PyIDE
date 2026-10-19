// Run configurations, the run widget, gutter run icons, and the Run tool window with one tab per configuration.
// Other features plug in through ide.run (configuration types, gutter providers, sessions).
(() => {
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const CURRENT = '__current';
  const MAX_TEMPORARY = 5;
  const types = new Map();
  const gutterProviders = [];

  // ---------- helpers ----------
  const isAbs = (p) => /^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(p);
  const resolvePath = (p) => {
    p = (p || '').trim().replace(/\//g, '\\');
    if (!p) return '';
    return isAbs(p) || !ide.root ? p : joinPath(ide.root, p.replace(/^\.[\\/]/, ''));
  };
  // Shell-like split: whitespace separates, quotes group, quotes are removed.
  const parseArgs = (s) => {
    const out = [];
    let cur = null;
    let quote = null;
    for (const ch of s || '') {
      if (quote) {
        if (ch === quote) quote = null; else cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur ??= '';
      } else if (/\s/.test(ch)) {
        if (cur !== null) out.push(cur);
        cur = null;
      } else cur = (cur ?? '') + ch;
    }
    if (cur !== null) out.push(cur);
    return out;
  };
  // PyCharm's one-line form: NAME=value;OTHER=value
  const parseEnv = (s) => {
    const env = {};
    for (const part of (s || '').split(/[;\n]/)) {
      const i = part.indexOf('=');
      if (i > 0) env[part.slice(0, i).trim()] = part.slice(i + 1);
    }
    return env;
  };
  const newId = () => `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const quoteArg = (a) => (/\s/.test(a) ? `"${a}"` : a);

  function interpFor(cfg) {
    if (cfg?.interp) {
      return ide.interps.find((i) => samePath(i.executable, cfg.interp))
        || { cmd: cfg.interp, args: [], executable: cfg.interp, label: cfg.interp };
    }
    return ide.currentInterp();
  }

  // ---------- configurations (per project, in ide.settings) ----------
  let state = { configs: [], selected: CURRENT };
  const storeKey = () => `runConfigs:${ide.root}`;
  const persist = () => {
    if (ide.root) ide.settings.set(storeKey(), JSON.parse(JSON.stringify(state)));
    renderTarget();
  };
  const findConfig = (id) => state.configs.find((c) => c.id === id) || null;
  const selectedConfig = () => findConfig(state.selected);

  function select(id) {
    state.selected = findConfig(id) ? id : CURRENT;
    persist();
  }

  // Adds a temporary configuration (or reuses the matching one), selects it, and returns it, like PyCharm does
  // when you run something from the editor or the project tree.
  function addTemporary(cfg) {
    const type = types.get(cfg.type);
    const key = type?.identity?.(cfg);
    let existing = state.configs.find((c) => c.type === cfg.type && type?.identity?.(c) === key);
    if (!existing) {
      existing = { ...type.defaults(), ...cfg, id: newId(), temporary: true };
      state.configs.push(existing);
      const temps = state.configs.filter((c) => c.temporary);
      for (const old of temps.slice(0, Math.max(0, temps.length - MAX_TEMPORARY))) {
        state.configs.splice(state.configs.indexOf(old), 1);
      }
    }
    state.selected = existing.id;
    persist();
    return existing;
  }

  // Types registered later are more specific (pytest before the plain Python script).
  function contextConfigForFile(path) {
    for (const t of [...types.values()].reverse()) {
      const cfg = t.forFile?.(path);
      if (cfg) return cfg;
    }
    return null;
  }

  // ---------- Run tool window: one session (tab) per configuration ----------
  const sessions = [];
  let activeSession = null;
  let tabBar;
  let bodies;
  let emptyNote;

  const tw = ide.registerToolWindow({
    id: 'Run', title: tr('Run'), icon: '▶', side: 'bottom', keys: 'Alt+4', order: 10,
    mount(container) {
      container.classList.add('run-tool');
      tabBar = el('div', 'run-tabs hidden');
      bodies = el('div', 'run-bodies');
      emptyNote = el('div', 'run-empty muted', tr('Nothing to show. Run a configuration with Shift+F10.'));
      bodies.appendChild(emptyNote);
      container.append(tabBar, bodies);
    },
  });

  function syncIds() {
    for (const id of ['runOut', 'runIn']) document.getElementById(id)?.removeAttribute('id');
    if (activeSession?.con) {
      activeSession.con.out.id = 'runOut';
      if (activeSession.con.input) activeSession.con.input.id = 'runIn';
    }
  }

  // A session is stoppable while its process runs and while a run is still starting there.
  const busy = (s) => s.running || !!s.starting;

  function renderActions() {
    const s = activeSession;
    if (!s) return tw.setActions([]);
    tw.setActions([
      { icon: '⟳', title: tr("Rerun '{name}'", { name: s.title }), run: () => runConfig(s.cfg) },
      ...(busy(s) ? [{ icon: '■', title: tr('Stop'), run: () => s.stop() }] : []),
      ...s.extraActions,
      ...(s.con ? [{ icon: '⌫', title: tr('Clear All'), run: () => s.con.clear() }] : []),
    ]);
  }

  function selectSession(s) {
    activeSession = s;
    for (const o of sessions) {
      o.host.classList.toggle('hidden', o !== s);
      o.tab.classList.toggle('active', o === s);
    }
    emptyNote.classList.toggle('hidden', !!s);
    tabBar.classList.toggle('hidden', !sessions.length);
    syncIds();
    renderActions();
  }

  function closeSession(s) {
    s.closed = true;
    s.stop();
    s.dispose?.();
    sessions.splice(sessions.indexOf(s), 1);
    s.tab.remove();
    s.host.remove();
    if (activeSession === s) selectSession(sessions[sessions.length - 1] || null);
    else tabBar.classList.toggle('hidden', !sessions.length);
    updateToolbar();
  }

  function createSession(cfg) {
    const s = {
      key: cfg.id, cfg, title: cfg.name, running: false, procId: null, con: null, extraActions: [], dispose: null,
      // starting: a promise while a run is being set up (its process may exist before started() gets its id).
      starting: null, cancelStart: false, closed: false,
      host: el('div', 'run-session hidden'),
      tab: el('div', 'run-tab'),
      // A console in the session (or in `parent`); typed lines go to the running process's stdin.
      console({ parent, input = false, placeholder = '' } = {}) {
        const con = ide.ui.console(parent || s.host, {
          input, placeholder,
          onInput(text) {
            if (!s.running) return;
            con.append(`${text}\n`, 'cmd');
            ide.proc.input(s.procId, `${text}\n`);
          },
        });
        if (con.input) con.input.disabled = true;
        s.con = con;
        if (activeSession === s) { syncIds(); renderActions(); }
        return con;
      },
      started(id) {
        s.procId = id;
        s.running = true;
        // Stop (or closing the tab) was asked for before the process id arrived.
        if (s.cancelStart || s.closed) { s.cancelStart = false; ide.proc.kill(id); }
        s.setIcon('▶', 'running');
        if (s.con?.input) { s.con.input.disabled = false; s.con.input.focus(); }
        updateToolbar();
        if (activeSession === s) renderActions();
      },
      exited(id) {
        if (s.procId !== id) return;
        s.running = false;
        if (s.con?.input) s.con.input.disabled = true;
        updateToolbar();
        if (activeSession === s) renderActions();
      },
      // Streams a process into the session console and prints PyCharm's exit line.
      attach(id, { onExit } = {}) {
        s.started(id);
        ide.proc.attach(id, {
          data: (text, stream) => s.con?.append(text, stream === 'err' ? 'err' : null),
          exit(code) {
            s.con?.append(`\n${tr('Process finished with exit code {code}', { code: code ?? 1 })}\n`, 'sys');
            if (s.procId === id) s.setIcon('▶', code === 0 ? 'done' : 'failed');
            onExit?.(code);
            s.exited(id);
          },
        });
      },
      stop() {
        if (s.running) ide.proc.kill(s.procId);
        else if (s.starting) s.cancelStart = true;
      },
      setIcon(icon, cls) {
        const i = s.tab.querySelector('.run-tab-icon');
        i.textContent = icon;
        i.className = `run-tab-icon ${cls || ''}`;
      },
      setActions(list) { s.extraActions = list; if (activeSession === s) renderActions(); },
      select: () => selectSession(s),
    };
    const tabTitle = el('span', 'run-tab-title', cfg.name);
    tabTitle.dataset.userText = '';
    s.tab.append(el('span', 'run-tab-icon', types.get(cfg.type)?.icon || '▶'), tabTitle);
    const close = el('button', 'run-tab-close', '×');
    close.title = tr('Close');
    close.onclick = (e) => { e.stopPropagation(); closeSession(s); };
    s.tab.appendChild(close);
    s.tab.onclick = () => selectSession(s);
    s.tab.onauxclick = (e) => e.button === 1 && closeSession(s);
    tabBar.appendChild(s.tab);
    bodies.appendChild(s.host);
    sessions.push(s);
    return s;
  }

  // Reuses the configuration's tab (stopping what runs there), like PyCharm without "Allow multiple instances".
  // A run still starting in the tab is waited out first, so its process is stopped here instead of being orphaned
  // (two quick Shift+F10 presses would otherwise both spawn, and the first could no longer be stopped).
  async function prepareSession(cfg) {
    let s;
    while ((s = sessions.find((o) => o.key === cfg.id))?.starting) await s.starting;
    if (s) {
      if (s.running) { const old = s.procId; s.procId = null; s.running = false; ide.proc.kill(old); }
      s.dispose?.();
      s.dispose = null;
      s.extraActions = [];
      s.con = null;
      s.cfg = cfg;
      s.title = cfg.name;
      s.tab.querySelector('.run-tab-title').textContent = cfg.name;
      s.setIcon(types.get(cfg.type)?.icon || '▶');
      s.host.replaceChildren();
    } else s = createSession(cfg);
    s.cancelStart = false;
    let done;
    s.starting = new Promise((r) => (done = r));
    s.startDone = () => { s.starting = null; done(); updateToolbar(); if (activeSession === s) renderActions(); };
    updateToolbar();
    selectSession(s);
    return s;
  }

  let lastRun = null;
  // opts are passed through to the type (e.g. {targets} for rerunning failed tests).
  async function runConfig(cfg, opts = {}) {
    const type = types.get(cfg?.type);
    if (!type) return;
    lastRun = cfg;
    tw.show();
    await ide.saveAll();
    const s = await prepareSession(cfg);
    try {
      const interp = interpFor(cfg);
      if (!interp) return s.console().append(`${tr('No Python interpreter found.')}\n`, 'err');
      await type.start(cfg, s, interp, opts);
    } catch (err) {
      (s.con || s.console()).append(`${err.message}\n`, 'err');
      s.running = false;
      updateToolbar();
    } finally {
      s.startDone();
    }
    return s;
  }

  // ---------- built-in type: Python script ----------
  types.set('python', {
    type: 'python', title: 'Python', icon: '🐍',
    fields: [
      { key: 'script', label: tr('Script path'), placeholder: tr('path\\to\\script.py'), browse: true },
      { key: 'params', label: tr('Script parameters') },
      { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the script folder') },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
    ],
    defaults: () => ({ script: '', params: '', cwd: '', env: '', interp: '' }),
    identity: (c) => resolvePath(c.script).toLowerCase(),
    file: (c) => resolvePath(c.script),
    forFile: (path) => ({ type: 'python', name: basename(path).replace(/\.pyw?$/, ''), script: path }),
    async start(cfg, s, interp) {
      const con = s.console({ input: true, placeholder: tr('stdin: type input and press Enter') });
      const script = resolvePath(cfg.script);
      if (!script) return con.append(`${tr('Script path is not specified. Edit the configuration first.')}\n`, 'err');
      const cwd = resolvePath(cfg.cwd) || dirname(script);
      const params = parseArgs(cfg.params);
      con.append(`${[interp.cmd, ...interp.args].map(quoteArg).join(' ')} ${quoteArg(script)}${params.length ? ` ${params.map(quoteArg).join(' ')}` : ''}\n`, 'sys');
      const id = await ide.api.invoke('run:start', interp, script, cwd, params, parseEnv(cfg.env), ide.root ? [ide.root] : []);
      s.attach(id);
    },
  });

  // ---------- run widget (toolbar) ----------
  const runBtn = el('button', 'tb-icon run-btn', '▶');
  runBtn.title = tr('Run (Shift+F10)');
  let debugActive = false; // a debugger session is active (see 'debugSessionChanged')
  const stopBtn = el('button', 'tb-icon stop-btn', '■');
  stopBtn.title = tr('Stop (Ctrl+F2)');
  stopBtn.disabled = true;
  const target = el('button', 'run-target');
  target.title = tr('Run/Debug Configurations');
  ide.registerToolbarItem({ order: 60, el: target });
  ide.registerToolbarItem({ order: 70, el: runBtn });
  ide.registerToolbarItem({ order: 90, el: stopBtn });

  function renderTarget() {
    const cfg = selectedConfig();
    const name = el('span', 'run-target-name', cfg ? cfg.name : tr('Current File'));
    if (cfg) name.dataset.userText = '';
    target.replaceChildren(
      el('span', 'run-target-icon' + (cfg?.temporary ? ' temporary' : ''), cfg ? types.get(cfg.type)?.icon || '▶' : '📄'),
      name,
      el('span', 'run-target-arrow', '▾'),
    );
  }

  function updateToolbar() {
    stopBtn.disabled = !sessions.some(busy) && !debugActive;
  }
  // The toolbar Stop button also stops a debug session (the debugger owns that process).
  ide.on('debugSessionChanged', (active) => { debugActive = active; updateToolbar(); });

  target.onclick = () => {
    const r = target.getBoundingClientRect();
    const cfg = selectedConfig();
    const sorted = [...state.configs.filter((c) => !c.temporary), ...state.configs.filter((c) => c.temporary)];
    ide.ui.contextMenu(r.left, r.bottom + 2, [
      ...sorted.map((c) => ({
        label: `${types.get(c.type)?.icon || '▶'}  ${c.name}`, hint: c.id === state.selected ? '✓' : '', run: () => select(c.id),
      })),
      ...(sorted.length ? [{ separator: true }] : []),
      { label: `📄  ${tr('Current File')}`, hint: state.selected === CURRENT ? '✓' : '', run: () => select(CURRENT) },
      { separator: true },
      ...(cfg?.temporary ? [{ label: tr("Save '{name}' Configuration", { name: cfg.name }), run: () => { cfg.temporary = false; persist(); } }] : []),
      { label: tr('Edit Configurations…'), run: () => editConfigurations() },
    ]);
  };

  // ---------- run actions ----------
  function currentPyFile() {
    const tab = ide.activeTab();
    return tab?.kind === 'file' && /\.pyw?$/i.test(tab.path) ? tab.path : null;
  }

  function runCurrentFile() {
    const file = currentPyFile();
    if (file) {
      const cfg = contextConfigForFile(file);
      return runConfig({ ...types.get(cfg.type).defaults(), ...cfg, id: `file:${file.toLowerCase()}` });
    }
    if (lastRun) return runConfig(lastRun);
    ide.ui.dialog({ title: tr('Run'), body: tr('Open a Python file to run it, or select a run configuration.') });
  }

  function runSelected() {
    const cfg = selectedConfig();
    return cfg ? runConfig(cfg) : runCurrentFile();
  }

  // Ctrl+Shift+F10 / project tree / gutter: run a context configuration, saved as a temporary one.
  function runContext(cfg) {
    return runConfig(addTemporary(cfg));
  }

  // The debugger debugs the active file; 'DebugCurrent' is the contract name, 'Debug' is PyCharm's action id.
  const debugActionId = () => ['DebugCurrent', 'Debug'].find((id) => ide.actions.some((a) => a.id === id));
  const canDebug = (cfg) => !!debugActionId() && (!cfg || cfg.type === 'python');
  function debugConfig(cfg) {
    if (cfg.type === 'python' && ide.debugger?.debugFile) {
      // Debug with the configuration's interpreter, working directory, parameters and environment.
      const r = ide.run.resolvePython(cfg);
      return ide.debugger.debugFile(r.script, { interp: r.interp, cwd: r.cwd, params: r.params, env: r.env });
    }
    const file = types.get(cfg.type)?.file?.(cfg);
    const go = () => ide.runAction(debugActionId());
    if (file) ide.openFile(file).then(go); else go();
  }

  async function chooseConfiguration(debug) {
    const items = [
      ...state.configs.map((c) => ({ label: c.name, detail: types.get(c.type)?.title, icon: types.get(c.type)?.icon, value: { cfg: c } })),
      { label: tr('Current File'), icon: '📄', value: { current: true } },
      { label: tr('Edit Configurations…'), icon: '⚙', value: { edit: true } },
    ];
    const choice = await ide.ui.pick({ placeholder: debug ? tr('Debug') : tr('Run'), items });
    if (!choice) return;
    if (choice.edit) return editConfigurations();
    if (choice.current) {
      select(CURRENT);
      if (!debug) return runCurrentFile();
      return canDebug() ? ide.runAction(debugActionId()) : ide.ui.dialog({ title: tr('Debug'), body: tr('No debugger is available.') });
    }
    select(choice.cfg.id);
    if (!debug) return runConfig(choice.cfg);
    if (canDebug(choice.cfg)) return debugConfig(choice.cfg);
    ide.ui.dialog({ title: tr('Debug'), body: canDebug() ? tr("Debugging '{name}' is not supported yet; it can be run.", { name: choice.cfg.name }) : tr('No debugger is available.') });
  }

  function stop() {
    if (activeSession && busy(activeSession)) return activeSession.stop();
    const running = sessions.filter(busy);
    if (!running.length && debugActive) return ide.runAction('StopDebug');
    if (running.length === 1) return running[0].stop();
    if (running.length > 1) {
      ide.ui.pick({ placeholder: tr('Stop process'), items: running.map((s) => ({ label: s.title, icon: '■', value: s })) })
        .then((s) => s?.stop());
    }
  }

  runBtn.onclick = runSelected;
  stopBtn.onclick = stop;
  ide.registerAction({ id: 'Run', title: tr('Run'), keys: 'Shift+F10', run: runSelected });
  ide.registerAction({ id: 'RunClass', title: tr('Run Context Configuration'), keys: 'Ctrl+Shift+F10', run: () => {
    const file = currentPyFile();
    if (file) runContext(contextConfigForFile(file));
  } });
  ide.registerAction({ id: 'Stop', title: tr('Stop'), keys: 'Ctrl+F2', run: stop });
  ide.registerAction({ id: 'ChooseRunConfiguration', title: tr('Run…'), keys: 'Alt+Shift+F10', run: () => chooseConfiguration(false) });
  ide.registerAction({ id: 'ChooseDebugConfiguration', title: tr('Debug…'), keys: 'Alt+Shift+F9', run: () => chooseConfiguration(true) });
  ide.registerAction({ id: 'editRunConfigurations', title: tr('Edit Configurations…'), run: () => editConfigurations() });
  ide.registerAction({ id: 'Rerun', title: tr('Rerun'), run: () => activeSession && runConfig(activeSession.cfg) });
  ide.registerTreeAction({
    title: tr("Run '…'"),
    hint: 'Ctrl+Shift+F10',
    when: (e) => !e.dir && /\.pyw?$/i.test(e.name) && contextConfigForFile(e.path)?.type === 'python',
    run: (e) => runContext(contextConfigForFile(e.path)),
  });

  // ---------- Edit Configurations dialog ----------
  function editConfigurations(focusId = state.selected) {
    const draft = JSON.parse(JSON.stringify(state.configs));
    let current = draft.find((c) => c.id === focusId) || draft[0] || null;
    const body = el('div', 'rc-dialog');
    const left = el('div', 'rc-left');
    const bar = el('div', 'rc-bar');
    const list = el('div', 'rc-list');
    const form = el('div', 'rc-form');
    left.append(bar, list);
    body.append(left, form);

    const tool = (id, icon, title, run) => {
      const b = el('button', 'rc-tool', icon);
      b.dataset.tool = id;
      b.title = title;
      b.onclick = run;
      bar.appendChild(b);
      return b;
    };
    tool('add', '＋', tr('Add New Configuration'), (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      ide.ui.contextMenu(r.left, r.bottom + 2, [...types.values()].map((t) => ({
        label: `${t.icon}  ${t.title}`,
        run() {
          const cfg = { ...t.defaults(), id: newId(), type: t.type, name: tr('Unnamed') };
          const file = currentPyFile();
          if (file && t.forFile) Object.assign(cfg, t.forFile(file) || {}, { type: t.type, name: tr('Unnamed') });
          draft.push(cfg);
          current = cfg;
          render();
          form.querySelector('input')?.select();
        },
      })));
      // Core menus sit below dialogs; this one opens from a dialog.
      const menu = document.querySelector('#menuHost .context-menu');
      if (menu) menu.style.zIndex = 80;
    });
    tool('remove', '−', tr('Remove Configuration'), () => {
      if (!current) return;
      const i = draft.indexOf(current);
      draft.splice(i, 1);
      current = draft[Math.min(i, draft.length - 1)] || null;
      render();
    });
    tool('copy', '⧉', tr('Copy Configuration'), () => {
      if (!current) return;
      const copy = { ...JSON.parse(JSON.stringify(current)), id: newId(), name: `${current.name} (1)`, temporary: false };
      draft.splice(draft.indexOf(current) + 1, 0, copy);
      current = copy;
      render();
    });

    function renderList() {
      list.replaceChildren();
      for (const t of types.values()) {
        const group = draft.filter((c) => c.type === t.type);
        if (!group.length) continue;
        list.appendChild(el('div', 'rc-group', `${t.icon}  ${t.title}`));
        for (const c of group) {
          const row = el('div', 'rc-item' + (c === current ? ' selected' : '') + (c.temporary ? ' temporary' : ''), c.name || tr('Unnamed'));
          row.dataset.userText = '';
          row.onclick = () => { current = c; render(); };
          list.appendChild(row);
        }
      }
      if (!draft.length) list.appendChild(el('div', 'rc-none muted', tr('No run configurations added. Click ＋ to add one.')));
    }

    function field(label, input) {
      const f = el('label', 'field');
      f.append(el('span', null, label), input);
      form.appendChild(f);
    }

    function renderForm() {
      form.replaceChildren();
      if (!current) return form.appendChild(el('div', 'muted', tr('Select a configuration or add a new one.')));
      const t = types.get(current.type);
      const name = el('input');
      name.dataset.key = 'name';
      name.value = current.name;
      name.oninput = () => { current.name = name.value; renderList(); };
      field(tr('Name:'), name);
      if (current.temporary) {
        const keep = el('label', 'rc-keep');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = false;
        cb.dataset.key = 'save';
        cb.onchange = () => { current.temporary = !cb.checked; renderList(); };
        keep.append(cb, el('span', null, ` ${tr('Save configuration (it is temporary now)')}`));
        form.appendChild(keep);
      }
      form.appendChild(el('div', 'rc-type muted', `${t.icon} ${t.title}`));
      for (const fd of t.fields) {
        let input;
        if (fd.kind === 'interp') {
          input = el('select');
          input.add(new Option(tr('Project Default ({interp})', { interp: ide.currentInterp()?.label || tr('none') }), ''));
          for (const it of ide.interps) input.add(new Option(it.label, it.executable));
          if (current[fd.key] && !ide.interps.some((i) => samePath(i.executable, current[fd.key]))) input.add(new Option(current[fd.key], current[fd.key]));
          input.value = current[fd.key] || '';
          input.onchange = () => (current[fd.key] = input.value);
        } else {
          input = el('input');
          input.value = current[fd.key] || '';
          input.placeholder = fd.placeholder || '';
          input.oninput = () => (current[fd.key] = input.value);
        }
        input.dataset.key = fd.key;
        if (fd.browse) {
          const wrap = el('span', 'rc-browse');
          const b = el('button', 'secondary', '…');
          b.title = tr('Browse');
          b.onclick = async (e) => {
            e.preventDefault();
            const p = await ide.api.openFileDialog([{ name: 'Python', extensions: ['py', 'pyw'] }]);
            if (p) { input.value = p; current[fd.key] = p; }
          };
          wrap.append(input, b);
          field(`${fd.label}:`, wrap);
        } else field(`${fd.label}:`, input);
      }
    }

    function render() { renderList(); renderForm(); }
    render();

    ide.ui.dialog({
      title: tr('Run/Debug Configurations'),
      body,
      width: 780,
      buttons: [
        { label: tr('Cancel') },
        { label: tr('OK'), primary: true, run() {
          for (const c of draft) if (!c.name?.trim()) c.name = tr('Unnamed');
          state.configs = draft;
          state.selected = current ? current.id : findConfig(state.selected) ? state.selected : CURRENT;
          persist();
          // Open tabs keep running their old copy; a rerun picks up the edited configuration.
          for (const s of sessions) { const c = findConfig(s.key); if (c) s.cfg = c; }
        } },
      ],
    });
  }

  // ---------- gutter run icons ----------
  // Every editor (split pane or viewer-embedded) keeps its own icon decorations and line -> item map.
  const gutterEditors = new Map(); // editor -> {deco, items: Map(line -> item), timer}
  const pathOfModel = (model) => (model ? ide.tabs.find((t) => t.model === model)?.path || null : null);

  function refreshEditorGutter(ed) {
    const g = gutterEditors.get(ed);
    if (!g) return;
    const model = ed.getModel();
    const path = pathOfModel(model);
    g.items = new Map();
    if (path && /\.pyw?$/i.test(path)) {
      for (const p of gutterProviders) {
        let items = [];
        try { items = p(model, path) || []; } catch (err) { console.error('gutter provider failed', err); }
        for (const it of items) if (!g.items.has(it.line)) g.items.set(it.line, it);
      }
    }
    const lane = ide.monaco.editor.GlyphMarginLane.Right;
    g.deco.set([...g.items.values()].map((it) => ({
      range: new ide.monaco.Range(it.line, 1, it.line, 1),
      options: {
        glyphMarginClassName: `run-gutter-icon ${it.state || ''}`,
        glyphMarginHoverMessage: { value: tr("Run '{name}'", { name: it.title }) },
        glyphMargin: { position: lane },
      },
    })));
  }
  function refreshGutter() { for (const ed of gutterEditors.keys()) refreshEditorGutter(ed); }
  function scheduleGutter(ed) {
    for (const [e, g] of gutterEditors) {
      if (ed && e !== ed) continue;
      clearTimeout(g.timer);
      g.timer = setTimeout(() => refreshEditorGutter(e), 250);
    }
  }

  function showGutterMenu(ed, item, x, y) {
    const cfg = () => item.config();
    ide.ui.contextMenu(x, y, [
      { label: `▶  ${tr("Run '{name}'", { name: item.title })}`, hint: 'Ctrl+Shift+F10', run: () => runContext(cfg()) },
      ...(canDebug(cfg()) ? [{ label: `🐞  ${tr("Debug '{name}'", { name: item.title })}`, run: () => {
        ed.setPosition({ lineNumber: item.line, column: 1 });
        debugConfig(addTemporary(cfg()));
      } }] : []),
      { separator: true },
      { label: tr('Modify Run Configuration…'), run: () => editConfigurations(addTemporary(cfg()).id) },
    ]);
  }

  // The icon shares the glyph margin with breakpoints; intercepting the press on the editor's container before
  // Monaco sees it keeps a click on the run icon from also toggling a breakpoint.
  const iconAt = (e) => e.button === 0 && e.target.closest?.('.run-gutter-icon');
  ide.onEditor((ed) => {
    const g = { deco: ed.createDecorationsCollection(), items: new Map(), timer: null };
    gutterEditors.set(ed, g);
    const dom = ed.getContainerDomNode();
    for (const type of ['pointerdown', 'mousedown']) {
      dom.addEventListener(type, (e) => {
        if (!iconAt(e)) return;
        e.stopPropagation();
        // Cancelling pointerdown would suppress the mousedown that opens the menu.
        if (type !== 'mousedown') return;
        e.preventDefault();
        const pos = ed.getTargetAtClientPoint(e.clientX, e.clientY)?.position;
        const item = pos && g.items.get(pos.lineNumber);
        if (item) showGutterMenu(ed, item, e.clientX, e.clientY);
      }, true);
    }
    for (const type of ['pointerup', 'mouseup', 'click']) dom.addEventListener(type, (e) => iconAt(e) && e.stopPropagation(), true);
    ed.onDidChangeModel(() => refreshEditorGutter(ed));
    ed.onDidChangeModelContent(() => scheduleGutter(ed));
    ed.onDidDispose(() => { clearTimeout(g.timer); gutterEditors.delete(ed); });
    refreshEditorGutter(ed);
  });
  // A tab can become a .py file (rename) or a first tab can appear for a model without the editor's model changing.
  ide.on('activeTabChanged', refreshGutter);

  ide.on('projectOpened', () => {
    const saved = ide.settings.get(storeKey(), null);
    state = saved ? JSON.parse(JSON.stringify(saved)) : { configs: [], selected: CURRENT };
    if (!findConfig(state.selected)) state.selected = CURRENT;
    renderTarget();
  });
  renderTarget();

  // __main__ blocks get a run icon, like PyCharm.
  gutterProviders.push((model, path) => {
    const items = [];
    const lines = model.getLinesContent();
    lines.forEach((text, i) => {
      if (/^if\s+__name__\s*==\s*(['"])__main__\1\s*:/.test(text)) {
        items.push({ line: i + 1, title: basename(path).replace(/\.pyw?$/, ''), config: () => types.get('python').forFile(path) });
      }
    });
    return items;
  });

  ide.run = {
    // type: {type, title, icon, fields, defaults(), identity(cfg), file(cfg), forFile?(path), start(cfg, session, interp, opts)}
    registerType: (t) => types.set(t.type, t),
    types,
    configs: () => state.configs,
    selected: selectedConfig,
    select,
    addTemporary,
    runConfig,
    runContext,
    runCurrentFile,
    editConfigurations,
    sessions: () => sessions,
    activeSession: () => activeSession,
    // fn(model, path) -> [{line, title, state?: 'passed'|'failed', config() -> cfg}]
    registerGutterProvider: (fn) => { gutterProviders.push(fn); scheduleGutter(); },
    refreshGutter,
    interpFor,
    // A Python configuration resolved to what a launcher needs (e.g. for a debugger).
    resolvePython: (cfg) => {
      const script = resolvePath(cfg.script);
      return { script, cwd: resolvePath(cfg.cwd) || dirname(script), params: parseArgs(cfg.params), env: parseEnv(cfg.env), interp: interpFor(cfg) };
    },
    resolvePath,
    parseArgs,
    parseEnv,
  };
})();
