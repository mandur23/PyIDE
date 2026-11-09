// Speech recognition in the editor (docs/cut-architecture.md section 10): Whisper runs on this PC through main
// (main/cut/whisper.js); this file reads and mixes the sound, keeps the transcripts, and turns them into edits.
//
//   Auto Captions…          (Automation menu, captions panel) a caption track from the speech of the sequence, the
//                           In-Out range or the selected clips, one undo step
//   Remove Filler Words…    (Automation menu, transcript panel) hesitations and long pauses, previewed on the
//                           timeline, then ripple-deleted from the clips' tracks and the tracks linked to them
//   the Transcript panel    the words with their times: the word under the playhead lit, a click seeks, selected
//                           words deleted with Delete or Remove (a ripple delete, one undo step), a search
//
// The sound of each media file is decoded (Cut.decoder.audioReader, 10 s blocks), mixed to mono, resampled to 16 kHz
// and streamed to main, which writes it to a temp file the model reads 30 s at a time. Transcripts are per media file
// (its path, size and mtime, the model and the language) in source seconds, kept in the Cut cache (cut:cacheGet/Put)
// and mapped to the timeline through each clip (Cut.speech.clipWords), so edits never need a new recognition.
// Nothing is downloaded until the person presses Download in the setup dialog.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const S = Cut.speech;
  const A = Cut.analyze;
  const C = Cut.commands;
  const { el, button } = ui;
  const T = Cut.time.TICKS;
  const RATE = S.RATE;
  const log = ide.logger('#cut');
  const invoke = (...args) => ide.api.invoke(...args);
  const NOT_SPEECH = new Set(['music', 'effects', 'ambience']);
  const DEFAULTS = { 'cut.speech.model': 'whisper-large-v3-turbo', 'cut.speech.language': 'auto', 'cut.speech.lineChars': 0, 'cut.speech.markUncertain': true, 'cut.speech.isolateVoice': false, 'cut.speech.highlight': false };
  const setting = (k) => { const v = ide.settings.get(k, DEFAULTS[k]); return v === undefined || v === null || v === '' ? DEFAULTS[k] : v; };
  // The word list is the project's (it names what this video is about, and travels with the project file).
  const projectTerms = (app = Cut.app) => (Array.isArray(app?.project?.settings?.speechTerms) ? app.project.settings.speechTerms : []);
  const opts = () => ({ model: String(setting('cut.speech.model')), language: ['auto', 'ko', 'en'].includes(setting('cut.speech.language')) ? setting('cut.speech.language') : 'auto', terms: projectTerms(), isolate: setting('cut.speech.isolateVoice') === true && !!ui.voice });
  // Whether the words Whisper was unsure of are marked (the transcript, the captions, Next Uncertain Word).
  const marking = () => setting('cut.speech.markUncertain') !== false;
  const doubtful = (w) => marking() && S.isUncertain(w);
  const percent = (p) => `${Math.round(p * 100)}%`;
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
  const model = () => Cut.model;
  const seconds = (ticks) => tr('{n} s', { n: (ticks / T).toFixed(1) });

  // main's events: setup progress and the model's state (loading, ready)
  let onProgress = null;
  let engine = { state: 'idle' };
  ide.api.on('cut:speechProgress', (p) => onProgress?.(p));
  let onEngine = null;
  ide.api.on('cut:speechState', (s) => { engine = s || engine; onEngine?.(); });
  const configure = () => invoke('cut:speechConfigure', { idleMinutes: ide.settings.get('ai.idleUnloadMinutes', 10) }).catch(() => {});
  configure();
  ide.on('settingsChanged', (k) => { if (k === 'ai.idleUnloadMinutes') configure(); });
  const status = () => invoke('cut:speechStatus').catch(() => null);

  // ---------- setup: the dialog before the first download ----------
  // What went wrong, in plain words.
  function setupError(r) {
    switch (r?.code) {
      case 'noPython': return tr('Python was not found on this PC. Speech recognition needs Python 3 (64-bit, from python.org) with PyTorch. Install Python and try again.');
      case 'noTorch': return tr('PyTorch cannot be installed for the Python on this PC. Install a 64-bit Python 3.10 to 3.13 from python.org and try again.');
      case 'disk': return tr('There is not enough free disk space. Free up space and try again ({detail}).', { detail: r.error || '' });
      case 'offline': return tr('The download could not reach the internet. Check the connection and try again.');
      case 'busy': return tr('The AI environment is in use by another Nano Studio window. Close it and try again.');
      case 'cancelled': return tr('The download was cancelled.');
      default: return tr('The download failed: {error}', { error: r?.error || tr('unknown error') });
    }
  }
  // Resolves true once the model and the runtime are ready (at once when they are), false when the person declines.
  // Without modelId (recognizing with the chosen model), a model already on this PC is offered in its place and becomes
  // the setting: the default changed to large-v3 turbo, and someone with only small should not need 1.6 GB, or a network.
  async function ensureReady(modelId) {
    const recognizing = modelId == null;
    const st = await status();
    if (!st) { ui.notify(tr('Speech recognition is not available.'), { kind: 'error' }); return false; }
    const m = st.models.find((x) => x.id === (modelId ?? opts().model)) || st.models[0];
    if (st.runtime && m.installed) return true;
    const other = recognizing && st.runtime ? st.models.find((x) => x.id !== m.id && x.installed) : null;
    return new Promise((resolve) => {
      let busy = false;
      let ok = false;
      const body = el('div', 'cut-form cut-speech-setup');
      body.append(el('div', 'cut-dialog-note', tr('Speech recognition uses the {name} model from OpenAI. It runs entirely on this PC: the sound is never sent anywhere.', { name: m.name })));
      const list = el('ul', 'cut-speech-setup-list');
      if (!m.installed) list.appendChild(el('li', null, tr('{name} model: about {size}', { name: m.name, size: ui.formatBytes(m.bytes) })));
      if (!st.runtime) list.appendChild(el('li', null, tr('The AI runtime (Python packages PyTorch and Transformers, shared with the other Nano Studio AI features): up to about {size}, less when Python already has PyTorch', { size: ui.formatBytes(st.runtimeBytes) })));
      body.append(list, el('div', 'cut-dialog-note', tr('Nothing is downloaded until you press Download. It is downloaded once; after that, recognition works offline.')));
      if (other) body.append(el('div', 'cut-dialog-note cut-speech-other', tr('{name} is already on this PC: use it to recognize speech now, with nothing to download.', { name: other.name })));
      const bar = el('div', 'cut-speech-bar');
      const fill = el('div', 'cut-speech-fill');
      bar.appendChild(fill);
      bar.hidden = true;
      const line = el('div', 'cut-speech-status', '', { 'aria-live': 'polite' });
      const error = el('div', 'cut-speech-error', '', { role: 'alert' });
      error.hidden = true;
      body.append(bar, line, error);
      const dlg = ui.dialog({
        title: tr('Download Speech Recognition'), id: 'cutSpeechSetup', body, width: 480,
        onClose: () => { onProgress = null; if (busy) invoke('cut:speechCancelSetup').catch(() => {}); resolve(ok); },
        buttons: [
          { label: tr('Download'), primary: true, run: () => { if (!busy) start(); return false; } },
          ...(other ? [{ label: tr('Use {name}', { name: other.name }), run: () => { if (busy) return false; ide.settings.set('cut.speech.model', other.id); ok = true; return true; } }] : []),
          { label: tr('Cancel') },
        ],
      });
      const go = dlg.el.querySelector('.dialog-buttons .primary');
      onProgress = (p) => {
        if (p.model && p.model !== m.id) return;
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
        const r = await invoke('cut:speechSetup', { model: m.id }).catch((err) => ({ ok: false, error: err.message }));
        busy = false;
        if (!dlg.el.isConnected) return;
        if (r?.ok) { ok = true; ui.toast(tr('{name} is ready.', { name: m.name })); dlg.close(); return; }
        error.textContent = setupError(r);
        error.dataset.code = r?.code || 'failed';
        error.hidden = false;
        line.textContent = '';
        go.disabled = false;
        go.textContent = tr('Try Again');
        if (r?.log) log.warn(`speech setup: ${r.error}\n${r.log}`);
      }
    });
  }

  // ---------- clips and transcripts ----------
  const kindOf = (seq, c) => seq.tracks.find((t) => t.id === c.track)?.kind;
  const mediaOf = (app, c) => model().mediaOf(app.project, c);
  const speaks = (app, seq, c) => kindOf(seq, c) === 'audio' && c.enabled && !c.source?.freeze && !!mediaOf(app, c)?.audio && !NOT_SPEECH.has(c.role);
  // The clips whose speech counts: the selected ones (a video clip brings its linked audio), else every one; with an
  // In-Out range only those it touches.
  function speechClips(app, { selected = true } = {}) {
    const seq = app.sequence;
    if (!seq) return [];
    const range = inOut(app);
    const picked = selected ? seq.clips.filter((c) => app.selection.has(c.id)) : [];
    const set = new Set();
    for (const c of picked) {
      if (speaks(app, seq, c)) set.add(c);
      for (const l of model().linkedClips(seq, c)) if (speaks(app, seq, l)) set.add(l);
    }
    if (!set.size) for (const c of seq.clips) if (speaks(app, seq, c)) set.add(c);
    return [...set].filter((c) => !range || (c.start < range[1] && model().clipEnd(c) > range[0])).sort((a, b) => a.start - b.start);
  }
  const inOut = (app) => (app.inOut?.in != null && app.inOut?.out != null && app.inOut.out > app.inOut.in ? [app.inOut.in, app.inOut.out] : null);
  const fileKey = (m) => `${m.path}|${m.size}|${m.mtime}`;
  // v2: the recognition itself changed (temperature fallback, no-speech windows, windows that start where the text
  // stopped), so transcripts made before are recognised again. Bump it with any change to what Whisper is asked. A word
  // list makes its own transcripts (|t<fingerprint>); without one the key is the one transcripts had before lists.
  // Transcripts made before confidences were kept have words without p, which are never marked.
  const keyOf = (m, o) => `speech|v2|${fileKey(m)}|${o.model}|${o.language}${o.terms?.length ? `|t${S.termsKey(o.terms)}` : ''}${o.isolate ? '|iv' : ''}`;
  const transcripts = new Map(); // key -> {ranges: [[a, b]] seconds, words: [{t0, t1, text, p?}] seconds, language}
  const latest = new Map(); // fileKey -> the key of the transcript made or read last for that file
  const looked = new Set(); // keys asked of the disk cache already
  async function cached(key) {
    if (transcripts.has(key) || looked.has(key)) return transcripts.get(key) || null;
    looked.add(key);
    const bytes = await invoke('cut:cacheGet', key).catch(() => null);
    if (!(bytes instanceof Uint8Array) || !bytes.length) return null;
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes));
      if (j?.v !== 1 || !Array.isArray(j.words) || !Array.isArray(j.ranges)) return null;
      const t = { ranges: j.ranges, words: j.words.map(([t0, t1, text, p]) => (Number.isFinite(p) ? { t0, t1, text, p } : { t0, t1, text })), language: j.language || null };
      transcripts.set(key, t);
      return t;
    } catch { return null; }
  }
  const store = (key, t) => {
    transcripts.set(key, t);
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, ranges: t.ranges, language: t.language, words: t.words.map((w) => (w.p == null ? [w.t0, w.t1, w.text] : [w.t0, w.t1, w.text, w.p])) }));
    return invoke('cut:cachePut', key, bytes).catch(() => {});
  };
  // The source seconds of each media the clips need (the part of each clip inside `range`, a second around it).
  function needed(app, clips, range) {
    const out = new Map();
    for (const c of clips) {
      const a = range ? Math.max(c.start, range[0]) : c.start;
      const b = range ? Math.min(model().clipEnd(c), range[1]) : model().clipEnd(c);
      if (b <= a) continue;
      const s0 = model().sourceTime(c, a);
      const s1 = model().sourceTime(c, Math.max(a, b - 1));
      const m = mediaOf(app, c);
      const list = out.get(m.id) || [];
      list.push([Math.max(0, Math.min(s0, s1) / T - 1), Math.max(s0, s1) / T + 1]);
      out.set(m.id, list);
    }
    return out;
  }

  // Source seconds [a, b) of a media's sound as 16 kHz mono in a temp file of main's. -> {id, samples, start}
  // voice: the isolated voice of these seconds ({path, from}, ui-voice.js), read in place of the media's sound.
  async function writeSound(app, mediaId, a, b, ctx, onPart, voice = null) {
    const o = voice ? await Cut.media.openPath(voice.path) : await Cut.media.open(app.project, mediaId);
    if (voice) { a -= voice.from; b -= voice.from; }
    if (o.error || !o.audio) throw Object.assign(new Error('The clip\'s media cannot be read.'), { code: 'media' });
    const r = await Cut.decoder.audioReader(o, o.audio);
    const rate = r.rate;
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    const g = gcd(rate, RATE);
    const si = rate / g; // a block starting on a multiple of si starts on an output sample
    const so = RATE / g;
    const margin = si * Math.ceil(256 / si); // the resampling filter's reach, so blocks join without a seam
    const s0 = Math.floor((a * rate) / si) * si;
    const s1 = Math.min(r.length, Math.ceil(b * rate));
    if (s1 <= s0) return null;
    const opened = await invoke('cut:speechOpen');
    if (!opened?.id) throw new Error(opened?.error || 'no temp file');
    let samples = 0;
    try {
      const block = rate * 10;
      for (let x = s0; x < s1; x += block) {
        await ctx.step();
        const y = Math.min(s1, x + block);
        const from = Math.max(0, x - margin);
        const planes = await r.read(from, y + margin);
        const len = (planes[0]?.length || 0);
        const mono = new Float32Array(margin + (y - x) + margin);
        const lead = x - from === margin ? 0 : margin - (x - from);
        for (const p of planes) for (let i = 0; i < len && lead + i < mono.length; i++) mono[lead + i] += p[i] / planes.length;
        const res = Cut.audioengine.resample([mono], rate, RATE)[0];
        const off = (margin * so) / si;
        const n = Math.round(((y - x) * so) / si);
        const out = res.slice(off, off + n);
        const w = await invoke('cut:speechWrite', opened.id, new Uint8Array(out.buffer));
        if (w?.error) throw new Error(w.error);
        samples += out.length;
        onPart?.((y - s0) / (s1 - s0));
      }
    } catch (err) {
      await invoke('cut:speechClose', opened.id).catch(() => {});
      throw err;
    }
    return { id: opened.id, samples, start: s0 / rate + (voice?.from || 0) };
  }

  let requestSeq = 0;
  // The words of a sound file, window by window: the next one starts where this one's text stopped when Whisper stopped
  // early (Cut.speech.nextWindow, textStop). -> {words (seconds from the file's start), language}
  async function recognise(file, ctx, o, onPart) {
    const results = [];
    const heard = new Map();
    let again = true;
    for (let from = 0; from != null;) {
      await ctx.step();
      const to = Math.min(file.samples, from + S.WINDOW * RATE);
      const request = `w${++requestSeq}`;
      const stop = () => invoke('cut:speechCancel', request).catch(() => {});
      ctx.signal.addEventListener('abort', stop, { once: true });
      let r;
      try {
        r = await invoke('cut:speechTranscribe', file.id, { offset: from, length: to - from, language: o.language, model: o.model, terms: o.terms, request });
      } finally { ctx.signal.removeEventListener('abort', stop); }
      if (r?.cancelled || ctx.signal.aborted) throw cancelled();
      if (r?.error) throw Object.assign(new Error(tr('Speech recognition failed: {error}', { error: r.error })), { code: r.code || 'speech' });
      if (r.language) heard.set(r.language, (heard.get(r.language) || 0) + 1);
      const words = S.dropEcho(r.words || [], o.terms);
      const step = S.nextWindow(from, to, S.textStop(words, r.end ?? null), { total: file.samples, again });
      results.push({ from, to, until: step.until, words });
      onPart?.(to / file.samples);
      from = step.next;
      again = step.until == null;
    }
    const language = [...heard.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
    return { words: S.mergeWindows(results), language };
  }

  // Makes sure the clips' speech is transcribed (only what is not cached yet). ctx: an analysis task's context.
  async function transcribe(app, clips, ctx, range = null, language = null) {
    const o = language ? { ...opts(), language } : opts();
    const work = [];
    for (const [mediaId, spans] of needed(app, clips, range)) {
      const m = app.project.media.find((x) => x.id === mediaId);
      const key = keyOf(m, o);
      const t = (await cached(key)) || { ranges: [], words: [], language: null };
      transcripts.set(key, t);
      latest.set(fileKey(m), key);
      for (const [a, b] of A.subtract(A.union(spans), t.ranges)) if (b - a >= 0.3) work.push({ mediaId, key, a, b });
    }
    const total = work.reduce((n, w) => n + (w.b - w.a), 0) || 1;
    let done = 0;
    for (const w of work) {
      const share = (w.b - w.a) / total;
      let last = 0;
      const at = (f) => { last = f; ctx.progress(done + share * f, engine.state === 'loading' ? tr('Loading the speech model…') : undefined); };
      // the isolated voice takes about a sixth of the time recognition does
      const voice = o.isolate ? await ui.voice.forSpeech(app, w.mediaId, w.a, w.b, ctx, (f) => at(0.2 * f)) : null;
      const file = await writeSound(app, w.mediaId, w.a, w.b, ctx, (f) => at((voice ? 0.2 : 0) + 0.1 * f), voice);
      if (!file) { done += share; continue; }
      let res;
      // The model loads (half a minute the first time) while the first window's request waits: say so when it starts.
      onEngine = () => at(last);
      try { res = await recognise(file, ctx, o, (f) => at(0.1 + 0.9 * f)); } finally {
        onEngine = null;
        await invoke('cut:speechClose', file.id).catch(() => {});
      }
      const t = transcripts.get(w.key);
      const words = res.words.map((x) => ({ ...x, t0: file.start + x.t0, t1: file.start + x.t1 }));
      const next = {
        ranges: A.union([...t.ranges, [file.start, file.start + file.samples / RATE]]),
        words: S.dedupe([...t.words, ...words].sort((x, y) => x.t0 - y.t0)),
        language: t.language || res.language,
      };
      await store(w.key, next);
      done += share;
    }
    ctx.progress(1);
    return true;
  }
  // The transcript of a media file for these settings, else the last one made for that file. null when none.
  function transcriptOf(m, o = opts()) {
    return transcripts.get(keyOf(m, o)) || transcripts.get(latest.get(fileKey(m))) || null;
  }
  // The clips' words on the timeline (ticks), in time order. Clips not transcribed yet have none.
  function timelineWords(app, clips, range = null) {
    const lists = [];
    for (const c of clips) {
      const m = mediaOf(app, c);
      const t = m && transcriptOf(m);
      if (t) lists.push(S.clipWords(c, t.words));
    }
    const all = S.joinClips(lists);
    return range ? all.filter((w) => (w.t0 + w.t1) / 2 >= range[0] && (w.t0 + w.t1) / 2 < range[1]) : all;
  }
  // Reads the cached transcripts of the sequence's media (for the panel, once per file and setting).
  async function loadCachedFor(app) {
    const seq = app.sequence;
    if (!seq) return false;
    let found = false;
    const o = opts();
    for (const c of seq.clips) {
      const m = mediaOf(app, c);
      if (!m?.audio) continue;
      const key = keyOf(m, o);
      if (await cached(key)) { if (!latest.has(fileKey(m))) latest.set(fileKey(m), key); found = true; }
    }
    return found;
  }
  // Isolate Voice (ui-voice.js): the vocals of a media file run on its time, so the file's transcripts (every setting's,
  // in memory and the one for these settings on disk) become the vocals' too, and nothing is recognised again.
  async function carryTranscripts(from, to) {
    await cached(keyOf(from, opts()));
    const a = `speech|v2|${fileKey(from)}|`;
    const b = `speech|v2|${fileKey(to)}|`;
    for (const [k, t] of [...transcripts]) if (k.startsWith(a) && !transcripts.has(b + k.slice(a.length))) await store(b + k.slice(a.length), t);
    const last = latest.get(fileKey(from));
    if (last?.startsWith(a) && !latest.has(fileKey(to))) latest.set(fileKey(to), b + last.slice(a.length));
  }
  // A transcript word (from timelineWords) corrected or confirmed by the person: the new text, and no longer uncertain
  // (p 1). The transcript is the media file's, so every clip of that file shows the correction.
  async function correctWord(app, w, text) {
    const clip = app.sequence?.clips.find((c) => c.id === w.clip);
    const m = clip && mediaOf(app, clip);
    const t = m && transcriptOf(m);
    const key = t && [...transcripts].find(([, v]) => v === t)?.[0];
    const src = t?.words[w.src];
    const next = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!key || !src || !next) return false;
    const words = t.words.slice();
    words[w.src] = { ...src, text: next, p: 1 };
    await store(key, { ...t, words });
    app.emit('transcripts', {});
    return true;
  }

  // ---------- uncertain words ----------
  // Their frames on the timeline, in order: the shown caption track's doubts (the captions are where they are fixed),
  // or the transcript's words when the Transcript panel has the keyboard or no caption holds a doubt.
  function uncertainFrames(app) {
    const seq = app.sequence;
    if (!seq || !marking()) return [];
    const fps = seq.fps;
    const track = ui.captions?.trackOf(app);
    let list = (track?.items || []).flatMap((it) => (it.doubt || []).map((d) => Math.min(it.start + d.at, it.end - 1)));
    if (!list.length || app.focusPanel === 'transcript') {
      list = timelineWords(app, seq.clips.filter((c) => speaks(app, seq, c))).filter(doubtful).map((w) => w.t0);
    }
    return [...new Set(list.map((t) => Cut.time.snap(t, fps)))].sort((a, b) => a - b);
  }
  // Next (dir 1) or Previous (-1) Uncertain Word: the playhead goes to it, and the Transcript and captions panels show
  // it. -> the time, or null when there is none that way.
  async function nextUncertain(app, dir = 1) {
    if (!app.sequence) return null;
    if (!marking()) { ui.toast(tr('Uncertain words are not marked. Turn the marks on in the settings (Video Editor, Speech Recognition).')); return null; }
    await loadCachedFor(app);
    const list = uncertainFrames(app);
    const t = dir > 0 ? list.find((x) => x > app.t) : list.filter((x) => x < app.t).pop();
    if (t == null) {
      ui.toast(!list.length ? tr('There are no uncertain words.') : dir > 0 ? tr('No uncertain words after the playhead.') : tr('No uncertain words before the playhead.'));
      return null;
    }
    app.setTime(t);
    ui.transcript?.reveal(t);
    ui.captions?.reveal?.(app, t);
    return t;
  }

  // Ready, then transcribed: true, or false when declined, cancelled or failed (said already).
  // Whisper, and HTDemucs when the voice is isolated first: true once both are there.
  const readyToRecognise = async () => (await ensureReady()) && (!opts().isolate || await ui.voice.ensureReady());
  async function prepare(app, clips, range, language = null) {
    if (!(await readyToRecognise())) return false;
    const r = await ui.auto.task(app, tr('Recognizing speech…'), (ctx) => transcribe(app, clips, ctx, range, language));
    if (r) app.emit('transcripts', {});
    return !!r;
  }

  // ---------- the word list ----------
  // The field for the project's word list: {row, value() -> terms}.
  function termsField(terms) {
    const box = el('textarea', 'cut-speech-terms', undefined, { rows: 3, spellcheck: 'false', placeholder: tr('One per line or separated by commas') });
    box.value = terms.join('\n');
    box.dataset.userText = '';
    const row = el('div', 'cut-speech-terms-row');
    row.append(ui.row(tr('Word list'), box), el('div', 'cut-dialog-note', tr('Names, products and terms that are spoken. Whisper is told of them, so it writes them the way you spell them here. Saved with the project.')));
    return { row, value: () => S.parseTerms(box.value) };
  }
  // The project's word list set to `terms` (one undo step when it changed). -> false when that failed.
  function setTerms(app, terms) {
    const now = projectTerms(app);
    if (now.length === terms.length && now.every((t, i) => t === terms[i])) return true;
    return !!ui.exec(app, C.setSettings({ speechTerms: terms }));
  }
  // Word List… (the Transcript panel): the list alone, for the next recognition.
  function editTerms(app) {
    const field = termsField(projectTerms(app));
    const body = el('div', 'cut-form cut-auto-form');
    body.append(field.row, el('div', 'cut-dialog-note', tr('Speech already recognized is recognized again with the new list the next time you transcribe or create captions.')));
    return new Promise((resolve) => {
      let result = false;
      ui.dialog({ title: tr('Word List'), id: 'cutSpeechTerms', body, width: 460, onClose: () => resolve(result),
        buttons: [{ label: tr('OK'), primary: true, run: () => { result = setTerms(app, field.value()); } }, { label: tr('Cancel') }] });
    });
  }

  // ---------- Auto Captions ----------
  const languageOptions = () => [{ value: 'auto', label: tr('Detect automatically') }, { value: 'ko', label: tr('Korean') }, { value: 'en', label: tr('English') }];
  // ask false (the control API): no dialog; language, chars and highlight as given, else the last choices.
  async function autoCaptions(app, { ask = true, language, chars, highlight } = {}) {
    const seq = app.sequence;
    const clips = speechClips(app);
    if (!seq || !clips.length) { ui.toast(tr('There are no clips with speech to transcribe.')); return null; }
    const range = inOut(app);
    const picked = seq.clips.some((c) => app.selection.has(c.id));
    const scope = range ? tr('From In to Out') : picked ? tr('The selected clips') : tr('The whole sequence');
    const st = await status();
    const o = { language: opts().language, chars: Number(setting('cut.speech.lineChars')) || 0, terms: projectTerms(app) };
    let spk = null; // the speakers' color and name choice (ui-speakers.js), when the project has speaker labels
    if (!ask) {
      const shown = seq.captions.find((t) => t.name === tr('Auto Captions'));
      Object.assign(o, { language: language ?? o.language, chars: chars ?? o.chars, isolate: opts().isolate, highlight: highlight ?? (shown ? !!shown.style.highlight : !!setting('cut.speech.highlight')) });
      spk = ui.speakers?.captionField(app) || null;
    }
    const go = !ask || await new Promise((resolve) => {
      let ok = false;
      const lang = ui.select({ options: languageOptions(), value: o.language, cls: 'cut-speech-language', onChange: (v) => { o.language = v; } });
      const chars = ui.numberField({ value: o.chars, min: 0, max: 80, step: 1, precision: 0, cls: 'cut-speech-chars', onChange: (v) => { o.chars = v; } });
      const terms = termsField(o.terms);
      const m = st?.models.find((x) => x.id === opts().model) || st?.models[0];
      const isolate = el('input', 'cut-speech-isolate', undefined, { type: 'checkbox' });
      isolate.checked = opts().isolate;
      const isolateRow = el('label', 'cut-form-row cut-check-row');
      isolateRow.append(isolate, el('span', null, tr('Isolate the voice first (HTDemucs): for speech over music; it makes steady noise worse, and takes about a sixth longer')));
      isolateRow.hidden = !ui.voice;
      // the word-by-word highlight: the last choice, or what the track being captioned again shows
      const shown = seq.captions.find((t) => t.name === tr('Auto Captions'));
      const hl = el('input', 'cut-speech-highlight', undefined, { type: 'checkbox' });
      hl.checked = shown ? !!shown.style.highlight : !!setting('cut.speech.highlight');
      const hlRow = el('label', 'cut-form-row cut-check-row');
      hlRow.append(hl, el('span', null, tr('Highlight each word as it is spoken')));
      spk = ui.speakers?.captionField(app) || null;
      const body = el('div', 'cut-form cut-auto-form');
      body.append(
        el('div', 'cut-dialog-note', tr('{scope}: {n} clips with speech. Captions of up to two lines, at most 6 seconds each, split at pauses and sentence ends.', { scope, n: clips.length })),
        ui.row(tr('Language'), lang),
        ui.row(tr('Characters per line'), chars, tr('0: 18 for Korean, 42 otherwise')),
        terms.row,
        isolateRow,
        hlRow,
        spk?.row || '',
        el('div', 'cut-dialog-note', tr('Model: {name}. It runs on this PC.', { name: m?.name || 'Whisper' })),
      );
      ui.dialog({ title: tr('Auto Captions'), id: 'cutSpeechCaptions', body, width: 460, onClose: () => resolve(ok),
        buttons: [{ label: tr('Create Captions'), primary: true, run: () => { for (const n of body.querySelectorAll('input.cut-number-input')) n.blur(); o.terms = terms.value(); o.isolate = isolate.checked; o.highlight = hl.checked; ok = true; } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    if (ask) {
      if (ui.voice && o.isolate !== opts().isolate) ide.settings.set('cut.speech.isolateVoice', o.isolate);
      if (o.highlight !== !!setting('cut.speech.highlight')) ide.settings.set('cut.speech.highlight', o.highlight);
      if (o.language !== setting('cut.speech.language')) ide.settings.set('cut.speech.language', o.language);
      if (o.chars !== Number(setting('cut.speech.lineChars'))) ide.settings.set('cut.speech.lineChars', o.chars);
      if (!setTerms(app, o.terms)) return null;
    }
    const ids = clips.map((c) => c.id);
    if (!(await prepare(app, clips, range, ask ? null : o.language))) return null;
    const s = app.sequence;
    const now = ids.map((id) => s.clips.find((c) => c.id === id)).filter(Boolean);
    const words = timelineWords(app, now, range);
    if (!words.length) { ui.toast(tr('No speech was recognized.')); return { count: 0 }; }
    const frame = Cut.time.frameTicks(s.fps);
    const make = (ws) => S.captions(ws, { frame, maxChars: o.chars, uncertain: S.UNCERTAIN });
    // with speaker labels, a caption never holds two speakers and knows its own
    const items = ui.speakers ? ui.speakers.captions(app, words, make, frame) : make(words);
    const name = tr('Auto Captions');
    const langs = new Set(now.map((c) => transcriptOf(mediaOf(app, c))?.language).filter(Boolean));
    const lang = o.language !== 'auto' ? o.language : langs.size === 1 ? [...langs][0] : S.isKorean(words.map((w) => w.text).join('')) ? 'ko' : 'en';
    const track = s.captions.find((t) => t.name === name);
    const [r0, r1] = range || [0, Infinity];
    const cmd = track
      ? C.setCaptions(s.id, track.id, [...track.items.filter((it) => it.end <= r0 || it.start >= r1).map(({ start, end, text, doubt, words, speaker }) => ({ start, end, text, doubt, words, speaker })), ...items])
      : C.addCaptionTrack(s.id, { name, lang, items, style: { ...(spk ? spk.value() : {}), highlight: o.highlight } });
    const style = { ...(spk ? spk.value() : {}), ...(track && !!track.style.highlight !== o.highlight ? { highlight: o.highlight } : {}) };
    const r = ui.exec(app, C.batch('Auto Captions', [cmd, ...(track && Object.keys(style).length ? [C.setCaptionTrack(s.id, track.id, { style })] : [])]));
    if (r) ui.toast(tr('Captions created: {n}.', { n: items.length }));
    return r ? { count: items.length } : null;
  }

  // ---------- Remove Filler Words ----------
  // Speech recognition alone (the control API's transcribe): the speech clips (the selection, else all; In to Out).
  // -> true when transcribed, false when declined, cancelled or failed.
  async function recognize(app, { language = null } = {}) {
    const clips = speechClips(app);
    if (!app.sequence || !clips.length) { ui.toast(tr('There are no clips with speech to transcribe.')); return false; }
    return prepare(app, clips, inOut(app), language);
  }

  // ask false (the control API): no dialog; the plan with the options given (else the last ones) is removed.
  async function removeFillers(app, { ask = true, fillers, pauses, pauseLength, keep } = {}) {
    const seq = app.sequence;
    const clips = speechClips(app);
    if (!seq || !clips.length) { ui.toast(tr('There are no clips with speech to transcribe.')); return null; }
    const ids = clips.map((c) => c.id);
    const range = inOut(app);
    if (!(await prepare(app, clips, range))) return null;
    const o = { fillers: true, pauses: true, pauseLength: 1, keep: 0.15, ...(ide.settings.get('cut.auto.fillers', null) || {}) };
    for (const [k, v] of Object.entries({ fillers, pauses, pauseLength, keep })) if (v != null) o[k] = v;
    const plan = () => {
      const s = app.sequence;
      const now = ids.map((id) => s.clips.find((c) => c.id === id)).filter(Boolean);
      const words = timelineWords(app, now, range);
      const p = S.fillerPlan(words, { ...o, frame: Cut.time.frameTicks(s.fps) });
      return { ...p, words, ...ui.auto.rippleTracks(s, now) };
    };
    if (!ask) {
      const p = plan();
      if (!p.ranges.length) { ui.toast(tr('No filler words or long pauses were found.')); return { cuts: 0 }; }
      const r = ui.auto.rippleRanges(app, p.ranges, p.tracks, 'Remove Filler Words');
      if (r) app.select([]);
      return r ? { cuts: p.ranges.length, fillers: p.fillers.length, pauses: p.pauses.length, seconds: Math.round((A.total(p.ranges) / T) * 10) / 10 } : null;
    }
    const summary = el('div', 'cut-auto-summary', '', { 'aria-live': 'polite' });
    const show = () => {
      const p = plan();
      summary.textContent = p.ranges.length
        ? tr('Fillers: {f} · long pauses: {p} · {time} removed', { f: p.fillers.length, p: p.pauses.length, time: seconds(A.total(p.ranges)) })
        : tr('No filler words or long pauses were found.');
      summary.dataset.cuts = String(p.ranges.length);
      summary.dataset.fillers = String(p.fillers.length);
      ui.timeline.setOverlay?.({ ranges: p.ranges, tracks: p.changed });
    };
    const check = (key, label, cls) => {
      const box = el('input', cls, undefined, { type: 'checkbox' });
      box.checked = !!o[key];
      box.addEventListener('change', () => { o[key] = box.checked; show(); });
      const row = el('label', 'cut-form-row cut-check-row');
      row.append(box, el('span', null, label));
      return row;
    };
    const field = (key, extra) => ui.numberField({ value: o[key], ...extra, onChange: (v) => { o[key] = v; show(); } });
    const body = el('div', 'cut-form cut-auto-form');
    body.append(
      el('div', 'cut-dialog-note', tr('Hesitations (Korean 음, 어, 으음; 그, 저, 뭐 when a pause follows; English um, uh, er, ah, hmm) and long pauses between words are ripple-deleted from their tracks and the tracks linked to them.')),
      check('fillers', tr('Filler words'), 'cut-speech-fillers'),
      check('pauses', tr('Pauses between words'), 'cut-speech-pauses'),
      ui.row(tr('Pauses longer than'), field('pauseLength', { min: 0.3, max: 10, step: 0.1, precision: 1, unit: 's', cls: 'cut-speech-pause' })),
      ui.row(tr('Keep on each side'), field('keep', { min: 0, max: 1, step: 0.05, precision: 2, unit: 's', cls: 'cut-speech-keep' })),
      summary,
    );
    show();
    return new Promise((resolve) => {
      let result = null;
      ui.dialog({
        title: tr('Remove Filler Words'), id: 'cutSpeechFillers', body, width: 460,
        onClose: () => { ui.timeline.setOverlay?.(null); resolve(result); },
        buttons: [
          { label: tr('Remove'), primary: true, run: () => {
            for (const n of body.querySelectorAll('input.cut-number-input')) n.blur();
            ide.settings.set('cut.auto.fillers', o);
            const p = plan();
            if (!p.ranges.length) { ui.toast(tr('No filler words or long pauses were found.')); return; }
            result = ui.auto.rippleRanges(app, p.ranges, p.tracks, 'Remove Filler Words');
            if (result) { app.select([]); ui.toast(tr('Removed {n} cuts ({time}).', { n: p.ranges.length, time: seconds(A.total(p.ranges)) })); }
          } },
          { label: tr('Cancel') },
        ],
      });
    });
  }

  // ---------- the Transcript panel ----------
  function mount(host, app) {
    const offs = [];
    const root = el('div', 'cut-transcript');
    const bar = el('div', 'cut-panel-toolbar');
    const run = button({ label: tr('Transcribe'), title: tr('Recognize the speech of the sequence'), cls: 'cut-tr-run', onClick: () => transcribeSequence() });
    const search = el('input', 'cut-search cut-tr-search', undefined, { type: 'search', placeholder: tr('Search'), spellcheck: 'false' });
    const count = el('span', 'cut-tr-count');
    const remove = button({ label: tr('Remove'), title: tr('Ripple delete the selected words'), cls: 'cut-tr-remove', disabled: true, onClick: () => removeSelected() });
    const fillers = button({ label: tr('Fillers…'), title: tr('Remove Filler Words…'), cls: 'cut-tr-fillers', onClick: () => Promise.resolve(removeFillers(app)).catch((err) => ui.report(err)) });
    const list = button({ label: tr('Word List…'), title: tr('Names and terms Whisper is told of'), cls: 'cut-tr-terms', onClick: () => Promise.resolve(editTerms(app)).catch((err) => ui.report(err)) });
    bar.append(run, search, count, remove, fillers, list);
    const text = el('div', 'cut-tr-text', undefined, { tabindex: 0, role: 'document' });
    const empty = el('div', 'cut-empty cut-tr-empty');
    const foot = el('div', 'cut-panel-foot');
    const footText = el('span', 'cut-tr-foot-text');
    const next = button({ label: '', title: tr('Next Uncertain Word'), cls: 'cut-tr-next-uncertain', onClick: () => Promise.resolve(nextUncertain(app, 1)).catch((err) => ui.report(err)) });
    foot.append(footText, next);
    // the speakers' row (ui-speakers.js): their names and colors, Label Speakers, the number of speakers
    const speakers = ui.speakers?.bar(app, { selectWords: (list) => pickWords(list), segment: (i) => segmentOf(i), words: () => words });
    root.append(bar, speakers?.el || '', text, empty, foot);
    host.appendChild(root);

    let words = [];
    let ids = []; // each word's speaker id (null: none)
    let spans = [];
    let sel = null; // [i, j] of words
    let pick = null; // a Set of word indexes (all the words of one speaker), instead of sel
    let anchor = -1;
    let current = -1;
    let matches = [];
    let matchAt = -1;
    let editing = null; // the word being corrected: {i}
    const fps = () => app.sequence?.fps || [30, 1];

    function draw() {
      const seq = app.sequence;
      words = seq ? timelineWords(app, seq.clips.filter((c) => speaks(app, seq, c))) : [];
      ids = ui.speakers?.wordSpeakers(app, words) || words.map(() => null);
      const paras = [];
      let para = null;
      spans = words.map((w, i) => {
        // a paragraph is one speaker's: a new one at a pause and where the speaker changes
        if (!para || w.t0 - words[i - 1].t1 >= 1.2 * T || ids[i] !== ids[i - 1]) {
          para = el('div', 'cut-tr-para');
          para.dataset.from = String(i);
          if (ids[i]) para.appendChild(ui.speakers.paraLabel(app, ids[i], i));
          para.appendChild(el('span', 'cut-tr-time', Cut.time.timecode(w.t0, fps())));
          paras.push(para);
        }
        const s = el('span', 'cut-tr-word', w.text, { 'data-i': String(i) });
        s.dataset.userText = '';
        s.title = `${Cut.time.timecode(w.t0, fps())} – ${Cut.time.timecode(w.t1, fps())}`;
        // Whisper was unsure of it: a wavy underline, and how sure it was in the tooltip
        if (doubtful(w)) {
          s.classList.add('uncertain');
          s.dataset.p = String(w.p);
          s.title += `\n${tr('Whisper was unsure of this word ({p}). Double-click to correct it.', { p: percent(w.p) })}`;
        }
        para.append(s, document.createTextNode(' '));
        return s;
      });
      text.replaceChildren(...paras);
      if (sel && (sel[1] >= words.length)) sel = null;
      if (pick && [...pick].some((k) => k >= words.length)) pick = null;
      speakers?.update(words, ids);
      current = -1;
      empty.hidden = words.length > 0;
      text.hidden = !words.length;
      empty.textContent = seq?.clips.some((c) => speaks(app, seq, c))
        ? tr('No transcript yet. Press Transcribe to recognize the speech of the sequence on this PC.')
        : tr('The sequence has no clips with speech.');
      const unsure = words.filter(doubtful).length;
      footText.textContent = words.length ? tr('{n} words', { n: words.length }) : '';
      next.hidden = !unsure;
      next.textContent = tr('{n} uncertain ›', { n: unsure });
      paint();
      find();
      highlight();
    }
    function paint() {
      spans.forEach((s, i) => s.classList.toggle('selected', pick ? pick.has(i) : !!sel && i >= sel[0] && i <= sel[1]));
      remove.disabled = !sel && !pick;
    }
    // Words chosen one by one (Select Words of a speaker): Delete and Remove take them all.
    function pickWords(list) {
      sel = null;
      pick = list.length ? new Set(list) : null;
      paint();
      if (pick) spans[Math.min(...pick)]?.scrollIntoView({ block: 'nearest' });
    }
    // The word indexes of the paragraph that starts at word i.
    function segmentOf(i) {
      const p = spans[i]?.closest('.cut-tr-para');
      return p ? [...p.querySelectorAll('.cut-tr-word')].map((s) => Number(s.dataset.i)) : [];
    }
    function highlight() {
      const i = words.length ? S.wordAt(words, app.t) : -1;
      const now = i >= 0 && app.t < Math.max(words[i].t1, words[i + 1] ? Math.min(words[i + 1].t0, words[i].t1 + 0.5 * T) : words[i].t1) ? i : -1;
      if (now === current) return;
      spans[current]?.classList.remove('current');
      current = now;
      const s = spans[current];
      if (s) {
        s.classList.add('current');
        if (app.playing) s.scrollIntoView({ block: 'nearest' });
      }
    }
    function find() {
      matches = S.search(words, search.value);
      for (const s of text.querySelectorAll('.cut-tr-word.match')) s.classList.remove('match');
      for (const [i, j] of matches) for (let k = i; k <= j; k++) spans[k]?.classList.add('match');
      count.textContent = search.value.trim() ? tr('{n} found', { n: matches.length }) : '';
      matchAt = -1;
    }
    function select(i, j, { seek = true } = {}) {
      sel = i < 0 ? null : [Math.min(i, j), Math.max(i, j)];
      pick = null;
      paint();
      if (sel && seek) app.setTime(words[sel[0]].t0);
    }
    function removeSelected() {
      if (!(sel || pick) || !app.sequence) return false;
      const seq = app.sequence;
      const chosen = pick ? [...pick].sort((a, b) => a - b) : [];
      if (!pick) for (let k = sel[0]; k <= sel[1]; k++) chosen.push(k);
      const ranges = S.removalRanges(words, chosen, { frame: Cut.time.frameTicks(seq.fps) });
      if (!ranges.length) return false;
      const ownClips = [...new Set(chosen.map((k) => words[k].clip))].map((id) => seq.clips.find((c) => c.id === id)).filter(Boolean);
      const { tracks } = ui.auto.rippleTracks(seq, ownClips);
      const r = ui.auto.rippleRanges(app, ranges, tracks, 'Delete Words');
      if (r) { sel = null; pick = null; anchor = -1; app.setTime(ranges[0][0]); }
      return !!r;
    }
    async function transcribeSequence() {
      const seq = app.sequence;
      if (!seq) return;
      const clips = seq.clips.filter((c) => speaks(app, seq, c));
      if (!clips.length) { ui.toast(tr('There are no clips with speech to transcribe.')); return; }
      run.disabled = true;
      try { await prepare(app, clips, null); } catch (err) { ui.report(err); } finally { run.disabled = false; }
      draw();
    }

    // Double-click: the word becomes a field; Enter or leaving it keeps the text (a word left as it was is confirmed,
    // no longer uncertain), Esc puts it back.
    function edit(i) {
      const s = spans[i];
      if (!s || editing) return;
      const w = words[i];
      const input = el('input', 'cut-tr-edit', undefined, { type: 'text', spellcheck: 'false', 'aria-label': tr('Correct the word') });
      input.value = w.text;
      input.dataset.userText = '';
      input.style.width = `${[...w.text].length + 3}ch`;
      editing = { i };
      s.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        input.replaceWith(s);
        editing = null;
        text.focus({ preventScroll: true });
        if (save && value && (value !== w.text || doubtful(w))) await correctWord(app, w, value);
        else later();
      };
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }
    // The word at frame t selected and scrolled to (Next Uncertain Word).
    function reveal(t) {
      let i = words.findIndex((w) => Cut.time.snap(w.t0, fps()) === t && doubtful(w));
      if (i < 0) i = S.wordAt(words, t);
      if (i < 0) return;
      select(i, i, { seek: false });
      spans[i]?.scrollIntoView({ block: 'nearest' });
    }

    const wordOf = (target) => target?.closest?.('.cut-tr-word');
    text.addEventListener('dblclick', (e) => {
      const w = wordOf(e.target);
      if (w && text.contains(w)) edit(Number(w.dataset.i));
    });
    text.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const w = wordOf(e.target);
      if (!w) return;
      e.preventDefault();
      text.focus({ preventScroll: true });
      const i = Number(w.dataset.i);
      if (e.shiftKey && anchor >= 0) { select(anchor, i, { seek: false }); return; }
      anchor = i;
      select(i, i);
      const move = (ev) => {
        const t = wordOf(document.elementFromPoint(ev.clientX, ev.clientY));
        if (t && text.contains(t)) select(anchor, Number(t.dataset.i), { seek: false });
      };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (sel || pick)) { e.preventDefault(); e.stopPropagation(); select(-1); }
    });
    search.addEventListener('input', () => find());
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || !matches.length) return;
      e.preventDefault();
      matchAt = (matchAt + (e.shiftKey ? matches.length - 1 : 1)) % matches.length;
      const [i, j] = matches[matchAt];
      select(i, j);
      spans[i]?.scrollIntoView({ block: 'nearest' });
    });
    offs.push(ui.onAction('delete', () => removeSelected() || false, { panels: ['transcript'] }));
    offs.push(ui.onAction('rippleDelete', () => removeSelected() || false, { panels: ['transcript'] }));
    let raf = 0;
    // not while a word is being corrected: the redraw would take its field away (it draws again when that ends)
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!editing) draw(); }); };
    offs.push(() => cancelAnimationFrame(raf));
    offs.push(app.on('project', later), app.on('sequence', () => { sel = null; loadCachedFor(app).then(later); later(); }), app.on('time', highlight), app.on('transcripts', later));
    offs.push(ide.on('settingsChanged', (k) => { if (k === 'cut.speech.markUncertain') later(); }));
    loadCachedFor(app).then(later);
    draw();
    ui.transcript = {
      get words() { return words.map((w, i) => ({ t0: w.t0, t1: w.t1, text: w.text, clip: w.clip, p: w.p, uncertain: doubtful(w), speaker: ids[i] ?? null })); },
      get selection() { return sel ? [...sel] : null; },
      // the words picked one by one (a speaker's), in order, else null
      get picked() { return pick ? [...pick].sort((a, b) => a - b) : null; },
      select, selectWords: pickWords, removeSelected, transcribe: transcribeSequence, refresh: draw, edit, reveal,
    };
    return { dispose: () => { for (const off of offs) off(); }, focus: () => text.focus({ preventScroll: true }) };
  }
  ui.registerPanel('transcript', { title: () => tr('Transcript'), mount });

  // ---------- the settings page's section (ui-settings.js) ----------
  function settingsSection(host, ctx) {
    const sec = ctx.ui.section(host, tr('Speech Recognition'));
    const modelSel = el('select', 'cut-settings-select cut-speech-model');
    modelSel.dataset.key = 'cut.speech.model';
    const state = el('span', 'cut-speech-model-state muted');
    const download = el('button', 'secondary cut-speech-download', tr('Download…'));
    download.type = 'button';
    download.hidden = true;
    const fill = async () => {
      const st = await status();
      const list = st?.models || [{ id: 'whisper-small', name: 'Whisper small', bytes: 970e6 }, { id: 'whisper-large-v3-turbo', name: 'Whisper large-v3 turbo', bytes: 1625e6 }];
      const v = String(ctx.value('cut.speech.model') ?? DEFAULTS['cut.speech.model']);
      modelSel.replaceChildren(...list.map((m) => new Option(`${m.name} (${ui.formatBytes(m.bytes)})`, m.id)));
      modelSel.value = list.some((m) => m.id === v) ? v : list[0].id;
      const m = list.find((x) => x.id === modelSel.value);
      const ready = !!st?.runtime && !!m?.installed;
      state.textContent = ready ? tr('Downloaded') : tr('Not downloaded: it is downloaded when you first use it, after you agree');
      state.dataset.ready = String(ready);
      download.hidden = ready;
    };
    modelSel.onchange = () => { ctx.set('cut.speech.model', modelSel.value); fill(); };
    download.onclick = async () => { download.disabled = true; await ensureReady(modelSel.value); download.disabled = false; fill(); };
    const modelRow = el('div', 'cut-speech-model-row');
    modelRow.append(modelSel, download);
    sec.appendChild(ctx.ui.fieldRow(tr('Model:'), modelRow));
    sec.appendChild(el('div', 'settings-note cut-speech-state-row')).appendChild(state);
    sec.appendChild(ctx.ui.fieldRow(tr('Language:'), ctx.ui.selectInput('cut.speech.language', languageOptions().map((o) => [o.value, o.label]), 'auto')));
    sec.appendChild(ctx.ui.fieldRow(tr('Characters per caption line:'), ctx.ui.numberInput('cut.speech.lineChars', { min: 0, max: 80 }), tr('0: 18 for Korean, 42 otherwise')));
    sec.appendChild(ctx.ui.checkbox('cut.speech.markUncertain', tr('Mark the words Whisper was unsure of (Transcript and Captions panels)')));
    if (ui.voice) sec.appendChild(ctx.ui.checkbox('cut.speech.isolateVoice', tr('Isolate the voice before recognition (HTDemucs): for speech over music, not over steady noise')));
    sec.appendChild(el('div', 'muted settings-note', tr('Whisper large-v3 turbo, the default, gets about half as many characters wrong as small, also through noise and music, and takes about 2.5 minutes per minute of sound on an 8-core CPU; Whisper small takes about 1 minute. Recognition runs on this PC only.')));
    fill();
  }

  ui.speech = {
    autoCaptions, removeFillers, recognize, ensureReady: (modelId) => (modelId ? ensureReady(modelId) : readyToRecognise()), transcribe, timelineWords, speechClips, settingsSection, status, defaults: DEFAULTS,
    nextUncertain, editTerms, correctWord, terms: projectTerms, marking, percent,
    // for speaker labels (ui-speakers.js): a media file's sound to main, its transcript, which clips speak
    writeSound, transcriptOf, speaks,
    // Reads the cached transcripts of the sequence's media (no recognition): true when one was found.
    loadCached: loadCachedFor,
    carryTranscripts,
    // Forgets the transcripts in memory (the cache on disk stays).
    forget: () => { transcripts.clear(); latest.clear(); looked.clear(); },
  };
})();
