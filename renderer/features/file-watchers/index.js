// File Watchers, as in PyCharm (Settings › File Watchers): a watcher runs a program when a project file matching its
// file type is saved, or, if asked, when it changes on disk (main/project-watch.js). Runs are debounced per file and
// never overlap for the same file; output goes to a "File Watchers" tab in the Run window, failures to a notification.
// Watchers are kept per project in the user's settings (`fileWatchers:<project>`), never in the project, and nothing
// runs in Safe Mode (main/features/file-watchers.js checks trust again).
(() => {
  const { el, basename, joinPath, isUnder } = ide.util;
  const keyOf = (root = ide.root) => `fileWatchers:${root}`;
  const DEBOUNCE_MS = 400;
  // Disk events this soon after the IDE saved a file, or after a watcher ran on it, are those writes, not external ones.
  const OWN_WRITE_MS = 2500;
  const NOISE = /(^|[\\/])(\.git|__pycache__|node_modules|\.venv|venv|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.tox|\.nox|\.idea)([\\/]|$)/i;
  const MACROS = '$FilePath$, $FileName$, $FileNameWithoutExtension$, $FileExt$, $FileDir$, $FileRelativePath$, $ProjectDir$, $PyInterpreterPath$, $PyInterpreterDirectory$';

  const newId = () => `fw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const DEFAULTS = {
    name: '', enabled: true, fileType: '', scope: 'project', scopeDir: '', program: '', args: '', cwd: '$FileDir$',
    autoSave: false, external: false, showConsole: 'error',
  };
  // Ready-made watchers; product names stay in English. The "ruff format on save" case is Actions on Save.
  const TEMPLATES = [
    { label: () => tr('Custom'), w: { name: 'Custom' } },
    { label: () => 'Black', w: { name: 'Black', fileType: '*.py', program: '$PyInterpreterPath$', args: '-m black $FilePath$', cwd: '$ProjectDir$' } },
    { label: () => 'pyside6-uic (.ui → .py)', w: { name: 'pyside6-uic', fileType: '*.ui', program: '$PyInterpreterDirectory$\\pyside6-uic', args: '$FileName$ -o ui_$FileNameWithoutExtension$.py' } },
    { label: () => 'pyuic5 (.ui → .py)', w: { name: 'pyuic5', fileType: '*.ui', program: '$PyInterpreterPath$', args: '-m PyQt5.uic.pyuic $FileName$ -o ui_$FileNameWithoutExtension$.py' } },
    { label: () => 'Sass (.scss → .css)', w: { name: 'Sass', fileType: '*.scss;*.sass', program: 'sass', args: '--no-source-map $FileName$:$FileNameWithoutExtension$.css' } },
  ];

  const clean = (list) => (Array.isArray(list) ? list : []).filter((w) => w && typeof w === 'object' && typeof w.id === 'string')
    .map((w) => ({ ...DEFAULTS, ...w, enabled: w.enabled !== false, showConsole: ['always', 'error', 'never'].includes(w.showConsole) ? w.showConsole : 'error' }));
  const watchers = () => (ide.root ? clean(ide.settings.get(keyOf(), [])) : []);

  // ---------- matching ----------
  // "*.ui", "*.scss;*.sass", "src/**/*.py": a pattern with a slash matches the path relative to the project, else the name.
  const globCache = new Map();
  function globRegex(glob) {
    if (!globCache.has(glob)) {
      let re = '';
      for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      globCache.set(glob, new RegExp(`^${re}$`, 'i'));
    }
    return globCache.get(glob);
  }
  function matches(w, path) {
    if (!w.enabled || !w.program?.trim() || !ide.root || !isUnder(path, ide.root)) return false;
    const rel = path.slice(ide.root.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
    if (NOISE.test(rel)) return false;
    if (w.scope === 'folder' && w.scopeDir?.trim() && !isUnder(path, joinPath(ide.root, w.scopeDir.trim().replace(/\//g, '\\')))) return false;
    return String(w.fileType || '').split(/[;,]/).map((g) => g.trim().replace(/\\/g, '/')).filter(Boolean)
      .some((g) => globRegex(g).test(g.includes('/') ? rel : basename(path)));
  }

  // ---------- running ----------
  const files = new Map(); // lower-cased path -> {path, timer, running, queue: Map(watcher id -> watcher)}
  const ownWrites = new Map(); // lower-cased path -> time of the IDE's save or a watcher's run
  const history = []; // finished runs this session, for tests and the console: {watcher, file, code, error?}
  let session = null;

  function consoleSession() {
    session = ide.run.outputSession('fileWatchers', tr('File Watchers'));
    if (!session.con) session.console();
    return session;
  }
  const showConsole = (s = consoleSession()) => ide.run.show(s);

  function trigger(path, list) {
    if (ide.trusted === false || !list.length) return;
    const k = path.toLowerCase();
    let f = files.get(k);
    if (!f) files.set(k, (f = { path, timer: null, running: false, queue: new Map() }));
    for (const w of list) f.queue.set(w.id, w);
    // A run in progress for this file takes the queued watchers when it ends; until then, every trigger restarts the wait.
    if (f.running) return;
    clearTimeout(f.timer);
    f.timer = setTimeout(() => drain(f), DEBOUNCE_MS);
  }

  async function drain(f) {
    f.timer = null;
    f.running = true;
    try {
      while (f.queue.size && ide.trusted !== false) {
        const batch = [...f.queue.values()];
        f.queue.clear();
        for (const w of batch) await runWatcher(w, f.path);
      }
    } finally {
      f.running = false;
      ownWrites.set(f.path.toLowerCase(), Date.now());
      if (!f.queue.size) files.delete(f.path.toLowerCase());
    }
  }

  function failed(w, s, text) {
    const note = { title: tr("File watcher '{name}' failed", { name: w.name }), text, kind: 'error', group: 'File Watchers', raw: true,
      actions: [{ label: tr('Show Console'), run: () => showConsole(s) }] };
    if (ide.notifications?.notify) ide.notifications.notify(note);
    else ide.run.notifyError(note.title, text);
  }

  const errorText = (r) => ({
    untrusted: tr('The project is not trusted (Safe Mode).'),
    outside: tr('The file is not in the project.'),
    noProgram: tr('Program is not specified.'),
    noCwd: tr('Working directory does not exist: {path}', { path: r.cwd }),
  })[r.error] || String(r.error);

  async function runWatcher(w, path) {
    const s = consoleSession();
    s.rerun = () => trigger(path, [w]);
    const con = s.con;
    if (w.showConsole === 'always') showConsole(s);
    con.append(`[${new Date().toLocaleTimeString()}] ${w.name}: ${ide.util.rel(path)}\n`, 'sys');
    let r;
    try {
      r = await ide.api.invoke('fileWatchers:run', { root: ide.root, file: path, program: w.program, args: w.args, cwd: w.cwd, pyInterpreter: ide.currentInterp()?.executable || '' });
    } catch (err) {
      r = { error: err.message };
    }
    if (r.error) {
      con.append(`${errorText(r)}\n`, 'err');
      history.push({ watcher: w.name, file: path, code: null, error: r.error });
      if (r.error !== 'untrusted') {
        if (w.showConsole !== 'never') showConsole(s);
        failed(w, s, errorText(r));
      }
      return;
    }
    con.append(`${r.command}\n`, 'sys');
    s.setIcon('▶', 'running');
    const code = await new Promise((resolve) => ide.proc.attach(r.id, {
      data: (text, stream) => con.append(text, stream === 'err' ? 'err' : null),
      exit: resolve,
    }));
    con.append(`${tr('Process finished with exit code {code}', { code: code ?? 1 })}\n\n`, 'sys');
    s.setIcon('▶', code === 0 ? 'done' : 'failed');
    history.push({ watcher: w.name, file: path, code: code ?? 1 });
    ownWrites.set(path.toLowerCase(), Date.now());
    // A watcher that rewrote the file it watches (Black): the open editor follows.
    await ide.reloadFromDisk([path]);
    if (code !== 0) {
      if (w.showConsole !== 'never') showConsole(s);
      failed(w, s, tr('Exit code {code}', { code: code ?? 1 }));
    }
  }

  // ---------- triggers ----------
  // Saved in the IDE: explicit saves, auto saves, and saves the auto-save option below makes.
  ide.on('fileSaved', (tab) => {
    if (!tab?.path) return;
    ownWrites.set(tab.path.toLowerCase(), Date.now());
    trigger(tab.path, watchers().filter((w) => matches(w, tab.path)));
  });

  // "Auto-save edited files to trigger the watcher": an edit saves the file after a short pause.
  const autoSaveTimers = new Map();
  // One listener per model: a model can be announced again (reopened over a model Monaco still holds), and the
  // listener goes with the model when it is disposed (the file's last tab closed).
  const listening = new WeakSet();
  ide.on('fileOpened', (tab) => {
    const path = tab?.path;
    const model = tab?.model || tab?.doc?.model;
    if (!path || !model?.onDidChangeContent || listening.has(model)) return;
    listening.add(model);
    const sub = model.onDidChangeContent(() => {
      if (ide.trusted === false || !watchers().some((w) => w.autoSave && matches(w, path))) return;
      clearTimeout(autoSaveTimers.get(path));
      autoSaveTimers.set(path, setTimeout(() => {
        autoSaveTimers.delete(path);
        const t = ide.findTab(path);
        if (t && ide.isDirty(t)) ide.saveTab(t);
      }, 1000));
    });
    model.onWillDispose?.(() => {
      sub.dispose();
      listening.delete(model);
      clearTimeout(autoSaveTimers.get(path));
      autoSaveTimers.delete(path);
    });
  });

  // "Trigger the watcher on external changes": files changed on disk by another program (project-watch).
  ide.api.on('watch:changed', async ({ root, paths }) => {
    if (ide.trusted === false || !ide.root || !root || !ide.util.samePath(root, ide.root)) return;
    const list = watchers().filter((w) => w.external);
    if (!list.length) return;
    for (const p of paths || []) {
      const own = ownWrites.get(p.toLowerCase());
      if (own && Date.now() - own < OWN_WRITE_MS) continue;
      if (files.get(p.toLowerCase())?.running) continue;
      const hit = list.filter((w) => matches(w, p));
      if (hit.length && await ide.api.exists(p)) trigger(p, hit);
    }
  });

  ide.on('projectOpened', () => {
    for (const f of files.values()) clearTimeout(f.timer);
    files.clear();
  });

  // ---------- Settings › File Watchers ----------
  ide.settingsPages.push({
    id: 'fileWatchers', title: () => tr('File Watchers'),
    keywords: 'file watchers watcher black sass scss pyside6 uic pyuic external tool on save 파일 감시기 감시 외부 도구',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('File Watchers'));
      if (!ide.root) { s.appendChild(el('div', 'muted', tr('Open a project to set up its file watchers.'))); return; }
      const key = keyOf();
      const list = clean(ctx.value(key) ?? []);
      let selected = list[0]?.id || null;
      const commit = () => ctx.set(key, JSON.parse(JSON.stringify(list)));

      s.appendChild(el('div', 'fw-note muted', tr('Watchers belong to this project and are kept in your settings, not in the project folder.')));
      if (ide.trusted === false) s.appendChild(el('div', 'fw-warn', tr('Safe Mode: file watchers do not run, since they start programs and this project is not trusted.')));
      const bar = el('div', 'fw-bar');
      const table = el('div', 'fw-list');
      const form = el('div', 'fw-form');
      s.append(bar, table, form);

      const tool = (id, icon, title, run) => {
        const b = el('button', 'fw-tool', icon);
        b.dataset.fw = id;
        b.title = title;
        b.onclick = (e) => { e.preventDefault(); run(e); };
        bar.appendChild(b);
        return b;
      };
      tool('add', '＋', tr('Add Watcher'), (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        ide.ui.contextMenu(r.left, r.bottom + 2, TEMPLATES.map((tpl) => ({ label: tpl.label(), run: () => {
          const w = { ...DEFAULTS, ...tpl.w, id: newId() };
          list.push(w);
          selected = w.id;
          commit();
          render();
          form.querySelector('[data-fw-key="name"]')?.select();
        } })));
        // Core menus sit below dialogs; this one opens from the Settings dialog.
        for (const m of document.querySelectorAll('#menuHost .context-menu')) m.style.zIndex = 80;
      });
      tool('remove', '−', tr('Remove Watcher'), () => {
        const i = list.findIndex((w) => w.id === selected);
        if (i < 0) return;
        list.splice(i, 1);
        selected = list[Math.min(i, list.length - 1)]?.id || null;
        commit();
        render();
      });
      tool('copy', '⧉', tr('Copy Watcher'), () => {
        const w = list.find((x) => x.id === selected);
        if (!w) return;
        const copy = { ...w, id: newId(), name: `${w.name} (1)` };
        list.splice(list.indexOf(w) + 1, 0, copy);
        selected = copy.id;
        commit();
        render();
      });

      function renderList() {
        table.replaceChildren();
        const head = el('div', 'fw-row fw-head');
        head.append(el('span', null, ''), el('span', null, tr('Name')), el('span', null, tr('File type')), el('span', null, tr('Program')));
        table.appendChild(head);
        for (const w of list) {
          const row = el('div', `fw-row${w.id === selected ? ' selected' : ''}`);
          row.dataset.id = w.id;
          const on = el('input', 'fw-enabled');
          on.type = 'checkbox';
          on.checked = w.enabled;
          on.title = tr('Enabled');
          on.onclick = (e) => e.stopPropagation();
          on.onchange = () => { w.enabled = on.checked; commit(); };
          const name = el('span', 'fw-name', w.name);
          name.dataset.userText = '';
          const type = el('span', 'fw-type', w.fileType);
          type.dataset.userText = '';
          const prog = el('span', 'fw-prog', [w.program, w.args].filter(Boolean).join(' '));
          prog.dataset.userText = '';
          row.append(on, name, type, prog);
          row.onclick = () => { selected = w.id; render(); };
          table.appendChild(row);
        }
        if (!list.length) table.appendChild(el('div', 'fw-none muted', tr('No file watchers. Click ＋ to add one.')));
      }

      function renderForm() {
        form.replaceChildren();
        const w = list.find((x) => x.id === selected);
        if (!w) return;
        const field = (label, input, k) => {
          input.dataset.fwKey = k;
          form.appendChild(ctx.ui.fieldRow(`${label}:`, input));
          return input;
        };
        const text = (k, label, placeholder = '') => {
          const input = el('input');
          input.value = w[k] || '';
          input.placeholder = placeholder;
          input.oninput = () => { w[k] = input.value; commit(); renderList(); };
          return field(label, input, k);
        };
        const select = (k, label, options) => {
          const input = el('select');
          for (const [value, text] of options) input.add(new Option(text, value));
          input.value = w[k];
          input.onchange = () => { w[k] = input.value; commit(); renderForm(); };
          return field(label, input, k);
        };
        const check = (k, label) => {
          const row = el('label', 'fw-check');
          const input = el('input');
          input.type = 'checkbox';
          input.checked = !!w[k];
          input.dataset.fwKey = k;
          input.onchange = () => { w[k] = input.checked; commit(); };
          row.append(input, el('span', null, ` ${label}`));
          form.appendChild(row);
        };
        text('name', tr('Name'));
        text('fileType', tr('File type'), tr('*.ui;*.scss or src/**/*.py'));
        select('scope', tr('Scope'), [['project', tr('Project Files')], ['folder', tr('Folder')]]);
        if (w.scope === 'folder') text('scopeDir', tr('Folder'), tr('Relative to the project, e.g. ui'));
        text('program', tr('Program'), tr('For example sass or $PyInterpreterPath$'));
        text('args', tr('Arguments'), '$FilePath$');
        text('cwd', tr('Working directory'), '$FileDir$');
        form.appendChild(el('div', 'fw-hint muted', tr('Macros: {macros}', { macros: MACROS })));
        check('autoSave', tr('Auto-save edited files to trigger the watcher'));
        check('external', tr('Trigger the watcher on external changes'));
        select('showConsole', tr('Show console'), [['always', tr('Always')], ['error', tr('On error')], ['never', tr('Never')]]);
      }

      function render() { renderList(); renderForm(); }
      render();
    },
  });

  ide.fileWatchers = {
    // The current project's watchers, and the runs finished this session ({watcher, file, code, error?}).
    list: watchers,
    history: () => history.slice(),
    busy: () => [...files.values()].some((f) => f.running || f.timer),
    templates: () => TEMPLATES.map((t) => ({ label: t.label(), ...t.w })),
  };
})();
