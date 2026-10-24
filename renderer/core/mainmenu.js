// Main toolbar (PyCharm New UI): main menu, project widget, run widget slot, Search Everywhere; the welcome screen;
// the status-bar interpreter widget; Get from VCS; Close Project; About.
(() => {
  const { $, el, basename, dirname, samePath } = ide.util;

  // ---------- toolbar chrome ----------
  $('mainMenuBtn').appendChild(ide.icon('mainMenu', '☰'));
  $('searchBtn').appendChild(ide.icon('search', '⌕'));
  $('runWidget').dataset.order = 60;
  $('searchBtn').dataset.order = 180;
  for (const n of document.querySelectorAll('[data-icon]')) n.appendChild(ide.icon(n.dataset.icon));

  // Project avatars: two letters on a color picked from the name, like PyCharm's project icons.
  const AVATAR_COLORS = ['#e46a2e', '#3574f0', '#5fb865', '#c94f4f', '#9d5cf0', '#d6ae58', '#2aacb8', '#e55b9b'];
  function avatar(name, cls = 'project-avatar') {
    // First letters of the first two words (Tendo_Aris -> TA), or the first two letters of a single word (project -> PR).
    const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || name).slice(0, 2)).toUpperCase();
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const a = el('span', cls, letters);
    a.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
    return a;
  }
  ide.ui.avatar = avatar;

  function renderProjectWidget() {
    const w = $('projectWidget');
    w.replaceChildren();
    if (ide.root) w.append(avatar(basename(ide.root)));
    const name = el('span', 'project-widget-name', ide.root ? basename(ide.root) : tr('No project'));
    name.dataset.userText = '';
    w.append(name, ide.icon('chevronDown', '▾'));
  }

  const recentProjects = () => ide.settings.get('recentProjects', []).filter((p) => !samePath(p.path, ide.root));

  const keyHint = (keys) => keys?.map(ide.keymap.format).join(', ') || '';
  // A menu item for a registered action, or null when the plugin that owns it is disabled; disabled when it needs a
  // project and none is open.
  function act(id, extra = {}) {
    const a = ide.actions.find((x) => x.id === id);
    if (!a) return null;
    return { label: a.title || id, hint: keyHint(a.keys) || a.menuHint, disabled: !ide.actionEnabled(a), run: () => ide.runAction(id), ...extra };
  }
  // Drops separators left dangling by missing items.
  function tidy(items) {
    const out = [];
    for (const it of items) {
      if (!it) continue;
      if (it.separator && (!out.length || out[out.length - 1].separator)) continue;
      out.push(it);
    }
    while (out.length && out[out.length - 1].separator) out.pop();
    return out;
  }

  // ---------- project widget ----------
  function recentItems(limit = 10) {
    return recentProjects().slice(0, limit).map((p) => ({
      label: basename(p.path), detail: p.path, userText: true, glyph: '',
      run: () => openRecent(p.path),
    }));
  }
  async function openRecent(path) {
    const state = await ide.probeProject(path);
    if (state === 'exists') return ide.openProject(path);
    if (state !== 'missing') return;
    ide.ui.dialog({ title: tr('Recent Projects'), body: tr('{path} no longer exists. Remove it from the list?', { path }), width: 460, buttons: [
      { label: tr('Remove'), primary: true, run: () => {
        ide.settings.set('recentProjects', ide.settings.get('recentProjects', []).filter((p) => !samePath(p.path, path)));
        renderWelcomeRecent();
      } },
      { label: tr('Cancel') },
    ] });
  }
  $('projectWidget').onclick = () => {
    const r = $('projectWidget').getBoundingClientRect();
    const recent = recentItems();
    ide.ui.contextMenu(r.left, r.bottom + 4, tidy([
      act('NewProject', { icon: 'newProject' }),
      act('OpenProject', { icon: 'openProject' }),
      act('GetFromVcs', { icon: 'fromVcs' }),
      recent.length && { separator: true },
      recent.length && { header: tr('Recent Projects') },
      ...recent,
      ide.root && { separator: true },
      ide.root && act('CloseProject'),
    ]));
  };

  // ---------- main menu ----------
  const editorCmd = (handler) => () => {
    const ed = ide.editor;
    if (!ed) return;
    ed.focus();
    ed.trigger('menu', handler, null);
  };
  function toolWindowItems() {
    return [...ide.toolWindows.values()].sort((a, b) => a.order - b.order)
      .map((tw) => ({ label: tw.title, icon: tw.iconName, glyph: tw.glyph, hint: tw.keys, disabled: !ide.root, run: () => tw.show() }));
  }
  // File › Manage IDE Settings (the settings-sync plugin); left out when that plugin is disabled.
  function manageSettingsItem() {
    const items = tidy([act('ImportSettings'), act('ExportSettings')]);
    return items.length ? { label: tr('Manage IDE Settings'), submenu: () => items } : null;
  }
  const MENUS = () => [
    { label: tr('File'), submenu: () => tidy([
      act('NewProject'), act('NewPythonFile'), act('NewScratchFile'), act('NewHttpRequest'), { separator: true },
      act('OpenProject'), act('OpenFile'), act('GetFromVcs'),
      { label: tr('Recent Projects'), submenu: () => recentItems(15), disabled: !recentProjects().length },
      act('CloseProject'), { separator: true },
      act('SaveAll'), act('ShowSettings'), manageSettingsItem(), { separator: true },
      act('TogglePowerSave', { checked: !!ide.powerSave?.on() }), { separator: true },
      act('Exit'),
    ]) },
    { label: tr('Edit'), submenu: () => tidy([
      act('Undo'), act('Redo'), { separator: true },
      act('Cut'), act('Copy'), act('Paste'), act('PasteMultiple'), act('CopyPaths'), { separator: true },
      act('SelectAll'), act('EditorSelectWord'), { separator: true },
      act('Find'), act('Replace'), act('FindInPath'), act('ReplaceInPath'), act('FindUsages'), { separator: true },
      act('EditorDuplicate'), act('EditorDeleteLine'), act('MoveLineUp'), act('MoveLineDown'),
    ]) },
    { label: tr('View'), submenu: () => tidy([
      { label: tr('Tool Windows'), submenu: toolWindowItems },
      { label: tr('Appearance'), submenu: () => tidy([
        // appearance-modes plugin; their titles say Enter or Exit.
        act('TogglePresentationMode'), act('ToggleDistractionFreeMode'), act('ToggleFullScreen'), act('ToggleZenMode'), { separator: true },
        // Dark, Light, Sync with OS (settings plugin).
        ...(ide.theme?.menuItems() || []),
      ]) },
      act('HideAllWindows'), { separator: true },
      // compare plugin
      act('CompareTwoFiles'), act('CompareClipboardWithSelection'), { separator: true },
      act('FileStructurePopup'), act('QuickJavaDoc'), act('ParameterInfo'), act('RecentFiles'), act('RecentLocations'),
    ]) },
    { label: tr('Navigate'), submenu: () => tidy([
      act('Back'), act('Forward'), act('JumpToLastChange'), { separator: true },
      act('SearchEverywhere'), act('GotoFile'), act('GotoClass'), act('GotoSymbol'), act('GotoAction'), act('GotoLine'), { separator: true },
      act('GotoDeclaration'), act('GotoTypeDeclaration'), act('GotoNextError'), act('GotoPreviousError'),
      act('TypeHierarchy'), act('CallHierarchy'), // type-hierarchy, navigation-bar
      act('SelectInProjectView'),
    ]) },
    { label: tr('Code'), submenu: () => tidy([
      act('ShowIntentionActions'), act('ReformatCode'), act('OptimizeImports'), act('RuffFixAll') || act('tooling.ruffFixAll'),
      { separator: true }, act('CommentByLineComment'), act('CollapseRegion'), act('ExpandRegion'),
    ]) },
    { label: tr('Refactor'), submenu: () => tidy([
      act('Refactorings.QuickListPopupAction'), { separator: true },
      act('RenameElement'), act('ChangeSignature'), act('Move'), act('Inline'), { separator: true },
      act('IntroduceVariable'), act('IntroduceConstant'), act('IntroduceParameter'), act('ExtractMethod'),
    ]) },
    { label: tr('Run'), submenu: () => tidy([
      act('RunAnything'), act('Run'), act('Debug'), act('RunCoverage'), act('Profile'), act('RunClass'), act('ChooseRunConfiguration'),
      act('ChooseDebugConfiguration'),
      act('editRunConfigurations'), act('AttachToProcess'), { separator: true },
      act('Stop'), act('StopDebug'), act('Rerun'), act('RerunFailedTests'), act('HideCoverage'), act('ShowCoverage'),
      { separator: true },
      act('StepOver'), act('StepInto'), act('StepOut'), act('RunToCursor'), act('Resume'), act('Pause'),
      act('EvaluateExpression'), act('ToggleLineBreakpoint'), act('ViewBreakpoints'),
    ]) },
    { label: tr('Tools'), submenu: () => tidy([
      act('RunPythonConsole'), act('ActivateTerminalToolWindow'), act('TerminalNewSession'), { separator: true },
      act('ClaudeCode'), act('ClaudeCodeSendReference'), act('InstallClaudeCode'), { separator: true },
      act('Database.NewDataSource'), act('Database.OpenConsole'), { separator: true },
      ...(ide.frameworks?.kinds().length ? [act('Frameworks.RunServer'), act('Frameworks.DebugServer'), ...(ide.frameworks.info().django ? [act('Django.RunManageTask'), act('Django.MakeMigrations'), act('Django.Migrate')] : []), { separator: true }] : []),
      act('InstallManager'), act('WorkspaceHome'), act('ShowPlugins'), act('ShowProjectStructureSettings'), act('CreateVirtualEnvironment'),
    ]) },
    { label: 'Git', submenu: () => tidy([
      act('CheckinProject'), act('Vcs.Push'), act('Vcs.UpdateProject'), act('Git.Branches'), { separator: true },
      act('Git.Merge'), act('Git.Rebase'), act('Git.ResolveConflicts'), act('Git.Stash'), act('Git.Unstash'), act('ChangesView.Shelve'), act('Vcs.Show.Shelf'), { separator: true },
      act('Git.Log'), act('Vcs.ShowTabbedFileHistory'), act('Annotate'), act('ChangesView.Revert'), act('Compare.SameVersion'), act('Git.CompareWithBranch'), act('Git.Init'),
      // Git › GitHub (github plugin), as in PyCharm.
      ...(act('Github.Share.Project') ? [{ separator: true }, { label: 'GitHub', submenu: () => tidy([act('Github.Share.Project'), act('Github.View.Pull.Request')]) }] : []),
    ]) },
    { label: tr('Window'), submenu: () => tidy([
      // Window › Layouts (layouts plugin).
      ide.layouts?.menu(), { separator: true },
      act('SplitVertically'), act('SplitHorizontally'), act('Unsplit'), act('UnsplitAll'), act('ChangeSplitOrientation'),
      { separator: true }, act('OpenInNewWindow'), act('MoveToNewWindow'), { separator: true },
      act('PreviousTab'), act('NextTab'), act('ReopenClosedTab'), act('PinActiveTab'), act('CloseContent'),
    ]) },
    { label: tr('Help'), submenu: () => tidy([act('KeymapReference'), act('FindActionHelp') || act('GotoAction'), { separator: true },
      act('OpenLogInEditor'), act('ShowLogInExplorer'), act('CollectZippedLogs'), act('LogDebugConfigure'), { separator: true }, act('ReportProblem'), act('CheckForUpdates'), act('WhatsNew'), act('AboutPyIDE')]) },
  ];
  function openMainMenu() {
    const r = $('mainMenuBtn').getBoundingClientRect();
    const menu = ide.ui.contextMenu(r.left, r.bottom + 4, MENUS().map((m) => ({ ...m, submenu: () => { const items = m.submenu(); return items.length ? items : [{ label: tr('(empty)'), disabled: true }]; } })));
    menu.id = 'mainMenu';
  }
  $('mainMenuBtn').onclick = openMainMenu;

  // ---------- status-bar interpreter ----------
  $('statusInterp').onclick = () => {
    const r = $('statusInterp').getBoundingClientRect();
    const cur = ide.currentInterp();
    ide.ui.contextMenu(r.right - 300, r.top - 8, tidy([
      ...ide.interps.map((it) => ({ label: it.label, detail: it.executable, userText: true, checked: cur && samePath(cur.executable, it.executable), icon: cur && samePath(cur.executable, it.executable) ? undefined : 'python', run: () => ide.setInterpreter(it.executable) })),
      { separator: true },
      ide.openSettings && { label: tr('Add New Interpreter…'), icon: 'add', run: () => ide.openSettings('interpreter') },
      ide.openSettings && { label: tr('Interpreter Settings…'), icon: 'settings', run: () => ide.openSettings('interpreter') },
    ]));
    // The menu opens upward from the status bar.
    const m = document.querySelector('#menuHost .context-menu');
    if (m) m.style.top = `${Math.max(4, r.top - m.offsetHeight - 4)}px`;
  };

  // ---------- welcome screen ----------
  function renderWelcomeRecent() {
    const list = $('welcomeRecent');
    list.replaceChildren();
    const recent = ide.settings.get('recentProjects', []);
    $('welcome').querySelector('.welcome-recent-title').classList.toggle('hidden', !recent.length);
    for (const p of recent.slice(0, 10)) {
      const row = el('div', 'welcome-recent-row');
      row.dataset.path = p.path;
      const text = el('div', 'welcome-recent-text');
      const name = el('div', 'welcome-recent-name', basename(p.path));
      const path = el('div', 'welcome-recent-path', p.path);
      name.dataset.userText = path.dataset.userText = '';
      text.append(name, path);
      const remove = el('button', 'welcome-recent-remove', '×');
      remove.title = tr('Remove from Recent Projects');
      remove.onclick = (e) => {
        e.stopPropagation();
        ide.settings.set('recentProjects', ide.settings.get('recentProjects', []).filter((x) => !samePath(x.path, p.path)));
        renderWelcomeRecent();
      };
      row.append(avatar(basename(p.path)), text, remove);
      row.onclick = () => openRecent(p.path);
      list.appendChild(row);
    }
  }
  $('welcomeNew').onclick = () => ide.runAction('NewProject');
  $('welcomeOpen').onclick = () => ide.pickAndOpenProject();
  $('welcomeVcs').onclick = () => ide.runAction('GetFromVcs');

  // ---------- Get from VCS ----------
  function getFromVcs() {
    const body = el('div', 'vcs-clone');
    const url = el('input');
    url.id = 'cloneUrl';
    url.placeholder = 'https://github.com/user/repo.git';
    const dir = el('input');
    dir.id = 'cloneDir';
    const parent = ide.settings.get('newProject.location') || (ide.root ? dirname(ide.root) : '');
    dir.value = parent;
    const browse = el('button', 'secondary', '…');
    browse.title = tr('Browse');
    browse.onclick = async () => { const d = await ide.api.openFolder(); if (d) dir.value = ide.util.joinPath(d, repoName(url.value) || ''); };
    const repoName = (u) => (u.trim().replace(/\/+$/, '').split(/[/:]/).pop() || '').replace(/\.git$/i, '');
    url.oninput = () => { if (parent) dir.value = ide.util.joinPath(parent, repoName(url.value)); };
    const row = (label, ...controls) => { const r = el('label', 'field'); const box = el('div', 'field-row'); box.append(...controls); r.append(el('span', null, label), box); return r; };
    const log = el('pre', 'clone-log');
    log.id = 'cloneLog';
    body.append(row(tr('URL:'), url), row(tr('Directory:'), dir, browse), log);
    let running = false;
    const dlg = ide.ui.dialog({
      title: tr('Get from Version Control'),
      body,
      width: 620,
      buttons: [
        { label: tr('Clone'), primary: true, run: async (d) => {
          if (running || !url.value.trim() || !dir.value.trim()) return false;
          if (await ide.api.exists(dir.value.trim())) { log.textContent = tr('{path} already exists', { path: dir.value.trim() }); return false; }
          running = true;
          log.textContent = `git clone ${url.value.trim()} ${dir.value.trim()}\n`;
          const id = await ide.api.invoke('project:clone', url.value.trim(), dir.value.trim());
          ide.proc.attach(id, {
            data: (t) => { log.textContent += t; log.scrollTop = log.scrollHeight; },
            async exit(code) {
              running = false;
              if (code !== 0) { log.textContent += `\n${tr('Clone failed (exit code {code})', { code })}\n`; return; }
              d.close();
              await ide.openProject(dir.value.trim());
            },
          });
          return false;
        } },
        { label: tr('Cancel') },
      ],
    });
    dlg.el.classList.add('clone-dialog');
    url.focus();
  }

  // About PyIDE is the diagnostics plugin's (a required plugin): versions of every tool, with Copy.

  // ---------- actions ----------
  [
    { id: 'MainMenu', title: tr('Main Menu'), keys: 'Alt+\\', run: openMainMenu, terminal: true },
    // The search-everywhere plugin replaces this with the real popup; without it, Double Shift still finds files.
    { id: 'SearchEverywhere', title: tr('Search Everywhere'), keys: 'Shift Shift', run: () => ide.runAction('GotoFile') },
    { id: 'GetFromVcs', title: tr('Get from VCS…'), run: getFromVcs },
    { id: 'CloseProject', title: tr('Close Project'), run: () => ide.closeProject() },
    { id: 'Exit', title: tr('Exit'), run: () => ide.api.invoke('window:close') },
    { id: 'Undo', title: tr('Undo'), run: editorCmd('undo') },
    { id: 'Redo', title: tr('Redo'), run: editorCmd('redo') },
    { id: 'Cut', title: tr('Cut'), run: editorCmd('editor.action.clipboardCutAction') },
    { id: 'Copy', title: tr('Copy'), run: editorCmd('editor.action.clipboardCopyAction') },
    { id: 'Paste', title: tr('Paste'), run: async () => { const t = await ide.api.invoke('clipboard:readText'); const ed = ide.editor; if (ed && t) { ed.focus(); ed.trigger('menu', 'type', { text: t }); } } },
    { id: 'SelectAll', title: tr('Select All'), run: editorCmd('editor.action.selectAll') },
    { id: 'KeymapReference', title: tr('Keymap Reference'), run: () => ide.openSettings?.('keymap') },
  ].forEach(ide.registerAction);
  // Monaco handles these keys itself; the Edit menu shows them for reference without binding them again.
  for (const [id, keys] of [['Undo', 'Ctrl+Z'], ['Redo', 'Ctrl+Shift+Z'], ['Cut', 'Ctrl+X'], ['Copy', 'Ctrl+C'], ['Paste', 'Ctrl+V'], ['SelectAll', 'Ctrl+A']]) {
    ide.actions.find((x) => x.id === id).menuHint = keys;
  }
  $('searchBtn').onclick = () => ide.runAction('SearchEverywhere');

  ide.on('projectOpened', renderProjectWidget);
  ide.on('projectClosed', () => { renderProjectWidget(); renderWelcomeRecent(); });
  ide.on('settingsChanged', (key) => { if (key === 'recentProjects') renderWelcomeRecent(); });
  renderProjectWidget();
  renderWelcomeRecent();
  ide.mainMenu = { open: openMainMenu, avatar };
})();
