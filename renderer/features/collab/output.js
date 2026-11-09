// What the host's runs print, read along by a collaboration session's guests: the host's window sends its Run output
// (runOutput, from the run plugin) and each guest shows it in the Host Output tool window. The guest runs nothing.
// Also the chat of the session, at the bottom of the Collaboration tool window.
(() => {
  const { el } = ide.util;
  const C = ide.collab;
  if (!C) return;
  const api = ide.api;

  // ---------- host ----------
  let batch = null; // {name, text, kind}
  let timer = null;
  const flush = () => {
    timer = null;
    if (batch) api.send('collab:runOutput', batch);
    batch = null;
  };
  const live = () => C.state().role === 'host' && C.state().people.length > 1;
  ide.on('runSessionStarting', (s) => {
    if (!live()) return;
    flush();
    api.send('collab:runOutput', { name: s?.title || '', text: '', start: true });
  });
  ide.on('runOutput', ({ name, text, kind }) => {
    if (!live() || typeof text !== 'string') return;
    if (batch && (batch.name !== name || batch.kind !== kind || batch.text.length > 32768)) flush();
    batch = batch || { name, text: '', kind };
    batch.text += text;
    if (!timer) timer = setTimeout(flush, 80);
  });

  // ---------- guest ----------
  let con = null;
  let shownName = null;
  const tw = ide.registerToolWindow({
    id: 'CollabOutput', title: tr('Host Output'), icon: '▶', iconName: 'run', side: 'bottom', order: 95,
    mount(container) {
      container.classList.add('collab-output');
      con = ide.ui.console(container, {});
    },
  });
  C.on('run', (e) => {
    if (C.state().role !== 'guest' || !con) return;
    const name = typeof e.name === 'string' ? e.name : '';
    if (e.start || name !== shownName) {
      if (e.start) con.clear();
      con.append(`${tr('{host} runs {name}', { host: C.state().info?.host || tr('the host'), name })}\n`, 'sys');
      shownName = name;
      if (e.start) tw.show();
    }
    if (typeof e.text === 'string' && e.text) con.append(e.text, e.kind === 'err' ? 'err' : e.kind === 'sys' ? 'sys' : null);
  });
  C.on('ended', () => { con?.clear(); shownName = null; });

  // ---------- chat ----------
  const panel = C.panel;
  if (!panel) return;
  const head = el('div', 'collab-head hidden', tr('Chat'));
  const list = el('div', 'collab-chat hidden');
  const input = el('input', 'collab-chat-input hidden');
  input.placeholder = tr('Message everyone in the session');
  input.maxLength = 4000;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
    e.preventDefault();
    api.send('collab:chat', input.value);
    input.value = '';
  });
  panel.append(head, list, input);
  let unread = 0;
  C.on('chat', (m) => {
    if (typeof m.text !== 'string') return;
    const p = C.person(m.id);
    const row = el('div', `collab-chat-row collab-c${(p?.color ?? m.id) % 8}`);
    row.append(el('span', 'collab-chat-name', `${m.name || p?.name || ''}: `), el('span', 'collab-chat-text', m.text));
    list.appendChild(row);
    while (list.childElementCount > 200) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
    const tool = ide.toolWindows.get('Collaboration');
    if (m.id !== C.me() && !tool?.isVisible()) { unread++; tool?.setBadge(String(unread)); }
  });
  ide.on('toolWindowShown', (id) => { if (id === 'Collaboration' && unread) { unread = 0; ide.toolWindows.get('Collaboration')?.setBadge(''); } });
  C.on('rendered', () => {
    const on = !!C.state().role && (C.state().role === 'host' || !!C.state().info);
    for (const n of [head, list, input]) n.classList.toggle('hidden', !on);
  });
  C.on('ended', () => list.replaceChildren());
  C.render();
})();
