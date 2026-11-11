(() => {
  const { el } = ide.util;
  const ICON = { error: 'error', warning: 'warning', info: 'info' };
  const SEVERITIES = ['error', 'warning', 'info'];
  const SEVERITY_TITLE = { error: () => tr('Error'), warning: () => tr('Warning'), info: () => tr('Information') };
  const FILTER_TITLE = { error: () => tr('Errors'), warning: () => tr('Warnings'), info: () => tr('Information') };
  // As in PyCharm: problems grouped by file, a file with many of them starts collapsed, and the toolbar's toggles hide
  // a severity. Both are kept for the session.
  const COLLAPSE_OVER = 50;
  const hidden = new Set();
  const collapsed = new Map(); // path lower -> true/false once the user toggled it
  let list;
  let bar;

  const tw = ide.registerToolWindow({
    id: 'Problems', title: tr('Problems'), icon: '⚠', side: 'bottom', keys: 'Alt+6', order: 40,
    mount(container) {
      bar = el('div', 'problems-bar');
      list = el('div', 'list');
      list.id = 'problemList';
      ide.ui.listKeys(list, {
        rows: '.problem-file, .problem',
        open: (row) => row._open(),
        expanded: (row) => (row.classList.contains('problem-file') ? !row.classList.contains('collapsed') : null),
        toggle: (row) => row._toggle(),
      });
      container.append(bar, list);
    },
  });

  const sevOf = (p) => p.severity || 'error';

  // The toggles are made once and updated, so a click is never on a button that a redraw just replaced.
  function renderBar(all) {
    if (!bar.childElementCount) {
      bar.append(...SEVERITIES.map((s) => {
        const b = el('button', `problems-filter ${s}`);
        b.dataset.severity = s;
        b.append(Object.assign(ide.icon(ICON[s]), { className: `ide-icon sev ${s}` }), el('span'));
        b.onclick = () => { hidden.has(s) ? hidden.delete(s) : hidden.add(s); render(); };
        return b;
      }));
    }
    for (const b of bar.children) {
      const s = b.dataset.severity;
      b.classList.toggle('on', !hidden.has(s));
      b.title = hidden.has(s) ? tr('Show {kind}', { kind: FILTER_TITLE[s]() }) : tr('Hide {kind}', { kind: FILTER_TITLE[s]() });
      b.setAttribute('aria-pressed', String(!hidden.has(s)));
      b.lastChild.textContent = `${FILTER_TITLE[s]()} ${all.filter((p) => sevOf(p) === s).length}`;
    }
  }

  function render() {
    const all = ide.problems.all();
    renderBar(all);
    const byFile = new Map();
    for (const p of all.filter((p) => !hidden.has(sevOf(p))).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || (a.col || 1) - (b.col || 1))) {
      const key = p.path.toLowerCase();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(p);
    }
    const nodes = [];
    for (const [key, items] of byFile) {
      const path = items[0].path;
      const shut = collapsed.get(key) ?? (byFile.size > 1 && items.length > COLLAPSE_OVER);
      const head = el('div', `list-row problem-file${shut ? ' collapsed' : ''}`);
      head.dataset.depth = '0';
      head.dataset.key = key;
      head.append(ide.icon('chevronDown', '▾'), ide.fileIcon(path));
      const name = el('span', 'problem-path', ide.util.rel(path));
      name.dataset.userText = '';
      head.append(name, el('span', 'muted', tr('{n} problems', { n: items.length })));
      head._toggle = () => { collapsed.set(key, !head.classList.contains('collapsed')); render(); };
      head._open = () => ide.openFile(path, { line: items[0].line, col: items[0].col });
      head.onclick = head._toggle;
      head.ondblclick = head._open;
      nodes.push(head);
      if (shut) continue;
      for (const p of items) {
        const row = el('div', 'list-row problem');
        row.dataset.depth = '1';
        row.dataset.path = p.path;
        row.dataset.key = `${key}:${p.line}:${p.col}:${p.source}:${p.msg}`;
        const sev = Object.assign(ide.icon(ICON[sevOf(p)]), { className: `ide-icon sev ${sevOf(p)}` });
        sev.title = SEVERITY_TITLE[sevOf(p)]();
        // The inspection's own message, its tool name and the place are data, not UI text.
        const text = el('span', 'problem-msg', p.msg);
        const source = el('span', 'muted', `  ${p.source}`);
        const at = el('span', 'muted problem-at', `  ${p.line}:${p.col || 1}`);
        text.dataset.userText = source.dataset.userText = at.dataset.userText = '';
        row.append(sev, text, source, at);
        row._open = row.onclick = () => ide.openFile(p.path, { line: p.line, col: p.col });
        nodes.push(row);
      }
    }
    if (!nodes.length) nodes.push(el('div', 'list-row muted', all.length ? tr('No problems of the shown kinds') : tr('No problems found')));
    const sel = list.querySelector('.selected')?.dataset.key;
    list.replaceChildren(...nodes);
    if (sel) for (const r of list.querySelectorAll('.problem-file, .problem')) r.classList.toggle('selected', r.dataset.key === sel);
    const errors = all.filter((p) => sevOf(p) === 'error').length;
    tw.setBadge(errors ? String(errors) : '');
  }

  // A project's diagnostics arrive a file at a time; draw once per frame.
  let frame = 0;
  ide.on('problemsChanged', () => { frame ||= requestAnimationFrame(() => { frame = 0; render(); }); });
  render();
})();
