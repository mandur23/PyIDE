// A server's Backups tab (main/minecraft/backups.js): its world backups with their time, reason, size and Minecraft
// version, Back Up Now, Restore…, Delete and Open Folder, the schedule and how many are kept, and the progress of a
// backup or a restore with Cancel. mc.backups.before(srv, reason) backs a server up before something risky (a Market
// change, a world dropped in, a settings change, Repair): the user sees why the action waits and can skip it.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const tabId = (dir) => `minecraft:backups:${dir.toLowerCase()}`;
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const REASON = () => ({
    manual: tr('Made by you'), market: tr('Before a Market change'), world: tr('Before a world was dropped in'), settings: tr('Before a settings change'),
    repair: tr('Before Repair'), schedule: tr('On schedule'), stop: tr('When the server stopped'), restore: tr('Before a restore'),
  });
  const PHASE = () => ({
    starting: tr('Starting…'), pausing: tr('Asking the server to pause its saves…'), flushing: tr('Waiting for the server to save its world…'),
    scanning: tr('Listing the files…'), packing: tr('Packing the world…'), resuming: tr('Turning the server\'s saves back on…'),
    verifying: tr('Checking every file of the backup…'), safety: tr('Backing up the current world first…'), unpacking: tr('Unpacking the backup…'),
    swapping: tr('Putting the files in place…'),
  });
  const EVERY = [0, 1, 2, 3, 6, 12, 24];
  const bytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const when = (ms) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const invoke = (ch, ...a) => ide.api.invoke(`minecraft:${ch}`, ide.root, ...a);
  const runSession = (dir) => ide.run.sessions().find((s) => s.cfg?.type === 'minecraft-server' && ide.run.resolvePath(s.cfg.dir).toLowerCase() === dir.toLowerCase()) || null;
  const percentOf = (ev) => (ev.total ? Math.min(100, Math.floor((ev.done / ev.total) * 100)) : null);
  const progressText = (ev) => {
    const p = percentOf(ev);
    const phase = PHASE()[ev.phase] || '';
    return p === null || !['packing', 'verifying', 'unpacking', 'safety'].includes(ev.phase) ? phase : `${phase} ${p}% · ${bytes(ev.done)} / ${bytes(ev.total)}`;
  };

  // ---------- jobs ----------
  // job -> {dir, onEvent(ev)} for the jobs this window follows. A job main started on its own (on schedule, at a stop)
  // gets a status bar task when its first event comes.
  const jobs = new Map();
  let seq = 0;
  const newJob = () => `mcbk-${Date.now()}-${++seq}`;
  ide.api.on('minecraft:backup', (ev) => {
    for (const v of views) if (same(v.srv.dir, ev.dir)) paintProgress(v, ev);
    let j = jobs.get(ev.job);
    if (!j && ev.state === 'running') j = follow(ev);
    j?.onEvent(ev);
    if (ev.state !== 'running') {
      jobs.delete(ev.job);
      for (const v of views) if (same(v.srv.dir, ev.dir)) load(v);
    }
  });
  function follow(ev) {
    const name = ev.dir.split(/[\\/]/).pop();
    const task = ide.tasks?.start({ title: tr('Backing up {name}…', { name }), onCancel: () => ide.api.invoke('minecraft:backupCancel', ev.job) });
    const j = {
      onEvent(e) {
        if (e.state === 'running') { task?.update({ fraction: e.total && e.phase === 'packing' ? e.done / e.total : null, text: progressText(e) }); return; }
        task?.done();
        if (e.state === 'failed') ide.notifications?.notify({ title: tr('The automatic backup of {name} was not made', { name }), text: failure(name, e), kind: 'warn', group: 'Minecraft', raw: true });
      },
    };
    jobs.set(ev.job, j);
    return j;
  }
  // A backup or a restore this window asked for, shown in the status bar (and a balloon when one is given):
  // run(job id) -> main's answer. cancelLabel is the balloon's button: Skip for a backup before an action.
  async function track(dir, { title, run, balloon, cancelLabel = tr('Cancel') }) {
    const job = newJob();
    const cancel = () => ide.api.invoke('minecraft:backupCancel', job);
    const task = ide.tasks?.start({ title, onCancel: cancel });
    const note = balloon ? ide.notifications?.notify({ title, text: tr('Starting…'), group: 'Minecraft', timeout: 0, raw: true, actions: [{ label: cancelLabel, run: cancel }] }) : null;
    const bar = el('div', 'mc-tr-bar');
    bar.appendChild(el('div', 'mc-tr-fill'));
    note?.balloon?.querySelector('.ide-balloon-text')?.after(bar);
    jobs.set(job, {
      onEvent(ev) {
        if (ev.state !== 'running') return;
        const p = percentOf(ev);
        const text = progressText(ev);
        task?.update({ fraction: p === null ? null : p / 100, text });
        const t = note?.balloon?.querySelector('.ide-balloon-text');
        if (t) t.textContent = text;
        bar.firstChild.style.width = `${p ?? 0}%`;
        bar.dataset.percent = String(p ?? 0);
      },
    });
    try {
      const r = await run(job);
      if (r?.ok === false) throw Object.assign(new Error(r.error), r);
      return r;
    } finally {
      jobs.delete(job);
      task?.done();
      note?.expire();
    }
  }
  const cancelled = (err) => err.code === 'cancelled';
  // Why a backup or a restore did not happen, from main's code ({ok: false, code, ...}); main's own words otherwise.
  function failure(name, e) {
    const text = {
      busy: () => tr('{name} is being backed up or restored already. Wait for it to finish.', { name }),
      proxy: () => tr('A proxy has no world to back up.'),
      leftOver: () => tr('{name} is still running from before, outside this window. End it on its card first.', { name }),
      badWorld: () => tr('level-name in server.properties is not a plain folder name, so the world cannot be found.'),
      noWorld: () => tr('{name} has no world yet. Start it once first.', { name }),
      space: () => tr('There is not enough free space: it needs up to {need}, and the disk has {free} free.', { need: bytes(e.need || 0), free: bytes(e.free || 0) }),
      stopped: () => tr('{name} stopped during the backup, and a stopping server writes its world, so that backup was thrown away. Make one now that it has stopped.', { name }),
      stopping: () => tr('{name} is stopping, and a stopping server writes its world. Make a backup once it has stopped.', { name }),
      unreadable: () => tr('{file} could not be read, so the backup was not made. Close whatever has it open, then try again.', { file: e.entry || '?' }),
      noAnswer: () => tr('{name} did not answer the save commands in time, so nothing was packed: a world copied while the server writes it would be broken. It may still be starting or busy; try again in a moment.', { name }),
      saveFailed: () => tr('{name} could not save its world (is the disk full?), so it was not backed up.', { name }),
      running: () => tr('Stop {name} first: a running server keeps writing its world.', { name }),
      damaged: () => tr('The backup is damaged ({file} does not match its checksum), so nothing was restored. The world was not touched.', { file: e.entry || '?' }),
      notBackup: () => tr('That file is not a backup Nano Studio made.'),
      safety: () => `${tr('The current world could not be backed up first, so nothing was restored.')} ${e.cause && e.cause !== 'safety' ? failure(name, { ...e, code: e.cause }) : ''}`.trim(),
      swap: () => tr('The restore stopped half-way (a file was in use), and everything was put back as it was.'),
    }[e.code];
    return text ? text() : e.error || e.message || String(e);
  }

  // ---------- before something risky ----------
  // -> true when the action goes on: backed up, skipped, or nothing to back up (no world yet, a proxy).
  const WHY = () => ({ market: tr('the Market change'), world: tr('the world you dropped in'), settings: tr('the settings change'), repair: tr('Repair') });
  const waiting = new Map(); // server folder (lower case) -> the answer of the before() under way: a second press waits for it
  function before(srv, reason) {
    if (!srv || srv.proxy || ide.trusted === false) return Promise.resolve(true);
    const k = srv.dir.toLowerCase();
    if (!waiting.has(k)) waiting.set(k, backUpFirst(srv, reason).finally(() => waiting.delete(k)));
    return waiting.get(k);
  }
  async function backUpFirst(srv, reason) {
    try {
      await track(srv.dir, {
        title: tr('Backing up {name} before {what}…', { name: srv.name, what: WHY()[reason] || reason }), balloon: true, cancelLabel: tr('Skip'),
        run: (job) => invoke('backupNow', srv.dir, { reason, job }),
      });
      return true;
    } catch (err) {
      if (cancelled(err) || err.code === 'noWorld' || err.code === 'proxy') return true;
      return ide.ui.confirm(tr('{name} could not be backed up first: {error} Go on without a backup?', { name: srv.name, error: failure(srv.name, err) }), { title: tr('Backup'), ok: tr('Go On Without a Backup') });
    }
  }

  // ---------- the tab ----------
  const views = new Set();
  function open(srv) {
    if (ide.trusted === false) return;
    ide.openCustomTab({ id: tabId(srv.dir), title: tr('{name} Backups', { name: srv.name }), icon: 'history', mount: (host) => mount(host, srv),
      onClose: () => { for (const v of views) if (v.srv.dir === srv.dir) views.delete(v); } });
  }
  function mount(host, srv) {
    host.classList.add('mcset', 'mcbk');
    const v = { srv, host };
    const main = el('div', 'mcset-main');
    const head = el('div', 'mcset-head');
    const scroll = el('div', 'mcset-scroll');
    main.append(head, scroll);
    const body = el('div', 'mcset-body');
    body.append(main);
    host.append(body);

    const title = el('div', 'mcset-title');
    const state = el('span', 'mcset-state');
    const name = el('span', 'mcset-name', srv.name);
    name.dataset.userText = '';
    title.append(name, state);
    const text = el('div', 'mcset-head-text');
    text.append(title, el('div', 'mcset-sub muted', `${mc.kindTitle(srv.kind)} ${srv.mc || ''} · ${tr('Backups')}`));
    const tools = el('div', 'mcset-tools');
    const folder = el('button', 'secondary mcbk-folder', tr('Open Folder'));
    folder.onclick = async () => { await ide.api.invoke('fs:create', `${srv.dir}\\backups`, true).catch(() => {}); ide.api.invoke('shell:openPath', `${srv.dir}\\backups`); };
    const now = el('button', 'primary mcbk-now', tr('Back Up Now'));
    now.onclick = () => backUpNow(v);
    tools.append(folder, now);
    head.append(text, tools);

    // The list, and what is running now.
    const listSec = el('section', 'mcset-section mcbk-section');
    const summary = el('div', 'mcbk-summary muted');
    const progress = el('div', 'mcbk-progress hidden');
    const ptext = el('span', 'mcbk-ptext');
    const pbar = el('div', 'mc-tr-bar mcbk-bar');
    pbar.appendChild(el('div', 'mc-tr-fill'));
    const pcancel = el('button', 'secondary mcbk-cancel', tr('Cancel'));
    progress.append(ptext, pbar, pcancel);
    const list = el('div', 'mcbk-list');
    listSec.append(el('h2', 'mcset-section-title', tr('Backups')), summary, progress, list);

    // The schedule and what is kept: applied when changed.
    const autoSec = el('section', 'mcset-section mcbk-section');
    const every = el('select', 'input mcset-input mcbk-every');
    for (const h of EVERY) every.add(new Option(h ? tr('Every {hours} hours', { hours: h }) : tr('Off'), String(h)));
    const keep = el('input', 'input mcset-input mcbk-keep');
    Object.assign(keep, { type: 'number', min: 1, max: 1000 });
    const limit = el('input', 'input mcset-input mcbk-limit');
    Object.assign(limit, { type: 'number', min: 1, max: 100000 });
    const saved = el('div', 'mcbk-saved muted');
    const row = (label, desc, ctl) => {
      const r = el('div', 'mcset-row');
      const t = el('div', 'mcset-text');
      t.append(el('div', 'mcset-label', label), el('div', 'mcset-desc muted', desc));
      r.append(t, ctl);
      return r;
    };
    autoSec.append(el('h2', 'mcset-section-title', tr('Automatic Backups')),
      row(tr('While it runs'), tr('A backup every so many hours while the server runs, and one when it stops if the last is more than a day old.'), every),
      row(tr('Automatic backups kept'), tr('The oldest automatic backups go once there are more than this.'), keep),
      row(tr('Space for backups (GB)'), tr('Automatic backups also go, oldest first, while the backups take more than this.'), limit),
      el('div', 'mcset-note', tr('Backups you make with Back Up Now, and ones marked Keep, are never deleted by these rules. Deleted backups go to the Recycle Bin.')),
      saved);
    const applyPolicy = async () => {
      const p = { every: Number(every.value), keep: Number(keep.value), maxGB: Number(limit.value) };
      const ok = Number.isInteger(p.keep) && p.keep >= 1 && p.keep <= 1000 && Number.isFinite(p.maxGB) && p.maxGB >= 1;
      keep.classList.toggle('invalid', !(Number.isInteger(p.keep) && p.keep >= 1 && p.keep <= 1000));
      limit.classList.toggle('invalid', !(Number.isFinite(p.maxGB) && p.maxGB >= 1));
      if (!ok) { saved.textContent = tr('Fix the values marked in red.'); return; }
      try { await invoke('backupPolicy', srv.dir, p); saved.textContent = tr('Saved.'); } catch (err) { saved.textContent = mc.errorText(err); }
    };
    every.onchange = applyPolicy;
    keep.onchange = applyPolicy;
    limit.onchange = applyPolicy;

    const whatSec = el('section', 'mcset-section mcbk-section');
    whatSec.append(el('h2', 'mcset-section-title', tr('What a Backup Holds')),
      el('div', 'mcset-note', tr('The world (with its Nether and End folders), server.properties, the whitelist, operators and bans, the other settings files, config/ and the plugins\' settings. Mods, plugin jars, libraries, logs and the server jar are left out: they are large and can be downloaded again, and a restore leaves them as they are. Each backup is a .zip in the server\'s backups folder, which Explorer and 7-Zip open.')));
    scroll.append(listSec, autoSec, whatSec);

    Object.assign(v, { state, now, summary, progress, ptext, pbar, pcancel, list, every, keep, limit, saved });
    views.add(v);
    paintStates();
    load(v);
  }

  async function load(v) {
    let r;
    try { r = await invoke('backups', v.srv.dir); } catch (err) { v.list.replaceChildren(el('div', 'mcset-error', mc.errorText(err))); return; }
    v.data = r;
    if (![...v.every.options].some((o) => o.value === String(r.policy.every))) v.every.add(new Option(tr('Every {hours} hours', { hours: r.policy.every }), String(r.policy.every)));
    v.every.value = String(r.policy.every);
    if (document.activeElement !== v.keep) v.keep.value = String(r.policy.keep);
    if (document.activeElement !== v.limit) v.limit.value = String(r.policy.maxGB);
    const limitBytes = r.policy.maxGB * 1024 ** 3;
    v.summary.textContent = !r.items.length ? tr('No backups yet. Back Up Now makes the first one.')
      : tr('{count} backups · {used} of {limit} used', { count: r.items.length, used: bytes(r.used), limit: `${r.policy.maxGB} GB` });
    v.summary.classList.toggle('mcbk-over', r.used > limitBytes);
    v.list.replaceChildren(...r.items.map((b) => itemRow(v, b)));
    if (r.busy) paintProgress(v, { ...r.busy, dir: v.srv.dir, state: 'running' });
    else { v.progress.classList.add('hidden'); v.busy = null; }
    paintButtons(v);
  }
  function itemRow(v, b) {
    const r = el('div', `mcbk-item${b.damaged ? ' damaged' : ''}`);
    r.dataset.name = b.name;
    const t = el('div', 'mcbk-item-text');
    const top = el('div', 'mcbk-item-top');
    top.append(el('span', 'mcbk-when', when(b.created)), el('span', `mcbk-reason${b.auto ? '' : ' manual'}`, REASON()[b.reason] || b.reason));
    const meta = [b.mc ? tr('Minecraft {version}', { version: b.mc }) : null, bytes(b.size), b.damaged ? tr('Cannot be read') : null].filter(Boolean).join(' · ');
    t.append(top, el('div', 'mcbk-meta muted', meta));
    const keepBox = el('label', 'mcbk-keepbox');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = b.keep || !b.auto;
    c.disabled = !b.auto;
    keepBox.title = b.auto ? tr('Kept: the automatic rules never delete it') : tr('A backup you made is always kept');
    c.onchange = async () => { try { await invoke('backupKeep', v.srv.dir, b.file, c.checked); } catch (err) { ide.ui.alert(mc.errorText(err)); } load(v); };
    keepBox.append(c, el('span', null, tr('Keep')));
    const restore = el('button', 'secondary mcbk-restore', tr('Restore…'));
    restore.disabled = b.damaged;
    restore.onclick = () => restoreFlow(v, b);
    const del = el('button', 'secondary mcbk-delete', tr('Delete'));
    del.onclick = async () => {
      if (!(await ide.ui.confirm(tr('Move the backup of {when} to the Recycle Bin?', { when: when(b.created) }), { ok: tr('Delete') }))) return;
      try { await invoke('backupDelete', v.srv.dir, b.file); } catch (err) { ide.ui.alert(mc.errorText(err)); }
      load(v);
    };
    r.append(t, keepBox, restore, del);
    return r;
  }
  function paintProgress(v, ev) {
    if (ev.state !== 'running') { v.progress.classList.add('hidden'); v.busy = null; paintButtons(v); return; }
    v.busy = ev;
    v.progress.classList.remove('hidden');
    v.progress.dataset.op = ev.op;
    const p = percentOf(ev);
    v.ptext.textContent = `${ev.op === 'restore' ? tr('Restoring') : tr('Backing up')} · ${progressText(ev)}`;
    v.pbar.firstChild.style.width = `${p ?? 0}%`;
    v.pbar.dataset.percent = String(p ?? 0);
    v.pcancel.onclick = () => ide.api.invoke('minecraft:backupCancel', ev.job);
    paintButtons(v);
  }
  function paintButtons(v) {
    const busy = !!v.busy;
    v.now.disabled = busy;
    for (const b of v.list.querySelectorAll('.mcbk-restore, .mcbk-delete')) b.disabled = busy || (b.classList.contains('mcbk-restore') && b.closest('.mcbk-item').classList.contains('damaged'));
  }
  function paintStates() {
    for (const v of views) {
      const running = mc.runningAt(v.srv.dir);
      v.state.classList.toggle('on', running);
      v.state.textContent = running ? tr('Running') : tr('Stopped');
    }
  }

  async function backUpNow(v) {
    try {
      await track(v.srv.dir, { title: tr('Backing up {name}…', { name: v.srv.name }), run: (job) => invoke('backupNow', v.srv.dir, { reason: 'manual', job }) });
      v.saved.textContent = '';
    } catch (err) {
      if (!cancelled(err)) ide.ui.alert(tr('{name} was not backed up: {error}', { name: v.srv.name, error: failure(v.srv.name, err) }));
    }
    load(v);
  }

  // Restore asks first, saying what goes back and what stays, and needs the server stopped.
  async function restoreFlow(v, b) {
    const srv = mc.servers().find((s) => same(s.dir, v.srv.dir)) || v.srv;
    if (srv.leftOver) { ide.ui.alert(tr('{name} is still running from before, outside this window. End it on its card first.', { name: srv.name })); return; }
    const running = mc.runningAt(srv.dir) || mc.stoppingAt(srv.dir);
    const box = el('div', 'mcbk-dialog');
    box.append(el('div', 'dialog-message', tr('{name} goes back to {when}: its world ({worlds}) and its settings files (server.properties, the whitelist, operators and bans, config/ and the plugins\' settings) are replaced by the backup\'s.', { name: srv.name, when: when(b.created), worlds: b.worlds.join(', ') || b.levelName || 'world' })),
      el('div', 'dialog-message', tr('Mods, plugins and the server itself stay as they are now. What is there now is backed up first ("Before a restore"), so this can be undone.')));
    if (b.mc && srv.mc && b.mc !== srv.mc) box.append(el('div', 'dialog-message mcbk-warn', tr('This backup was made on Minecraft {then}, and the server now runs {now}. Minecraft cannot open a world saved by a newer version.', { then: b.mc, now: srv.mc })));
    if (running) box.append(el('div', 'dialog-message mcbk-warn', tr('{name} is running. It is stopped first, which saves its world and drops the players on it.', { name: srv.name })));
    const only = el('label', 'mcbk-worldonly');
    const c = el('input');
    c.type = 'checkbox';
    only.append(c, el('span', null, tr('Restore the world only (keep the current settings files)')));
    box.append(only);
    const go = await new Promise((resolve) => {
      let yes = false;
      ide.ui.dialog({ title: tr('Restore Backup'), body: box, width: 560, onClose: () => resolve(yes),
        buttons: [{ label: running ? tr('Stop and Restore') : tr('Restore'), primary: true, run: () => { yes = true; } }, { label: tr('Cancel') }] });
    });
    if (!go) return;
    if (running && !(await stopFirst(srv))) return;
    try {
      const r = await track(srv.dir, { title: tr('Restoring {name}…', { name: srv.name }), run: (job) => invoke('backupRestore', srv.dir, b.file, { worldOnly: c.checked, job }) });
      await mc.refresh();
      mc.settings?.reload?.(srv.dir);
      ide.refreshTree?.();
      ide.notifications?.notify({ title: tr('{name} is back to {when}', { name: srv.name, when: when(b.created) }), kind: 'ok', group: 'Minecraft', raw: true,
        text: c.checked ? tr('The world was restored; the settings files were left as they were.') : tr('The world and the settings files were restored. What was there before is in the backup "Before a restore".'),
        actions: [{ label: tr('Start Server'), run: (n) => { n.expire(); mc.startServer(mc.servers().find((s) => same(s.dir, srv.dir)) || srv); } }] });
      return r;
    } catch (err) {
      if (!cancelled(err)) ide.ui.alert(tr('{name} was not restored: {error}', { name: srv.name, error: failure(srv.name, err) }));
      return null;
    } finally { load(v); }
  }
  // Stops the server as its Stop does, and waits until its process has ended (it saves first, which takes a while).
  async function stopFirst(srv) {
    const task = ide.tasks?.start({ title: tr('Stopping {name} to restore it…', { name: srv.name }) });
    try {
      if (mc.runningAt(srv.dir) && !mc.stoppingAt(srv.dir)) runSession(srv.dir)?.stop();
      for (let i = 0; i < 16 * 60 * 4 && (mc.runningAt(srv.dir) || mc.stoppingAt(srv.dir)); i++) await new Promise((r) => { setTimeout(r, 250); });
      if (mc.runningAt(srv.dir)) { ide.ui.alert(tr('{name} did not stop, so nothing was restored.', { name: srv.name })); return false; }
      // Main sees the process end a moment after the window does.
      await new Promise((r) => { setTimeout(r, 500); });
      return true;
    } finally { task?.done(); }
  }

  ide.on('runSessionStarting', () => setTimeout(paintStates, 0));
  mc.backups = { open, tabId, before, paintStates };
})();
