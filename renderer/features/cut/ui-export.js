// Export (video-editor-features.md section 15): the settings form, shown in the Export dialog (Ctrl+M) and in the
// Export workspace's panel: the sequence, a preset, size, codec (HEVC only when the PC encodes it in hardware),
// bitrate, keyframe interval, audio bitrate, the range (all or In to Out), captions (burned in, an SRT file beside the
// video, or both), the loudness target, the file; the estimated size and time; then progress with Cancel, and the
// result with what the check of the written file found. Export Frame (Ctrl+Shift+E) saves the program frame as PNG,
// and the chapter markers can be copied as a YouTube chapter list. Add to Queue hands the same settings, with a copy
// of the project as it is now, to the export queue (ui-queue.js), which runs one export at a time in the background.
//
// Cut.ui.exportDialog: open(app), exportFrame(app), running (the export in progress or null), form(app) -> Form.
// Cut.ui.syncBusy(): tells the IDE's close question about the exports that run (this one and the queue's).
(() => {
  const Cut = (globalThis.Cut = globalThis.Cut || {});
  const ui = Cut.ui;
  const { el, button } = ui;
  const log = ide.logger('#cut');
  const T = () => Cut.time;

  const MBPS = 1e6;
  let running = null; // {controller, name, task, promise}
  let hevcOk = null;

  // Closing the window while exports run asks first (window:setBusy, like a running program in the IDE).
  function syncBusy() {
    const names = running ? [tr('Export of {name}', { name: running.name })] : [];
    names.push(...(ui.exportQueue?.busyLabels?.() || []));
    ide.api.send('window:setBusy', names);
  }

  // HEVC is offered only when this PC has a hardware encoder for it (software HEVC is too slow to be useful).
  async function hevcAvailable() {
    if (hevcOk !== null) return hevcOk;
    hevcOk = false;
    try {
      const r = await globalThis.VideoEncoder?.isConfigSupported?.({ codec: 'hvc1.1.6.L120.90', width: 1920, height: 1080, bitrate: 10e6, framerate: 30, hardwareAcceleration: 'prefer-hardware' });
      hevcOk = !!r?.supported;
    } catch { hevcOk = false; }
    return hevcOk;
  }

  const presetList = () => Cut.presets?.list?.() || [];
  const fpsLabel = (fps) => { const v = fps[0] / fps[1]; return `${Number.isInteger(v) ? v : v.toFixed(3).replace(/0+$/, '')} fps`; };

  // The chapter markers as YouTube wants them: "00:00 Title" lines, the first at 00:00.
  function chaptersText(seq) {
    if (typeof Cut.export?.chapters === 'function') return Cut.export.chapters(seq, { firstName: tr('Intro') });
    const list = (seq.markers || []).filter((m) => m.kind === 'chapter').sort((a, b) => a.t - b.t);
    const fmt = (t) => {
      const s = Math.floor(T().toSeconds(t));
      const hh = Math.floor(s / 3600);
      const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
    };
    return list.map((m, i) => `${fmt(i === 0 ? 0 : m.t)} ${m.name || tr('Chapter {n}', { n: i + 1 })}`).join('\n');
  }

  // ---------- the form ----------
  // -> {el, settings() -> {seqId, preset, overrides, resolved, range, captions, path}, refresh(), start(), busy}
  function form(app, { inline = false } = {}) {
    const root = el('div', `cut-export-form${inline ? ' inline' : ''}`);
    const seqSel = ui.select({ options: [], cls: 'cut-export-seq', onChange: () => { pathTouched = false; refresh(); } });
    const presetSel = ui.select({ options: presetList().map((p) => ({ value: p.id, label: tr(p.name) })), value: ide.settings.get('cut.export.preset', 'youtube-1080p'), cls: 'cut-export-preset',
      onChange: () => { ide.settings.set('cut.export.preset', presetSel.value); fromPreset(); } });
    const codecSel = ui.select({ options: [{ value: 'h264', label: 'H.264' }], value: 'h264', cls: 'cut-export-codec', onChange: () => refresh() });
    const w = ui.numberField({ value: 1920, min: 16, max: 8192, step: 2, precision: 0, unit: 'px', cls: 'cut-export-w', onChange: () => refresh() });
    const h = ui.numberField({ value: 1080, min: 16, max: 8192, step: 2, precision: 0, unit: 'px', cls: 'cut-export-h', onChange: () => refresh() });
    const rate = el('span', 'cut-form-value cut-export-fps');
    const modeSel = ui.select({ options: [{ value: 'variable', label: tr('Variable bitrate, 1 pass') }, { value: 'constant', label: tr('Constant bitrate') }], value: 'variable', cls: 'cut-export-mode', onChange: () => refresh() });
    const bitrate = ui.numberField({ value: 10, min: 0.5, max: 200, step: 0.5, precision: 1, unit: 'Mbps', cls: 'cut-export-bitrate', onChange: () => refresh() });
    const keySec = ui.numberField({ value: 2, min: 0.5, max: 10, step: 0.5, precision: 1, unit: tr('s'), cls: 'cut-export-key', onChange: () => refresh() });
    const audioSel = ui.select({ options: (Cut.presets?.AUDIO_BITRATES || [128000, 160000, 192000]).map((b) => ({ value: b, label: `${b / 1000} kbps` })), value: 192000, cls: 'cut-export-audio', onChange: () => refresh() });
    const loudSel = ui.select({ options: [{ value: '-14', label: tr('YouTube (-14 LUFS)') }, { value: '-24', label: tr('Broadcast (-24 LUFS)') }, { value: 'off', label: tr('Do not change') }], value: '-14', cls: 'cut-export-loudness', onChange: () => refresh() });
    const rangeSel = ui.select({ options: [{ value: 'all', label: tr('Entire sequence') }, { value: 'inout', label: tr('In to Out') }], value: 'all', cls: 'cut-export-range', onChange: () => refresh() });
    const capSel = ui.select({ options: [{ value: 'none', label: tr('None') }, { value: 'burn', label: tr('Burn into the video') }, { value: 'srt', label: tr('SRT file beside the video') }, { value: 'both', label: tr('Both') }], value: 'none', cls: 'cut-export-captions', onChange: () => refresh() });
    // which of several caption tracks is burned in: the one shown in the captions panel (and the program monitor)
    const burnNote = el('div', 'cut-dialog-note cut-export-burn-track');
    burnNote.hidden = true;
    const pathIn = el('input', 'cut-export-path', undefined, { type: 'text', spellcheck: 'false' });
    let pathTouched = false;
    pathIn.addEventListener('input', () => { pathTouched = true; refresh(); });
    const browse = button({ label: tr('Browse…'), cls: 'cut-export-browse', onClick: async () => {
      const r = resolvedNow();
      const ext = r?.ext || 'mp4';
      const p = await ide.api.invoke('cut:saveAs', { defaultPath: pathIn.value, filters: [{ name: ext === 'm4a' ? tr('MPEG-4 audio') : tr('MPEG-4 video'), extensions: [ext] }], title: tr('Export To') });
      if (p) { pathIn.value = p; pathTouched = true; refresh(); }
    } });
    const pathRow = el('div', 'cut-export-path-row');
    pathRow.append(pathIn, browse);
    const estimate = el('div', 'cut-export-estimate');
    const warn = el('div', 'cut-export-warn');
    const loudness = el('div', 'cut-export-measure');
    const measureBtn = button({ label: tr('Measure Loudness'), cls: 'cut-export-measure-btn', onClick: () => measure() });
    const chaptersBtn = button({ label: tr('Copy YouTube Chapters'), cls: 'cut-export-chapters', onClick: () => copyChapters() });
    const videoRows = el('div', 'cut-form-group');
    videoRows.append(ui.row(tr('Codec'), codecSel), ui.row(tr('Width'), w), ui.row(tr('Height'), h), ui.row(tr('Frame rate'), rate),
      ui.row(tr('Bitrate mode'), modeSel), ui.row(tr('Target bitrate'), bitrate), ui.row(tr('Keyframe every'), keySec));
    const body = el('div', 'cut-form');
    body.append(
      ui.row(tr('Sequence'), seqSel), ui.row(tr('Preset'), presetSel),
      el('div', 'cut-form-section', tr('Video')), videoRows,
      el('div', 'cut-form-section', tr('Audio')), ui.row(tr('Audio bitrate'), audioSel), ui.row(tr('Loudness'), loudSel),
      el('div', 'cut-form-section', tr('Output')), ui.row(tr('Range'), rangeSel), ui.row(tr('Captions'), capSel), burnNote, ui.row(tr('File'), pathRow),
    );
    const tools = el('div', 'cut-export-tools');
    tools.append(measureBtn, chaptersBtn);
    // progress and result
    const progress = el('div', 'cut-export-progress');
    progress.hidden = true;
    const bar = el('div', 'cut-progress');
    const fill = el('div', 'cut-progress-fill');
    bar.appendChild(fill);
    const ptext = el('div', 'cut-progress-text');
    progress.append(bar, ptext);
    const result = el('div', 'cut-export-result');
    result.hidden = true;
    root.append(body, estimate, warn, loudness, tools, progress, result);

    const seqOf = () => app.project?.sequences.find((s) => s.id === seqSel.value) || app.sequence;
    // The caption track burned in: the one the captions panel shows for the active sequence, else the first.
    const burnTrack = (seq) => (seq && seq.id === app.sequenceId && ui.captions?.trackOf(app)) || seq?.captions?.[0] || null;
    function fillSequences() {
      const list = app.project?.sequences || [];
      seqSel.setOptions(list.map((s) => ({ value: s.id, label: s.name })), list.some((s) => s.id === seqSel.value) ? seqSel.value : app.sequenceId);
    }
    function fromPreset() {
      const p = Cut.presets?.get?.(presetSel.value);
      const seq = seqOf();
      if (!p) return refresh();
      const r = Cut.presets.resolve(p, seq);
      if (r.video) {
        w.value = r.width;
        h.value = r.height;
        bitrate.value = Math.round((r.video.bitrate / MBPS) * 10) / 10;
        keySec.value = p.video.keySeconds || 2;
        modeSel.value = r.video.mode;
        codecSel.value = r.video.family === 'hevc' && hevcOk ? 'hevc' : 'h264';
      }
      audioSel.value = String(r.audio.bitrate);
      loudSel.value = r.loudness == null ? 'off' : String(r.loudness);
      refresh();
    }
    const overrides = () => {
      const p = Cut.presets?.get?.(presetSel.value);
      const o = { audioBitrate: Number(audioSel.value), loudness: loudSel.value === 'off' ? null : Number(loudSel.value) };
      if (p?.kind === 'video') Object.assign(o, { w: w.value, h: h.value, codec: codecSel.value, bitrate: Math.round(bitrate.value * MBPS), mode: modeSel.value, keySeconds: keySec.value });
      return o;
    };
    function resolvedNow() {
      try { return Cut.presets.resolve(presetSel.value, seqOf(), overrides()); } catch { return null; }
    }
    function range() {
      const seq = seqOf();
      if (rangeSel.value !== 'inout' || seq?.id !== app.sequenceId) return null;
      const io = app.inOut;
      if (io.in == null && io.out == null) return null;
      return { in: io.in ?? 0, out: io.out ?? Cut.model.sequenceDuration(seq) };
    }
    async function defaultPath() {
      const seq = seqOf();
      const r = resolvedNow();
      const home = await ide.api.invoke('cut:home').catch(() => null);
      const dir = app.path ? app.path.replace(/[\\/][^\\/]*$/, '') : home?.projects || '';
      const safe = String(seq?.name || 'Sequence').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Sequence';
      return `${dir}\\${safe}.${r?.ext || 'mp4'}`;
    }
    let refreshSeq = 0;
    async function refresh() {
      const my = ++refreshSeq;
      fillSequences();
      const seq = seqOf();
      const p = Cut.presets?.get?.(presetSel.value);
      const isVideo = p?.kind !== 'audio';
      videoRows.hidden = !isVideo;
      rate.textContent = seq ? fpsLabel(seq.fps) : '';
      const hasCaptions = !!seq?.captions?.some((c) => c.items.length);
      capSel.disabled = !hasCaptions || !isVideo;
      if (capSel.disabled) capSel.value = 'none';
      const burned = burnTrack(seq);
      burnNote.hidden = !(burned && seq.captions.length > 1 && (capSel.value === 'burn' || capSel.value === 'both'));
      burnNote.textContent = burned ? tr('Burns in the caption track shown in the Captions panel: {name}', { name: burned.name }) : '';
      const io = app.inOut;
      rangeSel.disabled = seq?.id !== app.sequenceId || (io.in == null && io.out == null);
      if (rangeSel.disabled) rangeSel.value = 'all';
      if (!pathTouched || !pathIn.value) {
        const d = await defaultPath();
        if (my !== refreshSeq) return;
        if (!pathTouched || !pathIn.value) pathIn.value = d;
      }
      const r = resolvedNow();
      // The preset's extension, also over the other one: export writes withExt(path, ext), so a talk.mp4 left in the field
      // with Audio only checked talk.mp4 for "Replace it?" and wrote over talk.m4a.
      if (r && !pathIn.value.toLowerCase().endsWith(`.${r.ext}`)) pathIn.value = pathIn.value.replace(/(\.[^.\\/]*)?$/, `.${r.ext}`);
      const rg = range();
      const len = rg ? rg.out - rg.in : seq ? Cut.model.sequenceDuration(seq) : 0;
      const problems = r ? (Cut.presets.validate?.(r) || []) : [tr('Choose a preset.')];
      if (!len) problems.push('The sequence is empty.');
      const offline = seq ? seq.clips.filter((c) => c.source?.media != null && ui.offline?.has(c.source.media)).length : 0;
      warn.replaceChildren(...problems.map((x) => el('div', 'cut-export-problem', tr(x))));
      if (offline) warn.appendChild(el('div', 'cut-export-offline', tr('{n} clips use offline media: they export as a red "media offline" picture.', { n: offline })));
      if (r && len) {
        const bytes = Cut.presets.estimate?.(r, len, { fps: seq.fps }) ?? 0;
        const secs = Cut.presets.estimateSeconds?.(r, len, { fps: seq.fps }) ?? null;
        estimate.textContent = tr('Duration {d} · about {size} · about {time} on this PC', {
          d: T().timecode(len, seq.fps), size: ui.formatBytes(bytes), time: secs == null ? '?' : formatSeconds(secs),
        });
      } else estimate.textContent = '';
      api.problems = problems;
      api.onChange?.();
    }
    // Measures the sequence's integrated loudness and true peak (the range when one is chosen).
    async function measure() {
      const seq = seqOf();
      if (!seq || !Cut.audioengine?.measure) return;
      const rg = range() || { in: 0, out: Cut.model.sequenceDuration(seq) };
      if (rg.out <= rg.in) return;
      loudness.textContent = tr('Measuring…');
      try {
        // measure() streams the mix; renderOffline would hold all of it (about 1.4 GB an hour).
        const l = await Cut.audioengine.measure(app.project, seq.id, rg.in, rg.out);
        loudness.textContent = tr('Integrated loudness {lufs} LUFS · true peak {peak} dBTP', {
          lufs: Number.isFinite(l.integrated) ? l.integrated.toFixed(1) : '-∞', peak: Number.isFinite(l.truePeak) ? l.truePeak.toFixed(1) : '-∞' });
        loudness.dataset.lufs = String(l.integrated);
      } catch (err) {
        loudness.textContent = tr('The loudness could not be measured: {error}', { error: err?.message || String(err) });
      }
    }
    async function copyChapters() {
      const seq = seqOf();
      const text = seq ? chaptersText(seq) : '';
      if (!text) { ui.toast(tr('Add chapter markers first (M, then set the marker type to Chapter).')); return; }
      await ide.api.invoke('clipboard:writeText', text);
      ui.toast(tr('YouTube chapters copied'));
    }

    // The checks before an export starts or joins the queue -> {seq, path, resolved, range, captions} or null.
    async function prepare({ queued = false } = {}) {
      await refresh();
      if (api.problems.length) { ui.toast(tr(api.problems[0])); return null; }
      if (typeof Cut.export?.run !== 'function') { ui.notify(tr('The export engine is not available.'), { kind: 'error' }); return null; }
      const seq = seqOf();
      const title = queued ? tr('Add to Queue') : tr('Export');
      const offline = seq.clips.some((c) => c.source?.media != null && ui.offline?.has(c.source.media));
      if (offline && !(await ui.confirm(tr('Some clips use offline media and will export as a red "media offline" picture. Export anyway?'), { title, ok: title }))) return null;
      const path = pathIn.value.trim();
      // Replacing a file the project reads would put the export where the footage was.
      const same = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
      const used = app.project.media.find((m) => same(m.path) === same(path) || same(m.proxy?.path) === same(path));
      if (used) { ui.notify(tr('{name} is a media file of this project. Export to another name.', { name: ui.basename(path) }), { kind: 'warn' }); return null; }
      if (ui.exportQueue?.writes?.(path)) { ui.toast(tr('An export in the queue already writes {name}.', { name: ui.basename(path) })); return null; }
      const st = await ide.api.invoke('cut:stat', path).catch(() => null);
      if (st && !st.missing && !(await ui.confirm(tr('{name} already exists. Replace it?', { name: ui.basename(path) }), { title, ok: tr('Replace') }))) return null;
      return { seq, path, resolved: resolvedNow(), range: range(), captions: capSel.value === 'none' ? null : capSel.value, captionTrack: burnTrack(seq)?.id || null };
    }
    // Adds these settings and a copy of the project as it is now to the export queue. -> the job, or null.
    async function enqueue() {
      if (!ui.exportQueue) return null;
      const job = await prepare({ queued: true });
      if (!job) return null;
      const preset = Cut.presets?.get?.(presetSel.value);
      const added = ui.exportQueue.add({
        project: JSON.parse(JSON.stringify(app.project)), seqId: job.seq.id, seqName: job.seq.name, fps: [...job.seq.fps],
        path: job.path, settings: JSON.parse(JSON.stringify(job.resolved)), range: job.range, captions: job.captions, captionTrack: job.captionTrack,
        presetName: preset ? tr(preset.name) : presetSel.value,
      });
      ui.toast(tr('Added {name} to the export queue', { name: ui.basename(job.path) }));
      pathTouched = false;
      refresh();
      return added;
    }
    // Runs the export with these settings. -> the result, or null when it did not start.
    async function start() {
      if (running || ui.exportQueue?.busy) { ui.toast(tr('An export is already running.')); return null; }
      const job = await prepare();
      if (!job) return null;
      const { seq, path } = job;
      if (running || ui.exportQueue?.busy) { ui.toast(tr('An export is already running.')); return null; }
      const controller = new AbortController();
      const name = ui.basename(path);
      const task = ide.tasks?.start({ title: tr('Exporting {name}', { name }), fraction: 0, onCancel: () => controller.abort() });
      const started = performance.now();
      running = { controller, name, task, path };
      syncBusy();
      root.classList.add('exporting');
      progress.hidden = false;
      result.hidden = true;
      fill.style.width = '0%';
      ptext.textContent = tr('Starting…');
      api.onChange?.();
      const resolved = job.resolved;
      let r;
      try {
        r = await Cut.export.run({
          project: app.project, seqId: seq.id, path, preset: presetSel.value, overrides: overrides(), settings: resolved,
          range: job.range, captions: job.captions, captionTrack: job.captionTrack, signal: controller.signal,
          onProgress: (p) => {
            const f = typeof p === 'number' ? p : p?.fraction ?? (p?.frame != null && p?.frames ? p.frame / p.frames : null);
            if (f != null) {
              fill.style.width = `${Math.round(f * 1000) / 10}%`;
              task?.update({ fraction: f });
              const el2 = (performance.now() - started) / 1000;
              const left = f > 0.02 ? (el2 / f) * (1 - f) : null;
              ptext.textContent = tr('{pct}% · {left} left', { pct: Math.floor(f * 100), left: left == null ? '…' : formatSeconds(left) });
            }
            if (p?.stage) ptext.dataset.stage = p.stage;
          },
        });
      } catch (err) {
        r = { ok: false, error: err };
      } finally {
        task?.done();
        running = null;
        syncBusy();
        root.classList.remove('exporting');
        progress.hidden = true;
      }
      showResult(r, controller.signal.aborted);
      api.onChange?.();
      app.emit('exported', r);
      // The queue waits while this export runs.
      ui.exportQueue?.kick?.();
      return r;
    }
    function showResult(r, aborted) {
      result.hidden = false;
      result.replaceChildren();
      result.dataset.ok = String(!!r?.ok);
      if (aborted || r?.code === 'cancelled' || r?.error?.name === 'AbortError') {
        result.dataset.ok = 'cancelled';
        result.appendChild(el('div', 'cut-result-title', tr('The export was cancelled.')));
        return;
      }
      if (!r?.ok) {
        const msg = r?.error?.message || r?.error?.detail || (typeof r?.error === 'string' ? r.error : tr('unknown error'));
        result.appendChild(el('div', 'cut-result-title', tr('The export failed: {error}', { error: tr(msg) })));
        return;
      }
      result.appendChild(el('div', 'cut-result-title', tr('Exported {name}', { name: ui.basename(r.path) })));
      const facts = el('div', 'cut-result-facts');
      facts.textContent = tr('{size} in {time}', { size: ui.formatBytes(r.bytes), time: formatSeconds(r.seconds ?? 0) });
      result.appendChild(facts);
      const v = r.verified;
      if (v) {
        const ok = v.ok !== false && !(v.problems?.length);
        const said = (x) => (typeof x === 'string' ? tr(x) : tr(x?.message || x?.code || '', x?.params));
        const line = el('div', `cut-result-verify ${ok ? 'ok' : 'bad'}`, ok ? tr('Checked: the file opens, and its length and frames are as expected.') : tr('The check found problems: {list}', { list: (v.problems || []).map(said).join('; ') }));
        result.appendChild(line);
      }
      result.appendChild(button({ label: tr('Show in Explorer'), cls: 'cut-result-reveal', onClick: () => ide.api.invoke('cut:reveal', r.path) }));
    }

    const offs = [app.on('project', () => refresh()), app.on('sequence', () => { pathTouched = false; refresh(); }), app.on('inout', () => refresh()), app.on('captionTrack', () => refresh())];
    hevcAvailable().then((ok) => {
      if (ok) codecSel.setOptions([{ value: 'h264', label: 'H.264' }, { value: 'hevc', label: tr('HEVC (hardware)') }], codecSel.value);
    });
    const api = {
      el: root, refresh, start, enqueue, problems: [], onChange: null,
      settings: () => ({ seqId: seqOf()?.id, preset: presetSel.value, overrides: overrides(), resolved: resolvedNow(), range: range(), captions: capSel.value, path: pathIn.value }),
      cancel: () => running?.controller.abort(),
      dispose: () => { for (const off of offs) off(); },
      fields: { seqSel, presetSel, codecSel, w, h, bitrate, keySec, audioSel, loudSel, rangeSel, capSel, pathIn },
    };
    fillSequences();
    fromPreset();
    return api;
  }
  const formatSeconds = (s) => {
    const v = Math.max(0, Math.round(s));
    return v < 60 ? tr('{n} s', { n: v }) : v < 3600 ? tr('{m} min {s} s', { m: Math.floor(v / 60), s: v % 60 }) : tr('{h} h {m} min', { h: Math.floor(v / 3600), m: Math.floor(v / 60) % 60 });
  };

  // ---------- the dialog ----------
  let dialogForm = null;
  function open(app) {
    if (dialogForm) return dialogForm;
    const f = form(app);
    const exportBtn = { label: tr('Export'), primary: true, run: async () => { f.start(); return false; } };
    const queueBtn = { label: tr('Add to Queue'), run: async () => { f.enqueue(); return false; } };
    const dlg = ui.dialog({
      title: tr('Export Media'),
      id: 'cutExportDialog',
      body: f.el,
      width: 560,
      onClose: () => { f.dispose(); offQueue?.(); if (dialogForm === f) dialogForm = null; },
      buttons: [exportBtn, queueBtn, { label: tr('Cancel Export'), run: () => { f.cancel(); return false; } }, { label: tr('Close') }],
    });
    const [startBtn, addBtn, cancelBtn] = dlg.el.querySelectorAll('.dialog-buttons button');
    startBtn.classList.add('cut-export-start');
    addBtn.classList.add('cut-export-queue');
    cancelBtn.classList.add('cut-export-cancel');
    f.onChange = () => {
      startBtn.disabled = !!running || !!ui.exportQueue?.busy;
      addBtn.hidden = !ui.exportQueue;
      cancelBtn.hidden = !running;
    };
    const offQueue = app.on('exportQueue', () => f.onChange?.());
    f.onChange();
    f.dialog = dlg;
    dialogForm = f;
    return f;
  }

  // Export Frame: the program monitor's frame at the playhead as a PNG.
  async function exportFrame(app) {
    const seq = app.sequence;
    if (!seq) return null;
    const home = await ide.api.invoke('cut:home').catch(() => null);
    const dir = app.path ? app.path.replace(/[\\/][^\\/]*$/, '') : home?.projects || '';
    const tc = T().timecode(app.t, seq.fps).replace(/:/g, '-');
    const safe = String(seq.name || 'Frame').replace(/[\\/:*?"<>|]+/g, '_');
    const path = await ide.api.invoke('cut:saveAs', { defaultPath: `${dir}\\${safe} ${tc}.png`, filters: [{ name: tr('PNG image'), extensions: ['png'] }], title: tr('Export Frame') });
    if (!path) return null;
    if (typeof Cut.export?.exportFrame !== 'function') { ui.notify(tr('The export engine is not available.'), { kind: 'error' }); return null; }
    try {
      const r = await Cut.export.exportFrame(app.project, seq.id, app.t, path);
      if (r?.ok === false) throw r.error instanceof Error ? r.error : new Error(r?.error?.message || r?.error || 'error');
      ui.toast(tr('Saved {name}', { name: ui.basename(path) }));
      return r || { ok: true, path };
    } catch (err) {
      ui.notify(tr('The frame could not be saved: {error}', { error: err?.message || String(err) }), { kind: 'error' });
      return null;
    }
  }

  // ---------- the Export workspace panel ----------
  ui.registerPanel('export', {
    title: () => tr('Export Settings'),
    mount(root, app) {
      root.classList.add('cut-export-panel');
      const f = form(app, { inline: true });
      const actions = el('div', 'cut-export-actions');
      const go = button({ icon: 'export', label: tr('Export'), cls: 'accent cut-export-start', onClick: () => f.start() });
      const queue = button({ label: tr('Add to Queue'), cls: 'cut-export-queue', onClick: () => f.enqueue() });
      const cancel = button({ label: tr('Cancel Export'), cls: 'cut-export-cancel', onClick: () => f.cancel() });
      const frameBtn = button({ icon: 'frame', label: tr('Export Frame…'), cls: 'cut-export-frame', action: 'exportFrame', onClick: () => exportFrame(app) });
      actions.append(go, queue, cancel, frameBtn);
      // The settings scroll; the buttons stay in view under them.
      const scroll = el('div', 'cut-export-scroll');
      scroll.appendChild(f.el);
      root.append(scroll, actions);
      f.onChange = () => { go.disabled = !!running || !!ui.exportQueue?.busy; queue.hidden = !ui.exportQueue; cancel.hidden = !running; };
      f.onChange();
      const offQueue = app.on('exportQueue', () => f.onChange?.());
      panelForm = f;
      return { dispose: () => { f.dispose(); offQueue(); if (panelForm === f) panelForm = null; } };
    },
  });
  let panelForm = null;

  ui.syncBusy = syncBusy;
  ui.exportDialog = {
    open, exportFrame, form, chaptersText, formatSeconds,
    get running() { return running; },
    get dialogForm() { return dialogForm; },
    get panelForm() { return panelForm; },
  };
})();
