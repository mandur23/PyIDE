// Merging with Git, as in PyCharm: the three-pane merge tool (Yours | Result | Theirs) and the Conflicts dialog,
// Merge into Current / Rebase Current onto from the branch popup with Continue / Skip / Abort while git is stopped,
// Stash / Unstash, and Cherry-Pick / Revert from the Log. Built on ide.vcs from the vcs plugin.
(() => {
  const vcs = ide.vcs;
  if (!vcs) return;
  const { el, basename, dirname, samePath } = ide.util;
  const { invoke, notify, logResult, errorText, userText, trn } = vcs;
  const dateLocale = i18n.locale === 'ko' ? 'ko-KR' : 'en-US';
  const STATUS_LABEL = { modified: tr('Modified'), added: tr('Added'), deleted: tr('Deleted') };

  // Translated text whose {placeholders} are user data (branch names, hashes), each in its own span.
  function fill(text, vars, cls) {
    const out = el('span', cls);
    text.split(/\{(\w+)\}/).forEach((part, i) => {
      if (i % 2) out.append(userText('span', 'vcs-value', vars[part] ?? ''));
      else if (part) out.append(part);
    });
    return out;
  }
  const button = (label, cls, run) => { const b = el('button', cls, label); b.onclick = run; return b; };
  const checkbox = (label, cls) => {
    const box = el('label', `vcs-check ${cls}`);
    const input = el('input');
    input.type = 'checkbox';
    box.append(input, el('span', null, label));
    return { box, input };
  };
  const conflictedFiles = () => (vcs.repo()?.files || []).filter((f) => f.status === 'conflict');
  const inRepo = () => {
    if (vcs.repo()) return true;
    notify(tr('Git'), tr('This project is not under Git version control.'), 'warn');
    return false;
  };

  // ---------- operations that can stop on conflicts ----------
  const CONTINUE = { merge: tr('Continue Merge'), rebase: tr('Continue Rebase'), 'cherry-pick': tr('Continue Cherry-Pick'), revert: tr('Continue Revert') };
  const ABORT = { merge: tr('Abort Merge'), rebase: tr('Abort Rebase'), 'cherry-pick': tr('Abort Cherry-Pick'), revert: tr('Abort Revert') };
  const ABORTED = { merge: tr('Merge aborted'), rebase: tr('Rebase aborted'), 'cherry-pick': tr('Cherry-pick aborted'), revert: tr('Revert aborted') };
  const FINISHED = { merge: tr('Merge committed'), rebase: tr('Rebase finished'), 'cherry-pick': tr('Cherry-pick committed'), revert: tr('Revert committed') };
  const IN_PROGRESS = { merge: tr('Merge in progress'), rebase: tr('Rebase in progress'), 'cherry-pick': tr('Cherry-pick in progress'), revert: tr('Revert in progress') };
  // What finishes the operation once its conflicts are resolved.
  const NEXT_STEP = {
    merge: tr('Commit the merge, or continue it from the Git branches popup.'),
    rebase: tr('Continue the rebase to apply the remaining commits.'),
    'cherry-pick': tr('Continue the cherry-pick to commit it.'),
    revert: tr('Continue the revert to commit it.'),
  };
  const SKIPPABLE = new Set(['rebase', 'cherry-pick']);

  // How a git command that may stop on conflicts ended: done, stopped on conflicts (Conflicts dialog), or git's error.
  async function finish(r, done, failed) {
    logResult(r);
    await vcs.reload();
    if (r.ok) { if (done) notify(done, '', 'ok'); return; }
    if (r.conflicts?.length) return stopped(r);
    notify(failed, errorText(r), 'error', true);
  }

  // Git names the sides of a merge, rebase, cherry-pick or revert; conflicts an unstash or unshelve leaves have no
  // operation, so the command that stopped names the incoming side (the stash or shelf) until they are resolved.
  let incoming = null; // {root, name}
  async function conflictSides() {
    const sides = await invoke('conflictSides', ide.root);
    if (!sides.op && !sides.theirs && incoming && ide.util.samePath(incoming.root, ide.root || '')) sides.theirs = incoming.name;
    return sides;
  }

  function stopped(r) {
    incoming = !r.op && r.theirs ? { root: ide.root, name: r.theirs } : null;
    notify(trn(r.conflicts.length, 'Conflicts in {n} file', 'Conflicts in {n} files'), r.op ? tr('Resolve them, then continue or abort.') : tr('Resolve them to finish.'), 'warn');
    openConflicts();
  }

  function allResolved() {
    incoming = null;
    const op = vcs.repo()?.op;
    notify(tr('All conflicts resolved'), op ? NEXT_STEP[op] : '', 'ok');
  }

  async function chooseBranch(placeholder) {
    const repo = vcs.repo();
    const { local, remote } = await invoke('branches', ide.root);
    const items = [
      ...local.filter((b) => b !== repo.branch).map((b) => ({ label: b, icon: '⑂', hint: tr('Local'), value: b })),
      ...remote.map((b) => ({ label: b, icon: '☁', hint: tr('Remote'), value: b })),
    ];
    if (!items.length) { notify(tr('No other branches'), tr('Create a branch first.'), 'warn'); return null; }
    return ide.ui.pick({ placeholder, items });
  }

  async function mergeInto() {
    if (!inRepo()) return;
    const current = vcs.repo().branch || vcs.repo().detached;
    const branch = await chooseBranch(tr('Merge into {branch}', { branch: current }));
    if (!branch) return;
    await ide.saveAll();
    const r = await invoke('merge', ide.root, branch);
    finish(r, r.moved ? tr('Merged {branch} into {current}', { branch, current }) : tr('Already up to date'), tr('Merge failed'));
  }

  async function rebaseOnto() {
    if (!inRepo()) return;
    const current = vcs.repo().branch || vcs.repo().detached;
    const onto = await chooseBranch(tr('Rebase {branch} onto', { branch: current }));
    if (!onto) return;
    await ide.saveAll();
    const r = await invoke('rebase', ide.root, onto);
    finish(r, r.moved ? tr('Rebased {branch} onto {onto}', { branch: current, onto }) : tr('Already up to date'), tr('Rebase failed'));
  }

  // action: 'continue' | 'skip' | 'abort' for the operation git is stopped in.
  async function control(action) {
    const op = vcs.repo()?.op;
    if (!op) return;
    if (action === 'continue' && conflictedFiles().length) {
      notify(tr('Unresolved conflicts'), tr('Resolve all conflicts before continuing.'), 'warn');
      return openConflicts();
    }
    await ide.saveAll();
    const r = await invoke('operation', ide.root, action);
    const done = action === 'abort' ? ABORTED[op] : action === 'skip' ? tr('Commit skipped') : FINISHED[op];
    finish(r, r.op ? null : done, action === 'abort' ? tr('Abort failed') : tr('Continue failed'));
  }

  vcs.addBranchActions((repo) => {
    if (repo.op) {
      const items = [];
      if (conflictedFiles().length) items.push({ label: tr('Resolve Conflicts…'), icon: '⚠', value: { run: openConflicts } });
      items.push({ label: CONTINUE[repo.op], icon: '▶', value: { run: () => control('continue') } });
      if (SKIPPABLE.has(repo.op)) items.push({ label: tr('Skip Commit'), icon: '⤼', value: { run: () => control('skip') } });
      items.push({ label: ABORT[repo.op], icon: '■', value: { run: () => control('abort') } });
      return items;
    }
    return [
      { label: tr('Merge into Current…'), icon: '⤵', value: { run: mergeInto } },
      { label: tr('Rebase Current onto…'), icon: '⤴', value: { run: rebaseOnto } },
      { label: tr('Stash Changes…'), icon: '⇩', value: { run: openStash } },
      { label: tr('Unstash Changes…'), icon: '⇧', value: { run: openUnstash } },
    ];
  });

  // Above the changes list while git is stopped: what is going on, the conflicts left, and Continue / Skip / Abort.
  vcs.addCommitHeader((repo) => {
    if (!repo.op) return null;
    const n = repo.files.filter((f) => f.status === 'conflict').length;
    const box = el('div', 'vcs-op-banner');
    box.dataset.op = repo.op;
    const text = el('div', 'vcs-op-text');
    text.append(el('span', 'vcs-op-title', IN_PROGRESS[repo.op]));
    if (n) {
      const a = el('a', 'vcs-resolve-link', trn(n, 'Resolve {n} conflict…', 'Resolve {n} conflicts…'));
      a.href = '#';
      a.onclick = (e) => { e.preventDefault(); openConflicts(); };
      text.append(a);
    }
    const btns = el('div', 'vcs-op-btns');
    btns.append(button(tr('Continue'), 'secondary vcs-op-continue', () => control('continue')));
    if (SKIPPABLE.has(repo.op)) btns.append(button(tr('Skip'), 'secondary vcs-op-skip', () => control('skip')));
    btns.append(button(tr('Abort'), 'secondary vcs-op-abort', () => control('abort')));
    box.append(text, btns);
    return box;
  });

  // ---------- Conflicts dialog ----------
  const SIDE_STATUS = { U: tr('Modified'), A: tr('Added'), D: tr('Deleted') };
  let conflictsDialog = null;

  async function openConflicts() {
    if (!inRepo()) return;
    await vcs.refresh();
    if (!conflictedFiles().length) return allResolved();
    const sides = await conflictSides();
    conflictsDialog?.close();
    const selected = new Set();
    const body = el('div', 'vcs-conflicts');
    const table = el('div', 'vcs-conflicts-table');
    const head = el('div', 'vcs-conflict-row vcs-conflict-head');
    head.append(el('span', 'vcs-cf-name', tr('Name')),
      fill(sides.ours ? tr('Yours ({name})') : tr('Yours'), { name: sides.ours }, 'vcs-cf-side'),
      fill(sides.theirs ? tr('Theirs ({name})') : tr('Theirs'), { name: sides.theirs }, 'vcs-cf-side'));
    const rows = el('div', 'vcs-conflict-rows');
    table.append(head, rows);

    const render = () => {
      const files = conflictedFiles();
      for (const p of [...selected]) if (!files.some((f) => f.path === p)) selected.delete(p);
      if (!selected.size && files[0]) selected.add(files[0].path);
      rows.replaceChildren();
      for (const f of files) {
        const row = el('div', 'vcs-conflict-row' + (selected.has(f.path) ? ' selected' : ''));
        row.dataset.path = f.path;
        const name = el('span', 'vcs-cf-name');
        name.append(userText('span', 'vcs-name', basename(f.path)), userText('span', 'muted vcs-dir', samePath(dirname(f.path), ide.root) ? '' : ide.util.rel(dirname(f.path))));
        const xy = f.xy || 'UU';
        row.append(name, el('span', 'vcs-cf-side', SIDE_STATUS[xy[0]] || xy[0]), el('span', 'vcs-cf-side', SIDE_STATUS[xy[1]] || xy[1]));
        row.onclick = (e) => {
          if (!e.ctrlKey) selected.clear();
          if (e.ctrlKey && selected.has(f.path)) selected.delete(f.path); else selected.add(f.path);
          render();
        };
        row.ondblclick = () => mergeFile(f.path);
        rows.appendChild(row);
      }
      return files.length;
    };

    const accept = (side) => async () => {
      const paths = [...selected];
      if (!paths.length) return;
      await ide.saveAll();
      const r = await invoke('acceptSide', ide.root, paths, side);
      logResult(r);
      if (!r.ok) notify(tr('Cannot resolve'), r.log.map((l) => l.err).filter(Boolean).join('\n'), 'error', true);
      await vcs.reload();
      if (!render()) { dlg.close(); allResolved(); }
    };
    const btns = el('div', 'vcs-conflicts-btns');
    btns.append(button(tr('Accept Yours'), 'secondary vcs-accept-yours', accept('ours')),
      button(tr('Accept Theirs'), 'secondary vcs-accept-theirs', accept('theirs')),
      button(tr('Merge…'), 'primary vcs-merge-btn', () => selected.size && mergeFile([...selected][0])));
    body.append(table, btns);
    render();
    const dlg = ide.ui.dialog({
      title: tr('Conflicts'), body, width: 720, buttons: [{ label: tr('Close') }],
      onClose: () => { if (conflictsDialog === dlg) conflictsDialog = null; },
    });
    conflictsDialog = dlg;
    // The keyboard starts in the file list: Up/Down choose the file the buttons act on, Enter merges it.
    ide.ui.listKeys(rows, {
      rows: '.vcs-conflict-row',
      id: (row) => row.dataset.path,
      select: (row) => { selected.clear(); selected.add(row.dataset.path); render(); },
      open: (row) => mergeFile(row.dataset.path),
    });
    rows.focus();
    function mergeFile(path) { dlg.close(); openMergeTool(path); }
  }

  async function afterResolve() {
    if (conflictedFiles().length) openConflicts(); else allResolved();
  }

  // ---------- three-way merge tool ----------
  // Chunks of a three-way merge: the base→yours and base→theirs hunks touching the same base lines form one chunk.
  // Ranges are [start, end) line indexes into base, ours and theirs. kind: 'ours' / 'theirs' (only that side changed),
  // 'same' (both made the same change) or 'conflict'.
  function mergeChunks(B, O, T) {
    const hunks = [...vcs.diffLines(B, O).map((h) => ({ ...h, side: 'ours' })), ...vcs.diffLines(B, T).map((h) => ({ ...h, side: 'theirs' }))]
      .sort((a, b) => a.os - b.os || a.oc - b.oc);
    const chunks = [];
    const off = { ours: 0, theirs: 0 }; // each side's line offset from base before the current chunk
    for (let i = 0; i < hunks.length;) {
      const group = [hunks[i]];
      let end = hunks[i].os + hunks[i].oc;
      let j = i + 1;
      // Touching changes conflict, as in git.
      for (; j < hunks.length && hunks[j].os <= end; j++) { group.push(hunks[j]); end = Math.max(end, hunks[j].os + hunks[j].oc); }
      const bs = group[0].os;
      const chunk = { base: [bs, end] };
      for (const side of ['ours', 'theirs']) {
        const g = group.filter((h) => h.side === side);
        chunk[side] = g.length
          ? [g[0].ns - (g[0].os - bs), g[g.length - 1].ns + g[g.length - 1].nc + (end - g[g.length - 1].os - g[g.length - 1].oc)]
          : [bs + off[side], end + off[side]];
        off[side] = chunk[side][1] - end;
      }
      const changed = (side) => group.some((h) => h.side === side);
      const same = () => O.slice(...chunk.ours).join('\n') === T.slice(...chunk.theirs).join('\n');
      chunk.kind = changed('ours') && changed('theirs') ? (same() ? 'same' : 'conflict') : changed('ours') ? 'ours' : 'theirs';
      chunks.push(chunk);
      i = j;
    }
    return chunks;
  }

  // Color of a chunk on one side, as PyCharm draws it: red conflicts, green insertions, gray deletions, blue changes.
  const changeType = (c, side) => (c.kind === 'conflict' ? 'conflict' : c.base[0] === c.base[1] ? 'added' : c[side][0] === c[side][1] ? 'deleted' : 'modified');
  const other = (side) => (side === 'ours' ? 'theirs' : 'ours');
  const isResolved = (c) => c.state.ours !== 'pending' && c.state.theirs !== 'pending';

  async function openMergeTool(path) {
    const id = `${path} [${tr('merge')}]`; // tab ids double as the status-bar path
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    const [v, sides] = await Promise.all([invoke('mergeVersions', ide.root, path), conflictSides()]);
    if (v.ours == null || v.theirs == null) {
      notify(tr('Cannot merge {name}', { name: basename(path) }), tr('One side deleted the file. Choose Accept Yours or Accept Theirs in the Conflicts dialog.'), 'warn');
      return openConflicts();
    }
    let tool;
    ide.openCustomTab({
      id, title: tr('Merge: {name}', { name: basename(path) }), icon: '⇄',
      mount(host) { tool = mountMergeTool(host, { path, v, sides, close: () => ide.closeTab(id) }); },
      onClose() { tool?.dispose(); },
    });
  }

  let mergeSeq = 0;
  function mountMergeTool(host, { path, v, sides, close }) {
    const M = ide.monaco;
    const split = (s) => s.split(/\r?\n/);
    const lines = { ours: split(v.ours), theirs: split(v.theirs) };
    const chunks = mergeChunks(split(v.base ?? ''), lines.ours, lines.theirs).map((c, id) => ({
      ...c, id, result: [...c.base],
      state: { ours: c.kind === 'theirs' ? 'none' : 'pending', theirs: c.kind === 'ours' ? 'none' : 'pending' },
    }));
    const eol = /\r\n/.test(v.working ?? v.ours) ? '\r\n' : '\n';
    const seq = ++mergeSeq;
    const uri = (pane) => M.Uri.from({ scheme: 'vcs-merge', path: `/${seq}/${pane}/${basename(path)}` });
    // The result starts as the common base, like PyCharm; every change is then accepted or ignored chunk by chunk.
    const models = {
      ours: M.editor.createModel(v.ours, undefined, uri('ours')),
      result: M.editor.createModel(v.base ?? '', undefined, uri('result')),
      theirs: M.editor.createModel(v.theirs, undefined, uri('theirs')),
    };
    models.result.setEOL(eol === '\r\n' ? M.editor.EndOfLineSequence.CRLF : M.editor.EndOfLineSequence.LF);

    const root = el('div', 'vcs-mt');
    const bar = el('div', 'vcs-mt-bar');
    const applyAllBtn = button(tr('Apply Non-Conflicting Changes'), 'secondary vcs-mt-apply-all', () => applyNonConflicting());
    const nav = (glyph, title, dir) => { const b = button(glyph, 'vcs-mt-nav', () => go(dir)); b.title = title; return b; };
    const status = el('span', 'vcs-mt-status');
    bar.append(applyAllBtn, nav('↑', tr('Previous Difference'), -1), nav('↓', tr('Next Difference'), 1), el('span', 'vcs-spacer'), status);
    const head = el('div', 'vcs-mt-head');
    head.append(
      fill(sides.ours ? tr('Yours ({name}) — read-only') : tr('Yours — read-only'), { name: sides.ours }, 'vcs-diff-side'), el('span'),
      el('span', 'vcs-diff-side vcs-mt-result-title', tr('Result')), el('span'),
      fill(sides.theirs ? tr('Theirs ({name}) — read-only') : tr('Theirs — read-only'), { name: sides.theirs }, 'vcs-diff-side'));
    const body = el('div', 'vcs-mt-body');
    const boxes = { ours: el('div', 'vcs-mt-pane'), result: el('div', 'vcs-mt-pane vcs-mt-result'), theirs: el('div', 'vcs-mt-pane') };
    const strips = { ours: el('div', 'vcs-mt-strip'), theirs: el('div', 'vcs-mt-strip') };
    strips.ours.dataset.side = 'ours';
    strips.theirs.dataset.side = 'theirs';
    body.append(boxes.ours, strips.ours, boxes.result, strips.theirs, boxes.theirs);
    const foot = el('div', 'vcs-mt-foot');
    foot.append(button(tr('Accept Left'), 'secondary vcs-mt-accept-left', () => resolveWith(v.ours)),
      button(tr('Accept Right'), 'secondary vcs-mt-accept-right', () => resolveWith(v.theirs)), el('span', 'vcs-spacer'),
      button(tr('Apply'), 'primary vcs-mt-apply', () => apply()), button(tr('Cancel'), 'secondary vcs-mt-cancel', () => close()));
    root.append(bar, head, body, foot);
    host.appendChild(root);

    const opts = {
      automaticLayout: true, fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 14, lineHeight: 22,
      minimap: { enabled: false }, scrollBeyondLastLine: false, folding: false, glyphMargin: false, lineNumbersMinChars: 3,
    };
    const eds = {
      ours: M.editor.create(boxes.ours, { ...opts, model: models.ours, readOnly: true }),
      result: M.editor.create(boxes.result, { ...opts, model: models.result }),
      theirs: M.editor.create(boxes.theirs, { ...opts, model: models.theirs, readOnly: true }),
    };
    const lh = 22;
    let disposed = false;

    // ----- decorations: whole-line backgrounds, or a line between two lines where a side has no lines -----
    const decoIds = { ours: [], result: [], theirs: [] };
    function deco(model, [s, e], type, done) {
      if (s < e) return [{ range: new M.Range(s + 1, 1, e, 1), options: { isWholeLine: true, className: `vcs-mt-${type}${done ? ' done' : ''}`, marginClassName: `vcs-mt-${type}${done ? ' done' : ''}` } }];
      const n = model.getLineCount();
      const at = s < n ? s + 1 : n;
      return [{ range: new M.Range(at, 1, at, 1), options: { isWholeLine: true, className: `vcs-mt-gap ${s < n ? 'top' : 'bottom'} vcs-mt-gap-${type}${done ? ' done' : ''}` } }];
    }
    function decorate() {
      const d = { ours: [], result: [], theirs: [] };
      for (const c of chunks) {
        for (const side of ['ours', 'theirs']) if (c.state[side] !== 'none') d[side].push(...deco(models[side], c[side], changeType(c, side), c.state[side] !== 'pending'));
        d.result.push(...deco(models.result, c.result, changeType(c, c.kind === 'theirs' ? 'theirs' : 'ours'), isResolved(c)));
      }
      for (const k of Object.keys(d)) decoIds[k] = models[k].deltaDecorations(decoIds[k], d[k]);
    }

    // ----- the strips between the panes: connectors and the accept (» «) / ignore (✕) buttons -----
    const SVGNS = 'http://www.w3.org/2000/svg';
    const yOf = (ed, i) => {
      const n = ed.getModel().getLineCount();
      return (i < n ? ed.getTopForLineNumber(i + 1) : ed.getTopForLineNumber(n) + lh) - ed.getScrollTop();
    };
    function renderStrip(side) {
      const strip = strips[side];
      const w = strip.clientWidth;
      const h = strip.clientHeight;
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'vcs-mt-links');
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      const nodes = [svg];
      const sx = side === 'ours' ? 0 : w;
      const rx = w - sx;
      for (const c of chunks) {
        if (c.state[side] === 'none') continue;
        const [a1, a2] = c[side].map((i) => yOf(eds[side], i));
        const [b1, b2] = c.result.map((i) => yOf(eds.result, i));
        if (Math.max(a2, b2) < -lh || Math.min(a1, b1) > h + lh) continue;
        const m = w / 2;
        const p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('d', `M${sx} ${a1}C${m} ${a1} ${m} ${b1} ${rx} ${b1}L${rx} ${b2}C${m} ${b2} ${m} ${a2} ${sx} ${a2}Z`);
        p.setAttribute('class', `vcs-mt-link vcs-mt-${changeType(c, side)}${c.state[side] !== 'pending' ? ' done' : ''}`);
        svg.appendChild(p);
        if (c.state[side] !== 'pending') continue;
        const acts = el('div', 'vcs-mt-actions');
        acts.style.top = `${a1 - (a1 === a2 ? 9 : 0)}px`;
        const appending = c.kind === 'conflict' && c.state[other(side)] === 'applied';
        const accept = button(side === 'ours' ? '»' : '«', 'vcs-mt-act accept', () => acceptSide(c, side));
        accept.title = appending ? tr('Append') : tr('Accept');
        const ignore = button('✕', 'vcs-mt-act ignore', () => ignoreSide(c, side));
        ignore.title = tr('Ignore');
        for (const b of [accept, ignore]) { b.dataset.chunk = c.id; b.dataset.side = side; }
        acts.append(...(side === 'ours' ? [ignore, accept] : [accept, ignore]));
        nodes.push(acts);
      }
      strip.replaceChildren(...nodes);
    }
    const renderStrips = () => { if (!disposed) { renderStrip('ours'); renderStrip('theirs'); } };

    function refreshView() {
      decorate();
      renderStrips();
      const pending = chunks.filter((c) => !isResolved(c));
      const conflicts = pending.filter((c) => c.kind === 'conflict').length;
      const changes = pending.length - conflicts;
      status.textContent = pending.length
        ? [conflicts && trn(conflicts, '{n} conflict', '{n} conflicts'), changes && trn(changes, '{n} non-conflicting change', '{n} non-conflicting changes')].filter(Boolean).join(' · ')
        : tr('All changes have been processed');
      status.classList.toggle('done', !pending.length);
      applyAllBtn.disabled = !changes;
    }

    // ----- editing the result -----
    let applying = false;
    // Replaces result lines [s, e) with `text` lines as one undoable edit and moves the chunks after `c`.
    function replaceResult(c, s, e, text) {
      const model = models.result;
      const total = model.getLineCount();
      let range;
      let insert;
      if (e < total) { range = new M.Range(s + 1, 1, e + 1, 1); insert = text.map((l) => l + eol).join(''); }
      else if (s > 0) { range = new M.Range(s, model.getLineMaxColumn(s), total, model.getLineMaxColumn(total)); insert = text.map((l) => eol + l).join(''); }
      else { range = model.getFullModelRange(); insert = text.join(eol); }
      applying = true;
      model.pushStackElement();
      model.pushEditOperations([], [{ range, text: insert }], () => null);
      model.pushStackElement();
      applying = false;
      const delta = text.length - (e - s);
      c.result[1] += delta;
      for (const o of chunks) if (o.id > c.id) { o.result[0] += delta; o.result[1] += delta; }
    }
    // Typing in the result moves the chunks below and resizes the one typed in.
    models.result.onDidChangeContent((e) => {
      if (applying) return;
      for (const ch of e.changes) {
        const s = ch.range.startLineNumber - 1;
        const end = ch.range.endLineNumber - 1;
        const delta = (ch.text.match(/\r\n|\r|\n/g) || []).length - (end - s);
        for (const c of chunks) {
          if (c.result[0] > end) { c.result[0] += delta; c.result[1] += delta; } else if (c.result[1] > s) c.result[1] = Math.max(c.result[0], c.result[1] + delta);
        }
      }
      refreshView();
    });

    // In a conflict the second accepted side goes below the first, as PyCharm's append does.
    function acceptSide(c, side) {
      const text = lines[side].slice(...c[side]);
      if (c.kind === 'conflict' && c.state[other(side)] === 'applied') replaceResult(c, c.result[1], c.result[1], text);
      else replaceResult(c, c.result[0], c.result[1], text);
      c.state[side] = 'applied';
      if (c.kind === 'same') c.state[other(side)] = 'applied';
      refreshView();
    }
    function ignoreSide(c, side) {
      c.state[side] = 'ignored';
      if (c.kind === 'same') c.state[other(side)] = 'ignored';
      refreshView();
    }
    function applyNonConflicting() {
      for (const c of chunks) if (c.kind !== 'conflict' && !isResolved(c)) acceptSide(c, c.kind === 'theirs' ? 'theirs' : 'ours');
    }

    function go(dir) {
      const pending = chunks.filter((c) => !isResolved(c));
      if (!pending.length) return;
      const line = (eds.result.getPosition()?.lineNumber || 1) - 1;
      let target = dir > 0 ? pending.find((c) => c.result[0] > line) : [...pending].reverse().find((c) => c.result[0] < line);
      target ||= dir > 0 ? pending[0] : pending[pending.length - 1];
      const at = Math.min(target.result[0] + 1, models.result.getLineCount());
      eds.result.setPosition({ lineNumber: at, column: 1 });
      eds.result.revealLineInCenter(at);
      eds.result.focus();
    }

    // ----- scrolling the three panes together, line for line outside chunks and proportionally inside them -----
    function mapLine(i, from, to) {
      let delta = 0;
      for (const c of chunks) {
        const [fs, fe] = c[from];
        const [ts, te] = c[to];
        if (i < fs) break;
        if (i < fe) return ts + ((i - fs) * (te - ts)) / (fe - fs);
        delta = te - fe;
      }
      return i + delta;
    }
    let syncing = false;
    function sync(from) {
      if (syncing) return;
      syncing = true;
      const top = eds[from].getScrollTop() / lh;
      const inResult = from === 'result' ? top : mapLine(top, from, 'result');
      for (const to of ['ours', 'result', 'theirs']) {
        if (to !== from) eds[to].setScrollTop((to === 'result' ? inResult : mapLine(inResult, 'result', to)) * lh);
      }
      syncing = false;
      renderStrips();
    }
    for (const [name, ed] of Object.entries(eds)) {
      ed.onDidScrollChange((e) => (e.scrollTopChanged ? sync(name) : renderStrips()));
      ed.onDidLayoutChange(renderStrips);
    }

    // ----- finishing: write the result and mark the file resolved (git add) -----
    async function resolveWith(text) {
      const r = await invoke('resolve', ide.root, path, text);
      logResult(r);
      if (!r.ok) return notify(tr('Cannot resolve'), errorText(r), 'error', true);
      // The file's editor takes the result before the tool goes, as PyCharm's merge writes into the document: closing
      // first showed the old text until vcs.reload's pass over every open file got to it (seconds on a busy machine).
      await ide.reloadFromDisk([path]);
      close();
      await vcs.reload();
      afterResolve();
    }
    function apply() {
      const left = chunks.filter((c) => !isResolved(c)).length;
      if (!left) return resolveWith(models.result.getValue());
      const msg = el('div', null, trn(left, '{n} change is not processed. Save the result and mark the file as resolved anyway?', '{n} changes are not processed. Save the result and mark the file as resolved anyway?'));
      ide.ui.dialog({
        title: tr('Unprocessed Changes'), body: msg, width: 460,
        buttons: [{ label: tr('Apply Anyway'), primary: true, run: () => { resolveWith(models.result.getValue()); } }, { label: tr('Continue Merging') }],
      });
    }

    refreshView();
    root._vcsMerge = { chunks, eds, models };
    return {
      dispose() {
        disposed = true;
        for (const ed of Object.values(eds)) ed.dispose();
        M.editor.create(el('div')).dispose(); // rebinds Monaco's hover delegate after scoped editors go (see vcs mountDiff)
        for (const m of Object.values(models)) m.dispose();
      },
    };
  }

  vcs.setConflictHandler({ open: openMergeTool, resolve: openConflicts, stopped });

  // ---------- stash ----------
  function openStash() {
    if (!inRepo()) return;
    const repo = vcs.repo();
    const body = el('div', 'vcs-stash-new');
    const msg = el('input', 'vcs-stash-msg');
    const field = el('label', 'field');
    field.append(el('span', null, tr('Message')), msg);
    const untracked = checkbox(tr('Include untracked files'), 'vcs-stash-untracked');
    const keep = checkbox(tr('Keep index'), 'vcs-stash-keep');
    body.append(fill(tr('Branch: {branch}'), { branch: repo.branch || repo.detached || 'HEAD' }, 'vcs-stash-branch'), field, untracked.box, keep.box);
    ide.ui.dialog({
      title: tr('Stash Changes'), body, width: 480,
      buttons: [
        { label: tr('Create Stash'), primary: true, run: async () => {
          await ide.saveAll();
          const message = msg.value.trim();
          const r = await invoke('stash', ide.root, { message, untracked: untracked.input.checked, keepIndex: keep.input.checked });
          logResult(r);
          if (r.reason === 'noLocalChanges') return notify(tr('Nothing to stash'), errorText(r), 'warn');
          if (!r.ok) return notify(tr('Stash failed'), errorText(r), 'error', true);
          notify(tr('Changes stashed'), message, 'ok', true);
          await vcs.reload();
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  async function showStashDiff(s, f) {
    const [left, right] = await Promise.all([
      f.status === 'added' ? '' : invoke('fileAt', ide.root, `${s.hash}^1`, f.rel),
      // untracked files live in the stash's third parent
      f.status === 'deleted' ? '' : invoke('fileAt', ide.root, s.hash, f.rel).then((t) => t ?? invoke('fileAt', ide.root, `${s.hash}^3`, f.rel)),
    ]);
    vcs.openTextDiff({
      id: `${f.path} [${s.hash.slice(0, 8)}]`, title: `${basename(f.rel)} (${s.ref})`, name: basename(f.rel), left: left ?? '', right: right ?? '',
      leftTitle: tr('Base — read-only'), rightTitle: tr('Stashed changes ({ref}) — read-only', { ref: s.ref }),
    });
  }

  function openUnstash() {
    if (!inRepo()) return;
    const body = el('div', 'vcs-unstash');
    const list = el('div', 'vcs-stash-list');
    const files = el('div', 'vcs-stash-files');
    const top = el('div', 'vcs-unstash-top');
    top.append(list, files);
    const pop = checkbox(tr('Pop stash'), 'vcs-stash-pop');
    const index = checkbox(tr('Reinstate index'), 'vcs-stash-index');
    const dropBtn = button(tr('Drop'), 'secondary vcs-stash-drop', () => askDrop());
    const opts = el('div', 'vcs-unstash-opts');
    opts.append(pop.box, index.box, el('span', 'vcs-spacer'), dropBtn);
    const branchIn = el('input', 'vcs-stash-branch-name');
    const field = el('label', 'field');
    field.append(el('span', null, tr('As new branch')), branchIn);
    const confirm = el('div', 'vcs-stash-confirm hidden');
    body.append(top, opts, field, confirm);
    let stashes = [];
    let selected = null;
    let filesSeq = 0;

    async function load() {
      stashes = await invoke('stashList', ide.root);
      if (!stashes.some((s) => s.ref === selected)) selected = stashes[0]?.ref || null;
      renderList();
    }
    function renderList() {
      list.replaceChildren();
      if (!stashes.length) list.appendChild(el('div', 'vcs-empty muted', tr('No stashed changes')));
      for (const s of stashes) {
        const row = el('div', 'vcs-stash-row' + (s.ref === selected ? ' selected' : ''));
        row.dataset.ref = s.ref;
        const what = el('div', 'vcs-stash-what');
        what.append(userText('span', 'vcs-stash-ref', s.ref), userText('span', 'vcs-stash-message', s.message));
        const where = el('div', 'muted vcs-stash-where');
        where.append(userText('span', null, s.branch || ''), el('span', null, new Date(s.time * 1000).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })));
        row.append(what, where);
        row.onclick = () => { selected = s.ref; confirm.classList.add('hidden'); renderList(); };
        list.appendChild(row);
      }
      dropBtn.disabled = !selected;
      applyBtn().disabled = !selected;
      loadFiles();
    }
    async function loadFiles() {
      const my = ++filesSeq;
      const s = stashes.find((x) => x.ref === selected);
      if (!s) return files.replaceChildren();
      const changed = await invoke('stashFiles', ide.root, s.ref);
      if (my !== filesSeq) return;
      files.replaceChildren(el('div', 'vcs-side-title', trn(changed.length, '{n} file changed', '{n} files changed')));
      for (const f of changed) {
        const row = el('div', 'vcs-file vcs-stash-file');
        row.dataset.rel = f.rel;
        row.title = `${f.rel} — ${STATUS_LABEL[f.status]}`;
        const name = userText('span', 'vcs-name', basename(f.rel));
        name.style.color = `var(--vcs-${f.status})`;
        row.append(name, userText('span', 'muted vcs-dir', f.rel.includes('/') ? dirname(f.rel) : ''));
        row.ondblclick = () => { dlg.close(); showStashDiff(s, f); };
        files.appendChild(row);
      }
    }
    function askDrop() {
      if (!selected) return;
      const ref = selected;
      confirm.replaceChildren(fill(tr('Drop {ref}? Its changes will be lost.'), { ref }), el('span', 'vcs-spacer'),
        button(tr('Drop'), 'secondary vcs-stash-drop-yes', async () => {
          const r = await invoke('stashDrop', ide.root, ref);
          logResult(r);
          if (!r.ok) notify(tr('Drop failed'), errorText(r), 'error', true);
          confirm.classList.add('hidden');
          await load();
        }),
        button(tr('Cancel'), 'secondary', () => confirm.classList.add('hidden')));
      confirm.classList.remove('hidden');
    }

    const dlg = ide.ui.dialog({
      title: tr('Unstash Changes'), body, width: 760,
      buttons: [
        { label: tr('Apply Stash'), primary: true, run: async () => {
          const s = stashes.find((x) => x.ref === selected);
          if (!s) return false;
          const branch = branchIn.value.trim().replace(/\s+/g, '-');
          const popped = pop.input.checked;
          await ide.saveAll();
          const r = await invoke('unstash', ide.root, s.ref, { pop: popped, index: index.input.checked, branch: branch || null });
          const done = branch ? tr('Unstashed {ref} onto the new branch {branch}', { ref: s.ref, branch }) : popped ? tr('Unstashed {ref}', { ref: s.ref }) : tr('Applied {ref}', { ref: s.ref });
          finish({ ...r, theirs: s.ref }, done, tr('Unstash failed'));
        } },
        { label: tr('Cancel') },
      ],
    });
    const applyBtn = () => dlg.el.querySelector('.dialog-buttons .primary');
    pop.input.onchange = () => { applyBtn().textContent = pop.input.checked ? tr('Pop Stash') : tr('Apply Stash'); };
    load();
  }

  // ---------- cherry-pick and revert from the Log ----------
  async function applyCommit(kind, c) {
    await ide.saveAll();
    const r = await invoke(kind, ide.root, c.hash, c.parents.length > 1);
    const vars = { hash: c.short, subject: c.subject };
    finish(r, kind === 'cherryPick' ? tr('Cherry-picked {hash}: {subject}', vars) : tr('Reverted {hash}: {subject}', vars),
      kind === 'cherryPick' ? tr('Cherry-pick failed') : tr('Revert failed'));
  }
  vcs.addLogActions((c) => {
    const busy = !!vcs.repo()?.op;
    return [
      { label: tr('Cherry-Pick'), disabled: busy, run: () => applyCommit('cherryPick', c) },
      { label: tr('Revert Commit'), disabled: busy, run: () => applyCommit('revert', c) },
    ];
  });

  [
    { id: 'Git.Merge', title: tr('Merge…'), run: mergeInto },
    { id: 'Git.Rebase', title: tr('Rebase…'), run: rebaseOnto },
    { id: 'Git.ResolveConflicts', title: tr('Resolve Conflicts…'), run: openConflicts },
    { id: 'Git.Stash', title: tr('Stash Changes…'), run: openStash },
    { id: 'Git.Unstash', title: tr('Unstash Changes…'), run: openUnstash },
  ].forEach(ide.registerAction);
})();
