// Background tasks and notifications, as in PyCharm (see FEATURES.md, "Background tasks and notifications").
// ide.tasks: long-running work shown in the status bar (title and progress bar, "N processes running", a popup with
// every task and its Cancel button). ide.notifications: balloons in the lower right, kept for the session (and the last
// 200 across restarts) by the Notifications tool window (renderer/features/notifications).
(() => {
  const { el } = ide.util;

  // ---------- background tasks ----------
  const tasks = new Map(); // id -> task, in start order
  let taskSeq = 0;
  const clampFraction = (f) => (typeof f === 'number' && Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : null);
  const taskInfo = (t) => ({ id: t.id, title: t.title, text: t.text, fraction: t.fraction, cancellable: t.cancellable, startedAt: t.startedAt });
  let renderTasksLater = () => {}; // the status bar widget, below (main window only)
  const tasksChanged = () => { ide.emit('tasksChanged', listTasks()); renderTasksLater(); };
  const listTasks = () => [...tasks.values()].map(taskInfo);

  // start({title, text?, fraction?, cancellable?, onCancel?}) -> {id, update({fraction?, text?, title?}), done(), fail(err), cancelled, active}
  // fraction is 0..1; leave it out (or null) for an indeterminate bar. A task with onCancel is cancellable unless
  // cancellable is false. Cancel calls onCancel and removes the task; later update/done/fail calls are ignored.
  function startTask({ title, text = '', fraction, cancellable, onCancel } = {}) {
    const t = {
      id: ++taskSeq, title: String(title || ''), text: String(text || ''), fraction: clampFraction(fraction),
      cancellable: cancellable ?? typeof onCancel === 'function', onCancel, startedAt: Date.now(), cancelled: false,
    };
    tasks.set(t.id, t);
    const finish = () => { if (!tasks.delete(t.id)) return false; tasksChanged(); return true; };
    const handle = {
      id: t.id,
      get active() { return tasks.has(t.id); },
      get cancelled() { return t.cancelled; },
      update({ fraction: f, text: s, title: name } = {}) {
        if (!tasks.has(t.id)) return;
        if (f !== undefined) t.fraction = clampFraction(f);
        if (s !== undefined) t.text = String(s || '');
        if (name !== undefined) t.title = String(name || '');
        tasksChanged();
      },
      done() { finish(); },
      // err (an Error or text) also posts an error notification; fail() without one only ends the task.
      fail(err) {
        if (!finish() || !err) return;
        notify({ title: tr('{title} failed', { title: t.title }), text: String(err?.message || err), kind: 'error', group: 'Background Tasks', raw: true });
      },
    };
    tasksChanged();
    return handle;
  }

  function cancelTask(id) {
    const t = tasks.get(id);
    if (!t || !t.cancellable) return false;
    t.cancelled = true;
    tasks.delete(id);
    tasksChanged();
    try { t.onCancel?.(); } catch (err) { console.error('background task cancel failed', err); }
    return true;
  }

  ide.tasks = { start: startTask, list: listTasks, cancel: cancelTask };

  // ---------- notifications ----------
  const KINDS = { info: 'info', ok: 'ok', success: 'ok', warn: 'warn', warning: 'warn', error: 'error' };
  const history = []; // this session's notifications, oldest first
  let noteSeq = 0;
  const hiddenGroups = () => ide.settings.get('notifications.hiddenGroups', []);
  const notesChanged = (change) => ide.emit('notificationsChanged', change);

  const balloons = el('div', 'ide-balloons');
  balloons.id = 'balloons';
  document.body.appendChild(balloons);

  // The IDE log (diagnostics plugin) for error notifications.
  const logAction = () => ({ label: tr('Show Log'), log: true, valid: () => ide.actions.some((a) => a.id === 'OpenLogInEditor'), run: () => ide.runAction('OpenLogInEditor') });

  // notify({title, text?, kind?: 'info'|'ok'|'warn'|'error', group?, actions?: [{label, run(note), valid?()}], raw?,
  //   timeout?, balloon?, onClick?, balloonClass?}) -> note {id, entry, balloon, expire(), remove()}
  // raw: the text is user data (program output, paths) and is not translated. An action stays usable in the
  // Notifications tool window until the note expires (note.expire(), or valid() turns false). balloon: false only
  // records it. A group the user muted with Don't Show Again is recorded without a balloon.
  function notify(opts = {}) {
    const entry = {
      id: ++noteSeq, time: Date.now(), title: String(opts.title || ''), text: String(opts.text || '').trim(),
      kind: KINDS[opts.kind] || 'info', group: String(opts.group || ''), raw: !!opts.raw, read: false, expired: false,
      actions: (opts.actions || []).filter((a) => a && a.label && typeof a.run === 'function'),
    };
    if (entry.kind === 'error' && !entry.actions.some((a) => a.log)) entry.actions.push(logAction());
    history.push(entry);
    if (history.length > 1000) history.shift(); // a long session keeps its last 1000
    const note = {
      id: entry.id, entry, balloon: null,
      get expired() { return entry.expired; },
      expire() { if (entry.expired) return; entry.expired = true; note.remove(); notesChanged({ type: 'expired', entry }); },
      // Hides the balloon; the notification stays in the tool window.
      remove() { note.balloon?.remove(); },
    };
    entry.note = note;
    const muted = entry.group && hiddenGroups().includes(entry.group);
    if (opts.balloon !== false && !muted) note.balloon = showBalloon(entry, note, opts);
    notesChanged({ type: 'added', entry });
    return note;
  }

  const actionUsable = (entry, a) => !entry.expired && (typeof a.valid !== 'function' || a.valid());
  function runAction(entry, a) {
    if (!actionUsable(entry, a)) return;
    try { a.run(entry.note); } catch (err) { console.error('notification action failed', err); }
  }

  function showBalloon(entry, note, opts) {
    const b = el('div', `ide-balloon ${entry.kind}${opts.balloonClass ? ` ${opts.balloonClass}` : ''}`);
    b.dataset.note = entry.id;
    b.appendChild(el('div', 'ide-balloon-title', entry.title));
    if (entry.text) {
      const text = el('div', 'ide-balloon-text', entry.text);
      if (entry.raw) text.dataset.userText = '';
      b.appendChild(text);
    }
    if (entry.actions.length) {
      const row = el('div', 'ide-balloon-actions');
      for (const a of entry.actions) {
        if (!actionUsable(entry, a)) continue;
        const link = el('button', 'ide-balloon-action', a.label);
        link.onclick = (e) => { e.stopPropagation(); runAction(entry, a); b.remove(); };
        row.appendChild(link);
      }
      if (row.children.length) b.appendChild(row);
    }
    const tools = el('div', 'ide-balloon-tools');
    if (entry.group) {
      const more = el('button', 'ide-balloon-more', '⋮');
      more.title = tr('More');
      more.onclick = (e) => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        ide.ui.contextMenu(r.left, r.bottom, [
          { label: tr("Don't Show Again"), detail: tr(entry.group), run: () => { setGroupHidden(entry.group, true); b.remove(); } },
        ]);
      };
      tools.appendChild(more);
    }
    const close = el('button', 'ide-balloon-close', '×');
    close.title = tr('Close');
    close.onclick = (e) => { e.stopPropagation(); b.remove(); };
    tools.appendChild(close);
    b.appendChild(tools);
    b.onclick = () => { if (opts.onClick) { opts.onClick(note); b.remove(); } };
    if (opts.onClick) b.classList.add('clickable');
    balloons.appendChild(b);
    const timeout = opts.timeout ?? (entry.kind === 'error' ? 20000 : 10000);
    if (timeout > 0) setTimeout(() => b.remove(), timeout);
    return b;
  }

  function setGroupHidden(group, hidden) {
    const list = hiddenGroups().filter((g) => g !== group);
    if (hidden) list.push(group);
    ide.settings.set('notifications.hiddenGroups', list);
    notesChanged({ type: 'groups' });
  }

  ide.notifications = {
    notify,
    // This session's notifications, oldest first: {id, time, title, text, kind, group, raw, read, expired, actions, note}.
    list: () => history.slice(),
    unread: () => history.filter((e) => !e.read).length,
    markAllRead() { if (!history.some((e) => !e.read)) return; for (const e of history) e.read = true; notesChanged({ type: 'read' }); },
    clear() { history.length = 0; balloons.replaceChildren(); notesChanged({ type: 'cleared' }); },
    actionUsable,
    runAction,
    hiddenGroups,
    setGroupHidden,
  };

  // ---------- status bar widget and popup ----------
  if (ide.detached) return;
  const widget = el('button', 'bg-tasks hidden');
  widget.id = 'bgTasks';
  const label = el('span', 'bg-tasks-label');
  const bar = el('span', 'bg-bar');
  bar.appendChild(el('span', 'bg-fill'));
  widget.append(label, bar);
  ide.registerStatusItem({ order: 5, el: widget });

  const drawBar = (node, fraction) => {
    node.classList.toggle('indeterminate', fraction == null);
    node.firstChild.style.width = fraction == null ? '' : `${Math.round(fraction * 100)}%`;
  };

  let popup = null;
  let frame = 0;
  renderTasksLater = () => { if (!frame) frame = requestAnimationFrame(renderTasks); };
  function renderTasks() {
    frame = 0;
    const list = [...tasks.values()];
    widget.classList.toggle('hidden', !list.length);
    if (list.length) {
      const last = list[list.length - 1];
      label.textContent = list.length === 1 ? last.title : tr('{n} processes running', { n: list.length });
      widget.title = list.length === 1 ? [last.title, last.text].filter(Boolean).join('\n') : tr('Show all background tasks');
      drawBar(bar, last.fraction);
    }
    if (popup) renderPopup();
  }

  function renderPopup() {
    const list = [...tasks.values()];
    if (!list.length) return closePopup();
    popup.replaceChildren(el('div', 'bg-popup-head', tr('Background Tasks')));
    for (const t of list) {
      const row = el('div', 'bg-popup-row');
      row.dataset.task = t.id;
      const main = el('div', 'bg-popup-main');
      main.appendChild(el('div', 'bg-popup-title', t.title));
      const rowBar = el('span', 'bg-bar');
      rowBar.appendChild(el('span', 'bg-fill'));
      drawBar(rowBar, t.fraction);
      main.appendChild(rowBar);
      if (t.text) main.appendChild(el('div', 'bg-popup-text', t.text));
      row.appendChild(main);
      if (t.cancellable) {
        const cancel = el('button', 'bg-popup-cancel', '×');
        cancel.title = tr('Cancel');
        cancel.onclick = (e) => { e.stopPropagation(); cancelTask(t.id); };
        row.appendChild(cancel);
      }
      popup.appendChild(row);
    }
    const r = widget.getBoundingClientRect();
    popup.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  }

  const outside = (e) => { if (!popup?.contains(e.target) && !widget.contains(e.target)) closePopup(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopup(); } };
  function closePopup() {
    popup?.remove();
    popup = null;
    removeEventListener('mousedown', outside, true);
    removeEventListener('keydown', esc, true);
  }
  widget.onclick = () => {
    if (popup) return closePopup();
    if (!tasks.size) return;
    popup = el('div', 'bg-popup');
    popup.id = 'bgTasksPopup';
    document.body.appendChild(popup);
    renderPopup();
    setTimeout(() => { addEventListener('mousedown', outside, true); addEventListener('keydown', esc, true); });
  };
  ide.tasks.showPopup = () => { if (!popup) widget.onclick(); };
})();
