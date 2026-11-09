// What a collaboration session shares beyond the files (step 5 of docs/collab-coding-plan.md): a guest asks to run a
// file and the host answers each request (nothing runs without that answer, and it runs on the host, as the host); the
// host shares a terminal, which guests watch and type into only once the host lets them; the host opens a port (a
// web server) to the guests, who reach it on their own localhost.
(() => {
  const { el, basename } = ide.util;
  const C = ide.collab;
  if (!C) return;
  const api = ide.api;
  const notify = (title, text, kind = 'info') => ide.notifications?.notify({ title, text, kind, group: tr('Collaboration') });
  const inGuestDoc = () => ide.editor?.getModel()?.uri.scheme === 'collab';

  // ---------- running (guest asks, host answers) ----------
  async function requestRun() {
    const tab = ide.activeTab();
    const rel = tab && C.relOfLocal(tab.path);
    if (rel === null || rel === undefined) return ide.ui.alert(tr('Open one of the host\'s files to ask the host to run it.'));
    const host = C.state().info?.host || tr('the host');
    notify(tr('Asked {host} to run {name}', { host, name: basename(rel) }), tr('It runs on the host\'s computer once the host allows it. Its output shows in Host Output.'));
    const r = await api.invoke('collab:runRequest', rel);
    if (r.ok) notify(tr('{host} runs {name}', { host, name: basename(rel) }), tr('The host allowed your request.'), 'ok');
    else notify(tr('{name} was not run', { name: basename(rel) }), r.code === 'busy' ? tr('You already asked: wait for the host\'s answer.')
      : r.code === 'badPath' || r.code === 'hidden' ? tr('The host refused this path.') : r.code === 'offline' ? tr('You are not connected to the host right now.') : tr('The host declined to run it.'), 'warn');
    return undefined;
  }
  ide.registerAction({ id: 'Collab.RequestRun', title: tr('Ask the Host to Run This File'), keys: 'Shift+F10', context: 'editor', when: inGuestDoc, run: requestRun });

  // Requests wait their turn; each dialog says who asks, what runs and where. Enter and Esc decline.
  const runQueue = [];
  let runAsking = null;
  C.on('runRequest', (e) => { runQueue.push(e); nextRun(); });
  C.on('runWithdrawn', (e) => {
    const i = runQueue.findIndex((q) => q.by === e.by && q.req === e.req);
    if (i >= 0) runQueue.splice(i, 1);
    if (runAsking?.e.by === e.by && runAsking.e.req === e.req) { const d = runAsking.dlg; runAsking = null; d.close(); }
  });
  function nextRun() {
    if (runAsking || !runQueue.length || C.state().role !== 'host') return;
    const e = runQueue.shift();
    let allowed = false;
    const body = el('div', 'collab-run-ask');
    const interp = ide.currentInterp?.()?.label || tr('the project\'s interpreter');
    body.append(
      el('div', 'dialog-message', tr('{name} asks to run {file} on this computer. It runs as you, with your files and your network: allow it only if you know what the file does.', { name: e.name, file: e.rel })),
      el('div', 'collab-run-detail', `${tr('Runs')}: ${interp} ${e.rel}`),
      el('div', 'collab-run-detail', `${tr('Working directory')}: ${ide.root || ''}`),
    );
    runAsking = { e };
    runAsking.dlg = ide.ui.dialog({
      title: tr('Run Request'), body, width: 540,
      onClose: () => {
        runAsking = null;
        api.invoke('collab:runAnswer', e.by, e.req, allowed).then((ok) => { if (ok && allowed) ide.run?.runFile?.(e.path); });
        setTimeout(nextRun);
      },
      buttons: [{ label: tr('Decline'), primary: true }, { label: tr('Run Once'), run: () => { allowed = true; } }],
    });
  }

  // ---------- the shared terminal ----------
  const XTERM = '../node_modules/@xterm';
  const loadScript = (src) => new Promise((resolve, reject) => {
    const amd = window.define?.amd;
    if (amd) window.define.amd = undefined;
    const tag = el('script');
    tag.src = src;
    tag.onload = () => { if (amd) window.define.amd = amd; resolve(); };
    tag.onerror = () => { if (amd) window.define.amd = amd; reject(new Error(`failed to load ${src}`)); };
    document.head.appendChild(tag);
  });
  let xtermLoaded = null;
  const loadXterm = () => (xtermLoaded ||= (async () => {
    if (!document.querySelector('link[href$="xterm/css/xterm.css"]')) {
      const css = el('link');
      css.rel = 'stylesheet';
      css.href = `${XTERM}/xterm/css/xterm.css`;
      document.head.appendChild(css);
    }
    if (!window.Terminal) await loadScript(`${XTERM}/xterm/lib/xterm.js`);
  })());
  const term = { shared: false, name: '', canType: false, xterm: null, box: null, note: null, ask: null, pending: [] };
  const termTheme = () => {
    const v = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return { background: v('--gray1'), foreground: v('--text'), cursor: v('--gray11'), cursorAccent: v('--gray1') };
  };
  const termTw = ide.registerToolWindow({
    id: 'CollabTerminal', title: tr('Host Terminal'), icon: '>_', iconName: 'terminal', side: 'bottom', order: 96,
    mount(container) {
      container.classList.add('collab-term-tool');
      const bar = el('div', 'collab-term-bar');
      term.note = el('span', 'collab-term-note', tr('The host shares no terminal.'));
      term.ask = el('button', 'secondary hidden', tr('Ask to Type'));
      term.ask.onclick = () => { api.send('collab:termAsk'); term.note.textContent = tr('Waiting for the host to let you type…'); };
      bar.append(term.note, term.ask);
      term.box = el('div', 'collab-term-box');
      container.append(bar, term.box);
    },
  });
  async function ensureXterm() {
    if (term.xterm) return term.xterm;
    await loadXterm();
    if (term.xterm) return term.xterm;
    const x = new window.Terminal({ fontFamily: "'JetBrains Mono', D2Coding, Consolas, 'Malgun Gothic', monospace", fontSize: 13, scrollback: 5000, theme: termTheme(), cols: 100, rows: 20 });
    x.open(term.box);
    // What a guest types reaches the host's shell only once the host allows it (and main checks that again).
    x.onData((d) => { if (term.shared && term.canType) api.send('collab:termInput', d); });
    term.xterm = x;
    for (const d of term.pending.splice(0)) x.write(d);
    return x;
  }
  function drawTerm() {
    if (!term.note) return;
    term.note.textContent = !term.shared ? tr('The host shares no terminal.')
      : term.canType ? tr('{name} on the host: you may type in it.', { name: term.name }) : tr('{name} on the host: you are watching.', { name: term.name });
    term.ask.classList.toggle('hidden', !term.shared || term.canType);
  }
  C.on('term:state', (e) => {
    if (C.state().role !== 'guest') return;
    const was = term.shared;
    Object.assign(term, { shared: !!e.shared, name: String(e.name || ''), canType: !!e.canType });
    drawTerm();
    if (term.shared && !was) termTw.show();
    // The host's size: its shell draws for it.
    if (term.shared) ensureXterm().then((x) => { if (e.cols > 1 && e.rows > 1 && e.cols < 1000 && e.rows < 500) x.resize(e.cols | 0, e.rows | 0); });
    if (!term.shared && term.xterm) term.xterm.write(`\r\n${tr('[The host stopped sharing the terminal]')}\r\n`);
  });
  C.on('term', (e) => {
    if (C.state().role !== 'guest' || typeof e.data !== 'string') return;
    if (term.xterm) term.xterm.write(e.data); else term.pending.push(e.data);
  });
  C.on('term:answer', (e) => {
    if (C.state().role !== 'guest') return;
    if (!e.allowed) notify(tr('The host did not let you type'), tr('You can still watch the terminal.'), 'warn');
    drawTerm();
  });
  C.on('ended', () => {
    Object.assign(term, { shared: false, name: '', canType: false, pending: [] });
    if (term.xterm) { term.xterm._core?._coreBrowserService?._screenDprMonitor?.dispose(); term.xterm.dispose(); term.xterm = null; }
    term.box?.replaceChildren();
    drawTerm();
  });

  // The host's side.
  let hostTerm = null; // {name} while shared
  async function shareTerminal() {
    if (hostTerm) { await api.invoke('collab:stopTerminal'); return; }
    if (!ide.terminal) return ide.ui.alert(tr('The Terminal plugin is off.'));
    if (!ide.terminal.active()) await ide.terminal.open();
    for (let i = 0; i < 50 && !ide.terminal.active()?.id; i++) await new Promise((r) => { setTimeout(r, 100); });
    const t = ide.terminal.active();
    const pane = ide.terminal.tabs?.().flatMap((x) => x.panes).find((x) => x.id === t?.id);
    if (!t?.id || !(await api.invoke('collab:shareTerminal', t.id, t.name, pane?.cols, pane?.rows))) ide.ui.alert(tr('The terminal could not be shared. Open a terminal first.'));
    return undefined;
  }
  C.on('term', (e) => { if (C.state().role === 'host') { hostTerm = e.shared ? { name: e.name } : null; C.render(); } });
  const termAsks = [];
  let termAsking = null;
  C.on('termRequest', (e) => { termAsks.push(e); nextTermAsk(); });
  function nextTermAsk() {
    if (termAsking || !termAsks.length || C.state().role !== 'host') return;
    const e = termAsks.shift();
    let allowed = false;
    termAsking = ide.ui.dialog({
      title: tr('Typing in Your Terminal'), width: 520,
      body: el('div', 'dialog-message', tr('{name} asks to type in your terminal {terminal}. What they type runs as commands on this computer, as you. Allow it only for someone you trust.', { name: e.name, terminal: e.terminal })),
      onClose: () => { termAsking = null; api.invoke('collab:termAnswer', e.by, allowed); setTimeout(nextTermAsk); },
      buttons: [{ label: tr('Decline'), primary: true }, { label: tr('Allow Typing'), run: () => { allowed = true; } }],
    });
  }

  // ---------- ports ----------
  let hostPorts = [];
  let forwarded = []; // guest: [{port, local}]
  C.on('ports', (e) => { if (C.state().role === 'host') { hostPorts = Array.isArray(e.ports) ? e.ports : []; C.render(); } });
  C.on('forwarded', (e) => { forwarded = Array.isArray(e.ports) ? e.ports : []; C.render(); });
  async function sharePort() {
    const typed = (await ide.ui.prompt(tr('Port of a server on this computer to open to guests (e.g. 8000)')))?.trim();
    if (!typed) return;
    const port = Number(typed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return ide.ui.alert(tr('{port} is not a port number.', { port: typed }));
    hostPorts = await api.invoke('collab:sharePorts', [...new Set([...hostPorts, port])]);
    C.render();
  }
  const unsharePort = async (port) => { hostPorts = await api.invoke('collab:sharePorts', hostPorts.filter((p) => p !== port)); C.render(); };
  C.on('ended', () => { hostPorts = []; forwarded = []; hostTerm = null; });

  // ---------- in the Collaboration tool window ----------
  const panel = C.panel;
  if (!panel) return;
  const section = el('div', 'collab-share');
  panel.insertBefore(section, panel.querySelector('.collab-head'));
  C.on('rendered', () => {
    const role = C.state().role;
    const items = [];
    if (role === 'host') {
      const t = el('button', 'secondary collab-share-terminal', hostTerm ? tr('Stop Sharing Terminal') : tr('Share Terminal'));
      t.onclick = shareTerminal;
      const p = el('button', 'secondary collab-share-port', tr('Open a Port…'));
      p.onclick = sharePort;
      items.push(el('div', 'collab-actions'));
      items[0].append(t, p);
      if (hostTerm) items.push(el('div', 'collab-share-note', tr('Guests see the terminal {name}.', { name: hostTerm.name })));
      for (const port of hostPorts) {
        const row = el('div', 'collab-port');
        const stop = el('button', 'link', tr('Close'));
        stop.onclick = () => unsharePort(port);
        row.append(el('span', null, tr('Port {port} is open to guests', { port })), stop);
        items.push(row);
      }
    } else if (role === 'guest' && C.state().info) {
      const r = el('button', 'secondary collab-request-run', tr('Ask to Run This File'));
      r.title = ide.keymap?.label?.('Collab.RequestRun') || 'Shift+F10';
      r.onclick = requestRun;
      items.push(r);
      for (const f of forwarded) {
        const row = el('div', 'collab-port');
        row.dataset.port = f.port;
        const open = el('button', 'link', tr('Open in Browser'));
        open.onclick = () => api.invoke('collab:openForwarded', f.port);
        row.append(el('span', 'collab-port-text', tr('localhost:{local} reaches the host\'s port {port}', { local: f.local, port: f.port })), open);
        items.push(row);
      }
    }
    section.replaceChildren(...items);
    section.classList.toggle('hidden', !items.length);
  });
  C.render();
})();
