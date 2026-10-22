// File › Power Save Mode (PyCharm's TogglePowerSave). The state lives in the core (ide.powerSave, setting
// powerSave.enabled, kept across restarts) so every feature can follow it through powerSaveChanged; this plugin adds the
// action, the status bar indicator and its menu. mainmenu.js lists the action in the File menu with a check mark.
(() => {
  const { el } = ide.util;

  const item = el('button', 'power-save-status hidden');
  item.id = 'powerSaveStatus';
  // A battery with a leaf-like bolt, drawn in the status bar's text color.
  item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4.5" width="11" height="7" rx="1.5" fill="none" stroke="currentColor"/><rect x="13" y="6.5" width="1.5" height="3" rx=".5" fill="currentColor"/><path d="M7.6 5.6 5.2 8.4h2l-.8 2 2.4-2.8h-2z" fill="currentColor"/></svg>';
  const label = el('span', 'power-save-label', tr('Power Save Mode'));
  item.appendChild(label);
  item.onclick = (e) => {
    const r = item.getBoundingClientRect();
    const menu = ide.ui.contextMenu(r.left, r.top - 4, [
      { header: tr('Code analysis and background tasks are disabled.') },
      { label: tr('Disable Power Save Mode'), run: () => ide.powerSave.set(false) },
    ]);
    menu.id = 'powerSaveMenu';
    menu.style.top = `${Math.max(4, r.top - menu.offsetHeight - 4)}px`;
    e.stopPropagation();
  };
  ide.registerStatusItem({ order: 4, el: item });

  function render() {
    const on = ide.powerSave.on();
    item.classList.toggle('hidden', !on);
    item.title = `${tr('Power Save Mode: on')}\n${tr('Code analysis and background tasks are disabled.')}`;
  }
  ide.on('powerSaveChanged', render);
  render();

  ide.registerAction({ id: 'TogglePowerSave', title: tr('Power Save Mode'), run: () => ide.powerSave.set(!ide.powerSave.on()) });
})();
