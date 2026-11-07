// Automation by signal analysis (docs/cut-architecture.md section 10): the Automation menu of the top bar and of the
// timeline's clip menu, its dialogs, and the work behind them. The measurements are Cut.analyze's; this file reads the
// samples (Cut.decoder.audioReader, a block at a time) and the frames (a frame source, drawn small), and makes every
// result one undo step (Cut.commands.batch).
//
//   Remove Silence…         the quiet stretches of the selected clips (or every clip with sound), previewed on the
//                           timeline, then ripple-deleted from their tracks and the tracks linked to them
//   Detect Scene Changes…   markers at the cuts of video clips, or the clips split there
//   Detect Beats…           beat markers (every beat or every bar) of an audio clip
//   Auto Captions…          (ui-speech.js) a caption track from local speech recognition
//   Remove Filler Words…    (ui-speech.js) hesitations and long pauses of the transcript, ripple-deleted
//   Claude (ui-ai.js)       polish and translate captions, YouTube title, description and chapters, highlights to a
//                           9:16 shorts sequence, edit commands in plain words (Ctrl+J)
//   Match Loudness…         the sequence's master gain for a loudness target (true peak kept under -1 dBTP)
//   Match Clip Loudness…    each selected clip's volume for the same target
//   Auto Ducking…           volume keyframes that lower music clips while dialogue clips speak (clip roles)
//   Auto Color              color.basic white balance and exposure from the clip's picture (also in the color panel)
//
// Analyses run one at a time with a progress box and Cancel; one that decodes video waits while the player plays.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const A = Cut.analyze;
  const { el, button } = ui;
  const T = Cut.time.TICKS;
  const log = ide.logger('#cut');

  const ROLE_NAMES = { dialogue: 'Dialogue', music: 'Music', effects: 'Sound Effects', ambience: 'Ambience' };
  const TARGETS = [[-14, 'YouTube and streaming (-14 LUFS)'], [-16, 'Podcasts (-16 LUFS)'], [-24, 'Broadcast (-24 LUFS)']];
  const settings = (key, defaults) => ({ ...defaults, ...(ide.settings.get(`cut.auto.${key}`, null) || {}) });
  const remember = (key, value) => ide.settings.set(`cut.auto.${key}`, value);
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
  const seconds = (ticks) => tr('{n} s', { n: (ticks / T).toFixed(1) });

  // ---------- clips ----------
  const model = () => Cut.model;
  const kindOf = (seq, c) => seq.tracks.find((t) => t.id === c.track)?.kind;
  const trackOf = (seq, id) => seq.tracks.find((t) => t.id === id);
  const mediaOf = (app, c) => model().mediaOf(app.project, c);
  const withSound = (app, seq, c) => kindOf(seq, c) === 'audio' && !c.source?.freeze && !!mediaOf(app, c)?.audio;
  const withPicture = (app, seq, c) => kindOf(seq, c) === 'video' && !c.source?.freeze && mediaOf(app, c)?.kind === 'video';
  // The audio clips of the selection (a selected video clip brings its linked audio), else of the whole sequence.
  function soundClips(app, { all = true } = {}) {
    const seq = app.sequence;
    if (!seq) return [];
    const picked = seq.clips.filter((c) => app.selection.has(c.id));
    const set = new Set();
    for (const c of picked) {
      if (withSound(app, seq, c)) set.add(c);
      for (const l of model().linkedClips(seq, c)) if (withSound(app, seq, l)) set.add(l);
    }
    if (!picked.length && all) for (const c of seq.clips) if (withSound(app, seq, c)) set.add(c);
    return [...set].filter((c) => c.enabled && !trackOf(seq, c.track)?.locked).sort((a, b) => a.start - b.start);
  }
  function pictureClips(app) {
    const seq = app.sequence;
    if (!seq) return [];
    const picked = seq.clips.filter((c) => app.selection.has(c.id) && withPicture(app, seq, c));
    return (picked.length ? picked : seq.clips.filter((c) => withPicture(app, seq, c))).sort((a, b) => a.start - b.start);
  }
  const clipNow = (app, id) => app.sequence?.clips.find((c) => c.id === id) || null;

  // ---------- tasks: progress, cancel, waiting while the player plays ----------
  let running = null;
  // fn(ctx) with ctx = {signal, progress(fraction, text?), step() (throws when cancelled; waits while playing when the
  // task decodes video)}. -> its result, or null when it was cancelled or failed (the failure is shown).
  async function task(app, title, fn, { video = false } = {}) {
    if (running) { ui.toast(tr('Another analysis is running.')); return null; }
    const ctl = new AbortController();
    const host = document.querySelector('.cut-root') || document.body;
    const box = el('div', 'cut-auto-task', undefined, { role: 'status' });
    const name = el('div', 'cut-auto-task-title', title);
    const bar = el('div', 'cut-auto-task-bar');
    const fill = el('div', 'cut-auto-task-fill');
    bar.appendChild(fill);
    const text = el('div', 'cut-auto-task-text', '');
    const stop = button({ label: tr('Cancel'), cls: 'cut-auto-task-cancel', onClick: () => ctl.abort() });
    box.append(name, bar, text, stop);
    host.appendChild(box);
    running = { box, ctl, title };
    let shown = '';
    let yielded = performance.now();
    const ctx = {
      signal: ctl.signal,
      progress(fraction, line) {
        const p = Math.max(0, Math.min(1, fraction || 0));
        fill.style.width = `${(p * 100).toFixed(1)}%`;
        box.dataset.progress = p.toFixed(3);
        shown = line ?? `${Math.round(p * 100)}%`;
        text.textContent = shown;
      },
      async step() {
        if (ctl.signal.aborted) throw cancelled();
        if (video && app.playing) {
          box.dataset.paused = 'true';
          text.textContent = tr('Paused while playing');
          await new Promise((resolve) => {
            const off = app.on('playing', ({ playing }) => { if (!playing) { off(); ctl.signal.removeEventListener('abort', done); resolve(); } });
            const done = () => { off(); resolve(); };
            ctl.signal.addEventListener('abort', done, { once: true });
          });
          delete box.dataset.paused;
          text.textContent = shown;
          if (ctl.signal.aborted) throw cancelled();
        }
        // the page keeps drawing and taking input: a task gives way every 30 ms
        if (performance.now() - yielded > 30) {
          await new Promise((r) => setTimeout(r, 0));
          yielded = performance.now();
        }
      },
    };
    ctx.progress(0);
    try {
      return await fn(ctx);
    } catch (err) {
      if (err?.code === 'cancelled' || ctl.signal.aborted) ui.toast(tr('The analysis was cancelled.'));
      else ui.report(err?.code ? err : Object.assign(new Error(tr('The analysis failed: {error}', { error: err?.message || String(err) })), { code: 'analysis' }));
      return null;
    } finally {
      running = null;
      box.remove();
    }
  }

  // ---------- reading sound ----------
  // The clip's source sound in 10 s blocks: onBlock(planes, rate). -> {rate, start (seconds of the first sample)}
  async function readSound(app, clip, onBlock, ctx, { part = [0, 1] } = {}) {
    const o = await Cut.media.open(app.project, clip.source.media);
    if (o.error || !o.audio) throw Object.assign(new Error('The clip\'s media cannot be read.'), { code: 'media' });
    const r = await Cut.decoder.audioReader(o, o.audio);
    const [lo, hi] = A.sourceSpan(clip);
    const s0 = Math.max(0, Math.floor((lo / T) * r.rate));
    const s1 = Math.min(r.length, Math.ceil((hi / T) * r.rate));
    const block = r.rate * 10;
    for (let a = s0; a < s1; a += block) {
      await ctx.step();
      onBlock(await r.read(a, Math.min(s1, a + block)), r.rate);
      ctx.progress(part[0] + (part[1] - part[0]) * ((Math.min(s1, a + block) - s0) / Math.max(1, s1 - s0)));
    }
    return { rate: r.rate, start: s0 / r.rate, path: o.path };
  }

  // Levels of a clip's source span, kept for the session (the silence dialog redraws its preview from them).
  const levelCache = new Map();
  async function clipLevels(app, clip, ctx, part) {
    const m = mediaOf(app, clip);
    const [lo, hi] = A.sourceSpan(clip);
    const key = `${m.path}|${m.size}|${m.mtime}|${Math.round(lo)}|${Math.round(hi)}`;
    if (levelCache.has(key)) return levelCache.get(key);
    let meter = null;
    const info = await readSound(app, clip, (planes, rate) => { meter ||= A.levelMeter(rate, 0.01); meter.push(planes); }, ctx, { part });
    const entry = { levels: meter ? meter.levels() : new Float32Array(0), step: meter ? meter.step : 0.01, start: info.start };
    levelCache.set(key, entry);
    while (levelCache.size > 64) levelCache.delete(levelCache.keys().next().value);
    return entry;
  }
  // The loud parts of a clip as timeline ranges (ticks).
  const loudOnTimeline = (clip, lv, threshold) => A.rangesToTimeline(clip, A.loudRanges(lv.levels, lv.step, threshold).map(([a, b]) => [(lv.start + a) * T, (lv.start + b) * T]));
  const spanOf = (c) => [c.start, model().clipEnd(c)];

  // ---------- ripple deletes of ranges (silences, fillers, transcript words) ----------
  // The tracks a ripple delete of these clips' ranges cuts (the clips' tracks and the tracks linked to them) and the
  // tracks it changes: those and every sync-locked one, never a locked one (commands.js).
  function rippleTracks(seq, clips) {
    const tracks = new Set();
    for (const c of clips) { tracks.add(c.track); for (const l of model().linkedClips(seq, c)) tracks.add(l.track); }
    const changed = seq.tracks.filter((t) => !t.locked && (tracks.has(t.id) || t.syncLock)).map((t) => t.id);
    return { tracks: [...tracks], changed };
  }
  // Extracts the ranges (ticks, sorted) from those tracks as one undo step named `label`. -> the result, or null.
  function rippleRanges(app, ranges, tracks, label) {
    if (!ranges.length) return null;
    const cmds = ranges.slice().reverse().map(([a, b]) => C.extract(app.sequence.id, a, b, tracks));
    return ui.exec(app, C.batch(label, cmds));
  }

  // ---------- remove silence ----------
  // The levels of the sound clips (soundClips), measured in a task. -> {ids, lv: Map(id -> levels)}, or null. With
  // `speech`, clips whose role says they are not speech (music, effects, ambience) do not count unless selected: a
  // stretch is silent only when every clip counted is, and music under the talk would leave none.
  const NOT_SPEECH = new Set(['music', 'effects', 'ambience']);
  async function measureSilence(app, { speech = false } = {}) {
    const all = soundClips(app);
    const picked = app.sequence?.clips.some((c) => app.selection.has(c.id));
    const talk = speech && !picked ? all.filter((c) => !NOT_SPEECH.has(c.role)) : all;
    const clips = talk.length ? talk : all;
    if (!app.sequence || !clips.length) return { ids: [], lv: new Map() };
    const lv = await task(app, tr('Analyzing the sound…'), async (ctx) => {
      const out = new Map();
      for (let i = 0; i < clips.length; i++) out.set(clips[i].id, await clipLevels(app, clips[i], ctx, [i / clips.length, (i + 1) / clips.length]));
      return out;
    });
    return lv ? { ids: clips.map((c) => c.id), lv } : null;
  }
  // The quiet stretches of those clips for o {threshold (dB), minLength and margin (s)}: {ranges, tracks, changed}.
  function silenceOf(app, { ids, lv }, o) {
    const s = app.sequence;
    const now = ids.map((id) => clipNow(app, id)).filter(Boolean);
    const loud = now.flatMap((c) => loudOnTimeline(c, lv.get(c.id), o.threshold));
    const ranges = A.silenceRanges(now.map(spanOf), loud, { minLength: o.minLength * T, margin: o.margin * T, frame: Cut.time.frameTicks(s.fps) });
    return { ranges, ...rippleTracks(s, now) };
  }
  // The silence plan without the dialog (an edit command's removeSilence, ui-ai.js): the silences of the speech.
  // -> {ranges, tracks, changed}, or null when cancelled.
  async function silencePlan(app, { threshold = -40, minLength = 0.5, margin = 0.1 } = {}) {
    const m = await measureSilence(app, { speech: true });
    if (!m) return null;
    return m.ids.length ? silenceOf(app, m, { threshold, minLength, margin }) : { ranges: [], tracks: [], changed: [] };
  }
  async function removeSilence(app) {
    const seq = app.sequence;
    const clips = soundClips(app);
    if (!seq || !clips.length) { ui.toast(tr('There are no clips with sound to analyze.')); return null; }
    const measured = await measureSilence(app);
    if (!measured) return null;
    const o = settings('silence', { threshold: -40, minLength: 0.5, margin: 0.1 });
    const plan = () => silenceOf(app, measured, o);
    const summary = el('div', 'cut-auto-summary', '', { 'aria-live': 'polite' });
    const show = () => {
      const p = plan();
      summary.textContent = p.ranges.length ? tr('Cuts: {n} · {time} removed', { n: p.ranges.length, time: seconds(A.total(p.ranges)) }) : tr('No silence was found with these settings.');
      summary.dataset.cuts = String(p.ranges.length);
      ui.timeline.setOverlay?.({ ranges: p.ranges, tracks: p.changed });
    };
    const field = (key, opts) => ui.numberField({ value: o[key], ...opts, onChange: (v) => { o[key] = v; show(); } });
    const thr = field('threshold', { min: -90, max: -5, step: 1, unit: 'dB', cls: 'cut-auto-threshold' });
    const min = field('minLength', { min: 0.1, max: 10, step: 0.05, precision: 2, unit: 's', cls: 'cut-auto-min' });
    const margin = field('margin', { min: 0, max: 2, step: 0.05, precision: 2, unit: 's', cls: 'cut-auto-margin' });
    const body = el('div', 'cut-form cut-auto-form');
    body.append(
      el('div', 'cut-dialog-note', tr('Clips with sound: {n}. Quiet stretches are ripple-deleted from their tracks and the tracks linked to them.', { n: clips.length })),
      ui.row(tr('Quieter than'), thr), ui.row(tr('At least'), min), ui.row(tr('Keep on each side'), margin), summary,
    );
    show();
    return new Promise((resolve) => {
      let result = null;
      ui.dialog({
        title: tr('Remove Silence'), id: 'cutAutoSilence', body, width: 440,
        onClose: () => { ui.timeline.setOverlay?.(null); resolve(result); },
        buttons: [
          { label: tr('Remove'), primary: true, run: () => {
            for (const n of body.querySelectorAll('input.cut-number-input')) n.blur();
            remember('silence', o);
            const p = plan();
            if (!p.ranges.length) { ui.toast(tr('No silence was found with these settings.')); return; }
            result = rippleRanges(app, p.ranges, p.tracks, 'Remove Silence');
            if (result) { app.select([]); ui.toast(tr('Silences removed: {n} ({time}).', { n: p.ranges.length, time: seconds(A.total(p.ranges)) })); }
          } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  // ---------- frames ----------
  // Small RGBA pictures of a media's frames at source times: [{rgba, w, h}] (ctx.step() between frames).
  async function framesOf(app, mediaId, times, ctx, { width = 64 } = {}) {
    const o = await Cut.media.open(app.project, mediaId);
    if (o.error) throw Object.assign(new Error('The clip\'s media cannot be read.'), { code: 'media' });
    const w = width;
    const h = Math.max(8, Math.round((w * (o.height || 9)) / (o.width || 16)));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const grab = (source) => { g.clearRect(0, 0, w, h); g.drawImage(source, 0, 0, w, h); return { rgba: g.getImageData(0, 0, w, h).data, w, h }; };
    if (o.image) return times.map(() => grab(o.image));
    if (!o.video) throw Object.assign(new Error('The clip\'s media cannot be read.'), { code: 'media' });
    const src = Cut.decoder.createFrameSource(o, o.video, { hardware: true });
    try {
      const out = [];
      for (const t of times) {
        await ctx.step();
        const frame = await src.frameAt(t);
        try { out.push(grab(frame)); } finally { src.release(frame); }
      }
      return out;
    } finally { src.close(); }
  }

  // ---------- scene changes ----------
  async function detectScenes(app, { action } = {}) {
    const clips = pictureClips(app);
    if (!clips.length) { ui.toast(tr('There are no video clips to analyze.')); return null; }
    const o = settings('scenes', { threshold: 35, action: 'markers' });
    if (action) o.action = action;
    const go = await new Promise((resolve) => {
      let ok = false;
      const thr = ui.numberField({ value: o.threshold, min: 5, max: 95, step: 1, unit: '%', cls: 'cut-auto-scene-threshold', onChange: (v) => { o.threshold = v; } });
      const act = ui.select({ options: [{ value: 'markers', label: tr('Add sequence markers') }, { value: 'split', label: tr('Split the clips') }], value: o.action, cls: 'cut-auto-scene-action', onChange: (v) => { o.action = v; } });
      const body = el('div', 'cut-form cut-auto-form');
      body.append(el('div', 'cut-dialog-note', tr('Video clips: {n}. A scene change is where the colours of one frame differ from the frame before by more than the threshold.', { n: clips.length })),
        ui.row(tr('Threshold'), thr), ui.row(tr('At each change'), act));
      ui.dialog({ title: tr('Detect Scene Changes'), id: 'cutAutoScenes', body, width: 440, onClose: () => resolve(ok),
        buttons: [{ label: tr('Detect'), primary: true, run: () => { for (const n of body.querySelectorAll('input.cut-number-input')) n.blur(); ok = true; remember('scenes', o); } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    const ids = clips.map((c) => c.id);
    const found = await task(app, tr('Detecting scene changes…'), async (ctx) => {
      const out = [];
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const o2 = await Cut.media.open(app.project, clip.source.media);
        if (o2.error || !o2.video) continue;
        const s = o2.video.samples;
        const rankOf = new Uint32Array(s.count);
        for (let r = 0; r < s.count; r++) rankOf[s.order[r]] = r;
        const ptsOf = (r) => s.pts[s.order[r]];
        const [lo, hi] = A.sourceSpan(clip);
        const r0 = rankOf[Math.max(0, Cut.probe.sampleAtTime(o2.video, lo))];
        const r1 = rankOf[Math.max(0, Cut.probe.sampleAtTime(o2.video, Math.max(lo, hi - 1)))];
        const memo = new Map();
        const src = Cut.decoder.createFrameSource(o2, o2.video, { hardware: true });
        const w = 64;
        const h = Math.max(8, Math.round((w * (o2.height || 9)) / (o2.width || 16)));
        const canvas = new OffscreenCanvas(w, h);
        const g = canvas.getContext('2d', { willReadFrequently: true });
        try {
          const histAt = async (r) => {
            if (memo.has(r)) return memo.get(r);
            await ctx.step();
            const frame = await src.frameAt(ptsOf(r));
            let hist;
            try { g.drawImage(frame, 0, 0, w, h); hist = A.histogram(g.getImageData(0, 0, w, h).data, w, h); } finally { src.release(frame); }
            memo.set(r, hist);
            if (memo.size > 16) memo.delete(memo.keys().next().value);
            return hist;
          };
          const cuts = await A.detectScenes(r0, r1, histAt, { threshold: o.threshold / 100, step: 2, signal: ctx.signal,
            onProgress: (p) => ctx.progress((i + p) / clips.length) });
          out.push({ id: clip.id, times: cuts.map(ptsOf) });
        } finally { src.close(); }
      }
      return out;
    }, { video: true });
    if (!found) return null;
    const seq = app.sequence;
    const f = Cut.time.frameTicks(seq.fps);
    const cmds = [];
    let n = 0;
    for (const { id, times } of found) {
      const clip = clipNow(app, id);
      if (!clip || !ids.includes(id)) continue;
      const end = model().clipEnd(clip);
      const at = [...new Set(times.map((p) => Math.round(A.toTimeline(clip, p) / f) * f))].filter((t) => t > clip.start && t < end).sort((a, b) => a - b);
      n += at.length;
      if (o.action === 'split') for (const t of at.slice().reverse()) cmds.push(C.split(seq.id, t, { clipIds: [clip.id] }));
      else for (const t of at) cmds.push(C.addMarker(seq.id, { t, kind: 'comment', color: 'orange', name: tr('Scene {n}', { n: cmds.length + 2 }) }));
    }
    if (!cmds.length) { ui.toast(tr('No scene changes were found.')); return { count: 0 }; }
    const r = ui.exec(app, C.batch(o.action === 'split' ? 'Split at Scene Changes' : 'Add Scene Markers', cmds));
    if (r) ui.toast(tr('Scene changes found: {n}.', { n }));
    return r ? { count: n } : null;
  }

  // ---------- beats ----------
  async function detectBeats(app, { every } = {}) {
    const clips = soundClips(app, { all: false });
    const clip = clips[0];
    if (!clip) { ui.toast(tr('Select an audio clip first.')); return null; }
    const o = settings('beats', { every: 'beat' });
    if (every) o.every = every;
    const go = await new Promise((resolve) => {
      let ok = false;
      const sel = ui.select({ options: [{ value: 'beat', label: tr('Every beat') }, { value: 'bar', label: tr('Every bar (4 beats)') }], value: o.every, cls: 'cut-auto-beats-every', onChange: (v) => { o.every = v; } });
      const body = el('div', 'cut-form cut-auto-form');
      body.append(el('div', 'cut-dialog-note', tr('Finds the tempo and the beats of the clip and puts beat markers on them. Edits snap to markers.')), ui.row(tr('Markers'), sel));
      ui.dialog({ title: tr('Detect Beats'), id: 'cutAutoBeats', body, width: 420, onClose: () => resolve(ok),
        buttons: [{ label: tr('Detect'), primary: true, run: () => { ok = true; remember('beats', o); } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    const id = clip.id;
    const found = await task(app, tr('Detecting beats…'), async (ctx) => {
      let flux = null;
      let k = 1;
      const info = await readSound(app, clip, (planes, rate) => {
        // about 24 kHz is enough for onsets, and halves the work
        if (!flux) { k = rate >= 44100 ? 2 : 1; flux = A.createFlux(rate / k, { size: 1024, hop: 256 }); }
        const m = A.mono(planes);
        if (k === 1) flux.push(m);
        else {
          const d = new Float32Array(Math.floor(m.length / k));
          for (let i = 0; i < d.length; i++) d[i] = (m[i * 2] + m[i * 2 + 1]) / 2;
          flux.push(d);
        }
      }, ctx, { part: [0, 0.9] });
      if (!flux) return { bpm: 0, beats: [], phase: 0 };
      await ctx.step();
      const r = A.beats(flux, flux.envelope());
      ctx.progress(1);
      return { ...r, beats: r.beats.map((s) => (info.start + s) * T) };
    });
    if (!found) return null;
    const now = clipNow(app, id);
    const seq = app.sequence;
    if (!now || !found.beats.length) { ui.toast(tr('No beats were found.')); return { bpm: 0, count: 0 }; }
    const f = Cut.time.frameTicks(seq.fps);
    const end = model().clipEnd(now);
    const picked = found.beats.map((p, i) => ({ i, t: Math.round(A.toTimeline(now, p) / f) * f })).filter(({ i }) => o.every !== 'bar' || i % 4 === found.phase);
    const seen = new Set();
    const cmds = [];
    // markers of an earlier detection on this clip's stretch go first
    for (const m of seq.markers) if (m.kind === 'beat' && m.t >= now.start && m.t < end) cmds.push(C.removeMarker(seq.id, m.id));
    let bar = 0;
    for (const { t } of picked) {
      if (t < now.start || t >= end || seen.has(t)) continue;
      seen.add(t);
      bar++;
      cmds.push(C.addMarker(seq.id, { t, kind: 'beat', color: 'cyan', name: o.every === 'bar' ? String(bar) : '' }));
    }
    const count = seen.size;
    const r = ui.exec(app, C.batch('Add Beat Markers', cmds));
    if (r) ui.toast(tr('{bpm} BPM: {n} beat markers.', { bpm: found.bpm.toFixed(1), n: count }));
    return r ? { bpm: found.bpm, count } : null;
  }

  // ---------- loudness ----------
  const targetSelect = (value, cls) => ui.select({ options: TARGETS.map(([v, label]) => ({ value: String(v), label: tr(label) })), value: String(value), cls });
  function matchLoudness(app) {
    const seq = app.sequence;
    const length = seq ? model().sequenceDuration(seq) : 0;
    if (!seq || !length || !seq.clips.some((c) => kindOf(seq, c) === 'audio')) { ui.toast(tr('The sequence has no sound.')); return Promise.resolve(null); }
    const o = settings('loudness', { target: -14 });
    const ctl = new AbortController();
    let measured = null;
    const sel = targetSelect(o.target, 'cut-auto-loudness-target');
    const status = el('div', 'cut-auto-summary cut-auto-loudness-status', tr('Measuring…'));
    const gainLine = el('div', 'cut-auto-summary cut-auto-loudness-gain', '');
    const body = el('div', 'cut-form cut-auto-form');
    body.append(el('div', 'cut-dialog-note', tr('Measures the whole sequence and sets its master gain so the integrated loudness meets the target, with the true peak kept under -1 dBTP.')),
      ui.row(tr('Target'), sel), status, gainLine);
    const gain = () => (measured ? Math.round((seq.masterGain + Cut.audioengine.matchGain(measured, Number(sel.value), { ceiling: -1 })) * 100) / 100 : null);
    const showGain = () => {
      const g = gain();
      gainLine.textContent = g === null ? '' : tr('Master gain {gain} dB (now {now} dB)', { gain: g.toFixed(2), now: (seq.masterGain || 0).toFixed(2) });
      if (g !== null) gainLine.dataset.gain = String(g);
    };
    sel.addEventListener('change', showGain);
    return new Promise((resolve) => {
      let result = null;
      const dlg = ui.dialog({
        title: tr('Match Loudness'), id: 'cutAutoLoudness', body, width: 460,
        onClose: () => { ctl.abort(); resolve(result); },
        buttons: [
          { label: tr('Apply'), primary: true, run: () => {
            const g = gain();
            if (g === null) return false;
            o.target = Number(sel.value);
            remember('loudness', o);
            result = ui.exec(app, C.batch('Match Loudness', [C.setSequence(seq.id, { masterGain: g })]));
            if (result) ui.toast(tr('Master gain set to {gain} dB.', { gain: g.toFixed(2) }));
            return undefined;
          } },
          { label: tr('Cancel') },
        ],
      });
      const apply = dlg.el.querySelector('.dialog-buttons .primary');
      apply.disabled = true;
      Cut.audioengine.measure(app.project, seq.id, 0, length, { signal: ctl.signal, onProgress: (p) => { status.textContent = tr('Measuring… {p}%', { p: Math.round(p * 100) }); } })
        .then((m) => {
          measured = m;
          if (!Number.isFinite(m.integrated)) { status.textContent = tr('The sequence is silent.'); return; }
          status.textContent = tr('Integrated loudness {lufs} LUFS · true peak {peak} dBTP', { lufs: m.integrated.toFixed(1), peak: m.truePeak.toFixed(1) });
          status.dataset.lufs = String(m.integrated);
          apply.disabled = false;
          showGain();
        })
        .catch((err) => { if (err?.code !== 'cancelled') status.textContent = tr('The loudness could not be measured: {error}', { error: err?.message || String(err) }); });
    });
  }

  // A clip alone: its own sequence with every track level and no master gain, for measuring.
  function alone(project, seq, clip) {
    const s = { ...seq, masterGain: 0, transitions: [], clips: [clip],
      tracks: seq.tracks.map((t) => (t.kind === 'audio' ? { ...t, volume: 0, pan: 0, mute: false, solo: false } : t)) };
    return { ...project, sequences: [s] };
  }
  async function matchClipLoudness(app) {
    const clips = soundClips(app, { all: false });
    if (!clips.length) { ui.toast(tr('Select the clips to match first.')); return null; }
    const o = settings('clipLoudness', { target: -14 });
    const go = await new Promise((resolve) => {
      let ok = false;
      const sel = targetSelect(o.target, 'cut-auto-clip-target');
      sel.addEventListener('change', () => { o.target = Number(sel.value); });
      const body = el('div', 'cut-form cut-auto-form');
      body.append(el('div', 'cut-dialog-note', tr('Clips: {n}. Each clip\'s volume is set so its own loudness meets the target.', { n: clips.length })), ui.row(tr('Target'), sel));
      ui.dialog({ title: tr('Match Clip Loudness'), id: 'cutAutoClipLoudness', body, width: 440, onClose: () => resolve(ok),
        buttons: [{ label: tr('Match'), primary: true, run: () => { ok = true; remember('clipLoudness', o); } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    const seq = app.sequence;
    const ids = clips.map((c) => c.id);
    const measured = await task(app, tr('Measuring clip loudness…'), async (ctx) => {
      const out = new Map();
      for (let i = 0; i < clips.length; i++) {
        await ctx.step();
        const c = clips[i];
        out.set(c.id, await Cut.audioengine.measure(alone(app.project, seq, c), seq.id, c.start, model().clipEnd(c), { signal: ctx.signal,
          onProgress: (p) => ctx.progress((i + p) / clips.length) }));
      }
      return out;
    });
    if (!measured) return null;
    const cmds = [];
    const gains = {};
    for (const id of ids) {
      const c = clipNow(app, id);
      const m = measured.get(id);
      if (!c || !Number.isFinite(m?.integrated)) continue;
      const d = Math.round((o.target - m.integrated) * 10) / 10;
      const vol = Math.max(-60, Math.min(24, Math.round(((c.props.volume || 0) + d) * 10) / 10));
      gains[id] = vol;
      cmds.push(C.setClip(seq.id, c.id, { props: { volume: vol } }, { linked: false }));
      const keys = c.keyframes.volume;
      if (keys?.length) cmds.push(C.setKeyframes(seq.id, c.id, 'volume', keys.map((k) => ({ ...k, v: Math.max(-60, Math.min(24, Math.round((k.v + d) * 10) / 10)) }))));
    }
    if (!cmds.length) { ui.toast(tr('The clips are silent.')); return null; }
    const r = ui.exec(app, C.batch('Match Clip Loudness', cmds));
    if (r) ui.toast(tr('Clips set to {lufs} LUFS: {n}.', { n: Object.keys(gains).length, lufs: o.target }));
    return r ? { gains } : null;
  }

  // ---------- ducking ----------
  async function autoDuck(app) {
    const seq = app.sequence;
    if (!seq) return null;
    const dialogue = seq.clips.filter((c) => c.role === 'dialogue' && c.enabled && withSound(app, seq, c));
    const music = seq.clips.filter((c) => c.role === 'music' && kindOf(seq, c) === 'audio' && !trackOf(seq, c.track)?.locked);
    if (!dialogue.length || !music.length) {
      ui.dialog({ title: tr('Auto Ducking'), id: 'cutAutoDuckRoles', width: 440,
        body: el('div', 'dialog-message', tr('Mark the clips first: right-click a clip in the timeline and choose Audio Role > Dialogue for speech and Music for the music to lower.')) });
      return null;
    }
    const o = settings('duck', { amount: -12, fade: 0.3, threshold: -40, hold: 0.5 });
    const go = await new Promise((resolve) => {
      let ok = false;
      const body = el('div', 'cut-form cut-auto-form');
      const field = (key, opts) => ui.numberField({ value: o[key], ...opts, onChange: (v) => { o[key] = v; } });
      body.append(el('div', 'cut-dialog-note', tr('Dialogue clips: {d}, music clips: {m}. The music is lowered wherever the dialogue speaks.', { d: dialogue.length, m: music.length })),
        ui.row(tr('Lower by'), field('amount', { min: -40, max: -1, step: 1, unit: 'dB', cls: 'cut-auto-duck-amount' })),
        ui.row(tr('Fade'), field('fade', { min: 0, max: 2, step: 0.05, precision: 2, unit: 's', cls: 'cut-auto-duck-fade' })),
        ui.row(tr('Speech louder than'), field('threshold', { min: -90, max: -5, step: 1, unit: 'dB', cls: 'cut-auto-duck-threshold' })));
      ui.dialog({ title: tr('Auto Ducking'), id: 'cutAutoDuck', body, width: 440, onClose: () => resolve(ok),
        buttons: [{ label: tr('Duck'), primary: true, run: () => { for (const n of body.querySelectorAll('input.cut-number-input')) n.blur(); ok = true; remember('duck', o); } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    const dIds = dialogue.map((c) => c.id);
    const mIds = music.map((c) => c.id);
    const lv = await task(app, tr('Finding the speech…'), async (ctx) => {
      const out = new Map();
      for (let i = 0; i < dialogue.length; i++) out.set(dialogue[i].id, await clipLevels(app, dialogue[i], ctx, [i / dialogue.length, (i + 1) / dialogue.length]));
      return out;
    });
    if (!lv) return null;
    const s = app.sequence;
    const f = Cut.time.frameTicks(s.fps);
    const fade = Math.round((o.fade * T) / f) * f;
    const speech = A.union(dIds.map((id) => clipNow(app, id)).filter(Boolean).flatMap((c) => A.speechRanges([spanOf(c)], loudOnTimeline(c, lv.get(c.id), o.threshold), { hold: o.hold * T })));
    const cmds = [];
    for (const id of mIds) {
      const c = clipNow(app, id);
      if (!c) continue;
      // Written as the clip's `duck` curve, replacing the last run's: the volume keyframes stay the user's.
      const keys = A.duckKeyframes({ duration: model().clipDuration(c), speech: speech.map(([a, b]) => [a - c.start, b - c.start]), amount: o.amount, fade, frame: f });
      if (keys.length || c.keyframes.duck) cmds.push(C.setKeyframes(s.id, c.id, 'duck', keys));
    }
    const ducked = cmds.filter((x) => x.keyframes.length).length;
    if (!cmds.length) { ui.toast(tr('The dialogue does not overlap the music.')); return { count: 0 }; }
    const r = ui.exec(app, C.batch('Auto Ducking', cmds));
    if (r) ui.toast(ducked ? tr('Music clips ducked: {n} (under {s} of speech).', { n: ducked, s: seconds(A.total(speech)) }) : tr('The dialogue does not overlap the music.'));
    return r ? { count: ducked, speech } : null;
  }

  // ---------- auto colour ----------
  async function autoColor(app) {
    const seq = app.sequence;
    const c0 = seq ? ui.edit?.primaryClip(app) : null;
    const m = c0 && mediaOf(app, c0);
    if (!c0 || kindOf(seq, c0) !== 'video' || !m || (m.kind !== 'video' && m.kind !== 'image')) { ui.toast(tr('Select a video clip first.')); return null; }
    const id = c0.id;
    const inside = app.t >= c0.start && app.t < model().clipEnd(c0);
    const d = model().clipDuration(c0);
    const times = inside ? [model().sourceTime(c0, app.t)] : [0.1, 0.3, 0.5, 0.7, 0.9].map((x) => model().sourceTime(c0, c0.start + Math.floor(d * x)));
    const values = await task(app, tr('Analyzing the picture…'), async (ctx) => {
      const images = await framesOf(app, c0.source.media, times, ctx);
      ctx.progress(1);
      return A.autoColor(images);
    }, { video: true });
    if (!values) return null;
    const c = clipNow(app, id);
    if (!c) return null;
    const e = c.effects.find((x) => x.type === 'color.basic');
    const cmds = [];
    if (e) {
      for (const k of ['temperature', 'tint', 'exposure']) if (c.keyframes[`effects.${e.id}.${k}`]) cmds.push(C.setKeyframes(seq.id, c.id, `effects.${e.id}.${k}`, null));
      cmds.push(C.setEffect(seq.id, c.id, e.id, { on: true, params: values }));
    } else cmds.push(C.addEffect(seq.id, c.id, 'color.basic', null, values));
    const r = ui.exec(app, C.batch('Auto Color', cmds));
    if (r) ui.toast(tr('Temperature {t}, tint {m}, exposure {e}.', { t: values.temperature, m: values.tint, e: values.exposure.toFixed(2) }));
    return r ? values : null;
  }

  // ---------- roles ----------
  function setRole(app, role) {
    const seq = app.sequence;
    const ids = [...app.selection].filter((id) => seq?.clips.some((c) => c.id === id));
    if (!ids.length) return null;
    return ui.exec(app, C.setRole(seq.id, ids, role));
  }

  // ---------- menus ----------
  const ITEMS = [
    ['silence', 'Remove Silence…', removeSilence],
    ['scenes', 'Detect Scene Changes…', (app) => detectScenes(app)],
    ['beats', 'Detect Beats…', (app) => detectBeats(app)],
    null,
    // speech recognition (ui-speech.js, which loads after this file)
    ['captions', 'Auto Captions…', (app) => ui.speech.autoCaptions(app)],
    ['fillers', 'Remove Filler Words…', (app) => ui.speech.removeFillers(app)],
    // who speaks when, on the transcripts (ui-speakers.js)
    ['speakers', 'Label Speakers', (app) => ui.speakers.label(app)],
    // the words Whisper was unsure of, one after another (Alt+] and Alt+[: free in Cut, unlike F2, the project
    // panel's Rename)
    ['nextUncertain', 'Next Uncertain Word', (app) => ui.speech.nextUncertain(app, 1), 'Alt+]'],
    ['prevUncertain', 'Previous Uncertain Word', (app) => ui.speech.nextUncertain(app, -1), 'Alt+['],
    null,
    // text AI through Claude (ui-ai.js, which loads after this file)
    ['aiPolish', 'Polish Captions with Claude…', (app) => ui.ai.polishCaptions(app)],
    ['aiTranslate', 'Translate Captions with Claude…', (app) => ui.ai.translateCaptions(app)],
    ['aiMetadata', 'YouTube Title, Description and Chapters…', (app) => ui.ai.youtubeMetadata(app)],
    ['aiHighlights', 'Highlights to Shorts…', (app) => ui.ai.highlights(app)],
    ['aiCommand', 'Edit Command…', (app) => ui.ai.editCommand(app), 'Ctrl+J'],
    null,
    ['loudness', 'Match Loudness…', matchLoudness],
    ['clipLoudness', 'Match Clip Loudness…', matchClipLoudness],
    ['duck', 'Auto Ducking…', autoDuck],
    // the vocals of HTDemucs in place of the clips' sound (ui-voice.js, which loads after this file)
    ['isolateVoice', 'Isolate Voice', (app) => ui.voice.isolate(app)],
    null,
    ['color', 'Auto Color', autoColor],
  ];
  const run = (app, fn) => { Promise.resolve().then(() => fn(app)).catch((err) => { log.error(err?.stack || String(err)); ui.report(err); }); };
  const menuItems = (app) => ITEMS.map((it) => (it ? { label: tr(it[1]), keyAction: it[3] ? `Cut.auto.${it[0]}` : undefined, run: () => run(app, it[2]) } : { separator: true }));
  // The clip menu's part: the audio role and the automation.
  function clipMenuItems(app, clip) {
    const seq = app.sequence;
    const audio = kindOf(seq, clip) === 'audio' || model().linkedClips(seq, clip).some((l) => kindOf(seq, l) === 'audio');
    return [
      { label: tr('Audio Role'), disabled: !audio, submenu: [
        { label: tr('None'), checked: !clip.role, run: () => setRole(app, null) },
        ...model().ROLES.map((r) => ({ label: tr(ROLE_NAMES[r]), checked: clip.role === r, run: () => setRole(app, r) })),
      ] },
      { label: tr('Automation'), submenu: menuItems(app) },
    ];
  }
  function topBarButton() {
    const b = button({ icon: 'audio', label: tr('Automation'), title: tr('Automation'), cls: 'cut-auto-btn', onClick: () => ui.menu(b, menuItems(Cut.app)) });
    b.appendChild(el('span', 'cut-auto-caret', '▾'));
    b.setAttribute('aria-haspopup', 'menu');
    return b;
  }
  for (const it of ITEMS) {
    if (!it) continue;
    ide.registerAction({ id: `Cut.auto.${it[0]}`, title: tr(it[1]), keys: it[3] || [], when: () => !!document.querySelector('.cut-root') && !!Cut.app?.history, run: () => run(Cut.app, it[2]) });
  }

  ui.auto = {
    removeSilence, detectScenes, detectBeats, matchLoudness, matchClipLoudness, autoDuck, autoColor, setRole,
    menuItems, clipMenuItems, topBarButton, task, soundClips, pictureClips, rippleTracks, rippleRanges, silencePlan,
    get running() { return running ? { title: running.title } : null; },
    cancel: () => running?.ctl.abort(),
    // Forgets the sound levels measured so far (the next analysis reads the files again).
    forget: () => levelCache.clear(),
    ROLE_NAMES,
  };
})();
