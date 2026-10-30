// "Create a virtual environment?" A bar above the editors when a trusted project with requirements.txt,
// pyproject.toml or Pipfile opens with no virtual environment and no usable interpreter configured (none chosen, or
// the chosen one is gone), like PyCharm's notification for such projects. Create .venv makes the environment with the
// newest base interpreter (`uv venv` in a uv project), selects it as the project interpreter and installs the
// dependencies through the packages plugin; Choose Interpreter… opens Settings › Python Interpreter; Don't Ask Again
// is remembered per project (`venvPrompt.ignore:<project>`). Tools › Create Virtual Environment… asks for the
// location and base interpreter. Safe Mode: no prompt, and nothing is created.
(() => {
  if (ide.detached) return;
  const { $, el, samePath, joinPath, basename, isUnder } = ide.util;
  const IGNORE = (root) => `venvPrompt.ignore:${root}`;
  const SAFE_MODE = () => tr('Virtual environments cannot be created in Safe Mode. Trust the project first.');
  const closed = new Set(); // projects whose bar was closed this session (lower-case)
  const bar = el('div', 'venv-bar hidden');
  bar.id = 'venvBar';
  $('center').insertBefore(bar, $('editorArea'));
  let working = false; // creating the environment or installing into it
  let seq = 0;
  let hideTimer = null;

  // Working local interpreters: not remote targets, and not the project's chosen one when it is invalid.
  const localInterps = () => ide.interps.filter((i) => !i.target && !i.invalid);
  const versionKey = (v) => String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
  const newer = (a, b) => {
    const x = versionKey(a.version);
    const y = versionKey(b.version);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  };
  // Base interpreters (not virtual environments), newest first.
  const basesOf = (info) => localInterps().filter((i) => info.bases.some((b) => samePath(b, i.executable))).sort(newer);

  const inspect = () => ide.api.invoke('venv-setup:inspect', ide.root, localInterps().map((i) => i.executable)).catch(() => null);

  // Why the prompt shows ({missing: the configured interpreter that is gone, or null; broken: a virtual environment
  // of the project whose python.exe is gone or does not start, or null}), or null when it does not.
  function reason(info) {
    const root = ide.root;
    if (!root || ide.trusted === false || !info?.trusted) return null;
    if (ide.settings.get(IGNORE(root), false) || closed.has(root.toLowerCase())) return null;
    if (!info.files.length) return null;
    if (localInterps().some((i) => isUnder(i.executable, root))) return null;
    const configured = ide.settings.get(`interpreter.${root}`, '');
    if (configured && ide.interps.some((i) => !i.invalid && samePath(i.executable, configured))) return null;
    // A venv no working interpreter is listed from counts as none.
    return { missing: configured || null, broken: info.venv || null };
  }

  function hide() {
    clearTimeout(hideTimer);
    bar.classList.add('hidden');
    bar.replaceChildren();
    delete bar.dataset.state;
  }

  async function evaluate() {
    const my = ++seq;
    if (working) return;
    const info = ide.root && ide.trusted !== false ? await inspect() : null;
    if (my !== seq || working) return;
    const why = reason(info);
    if (why) showPrompt(info, why); else if (bar.dataset.state === 'prompt') hide();
  }

  const link = (label, action, run) => {
    const a = el('a', 'venv-bar-link', label);
    a.dataset.action = action;
    a.onclick = run;
    return a;
  };
  function closeButton(run) {
    const x = el('span', 'venv-bar-close', '×');
    x.dataset.action = 'close';
    x.title = tr('Close');
    x.onclick = run;
    return x;
  }

  // The default location: .venv, else venv, else .venv1, .venv2…
  async function freeDir(root) {
    for (const name of ['.venv', 'venv']) if (!(await ide.api.exists(joinPath(root, name)))) return joinPath(root, name);
    for (let i = 1; ; i++) if (!(await ide.api.exists(joinPath(root, `.venv${i}`)))) return joinPath(root, `.venv${i}`);
  }

  function showPrompt(info, why) {
    clearTimeout(hideTimer);
    const root = ide.root;
    const base = basesOf(info)[0] || null;
    const useUv = !!info.uv;
    const files = info.files.join(', ');
    const text = el('span', 'venv-bar-text');
    const detail = why.broken
      ? tr('The virtual environment {path} does not work. The project has {files}.', { path: why.broken, files })
      : why.missing
        ? tr('The project interpreter {path} was not found. The project has {files} but no virtual environment.', { path: why.missing, files })
        : tr('No Python interpreter is configured for this project. It has {files} but no virtual environment.', { files });
    text.append(el('b', null, why.broken ? tr('Recreate the virtual environment?') : tr('Create a virtual environment?')), ' ', detail);
    const actions = el('span', 'venv-bar-actions');
    if (why.broken && (useUv || base)) {
      actions.append(link(tr('Recreate {name}', { name: basename(why.broken) }), 'recreate', () => recreate(why.broken)));
    } else if (useUv || base) {
      const create = link(tr('Create .venv'), 'create', async () => create_({ dir: await freeDir(root), base, uv: useUv, install: true }));
      create.title = useUv ? 'uv venv' : `${base.label} -m venv`; // command lines are user data
      actions.append(create);
    } else actions.append(el('span', 'muted', tr('No Python interpreter was found. Install Python first.')));
    actions.append(
      link(tr('Choose Interpreter…'), 'choose', () => ide.openSettings?.('interpreter')),
      link(tr("Don't Ask Again"), 'ignore', () => { ide.settings.set(IGNORE(root), true); hide(); }),
    );
    bar.replaceChildren(Object.assign(ide.icon('warning'), { className: 'ide-icon venv-bar-icon' }), text, actions, closeButton(() => { closed.add(root.toLowerCase()); hide(); }));
    bar.dataset.state = 'prompt';
    bar.classList.remove('hidden');
  }

  function showState(state, message) {
    clearTimeout(hideTimer);
    const text = el('span', 'venv-bar-text', message);
    bar.replaceChildren(el('span', 'venv-bar-icon', state === 'error' ? '⚠' : state === 'done' ? '✓' : '⏳'), text);
    if (state !== 'working') bar.appendChild(closeButton(hide));
    bar.dataset.state = state;
    bar.classList.remove('hidden');
    if (state === 'done') hideTimer = setTimeout(hide, 15000);
  }

  // Creates the environment, makes it the project interpreter and (install) installs what the dependency files ask.
  // If the user opens another project meanwhile, the environment stays where it was made but nothing more is done:
  // selecting the interpreter and installing act on the project that is open.
  async function create_({ dir, base, uv, install }) {
    const root = ide.root;
    if (!root || working) return false;
    const moved = () => !ide.root || !samePath(ide.root, root);
    const notSetUp = () => tr('Created {path}, but {project} was closed before the environment was set up for it. Check Settings › Python Interpreter when you open {project} again.', { path: dir, project: basename(root) });
    const leftBehind = (text) => {
      if (bar.dataset.state === 'working') hide();
      const note = { title: tr('Create Virtual Environment'), text, kind: 'warning', group: 'Virtual Environment', raw: true };
      if (ide.notifications?.notify) ide.notifications.notify(note); else ide.ui.alert(text);
      return false;
    };
    if (ide.trusted === false) { ide.ui.alert(SAFE_MODE()); return false; }
    if (await ide.api.exists(dir)) { ide.ui.alert(tr('{path} already exists', { path: dir })); return false; }
    working = true;
    seq++;
    try {
      showState('working', tr('Creating a virtual environment in {path}…', { path: dir }));
      const header = uv ? tr('Creating a virtual environment in {path} with uv', { path: dir })
        : tr('Creating a virtual environment in {path} with {interpreter}', { path: dir, interpreter: base.label });
      const code = await ide.packages.run(header, () => ide.api.invoke('venv-setup:create', root, { dir, base: base && { executable: base.executable }, uv }));
      if (code !== 0) {
        showState('error', code == null ? tr('Another package operation is running. Try again when it has finished.')
          : tr('Creating the virtual environment failed (exit code {code}). See the Python Packages window.', { code }));
        return false;
      }
      if (moved()) return leftBehind(notSetUp());
      const exe = joinPath(dir, 'Scripts\\python.exe');
      ide.settings.set(`interpreter.${root}`, exe);
      await ide.reloadInterpreters();
      // Venvs are found two levels deep in the project; one elsewhere is listed through interpreters.extra.
      if (!ide.interps.some((i) => samePath(i.executable, exe))) {
        ide.settings.set('interpreters.extra', [...ide.settings.get('interpreters.extra', []), exe]);
        await ide.reloadInterpreters();
      }
      if (moved()) return leftBehind(notSetUp());
      if (!samePath(ide.currentInterp()?.executable || '', exe)) ide.setInterpreter(exe);
      ide.refreshTree();
      let failed = null;
      if (install && ide.dependencies) {
        showState('working', tr('Installing dependencies into {path}…', { path: dir }));
        const notInstalled = () => tr('Created {path} and set it as the interpreter of {project}, but {project} was closed before the dependencies were installed.', { path: dir, project: basename(root) });
        const state = await ide.dependencies.check({ fresh: true });
        if (moved()) return leftBehind(notInstalled());
        for (const f of state.files.filter((x) => x.reqs.some((r) => r.status !== 'ok'))) {
          if (moved()) return leftBehind(notInstalled());
          const c = await ide.dependencies.install(f.path);
          if (c !== 0) { failed = c; break; }
        }
      }
      if (failed != null) {
        showState('error', tr('The virtual environment {path} was created, but installing the dependencies failed (exit code {code}). See the Python Packages window.', { path: dir, code: failed }));
      } else {
        showState('done', install
          ? tr('Created {path}, set it as the project interpreter and installed the dependencies.', { path: dir })
          : tr('Created {path} and set it as the project interpreter.', { path: dir }));
      }
      return true;
    } finally {
      working = false;
      // The project opened meanwhile was not evaluated while this was working.
      if (moved()) evaluate();
    }
  }

  // A virtual environment that does not work (its base Python was uninstalled, its python.exe deleted) goes to the
  // Recycle Bin, after a confirmation, and is made again in the same place with the newest base interpreter.
  async function recreate(dir) {
    if (!ide.root || working) return false;
    if (ide.trusted === false) { ide.ui.alert(SAFE_MODE()); return false; }
    const info = await inspect();
    if (!info?.trusted) { ide.ui.alert(SAFE_MODE()); return false; }
    const base = basesOf(info)[0] || null;
    if (!info.uv && !base) { ide.ui.alert(tr('No Python interpreter was found. Install Python first.')); return false; }
    const ok = await ide.ui.confirm(tr('Move the virtual environment {path} to the Recycle Bin and create it again?', { path: dir }),
      { title: tr('Recreate Virtual Environment'), ok: tr('Recreate') });
    if (!ok) return false;
    try { await ide.api.trash(dir); } catch (e) {
      ide.ui.alert(tr('Could not move {name} to the Recycle Bin: {error}', { name: basename(dir), error: ide.util.errorText(e) }));
      return false;
    }
    return create_({ dir, base, uv: !!info.uv, install: info.files.length > 0 });
  }

  // Tools › Create Virtual Environment…: location, base interpreter (or uv) and whether to install the dependencies.
  async function openDialog() {
    if (!ide.root) { ide.ui.alert(tr('Open a project to configure its interpreter.')); return; }
    if (ide.trusted === false) { ide.ui.alert(SAFE_MODE()); return; }
    const info = await inspect();
    if (!info?.trusted) { ide.ui.alert(SAFE_MODE()); return; }
    const bases = basesOf(info);
    const body = el('div', 'venv-dialog');
    const row = (label, control) => {
      const r = el('label', 'venv-dialog-row');
      r.append(el('span', 'venv-dialog-label', label), control);
      return r;
    };
    const loc = el('input', 'input');
    loc.id = 'venvDlgLocation';
    loc.value = await freeDir(ide.root);
    const base = el('select', 'input');
    base.id = 'venvDlgBase';
    if (info.uv) base.add(new Option('uv venv', '__uv'));
    for (const b of bases) base.add(new Option(`${b.label}   ${b.executable}`, b.executable));
    body.append(row(tr('Location:'), loc), row(tr('Base interpreter:'), base));
    let installBox = null;
    if (info.files.length) {
      const r = el('label', 'venv-dialog-check');
      installBox = el('input');
      installBox.type = 'checkbox';
      installBox.id = 'venvDlgInstall';
      installBox.checked = true;
      r.append(installBox, document.createTextNode(` ${tr('Install dependencies from {files}', { files: info.files.join(', ') })}`));
      body.appendChild(r);
    }
    const note = el('div', 'venv-dialog-note muted');
    if (!base.options.length) note.textContent = tr('No Python interpreter was found. Install Python first.');
    body.appendChild(note);
    ide.ui.dialog({
      title: tr('Create Virtual Environment'),
      body,
      width: 620,
      buttons: [
        { label: tr('Create'), primary: true, run: async () => {
          const dir = loc.value.trim();
          if (!dir || !/^([a-z]:[\\/]|\\\\)/i.test(dir)) { note.textContent = tr('Enter an absolute folder path.'); return false; }
          if (!base.options.length) return false;
          if (await ide.api.exists(dir)) { note.textContent = tr('{path} already exists', { path: dir }); return false; }
          const uv = base.value === '__uv';
          create_({ dir, base: uv ? null : bases.find((b) => b.executable === base.value), uv, install: !!installBox?.checked });
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  ide.registerAction({ id: 'CreateVirtualEnvironment', title: tr('Create Virtual Environment…'), run: openDialog });

  ide.on('projectOpened', () => { hide(); evaluate(); });
  ide.on('projectClosed', () => { seq++; hide(); });
  ide.on('interpreterChanged', () => { if (bar.dataset.state === 'prompt') evaluate(); });
  ide.on('filesChanged', (c) => {
    const paths = [...(c.created || []), ...(c.deleted || [])].filter((p) => typeof p === 'string');
    if (paths.some((p) => /(^|[\\/])(requirements[^\\/]*\.txt|pyproject\.toml|pipfile|pyvenv\.cfg)$/i.test(p) || basename(p).toLowerCase().includes('venv'))) evaluate();
  });
  if (ide.root) evaluate();

  ide.venvSetup = { create: create_, recreate, openDialog, evaluate, state: () => bar.dataset.state || null };
})();
