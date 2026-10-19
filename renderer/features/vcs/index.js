(() => {
  const { el, basename, dirname, samePath } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(`git:${ch}`, ...args);
  const key = (p) => p.toLowerCase();
  // PyCharm file status colors, defined per theme in style.css (Darcula / Light).
  const COLORS = Object.fromEntries(['modified', 'added', 'deleted', 'unversioned', 'conflict'].map((s) => [s, `var(--vcs-${s})`]));
  // Monaco's overview ruler needs a concrete color, so read the theme's variable when decorating.
  const gutterColor = (type) => getComputedStyle(document.documentElement).getPropertyValue(`--vcs-gutter-${type}`).trim();
  const STATUS_LABEL = { modified: tr('Modified'), added: tr('Added'), deleted: tr('Deleted'), unversioned: tr('Unversioned'), conflict: tr('Merge Conflict') };
  // Singular/plural message pair with {n} and optional placeholders.
  const trn = (n, one, many, vars = {}) => tr(n === 1 ? one : many, { n, ...vars });
  const nFiles = (n) => trn(n, '{n} file', '{n} files');
  const dateLocale = i18n.locale === 'ko' ? 'ko-KR' : 'en-US';
  // Text that is user data (paths, git output, commit messages, names) and must stay as is.
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };

  // Errors this feature composes in the main process come with a reason; anything else is git's own text.
  const REASONS = {
    notRepo: tr('Not a Git repository'),
    noRemote: tr('No remotes are defined for this repository.'),
    detached: tr('Cannot push from a detached HEAD.'),
  };
  const errorText = (r) => (r.reason && REASONS[r.reason]) || r.err || r.out || '';

  let repo = null; // git:status result while the project is a repository
  const byPath = new Map(); // lower-cased path -> changed file
  let lastHead;

  // ---------- notifications and the Git console ----------
  const notes = el('div', 'vcs-notes');
  document.body.appendChild(notes);
  // raw: the text is git output or a path, shown untranslated.
  function notify(title, text = '', kind = 'info', raw = false) {
    const note = el('div', `vcs-note ${kind}`);
    note.appendChild(el('div', 'vcs-note-title', title));
    if (text) note.appendChild((raw ? userText : el)('div', 'vcs-note-text', text.trim()));
    const close = el('button', 'vcs-note-close', '×');
    close.onclick = (e) => { e.stopPropagation(); note.remove(); };
    note.appendChild(close);
    note.onclick = () => { showConsole(); note.remove(); };
    notes.appendChild(note);
    setTimeout(() => note.remove(), kind === 'error' ? 20000 : 10000);
    return note;
  }

  let gitConsole = null;
  function logResult(r) {
    if (!gitConsole || !r) return;
    for (const entry of r.log || [r]) {
      if (!entry.cmd) continue;
      gitConsole.append(`${new Date().toLocaleTimeString()}: ${entry.cmd}\n`, 'cmd');
      if (entry.out) gitConsole.append(entry.out.endsWith('\n') ? entry.out : `${entry.out}\n`);
      // git reports progress on stderr even when it succeeds
      if (entry.err) gitConsole.append(entry.err.endsWith('\n') ? entry.err : `${entry.err}\n`, r.ok ? 'sys' : 'err');
    }
  }

  // Reloads tabs from disk after git rewrote files; unlike ide.reloadFromDisk this also replaces unsaved edits.
  async function reloadTabs(paths, force) {
    if (!force) return ide.reloadFromDisk(paths);
    for (const tab of ide.tabs.filter((t) => t.kind === 'file' && paths.some((p) => samePath(p, t.path)))) {
      let text;
      try { text = await ide.api.read(tab.path); } catch { continue; }
      if (text !== tab.model.getValue()) tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
      tab.savedVersion = tab.model.getAlternativeVersionId();
    }
    ide.renderTabs();
  }

  // ---------- status refresh ----------
  let refreshSeq = 0;
  let refreshTimer;
  const scheduleRefresh = (ms = 200) => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, ms); };
  const treeSig = () => [...byPath.values()].map((f) => `${key(f.path)}:${f.status}`).sort().join('|');

  async function refresh() {
    const root = ide.root;
    if (!root) return;
    const my = ++refreshSeq;
    const st = await invoke('status', root);
    if (my !== refreshSeq || root !== ide.root) return;
    const before = treeSig();
    repo = st.isRepo ? st : null;
    byPath.clear();
    for (const f of repo?.files || []) byPath.set(key(f.path), f);
    for (const k of [...selection]) if (!byPath.has(k)) selection.delete(k);
    const head = repo?.head || null;
    if (head !== lastHead) {
      lastHead = head;
      headCache.clear();
      if (gitTw.isVisible()) loadLog();
    }
    repoKey.set(!!repo);
    renderWidget();
    renderChanges();
    if (treeSig() !== before) ide.refreshTree();
    updateGutter(ide.activeTab());
  }

  ide.registerTreeDecorator((entry) => {
    const f = !entry.dir && byPath.get(key(entry.path));
    return f ? { color: COLORS[f.status] } : null;
  });

  // ---------- branch widget ----------
  const branchBtn = el('button', 'tb-btn vcs-branch hidden');
  branchBtn.title = tr('Git Branches');
  ide.registerToolbarItem({ side: 'left', order: 10, el: branchBtn });

  function renderWidget() {
    branchBtn.classList.toggle('hidden', !repo);
    if (!repo) return;
    branchBtn.replaceChildren(el('span', 'vcs-branch-icon', '⑂'), userText('span', 'vcs-branch-name', repo.branch || repo.detached || 'HEAD'), el('span', 'vcs-caret', '▾'));
  }

  async function afterCheckout() {
    headCache.clear();
    await ide.reloadFromDisk();
    ide.refreshTree();
    await refresh();
    if (gitTw.isVisible()) loadLog();
  }

  async function showBranches() {
    if (!repo) return;
    const { local, remote } = await invoke('branches', ide.root);
    const items = [{ label: tr('New Branch…'), icon: '＋', value: { create: true } }];
    for (const b of local) items.push({ label: b, icon: b === repo.branch ? '★' : '⑂', hint: b === repo.branch ? tr('current') : tr('Local'), value: { name: b } });
    for (const b of remote) items.push({ label: b, icon: '☁', hint: tr('Remote'), value: { name: b, remote: true } });
    const choice = await ide.ui.pick({ placeholder: tr('Git Branches — {branch}', { branch: repo.branch || repo.detached }), items });
    if (!choice) return;
    if (choice.create) {
      const name = await ide.ui.prompt(tr('New branch name'), '');
      if (!name) return;
      await ide.saveAll(); // like PyCharm: unsaved edits reach disk before HEAD moves, so git sees (and carries) them
      const r = await invoke('newBranch', ide.root, name.replace(/\s+/g, '-'));
      logResult(r);
      if (!r.ok) return notify(tr('Branch creation failed'), errorText(r), 'error', true);
      return afterCheckout();
    }
    if (choice.name === repo.branch) return;
    await ide.saveAll();
    let r;
    if (choice.remote) {
      const localName = choice.name.split('/').slice(1).join('/');
      r = local.includes(localName) ? await invoke('checkout', ide.root, localName) : await invoke('checkout', ide.root, choice.name, true);
    } else r = await invoke('checkout', ide.root, choice.name);
    logResult(r);
    if (!r.ok) return notify(tr('Checkout failed'), errorText(r), 'error', true);
    notify(tr('Checked out {branch}', { branch: choice.remote ? choice.name.split('/').slice(1).join('/') : choice.name }), '', 'ok');
    afterCheckout();
  }
  branchBtn.onclick = showBranches;

  // ---------- Commit tool window ----------
  const included = new Map(); // lower path -> explicit checkbox choice
  const selection = new Set(); // lower paths selected in the changes list
  let listEl, msgEl, initBox, commitBody;
  const fileIncluded = (f) => included.get(key(f.path)) ?? f.status !== 'unversioned';

  const commitTw = ide.registerToolWindow({
    id: 'Commit', title: tr('Commit'), icon: '✓', side: 'left', keys: 'Alt+0', order: 10,
    mount(container, tw) {
      initBox = el('div', 'vcs-init');
      initBox.appendChild(el('div', 'muted', tr('Version control is not configured for this project.')));
      const initBtn = el('button', 'primary vcs-init-btn', tr('Create Git Repository…'));
      initBtn.onclick = createRepository;
      initBox.appendChild(initBtn);

      commitBody = el('div', 'vcs-commit hidden');
      listEl = el('div', 'vcs-changes');
      listEl.tabIndex = 0;
      listEl.onkeydown = onListKey;
      msgEl = el('textarea', 'vcs-msg');
      msgEl.placeholder = tr('Commit Message');
      msgEl.onkeydown = (e) => {
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doCommit(false); }
      };
      const btns = el('div', 'vcs-commit-btns');
      const commitBtn = el('button', 'primary vcs-commit-btn', tr('Commit'));
      commitBtn.title = tr('Commit (Ctrl+Enter)');
      commitBtn.onclick = () => doCommit(false);
      const pushBtn = el('button', 'secondary vcs-commit-push-btn', tr('Commit and Push…'));
      pushBtn.onclick = () => doCommit(true);
      btns.append(commitBtn, pushBtn);
      commitBody.append(listEl, msgEl, btns);
      container.append(initBox, commitBody);
      tw.setActions([
        { icon: '⟳', title: tr('Refresh'), run: refresh },
        { icon: '↶', title: tr('Rollback… (Ctrl+Alt+Z)'), run: () => rollbackFiles(selectedFiles()) },
        { icon: '⇆', title: tr('Show Diff'), run: () => selectedFiles()[0] && openWorkingDiff(selectedFiles()[0].path) },
      ]);
    },
  });

  const selectedFiles = () => [...selection].map((k) => byPath.get(k)).filter(Boolean);

  function renderChanges() {
    if (!listEl) return;
    initBox.classList.toggle('hidden', !!repo || !ide.root);
    commitBody.classList.toggle('hidden', !repo);
    commitTw.setBadge(repo?.files.length ? String(repo.files.length) : '');
    if (!repo) return;
    const scroll = listEl.scrollTop;
    listEl.replaceChildren();
    const changes = repo.files.filter((f) => f.status !== 'unversioned');
    const unversioned = repo.files.filter((f) => f.status === 'unversioned');
    renderGroup(tr('Changes'), changes);
    if (unversioned.length) renderGroup(tr('Unversioned Files'), unversioned);
    listEl.scrollTop = scroll;
  }

  function renderGroup(title, files) {
    const head = el('div', 'vcs-group');
    const cb = el('input');
    cb.type = 'checkbox';
    const on = files.filter(fileIncluded).length;
    cb.checked = files.length > 0 && on === files.length;
    cb.indeterminate = on > 0 && on < files.length;
    cb.disabled = !files.length;
    cb.onchange = () => { for (const f of files) included.set(key(f.path), cb.checked); renderChanges(); };
    head.append(el('span', 'arrow', '▾'), cb, el('span', 'vcs-group-title', title), el('span', 'muted', nFiles(files.length)));
    listEl.appendChild(head);
    for (const f of files) {
      const row = el('div', 'vcs-file' + (selection.has(key(f.path)) ? ' selected' : ''));
      row.dataset.path = f.path;
      row.dataset.status = f.status;
      const fcb = el('input');
      fcb.type = 'checkbox';
      fcb.checked = fileIncluded(f);
      fcb.onclick = (e) => e.stopPropagation();
      fcb.onchange = () => { included.set(key(f.path), fcb.checked); renderChanges(); };
      const name = userText('span', 'vcs-name', basename(f.path));
      name.style.color = COLORS[f.status];
      const dir = ide.util.rel(dirname(f.path));
      row.append(fcb, el('span', 'icon', f.path.endsWith('.py') ? '🐍' : '📄'), name, userText('span', 'muted vcs-dir', samePath(dirname(f.path), ide.root) ? '' : dir));
      row.title = `${ide.util.rel(f.path)} — ${STATUS_LABEL[f.status] || f.status}`;
      row.onclick = (e) => {
        if (!e.ctrlKey) selection.clear();
        const k = key(f.path);
        e.ctrlKey && selection.has(k) ? selection.delete(k) : selection.add(k);
        listEl.focus();
        renderChanges();
      };
      row.ondblclick = () => openWorkingDiff(f.path);
      listEl.appendChild(row);
    }
  }

  function onListKey(e) {
    const rows = [...listEl.querySelectorAll('.vcs-file')];
    const i = rows.findIndex((r) => r.classList.contains('selected'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (!next) return;
      selection.clear();
      selection.add(key(next.dataset.path));
      renderChanges();
      listEl.querySelector('.vcs-file.selected')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && rows[i]) {
      e.preventDefault();
      openWorkingDiff(rows[i].dataset.path);
    } else if (e.key === ' ' && rows[i]) {
      e.preventDefault();
      for (const f of selectedFiles()) included.set(key(f.path), !fileIncluded(f));
      renderChanges();
    }
  }

  async function createRepository() {
    if (!ide.root) return;
    const r = await invoke('init', ide.root);
    logResult(r);
    if (!r.ok) return notify(tr('Git init failed'), errorText(r), 'error', true);
    notify(tr('Created Git repository'), ide.root, 'ok', true);
    await refresh();
  }

  function focusCommitMessage() {
    if (!ide.root) return;
    commitTw.show();
    scheduleRefresh(0);
    if (repo) msgEl.focus();
  }

  async function doCommit(andPush) {
    if (!repo) return;
    await ide.saveAll();
    await refresh();
    const files = repo.files.filter(fileIncluded);
    const message = msgEl.value.trim();
    if (!files.length) return notify(tr('No changes selected for commit'), tr('Select files with the checkboxes in the Commit tool window.'), 'warn');
    if (!message) { msgEl.focus(); return notify(tr('Commit message is empty'), tr('Enter a commit message.'), 'warn'); }
    const r = await invoke('commit', ide.root, msgEl.value.replace(/\s+$/, ''), files.map((f) => ({ path: f.path, orig: f.orig })));
    logResult(r);
    if (!r.ok) return notify(tr('Commit failed'), errorText(r), 'error', true);
    msgEl.value = '';
    included.clear();
    selection.clear();
    notify(trn(files.length, '{n} file committed: {message}', '{n} files committed: {message}', { message: message.split('\n')[0] }), '', 'ok');
    await refresh();
    if (andPush) openPushDialog();
  }

  function rollbackFiles(files) {
    files = files.filter((f) => f.status !== 'unversioned');
    if (!repo || !files.length) return notify(tr('Nothing to roll back'), tr('Select changed files in the Commit tool window.'), 'warn');
    const body = el('div', 'vcs-rollback');
    body.appendChild(el('div', null, trn(files.length, 'Rollback changes in {n} file? Local changes will be lost.', 'Rollback changes in {n} files? Local changes will be lost.')));
    const list = userText('div', 'vcs-dialog-list');
    for (const f of files) {
      const n = el('div', null, ide.util.rel(f.path));
      n.style.color = COLORS[f.status];
      list.appendChild(n);
    }
    body.appendChild(list);
    ide.ui.dialog({
      title: tr('Rollback Changes'), body, width: 480,
      buttons: [
        { label: tr('Rollback'), primary: true, run: async () => {
          const r = await invoke('rollback', ide.root, files.map((f) => ({ path: f.path, status: f.status, orig: f.orig })));
          logResult(r);
          if (!r.ok) notify(tr('Rollback failed'), r.log.map((l) => l.err).join('\n'), 'error', true);
          for (const f of files) selection.delete(key(f.path));
          await reloadTabs(files.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path])), true);
          ide.refreshTree();
          await refresh();
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // ---------- diff tabs ----------
  let diffSeq = 0;
  const diffUri = (name) => ide.monaco.Uri.from({ scheme: 'vcs-diff', path: `/${++diffSeq}/${name}` });

  // PyCharm colors a changed block blue on both sides (Monaco only knows inserted/removed): whole-line and
  // per-character decorations over Monaco's own, styled per theme in style.css.
  function markModifiedBlocks(diff) {
    const M = ide.monaco;
    const orig = [];
    const mod = [];
    for (const c of diff.getLineChanges() || []) {
      if (!c.originalEndLineNumber || !c.modifiedEndLineNumber) continue;
      orig.push({ range: new M.Range(c.originalStartLineNumber, 1, c.originalEndLineNumber, 1), options: { isWholeLine: true, className: 'vcs-diff-mod', marginClassName: 'vcs-diff-mod' } });
      mod.push({ range: new M.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber, 1), options: { isWholeLine: true, className: 'vcs-diff-mod', marginClassName: 'vcs-diff-mod' } });
      for (const ch of c.charChanges || []) {
        if (ch.originalEndLineNumber) orig.push({ range: new M.Range(ch.originalStartLineNumber, ch.originalStartColumn, ch.originalEndLineNumber, ch.originalEndColumn), options: { className: 'vcs-diff-mod-char' } });
        if (ch.modifiedEndLineNumber) mod.push({ range: new M.Range(ch.modifiedStartLineNumber, ch.modifiedStartColumn, ch.modifiedEndLineNumber, ch.modifiedEndColumn), options: { className: 'vcs-diff-mod-char' } });
      }
    }
    diff._vcsMod = {
      orig: diff.getOriginalEditor().deltaDecorations(diff._vcsMod?.orig || [], orig),
      mod: diff.getModifiedEditor().deltaDecorations(diff._vcsMod?.mod || [], mod),
    };
  }

  // A header title is UI text, or {user} for text that is user data (hashes, commit messages).
  const diffSide = (t) => (typeof t === 'string' ? el('span', 'vcs-diff-side', t) : userText('span', 'vcs-diff-side', t.user));

  function mountDiff(host, { leftTitle, rightTitle, left, right, rightModel, name }) {
    const head = el('div', 'vcs-diff-head');
    head.append(diffSide(leftTitle), diffSide(rightTitle));
    const box = el('div', 'vcs-diff-body');
    host.append(head, box);
    const monaco = ide.monaco;
    const original = monaco.editor.createModel(left ?? '', undefined, diffUri(name));
    const modified = rightModel || monaco.editor.createModel(right ?? '', undefined, diffUri(name));
    const diff = monaco.editor.createDiffEditor(box, {
      automaticLayout: true, readOnly: !rightModel, originalEditable: false, renderSideBySide: true,
      fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 14, lineHeight: 22, minimap: { enabled: false },
      scrollBeyondLastLine: false, ignoreTrimWhitespace: false, renderMarginRevertIcon: false,
    });
    diff.setModel({ original, modified });
    diff.onDidUpdateDiff(() => markModifiedBlocks(diff));
    host._vcsDiff = diff;
    return () => {
      // the modified side may be an open editor's model, which outlives this view
      if (diff._vcsMod) diff.getModifiedEditor().deltaDecorations(diff._vcsMod.mod, []);
      diff.dispose();
      // Monaco keeps a global hover-delegate factory bound to the last editor's (scoped) services; after the
      // diff editor's scope is disposed every context menu throws. A throwaway editor rebinds it to the root.
      monaco.editor.create(el('div')).dispose();
      original.dispose();
      if (!rightModel) modified.dispose();
    };
  }

  async function openWorkingDiff(path) {
    const id = `${path} [${tr('diff with HEAD')}]`; // tab ids double as the status-bar path
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    const f = byPath.get(key(path));
    const left = f?.status === 'unversioned' || f?.status === 'added' ? '' : await invoke('show', ide.root, f?.orig || path, 'HEAD');
    const tab = ide.findTab(path);
    let right = null;
    if (!tab && f?.status !== 'deleted') { try { right = await ide.api.read(path); } catch { right = ''; } }
    let dispose;
    let unsub;
    ide.openCustomTab({
      id, title: tr('Diff: {name}', { name: basename(path) }), icon: '⇆',
      mount(host) {
        dispose = mountDiff(host, {
          name: basename(path), left, right, rightModel: tab?.model,
          leftTitle: lastHead ? tr('HEAD ({hash}) — read-only', { hash: lastHead.slice(0, 8) }) : 'HEAD',
          rightTitle: tab ? tr('Your version') : tr('Your version — read-only'),
        });
        // the right side shares the open editor's model, so the diff cannot outlive that tab
        if (tab) unsub = ide.on('fileClosed', (p) => samePath(p, path) && setTimeout(() => ide.closeTab(id)));
      },
      onClose() { unsub?.(); dispose?.(); },
    });
  }

  async function openCommitDiff(commit, file) {
    const id = `${file.path} [${commit.hash.slice(0, 8)}]`;
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    const [left, right] = await Promise.all([
      file.status === 'added' ? '' : invoke('fileAt', ide.root, `${commit.hash}^`, file.rel),
      file.status === 'deleted' ? '' : invoke('fileAt', ide.root, commit.hash, file.rel),
    ]);
    let dispose;
    ide.openCustomTab({
      id, title: `${basename(file.rel)} (${commit.hash.slice(0, 7)})`, icon: '⇆',
      mount(host) {
        dispose = mountDiff(host, {
          name: basename(file.rel), left, right,
          leftTitle: tr('{hash}^ (parent)', { hash: commit.hash.slice(0, 7) }),
          rightTitle: { user: `${commit.hash.slice(0, 7)} — ${commit.message?.split('\n')[0] || ''}` },
        });
      },
      onClose() { dispose?.(); },
    });
  }

  // ---------- gutter change markers ----------
  // Myers line diff -> hunks {os, oc, ns, nc} (0-based start and length in old/new).
  function diffLines(a, b) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const A = a.slice(pre, a.length - suf);
    const B = b.slice(pre, b.length - suf);
    const N = A.length;
    const M = B.length;
    if (!N && !M) return [];
    if (!N || !M) return [{ os: pre, oc: N, ns: pre, nc: M }];
    const max = N + M;
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let D = -1;
    for (let d = 0; d <= max && D < 0; d++) {
      if (d > 4000) return [{ os: pre, oc: N, ns: pre, nc: M }]; // pathological input: one big hunk
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { D = d; break; }
      }
    }
    const ma = new Uint8Array(N);
    const mb = new Uint8Array(M);
    let x = N;
    let y = M;
    for (let d = D; d > 0; d--) {
      const vp = trace[d];
      const at = (k) => vp[k + d + 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const px = at(prevK);
      const py = px - prevK;
      const midX = prevK === k + 1 ? px : px + 1;
      while (x > midX) { x--; y--; ma[x] = 1; mb[y] = 1; }
      x = px;
      y = py;
    }
    while (x > 0 && y > 0) { x--; y--; ma[x] = 1; mb[y] = 1; }
    const hunks = [];
    let i = 0;
    let j = 0;
    while (i < N || j < M) {
      if (i < N && j < M && ma[i] && mb[j]) { i++; j++; continue; }
      const os = i;
      const ns = j;
      while (i < N && !ma[i]) i++;
      while (j < M && !mb[j]) j++;
      hunks.push({ os: os + pre, oc: i - os, ns: ns + pre, nc: j - ns, old: A.slice(os, i) });
    }
    return hunks;
  }

  const headCache = new Map(); // lower path -> Promise<HEAD text | null>
  const gutters = new Map(); // lower path -> {ids, hunks, base}
  const headText = (path) => {
    const k = key(path);
    if (!headCache.has(k)) headCache.set(k, invoke('show', ide.root, path, 'HEAD'));
    return headCache.get(k);
  };
  const hunkLine = (h, model) => (h.nc ? h.ns + 1 : Math.max(1, Math.min(h.ns + 1, model.getLineCount())));

  function hunkDecoration(h, model) {
    const M = ide.monaco;
    const type = h.nc === 0 ? 'deleted' : h.oc === 0 ? 'added' : 'modified';
    const start = hunkLine(h, model);
    const end = h.nc ? h.ns + h.nc : start;
    const atEnd = !h.nc && h.ns + 1 > model.getLineCount();
    return {
      range: new M.Range(start, 1, end, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `vcs-gutter vcs-${type}${atEnd ? ' vcs-deleted-end' : ''}`,
        overviewRuler: { color: gutterColor(type), position: M.editor.OverviewRulerLane.Left },
      },
    };
  }

  function applyGutter(tab, base) {
    const k = key(tab.path);
    const g = gutters.get(k) || { ids: [], hunks: [], base: null };
    g.base = base;
    g.hunks = base == null ? [] : diffLines(base.split(/\r?\n/), tab.model.getLinesContent());
    g.ids = tab.model.deltaDecorations(g.ids, g.hunks.map((h) => hunkDecoration(h, tab.model)));
    gutters.set(k, g);
    return g;
  }

  async function updateGutter(tab) {
    if (tab?.kind !== 'file' || tab.model.isDisposed()) return;
    const f = byPath.get(key(tab.path));
    const base = repo && f?.status !== 'unversioned' && f?.status !== 'added' ? await headText(tab.path) : null;
    if (!tab.model.isDisposed() && ide.findTab(tab.path) === tab) applyGutter(tab, base);
  }

  let gutterTimer;
  ide.editor.onDidChangeModelContent(() => {
    clearTimeout(gutterTimer);
    gutterTimer = setTimeout(() => updateGutter(ide.activeTab()), 250);
  });

  // Recomputes synchronously so navigation sees edits typed within the debounce window.
  function currentHunks(tab) {
    if (tab?.kind !== 'file') return [];
    const g = gutters.get(key(tab.path));
    return g?.base == null ? [] : applyGutter(tab, g.base).hunks;
  }

  function gotoChange(dir) {
    const tab = ide.activeTab();
    const hunks = currentHunks(tab);
    if (!hunks.length) return;
    const line = ide.editor.getPosition()?.lineNumber || 1;
    const starts = hunks.map((h) => hunkLine(h, tab.model));
    let target = dir > 0 ? starts.find((s) => s > line) : [...starts].reverse().find((s) => s < line);
    if (target == null) target = dir > 0 ? starts[0] : starts[starts.length - 1];
    ide.editor.setPosition({ lineNumber: target, column: 1 });
    ide.editor.revealLineInCenterIfOutsideViewport(target);
    ide.editor.focus();
  }

  const hunkAt = (tab, line) => currentHunks(tab).find((h) => {
    const start = hunkLine(h, tab.model);
    return line >= start && line <= (h.nc ? h.ns + h.nc : start);
  });

  // Rollback Lines: replaces the hunk's current lines with the HEAD lines, as one undoable edit.
  function rollbackHunk(tab, h) {
    const model = tab.model;
    const eol = model.getEOL();
    const total = model.getLineCount();
    const M = ide.monaco;
    let range;
    let text;
    if (h.ns + h.nc < total) {
      range = new M.Range(h.ns + 1, 1, h.ns + h.nc + 1, 1);
      text = h.old.map((l) => l + eol).join('');
    } else if (h.ns > 0) {
      range = new M.Range(h.ns, model.getLineMaxColumn(h.ns), total, model.getLineMaxColumn(total));
      text = h.old.map((l) => eol + l).join('');
    } else {
      range = model.getFullModelRange();
      text = h.old.join(eol);
    }
    model.pushStackElement();
    model.pushEditOperations(ide.editor.getSelections(), [{ range, text }], () => null);
    model.pushStackElement();
    updateGutter(tab);
  }

  function rollbackLinesAtCaret() {
    const tab = ide.activeTab();
    const h = tab?.kind === 'file' && hunkAt(tab, ide.editor.getPosition().lineNumber);
    if (h) rollbackHunk(tab, h);
  }

  // ---------- annotate (git blame) ----------
  const blames = new Map(); // lower path -> {ids, width, classToHash}
  const blameStyle = el('style');
  document.head.appendChild(blameStyle);
  const repoKey = ide.editor.createContextKey('vcsRepo', false);
  const annotatedKey = ide.editor.createContextKey('vcsAnnotated', false);
  let blameSeq = 0;
  const fmtShort = (t) => new Date(t * 1000).toLocaleDateString(dateLocale, { year: '2-digit', month: 'numeric', day: 'numeric' });

  function fmtDate(t) {
    const d = new Date(t * 1000);
    const time = d.toLocaleTimeString(dateLocale, { hour: 'numeric', minute: '2-digit' });
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (days === 0) return tr('Today {time}', { time });
    if (days === 1) return tr('Yesterday {time}', { time });
    return `${fmtShort(t)}, ${time}`;
  }

  function rebuildBlameCss() {
    blameStyle.textContent = [...blames.values()].map((b) => b.css).join('\n');
  }

  function applyAnnotationLayout(tab) {
    const b = tab?.kind === 'file' && blames.get(key(tab.path));
    annotatedKey.set(!!b);
    ide.editor.updateOptions({ lineDecorationsWidth: b ? b.width : 10 });
    ide.editor.getDomNode()?.style.setProperty('--vcs-bar-left', b ? `${b.width - 6}px` : '0px');
  }

  async function annotate(tab) {
    if (!repo || tab?.kind !== 'file') return;
    const r = await invoke('blame', ide.root, tab.path, tab.model.getValue());
    if (!r) return notify(tr('Cannot annotate'), tr('{name} is not tracked by Git.', { name: basename(tab.path) }), 'warn');
    const old = blames.get(key(tab.path));
    const classToHash = {};
    const classOf = {};
    let css = '';
    let longest = 0;
    for (const [hash, c] of Object.entries(r.commits)) {
      if (/^0+$/.test(hash)) continue;
      const cls = `vcs-blame-${++blameSeq}`;
      const label = `${fmtShort(c.time)}  ${c.author}`;
      longest = Math.max(longest, label.length);
      classOf[hash] = cls;
      classToHash[cls] = hash;
      css += `.${cls}::after { content: ${JSON.stringify(label)}; }\n`;
    }
    const decos = [];
    r.lines.forEach((hash, i) => {
      if (!classOf[hash]) return;
      decos.push({ range: new ide.monaco.Range(i + 1, 1, i + 1, 1), options: { isWholeLine: true, linesDecorationsClassName: `vcs-blame ${classOf[hash]}` } });
    });
    const ids = tab.model.deltaDecorations(old?.ids || [], decos);
    blames.set(key(tab.path), { ids, css, classToHash, width: Math.round(longest * 7.2) + 22 });
    rebuildBlameCss();
    if (ide.activeTab() === tab) applyAnnotationLayout(tab);
  }

  function closeAnnotations(tab) {
    const b = tab && blames.get(key(tab.path));
    if (!b) return;
    if (!tab.model.isDisposed()) tab.model.deltaDecorations(b.ids, []);
    blames.delete(key(tab.path));
    rebuildBlameCss();
    applyAnnotationLayout(ide.activeTab());
  }

  const toggleAnnotate = () => {
    const tab = ide.activeTab();
    if (tab?.kind !== 'file') return;
    blames.has(key(tab.path)) ? closeAnnotations(tab) : annotate(tab);
  };

  ide.editor.addAction({ id: 'vcs.annotate', label: tr('Annotate with Git Blame'), contextMenuGroupId: '9_vcs', precondition: 'vcsRepo && !vcsAnnotated', run: toggleAnnotate });
  ide.editor.addAction({ id: 'vcs.closeAnnotations', label: tr('Close Annotations'), contextMenuGroupId: '9_vcs', precondition: 'vcsAnnotated', run: toggleAnnotate });

  ide.editor.onMouseDown((e) => {
    const M = ide.monaco;
    if (e.target.type !== M.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !e.target.position) return;
    const tab = ide.activeTab();
    if (tab?.kind !== 'file') return;
    const line = e.target.position.lineNumber;
    const b = blames.get(key(tab.path));
    const layout = ide.editor.getLayoutInfo();
    const x = e.event.posx - ide.editor.getDomNode().getBoundingClientRect().left;
    if (b && x < layout.decorationsLeft + b.width - 8) {
      const cls = tab.model.getLineDecorations(line).map((d) => d.options.linesDecorationsClassName || '')
        .map((c) => c.split(' ').find((n) => b.classToHash[n])).find(Boolean);
      if (cls) showCommit(b.classToHash[cls]);
      return;
    }
    const h = hunkAt(tab, line);
    if (!h || !e.event.leftButton) return;
    ide.ui.contextMenu(e.event.posx, e.event.posy, [
      { label: tr('Rollback Lines'), hint: 'Ctrl+Alt+Z', run: () => rollbackHunk(tab, h) },
      { label: tr('Show Diff'), run: () => openWorkingDiff(tab.path) },
      { separator: true },
      { label: tr('Next Change'), hint: 'Ctrl+Alt+Shift+Down', run: () => { ide.editor.setPosition({ lineNumber: line, column: 1 }); gotoChange(1); } },
      { label: tr('Previous Change'), hint: 'Ctrl+Alt+Shift+Up', run: () => { ide.editor.setPosition({ lineNumber: line, column: 1 }); gotoChange(-1); } },
    ]);
  });

  // ---------- Git tool window: Log and Console ----------
  let logRows, filesEl, detailsEl, logPane, consolePane, subTabs;
  let commits = [];
  let selectedCommit = null;
  let details = null;

  const gitTw = ide.registerToolWindow({
    id: 'Git', title: 'Git', icon: '⑂', side: 'bottom', keys: 'Alt+9', order: 45,
    mount(container, tw) {
      subTabs = el('div', 'vcs-subtabs');
      const logTab = el('button', 'vcs-subtab active', tr('Log'));
      const conTab = el('button', 'vcs-subtab', tr('Console'));
      subTabs.append(logTab, conTab);
      logPane = el('div', 'vcs-log');
      consolePane = el('div', 'vcs-console hidden');
      const table = el('div', 'vcs-log-table');
      const header = el('div', 'vcs-log-row vcs-log-header');
      header.append(el('span', 'vcs-c-subject', tr('Commit')), el('span', 'vcs-c-author', tr('Author')), el('span', 'vcs-c-date', tr('Date')));
      logRows = el('div', 'vcs-log-rows');
      logRows.tabIndex = 0;
      logRows.onkeydown = (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const i = commits.findIndex((c) => c.hash === selectedCommit);
        const next = commits[Math.max(0, Math.min(commits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) selectCommit(next.hash);
      };
      table.append(header, logRows);
      const side = el('div', 'vcs-log-side');
      filesEl = el('div', 'vcs-log-files');
      detailsEl = el('div', 'vcs-log-details');
      side.append(filesEl, detailsEl);
      logPane.append(table, side);
      gitConsole = ide.ui.console(consolePane);
      gitConsole.out.id = 'vcsConsole';
      const switchTo = (log) => {
        logTab.classList.toggle('active', log);
        conTab.classList.toggle('active', !log);
        logPane.classList.toggle('hidden', !log);
        consolePane.classList.toggle('hidden', log);
      };
      logTab.onclick = () => switchTo(true);
      conTab.onclick = () => switchTo(false);
      subTabs.switchTo = switchTo;
      container.append(subTabs, logPane, consolePane);
      tw.setActions([
        { icon: '⟳', title: tr('Refresh'), run: loadLog },
        { icon: '↓', title: tr('Update Project… (Ctrl+T)'), run: updateProject },
        { icon: '↑', title: tr('Push… (Ctrl+Shift+K)'), run: openPushDialog },
      ]);
    },
  });

  function showConsole() {
    gitTw.show();
    subTabs.switchTo(false);
  }

  let logSeq = 0;
  async function loadLog() {
    if (!logRows) return;
    const my = ++logSeq;
    if (!repo) {
      commits = [];
      logRows.replaceChildren(el('div', 'vcs-empty muted', ide.root ? tr('No Git repository in this project') : tr('No project')));
      filesEl.replaceChildren();
      detailsEl.replaceChildren();
      return;
    }
    const list = await invoke('log', ide.root);
    if (my !== logSeq) return;
    commits = list;
    if (!commits.some((c) => c.hash === selectedCommit)) selectedCommit = commits[0]?.hash || null;
    renderLog();
    if (selectedCommit) selectCommit(selectedCommit);
    else { filesEl.replaceChildren(); detailsEl.replaceChildren(el('div', 'muted', tr('No commits yet'))); }
  }

  function renderLog() {
    logRows.replaceChildren();
    if (!commits.length) logRows.appendChild(el('div', 'vcs-empty muted', tr('No commits yet')));
    for (const c of commits) {
      const row = el('div', 'vcs-log-row' + (c.hash === selectedCommit ? ' selected' : ''));
      row.dataset.hash = c.hash;
      // subject, refs and author are user data
      const subj = userText('span', 'vcs-c-subject');
      subj.appendChild(el('span', 'vcs-dot', '●'));
      for (const ref of c.refs) {
        const name = ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
        if (name === 'HEAD' || name.endsWith('/HEAD')) continue;
        subj.appendChild(el('span', 'vcs-ref' + (ref.startsWith('HEAD -> ') ? ' head' : ref.startsWith('tag: ') ? ' tag' : ref.includes('/') ? ' remote' : ''), name));
      }
      subj.appendChild(el('span', 'vcs-subject-text', c.subject));
      row.append(subj, userText('span', 'vcs-c-author', c.author), el('span', 'vcs-c-date', fmtDate(c.time)));
      subj.title = `${c.short} ${c.subject}`;
      row.onclick = () => { selectCommit(c.hash); logRows.focus(); };
      logRows.appendChild(row);
    }
  }

  async function selectCommit(hash) {
    selectedCommit = hash;
    for (const r of logRows.querySelectorAll('.vcs-log-row')) r.classList.toggle('selected', r.dataset.hash === hash);
    logRows.querySelector('.vcs-log-row.selected')?.scrollIntoView({ block: 'nearest' });
    const d = await invoke('commitDetails', ide.root, hash);
    if (selectedCommit !== hash) return;
    details = d;
    filesEl.replaceChildren(el('div', 'vcs-side-title', trn(d.files.length, '{n} file changed', '{n} files changed')));
    for (const f of d.files) {
      const row = el('div', 'vcs-file vcs-log-file');
      row.dataset.rel = f.rel;
      row.title = `${f.rel} — ${STATUS_LABEL[f.status] || f.status}`;
      const name = userText('span', 'vcs-name', basename(f.rel));
      name.style.color = COLORS[f.status];
      row.append(el('span', 'icon', f.rel.endsWith('.py') ? '🐍' : '📄'), name, userText('span', 'muted vcs-dir', f.rel.includes('/') ? dirname(f.rel) : ''));
      row.onclick = () => { filesEl.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected')); row.classList.add('selected'); };
      row.ondblclick = () => openCommitDiff(d, f);
      filesEl.appendChild(row);
    }
    const who = userText('span', null, `${d.hash.slice(0, 8)} ${d.author} <${d.email}>`);
    const when = el('div', 'muted vcs-detail-meta');
    when.append(who, ' ', tr('on {date}', { date: new Date(d.time * 1000).toLocaleString(dateLocale) }));
    detailsEl.replaceChildren(userText('div', 'vcs-detail-msg', d.message), when);
  }

  async function showCommit(hash) {
    gitTw.show();
    subTabs.switchTo(true);
    await loadLog();
    if (commits.some((c) => c.hash === hash)) await selectCommit(hash);
  }

  ide.on('toolWindowShown', (id) => id === 'Git' && loadLog());

  // ---------- update project / push ----------
  async function updateProject() {
    if (!repo) return notify(tr('Update Project'), tr('This project is not under Git version control.'), 'warn');
    await ide.saveAll();
    const r = await invoke('pull', ide.root);
    logResult(r);
    if (r.noRemote) return notify(tr("Can't update"), tr('No remotes are defined for this repository. Define a remote in the Push dialog (Ctrl+Shift+K).'), 'warn');
    if (!r.ok) return notify(tr('Update failed'), errorText(r), 'error', true);
    if (r.upToDate) notify(tr('All files are up-to-date'), '', 'ok');
    else notify(trn(r.updated.length, '{n} file updated', '{n} files updated'), r.updated.map((p) => ide.util.rel(p)).join('\n'), 'ok', true);
    headCache.clear();
    await reloadTabs(r.updated, false);
    ide.refreshTree();
    await refresh();
    if (gitTw.isVisible()) loadLog();
  }

  async function doPush() {
    const r = await invoke('push', ide.root);
    logResult(r);
    if (r.noRemote) return notify(tr('Push failed'), tr('No remotes are defined for this repository.'), 'warn');
    if (!r.ok) return notify(tr('Push failed'), errorText(r), 'error', !r.reason);
    notify(r.pushed ? trn(r.pushed, 'Pushed {n} commit to {target}', 'Pushed {n} commits to {target}', { target: r.target }) : tr('Everything is up to date'), '', 'ok');
    await refresh();
    if (gitTw.isVisible()) loadLog();
  }

  async function openPushDialog() {
    if (!repo) return notify(tr('Push'), tr('This project is not under Git version control.'), 'warn');
    const o = await invoke('outgoing', ide.root);
    const body = el('div', 'vcs-push');
    let urlIn;
    let nameIn;
    if (!o.remotes.length) {
      body.appendChild(el('div', 'vcs-push-warn', tr('No remotes are defined. Define a remote to push to:')));
      const f1 = el('label', 'field');
      nameIn = el('input');
      nameIn.value = 'origin';
      f1.append(el('span', null, tr('Name')), nameIn);
      const f2 = el('label', 'field');
      urlIn = el('input', 'vcs-remote-url');
      urlIn.placeholder = tr('https://github.com/user/repo.git or a local path');
      f2.append(el('span', null, tr('URL')), urlIn);
      body.append(f1, f2);
    } else {
      const dest = o.upstream ? o.upstream.split('/').slice(1).join('/') : o.branch;
      const target = el('div', 'vcs-push-target');
      target.append(userText('span', null, `${o.branch || 'HEAD'} → ${o.remote} : ${dest}`));
      if (!o.upstream) target.append(' ', el('span', 'muted', tr('(new)')));
      body.appendChild(target);
    }
    const list = userText('div', 'vcs-dialog-list vcs-push-commits');
    for (const c of o.commits || []) {
      const row = el('div', 'vcs-push-commit');
      row.append(el('span', 'muted', c.short), el('span', null, ` ${c.subject}`), el('span', 'muted', `  ${c.author}`));
      list.appendChild(row);
    }
    if (!o.commits?.length) { delete list.dataset.userText; list.appendChild(el('div', 'muted', tr('No commits to push'))); }
    body.appendChild(list);
    ide.ui.dialog({
      title: tr('Push Commits to {project}', { project: basename(ide.root) }), body, width: 560,
      buttons: [
        { label: tr('Push'), primary: true, run: async () => {
          if (urlIn) {
            const url = urlIn.value.trim();
            if (!url) { urlIn.focus(); return false; }
            const r = await invoke('addRemote', ide.root, nameIn.value.trim() || 'origin', url);
            logResult(r);
            if (!r.ok) { notify(tr('Cannot define remote'), errorText(r), 'error', true); return false; }
          }
          doPush();
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // ---------- actions ----------
  const commitFocused = () => !!listEl && listEl.closest('.tool').contains(document.activeElement) && document.activeElement !== msgEl;
  [
    { id: 'CheckinProject', title: tr('Commit…'), keys: 'Ctrl+K', run: focusCommitMessage },
    { id: 'Vcs.Push', title: tr('Push…'), keys: 'Ctrl+Shift+K', run: openPushDialog },
    { id: 'Vcs.UpdateProject', title: tr('Update Project…'), keys: 'Ctrl+T', run: updateProject },
    { id: 'ChangesView.Revert', title: tr('Rollback…'), keys: 'Ctrl+Alt+Z', run: () => {
      if (commitFocused()) return rollbackFiles(selectedFiles());
      if (ide.editor.hasTextFocus()) return rollbackLinesAtCaret();
      const tab = ide.activeTab();
      const f = tab && byPath.get(key(tab.path));
      if (f) rollbackFiles([f]);
    } },
    { id: 'VcsShowNextChangeMarker', title: tr('Next Change'), keys: 'Ctrl+Alt+Shift+ArrowDown', when: () => ide.activeTab()?.kind === 'file', run: () => gotoChange(1) },
    { id: 'VcsShowPrevChangeMarker', title: tr('Previous Change'), keys: 'Ctrl+Alt+Shift+ArrowUp', when: () => ide.activeTab()?.kind === 'file', run: () => gotoChange(-1) },
    { id: 'Annotate', title: tr('Annotate with Git Blame'), run: toggleAnnotate },
    { id: 'Git.Branches', title: tr('Branches…'), run: showBranches },
    { id: 'Git.Init', title: tr('Create Git Repository…'), run: createRepository },
    { id: 'Git.Log', title: tr('Show Git Log'), run: () => { gitTw.show(); subTabs.switchTo(true); } },
    { id: 'Compare.SameVersion', title: tr('Show Diff with HEAD'), run: () => ide.activeTab()?.kind === 'file' && openWorkingDiff(ide.activeTab().path) },
  ].forEach(ide.registerAction);
  ide.registerTreeAction({ title: tr('Git: Show Diff'), when: (e) => !e.dir && byPath.has(key(e.path)), run: (e) => openWorkingDiff(e.path) });
  ide.registerTreeAction({ title: tr('Git: Rollback…'), when: (e) => !e.dir && byPath.get(key(e.path))?.status !== 'unversioned' && byPath.has(key(e.path)), run: (e) => rollbackFiles([byPath.get(key(e.path))]) });

  // ---------- events ----------
  ide.on('projectOpened', () => {
    repo = null;
    lastHead = undefined;
    byPath.clear();
    included.clear();
    selection.clear();
    headCache.clear();
    gutters.clear();
    blames.clear();
    rebuildBlameCss();
    commits = [];
    if (msgEl) msgEl.value = '';
    refresh();
  });
  ide.on('fileSaved', (tab) => {
    scheduleRefresh();
    if (blames.has(key(tab.path))) annotate(tab);
  });
  ide.on('filesChanged', () => scheduleRefresh());
  // overview-ruler marks carry concrete colors; recolor them for the new theme
  ide.on('settingsChanged', (k) => k === 'appearance.theme' && setTimeout(() => updateGutter(ide.activeTab())));
  ide.on('activeTabChanged', (tab) => { updateGutter(tab); applyAnnotationLayout(tab); });
  ide.on('fileClosed', (path) => { gutters.delete(key(path)); if (blames.delete(key(path))) rebuildBlameCss(); });
  window.addEventListener('focus', () => scheduleRefresh(50));
})();
