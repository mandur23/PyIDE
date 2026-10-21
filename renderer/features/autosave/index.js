// Auto save (Settings › Appearance & Behavior › System Settings) and the generic actions on save (Settings › Actions
// on Save). The core does the saving (ide.autoSave skips what must not be written; ide.registerSaveAction); this
// plugin decides when to save and strips trailing whitespace and adds final line breaks.
(() => {
  const { el, basename, samePath } = ide.util;
  const DEFAULTS = {
    'autosave.onFrameDeactivation': true,
    'autosave.onTabSwitch': true,
    'autosave.onIdle': true,
    'autosave.idleSeconds': 15,
    'autosave.beforeRun': true,
    'save.stripTrailingSpaces': true,
    'save.ensureFinalNewline': false,
    'tools.optimizeImportsOnSave': false,
  };
  const get = (k) => ide.settings.get(k, DEFAULTS[k]);

  // ---------- triggers ----------
  // The window lost focus to another application. Focus moving into a frame inside the page (an HTML preview, a
  // notebook output) blurs the window too, but the document still has focus then (as it always does for test
  // instances, which run with CDP focus emulation).
  addEventListener('blur', () => {
    if (!get('autosave.onFrameDeactivation')) return;
    setTimeout(() => { if (!document.hasFocus()) ide.autoSave(); });
  });
  // PyCharm counts the built-in terminal as another application.
  addEventListener('focusin', (e) => {
    if (get('autosave.onFrameDeactivation') && e.target.closest?.('.xterm')) ide.autoSave();
  });

  let lastTab = null;
  ide.on('activeTabChanged', (tab) => {
    const prev = lastTab;
    lastTab = tab;
    if (prev?.doc && prev.doc !== tab?.doc && get('autosave.onTabSwitch')) ide.autoSave([prev.path]);
  });

  let idleTimer = 0;
  function armIdle() {
    clearTimeout(idleTimer);
    if (!get('autosave.onIdle')) return;
    idleTimer = setTimeout(() => ide.autoSave(), Math.max(1, Number(get('autosave.idleSeconds')) || 15) * 1000);
  }
  for (const type of ['keydown', 'mousedown', 'wheel']) addEventListener(type, armIdle, true);
  ide.on('fileOpened', (tab) => tab.model?.onDidChangeContent(armIdle));
  ide.on('settingsChanged', (key) => { if (key.startsWith('autosave.')) armIdle(); });

  // ---------- actions on save ----------
  // Lines are those of the text before any other action ran (this one runs first); caret lines keep their spaces.
  ide.registerSaveAction({
    id: 'stripTrailingSpaces', order: 10,
    run(text, ctx) {
      if (!get('save.stripTrailingSpaces') || !ctx.modifiedLines.size) return undefined;
      const lines = text.split(ctx.eol);
      let changed = false;
      for (const l of ctx.modifiedLines) {
        if (l > lines.length || ctx.caretLines.has(l)) continue;
        const stripped = lines[l - 1].replace(/[ \t]+$/, '');
        if (stripped !== lines[l - 1]) { lines[l - 1] = stripped; changed = true; }
      }
      return changed ? lines.join(ctx.eol) : undefined;
    },
  });
  ide.registerSaveAction({
    id: 'ensureFinalNewline', order: 20,
    run: (text, ctx) => (get('save.ensureFinalNewline') && text && !text.endsWith('\n') ? text + ctx.eol : undefined),
  });

  // ---------- files auto save left alone ----------
  const MESSAGES = {
    changedOnDisk: (name) => tr('Not auto-saved: {name} changed on disk', { name }),
    unreadable: (name) => tr('Not auto-saved: {name} cannot be read', { name }),
    failed: (name) => tr('Not auto-saved: {name} cannot be written', { name }),
  };
  const skipped = new Map(); // path -> reason
  const status = el('span', 'autosave-status hidden');
  status.id = 'autosaveStatus';
  ide.registerStatusItem({ order: 6, el: status });
  function render() {
    status.classList.toggle('hidden', !skipped.size);
    const [[path, reason] = []] = skipped;
    status.textContent = skipped.size === 1 ? `⚠ ${MESSAGES[reason](basename(path))}` : `⚠ ${tr('{count} files not auto-saved', { count: skipped.size })}`;
    status.title = [...skipped.keys()].map((p) => ide.util.rel(p)).join('\n');
  }
  const forget = (path) => { for (const p of skipped.keys()) if (samePath(p, path)) skipped.delete(p); render(); };
  ide.on('autoSaveSkipped', ({ path, reason }) => { forget(path); skipped.set(path, reason); render(); });
  ide.on('fileSaved', (tab) => forget(tab.path));
  ide.on('fileClosed', forget);
  status.onclick = () => {
    const r = status.getBoundingClientRect();
    ide.ui.contextMenu(r.left, r.top - 8, [...skipped.keys()].flatMap((path) => [
      { header: ide.util.rel(path) },
      { label: tr('Save (overwrite the file on disk)'), run: () => ide.saveTab(ide.findTab(path), { overwrite: true }) },
      { label: tr('Reload from disk (discard changes in the editor)'), run: async () => {
        const doc = ide.getDocument(path);
        if (!doc) return;
        doc.savedVersion = doc.model.getAlternativeVersionId();
        await ide.reloadFromDisk([path]);
        forget(path);
      } },
    ]));
  };

  // ---------- settings ----------
  const note = (host, text) => host.appendChild(el('div', 'muted settings-note', text));
  (ide.settingsPages ||= []).push({
    id: 'system', group: 'appearance', title: () => tr('System Settings'), defaults: DEFAULTS,
    keywords: 'autosave auto save idle focus frame deactivation tab switch before run 자동 저장 유휴 포커스 탭 전환 실행 전',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Autosave'));
      s.appendChild(ctx.ui.checkbox('autosave.onFrameDeactivation', tr('Save files when switching to a different application or a built-in terminal')));
      s.appendChild(ctx.ui.checkbox('autosave.onTabSwitch', tr('Save files when switching to another editor tab')));
      s.appendChild(ctx.ui.checkbox('autosave.onIdle', tr('Save files if the IDE is idle')));
      s.appendChild(ctx.ui.fieldRow(tr('Idle time (seconds):'), ctx.ui.numberInput('autosave.idleSeconds', { min: 1, max: 3600, fallback: 15 })));
      s.appendChild(ctx.ui.checkbox('autosave.beforeRun', tr('Save files before Run, Debug and tests')));
      note(s, tr('Auto save skips untitled and read-only files, files open only in a viewer, and files another program changed on disk.'));
    },
  });
  ide.settingsPages.push({
    id: 'actionsOnSave', title: () => tr('Actions on Save'), defaults: DEFAULTS,
    keywords: 'actions on save reformat optimize imports trailing whitespace spaces final newline line break ruff 저장 시 액션 서식 import 최적화 공백 줄바꿈',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Actions on Save'));
      s.appendChild(ctx.ui.checkbox('save.stripTrailingSpaces', tr('Strip trailing whitespace on modified lines')));
      s.appendChild(ctx.ui.checkbox('save.ensureFinalNewline', tr('Ensure every saved file ends with a line break')));
      if (ide.tooling) {
        s.appendChild(ctx.ui.checkbox('tools.formatOnSave', tr('Reformat code (ruff format)')));
        s.appendChild(ctx.ui.checkbox('tools.optimizeImportsOnSave', tr('Optimize imports (ruff)')));
      }
      note(s, tr('Actions run on {saves} and auto saves. One Ctrl+Z undoes them.', { saves: ide.keymap.withKeys(tr('explicit saves'), 'SaveAll') }));
    },
  });
})();
