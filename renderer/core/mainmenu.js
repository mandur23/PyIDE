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
  const pasteInto = async (ed) => {
    const text = await ide.api.invoke('clipboard:readText');
    if (ed && text) { ed.focus(); ed.trigger('menu', 'type', { text }); }
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
      act('SelectAll'), act('EditorSelectWord'), act('SelectNextOccurrence'), act('UnselectPreviousOccurrence'), act('SelectAllOccurrences'), { separator: true },
      act('Find'), act('Replace'), act('FindInPath'), act('ReplaceInPath'), act('FindUsages'), { separator: true },
      // editor-assists: PyCharm's Edit menu order.
      act('EditorCompleteStatement'), act('EditorJoinLines'), act('EditorDuplicate'), act('EditorDeleteLine'), act('EditorToggleCase'),
      act('EditorStartNewLine'), act('EditorStartNewLineBefore'), act('MoveLineUp'), act('MoveLineDown'),
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
      act('FileStructurePopup'), act('QuickImplementations'), act('QuickJavaDoc'), act('ParameterInfo'), act('ExpressionTypeInfo'),
      act('RecentFiles'), act('RecentLocations'),
    ]) },
    { label: tr('Navigate'), submenu: () => tidy([
      act('Back'), act('Forward'), act('JumpToLastChange'), { separator: true },
      act('SearchEverywhere'), act('GotoFile'), act('GotoClass'), act('GotoSymbol'), act('GotoAction'), act('GotoLine'), { separator: true },
      act('GotoDeclaration'), act('GotoImplementation'), act('GotoTypeDeclaration'), act('GotoSuperMethod'), act('GotoTest'),
      act('GotoNextError'), act('GotoPreviousError'),
      act('TypeHierarchy'), act('CallHierarchy'), // type-hierarchy, navigation-bar
      act('SelectInProjectView'),
    ]) },
    { label: tr('Code'), submenu: () => tidy([
      act('ShowIntentionActions'), act('OverrideMethods'), act('ImplementMethods'), { separator: true },
      act('ReformatCode'), act('OptimizeImports'), act('RuffFixAll') || act('tooling.ruffFixAll'), { separator: true },
      act('CommentByLineComment'), act('MoveStatementUp'), act('MoveStatementDown'), { separator: true },
      act('CollapseRegion'), act('ExpandRegion'), act('CollapseAllRegions'), act('ExpandAllRegions'),
    ]) },
    { label: tr('Refactor'), submenu: () => tidy([
      act('Refactorings.QuickListPopupAction'), { separator: true },
      act('RenameElement'), act('ChangeSignature'), act('Move'), act('Inline'), { separator: true },
      act('IntroduceVariable'), act('IntroduceConstant'), act('IntroduceParameter'), act('ExtractMethod'),
    ]) },
    { label: tr('Run'), submenu: () => tidy([
      act('RunAnything'), act('Run'), act('Debug'), act('RunCoverage'), act('Profile'), act('RunClass'), act('ChooseRunConfiguration'),
      act('ChooseDebugConfiguration'),
      act('editRunConfigurations'), act('AttachToProcess'), act('BuildExecutable'), { separator: true },
      act('Stop'), act('StopDebug'), act('Rerun'), act('ToggleRerunOnSave'), act('RerunFailedTests'), act('HideCoverage'), act('ShowCoverage'),
      { separator: true },
      act('StepOver'), act('StepInto'), act('StepOut'), act('RunToCursor'), act('Resume'), act('Pause'),
      act('EvaluateExpression'), act('ToggleLineBreakpoint'), act('ViewBreakpoints'),
    ]) },
    { label: tr('Tools'), submenu: () => tidy([
      act('RunPythonConsole'), act('ActivateTerminalToolWindow'), act('TerminalNewSession'), { separator: true },
      act('ClaudeCode'), act('ClaudeCodeSendReference'), act('InstallClaudeCode'), { separator: true },
      act('Database.NewDataSource'), act('Database.OpenConsole'), { separator: true },
      ...(ide.frameworks?.kinds().length ? [act('Frameworks.RunServer'), act('Frameworks.DebugServer'), ...(ide.frameworks.info().django ? [act('Django.RunManageTask'), act('Django.MakeMigrations'), act('Django.Migrate')] : []), { separator: true }] : []),
      act('InstallManager'), act('WorkspaceHome'), act('ShowPlugins'), act('ShowProjectStructureSettings'), act('CreateVirtualEnvironment'), act('SyncPythonRequirements'),
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
    { id: 'Paste', title: tr('Paste'), run: () => pasteInto(ide.editor) },
    { id: 'SelectAll', title: tr('Select All'), run: editorCmd('editor.action.selectAll') },
    { id: 'KeymapReference', title: tr('Keymap Reference'), run: () => ide.openSettings?.('keymap') },
  ].forEach(ide.registerAction);
  // Monaco handles these keys itself; the Edit menu shows them for reference without binding them again.
  for (const [id, keys] of [['Undo', 'Ctrl+Z'], ['Redo', 'Ctrl+Shift+Z'], ['Cut', 'Ctrl+X'], ['Copy', 'Ctrl+C'], ['Paste', 'Ctrl+V'], ['SelectAll', 'Ctrl+A']]) {
    ide.actions.find((x) => x.id === id).menuHint = keys;
  }
  $('searchBtn').onclick = () => ide.runAction('SearchEverywhere');

  // ---------- editor context menu ----------
  // PyCharm's editor popup: the common actions at the top, the rest in submenus (Monaco's flat menu had grown past 30
  // rows). An entry names the IDE action and the editor action that does the same in one editor ({ide, ed}): a tab's
  // editor runs the IDE action (its key, Korean title and enablement), an embedded editor (a notebook cell, a viewer)
  // the editor action, since IDE actions act on the active tab. Monaco registers the clipboard commands as no editor
  // action, so those entries give `run(editor)` instead (`edits`: not in a read-only editor). `needs` names an editor
  // action whose precondition the entry shares (Git: a repository). Items that do not apply are left out. Editor actions that plugins add with a contextMenuGroupId and that no entry names are listed at the end.
  const EDITOR_MENU = () => [
    { ide: 'ShowIntentionActions', ed: 'editor.action.quickFix' },
    { separator: true },
    { ide: 'Cut', edits: true, run: (ed) => ed.trigger('menu', 'editor.action.clipboardCutAction', null) },
    { ide: 'Copy', run: (ed) => ed.trigger('menu', 'editor.action.clipboardCopyAction', null) },
    { ide: 'Paste', edits: true, run: pasteInto },
    { label: tr('Copy / Paste Special'), submenu: [{ ide: 'CopyPaths' }, { ide: 'PasteMultiple', ed: 'pyide.pasteFromHistory' }, { ide: 'CompareClipboardWithSelection', ed: 'pyide.compareWithClipboard' }] },
    { separator: true },
    { ide: 'FindUsages', ed: 'editor.action.goToReferences' }, { ide: 'FindSimilarCode', ed: 'pyide.semantic.findSimilar' },
    { label: tr('Refactor'), submenu: [
      { ide: 'RenameElement', ed: 'editor.action.rename' }, { ide: 'ChangeSignature' }, { ide: 'Move' }, { ide: 'Inline' }, { separator: true },
      { ide: 'IntroduceVariable' }, { ide: 'IntroduceConstant' }, { ide: 'IntroduceParameter' }, { ide: 'ExtractMethod' }, { separator: true },
      { ide: 'Refactorings.QuickListPopupAction' },
    ] },
    { label: tr('Folding'), submenu: [
      { ide: 'ExpandRegion', ed: 'editor.unfold' }, { ide: 'CollapseRegion', ed: 'editor.fold' }, { ide: 'ExpandAllRegions', ed: 'editor.unfoldAll' }, { ide: 'CollapseAllRegions', ed: 'editor.foldAll' },
    ] },
    { label: tr('Go To'), submenu: [
      { ide: 'GotoDeclaration', ed: 'editor.action.revealDefinition' }, { ide: 'GotoImplementation', ed: 'pyide.gotoImplementation' },
      { ide: 'GotoTypeDeclaration', ed: 'editor.action.goToTypeDefinition' }, { ide: 'GotoSuperMethod', ed: 'pyide.gotoSuperMethod' }, { ide: 'GotoTest', ed: 'pyide.gotoTest' },
      { separator: true },
      { ide: 'QuickImplementations', ed: 'editor.action.peekDefinition' }, { ide: 'TypeHierarchy', ed: 'pyide.typeHierarchy' }, { ide: 'CallHierarchy', ed: 'pyide.callHierarchy' },
    ] },
    { label: tr('Generate'), submenu: [
      { ide: 'OverrideMethods' }, { ide: 'ImplementMethods' }, { separator: true }, { ide: 'AiGenerate.WriteDocumentation' }, { ide: 'AiGenerate.GenerateTests' },
    ] },
    { separator: true },
    { ide: 'RunClass' }, { ide: 'ExecuteInPyConsoleAction', ed: 'pyide.executeInConsole' },
    { separator: true },
    { label: tr('AI'), submenu: [
      { ed: 'aiChat.askAboutSelection' }, { ide: 'AiEdit.InlineEdit' }, { ide: 'AiGenerate.Menu', ed: 'aiGenerate.menu' }, { ed: 'aiChat.open' },
      { separator: true }, { ide: 'ClaudeCodeSendReference', ed: 'pyide.claude.sendReference' },
    ] },
    { label: tr('Bookmarks'), submenu: [
      { ide: 'ToggleBookmark', ed: 'bookmarks.toggle' }, { ide: 'ToggleBookmarkWithMnemonic', ed: 'bookmarks.mnemonic' }, { ide: 'ShowBookmarks' },
    ] },
    { label: tr('Local History'), submenu: [
      { ide: 'LocalHistory.ShowHistory', ed: 'localHistory.show', label: tr('Show History') }, { ide: 'LocalHistory.PutLabel', label: tr('Put Label…') },
    ] },
    { label: 'Git', needs: 'vcs.showHistory', submenu: [
      { ed: 'vcs.annotate' }, { ed: 'vcs.closeAnnotations' }, { ide: 'Vcs.ShowTabbedFileHistory', ed: 'vcs.showHistory' }, { ide: 'Compare.SameVersion' }, { ide: 'Git.CompareWithBranch' },
    ] },
    { ide: 'ShowUmlDiagram', ed: 'pyide.showUmlDiagram' }, { ide: 'VisualScript.ShowAsFlow' },
  ];
  const menuEntryIds = (entries) => entries.flatMap((e) => (e.submenu ? menuEntryIds(e.submenu) : e.ed ? [e.ed] : []));

  function editorMenuItems(ed) {
    const inTab = ide.editors().includes(ed);
    const editorAction = (id, label) => {
      const a = id && ed.getAction(id);
      return a && a.isSupported() ? { label: label || a.label, run: () => { ed.focus(); a.run(); } } : null;
    };
    const supported = (id) => ed.getAction(id)?.isSupported();
    const item = (e) => {
      if (e.separator) return e;
      // An editor action's precondition (vcsRepo, a rename provider…) and an IDE action's `when` say whether it applies.
      if ((e.needs && !supported(e.needs)) || (e.ed && ed.getAction(e.ed) && !supported(e.ed))) return null;
      if (e.submenu) {
        const sub = tidy(e.submenu.map(item));
        return sub.length ? { label: e.label, submenu: sub } : null;
      }
      const a = inTab && e.ide && ide.actions.find((x) => x.id === e.ide);
      if (a) return ide.actionEnabled(a) && (!a.when || a.when()) ? act(e.ide, e.label ? { label: e.label } : {}) : null;
      if (e.run) {
        const title = e.label || ide.actions.find((a) => a.id === e.ide)?.title;
        if (!title || (e.edits && ed.getOption(ide.monaco.editor.EditorOption.readOnly))) return null;
        return { label: title, run: () => { ed.focus(); e.run(ed); } };
      }
      return editorAction(e.ed, e.label);
    };
    const entries = EDITOR_MENU();
    const named = new Set(menuEntryIds(entries));
    const extras = (ide.editorMenuActions?.(ed) || []).filter((d) => !named.has(d.id))
      .sort((a, b) => a.group.localeCompare(b.group) || (a.order ?? 0) - (b.order ?? 0)).map((d) => editorAction(d.id));
    return tidy([...entries.map(item), { separator: true }, ...extras]);
  }
  ide.ui.editorContextMenu = (ed, x, y) => ide.ui.contextMenu(x, y, editorMenuItems(ed));

  ide.on('projectOpened', renderProjectWidget);
  ide.on('projectClosed', () => { renderProjectWidget(); renderWelcomeRecent(); });
  ide.on('settingsChanged', (key) => { if (key === 'recentProjects') renderWelcomeRecent(); });
  renderProjectWidget();
  renderWelcomeRecent();
  ide.mainMenu = { open: openMainMenu, avatar };
})();
