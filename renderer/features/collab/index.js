// Collaboration (docs/collab-coding-plan.md): Tools › Start Collaboration Session shares the open project with a join
// code, Join Collaboration Session takes one; the Collaboration tool window shows who is in, the requests to join,
// and, for a guest, the host's files. The main side is main/features/collab.js.
//
// A guest's tabs are collab://<session>/<project-relative path> documents (ide.registerDocSource): their text comes from
// the host's shared document and never touches this computer's disk; they close when the session ends. presence.js
// draws the others' carets, selections and names and follows one of them.
(() => {
  const { el, basename, samePath } = ide.util;
  const here = document.currentScript.src.replace(/[^/]*$/, '');
  const api = ide.api;

  window.PYIDE_ICONS = window.PYIDE_ICONS || {};
  window.PYIDE_ICONS.collab = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5.5" cy="5" r="2.5" stroke="currentColor"/><path d="M1 13.5c0-2.5 2-4.5 4.5-4.5S10 11 10 13.5" stroke="currentColor"/><circle cx="11.5" cy="5.5" r="2" stroke="currentColor"/><path d="M11 9.1c2.2.2 4 1.9 4 4.4" stroke="currentColor"/></svg>';

  // ---------- state ----------
  // role: null | 'host' | 'guest'. Host: code, mode, people, pending. Guest: sid, state (connecting, waiting, online,
  // reconnecting), info (the host's welcome: you, role, color, project, host), people.
  const S = { role: null, code: null, mode: null, people: [], pending: [], sid: null, state: null, info: null, hostName: '' };
  const listeners = new Map();
  const on = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); };
  const emit = (type, e) => { for (const fn of listeners.get(type) || []) { try { fn(e); } catch (err) { console.error(err); } } };

  const PREFIX = 'collab://';
  const isRemote = (p) => typeof p === 'string' && p.startsWith(PREFIX);
  const localPath = (rel) => `${PREFIX}${S.sid}/${rel}`;
  // A guest document's path -> its project-relative path, or null when it is not this session's.
  const relOfLocal = (p) => (S.sid && isRemote(p) && p.startsWith(`${PREFIX}${S.sid}/`) ? p.slice(`${PREFIX}${S.sid}/`.length) : null);
  // Whether a document's path takes part in the session: the host's project files, the guest's collab:// files.
  const inSession = (p) => (S.role === 'host' ? !!ide.root && ide.util.isUnder(p, ide.root) && !samePath(p, ide.root) : S.role === 'guest' ? relOfLocal(p) !== null : false);
  const me = () => (S.role === 'host' ? 0 : S.info?.you ?? -1);
  const person = (id) => S.people.find((p) => p.id === id) || null;
  const canEdit = () => S.role === 'host' || S.info?.role === 'edit';

  // A guest document opens empty and takes its text when the host answers: what needs the text (a caret at a line, a
  // scroll position) waits for that. -> the tab, once its document has its text.
  async function opened(path, opts = {}) {
    const tab = await ide.openFile(path, opts);
    const doc = tab?.doc;
    if (doc?.remote && doc.sync?.joining !== undefined) {
      await new Promise((resolve) => {
        const off = ide.on('remoteDocumentSynced', (d) => { if (d === doc) { off(); resolve(); } });
        setTimeout(() => { off(); resolve(); }, 15000);
      });
    }
    return tab;
  }
  ide.collab = { on, state: () => S, isRemote, localPath, relOfLocal, inSession, me, person, canEdit, opened };

  // ---------- a guest's documents ----------
  ide.registerDocSource({
    // Every collab:// path, also one of a session that has ended: it is never read from or written to disk.
    owns: isRemote,
    uri(p) {
      const m = /^collab:\/\/([^/]*)\/(.*)$/.exec(p) || [null, 'none', p];
      return ide.monaco.Uri.from({ scheme: 'collab', authority: m[1] || 'none', path: `/${m[2]}` });
    },
    readOnly: () => !canEdit(),
    // Saving is the host's: files.js asks it to.
    save: (doc) => ide.collab.save?.(doc) ?? null,
  });
  const remoteTabs = () => ide.tabs.filter((t) => isRemote(t.path));
  // The host refused or could not give a document: its tab closes, and the guest is told why.
  const FAILED = {
    hidden: () => tr('The host does not share this file.'),
    missing: () => tr('The file is not there any more.'),
    ENOENT: () => tr('The file is not there any more.'),
    binary: () => tr('The file is binary, so it cannot be shown as text.'),
    tooLarge: () => tr('The file is too large to share.'),
    readOnly: () => tr('You may only view this session: the host has not let you edit.'),
    badPath: () => tr('The host refused this path.'),
    offline: () => tr('You are not in the session.'),
  };
  api.on('doc:failed', (msg) => {
    const doc = ide.getDocument(msg.path);
    if (!doc || doc.sync?.ticket !== msg.ticket) return;
    for (const t of ide.tabs.filter((x) => x.doc === doc)) ide.closeTabObject(t, true);
    const why = FAILED[msg.code]?.() || tr('The host could not open it.');
    ide.notifications?.notify({ title: tr('Cannot open {name}', { name: basename(msg.path) }), text: why, kind: 'warn', group: tr('Collaboration') });
  });
  function closeRemoteTabs() {
    for (const t of remoteTabs()) ide.closeTabObject(t, true);
  }
  function refreshReadOnly() {
    for (const t of remoteTabs()) if (t.doc) ide.setDocumentReadOnly(t.doc, !canEdit());
  }

  // ---------- events from main ----------
  const WHY = {
    declined: () => tr('The host declined your request to join.'),
    full: () => tr('The session is full: at most 5 people, the host included.'),
    expired: () => tr('You were away too long and left the session. Join again with the code.'),
    ended: () => tr('The host ended the collaboration session.'),
    kicked: () => tr('The host removed you from the session.'),
    lost: () => tr('The connection to the host was lost. Ask the host whether the session still runs, then join again.'),
    unreachable: () => tr('Nano Studio cannot reach the host. Check that the host still runs the session and that the code is the latest one, then try again.'),
    badKey: () => tr('The other side did not prove it holds the code\'s key. Ask the host for a new code.'),
    closed: () => tr('The host closed the connection before answering.'),
    left: () => null,
  };
  api.on('collab:event', (e) => {
    if (!e || typeof e.type !== 'string') return;
    switch (e.type) {
      case 'started': Object.assign(S, { role: 'host', code: e.code, mode: e.mode, people: e.people || [], pending: e.pending || [] }); break;
      case 'stopped': endSession(); break;
      case 'people':
        S.people = e.people || [];
        if (S.role === 'host') S.pending = e.pending || [];
        break;
      case 'request':
        if (!S.pending.some((p) => p.id === e.id)) S.pending.push({ id: e.id, name: e.name });
        emit('request', e);
        break;
      case 'withdrawn': emit('withdrawn', e); break;
      case 'left':
        if (e.why === 'lost') ide.notifications?.notify({ title: tr('{name} left the session', { name: e.name }), text: tr('The connection was lost for more than two minutes.'), group: tr('Collaboration') });
        break;
      case 'open':
        // A file a guest opened: the host's window holds it too (behind the tab in front), for its language server.
        if (S.role === 'host' && typeof e.path === 'string' && !ide.findTab(e.path)) ide.openFile(e.path, { background: true, focus: false }).catch?.(() => {});
        break;
      case 'tunnel':
        if (S.role === 'host') ide.notifications?.notify({ title: tr('The collaboration tunnel stopped'), text: tr('Guests over the internet cannot reach you now. End the session and start it again for a new code.'), kind: 'warn', group: tr('Collaboration') });
        break;
      case 'state': guestState(e); break;
      case 'remote:welcome':
        S.info = { you: e.you, role: e.role === 'edit' ? 'edit' : 'read', color: e.color, project: String(e.project || ''), host: String(e.host || '') };
        S.people = Array.isArray(e.people) ? e.people : [];
        refreshReadOnly();
        emit('welcome', S.info);
        break;
      case 'remote:people': S.people = Array.isArray(e.people) ? e.people : []; break;
      case 'remote:role':
        if (S.info) S.info.role = e.role === 'edit' ? 'edit' : 'read';
        refreshReadOnly();
        ide.notifications?.notify({ title: canEdit() ? tr('You may now edit') : tr('You may now only view'), text: canEdit() ? tr('The host let you edit the shared files.') : tr('The host made the session read-only for you.'), group: tr('Collaboration') });
        break;
      default: break;
    }
    // Presence and the rest (presence.js, chat) hear every event; remote ones with paths made local.
    if (e.type.startsWith('remote:')) {
      const type = e.type.slice(7);
      const out = { ...e, type };
      if ('path' in e) out.path = typeof e.path === 'string' ? localPath(e.path) : null;
      emit(type, out);
    } else if (!['request', 'withdrawn'].includes(e.type)) emit(e.type, e);
    render();
  });

  function guestState(e) {
    const was = S.state;
    S.state = e.state;
    if (e.state === 'online' && e.resumed) ide.notifications?.notify({ title: tr('Connected to the host again'), text: tr('Edits made meanwhile were sent.'), kind: 'ok', group: tr('Collaboration') });
    if (e.state === 'reconnecting' && was === 'online') ide.notifications?.notify({ title: tr('Connection to the host lost'), text: tr('Reconnecting… Keep working: your edits are sent once the connection is back.'), kind: 'warn', group: tr('Collaboration') });
    if (e.state === 'ended') {
      const why = WHY[e.why]?.() ?? tr('The collaboration session ended.');
      const joining = !S.info;
      endSession();
      if (joining) emit('joinFailed', why); else if (why) ide.notifications?.notify({ title: tr('Collaboration ended'), text: why, kind: e.why === 'ended' || e.why === 'left' ? 'info' : 'warn', group: tr('Collaboration') });
    }
  }

  // Everything of the session goes: a guest's tabs and the host's text in them, the file tree, the carets.
  function endSession() {
    const wasGuest = S.role === 'guest';
    Object.assign(S, { role: null, code: null, mode: null, people: [], pending: [], sid: null, state: null, info: null, hostName: '' });
    if (wasGuest) {
      closeRemoteTabs();
      for (const m of ide.monaco.editor.getModels()) if (m.uri.scheme === 'collab' && !m.isDisposed()) m.dispose();
      document.body.classList.remove('collab-guest');
      tree.clear();
    }
    emit('ended');
    render();
  }

  // ---------- starting and joining ----------
  const DEFAULT_HIDDEN = ['.env', '.env.*', '*.key', '*.pem', '*.pfx', '*.p12', 'id_rsa*', '.git/', '.ssh/'];
  const field = (label, input, hint) => {
    const row = el('label', 'collab-field');
    row.append(el('span', 'collab-field-label', label), input);
    if (hint) row.appendChild(el('span', 'collab-field-hint', hint));
    return row;
  };
  const START_ERRORS = {
    noProject: () => tr('Open a project first: a session shares the open project.'),
    noLan: () => tr('This computer is on no local network. Use the internet connection instead.'),
    busy: () => tr('A collaboration session is already open in this window.'),
  };
  function startDialog() {
    if (S.role) return showTool();
    if (!ide.root) return ide.ui.alert(START_ERRORS.noProject());
    const body = el('div', 'collab-form');
    const name = el('input', 'collab-name');
    name.value = ide.settings.get('collab.name', '');
    name.placeholder = tr('Your name as others see it');
    const mode = el('select', 'collab-mode');
    for (const [v, label] of [['internet', tr('Over the internet (encrypted bore.pub tunnel)')], ['lan', tr('On the same network only (direct)')]]) {
      const o = el('option', null, label);
      o.value = v;
      mode.appendChild(o);
    }
    mode.value = ide.settings.get('collab.mode', 'internet');
    const hidden = el('textarea', 'collab-hidden');
    hidden.rows = 3;
    hidden.value = ide.settings.get('collab.hidden', DEFAULT_HIDDEN).join('\n');
    const error = el('div', 'collab-error hidden');
    body.append(
      el('div', 'collab-intro', tr('Guests see the files of {project} and edit them with you. Files, saving, running and language servers stay on this computer. Each person who asks to join needs your OK, and joins read-only unless you let them edit.', { project: basename(ide.root) })),
      field(tr('Name'), name), field(tr('Connection'), mode),
      field(tr('Files guests never see'), hidden, tr('One pattern per line: a name (*.key), or a folder ending in / (.git/).')),
      error,
    );
    ide.ui.dialog({
      title: tr('Start Collaboration Session'), body, width: 560,
      buttons: [{ label: tr('Start'), primary: true, run: async (dlg) => {
        const patterns = hidden.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        ide.settings.set('collab.name', name.value.trim());
        ide.settings.set('collab.mode', mode.value);
        ide.settings.set('collab.hidden', patterns);
        error.classList.add('hidden');
        dlg.el.classList.add('collab-busy');
        const r = await api.invoke('collab:start', { root: ide.root, name: name.value.trim(), mode: mode.value, hidden: patterns }).catch((err) => ({ error: err.message, code: 'failed' }));
        dlg.el.classList.remove('collab-busy');
        if (r.error) {
          error.textContent = START_ERRORS[r.code]?.() || (mode.value === 'internet'
            ? tr('The bore.pub tunnel did not open ({error}). Check the internet connection, or choose the same-network connection.', { error: r.error })
            : tr('The session did not start: {error}', { error: r.error }));
          error.classList.remove('hidden');
          return false;
        }
        Object.assign(S, { role: 'host', code: r.code, mode: r.mode, people: r.people || [], pending: r.pending || [] });
        render();
        showTool();
        copyCode(true);
        return true;
      } }, { label: tr('Cancel') }],
    });
    return undefined;
  }
  function copyCode(started = false) {
    if (!S.code) return;
    api.invoke('clipboard:writeText', S.code);
    ide.notifications?.notify({ title: started ? tr('Collaboration started') : tr('Join code copied'), text: tr('The join code is on the clipboard: send it to the people you work with. You accept each one who asks to join.'), kind: 'ok', group: tr('Collaboration') });
  }

  function joinDialog(prefill = '') {
    if (S.role) return showTool();
    const body = el('div', 'collab-form');
    const code = el('textarea', 'collab-code');
    code.rows = 3;
    code.placeholder = tr('Paste the join code (nanostudio:collab?…)');
    code.value = prefill;
    const name = el('input', 'collab-name');
    name.value = ide.settings.get('collab.name', '');
    name.placeholder = tr('Your name as others see it');
    const status = el('div', 'collab-status hidden');
    const error = el('div', 'collab-error hidden');
    body.append(
      el('div', 'collab-intro', tr('You see and edit the host\'s files; nothing of them is saved on this computer, and it all goes when the session ends. The host runs the code, not you.')),
      field(tr('Join code'), code), field(tr('Name'), name), status, error,
    );
    let waiting = null; // the join under way
    const dlg = ide.ui.dialog({
      title: tr('Join Collaboration Session'), body, width: 560,
      onClose: () => { if (waiting && S.role === 'guest' && !S.info) api.invoke('collab:leave'); waiting = null; },
      buttons: [{ label: tr('Join'), primary: true, run: async () => {
        if (waiting) return false;
        error.classList.add('hidden');
        if (!code.value.trim()) { error.textContent = tr('Paste the join code the host sent you.'); error.classList.remove('hidden'); return false; }
        ide.settings.set('collab.name', name.value.trim());
        const r = await api.invoke('collab:join', { code: code.value.trim(), name: name.value.trim() }).catch((err) => ({ error: err.message, code: 'failed' }));
        if (r.error) {
          error.textContent = r.code === 'badCode'
            ? tr('That is not a Nano Studio collaboration code. Copy the whole code the host sent (it starts with nanostudio:collab?).')
            : r.code === 'busy' ? START_ERRORS.busy() : tr('Cannot join: {error}', { error: r.error });
          error.classList.remove('hidden');
          return false;
        }
        Object.assign(S, { role: 'guest', sid: r.sid, state: r.state, hostName: r.hostName || '', info: null, people: [] });
        status.textContent = tr('Connecting to {host}…', { host: S.hostName || tr('the host') });
        status.classList.remove('hidden');
        render();
        waiting = new Promise((resolve) => {
          const offs = [
            on('state', (e) => { if (e.state === 'waiting') status.textContent = tr('Waiting for {host} to let you in…', { host: S.hostName || tr('the host') }); }),
            on('welcome', () => { offs.forEach((f) => f()); resolve(true); }),
            on('joinFailed', (why) => { offs.forEach((f) => f()); error.textContent = why; error.classList.remove('hidden'); status.classList.add('hidden'); resolve(false); }),
          ];
        });
        const ok = await waiting;
        waiting = null;
        if (!ok) return false;
        joined();
        return true;
      } }, { label: tr('Cancel') }],
    });
    return dlg;
  }
  // In the session: the window shows the host's files even with no project of its own open.
  function joined() {
    document.body.classList.add('collab-guest');
    tree.reset();
    showTool();
    ide.notifications?.notify({ title: tr('You joined {host}\'s session', { host: S.info?.host || S.hostName }), text: canEdit() ? tr('You may edit the shared files.') : tr('You may view the files; the host can let you edit.'), kind: 'ok', group: tr('Collaboration') });
  }

  async function stopOrLeave() {
    if (S.role === 'host') {
      if (!(await ide.ui.confirm(tr('End the session for everyone? Guests lose the shared files at once.'), { ok: tr('End Session') }))) return;
      await api.invoke('collab:stop');
      endSession();
    } else if (S.role === 'guest') {
      await api.invoke('collab:leave');
    }
  }

  // ---------- requests to join (host) ----------
  let asking = null; // {id, dlg}
  const queue = [];
  on('request', (e) => { queue.push(e); askNext(); });
  on('withdrawn', (e) => {
    const i = queue.findIndex((q) => q.id === e.id);
    if (i >= 0) queue.splice(i, 1);
    if (asking?.id === e.id) { const d = asking.dlg; asking = null; d.close(); }
    render();
  });
  function askNext() {
    if (asking || !queue.length || S.role !== 'host') return;
    const req = queue.shift();
    const answer = (allow, role) => api.invoke('collab:answer', req.id, allow, role);
    asking = { id: req.id };
    asking.dlg = ide.ui.dialog({
      title: tr('Request to Join'),
      body: el('div', 'dialog-message', tr('{name} wants to join your collaboration session. Once in, they see every file of the project except the hidden ones; they edit only if you let them.', { name: req.name })),
      width: 500,
      onClose: () => { asking = null; setTimeout(askNext); },
      buttons: [
        { label: tr('Accept (View Only)'), primary: true, run: () => answer(true, 'read') },
        { label: tr('Accept and Allow Editing'), run: () => answer(true, 'edit') },
        { label: tr('Decline'), run: () => answer(false) },
      ],
    });
  }

  // ---------- the host's files (guest) ----------
  // rel -> {entries: [{name, dir}] | null (loading), error}; expanded: the folders shown open.
  const tree = (() => {
    const folders = new Map();
    const expanded = new Set(['']);
    let host = null;
    const load = async (rel) => {
      folders.set(rel, { entries: null });
      draw();
      const r = await api.invoke('collab:tree', rel).catch(() => ({ error: 'failed' }));
      if (S.role !== 'guest') return;
      folders.set(rel, r.error ? { entries: [], error: r.error } : { entries: r.entries });
      draw();
    };
    function rowsOf(rel, depth, out) {
      const f = folders.get(rel);
      if (!f) { load(rel); return; }
      if (!f.entries) { out.push(el('div', 'collab-tree-note', tr('Loading…'))); return; }
      if (f.error) out.push(el('div', 'collab-tree-note', tr('The host could not list this folder.')));
      for (const e of f.entries) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        const row = el('div', `collab-tree-row${e.dir ? ' dir' : ''}`);
        row.tabIndex = 0;
        row.dataset.rel = child;
        row.style.paddingLeft = `${8 + depth * 14}px`;
        const arrow = el('span', `collab-tree-arrow${e.dir && expanded.has(child) ? ' open' : ''}`, e.dir ? '›' : '');
        row.append(arrow, ide.fileIcon(e.name, { dir: e.dir }), el('span', 'collab-tree-name', e.name));
        const open = () => {
          if (e.dir) {
            if (expanded.has(child)) expanded.delete(child); else expanded.add(child);
            draw();
          } else ide.openFile(localPath(child));
        };
        row.onclick = open;
        row.onkeydown = (ev) => { if (ev.key === 'Enter') open(); };
        out.push(row);
        if (e.dir && expanded.has(child)) rowsOf(child, depth + 1, out);
      }
    }
    function draw() {
      if (!host) return;
      const out = [];
      if (S.role === 'guest' && S.info) rowsOf('', 0, out);
      host.replaceChildren(...out);
    }
    return {
      mount(node) { host = node; draw(); },
      reset() { folders.clear(); expanded.clear(); expanded.add(''); draw(); },
      clear() { folders.clear(); expanded.clear(); expanded.add(''); draw(); },
      refresh() { for (const rel of [...folders.keys()]) if (expanded.has(rel)) load(rel); },
      changed(rel) { if (folders.has(rel)) load(rel); },
      draw,
    };
  })();
  ide.collab.tree = tree;

  // ---------- status bar ----------
  const item = el('button', 'collab-status-item hidden');
  item.id = 'collabStatus';
  item.onclick = () => showTool();
  ide.registerStatusItem({ order: 8, el: item });
  function statusItem() {
    item.classList.toggle('hidden', !S.role);
    if (!S.role) return;
    item.replaceChildren(ide.icon('collab'), el('span', null, S.role === 'host'
      ? (S.pending.length ? tr('Collaboration: {n} waiting', { n: S.pending.length }) : tr('Collaboration: {n} people', { n: S.people.length }))
      : S.state === 'reconnecting' ? tr('Collaboration: reconnecting…') : tr('Collaboration: {host}', { host: S.info?.host || S.hostName || '' })));
    item.classList.toggle('warn', S.state === 'reconnecting' || (S.role === 'host' && S.pending.length > 0));
    item.title = tr('Show the Collaboration tool window');
  }

  // ---------- the tool window ----------
  let tw = null;
  const parts = {};
  const ROLE = { host: () => tr('Host'), edit: () => tr('Can edit'), read: () => tr('View only') };
  function render() {
    if (!parts.root) return;
    const { status, actions, people, pending, files, filesHead, idle } = parts;
    idle.classList.toggle('hidden', !!S.role);
    for (const n of [status, actions, parts.peopleHead, people]) n.classList.toggle('hidden', !S.role);
    // The session line.
    if (S.role === 'host') {
      status.textContent = tr('Sharing {project} · {n} of 5 people', { project: basename(ide.root || ''), n: S.people.length });
    } else if (S.role === 'guest') {
      const where = S.info ? tr('{host}\'s {project}', { host: S.info.host, project: S.info.project }) : S.hostName || tr('the host');
      status.textContent = S.state === 'reconnecting' ? tr('Reconnecting to {where}…', { where })
        : S.state === 'waiting' ? tr('Waiting for {host} to let you in…', { host: S.hostName || tr('the host') })
          : S.info ? `${where} · ${canEdit() ? tr('Can edit') : tr('View only')}` : tr('Connecting to {host}…', { host: S.hostName || tr('the host') });
    }
    status.classList.toggle('warn', S.state === 'reconnecting');
    const buttons = [];
    if (S.role === 'host') {
      const copy = el('button', 'secondary collab-copy', tr('Copy Join Code'));
      copy.onclick = () => copyCode();
      buttons.push(copy);
    }
    if (S.role) {
      const stop = el('button', 'secondary collab-stop', S.role === 'host' ? tr('End Session') : tr('Leave Session'));
      stop.onclick = stopOrLeave;
      buttons.push(stop);
    }
    actions.replaceChildren(...buttons);
    // People.
    people.replaceChildren(...S.people.map((p) => {
      const row = el('div', `collab-person collab-c${p.color % 8}${p.state === 'away' ? ' away' : ''}`);
      row.dataset.id = p.id;
      row.append(el('span', 'collab-dot'), el('span', 'collab-person-name', p.id === me() ? tr('{name} (you)', { name: p.name }) : p.name));
      const tag = p.state === 'away' ? tr('Disconnected') : ROLE[p.role]?.() || '';
      row.appendChild(el('span', 'collab-person-role', tag));
      const tools = el('span', 'collab-person-tools');
      if (p.id !== me()) {
        const follow = el('button', `link collab-follow${ide.collab.following?.() === p.id ? ' on' : ''}`, ide.collab.following?.() === p.id ? tr('Stop Following') : tr('Follow'));
        follow.onclick = () => ide.collab.follow?.(ide.collab.following?.() === p.id ? null : p.id);
        tools.appendChild(follow);
      }
      if (S.role === 'host' && p.id !== 0) {
        const role = el('button', 'link collab-role', p.role === 'edit' ? tr('Make View Only') : tr('Allow Editing'));
        role.onclick = () => api.invoke('collab:setRole', p.id, p.role === 'edit' ? 'read' : 'edit');
        const kick = el('button', 'link collab-kick', tr('Remove from Session'));
        kick.onclick = async () => { if (await ide.ui.confirm(tr('Remove {name} from the session?', { name: p.name }), { ok: tr('Remove from Session') })) api.invoke('collab:kick', p.id); };
        tools.append(role, kick);
      }
      row.appendChild(tools);
      return row;
    }));
    // Requests (host).
    pending.classList.toggle('hidden', !(S.role === 'host' && S.pending.length));
    parts.pendingHead.classList.toggle('hidden', !(S.role === 'host' && S.pending.length));
    pending.replaceChildren(...(S.role === 'host' ? S.pending : []).map((p) => {
      const row = el('div', 'collab-request');
      row.dataset.id = p.id;
      const acceptBtn = el('button', 'secondary', tr('Accept'));
      acceptBtn.onclick = () => api.invoke('collab:answer', p.id, true, 'read');
      const declineBtn = el('button', 'secondary', tr('Decline'));
      declineBtn.onclick = () => api.invoke('collab:answer', p.id, false);
      row.append(el('span', 'collab-person-name', tr('{name} wants to join', { name: p.name })), acceptBtn, declineBtn);
      return row;
    }));
    // The host's files (guest).
    const showFiles = S.role === 'guest' && !!S.info;
    filesHead.classList.toggle('hidden', !showFiles);
    files.classList.toggle('hidden', !showFiles);
    if (showFiles) parts.filesTitle.textContent = tr('Files of {project}', { project: S.info.project });
    statusItem();
    emit('rendered');
  }

  tw = ide.registerToolWindow({
    id: 'Collaboration', title: tr('Collaboration'), icon: '⇋', iconName: 'collab', side: 'left', order: 90,
    mount(container) {
      container.classList.add('collab-tool');
      const root = el('div', 'collab-panel');
      const idle = el('div', 'collab-idle');
      const startBtn = el('button', 'primary', tr('Start Session'));
      startBtn.onclick = startDialog;
      const joinBtn = el('button', 'secondary', tr('Join Session'));
      joinBtn.onclick = () => joinDialog();
      idle.append(el('div', 'collab-intro', tr('Work on one project together in real time: share yours with a join code, or join someone else\'s.')), el('div', 'collab-idle-buttons'));
      idle.lastChild.append(startBtn, joinBtn);
      const status = el('div', 'collab-session');
      const actions = el('div', 'collab-actions');
      const peopleHead = el('div', 'collab-head', tr('People'));
      const people = el('div', 'collab-people');
      const pendingHead = el('div', 'collab-head', tr('Waiting to Join'));
      const pending = el('div', 'collab-requests');
      const filesHead = el('div', 'collab-head collab-files-head');
      const filesTitle = el('span', null, '');
      const refresh = el('button', 'link collab-refresh', tr('Refresh'));
      refresh.onclick = () => tree.refresh();
      filesHead.append(filesTitle, refresh);
      const files = el('div', 'collab-tree');
      tree.mount(files);
      root.append(idle, status, actions, peopleHead, people, pendingHead, pending, filesHead, files);
      container.appendChild(root);
      Object.assign(parts, { root, idle, status, actions, peopleHead, people, pendingHead, pending, filesHead, filesTitle, files });
      ide.collab.panel = root;
      render();
    },
  });
  const showTool = () => tw.show();
  ide.collab.render = render;

  // ---------- actions and the welcome screen ----------
  ide.registerAction({ id: 'Collab.Start', title: tr('Start Collaboration Session…'), run: startDialog });
  ide.registerAction({ id: 'Collab.Join', title: tr('Join Collaboration Session…'), run: () => joinDialog() });
  ide.registerAction({ id: 'Collab.CopyCode', title: tr('Copy Collaboration Join Code'), run: () => (S.role === 'host' ? copyCode() : startDialog()) });
  ide.registerAction({ id: 'Collab.End', title: tr('End or Leave Collaboration Session'), run: stopOrLeave });
  ide.registerAction({ id: 'ActivateCollaborationToolWindow', title: tr('Collaboration'), run: showTool });
  ide.collab.startDialog = startDialog;
  ide.collab.joinDialog = joinDialog;

  const welcomeActions = document.querySelector('#welcome .welcome-actions');
  if (welcomeActions && !ide.detached) {
    const b = el('button', 'welcome-action');
    b.id = 'welcomeCollab';
    const icon = el('span', 'welcome-action-icon');
    icon.appendChild(ide.icon('collab'));
    b.append(icon, el('span', null, tr('Join Session')));
    b.onclick = () => joinDialog();
    welcomeActions.appendChild(b);
  }

  // A window opened again (reload) finds the session main still has.
  api.invoke('collab:state').then((st) => {
    if (!st?.role) return;
    if (st.role === 'host') Object.assign(S, { role: 'host', code: st.code, mode: st.mode, people: st.people || [], pending: st.pending || [] });
    else {
      Object.assign(S, { role: 'guest', sid: st.sid, state: st.state, hostName: st.hostName || '', info: st.info || null });
      if (S.info) document.body.classList.add('collab-guest');
    }
    render();
  }).catch(() => {});

  for (const file of ['presence.js', 'files.js', 'lsp.js', 'output.js', 'share.js']) {
    const s = el('script');
    s.src = here + file;
    s.async = false;
    document.body.appendChild(s);
  }
})();
