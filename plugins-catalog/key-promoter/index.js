(() => {
  const { el } = ide.util;
  const counts = new Map();
  const host = el('div', 'key-promoter-host');
  document.body.appendChild(host);

  // Shortcuts are shown in tooltips as "Name (Keys)"; that suffix is what the user could have pressed.
  const CHORD = /\(((?:(?:Ctrl|Alt|Shift)\+)*(?:F\d{1,2}|[A-Z0-9]|Insert|Delete|Esc|Enter)(?:, [^)]+)?)\)\s*$/;

  function toast(name, keys, n) {
    const t = el('div', 'key-promoter-toast');
    const head = el('div', 'key-promoter-keys', keys);
    const body = el('div', null, tr('{name} — clicked {count} times without the shortcut', { name, count: n }));
    t.append(head, body);
    host.appendChild(t);
    setTimeout(() => t.classList.add('fade'), 3200);
    setTimeout(() => t.remove(), 3700);
  }

  addEventListener('click', (e) => {
    if (!e.isTrusted && !e.detail) return;
    const target = e.target.closest?.('[title]');
    const m = target?.title.match(CHORD);
    if (!m) return;
    const name = target.title.slice(0, m.index).trim();
    const n = (counts.get(name) || 0) + 1;
    counts.set(name, n);
    toast(name, m[1], n);
  }, true);
})();
