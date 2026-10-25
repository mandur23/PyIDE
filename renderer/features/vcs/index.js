(() => {
  const { el, basename, dirname, samePath } = ide.util;
  // Commands that rewrite the working tree put a Local History label first (local-history plugin), whichever UI ran them.
  const CHECKPOINTS = {
    pull: 'Before Update Project', checkout: 'Before Checkout', rollback: 'Before Rollback', merge: 'Before Merge',
    rebase: 'Before Rebase', cherryPick: 'Before Cherry-pick', revert: 'Before Git Revert', stash: 'Before Stash',
    unstash: 'Before Unstash', reset: 'Before Reset', acceptSide: 'Before Accepting a Merge Side', resolve: 'Before Resolving a Conflict',
    shelve: 'Before Shelve', unshelve: 'Before Unshelve',
  };
  const OPERATION_CHECKPOINTS = { continue: 'Before Continuing', skip: 'Before Skipping', abort: 'Before Aborting' };
  // Commands that talk to a remote show in the status bar's background tasks while they run, as in PyCharm.
  const TASKS = { push: () => tr('Pushing…'), pull: () => tr('Updating project…') };
  const invoke = async (ch, ...args) => {
    const label = ch === 'operation' ? OPERATION_CHECKPOINTS[args[1]] : CHECKPOINTS[ch];
    if (label) await ide.localHistory?.checkpoint(label);
    const task = TASKS[ch] && ide.tasks?.start({ title: TASKS[ch]() });
    try { return await ide.api.invoke(`git:${ch}`, ...args); } finally { task?.done(); }
  };
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
    noOperation: tr('No merge, rebase, cherry-pick or revert is in progress.'),
    noLocalChanges: tr('No local changes to save'),
    noShelfChanges: tr('No changes to shelve'),
    currentBranch: tr('The current branch cannot be deleted.'),
    pushed: tr('The commit is already pushed. Rewriting it would need a force push.'),
    notHead: tr('Only the last commit can be undone.'),
    mergeCommit: tr('A merge commit cannot be undone.'),
    operationInProgress: tr('A merge, rebase, cherry-pick or revert is in progress.'),
    notInBranch: tr('The commit is not in the current branch.'),
    emptyMessage: tr('The commit message is empty.'),
    badTagName: tr('This is not a valid tag name.'),
    gitMissing: tr('Git is not installed or not on PATH. Install Git for Windows (git-scm.com) and restart PyIDE.'),
  };
  // The operation git stopped in the middle of, as the branch widget shows it.
  const OP_LABEL = { merge: tr('Merging'), rebase: tr('Rebasing'), 'cherry-pick': tr('Cherry-picking'), revert: tr('Reverting') };

  // Extension points the vcs-merge plugin fills: branch popup entries, Log context-menu entries, rows above the
  // changes list, and what opening a conflicted file or a stopped pull does.
  const branchActions = [];
  const logActions = [];
  const commitHeaders = [];
  const msgActions = el('div', 'vcs-msg-actions'); // buttons other plugins put on the commit message box
  const commitOpts = el('div', 'vcs-commit-opts'); // controls other plugins put after the commit buttons
  const beforeCommit = []; // async ({files, message, andPush}) => false to stop the commit (commit checks)
  let conflictHandler = null;
  const errorText = (r) => (r.reason && REASONS[r.reason]) || r.err || r.out || '';

  let repo = null; // git:status result while the project is a repository
  let noRepo = null; // git:status result otherwise: {reason: 'gitMissing' | 'damaged', top, error} or no reason
  const byPath = new Map(); // lower-cased path -> changed file
  const ignored = new Set(); // lower-cased paths of ignored files and folders (a folder covers what it holds)
  let lastHead;
  let lastBranch; // what vcsBranchChanged last announced: the branch, '' for no branch, null outside a repository

  // ---------- notifications and the Git console ----------
  // A balloon through ide.notifications (kept in the Notifications tool window); clicking it shows the Git console.
  // raw: the text is git output or a path, shown untranslated; actions: links on the balloon ([{label, run(note)}]).
  // Returns the note ({remove(), expire()}).
  function notify(title, text = '', kind = 'info', raw = false, actions = []) {
    return ide.notifications.notify({ title, text, kind, raw, actions, group: 'Git', balloonClass: 'vcs-note', onClick: () => showConsole() });
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
      // Read in the document's own encoding (CP949, UTF-16...), as the editor opened it.
      let text;
      try { ({ text } = await ide.api.invoke('fs:readText', tab.path, tab.doc?.encoding)); } catch { continue; }
      if (text === undefined) continue;
      if (text !== tab.model.getValue()) tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
      tab.savedVersion = tab.model.getAlternativeVersionId();
    }
    ide.renderTabs();
  }

  // ---------- status refresh ----------
  let refreshSeq = 0;
  let refreshTimer;
  const scheduleRefresh = (ms = 200) => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, ms); };
  const treeSig = () => [...byPath.values()].map((f) => `${key(f.path)}:${f.status}`).sort().join('|') + '#' + [...ignored].sort().join('|');

  // One git status at a time: on a large repository it takes seconds, and saves, focus changes and file events
  // would otherwise start overlapping ones. A refresh asked for meanwhile runs once after the current one, and every
  // caller's promise settles after a status taken since it asked.
  let refreshing = null;
  let refreshAgain = false;
  function refresh() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        do { refreshAgain = false; await refreshOnce(); } while (refreshAgain);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function refreshOnce() {
    const root = ide.root;
    if (!root) return;
    const my = ++refreshSeq;
    const st = await invoke('status', root);
    if (my !== refreshSeq || root !== ide.root) return;
    const before = treeSig();
    repo = st.isRepo ? st : null;
    noRepo = st.isRepo ? null : st;
    byPath.clear();
    for (const f of repo?.files || []) byPath.set(key(f.path), f);
    ignored.clear();
    for (const p of repo?.ignored || []) ignored.add(key(p));
    for (const k of [...selection]) if (!byPath.has(k)) selection.delete(k);
    prefillMergeMessage();
    const head = repo?.head || null;
    if (head !== lastHead) {
      lastHead = head;
      headCache.clear();
      if (gitTw.isVisible()) loadLog();
      // Commits, checkouts, resets: code vision blames its files again.
      ide.emit('vcsHeadChanged', { root, head });
    }
    setRepoKey(!!repo);
    // Other plugins (the Workspace home's branch chip) follow Create Git Repository, checkouts and rebases, which change
    // no project file they would notice.
    const branch = repo ? repo.branch || repo.detached || '' : null;
    if (branch !== lastBranch) { lastBranch = branch; ide.emit('vcsBranchChanged', { root, branch, isRepo: !!repo }); }
    renderWidget();
    // Most refreshes (a save, a window focus) find the list as it was; rebuilding 600 rows took ~45 ms each time.
    if (changesKey() !== drawnKey) renderChanges();
    if (treeSig() !== before) ide.refreshTree();
    updateVisibleGutters();
  }

  // Ignored by .gitignore: the path itself or a folder above it (git lists an ignored folder once, not its files).
  const isIgnored = (p) => {
    if (!ignored.size) return false;
    for (let k = key(p); k && k !== key(ide.root || ''); k = k.slice(0, Math.max(k.lastIndexOf('\\'), k.lastIndexOf('/')))) if (ignored.has(k)) return true;
    return false;
  };
  ide.registerTreeDecorator((entry) => {
    const f = !entry.dir && byPath.get(key(entry.path));
    if (f) return { color: COLORS[f.status] };
    return isIgnored(entry.path) ? { color: 'var(--vcs-ignored)' } : null;
  });

  // ---------- branch widget ----------
  const branchBtn = el('button', 'tb-btn vcs-branch hidden');
  branchBtn.title = tr('Git Branches');
  ide.registerToolbarItem({ side: 'left', order: 10, el: branchBtn });

  // Incoming/outgoing commits of the current branch against its upstream ("↓3 ↑1"), kept current by auto-fetch.
  const syncBtn = el('button', 'tb-btn vcs-sync hidden');
  syncBtn.id = 'vcsSync';
  ide.registerToolbarItem({ side: 'left', order: 11, el: syncBtn });

  function renderWidget() {
    branchBtn.classList.toggle('hidden', !repo);
    renderSync();
    if (!repo) return;
    const name = repo.branch || repo.opBranch || repo.detached || 'HEAD';
    const parts = [ide.icon('branch', '⑂'), userText('span', 'vcs-branch-name', name)];
    // A long name ends in an ellipsis in the toolbar; the tooltip keeps all of it.
    branchBtn.title = tr('Git Branches — {branch}', { branch: name });
    if (repo.op) parts.push(el('span', 'vcs-branch-op', OP_LABEL[repo.op]));
    branchBtn.replaceChildren(...parts, ide.icon('chevronDown', '▾'));
  }

  function renderSync() {
    const show = !!repo?.upstream && (repo.behind > 0 || repo.ahead > 0);
    syncBtn.classList.toggle('hidden', !show);
    if (!show) return;
    const parts = [];
    if (repo.behind) parts.push(el('span', 'vcs-sync-in', `↓${repo.behind}`));
    if (repo.ahead) parts.push(el('span', 'vcs-sync-out', `↑${repo.ahead}`));
    syncBtn.replaceChildren(...parts);
    syncBtn.dataset.behind = repo.behind;
    syncBtn.dataset.ahead = repo.ahead;
    const lines = [];
    if (repo.behind) lines.push(trn(repo.behind, '{n} incoming commit from {upstream}', '{n} incoming commits from {upstream}', { upstream: repo.upstream }));
    if (repo.ahead) lines.push(trn(repo.ahead, '{n} outgoing commit to {upstream}', '{n} outgoing commits to {upstream}', { upstream: repo.upstream }));
    if (fetchState.lastFetch) lines.push(tr('Last fetched at {time}', { time: new Date(fetchState.lastFetch).toLocaleTimeString(dateLocale, { hour: 'numeric', minute: '2-digit' }) }));
    lines.push(tr('Click to update the project'));
    syncBtn.title = lines.join('\n');
  }

  syncBtn.onclick = () => {
    const r = syncBtn.getBoundingClientRect();
    ide.ui.contextMenu(r.left, r.bottom, [
      { label: tr('Update Project…'), keyAction: 'Vcs.UpdateProject', run: updateProject },
      ...(repo?.ahead ? [{ label: tr('Push…'), keyAction: 'Vcs.Push', run: openPushDialog }] : []),
      { separator: true },
      { label: tr('Fetch'), run: () => runAutoFetch(true) },
    ]);
  };

  // ---------- auto-fetch ----------
  // Every vcs.autoFetchMinutes minutes (default 10, 0 = off) a quiet `git fetch --all --prune` (git:backgroundFetch,
  // main/features/git.js: never while another git operation runs, never prompts) keeps ↓/↑ current. Failures (offline,
  // credentials needed) only go to the IDE log and stretch the interval, doubling up to an hour; a success resets it.
  const fetchState = { attempts: 0, failures: 0, skipped: 0, lastFetch: null, lastError: null, nextDelay: 0, running: false, timer: null };
  const MAX_FETCH_BACKOFF = 60 * 60000;
  const fetchMinutes = () => { const n = Number(ide.settings.get('vcs.autoFetchMinutes', 10)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const fetchInterval = () => Math.max(1000, fetchMinutes() * 60000);
  let fetchGen = 0;

  // delay: the wait before the next fetch; by default the interval, stretched after failures.
  function scheduleAutoFetch(delay) {
    clearTimeout(fetchState.timer);
    fetchState.timer = null;
    fetchState.nextDelay = 0;
    if (!fetchMinutes() || !ide.root) return;
    const interval = fetchInterval();
    const wait = delay ?? (fetchState.failures ? Math.min(interval * 2 ** fetchState.failures, Math.max(interval, MAX_FETCH_BACKOFF)) : interval);
    fetchState.nextDelay = wait;
    const gen = fetchGen;
    fetchState.timer = setTimeout(() => { if (gen === fetchGen) runAutoFetch(false); }, wait);
  }

  // A new project, or a new interval: the first fetch comes soon (within 20 s), then every interval.
  function restartAutoFetch() {
    fetchGen++;
    Object.assign(fetchState, { failures: 0, lastFetch: null, lastError: null });
    scheduleAutoFetch(Math.min(fetchInterval(), 20000));
  }

  async function runAutoFetch(manual) {
    const root = ide.root;
    const gen = fetchGen;
    if (!root || fetchState.running) { if (!manual) scheduleAutoFetch(); return; }
    // Power Save Mode: no automatic fetch (the timer keeps running; a fetch the user asks for still runs).
    if (!manual && ide.powerSave?.on()) { scheduleAutoFetch(); return; }
    // Safe Mode runs no git at all (main refuses too); a project without remotes has nothing to fetch.
    if (ide.trusted === false || !repo?.remotes.length) {
      if (manual) notify(tr('Nothing to fetch'), repo ? REASONS.noRemote : tr('This project is not under Git version control.'), 'warn');
      else scheduleAutoFetch();
      return;
    }
    fetchState.running = true;
    const task = manual ? ide.tasks?.start({ title: tr('Fetching…') }) : null;
    let r;
    try { r = await ide.api.invoke('git:backgroundFetch', root); } catch (err) { r = { ok: false, err: err.message }; } finally { fetchState.running = false; task?.done(); }
    if (gen !== fetchGen || root !== ide.root) return; // the project or the interval changed meanwhile: its own timer runs
    if (r.skipped === 'busy' || r.skipped === 'running') {
      // Another git operation is running: try again shortly, without counting it as a failure.
      fetchState.skipped++;
      if (manual) notify(tr('Fetch postponed'), tr('Another Git operation is running.'), 'info');
      scheduleAutoFetch(Math.min(fetchInterval(), 30000));
      return;
    }
    if (!r.skipped) fetchState.attempts++;
    if (r.ok) {
      Object.assign(fetchState, { failures: 0, lastFetch: Date.now(), lastError: null });
      await refresh();
      if (manual) notify(tr('Fetched successfully'), '', 'ok');
    } else if (!r.skipped) {
      fetchState.failures++;
      fetchState.lastError = r.err || '';
      // Quiet: main wrote the reason to the IDE log; only a fetch the user asked for reports it.
      if (manual) notify(tr('Fetch failed'), r.err || '', 'error', true);
    }
    renderSync();
    scheduleAutoFetch();
  }
  ide.on('settingsChanged', (k) => k === 'vcs.autoFetchMinutes' && restartAutoFetch());
  // PyCharm's Protected branches setting: names or * patterns, separated by commas or
  // semicolons. Force Push to one asks again with a warning.
  const PROTECTED_DEFAULT = 'master, main';
  const globRe = (p) => new RegExp(`^${p.replace(/[.+?^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const isProtected = (branch) => String(ide.settings.get('vcs.protectedBranches', PROTECTED_DEFAULT) ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    .some((p) => globRe(p).test(branch));
  (ide.settingsPages ||= []).push({
    id: 'vcs-git', title: () => 'Git', defaults: { 'vcs.autoFetchMinutes': 10, 'vcs.protectedBranches': PROTECTED_DEFAULT },
    keywords: 'git fetch auto-fetch remote incoming outgoing push force protected branches 페치 원격 푸시 강제 보호된 브랜치',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Fetch'));
      s.appendChild(ctx.ui.fieldRow(tr('Fetch from remotes every (minutes):'), ctx.ui.numberInput('vcs.autoFetchMinutes', { min: 0, max: 1440, fallback: 10 })));
      s.appendChild(el('div', 'muted settings-note', tr('Keeps the incoming and outgoing commit counts next to the branch current. 0 turns automatic fetching off.')));
      const p = ctx.ui.section(host, tr('Push'));
      const branches = el('input', 'vcs-protected-input');
      branches.dataset.key = 'vcs.protectedBranches';
      branches.value = ctx.value('vcs.protectedBranches') ?? PROTECTED_DEFAULT;
      branches.oninput = () => ctx.set('vcs.protectedBranches', branches.value);
      p.appendChild(ctx.ui.fieldRow(tr('Protected branches:'), branches));
      p.appendChild(el('div', 'muted settings-note', tr('Force Push to these branches asks first. Separate names with commas; * matches any text.')));
    },
  });

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
    const extra = branchActions.flatMap((fn) => fn(repo, { local, remote }));
    // While an operation is stopped its Continue / Abort come first, as in PyCharm.
    if (repo.op) items.unshift(...extra); else items.push(...extra);
    for (const b of local) items.push({ label: b, icon: b === repo.branch ? '★' : '⑂', hint: b === repo.branch ? tr('current') : tr('Local'), value: { name: b } });
    for (const b of remote) items.push({ label: b, icon: '☁', hint: tr('Remote'), value: { name: b, remote: true } });
    const watch = watchBranchPopup(local);
    const choice = await ide.ui.pick({ placeholder: tr('Git Branches — {branch}', { branch: repo.branch || repo.detached }), items });
    watch.dispose();
    if (watch.menu) return branchMenu(watch.menu, local);
    if (!choice) return;
    if (choice.run) return choice.run();
    if (choice.create) {
      const name = await ide.ui.prompt(tr('New branch name'), '');
      if (!name) return;
      await ide.saveAll(); // like PyCharm: unsaved edits reach disk before HEAD moves, so git sees (and carries) them
      const r = await invoke('newBranch', ide.root, name.replace(/\s+/g, '-'));
      logResult(r);
      if (!r.ok) return notify(tr('Branch creation failed'), errorText(r), 'error', true);
      return afterCheckout();
    }
    return checkoutBranch(choice, local);
  }
  branchBtn.onclick = showBranches;

  async function checkoutBranch({ name, remote }, local) {
    if (name === repo?.branch) return;
    await ide.saveAll();
    const localName = remote ? name.split('/').slice(1).join('/') : name;
    const r = !remote ? await invoke('checkout', ide.root, name)
      : local.includes(localName) ? await invoke('checkout', ide.root, localName) : await invoke('checkout', ide.root, name, true);
    logResult(r);
    if (!r.ok) return notify(tr('Checkout failed'), errorText(r), 'error', true);
    notify(tr('Checked out {branch}', { branch: localName }), '', 'ok');
    afterCheckout();
  }

  // A local branch's own actions, as in PyCharm's branch popup: Right on the selected branch, or a right-click on one,
  // closes the popup and opens them beside that row. ide.ui.pick has no submenus, so the popup is watched while open.
  function watchBranchPopup(local) {
    const input = document.getElementById('popupIn');
    const list = document.getElementById('popupList');
    const watch = { menu: null };
    const open = (row, e) => {
      const v = row?._item?.value;
      if (!v?.name || v.remote || !local.includes(v.name)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = row.getBoundingClientRect();
      watch.menu = { name: v.name, x: Math.min(r.right - 8, r.left + 260), y: r.top };
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    };
    const onKey = (e) => {
      if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) open(list.querySelector('.popup-item.active'), e);
    };
    const onMouse = (e) => { if (e.button === 2) open(e.target.closest('.popup-item'), e); };
    input.addEventListener('keydown', onKey, true);
    list.addEventListener('mousedown', onMouse, true);
    watch.dispose = () => { input.removeEventListener('keydown', onKey, true); list.removeEventListener('mousedown', onMouse, true); };
    return watch;
  }

  function branchMenu({ name, x, y }, local) {
    const current = name === repo?.branch;
    const menu = ide.ui.contextMenu(x, y, [
      { label: tr('Checkout'), disabled: current, run: () => checkoutBranch({ name }, local) },
      { label: tr('Rename…'), run: () => renameBranch(name) },
      { label: tr('Delete'), disabled: current, run: () => deleteBranch(name) },
    ]);
    if (menu) menu.id = 'vcsBranchMenu';
  }

  async function renameBranch(from) {
    const to = (await ide.ui.prompt(tr('Rename branch {branch} to', { branch: from }), from))?.replace(/\s+/g, '-');
    if (!to || to === from) return;
    const r = await invoke('renameBranch', ide.root, from, to);
    logResult(r);
    if (!r.ok) return notify(tr('Branch rename failed'), errorText(r), 'error', true);
    notify(tr('Renamed branch {from} to {to}', { from, to }), '', 'ok');
    await refresh();
    if (gitTw.isVisible()) loadLog();
  }

  // As in PyCharm: a branch with commits no other branch has is deleted only after a question listing them, and the
  // notification offers to restore it.
  async function deleteBranch(name) {
    let r = await invoke('deleteBranch', ide.root, name);
    if (r.reason === 'notMerged') {
      logResult(r);
      if (!(await askDeleteUnmerged(name, r))) return;
      r = await invoke('deleteBranch', ide.root, name, { force: true });
    }
    logResult(r);
    if (!r.ok) return notify(tr('Branch deletion failed'), errorText(r), 'error', !r.reason);
    const restore = { label: tr('Restore'), run: async (note) => {
      note?.expire();
      const back = await invoke('restoreBranch', ide.root, name, r.hash, r.upstream);
      logResult(back);
      if (!back.ok) return notify(tr('Branch restore failed'), errorText(back), 'error', true);
      notify(tr('Restored branch {branch}', { branch: name }), '', 'ok');
      if (gitTw.isVisible()) loadLog();
    } };
    notify(tr('Deleted branch {branch}', { branch: name }), '', 'ok', false, r.hash ? [restore] : []);
    if (gitTw.isVisible()) loadLog();
  }

  function askDeleteUnmerged(name, r) {
    return new Promise((resolve) => {
      let yes = false;
      const body = el('div', 'vcs-unmerged');
      body.appendChild(el('div', null, tr('The branch {branch} is not fully merged to the branch {target}. Below is the list of unmerged commits.', { branch: name, target: r.target })));
      const list = userText('div', 'vcs-dialog-list vcs-unmerged-commits');
      for (const c of r.commits) {
        const row = el('div', 'vcs-push-commit');
        row.append(el('span', 'muted', c.short), el('span', null, ` ${c.subject}`), el('span', 'muted', `  ${c.author}`));
        list.appendChild(row);
      }
      body.appendChild(list);
      ide.ui.dialog({
        title: tr('Branch Is Not Fully Merged'), body, width: 520, onClose: () => resolve(yes),
        buttons: [{ label: tr('Delete'), primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }],
      });
    });
  }

  // ---------- Commit tool window ----------
  const included = new Map(); // lower path -> explicit checkbox choice
  const selection = new Set(); // lower paths selected in the changes list
  // A group lists its first rows only: a venv or data folder missing from .gitignore makes tens of thousands of
  // unversioned files, and rebuilding a row for each on every refresh and click took seconds. "Show more" doubles it.
  const GROUP_ROWS = 300;
  const groupRows = new Map(); // group title -> rows shown
  let listEl, msgEl, initBox, commitBody, headerEl;
  // Conflicted files are left out until resolved: committing one as is would record its conflict markers.
  const fileIncluded = (f) => f.status !== 'conflict' && (included.get(key(f.path)) ?? f.status !== 'unversioned');
  let prefilled = null; // the merge message put into an empty commit message box
  let commitBtn, pushBtn, amendInput;
  // While Amend is ticked the box shows the last commit's message: {text: the box before, message: what was put in}.
  let amendSaved = null;
  // The Shelf tab (drawn by the shelf section below; declared here because the tool window can mount at once).
  let commitTabs, changesPane, shelfPane, shelfList, shelfTabBtn;
  let shelves = []; // git:shelves, newest first
  const shelfOpen = new Set(); // ids of expanded shelves
  const shelfSel = { id: null, rels: new Set() }; // the selected shelf, or files of it
  const shelfShown = () => !!shelfPane && !shelfPane.classList.contains('hidden');

  function prefillMergeMessage() {
    if (!msgEl) return;
    if (repo?.op === 'merge' && repo.mergeMessage && !msgEl.value) msgEl.value = prefilled = repo.mergeMessage;
    else if (repo?.op !== 'merge' && prefilled) {
      if (msgEl.value === prefilled) msgEl.value = '';
      prefilled = null;
    }
  }

  const commitTw = ide.registerToolWindow({
    id: 'Commit', title: tr('Commit'), icon: '✓', side: 'left', keys: 'Alt+0', order: 10,
    mount(container, tw) {
      initBox = el('div', 'vcs-init');
      renderInitBox();

      commitBody = el('div', 'vcs-commit hidden');
      headerEl = el('div', 'vcs-commit-header');
      listEl = el('div', 'vcs-changes');
      listEl.tabIndex = 0;
      listEl.onkeydown = onListKey;
      msgEl = el('textarea', 'vcs-msg');
      msgEl.placeholder = tr('Commit Message');
      msgEl.onkeydown = (e) => {
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doCommit(false); }
      };
      const btns = el('div', 'vcs-commit-btns');
      commitBtn = el('button', 'primary vcs-commit-btn', tr('Commit'));
      commitBtn.title = tr('Commit (Ctrl+Enter)');
      commitBtn.onclick = () => doCommit(false);
      pushBtn = el('button', 'secondary vcs-commit-push-btn', tr('Commit and Push…'));
      pushBtn.onclick = () => doCommit(true);
      btns.append(commitBtn, pushBtn, commitOpts);
      // A row of its own: the buttons' labels grow with Amend, and a second click must not land on them.
      amendInput = checkbox(tr('Amend'), 'vcs-amend', false, setAmend).input;
      amendInput.id = 'vcsAmend';
      const msgBox = el('div', 'vcs-msg-box');
      msgBox.append(msgEl, msgActions);
      commitBody.append(headerEl, listEl, msgBox, amendInput.parentElement, btns);
      // Commit | Shelf tabs, as in PyCharm's Commit tool window (shown while the project is a repository).
      changesPane = el('div', 'vcs-changes-pane');
      changesPane.append(initBox, commitBody);
      commitTabs = el('div', 'vcs-subtabs vcs-commit-tabs hidden');
      const changesTab = el('button', 'vcs-ctab active', tr('Commit'));
      changesTab.id = 'vcsChangesTab';
      shelfTabBtn = el('button', 'vcs-ctab', tr('Shelf'));
      shelfTabBtn.id = 'vcsShelfTab';
      changesTab.onclick = () => switchCommitTab('changes');
      shelfTabBtn.onclick = () => switchCommitTab('shelf');
      commitTabs.append(changesTab, shelfTabBtn);
      shelfPane = buildShelfPane();
      container.append(commitTabs, changesPane, shelfPane);
      tw.setActions([
        { icon: '⟳', title: tr('Refresh'), run: () => (shelfShown() ? loadShelves() : refresh()) },
        { icon: '↶', title: tr('Rollback…'), keyAction: 'ChangesView.Revert', run: () => rollbackFiles(selectedFiles()) },
        { icon: '⇆', title: tr('Show Diff'), run: () => selectedFiles()[0] && openChange(selectedFiles()[0].path) },
        { icon: '⊟', title: tr('Shelve Changes…'), id: 'vcsShelveAction', keyAction: 'ChangesView.Shelve', run: () => openShelveDialog() },
      ]);
      prefillMergeMessage();
    },
  });

  // A conflicted file opens in the merge tool; any other change in a diff with HEAD.
  function openChange(path) {
    if (byPath.get(key(path))?.status === 'conflict' && conflictHandler) return conflictHandler.open(path);
    return openWorkingDiff(path);
  }

  const selectedFiles = () => [...selection].map((k) => byPath.get(k)).filter(Boolean);

  // What the Commit window says outside a repository: Create Git Repository only when there is none and Git can make
  // one. A missing Git or a repository git refuses is named, with git's own message.
  function renderInitBox() {
    const reason = noRepo?.reason;
    const shown = JSON.stringify([reason, noRepo?.top, noRepo?.error]);
    if (initBox.dataset.shown === shown) return;
    initBox.dataset.shown = shown;
    if (reason === 'gitMissing') initBox.replaceChildren(el('div', 'muted', REASONS.gitMissing));
    else if (reason === 'damaged') {
      initBox.replaceChildren(el('div', 'muted', tr('Git cannot use the repository in {path}. It may be damaged:', { path: noRepo.top })),
        userText('div', 'vcs-init-error', noRepo.error));
    } else {
      const initBtn = el('button', 'primary vcs-init-btn', tr('Create Git Repository…'));
      initBtn.onclick = createRepository;
      initBox.replaceChildren(el('div', 'muted', tr('Version control is not configured for this project.')), initBtn);
    }
    if (reason) {
      const again = el('button', 'secondary vcs-init-retry', tr('Refresh'));
      again.onclick = () => refresh();
      initBox.appendChild(again);
    }
  }

  // Everything the changes list is drawn from, as of its last drawing.
  let drawnKey = null;
  const changesKey = () => JSON.stringify([ide.root, repo, noRepo, [...selection], [...included], [...groupRows], commitHeaders.length, !!conflictHandler]);

  function renderChanges() {
    if (!listEl) return;
    drawnKey = changesKey();
    renderInitBox();
    initBox.classList.toggle('hidden', !!repo || !ide.root);
    commitBody.classList.toggle('hidden', !repo);
    commitTabs.classList.toggle('hidden', !repo);
    if (!repo && shelfShown()) switchCommitTab('changes');
    commitTw.setBadge(repo?.files.length ? String(repo.files.length) : '');
    renderAmend();
    if (!repo) { headerEl.replaceChildren(); return; }
    headerEl.replaceChildren(...commitHeaders.map((fn) => fn(repo)).filter(Boolean));
    const scroll = listEl.scrollTop;
    listEl.replaceChildren();
    const conflicts = repo.files.filter((f) => f.status === 'conflict');
    const changes = repo.files.filter((f) => f.status !== 'unversioned' && f.status !== 'conflict');
    const unversioned = repo.files.filter((f) => f.status === 'unversioned');
    if (conflicts.length) renderGroup(tr('Merge Conflicts'), conflicts, true);
    renderGroup(tr('Changes'), changes);
    if (unversioned.length) renderGroup(tr('Unversioned Files'), unversioned);
    listEl.scrollTop = scroll;
  }

  function renderGroup(title, files, conflicts = false) {
    const head = el('div', 'vcs-group' + (conflicts ? ' vcs-conflicts' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    const on = files.filter(fileIncluded).length;
    cb.checked = files.length > 0 && on === files.length;
    cb.indeterminate = on > 0 && on < files.length;
    cb.disabled = !files.length || conflicts;
    cb.onchange = () => { for (const f of files) included.set(key(f.path), cb.checked); renderChanges(); };
    head.append(el('span', 'arrow', '▾'), cb, el('span', 'vcs-group-title', title), el('span', 'muted', nFiles(files.length)));
    if (conflicts && conflictHandler) {
      const link = el('a', 'vcs-resolve-link', tr('Resolve'));
      link.href = '#';
      link.onclick = (e) => { e.preventDefault(); conflictHandler.resolve(); };
      head.appendChild(link);
    }
    listEl.appendChild(head);
    const limit = groupRows.get(title) || GROUP_ROWS;
    for (const f of files.slice(0, limit)) {
      const row = el('div', 'vcs-file' + (selection.has(key(f.path)) ? ' selected' : ''));
      row.dataset.path = f.path;
      row.dataset.status = f.status;
      const fcb = el('input');
      fcb.type = 'checkbox';
      fcb.checked = fileIncluded(f);
      fcb.disabled = f.status === 'conflict';
      fcb.onclick = (e) => e.stopPropagation();
      fcb.onchange = () => { included.set(key(f.path), fcb.checked); renderChanges(); };
      const name = userText('span', 'vcs-name', basename(f.path));
      name.style.color = COLORS[f.status];
      const dir = ide.util.rel(dirname(f.path));
      row.append(fcb, Object.assign(ide.fileIcon(f.path), { className: 'file-icon icon' }), name, userText('span', 'muted vcs-dir', samePath(dirname(f.path), ide.root) ? '' : dir));
      row.title = `${ide.util.rel(f.path)} — ${STATUS_LABEL[f.status] || f.status}`;
      row.onclick = (e) => {
        if (!e.ctrlKey) selection.clear();
        const k = key(f.path);
        e.ctrlKey && selection.has(k) ? selection.delete(k) : selection.add(k);
        listEl.focus();
        renderChanges();
      };
      row.ondblclick = () => openChange(f.path);
      listEl.appendChild(row);
    }
    if (files.length > limit) {
      const more = el('a', 'vcs-more', tr('Show {n} more', { n: Math.min(limit, files.length - limit) }));
      more.href = '#';
      more.onclick = (e) => { e.preventDefault(); groupRows.set(title, limit * 2); renderChanges(); };
      const moreRow = el('div', 'vcs-more-row');
      moreRow.append(more, el('span', 'muted', tr('{shown} of {total}', { shown: limit, total: files.length })));
      listEl.appendChild(moreRow);
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
      openChange(rows[i].dataset.path);
    } else if (e.key === ' ' && rows[i]) {
      e.preventDefault();
      for (const f of selectedFiles()) included.set(key(f.path), !fileIncluded(f));
      renderChanges();
    }
  }

  async function createRepository() {
    if (!ide.root) return;
    if (noRepo?.reason === 'damaged') {
      return notify(tr('Git init failed'), `${tr('Git cannot use the repository in {path}. It may be damaged:', { path: noRepo.top })} ${noRepo.error}`, 'error', true);
    }
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
    // From the Shelf tab (where shelving leaves the window) Commit… goes back to the changes, as in PyCharm.
    if (shelfShown()) switchCommitTab('changes');
    if (repo) msgEl.focus();
  }

  // Amend, as in PyCharm: the box takes the last commit's message (the text typed before comes back when Amend is
  // turned off with the message unedited) and the buttons say Amend Commit. No commit yet, or git stopped in a merge,
  // rebase or cherry-pick: there is nothing git would amend.
  async function setAmend(on) {
    if (on) {
      const last = await invoke('lastCommit', ide.root);
      if (!amendInput.checked) return;
      if (!last) { amendInput.checked = false; return renderAmend(); }
      amendSaved = { text: msgEl.value, message: last.message };
      msgEl.value = last.message;
    } else if (amendSaved) {
      if (msgEl.value === amendSaved.message) msgEl.value = amendSaved.text;
      amendSaved = null;
    }
    renderAmend();
  }

  function renderAmend() {
    if (!amendInput) return;
    const can = !!repo?.head && !repo.op;
    amendInput.disabled = !can;
    if (!can && amendInput.checked) { amendInput.checked = false; setAmend(false); return; }
    commitBtn.textContent = amendInput.checked ? tr('Amend Commit') : tr('Commit');
    pushBtn.textContent = amendInput.checked ? tr('Amend Commit and Push…') : tr('Commit and Push…');
  }

  let committing = false;
  async function doCommit(andPush) {
    if (!repo || committing) return;
    committing = true;
    try { await commitNow(andPush); } finally { committing = false; }
  }

  async function commitNow(andPush) {
    await ide.saveAll();
    await refresh();
    if (!repo) return;
    let files = repo.files.filter(fileIncluded);
    const message = msgEl.value.trim();
    const amend = !!amendInput?.checked;
    // A merge whose result equals HEAD still needs its merge commit; Amend with no files changes only the message.
    const filesOptional = repo.op === 'merge' || amend;
    if (!files.length && !filesOptional) return notify(tr('No changes selected for commit'), tr('Select files with the checkboxes in the Commit tool window.'), 'warn');
    if (!message) { msgEl.focus(); return notify(tr('Commit message is empty'), tr('Enter a commit message.'), 'warn'); }
    if (amend) {
      const last = await invoke('lastCommit', ide.root);
      if (last?.pushedTo && !(await ide.ui.confirm(tr('The last commit is already pushed to {upstream}. Amending it rewrites history: pushing it again needs a force push, and anyone who pulled it has to recover their copy. Amend anyway?', { upstream: last.pushedTo }), { title: tr('Amend Commit'), ok: tr('Amend Commit') }))) return;
    }
    // Commit checks (vcs-checks plugin): a hook returning false stops the commit; one may rewrite and save the files.
    if (beforeCommit.length) {
      for (const hook of beforeCommit) if ((await hook({ files, message, andPush, amend })) === false) return;
      await ide.saveAll();
      const chosen = new Set(files.map((f) => key(f.path)));
      await refresh();
      if (!repo) return;
      files = repo.files.filter((f) => chosen.has(key(f.path)) && f.status !== 'conflict');
      if (!files.length && !filesOptional) return notify(tr('No changes selected for commit'), tr('Select files with the checkboxes in the Commit tool window.'), 'warn');
    }
    const r = await invoke('commit', ide.root, msgEl.value.replace(/\s+$/, ''), files.map((f) => ({ path: f.path, orig: f.orig })), { amend });
    logResult(r);
    if (!r.ok) return notify(tr('Commit failed'), errorText(r), 'error', true);
    msgEl.value = '';
    included.clear();
    selection.clear();
    if (amend) {
      amendInput.checked = false;
      amendSaved = null;
      renderAmend();
      notify(tr('Amended the last commit: {message}', { message: message.split('\n')[0] }), '', 'ok');
    } else notify(trn(files.length, '{n} file committed: {message}', '{n} files committed: {message}', { message: message.split('\n')[0] }), '', 'ok');
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

  // inline: one column with removed and added lines interleaved, for a narrow pane.
  function mountDiff(host, { leftTitle, rightTitle, left, right, rightModel, name, inline = false }) {
    const head = el('div', 'vcs-diff-head');
    head.append(diffSide(leftTitle), diffSide(rightTitle));
    const box = el('div', 'vcs-diff-body');
    host.append(head, box);
    const monaco = ide.monaco;
    const original = monaco.editor.createModel(left ?? '', undefined, diffUri(name));
    const modified = rightModel || monaco.editor.createModel(right ?? '', undefined, diffUri(name));
    const diff = monaco.editor.createDiffEditor(box, {
      automaticLayout: true, readOnly: !rightModel, originalEditable: false, renderSideBySide: !inline,
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
    openLocalDiff({ id, path, left, deleted: f?.status === 'deleted',
      leftTitle: lastHead ? tr('HEAD ({hash}) — read-only', { hash: lastHead.slice(0, 8) }) : 'HEAD' });
  }

  // A diff tab of `left` against the file as it is now: the open editor's model (edits show at once and can be made in
  // the diff), else the text on disk, read-only.
  async function openLocalDiff({ id, path, left, leftTitle, deleted = false }) {
    const tab = ide.findTab(path);
    let right = null;
    if (!tab && !deleted) { try { right = (await ide.api.invoke('fs:readText', path)).text ?? ''; } catch { right = ''; } }
    let dispose;
    let unsub;
    ide.openCustomTab({
      id, title: tr('Diff: {name}', { name: basename(path) }), icon: '⇆',
      mount(host) {
        dispose = mountDiff(host, {
          name: basename(path), left, right, rightModel: tab?.model, leftTitle,
          rightTitle: tab ? tr('Your version') : tr('Your version — read-only'),
        });
        // the right side shares the open editor's model, so the diff cannot outlive that tab
        if (tab) unsub = ide.on('fileClosed', (p) => samePath(p, path) && setTimeout(() => ide.closeTab(id)));
      },
      onClose() { unsub?.(); dispose?.(); },
    });
  }

  // A file before and after a commit (a rename's old name on the left): '' where it does not exist, {binary: true}
  // for a binary version.
  const commitSides = (hash, { status, rel, orig }) => Promise.all([
    status === 'added' ? '' : invoke('fileAt', ide.root, `${hash}^`, orig || rel, { binary: true }),
    status === 'deleted' ? '' : invoke('fileAt', ide.root, hash, rel, { binary: true }),
  ]).then((sides) => sides.map((s) => s ?? ''));
  const notifyBinary = (rel) => notify(tr('Binary file'), tr('{name} is a binary file; it cannot be shown as text.', { name: basename(rel) }), 'warn');

  async function openCommitDiff(commit, file) {
    const id = `${file.path} [${commit.hash.slice(0, 8)}]`;
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    const [left, right] = await commitSides(commit.hash, file);
    if (left.binary || right.binary) return notifyBinary(file.rel);
    openTextDiff({
      id, title: `${basename(file.rel)} (${commit.hash.slice(0, 7)})`, name: basename(file.rel), left, right,
      leftTitle: tr('{hash}^ (parent)', { hash: commit.hash.slice(0, 7) }),
      rightTitle: { user: `${commit.hash.slice(0, 7)} — ${commit.message?.split('\n')[0] || ''}` },
    });
  }

  // A read-only diff tab of two texts; titles as in mountDiff.
  function openTextDiff({ id, title, name, left, right, leftTitle, rightTitle }) {
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    let dispose;
    ide.openCustomTab({
      id, title, icon: '⇆',
      mount(host) { dispose = mountDiff(host, { name, left, right, leftTitle, rightTitle }); },
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
    const oldLines = a.slice(pre, a.length - suf);
    const N = oldLines.length;
    const M = b.length - pre - suf;
    // Every hunk carries its HEAD lines (Rollback Lines puts them back).
    const whole = [{ os: pre, oc: N, ns: pre, nc: M, old: oldLines }];
    if (!N && !M) return [];
    if (!N || !M) return whole;
    // Lines as numbers: the search below compares them millions of times on a big diff.
    const ids = new Map();
    const id = (l) => { let n = ids.get(l); if (n === undefined) ids.set(l, (n = ids.size)); return n; };
    const A = Int32Array.from(oldLines, id);
    const B = Int32Array.from(b.slice(pre, b.length - suf), id);
    // More than MAX_D edits is pathological input: one big hunk. Lines one side lacks are edits whatever the
    // alignment, so a heavily rewritten file is recognized here without the O(MAX_D²) search (175 ms on 20k lines).
    const MAX_D = 4000;
    if (N + M > MAX_D) {
      const count = new Int32Array(ids.size);
      for (const l of A) count[l]++;
      let matched = 0;
      for (const l of B) if (count[l] > 0) { count[l]--; matched++; }
      if (N + M - 2 * matched > MAX_D) return whole;
    }
    const max = N + M;
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let D = -1;
    for (let d = 0; d <= max && D < 0; d++) {
      if (d > MAX_D) return whole;
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
      hunks.push({ os: os + pre, oc: i - os, ns: ns + pre, nc: j - ns, old: oldLines.slice(os, i) });
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
    const started = performance.now();
    g.base = base;
    g.hunks = base == null ? [] : diffLines(base.split(/\r?\n/), tab.model.getLinesContent());
    g.ms = performance.now() - started;
    g.ids = tab.model.deltaDecorations(g.ids, g.hunks.map((h) => hunkDecoration(h, tab.model)));
    gutters.set(k, g);
    return g;
  }

  async function updateGutter(tab) {
    if (tab?.kind !== 'file' || tab.model.isDisposed()) return;
    const f = byPath.get(key(tab.path));
    const base = repo && f?.status !== 'unversioned' && f?.status !== 'added' ? await headText(tab.path) : null;
    if (!tab.model.isDisposed() && ide.findTab(tab.path)?.model === tab.model) applyGutter(tab, base);
  }

  // The change markers are model decorations, so every pane showing the file has them; an edit typed in any pane
  // (or in an editor embedded in a viewer) recomputes them.
  const tabOf = (ed) => { const m = ed.getModel(); return m ? ide.tabs.find((t) => t.model === m) || null : null; };
  const fileTabOf = (ed) => { const t = tabOf(ed); return t && { kind: 'file', path: t.path, model: t.model }; };
  let gutterTimer;
  ide.onEditor((ed) => ed.onDidChangeModelContent(() => {
    clearTimeout(gutterTimer);
    // A file whose last diff took long (big and heavily changed) is diffed after a longer pause in typing.
    const tab = tabOf(ed);
    const slow = tab && gutters.get(key(tab.path))?.ms > 40;
    gutterTimer = setTimeout(() => updateGutter(fileTabOf(ed)), slow ? 1000 : 250);
  }));

  // Every file shown in some pane, not just the active one, so a split view stays current after commits and checkouts.
  function updateVisibleGutters() {
    const seen = new Set();
    for (const ed of vcsEditors.keys()) {
      const tab = fileTabOf(ed);
      if (tab && !seen.has(tab.model)) { seen.add(tab.model); updateGutter(tab); }
    }
  }

  // Recomputes synchronously so navigation sees edits typed within the debounce window.
  function currentHunks(tab) {
    if (tab?.kind !== 'file') return [];
    const g = gutters.get(key(tab.path));
    return g?.base == null ? [] : applyGutter(tab, g.base).hunks;
  }

  function gotoChange(dir, ed = ide.editor) {
    const tab = ed && fileTabOf(ed);
    const hunks = currentHunks(tab);
    if (!hunks.length) return;
    const line = ed.getPosition()?.lineNumber || 1;
    const starts = hunks.map((h) => hunkLine(h, tab.model));
    let target = dir > 0 ? starts.find((s) => s > line) : [...starts].reverse().find((s) => s < line);
    if (target == null) target = dir > 0 ? starts[0] : starts[starts.length - 1];
    ed.setPosition({ lineNumber: target, column: 1 });
    ed.revealLineInCenterIfOutsideViewport(target);
    ed.focus();
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

  // The blame column is model decorations, but its width and the context keys are per editor: each pane sizes its
  // gutter for the file it shows.
  function applyAnnotationLayout(ed) {
    const keys = vcsEditors.get(ed);
    if (!keys) return;
    const t = tabOf(ed);
    const b = t && blames.get(key(t.path));
    keys.annotated.set(!!b);
    ed.updateOptions({ lineDecorationsWidth: b ? b.width : 10 });
    ed.getDomNode()?.style.setProperty('--vcs-bar-left', b ? `${b.width - 6}px` : '0px');
  }
  const layoutAnnotations = () => { for (const ed of vcsEditors.keys()) applyAnnotationLayout(ed); };

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
    layoutAnnotations();
  }

  function closeAnnotations(tab) {
    const b = tab && blames.get(key(tab.path));
    if (!b) return;
    if (!tab.model.isDisposed()) tab.model.deltaDecorations(b.ids, []);
    blames.delete(key(tab.path));
    rebuildBlameCss();
    layoutAnnotations();
  }

  // Toggles annotations for the file shown in `ed` (the active pane unless a context menu names another editor).
  const toggleAnnotate = (ed = ide.editor) => {
    const tab = ed && fileTabOf(ed);
    if (!tab) return;
    blames.has(key(tab.path)) ? closeAnnotations(tab) : annotate(tab);
  };

  // Per-editor context keys, context-menu actions and gutter clicks, for every pane and viewer-embedded editor.
  const vcsEditors = new Map(); // editor -> {repo, annotated} context keys
  let repoOn = false;
  function setRepoKey(on) {
    repoOn = on;
    for (const k of vcsEditors.values()) k.repo.set(on);
  }
  ide.onEditor((ed) => {
    vcsEditors.set(ed, { repo: ed.createContextKey('vcsRepo', repoOn), annotated: ed.createContextKey('vcsAnnotated', false) });
    ed.onDidDispose(() => vcsEditors.delete(ed));
    ed.onDidChangeModel(() => applyAnnotationLayout(ed));
    ed.addAction({ id: 'vcs.annotate', label: tr('Annotate with Git Blame'), contextMenuGroupId: '9_vcs', precondition: 'vcsRepo && !vcsAnnotated', run: () => toggleAnnotate(ed) });
    ed.addAction({ id: 'vcs.closeAnnotations', label: tr('Close Annotations'), contextMenuGroupId: '9_vcs', precondition: 'vcsAnnotated', run: () => toggleAnnotate(ed) });
    ed.addAction({ id: 'vcs.showHistory', label: tr('Git: Show History'), contextMenuGroupId: '9_vcs', precondition: 'vcsRepo', run: () => { const t = fileTabOf(ed); if (t) showHistory(t.path); } });
    ed.onMouseDown((e) => gutterMouseDown(ed, e));
    applyAnnotationLayout(ed);
  });

  function gutterMouseDown(ed, e) {
    const M = ide.monaco;
    if (e.target.type !== M.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !e.target.position) return;
    const tab = fileTabOf(ed);
    if (!tab) return;
    const line = e.target.position.lineNumber;
    const b = blames.get(key(tab.path));
    const layout = ed.getLayoutInfo();
    const x = e.event.posx - ed.getDomNode().getBoundingClientRect().left;
    if (b && x < layout.decorationsLeft + b.width - 8) {
      const cls = tab.model.getLineDecorations(line).map((d) => d.options.linesDecorationsClassName || '')
        .map((c) => c.split(' ').find((n) => b.classToHash[n])).find(Boolean);
      if (cls) showCommit(b.classToHash[cls]);
      return;
    }
    const h = hunkAt(tab, line);
    if (!h || !e.event.leftButton) return;
    ide.ui.contextMenu(e.event.posx, e.event.posy, [
      { label: tr('Rollback Lines'), keyAction: 'ChangesView.Revert', run: () => rollbackHunk(tab, h) },
      { label: tr('Show Diff'), run: () => openWorkingDiff(tab.path) },
      { separator: true },
      { label: tr('Next Change'), keyAction: 'VcsShowNextChangeMarker', run: () => { ed.setPosition({ lineNumber: line, column: 1 }); gotoChange(1, ed); } },
      { label: tr('Previous Change'), keyAction: 'VcsShowPrevChangeMarker', run: () => { ed.setPosition({ lineNumber: line, column: 1 }); gotoChange(-1, ed); } },
    ]);
  }

  // ---------- Git tool window: Log, Activity and Console ----------
  let logRows, filesEl, detailsEl, logPane, activityPane, activityRows, consolePane, subTabs, logSearch, authorSelect, kindSelect, historyChip;
  let commits = [];
  let historyOf = null; // the file whose history the Log shows (Show History), or null for every commit
  let disposePreview = null; // the history's diff preview, while it shows
  let layout = { rows: new Map(), lanes: 0 };
  let activity = [];
  let me = null;
  let unpushed = new Set(); // hashes of HEAD's commits no remote branch has: Undo Commit and Edit Commit Message
  let selectedCommit = null;
  let details = null;
  // Activity badges; defined before the tool window because its mount can run as soon as it is registered.
  const KIND_LABEL = {
    commit: tr('Commit'), amend: tr('Amend'), merge: tr('Merge'), checkout: tr('Checkout'), pull: tr('Pull'),
    reset: tr('Reset'), rebase: tr('Rebase'), 'cherry-pick': tr('Cherry-pick'), revert: tr('Revert'), clone: tr('Clone'), other: tr('Other'),
  };
  const gitTw = ide.registerToolWindow({
    id: 'Git', title: 'Git', icon: '⑂', side: 'bottom', keys: 'Alt+9', order: 45,
    mount(container, tw) {
      subTabs = el('div', 'vcs-subtabs');
      const tabs = { log: el('button', 'vcs-subtab active', tr('Log')), activity: el('button', 'vcs-subtab', tr('Activity')), console: el('button', 'vcs-subtab', tr('Console')) };
      tabs.activity.id = 'vcsActivityTab';
      subTabs.append(tabs.log, tabs.activity, tabs.console);

      logPane = el('div', 'vcs-log');
      const table = el('div', 'vcs-log-table');
      const bar = el('div', 'vcs-log-bar');
      logSearch = el('input', 'vcs-log-search');
      logSearch.id = 'vcsLogSearch';
      logSearch.placeholder = tr('Search commits (message, hash, author)');
      logSearch.oninput = () => renderLog();
      authorSelect = el('select', 'vcs-log-author');
      authorSelect.id = 'vcsLogAuthor';
      authorSelect.onchange = () => renderLog();
      const authorLabel = el('label', 'muted', tr('User:'));
      authorLabel.htmlFor = authorSelect.id; // names the list for screen readers
      // One unit, so a narrow bar wraps it whole onto the next line instead of breaking the label.
      const authorFilter = el('span', 'vcs-log-user');
      authorFilter.append(authorLabel, authorSelect);
      historyChip = el('span', 'vcs-log-path hidden');
      historyChip.id = 'vcsLogPath';
      bar.append(logSearch, authorFilter, historyChip);
      const header = el('div', 'vcs-log-row vcs-log-header');
      header.append(el('span', 'vcs-c-subject', tr('Commit')), el('span', 'vcs-c-author', tr('Author')), el('span', 'vcs-c-date', tr('Date')));
      logRows = el('div', 'vcs-log-rows');
      logRows.tabIndex = 0;
      logRows.onkeydown = (e) => {
        if (e.key === 'Enter' && historyOf && selectedCommit) {
          e.preventDefault();
          const c = commits.find((x) => x.hash === selectedCommit);
          if (c) showHistoryDiff(c);
          return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const shown = visibleCommits();
        const i = shown.findIndex((c) => c.hash === selectedCommit);
        const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) selectCommit(next.hash);
      };
      table.append(bar, header, logRows);
      const side = el('div', 'vcs-log-side');
      filesEl = el('div', 'vcs-log-files');
      detailsEl = el('div', 'vcs-log-details');
      side.append(filesEl, detailsEl);
      logPane.append(table, side);

      activityPane = el('div', 'vcs-activity hidden');
      const abar = el('div', 'vcs-log-bar');
      kindSelect = el('select');
      kindSelect.id = 'vcsActivityKind';
      kindSelect.add(new Option(tr('All actions'), ''));
      for (const k of Object.keys(KIND_LABEL)) kindSelect.add(new Option(KIND_LABEL[k], k));
      kindSelect.onchange = () => renderActivity();
      abar.append(el('span', 'muted', tr('What happened in this repository, newest first')), el('span', 'vcs-spacer'), kindSelect);
      activityRows = el('div', 'vcs-activity-rows');
      activityRows.id = 'vcsActivity';
      activityPane.append(abar, activityRows);

      consolePane = el('div', 'vcs-console hidden');
      gitConsole = ide.ui.console(consolePane);
      gitConsole.out.id = 'vcsConsole';
      const panes = { log: logPane, activity: activityPane, console: consolePane };
      // true / false keep the old meaning (Log / Console) for existing callers.
      const switchTo = (name) => {
        const which = name === true ? 'log' : name === false ? 'console' : name;
        for (const [k, b] of Object.entries(tabs)) b.classList.toggle('active', k === which);
        for (const [k, p] of Object.entries(panes)) p.classList.toggle('hidden', k !== which);
        if (which === 'activity') loadActivity();
      };
      for (const k of Object.keys(tabs)) tabs[k].onclick = () => switchTo(k);
      subTabs.switchTo = switchTo;
      container.append(subTabs, logPane, activityPane, consolePane);
      tw.setActions([
        { icon: '⟳', title: tr('Refresh'), run: loadLog },
        { icon: '↓', title: tr('Update Project…'), keyAction: 'Vcs.UpdateProject', run: updateProject },
        { icon: '↑', title: tr('Push…'), keyAction: 'Vcs.Push', run: openPushDialog },
      ]);
    },
  });

  function showConsole() {
    gitTw.show();
    subTabs.switchTo(false);
  }

  // Commit graph like PyCharm's log: each commit sits on a lane and lines run to its parents. Lanes hold the hash
  // each one waits for; a commit takes the lane waiting for it (others waiting for it merge in), its first parent
  // continues that lane and further parents (merges) branch out to lanes of their own.
  function layoutGraph(list) {
    const lanes = [];
    const rows = new Map();
    let width = 0;
    for (const c of list) {
      const before = lanes.slice();
      let lane = lanes.indexOf(c.hash);
      const fromAbove = lane >= 0;
      if (!fromAbove) { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; }
      const into = [];
      lanes.forEach((h, i) => { if (h === c.hash && i !== lane) { into.push(i); lanes[i] = null; } });
      lanes[lane] = c.parents[0] ?? null;
      const out = [];
      for (const p of c.parents.slice(1)) {
        let j = lanes.indexOf(p);
        if (j < 0) { j = lanes.indexOf(null); if (j < 0) j = lanes.length; lanes[j] = p; }
        out.push(j);
      }
      while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
      width = Math.max(width, before.length, lane + 1, lanes.length);
      rows.set(c.hash, { lane, before, into, out, fromAbove, down: c.parents.length > 0 });
    }
    return { rows, lanes: width };
  }

  const LANE = 12;
  const MAX_LANES = 14;
  const LANE_COLORS = ['#3592c4', '#d1873a', '#5fb86b', '#c75cc0', '#c9b640', '#4fb5ad', '#e06c75', '#8f8ce6'];
  const laneX = (i) => Math.min(i, MAX_LANES - 1) * LANE + LANE / 2 + 2;
  const SVG = 'http://www.w3.org/2000/svg';

  function graphCell(g, lanes, merge) {
    const svg = document.createElementNS(SVG, 'svg');
    const width = Math.min(lanes, MAX_LANES) * LANE + 4;
    svg.setAttribute('class', 'vcs-graph');
    svg.setAttribute('width', width);
    svg.setAttribute('height', 24);
    const color = (i) => LANE_COLORS[i % LANE_COLORS.length];
    const line = (x1, y1, x2, y2, lane) => {
      const p = document.createElementNS(SVG, 'path');
      const my = (y1 + y2) / 2;
      p.setAttribute('d', x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`);
      p.setAttribute('stroke', color(lane));
      svg.appendChild(p);
    };
    if (g) {
      g.before.forEach((h, i) => {
        if (!h) return;
        if (i === g.lane) { if (g.fromAbove) line(laneX(i), 0, laneX(i), 12, i); }
        else if (g.into.includes(i)) line(laneX(i), 0, laneX(g.lane), 12, i);
        else line(laneX(i), 0, laneX(i), 24, i);
      });
      if (g.down) line(laneX(g.lane), 12, laneX(g.lane), 24, g.lane);
      for (const j of g.out) line(laneX(g.lane), 12, laneX(j), 24, j);
    }
    const dot = document.createElementNS(SVG, 'circle');
    const lane = g ? g.lane : 0;
    dot.setAttribute('cx', laneX(lane));
    dot.setAttribute('cy', 12);
    dot.setAttribute('r', merge ? 4 : 3.5);
    dot.setAttribute('class', merge ? 'vcs-node merge' : 'vcs-node');
    dot.style.setProperty('--lane', color(lane));
    svg.appendChild(dot);
    return svg;
  }

  const isMine = (c) => !!me && (c.author === me.name || (me.email && c.email === me.email));
  function visibleCommits() {
    const q = logSearch?.value.trim().toLowerCase() || '';
    const who = authorSelect?.value || '';
    return commits.filter((c) => (!who || (who === '@me' ? isMine(c) : c.author === who))
      && (!q || c.subject.toLowerCase().includes(q) || c.hash.startsWith(q) || c.author.toLowerCase().includes(q)));
  }

  function fillAuthors() {
    const keep = authorSelect.value;
    authorSelect.replaceChildren(new Option(tr('All'), ''));
    if (me?.name) authorSelect.add(new Option(tr('Me ({name})', { name: me.name }), '@me'));
    for (const a of [...new Set(commits.map((c) => c.author))].sort()) authorSelect.add(new Option(a, a));
    authorSelect.value = [...authorSelect.options].some((o) => o.value === keep) ? keep : '';
  }

  let logSeq = 0;
  async function loadLog() {
    if (!logRows) return;
    const my = ++logSeq;
    if (!repo) {
      commits = [];
      activity = [];
      logRows.replaceChildren(el('div', 'vcs-empty muted', ide.root ? tr('No Git repository in this project') : tr('No project')));
      activityRows.replaceChildren(el('div', 'vcs-empty muted', ide.root ? tr('No Git repository in this project') : tr('No project')));
      setHistoryOf(null);
      filesEl.replaceChildren();
      detailsEl.replaceChildren();
      return;
    }
    const [list, who, mine] = await Promise.all([historyOf ? invoke('fileHistory', ide.root, historyOf) : invoke('log', ide.root), invoke('identity', ide.root),
      invoke('unpushed', ide.root)]);
    if (my !== logSeq) return;
    commits = list;
    me = who;
    unpushed = new Set(mine);
    layout = layoutGraph(commits);
    fillAuthors();
    if (!commits.some((c) => c.hash === selectedCommit)) selectedCommit = commits[0]?.hash || null;
    renderLog();
    if (selectedCommit) selectCommit(selectedCommit);
    else { closePreview(); filesEl.replaceChildren(); detailsEl.replaceChildren(el('div', 'muted', tr('No commits yet'))); }
    if (!activityPane.classList.contains('hidden')) loadActivity();
  }

  function renderLog() {
    logRows.replaceChildren();
    if (!commits.length) logRows.appendChild(el('div', 'vcs-empty muted', tr('No commits yet')));
    const shown = visibleCommits();
    // A filtered list (a file's history too) has gaps, so lines between its commits would lie; it keeps only the dots.
    const filtered = !!historyOf || shown.length !== commits.length;
    logRows.classList.toggle('filtered', filtered);
    if (commits.length && !shown.length) logRows.appendChild(el('div', 'vcs-empty muted', tr('No commits match the filter')));
    for (const c of shown) {
      const merge = c.parents.length > 1;
      const row = el('div', 'vcs-log-row' + (c.hash === selectedCommit ? ' selected' : '') + (merge ? ' merge' : ''));
      row.dataset.hash = c.hash;
      // subject, refs and author are user data
      const subj = userText('span', 'vcs-c-subject');
      subj.appendChild(graphCell(filtered ? null : layout.rows.get(c.hash), filtered ? 1 : layout.lanes, merge));
      for (const ref of c.refs) {
        const name = ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
        if (name === 'HEAD' || name.endsWith('/HEAD')) continue;
        subj.appendChild(el('span', 'vcs-ref' + (ref.startsWith('HEAD -> ') ? ' head' : ref.startsWith('tag: ') ? ' tag' : ref.includes('/') ? ' remote' : ''), name));
      }
      if (merge) subj.appendChild(el('span', 'vcs-badge merge', tr('Merge')));
      subj.appendChild(el('span', 'vcs-subject-text', c.subject));
      const author = userText('span', 'vcs-c-author' + (isMine(c) ? ' mine' : ''), c.author);
      row.append(subj, author, el('span', 'vcs-c-date', fmtDate(c.time)));
      subj.title = `${c.short} ${c.subject}`;
      row.onclick = () => { selectCommit(c.hash); logRows.focus(); };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        selectCommit(c.hash);
        const own = historyOf ? [
          { label: tr('Show Diff'), run: () => showHistoryDiff(c) },
          { label: tr('Compare with Local'), run: () => compareWithLocal(c) },
          { separator: true },
        ] : [];
        const menu = ide.ui.contextMenu(e.clientX, e.clientY, [...own, ...commitActions(c)]);
        if (menu) menu.id = 'vcsLogMenu';
      };
      logRows.appendChild(row);
    }
  }

  // ---------- the Log's commit menu ----------
  // PyCharm's menu for one commit. Cherry-Pick and Revert Commit come from the vcs-merge plugin (addLogActions). Undo
  // Commit and Edit Commit Message rewrite only commits no remote branch has, as PyCharm allows.
  function commitActions(c) {
    const busy = !!repo?.op;
    const mine = unpushed.has(c.hash);
    return [
      { label: tr('Copy Revision Number'), run: () => ide.api.invoke('clipboard:writeText', c.hash) },
      { separator: true },
      ...logActions.flatMap((fn) => fn(c)),
      { label: tr('Checkout Revision'), disabled: busy, run: () => checkoutRevision(c) },
      { separator: true },
      { label: tr('Reset Current Branch to Here…'), disabled: !repo?.head, run: () => resetToHere(c) },
      { label: tr('Undo Commit'), disabled: busy || !mine || c.hash !== repo?.head || c.parents.length > 1, run: () => undoCommit(c) },
      { label: tr('Edit Commit Message…'), disabled: busy || !mine, run: () => editMessage(c) },
      { separator: true },
      { label: tr('New Branch…'), run: () => branchHere(c) },
      { label: tr('New Tag…'), run: () => tagHere(c) },
    ];
  }

  // After a command that moved HEAD: the editors, the changes and the log, with `select` the commit to show.
  async function afterRewrite(select) {
    if (select) selectedCommit = select;
    await afterCheckout();
  }

  async function checkoutRevision(c) {
    await ide.saveAll();
    const r = await invoke('checkout', ide.root, c.hash);
    logResult(r);
    if (!r.ok) return notify(tr('Checkout failed'), errorText(r), 'error', true);
    notify(tr('Checked out {branch}', { branch: c.short }), '', 'ok');
    afterRewrite(c.hash);
  }

  // PyCharm's Git Reset dialog: git reset's four modes, Mixed first chosen.
  function resetToHere(c) {
    const modes = [
      { mode: 'soft', label: tr('Soft'), text: tr("Files won't change, differences will be staged for commit.") },
      { mode: 'mixed', label: tr('Mixed'), text: tr("Files won't change, differences won't be staged.") },
      { mode: 'hard', label: tr('Hard'), text: tr('Files will be reverted to the state of the selected commit.'), warn: tr('Warning: any local changes will be lost.') },
      { mode: 'keep', label: tr('Keep'), text: tr('Files will be reverted to the state of the selected commit, but local changes will be kept intact.') },
    ];
    const body = el('div', 'vcs-reset');
    body.append(el('div', null, tr('This will reset the current branch head to the selected commit, and update the working tree and the index according to the selected mode:')),
      userText('div', 'vcs-reset-target muted', `${c.short} ${c.subject}`));
    for (const m of modes) {
      const row = el('label', 'vcs-reset-mode');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'vcsResetMode';
      radio.value = m.mode;
      radio.checked = m.mode === 'mixed';
      const text = el('div', 'vcs-reset-text');
      text.append(el('div', 'vcs-reset-label', m.label), el('div', 'muted', m.text), ...(m.warn ? [el('div', 'vcs-reset-warn', m.warn)] : []));
      row.append(radio, text);
      body.appendChild(row);
    }
    ide.ui.dialog({
      title: tr('Git Reset'), body, width: 560,
      buttons: [{ label: tr('Reset'), primary: true, run: () => { reset(c, body.querySelector('input[name=vcsResetMode]:checked').value); } }, { label: tr('Cancel') }],
    });
  }

  async function reset(c, mode) {
    await ide.saveAll();
    const r = await invoke('reset', ide.root, c.hash, mode);
    logResult(r);
    if (!r.ok) return notify(tr('Reset failed'), errorText(r), 'error', true);
    afterRewrite(c.hash);
  }

  // The commit's changes stay as local changes and its message goes back into the commit box, as in PyCharm.
  async function undoCommit(c) {
    const r = await invoke('undoCommit', ide.root, c.hash);
    logResult(r);
    if (!r.ok) return notify(tr('Undo Commit failed'), errorText(r), 'error', !r.reason);
    commitTw.show();
    if (amendInput?.checked) { amendInput.checked = false; await setAmend(false); }
    if (msgEl) msgEl.value = r.message;
    await afterRewrite(c.parents[0] || null);
  }

  async function editMessage(c) {
    const d = await invoke('commitDetails', ide.root, c.hash);
    const box = el('textarea', 'vcs-reword-text');
    box.value = d.message;
    box.rows = 8;
    box.spellcheck = false;
    box.onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); dlg.el.querySelector('.dialog-buttons .primary').click(); } };
    const dlg = ide.ui.dialog({
      title: tr('Edit Commit Message'), body: box, width: 560,
      buttons: [{ label: tr('OK'), primary: true, run: () => {
        const message = box.value.trim();
        if (!message) { box.focus(); return false; }
        if (message !== d.message.trim()) reword(c, message);
      } }, { label: tr('Cancel') }],
    });
    box.setSelectionRange(0, 0);
  }

  async function reword(c, message) {
    const r = await invoke('reword', ide.root, c.hash, message);
    logResult(r);
    if (!r.ok) return notify(tr('Edit Commit Message failed'), errorText(r), 'error', !r.reason);
    afterRewrite(r.hash);
  }

  function branchHere(c) {
    const body = el('div', 'vcs-new-branch');
    const name = el('input', 'vcs-new-branch-name');
    name.spellcheck = false;
    const checkout = el('input');
    checkout.type = 'checkbox';
    checkout.checked = true;
    const box = el('label', 'vcs-new-branch-checkout');
    box.append(checkout, ' ', tr('Checkout branch'));
    body.append(el('div', null, tr('New branch name:')), name, box);
    ide.ui.dialog({
      title: tr('Create New Branch'), body, width: 420,
      buttons: [{ label: tr('Create'), primary: true, run: () => {
        const branch = name.value.trim().replace(/\s+/g, '-');
        if (!branch) { name.focus(); return false; }
        createBranch(c, branch, checkout.checked);
      } }, { label: tr('Cancel') }],
    });
  }

  async function createBranch(c, name, checkout) {
    if (checkout) await ide.saveAll();
    const r = await invoke('newBranch', ide.root, name, { at: c.hash, checkout });
    logResult(r);
    if (!r.ok) return notify(tr('Branch creation failed'), errorText(r), 'error', true);
    if (checkout) return afterRewrite(c.hash);
    if (gitTw.isVisible()) loadLog();
  }

  async function tagHere(c) {
    const name = (await ide.ui.prompt(tr('New tag name'), ''))?.trim().replace(/\s+/g, '-');
    if (!name) return;
    const r = await invoke('tag', ide.root, name, c.hash);
    logResult(r);
    if (!r.ok) return notify(tr('Tag creation failed'), errorText(r), 'error', !r.reason);
    if (gitTw.isVisible()) loadLog();
  }

  async function selectCommit(hash) {
    selectedCommit = hash;
    for (const r of logRows.querySelectorAll('.vcs-log-row')) r.classList.toggle('selected', r.dataset.hash === hash);
    logRows.querySelector('.vcs-log-row.selected')?.scrollIntoView({ block: 'nearest' });
    const entry = historyOf && commits.find((c) => c.hash === hash);
    const [d, sides] = await Promise.all([invoke('commitDetails', ide.root, hash), entry ? commitSides(entry.hash, entry) : null]);
    if (selectedCommit !== hash) return;
    details = d;
    closePreview();
    if (entry) showPreview(entry, sides);
    else filesEl.replaceChildren(el('div', 'vcs-side-title', trn(d.files.length, '{n} file changed', '{n} files changed')));
    for (const f of entry ? [] : d.files) {
      const row = el('div', 'vcs-file vcs-log-file');
      row.dataset.rel = f.rel;
      row.title = `${f.rel} — ${STATUS_LABEL[f.status] || f.status}`;
      const name = userText('span', 'vcs-name', basename(f.rel));
      name.style.color = COLORS[f.status];
      row.append(Object.assign(ide.fileIcon(f.rel), { className: 'file-icon icon' }), name, userText('span', 'muted vcs-dir', f.rel.includes('/') ? dirname(f.rel) : ''));
      row.onclick = () => { filesEl.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected')); row.classList.add('selected'); };
      row.ondblclick = () => openCommitDiff(d, f);
      filesEl.appendChild(row);
    }
    const who = userText('span', null, `${d.hash.slice(0, 8)} ${d.author} <${d.email}>`);
    const when = el('div', 'muted vcs-detail-meta');
    when.append(who, ' ', tr('on {date}', { date: new Date(d.time * 1000).toLocaleString(dateLocale) }));
    const parts = [userText('div', 'vcs-detail-msg', d.message), when];
    if (d.parents.length > 1) {
      // A merge: its parents are the branch it was made on and the branch(es) merged into it.
      const p = el('div', 'vcs-detail-parents');
      p.append(el('span', 'vcs-badge merge', tr('Merge')), ' ', tr('Parents:'), ' ');
      d.parents.forEach((h, i) => {
        const a = userText('a', 'vcs-hash-link', h.slice(0, 8));
        a.href = '#';
        a.onclick = (e) => { e.preventDefault(); showCommit(h); };
        p.append(...(i ? [', ', a] : [a]));
      });
      parts.push(p);
    }
    detailsEl.replaceChildren(...parts);
  }

  async function showCommit(hash) {
    gitTw.show();
    subTabs.switchTo('log');
    if (logSearch.value || authorSelect.value) { logSearch.value = ''; authorSelect.value = ''; }
    setHistoryOf(null);
    await loadLog();
    if (commits.some((c) => c.hash === hash)) await selectCommit(hash);
  }

  // ---------- Show History: the Log of one file ----------
  // PyCharm's Git › Show History: only the commits that changed the file, followed through renames, with the file's
  // change in the selected commit beside them, Show Diff (Enter) and Compare with Local. null lists every commit again.
  async function showHistory(path) {
    if (path && !repo) return notify(tr('Show History'), tr('This project is not under Git version control.'), 'warn');
    gitTw.show();
    subTabs.switchTo('log');
    if (logSearch.value || authorSelect.value) { logSearch.value = ''; authorSelect.value = ''; }
    selectedCommit = null;
    setHistoryOf(path);
    await loadLog();
    logRows.focus();
  }

  function setHistoryOf(path) {
    historyOf = path || null;
    if (!historyChip) return;
    logPane.classList.toggle('history', !!historyOf);
    historyChip.classList.toggle('hidden', !historyOf);
    if (!historyOf) { closePreview(); historyChip.replaceChildren(); return; }
    const all = el('button', 'vcs-log-path-close', '×');
    all.title = tr('Show All Commits');
    all.onclick = () => showHistory(null);
    historyChip.replaceChildren(el('span', 'muted', tr('Path:')), userText('span', 'vcs-log-path-name', ide.util.rel(historyOf)), all);
  }

  function showPreview(c, [left, right]) {
    filesEl.classList.add('vcs-history-preview');
    const title = el('div', 'vcs-side-title');
    title.append(userText('span', null, c.orig ? `${c.orig} → ${c.rel}` : c.rel));
    if (left.binary || right.binary) return filesEl.replaceChildren(title, el('div', 'vcs-history-binary muted', tr('Binary file')));
    const host = el('div', 'vcs-history-diff');
    filesEl.replaceChildren(title, host);
    disposePreview = mountDiff(host, {
      name: basename(c.rel), left, right, inline: true,
      leftTitle: tr('{hash}^ (parent)', { hash: c.short }), rightTitle: { user: `${c.short} — ${c.subject}` },
    });
  }

  function closePreview() {
    disposePreview?.();
    disposePreview = null;
    filesEl?.classList.remove('vcs-history-preview');
  }

  function showHistoryDiff(c) {
    openCommitDiff({ hash: c.hash, message: c.subject }, { path: historyOf, rel: c.rel, orig: c.orig, status: c.status });
  }

  async function compareWithLocal(c) {
    const path = historyOf;
    const id = `${path} [${tr('{hash} vs. Local', { hash: c.short })}]`;
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    const left = (await invoke('fileAt', ide.root, c.hash, c.rel, { binary: true })) ?? '';
    if (left.binary) return notifyBinary(c.rel);
    openLocalDiff({ id, path, left, leftTitle: { user: `${c.short} — ${c.subject}` } });
  }

  // ---------- Activity: git reflog as a timeline ----------
  // Reflog subjects git writes, most specific first. Each maps to a kind (badge in KIND_LABEL) and a sentence; the
  // {placeholders} are filled with git's own text (branch names, commit messages), which stays untranslated.
  const ACTIVITY = [
    { kind: 'commit', re: /^commit \(initial\): (.*)$/s, say: (m) => ['Initial commit: {message}', { message: m[1] }] },
    { kind: 'amend', re: /^commit \(amend\): (.*)$/s, say: (m) => ['Amended the last commit: {message}', { message: m[1] }] },
    { kind: 'amend', re: /^reword: (.*)$/s, say: (m) => ['Edited a commit message: {message}', { message: m[1] }] },
    { kind: 'merge', re: /^commit \(merge\): (.*)$/s, say: (m) => ['Committed a merge: {message}', { message: m[1] }] },
    { kind: 'commit', re: /^commit: (.*)$/s, say: (m) => ['Committed: {message}', { message: m[1] }] },
    { kind: 'merge', re: /^merge (.+?): (.*)$/s, say: (m) => ['Merged {branch} ({how})', { branch: m[1], how: m[2] }] },
    { kind: 'pull', re: /^pull(?: [^:]*)?: (.*)$/s, say: (m) => ['Pulled ({how})', { how: m[1] }] },
    { kind: 'checkout', re: /^checkout: moving from (.+) to (.+)$/, say: (m) => ['Switched from {from} to {to}', { from: m[1], to: m[2] }] },
    { kind: 'reset', re: /^reset: moving to (.+)$/, say: (m) => ['Reset to {target}', { target: m[1] }] },
    { kind: 'rebase', re: /^rebase(?: -i)? \(finish\): (?:returning to )?(.*)$/, say: (m) => ['Finished a rebase of {branch}', { branch: m[1].replace(/^refs\/heads\//, '') }] },
    { kind: 'rebase', re: /^rebase(?: -i)? \(abort\)/, say: () => ['Aborted a rebase', {}] },
    // The steps inside a rebase (start, pick, continue...) would flood the list; its finish line stands for them.
    { kind: 'rebase', re: /^rebase/, hidden: true },
    { kind: 'cherry-pick', re: /^cherry-pick: (.*)$/s, say: (m) => ['Cherry-picked: {message}', { message: m[1] }] },
    { kind: 'revert', re: /^revert: (.*)$/s, say: (m) => ['Reverted: {message}', { message: m[1] }] },
    { kind: 'clone', re: /^clone: (.*)$/s, say: (m) => ['Cloned {source}', { source: m[1].replace(/^from /, '') }] },
  ];
  // Literal keys so the i18n checks see every sentence.
  const SENTENCES = {
    'Initial commit: {message}': () => tr('Initial commit: {message}'),
    'Amended the last commit: {message}': () => tr('Amended the last commit: {message}'),
    'Edited a commit message: {message}': () => tr('Edited a commit message: {message}'),
    'Committed a merge: {message}': () => tr('Committed a merge: {message}'),
    'Committed: {message}': () => tr('Committed: {message}'),
    'Merged {branch} ({how})': () => tr('Merged {branch} ({how})'),
    'Pulled ({how})': () => tr('Pulled ({how})'),
    'Switched from {from} to {to}': () => tr('Switched from {from} to {to}'),
    'Reset to {target}': () => tr('Reset to {target}'),
    'Finished a rebase of {branch}': () => tr('Finished a rebase of {branch}'),
    'Aborted a rebase': () => tr('Aborted a rebase'),
    'Cherry-picked: {message}': () => tr('Cherry-picked: {message}'),
    'Reverted: {message}': () => tr('Reverted: {message}'),
    'Cloned {source}': () => tr('Cloned {source}'),
  };

  function classify(e) {
    for (const a of ACTIVITY) {
      const m = a.re.exec(e.action);
      if (m) return a.hidden ? null : { kind: a.kind, say: a.say(m) };
    }
    return { kind: 'other', say: null };
  }

  // The translated sentence with each {placeholder} as its own user-data span.
  function sentence([key, vars]) {
    const out = el('span', 'vcs-act-text');
    (SENTENCES[key] ? SENTENCES[key]() : key).split(/\{(\w+)\}/).forEach((part, i) => {
      if (i % 2) out.append(userText('span', 'vcs-act-value', vars[part] ?? ''));
      else if (part) out.append(part);
    });
    return out;
  }

  let activitySeq = 0;
  async function loadActivity() {
    if (!activityRows || !repo) return;
    const my = ++activitySeq;
    const list = await invoke('reflog', ide.root);
    if (my !== activitySeq) return;
    activity = list.map((e) => ({ ...e, ...classify(e) })).filter((e) => e.kind);
    renderActivity();
  }

  function dayLabel(t) {
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t * 1000).setHours(0, 0, 0, 0)) / 86400000);
    return days === 0 ? tr('Today') : days === 1 ? tr('Yesterday') : new Date(t * 1000).toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  }

  function renderActivity() {
    activityRows.replaceChildren();
    const kind = kindSelect.value;
    const shown = activity.filter((e) => !kind || e.kind === kind);
    if (!shown.length) activityRows.appendChild(el('div', 'vcs-empty muted', activity.length ? tr('No actions of this kind') : tr('No activity yet')));
    let day = null;
    for (const e of shown) {
      const label = dayLabel(e.time);
      if (label !== day) { activityRows.appendChild(el('div', 'vcs-act-day', label)); day = label; }
      const row = el('div', `vcs-act-row kind-${e.kind}`);
      row.dataset.kind = e.kind;
      row.dataset.hash = e.hash;
      const text = e.say ? sentence(e.say) : userText('span', 'vcs-act-text', e.action);
      const hash = userText('a', 'vcs-hash-link', e.short);
      hash.href = '#';
      hash.title = tr('Show in Log');
      const go = (ev) => { ev.preventDefault(); showCommit(e.hash); };
      hash.onclick = go;
      row.ondblclick = go;
      row.append(el('span', `vcs-badge ${e.kind}`, KIND_LABEL[e.kind]), text, hash, userText('span', 'vcs-act-who muted', e.who),
        el('span', 'vcs-act-time muted', new Date(e.time * 1000).toLocaleTimeString(dateLocale, { hour: 'numeric', minute: '2-digit' })));
      activityRows.appendChild(row);
    }
  }

  ide.on('toolWindowShown', (id) => id === 'Git' && loadLog());

  // ---------- update project / push ----------
  async function updateProject() {
    if (!repo) return notify(tr('Update Project'), tr('This project is not under Git version control.'), 'warn');
    await ide.saveAll();
    const r = await invoke('pull', ide.root);
    logResult(r);
    if (r.noRemote) return notify(tr("Can't update"), tr('No remotes are defined for this repository. Define a remote in {dialog}.', { dialog: ide.keymap.withKeys(tr('the Push dialog'), 'Vcs.Push') }), 'warn');
    if (!r.ok && r.conflicts?.length && conflictHandler) { await afterCheckout(); return conflictHandler.stopped(r); }
    if (!r.ok) return notify(tr('Update failed'), errorText(r), 'error', true);
    if (r.upToDate) notify(tr('All files are up-to-date'), '', 'ok');
    else notify(trn(r.updated.length, '{n} file updated', '{n} files updated'), r.updated.map((p) => ide.util.rel(p)).join('\n'), 'ok', true);
    headCache.clear();
    await reloadTabs(r.updated, false);
    ide.refreshTree();
    await refresh();
    if (gitTw.isVisible()) loadLog();
  }

  // lease: Force Push with the remote branch's commit that the Push Rejected dialog showed (git:push).
  async function doPush(lease) {
    const r = await invoke('push', ide.root, lease ? { lease } : {});
    logResult(r);
    if (r.noRemote) return notify(tr('Push failed'), tr('No remotes are defined for this repository.'), 'warn');
    if (!r.ok && r.lease && !lease) return pushRejected(r);
    if (!r.ok && lease && r.rejected === 'stale info') {
      return notify(tr('Push failed'), tr('Force Push was refused: {target} changed after the Push Rejected question. Update the project to get the new commits, then push again.', { target: r.target }), 'error');
    }
    if (!r.ok) return notify(tr('Push failed'), errorText(r), 'error', !r.reason);
    if (r.forced) notify(tr('Force pushed {branch} to {target}', { branch: repo?.branch || r.branch, target: r.target }), '', 'ok');
    else notify(r.pushed ? trn(r.pushed, 'Pushed {n} commit to {target}', 'Pushed {n} commits to {target}', { target: r.target }) : tr('Everything is up to date'), '', 'ok');
    await refresh();
    if (gitTw.isVisible()) loadLog();
  }

  // A push git refused as non-fast-forward, typically after Amend Commit and Push… on a pushed commit: PyCharm's Push
  // Rejected question, offering Force Push (--force-with-lease) and listing the commits it would remove.
  function pushRejected(r) {
    const body = el('div', 'vcs-push vcs-push-rejected');
    body.appendChild(el('div', 'dialog-message', tr('Push of current branch {branch} was rejected: {target} has commits that are not in your branch.', { branch: repo?.branch || r.branch, target: r.target })));
    if (r.dropped?.length) {
      body.appendChild(el('div', 'vcs-push-note', tr('Force Push replaces {target} with your branch and removes these commits from it:', { target: r.target })));
      const list = userText('div', 'vcs-dialog-list vcs-push-commits');
      for (const c of r.dropped) {
        const row = el('div', 'vcs-push-commit');
        row.append(el('span', 'muted', c.short), el('span', null, ` ${c.subject}`), el('span', 'muted', `  ${c.author}`));
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    body.appendChild(el('div', 'muted vcs-push-note', tr('Force Push is refused if {target} has changed since the last fetch.', { target: r.target })));
    let chosen = false;
    ide.ui.dialog({
      title: tr('Push Rejected'), body, width: 560,
      onClose: () => { if (!chosen) notify(tr('Push rejected'), r.err || r.out || '', 'warn', true); },
      buttons: [
        { label: tr('Force Push'), primary: true, run: async () => {
          chosen = true;
          if (isProtected(r.branch) && !(await ide.ui.confirm(tr('{branch} is a protected branch. Force pushing to it rewrites history that others may have built on. Force push to {target} anyway?', { branch: r.branch, target: r.target }),
            { title: tr('Force Push to Protected Branch'), ok: tr('Force Push') }))) {
            notify(tr('Push rejected'), tr('Force Push to the protected branch {branch} was canceled.', { branch: r.branch }), 'warn');
            return;
          }
          doPush(r.lease);
        } },
        { label: tr('Cancel') },
      ],
    });
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
    } else if (!o.branch) {
      // A detached HEAD has no branch to push (git:push refuses it as well).
      body.appendChild(el('div', 'vcs-push-warn', REASONS.detached));
    } else {
      const dest = o.upstream ? o.upstream.split('/').slice(1).join('/') : o.branch;
      const target = el('div', 'vcs-push-target');
      target.append(userText('span', null, `${o.branch} → ${o.remote} : ${dest}`));
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

  // ---------- shelf ----------
  // PyCharm's shelf. Shelve Changes… puts chosen files aside as a named patch (main/features/git.js keeps it outside
  // the repository) and rolls them back unless asked to keep them; the Commit window's Shelf tab lists the shelves and
  // unshelves all or some of their files, three-way merging where the files changed since.
  const SHELF_COLORS = { modified: COLORS.modified, renamed: COLORS.modified, added: COLORS.added, deleted: COLORS.deleted };
  const SHELF_STATUS_LABEL = { modified: tr('Modified'), added: tr('Added'), deleted: tr('Deleted'), renamed: tr('Renamed') };
  const removeApplied = () => ide.settings.get('vcs.shelf.removeApplied', true);
  const currentShelf = () => shelves.find((s) => s.id === shelfSel.id) || null;
  function checkbox(label, cls, checked, onchange) {
    const box = el('label', `vcs-check ${cls}`);
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    if (onchange) input.onchange = () => onchange(input.checked);
    box.append(input, el('span', null, label));
    return { box, input };
  }

  // Called from the Commit tool window's mount, which can run before this section: only DOM and hoisted functions.
  function buildShelfPane() {
    const pane = el('div', 'vcs-shelf hidden');
    const bar = el('div', 'vcs-shelf-bar');
    const btn = (label, cls, run) => { const b = el('button', `secondary ${cls}`, label); b.onclick = run; return b; };
    bar.append(
      btn(tr('Unshelve'), 'vcs-shelf-unshelve', () => unshelve(currentShelf(), shelfSel.rels.size ? [...shelfSel.rels] : null)),
      btn(tr('Rename…'), 'vcs-shelf-rename', () => renameShelf(currentShelf())),
      btn(tr('Delete…'), 'vcs-shelf-delete', () => deleteShelf(currentShelf())));
    const remove = checkbox(tr('Remove successfully applied files from the shelf'), 'vcs-shelf-remove',
      ide.settings.get('vcs.shelf.removeApplied', true), (on) => ide.settings.set('vcs.shelf.removeApplied', on));
    shelfList = el('div', 'vcs-shelf-list');
    shelfList.id = 'vcsShelfList';
    const isFile = (row) => row.dataset.rel != null;
    ide.ui.listKeys(shelfList, {
      rows: '.vcs-shelf-row, .vcs-shelf-file',
      select: (row) => selectShelfRow(row, false),
      open: (row) => (isFile(row) ? showShelfDiff(row.dataset.id, row.dataset.rel) : toggleShelf(row.dataset.id)),
      expanded: (row) => (isFile(row) ? null : shelfOpen.has(row.dataset.id)),
      toggle: (row) => toggleShelf(row.dataset.id),
    });
    shelfList.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && e.target === shelfList && currentShelf()) { e.preventDefault(); deleteShelf(currentShelf()); }
    });
    pane.append(bar, remove.box, shelfList);
    return pane;
  }

  function switchCommitTab(which) {
    const shelf = which === 'shelf';
    [...commitTabs.children].forEach((b) => b.classList.toggle('active', (b === shelfTabBtn) === shelf));
    changesPane.classList.toggle('hidden', shelf);
    shelfPane.classList.toggle('hidden', !shelf);
    if (shelf) loadShelves();
  }

  function showShelf() {
    if (!ide.root) return;
    commitTw.show();
    if (!repo) return notify(tr('Shelf'), tr('This project is not under Git version control.'), 'warn');
    switchCommitTab('shelf');
    shelfList.focus();
  }

  let shelfSeq = 0;
  async function loadShelves() {
    const root = ide.root;
    if (!root) return;
    const my = ++shelfSeq;
    const list = await invoke('shelves', root);
    if (my !== shelfSeq || root !== ide.root) return;
    shelves = list;
    if (!currentShelf()) { shelfSel.id = shelves[0]?.id || null; shelfSel.rels.clear(); }
    const shelf = currentShelf();
    for (const rel of [...shelfSel.rels]) if (!shelf?.files.some((f) => f.rel === rel)) shelfSel.rels.delete(rel);
    renderShelves();
  }

  function renderShelves() {
    if (!shelfList) return;
    const scroll = shelfList.scrollTop;
    shelfList.replaceChildren();
    if (!shelves.length) shelfList.appendChild(el('div', 'vcs-empty muted', tr('No shelved changes')));
    for (const s of shelves) {
      const open = shelfOpen.has(s.id);
      const row = el('div', 'vcs-shelf-row' + (s.id === shelfSel.id && !shelfSel.rels.size ? ' selected' : ''));
      Object.assign(row.dataset, { id: s.id, key: `s:${s.id}`, depth: '0' });
      const arrow = el('span', 'arrow', open ? '▾' : '▸');
      arrow.onclick = (e) => { e.stopPropagation(); toggleShelf(s.id); };
      row.append(arrow, userText('span', 'vcs-shelf-name', s.name), el('span', 'muted vcs-shelf-count', nFiles(s.files.length)),
        el('span', 'muted vcs-shelf-date', fmtDate(s.time / 1000)));
      row.onclick = () => selectShelfRow(row, false);
      row.ondblclick = () => toggleShelf(s.id);
      row.oncontextmenu = (e) => { e.preventDefault(); selectShelfRow(row, false); shelfMenu(e); };
      shelfList.appendChild(row);
      if (!open) continue;
      for (const f of s.files) {
        const fr = el('div', 'vcs-file vcs-shelf-file' + (s.id === shelfSel.id && shelfSel.rels.has(f.rel) ? ' selected' : ''));
        Object.assign(fr.dataset, { id: s.id, rel: f.rel, key: `f:${s.id}:${f.rel}`, depth: '1', status: f.status, path: f.path });
        const name = userText('span', 'vcs-name', basename(f.path));
        name.style.color = SHELF_COLORS[f.status] || COLORS.modified;
        const dir = dirname(f.path);
        fr.append(Object.assign(ide.fileIcon(f.path), { className: 'file-icon icon' }), name,
          userText('span', 'muted vcs-dir', samePath(dir, ide.root) ? '' : ide.util.rel(dir)));
        fr.title = `${f.orig ? `${f.orig} → ` : ''}${f.rel} — ${SHELF_STATUS_LABEL[f.status] || f.status}`;
        fr.onclick = (e) => selectShelfRow(fr, e.ctrlKey);
        fr.ondblclick = () => showShelfDiff(s.id, f.rel);
        fr.oncontextmenu = (e) => { e.preventDefault(); if (!fr.classList.contains('selected')) selectShelfRow(fr, false); shelfMenu(e); };
        shelfList.appendChild(fr);
      }
    }
    shelfList.scrollTop = scroll;
  }

  // A shelf row selects the shelf; file rows select files of one shelf (Ctrl adds or removes one).
  function selectShelfRow(row, ctrl) {
    const { id, rel } = row.dataset;
    if (rel == null || shelfSel.id !== id || !ctrl) shelfSel.rels.clear();
    shelfSel.id = id;
    if (rel != null) { if (ctrl && shelfSel.rels.has(rel)) shelfSel.rels.delete(rel); else shelfSel.rels.add(rel); }
    shelfList.focus();
    renderShelves();
  }

  function toggleShelf(id) {
    if (!shelfOpen.delete(id)) shelfOpen.add(id);
    renderShelves();
  }

  function shelfMenu(e) {
    const s = currentShelf();
    if (!s) return;
    const rels = [...shelfSel.rels];
    ide.ui.contextMenu(e.clientX, e.clientY, [
      { label: tr('Unshelve'), run: () => unshelve(s, null) },
      ...(rels.length ? [
        { label: tr('Unshelve Selected Files'), run: () => unshelve(s, rels) },
        { label: tr('Show Diff'), run: () => showShelfDiff(s.id, rels[0]) },
      ] : []),
      { separator: true },
      { label: tr('Rename…'), run: () => renameShelf(s) },
      { label: tr('Delete…'), run: () => deleteShelf(s) },
    ]);
  }

  async function openShelveDialog() {
    if (!repo) return notify(tr('Shelve Changes'), tr('This project is not under Git version control.'), 'warn');
    await ide.saveAll();
    await refresh();
    const files = repo.files.filter((f) => f.status !== 'conflict');
    if (!files.length) return notify(tr('Nothing to shelve'), tr('There are no local changes.'), 'warn');
    // As in PyCharm: the changes selected in the Commit window, else those ticked for commit.
    const sel = selectedFiles().filter((f) => f.status !== 'conflict');
    const chosen = new Set((sel.length ? sel : files.filter(fileIncluded)).map((f) => key(f.path)));
    const body = el('div', 'vcs-shelve');
    const nameField = el('label', 'field');
    const nameIn = el('input', 'vcs-shelve-name');
    nameIn.value = tr('Changes from {date}', { date: new Date().toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' }) });
    nameField.append(el('span', null, tr('Name')), nameIn);
    const all = checkbox(tr('Changes'), 'vcs-shelve-all', false);
    const count = el('span', 'muted vcs-shelve-count');
    all.box.appendChild(count);
    const list = el('div', 'vcs-dialog-list vcs-shelve-files');
    const boxes = files.map((f) => {
      const row = el('label', 'vcs-shelve-file');
      row.dataset.path = f.path;
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = chosen.has(key(f.path));
      cb.onchange = () => { if (cb.checked) chosen.add(key(f.path)); else chosen.delete(key(f.path)); sync(); };
      const name = userText('span', 'vcs-name', ide.util.rel(f.path));
      name.style.color = COLORS[f.status];
      row.title = STATUS_LABEL[f.status] || f.status;
      row.append(cb, Object.assign(ide.fileIcon(f.path), { className: 'file-icon icon' }), name);
      list.appendChild(row);
      return cb;
    });
    const sync = () => {
      all.input.checked = chosen.size === files.length;
      all.input.indeterminate = chosen.size > 0 && chosen.size < files.length;
      count.textContent = `${chosen.size} / ${files.length}`;
    };
    all.input.onchange = () => {
      files.forEach((f, i) => { boxes[i].checked = all.input.checked; if (all.input.checked) chosen.add(key(f.path)); else chosen.delete(key(f.path)); });
      sync();
    };
    sync();
    const keep = checkbox(tr('Keep changes in working tree'), 'vcs-shelve-keep', ide.settings.get('vcs.shelf.keep', false));
    body.append(nameField, all.box, list, keep.box);
    ide.ui.dialog({
      title: tr('Shelve Changes'), body, width: 560,
      buttons: [
        { label: tr('Shelve Changes'), primary: true, run: () => {
          const name = nameIn.value.trim();
          if (!name) { nameIn.focus(); return false; }
          const picked = files.filter((f) => chosen.has(key(f.path)));
          if (!picked.length) { notify(tr('No changes selected'), tr('Select the files to shelve.'), 'warn'); return false; }
          ide.settings.set('vcs.shelf.keep', keep.input.checked);
          shelveFiles(picked, name, keep.input.checked);
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  async function shelveFiles(files, name, keep) {
    const r = await invoke('shelve', ide.root, { name, paths: files.map((f) => f.path), keep });
    logResult(r);
    if (!r.ok) return notify(tr('Shelve failed'), errorText(r), 'error', !r.reason);
    for (const f of files) { selection.delete(key(f.path)); included.delete(key(f.path)); }
    if (r.reverted) await reloadTabs(r.paths, true);
    ide.refreshTree();
    await refresh();
    shelfSel.id = r.id;
    shelfSel.rels.clear();
    shelfOpen.add(r.id);
    commitTw.show();
    switchCommitTab('shelf');
    if (r.revertError) notify(tr('Changes were shelved but not rolled back'), r.revertError, 'warn', true);
    else notify(trn(r.files, 'Shelved {n} file: {name}', 'Shelved {n} files: {name}', { name: r.name }), '', 'ok');
  }

  // rels: the shelved files to apply (repo-relative), or null for the whole shelf.
  async function unshelve(s, rels) {
    if (!s || !repo) return;
    await ide.saveAll();
    const r = await invoke('unshelve', ide.root, s.id, { rels, remove: removeApplied() });
    logResult(r);
    await reloadTabs(r.paths || [], false);
    ide.refreshTree();
    await refresh();
    await loadShelves();
    if (!r.applied) return notify(tr('Unshelve failed'), errorText(r), 'error', !r.reason);
    if (r.failed.length) {
      notify(trn(r.failed.length, '{n} file could not be unshelved and stays on the shelf', '{n} files could not be unshelved and stay on the shelf'),
        r.failed.map((f) => `${f.rel}: ${f.err}`).join('\n'), 'error', true);
    }
    if (r.conflicts.length) {
      if (conflictHandler) conflictHandler.stopped({ ...r, theirs: tr('shelf {name}', { name: s.name }) });
      else notify(trn(r.conflicts.length, 'Unshelved with conflicts in {n} file', 'Unshelved with conflicts in {n} files'), r.conflicts.map((p) => ide.util.rel(p)).join('\n'), 'warn', true);
      // "Accept Yours" would otherwise lose the shelved change, so the shelf keeps it until the user deletes it there
      if (r.keptConflicts?.length) {
        notify(trn(r.keptConflicts.length, 'The file with conflicts stays on the shelf until you delete it', 'The {n} files with conflicts stay on the shelf until you delete them'),
          r.keptConflicts.join('\n'), 'info', true);
      }
    } else if (r.applied.length) {
      notify(trn(r.applied.length, 'Unshelved {n} file from {name}', 'Unshelved {n} files from {name}', { name: s.name }), '', 'ok');
    }
  }

  async function showShelfDiff(id, rel) {
    const s = shelves.find((x) => x.id === id);
    const f = s?.files.find((x) => x.rel === rel);
    if (!f) return;
    const r = await invoke('shelfDiff', ide.root, id, rel);
    if (!r.ok) return notify(tr('Cannot show the shelved change'), errorText(r), 'error', !r.reason);
    if (r.binary) return notify(tr('Binary file'), tr('{name} is a binary file; its shelved change cannot be shown as text.', { name: basename(f.path) }), 'warn');
    openTextDiff({
      id: `${f.path} [${s.name}]`, title: tr('{name} (shelved)', { name: basename(f.path) }), name: basename(f.path),
      left: r.before ?? '', right: r.after ?? '', leftTitle: tr('Before shelving'), rightTitle: { user: s.name },
    });
  }

  async function renameShelf(s) {
    if (!s) return;
    const name = (await ide.ui.prompt(tr('Shelf name'), s.name))?.trim();
    if (!name || name === s.name) return;
    const r = await invoke('shelfRename', ide.root, s.id, name);
    if (!r.ok) return notify(tr('Rename failed'), errorText(r), 'error', true);
    await loadShelves();
  }

  async function deleteShelf(s) {
    if (!s) return;
    if (!(await ide.ui.confirm(tr('Delete the shelf "{name}"? Its changes will be lost.', { name: s.name }), { title: tr('Delete Shelf'), ok: tr('Delete') }))) return;
    const r = await invoke('shelfDelete', ide.root, s.id);
    if (!r.ok) return notify(tr('Delete failed'), errorText(r), 'error', true);
    await loadShelves();
  }

  // ---------- actions ----------
  const commitFocused =() => !!listEl && listEl.closest('.tool').contains(document.activeElement) && document.activeElement !== msgEl;
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
    { id: 'Annotate', title: tr('Annotate with Git Blame'), run: () => toggleAnnotate() },
    { id: 'Git.Branches', title: tr('Branches…'), run: showBranches },
    { id: 'Git.Init', title: tr('Create Git Repository…'), run: createRepository },
    { id: 'Git.Log', title: tr('Show Git Log'), run: () => { if (historyOf) return showHistory(null); gitTw.show(); subTabs.switchTo(true); } },
    { id: 'Vcs.ShowTabbedFileHistory', title: tr('Show History'), when: () => ide.activeTab()?.kind === 'file', run: () => showHistory(ide.activeTab().path) },
    { id: 'Compare.SameVersion', title: tr('Show Diff with HEAD'), run: () => ide.activeTab()?.kind === 'file' && openWorkingDiff(ide.activeTab().path) },
    { id: 'ChangesView.Shelve', title: tr('Shelve Changes…'), run: () => openShelveDialog() },
    { id: 'Vcs.Show.Shelf', title: tr('Show Shelf'), run: showShelf },
  ].forEach(ide.registerAction);
  ide.registerTreeAction({ title: tr('Git: Show Diff'), when: (e) => !e.dir && byPath.has(key(e.path)), run: (e) => openWorkingDiff(e.path) });
  ide.registerTreeAction({ title: tr('Git: Show History'), when: (e) => !e.dir && !!repo && !isIgnored(e.path) && !['unversioned', 'added'].includes(byPath.get(key(e.path))?.status), run: (e) => showHistory(e.path) });
  ide.registerTreeAction({ title: tr('Git: Rollback…'), when: (e) => !e.dir && byPath.get(key(e.path))?.status !== 'unversioned' && byPath.has(key(e.path)), run: (e) => rollbackFiles([byPath.get(key(e.path))]) });

  ide.vcs = {
    invoke, notify, logResult, errorText, userText, trn, nFiles, refresh, showConsole, openTextDiff, diffLines,
    repo: () => repo,
    // Output of another tool's long command (the github plugin's gh) as it arrives; kind: 'cmd' | 'sys' | 'err'.
    appendConsole: (text, kind) => gitConsole?.append(text, kind),
    // Reloads editors and the log after git moved HEAD or rewrote files (unsaved edits were saved beforehand).
    reload: afterCheckout,
    showCommit, showHistory,
    addBranchActions: (fn) => branchActions.push(fn),
    addLogActions: (fn) => logActions.push(fn),
    addCommitHeader: (fn) => { commitHeaders.push(fn); renderChanges(); },
    // The commit message box, the changes ticked for commit, and a button shown in the box's top right corner.
    commitMessage: () => msgEl,
    includedFiles: () => (repo ? repo.files.filter(fileIncluded) : []),
    addMessageAction: (node) => msgActions.appendChild(node),
    // Commit checks: a control after the Commit buttons, and a hook run before every commit (Commit and Commit and
    // Push) once the files and message are valid; returning false stops it. Files a hook rewrites must be saved.
    addCommitOption: (node) => commitOpts.appendChild(node),
    addBeforeCommit: (fn) => beforeCommit.push(fn),
    committing: () => committing,
    // Auto-fetch (vcs.autoFetchMinutes): {failures, attempts, lastFetch, lastError, nextDelay, running}, and fetch now.
    autoFetch: { state: () => ({ ...fetchState, timer: undefined }), now: () => runAutoFetch(true) },
    // {open(path): merge tool for one file, resolve(): the conflicts dialog, stopped(result): after a pull stopped on conflicts}
    setConflictHandler: (handler) => { conflictHandler = handler; renderChanges(); },
  };

  // ---------- events ----------
  // A new project, or none: nothing of the previous repository stays (state, widgets, timers).
  function forgetRepository() {
    repo = null;
    noRepo = null;
    lastHead = undefined;
    lastBranch = undefined;
    shelves = [];
    shelfOpen.clear();
    shelfSel.id = null;
    shelfSel.rels.clear();
    if (shelfShown()) loadShelves();
    byPath.clear();
    included.clear();
    selection.clear();
    groupRows.clear();
    headCache.clear();
    gutters.clear();
    blames.clear();
    rebuildBlameCss();
    commits = [];
    setHistoryOf(null);
    if (msgEl) msgEl.value = '';
    if (amendInput) amendInput.checked = false;
    amendSaved = null;
  }
  ide.on('projectOpened', () => {
    forgetRepository();
    refresh();
    restartAutoFetch();
  });
  // Back on the welcome screen: no branch widget, ↓↑ counts, changes or log of the closed project, and no auto-fetch.
  ide.on('projectClosed', () => {
    refreshSeq++;
    forgetRepository();
    setRepoKey(false);
    renderWidget();
    renderChanges();
    loadLog();
    restartAutoFetch();
  });
  ide.on('fileSaved', (tab) => {
    scheduleRefresh();
    if (blames.has(key(tab.path))) annotate(tab);
  });
  ide.on('filesChanged', () => scheduleRefresh());
  // overview-ruler marks carry concrete colors; recolor them for the new theme
  ide.on('themeChanged', () => setTimeout(updateVisibleGutters));
  ide.on('activeTabChanged', (tab) => { updateGutter(tab); layoutAnnotations(); });
  ide.on('fileClosed', (path) => { gutters.delete(key(path)); headCache.delete(key(path)); if (blames.delete(key(path))) rebuildBlameCss(); });
  window.addEventListener('focus', () => scheduleRefresh(50));
})();
