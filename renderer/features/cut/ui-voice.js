// Voice isolation (docs/cut-architecture.md section 10): the speech of a recording without its music and noise, from
// the vocals stem of HTDemucs, which runs on this PC through main (main/cut/voice.js).
//
//   Isolate Voice           (Automation menu, the clip menu) the selected audio clips (a video clip brings its linked
//                           audio) play the vocals of their media file instead, as one undo step: the vocals are a new
//                           WAV in the Cut workspace's Media folder, imported next to the source in its bin, and each
//                           clip keeps its place, in, out, speed, keyframes, effects and links
//   Isolate Voice           (the project panel's item menu) the vocals of the chosen media, imported into its bin
//   before recognition      ui-speech.js asks forSpeech() for the vocals of the part it recognises (setting
//                           cut.speech.isolateVoice); those go to the Cut cache
//
// The sound is decoded here (Cut.decoder.audioReader, 10 s blocks), resampled to the model's 44.1 kHz, kept in one or
// two channels and streamed to main. A file made before for the same media and range is used again. Nothing is
// downloaded until the person presses Download in the setup dialog.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const C = Cut.commands;
  const { el } = ui;
  const T = Cut.time.TICKS;
  const RATE = 44100;
  const log = ide.logger('#cut');
  const invoke = (...args) => ide.api.invoke(...args);
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
  const model = () => Cut.model;
  const status = () => invoke('cut:voiceStatus').catch(() => null);

  let onSetup = null;
  ide.api.on('cut:voiceSetupProgress', (p) => onSetup?.(p));
  const progress = new Map(); // request -> (fraction) => void
  ide.api.on('cut:voiceProgress', (p) => progress.get(p?.request)?.(p.fraction));
  let engine = { state: 'idle' };
  ide.api.on('cut:voiceState', (s) => { engine = s || engine; });
  const configure = () => invoke('cut:voiceConfigure', { idleMinutes: ide.settings.get('ai.idleUnloadMinutes', 10) }).catch(() => {});
  configure();
  ide.on('settingsChanged', (k) => { if (k === 'ai.idleUnloadMinutes') configure(); });

  // ---------- setup: the dialog before the first download ----------
  function setupError(r) {
    switch (r?.code) {
      case 'noPython': return tr('Python was not found on this PC. Voice isolation needs Python 3 (64-bit, from python.org) with PyTorch. Install Python and try again.');
      case 'noTorch': return tr('PyTorch cannot be installed for the Python on this PC. Install a 64-bit Python 3.10 to 3.13 from python.org and try again.');
      case 'disk': return tr('There is not enough free disk space. Free up space and try again ({detail}).', { detail: r.error || '' });
      case 'offline': return tr('The download could not reach the internet. Check the connection and try again.');
      case 'busy': return tr('The AI environment is in use by another Nano Studio window. Close it and try again.');
      case 'cancelled': return tr('The download was cancelled.');
      default: return tr('The download failed: {error}', { error: r?.error || tr('unknown error') });
    }
  }
  // Resolves true once the model and its packages are there (at once when they are), false when the person declines.
  async function ensureReady() {
    const st = await status();
    if (!st) { ui.notify(tr('Voice isolation is not available.'), { kind: 'error' }); return false; }
    if (st.runtime && st.model.installed) return true;
    return new Promise((resolve) => {
      let busy = false;
      let ok = false;
      const m = st.model;
      const body = el('div', 'cut-form cut-speech-setup cut-voice-setup');
      body.append(el('div', 'cut-dialog-note', tr('Voice isolation separates speech from music and noise with the {name} model from Meta. It runs entirely on this PC: the sound is never sent anywhere.', { name: m.name })));
      const list = el('ul', 'cut-speech-setup-list');
      if (!m.installed) list.appendChild(el('li', null, tr('{name} model: about {size}', { name: m.name, size: ui.formatBytes(m.bytes) })));
      if (!st.runtime) list.appendChild(el('li', null, tr('Python packages for it (Demucs, and PyTorch when Python does not have it yet, shared with the other Nano Studio AI features): up to about {size}', { size: ui.formatBytes(st.runtimeBytes) })));
      body.append(list, el('div', 'cut-dialog-note', tr('Nothing is downloaded until you press Download. It is downloaded once; after that, voice isolation works offline.')));
      const bar = el('div', 'cut-speech-bar');
      const fill = el('div', 'cut-speech-fill');
      bar.appendChild(fill);
      bar.hidden = true;
      const line = el('div', 'cut-speech-status', '', { 'aria-live': 'polite' });
      const error = el('div', 'cut-speech-error', '', { role: 'alert' });
      error.hidden = true;
      body.append(bar, line, error);
      const dlg = ui.dialog({
        title: tr('Download Voice Isolation'), id: 'cutVoiceSetup', body, width: 480,
        onClose: () => { onSetup = null; if (busy) invoke('cut:voiceCancelSetup').catch(() => {}); resolve(ok); },
        buttons: [
          { label: tr('Download'), primary: true, run: () => { if (!busy) start(); return false; } },
          { label: tr('Cancel') },
        ],
      });
      const go = dlg.el.querySelector('.dialog-buttons .primary');
      onSetup = (p) => {
        if (p.phase === 'runtime') line.textContent = p.text ? tr('Setting up the AI runtime… {line}', { line: p.text }) : tr('Setting up the AI runtime…');
        if (p.phase === 'download' && Number.isFinite(p.fraction)) {
          fill.style.width = `${(p.fraction * 100).toFixed(1)}%`;
          bar.dataset.progress = p.fraction.toFixed(3);
          line.textContent = tr('Downloading {name}… {p}% of {size}', { name: m.name, p: Math.round(p.fraction * 100), size: ui.formatBytes(p.bytes || m.bytes) });
        }
        bar.classList.toggle('indeterminate', p.phase === 'runtime');
      };
      async function start() {
        busy = true;
        go.disabled = true;
        bar.hidden = false;
        error.hidden = true;
        line.textContent = tr('Starting…');
        const r = await invoke('cut:voiceSetup').catch((err) => ({ ok: false, error: err.message }));
        busy = false;
        if (!dlg.el.isConnected) return;
        if (r?.ok) { ok = true; ui.toast(tr('{name} is ready.', { name: m.name })); dlg.close(); return; }
        error.textContent = setupError(r);
        error.dataset.code = r?.code || 'failed';
        error.hidden = false;
        line.textContent = '';
        go.disabled = false;
        go.textContent = tr('Try Again');
        if (r?.log) log.warn(`voice setup: ${r.error}\n${r.log}`);
      }
    });
  }

  // ---------- the vocals of a media file ----------
  // FNV-1a of a text, twice with two seeds: 16 hex digits (as ui-proxy.js names proxies).
  function hash(text) {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }
  const round3 = (s) => Math.round(s * 1000) / 1000;
  const keyOf = (m, from, to) => hash(`${String(m.path).toLowerCase()}|${m.size}|${m.mtime}|${round3(from)}|${to == null ? 'end' : round3(to)}|htdemucs`);
  let requestSeq = 0;

  // The vocals of source seconds [from, to) of a media file (to null: to its end, padded to the media's length so every
  // clip of it fits) as a WAV of main's, in `place` ('media' or 'cache'). -> {path, from}. ctx: an analysis task's
  // context; onPart(fraction) follows the decoding and the separation.
  async function render(app, mediaId, { from = 0, to = null, place = 'media', ctx, onPart } = {}) {
    const m = app.project.media.find((x) => x.id === mediaId);
    if (!m?.audio) throw Object.assign(new Error('The media has no sound.'), { code: 'noAudio' });
    const key = keyOf(m, from, to);
    const known = await invoke('cut:voiceFind', { name: m.name, key }).catch(() => null);
    if (known?.path) { onPart?.(1); return { path: known.path, from }; }
    const o = await Cut.media.open(app.project, mediaId);
    if (o.error || !o.audio) throw Object.assign(new Error('The clip\'s media cannot be read.'), { code: 'media' });
    const r = await Cut.decoder.audioReader(o, o.audio);
    const rate = r.rate;
    const channels = Math.min(2, r.channels || 1);
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    const g = gcd(rate, RATE);
    const si = rate / g; // a block starting on a multiple of si starts on an output sample
    const so = RATE / g;
    const margin = si * Math.ceil(256 / si); // the resampling filter's reach, so blocks join without a seam
    const s0 = Math.floor((from * rate) / si) * si;
    const s1 = Math.min(r.length, to == null ? r.length : Math.ceil(to * rate));
    const frames = to == null ? Math.ceil(((m.duration / T) - s0 / rate) * RATE) : 0;
    const opened = await invoke('cut:voiceOpen', { channels });
    if (!opened?.id) throw new Error(opened?.error || 'no temp file');
    const request = `v${++requestSeq}`;
    const stop = () => invoke('cut:voiceCancel', request).catch(() => {});
    try {
      const block = rate * 10;
      for (let x = s0; x < s1; x += block) {
        await ctx.step();
        const y = Math.min(s1, x + block);
        const lo = Math.max(0, x - margin);
        const planes = await r.read(lo, y + margin);
        const lead = x - lo === margin ? 0 : margin - (x - lo);
        const n = Math.round(((y - x) * so) / si);
        const off = (margin * so) / si;
        const outs = [];
        for (let c = 0; c < channels; c++) {
          const src = new Float32Array(margin + (y - x) + margin);
          // a mono file read as stereo, or more than two channels folded into two
          const mine = planes.filter((_, k) => (channels === 1 ? true : k % 2 === c));
          for (const p of mine) for (let i = 0; i < p.length && lead + i < src.length; i++) src[lead + i] += p[i] / mine.length;
          outs.push(Cut.audioengine.resample([src], rate, RATE)[0].subarray(off, off + n));
        }
        const inter = new Float32Array(n * channels);
        for (let c = 0; c < channels; c++) for (let i = 0; i < n; i++) inter[i * channels + c] = outs[c][i] || 0;
        const w = await invoke('cut:voiceWrite', opened.id, new Uint8Array(inter.buffer));
        if (w?.error) throw new Error(w.error);
        onPart?.(0.15 * ((y - s0) / Math.max(1, s1 - s0)));
      }
      await ctx.step();
      progress.set(request, (f) => onPart?.(0.15 + 0.85 * f));
      ctx.signal.addEventListener('abort', stop, { once: true });
      const res = await invoke('cut:voiceSeparate', opened.id, { request, name: m.name, key, place, frames: Math.max(0, frames) });
      if (res?.cancelled || ctx.signal.aborted) throw cancelled();
      if (res?.error) throw Object.assign(new Error(tr('Voice isolation failed: {error}', { error: res.error })), { code: res.code || 'voice' });
      onPart?.(1);
      return { path: res.path, from: s0 / rate };
    } finally {
      ctx.signal.removeEventListener('abort', stop);
      progress.delete(request);
      await invoke('cut:voiceClose', opened.id).catch(() => {});
    }
  }

  // For speech recognition (ui-speech.js): the vocals of source seconds [a, b) of a media file, in the cache.
  const forSpeech = (app, mediaId, a, b, ctx, onPart) => render(app, mediaId, { from: a, to: b, place: 'cache', ctx, onPart });

  // The vocals of each media as media entries of the project: one already there for that file, else imported into
  // the source's bin, with the source's speaker turns (the same time base). -> Map(mediaId -> new mediaId); run inside
  // a history group. entries: Cut.media.importFiles of the made paths, read before the group opens.
  function importVocals(app, made, entries) {
    const p = app.project;
    const out = new Map();
    entries.forEach((e, i) => {
      const src = p.media.find((x) => x.id === made[i].mediaId);
      if (e.error || !src) throw Object.assign(new Error(tr('The isolated voice cannot be read: {error}', { error: e.error?.detail || e.error?.code || '' })), { code: 'voice' });
      const there = p.media.find((x) => String(x.path).toLowerCase() === String(e.path).toLowerCase());
      if (there) { out.set(src.id, there.id); return; }
      const bin = p.bins.find((b) => b.items.includes(src.id))?.id ?? null;
      const { ids } = app.history.do(C.importMedia([{ ...e, name: tr('{name} (Voice)', { name: src.name }) }], bin));
      out.set(src.id, ids[0]);
    });
    const turns = {};
    for (const [from, to] of out) if (p.speakers?.turns?.[from] && !p.speakers.turns[to]) turns[to] = JSON.parse(JSON.stringify(p.speakers.turns[from]));
    if (Object.keys(turns).length) app.history.do(C.setSpeakers({ turns }));
    return out;
  }
  // Before the group: the sources' transcripts become the vocals' files' too (ui-speech.js, keyed by path, size and
  // mtime), so the Transcript panel keeps its words when the clips switch over.
  async function carryTranscripts(app, made, entries) {
    for (const [i, x] of made.entries()) {
      const src = app.project.media.find((m) => m.id === x.mediaId);
      if (src && !entries[i]?.error) await ui.speech?.carryTranscripts?.(src, entries[i]).catch((err) => log.warn(`transcripts not carried: ${err?.message || err}`));
    }
  }

  // The vocals of media files, one task with progress and Cancel. -> [{mediaId, path}] or null (cancelled, failed).
  function renderAll(app, mediaIds) {
    const list = mediaIds.map((id) => app.project.media.find((m) => m.id === id)).filter((m) => m?.audio);
    const total = list.reduce((n, m) => n + Math.max(1, m.duration), 0) || 1;
    return ui.auto.task(app, tr('Isolating voice…'), async (ctx) => {
      const made = [];
      let done = 0;
      for (const m of list) {
        const share = Math.max(1, m.duration) / total;
        const at = (f) => ctx.progress(done + share * f, engine.state === 'loading' ? tr('Loading the voice isolation model…') : undefined);
        const r = await render(app, m.id, { place: 'media', ctx, onPart: at });
        made.push({ mediaId: m.id, path: r.path });
        done += share;
      }
      ctx.progress(1);
      return made;
    });
  }

  // ---------- Isolate Voice ----------
  const kindOf = (seq, c) => seq.tracks.find((t) => t.id === c.track)?.kind;
  const hasSound = (app, seq, c) => kindOf(seq, c) === 'audio' && c.source?.media != null && !!model().mediaOf(app.project, c)?.audio;
  // The selected audio clips; a selected video clip brings its linked audio.
  function soundClips(app) {
    const seq = app.sequence;
    if (!seq) return [];
    const set = new Set();
    for (const c of seq.clips.filter((x) => app.selection.has(x.id))) {
      if (hasSound(app, seq, c)) set.add(c);
      for (const l of model().linkedClips(seq, c)) if (hasSound(app, seq, l)) set.add(l);
    }
    return [...set].filter((c) => !seq.tracks.find((t) => t.id === c.track)?.locked);
  }
  async function isolate(app) {
    const clips = soundClips(app);
    if (!clips.length) { ui.toast(tr('Select a clip with sound to isolate its voice.')); return null; }
    if (!(await ensureReady())) return null;
    const seqId = app.sequence.id;
    const byMedia = new Map();
    for (const c of clips) byMedia.set(c.source.media, [...(byMedia.get(c.source.media) || []), c.id]);
    const made = await renderAll(app, [...byMedia.keys()]);
    if (!made) return null;
    const seq = app.project.sequences.find((s) => s.id === seqId);
    if (!seq) return null;
    const entries = await Cut.media.importFiles(made.map((x) => x.path));
    await carryTranscripts(app, made, entries);
    app.history.begin('Isolate Voice');
    try {
      const vocals = importVocals(app, made, entries);
      const changed = [];
      for (const [mediaId, ids] of byMedia) {
        // clips removed or given another sound while the voice was being isolated are left alone
        const still = ids.filter((id) => seq.clips.some((c) => c.id === id && c.source?.media === mediaId));
        if (still.length && vocals.get(mediaId)) changed.push(...app.history.do(C.replaceAudio(seqId, still, vocals.get(mediaId))).ids);
      }
      app.history.commit();
      ui.toast(tr('The voice was isolated in {n} clips. Undo brings the original sound back.', { n: changed.length }));
      return { clips: changed, media: [...vocals.values()] };
    } catch (err) {
      app.history.cancel();
      ui.report(err);
      return null;
    }
  }
  // From the project panel: the vocals of the chosen media, imported next to them (the timeline stays as it is).
  async function isolateMedia(app, mediaIds) {
    const ids = mediaIds.filter((id) => app.project.media.find((m) => m.id === id)?.audio);
    if (!ids.length) { ui.toast(tr('The media has no sound.')); return null; }
    if (!(await ensureReady())) return null;
    const made = await renderAll(app, ids);
    if (!made) return null;
    const entries = await Cut.media.importFiles(made.map((x) => x.path));
    await carryTranscripts(app, made, entries);
    app.history.begin('Isolate Voice');
    try {
      const vocals = importVocals(app, made, entries);
      app.history.commit();
      ui.toast(tr('The isolated voice is in the project: {n} files.', { n: vocals.size }));
      return { media: [...vocals.values()] };
    } catch (err) {
      app.history.cancel();
      ui.report(err);
      return null;
    }
  }

  // ---------- the settings page's section (ui-settings.js) ----------
  function settingsSection(host, ctx) {
    const sec = ctx.ui.section(host, tr('Voice Isolation'));
    const state = el('span', 'cut-voice-state muted');
    const download = el('button', 'secondary cut-voice-download', tr('Download…'));
    download.type = 'button';
    download.hidden = true;
    const fill = async () => {
      const st = await status();
      const ready = !!st?.runtime && !!st?.model?.installed;
      state.textContent = ready ? tr('{name}: downloaded', { name: st.model.name }) : tr('{name}: not downloaded; it is downloaded when you first use it, after you agree', { name: st?.model?.name || 'HTDemucs' });
      state.dataset.ready = String(ready);
      download.hidden = ready;
    };
    download.onclick = async () => { download.disabled = true; await ensureReady(); download.disabled = false; fill(); };
    const row = el('div', 'settings-note cut-voice-state-row');
    row.append(state, download);
    sec.appendChild(row);
    sec.appendChild(el('div', 'muted settings-note', tr('Isolate Voice (Automation menu, clip menu, project panel) keeps the speech of a clip and drops its music and noise. The new sound is a WAV in the Media folder of the Cut workspace; your files are never changed. It takes about 25 seconds per minute of sound on an 8-core CPU.')));
    fill();
  }

  ui.voice = { isolate, isolateMedia, ensureReady, render, forSpeech, status, settingsSection, keyOf };
})();
