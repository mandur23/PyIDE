// IDE internal errors and diagnostics, as in PyCharm: a red blinking status-bar icon when something fails, the list of
// errors with stack traces and the plugin each came from (Copy, Clear All, Disable Plugin), Help › Show Log, Show Log
// in Explorer, Collect Logs and Diagnostic Data, Debug Log Settings, and About with versions.
// The errors themselves are collected in the main process (main/diagnostics) from every window and process.
(() => {
  const { el } = ide.util;
  const invoke = (channel, ...args) => ide.api.invoke(channel, ...args);
  const userText = (node) => { node.dataset.userText = ''; return node; };

  const SOURCES = { main: () => tr('Main process'), renderer: () => tr('Renderer'), plugin: () => tr('Plugin loading'), sidecar: () => tr('Helper process') };
  const WINDOWS = { main: () => tr('Main window'), detached: () => tr('Detached window') };
  const KINDS = {
    uncaught: () => tr('Uncaught exception'), rejection: () => tr('Unhandled promise rejection'), load: () => tr('Load failure'),
    crash: () => tr('Crash'), logged: () => tr('Logged error'), reported: () => tr('Logged error'), error: () => tr('Error'),
  };
  // A plugin with this many errors (occurrences included) is called out as one that keeps failing.
  const KEEPS_FAILING = 3;

  const interpreterInfo = () => ({
    interpreters: ide.interps.map(({ label, version, executable }) => ({ label, version, executable })),
    current: ide.currentInterp()?.executable || null,
  });

  // ---------- status bar ----------
  const ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/>'
    + '<rect x="7.1" y="3.6" width="1.8" height="5.8" rx=".9" fill="#fff"/><circle cx="8" cy="11.7" r="1.05" fill="#fff"/></svg>';
  const status = el('button', 'diag-status hidden');
  status.id = 'ideErrors';
  const glyph = el('span', 'diag-status-icon');
  glyph.innerHTML = ICON;
  const count = el('span', 'diag-status-count');
  status.append(glyph, count);
  ide.registerStatusItem({ order: 1, el: status });

  let summary = { count: 0, unread: 0 };
  let openDialog = null;
  function showSummary(s) {
    summary = s;
    status.classList.toggle('hidden', !s.count);
    status.classList.toggle('unread', s.unread > 0);
    count.textContent = s.count;
    status.title = s.unread
      ? tr('IDE internal errors: {count} new. Click to see them.', { count: s.unread })
      : tr('IDE internal errors: {count}', { count: s.count });
  }
  ide.api.on('diagnostics:changed', (s) => { showSummary(s); openDialog?.refresh(); });
  invoke('diagnostics:errors').then((list) => showSummary({ count: list.length, unread: list.filter((e) => !e.read).length }));
  status.onclick = () => openErrors();

  // ---------- internal errors dialog ----------
  const pluginName = (p) => (!p ? tr('PyIDE core') : p.i18n?.[i18n.locale]?.name || (p.bundled ? tr(p.name) : p.name));
  const timeOf = (t) => new Date(t).toLocaleTimeString();
  const describe = (e) => [SOURCES[e.source]?.() || e.source, e.window && WINDOWS[e.window]?.(), KINDS[e.kind]?.() || KINDS.error()].filter(Boolean).join(' · ');
  const copyText = (e) => [
    `${e.title ? `${e.title}: ` : ''}${e.message}`,
    `Plugin: ${e.plugin ? `${e.plugin.name} (${e.plugin.id})` : 'PyIDE core'}`,
    `Source: ${e.source}${e.window ? ` (${e.window} window)` : ''}, ${e.kind}, ${new Date(e.time).toISOString()}${e.count > 1 ? `, ${e.count} times` : ''}`,
    '',
    e.stack,
  ].join('\n');

  async function openErrors() {
    if (openDialog) return;
    let list = await invoke('diagnostics:errors');
    let selected = list[list.length - 1]?.id;
    const body = el('div', 'diag');
    const rows = el('div', 'diag-list');
    const detail = el('div', 'diag-detail');
    body.append(rows, detail);

    const dlg = ide.ui.dialog({
      title: tr('IDE Internal Errors'),
      body,
      width: 860,
      buttons: [
        { label: tr('Copy'), run: async () => { const e = current(); if (e) await invoke('clipboard:writeText', copyText(e)); copyBtn.textContent = tr('Copied'); return false; } },
        { label: tr('Clear All'), run: async () => { await invoke('diagnostics:clear'); } },
        { label: tr('Disable Plugin'), run: () => { const e = current(); if (e?.plugin) disablePlugin(e.plugin); } },
        { label: tr('Close'), primary: true },
      ],
      onClose: () => { openDialog = null; },
    });
    dlg.el.classList.add('diag-dialog');
    const [copyBtn, clearBtn, disableBtn] = dlg.el.querySelectorAll('.dialog-buttons button');
    copyBtn.id = 'diagCopy';
    clearBtn.id = 'diagClear';
    disableBtn.id = 'diagDisable';
    const current = () => list.find((e) => e.id === selected);

    function render() {
      rows.replaceChildren();
      if (!list.length) rows.append(el('div', 'diag-empty muted', tr('No errors')));
      for (const e of [...list].reverse()) {
        const row = el('div', `diag-row${e.id === selected ? ' active' : ''}`);
        row.dataset.id = e.id;
        const head = el('div', 'diag-row-head');
        head.append(el('span', 'diag-row-time', timeOf(e.lastTime)), userText(el('span', 'diag-row-plugin', pluginName(e.plugin))));
        if (e.count > 1) head.append(el('span', 'diag-row-count', tr('{count} times', { count: e.count })));
        row.append(head, userText(el('div', 'diag-row-msg', e.title ? `${e.title}: ${e.message}` : e.message)));
        row.onclick = () => { selected = e.id; copyBtn.textContent = tr('Copy'); render(); };
        rows.appendChild(row);
      }
      detail.replaceChildren();
      const e = current();
      disableBtn.classList.toggle('hidden', !e?.plugin || e.plugin.required);
      copyBtn.disabled = !e;
      if (!e) return;
      const plugin = el('div', 'diag-plugin');
      plugin.append(el('span', 'muted', tr('Plugin:')), ' ', userText(el('b', 'diag-plugin-name', pluginName(e.plugin))));
      if (e.plugin) plugin.append(' ', userText(el('span', 'muted diag-plugin-id', `(${e.plugin.id})`)));
      detail.append(plugin, el('div', 'diag-meta muted', `${describe(e)} · ${timeOf(e.time)}${e.count > 1 ? ` · ${tr('{count} times', { count: e.count })}` : ''}`));
      const total = e.plugin ? list.filter((x) => x.plugin?.id === e.plugin.id).reduce((n, x) => n + x.count, 0) : 0;
      if (e.plugin && !e.plugin.required && total >= KEEPS_FAILING) {
        detail.append(el('div', 'diag-failing', tr('{name} keeps failing ({count} errors). You can disable it.', { name: pluginName(e.plugin), count: total })));
      }
      detail.append(userText(el('div', 'diag-message', e.title ? `${e.title}: ${e.message}` : e.message)), el('pre', 'diag-stack', e.stack));
    }

    openDialog = {
      async refresh() {
        list = await invoke('diagnostics:errors');
        if (!current()) selected = list[list.length - 1]?.id;
        render();
        invoke('diagnostics:markRead');
      },
      close: () => dlg.close(),
    };
    render();
    await invoke('diagnostics:markRead');
  }

  function disablePlugin(plugin) {
    const name = pluginName(plugin);
    ide.ui.dialog({
      title: tr('Disable Plugin'),
      body: el('p', null, tr('Disable {name}? It stops loading after a restart.', { name })),
      buttons: [
        { label: tr('Disable Plugin'), primary: true, run: async () => {
          await invoke('plugins:setEnabled', plugin.id, false);
          openDialog?.close();
          ide.ui.dialog({
            title: tr('Plugin Disabled'),
            body: el('p', null, tr('{name} is disabled and stops loading after a restart.', { name })),
            buttons: [{ label: tr('Restart Now'), primary: true, run: () => ide.restart() }, { label: tr('Later') }],
          });
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  // ---------- log ----------
  async function showLog() {
    const file = await invoke('diagnostics:logFile');
    await ide.openFile(file);
    const tab = ide.findTab(file);
    if (tab?.model) ide.editor?.revealLine(tab.model.getLineCount());
  }

  async function collect() {
    const plugins = await invoke('plugins:list');
    const r = await invoke('diagnostics:collect', {
      ...interpreterInfo(),
      plugins,
      title: tr('Save Logs and Diagnostic Data'),
      filterName: tr('ZIP archive'),
    });
    if (!r) return null;
    const body = el('div', 'diag-saved');
    body.append(el('div', 'muted', tr('Saved to:')), userText(el('div', 'diag-saved-path', r.path)),
      el('p', 'muted', tr('Nothing was uploaded. Passwords, tokens and API keys were removed from the archive.')));
    ide.ui.dialog({
      title: tr('Logs and Diagnostic Data'),
      body,
      buttons: [{ label: tr('Show in Explorer'), run: () => { invoke('shell:showInFolder', r.path); } }, { label: tr('OK'), primary: true }],
    }).el.classList.add('diag-saved-dialog');
    return r.path;
  }

  // ---------- About ----------
  async function about() {
    const v = await invoke('diagnostics:versions', interpreterInfo());
    const cur = v.interpreters.find((i) => i.current);
    const body = el('div', 'about diag-about');
    body.append(el('div', 'about-logo', 'Py'));
    const text = el('div', 'diag-about-text');
    text.append(el('h2', null, 'PyIDE'), el('div', 'muted', tr('A PyCharm-style Python IDE')));
    const facts = el('table', 'diag-facts');
    for (const [label, value] of [
      [tr('Version'), v.app],
      [tr('Runtime'), `Electron ${v.electron} · Chromium ${v.chromium} · Node ${v.node} · V8 ${v.v8}`],
      [tr('Python tools'), `Pyright ${v.pyright || '—'} · ruff ${v.ruff || '—'}`],
      [tr('Python interpreter'), cur ? `${cur.version} (${cur.executable})` : tr('None')],
      [tr('Operating system'), v.os],
    ]) {
      const row = el('tr');
      row.append(el('td', 'muted', label), userText(el('td', null, value)));
      facts.appendChild(row);
    }
    text.append(facts, el('div', 'muted about-credit', tr('Icons and color schemes from PyCharm (IntelliJ Platform, Apache License 2.0).')));
    body.appendChild(text);
    const dlg = ide.ui.dialog({
      title: tr('About PyIDE'),
      body,
      width: 620,
      buttons: [
        { label: tr('Copy'), run: async () => { await invoke('clipboard:writeText', v.text); copy.textContent = tr('Copied'); return false; } },
        { label: tr('Close'), primary: true },
      ],
    });
    dlg.el.classList.add('diag-about-dialog');
    const copy = dlg.el.querySelector('.dialog-buttons button');
    copy.id = 'aboutCopy';
  }

  // ---------- Help › Debug Log Settings ----------
  // The main process reads these settings at startup; changes apply at once.
  const LEVEL_KEY = 'diagnostics.logLevel';
  const SIZE_KEY = 'diagnostics.logSizeMB';
  const LEVELS = () => [['DEBUG', tr('Debug')], ['INFO', tr('Info')], ['WARN', tr('Warning')], ['ERROR', tr('Error')]];
  function logSettings() {
    const body = el('div', 'diag-log-settings');
    const field = (label, control) => { const row = el('label', 'field'); row.append(el('span', null, label), control); return row; };
    const level = el('select');
    level.id = 'diagLogLevel';
    for (const [value, label] of LEVELS()) level.add(new Option(label, value));
    level.value = ide.settings.get(LEVEL_KEY, 'INFO');
    const size = el('input');
    size.id = 'diagLogSize';
    Object.assign(size, { type: 'number', min: 1, max: 100, value: ide.settings.get(SIZE_KEY, 10) });
    body.append(field(tr('Log level'), level), field(tr('Maximum log file size (MB)'), size),
      el('p', 'muted', tr('Older logs are kept as pyide.1.log to pyide.5.log in the same folder.')));
    ide.ui.dialog({
      title: tr('Debug Log Settings'),
      body,
      width: 460,
      buttons: [
        { label: tr('OK'), primary: true, run: () => {
          ide.settings.set(LEVEL_KEY, level.value);
          ide.settings.set(SIZE_KEY, Math.min(100, Math.max(1, Math.round(Number(size.value) || 10))));
          invoke('diagnostics:configure', { level: ide.settings.get(LEVEL_KEY), sizeMB: ide.settings.get(SIZE_KEY) });
        } },
        { label: tr('Cancel') },
      ],
    }).el.classList.add('diag-log-settings-dialog');
  }

  // ---------- actions ----------
  [
    { id: 'ShowIdeErrors', title: tr('IDE Internal Errors'), run: openErrors },
    { id: 'OpenLogInEditor', title: tr('Show Log'), run: showLog },
    { id: 'ShowLogInExplorer', title: tr('Show Log in Explorer'), run: () => invoke('diagnostics:showLogInExplorer') },
    { id: 'CollectZippedLogs', title: tr('Collect Logs and Diagnostic Data'), run: collect },
    { id: 'LogDebugConfigure', title: tr('Debug Log Settings…'), run: logSettings },
    { id: 'AboutPyIDE', title: tr('About PyIDE'), run: about },
  ].forEach(ide.registerAction);

  ide.diagnostics = { openErrors, showLog, collect, about, summary: () => summary };
})();
