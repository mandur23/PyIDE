// File › Manage IDE Settings › Export Settings… / Import Settings…, as in PyCharm. Export asks which categories to
// include, then where to save the .zip; import picks a .zip, checks it, lists the categories it holds, backs up the
// current state and applies the chosen ones, then offers a restart. The archive is built and read in main
// (main/features/settings-sync.js, main/settings-sync/archive.js). The renderer owns settings.json (ide.settings), so
// the imported keys, keymap, live templates and recent projects are set here, and data sources go through the
// Database plugin while it runs.
(() => {
  const { el, basename, samePath } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(`settings:${ch}`, ...args);

  const LABELS = {
    appearance: () => tr('Appearance and editor settings'),
    keymap: () => tr('Keymap'),
    liveTemplates: () => tr('Live templates'),
    codeStyle: () => tr('Code style'),
    plugins: () => tr('Plugins (enabled state)'),
    dataSources: () => tr('Database data sources (without passwords)'),
    scratches: () => tr('Scratch files'),
    recentProjects: () => tr('Recent projects list'),
  };
  const size = (b) => (b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
  function detail(c) {
    const { count } = c;
    switch (c.id) {
      case 'appearance':
      case 'codeStyle': return tr('{count} settings', { count });
      case 'keymap': return tr('{count} changed actions', { count });
      case 'liveTemplates': return tr('{count} changes', { count });
      case 'plugins': return count ? tr('{count} disabled', { count }) : tr('all enabled');
      case 'dataSources': return tr('{count} data sources', { count });
      case 'scratches': return c.bytes == null ? tr('{count} files', { count }) : tr('{count} files, {size}', { count, size: size(c.bytes) });
      case 'recentProjects': return tr('{count} projects', { count });
      default: return '';
    }
  }

  // Resolves to the ticked category ids, or null when cancelled.
  function chooseCategories({ title, intro, note, categories, okLabel }) {
    return new Promise((resolve) => {
      let picked = null;
      const body = el('div', 'settings-sync');
      body.append(el('div', 'settings-sync-intro', intro));
      const list = el('div', 'settings-sync-list');
      const boxes = [];
      for (const c of categories) {
        const row = el('label', `settings-sync-row${c.available === false ? ' disabled' : ''}`);
        const box = el('input');
        box.type = 'checkbox';
        box.checked = !!c.checked;
        box.disabled = c.available === false;
        box.dataset.category = c.id;
        row.append(box, el('span', 'settings-sync-name', LABELS[c.id]?.() || c.id), el('span', 'settings-sync-detail', c.available === false ? tr('nothing to export') : detail(c)));
        boxes.push(box);
        list.append(row);
      }
      body.append(list);
      if (note) body.append(el('div', 'settings-sync-note', note));
      const dlg = ide.ui.dialog({
        title,
        body,
        width: 520,
        onClose: () => resolve(picked),
        buttons: [
          { label: okLabel, primary: true, run: () => {
            const ids = boxes.filter((b) => b.checked && !b.disabled).map((b) => b.dataset.category);
            if (!ids.length) return false;
            picked = ids;
            return true;
          } },
          { label: tr('Cancel') },
        ],
      });
      const primary = dlg.el.querySelector('.dialog-buttons .primary');
      const sync = () => { primary.disabled = !boxes.some((b) => b.checked && !b.disabled); };
      for (const b of boxes) b.addEventListener('change', sync);
      sync();
    });
  }

  function errorText(r) {
    switch (r.code) {
      case 'notZip': return tr('The file is not a ZIP archive, or it is damaged.');
      case 'noManifest': return tr('The archive is not a Nano Studio settings file: it has no pyide-settings.json.');
      case 'badManifest': return tr('The pyide-settings.json in the archive is not valid.');
      case 'newerFormat': return tr('These settings were exported by a newer Nano Studio ({version}, format {format}). Update Nano Studio to import them.', { version: r.version || '?', format: r.format });
      case 'unsafeEntry': return tr('The archive contains an unsafe path, so nothing was imported: {name}', { name: r.detail });
      case 'badEntry': return tr('The archive entry {name} is damaged.', { name: r.detail });
      case 'tooLarge': return r.size && r.limit
        ? tr('The archive is too large: {size}, at most {limit} is allowed.', { size: size(r.size), limit: size(r.limit) })
        : tr('The archive is too large.');
      case 'tooManyEntries': return tr('The archive has too many entries: {count}, at most {limit} are allowed.', { count: r.count, limit: r.limit });
      case 'overlap': return tr('The archive is malformed: several entries share the same data, as in a ZIP bomb, so nothing was imported.');
      case 'busy': return tr('Another import is still running.');
      default: return tr('Error: {detail}', { detail: r.detail || r.code });
    }
  }

  // Messages carry file names and paths: always text, never markup.
  function message(title, lines, cls = '', buttons) {
    const body = el('div', `settings-sync-message ${cls}`);
    for (const line of [].concat(lines).filter(Boolean)) body.append(el('div', 'settings-sync-line', line));
    return ide.ui.dialog({ title, body, width: 540, buttons });
  }

  // ---------- export ----------
  async function exportSettings() {
    ide.settings.flush();
    const title = tr('Export Settings');
    const ids = await chooseCategories({
      title,
      intro: tr('Select the settings to export:'),
      note: tr('Passwords, API keys and other secrets are never exported, nor are paths that only exist on this computer (interpreters, trusted projects).'),
      categories: await invoke('exportInfo'),
      okLabel: tr('Export'),
    });
    if (!ids) return null;
    const file = await invoke('chooseExportFile', title);
    if (!file) return null;
    const r = await invoke('export', file, ids);
    if (!r.ok) return message(title, errorText(r), 'error');
    return message(title, tr('Settings exported to {path}', { path: file }), 'done', [
      { label: tr('OK'), primary: true },
      { label: tr('Show in Explorer'), run: () => ide.api.invoke('shell:showInFolder', file) },
    ]);
  }

  // ---------- import ----------
  async function applyImported(r) {
    const notes = [];
    for (const [k, v] of Object.entries(r.settings || {})) ide.settings.set(k, v);
    if (r.keymap) ide.settings.set('keymap.overrides', r.keymap);
    if (r.liveTemplates) {
      const current = ide.settings.get('liveTemplates.custom', {}) || {};
      const replaced = Object.keys(r.liveTemplates.custom)
        .filter((a) => Object.hasOwn(current, a) && JSON.stringify(current[a]) !== JSON.stringify(r.liveTemplates.custom[a]));
      ide.settings.set('liveTemplates.custom', { ...current, ...r.liveTemplates.custom });
      ide.settings.set('liveTemplates.postfixDisabled', r.liveTemplates.postfixDisabled);
      if (replaced.length) notes.push(tr('Live templates replaced by the imported ones: {names}', { names: replaced.join(', ') }));
    }
    if (r.recentProjects) {
      const current = ide.settings.get('recentProjects', []);
      const merged = [...current, ...r.recentProjects.filter((p) => !current.some((c) => samePath(c.path, p.path)))]
        .sort((a, b) => (b.opened || 0) - (a.opened || 0)).slice(0, 15);
      ide.settings.set('recentProjects', merged);
    }
    if (r.dataSources?.length) {
      const failed = [];
      for (const s of r.dataSources) {
        try { await ide.database.addDataSource(s); } catch { failed.push(s.name || s.id); }
      }
      if (failed.length) notes.push(tr('Data sources not imported: {names}', { names: failed.join(', ') }));
    }
    if (r.scratches?.added.length) notes.push(tr('{count} scratch files added', { count: r.scratches.added.length }));
    ide.settings.flush();
    return notes;
  }

  async function importSettings() {
    const title = tr('Import Settings');
    const file = await invoke('chooseImportFile', title);
    if (!file) return null;
    const info = await invoke('inspect', file);
    if (!info.ok) return message(title, [tr('Cannot import {name}', { name: basename(file) }), errorText(info)], 'error');
    if (!info.categories.length) return message(title, tr('The archive holds no settings Nano Studio can import.'), 'error');
    const date = info.created ? new Date(info.created) : null;
    const ids = await chooseCategories({
      title,
      intro: info.version && date && !Number.isNaN(+date)
        ? tr('Settings exported from {product} {version} on {date}. Select the settings to import:', { product: info.product || 'Nano Studio', version: info.version, date: date.toLocaleString(i18n.locale) })
        : tr('Select the settings to import:'),
      note: tr('Your current settings are backed up first. Imported settings replace the current ones with the same name.'),
      categories: info.categories.map((c) => ({ ...c, checked: true })),
      okLabel: tr('Import'),
    });
    if (!ids) return null;
    ide.settings.flush();
    const r = await invoke('import', file, ids, { databaseLoaded: !!ide.database });
    if (!r.ok) return message(title, [tr('Cannot import {name}', { name: basename(file) }), errorText(r)], 'error');
    const notes = await applyImported(r);
    return message(tr('Settings Imported'), [
      tr('Imported: {categories}.', { categories: r.applied.map((id) => LABELS[id]()).join(', ') }),
      ...notes,
      tr('Your previous settings were backed up to {path}', { path: r.backup }),
      tr('Some settings take effect after a restart. Restart Nano Studio now?'),
    ], 'done', [
      { label: tr('Restart'), primary: true, run: () => ide.restart() },
      { label: tr('Not Now') },
    ]);
  }

  ide.registerAction({ id: 'ExportSettings', title: tr('Export Settings…'), run: () => exportSettings() });
  ide.registerAction({ id: 'ImportSettings', title: tr('Import Settings…'), run: () => importSettings() });
  ide.settingsSync = { exportSettings, importSettings };
})();
