// The export queue (video-editor-features.md section 15 [2]): exports added from the export settings (Add to Queue)
// run one at a time in the background while editing goes on, in the Export Queue panel of the Export workspace.
//
// A job holds a copy of the project made when it was added, so later edits never reach it, with the resolved
// settings, the range, the captions choice and the file. Jobs wait while the export dialog's own export runs. Each
// row shows the preset, range, file, progress and state, and can be cancelled, removed, retried, moved up or down and,
// once written, shown in Explorer. The queue lives in this module, not in the panel, so switching workspaces or
// closing the panel changes nothing; while one runs the IDE asks before the window closes (Cut.ui.syncBusy).
//
// Cut.ui.exportQueue: add(spec) -> job, cancel(id), remove(id), retry(id), move(id, delta), openFolder(id),
// clearFinished(), jobs(), busy, writes(path), busyLabels(), kick().
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, button } = ui;
  const log = ide.logger('#cut');

  const jobs = []; // {id, project, seqId, seqName, fps, path, settings, range, captions, presetName, state, fraction, error, result, controller, task}
  let nextId = 1;
  let current = null;
  const changed = () => { Cut.app?.emit('exportQueue', { jobs: jobs.length }); ui.syncBusy?.(); };
  const find = (id) => jobs.find((j) => j.id === id);
  const fileName = (j) => ui.basename(j.path);
  const live = (j) => j.state === 'waiting' || j.state === 'running';

  function add(spec) {
    const job = { ...spec, id: nextId++, state: 'waiting', fraction: 0, error: null, result: null };
    jobs.push(job);
    changed();
    kick();
    return job;
  }
  // The next waiting job starts when nothing else exports.
  function kick() {
    if (current || ui.exportDialog?.running) return;
    const job = jobs.find((j) => j.state === 'waiting');
    if (job) run(job).catch((err) => log.error(`export queue: ${err?.stack || err}`));
  }
  async function run(job) {
    current = job;
    job.state = 'running';
    job.fraction = 0;
    job.error = null;
    job.result = null;
    job.controller = new AbortController();
    const { signal } = job.controller;
    job.task = ide.tasks?.start({ title: tr('Exporting {name} (queue)', { name: fileName(job) }), fraction: 0, onCancel: () => job.controller?.abort() });
    changed();
    let r;
    try {
      r = await Cut.export.run({
        project: job.project, seqId: job.seqId, path: job.path, settings: job.settings, range: job.range, captions: job.captions, captionTrack: job.captionTrack, signal,
        onProgress: (p) => {
          const f = typeof p === 'number' ? p : p?.fraction;
          if (f == null || !Number.isFinite(f)) return;
          job.fraction = f;
          job.task?.update({ fraction: f });
          Cut.app?.emit('exportQueue', { progress: job.id });
        },
      });
    } catch (err) {
      r = { ok: false, error: err?.message || String(err) };
    }
    job.task?.done();
    job.task = null;
    job.controller = null;
    if (signal.aborted || r?.code === 'cancelled') job.state = 'cancelled';
    else if (r?.ok) {
      job.state = 'done';
      job.fraction = 1;
      job.path = r.path || job.path;
      job.result = { bytes: r.bytes, seconds: r.seconds, problems: r.verified?.problems || [] };
      ui.toast(tr('Exported {name}', { name: fileName(job) }));
    } else {
      job.state = 'failed';
      job.error = typeof r?.error === 'string' ? r.error : r?.error?.message || 'unknown error';
      ui.notify(tr('The export of {name} failed: {error}', { name: fileName(job), error: tr(job.error) }), { kind: 'warn' });
    }
    current = null;
    changed();
    kick();
  }
  function cancel(id) {
    const j = find(id);
    if (!j) return false;
    if (j.state === 'running') j.controller?.abort();
    else if (j.state === 'waiting') { j.state = 'cancelled'; changed(); }
    return true;
  }
  function remove(id) {
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0 || jobs[i].state === 'running') return false;
    jobs.splice(i, 1);
    changed();
    return true;
  }
  function retry(id) {
    const j = find(id);
    if (!j || live(j)) return false;
    j.state = 'waiting';
    j.fraction = 0;
    j.error = null;
    changed();
    kick();
    return true;
  }
  // Moves a job up (-1) or down (+1) in the list; the order is the order they run in.
  function move(id, delta) {
    const i = jobs.findIndex((j) => j.id === id);
    const to = i + Math.sign(delta);
    if (i < 0 || to < 0 || to >= jobs.length) return false;
    [jobs[i], jobs[to]] = [jobs[to], jobs[i]];
    changed();
    return true;
  }
  const openFolder = (id) => { const j = find(id); return j ? ide.api.invoke('cut:reveal', j.path) : null; };
  function clearFinished() {
    for (let i = jobs.length - 1; i >= 0; i--) if (!live(jobs[i])) jobs.splice(i, 1);
    changed();
  }

  // ---------- the panel ----------
  const STATE = {
    waiting: () => tr('Waiting'),
    running: (j) => tr('Exporting {pct}%', { pct: Math.floor(j.fraction * 100) }),
    done: (j) => (j.result ? tr('Done: {size} in {time}', { size: ui.formatBytes(j.result.bytes), time: ui.exportDialog?.formatSeconds?.(j.result.seconds || 0) ?? '' }) : tr('Done')),
    failed: (j) => tr('Failed: {error}', { error: tr(j.error || '') }),
    cancelled: () => tr('Cancelled'),
  };
  const rangeText = (j) => (j.range ? tr('In to Out ({from} – {to})', { from: Cut.time.timecode(j.range.in, j.fps || [30, 1]), to: Cut.time.timecode(j.range.out, j.fps || [30, 1]) }) : tr('Entire sequence'));

  function mount(root, app) {
    root.classList.add('cut-queue');
    const note = el('div', 'cut-queue-note', tr('Queued exports run one at a time while you keep editing. Playback may be slower while one runs.'));
    const list = el('div', 'cut-queue-list');
    const foot = el('div', 'cut-queue-foot');
    const clear = button({ label: tr('Clear Finished'), cls: 'cut-queue-clear', onClick: () => clearFinished() });
    foot.appendChild(clear);
    root.append(note, list, foot);
    const rows = new Map(); // job id -> {row, fill, state, key}
    let shape = '';
    function draw() {
      // Rows are rebuilt only when jobs come, go, move or change state; progress updates them in place, so a button
      // under the pointer is never replaced while it is being clicked.
      const now = jobs.map((j) => `${j.id}:${j.state}`).join(',');
      if (now !== shape) {
        shape = now;
        rows.clear();
        list.replaceChildren();
        jobs.forEach((j, i) => list.appendChild(row(j, i)));
        if (!jobs.length) list.appendChild(el('div', 'cut-empty', tr('No exports are queued. Choose Add to Queue in the export settings.')));
      }
      for (const j of jobs) {
        const r = rows.get(j.id);
        if (!r) continue;
        r.fill.style.width = `${Math.round(j.fraction * 1000) / 10}%`;
        r.state.textContent = (STATE[j.state] || (() => j.state))(j);
      }
      clear.disabled = !jobs.some((j) => !live(j));
    }
    function row(j, i) {
      const r = el('div', 'cut-queue-job', undefined, { 'data-id': j.id, 'data-state': j.state });
      const name = el('div', 'cut-queue-name', fileName(j));
      name.dataset.userText = '';
      name.title = j.path;
      const details = el('div', 'cut-queue-details', `${j.presetName} · ${j.seqName} · ${rangeText(j)}`);
      const path = el('div', 'cut-queue-path', j.path);
      path.dataset.userText = '';
      const bar = el('div', 'cut-progress cut-queue-progress');
      const fill = el('div', 'cut-progress-fill');
      bar.appendChild(fill);
      const state = el('div', 'cut-queue-state');
      const tools = el('div', 'cut-queue-tools');
      const add = (cls, label, fn, { disabled = false, title = label } = {}) => tools.appendChild(button({ label, title, cls, disabled, onClick: fn }));
      add('cut-queue-up', '↑', () => move(j.id, -1), { disabled: i === 0 || j.state === 'running', title: tr('Move Up') });
      add('cut-queue-down', '↓', () => move(j.id, 1), { disabled: i === jobs.length - 1 || j.state === 'running', title: tr('Move Down') });
      if (live(j)) add('cut-queue-cancel', tr('Cancel'), () => cancel(j.id));
      if (j.state === 'failed' || j.state === 'cancelled') add('cut-queue-retry', tr('Retry'), () => retry(j.id));
      if (j.state === 'done') add('cut-queue-open', tr('Open Folder'), () => openFolder(j.id));
      if (j.state !== 'running') add('cut-queue-remove', tr('Remove'), () => remove(j.id));
      r.append(name, details, path, bar, state, tools);
      if (j.result?.problems?.length) r.appendChild(el('div', 'cut-queue-problems', tr('The check found problems: {list}', { list: j.result.problems.map((x) => tr(x.message || x.code || '', x.params)).join('; ') })));
      rows.set(j.id, { row: r, fill, state });
      return r;
    }
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    const off = app.on('exportQueue', later);
    draw();
    return () => { off(); cancelAnimationFrame(raf); };
  }
  ui.registerPanel('queue', { title: () => tr('Export Queue'), mount });

  ui.exportQueue = {
    add, cancel, remove, retry, move, openFolder, clearFinished, kick,
    jobs: () => jobs.map((j) => ({ id: j.id, path: j.path, state: j.state, fraction: j.fraction, error: j.error, result: j.result, range: j.range, presetName: j.presetName, seqName: j.seqName })),
    get busy() { return !!current; },
    writes: (path) => jobs.some((j) => live(j) && String(j.path).toLowerCase() === String(path).toLowerCase()),
    busyLabels: () => jobs.filter(live).map((j) => tr('Export of {name}', { name: fileName(j) })),
  };
})();
