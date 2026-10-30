// Rerun on Save: a toggle in the Run tool window's toolbar, per Run tab, like the test tabs' Toggle Auto-test. While it
// is on, saving a file of the project runs that tab's configuration again, after a short wait for more saves. A run in
// progress is stopped first and one run follows; saves during that wait fold into it, so runs never overlap or pile
// up. Off by default, not kept across restarts, and off for every tab when another project opens. Test tabs keep their
// own Auto-test; a run that is being debugged or that builds an executable gets no toggle. Safe Mode: nothing reruns.
(() => {
  const { el } = ide.util;
  const run = ide.run;
  const DELAY = 800;
  // Saves inside these folders are the environment or tool output, not the program.
  const SKIP = /[\\/](\.?venv[^\\/]*|env|site-packages|__pycache__|node_modules|\.git|\.idea|\.pytest_cache|\.mypy_cache|build|dist)[\\/]/i;
  const EXCLUDED = new Set(['pytest', 'pyinstaller']);

  let debugActive = false;
  ide.on('debugSessionChanged', (active) => { debugActive = active; });
  let starting = 0; // reruns being set up; their own Save All before the run is not a new change

  const eligible = (s) => !!s.cfg?.type && run.types.has(s.cfg.type) && !EXCLUDED.has(s.cfg.type) && !String(s.key).startsWith('debug:');

  function set(s, on) {
    s.rerunOnSave = !!on && !s.closed;
    clearTimeout(s.rerunOnSaveTimer);
    if (!s.rerunOnSaveBadge) {
      s.rerunOnSaveBadge = el('span', 'run-tab-rerun-on-save hidden', tr('On save'));
      s.rerunOnSaveBadge.title = tr('Rerun on Save');
      s.tab.insertBefore(s.rerunOnSaveBadge, s.tab.querySelector('.run-tab-close'));
    }
    s.rerunOnSaveBadge.classList.toggle('hidden', !s.rerunOnSave);
    run.renderActions();
  }

  run.registerSessionAction((s) => (eligible(s) ? {
    id: 'rerunOnSave', icon: 'rerunAuto',
    title: tr('Rerun on Save'),
    toggled: !!s.rerunOnSave,
    run: () => set(s, !s.rerunOnSave),
  } : null));

  async function rerun(s) {
    if (s.rerunOnSaveBusy) { s.rerunOnSaveAgain = true; return; }
    s.rerunOnSaveBusy = true;
    try {
      do {
        s.rerunOnSaveAgain = false;
        while (s.starting) await s.starting;
        if (s.running) {
          // Stop the current run and wait for its process to end (the timeout covers a process that never reports).
          const ended = new Promise((resolve) => { s.exitHooks.push(resolve); setTimeout(resolve, 15000); });
          s.stop();
          await ended;
        }
        if (!s.rerunOnSave || s.closed || debugActive || ide.trusted === false || !run.sessions().includes(s)) return;
        // Keep the keyboard where the user is typing (showing the Run window may focus a field in it).
        const focused = document.activeElement;
        starting++;
        try {
          await run.runConfig(s.cfg, { executor: s.executor || undefined, confirm: false });
        } finally { starting--; }
        if (focused && focused !== document.activeElement && document.contains(focused)) focused.focus();
      } while (s.rerunOnSaveAgain && s.rerunOnSave && !s.closed);
    } finally { s.rerunOnSaveBusy = false; }
  }

  // Run tabs survive a project switch; rerunning one against another project's saves would run the old program.
  const offAll = () => {
    for (const s of run.sessions()) {
      clearTimeout(s.rerunOnSaveTimer);
      s.rerunOnSaveAgain = false;
      if (s.rerunOnSave) set(s, false);
    }
  };
  // A run of the tab that starts by any other way (Rerun, Shift+F10) already has the saves its Save All made.
  ide.on('runSessionStarting', (s) => clearTimeout(s.rerunOnSaveTimer));
  ide.on('projectOpened', offAll);
  ide.on('projectClosed', offAll);

  ide.on('fileSaved', (tab) => {
    if (ide.trusted === false || starting || debugActive || !tab?.path || !ide.root) return;
    if (!ide.util.isUnder(tab.path, ide.root) || SKIP.test(`\\${ide.util.rel(tab.path)}`)) return;
    for (const s of run.sessions()) {
      if (!s.rerunOnSave || s.closed || !eligible(s)) continue;
      clearTimeout(s.rerunOnSaveTimer);
      s.rerunOnSaveTimer = setTimeout(() => rerun(s), DELAY);
    }
  });

  ide.registerAction({ id: 'ToggleRerunOnSave', title: tr('Rerun on Save'), needsProject: true, run: () => {
    const s = run.activeSession();
    if (s && eligible(s)) set(s, !s.rerunOnSave);
    else ide.ui.alert(tr('Run a configuration first; Rerun on Save then applies to its tab in the Run tool window.'));
  } });

  ide.rerunOnSave = { set, enabled: (s) => !!s?.rerunOnSave };
})();
