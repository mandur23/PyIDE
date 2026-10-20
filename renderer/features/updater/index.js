// Updates: checks the update feed on startup and from Help > Check for Updates…, downloads in the background with
// progress in the status bar, then offers Restart to Update (NSIS installs) or Download the new installer (MSI).
(() => {
  const { el } = ide.util;
  const FEED = 'updates.feedUrl';
  const ON_STARTUP = 'updates.checkOnStartup';
  const SKIPPED = 'updates.skippedVersion';
  const DEFAULTS = { [ON_STARTUP]: true };
  const log = ide.logger?.('#updater') || console;
  let state = { phase: 'idle' };

  const feed = () => String(ide.settings.get(FEED, '') || '').trim();

  // ---------- status bar ----------
  const item = el('span', 'upd-status hidden');
  item.id = 'updateStatus';
  item.onclick = () => (state.phase === 'downloaded' ? offerRestart() : null);
  ide.registerStatusItem({ order: 7, el: item });
  function render() {
    let text = '';
    if (state.phase === 'downloading') text = tr('Downloading PyIDE {version}… {percent}%', { version: state.available, percent: state.percent || 0 });
    else if (state.phase === 'downloaded') text = tr('Restart to Update');
    item.textContent = text;
    item.title = state.phase === 'downloaded' ? tr('PyIDE {version} is ready to install', { version: state.available }) : '';
    item.classList.toggle('hidden', !text);
    item.classList.toggle('ready', state.phase === 'downloaded');
  }
  ide.api.on('updater:state', (s) => {
    const was = state.phase;
    state = s;
    render();
    if (s.phase === 'downloaded' && was !== 'downloaded') offerRestart();
  });

  const message = (title, text, buttons) => {
    const body = el('div', 'upd-message');
    for (const line of [].concat(text)) body.appendChild(el('p', null, line));
    return ide.ui.dialog({ title, body, buttons, width: 460 });
  };
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
      else ide.api.invoke('updater:download').catch((err) => {
        log.warn(`update download failed: ${reasonOf(err)}`);
        message(tr('Update'), [tr('Could not download PyIDE {version}.', { version }), reasonOf(err)], [{ label: tr('Close'), primary: true }]);
      });
    } else if (state.kind === 'msi') {
      message(tr('Update Available'), [tr('PyIDE {version} is available. You have {current}.', { version, current: state.version }),
        tr('This copy was installed from an MSI package, so update it with the new MSI installer.')], [
        { label: tr('Download the new installer'), primary: true, run: () => ide.api.invoke('updater:openInstaller') }, skip(version), later]);
    } else {
      message(tr('Update Available'), [tr('PyIDE {version} is available. You have {current}.', { version, current: state.version }),
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

  ide.on('ready', async () => {
    state = await ide.api.invoke('updater:state');
    render();
    if (ide.detached || !ide.settings.get(ON_STARTUP, true) || !feed()) return;
    setTimeout(() => check(), 3000);
  });

  // ---------- Settings > Updates ----------
  (ide.settingsPages ||= []).push({
    id: 'updates', title: () => tr('Updates'), defaults: DEFAULTS,
    keywords: 'updates update check feed latest.yml version skip restart 업데이트 확인 피드 버전 건너뛰기',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Updates'));
      s.appendChild(ctx.ui.checkbox(ON_STARTUP, tr('Check for updates on startup')));
      const input = el('input', 'upd-feed');
      input.dataset.key = FEED;
      input.placeholder = tr('Web address or local folder');
      input.value = ctx.value(FEED) || '';
      input.oninput = () => ctx.set(FEED, input.value.trim());
      const browse = el('button', 'secondary', tr('Browse…'));
      browse.onclick = async () => {
        const dir = await ide.api.openFolder();
        if (dir) { input.value = dir; ctx.set(FEED, dir); }
      };
      const feedRow = el('div', 'upd-feed-row');
      feedRow.append(input, browse);
      s.appendChild(ctx.ui.fieldRow(tr('Update feed:'), feedRow, tr('An http(s) URL or a local folder with latest.yml. Leave it empty to turn updates off.')));

      const info = ctx.ui.section(host, tr('This Installation'));
      const kinds = { nsis: tr('PyIDE installer (updates itself)'), msi: tr('MSI package (update with the new MSI)'), source: tr('Run from source (no updates)') };
      info.appendChild(ctx.ui.fieldRow(tr('Version:'), el('span', 'upd-version', state.version || '')));
      info.appendChild(ctx.ui.fieldRow(tr('Installed with:'), el('span', null, kinds[state.kind] || '')));
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
      now.onclick = () => check({ manual: true, feedUrl: String(ctx.value(FEED) || '').trim() });
      info.appendChild(now);
    },
  });
})();
