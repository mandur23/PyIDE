(() => {
  const { el } = ide.util;
  const ICON = { error: '✖', warning: '▲', info: 'ℹ' };
  let list;

  const tw = ide.registerToolWindow({
    id: 'Problems', title: 'Problems', icon: '⚠', side: 'bottom', keys: 'Alt+6', order: 40,
    mount(container) {
      list = el('div', 'list');
      list.id = 'problemList';
      container.appendChild(list);
    },
  });

  function render() {
    const all = ide.problems.all().sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    list.innerHTML = '';
    for (const p of all) {
      const row = el('div', 'list-row problem');
      row.appendChild(el('span', `sev ${p.severity || 'error'}`, ICON[p.severity || 'error']));
      row.appendChild(el('span', null, `${ide.util.rel(p.path)}:${p.line}:${p.col || 1}  ${p.msg}`));
      row.appendChild(el('span', 'muted', `  ${p.source}`));
      row.onclick = () => ide.openFile(p.path, { line: p.line, col: p.col });
      list.appendChild(row);
    }
    if (!all.length) list.appendChild(el('div', 'list-row muted', 'No problems found'));
    const errors = all.filter((p) => (p.severity || 'error') === 'error').length;
    tw.setBadge(errors ? String(errors) : '');
  }

  ide.on('problemsChanged', render);
  render();
})();
