// Install Manager: one tab to install, check, update and remove what a Python developer needs.
// Installables are a registry any plugin pushes into, whatever the load order:
//   (ide.installables ||= []).push({ id, category, name, description, size?, homepage?,
//     status: async () => ({ installed, version?, running?, detail?, available?, reason?, update? }),
//     install: async (log, progress, signal) => {},   // throw to fail; update/uninstall/start/stop take the same arguments
//     update?, uninstall?, start?, stop?, actions?: [{ label, run, when?(status) }],
//     confirm?: string, confirmUninstall?: string });  // confirmation text; `backticks` render as code
//   ide.emit('installablesChanged');
(() => {
  const { el } = ide.util;
  const TAB_ID = 'installer:manager';
  const CATEGORIES = {
    interpreters: tr('Python Interpreters'), python: tr('Python Tools'), toolchains: tr('Toolchains'), languages: tr('Language Servers'), databases: tr('Databases'), drivers: tr('Database Drivers'), ai: tr('AI Models'), system: tr('System Tools'),
  };
  const BUSY = { install: 'installing', update: 'updating', uninstall: 'removing', start: 'starting', stop: 'stopping' };
  const BUSY_PHASES = new Set(Object.values(BUSY));
  const BADGES = {
    unknown: [tr('Not checked'), 'muted'], checking: [tr('Checking…'), 'muted'], notInstalled: [tr('Not installed'), 'muted'],
    installed: [tr('Installed'), 'ok'], running: [tr('Running'), 'run'], unavailable: [tr('Unavailable'), 'warn'],
    installing: [tr('Installing…'), 'busy'], updating: [tr('Updating…'), 'busy'], removing: [tr('Removing…'), 'busy'],
    starting: [tr('Starting…'), 'busy'], stopping: [tr('Stopping…'), 'busy'], failed: [tr('Failed'), 'error'],
  };
  const OP_TITLES = { install: tr('Install'), update: tr('Update'), uninstall: tr('Remove'), start: tr('Start'), stop: tr('Stop') };
  const phaseOf = (st) => (st.available === false ? 'unavailable' : st.running ? 'running' : st.installed ? 'installed' : 'notInstalled');
  const categoryLabel = (c) => CATEGORIES[c] || c;
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };

  // ---------- registry ----------
  const warned = new Set();
  const valid = (it) => !!it && typeof it.id === 'string' && typeof it.name === 'string' && typeof it.category === 'string'
    && typeof it.status === 'function' && typeof it.install === 'function';
  function items() {
    const byId = new Map();
    for (const it of ide.installables || []) {
      if (valid(it)) byId.set(it.id, it);
      else if (!warned.has(it)) { warned.add(it); console.warn('Install Manager: ignoring an invalid installable', it?.id); }
    }
    return [...byId.values()];
  }

  // ---------- per-item state machine ----------
  // phase: unknown -> checking -> notInstalled | installed | running | unavailable; an operation moves to a busy phase
  // and back to the checked phase, or to failed. `status` is the last status the item reported.
  const states = new Map();
  const entry = (id) => {
    if (!states.has(id)) states.set(id, { phase: 'unknown', status: null, error: null, notice: null, log: '', progress: null, ctl: null, seq: 0 });
    return states.get(id);
  };
  const isBusy = (id) => BUSY_PHASES.has(entry(id).phase);

  function set(item, patch) {
    Object.assign(entry(item.id), patch);
    updateCard(item);
    renderSide();
    renderStatusItem();
  }

  function appendLog(item, text) {
    const s = entry(item.id);
    s.log = (s.log + text).slice(-200000);
    scheduleLog(item.id);
  }

  async function check(item, { quiet = false } = {}) {
    const s = entry(item.id);
    if (isBusy(item.id)) return;
    const my = ++s.seq;
    if (!quiet) set(item, { phase: 'checking' });
    try {
      const st = (await item.status()) || {};
      if (my !== s.seq) return;
      if (quiet && s.phase === 'failed') set(item, { status: st });
      else set(item, { phase: phaseOf(st), status: st, error: quiet ? s.error : null });
    } catch (err) {
      if (my === s.seq) set(item, { phase: 'failed', error: String(err?.message || err) });
    }
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const body = el('div', 'inst-confirm');
      for (const para of text.split(/\n\s*\n/)) {
        const p = el('p');
        para.split(/(`[^`]*`)/).forEach((part, i) => p.append(i % 2 ? userText('code', null, part.slice(1, -1)) : part));
        body.appendChild(p);
      }
      let answered = false;
      ide.ui.dialog({
        title,
        body,
        buttons: [{ label: okLabel, primary: true, run: () => { answered = true; resolve(true); } }, { label: tr('Cancel') }],
        onClose: () => { if (!answered) resolve(false); },
      });
    });
  }

  async function run(item, op) {
    const s = entry(item.id);
    if (isBusy(item.id) || typeof item[op] !== 'function') return;
    const text = op === 'install' ? item.confirm : op === 'uninstall' ? item.confirmUninstall : null;
    if (text && !(await confirmDialog(tr('{op}: {name}', { op: OP_TITLES[op], name: item.name }), text, OP_TITLES[op]))) return;
    const ctl = new AbortController();
    s.seq++;
    set(item, { phase: BUSY[op], error: null, notice: null, progress: null, ctl });
    appendLog(item, `${s.log ? '\n' : ''}── ${OP_TITLES[op]} · ${new Date().toLocaleTimeString()} ──\n`);
    // The job is also a background task (status bar progress and popup, where Cancel cancels it) and ends with a notification.
    const title = tr('{op}: {name}', { op: OP_TITLES[op], name: item.name });
    const task = ide.tasks?.start({ title, onCancel: () => ctl.abort() });
    const lastLine = (t) => {
      const line = String(t).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) task?.update({ text: line.slice(0, 200) });
    };
    const log = (t) => { lastLine(t); appendLog(item, String(t).endsWith('\n') ? String(t) : `${t}\n`); };
    // Process output arrives in arbitrary chunks; main jobs append it as is instead of a line per chunk.
    log.raw = (t) => { lastLine(t); appendLog(item, t); };
    const progress = (f) => {
      if (entry(item.id).ctl !== ctl) return;
      const fraction = Math.max(0, Math.min(1, Number(f) || 0));
      task?.update({ fraction });
      set(item, { progress: fraction });
    };
    const cancelled = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    const notify = (kind, text) => ide.notifications?.notify({ title, text, kind, raw: kind === 'error', group: 'Install Manager',
      actions: [{ label: tr('Open Install Manager'), run: () => open(item.category) }] });
    try {
      await Promise.race([item[op](log, progress, ctl.signal), cancelled]);
      task?.done();
      appendLog(item, `${tr('Done.')}\n`);
      set(item, { ctl: null, phase: s.status ? phaseOf(s.status) : 'unknown' });
      if (op !== 'start' && op !== 'stop') notify('ok', tr('Done.'));
      await check(item);
    } catch (err) {
      task?.done();
      if (ctl.signal.aborted) {
        appendLog(item, `${tr('Cancelled.')}\n`);
        set(item, { ctl: null, phase: s.status ? phaseOf(s.status) : 'unknown' });
        await check(item);
      } else {
        const message = String(err?.message || err);
        appendLog(item, `${tr('Failed: {error}', { error: message })}\n`);
        set(item, { ctl: null, phase: 'failed', error: message });
        cards.get(item.id)?.logBox.setAttribute('open', '');
        notify('error', message);
      }
    }
  }

  const cancel = (item) => entry(item.id).ctl?.abort();

  async function runAction(item, action) {
    set(item, { error: null, notice: null });
    try {
      const notice = await action.run();
      if (typeof notice === 'string') set(item, { notice });
    } catch (err) {
      set(item, { error: String(err?.message || err) });
    }
  }

  // ---------- main-process jobs ----------
  const jobs = new Map(); // jobId -> {log, progress}
  let jobSeq = 0;
  ide.api.on('installer:log', ({ jobId, text }) => jobs.get(jobId)?.log(text));
  ide.api.on('installer:progress', ({ jobId, fraction }) => jobs.get(jobId)?.progress?.(fraction));

  async function mainJob(spec, log, progress, signal) {
    const jobId = `job-${Date.now()}-${++jobSeq}`;
    jobs.set(jobId, { log: log.raw || log, progress });
    const onAbort = () => ide.api.invoke('installer:cancel', jobId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await ide.api.invoke('installer:run', jobId, spec);
      if (!r.ok) throw new Error(r.error);
    } finally {
      jobs.delete(jobId);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // ---------- built-in catalog: Python tools via pip in the project interpreter ----------
  const normalize = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  const noInterp = () => tr('No project interpreter. Choose one in Settings › Python Interpreter.');
  const pipLists = new Map(); // python.exe -> Promise<{ok, packages: Map} | {ok: false, error}>
  const outdated = new Map(); // python.exe -> Map(name -> latest version)
  const outdatedRequested = new Set();
  const pipItemIds = new Set();

  function pipList(exe) {
    if (!pipLists.has(exe)) {
      pipLists.set(exe, ide.api.invoke('installer:pipList', exe).then((r) => (r.ok
        ? { ok: true, packages: new Map(r.packages.map((p) => [normalize(p.name), p.version])) } : r)));
    }
    return pipLists.get(exe);
  }

  // `pip list --outdated` asks PyPI about every package, so it runs in the background and fills in updates later.
  function checkOutdated(exe) {
    if (outdatedRequested.has(exe)) return;
    outdatedRequested.add(exe);
    ide.api.invoke('installer:pipList', exe, { outdated: true }).then((r) => {
      if (!r.ok) return;
      outdated.set(exe, new Map(r.packages.map((p) => [normalize(p.name), p.latest])));
      for (const it of items()) if (pipItemIds.has(it.id)) check(it, { quiet: true });
    });
  }

  function pip({ package: pkg, name = pkg, description = '', category = 'python', id = `pip:${normalize(pkg)}`, size, homepage = `https://pypi.org/project/${pkg}/` }) {
    const key = normalize(pkg.replace(/\[.*$/, ''));
    const target = () => ide.currentInterp()?.executable;
    async function job(op, log, signal) {
      const exe = target();
      if (!exe) throw new Error(noInterp());
      try {
        await mainJob({ kind: 'pip', python: exe, op, package: pkg }, log, null, signal);
      } finally {
        pipLists.delete(exe);
        outdated.get(exe)?.delete(key);
      }
    }
    pipItemIds.add(id);
    return {
      id, category, name, description, size, homepage,
      async status() {
        const exe = target();
        if (!exe) return { available: false, reason: noInterp() };
        const list = await pipList(exe);
        if (!list.ok) return { available: false, reason: list.error };
        const version = list.packages.get(key);
        if (version) checkOutdated(exe);
        const latest = outdated.get(exe)?.get(key);
        return { installed: !!version, version, update: version && latest && latest !== version ? latest : undefined };
      },
      install: (log, _progress, signal) => job('install', log, signal),
      update: (log, _progress, signal) => job('upgrade', log, signal),
      uninstall: (log, _progress, signal) => job('uninstall', log, signal),
    };
  }

  const PYTHON_TOOLS = [
    ['ruff', 'Ruff', tr('An extremely fast Python linter and code formatter.')],
    ['black', 'Black', tr('The uncompromising Python code formatter.')],
    ['mypy', 'mypy', tr('Static type checker for Python type hints.')],
    ['pytest', 'pytest', tr('Write small, readable tests that scale to complex functional testing.')],
    ['ipython', 'IPython', tr('A powerful interactive Python shell.')],
    ['jupyterlab', 'JupyterLab', tr('Notebooks, code and data in the browser.')],
    ['uv', 'uv', tr('A very fast Python package and project manager, written in Rust.')],
    ['pre-commit', 'pre-commit', tr('Runs checks such as Ruff and Black on every commit.')],
  ];

  // ---------- built-in catalog: portable database servers ----------
  let serverList = null;
  const servers = () => (serverList ||= ide.api.invoke('installer:servers').then((list) => new Map(list.map((s) => [s.name, s]))));
  const mb = (bytes) => tr('{size} MB download', { size: Math.round(bytes / 1048576) });
  const connectionUrl = (c) => c.url || `${c.kind === 'postgres' ? 'postgresql' : 'mysql'}://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`;

  function serverItem(name, title, description, homepage) {
    const job = (kind) => async (log, progress, signal) => {
      try { await mainJob({ kind, name }, log, progress, signal); } finally { serverList = null; }
    };
    return {
      id: `server:${name}`, category: 'databases', name: title, description, homepage,
      async status() {
        const s = (await servers()).get(name);
        const detail = s.running ? tr('Listening on 127.0.0.1:{port}', { port: s.port })
          : s.installed ? tr('Stopped (port {port})', { port: s.port }) : tr('Portable install for your user account; no administrator rights needed.');
        return { installed: s.installed, running: s.running, version: s.version, detail, size: mb(s.size) };
      },
      install: job('server-install'),
      uninstall: job('server-uninstall'),
      start: job('server-start'),
      stop: job('server-stop'),
      confirmUninstall: tr('Removing {name} deletes its data directory, including every database in it.', { name: title }),
      actions: [
        {
          label: tr('Add as Data Source'),
          when: (st) => st.running && typeof ide.database?.addDataSource === 'function',
          run: async () => {
            await ide.database.addDataSource(await ide.api.invoke('installer:serverConnection', name));
            return tr('Added to the data sources.');
          },
        },
        {
          label: tr('Copy Connection URL'),
          when: (st) => st.installed,
          run: async () => {
            await navigator.clipboard.writeText(connectionUrl(await ide.api.invoke('installer:serverConnection', name)));
            return tr('Connection URL copied, including the password.');
          },
        },
      ],
    };
  }

  // ---------- built-in catalog: system tools through winget ----------
  let systemState = null;
  const SYSTEM = [
    ['git', 'Git.Git', 'Git', tr('Distributed version control, used by the Git tool window and commit dialog.'), 'https://git-scm.com/'],
    ['python313', 'Python.Python.3.13', 'Python 3.13', tr('The Python 3.13 interpreter from python.org, for new virtual environments.'), 'https://www.python.org/'],
    ['node', 'OpenJS.NodeJS.LTS', 'Node.js LTS', tr('JavaScript runtime with npm, needed by many web and tooling projects.'), 'https://nodejs.org/'],
    ['gh', 'GitHub.cli', 'GitHub CLI', tr('GitHub on the command line, used to share projects on GitHub and list pull requests.'), 'https://cli.github.com/'],
  ];
  const systemStatus = () => (systemState ||= ide.api.invoke('installer:system', SYSTEM.map(([key]) => key)));

  function systemItem([key, wingetId, name, description, homepage]) {
    return {
      id: `system:${key}`, category: 'system', name, description, homepage,
      async status() {
        const s = (await systemStatus())[key];
        return {
          installed: s.installed, version: s.version, detail: s.detail, available: s.available,
          reason: s.reason === 'no-winget' ? tr('winget is not available on this computer. Install App Installer from the Microsoft Store.') : undefined,
        };
      },
      confirm: tr('{name} will be installed system-wide with winget:', { name })
        + `\n\n\`winget install --id ${wingetId} -e --accept-source-agreements --accept-package-agreements\`\n\n`
        + tr('Windows may ask for administrator permission. Restart PyIDE afterwards so the new PATH applies.'),
      install: async (log, progress, signal) => {
        try { await mainJob({ kind: 'winget', id: wingetId }, log, progress, signal); } finally { systemState = null; }
      },
    };
  }

  // ---------- built-in catalog: PyIDE's own Python ----------
  // The official python.org build (main/installer/python.js) under ~/.pyide/python/<version>, listed by the interpreter
  // picker through the interpreters.extra setting once it is installed, and taken off the list when it is removed.
  let pythonList = null;
  const pythons = () => (pythonList ||= ide.api.invoke('installer:pythons').then((list) => new Map(list.map((p) => [p.key, p]))));
  async function listInterpreter(exe, on) {
    const extra = ide.settings.get('interpreters.extra', []);
    const has = extra.some((p) => ide.util.samePath(p, exe));
    if (on === has) return;
    ide.settings.set('interpreters.extra', on ? [...extra, exe] : extra.filter((p) => !ide.util.samePath(p, exe)));
    await ide.reloadInterpreters?.();
  }
  // Is `interp` this Python, or a venv made from it (pyvenv.cfg's home)?
  async function basedOn(interp, dir) {
    if (!interp?.executable || interp.invalid) return false;
    if (ide.util.isUnder(interp.executable, dir)) return true;
    const file = ide.util.joinPath(ide.util.dirname(ide.util.dirname(interp.executable)), 'pyvenv.cfg');
    const cfg = (await ide.api.exists(file)) ? await ide.api.read(file).catch(() => '') : '';
    const home = /^\s*home\s*=\s*(.+?)\s*$/im.exec(cfg || '')?.[1];
    return !!home && ide.util.isUnder(home, dir);
  }
  // The IDE's own helpers (semantic highlighting, refactoring, the console) run in the project interpreter and hold its
  // files; before this Python is removed the project moves to another interpreter, or to none.
  async function release(p) {
    await listInterpreter(p.exe, false);
    if (ide.root && await basedOn(ide.currentInterp(), p.dir)) {
      const others = [];
      for (const i of ide.interps || []) if (!i.unsupported && !(await basedOn(i, p.dir))) others.push(i);
      const key = `interpreter.${ide.root}`;
      if (others[0]) ide.settings.set(key, others[0].executable); else ide.settings.set(key, undefined);
      await ide.reloadInterpreters?.();
      if (!others[0] && ide.currentInterp() && await basedOn(ide.currentInterp(), p.dir)) {
        ide.interps = (ide.interps || []).filter((i) => !ide.util.isUnder(i.executable, p.dir));
        ide.emit('interpreterChanged', ide.currentInterp());
      }
    }
  }
  function pythonItem(key) {
    const name = tr('PyIDE Python {version}', { version: key });
    const job = (kind) => async (log, progress, signal) => {
      const p = (await pythons()).get(key);
      if (kind === 'python-uninstall') await release(p);
      try {
        await mainJob({ kind, name: key }, log, progress, signal);
      } catch (err) {
        if (kind === 'python-uninstall') await listInterpreter(p.exe, true);
        throw err;
      } finally { pythonList = null; }
      if (kind === 'python-install') await listInterpreter(p.exe, true);
    };
    return {
      id: `python:${key}`, category: 'interpreters', name, homepage: 'https://www.nuget.org/packages/python',
      description: tr('The official Python {version} from python.org, installed for PyIDE only: no administrator rights and nothing added to PATH. It includes pip and venv; tkinter is not included.', { version: key }),
      async status() {
        const p = (await pythons()).get(key);
        return { installed: p.installed, version: p.version, size: mb(p.size), detail: p.installed ? p.exe : tr('Installs into {path}', { path: p.dir }) };
      },
      install: job('python-install'),
      uninstall: job('python-uninstall'),
      confirmUninstall: tr('Virtual environments made from {name} stop working once it is removed.', { name }),
      actions: [{
        label: tr('Use as Project Interpreter'),
        when: (st) => st.installed && !!ide.root,
        run: async () => {
          const p = (await pythons()).get(key);
          await listInterpreter(p.exe, true);
          ide.setInterpreter(p.exe);
          return tr('{name} is now the project interpreter.', { name });
        },
      }],
    };
  }
  const OWN_PYTHON = '3.13';

  const builtins = [
    pythonItem(OWN_PYTHON),
    ...PYTHON_TOOLS.map(([pkg, name, description]) => pip({ package: pkg, name, description })),
    serverItem('postgresql', 'PostgreSQL', tr('Open-source relational database server, from the EDB Windows binaries.'), 'https://www.postgresql.org/'),
    serverItem('mariadb', 'MariaDB', tr('MySQL-compatible database server, from the official MariaDB zip.'), 'https://mariadb.org/'),
    serverItem('mongodb', 'MongoDB', tr('Document database server (Community Edition), from the official MongoDB zip.'), 'https://www.mongodb.com/'),
    ...SYSTEM.map(systemItem),
  ];
  (ide.installables ||= []).push(...builtins);

  // ---------- view ----------
  let host = null;
  let sideEl = null;
  let cardsEl = null;
  let targetEl = null;
  let searchEl = null;
  const view = { filter: 'all', query: '' }; // filter: all | installed | updates | cat:<category>
  const cards = new Map(); // id -> card parts

  const installedNow = (id) => { const p = entry(id).phase; const st = entry(id).status; return p === 'installed' || p === 'running' || (BUSY_PHASES.has(p) || p === 'failed') && !!(st?.installed || st?.running); };
  const hasUpdate = (id) => !!entry(id).status?.update && ['installed', 'running'].includes(entry(id).phase);
  const FILTERS = { all: () => true, installed: (it) => installedNow(it.id), updates: (it) => hasUpdate(it.id) };
  const matchesFilter = (it) => (view.filter.startsWith('cat:') ? it.category === view.filter.slice(4) : FILTERS[view.filter](it));
  const matchesQuery = (it) => !view.query || [it.name, it.description, it.id, categoryLabel(it.category)]
    .some((t) => String(t || '').toLowerCase().includes(view.query));

  function categories() {
    const seen = [...new Set(items().map((it) => it.category))];
    const known = Object.keys(CATEGORIES);
    return seen.sort((a, b) => (known.includes(a) ? known.indexOf(a) : 99) - (known.includes(b) ? known.indexOf(b) : 99) || a.localeCompare(b));
  }

  function navRow(filter, label, count, isUser) {
    const row = el('div', `inst-nav${view.filter === filter ? ' selected' : ''}`);
    row.dataset.filter = filter;
    row.append(isUser ? userText('span', 'inst-nav-label', label) : el('span', 'inst-nav-label', label), el('span', 'inst-count', String(count)));
    row.onclick = () => { view.filter = filter; renderSide(); renderCards(); };
    return row;
  }

  function renderSide() {
    if (!sideEl) return;
    const all = items();
    sideEl.replaceChildren(
      el('div', 'inst-side-title', tr('Install Manager')),
      navRow('all', tr('All'), all.length),
      navRow('installed', tr('Installed'), all.filter((it) => installedNow(it.id)).length),
      navRow('updates', tr('Updates'), all.filter((it) => hasUpdate(it.id)).length),
      el('div', 'inst-side-head', tr('Categories')),
      ...categories().map((c) => navRow(`cat:${c}`, categoryLabel(c), all.filter((it) => it.category === c).length, !CATEGORIES[c])),
    );
  }

  function renderTarget() {
    if (!targetEl) return;
    const show = view.filter === 'cat:python' || view.filter === 'cat:drivers';
    targetEl.classList.toggle('hidden', !show);
    if (!show) return;
    const interp = ide.currentInterp();
    const change = el('button', 'inst-link', tr('Change…'));
    change.onclick = () => ide.runAction('ShowProjectStructureSettings');
    targetEl.replaceChildren(el('span', 'muted', tr('Packages install into the project interpreter:')),
      interp ? userText('span', 'inst-interp', interp.label) : el('span', 'inst-interp', tr('None selected')), change);
  }

  function renderCards() {
    if (!cardsEl) return;
    renderTarget();
    const shown = items().filter((it) => matchesFilter(it) && matchesQuery(it));
    const known = Object.keys(CATEGORIES);
    shown.sort((a, b) => (known.indexOf(a.category) + 1 || 99) - (known.indexOf(b.category) + 1 || 99));
    cardsEl.replaceChildren(...shown.map((it) => cardFor(it).root));
    if (!shown.length) cardsEl.appendChild(el('div', 'inst-empty muted', view.query ? tr('Nothing matches “{query}”.', { query: view.query }) : tr('Nothing here yet.')));
  }

  function cardFor(item) {
    if (cards.has(item.id) && cards.get(item.id).item === item) return cards.get(item.id);
    const root = el('div', 'inst-card');
    root.dataset.id = item.id;
    const head = el('div', 'inst-card-head');
    const name = userText('span', 'inst-name', item.name);
    const version = userText('span', 'inst-version');
    const badge = el('span', 'inst-badge');
    const links = el('span', 'inst-links');
    if (item.homepage) {
      const home = el('button', 'inst-icon-btn', '↗');
      home.title = tr('Open Homepage');
      home.onclick = () => ide.api.invoke('shell:openExternal', item.homepage);
      links.appendChild(home);
    }
    head.append(name, version, el('span', 'spacer'), links, badge);
    const desc = el('div', 'inst-desc', item.description || '');
    const meta = el('div', 'inst-meta');
    const message = el('div', 'inst-message');
    const bar = el('div', 'inst-bar');
    const progressEl = el('div', 'inst-progress');
    progressEl.appendChild(bar);
    const buttons = el('div', 'inst-buttons');
    const logBox = el('details', 'inst-logbox');
    const log = el('pre', 'inst-log');
    logBox.append(el('summary', null, tr('Log')), log);
    root.append(head, desc, meta, message, progressEl, buttons, logBox);
    const parts = { item, root, version, badge, meta, message, bar, progressEl, buttons, logBox, log };
    cards.set(item.id, parts);
    updateCard(item);
    flushLog(item.id);
    return parts;
  }

  function button(label, cls, onclick, op) {
    const b = el('button', cls, label);
    if (op) b.dataset.op = op;
    b.onclick = onclick;
    return b;
  }

  function buttonsFor(item, s) {
    if (BUSY_PHASES.has(s.phase)) return [button(tr('Cancel'), 'secondary', () => cancel(item), 'cancel')];
    if (s.phase === 'checking' || s.phase === 'unknown' || s.phase === 'unavailable') return [];
    if (s.phase === 'failed' && !s.status) return [button(tr('Check Again'), 'secondary', () => check(item), 'check')];
    const st = s.status || {};
    const base = s.phase === 'failed' ? phaseOf(st) : s.phase;
    const out = [];
    const opButton = (op, primary) => typeof item[op] === 'function' && out.push(button(OP_TITLES[op], primary ? 'primary' : 'secondary', () => run(item, op), op));
    if (base === 'notInstalled') opButton('install', true);
    if (base === 'installed' || base === 'running') {
      if (st.update && item.update) out.push(button(tr('Update to {version}', { version: st.update }), 'primary', () => run(item, 'update'), 'update'));
      if (base === 'installed') opButton('start', true);
      if (base === 'running') opButton('stop', false);
      for (const a of item.actions || []) {
        if (!a.when || a.when(st)) out.push(button(a.label, 'secondary', () => runAction(item, a), 'action'));
      }
      opButton('uninstall', false);
    }
    return out;
  }

  function updateCard(item) {
    const c = cards.get(item.id);
    if (!c || c.item !== item) return;
    const s = entry(item.id);
    const st = s.status || {};
    c.root.dataset.phase = s.phase;
    const [label, tone] = BADGES[s.phase];
    c.badge.textContent = label;
    c.badge.className = `inst-badge ${tone}`;
    c.version.textContent = st.version ? `v${st.version}` : '';
    const meta = [st.detail, item.size || st.size].filter(Boolean);
    c.meta.replaceChildren(...meta.map((m) => el('span', null, m)));
    const message = s.phase === 'unavailable' ? st.reason : s.error ? tr('Error: {error}', { error: s.error }) : s.notice;
    c.message.textContent = message || '';
    c.message.className = `inst-message${s.phase === 'unavailable' ? ' warn' : s.error ? ' error' : ''}`;
    if (s.error) c.message.dataset.userText = ''; else delete c.message.dataset.userText;
    const busy = BUSY_PHASES.has(s.phase);
    c.progressEl.classList.toggle('hidden', !busy);
    c.bar.classList.toggle('indeterminate', busy && s.progress === null);
    c.bar.style.width = s.progress === null ? '' : `${Math.round(s.progress * 100)}%`;
    c.buttons.replaceChildren(...buttonsFor(item, s));
    c.logBox.classList.toggle('hidden', !s.log);
  }

  // Log text arrives in bursts (pip, downloads); repaint each card's log at most every 50 ms. A timer, not
  // requestAnimationFrame, because frames stop while the window is hidden and the log would go stale.
  const dirtyLogs = new Set();
  let logTimer = 0;
  function scheduleLog(id) {
    dirtyLogs.add(id);
    if (!logTimer) logTimer = setTimeout(() => { logTimer = 0; for (const d of dirtyLogs) flushLog(d); dirtyLogs.clear(); }, 50);
  }
  function flushLog(id) {
    const c = cards.get(id);
    if (!c) return;
    // Progress bars redraw a line with carriage returns; keep only the last state of each line.
    const text = entry(id).log.split('\n').map((l) => l.split('\r').filter(Boolean).pop() || '').join('\n');
    const atBottom = c.log.scrollHeight - c.log.scrollTop - c.log.clientHeight < 30;
    c.log.textContent = text;
    if (atBottom) c.log.scrollTop = c.log.scrollHeight;
    c.logBox.classList.toggle('hidden', !text);
  }

  function refresh() {
    pipLists.clear();
    outdatedRequested.clear();
    serverList = null;
    systemState = null;
    return Promise.all(items().map((it) => check(it)));
  }

  function mount(container) {
    host = container;
    container.classList.add('inst-tab');
    const page = el('div', 'inst-page');
    page.id = 'installManager';
    sideEl = el('aside', 'inst-side');
    const main = el('div', 'inst-main');
    const top = el('div', 'inst-top');
    searchEl = el('input', 'input inst-search');
    searchEl.id = 'installSearch';
    searchEl.placeholder = tr('Search installables');
    searchEl.oninput = () => { view.query = searchEl.value.trim().toLowerCase(); renderCards(); };
    const refreshBtn = el('button', 'inst-icon-btn inst-refresh', '⟳');
    refreshBtn.title = tr('Refresh');
    refreshBtn.onclick = () => refresh();
    top.append(searchEl, refreshBtn);
    targetEl = el('div', 'inst-target hidden');
    cardsEl = el('div', 'inst-cards');
    cardsEl.id = 'installCards';
    main.append(top, targetEl, cardsEl);
    page.append(sideEl, main);
    container.appendChild(page);
    renderSide();
    renderCards();
  }

  function open(category) {
    if (category) view.filter = `cat:${category}`;
    const first = !host;
    ide.openCustomTab({
      id: TAB_ID,
      title: tr('Install Manager'),
      icon: '⤓',
      mount,
      onClose() { host = sideEl = cardsEl = targetEl = searchEl = null; cards.clear(); },
    });
    renderSide();
    renderCards();
    if (first) refresh();
  }

  // Items registered after the page was built get a card and a first status check.
  ide.on('installablesChanged', () => {
    if (!host) return;
    renderSide();
    renderCards();
    for (const it of items()) if (entry(it.id).phase === 'unknown') check(it);
  });
  ide.on('interpreterChanged', () => {
    pipLists.clear();
    if (!host) return;
    renderTarget();
    for (const it of items()) if (pipItemIds.has(it.id)) check(it);
  });

  // ---------- status bar: visible while jobs run ----------
  const statusItem = el('span', 'inst-status hidden');
  statusItem.id = 'installerStatus';
  statusItem.onclick = () => open();
  ide.registerStatusItem({ order: 9, el: statusItem });
  function renderStatusItem() {
    const busy = [...states.values()].filter((s) => BUSY_PHASES.has(s.phase)).length;
    statusItem.textContent = busy ? `⤓ ${tr('Install Manager: {count} running', { count: busy })}` : '';
    statusItem.classList.toggle('hidden', !busy);
  }

  function register(item) {
    (ide.installables ||= []).push(item);
    ide.emit('installablesChanged');
    return item;
  }

  ide.registerAction({ id: 'InstallManager', title: tr('Install Manager'), run: () => open() });
  // An installed PyIDE Python missing from the list (settings reset or copied) is listed again; with no usable
  // interpreter at all, one notification per session offers to install it.
  ide.on('ready', async () => {
    const list = await pythons().catch(() => new Map());
    for (const p of list.values()) if (p.installed) await listInterpreter(p.exe, true);
    await ide.reloadInterpreters?.();
    if ((ide.interps || []).some((i) => !i.invalid && !i.unsupported)) return;
    const item = items().find((it) => it.id === `python:${OWN_PYTHON}`);
    ide.notifications?.notify({
      title: tr('No Python interpreter found'),
      text: tr('Install {name} ({size}) to run, debug and test Python code without installing Python on the system.', { name: item.name, size: mb(list.get(OWN_PYTHON)?.size || 0) }),
      kind: 'warn', group: 'Python Interpreter',
      actions: [{ label: tr('Install {name}', { name: item.name }), run: () => { open(item.category); run(item, 'install'); } }],
    });
  });

  // run(id, op): an operation started from elsewhere (New Project's Download JDK), with the card's log, task and notification.
  const runById = (id, op = 'install') => { const it = items().find((i) => i.id === id); return it ? run(it, op) : Promise.resolve(); };
  // job(spec, log, progress, signal): a job of main/features/installer.js (toolchain-install…) for another plugin's installable.
  ide.installer = { open, refresh, register, pip, run: runById, job: mainJob, state: (id) => ({ ...entry(id), ctl: undefined }) };
  ide.emit('installablesChanged');
})();
