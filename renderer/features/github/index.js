// GitHub through the GitHub CLI (gh): Git › GitHub › Share Project on GitHub… and the Pull Requests tool window, as in
// PyCharm. The main side is main/features/github.js; Git output goes to the vcs plugin's Git console.
(() => {
  const { el, basename } = ide.util;
  const vcs = ide.vcs;
  const invoke = (ch, ...args) => ide.api.invoke(`github:${ch}`, ...args);
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };
  const dateLocale = i18n.locale === 'ko' ? 'ko-KR' : 'en-US';
  const CLI_URL = 'https://cli.github.com/';

  // Reasons main composes; anything else is gh's or git's own text.
  const REASONS = {
    untrusted: tr('GitHub features are off in Safe Mode. Trust the project to use them.'),
    missing: tr('GitHub CLI (gh) is not installed.'),
    notRepo: tr('Not a Git repository'),
    noCommits: tr('The project has no commits yet.'),
    badName: tr('Repository names may use letters, digits, ".", "-" and "_".'),
    badRemote: tr('Enter a remote name such as origin.'),
    badNumber: tr('Not a pull request number.'),
    badInput: tr('This file cannot be compared.'),
    badOutput: tr('GitHub CLI returned output Nano Studio cannot read. Update the GitHub CLI.'),
    headMissing: tr("The pull request's commits are not in the local repository. Use Checkout to get them."),
  };
  const errorText = (r) => (r.reason === 'remoteExists' ? tr('A remote named {name} already exists.', { name: r.remote })
    : r.reason === 'alreadyShared' ? tr('The project is already on GitHub: {url}', { url: r.url })
      : r.reason === 'baseMissing' ? tr('The base branch {branch} is not in the local repository.', { branch: r.base })
        : (r.reason && REASONS[r.reason]) || (r.err || r.out || '').trim());

  // ---------- gh output in the Git console ----------
  let opSeq = 0;
  const ops = new Map();
  ide.api.on('github:output', ({ op, cmd, text }) => {
    if (!ops.has(op)) return;
    if (cmd) vcs.appendConsole(`${new Date().toLocaleTimeString()}: ${cmd}\n`, 'cmd');
    else vcs.appendConsole(text);
  });
  async function streamed(channel, ...args) {
    const op = `gh-${Date.now()}-${++opSeq}`;
    ops.set(op, true);
    vcs.showConsole();
    try {
      return await invoke(channel, ...args, op);
    } finally {
      ops.delete(op);
    }
  }

  // ---------- gh and its login ----------
  let status = null; // github:status of the open project

  // Resolves the login state, or null after telling the user what is missing.
  async function readyGh(title) {
    if (ide.trusted === false) { vcs.notify(title, REASONS.untrusted, 'warn'); return null; }
    status = await invoke('status', ide.root);
    if (!status.trusted) { vcs.notify(title, REASONS.untrusted, 'warn'); return null; }
    if (status.installed && status.loggedIn) return status;
    const body = el('div', 'gh-setup-dialog');
    setupHelp(body, status, () => dlg.close());
    const dlg = ide.ui.dialog({ title, body, width: 520, buttons: [{ label: tr('Close'), primary: true }] });
    return null;
  }

  // How to install gh or log in, with buttons that do it. close() runs before a button leaves the page.
  function setupHelp(host, st, close = () => {}) {
    const btns = el('div', 'gh-setup-buttons');
    const button = (label, cls, run) => { const b = el('button', cls, label); b.onclick = () => { close(); run(); }; btns.appendChild(b); return b; };
    if (!st.installed) {
      host.append(el('div', 'gh-setup-title', REASONS.missing),
        el('div', 'gh-setup-text', tr('Nano Studio uses the GitHub CLI to share projects and list pull requests. Install it, then click Refresh.')));
      if (st.error) host.append(userText('pre', 'gh-setup-out', st.error));
      if (ide.installer) button(tr('Install GitHub CLI…'), 'primary gh-install', () => ide.installer.open('system'));
      button('cli.github.com', 'secondary gh-cli-link', () => invoke('openUrl', CLI_URL));
    } else {
      host.append(el('div', 'gh-setup-title', tr('You are not logged in to the GitHub CLI.')),
        el('div', 'gh-setup-text', tr('Run gh auth login in the Terminal and follow its steps, then click Refresh.')));
      if (st.authText) host.append(userText('pre', 'gh-setup-out', st.authText));
      if (ide.terminal) {
        button(tr('Log In in Terminal'), 'primary gh-login', () => ide.terminal.open({
          name: 'GitHub CLI', shell: 'powershell', command: `& '${st.path.replace(/'/g, "''")}' auth login`,
        }));
      }
    }
    host.appendChild(btns);
    return btns;
  }

  // ---------- Share Project on GitHub ----------
  const repoNameOf = (dir) => basename(dir).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

  async function shareProject() {
    if (!ide.root) return;
    const title = tr('Share Project on GitHub');
    const st = await readyGh(title);
    if (!st) return;
    const repo = await invoke('repo', ide.root);
    if (repo.github) return vcs.notify(tr('The project is already on GitHub'), repo.github.web, 'info', true);
    if (!repo.isRepo || !repo.head) return offerInitialCommit(repo);
    shareDialog(repo, st);
  }

  // gh pushes the current branch, so a project without commits makes its first commit through the Commit tool window.
  function offerInitialCommit(repo) {
    ide.ui.dialog({
      title: tr('Share Project on GitHub'), width: 500,
      body: tr('The project has no commits yet. Make the initial commit, then share the project on GitHub.'),
      buttons: [
        { label: tr('Commit…'), primary: true, run: async () => {
          if (!repo.isRepo) {
            const r = await vcs.invoke('init', ide.root);
            vcs.logResult(r);
            if (!r.ok) return vcs.notify(tr('Git init failed'), vcs.errorText(r), 'error', true);
            await vcs.refresh();
          }
          ide.runAction('CheckinProject');
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  function shareDialog(repo, st) {
    const body = el('div', 'gh-share');
    const field = (label, input) => { const f = el('label', 'field'); f.append(el('span', null, label), input); return f; };
    const nameIn = el('input', 'gh-share-name');
    nameIn.value = repoNameOf(ide.root);
    const privBox = el('label', 'gh-checkbox gh-share-private');
    const privIn = el('input');
    privIn.type = 'checkbox';
    privIn.checked = true;
    privBox.append(privIn, el('span', null, tr('Private')));
    const descIn = el('input', 'gh-share-description');
    const remoteIn = el('input', 'gh-share-remote');
    remoteIn.value = repo.remotes.some((r) => r.name === 'origin') ? 'github' : 'origin';
    const error = el('div', 'gh-share-error');
    const account = el('div', 'muted gh-share-account');
    if (st.account) account.append(tr('Account:'), ' ', userText('span', null, st.account));
    body.append(field(tr('Repository name'), nameIn), privBox, field(tr('Remote'), remoteIn), field(tr('Description'), descIn), account, error);
    ide.ui.dialog({
      title: tr('Share Project on GitHub'), body, width: 520,
      buttons: [
        { label: tr('Share'), primary: true, run: () => {
          const name = nameIn.value.trim();
          const remote = remoteIn.value.trim();
          if (!/^(?:[A-Za-z0-9][A-Za-z0-9-]*\/)?[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(name)) { error.textContent = REASONS.badName; nameIn.focus(); return false; }
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) { error.textContent = REASONS.badRemote; remoteIn.focus(); return false; }
          if (repo.remotes.some((r) => r.name === remote)) { error.textContent = tr('A remote named {name} already exists.', { name: remote }); remoteIn.focus(); return false; }
          runShare({ name, private: privIn.checked, description: descIn.value.trim(), remote });
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  async function runShare(opts) {
    const note = vcs.notify(tr('Sharing {name} on GitHub…', { name: opts.name }), '', 'info');
    const r = await streamed('share', ide.root, opts);
    note.remove();
    if (!r.ok) return vcs.notify(tr('Cannot share the project on GitHub'), errorText(r), 'error', !r.reason);
    vcs.notify(tr('Shared the project on GitHub'), r.url || '', 'ok', true);
    await vcs.refresh();
    if (tw.isVisible()) load();
  }

  // ---------- Pull Requests tool window ----------
  const FILTERS = { open: tr('Open pull requests'), closed: tr('Closed pull requests'), mine: tr('Your pull requests') };
  const REVIEW = { APPROVED: tr('Approved'), CHANGES_REQUESTED: tr('Changes requested'), REVIEW_REQUIRED: tr('Review required') };
  const STATE = { CLOSED: tr('Closed'), MERGED: tr('Merged') };
  const REVIEW_STATE = { APPROVED: tr('Approved'), CHANGES_REQUESTED: tr('Changes requested'), COMMENTED: tr('Commented'), DISMISSED: tr('Dismissed'), PENDING: tr('Pending') };
  const CHECK = { success: tr('Passed'), failure: tr('Failed'), pending: tr('Pending'), skipped: tr('Skipped') };
  let stateEl, barEl, filterEl, accountEl, listEl, detailsEl;
  let filter = 'open';
  let remote = null; // the GitHub remote of the project
  let prs = [];
  let selected = null;
  let current = null; // gh pr view of the selected pull request
  let loadSeq = 0;
  let viewSeq = 0;

  const tw = ide.registerToolWindow({
    id: 'PullRequests', title: tr('Pull Requests'), icon: '⇅', iconName: 'pullRequests', side: 'left', order: 40,
    mount(container, w) {
      container.classList.add('gh-tool');
      stateEl = el('div', 'gh-state hidden');
      barEl = el('div', 'gh-bar hidden');
      filterEl = el('select', 'gh-filter');
      filterEl.id = 'ghFilter';
      for (const [k, label] of Object.entries(FILTERS)) filterEl.add(new Option(label, k));
      filterEl.onchange = () => { filter = filterEl.value; loadList(); };
      accountEl = userText('span', 'gh-account muted');
      barEl.append(filterEl, el('span', 'gh-spacer'), accountEl);
      listEl = el('div', 'gh-list hidden');
      ide.ui.listKeys(listEl, { rows: '.gh-pr', select: (row) => selectPr(Number(row.dataset.number)), open: (row) => selectPr(Number(row.dataset.number)), id: (row) => row.dataset.number });
      detailsEl = el('div', 'gh-details hidden');
      container.append(stateEl, barEl, listEl, detailsEl);
      w.setActions([{ icon: 'refresh', title: tr('Refresh'), id: 'gh-refresh', run: () => load() }]);
    },
  });

  function showState(build) {
    stateEl.replaceChildren();
    build(stateEl);
    stateEl.classList.remove('hidden');
    for (const n of [barEl, listEl, detailsEl]) n.classList.add('hidden');
  }
  const message = (text, cls = '') => (host) => host.appendChild(el('div', `gh-state-text ${cls}`, text));

  async function load() {
    const my = ++loadSeq;
    if (!ide.root) return showState(message(tr('No project')));
    // Safe Mode: gh would read the project's git configuration, so nothing runs.
    if (ide.trusted === false) return showState(message(REASONS.untrusted, 'gh-untrusted'));
    if (!status) showState(message(tr('Loading…')));
    const st = await invoke('status', ide.root);
    if (my !== loadSeq) return;
    status = st;
    if (!st.trusted) return showState(message(REASONS.untrusted, 'gh-untrusted'));
    if (!st.installed || !st.loggedIn) return showState((host) => { host.classList.add(st.installed ? 'gh-logged-out' : 'gh-missing'); setupHelp(host, st); refreshButton(host); });
    const repo = await invoke('repo', ide.root);
    if (my !== loadSeq) return;
    remote = repo.github;
    if (!remote) {
      return showState((host) => {
        host.classList.add('gh-no-remote');
        host.append(el('div', 'gh-setup-title', repo.isRepo ? tr('This project has no GitHub remote.') : REASONS.notRepo),
          el('div', 'gh-setup-text', tr('Share the project on GitHub to create a repository for it and see its pull requests here.')));
        const b = el('button', 'primary gh-share-btn', tr('Share Project on GitHub…'));
        b.onclick = shareProject;
        host.appendChild(b);
      });
    }
    accountEl.textContent = st.account ? `${remote.owner}/${remote.repo} · ${st.account}` : `${remote.owner}/${remote.repo}`;
    await loadList();
  }

  function refreshButton(host) {
    const b = el('button', 'secondary gh-refresh-btn', tr('Refresh'));
    b.onclick = () => load();
    (host.querySelector('.gh-setup-buttons') || host).appendChild(b);
  }

  async function loadList() {
    const my = ++loadSeq;
    stateEl.classList.add('hidden');
    barEl.classList.remove('hidden');
    listEl.classList.remove('hidden');
    listEl.replaceChildren(el('div', 'gh-empty muted', tr('Loading…')));
    const r = await invoke('prList', ide.root, filter);
    if (my !== loadSeq) return;
    if (!r.ok) {
      prs = [];
      listEl.replaceChildren(el('div', 'gh-empty gh-error', tr('Cannot load pull requests')), userText('pre', 'gh-setup-out', errorText(r)));
      return;
    }
    prs = r.prs;
    renderList();
    if (selected != null && prs.some((p) => p.number === selected)) selectPr(selected);
    else { selected = null; current = null; detailsEl.classList.add('hidden'); }
  }

  const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const login = (a) => a?.login || a?.name || '';
  const badge = (text, cls) => el('span', `gh-badge ${cls}`, text);

  function renderList() {
    listEl.replaceChildren();
    if (!prs.length) listEl.appendChild(el('div', 'gh-empty muted', tr('No pull requests')));
    for (const p of prs) {
      const row = el('div', 'gh-pr' + (p.number === selected ? ' selected' : ''));
      row.dataset.number = p.number;
      const top = el('div', 'gh-pr-top');
      top.append(userText('span', 'gh-pr-title', p.title), userText('span', 'gh-pr-number muted', `#${p.number}`));
      const meta = el('div', 'gh-pr-meta muted');
      meta.append(userText('span', 'gh-pr-author', login(p.author)), userText('span', 'gh-pr-branch', `${p.headRefName} → ${p.baseRefName}`), el('span', 'gh-pr-time', fmtTime(p.updatedAt)));
      if (p.isDraft) top.appendChild(badge(tr('Draft'), 'draft'));
      if (STATE[p.state]) top.appendChild(badge(STATE[p.state], p.state.toLowerCase()));
      if (p.reviewDecision && REVIEW[p.reviewDecision]) top.appendChild(badge(REVIEW[p.reviewDecision], p.reviewDecision.toLowerCase()));
      row.append(top, meta);
      row.onclick = () => { selectPr(p.number); listEl.focus(); };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        selectPr(p.number);
        ide.ui.contextMenu(e.clientX, e.clientY, [
          { label: tr('Open in Browser'), run: () => openInBrowser(p.number) },
          { label: tr('Checkout'), run: () => checkoutPr(p.number) },
        ]);
      };
      listEl.appendChild(row);
    }
  }

  async function selectPr(number) {
    selected = number;
    for (const r of listEl.querySelectorAll('.gh-pr')) r.classList.toggle('selected', Number(r.dataset.number) === number);
    listEl.querySelector('.gh-pr.selected')?.scrollIntoView({ block: 'nearest' });
    const my = ++viewSeq;
    detailsEl.classList.remove('hidden');
    if (current?.number !== number) detailsEl.replaceChildren(el('div', 'gh-empty muted', tr('Loading…')));
    const r = await invoke('prView', ide.root, number);
    if (my !== viewSeq) return;
    if (!r.ok) { current = null; detailsEl.replaceChildren(el('div', 'gh-empty gh-error', tr('Cannot load the pull request')), userText('pre', 'gh-setup-out', errorText(r))); return; }
    current = { ...r.pr, number: r.pr.number ?? number };
    renderDetails(current);
  }

  // A section with a title and a count; rows are appended to the returned element.
  function section(title, count, cls) {
    const s = el('div', `gh-section ${cls}`);
    const head = el('div', 'gh-section-title', title);
    if (count != null) head.append(' ', el('span', 'muted', String(count)));
    s.appendChild(head);
    detailsEl.appendChild(s);
    return s;
  }

  // gh's statusCheckRollup holds check runs (GitHub Actions and apps) and commit statuses.
  function checkState(c) {
    if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
      const s = String(c.state || '').toUpperCase();
      return s === 'SUCCESS' ? 'success' : s === 'FAILURE' || s === 'ERROR' ? 'failure' : 'pending';
    }
    if (String(c.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
    const k = String(c.conclusion || '').toUpperCase();
    return k === 'SUCCESS' ? 'success' : k === 'NEUTRAL' || k === 'SKIPPED' ? 'skipped' : 'failure';
  }

  function renderDetails(pr) {
    detailsEl.replaceChildren();
    const head = el('div', 'gh-head');
    const title = el('div', 'gh-head-title');
    title.append(userText('span', 'gh-detail-title', pr.title), userText('span', 'gh-pr-number muted', ` #${pr.number}`));
    const meta = el('div', 'gh-head-meta');
    if (pr.isDraft && pr.state === 'OPEN') meta.appendChild(badge(tr('Draft'), 'draft'));
    else if (STATE[pr.state]) meta.appendChild(badge(STATE[pr.state], String(pr.state).toLowerCase()));
    // "{author} wants to merge {head} into {base}" with each name kept as user data.
    const sentence = el('span', 'gh-head-sentence');
    const vars = { author: login(pr.author), head: pr.headRefName || '', base: pr.baseRefName || '' };
    tr('{author} wants to merge {head} into {base}').split(/\{(\w+)\}/).forEach((part, i) => {
      if (i % 2) sentence.append(userText('span', `gh-ref gh-ref-${part}`, vars[part] ?? ''));
      else if (part) sentence.append(part);
    });
    meta.appendChild(sentence);
    const btns = el('div', 'gh-head-buttons');
    const browser = el('button', 'secondary gh-open-browser', tr('Open in Browser'));
    browser.onclick = () => openInBrowser(pr.number);
    const checkout = el('button', 'secondary gh-checkout', tr('Checkout'));
    checkout.onclick = () => checkoutPr(pr.number);
    btns.append(browser, checkout);
    head.append(title, meta, btns);
    detailsEl.appendChild(head);

    // The description is Markdown from the pull request's author: shown as text, never as markup.
    const desc = section(tr('Description'), null, 'gh-description');
    desc.appendChild(pr.body?.trim() ? userText('div', 'gh-body', pr.body) : el('div', 'muted', tr('No description provided.')));

    const files = pr.files || [];
    const fs = section(tr('Files changed'), files.length, 'gh-files');
    for (const f of files) {
      const row = el('div', 'gh-file');
      row.dataset.path = f.path;
      row.title = f.path;
      row.dataset.userText = ''; // the path and line counts are user data
      const stat = el('span', 'gh-file-stat');
      stat.append(el('span', 'gh-add', `+${f.additions ?? 0}`), ' ', el('span', 'gh-del', `−${f.deletions ?? 0}`));
      row.append(Object.assign(ide.fileIcon(f.path), { className: 'file-icon icon' }), userText('span', 'gh-file-name', basename(f.path)),
        userText('span', 'gh-file-dir muted', f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''), stat);
      row.onclick = () => openFileDiff(pr, f);
      fs.appendChild(row);
    }

    const checks = pr.statusCheckRollup || [];
    const cs = section(tr('Checks'), null, 'gh-checks');
    if (!checks.length) cs.appendChild(el('div', 'muted', tr('No checks')));
    else {
      const counts = {};
      for (const c of checks) { const s = checkState(c); counts[s] = (counts[s] || 0) + 1; }
      const summary = el('div', 'gh-check-summary');
      for (const s of ['failure', 'pending', 'success', 'skipped']) if (counts[s]) summary.appendChild(badge(`${CHECK[s]} ${counts[s]}`, `check-${s}`));
      cs.appendChild(summary);
      for (const c of checks) {
        const s = checkState(c);
        const row = el('div', `gh-check check-${s}`);
        row.dataset.state = s;
        row.append(badge(CHECK[s], `check-${s}`), userText('span', 'gh-check-name', [c.workflowName, c.name || c.context].filter(Boolean).join(' / ')));
        const url = c.detailsUrl || c.targetUrl;
        if (url) {
          const a = el('a', 'gh-link', tr('Details'));
          a.href = '#';
          a.onclick = (e) => { e.preventDefault(); invoke('openUrl', url); };
          row.appendChild(a);
        }
        cs.appendChild(row);
      }
    }

    const commits = pr.commits || [];
    const cm = section(tr('Commits'), commits.length, 'gh-commits');
    for (const c of commits) {
      const row = el('div', 'gh-commit');
      row.append(userText('span', 'gh-oid muted', String(c.oid || '').slice(0, 7)), userText('span', 'gh-commit-msg', c.messageHeadline || ''),
        userText('span', 'gh-commit-author muted', (c.authors || []).map(login).filter(Boolean).join(', ')));
      cm.appendChild(row);
    }

    const reviews = (pr.reviews || []).filter((r) => r.state !== 'PENDING' || r.body);
    const rv = section(tr('Reviews'), reviews.length, 'gh-reviews');
    if (!reviews.length) rv.appendChild(el('div', 'muted', tr('No reviews')));
    for (const r of reviews) rv.appendChild(comment(r.author, r.submittedAt, r.body, badge(REVIEW_STATE[r.state] || r.state, `review-${String(r.state).toLowerCase()}`), 'gh-review'));

    const comments = pr.comments || [];
    const co = section(tr('Comments'), comments.length, 'gh-comments');
    if (!comments.length) co.appendChild(el('div', 'muted', tr('No comments')));
    for (const c of comments) co.appendChild(comment(c.author, c.createdAt, c.body, null, 'gh-comment'));
  }

  function comment(author, time, body, mark, cls) {
    const box = el('div', cls);
    const top = el('div', 'gh-comment-top');
    top.append(userText('span', 'gh-comment-author', login(author)));
    if (mark) top.append(mark);
    top.append(el('span', 'muted gh-comment-time', time ? fmtTime(time) : ''));
    box.append(top);
    if (body?.trim()) box.append(userText('div', 'gh-body', body));
    return box;
  }

  async function openFileDiff(pr, f) {
    for (const r of detailsEl.querySelectorAll('.gh-file')) r.classList.toggle('selected', r.dataset.path === f.path);
    if (!pr.headRefOid) return vcs.notify(tr('Cannot show the diff'), REASONS.headMissing, 'warn');
    const r = await invoke('fileDiff', ide.root, { base: pr.baseRefName, head: pr.headRefOid, file: f.path, remote: remote?.name });
    if (!r.ok) return vcs.notify(tr('Cannot show the diff'), errorText(r), 'warn', !r.reason);
    vcs.openTextDiff({
      id: `${f.path} [#${pr.number}]`, title: `${basename(f.path)} (#${pr.number})`, name: basename(f.path),
      left: r.left ?? '', right: r.right ?? '',
      leftTitle: { user: `${pr.baseRefName} (${r.base.slice(0, 7)})` },
      rightTitle: { user: `${pr.headRefName} (${pr.headRefOid.slice(0, 7)})` },
    });
  }

  async function openInBrowser(number) {
    const pr = current?.number === number ? current : null;
    const url = pr?.url || (remote ? `https://github.com/${remote.owner}/${remote.repo}/pull/${number}` : null);
    if (url) await invoke('openUrl', url);
  }

  // Only on this explicit action: gh fetches the pull request's branch and switches to it.
  async function checkoutPr(number) {
    if (ide.trusted === false) return vcs.notify(tr('Checkout failed'), REASONS.untrusted, 'warn');
    await ide.saveAll();
    await ide.localHistory?.checkpoint('Before Checkout');
    const r = await streamed('checkout', ide.root, number);
    if (!r.ok) return vcs.notify(tr('Checkout failed'), errorText(r), 'error', !r.reason);
    vcs.notify(tr('Checked out pull request #{n}', { n: number }), '', 'ok');
    await vcs.reload();
  }

  // ---------- actions and events ----------
  ide.registerAction({ id: 'Github.Share.Project', title: tr('Share Project on GitHub…'), run: shareProject });
  ide.registerAction({ id: 'Github.View.Pull.Request', title: tr('View Pull Requests'), run: () => { tw.show(); load(); } });

  ide.on('toolWindowShown', (id) => id === 'PullRequests' && load());
  // Another project, or none: closing shows "No project" instead of the closed project's pull requests (gh runs only
  // while the tool window is shown, and never without a project).
  const forget = () => {
    status = null;
    remote = null;
    prs = [];
    selected = null;
    current = null;
    if (stateEl && (tw.isVisible() || !ide.root)) load();
  };
  ide.on('projectOpened', forget);
  ide.on('projectClosed', forget);

  ide.github = { share: shareProject, load, status: () => status };
})();
