// Port sharing (VS Code's Ports view): a Ports tool window listing the ports that programs started from PyIDE listen
// on, and ports the user added with Add Port (a server started elsewhere, such as a game server), each with what it
// speaks (HTTP, HTTPS or TCP), its local address, its address for other computers on the same network, and a Share
// button that gives it a public address (main/features/port-sharing.js): a web server an https address through a
// Cloudflare quick tunnel, any other TCP server a host:port address through bore. Both tools come from the Install
// Manager. A new server is announced with Open in Browser and Share. Sharing asks first (anyone with the address
// reaches the server), and "Share new ports automatically" is off unless the user turns it on, after the same warning.
(() => {
  const { el } = ide.util;
  const AUTO = 'ports.autoShare';
  const CONFIRM = 'ports.confirmShare'; // false after "Don't ask again"
  const ADDED = 'ports.added'; // ports the user added, for every project
  const TOOLS = {
    cloudflared: { item: 'tool:cloudflared', homepage: 'https://github.com/cloudflare/cloudflared',
      description: () => tr('Cloudflare Tunnel client (Apache 2.0) that gives a web server running in PyIDE a public https address, for the Ports tool window.') },
    bore: { item: 'tool:bore', homepage: 'https://github.com/ekzhang/bore',
      description: () => tr('TCP tunnel client (MIT) that gives a server that is not a web server, such as a game server, a public address through bore.pub, for the Ports tool window.') },
  };
  let st = { ports: [], added: [], tunnels: [], cloudflared: false, bore: false };
  const announced = new Set(); // ports told about this session
  const tunnelOf = (port) => st.tunnels.find((t) => t.port === port) || null;
  const web = (p) => p.proto !== 'tcp';
  const toolFor = (p) => (web(p) ? 'cloudflared' : 'bore');
  const hostPort = (host, port) => `${host}:${port}`;
  // A web server's address opens in the browser; another server's is host:port, for its own client to connect to.
  const local = (p) => (web(p) ? `${p.proto || 'http'}://${hostPort(p.host || 'localhost', p.port)}/` : hostPort(p.host || 'localhost', p.port));
  const lanOf = (p) => (p.lan || []).map((ip) => (web(p) ? `${p.proto || 'http'}://${hostPort(ip, p.port)}/` : hostPort(ip, p.port)));
  const openUrl = (url) => ide.api.invoke('shell:openExternal', url);
  const copy = (text) => ide.api.invoke('clipboard:writeText', text);
  const PROTO = { http: 'HTTP', https: 'HTTPS', tcp: 'TCP' };

  // ---------- Install Manager: cloudflared and bore ----------
  const builtin = (name) => ide.api.invoke('installer:toolchains').then((l) => l.find((s) => s.name === name));
  for (const [name, t] of Object.entries(TOOLS)) {
    (ide.installables ||= []).push({
      id: t.item, category: 'system', name, homepage: t.homepage,
      description: t.description(),
      async status() {
        const s = await builtin(name);
        return { installed: !!s?.installed, version: s?.version, size: s ? tr('{size} MB download', { size: Math.max(1, Math.round(s.size / 1048576)) }) : '',
          detail: s?.installed ? s.home : tr('Portable install for your user account; no administrator rights needed.') };
      },
      install: (log, progress, signal) => ide.installer.job({ kind: 'toolchain-install', name }, log, progress, signal),
      uninstall: (log, progress, signal) => ide.installer.job({ kind: 'toolchain-uninstall', name }, log, progress, signal),
    });
  }
  ide.emit('installablesChanged');

  async function ensureTool(name) {
    if (st[name]) return true;
    if (!ide.installer?.run) {
      ide.ui.alert(tr('Sharing this port needs {tool} from the Install Manager, and the Install Manager plugin is disabled.', { tool: name }));
      return false;
    }
    const s = await builtin(name);
    const ok = await ide.ui.confirm(tr('Sharing this port needs {tool} {version} ({size} MB), which the Install Manager downloads for your user account. Download it now?',
      { tool: name, version: s?.version || '', size: s ? Math.max(1, Math.round(s.size / 1048576)) : '?' }), { title: tr('Share Port'), ok: tr('Download') });
    if (!ok) return false;
    await ide.installer.run(TOOLS[name].item);
    const after = ide.installer.state(TOOLS[name].item);
    if (after.phase === 'failed') { ide.ui.alert(tr('{tool} could not be installed: {error}', { tool: name, error: after.error })); return false; }
    st = await ide.api.invoke('ports:state');
    return st[name];
  }

  // ---------- sharing ----------
  // Anyone with the address reaches the server, so the first share asks (until "Don't ask again").
  function confirmShare(port) {
    if (ide.settings.get(CONFIRM, true) === false) return Promise.resolve(true);
    return new Promise((resolve) => {
      const again = el('input');
      again.type = 'checkbox';
      again.id = 'portsDontAsk';
      const row = el('label', 'ports-dont-ask');
      row.append(again, el('span', null, tr("Don't ask again")));
      const body = el('div', 'ports-warning');
      body.append(el('p', null, tr('Anyone with the public address can open the server on port {port} from the internet while it is shared, without signing in.', { port })),
        el('p', null, tr('Development servers often run in debug mode with no sign-in. Share only what you would show others, and stop sharing when you are done.')), row);
      ide.ui.dialog({
        title: tr('Share Port {port}', { port }), body, width: 520,
        buttons: [
          { label: tr('Share'), primary: true, run: () => { if (again.checked) ide.settings.set(CONFIRM, false); resolve(true); } },
          { label: tr('Cancel'), run: () => resolve(false) },
        ],
        onClose: () => resolve(false),
      });
    });
  }

  async function share(port, { asked = false } = {}) {
    if (!asked && !(await confirmShare(port))) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = st.ports.find((x) => x.port === port);
      // Before the probe answers, main picks the tool; a missing one comes back as "<tool> is not installed".
      if (p?.proto && !(await ensureTool(toolFor(p)))) return;
      try {
        st = await ide.api.invoke('ports:share', port);
        render();
        return;
      } catch (err) {
        const missing = /\b(cloudflared|bore) is not installed/.exec(ide.util.errorText(err))?.[1];
        if (missing && attempt === 0) { if (await ensureTool(missing)) continue; return; }
        ide.notifications?.notify({ title: tr('Port {port} could not be shared', { port }), text: ide.util.errorText(err), kind: 'error', group: 'Ports', raw: true });
        return;
      }
    }
  }
  async function unshare(port) {
    st = await ide.api.invoke('ports:unshare', port);
    render();
  }

  async function setAuto(on) {
    if (on && !(await ide.ui.confirm(tr('Every server a program started from PyIDE opens will get a public address that anyone with it can open, without signing in. Turn on?'),
      { title: tr('Share New Ports Automatically'), ok: tr('Turn On') }))) return false;
    ide.settings.set(AUTO, !!on);
    return true;
  }

  // ---------- added ports ----------
  const addedPorts = () => ide.settings.get(ADDED, []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  async function setAdded(list) {
    ide.settings.set(ADDED, [...new Set(list)].sort((a, b) => a - b));
    st = await ide.api.invoke('ports:setAdded', addedPorts());
    render();
  }
  async function addPort(port) {
    if (port == null) {
      const text = await ide.ui.prompt(tr('Port number of a server running on this computer (e.g. 25565)'));
      if (text == null || !String(text).trim()) return;
      port = Number(String(text).trim());
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { ide.ui.alert(tr('Enter a port number from 1 to 65535.')); return; }
    await setAdded([...addedPorts(), port]);
    if (!st.ports.some((p) => p.port === port)) {
      ide.notifications?.notify({ title: tr('Port {port} added', { port }), text: tr('Nothing listens on port {port} yet. It appears in the list once its server starts.', { port }), group: 'Ports' });
    }
  }
  const removePort = (port) => { if (tunnelOf(port)) unshare(port); return setAdded(addedPorts().filter((p) => p !== port)); };

  // ---------- tool window ----------
  let list = null;
  let autoBox = null;
  const tw = ide.registerToolWindow({
    id: 'Ports', title: tr('Ports'), icon: '⇄', side: 'bottom', order: 66,
    mount(container) {
      container.id = 'portsTool';
      container.classList.add('ports-tool');
      const bar = el('div', 'ports-bar');
      autoBox = el('input');
      autoBox.type = 'checkbox';
      autoBox.id = 'portsAuto';
      autoBox.checked = !!ide.settings.get(AUTO, false);
      autoBox.onchange = async () => { autoBox.checked = (await setAuto(autoBox.checked)) ? autoBox.checked : !autoBox.checked; };
      const auto = el('label', 'ports-auto');
      auto.append(autoBox, el('span', null, tr('Share new ports automatically')));
      const add = el('button', 'secondary ports-add-btn', tr('Add Port…'));
      add.id = 'portsAdd';
      add.title = tr('List a server that was not started from PyIDE, such as a game server');
      add.onclick = () => addPort();
      const refresh = el('button', 'secondary', tr('Refresh'));
      refresh.id = 'portsRefresh';
      refresh.onclick = async () => { st = await ide.api.invoke('ports:refresh'); render(); };
      bar.append(auto, add, refresh);
      list = el('div', 'ports-list');
      list.id = 'portsList';
      container.append(bar, list);
      render();
    },
  });

  function link(url, cls) {
    const a = el('a', cls, url);
    a.dataset.userText = '';
    a.href = '#';
    a.dataset.url = url;
    a.title = tr('Open in Browser');
    a.onclick = (e) => { e.preventDefault(); openUrl(url); };
    return a;
  }
  // A host:port address: copied on click, since a browser cannot open it.
  function address(text, cls) {
    const a = el('span', `${cls} ports-address`, text);
    a.dataset.userText = '';
    a.dataset.url = text;
    a.title = tr('Copy Address');
    a.onclick = () => copy(text);
    return a;
  }
  function button(text, cls, run) {
    const b = el('button', cls, text);
    b.onclick = (e) => { e.preventDefault(); run(); };
    return b;
  }
  function render() {
    if (!list) return;
    const waiting = st.added.filter((port) => !st.ports.some((p) => p.port === port));
    if (!st.ports.length && !waiting.length) {
      list.replaceChildren(el('div', 'ports-empty muted', tr('Servers that programs started from PyIDE listen on appear here, with a Share button that gives them a public address. Add Port lists a server started elsewhere.')));
      return;
    }
    const head = el('div', 'ports-row ports-head');
    head.append(...[tr('Port'), tr('Process'), tr('Local Address'), tr('Public Address'), ''].map((t) => el('span', null, t)));
    const rows = st.ports.map((p) => {
      const t = tunnelOf(p.port);
      const row = el('div', 'ports-row');
      row.dataset.port = p.port;
      row.dataset.proto = p.proto || '';
      const portCell = el('span', 'ports-port', String(p.port));
      if (p.proto) portCell.append(el('span', 'ports-proto', PROTO[p.proto]));
      const proc = el('span', 'ports-proc', p.name ? `${p.name} (${p.pid})` : String(p.pid));
      proc.title = p.cmd;
      proc.dataset.userText = '';
      const pub = el('span', 'ports-public');
      const act = el('span', 'ports-actions');
      if (!t) {
        act.append(button(tr('Share'), 'secondary ports-share', () => share(p.port)));
      } else if (t.state === 'starting') {
        pub.append(el('span', 'muted', tr('Starting the tunnel…')));
        act.append(button(tr('Stop Sharing'), 'secondary ports-stop', () => unshare(p.port)));
      } else if (t.state === 'shared') {
        pub.append(t.kind === 'bore' ? address(t.url, 'ports-url') : link(t.url, 'ports-url'), button('⧉', 'ports-copy', () => copy(t.url)));
        pub.lastChild.title = tr('Copy Address');
        act.append(button(tr('Stop Sharing'), 'secondary ports-stop', () => unshare(p.port)));
      } else {
        const err = el('span', 'ports-error', tr('Sharing failed'));
        err.title = t.error || '';
        pub.append(err);
        act.append(button(tr('Retry'), 'secondary ports-share', async () => { await ide.api.invoke('ports:unshare', p.port); share(p.port, { asked: true }); }));
      }
      if (p.added) {
        const remove = button('×', 'ports-remove', () => removePort(p.port));
        remove.title = tr('Remove from the list');
        act.append(remove);
      }
      const loc = el('span', 'ports-local-cell');
      loc.append(web(p) ? link(local(p), 'ports-local') : address(local(p), 'ports-local'));
      // Other computers on the same network (Wi-Fi, LAN) reach a server bound to every interface here.
      for (const lan of lanOf(p)) {
        const line = el('span', 'ports-lan');
        line.append(el('span', 'muted', tr('LAN')), web(p) ? link(lan, 'ports-lan-url') : address(lan, 'ports-lan-url'));
        line.title = tr('Address for other computers on the same network');
        loc.append(line);
      }
      row.append(portCell, proc, loc, pub, act);
      return row;
    });
    for (const port of waiting) {
      const row = el('div', 'ports-row ports-waiting');
      row.dataset.port = port;
      const act = el('span', 'ports-actions');
      const remove = button('×', 'ports-remove', () => removePort(port));
      remove.title = tr('Remove from the list');
      act.append(remove);
      row.append(el('span', 'ports-port', String(port)), el('span', 'muted', tr('Not listening')), el('span'), el('span'), act);
      rows.push(row);
    }
    list.replaceChildren(head, ...rows);
  }

  // ---------- updates from main ----------
  function announce(before) {
    for (const p of st.ports) {
      if (announced.has(p.port)) continue;
      announced.add(p.port);
      if (ide.settings.get(AUTO, false) && !p.added) {
        if (st.cloudflared || st.bore) share(p.port, { asked: true });
        continue;
      }
      if (p.added) continue;
      ide.notifications?.notify({
        title: tr('Port {port} is available', { port: p.port }), text: tr('{process} is listening on {url}', { process: p.name, url: local(p) }),
        group: 'Ports', raw: true,
        actions: [
          ...(web(p) ? [{ label: tr('Open in Browser'), run: () => openUrl(local(p)) }] : []),
          { label: tr('Share'), run: () => share(p.port) },
        ],
      });
    }
    for (const t of st.tunnels) {
      const was = before.tunnels.find((x) => x.port === t.port);
      if (t.state === 'shared' && was?.state !== 'shared') {
        ide.notifications?.notify({
          title: tr('Port {port} is shared', { port: t.port }),
          text: t.kind === 'bore' ? `${t.url}\n${tr('Connect to this address from the program\'s own client (for a game server, its server address).')}` : t.url,
          kind: 'ok', group: 'Ports', raw: true,
          actions: [{ label: tr('Copy Address'), run: () => copy(t.url) }, ...(t.kind === 'bore' ? [] : [{ label: tr('Open in Browser'), run: () => openUrl(t.url) }])],
        });
      } else if (t.state === 'failed' && was?.state !== 'failed') {
        ide.notifications?.notify({ title: tr('Port {port} could not be shared', { port: t.port }), text: t.error || '', kind: 'error', group: 'Ports', raw: true });
      }
    }
    // A port that went away can announce itself again when its server comes back.
    for (const port of [...announced]) if (!st.ports.some((p) => p.port === port)) announced.delete(port);
  }
  // What a server speaks is asked only while the window is shown: a probe is a connection the server sees.
  const probeIfShown = () => { if (tw.isVisible?.() && st.ports.some((p) => !p.proto)) ide.api.invoke('ports:probe').catch(() => {}); };
  ide.on('toolWindowShown', (id) => { if (id === 'Ports') probeIfShown(); });
  ide.api.on('ports:changed', (next) => {
    const before = st;
    st = next;
    announce(before);
    render();
    probeIfShown();
    tw.button?.classList.toggle('has-shared', st.tunnels.some((t) => t.state === 'shared'));
  });
  const start = addedPorts().length ? ide.api.invoke('ports:setAdded', addedPorts()) : ide.api.invoke('ports:state');
  start.then((s) => { const before = st; st = s; announce(before); render(); }, () => {});

  ide.ports = { state: () => st, share, unshare, setAutoShare: setAuto, addPort, removePort };
})();
