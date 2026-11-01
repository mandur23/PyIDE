// Detailed logging in the Players tab: the offer to install the NanoBridge plugin (main/minecraft/players/bridge.js), its
// removal, the app-wide default for new servers, and applying it to the project's other servers. It records people, so
// nothing is installed without the owner reading what it does, and the default is off until they turn it on.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const { call, views, paintResult, refresh, userText } = mc.players.kit;
  const NEW_SERVERS = 'minecraft.detailedLogNewServers'; // read by main when it creates a server
  const invoke = (channel, ...args) => ide.api.invoke(`players:${channel}`, ide.root, ...args);

  const WHY_NOT = () => ({
    noPlugins: tr('A Vanilla server has no plugins, so detailed logging is not available here. The plain log keeps working.'),
    modded: tr('Detailed logging works on Paper and Purpur only. Fabric, Forge and NeoForge are not covered. The plain log keeps working.'),
    proxy: tr('A proxy has no players of its own, so there is nothing for it to log.'),
    kind: tr('Detailed logging works on Paper and Purpur only. The plain log keeps working.'),
    oldVersion: tr('Detailed logging needs Minecraft 1.20 or newer. The plain log keeps working.'),
    locked: tr('The server is holding that file. Stop the server and try again.'),
    failed: tr('The plugin file could not be written.'),
  });
  const whyNot = (code) => WHY_NOT()[code] ?? tr('That did not work.');
  const labelOf = (s) => (s.code ? tr('Detailed Logging: Not Available') : s.installed === 'none' ? tr('Detailed Logging: Off')
    : s.active ? tr('Detailed Logging: On') : s.running ? tr('Detailed Logging: Restart Needed') : tr('Detailed Logging: Ready'));

  async function paint(v) {
    let s;
    try { s = await call('bridge', v); } catch { return; }
    if (!views.has(v)) return;
    v.bridgeState = s;
    v.bridgeButton.textContent = labelOf(s);
    v.bridgeButton.classList.toggle('on', !s.code && s.installed !== 'none');
  }
  function button(v) {
    v.bridgeButton = el('button', 'secondary mcpl-bridge', tr('Detailed Logging'));
    v.bridgeButton.type = 'button';
    v.bridgeButton.onclick = () => offer(v);
    return v.bridgeButton;
  }
  function changed(v, ok, says) {
    paintResult(v, ok ? 'ok' : 'bad', null, says);
    paint(v);
    refresh(v);
  }

  function offer(v) {
    const s = v.bridgeState;
    if (!s) return;
    if (s.code) {
      ide.ui.dialog({ title: tr('Detailed Logging'), body: el('div', 'mc-dialog mcpl-bridge-why', whyNot(s.code)), width: 460, buttons: [{ label: tr('Close'), primary: true }] });
      return;
    }
    const body = el('div', 'mc-dialog mcpl-bridge-offer');
    if (s.installed === 'none') {
      body.append(el('p', null, tr('This installs the NanoBridge plugin in plugins/ of this server. It records players\' block and combat activity, what they take from containers, items picked up and dropped, the first word of commands, and sign text, with the place and the time. It never reads chat.')),
        el('p', null, tr('A restart is needed before it records anything.')));
    } else {
      body.append(el('p', null, tr('The NanoBridge plugin is in plugins/ of this server. Removing it stops the recording after a restart. What was recorded stays in the timeline for 30 days.')));
      if (s.installed === 'other') body.append(el('p', null, tr('The file there is not the one this version of the app ships. Installing replaces it.')));
    }
    body.append(el('p', 'mcpl-bridge-tell', tr('Let your players know that this is recorded.')));
    const newServers = el('input');
    newServers.type = 'checkbox';
    newServers.className = 'mcpl-bridge-new';
    newServers.checked = ide.settings.get(NEW_SERVERS, false) === true;
    newServers.onchange = () => ide.settings.set(NEW_SERVERS, newServers.checked);
    const check = el('label', 'mc-dialog-check');
    check.append(newServers, ` ${tr('Also turn this on for new Paper and Purpur servers')}`);
    body.append(check);
    const error = el('div', 'mc-dialog-error');
    body.append(error);
    const fail = (r) => { error.textContent = whyNot(r.code); return false; };
    const install = async () => {
      const r = await call('bridgeInstall', v);
      if (!r.ok) return fail(r);
      changed(v, true, r.restart ? tr('NanoBridge is in plugins/. Restart the server to start recording.') : tr('NanoBridge is in plugins/. It starts recording when the server starts.'));
      return undefined;
    };
    const remove = async () => {
      const r = await call('bridgeRemove', v);
      if (!r.ok) return fail(r);
      changed(v, true, r.restart ? tr('NanoBridge is gone from plugins/. It keeps recording until the server restarts.') : tr('NanoBridge is gone from plugins/.'));
      return undefined;
    };
    const others = () => { applyOthers(v, error); return false; };
    ide.ui.dialog({
      title: tr('Detailed Logging'), body, width: 520,
      buttons: [...(s.installed !== 'current' ? [{ label: tr('Install Plugin'), primary: true, run: install }] : []), ...(s.installed !== 'none' ? [{ label: tr('Remove Plugin'), run: remove }] : []),
        { label: tr('Apply to My Other Servers…'), run: others }, { label: tr('Cancel') }],
    });
  }

  // One confirmation that names the servers, then a line for each server with what was done or why not.
  async function applyOthers(v, error) {
    let all;
    try { all = await invoke('bridgeServers'); } catch (err) { error.textContent = mc.errorText(err); return; }
    if (!views.has(v)) return;
    const others = all.filter((s) => s.dir.toLowerCase() !== v.srv.dir.toLowerCase());
    const able = others.filter((s) => !s.code && s.installed !== 'current');
    if (!able.length) { report(others, new Map()); return; }
    const names = able.map((s) => s.name).join(', ');
    const yes = await ide.ui.confirm(tr('Install NanoBridge on these servers: {names}? It records their players\' block and combat activity. Let your players know that this is recorded. A server that is running needs a restart.', { names }), { title: tr('Apply to My Other Servers'), ok: tr('Install on All') });
    if (!yes || !views.has(v)) return;
    const done = new Map();
    for (const s of able) done.set(s.dir, await invoke('bridgeInstall', s.dir).catch(() => ({ ok: false, code: 'failed' })));
    report(others, done);
    paint(v);
  }
  function report(servers, done) {
    const list = el('div', 'mc-dialog mcpl-bridge-report');
    if (!servers.length) list.append(el('div', 'muted', tr('This project has no other server.')));
    for (const s of servers) {
      const r = done.get(s.dir);
      const row = el('div', 'mcpl-bridge-line');
      row.dataset.server = s.name;
      const says = r?.ok ? (r.restart ? tr('Installed. It is running, so restart it to start recording.') : tr('Installed. It starts recording when it starts.'))
        : r ? whyNot(r.code) : s.code ? whyNot(s.code) : s.installed === 'current' ? tr('Already on.') : tr('Left as it was.');
      row.append(userText('span', 'mcpl-bridge-name', s.name), el('span', `mcpl-bridge-says${r && !r.ok ? ' bad' : ''}`, says));
      list.append(row);
    }
    ide.ui.dialog({ title: tr('Apply to My Other Servers'), body: list, width: 520, buttons: [{ label: tr('Close'), primary: true }] });
  }

  mc.players.bridge = { button, paint };
})();
