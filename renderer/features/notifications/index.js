// The Notifications tool window (right side, as in PyCharm): this session's notifications from ide.notifications
// (renderer/core/notifications.js), newest first, with their actions while those are still valid, an unread badge on the
// stripe button, Clear All, and the notifications of earlier sessions from the event log (main/features/notifications.js).
(() => {
  const { el } = ide.util;
  const notes = ide.notifications;
  const invoke = (channel, ...args) => ide.api.invoke(channel, ...args);

  let previous = [];
  const persist = (e) => invoke('notifications:append', { time: e.time, title: e.title, text: e.text, kind: e.kind, group: e.group, raw: e.raw }).catch(() => {});
  // Notifications posted by plugins that loaded before this one.
  for (const e of notes.list()) persist(e);

  let host = null;
  const tw = ide.registerToolWindow({
    id: 'Notifications', title: tr('Notifications'), iconName: 'notifications', icon: '🔔', side: 'right', order: 20,
    mount(container) {
      host = el('div', 'notes-list');
      host.tabIndex = 0;
      container.appendChild(host);
    },
  });

  const KIND_LABEL = { info: () => tr('Information'), ok: () => tr('Information'), warn: () => tr('Warning'), error: () => tr('Error') };
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  const timeText = (t) => (sameDay(t, Date.now()) ? new Date(t).toLocaleTimeString() : new Date(t).toLocaleString());

  function item(e, { session }) {
    const row = el('div', `notes-item ${e.kind}${session && !e.read ? ' unread' : ''}${session ? '' : ' earlier'}`);
    if (session) row.dataset.note = e.id;
    const head = el('div', 'notes-head');
    head.appendChild(el('span', 'notes-title', e.title));
    head.appendChild(el('span', 'notes-time', timeText(e.time)));
    row.appendChild(head);
    if (e.text) {
      const text = el('div', 'notes-text', e.text);
      if (e.raw) text.dataset.userText = '';
      row.appendChild(text);
    }
    const foot = el('div', 'notes-foot');
    const meta = el('span', 'notes-meta', [KIND_LABEL[e.kind]?.(), e.group ? tr(e.group) : ''].filter(Boolean).join(' · '));
    foot.appendChild(meta);
    if (session) {
      for (const a of e.actions) {
        if (!notes.actionUsable(e, a)) continue;
        const link = el('button', 'notes-action', a.label);
        link.onclick = () => { notes.runAction(e, a); render(); };
        foot.appendChild(link);
      }
    }
    row.appendChild(foot);
    return row;
  }

  function render() {
    if (!host) return;
    const session = notes.list().reverse();
    host.replaceChildren();
    if (!session.length && !previous.length) {
      host.appendChild(el('div', 'notes-empty', tr('No notifications')));
    }
    for (const e of session) host.appendChild(item(e, { session: true }));
    if (previous.length) {
      host.appendChild(el('div', 'notes-section', tr('Earlier sessions')));
      for (const e of previous.slice().reverse()) host.appendChild(item(e, { session: false }));
    }
    renderActions();
  }

  function renderActions() {
    const actions = [
      { id: 'markRead', icon: 'check', title: tr('Mark All as Read'), run: () => notes.markAllRead() },
      { id: 'clearAll', icon: 'clear', title: tr('Clear All'), run: clearAll },
    ];
    if (notes.hiddenGroups().length) {
      actions.push({ id: 'restoreGroups', icon: 'reset', title: tr('Show Balloons Again ({groups})', { groups: notes.hiddenGroups().map((g) => tr(g)).join(', ') }),
        run: () => { for (const g of notes.hiddenGroups()) notes.setGroupHidden(g, false); } });
    }
    tw.setActions(actions);
  }

  async function clearAll() {
    notes.clear();
    previous = [];
    await invoke('notifications:clear').catch(() => {});
    render();
  }

  function updateBadge() {
    const n = notes.unread();
    tw.setBadge(n ? String(n) : '');
    tw.button.title = n ? tr('Notifications: {n} unread', { n }) : tr('Notifications');
  }

  let renderFrame = 0;
  const renderSoon = () => { if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; if (tw.isVisible()) render(); }); };

  ide.on('notificationsChanged', (change) => {
    if (change?.type === 'added') {
      persist(change.entry);
      if (tw.isVisible() && document.hasFocus()) change.entry.read = true;
    }
    updateBadge();
    renderSoon();
  });
  ide.on('toolWindowShown', (id) => { if (id === 'Notifications') { render(); notes.markAllRead(); } });
  ide.on('settingsChanged', (key) => { if (key === 'notifications.hiddenGroups') renderActions(); });

  ide.registerAction({ id: 'ActivateNotificationsToolWindow', title: tr('Notifications'), run: () => tw.show() });
  ide.registerAction({ id: 'ClearAllNotifications', title: tr('Clear All Notifications'), run: clearAll });

  invoke('notifications:previous').then((list) => { previous = Array.isArray(list) ? list : []; render(); }).catch(() => {});
  updateBadge();
  render();
})();
