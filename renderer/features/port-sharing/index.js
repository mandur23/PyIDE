// Port sharing (VS Code's Ports view): a Ports tool window listing the ports that programs started from PyIDE listen
// on, each with its local address and a Share button that gives it a public https address through a Cloudflare quick
// tunnel (main/features/port-sharing.js; cloudflared comes from the Install Manager). A new server is announced with
// Open in Browser and Share. Sharing asks first (anyone with the address reaches the server), and "Share new ports
// automatically" is off unless the user turns it on, after the same warning.
(() => {
  const { el } = ide.util;
  const AUTO = 'ports.autoShare';
  const CONFIRM = 'ports.confirmShare'; // false after "Don't ask again"
  const ITEM = 'tool:cloudflared';
  let st = { ports: [], tunnels: [], cloudflared: false };
  const announced = new Set(); // ports told about this session
  const tunnelOf = (port) => st.tunnels.find((t) => t.port === port) || null;
  const local = (port) => `http://localhost:${port}/`;
  const openUrl = (url) => ide.api.invoke('shell:openExternal', url);
  const copy = (text) => ide.api.invoke('clipboard:writeText', text);

  // ---------- Install Manager: cloudflared ----------
  const builtin = () => ide.api.invoke('installer:toolchains').then((l) => l.find((s) => s.name === 'cloudflared'));
  (ide.installables ||= []).push({
    id: ITEM, category: 'system', name: 'cloudflared', homepage: 'https://github.com/cloudflare/cloudflared',
    description: tr('Cloudflare Tunnel client (Apache 2.0) that gives a server running in PyIDE a public https address, for the Ports tool window.'),
    async status() {
      const s = await builtin();
      return { installed: !!s?.installed, version: s?.version, size: s ? tr('{size} MB download', { size: Math.round(s.size / 1048576) }) : '',
        detail: s?.installed ? s.home : tr('Portable install for your user account; no administrator rights needed.') };
    },
    install: (log, progress, signal) => ide.installer.job({ kind: 'toolchain-install', name: 'cloudflared' }, log, progress, signal),
    uninstall: (log, progress, signal) => ide.installer.job({ kind: 'toolchain-uninstall', name: 'cloudflared' }, log, progress, signal),
  });
  ide.emit('installablesChanged');

  async function ensureCloudflared() {
    if (st.cloudflared) return true;
    if (!ide.installer?.run) {
      ide.ui.alert(tr('Sharing a port needs cloudflared from the Install Manager, and the Install Manager plugin is disabled.'));
      return false;
    }
    const s = await builtin();
    const ok = await ide.ui.confirm(tr('Sharing a port needs cloudflared {version} ({size} MB), which the Install Manager downloads for your user account. Download it now?',
      { version: s?.version || '', size: s ? Math.round(s.size / 1048576) : '?' }), { title: tr('Share Port'), ok: tr('Download') });
    if (!ok) return false;
    await ide.installer.run(ITEM);
    const after = ide.installer.state(ITEM);
    if (after.phase === 'failed') { ide.ui.alert(tr('cloudflared could not be installed: {error}', { error: after.error })); return false; }
    st = await ide.api.invoke('ports:state');
    return st.cloudflared;
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
    if (!(await ensureCloudflared())) return;
    try {
      st = await ide.api.invoke('ports:share', port);
      render();
    } catch (err) {
      ide.notifications?.notify({ title: tr('Port {port} could not be shared', { port }), text: ide.util.errorText(err), kind: 'error', group: 'Ports', raw: true });
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
      const refresh = el('button', 'secondary', tr('Refresh'));
      refresh.id = 'portsRefresh';
      refresh.onclick = async () => { st = await ide.api.invoke('ports:refresh'); render(); };
      bar.append(auto, refresh);
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
  function button(text, cls, run) {
    const b = el('button', cls, text);
    b.onclick = (e) => { e.preventDefault(); run(); };
    return b;
  }
  function render() {
    if (!list) return;
    if (!st.ports.length) {
      list.replaceChildren(el('div', 'ports-empty muted', tr('Servers that programs started from PyIDE listen on appear here, with a Share button that gives them a public address.')));
      return;
    }
    const head = el('div', 'ports-row ports-head');
    head.append(...[tr('Port'), tr('Process'), tr('Local Address'), tr('Public Address'), ''].map((t) => el('span', null, t)));
    list.replaceChildren(head, ...st.ports.map((p) => {
      const t = tunnelOf(p.port);
      const row = el('div', 'ports-row');
      row.dataset.port = p.port;
      const proc = el('span', 'ports-proc', `${p.name} (${p.pid})`);
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
        pub.append(link(t.url, 'ports-url'), button('⧉', 'ports-copy', () => copy(t.url)));
        pub.lastChild.title = tr('Copy Address');
        act.append(button(tr('Stop Sharing'), 'secondary ports-stop', () => unshare(p.port)));
      } else {
        const err = el('span', 'ports-error', tr('Sharing failed'));
        err.title = t.error || '';
        pub.append(err);
        act.append(button(tr('Retry'), 'secondary ports-share', async () => { await ide.api.invoke('ports:unshare', p.port); share(p.port, { asked: true }); }));
      }
      const loc = el('span', 'ports-local-cell');
      loc.append(link(local(p.port), 'ports-local'));
      row.append(el('span', 'ports-port', String(p.port)), proc, loc, pub, act);
      return row;
    }));
  }

  // ---------- updates from main ----------
  function announce(before) {
    for (const p of st.ports) {
      if (announced.has(p.port)) continue;
      announced.add(p.port);
      if (ide.settings.get(AUTO, false)) {
        if (st.cloudflared) share(p.port, { asked: true });
        continue;
      }
      ide.notifications?.notify({
        title: tr('Port {port} is available', { port: p.port }), text: tr('{process} is listening on {url}', { process: p.name, url: local(p.port) }),
        group: 'Ports', raw: true,
        actions: [
          { label: tr('Open in Browser'), run: () => openUrl(local(p.port)) },
          { label: tr('Share'), run: () => share(p.port) },
        ],
      });
    }
    for (const t of st.tunnels) {
      const was = before.tunnels.find((x) => x.port === t.port);
      if (t.state === 'shared' && was?.state !== 'shared') {
        ide.notifications?.notify({
          title: tr('Port {port} is shared', { port: t.port }), text: t.url, kind: 'ok', group: 'Ports', raw: true,
          actions: [{ label: tr('Copy Address'), run: () => copy(t.url) }, { label: tr('Open in Browser'), run: () => openUrl(t.url) }],
        });
      } else if (t.state === 'failed' && was?.state !== 'failed') {
        ide.notifications?.notify({ title: tr('Port {port} could not be shared', { port: t.port }), text: t.error || '', kind: 'error', group: 'Ports', raw: true });
      }
    }
    // A port that went away can announce itself again when its server comes back.
    for (const port of [...announced]) if (!st.ports.some((p) => p.port === port)) announced.delete(port);
  }
  ide.api.on('ports:changed', (next) => {
    const before = st;
    st = next;
    announce(before);
    render();
    tw.button?.classList.toggle('has-shared', st.tunnels.some((t) => t.state === 'shared'));
  });
  ide.api.invoke('ports:state').then((s) => { const before = st; st = s; announce(before); render(); }, () => {});

  ide.ports = { state: () => st, share, unshare, setAutoShare: setAuto };
})();
