// Terminal tool window: real PTY sessions rendered with xterm.js, in tabs, plus the Claude Code launcher.
(() => {
  const { el, basename, dirname, joinPath, samePath, isUnder } = ide.util;
  const XTERM = '../node_modules/@xterm';

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

  const sessions = [];
  let active = null;
  let tw;
  let tabBar;
  let host;
  let shells = [];
  let claude = { installed: false };

  // ---------- sessions ----------
  async function createSession({ name, command, cwd, shell, focus = true, kind = 'shell' } = {}) {
    await ready;
    const s = { name, kind, exited: false, cwd: cwd || ide.root || '' };
    s.el = el('div', 'term-session hidden');
    s.el.dataset.terminal = '';
    host.appendChild(s.el);
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
    s.term.open(s.el);
    s.term.attachCustomKeyEventHandler((e) => keyHandler(s, e));
    s.el.addEventListener('contextmenu', (e) => { e.preventDefault(); sessionMenu(s, e.clientX, e.clientY); });
    sessions.push(s);
    s.tab = el('div', 'term-tab');
    renderTab(s);
    tabBar.insertBefore(s.tab, tabBar.querySelector('.term-new'));
    select(s, focus);
    s.fit.fit();
    const r = await ide.api.invoke('pty:create', {
      shell: shell || ide.settings.get('terminal.shell', 'powershell'),
      cwd: cwd || ide.root || undefined,
      cols: s.term.cols,
      rows: s.term.rows,
      command,
      interpreter: ide.settings.get('terminal.activateVenv', true) ? ide.currentInterp()?.executable : undefined,
    });
    s.id = r.id;
    s.shellName = r.shellName;
    s.name ??= r.shellName;
    renderTab(s);
    for (const d of orphanOutput.get(r.id) || []) s.term.write(d);
    orphanOutput.delete(r.id);
    s.term.onData((data) => !s.exited && ide.api.send('pty:write', { id: s.id, data }));
    s.term.onResize(({ cols, rows }) => ide.api.send('pty:resize', { id: s.id, cols, rows }));
    s.term.onTitleChange((title) => { if (kind === 'shell' && title) { s.title = title; renderTab(s); } });
    return s;
  }

  const byId = (id) => sessions.find((s) => s.id === id);
  // Output that arrives before pty:create has answered is kept until the session knows its id.
  const orphanOutput = new Map();
  ide.api.on('pty:data', ({ id, data }) => {
    const s = byId(id);
    if (s) s.term.write(data);
    else orphanOutput.set(id, [...(orphanOutput.get(id) || []), data]);
  });
  ide.api.on('pty:exit', ({ id, code }) => {
    const s = byId(id);
    if (!s) return;
    s.exited = true;
    s.term.write(`\r\n\x1b[90m${tr('Process exited with code {code}. Press Enter to close this tab.', { code })}\x1b[0m\r\n`);
    renderTab(s);
  });

  function select(s, focus = true) {
    active = s;
    for (const o of sessions) {
      o.el.classList.toggle('hidden', o !== s);
      o.tab.classList.toggle('active', o === s);
    }
    host.querySelector('.term-empty')?.classList.toggle('hidden', !!s);
    if (s) {
      requestAnimationFrame(() => { try { s.fit.fit(); } catch {} });
      if (focus) s.term.focus();
    }
  }

  function closeSession(s) {
    if (s.id && !s.exited) ide.api.invoke('pty:kill', s.id);
    s.term.dispose();
    s.el.remove();
    s.tab.remove();
    sessions.splice(sessions.indexOf(s), 1);
    if (active === s) select(sessions[sessions.length - 1] || null);
  }

  function renderTab(s) {
    s.tab.replaceChildren();
    s.tab.title = s.shellName || '';
    s.tab.append(el('span', 'term-tab-icon' + (s.kind === 'claude' ? ' claude' : ''), s.kind === 'claude' ? '✳' : '❯'));
    const label = el('span', 'term-tab-name' + (s.exited ? ' exited' : ''), s.name || '…');
    label.dataset.userText = '';
    s.tab.append(label);
    const close = el('button', 'term-tab-close', '×');
    close.title = tr('Close Session');
    close.onclick = (e) => { e.stopPropagation(); closeSession(s); };
    s.tab.append(close);
    s.tab.onclick = () => select(s);
    s.tab.onauxclick = (e) => e.button === 1 && closeSession(s);
    s.tab.ondblclick = async () => {
      const name = await ide.ui.prompt(tr('Rename Session'), s.name);
      if (name) { s.name = name; renderTab(s); }
    };
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
      { label: tr('Rename Session'), run: () => s.tab.ondblclick() },
      { label: tr('Close Session'), run: () => closeSession(s) },
    ]);
  }

  // ---------- Claude Code ----------
  const claudeSession = () => sessions.find((s) => s.kind === 'claude' && !s.exited);

  async function refreshClaude() {
    claude = await ide.api.invoke('claude:status');
    return claude;
  }

  async function openClaude() {
    tw.show();
    // Claude Code's interface needs room; a short bottom panel grows to just under half the window.
    const bottom = document.getElementById('bottom');
    if (bottom.offsetHeight < innerHeight * 0.4) bottom.style.height = `${Math.round(innerHeight * 0.45)}px`;
    const existing = claudeSession();
    if (existing) { select(existing); return existing; }
    if (!(await refreshClaude()).installed) { showInstallPrompt(); return null; }
    const q = (p) => `'${p.replace(/'/g, "''")}'`;
    return createSession({ name: 'Claude Code', kind: 'claude', command: `& ${q(claude.path)}`, shell: 'powershell' });
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
          createSession({ name: tr('Install Claude Code'), shell: 'powershell', command: 'irm https://claude.ai/install.ps1 | iex' });
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
          ...shells.map((sh) => ({ label: sh.name, hint: sh.id === ide.settings.get('terminal.shell', 'powershell') ? '✓' : '', run: () => createSession({ shell: sh.id }) })),
          { separator: true },
          { label: tr('Claude Code'), hint: 'Ctrl+Esc', run: openClaude },
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
      new ResizeObserver(() => { if (active && !host.closest('.hidden')) { try { active.fit.fit(); } catch {} } }).observe(host);
    },
  });
  tw.setActions([
    { icon: '✳', title: tr('Claude Code'), run: openClaude },
    { icon: '⌫', title: tr('Clear Buffer'), run: () => active?.term.clear() },
  ]);

  // Opening the Terminal window with no sessions starts one, as in PyCharm.
  ide.on('toolWindowShown', (id) => {
    if (id !== 'Terminal') return;
    if (!sessions.length) createSession();
    else if (active) requestAnimationFrame(() => { try { active.fit.fit(); } catch {} active.term.focus(); });
  });

  ide.on('settingsChanged', (key) => {
    if (key === 'appearance.theme') requestAnimationFrame(() => { for (const s of sessions) s.term.options.theme = theme(); });
    if (key === 'terminal.fontSize') for (const s of sessions) { s.term.options.fontSize = fontSize(); s.fit.fit(); }
  });

  // Toolbar button and stripe icon for Claude Code.
  const claudeBtn = el('button', 'tb-icon claude-btn', '✳');
  claudeBtn.title = `${tr('Claude Code')} (Ctrl+Esc)`;
  claudeBtn.onclick = openClaude;
  ide.registerToolbarItem({ side: 'right', order: 150, el: claudeBtn });

  ide.registerAction({ id: 'ClaudeCode', title: tr('Claude Code'), keys: 'Ctrl+Escape', run: openClaude, terminal: true });
  ide.registerAction({ id: 'ClaudeCodeSendReference', title: tr('Send File Reference to Claude Code'), keys: 'Ctrl+Alt+K', run: sendReference });
  ide.registerAction({ id: 'TerminalNewSession', title: tr('New Terminal Session'), keys: 'Ctrl+Shift+T', when: () => !!document.activeElement?.closest('[data-terminal]'), run: () => createSession(), terminal: true });
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
      tw.show();
      await createSession({ name: tr('Install Claude Code'), shell: 'powershell', command: 'irm https://claude.ai/install.ps1 | iex' });
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
    run: (entry) => { tw.show(); createSession({ cwd: entry.path }); },
  });

  // Commands run in the project root; a new project means new sessions start there.
  ide.on('projectOpened', () => refreshClaude());

  ide.terminal = {
    open: (opts) => { tw.show(); return createSession(opts); },
    sessions: () => sessions.map((s) => ({ id: s.id, name: s.name, kind: s.kind, exited: s.exited })),
    active: () => active && { id: active.id, name: active.name, kind: active.kind },
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
