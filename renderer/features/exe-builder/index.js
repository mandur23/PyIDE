// Build Executable: packs a Python program into a Windows program (.exe) with PyInstaller, so it runs on a computer
// without Python. Run › Build Executable… asks for the name, one file or one folder, a console window or none, and an
// icon, then saves a "PyInstaller" run configuration for the script (its other options, bundled data files and extra
// PyInstaller arguments, are in Edit Configurations) and runs it in the Run tool window. The program goes to the
// project's dist folder, PyInstaller's work files to build/<name>. PyInstaller missing from the interpreter: the build
// offers to install it first, with the project's tool, without adding it to the requirements. A finished build says
// where the program is, with Show in Explorer. Local interpreters only; Safe Mode builds nothing.
(() => {
  const { el, basename, dirname } = ide.util;
  const run = ide.run;
  const TYPE = 'pyinstaller';
  const isPy = (p) => /\.pyw?$/i.test(p || '');
  const list = (s) => (s || '').split(/[;\n]/).map((p) => p.trim()).filter(Boolean);
  const nameOf = (script) => basename(script || '').replace(/\.pyw?$/i, '');
  // PyInstaller adds .exe itself: "tool.exe" typed as the name would otherwise become tool.exe.exe.
  const exeNameOf = (name) => (name || '').trim().replace(/\.exe$/i, '');

  const ERRORS = {
    remote: () => tr('Building an executable needs a local Python interpreter.'),
    untrusted: () => tr('The project is open in Safe Mode, where PyIDE runs nothing from it.'),
    script: (p) => tr('Script not found: {path}', { path: p }),
    icon: (p) => tr('Icon not found: {path}', { path: p }),
    data: (p) => tr('Data file or folder not found: {path}', { path: p }),
    name: (p) => tr('Not a file name for the executable: {name}', { name: p }),
  };

  function askInstall(interp) {
    return new Promise((resolve) => {
      ide.ui.dialog({
        title: tr('Install PyInstaller?'),
        body: tr('Building an executable needs PyInstaller, which is not installed in {interpreter}. Install it now? It is not added to the requirements.', { interpreter: interp.label || interp.executable }),
        onClose: () => resolve(false),
        buttons: [{ label: tr('Install and Build'), primary: true, run: () => resolve(true) }, { label: tr('Cancel') }],
      });
    });
  }

  // In a Git repository whose .gitignore does not cover them yet, the build's output folders (a program of tens of MB
  // and PyInstaller's work files) are offered for .gitignore, so they are not committed by accident.
  const IGNORED = ['build/', 'dist/'];
  async function missingIgnores(root) {
    if (!(await ide.api.exists(ide.util.joinPath(root, '.git')))) return [];
    const file = ide.util.joinPath(root, '.gitignore');
    const text = (await ide.api.exists(file)) ? await ide.api.read(file) : '';
    const lines = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/?\*?$/, '/')));
    return IGNORED.filter((p) => !lines.has(p));
  }
  async function addIgnores(root, patterns) {
    const file = ide.util.joinPath(root, '.gitignore');
    const doc = ide.getDocument(file);
    const text = doc ? doc.model.getValue() : (await ide.api.exists(file)) ? await ide.api.read(file) : '';
    const next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}# PyInstaller (Build Executable)\n${patterns.join('\n')}\n`;
    const tab = ide.findTab(file);
    if (doc && tab && ide.isDirty(tab)) doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: next }], () => null);
    else {
      await ide.api.write(file, next);
      if (doc) await ide.reloadFromDisk([file]);
    }
    ide.refreshTree?.();
  }

  const mb = (bytes) => (bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0);

  async function built(s, output, oneFolder) {
    // What the user hands on: the .exe, or for one folder the whole folder.
    const bytes = await ide.api.invoke('exe-builder:size', oneFolder ? dirname(output) : output).catch(() => null);
    const size = bytes == null ? '' : ` (${oneFolder ? tr('folder {size} MB', { size: mb(bytes) }) : tr('{size} MB', { size: mb(bytes) })})`;
    s.con?.append(`\n${tr('Executable built: {path}', { path: output })}${size}\n`, 'ok');
    const reveal = () => ide.api.invoke('shell:showInFolder', output);
    s.setActions([{ id: 'showExe', icon: '📂', title: tr('Show in Explorer'), run: reveal }]);
    const root = ide.root;
    const ignores = await missingIgnores(root).catch(() => []);
    ide.notifications?.notify({
      title: tr('Executable built'), text: `${output}${size}`, kind: 'ok', group: 'Build Executable', raw: true,
      actions: [
        { label: tr('Show in Explorer'), run: reveal },
        ...(ignores.length ? [{ label: tr('Add {folders} to .gitignore', { folders: ignores.join(', ') }), run: (note) => { note.expire(); addIgnores(root, ignores); } }] : []),
      ],
    });
    ide.refreshTree?.();
  }

  run.registerType({
    type: TYPE, title: tr('PyInstaller'), icon: '📦',
    fields: [
      { key: 'script', label: tr('Script path'), placeholder: 'main.py' },
      { key: 'exeName', label: tr('Executable name'), placeholder: tr('Defaults to the script name') },
      { key: 'mode', label: tr('Output'), kind: 'select', options: () => [['onefile', tr('One file (.exe)')], ['onedir', tr('One folder')]] },
      { key: 'windowed', label: tr('No console window (GUI program)'), kind: 'checkbox' },
      { key: 'icon', label: tr('Icon (.ico)'), placeholder: 'icon.ico' },
      { key: 'data', label: tr('Data files and folders'), placeholder: tr('assets;config.json') },
      { key: 'extra', label: tr('Extra PyInstaller options'), placeholder: '--hidden-import module' },
      { key: 'interp', label: tr('Python interpreter'), kind: 'interp' },
    ],
    defaults: () => ({ script: '', exeName: '', mode: 'onefile', windowed: false, icon: '', data: '', extra: '', interp: '' }),
    identity: (c) => (c.script || '').trim().toLowerCase(),
    file: (c) => run.resolvePath(c.script) || null,
    async start(cfg, s, interp) {
      const con = s.console();
      const opts = {
        script: run.resolvePath(cfg.script), name: exeNameOf(cfg.exeName), mode: cfg.mode, windowed: !!cfg.windowed,
        icon: run.resolvePath(cfg.icon), data: list(cfg.data).map(run.resolvePath), extra: run.parseArgs(cfg.extra),
      };
      if (!cfg.script?.trim()) return con.append(`${tr('No script given. Edit the configuration first.')}\n`, 'err');
      let p = await ide.api.invoke('exe-builder:prepare', interp, ide.root, opts);
      if (p.missing) {
        con.append(`${tr('PyInstaller is not installed in {interpreter}.', { interpreter: interp.label || interp.executable })}\n`, 'sys');
        if (!(await askInstall(interp)) || !ide.dependencies) return con.append(`${tr('Build cancelled: PyInstaller is not installed.')}\n`, 'err');
        // Into the interpreter the configuration builds with, which need not be the project's.
        const code = await ide.dependencies.installSpecs(['pyinstaller'], { interp });
        if (code === null) return con.append(`${tr('Build cancelled: another package job is running in Python Packages. Build again when it is done.')}\n`, 'err');
        if (code !== 0) return con.append(`${tr('Build cancelled: PyInstaller could not be installed (see Python Packages).')}\n`, 'err');
        run.show(s);
        p = await ide.api.invoke('exe-builder:prepare', interp, ide.root, opts);
      }
      if (p.error || p.missing) return con.append(`${(ERRORS[p.error] || (() => tr('PyInstaller is not installed in {interpreter}.', { interpreter: interp.label })))(p.path)}\n`, 'err');
      con.append(`PyInstaller ${p.version}\n${[interp.cmd, ...interp.args, '-m', ...p.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`, 'sys');
      const id = await ide.api.invoke('run:start', interp, '-m', ide.root, p.args, {}, [ide.root]);
      s.attach(id, {
        onExit: async (code) => {
          if (code === 0 && await ide.api.exists(p.output)) return built(s, p.output, cfg.mode === 'onedir');
          if (s.stopRequested) return;
          ide.notifications?.notify({
            title: tr('Building {name} failed', { name: basename(p.output) }), text: tr('See the Run tool window for PyInstaller\'s output.'),
            kind: 'error', group: 'Build Executable', actions: [{ label: tr('Show Output'), run: () => run.show(s) }],
          });
        },
      });
    },
  });

  // The script to build: the open Python file, else the selected Python configuration's script.
  function currentScript() {
    const tab = ide.activeTab?.();
    if (tab?.kind === 'file' && isPy(tab.path)) return tab.path;
    const cfg = run.selected();
    if (cfg?.type === 'python' && cfg.runMode !== 'module' && isPy(cfg.script)) return run.resolvePath(cfg.script);
    if (cfg?.type === TYPE) return run.resolvePath(cfg.script);
    return null;
  }

  const configFor = (script) => run.configs().find((c) => c.type === TYPE && run.resolvePath(c.script).toLowerCase() === script.toLowerCase()) || null;

  function openDialog(path) {
    if (ide.trusted === false) return ide.ui.alert(ERRORS.untrusted());
    const script = typeof path === 'string' && isPy(path) ? path : currentScript();
    if (!script) return ide.ui.alert(tr('Open the Python file to build first.'));
    const saved = configFor(script);
    const body = el('div', 'exe-dialog');
    const row = (label, control) => {
      const r = el('label', 'exe-dialog-row');
      r.append(el('span', 'exe-dialog-label', label), control);
      return r;
    };
    const check = (id, label, checked) => {
      const r = el('label', 'exe-dialog-check');
      const box = el('input');
      box.type = 'checkbox';
      box.id = id;
      box.checked = checked;
      r.append(box, document.createTextNode(` ${label}`));
      return { r, box };
    };
    const scriptText = el('div', 'exe-dialog-script', ide.util.rel(script));
    scriptText.dataset.userText = '';
    const name = el('input', 'input');
    name.id = 'exeDlgName';
    name.value = saved?.exeName || nameOf(script);
    const mode = el('select', 'input');
    mode.id = 'exeDlgMode';
    mode.add(new Option(tr('One file (.exe)'), 'onefile'));
    mode.add(new Option(tr('One folder'), 'onedir'));
    mode.value = saved?.mode || 'onefile';
    const windowed = check('exeDlgWindowed', tr('No console window (GUI program)'), saved ? !!saved.windowed : /\.pyw$/i.test(script));
    const icon = el('input', 'input');
    icon.id = 'exeDlgIcon';
    icon.placeholder = tr('Optional, an .ico file');
    icon.value = saved?.icon || '';
    const browse = el('button', 'secondary', tr('Browse…'));
    browse.onclick = async (e) => {
      e.preventDefault();
      const picked = await ide.api.invoke('dialog:openFile', [{ name: 'Icon', extensions: ['ico'] }]).catch(() => null);
      const file = Array.isArray(picked) ? picked[0] : picked;
      if (file) icon.value = file;
    };
    const iconRow = el('div', 'exe-dialog-icon');
    iconRow.append(icon, browse);
    const note = el('div', 'exe-dialog-note muted', tr('One file is a single .exe that is easy to share; one folder starts faster. Data files and extra options are in Run › Edit Configurations.'));
    const error = el('div', 'exe-dialog-error');
    body.append(row(tr('Script:'), scriptText), row(tr('Name:'), name), row(tr('Output:'), mode), windowed.r, row(tr('Icon:'), iconRow), note, error);
    ide.ui.dialog({
      title: tr('Build Executable'),
      body,
      width: 560,
      buttons: [
        { label: tr('Build'), primary: true, run: () => {
          const exeName = exeNameOf(name.value);
          if (/^\.*$/.test(exeName)) { error.textContent = tr('Enter a name for the executable.'); return false; }
          if (/[\\/:*?"<>|]/.test(exeName)) { error.textContent = tr('A file name cannot contain {chars}', { chars: '\\ / : * ? " < > |' }); return false; }
          build(script, { exeName, mode: mode.value, windowed: windowed.box.checked, icon: icon.value.trim() });
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
    setTimeout(() => name.select(), 0);
  }

  // Saves the choices in the script's PyInstaller configuration (made once, then kept) and runs it, leaving the run
  // widget's selection as it was: Shift+F10 keeps running the program, not the build.
  function build(script, fields) {
    const previous = run.selected()?.id;
    let cfg = configFor(script);
    if (!cfg) {
      cfg = run.addTemporary({ type: TYPE, name: tr('Build {name}', { name: fields.exeName }), script: ide.util.rel(script) });
      cfg.temporary = false;
    }
    Object.assign(cfg, fields);
    run.select(previous);
    return run.runConfig(cfg, { remember: false });
  }

  ide.registerAction({ id: 'BuildExecutable', title: tr('Build Executable…'), needsProject: true, run: () => openDialog() });
  ide.registerTreeAction({ title: tr('Build Executable…'), when: (e, sel = []) => !e.dir && isPy(e.path) && sel.length <= 1 && ide.trusted !== false, run: (e) => openDialog(e.path) });
  ide.onEditor((ed) => {
    ed.addAction({ id: 'exeBuilder.build', label: tr('Build Executable…'), contextMenuGroupId: '2_run', contextMenuOrder: 9, precondition: 'editorLangId == python',
      run: () => { const tab = ide.tabs.find((t) => t.kind === 'file' && t.model === ed.getModel()); if (tab) openDialog(tab.path); } });
  });
  ide.exeBuilder = { openDialog, build };
})();
