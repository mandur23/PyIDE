// Run configurations, the run widget, gutter run icons, and the Run tool window with one tab per configuration.
// Other features plug in through ide.run (configuration types, gutter providers, sessions).
(() => {
  const { el, basename, dirname, joinPath, samePath } = ide.util;
  const CURRENT = '__current';
  const MAX_TEMPORARY = 5;
  const types = new Map();
  const gutterProviders = [];
  // Executors run a configuration another way (Run with Coverage, Profile) by wrapping its interpreter.
  const executors = new Map();

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
  // A configuration's .env files ("Env files", ;-separated, relative to the project root), as absolute paths.
  // Configurations saved before the field existed get the default, the project root's .env.
  const DEFAULT_ENV_FILES = '.env';
  const envFilesFor = (cfg) => (cfg?.envFiles ?? DEFAULT_ENV_FILES).split(/[;\n]/).map((p) => p.trim()).filter(Boolean).map(resolvePath);
  // Listed env files that do not exist; the default .env is optional, so it is never reported.
  async function missingEnvFiles(cfg) {
    const listed = (cfg?.envFiles ?? DEFAULT_ENV_FILES).split(/[;\n]/).map((p) => p.trim()).filter((p) => p && p !== DEFAULT_ENV_FILES);
    const exists = await Promise.all(listed.map((p) => ide.api.exists(resolvePath(p))));
    return listed.map(resolvePath).filter((_p, i) => !exists[i]);
  }
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
      emptyNote = ide.keymap.text(el('div', 'run-empty muted'), () => {
        const keys = ide.keymap.label('Run');
        return keys ? tr('Nothing to show. Run a configuration with {keys}.', { keys }) : tr('Nothing to show.');
      });
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
  const killProcess = (id) => ide.proc.kill(id);

  function renderActions() {
    const s = activeSession;
    if (!s) return tw.setActions([]);
    tw.setActions([
      { id: 'rerun', icon: '⟳', title: tr("Rerun '{name}'", { name: s.title }), run: () => (s.rerun ? s.rerun() : runConfig(s.cfg, { executor: s.executor })) },
      ...(busy(s) ? [{ id: 'stop', icon: '■', title: tr('Stop'), run: () => s.stop() }] : []),
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
    s.finish?.(-1);
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
      // executor: the id of the executor of the current run; exitHooks run once when its process exits.
      executor: null, exitHooks: [],
      // starting: a promise while a run is being set up (its process may exist before started() gets its id).
      starting: null, cancelStart: false, closed: false,
      // finished: resolves with the exit code of the current run (-1: it did not start, was replaced or closed);
      // launched: the current run started a process. rerun: what the tab's Rerun does instead of runConfig(cfg).
      finished: Promise.resolve(-1), finish: null, launched: false, rerun: null,
      // kill(id): ends the current run's process; a run in an emulated terminal replaces it (run:terminalKill).
      kill: killProcess,
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
        s.launched = true;
        // Stop (or closing the tab) was asked for before the process id arrived.
        if (s.cancelStart || s.closed) { s.cancelStart = false; s.kill(id); }
        s.setIcon('▶', 'running');
        if (s.con?.input) { s.con.input.disabled = false; s.con.input.focus(); }
        updateToolbar();
        if (activeSession === s) renderActions();
      },
      exited(id, code) {
        if (s.procId !== id) return;
        s.running = false;
        if (s.con?.input) s.con.input.disabled = true;
        updateToolbar();
        if (activeSession === s) renderActions();
        for (const hook of s.exitHooks.splice(0)) hook();
        // A type that does not report the exit code (undefined) is taken as success; a killed process (null) as failure.
        s.finish?.(code === undefined ? 0 : code ?? 1);
      },
      // Streams a process into the session console and prints PyCharm's exit line. A process that a rerun in this
      // tab replaced (s.procId moved on) writes nothing more: its console is gone and s.con is the new run's.
      attach(id, { onExit } = {}) {
        s.started(id);
        ide.proc.attach(id, {
          data: (text, stream) => s.procId === id && s.con?.append(text, stream === 'err' ? 'err' : null),
          exit(code) {
            if (s.procId === id) {
              s.con?.append(`\n${tr('Process finished with exit code {code}', { code: code ?? 1 })}\n`, 'sys');
              s.setIcon('▶', code === 0 ? 'done' : 'failed');
            }
            onExit?.(code);
            s.exited(id, code);
          },
        });
      },
      stop() {
        if (s.running) s.kill(s.procId);
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

  // A new run in the session: the previous run's waiters learn it was replaced.
  function armFinished(s) {
    const previous = s.finish;
    let resolve;
    s.finished = new Promise((r) => (resolve = r));
    s.finish = (code) => resolve(code);
    s.launched = false;
    previous?.(-1);
  }

  // Reuses the configuration's tab (stopping what runs there), like PyCharm without "Allow multiple instances".
  // A run still starting in the tab is waited out first, so its process is stopped here instead of being orphaned
  // (two quick Shift+F10 presses would otherwise both spawn, and the first could no longer be stopped).
  async function prepareSession(cfg, executor) {
    let s;
    while ((s = sessions.find((o) => o.key === cfg.id))?.starting) await s.starting;
    if (s) {
      if (s.running) { const old = s.procId; s.procId = null; s.running = false; s.kill(old); }
      s.kill = killProcess;
      s.dispose?.();
      s.dispose = null;
      s.extraActions = [];
      s.exitHooks = [];
      s.con = null;
      s.cfg = cfg;
      s.title = cfg.name;
      s.tab.querySelector('.run-tab-title').textContent = cfg.name;
      s.setIcon(types.get(cfg.type)?.icon || '▶');
      s.host.replaceChildren();
    } else s = createSession(cfg);
    s.executor = executor?.id || null;
    s.cancelStart = false;
    s.rerun = null;
    armFinished(s);
    let done;
    s.starting = new Promise((r) => (done = r));
    s.startDone = () => { s.starting = null; done(); updateToolbar(); if (activeSession === s) renderActions(); };
    updateToolbar();
    selectSession(s);
    return s;
  }

  // ---------- before launch tasks ----------
  // cfg.beforeLaunch: [{kind: 'config', id} | {kind: 'tool', name?, program, args?, cwd?}], PyCharm's "Before launch"
  // list. They run in order before Run and Debug start the configuration, and the first that fails (or is stopped)
  // cancels the launch. "Save all files" is not a task: the autosave.beforeRun setting saves before every launch.
  // The tasks live in the run configuration (the user's settings), never in the project.
  const cleanTasks = (list) => (Array.isArray(list) ? list : []).filter((t) => t && typeof t === 'object'
    && (t.kind === 'config' ? typeof t.id === 'string' : t.kind === 'tool' && typeof t.program === 'string'));
  const beforeLaunchOf = (cfg) => cleanTasks(cfg?.beforeLaunch);
  const TOOL_MACROS = '$ProjectDir$, $FilePath$, $FileName$, $FileNameWithoutExtension$, $FileDir$, $PyInterpreterPath$';
  const toolTitle = (t) => t.name?.trim() || [t.program, t.args].filter((x) => x?.trim()).join(' ').trim() || tr('Unnamed');
  function describeTask(t, configs = state.configs) {
    if (t.kind === 'tool') return tr('Run External Tool: {name}', { name: toolTitle(t) });
    const c = configs.find((x) => x.id === t.id);
    return c ? tr("Run '{name}'", { name: c.name }) : tr('Run Another Configuration (missing)');
  }

  // Configurations that would run before themselves, as names (A, B, A); null when there is no cycle.
  function findCycle(startId, configs, startCfg) {
    const byId = new Map(configs.map((c) => [c.id, c]));
    if (startCfg) byId.set(startCfg.id, startCfg);
    const stack = [];
    const done = new Set();
    const visit = (id) => {
      const at = stack.indexOf(id);
      if (at >= 0) return [...stack.slice(at), id];
      const c = byId.get(id);
      if (done.has(id) || !c) return null;
      stack.push(id);
      for (const t of beforeLaunchOf(c)) {
        const cycle = t.kind === 'config' ? visit(t.id) : null;
        if (cycle) return cycle;
      }
      stack.pop();
      done.add(id);
      return null;
    };
    const ids = visit(startId);
    return ids && ids.map((id) => byId.get(id)?.name || id);
  }

  function notifyError(title, text) {
    if (ide.notifications?.notify) return ide.notifications.notify({ title, text, kind: 'error', group: 'Run', raw: true });
    ide.ui.dialog({ title, body: text });
  }

  // Macros of external tools: $ProjectDir$, $FilePath$ (the active editor's file) and the rest (main/features/run.js).
  function macroContext() {
    const tab = ide.activeTab();
    return { projectDir: ide.root || '', filePath: tab?.kind === 'file' ? tab.path : '', pyInterpreter: ide.currentInterp()?.executable || '' };
  }
  const toolError = (r) => (r.error === 'noCwd' ? tr('Working directory does not exist: {path}', { path: r.cwd })
    : r.error === 'noProgram' ? tr('Program is not specified.')
    : r.error === 'untrusted' ? tr('The project is not trusted (Safe Mode).') : String(r.error));

  // Runs an external tool in its own Run tab (one per tool name, as PyCharm's); -> true, or why it failed.
  async function runTool(t, onSession = () => {}) {
    const s = await prepareSession({ id: `tool:${toolTitle(t)}`, name: toolTitle(t), type: '' }, null);
    s.rerun = () => runTool(t);
    onSession(s);
    const con = s.console();
    try {
      const r = await ide.api.invoke('run:startTool', { program: t.program, args: t.args || '', cwd: t.cwd || '', macros: macroContext() });
      if (r.error) {
        con.append(`${toolError(r)}\n`, 'err');
        return toolError(r);
      }
      con.append(`${r.command}\n`, 'sys');
      s.attach(r.id);
    } catch (err) {
      con.append(`${err.message}\n`, 'err');
      return err.message;
    } finally {
      if (!s.launched) s.finish(-1);
      s.startDone();
    }
    const code = await s.finished;
    return code === 0 || tr('Exit code {code}', { code });
  }

  // Runs another configuration (with its own before launch tasks) and waits for it to finish; -> true, or why not.
  // A run of it still going (often an earlier launch's task, see latestLaunch) is replaced without the rerun question:
  // the user asked to run this configuration, and a Cancel on a question about another one would drop that launch.
  async function runDependency(t, onSession) {
    const other = findConfig(t.id);
    if (!other) return tr('The configuration no longer exists.');
    const s = await runConfig(other, { confirm: false });
    if (!s) return tr('It was not started.');
    onSession(s);
    const code = await s.finished;
    return code === 0 || tr('Exit code {code}', { code });
  }

  // cfg.id -> the latest launch of the configuration still in its before launch tasks. Run or Debug pressed again
  // while they run starts them over, and the earlier launch ends quietly once its current task returns: the newer one
  // reuses that task's tab and stops it, which is not the task failing.
  const latestLaunch = new Map();

  // Runs cfg's before launch tasks in order. false: a task failed or was cancelled, or the tasks form a cycle, so the
  // configuration must not start (an error notification says why), or a newer launch of it took over.
  async function runBeforeLaunch(cfg) {
    const tasks = beforeLaunchOf(cfg);
    if (!tasks.length) return true;
    const cycle = findCycle(cfg.id, state.configs, cfg);
    if (cycle) {
      notifyError(tr("'{name}' was not started", { name: cfg.name }), tr('Before launch tasks form a cycle: {cycle}', { cycle: cycle.join(' → ') }));
      return false;
    }
    const launch = {};
    latestLaunch.set(cfg.id, launch);
    const superseded = () => latestLaunch.get(cfg.id) !== launch;
    let running = null;
    let cancelled = false;
    const progress = ide.tasks?.start({
      title: tr("Before launch: '{name}'", { name: cfg.name }), fraction: 0,
      onCancel: () => { cancelled = true; running?.stop(); },
    });
    try {
      for (const [i, t] of tasks.entries()) {
        progress?.update({ text: describeTask(t), fraction: i / tasks.length });
        const result = t.kind === 'config' ? await runDependency(t, (s) => (running = s)) : await runTool(t, (s) => (running = s));
        running = null;
        if (cancelled || superseded()) return false;
        if (result !== true) {
          notifyError(tr("'{name}' was not started", { name: cfg.name }), `${tr('Before launch task failed: {task}', { task: describeTask(t) })}\n${result}`);
          return false;
        }
      }
      return true;
    } finally {
      progress?.done();
      if (!superseded()) latestLaunch.delete(cfg.id);
    }
  }

  // PyCharm's "Process 'x' Is Running" question before a run replaces its configuration's run that is still going (no
  // configuration allows multiple instances here). "Don't ask again" turns run.confirmRerun off (Settings › Run/Debug).
  // -> false when the user keeps the running one.
  const CONFIRM_RERUN = 'run.confirmRerun';
  async function confirmRerun(cfg) {
    const s = sessions.find((o) => o.key === cfg.id);
    if (!s || !busy(s) || !ide.settings.get(CONFIRM_RERUN, true)) return true;
    const again = el('input');
    again.type = 'checkbox';
    again.dataset.key = 'dontAskAgain';
    const check = el('label', 'run-confirm-again');
    check.append(again, el('span', null, tr("Don't ask again")));
    const body = el('div', 'run-confirm');
    body.append(el('div', 'dialog-message', tr("'{name}' is running. Stop and rerun?", { name: cfg.name })), check);
    let yes = false;
    await new Promise((resolve) => ide.ui.dialog({
      title: tr("Process '{name}' Is Running", { name: cfg.name }), body, width: 460, onClose: resolve,
      buttons: [{ label: tr('Stop and Rerun'), primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }],
    }));
    if (yes && again.checked) ide.settings.set(CONFIRM_RERUN, false);
    return yes;
  }

  let lastRun = null;
  // opts are passed through to the type (e.g. {targets} for rerunning failed tests); opts.executor names an executor;
  // opts.confirm: false stops a run of the configuration that is still going without asking (auto-test, before launch).
  async function runConfig(cfg, opts = {}) {
    const type = types.get(cfg?.type);
    if (!type) return;
    if (opts.confirm !== false && !(await confirmRerun(cfg))) return;
    const executor = executors.get(opts.executor) || null;
    tw.show();
    if (ide.settings.get('autosave.beforeRun', true)) await ide.saveAll();
    if (!(await runBeforeLaunch(cfg))) return;
    lastRun = cfg;
    const s = await prepareSession(cfg, executor);
    try {
      let interp = interpFor(cfg);
      if (!interp) return s.console().append(`${tr('No Python interpreter found.')}\n`, 'err');
      // The executor returns the interpreter to start instead (null cancels the run) and may add exit hooks.
      if (executor && !(interp = await executor.prepare(cfg, interp, s))) return s;
      await type.start(cfg, s, interp, opts);
    } catch (err) {
      (s.con || s.console()).append(`${err.message}\n`, 'err');
      s.running = false;
      updateToolbar();
    } finally {
      if (!s.launched) s.finish(-1);
      s.startDone();
    }
    return s;
  }

  // ---------- built-in type: Python script ----------
  // Shared with other configuration types; the explicit environment variables override the files.
  const ENV_FILES_FIELD = { key: 'envFiles', label: tr('Env files'), placeholder: tr('.env;config/local.env (relative to the project root)') };
  // A working directory Windows can start a program in (main/features/run.js): one that is too long is replaced by its
  // short form, or else by the project root, and write() says which folder stands in for it.
  async function workingDir(cwd, write) {
    const r = await ide.api.invoke('run:workingDir', cwd, ide.root ? [ide.root] : []);
    if (r.tooLong) write(`${tr('The working directory is longer than Windows allows ({length} characters): {path}', { length: r.tooLong.length, path: r.tooLong })}\n${tr('The program runs in {path} instead.', { path: r.cwd })}\n`);
    return r.cwd;
  }
  // Prints a warning line for each listed env file that does not exist.
  async function warnMissingEnvFiles(cfg, write) {
    for (const p of await missingEnvFiles(cfg)) write(`${tr('Env file not found: {path}', { path: p })}\n`);
  }
  const commandLine = (interp, r) => [interp.cmd, ...interp.args, ...r.interpOptions, r.script, ...r.params].map(quoteArg).join(' ');

  // ---------- Emulate terminal in output console ----------
  // The run's tab shows an xterm.js terminal on a pseudo-console (run:startTerminal in main/features/run.js), so the
  // program's isatty() is true: colors, progress bars and prompts behave as in a terminal, keys go to the program.
  const XTERM = '../node_modules/@xterm';
  // xterm ships UMD bundles; with Monaco's AMD loader present they would register as AMD modules instead of globals
  // (the Terminal plugin loads them the same way, and usually first).
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const amd = window.define?.amd;
      if (amd) window.define.amd = undefined;
      const tag = el('script');
      tag.src = src;
      tag.onload = () => { if (amd) window.define.amd = amd; resolve(); };
      tag.onerror = () => { if (amd) window.define.amd = amd; reject(new Error(`failed to load ${src}`)); };
      document.head.appendChild(tag);
    });
  }
  let xterm = null;
  const loadXterm = () => (xterm ||= (async () => {
    if (!document.querySelector('link[href$="xterm/css/xterm.css"]')) {
      const css = el('link');
      css.rel = 'stylesheet';
      css.href = `${XTERM}/xterm/css/xterm.css`;
      document.head.appendChild(css);
    }
    if (!window.Terminal) await loadScript(`${XTERM}/xterm/lib/xterm.js`);
    if (!window.FitAddon) await loadScript(`${XTERM}/addon-fit/lib/addon-fit.js`);
  })());
  // Output and exit of each run in a terminal, by id; what arrives before its tab listens waits in `early`.
  const terminalRuns = new Map();
  const early = new Map();
  const deliver = (id, m) => {
    const run = terminalRuns.get(id);
    if (run) run(m); else early.set(id, [...(early.get(id) || []), m]);
  };
  ide.api.on('run:terminalData', ({ id, data }) => deliver(id, { data }));
  ide.api.on('run:terminalExit', ({ id, code }) => deliver(id, { exit: true, code }));
  const termTheme = () => {
    const v = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return { background: v('--gray1'), foreground: v('--text'), cursor: v('--gray11'), cursorAccent: v('--gray1') };
  };

  async function startInTerminal(cfg, s, interp, r) {
    await loadXterm();
    // Not a [data-terminal] like the Terminal's panes: as in PyCharm's Run console, the IDE's shortcuts (Stop, Rerun)
    // still work while it has the keyboard; other keys go to the program.
    const box = el('div', 'run-term');
    s.host.appendChild(box);
    const term = new window.Terminal({
      fontFamily: "'JetBrains Mono', D2Coding, Consolas, 'Malgun Gothic', monospace", fontSize: 13, scrollback: 10000,
      theme: termTheme(), windowsPty: { backend: 'conpty' },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(box);
    try { fit.fit(); } catch {}
    s.term = term;
    const line = (text) => term.write(`${text.replace(/\r?\n/g, '\r\n')}`);
    line(`${commandLine(interp, r)}\n`);
    if (r.stdin) line(`${tr('Redirect input from is not used while Emulate terminal in output console is on.')}\n`);
    const cwd = await workingDir(r.cwd, line);
    await warnMissingEnvFiles(cfg, line);
    let id = null;
    const size = ide.util.observeSize(box, () => {
      if (!box.offsetWidth || box.closest('.hidden')) return;
      try { fit.fit(); } catch {}
      if (id != null) ide.api.send('run:terminalResize', { id, cols: term.cols, rows: term.rows });
    });
    const input = term.onData((data) => { if (id != null && s.procId === id && s.running) ide.api.send('run:terminalWrite', { id, data }); });
    s.dispose = () => {
      size.disconnect();
      input.dispose();
      term.dispose();
      if (s.term === term) s.term = null;
      // A replaced run's last output and exit still arrive; they are dropped instead of waiting in `early`.
      if (terminalRuns.has(id)) terminalRuns.set(id, (m) => { if (m.exit) terminalRuns.delete(id); });
    };
    let res;
    try {
      res = await ide.api.invoke('run:startTerminal', interp, r.script, cwd, r.params, r.env, ide.root ? [ide.root] : [], envFilesFor(cfg),
        { interpOptions: r.interpOptions, cols: term.cols, rows: term.rows });
    } catch (err) {
      return line(`${ide.util.errorText(err)}\n`);
    }
    if (res.error) return line(`${tr('Emulate terminal in output console is not available for a remote interpreter.')}\n`);
    id = res.id;
    s.kill = (pid) => ide.api.invoke('run:terminalKill', pid);
    s.started(id);
    term.focus();
    terminalRuns.set(id, (m) => {
      if (!m.exit) return void (s.procId === id && term.write(m.data));
      terminalRuns.delete(id);
      if (s.procId === id) {
        line(`\n${tr('Process finished with exit code {code}', { code: m.code ?? 1 })}\n`);
        s.setIcon('▶', m.code === 0 ? 'done' : 'failed');
      }
      s.exited(id, m.code);
    });
    for (const m of early.get(id) || []) terminalRuns.get(id)?.(m);
    early.delete(id);
  }
  // PyCharm's "Run: Script path / Module name": cfg.runMode 'module' runs `python -m <cfg.module>` (configurations saved
  // before the switch run their script). A module runs in the project root unless a working directory is given.
  const isModule = (cfg) => cfg?.runMode === 'module';
  // A Python configuration resolved to what a launcher needs: script is '-m' for a module, which then leads params.
  // missing: the script or module is not specified. interpOptions: PyCharm's Interpreter options (-X dev, -O, -W error),
  // which go before the script; stdin: the file of Redirect input from (absolute), or ''.
  function resolvePython(cfg) {
    const params = parseArgs(cfg.params);
    const base = { cwd: resolvePath(cfg.cwd), env: parseEnv(cfg.env), interp: interpFor(cfg), interpOptions: parseArgs(cfg.interpOptions),
      stdin: resolvePath(cfg.stdinFile) };
    if (isModule(cfg)) {
      const module = (cfg.module || '').trim();
      return { ...base, missing: !module, script: '-m', params: [module, ...params], cwd: base.cwd || ide.root || '' };
    }
    const script = resolvePath(cfg.script);
    return { ...base, missing: !script, script, params, cwd: base.cwd || (script && dirname(script)) };
  }
  types.set('python', {
    type: 'python', title: 'Python', icon: '🐍',
    fields: [
      { key: 'runMode', label: tr('Run'), kind: 'select', options: () => [['script', tr('Script path')], ['module', tr('Module name')]] },
      { key: 'script', label: tr('Script path'), placeholder: tr('path\\to\\script.py'), browse: true, shown: (c) => !isModule(c) },
      { key: 'module', label: tr('Module name'), placeholder: tr('e.g. package.module'), shown: isModule },
      { key: 'params', label: tr('Script parameters') },
      { key: 'cwd', label: tr('Working directory'), placeholder: tr('Defaults to the script folder'), placeholderFor: (c) => (isModule(c) ? tr('Defaults to the project root') : null) },
      { key: 'env', label: tr('Environment variables'), placeholder: tr('NAME=value;OTHER=value') },
      ENV_FILES_FIELD,
      { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
      { key: 'interpOptions', label: tr('Interpreter options'), placeholder: tr('e.g. -X dev -W error') },
      { key: 'stdinFile', label: tr('Redirect input from'), placeholder: tr('A file the program reads as its standard input'), browse: [] },
      { key: 'emulateTerminal', label: tr('Emulate terminal in output console'), kind: 'checkbox' },
    ],
    defaults: () => ({ runMode: 'script', script: '', module: '', params: '', cwd: '', env: '', envFiles: DEFAULT_ENV_FILES, interp: '',
      interpOptions: '', stdinFile: '', emulateTerminal: false }),
    identity: (c) => (isModule(c) ? `module:${(c.module || '').trim().toLowerCase()}` : resolvePath(c.script).toLowerCase()),
    file: (c) => (isModule(c) ? null : resolvePath(c.script)),
    // A scratch file (scratches plugin) runs in the project root, as in PyCharm.
    forFile: (path) => ({ type: 'python', name: basename(path).replace(/\.pyw?$/, ''), script: path, ...(ide.root && ide.scratches?.isScratch(path) ? { cwd: ide.root } : {}) }),
    async start(cfg, s, interp) {
      const r = resolvePython(cfg);
      // A remote interpreter's program gets no pseudo-console here; it runs with the output console.
      if (cfg.emulateTerminal && !interp.target && !r.missing) return startInTerminal(cfg, s, interp, r);
      const con = s.console({ input: !r.stdin, placeholder: tr('stdin: type input and press Enter') });
      if (r.missing) {
        return con.append(`${isModule(cfg) ? tr('Module name is not specified. Edit the configuration first.') : tr('Script path is not specified. Edit the configuration first.')}\n`, 'err');
      }
      con.append(`${commandLine(interp, r)}${r.stdin ? ` < ${quoteArg(r.stdin)}` : ''}\n`, 'sys');
      if (cfg.emulateTerminal) con.append(`${tr('Emulate terminal in output console is not available for a remote interpreter.')}\n`, 'err');
      if (r.stdin && !(await ide.api.exists(r.stdin))) return con.append(`${tr("Input file doesn't exist: {path}", { path: r.stdin })}\n`, 'err');
      const cwd = await workingDir(r.cwd, (text) => con.append(text, 'err'));
      await warnMissingEnvFiles(cfg, (text) => con.append(text, 'err'));
      // run:start runs `python <options> -u <script> <params…>`, so '-m' goes where the script would.
      const id = await ide.api.invoke('run:start', interp, r.script, cwd, r.params, r.env, ide.root ? [ide.root] : [], envFilesFor(cfg),
        { interpOptions: r.interpOptions, stdin: r.stdin || undefined });
      s.attach(id);
    },
  });

  // ---------- run widget (toolbar) ----------
  const runBtn = el('button', 'tb-icon run-btn');
  runBtn.appendChild(ide.icon('runRun', '▶'));
  ide.keymap.tooltip(runBtn, tr('Run'), 'Run');
  let debugActive = false; // a debugger session is active (see 'debugSessionChanged')
  const stopBtn = el('button', 'tb-icon stop-btn');
  stopBtn.appendChild(ide.icon('runStop', '■'));
  ide.keymap.tooltip(stopBtn, tr('Stop'), 'Stop');
  stopBtn.disabled = true;
  const target = el('button', 'run-target');
  target.title = tr('Run/Debug Configurations');
  ide.registerToolbarItem({ order: 60, el: target });
  ide.registerToolbarItem({ order: 70, el: runBtn });
  ide.registerToolbarItem({ order: 90, el: stopBtn });
  // PyCharm's "More Actions" (⋮) in the run widget: the other executors for the selected configuration.
  const moreBtn = el('button', 'tb-icon run-more-btn hidden');
  moreBtn.appendChild(ide.icon('moreVertical', '⋮'));
  moreBtn.title = tr('More Actions');
  ide.registerToolbarItem({ order: 85, el: moreBtn });

  function renderTarget() {
    const cfg = selectedConfig();
    const name = el('span', 'run-target-name', cfg ? cfg.name : tr('Current File'));
    if (cfg) name.dataset.userText = '';
    target.replaceChildren(
      el('span', 'run-target-icon' + (cfg?.temporary ? ' temporary' : ''), cfg ? types.get(cfg.type)?.icon || '▶' : '📄'),
      name,
      (() => { const a = el('span', 'run-target-arrow'); a.appendChild(ide.icon('chevronDown', '▾')); return a; })(),
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
  // The active file Run can start: a Python file, or a file (also in a viewer tab) that another configuration type's
  // forFile claims, such as a visual script (.pyflow).
  function currentPyFile() {
    const tab = ide.activeTab();
    const path = tab?.kind === 'file' || tab?.viewer ? tab.path : null;
    if (!path) return null;
    return /\.pyw?$/i.test(path) || [...types.values()].some((t) => t.type !== 'python' && t.forFile?.(path)) ? path : null;
  }

  const currentFileConfig = (file) => {
    const cfg = contextConfigForFile(file);
    return { ...types.get(cfg.type).defaults(), ...cfg, id: `file:${file.toLowerCase()}` };
  };

  function runCurrentFile(opts = {}) {
    const file = currentPyFile();
    if (file) return runConfig(currentFileConfig(file), opts);
    if (lastRun) return runConfig(lastRun, opts);
    ide.ui.dialog({ title: tr('Run'), body: tr('Open a Python file to run it, or select a run configuration.') });
  }

  function runSelected(opts = {}) {
    const cfg = selectedConfig();
    return cfg ? runConfig(cfg, opts) : runCurrentFile(opts);
  }

  // What Run would start now: the selected configuration, the current file, or the last run.
  function selectedTarget() {
    const file = currentPyFile();
    return selectedConfig() || (file ? currentFileConfig(file) : lastRun);
  }

  moreBtn.onclick = () => {
    const r = moreBtn.getBoundingClientRect();
    const cfg = selectedTarget();
    ide.ui.contextMenu(r.left, r.bottom + 2, [...executors.values()].map((ex) => ({
      label: cfg ? ex.label(cfg.name) : ex.title, icon: ex.iconName, glyph: ex.glyph, disabled: !cfg,
      run: () => runSelected({ executor: ex.id }),
    })));
  };

  // Ctrl+Shift+F10 / project tree / gutter: run a context configuration, saved as a temporary one.
  function runContext(cfg) {
    return runConfig(addTemporary(cfg));
  }

  // The debugger debugs the active file; 'DebugCurrent' is the contract name, 'Debug' is PyCharm's action id.
  const debugActionId = () => ['DebugCurrent', 'Debug'].find((id) => ide.actions.some((a) => a.id === id));
  // A type with debugTarget(cfg, interp, opts) -> {script, cwd, params, env, tabs?, started?} (script may be '-m'; null
  // cancels) is debugged like a script; tabs are debugFile's plugin sub-tabs of the session. started(promise) gets
  // debugFile's promise, which settles once the session runs or failed.
  const canDebug = (cfg) => !!debugActionId() && (!cfg || cfg.type === 'python' || (!!types.get(cfg.type)?.debugTarget && !!ide.debugger?.debugFile));
  // opts are passed through to the type's debugTarget (e.g. {targets} for debugging the failed tests again).
  async function debugConfig(cfg, opts = {}) {
    if (beforeLaunchOf(cfg).length) {
      if (ide.settings.get('autosave.beforeRun', true)) await ide.saveAll();
      if (!(await runBeforeLaunch(cfg))) return;
    }
    const debugTarget = types.get(cfg.type)?.debugTarget;
    if ((cfg.type === 'python' || debugTarget) && ide.debugger?.debugFile) {
      // Debug with the configuration's interpreter, working directory, parameters and environment.
      const target = cfg.type === 'python' ? resolvePython(cfg) : await debugTarget(cfg, interpFor(cfg), opts);
      if (!target) return;
      if (target.missing) {
        return ide.ui.alert(isModule(cfg) ? tr('Module name is not specified. Edit the configuration first.') : tr('Script path is not specified. Edit the configuration first.'));
      }
      const r = { interp: interpFor(cfg), ...target };
      // Interpreter options go with the interpreter's own arguments, ahead of debugpy's.
      const interp = r.interp && r.interpOptions?.length ? { ...r.interp, args: [...r.interp.args, ...r.interpOptions] } : r.interp;
      // A debugTarget may build its script (a visual script compiles its graph), so Rerun asks it again. Its tabs are
      // sub-tabs of the session in the Debug window (the pytest type's Test Results).
      const started = ide.debugger.debugFile(r.script, { interp, cwd: r.cwd, params: r.params, env: r.env, envFiles: envFilesFor(cfg),
        ...(r.tabs ? { tabs: r.tabs } : {}), ...(debugTarget ? { rerun: () => debugConfig(cfg, opts) } : {}) });
      r.started?.(started);
      return started;
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
  ide.registerAction({ id: 'Rerun', title: tr('Rerun'), run: () => activeSession && (activeSession.rerun ? activeSession.rerun() : runConfig(activeSession.cfg, { executor: activeSession.executor })) });
  ide.registerTreeAction({
    title: tr("Run '…'"),
    keyAction: 'RunClass',
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
        if (fd.shown && !fd.shown(current)) continue;
        let input;
        if (fd.kind === 'select') {
          input = el('select');
          const options = fd.options();
          for (const [value, label] of options) input.add(new Option(label, value));
          input.value = options.some(([v]) => v === current[fd.key]) ? current[fd.key] : options[0][0];
          // The form shows other fields for another choice (Script path or Module name).
          input.onchange = () => {
            current[fd.key] = input.value;
            renderForm();
            form.querySelector(`[data-key="${fd.key}"]`)?.focus();
          };
        } else if (fd.kind === 'interp') {
          input = el('select');
          input.add(new Option(tr('Project Default ({interp})', { interp: ide.currentInterp()?.label || tr('none') }), ''));
          for (const it of ide.interps) input.add(new Option(it.label, it.executable));
          if (current[fd.key] && !ide.interps.some((i) => samePath(i.executable, current[fd.key]))) input.add(new Option(current[fd.key], current[fd.key]));
          input.value = current[fd.key] || '';
          input.onchange = () => (current[fd.key] = input.value);
        } else if (fd.kind === 'checkbox') {
          input = el('input');
          input.type = 'checkbox';
          input.checked = !!current[fd.key];
          input.onchange = () => (current[fd.key] = input.checked);
        } else {
          input = el('input');
          input.value = current[fd.key] || '';
          input.placeholder = fd.placeholderFor?.(current) || fd.placeholder || '';
          input.oninput = () => (current[fd.key] = input.value);
        }
        input.dataset.key = fd.key;
        if (fd.browse) {
          const wrap = el('span', 'rc-browse');
          const b = el('button', 'secondary', '…');
          b.title = tr('Browse');
          b.onclick = async (e) => {
            e.preventDefault();
            // fd.browse: the dialog's filters (an empty list shows every file), or true for Python files.
            const p = await ide.api.openFileDialog(Array.isArray(fd.browse) ? fd.browse : [{ name: 'Python', extensions: ['py', 'pyw'] }]);
            if (p) { input.value = p; current[fd.key] = p; }
          };
          wrap.append(input, b);
          field(`${fd.label}:`, wrap);
        } else field(`${fd.label}:`, input);
      }
      renderBeforeLaunch();
    }

    // ---------- Before launch (in the form) ----------
    let blSelected = 0;
    let blFor = null; // the configuration blSelected belongs to
    let blError = '';
    function renderBeforeLaunch() {
      if (blFor !== current) { blFor = current; blSelected = 0; blError = ''; }
      const tasks = (current.beforeLaunch = cleanTasks(current.beforeLaunch));
      blSelected = Math.max(0, Math.min(blSelected, tasks.length - 1));
      const sec = el('div', 'rc-bl');
      sec.appendChild(el('div', 'rc-bl-title', tr('Before launch')));
      const blBar = el('div', 'rc-bl-bar');
      const blButton = (id, icon, title, run, disabled) => {
        const b = el('button', 'rc-bl-btn', icon);
        b.dataset.bl = id;
        b.title = title;
        b.disabled = !!disabled;
        b.onclick = (e) => { e.preventDefault(); run(e); };
        blBar.appendChild(b);
      };
      const move = (d) => {
        const [t] = tasks.splice(blSelected, 1);
        tasks.splice(blSelected + d, 0, t);
        blSelected += d;
        renderForm();
      };
      blButton('add', '＋', tr('Add Task'), (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const others = draft.filter((c) => c !== current);
        ide.ui.contextMenu(r.left, r.bottom + 2, [
          { header: tr('Run Another Configuration') },
          ...others.map((c) => ({ label: `${types.get(c.type)?.icon || '▶'}  ${c.name || tr('Unnamed')}`, run: () => {
            tasks.push({ kind: 'config', id: c.id });
            const cycle = findCycle(current.id, draft);
            if (cycle) {
              tasks.pop();
              blError = tr("'{name}' cannot run before itself: {cycle}", { name: current.name, cycle: cycle.join(' → ') });
            } else {
              blError = '';
              blSelected = tasks.length - 1;
            }
            renderForm();
          } })),
          ...(others.length ? [] : [{ label: tr('No other configurations'), disabled: true }]),
          { separator: true },
          { label: tr('Run External Tool'), run: () => {
            tasks.push({ kind: 'tool', name: '', program: '', args: '', cwd: '' });
            blSelected = tasks.length - 1;
            blError = '';
            renderForm();
            form.querySelector('[data-bl-key="program"]')?.focus();
          } },
        ]);
        // Core menus sit below dialogs; this one opens from a dialog.
        for (const m of document.querySelectorAll('#menuHost .context-menu')) m.style.zIndex = 80;
      });
      blButton('remove', '−', tr('Remove Task'), () => { tasks.splice(blSelected, 1); blError = ''; renderForm(); }, !tasks.length);
      blButton('up', '▲', tr('Move Up'), () => move(-1), blSelected <= 0);
      blButton('down', '▼', tr('Move Down'), () => move(1), blSelected >= tasks.length - 1);
      const blList = el('div', 'rc-bl-list');
      tasks.forEach((t, i) => {
        const row = el('div', `rc-bl-item${i === blSelected ? ' selected' : ''}`, describeTask(t, draft));
        row.dataset.index = i;
        row.dataset.kind = t.kind;
        row.onclick = () => { blSelected = i; renderForm(); };
        blList.appendChild(row);
      });
      if (!tasks.length) blList.appendChild(el('div', 'rc-bl-none muted', tr('There are no tasks to run before launch')));
      sec.append(blBar, blList);
      if (blError) sec.appendChild(el('div', 'rc-bl-error', blError));
      const t = tasks[blSelected];
      if (t?.kind === 'tool') {
        const tool = el('div', 'rc-bl-tool');
        for (const [key, label, placeholder] of [
          ['name', tr('Name'), tr('Optional')],
          ['program', tr('Program'), tr('For example node, black or $PyInterpreterPath$')],
          ['args', tr('Arguments'), '$FilePath$'],
          ['cwd', tr('Working directory'), tr('Defaults to the project folder')],
        ]) {
          const input = el('input');
          input.dataset.blKey = key;
          input.value = t[key] || '';
          input.placeholder = placeholder;
          input.oninput = () => {
            t[key] = input.value;
            const row = blList.querySelector(`[data-index="${blSelected}"]`);
            if (row) row.textContent = describeTask(t, draft);
          };
          const f = el('label', 'field');
          f.append(el('span', null, `${label}:`), input);
          tool.appendChild(f);
        }
        tool.appendChild(el('div', 'rc-bl-hint muted', tr('Macros: {macros}. The output shows in the Run window.', { macros: TOOL_MACROS })));
        sec.appendChild(tool);
      }
      form.appendChild(sec);
    }

    function render() { renderList(); renderForm(); }
    render();

    ide.ui.dialog({
      title: tr('Run/Debug Configurations'),
      body,
      width: 780,
      buttons: [
        { label: tr('OK'), primary: true, run() {
          for (const c of draft) if (!c.name?.trim()) c.name = tr('Unnamed');
          // A cycle made some other way (a copied configuration) is refused here too.
          for (const c of draft) {
            const cycle = findCycle(c.id, draft);
            if (!cycle) continue;
            current = c;
            renderList();
            blFor = c;
            blError = tr("'{name}' cannot run before itself: {cycle}", { name: c.name, cycle: cycle.join(' → ') });
            renderForm();
            return false;
          }
          state.configs = draft;
          state.selected = current ? current.id : findConfig(state.selected) ? state.selected : CURRENT;
          persist();
          // Open tabs keep running their old copy; a rerun picks up the edited configuration.
          for (const s of sessions) { const c = findConfig(s.key); if (c) s.cfg = c; }
        } },
        { label: tr('Cancel') },
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
      { label: `▶  ${tr("Run '{name}'", { name: item.title })}`, keyAction: 'RunClass', run: () => runContext(cfg()) },
      ...(canDebug(cfg()) ? [{ label: `🐞  ${tr("Debug '{name}'", { name: item.title })}`, run: () => {
        ed.setPosition({ lineNumber: item.line, column: 1 });
        debugConfig(addTemporary(cfg()));
      } }] : []),
      ...[...executors.values()].map((ex) => ({
        label: ex.label(item.title), icon: ex.iconName, glyph: ex.glyph, run: () => runConfig(addTemporary(cfg()), { executor: ex.id }),
      })),
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
    // A hand-edited settings file keeps only the configurations that are objects with an id.
    state.configs = Array.isArray(state.configs) ? state.configs.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') : [];
    // Configurations saved before "Before launch" existed have none; malformed tasks are dropped.
    for (const c of state.configs) if ('beforeLaunch' in c) c.beforeLaunch = cleanTasks(c.beforeLaunch);
    if (!findConfig(state.selected)) state.selected = CURRENT;
    renderTarget();
  });
  // The configurations belong to the closed project: the run widget must not offer (and Run must not start) them.
  ide.on('projectClosed', () => {
    state = { configs: [], selected: CURRENT };
    renderTarget();
  });
  renderTarget();

  (ide.settingsPages ||= []).push({
    id: 'run-debug', title: () => tr('Run/Debug'), defaults: { [CONFIRM_RERUN]: true },
    keywords: 'run debug rerun confirm stop process running ask 실행 디버그 다시 실행 확인 중지 프로세스',
    mount(host, ctx) {
      const sec = ctx.ui.section(host, tr('Run/Debug'));
      sec.appendChild(ctx.ui.checkbox(CONFIRM_RERUN, tr('Confirm rerun with process termination')));
      sec.appendChild(el('div', 'muted settings-note', tr('Asks before Run or Rerun stops a run of the same configuration that is still going.')));
    },
  });

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
    runSelected,
    selectedTarget,
    // executor: {id, title, label(name), iconName?, glyph?, prepare(cfg, interp, session) -> Promise<interp | null>}.
    // prepare returns the interpreter to start with (e.g. one whose args launch a wrapper script before the program)
    // and may push callbacks to session.exitHooks, which run once when that run's process exits.
    registerExecutor: (ex) => { executors.set(ex.id, ex); moreBtn.classList.remove('hidden'); },
    executors,
    debugConfig,
    canDebug,
    // Before launch tasks: runBeforeLaunch(cfg) -> Promise<bool>, findCycle(id, configs) -> names | null.
    runBeforeLaunch,
    findCycle,
    // A Run tool window tab that is not a configuration's (File Watchers); an existing one keeps its console.
    outputSession: (key, title) => sessions.find((o) => o.key === key) || createSession({ id: key, name: title, type: '' }),
    // Shows the Run window with this session selected.
    show(session) { tw.show(); if (session) selectSession(session); },
    // The Run tab of a configuration being debugged (its own tab, apart from the configuration's runs) for what the
    // debugger does not show, such as Test Results; the debugger owns the process. Like a run being started, the caller
    // ends the setup with session.startDone() and reports the end with session.finish(code).
    async debugSession(cfg) {
      const s = await prepareSession({ ...cfg, id: `debug:${cfg.id}` }, null);
      s.tab.classList.add('run-tab-debug');
      return s;
    },
    notifyError,
    editConfigurations,
    sessions: () => sessions,
    activeSession: () => activeSession,
    // fn(model, path) -> [{line, title, state?: 'passed'|'failed', config() -> cfg}]
    registerGutterProvider: (fn) => { gutterProviders.push(fn); scheduleGutter(); },
    refreshGutter,
    interpFor,
    // A Python configuration resolved to what a launcher needs (e.g. for a debugger).
    resolvePython,
    resolvePath,
    parseArgs,
    parseEnv,
    // .env files: the field for a configuration type, its absolute paths, and warnings for missing ones.
    envFilesField: ENV_FILES_FIELD,
    defaultEnvFiles: DEFAULT_ENV_FILES,
    envFiles: envFilesFor,
    warnMissingEnvFiles,
    // workingDir(cwd, write) -> a folder a program can start in; write(text) says when another one stands in.
    workingDir,
  };
})();
