// Updates: checks the update feed on startup, then daily or weekly while PyIDE runs, and from Help > Check for Updates…,
// downloads in the background with progress in the status bar, then offers Restart to Update (NSIS installs) or
// Download the new installer (MSI).
(() => {
  const { el } = ide.util;
  const FEED = 'updates.feedUrl';
  // Automatic checks on or off (the key predates the interval and keeps the user's choice).
  const ON_STARTUP = 'updates.checkOnStartup';
  const INTERVAL = 'updates.checkInterval'; // 'startup' | 'daily' | 'weekly'
  const SKIPPED = 'updates.skippedVersion';
  // Download only the changed blocks of the installer when possible (main falls back to the full installer).
  const DIFFERENTIAL = 'updates.differential';
  const DEFAULTS = { [ON_STARTUP]: true, [INTERVAL]: 'daily', [DIFFERENTIAL]: true };
  const log = ide.logger?.('#updater') || console;
  let state = { phase: 'idle' };

  // An unset feed means the installation default (state.defaultFeed); an empty one, set by the user, turns updates off.
  const feed = () => String(ide.settings.get(FEED, state.defaultFeed || '') ?? '').trim();

  // ---------- status bar ----------
  const item = el('span', 'upd-status hidden');
  item.id = 'updateStatus';
  item.onclick = () => (state.phase === 'downloaded' ? offerRestart() : null);
  ide.registerStatusItem({ order: 7, el: item });
  const size = (n) => (n < 100 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function render() {
    let text = '';
    const delta = state.download?.mode === 'delta' && state.download.bytes != null ? size(state.download.bytes) : null;
    if (state.phase === 'downloading' && delta) text = tr('Downloading PyIDE {version} (delta {size})… {percent}%', { version: state.available, size: delta, percent: state.percent || 0 });
    else if (state.phase === 'downloading') text = tr('Downloading PyIDE {version}… {percent}%', { version: state.available, percent: state.percent || 0 });
    else if (state.phase === 'downloaded') text = tr('Restart to Update');
    item.textContent = text;
    item.title = state.phase === 'downloaded' ? tr('PyIDE {version} is ready to install', { version: state.available }) : '';
    item.classList.toggle('hidden', !text);
    item.classList.toggle('ready', state.phase === 'downloaded');
    // The download is also a background task (the status bar progress widget and its popup).
    if (state.phase === 'downloading' && ide.tasks) {
      if (!task?.active) task = ide.tasks.start({ title: tr('Downloading PyIDE {version}', { version: state.available }), cancellable: false });
      task.update({ fraction: (state.percent || 0) / 100, text: `${state.percent || 0}%` });
    } else if (task) { task.done(); task = null; }
  }
  let task = null;
  ide.api.on('updater:state', (s) => {
    const was = state.phase;
    state = s;
    render();
    if (s.phase === 'downloaded' && was !== 'downloaded') offerRestart();
  });

  const message = (title, text, buttons, onClose) => {
    const body = el('div', 'upd-message');
    for (const line of [].concat(text)) body.appendChild(el('p', null, line));
    return ide.ui.dialog({ title, body, buttons, width: 460, onClose });
  };
  // The open Update Available dialog ({version}): an automatic check does not open a second one for the same version.
  let announced = null;
  function announce(version, manual, text, buttons) {
    if (!manual && announced?.version === version) return;
    const entry = { version };
    announced = entry;
    message(tr('Update Available'), text, buttons, () => { if (announced === entry) announced = null; });
  }
  // What main threw, without Electron's "Error invoking remote method '…': Error: " prefix.
  const reasonOf = (err) => ide.util.errorText(err);
  const skip = (version) => ({ label: tr('Skip This Version'), run: () => ide.settings.set(SKIPPED, version) });
  const later = { label: tr('Later') };

  // manual: from the menu or Settings, so it reports "no update" and errors, and ignores a skipped version.
  async function check({ manual = false, feedUrl = feed() } = {}) {
    if (!feedUrl) {
      if (manual) {
        message(tr('Check for Updates'), tr('Updates are off: no update feed is set.'), [
          { label: tr('Open Settings'), primary: true, run: () => ide.openSettings?.('updates') }, { label: tr('Close') }]);
      }
      return null;
    }
    let result;
    try {
      result = await ide.api.invoke('updater:check', feedUrl);
    } catch (err) {
      const reason = reasonOf(err);
      log.warn(`update check failed: ${reason}`);
      if (manual) message(tr('Check for Updates'), [tr('Could not check for updates.'), reason], [{ label: tr('Close'), primary: true }]);
      return null;
    }
    const version = result.available;
    if (!version) {
      if (manual) message(tr('Check for Updates'), tr('PyIDE {version} is the latest version.', { version: state.version }), [{ label: tr('Close'), primary: true }]);
      return result;
    }
    if (!manual && ide.settings.get(SKIPPED) === version) return result;
    if (state.kind === 'nsis') {
      if (state.phase === 'downloaded') offerRestart();
      else ide.api.invoke('updater:download', { differential: ide.settings.get(DIFFERENTIAL, true) !== false }).catch((err) => {
        log.warn(`update download failed: ${reasonOf(err)}`);
        message(tr('Update'), [tr('Could not download PyIDE {version}.', { version }), reasonOf(err)], [{ label: tr('Close'), primary: true }]);
      });
    } else if (state.kind === 'msi') {
      announce(version, manual, [tr('PyIDE {version} is available. You have {current}.', { version, current: state.version }),
        tr('This copy was installed from an MSI package, so update it with the new MSI installer.')], [
        { label: tr('Download the new installer'), primary: true, run: () => ide.api.invoke('updater:openInstaller') }, skip(version), later]);
    } else {
      announce(version, manual, [tr('PyIDE {version} is available. You have {current}.', { version, current: state.version }),
        tr('PyIDE updates itself only when it was installed with the PyIDE installer.')], [{ label: tr('Close'), primary: true }]);
    }
    return result;
  }

  let restartDialog = null;
  function offerRestart() {
    if (restartDialog) return;
    const version = state.available;
    restartDialog = message(tr('Update Ready'), tr('PyIDE {version} has been downloaded. Restart PyIDE to install it.', { version }), [
      { label: tr('Restart to Update'), primary: true, run: restart }, skip(version), later]);
    const close = restartDialog.close;
    restartDialog.close = () => { restartDialog = null; close(); };
  }

  // The installer closes PyIDE whether or not a window agrees, so unsaved files are saved first.
  async function restart() {
    const dirty = ide.tabs.filter((t) => ide.isDirty(t));
    if (dirty.length) {
      const ok = await new Promise((resolve) => message(tr('Restart to Update'),
        tr('Save {count} modified files and restart?', { count: dirty.length }), [
          { label: tr('Save and Restart'), primary: true, run: () => resolve(true) }, { label: tr('Cancel'), run: () => resolve(false) }]));
      if (!ok) return;
      await ide.saveAll();
    }
    await ide.api.invoke('updater:install');
  }

  ide.registerAction({ id: 'CheckForUpdates', title: tr('Check for Updates…'), run: () => check({ manual: true }) });

  // ---------- what's new ----------
  // After an update, the first window shows the CHANGELOG.md sections since the version that ran before (main decides,
  // once). Help > What's New shows every section up to this version. Lines are "- item" bullets with `code` spans.
  function notesBody(sections) {
    const body = el('div', 'upd-notes');
    for (const { version, text } of sections) {
      body.appendChild(el('h3', null, `PyIDE ${version}`));
      let list = null;
      for (const line of text.split('\n')) {
        if (!line.trim()) { list = null; continue; }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        if (bullet && !list) list = body.appendChild(el('ul'));
        const node = bullet ? list.appendChild(el('li')) : body.appendChild(el('p'));
        if (!bullet) list = null;
        (bullet ? bullet[1] : line).split('`').forEach((part, i) => { if (part) node.appendChild(i % 2 ? el('code', null, part) : document.createTextNode(part)); });
      }
    }
    return body;
  }
  function showNotes(version, sections) {
    const body = sections.length ? notesBody(sections) : el('p', null, tr('No release notes for this version.'));
    return ide.ui.dialog({ title: tr("What's New in PyIDE {version}", { version }), body, buttons: [{ label: tr('Close'), primary: true }], width: 620 });
  }
  ide.registerAction({ id: 'WhatsNew', title: tr("What's New"), run: async () => {
    const notes = await ide.api.invoke('updater:releaseNotes');
    showNotes(notes.version, notes.all);
  } });

  // ---------- automatic checks ----------
  // 3 s after startup, then whenever the interval has passed since the last check that read the feed (main keeps its
  // time across restarts, so a restart does not check again). "On startup only" checks once per start, as before.
  // After failed checks the next one comes sooner, backing off: 1/24 of the interval (an hour for daily), doubling up
  // to the interval. Nothing is checked while a check runs or an update downloads or waits for its restart, in Power
  // Save mode (`ide.powerSave.on()`) or while offline.
  const DAY = 24 * 3600 * 1000;
  const STARTUP_DELAY = 3000;
  const MAX_WAIT = 3600 * 1000; // looked at again at least hourly (sleep, clock changes, Power Save turned off)
  let timer = null;
  let started = false;
  let startupChecked = false;
  let decision = { reason: null, at: 0, due: null }; // the last scheduling decision, for ide.updater.status()
  let decisions = 0;
  const history = []; // automatic checks this session: {at, ok}

  const period = () => {
    const mode = ide.settings.get(INTERVAL, 'daily');
    return mode === 'startup' ? null : (state.intervalMs || DAY) * (mode === 'weekly' ? 7 : 1);
  };
  const retryDelay = (failures, p) => Math.min(p, (p / 24) * 2 ** (failures - 1));
  const nextDue = (p) => (state.failures > 0 && state.lastAttempt ? state.lastAttempt + retryDelay(state.failures, p) : (state.lastCheck || 0) + p);
  const powerSave = () => !!ide.powerSave?.on?.();

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, Math.min(ms, MAX_WAIT)));
  }

  async function tick() {
    timer = null;
    state = await ide.api.invoke('updater:state');
    const p = period();
    const now = Date.now();
    const due = p == null ? (startupChecked ? null : now) : nextDue(p);
    const reason = !ide.settings.get(ON_STARTUP, true) ? 'off'
      : !feed() ? 'noFeed'
      : due == null ? 'startupOnly'
      : ['checking', 'downloading', 'downloaded'].includes(state.phase) ? state.phase
      : powerSave() ? 'powerSave'
      : navigator.onLine === false ? 'offline'
      : due > now ? (state.failures ? 'backoff' : 'recent')
      : null;
    decision = { reason: reason || 'check', at: now, due };
    decisions++;
    if (!reason) {
      startupChecked = true;
      const result = await check();
      history.push({ at: now, ok: !!result });
      if (history.length > 50) history.shift();
      state = await ide.api.invoke('updater:state');
    }
    if (['off', 'noFeed', 'startupOnly'].includes(reason) || (p == null && startupChecked)) return; // a settings change schedules again
    if (p == null) schedule(60000);
    else schedule(!reason || reason === 'recent' || reason === 'backoff' ? nextDue(p) - Date.now() : Math.min(p, 5 * 60000));
  }

  ide.on('ready', async () => {
    state = await ide.api.invoke('updater:state');
    render();
    if (ide.detached) return;
    const notes = await ide.api.invoke('updater:releaseNotes');
    if (notes.afterUpdate.length) showNotes(notes.version, notes.afterUpdate);
    started = true;
    schedule(STARTUP_DELAY);
  });
  ide.on('settingsChanged', (key) => { if (started && [ON_STARTUP, INTERVAL, FEED].includes(key)) schedule(STARTUP_DELAY); });
  addEventListener('online', () => { if (started && decision.reason === 'offline') schedule(STARTUP_DELAY); });
  ide.on('powerSaveChanged', (on) => { if (started && !on && decision.reason === 'powerSave') schedule(STARTUP_DELAY); });

  ide.updater = {
    check: (opts) => check(opts),
    // The scheduler's last decision ({reason, at, due}), how many it made, the automatic checks and the interval.
    status: () => ({ ...decision, decisions, history: history.slice(), period: period(), retryDelay: (n) => retryDelay(n, period() ?? DAY) }),
  };

  // ---------- Settings > Updates ----------
  (ide.settingsPages ||= []).push({
    id: 'updates', title: () => tr('Updates'), defaults: DEFAULTS,
    keywords: 'updates update check feed latest.yml version skip restart daily weekly interval differential delta 업데이트 변경분 확인 피드 버전 건너뛰기 매일 매주',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Updates'));
      const auto = el('div', 'upd-auto');
      auto.append(ctx.ui.checkbox(ON_STARTUP, tr('Check for updates')),
        ctx.ui.selectInput(INTERVAL, [['startup', tr('On startup only')], ['daily', tr('Daily')], ['weekly', tr('Weekly')]], 'daily'));
      s.appendChild(auto);
      const input = el('input', 'upd-feed');
      input.dataset.key = FEED;
      input.placeholder = tr('Web address or local folder');
      input.value = ctx.value(FEED) ?? state.defaultFeed ?? '';
      input.oninput = () => ctx.set(FEED, input.value.trim());
      const browse = el('button', 'secondary', tr('Browse…'));
      browse.onclick = async () => {
        const dir = await ide.api.openFolder();
        if (dir) { input.value = dir; ctx.set(FEED, dir); }
      };
      const feedRow = el('div', 'upd-feed-row');
      feedRow.append(input, browse);
      s.appendChild(ctx.ui.fieldRow(tr('Update feed:'), feedRow, tr('An http(s) URL or a local folder with latest.yml. Leave it empty to turn updates off.')));
      s.appendChild(ctx.ui.checkbox(DIFFERENTIAL, tr('Download only the changed parts of an update when possible')));

      const info = ctx.ui.section(host, tr('This Installation'));
      const kinds = { nsis: tr('PyIDE installer (updates itself)'), msi: tr('MSI package (update with the new MSI)'), source: tr('Run from source (no updates)') };
      info.appendChild(ctx.ui.fieldRow(tr('Version:'), el('span', 'upd-version', state.version || '')));
      info.appendChild(ctx.ui.fieldRow(tr('Installed with:'), el('span', null, kinds[state.kind] || '')));
      if (state.lastCheck) info.appendChild(ctx.ui.fieldRow(tr('Last checked:'), el('span', 'upd-last-check', new Date(state.lastCheck).toLocaleString())));
      const skipped = ctx.value(SKIPPED);
      if (skipped) {
        const row = el('div', 'upd-skipped');
        const clear = el('button', 'secondary', tr('Clear'));
        clear.onclick = () => { ctx.set(SKIPPED, null); row.remove(); };
        row.append(el('span', null, skipped), clear);
        info.appendChild(ctx.ui.fieldRow(tr('Skipped version:'), row));
      }
      const now = el('button', 'secondary', tr('Check Now'));
      now.id = 'updatesCheckNow';
      now.onclick = () => check({ manual: true, feedUrl: String(ctx.value(FEED) ?? state.defaultFeed ?? '').trim() });
      info.appendChild(now);
    },
  });
})();
