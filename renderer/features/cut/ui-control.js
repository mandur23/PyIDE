// What the control API's tools (Cut.control, docs/cut-ai-control.md) need of the page beyond Cut.commands: the
// keyboard's actions (run_action), the Automation menu's jobs without their dialogs, media in, saving, the frame,
// caption and sequence exports, the export queue and proxies. ui-assistant.js hands these to every call, with the
// call's Stop signal and a progress function that shows in the chat.
//
// The rules that keep the user's files the user's live here:
// - import: a file in the project's folder (by its real path) comes in at once; any other only after the user
//   confirms it in a dialog that lists it, and nothing is looked at on the disk before that;
// - exports write new files only, in the project's folder (or Projects), after the user says yes; nothing is replaced;
// - save writes the project's own file; a project never saved opens Save As, where the user picks the place;
// - a job that needs a model asks in Cut's setup dialog (Download or Cancel); a no ends the call, nothing downloaded.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const { el } = ui;
  const invoke = (...args) => ide.api.invoke(...args);
  const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
  const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const inside = (p, dir) => !!dir && norm(p).startsWith(`${norm(dir)}\\`);
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  // ---------- asking first ----------
  // A yes/no dialog that lists `rows` ([key, value]) under a message. -> true for yes.
  function ask({ title, id, message, rows = [], list = null, note, yes, no }) {
    const body = el('div', 'cut-form cut-as-export');
    body.appendChild(el('div', 'dialog-message', message));
    if (rows.length) {
      const grid = el('div', 'cut-as-export-grid');
      for (const [k, v] of rows) grid.append(el('span', 'cut-as-export-key', k), el('span', 'cut-as-export-value', v));
      body.appendChild(grid);
    }
    if (list) {
      const ul = el('ul', 'cut-as-import-list');
      for (const x of list) { const li = el('li', null, x); li.dataset.userText = ''; ul.appendChild(li); }
      body.appendChild(ul);
    }
    if (note) body.appendChild(el('div', 'cut-dialog-note', note));
    return new Promise((resolve) => {
      let ok = false;
      ui.dialog({ title, id, body, width: 540, onClose: () => resolve(ok), buttons: [{ label: yes, primary: true, run: () => { ok = true; } }, { label: no }] });
    });
  }
  // The folder new files go to: the project's, or Projects for a project never saved.
  async function outputDir() {
    const app = Cut.app;
    if (app.path) return dirOf(app.path);
    return (await invoke('cut:home').catch(() => null))?.projects || null;
  }
  // A file name there that is free: not on the disk, not used by the project, not being written by the queue.
  async function freePath(dir, stem, ext) {
    const app = Cut.app;
    const clean = String(stem || 'Sequence').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Sequence';
    for (let n = 1; n < 100; n++) {
      const candidate = `${dir}\\${clean}${n > 1 ? ` (${n})` : ''}.${ext}`;
      const used = app.project.media.some((m) => norm(m.path) === norm(candidate)) || ui.exportQueue?.writes(candidate) || norm(app.path || '') === norm(candidate);
      if (used) continue;
      const st = await invoke('cut:stat', candidate).catch(() => null);
      if (st?.missing) return candidate;
    }
    return null;
  }

  // ---------- exports ----------
  async function exportAsk({ seq, preset, fileName, range, captions, settings }) {
    const app = Cut.app;
    const p = Cut.presets?.get?.(preset);
    if (!p || !ui.exportQueue) return { ok: false, error: 'exporting is not available' };
    const dir = await outputDir();
    if (!dir) return { ok: false, error: 'there is no folder to export to' };
    const path = await freePath(dir, fileName || seq.name, p.ext);
    if (!path) return { ok: false, error: 'no free file name' };
    const s = settings || Cut.presets.resolve(preset, seq, {});
    const fps = seq.fps;
    const rows = [
      [tr('Sequence:'), seq.name],
      [tr('Preset:'), tr(p.name)],
      ...(s.video ? [[tr('Video:'), `${s.width}x${s.height} ${s.video.family === 'hevc' ? 'HEVC' : 'H.264'} ${(s.video.bitrate / 1e6).toFixed(1)} Mbps`]] : []),
      [tr('File:'), path],
      [tr('Range:'), range ? `${Cut.time.timecode(range.in, fps)} – ${Cut.time.timecode(range.out, fps)}` : tr('Entire Sequence')],
    ];
    const yes = await ask({ title: tr('Export Requested by AI'), id: 'cutAsExport', message: tr('The AI wants to export this sequence to a new file.'), rows,
      note: tr('It joins the export queue. No existing file is replaced.'), yes: tr('Export'), no: tr('Don\'t Export') });
    if (!yes) return { ok: false, declined: true };
    const job = ui.exportQueue.add({
      project: JSON.parse(JSON.stringify(app.project)), seqId: seq.id, seqName: seq.name, fps: [...seq.fps], path, settings: JSON.parse(JSON.stringify(s)),
      range, captions: captions && p.kind !== 'audio' && seq.captions?.length ? 'burn' : null, captionTrack: captions ? (ui.captions?.trackOf?.(app)?.id || seq.captions?.[0]?.id || null) : null,
      presetName: tr(p.name),
    });
    ui.toast(tr('Added {name} to the export queue', { name: ui.basename(path) }));
    return { ok: true, name: ui.basename(path), path, job: job?.id ?? null };
  }
  // Waits for a queue job: {ok} when written, {cancelled} when Stop (the signal) or the user cancelled it.
  async function exportWait(id, { signal, progress } = {}) {
    const q = ui.exportQueue;
    const job = () => q.jobs().find((j) => j.id === id);
    let stopping = false;
    for (;;) {
      const j = job();
      if (!j) return { ok: false, error: 'the job left the queue' };
      if (j.state === 'done') return { ok: true };
      if (j.state === 'cancelled') return { ok: false, cancelled: true };
      if (j.state === 'failed') return { ok: false, error: j.error || 'failed' };
      if (signal?.aborted && !stopping) { stopping = true; q.cancel(id); }
      progress?.(j.fraction || 0, j.state === 'waiting' ? tr('Waiting in the export queue') : undefined);
      await settle(200);
    }
  }
  async function exportFrame({ seq, t, fileName }) {
    const dir = await outputDir();
    if (!dir) return { ok: false, error: 'there is no folder to save to' };
    const tc = Cut.time.timecode(t, seq.fps).replace(/:/g, '-');
    const path = await freePath(dir, fileName || `${seq.name || 'Frame'} ${tc}`, 'png');
    if (!path) return { ok: false, error: 'no free file name' };
    const yes = await ask({ title: tr('Export Frame Requested by AI'), id: 'cutAsFrame', message: tr('The AI wants to save a frame of this sequence as a new picture.'),
      rows: [[tr('Sequence:'), seq.name], [tr('Time:'), Cut.time.timecode(t, seq.fps)], [tr('File:'), path]], note: tr('No existing file is replaced.'), yes: tr('Save'), no: tr('Don\'t Save') });
    if (!yes) return { ok: false, declined: true };
    const r = await Cut.export.exportFrame(Cut.app.project, seq.id, t, path).catch((err) => ({ ok: false, error: err?.message || String(err) }));
    if (r?.ok === false) return { ok: false, error: String(r.error?.message || r.error || 'error') };
    ui.toast(tr('Saved {name}', { name: ui.basename(path) }));
    return { ok: true, name: ui.basename(path) };
  }
  async function exportCaptions({ seq, trackId, format, fileName }) {
    const app = Cut.app;
    const t = trackId ? seq.captions.find((x) => x.id === trackId) : (seq.id === app.sequenceId ? ui.captions?.trackOf?.(app) : null) || seq.captions[0];
    if (!t?.items.length) return { ok: false, error: 'the caption track is empty' };
    const dir = await outputDir();
    if (!dir) return { ok: false, error: 'there is no folder to save to' };
    const path = await freePath(dir, fileName || `${seq.name} ${t.name}`, format);
    if (!path) return { ok: false, error: 'no free file name' };
    const yes = await ask({ title: tr('Export Captions Requested by AI'), id: 'cutAsCaptions', message: tr('The AI wants to save captions to a new file.'),
      rows: [[tr('Captions:'), t.name], [tr('File:'), path]], note: tr('No existing file is replaced.'), yes: tr('Save'), no: tr('Don\'t Save') });
    if (!yes) return { ok: false, declined: true };
    const items = Cut.speakers.written(app.project, t, t.items, tr).map(({ start, end, text }) => ({ start, end, text }));
    try { await ui.captions.writeText(path, format === 'vtt' ? Cut.srt.writeVtt(items) : Cut.srt.write(items)); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    ui.toast(tr('Saved {name}', { name: ui.basename(path) }));
    return { ok: true, name: ui.basename(path), count: items.length };
  }
  const queue = {
    jobs: () => (ui.exportQueue?.jobs() || []).map((j) => ({ id: j.id, name: ui.basename(j.path), seqName: j.seqName, presetName: j.presetName, state: j.state, fraction: j.fraction, error: j.error || null })),
    cancel: (id) => ui.exportQueue.cancel(id) !== false,
    retry: (id) => ui.exportQueue.retry(id) !== false,
    remove: (id) => ui.exportQueue.remove(id) !== false,
    clearFinished: () => ui.exportQueue.clearFinished(),
  };

  // ---------- media in, saving ----------
  async function importMedia({ paths, folder, binId, seq }) {
    const app = Cut.app;
    if (!ui.media) return { ok: false, error: 'importing is not available' };
    if (folder) { const ids = await ui.media.importFolder(app); return ids?.length ? { ok: true, ids } : { declined: true }; }
    if (!paths) { const ids = await ui.media.importDialog(app, { binId }); return ids?.length ? { ok: true, ids } : { declined: true }; }
    // Inside the project's folder by name and by real path, or confirmed by the user before anything is looked at.
    const dirReal = app.path ? (await invoke('cut:stat', dirOf(app.path)).catch(() => null))?.path : null;
    const near = [];
    let far = [];
    for (const p of paths) (inside(p, app.path ? dirOf(app.path) : null) ? near : far).push(p);
    const files = [];
    const failed = [];
    const look = async (p) => {
      const st = await invoke('cut:stat', p).catch(() => null);
      if (!st || st.missing) { failed.push({ name: ui.basename(p), error: 'not found' }); return null; }
      if (!st.isFile) { failed.push({ name: ui.basename(p), error: 'a folder (import_media with folder: true lets the user pick one)' }); return null; }
      return st.path || p;
    };
    for (const p of near) {
      const real = await look(p);
      if (!real) continue;
      if (inside(real, dirReal)) files.push(real);
      else far.push(p);
    }
    far = [...new Set(far)];
    if (far.length) {
      const yes = await ask({ title: tr('Import Requested by AI'), id: 'cutAsImport', message: tr('The AI wants to import these files into the project:'), list: far,
        note: tr('Only these files are read; they are not changed.'), yes: tr('Import'), no: tr('Don\'t Import') });
      if (!yes) return { declined: true };
      for (const p of far) { const real = await look(p); if (real) files.push(real); }
    }
    const captionFiles = files.filter((p) => /\.(srt|vtt)$/i.test(p));
    const mediaFiles = files.filter((p) => !/\.(srt|vtt)$/i.test(p));
    const ids = mediaFiles.length ? (await ui.media.importPaths(app, mediaFiles, { binId })) || [] : [];
    const got = new Set(ids.map((id) => norm(app.project.media.find((m) => m.id === id)?.path || '')));
    for (const p of mediaFiles) if (!got.has(norm(p))) failed.push({ name: ui.basename(p), error: 'not a media file Cut can read' });
    const captionTracks = [];
    for (const p of captionFiles) {
      if (app.sequenceId !== seq.id) app.setSequence(seq.id);
      const n = await ui.captions.importFile(app, p, { newTrack: true });
      if (n > 0) captionTracks.push({ id: ui.captions.trackOf(app)?.id, captions: n });
      else failed.push({ name: ui.basename(p), error: 'no captions in it' });
    }
    return { ok: true, ids, captionTracks, failed };
  }
  async function save() {
    const app = Cut.app;
    const life = ui.lifecycle;
    if (!life) return { ok: false, error: 'saving is not available' };
    const said = [];
    const off = ui.listen((t, kind) => { if (kind === 'error' || kind === 'warn') said.push(t); });
    try {
      if (!app.path) return (await life.saveAs()) ? { ok: true, name: ui.basename(app.path) } : said.length ? { ok: false, error: said.join(' ') } : { declined: true };
      return (await life.save()) ? { ok: true, name: ui.basename(app.path) } : { ok: false, error: said.join(' ') || 'not saved' };
    } finally { off(); }
  }

  // ---------- proxies ----------
  const proxies = {
    state: (id) => {
      const m = Cut.app.project.media.find((x) => x.id === id);
      const s = m && ui.proxy ? ui.proxy.state(m) : { state: 'none' };
      return { proxy: s.state, ...(s.state === 'running' ? { progress: Math.round((s.fraction || 0) * 1000) / 1000 } : {}), ...(s.error ? { error: String(s.error) } : {}) };
    },
    create: (ids) => (ui.proxy ? ui.proxy.create(Cut.app, ids) : 0),
    // Until each media's job ends; Stop cancels the ones not done. -> {done, cancelled}
    async wait(ids, { signal, progress } = {}) {
      const mine = () => ui.proxy.jobs().filter((j) => ids.includes(j.mediaId));
      const open = (j) => j.state === 'waiting' || j.state === 'running';
      let stopped = false;
      for (;;) {
        const list = mine();
        const done = ids.filter((id) => proxies.state(id).proxy === 'ready').length;
        if (!list.some(open)) return { done, cancelled: stopped };
        if (signal?.aborted && !stopped) { stopped = true; for (const j of list) if (open(j)) ui.proxy.cancel(j.mediaId); }
        const f = list.reduce((n, j) => n + (j.state === 'done' ? 1 : j.fraction || 0), 0) / Math.max(1, list.length);
        progress?.(f, tr('Proxies: {n} of {m} ready', { n: done, m: ids.length }));
        await settle(200);
      }
    },
  };

  // ---------- run_action ----------
  async function action(id, { panel } = {}) {
    const app = Cut.app;
    const said = [];
    const off = ui.listen((t) => said.push(t));
    try {
      let ran;
      if (id.startsWith('window.')) { ui.openPanel?.(id.slice('window.'.length)); ran = true; } else if (id === 'auto.nextUncertain' || id === 'auto.prevUncertain') {
        ran = (await ui.speech.nextUncertain(app, id === 'auto.nextUncertain' ? 1 : -1)) != null;
      } else ran = ui.runAction(id, { source: 'ai', panel: panel ?? 'timeline', app });
      await settle();
      return { ran, toasts: said };
    } finally { off(); }
  }
  const view = () => ({
    workspace: ui.workspace ?? null, snapping: !!ui.editing?.snapping, maximized: !!document.querySelector('.cut-root .maximized'),
    panels: [...document.querySelectorAll('.cut-root [data-panel]')].map((n) => n.dataset.panel).join(','),
    heights: (Cut.app.sequence?.tracks || []).map((t) => t.height ?? '').join(','),
  });

  // ---------- automation ----------
  // The clips and range a job works on, as the menu sees them: the selection and In/Out, put back after.
  function scope(app, { clipIds, range, time }) {
    const sel = [...app.selection];
    const io = { ...app.inOut };
    if (clipIds) app.select(clipIds, { add: false });
    if (range) app.setInOut({ in: range[0], out: range[1] });
    if (time != null) app.setTime(Cut.time.snap(Math.round(time * Cut.time.TICKS), app.sequence.fps));
    return () => {
      if (clipIds) app.select(sel.filter((id) => app.sequence?.clips.some((c) => c.id === id)), { add: false });
      if (range) app.setInOut(io);
    };
  }
  const SPEECH = new Set(['transcribe', 'auto_captions', 'remove_fillers']);
  async function automation(action2, a, { seq, signal, progress }) {
    const app = Cut.app;
    if (app.sequenceId !== seq.id) app.setSequence(seq.id);
    if (ui.auto.running) return { ok: false, error: 'Another analysis is running in Cut; wait for it, or ask the user to cancel it.' };
    // the setup dialogs first: the user agrees to a download there, or the job ends
    let declined = false;
    const speechReady = ui.speech.ensureReady;
    if (SPEECH.has(action2) && !(await ui.speech.ensureReady())) return { declined: true };
    if (action2 === 'label_speakers' && !(await ui.speakers.ensureReady())) return { declined: true };
    if (action2 === 'isolate_voice' && !(await ui.voice.ensureReady())) return { declined: true };
    if (action2 === 'label_speakers') ui.speech.ensureReady = async (...x) => { const ok = await speechReady(...x); if (!ok) declined = true; return ok; };
    const watch = { signal, progress, cancelled: false };
    const offWatch = ui.auto.observe(watch);
    const said = [];
    const offSaid = ui.listen((t, kind) => { if (kind !== 'info' || said.length < 4) said.push(t); });
    const h = app.history;
    const before = { n: h.list().filter((x) => x.done).length, pos: h.position };
    const restore = scope(app, { clipIds: a.clipIds, range: a.range, time: action2 === 'auto_color' ? a.time : null });
    let r = null;
    try {
      const A = ui.auto;
      const run = {
        transcribe: () => ui.speech.recognize(app, { language: a.language && a.language !== 'auto' ? a.language : null }),
        auto_captions: () => ui.speech.autoCaptions(app, { ask: false, language: a.language, chars: a.chars_per_line, highlight: a.highlight }),
        remove_fillers: () => ui.speech.removeFillers(app, { ask: false, fillers: a.fillers, pauses: a.pauses, pauseLength: a.pause_length, keep: a.keep }),
        label_speakers: () => ui.speakers.label(app, a.speakers != null ? { count: a.speakers } : {}),
        isolate_voice: () => ui.voice.isolate(app),
        detect_scenes: () => A.detectScenes(app, { ask: false, action: a.mode === 'split' ? 'split' : 'markers', threshold: a.threshold }),
        detect_beats: () => A.detectBeats(app, { ask: false, every: a.every }),
        match_loudness: () => A.matchLoudness(app, { ask: false, target: a.target }),
        match_clip_loudness: () => A.matchClipLoudness(app, { ask: false, target: a.target }),
        auto_duck: () => A.autoDuck(app, { ask: false, amount: a.amount, fade: a.fade, threshold: a.threshold }),
        auto_color: () => A.autoColor(app),
      }[action2];
      r = await run();
    } catch (err) {
      said.push(err?.message || String(err));
    } finally {
      restore();
      offWatch();
      offSaid();
      ui.speech.ensureReady = speechReady;
    }
    if (declined) return { declined: true };
    if (watch.cancelled || signal?.aborted) return { cancelled: true };
    const after = { n: h.list().filter((x) => x.done).length, pos: h.position };
    const changed = h === app.history && (after.n !== before.n || after.pos !== before.pos);
    if (!r && !changed) return { ok: false, error: said.join(' ') || `${action2} changed nothing.` };
    const value = { job: action2, ...(r && typeof r === 'object' ? r : {}), ...(said.length ? { said } : {}) };
    if (action2 === 'transcribe') value.note = 'Recognized: get_transcript reads it.';
    if (value.speech) value.speech = value.speech.length;
    return { ok: true, changed, value, at: app.t, seqId: app.sequenceId };
  }

  ui.controlServices = {
    exportAsk, exportWait, exportFrame, exportCaptions, queue, importMedia, save, proxies, action, view, automation,
    offline: (id) => !!ui.offline?.has?.(id),
    clipboard: () => ui.timeline.clipboard?.length || 0,
    showCaptionTrack: (seq, id) => { const app = Cut.app; if (app.sequenceId !== seq.id) app.setSequence(seq.id); ui.captions?.show?.(app, id); },
  };
})();
