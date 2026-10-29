// Terminal tool window: real PTY sessions rendered with xterm.js, in tabs, plus the Claude Code launcher.
(() => {
  const { el, basename, dirname, joinPath, samePath, isUnder } = ide.util;
  const XTERM = '../node_modules/@xterm';
  const LOAD_ENV_FILE = 'terminal.loadEnvFile';
  const SHELL = 'terminal.shell';

  // xterm ships UMD bundles; with Monaco's AMD loader present they would register as AMD modules instead of globals.
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const amd = window.define?.amd;
      if (amd) window.define.amd = undefined;
      const s = el('script');
      s.src = src;
      s.onload = () => { if (amd) window.define.amd = amd; resolve(); };
      s.onerror = () => { if (amd) window.define.amd = amd; reject(new Error(`failed to load ${src}`)); };
      document.head.appendChild(s);
    });
  }
  const css = el('link');
  css.rel = 'stylesheet';
  css.href = `${XTERM}/xterm/css/xterm.css`;
  document.head.appendChild(css);
  const ready = (async () => {
    await loadScript(`${XTERM}/xterm/lib/xterm.js`);
    // One at a time: each load hides define.amd only for its own duration.
    for (const a of ['fit', 'web-links', 'search', 'unicode11']) await loadScript(`${XTERM}/addon-${a}/lib/addon-${a}.js`);
  })();

  // ANSI palettes: PyCharm's terminal colors for Darcula / Light.
  const PALETTE = {
    dark: { black: '#1e1f22', red: '#f0524f', green: '#5c962c', yellow: '#a68a0d', blue: '#3993d4', magenta: '#a771bf', cyan: '#00a3a3',
      white: '#bcbec4', brightBlack: '#595b5d', brightRed: '#ff4050', brightGreen: '#4fc414', brightYellow: '#e5bf00', brightBlue: '#1fb0ff',
      brightMagenta: '#ed7eed', brightCyan: '#00e5e5', brightWhite: '#ffffff' },
    light: { black: '#000000', red: '#c91b00', green: '#00a600', yellow: '#c7c400', blue: '#0225c7', magenta: '#c930c7', cyan: '#00c5c7',
      white: '#c7c7c7', brightBlack: '#686868', brightRed: '#ff6e67', brightGreen: '#3ac93a', brightYellow: '#b39d00', brightBlue: '#6871ff',
      brightMagenta: '#ff77ff', brightCyan: '#3bbfbf', brightWhite: '#7e7e7e' },
  };
  function theme() {
    const v = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const light = document.documentElement.dataset.theme === 'light';
    return { ...PALETTE[light ? 'light' : 'dark'], background: v('--gray1'), foreground: v('--text'), cursor: v('--gray11'),
      cursorAccent: v('--gray1'), selectionBackground: light ? '#a6d2ff' : '#214283' };
  }
  const fontSize = () => Number(ide.settings.get('terminal.fontSize', 13)) || 13;

  // A session is one PTY shown in one pane. A tab holds a tree of panes like PyCharm's split terminals:
  // a leaf {kind: 'leaf', s} or a split {kind: 'split', dir: 'row'|'column', ratio, a, b}.
  const sessions = []; // every pane of every tab, in creation order
  const tabs = []; // {root, active, el (layout), tabEl}
  let active = null; // the active pane of the active tab
  let tw;
  let tabBar;
  let host;
  let shells = [];
  let claude = { installed: false };
  let sessionsRoot = null; // the project the open sessions belong to
  let localHost = ''; // this computer's name in lower case (from pty:create), for OSC 7

  const leaves = (node) => (!node ? [] : node.kind === 'leaf' ? [node.s] : [...leaves(node.a), ...leaves(node.b)]);
  const parentOf = (node, target) => {
    if (!node || node.kind !== 'split') return null;
    if (node.a === target || node.b === target) return node;
    return parentOf(node.a, target) || parentOf(node.b, target);
  };
  const MIN_PANE = { row: 80, column: 40 }; // px a divider leaves to each side

  function renderLayout(t) {
    const build = (node, depth = 0) => {
      if (node.kind === 'leaf') { node.s.pane.style.flex = ''; return node.s.pane; }
      const box = el('div', `split split-${node.dir}`);
      const a = build(node.a, depth + 1);
      const b = build(node.b, depth + 1);
      const apply = () => { a.style.flex = `${node.ratio} 1 0`; b.style.flex = `${1 - node.ratio} 1 0`; };
      apply();
      const handle = el('div', 'split-handle term-divider');
      // Where a nested divider meets its parent's, the parent's (the longer one) takes the mouse.
      handle.style.zIndex = String(20 - depth);
      handle.onmousedown = (down) => {
        down.preventDefault();
        const r = box.getBoundingClientRect();
        const size = node.dir === 'row' ? r.width : r.height;
        const lo = Math.min(0.5, MIN_PANE[node.dir] / Math.max(1, size));
        const move = (e) => {
          const pos = node.dir === 'row' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
          node.ratio = Math.min(1 - lo, Math.max(lo, pos));
          apply();
        };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      };
      handle.ondblclick = () => { node.ratio = 0.5; apply(); };
      box.append(a, handle, b);
      return box;
    };
    t.el.replaceChildren(build(t.root));
    t.el.classList.toggle('split-mode', t.root.kind === 'split');
  }

  // Panes fit their PTY to their own size; a pane in a hidden tab or window keeps its size until it shows again.
  function fitPane(s) {
    if (s.closed || !s.pane.isConnected || !s.pane.offsetWidth || s.pane.closest('.hidden')) return;
    try { s.fit.fit(); } catch {}
  }
  const fitTab = (t) => { for (const s of leaves(t?.root)) fitPane(s); };

  function makeTab() {
    const t = { root: null, active: null };
    t.el = el('div', 'term-layout hidden');
    host.appendChild(t.el);
    t.tabEl = el('div', 'term-tab');
    t.tabEl.onclick = () => selectPane(t.active);
    t.tabEl.onauxclick = (e) => e.button === 1 && closeTab(t);
    t.tabEl.ondblclick = () => renameSession(t.active);
    t.tabEl.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); });
    tabBar.insertBefore(t.tabEl, tabBar.querySelector('.term-new'));
    tabs.push(t);
    return t;
  }

  // ---------- sessions ----------
  // A new tab with one pane.
  // Sessions on their way (waiting for the terminal to be ready); the window's own first session waits for them too.
  let creating = 0;
  async function createSession(opts = {}) {
    creating++;
    try {
      await ready;
      return await startPane(makeTab(), opts);
    } finally { creating--; }
  }
  // Shows the window for a session about to be made, so showing it does not also start the default one.
  let opening = false;
  function showFor() {
    opening = true;
    try { tw.show(); } finally { opening = false; }
  }

  // Splits pane `from` (default: the active one); the new pane starts in that pane's folder with the same shell.
  async function splitPane(from, side) {
    from ||= active;
    if (!from) { tw.show(); return null; }
    await ready;
    if (from.closed) return null;
    if (!tw.isVisible()) tw.show();
    return startPane(from.t, {
      cwd: from.cwd || ide.root || undefined,
      // A Claude Code or installer pane splits into a plain shell, not a second copy of its command.
      shell: from.kind === 'shell' && !from.command ? from.shellOpt : undefined,
    }, { from, side });
  }

  // projectless: the session is not tied to the project (the Claude Code installer) and outlives a project switch.
  async function startPane(t, { name, command, cwd, shell, focus = true, kind = 'shell', projectless = false } = {}, place = null) {
    const s = { name, kind, exited: false, cwd: cwd || ide.root || '', shellOpt: shell, command, t, projectless };
    s.pane = el('div', 'term-pane');
    s.el = el('div', 'term-session hidden');
    s.el.dataset.terminal = '';
    s.pane.appendChild(s.el);
    s.leaf = { kind: 'leaf', s };
    if (!place) t.root = s.leaf;
    else {
      const old = place.from.leaf;
      const split = { kind: 'split', dir: place.side === 'down' ? 'column' : 'row', ratio: 0.5, a: old, b: s.leaf };
      const p = parentOf(t.root, old);
      if (!p) t.root = split; else if (p.a === old) p.a = split; else p.b = split;
    }
    renderLayout(t);
    s.term = new window.Terminal({
      allowProposedApi: true,
      fontFamily: "'JetBrains Mono', D2Coding, Consolas, 'Malgun Gothic', monospace",
      fontSize: fontSize(),
      cursorBlink: true,
      scrollback: 10000,
      theme: theme(),
      windowsPty: { backend: 'conpty' },
    });
    s.fit = new window.FitAddon.FitAddon();
    s.search = new window.SearchAddon.SearchAddon();
    s.term.loadAddon(s.fit);
    s.term.loadAddon(s.search);
    s.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
    s.term.unicode.activeVersion = '11';
    s.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, url) => ide.api.invoke('shell:openExternal', url)));
    s.term.registerLinkProvider(fileLinkProvider(s));
    trackCwd(s);
    s.term.open(s.el);
    s.term.attachCustomKeyEventHandler((e) => keyHandler(s, e));
    s.el.addEventListener('contextmenu', (e) => { e.preventDefault(); sessionMenu(s, e.clientX, e.clientY); });
    // Clicking or tabbing into a pane makes it the active one (focus outline, tab title).
    s.pane.addEventListener('focusin', () => { if (active !== s && !s.closed) selectPane(s, false); });
    s.size = ide.util.observeSize(s.pane, () => fitPane(s));
    sessions.push(s);
    selectPane(s, focus);
    try { s.fit.fit(); } catch {}
    const size = { cols: s.term.cols, rows: s.term.rows };
    let r;
    try {
      r = await ide.api.invoke('pty:create', {
        shell: shell || ide.settings.get(SHELL, 'powershell'),
        cwd: cwd || ide.root || undefined,
        ...size,
        command,
        interpreter: ide.settings.get('terminal.activateVenv', true) ? ide.currentInterp()?.executable : undefined,
        envFiles: ide.settings.get(LOAD_ENV_FILE, true) && ide.root ? [joinPath(ide.root, '.env')] : [],
        // With a remote project interpreter (WSL, SSH, Docker), a plain new session is a shell in that target.
        target: !shell && !command ? ide.currentInterp()?.target : undefined,
      });
    } catch (err) {
      r = { error: ide.util.errorText(err) };
    }
    // The shell could not start (not installed, unreachable target): say why instead of a tab stuck at "…".
    if (r.error) {
      s.exited = true;
      s.name ??= r.shellName || shell || ide.settings.get(SHELL, 'powershell');
      if (s.closed) return s;
      const lines = r.error === 'shellNotFound'
        ? [tr('The terminal could not start: {shell} was not found ({file}).', { shell: r.shellName, file: r.file }),
          tr('Start another shell with New Session with… (▾), or choose the default shell in Settings › Terminal.')]
        : [tr('The terminal could not start: {message}', { message: r.error })];
      s.term.write(`\x1b[31m${lines[0]}\x1b[0m\r\n${lines.slice(1).map((l) => `${l}\r\n`).join('')}\x1b[90m${tr('Press Enter to close this tab.')}\x1b[0m\r\n`);
      renderTab(s.t);
      return s;
    }
    const pending = orphanOutput.get(r.id) || [];
    orphanOutput.delete(r.id);
    // The pane was closed while the shell started (a remote target can take seconds): end it instead of orphaning it.
    if (s.closed) { closedIds.add(r.id); ide.api.invoke('pty:kill', r.id); return s; }
    s.id = r.id;
    s.pid = r.pid;
    if (r.host) localHost = String(r.host).toLowerCase();
    s.pane.dataset.session = r.id;
    s.shellName = r.shellName;
    s.name ??= r.shellName;
    renderTab(s.t);
    for (const d of pending) s.term.write(d);
    s.term.onData((data) => !s.exited && ide.api.send('pty:write', { id: s.id, data }));
    s.term.onResize(({ cols, rows }) => ide.api.send('pty:resize', { id: s.id, cols, rows }));
    // A resize while the shell started (the panel settling after it opened) did not reach the pty.
    if (s.term.cols !== size.cols || s.term.rows !== size.rows) ide.api.send('pty:resize', { id: s.id, cols: s.term.cols, rows: s.term.rows });
    s.term.onTitleChange((title) => { if (kind === 'shell' && title) { s.title = title; renderTab(s.t); } });
    return s;
  }

  // The folder a shell reports (OSC 7 file://host/path, or Windows Terminal's OSC 9;9 "path") is where a split of
  // that pane starts; a shell that reports nothing keeps the folder it started in. Any program can print these, so
  // only a local drive path is taken: a UNC path (\\host\share) would make the split's folder check open an SMB
  // connection to that host and offer it the user's NTLM credentials. OSC 7 must name no host, localhost or this
  // computer.
  const localPath = (p) => /^[A-Za-z]:[\\/]/.test(p) && !/[\x00-\x1f]/.test(p);
  function trackCwd(s) {
    const set = (p) => { if (localPath(p)) s.cwd = p.replace(/\//g, '\\'); };
    s.term.parser.registerOscHandler(7, (data) => {
      try {
        const u = new URL(data);
        const host = u.hostname.toLowerCase();
        if (u.protocol === 'file:' && (!host || host === 'localhost' || (localHost && host === localHost))) {
          set(decodeURIComponent(u.pathname).replace(/^\/(?=[A-Za-z]:)/, ''));
        }
      } catch {}
      return true;
    });
    s.term.parser.registerOscHandler(9, (data) => {
      const m = /^9;"?([^"]*)"?$/.exec(data);
      if (!m) return false;
      set(m[1]);
      return true;
    });
  }

  const byId = (id) => sessions.find((s) => s.id === id);
  // Output that arrives before pty:create has answered is kept until the session knows its id. Sessions closed
  // here may still print until their exit arrives; that output is dropped.
  const orphanOutput = new Map();
  const closedIds = new Set();
  ide.api.on('pty:data', ({ id, data }) => {
    const s = byId(id);
    if (s) s.term.write(data);
    else if (!closedIds.has(id)) (orphanOutput.get(id) || orphanOutput.set(id, []).get(id)).push(data);
  });
  ide.api.on('pty:exit', ({ id, code }) => {
    const s = byId(id);
    closedIds.delete(id);
    if (!s) return;
    s.exited = true;
    // A split pane whose shell ends (`exit`) closes, as in PyCharm; a tab's only pane keeps its output until Enter.
    if (s.t.root.kind === 'split') { closeSession(s); return; }
    s.term.write(`\r\n\x1b[90m${tr('Process exited with code {code}. Press Enter to close this tab.', { code })}\x1b[0m\r\n`);
    renderTab(s.t);
  });

  // Shows pane s (its tab becomes the visible one); null shows the empty state.
  function selectPane(s, focus = true) {
    const t = s?.t || null;
    active = s;
    if (t) t.active = s;
    for (const o of tabs) {
      o.el.classList.toggle('hidden', o !== t);
      o.tabEl.classList.toggle('active', o === t);
    }
    for (const o of sessions) {
      o.el.classList.toggle('hidden', o.t !== t);
      o.pane.classList.toggle('active', o === s);
    }
    host.querySelector('.term-empty')?.classList.toggle('hidden', !!s);
    if (t) renderTab(t);
    if (s) {
      requestAnimationFrame(() => fitTab(t));
      if (focus) s.term.focus();
    }
  }
  const select = selectPane;

  // Closes one pane: its PTY (and everything running in it) ends. The last pane of a tab closes the tab.
  function closeSession(s) {
    if (!s || s.closed) return;
    s.closed = true;
    if (s.id && !s.exited) { closedIds.add(s.id); ide.api.invoke('pty:kill', s.id); }
    s.size.disconnect();
    // xterm 5.5 never disposes the device-pixel-ratio monitor its CoreBrowserService creates, so every closed terminal
    // left a window 'resize' and a media-query listener behind (verify/soak.mjs counted 4 per session).
    s.term._core?._coreBrowserService?._screenDprMonitor?.dispose();
    s.term.dispose();
    s.pane.remove();
    sessions.splice(sessions.indexOf(s), 1);
    const t = s.t;
    const p = parentOf(t.root, s.leaf);
    let next = null;
    if (!p) t.root = null;
    else {
      const sibling = p.a === s.leaf ? p.b : p.a;
      const gp = parentOf(t.root, p);
      if (!gp) t.root = sibling; else if (gp.a === p) gp.a = sibling; else gp.b = sibling;
      const near = leaves(sibling);
      next = p.a === s.leaf ? near[0] : near[near.length - 1];
    }
    if (!t.root) {
      t.el.remove();
      t.tabEl.remove();
      tabs.splice(tabs.indexOf(t), 1);
      if (active === s) select(tabs[tabs.length - 1]?.active || null);
      return;
    }
    renderLayout(t);
    if (t.active === s) t.active = next;
    if (active === s) select(next);
    else renderTab(t);
  }

  function closeTab(t) {
    for (const s of leaves(t.root)) closeSession(s);
  }

  function renderTab(t) {
    const s = t.active;
    if (!s) return;
    t.tabEl.replaceChildren();
    t.tabEl.title = s.shellName || '';
    t.tabEl.append(el('span', 'term-tab-icon' + (s.kind === 'claude' ? ' claude' : ''), s.kind === 'claude' ? '✳' : '❯'));
    const label = el('span', 'term-tab-name' + (s.exited ? ' exited' : ''), s.name || '…');
    label.dataset.userText = '';
    t.tabEl.append(label);
    const n = leaves(t.root).length;
    if (n > 1) t.tabEl.append(el('span', 'term-tab-count', String(n)));
    const close = el('button', 'term-tab-close', '×');
    close.title = tr('Close Tab');
    close.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    t.tabEl.append(close);
  }

  async function renameSession(s) {
    if (!s) return;
    const name = await ide.ui.prompt(tr('Rename Session'), s.name);
    if (name && !s.closed) { s.name = name; renderTab(s.t); }
  }

  // Next/previous pane of the active tab, in reading order of the split tree.
  function cycleSplit(step) {
    const t = active?.t;
    if (!t) return;
    const list = leaves(t.root);
    if (list.length < 2) return;
    if (!tw.isVisible()) tw.show();
    select(list[(list.indexOf(active) + step + list.length) % list.length]);
  }

  // ---------- keys, clipboard, links ----------
  const clip = { read: () => ide.api.invoke('clipboard:readText'), write: (t) => ide.api.invoke('clipboard:writeText', t) };
  function keyHandler(s, e) {
    if (e.type !== 'keydown') return true;
    if (s.exited && e.key === 'Enter') { closeSession(s); return false; }
    const ctrl = e.ctrlKey && !e.altKey;
    // Ctrl+C copies when there is a selection (otherwise it interrupts), as in Windows Terminal.
    if (ctrl && !e.shiftKey && e.code === 'KeyC' && s.term.hasSelection()) { clip.write(s.term.getSelection()); s.term.clearSelection(); return false; }
    if (ctrl && e.shiftKey && e.code === 'KeyC') { if (s.term.hasSelection()) clip.write(s.term.getSelection()); return false; }
    if (ctrl && e.code === 'KeyV') { e.preventDefault(); clip.read().then((t) => t && s.term.paste(t)); return false; }
    if (ctrl && e.shiftKey && e.code === 'KeyF') { findInTerminal(s); return false; }
    return true;
  }

  // `File "x.py", line 12` (tracebacks) and `path/to/file.py:12[:3]` open in the editor.
  const FILE_LINK = /File "([^"]+)", line (\d+)|((?:[A-Za-z]:)?[\w./\\-]+\.(?:py|pyi|txt|md|json|toml|cfg|ini|js|ts|html|css|yml|yaml|bat|ps1|java|kt|lua|luau)):(\d+)(?::(\d+))?/g;
  // Matches run over the whole logical line, so long paths that wrap onto the next rows still link.
  function fileLinkProvider(s) {
    return {
      provideLinks(y, callback) {
        const buf = s.term.buffer.active;
        const cols = s.term.cols;
        let first = y - 1;
        while (first > 0 && buf.getLine(first)?.isWrapped) first--;
        let last = first;
        while (buf.getLine(last + 1)?.isWrapped) last++;
        let text = '';
        for (let i = first; i <= last; i++) text += buf.getLine(i)?.translateToString(i === last) ?? '';
        // Buffer rows are 0-based, link positions 1-based; a string index maps to (column, row) by the row width.
        const at = (index) => ({ x: (index % cols) + 1, y: first + Math.floor(index / cols) + 1 });
        const links = [];
        for (const m of text.matchAll(FILE_LINK)) {
          const start = at(m.index);
          const end = at(m.index + m[0].length - 1);
          if (y < start.y || y > end.y) continue;
          const raw = m[1] || m[3];
          const lineNo = Number(m[2] || m[4]);
          const col = Number(m[5]) || 1;
          links.push({
            range: { start, end },
            text: m[0],
            activate: async () => {
              const full = /^[A-Za-z]:|^[\\/]/.test(raw) ? raw : joinPath(s.cwd || ide.root || '', raw.replace(/\//g, '\\'));
              if (await ide.api.exists(full)) ide.openFile(full, { line: lineNo, col });
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    };
  }
  async function findInTerminal(s) {
    const q = await ide.ui.prompt(tr('Find in terminal'), s.lastSearch || '');
    if (!q) return;
    s.lastSearch = q;
    s.search.findNext(q, { caseSensitive: false });
  }

  function sessionMenu(s, x, y) {
    ide.ui.contextMenu(x, y, [
      { label: tr('Copy'), hint: 'Ctrl+C', disabled: !s.term.hasSelection(), run: () => clip.write(s.term.getSelection()) },
      { label: tr('Paste'), hint: 'Ctrl+V', run: () => clip.read().then((t) => t && s.term.paste(t)) },
      { label: tr('Select All'), run: () => s.term.selectAll() },
      { separator: true },
      { label: tr('Find in terminal'), hint: 'Ctrl+Shift+F', run: () => findInTerminal(s) },
      { label: tr('Clear Buffer'), run: () => s.term.clear() },
      { separator: true },
      ...splitItems(s),
      { separator: true },
      { label: tr('Rename Session'), run: () => renameSession(s) },
      { label: tr('Close Session'), keyAction: 'Terminal.CloseSession', run: () => closeSession(s) },
    ]);
  }

  const splitItems = (s) => [
    { label: tr('Split Right'), keyAction: 'Terminal.SplitRight', run: () => splitPane(s, 'right') },
    { label: tr('Split Down'), keyAction: 'Terminal.SplitDown', run: () => splitPane(s, 'down') },
  ];
  function tabMenu(t, x, y) {
    if (!t.active) return;
    ide.ui.contextMenu(x, y, [
      ...splitItems(t.active),
      { separator: true },
      { label: tr('Rename Session'), run: () => renameSession(t.active) },
      { label: tr('Close Tab'), run: () => closeTab(t) },
    ]);
  }

  // ---------- Claude Code ----------
  const claudeSession = () => sessions.find((s) => s.kind === 'claude' && !s.exited);

  async function refreshClaude() {
    claude = await ide.api.invoke('claude:status');
    return claude;
  }

  async function openClaude() {
    showFor();
    // Claude Code's interface needs room; a short bottom panel grows to just under half the window.
    const bottom = document.getElementById('bottom');
    if (bottom.offsetHeight < innerHeight * 0.4) bottom.style.height = `${Math.round(innerHeight * 0.45)}px`;
    const existing = claudeSession();
    if (existing) { select(existing); return existing; }
    if (!(await refreshClaude()).installed) { showInstallPrompt(); return null; }
    const q = (p) => `'${p.replace(/'/g, "''")}'`;
    return createSession({ name: 'Claude Code', kind: 'claude', command: `& ${q(claude.path)}`, shell: 'powershell' });
  }

  // `claude auth login` in its own tab: the CLI's sign-in, which the AI features use, is separate from the Claude app's,
  // and a refresh token the CLI can no longer use ("OAuth session expired and could not be refreshed") needs a new one.
  async function openClaudeLogin() {
    showFor();
    if (!(await refreshClaude()).installed) { showInstallPrompt(); return null; }
    const q = (p) => `'${p.replace(/'/g, "''")}'`;
    return createSession({ name: tr('Sign in to Claude Code'), kind: 'claude-login', command: `& ${q(claude.path)} auth login`, shell: 'powershell', projectless: true });
  }

  // The official installer runs visibly in a terminal tab, so the user sees exactly what is executed.
  function showInstallPrompt() {
    const body = el('div', 'claude-install');
    body.append(
      el('p', null, tr('Claude Code is not installed on this computer.')),
      el('p', 'muted', tr('Install it with the official installer, then sign in with your Claude subscription when it starts (/login).')),
    );
    const cmd = el('code', 'claude-install-cmd', 'irm https://claude.ai/install.ps1 | iex');
    body.appendChild(cmd);
    ide.ui.dialog({
      title: tr('Install Claude Code'),
      body,
      width: 520,
      buttons: [
        { label: tr('Install in Terminal'), primary: true, run: () => {
          createSession({ name: tr('Install Claude Code'), shell: 'powershell', command: 'irm https://claude.ai/install.ps1 | iex', projectless: true });
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // Sends "@path#Lx-y" for the current file or selection to Claude Code, like the official IDE extensions.
  async function sendReference() {
    const ed = ide.editor;
    const tab = ide.activeTab();
    if (!tab?.path || tab.kind !== 'file' && !tab.doc) return;
    const s = claudeSession() || await openClaude();
    if (!s) return;
    const rel = ide.root && isUnder(tab.path, ide.root) ? ide.util.rel(tab.path).replace(/\\/g, '/') : tab.path;
    const sel = ed?.getModel() === tab.model ? ed.getSelection() : null;
    const range = sel && !sel.isEmpty() ? (sel.startLineNumber === sel.endLineNumber ? `#L${sel.startLineNumber}` : `#L${sel.startLineNumber}-${sel.endLineNumber}`) : '';
    const send = () => { ide.api.send('pty:write', { id: s.id, data: `@${rel}${range} ` }); select(s); };
    if (s.id) send(); else setTimeout(send, 800);
  }

  function logicalLines(s) {
    if (!s) return [];
    const b = s.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      const wrapsOn = b.getLine(i + 1)?.isWrapped;
      const piece = line?.translateToString(!wrapsOn) ?? '';
      if (line?.isWrapped && out.length) out[out.length - 1].text += piece;
      else out.push({ row: i, text: piece });
    }
    return out;
  }
  // ---------- tool window ----------
  tw = ide.registerToolWindow({
    id: 'Terminal', title: tr('Terminal'), icon: '❯', side: 'bottom', keys: 'Alt+F12', order: 30,
    mount(container) {
      container.classList.add('term-tool');
      tabBar = el('div', 'term-tabs');
      const add = el('button', 'term-new', '＋');
      add.title = tr('New Session');
      add.onclick = () => createSession();
      const pick = el('button', 'term-new term-pick', '▾');
      pick.title = tr('New Session with…');
      pick.onclick = async (e) => {
        shells = shells.length ? shells : await ide.api.invoke('pty:shells');
        const r = pick.getBoundingClientRect();
        ide.ui.contextMenu(r.left, r.bottom, [
          ...shells.map((sh) => ({ label: sh.name, hint: sh.id === ide.settings.get(SHELL, 'powershell') ? '✓' : '', run: () => createSession({ shell: sh.id }) })),
          { separator: true },
          { label: tr('Claude Code'), keyAction: 'ClaudeCode', run: openClaude },
        ]);
        e.stopPropagation();
      };
      tabBar.append(add, pick);
      host = el('div', 'term-host');
      const empty = el('div', 'term-empty muted');
      empty.append(el('div', null, tr('No terminal sessions')));
      const start = el('button', 'secondary', tr('New Session'));
      start.onclick = () => createSession();
      empty.appendChild(start);
      host.appendChild(empty);
      container.append(tabBar, host);
    },
  });
  tw.setActions([
    { icon: '✳', title: tr('Claude Code'), keyAction: 'ClaudeCode', run: openClaude },
    { icon: '◫', title: tr('Split Right'), keyAction: 'Terminal.SplitRight', id: 'terminal-split-right', run: () => splitPane(active, 'right') },
    { icon: '⊟', title: tr('Split Down'), keyAction: 'Terminal.SplitDown', id: 'terminal-split-down', run: () => splitPane(active, 'down') },
    { icon: '⌫', title: tr('Clear Buffer'), run: () => active?.term.clear() },
  ]);

  // Opening the Terminal window with no sessions starts one, as in PyCharm.
  ide.on('toolWindowShown', (id) => {
    if (id !== 'Terminal') return;
    if (!sessions.length && !creating && !opening) createSession();
    else if (active) requestAnimationFrame(() => { fitTab(active.t); active.term.focus(); });
  });

  (ide.settingsPages ||= []).push({
    id: 'terminal', title: () => tr('Terminal'), keywords: 'terminal shell env dotenv environment 터미널 셸 환경 변수',
    defaults: { [LOAD_ENV_FILE]: true },
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Terminal'));
      // The shells found on this computer; the setting may name one that is gone, which is kept until changed.
      const pick = ctx.ui.selectInput(SHELL, [], 'powershell');
      pick.id = 'terminalShell';
      s.appendChild(ctx.ui.fieldRow(tr('Default shell:'), pick));
      ide.api.invoke('pty:shells').then((list) => {
        shells = list;
        const current = ctx.value(SHELL) ?? 'powershell';
        for (const sh of list) pick.add(new Option(sh.name, sh.id));
        if (!list.some((sh) => sh.id === current)) pick.add(new Option(current, current));
        pick.value = current;
      }).catch(() => {});
      s.appendChild(ctx.ui.checkbox(LOAD_ENV_FILE, tr('Load the project .env file into new terminals')));
      host.appendChild(el('p', 'muted settings-note', tr('New sessions get the variables of the .env file in the project root. Sessions that are already open keep their environment.')));
    },
  });

  // themeChanged: also when the OS switches under the Sync with OS theme.
  ide.on('themeChanged', () => requestAnimationFrame(() => { for (const s of sessions) s.term.options.theme = theme(); }));
  ide.on('settingsChanged', (key) => {
    if (key === 'terminal.fontSize') for (const s of sessions) { s.term.options.fontSize = fontSize(); fitPane(s); }
  });

  // Toolbar button and stripe icon for Claude Code.
  const claudeBtn = el('button', 'tb-icon claude-btn', '✳');
  ide.keymap.tooltip(claudeBtn, tr('Claude Code'), 'ClaudeCode');
  claudeBtn.onclick = openClaude;
  ide.registerToolbarItem({ side: 'right', order: 150, el: claudeBtn });

  ide.registerAction({ id: 'ClaudeCode', title: tr('Claude Code'), keys: 'Ctrl+Escape', run: openClaude, terminal: true });
  ide.registerAction({ id: 'ClaudeCodeLogin', title: tr('Sign in to Claude Code'), run: openClaudeLogin, terminal: true });
  ide.registerAction({ id: 'ClaudeCodeSendReference', title: tr('Send File Reference to Claude Code'), keys: 'Ctrl+Alt+K', run: sendReference });
  ide.registerAction({ id: 'TerminalNewSession', title: tr('New Terminal Session'), keys: 'Ctrl+Shift+T', when: () => !!document.activeElement?.closest('[data-terminal]'), run: () => createSession(), terminal: true });
  // Split terminals (PyCharm's Split Right / Split Down / Next and Previous Splitter): unbound, as in PyCharm.
  ide.registerAction({ id: 'Terminal.SplitRight', title: tr('Split Terminal Right'), run: () => splitPane(active, 'right'), terminal: true });
  ide.registerAction({ id: 'Terminal.SplitDown', title: tr('Split Terminal Down'), run: () => splitPane(active, 'down'), terminal: true });
  ide.registerAction({ id: 'Terminal.NextSplitter', title: tr('Next Terminal Split'), run: () => cycleSplit(1), terminal: true });
  ide.registerAction({ id: 'Terminal.PreviousSplitter', title: tr('Previous Terminal Split'), run: () => cycleSplit(-1), terminal: true });
  ide.registerAction({ id: 'Terminal.CloseSession', title: tr('Close Terminal Session'), run: () => closeSession(active), terminal: true });
  ide.registerAction({ id: 'InstallClaudeCode', title: tr('Install Claude Code'), run: showInstallPrompt });
  // The official installer runs in a visible Terminal session, so the user sees exactly what it does; the Install
  // Manager card waits until the claude binary shows up.
  (ide.installables ||= []).push({
    id: 'ai:claude-code', category: 'ai', name: 'Claude Code', homepage: 'https://claude.com/claude-code',
    description: tr("Anthropic's coding agent in the Terminal, signed in with your Claude subscription."),
    confirm: tr('This runs the official installer in a Terminal session: `irm https://claude.ai/install.ps1 | iex`'),
    status: async () => {
      const c = await refreshClaude();
      return { installed: !!c?.installed, version: c?.version?.split(' ')[0] || undefined };
    },
    install: async (log, _progress, signal) => {
      showFor();
      await createSession({ name: tr('Install Claude Code'), shell: 'powershell', command: 'irm https://claude.ai/install.ps1 | iex', projectless: true });
      log(`${tr('Running the official installer in the Terminal…')}\n`);
      const end = Date.now() + 15 * 60000;
      while (!(await refreshClaude())?.installed) {
        if (signal?.aborted) throw new Error(tr('Cancelled'));
        if (Date.now() > end) throw new Error(tr('The installer did not finish within 15 minutes.'));
        await new Promise((r) => setTimeout(r, 3000));
      }
      log(`${claude.version || 'claude'}\n`);
    },
  });
  ide.emit('installablesChanged');
  ide.onEditor((ed) => ed.addAction({
    id: 'pyide.claude.sendReference', label: tr('Send to Claude Code'), contextMenuGroupId: '9_claude', run: sendReference,
  }));
  ide.registerTreeAction({
    title: tr('Open in Terminal'),
    when: (entry) => entry.dir,
    run: (entry) => { showFor(); createSession({ cwd: entry.path }); },
  });

  // Commands run in the project root; a new project means new sessions start there.
  ide.on('projectOpened', (root) => {
    refreshClaude();
    // Sessions belong to their project: opening another one in this window ends them, like closing the project.
    if (sessionsRoot && !samePath(sessionsRoot, root)) closeAll();
    sessionsRoot = root;
  });
  ide.on('projectClosed', () => { closeAll(); sessionsRoot = null; });
  // The installer's session is not the project's: it keeps running (and keeps its tab) while it has not exited.
  function closeAll() { for (const s of [...sessions]) if (!s.projectless || s.exited) closeSession(s); }

  // Like PyCharm, ending sessions that still run asks first; Cancel keeps the project (and every session) open.
  // A reload (Trust Project) ends every session, the installer's too.
  ide.beforeProjectChange?.push(async (next, { reload = false } = {}) => {
    if (!reload && next && (!sessionsRoot || samePath(sessionsRoot, next))) return true;
    const running = sessions.filter((s) => !s.exited && !s.closed && (reload || !s.projectless));
    if (!running.length) return true;
    const text = running.length === 1
      ? tr('A terminal session is still running: {names}. Terminate it?', { names: running[0].name || '…' })
      : tr('{count} terminal sessions are still running: {names}. Terminate them?',
        { count: running.length, names: running.map((s) => s.name || '…').join(', ') });
    return ide.ui.confirm(text, { title: tr('Terminate Processes'), ok: tr('Terminate') });
  });

  const layoutOf = (n) => (!n ? null : n.kind === 'leaf' ? { id: n.s.id, cols: n.s.term.cols, rows: n.s.term.rows }
    : { dir: n.dir, ratio: n.ratio, a: layoutOf(n.a), b: layoutOf(n.b) });
  ide.terminal = {
    open: (opts) => { showFor(); return createSession(opts); },
    claudeLogin: openClaudeLogin,
    sessions: () => sessions.map((s) => ({ id: s.id, name: s.name, kind: s.kind, exited: s.exited, pid: s.pid, cwd: s.cwd, tab: tabs.indexOf(s.t), projectless: s.projectless })),
    // Tabs with their split tree: a pane is {id, cols, rows}, a split {dir: 'row'|'column', ratio, a, b}.
    tabs: () => tabs.map((t) => ({ name: t.active?.name, active: t.active?.id, panes: leaves(t.root).map((s) => s.id), layout: layoutOf(t.root) })),
    split: (side, id) => splitPane(id ? byId(id) : active, side),
    focus: (id) => { const s = byId(id); if (s) select(s); return !!s; },
    close: (id) => closeSession(id ? byId(id) : active),
    active: () => active && { id: active.id, name: active.name, kind: active.kind, pid: active.pid },
    // Plain text of a session's buffer as logical lines (rows that wrap are joined back together).
    text: (id) => logicalLines(id ? byId(id) : active).map((l) => l.text).join('\n'),
    // Buffer position (0-based row, column) of the last occurrence of `needle`, following wrapped rows.
    locate: (needle) => {
      const s = active;
      if (!s) return null;
      const lines = logicalLines(s);
      for (let i = lines.length - 1; i >= 0; i--) {
        const k = lines[i].text.lastIndexOf(needle);
        if (k >= 0) return { row: lines[i].row + Math.floor(k / s.term.cols), col: k % s.term.cols };
      }
      return null;
    },    send: (text, id) => { const s = id ? byId(id) : active; if (s?.id) ide.api.send('pty:write', { id: s.id, data: text }); },
    openClaude,
    claudeStatus: () => claude,
    // Cell geometry of the active session, for placing the mouse on a given buffer line.
    geometry: () => active && { cols: active.term.cols, rows: active.term.rows, viewportY: active.term.buffer.active.viewportY },
  };
})();
