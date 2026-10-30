(() => {
  const { el } = ide.util;
  const ICON = { error: 'error', warning: 'warning', info: 'info' };
  const SEVERITY_TITLE = { error: () => tr('Error'), warning: () => tr('Warning'), info: () => tr('Information') };
  let list;

  const tw = ide.registerToolWindow({
    id: 'Problems', title: tr('Problems'), icon: '⚠', side: 'bottom', keys: 'Alt+6', order: 40,
    mount(container) {
      list = el('div', 'list');
      list.id = 'problemList';
      ide.ui.listKeys(list, { rows: '.problem' });
      container.appendChild(list);
    },
  });

  function render() {
    const all = ide.problems.all().sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    list.innerHTML = '';
    for (const p of all) {
      const row = el('div', 'list-row problem');
      const sev = Object.assign(ide.icon(ICON[p.severity || 'error']), { className: `ide-icon sev ${p.severity || 'error'}` });
      sev.title = SEVERITY_TITLE[p.severity || 'error']();
      row.appendChild(sev);
      // Location, the inspection's own message and its tool name are data, not UI text.
      const text = el('span', null, `${ide.util.rel(p.path)}:${p.line}:${p.col || 1}  ${p.msg}`);
      const source = el('span', 'muted', `  ${p.source}`);
      text.dataset.userText = source.dataset.userText = '';
      row.append(text, source);
      row.onclick = () => ide.openFile(p.path, { line: p.line, col: p.col });
      list.appendChild(row);
    }
    if (!all.length) list.appendChild(el('div', 'list-row muted', tr('No problems found')));
    const errors = all.filter((p) => (p.severity || 'error') === 'error').length;
    tw.setBadge(errors ? String(errors) : '');
  }

  ide.on('problemsChanged', render);
  render();
})();
