// Commit checks, as in PyCharm's commit options (the gear next to the Commit buttons): before a commit (Commit and
// Commit and Push) the chosen checks run in order on the files being committed, with progress and Cancel:
// Reformat code and Optimize imports (ruff, through the tooling plugin's channels; the files are saved and the result is
// committed, after a "Before Commit Checks" Local History checkpoint, and a notification offers Undo whether the commit
// went on or a later check or Cancel stopped it), Analyze code (Pyright and ruff problems: errors stop the commit with Review / Commit Anyway / Cancel),
// Check TODO (TODO and FIXME comments the changes add) and Run tests (a run configuration; failing tests stop it).
(() => {
  const vcs = ide.vcs;
  if (!vcs?.addBeforeCommit) return;
  const { el, basename, samePath } = ide.util;
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };
  const trn = (n, one, many, vars = {}) => tr(n === 1 ? one : many, { n, ...vars });

  // Options are per IDE, as in PyCharm; the test configuration is per project (run configurations are).
  const CHECKS = [
    { id: 'reformat', label: () => tr('Reformat code'), fallback: false },
    { id: 'optimizeImports', label: () => tr('Optimize imports'), fallback: false },
    { id: 'analyze', label: () => tr('Analyze code'), fallback: true },
    { id: 'todo', label: () => tr('Check TODO'), fallback: true },
    { id: 'runTests', label: () => tr('Run tests:'), fallback: false },
  ];
  const settingKey = (id) => `vcs.commitChecks.${id}`;
  const enabled = (id) => !!ide.settings.get(settingKey(id), CHECKS.find((c) => c.id === id).fallback);
  const testConfigKey = () => `vcs.commitChecks.testConfig:${ide.root}`;
  const testConfig = () => {
    const id = ide.root ? ide.settings.get(testConfigKey(), null) : null;
    return (id && ide.run?.configs().find((c) => c.id === id)) || null;
  };
  const toolingAvailable = () => !!ide.tooling;
  const ruffOpts = () => ({ root: ide.root, lineLength: Number(ide.settings.get('tools.ruffLineLength', 0)) || undefined });
  const isPy = (p) => /\.pyi?$/i.test(p);

  // ---------- the gear and its popup ----------
  const gear = el('button', 'tb-icon vcs-checks-gear');
  gear.id = 'vcsCommitOptions';
  gear.title = tr('Commit Options');
  gear.appendChild(ide.icon('settings', '⚙'));
  const progress = el('div', 'vcs-checks-progress hidden');
  progress.id = 'vcsChecksProgress';
  const progressText = el('span', 'vcs-checks-progress-text');
  const cancelLink = el('a', 'vcs-checks-cancel', tr('Cancel'));
  cancelLink.id = 'vcsChecksCancel';
  cancelLink.href = '#';
  progress.append(el('span', 'vcs-checks-spinner'), progressText, cancelLink);
  vcs.addCommitOption(progress);
  vcs.addCommitOption(gear);

  let popup = null;
  const closePopup = () => {
    if (!popup) return;
    popup.remove();
    popup = null;
    removeEventListener('mousedown', outside, true);
    removeEventListener('keydown', onPopupKey, true);
  };
  const outside = (e) => { if (popup && !popup.contains(e.target) && !gear.contains(e.target)) closePopup(); };
  const onPopupKey = (e) => { if (e.key === 'Escape' && popup) { e.stopPropagation(); e.preventDefault(); closePopup(); gear.focus(); } };

  function openPopup() {
    closePopup();
    popup = el('div', 'vcs-checks-popup');
    popup.id = 'vcsChecksPopup';
    popup.appendChild(el('div', 'vcs-checks-head', tr('Before Commit')));
    for (const c of CHECKS) {
      const row = el('label', 'vcs-checks-option');
      row.dataset.check = c.id;
      const box = el('input');
      box.type = 'checkbox';
      box.checked = enabled(c.id);
      const needsTooling = c.id === 'reformat' || c.id === 'optimizeImports';
      box.disabled = (needsTooling && !toolingAvailable()) || (c.id === 'runTests' && !ide.run);
      box.onchange = () => ide.settings.set(settingKey(c.id), box.checked);
      row.append(box, el('span', null, c.label()));
      if (c.id === 'runTests') row.appendChild(configSelect());
      popup.appendChild(row);
    }
    document.body.appendChild(popup);
    const r = gear.getBoundingClientRect();
    const w = popup.offsetWidth;
    popup.style.left = `${Math.max(4, Math.min(r.right - w, innerWidth - w - 4))}px`;
    popup.style.top = `${Math.max(4, r.top - popup.offsetHeight - 4)}px`;
    addEventListener('mousedown', outside, true);
    addEventListener('keydown', onPopupKey, true);
    popup.querySelector('input:not(:disabled)')?.focus();
  }
  gear.onclick = () => (popup ? closePopup() : openPopup());

  // The run configurations of this project; the chosen one is remembered per project.
  function configSelect() {
    const sel = el('select', 'vcs-checks-config');
    sel.id = 'vcsChecksTestConfig';
    const configs = ide.run?.configs() || [];
    if (!configs.length) {
      sel.add(new Option(tr('No run configurations'), ''));
      sel.disabled = true;
      return sel;
    }
    sel.add(new Option(tr('Choose a configuration…'), ''));
    for (const c of configs) {
      const o = new Option(c.name, c.id);
      o.dataset.userText = '';
      sel.add(o);
    }
    sel.value = testConfig()?.id || '';
    sel.onclick = (e) => e.preventDefault(); // a click on the select must not toggle the row's checkbox
    sel.onchange = () => {
      ide.settings.set(testConfigKey(), sel.value || null);
      // choosing a configuration turns the check on, as PyCharm does
      if (sel.value && !enabled('runTests')) {
        ide.settings.set(settingKey('runTests'), true);
        const box = popup?.querySelector('[data-check="runTests"] input');
        if (box) box.checked = true;
      }
    };
    return sel;
  }

  // ---------- running the checks ----------
  let current = null; // the run in progress: {cancelled, cancel(), onCancel}
  cancelLink.onclick = (e) => { e.preventDefault(); current?.cancel(); };

  function startRun(steps) {
    const run = {
      steps,
      rewrites: new Map(), // lower-cased path -> {path, before, text, encoding, written?}: Reformat / Optimize imports
      written: [], // the entries applyRewrites wrote
      checkpointed: false,
      cancelled: false,
      abort: null, // stops what the current step waits for (Pyright, a test run)
      cancel() {
        if (run.cancelled) return;
        run.cancelled = true;
        try { run.abort?.(); } catch {}
      },
    };
    run.task = ide.tasks?.start?.({ title: tr('Checking before commit'), fraction: 0, onCancel: () => run.cancel() }) || null;
    run.step = (i, text) => {
      progressText.textContent = `${text} ${i + 1}/${steps.length}`;
      run.task?.update({ text, fraction: i / steps.length });
    };
    progress.classList.remove('hidden');
    gear.disabled = true;
    current = run;
    return run;
  }
  function endRun(run) {
    if (current === run) current = null;
    progress.classList.add('hidden');
    gear.disabled = false;
    run.task?.done();
  }

  // The text of a file as it will be committed: the open document's (saved before the checks), else the disk's.
  async function readFile(path) {
    const doc = ide.getDocument?.(path);
    if (doc?.model && !doc.model.isDisposed()) return { text: doc.model.getValue(), doc };
    try {
      const r = await ide.api.invoke('fs:readText', path);
      return r.text === undefined ? null : { text: r.text, encoding: r.encoding };
    } catch { return null; }
  }

  // Replaces only the changed middle of the model as one undo step (as the tooling plugin does).
  function applyText(model, text) {
    const old = model.getValue();
    if (old === text) return false;
    const n = Math.min(old.length, text.length);
    let s = 0;
    while (s < n && old[s] === text[s]) s++;
    let e = 0;
    while (e < n - s && old[old.length - 1 - e] === text[text.length - 1 - e]) e++;
    const range = ide.monaco.Range.fromPositions(model.getPositionAt(s), model.getPositionAt(old.length - e));
    model.pushStackElement();
    model.pushEditOperations([], [{ range, text: text.slice(s, text.length - e), forceMoveMarkers: true }], () => null);
    model.pushStackElement();
    return true;
  }

  // Reformat code / Optimize imports: ruff on each Python file being committed, on the text in memory (imports first,
  // then the reformat on their result). A file ruff cannot parse is left as it is. Nothing is written until the last
  // of these steps is done (applyRewrites), so a Cancel during them leaves every file untouched.
  async function rewrite(run, files, channel) {
    const failed = [];
    for (const f of files.filter((x) => x.status !== 'deleted' && isPy(x.path))) {
      if (run.cancelled) return;
      const k = f.path.toLowerCase();
      let entry = run.rewrites.get(k);
      if (!entry) {
        const file = await readFile(f.path);
        if (!file) continue;
        entry = { path: f.path, before: file.text, text: file.text, encoding: file.doc?.encoding || file.encoding };
        run.rewrites.set(k, entry);
      }
      const r = await ide.api.invoke(channel, entry.text, f.path, ruffOpts());
      if (!r.ok) { failed.push(`${ide.util.rel(f.path)}: ${r.error}`); continue; }
      entry.text = r.text;
    }
    if (failed.length) {
      vcs.notify(channel === 'tooling:format' ? tr('Some files could not be reformatted') : tr('Imports could not be optimized in some files'), failed.join('\n'), 'warn', true);
    }
  }

  // The Local History label put before the files are rewritten (English; Local History translates it where shown).
  const CHECKPOINT_LABEL = 'Before Commit Checks';

  // Every file about to be rewritten goes into a Local History checkpoint with its text from before the checks: files
  // the history has never seen (not opened since the project was) would otherwise have no revision to go back to.
  // ide.localHistory.checkpoint() only adds open documents' unsaved text, so the store is asked directly.
  async function checkpoint(entries) {
    if (!ide.localHistory) return false;
    try {
      await ide.localHistory.ready?.();
      const t = await ide.api.invoke('localHistory:checkpoint', ide.root, CHECKPOINT_LABEL, false,
        entries.map((e) => ({ path: e.path, text: e.before, encoding: e.encoding })));
      return t != null;
    } catch (err) {
      console.error('commit checks: cannot put a Local History label', err);
      return false;
    }
  }

  // Writes what the rewrite steps produced: open documents are edited (one undo step) and saved, other files are
  // rewritten in their own encoding and recorded as saves in Local History, after a "Before Commit Checks" checkpoint.
  // A file that changed while ruff ran is left alone. -> the entries written.
  async function applyRewrites(run) {
    const changed = [...run.rewrites.values()].filter((e) => e.text !== e.before && !e.written);
    if (!changed.length || run.cancelled) return [];
    run.checkpointed = (await checkpoint(changed)) || run.checkpointed;
    const written = [];
    for (const e of changed) {
      const now = await readFile(e.path);
      if (!now || now.text !== e.before) continue;
      if (now.doc) {
        applyText(now.doc.model, e.text);
      } else {
        await ide.api.invoke('fs:writeText', e.path, e.text, e.encoding);
        if (ide.localHistory) ide.api.invoke('localHistory:record', ide.root, e.path, 'save').catch(() => {});
      }
      e.written = true;
      written.push(e);
    }
    if (written.length) await ide.saveAll();
    run.written.push(...written);
    return written;
  }

  // Undo of a rewrite: each file goes back to its text from before the checks, unless it changed again since.
  async function undoRewrites(entries) {
    const kept = [];
    let restored = 0;
    for (const e of entries) {
      const now = await readFile(e.path);
      if (!now || now.text !== e.text) { kept.push(ide.util.rel(e.path)); continue; }
      if (now.doc) {
        applyText(now.doc.model, e.before);
        await ide.saveTab({ doc: now.doc });
      } else {
        await ide.api.invoke('fs:writeText', e.path, e.before, e.encoding);
        if (ide.localHistory) ide.api.invoke('localHistory:record', ide.root, e.path, 'revert').catch(() => {});
      }
      restored++;
    }
    await vcs.refresh?.();
    if (kept.length) {
      vcs.notify(trn(kept.length, '{n} file changed after the commit checks and was not restored', '{n} files changed after the commit checks and were not restored'),
        kept.join('\n'), 'warn', true);
    }
    return restored;
  }

  // The result of a rewrite, with Undo (and the Local History label), whether the commit went on or not.
  let lastReport = null; // {count, committing, checkpointed, undo()} of the last rewrite, for tests
  function reportRewrites(run, committing) {
    const n = run.written.length;
    const title = run.steps.includes('reformat')
      ? trn(n, 'Reformatted {n} file before commit', 'Reformatted {n} files before commit')
      : trn(n, 'Optimized imports in {n} file before commit', 'Optimized imports in {n} files before commit');
    const where = run.checkpointed ? ` ${tr('Local History keeps their earlier text under "{label}".', { label: tr(CHECKPOINT_LABEL) })}` : '';
    const text = (committing ? tr('Undo restores the files as they were before the checks.') : tr('The commit was stopped. Undo restores the files as they were before the checks.')) + where;
    const entries = run.written.slice();
    const actions = [{ label: tr('Undo'), run: (note) => { note.expire(); undoRewrites(entries); } }];
    if (run.checkpointed && ide.localHistory?.show) actions.push({ label: tr('Show Local History'), run: () => ide.localHistory.show(ide.root, true) });
    const note = { title, text, kind: committing ? 'info' : 'warn', group: 'Git', actions, timeout: committing ? 10000 : 30000 };
    if (ide.notifications?.notify) ide.notifications.notify(note);
    else vcs.notify(title, text, note.kind);
    run.report = { count: n, committing, checkpointed: !!run.checkpointed, undo: () => undoRewrites(entries) };
    lastReport = run.report;
  }

  // Analyze code: Pyright (the bundled CLI, with the project interpreter) and ruff's lint, as the editor shows them.
  async function analyze(run, files) {
    const py = files.filter((f) => f.status !== 'deleted' && isPy(f.path));
    if (!py.length) return [];
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    run.abort = () => ide.api.invoke('vcs-checks:cancel', id);
    const pyright = await ide.api.invoke('vcs-checks:analyze', id, ide.root, py.map((f) => f.path), ide.currentInterp?.()?.executable || null);
    run.abort = null;
    if (run.cancelled) return [];
    const problems = [];
    if (pyright.ok) for (const d of pyright.diagnostics) problems.push({ ...d, source: 'Pyright' });
    else vcs.notify(tr('Pyright could not analyze the files being committed'), pyright.error || '', 'warn', true);
    if (ide.settings.get('tools.ruffOnSave', true)) {
      for (const f of py) {
        if (run.cancelled) return [];
        const file = await readFile(f.path);
        if (!file) continue;
        const diags = await ide.api.invoke('tooling:check', file.text, f.path, ruffOpts());
        for (const d of Array.isArray(diags) ? diags : []) {
          problems.push({
            path: f.path, line: d.location?.row || 1, col: d.location?.column || 1, endLine: d.end_location?.row, endCol: d.end_location?.column,
            // a diagnostic without a rule code is a syntax error
            severity: d.code ? 'warning' : 'error', message: d.code ? `${d.code} ${d.message}` : d.message, source: 'ruff',
          });
        }
      }
    }
    return problems;
  }

  // Check TODO: TODO and FIXME comments on lines the changes add, which the replaced lines did not have (PyCharm's
  // default patterns \btodo\b.* and \bfixme\b.*, inside comments only).
  const HASH = /\.(py|pyi|pyw|sh|ps1|toml|ya?ml|cfg|ini|rb|pl|r)$/i;
  const SLASH = /\.(js|ts|jsx|tsx|mjs|cjs|java|c|h|cpp|go|rs|kt|swift)$/i;
  function todosIn(line, marker) {
    const i = line.indexOf(marker);
    if (i < 0) return null;
    const m = /\b(todo|fixme)\b.*$/i.exec(line.slice(i + marker.length));
    return m ? m[0].trim() : null;
  }
  async function checkTodo(run, files) {
    const found = [];
    for (const f of files.filter((x) => x.status !== 'deleted')) {
      if (run.cancelled) return [];
      const marker = HASH.test(f.path) ? '#' : SLASH.test(f.path) ? '//' : null;
      if (!marker) continue;
      const file = await readFile(f.path);
      if (!file) continue;
      const fresh = f.status === 'added' || f.status === 'unversioned';
      const before = fresh ? '' : (await vcs.invoke('show', ide.root, f.orig || f.path, 'HEAD')) ?? '';
      const lines = file.text.split(/\r?\n/);
      for (const h of vcs.diffLines(before ? before.split(/\r?\n/) : [], lines)) {
        const old = new Set(h.old.map((l) => todosIn(l, marker)).filter(Boolean));
        for (let n = h.ns; n < h.ns + h.nc; n++) {
          const text = todosIn(lines[n], marker);
          if (text && !old.has(text)) found.push({ path: f.path, line: n + 1, col: lines[n].search(/\b(todo|fixme)\b/i) + 1, message: text, severity: 'todo' });
        }
      }
    }
    return found;
  }

  // Run tests: the chosen run configuration, as Run would start it; failed when its tab ends failed (a test run's
  // status says failed, another program exited with a non-zero code).
  async function runTests(run, cfg) {
    const s = await ide.run.runConfig(cfg);
    if (!s) return { failed: false };
    if (s.running || s.starting) {
      run.abort = () => s.stop();
      await new Promise((resolve) => { s.exitHooks.push(resolve); if (!s.running && !s.starting) resolve(); });
      run.abort = null;
    }
    const state = s.host.querySelector('.tr-status')?.dataset.state;
    const failed = state ? state === 'failed' : !!s.tab.querySelector('.run-tab-icon.failed');
    return { failed, session: s, text: s.host.querySelector('.tr-status')?.textContent || '' };
  }

  // A stopping dialog: resolves 'review', 'commit' or 'cancel' (Esc).
  function ask(title, lines) {
    return new Promise((resolve) => {
      let answer = 'cancel';
      const body = el('div', 'vcs-checks-ask');
      for (const l of lines) body.appendChild(el('div', null, l));
      ide.ui.dialog({
        title, body, width: 460, onClose: () => resolve(answer),
        buttons: [
          { label: tr('Review'), primary: true, run: () => { answer = 'review'; } },
          { label: tr('Commit Anyway'), run: () => { answer = 'commit'; } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  // Review: the problems or TODO items in a tab, grouped by file; a row opens the file at its line.
  function showResults(title, items) {
    const id = `${title} [${tr('Commit Checks')}]`;
    if (ide.findTab(id)) ide.closeTab(id, true);
    ide.openCustomTab({
      id, title, icon: '✓',
      mount(host) {
        const box = el('div', 'vcs-checks-results');
        box.id = 'vcsChecksResults';
        const byFile = new Map();
        for (const it of items) (byFile.get(it.path) || byFile.set(it.path, []).get(it.path)).push(it);
        for (const [path, list] of byFile) {
          const head = el('div', 'vcs-checks-file');
          head.append(Object.assign(ide.fileIcon(path), { className: 'file-icon icon' }), userText('span', null, ide.util.rel(path)), el('span', 'muted', String(list.length)));
          box.appendChild(head);
          for (const it of list.sort((a, b) => a.line - b.line)) {
            const row = el('div', `vcs-checks-row ${it.severity}`);
            row.dataset.path = it.path;
            row.dataset.line = it.line;
            row.tabIndex = 0;
            const sev = { error: tr('Error'), warning: tr('Warning'), todo: 'TODO' }[it.severity];
            row.append(el('span', `vcs-checks-sev ${it.severity}`, sev), userText('span', 'vcs-checks-msg', it.message),
              el('span', 'muted', `${it.source ? `${it.source} ` : ''}${it.line}:${it.col}`));
            const go = () => ide.openFile(it.path, { line: it.line, col: it.col });
            row.onclick = go;
            row.onkeydown = (e) => { if (e.key === 'Enter') go(); };
            box.appendChild(row);
          }
        }
        host.appendChild(box);
      },
    });
  }

  const counts = (problems) => ({ errors: problems.filter((p) => p.severity === 'error').length, warnings: problems.filter((p) => p.severity === 'warning').length });

  // -> false to stop the commit.
  async function beforeCommit({ files }) {
    if (!ide.root) return true;
    const steps = [];
    // Imports first: removing one can leave blank lines that only the reformat after it tidies up.
    if (enabled('optimizeImports') && toolingAvailable()) steps.push('optimizeImports');
    if (enabled('reformat') && toolingAvailable()) steps.push('reformat');
    if (enabled('analyze')) steps.push('analyze');
    if (enabled('todo')) steps.push('todo');
    if (enabled('runTests') && ide.run) {
      if (testConfig()) steps.push('runTests');
      else vcs.notify(tr('No test configuration for commit checks'), tr('Choose a run configuration next to Run tests in the commit options.'), 'warn');
    }
    if (!steps.length) return true;
    closePopup();
    const run = startRun(steps);
    let ok = false;
    try {
      ok = await runSteps(run, files);
      return ok;
    } finally {
      endRun(run);
      // Whatever stopped the commit afterwards (a check, Cancel), the rewritten files can go back in one step.
      if (run.written.length) reportRewrites(run, ok);
    }
  }
  vcs.addBeforeCommit(beforeCommit);

  const REWRITES = new Set(['optimizeImports', 'reformat']);
  async function runSteps(run, files) {
    const { steps } = run;
    for (const [i, step] of steps.entries()) {
      if (run.cancelled) return false;
      if (step === 'reformat') {
        run.step(i, tr('Reformatting code…'));
        await rewrite(run, files, 'tooling:format');
      } else if (step === 'optimizeImports') {
        run.step(i, tr('Optimizing imports…'));
        await rewrite(run, files, 'tooling:optimizeImports');
      } else if (step === 'analyze') {
        run.step(i, tr('Analyzing code…'));
        const problems = await analyze(run, files);
        if (run.cancelled) return false;
        const c = counts(problems);
        if (c.errors) {
          const answer = await ask(tr('Code Analysis'), [
            tr('Code analysis found problems in the files being committed:'),
            `${trn(c.errors, '{n} error', '{n} errors')}, ${trn(c.warnings, '{n} warning', '{n} warnings')}`,
          ]);
          if (answer === 'review') showResults(tr('Code Analysis'), problems);
          if (answer !== 'commit') return false;
        }
      } else if (step === 'todo') {
        run.step(i, tr('Checking TODO…'));
        const todos = await checkTodo(run, files);
        if (run.cancelled) return false;
        if (todos.length) {
          const answer = await ask(tr('Check TODO'), [trn(todos.length, 'The changes add {n} TODO item.', 'The changes add {n} TODO items.')]);
          if (answer === 'review') showResults(tr('Check TODO'), todos);
          if (answer !== 'commit') return false;
        }
      } else if (step === 'runTests') {
        const cfg = testConfig();
        run.step(i, tr('Running tests: {name}…', { name: cfg.name }));
        const r = await runTests(run, cfg);
        if (run.cancelled) return false;
        if (r.failed) {
          const answer = await ask(tr('Tests Failed'), [tr('{name} failed.', { name: cfg.name }), ...(r.text ? [r.text] : [])]);
          if (answer === 'review') r.session?.select();
          if (answer !== 'commit') return false;
        }
      }
      // The rewrites are written once, after the last of them, behind one Local History checkpoint.
      if (REWRITES.has(step) && !REWRITES.has(steps[i + 1])) {
        if (run.cancelled) return false;
        await applyRewrites(run);
      }
    }
    return !run.cancelled;
  }

  ide.vcsChecks = {
    checks: () => CHECKS.map((c) => ({ id: c.id, enabled: enabled(c.id) })),
    testConfig,
    running: () => !!current,
    cancel: () => current?.cancel(),
    openOptions: openPopup,
    // The last Reformat code / Optimize imports result: {count, committing, checkpointed, undo()} (tests).
    lastRewrite: () => lastReport,
  };
})();
