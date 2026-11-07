// Speaker labels in the editor (docs/cut-architecture.md section 10): who speaks when, on the transcripts of
// ui-speech.js. Main (main/cut/speakers.js) gives one WeSpeaker embedding per window of speech; the windows, the
// clustering and the turns are Cut.speakers (pure). The labels are the project's (project.speakers, one undo step
// per change, saved with it), in source seconds per media file, so trims and moves keep them.
//
//   Label Speakers       (Automation menu, the Transcript panel's speakers row) recognises what is not transcribed
//                        yet, embeds the speech (cached per media file and windows) and labels it: Auto, or the
//                        number of speakers chosen in the row; run again with another number, only the clustering
//                        runs again, and speakers that stay keep their names and colors
//   the speakers row     a chip per speaker: click selects all its words, double-click renames it
//   a paragraph's label  its speaker: Change Speaker (one undo step), Rename Speaker…, Select Words
//   Auto Captions        captions split where the speaker changes, each with its speaker; the track shows the
//                        speakers' colors and/or names (style.speakerColor, style.speakerName)
// Nothing is downloaded until the person presses Download in the setup dialog.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const K = Cut.speakers;
  const C = Cut.commands;
  const { el, button } = ui;
  const T = Cut.time.TICKS;
  const RATE = Cut.speech.RATE;
  const log = ide.logger('#cut');
  const invoke = (...args) => ide.api.invoke(...args);
  const model = () => Cut.model;
  const labels = (app) => app?.project?.speakers || null;
  const nameOf = (app, id) => K.nameOf(labels(app), id, tr);
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
  const CHUNK = 64; // windows per request: progress and Cancel between them

  let onProgress = null;
  ide.api.on('cut:speakersProgress', (p) => onProgress?.(p));
  const configure = () => invoke('cut:speakersConfigure', { idleMinutes: ide.settings.get('ai.idleUnloadMinutes', 10) }).catch(() => {});
  configure();
  ide.on('settingsChanged', (k) => { if (k === 'ai.idleUnloadMinutes') configure(); });
  const status = () => invoke('cut:speakersStatus').catch(() => null);

  // ---------- setup: the dialog before the first download ----------
  function setupError(r) {
    switch (r?.code) {
      case 'noPython': return tr('Python was not found on this PC. Speaker labels need Python 3 (64-bit, from python.org). Install Python and try again.');
      case 'disk': return tr('There is not enough free disk space. Free up space and try again ({detail}).', { detail: r.error || '' });
      case 'offline': return tr('The download could not reach the internet. Check the connection and try again.');
      case 'busy': return tr('The AI environment is in use by another Nano Studio window. Close it and try again.');
      case 'cancelled': return tr('The download was cancelled.');
      default: return tr('The download failed: {error}', { error: r?.error || tr('unknown error') });
    }
  }
  // Resolves true once the model and onnxruntime are there (at once when they are), false when the person declines.
  async function ensureReady() {
    const st = await status();
    if (!st) { ui.notify(tr('Speaker labels are not available.'), { kind: 'error' }); return false; }
    if (st.runtime && st.model.installed) return true;
    return new Promise((resolve) => {
      let busy = false;
      let ok = false;
      const body = el('div', 'cut-form cut-speech-setup cut-spk-setup');
      body.append(el('div', 'cut-dialog-note', tr('Speaker labels use the {name} model (WeSpeaker, trained on VoxCeleb). It runs entirely on this PC: the sound is never sent anywhere.', { name: st.model.name })));
      const list = el('ul', 'cut-speech-setup-list');
      if (!st.model.installed) list.appendChild(el('li', null, tr('{name} model: about {size}', { name: st.model.name, size: ui.formatBytes(st.model.bytes) })));
      if (!st.runtime) list.appendChild(el('li', null, tr('ONNX Runtime for the AI environment (shared with the other Nano Studio AI features): up to about {size}', { size: ui.formatBytes(st.runtimeBytes) })));
      body.append(list, el('div', 'cut-dialog-note', tr('Nothing is downloaded until you press Download. It is downloaded once; after that, speaker labels work offline.')));
      const bar = el('div', 'cut-speech-bar');
      const fill = el('div', 'cut-speech-fill');
      bar.appendChild(fill);
      bar.hidden = true;
      const line = el('div', 'cut-speech-status', '', { 'aria-live': 'polite' });
      const error = el('div', 'cut-speech-error', '', { role: 'alert' });
      error.hidden = true;
      body.append(bar, line, error);
      const dlg = ui.dialog({
        title: tr('Download Speaker Labels'), id: 'cutSpeakersSetup', body, width: 480,
        onClose: () => { onProgress = null; if (busy) invoke('cut:speakersCancelSetup').catch(() => {}); resolve(ok); },
        buttons: [
          { label: tr('Download'), primary: true, run: () => { if (!busy) start(); return false; } },
          { label: tr('Cancel') },
        ],
      });
      const go = dlg.el.querySelector('.dialog-buttons .primary');
      onProgress = (p) => {
        if (p.phase === 'runtime') line.textContent = p.text ? tr('Setting up the AI runtime… {line}', { line: p.text }) : tr('Setting up the AI runtime…');
        if (p.phase === 'download') {
          line.textContent = tr('Downloading {name}… {size}', { name: st.model.name, size: ui.formatBytes(p.bytes || st.model.bytes) });
          if (Number.isFinite(p.fraction)) { fill.style.width = `${(p.fraction * 100).toFixed(1)}%`; bar.dataset.progress = p.fraction.toFixed(3); }
        }
        bar.classList.toggle('indeterminate', !Number.isFinite(p.fraction));
      };
      async function start() {
        busy = true;
        go.disabled = true;
        bar.hidden = false;
        error.hidden = true;
        line.textContent = tr('Starting…');
        const r = await invoke('cut:speakersSetup').catch((err) => ({ ok: false, error: err.message }));
        busy = false;
        if (!dlg.el.isConnected) return;
        if (r?.ok) { ok = true; ui.toast(tr('{name} is ready.', { name: st.model.name })); dlg.close(); return; }
        error.textContent = setupError(r);
        error.dataset.code = r?.code || 'failed';
        error.hidden = false;
        line.textContent = '';
        go.disabled = false;
        go.textContent = tr('Try Again');
        if (r?.log) log.warn(`speakers setup: ${r.error}\n${r.log}`);
      }
    });
  }

  // ---------- embeddings, cached per media file and windows ----------
  const fnv = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  const keyOf = (m, windows) => `speakers|v1|${m.path}|${m.size}|${m.mtime}|${windows.length}|${fnv(windows.map((w) => `${w.t0.toFixed(3)},${w.t1.toFixed(3)}`).join(';'))}`;
  const embeddings = new Map(); // key -> {dim, data: Float32Array}
  async function cachedEmbeddings(key) {
    if (embeddings.has(key)) return embeddings.get(key);
    const bytes = await invoke('cut:cacheGet', key).catch(() => null);
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;
    const head = new DataView(bytes.buffer, bytes.byteOffset, 8);
    const dim = head.getUint32(0, true);
    const n = head.getUint32(4, true);
    if (!dim || bytes.length !== 8 + n * dim * 4) return null;
    const e = { dim, data: new Float32Array(bytes.slice(8).buffer) };
    embeddings.set(key, e);
    return e;
  }
  function storeEmbeddings(key, e) {
    embeddings.set(key, e);
    const bytes = new Uint8Array(8 + e.data.byteLength);
    const head = new DataView(bytes.buffer);
    head.setUint32(0, e.dim, true);
    head.setUint32(4, e.data.length / e.dim, true);
    bytes.set(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength), 8);
    return invoke('cut:cachePut', key, bytes).catch(() => {});
  }
  let requestSeq = 0;
  // The embeddings of a media file's windows (source seconds). -> {dim, data}
  async function embedMedia(app, m, windows, ctx, onPart) {
    const key = keyOf(m, windows);
    const hit = await cachedEmbeddings(key);
    if (hit) return hit;
    const a = Math.max(0, Math.min(...windows.map((w) => w.t0)) - 0.1);
    const b = Math.max(...windows.map((w) => w.t1)) + 0.1;
    const file = await ui.speech.writeSound(app, m.id, a, b, ctx, (f) => onPart(0.4 * f));
    if (!file) return null;
    const parts = [];
    let dim = 0;
    try {
      for (let k = 0; k < windows.length; k += CHUNK) {
        await ctx.step();
        const list = windows.slice(k, k + CHUNK).map((w) => {
          const offset = Math.max(0, Math.min(file.samples - 1, Math.round((w.t0 - file.start) * RATE)));
          return [offset, Math.max(1, Math.min(file.samples - offset, Math.round((w.t1 - w.t0) * RATE), 30 * RATE))];
        });
        const request = `k${++requestSeq}`;
        const stop = () => invoke('cut:speakersCancel', request).catch(() => {});
        ctx.signal.addEventListener('abort', stop, { once: true });
        let r;
        try { r = await invoke('cut:speakersEmbed', file.id, { windows: list, request }); } finally { ctx.signal.removeEventListener('abort', stop); }
        if (r?.cancelled || ctx.signal.aborted) throw cancelled();
        if (r?.error) throw Object.assign(new Error(tr('Speaker labels failed: {error}', { error: r.error })), { code: r.code || 'speakers' });
        dim = r.dim;
        parts.push(new Float32Array(r.data.slice().buffer));
        onPart(0.4 + 0.6 * Math.min(1, (k + CHUNK) / windows.length));
      }
    } finally {
      await invoke('cut:speechClose', file.id).catch(() => {});
    }
    const data = new Float32Array(windows.length * dim);
    let at = 0;
    for (const p of parts) { data.set(p, at); at += p.length; }
    const e = { dim, data };
    await storeEmbeddings(key, e);
    return e;
  }

  // ---------- the words' speakers ----------
  // The speaker id of each timeline word (from ui.speech.timelineWords), by the turns of its clip's media at the
  // source time of its middle. sp: the labels to read (the project's by default).
  function wordSpeakers(app, words, sp = labels(app)) {
    if (!sp?.list?.length || !words.length) return words.map(() => null);
    const seq = app.sequence;
    const clips = new Map((seq?.clips || []).map((c) => [c.id, c]));
    return words.map((w) => {
      const c = clips.get(w.clip);
      const media = c?.source?.media;
      const turns = media != null ? sp.turns[media] : null;
      if (!turns) return null;
      return K.at(turns, model().sourceTime(c, (w.t0 + w.t1) / 2) / T);
    });
  }
  const sequenceWords = (app) => {
    const seq = app.sequence;
    return seq ? ui.speech.timelineWords(app, seq.clips.filter((c) => ui.speech.speaks(app, seq, c))) : [];
  };
  // Caption items that name a speaker (or are on a track showing speakers) given the speaker most of their words have
  // under `sp`: the commands, so a change of labels carries to the captions in the same undo step.
  function captionUpdates(app, sp) {
    const seq = app.sequence;
    if (!seq) return [];
    const words = sequenceWords(app);
    const ids = wordSpeakers(app, words, sp);
    const out = [];
    for (const ct of seq.captions || []) {
      if (!ct.style?.speakerColor && !ct.style?.speakerName && !ct.items.some((it) => it.speaker)) continue;
      for (const it of ct.items) {
        const time = new Map();
        words.forEach((w, i) => {
          const ov = Math.min(w.t1, it.end) - Math.max(w.t0, it.start);
          if (ov > 0 && ids[i]) time.set(ids[i], (time.get(ids[i]) || 0) + ov);
        });
        const best = [...time].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
        if (best && best !== it.speaker) out.push(C.setCaption(seq.id, ct.id, it.id, { speaker: best }));
        else if (!best && it.speaker && !sp?.list?.some((s) => s.id === it.speaker)) out.push(C.setCaption(seq.id, ct.id, it.id, { speaker: null }));
      }
    }
    return out;
  }

  // ---------- Label Speakers ----------
  // The row's choice before the project has labels, for that project and sequence only: another project or sequence
  // starts at Auto, never at a count chosen for a different video.
  let chosen = { history: null, seq: null, count: 0 };
  const countOf = (app) => labels(app)?.count ?? (chosen.history === app.history && chosen.seq === app.sequence?.id ? chosen.count : 0);
  // count: 0 for Auto, else the number of speakers. -> {speakers: n} or null (declined, cancelled, failed)
  async function label(app, { count = countOf(app) } = {}) {
    const seq = app.sequence;
    const clips = seq ? seq.clips.filter((c) => ui.speech.speaks(app, seq, c)) : [];
    if (!clips.length) { ui.toast(tr('There are no clips with speech to transcribe.')); return null; }
    await ui.speech.loadCached(app);
    const untranscribed = clips.filter((c) => !ui.speech.transcriptOf(model().mediaOf(app.project, c)));
    if (untranscribed.length && !(await ui.speech.ensureReady())) return null;
    if (!(await ensureReady())) return null;
    const ids = clips.map((c) => c.id);
    const result = await ui.auto.task(app, tr('Labeling speakers…'), async (ctx) => {
      const split = untranscribed.length ? 0.5 : 0;
      if (untranscribed.length) {
        const sub = { ...ctx, progress: (f, text) => ctx.progress(split * f, text) };
        await ui.speech.transcribe(app, untranscribed, sub, null);
        app.emit('transcripts', {});
      }
      const s = app.sequence;
      const now = ids.map((id) => s.clips.find((c) => c.id === id)).filter(Boolean);
      const media = [...new Set(now.map((c) => c.source.media))].map((id) => app.project.media.find((m) => m.id === id)).filter(Boolean);
      const jobs = media.map((m) => {
        const words = (ui.speech.transcriptOf(m)?.words || []).slice().sort((x, y) => x.t0 - y.t0);
        return { m, words, windows: words.length ? K.windowsOf(words) : [] };
      }).filter((j) => j.windows.length);
      if (!jobs.length) return { none: true };
      const total = jobs.reduce((n, j) => n + j.windows.length, 0);
      let done = 0;
      const vectors = [];
      const speech = [];
      for (const j of jobs) {
        const e = await embedMedia(app, j.m, j.windows, ctx, (f) => ctx.progress(split + (1 - split) * 0.95 * ((done + f * j.windows.length) / total)));
        j.from = vectors.length;
        for (let k = 0; k < j.windows.length; k++) {
          vectors.push(e ? e.data.subarray(k * e.dim, (k + 1) * e.dim) : null);
          speech.push(j.windows[k].speech);
        }
        done += j.windows.length;
      }
      await ctx.step();
      const lab = K.cluster(vectors, speech, { count: count > 0 ? count : null });
      const turns = {};
      for (const j of jobs) {
        const wl = K.wordLabels(j.words, j.windows, lab.slice(j.from, j.from + j.windows.length));
        turns[j.m.id] = K.turnsOf(j.words, wl.map((l) => (l >= 0 ? String(l) : null)));
      }
      ctx.progress(1);
      return { turns, n: Math.max(0, ...lab) + 1 };
    });
    if (!result) return null;
    if (result.none) { ui.toast(tr('No speech was recognized.')); return { speakers: 0 }; }
    const before = labels(app);
    const newIds = Array.from({ length: result.n }, (_, k) => String(k));
    const { list, ids: idOf } = K.listFor(result.n, before, K.match(before?.turns, result.turns, newIds), K.inUse(app.project));
    const turns = Object.fromEntries(Object.entries(result.turns).map(([mid, t]) => [mid, t.map(([a, b, l]) => [a, b, idOf[Number(l)]])]));
    // speakers of other media files' labels (not in this sequence) stay in the list
    const used = new Set(list.map((s) => s.id));
    for (const [mid, t] of Object.entries(before?.turns || {})) {
      if (turns[mid]) continue;
      for (const [, , id] of t) if (!used.has(id)) { const s = before.list.find((x) => x.id === id); if (s) { list.push({ ...s }); used.add(id); } }
    }
    const next = { list, turns: { ...(before?.turns || {}), ...turns }, count: Math.max(0, Math.min(K.MAX, Math.round(count) || 0)) };
    const r = ui.exec(app, C.batch('Label Speakers', [C.setSpeakers({ list: next.list, turns, count: next.count }), ...captionUpdates(app, next)]));
    if (!r) return null;
    const found = new Set(Object.values(turns).flatMap((t) => t.map((x) => x[2]))).size;
    ui.toast(tr('Speakers labeled: {n}.', { n: found }));
    return { speakers: found };
  }

  // ---------- changes by hand ----------
  function rename(app, id) {
    const sp = labels(app);
    const s = sp?.list.find((x) => x.id === id);
    if (!s) return Promise.resolve(false);
    const input = el('input', 'cut-spk-name', undefined, { type: 'text', spellcheck: 'false', placeholder: nameOf(app, id) });
    input.value = s.name;
    input.dataset.userText = '';
    const body = el('div', 'cut-form cut-auto-form');
    body.append(ui.row(tr('Name'), input), el('div', 'cut-dialog-note', tr('Empty: "{name}". The name shows in the Transcript panel and in captions that show speakers\' names.', { name: tr('Speaker {n}', { n: sp.list.indexOf(s) + 1 }) })));
    return new Promise((resolve) => {
      let result = false;
      ui.dialog({ title: tr('Rename Speaker'), id: 'cutSpeakerRename', body, width: 400, onClose: () => resolve(result),
        buttons: [{ label: tr('OK'), primary: true, run: () => {
          const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 60);
          if (name === s.name) { result = true; return; }
          result = !!ui.exec(app, C.batch('Rename Speaker', [C.setSpeakers({ list: sp.list.map((x) => (x.id === id ? { ...x, name } : x)) })]));
        } }, { label: tr('Cancel') }] });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }
  // The words (timeline words of the Transcript panel) given to speaker `id` ('new': a new speaker), one undo step:
  // their media's turns over the source seconds the words span.
  function reassign(app, words, id) {
    const sp = labels(app);
    const seq = app.sequence;
    if (!sp || !seq || !words.length) return false;
    let list = sp.list;
    if (id === 'new') {
      const made = K.listFor(list.length + 1, sp, new Map(list.map((s, k) => [String(k), s.id])), K.inUse(app.project));
      list = made.list;
      id = made.ids[list.length - 1];
    }
    const spans = new Map(); // media -> [a, b] source seconds
    const clips = new Map(seq.clips.map((c) => [c.id, c]));
    for (const w of words) {
      const c = clips.get(w.clip);
      if (!c?.source || c.source.media == null) continue;
      const x = model().sourceTime(c, w.t0) / T;
      const y = model().sourceTime(c, Math.max(w.t0, w.t1 - 1)) / T;
      const r = spans.get(c.source.media) || [Infinity, -Infinity];
      spans.set(c.source.media, [Math.min(r[0], x, y), Math.max(r[1], x, y)]);
    }
    const turns = {};
    for (const [media, [a, b]] of spans) if (b > a) turns[media] = K.assign(sp.turns[media] || [], a, b, id);
    // a speaker no turn names any more leaves the list
    const all = { ...sp.turns, ...turns };
    const named = new Set(Object.values(all).flatMap((t) => t.map((x) => x[2])));
    list = list.filter((s) => named.has(s.id));
    const next = { list, turns: all, count: sp.count };
    return !!ui.exec(app, C.batch('Change Speaker', [C.setSpeakers({ list, turns }), ...captionUpdates(app, next)]));
  }

  // ---------- the Transcript panel's parts ----------
  const dot = (color) => {
    const d = el('span', 'cut-spk-dot');
    d.style.setProperty('--spk', color || 'var(--gray8)');
    return d;
  };
  let panel = null; // the mounted panel's {words(), segment(i), selectWords(list)}
  const indexesOf = (app, id) => wordSpeakers(app, panel?.words() || []).map((s, i) => (s === id ? i : -1)).filter((i) => i >= 0);
  function selectSpeaker(app, id) { panel?.selectWords(indexesOf(app, id)); }
  function speakerMenu(app, id, segmentStart) {
    const sp = labels(app);
    const items = [];
    if (segmentStart != null) {
      const words = () => { const all = panel?.words() || []; return (panel?.segment(segmentStart) || []).map((i) => all[i]).filter(Boolean); };
      items.push({ label: tr('Change Speaker'), submenu: [
        ...sp.list.map((s) => ({ label: nameOf(app, s.id), checked: s.id === id, run: () => reassign(app, words(), s.id) })),
        { separator: true },
        { label: tr('New Speaker'), disabled: sp.list.length >= K.MAX, run: () => reassign(app, words(), 'new') },
      ] });
    }
    items.push({ label: tr('Rename Speaker…'), run: () => rename(app, id).catch((err) => ui.report(err)) });
    items.push({ label: tr('Select Words of {name}', { name: nameOf(app, id) }), run: () => selectSpeaker(app, id) });
    return items;
  }
  // A paragraph's speaker: its name in its color; a click opens the speaker menu.
  function labelOf(app, id, segmentStart) {
    const b = el('button', 'cut-tr-speaker', undefined, { type: 'button', 'data-speaker': id });
    b.append(dot(K.colorOf(labels(app), id)), el('span', 'cut-tr-speaker-name', nameOf(app, id)));
    b.title = tr('Change Speaker, Rename Speaker…, Select Words');
    b.style.setProperty('--spk', K.colorOf(labels(app), id) || 'var(--gray8)');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); ui.menu(b, speakerMenu(app, id, segmentStart)); });
    return b;
  }
  // The row above the transcript: the speakers (click: select their words, double-click: rename), the number of
  // speakers and Label Speakers. api: {words(), segment(i), selectWords(list)} of the panel.
  function bar(app, api) {
    panel = api;
    const row = el('div', 'cut-spk-bar');
    const chips = el('div', 'cut-spk-chips');
    const options = () => [{ value: 0, label: tr('Auto') }, ...Array.from({ length: 6 }, (_, k) => ({ value: k + 1, label: k ? tr('{n} speakers', { n: k + 1 }) : tr('1 speaker') }))];
    const count = ui.select({ options: options(), value: countOf(app), cls: 'cut-spk-count', title: tr('Number of speakers'), onChange: (v) => { chosen = { history: app.history, seq: app.sequence?.id ?? null, count: Number(v) || 0 }; } });
    const run = button({ label: tr('Label Speakers'), title: tr('Tell who speaks when (on this PC); with a number, that many speakers'), cls: 'cut-spk-run', onClick: async () => {
      run.disabled = true;
      try { await label(app, { count: Number(count.value) || 0 }); } catch (err) { ui.report(err); } finally { run.disabled = false; }
    } });
    row.append(chips, count, run);
    let shown = '';
    function update(words, ids) {
      const sp = labels(app);
      if (document.activeElement !== count) count.value = String(countOf(app));
      const n = new Map();
      ids.forEach((id) => { if (id) n.set(id, (n.get(id) || 0) + 1); });
      const list = (sp?.list || []).filter((s) => n.has(s.id));
      const key = JSON.stringify([words.length > 0, list.map((s) => [s.id, nameOf(app, s.id), s.color, n.get(s.id)])]);
      row.classList.toggle('empty', !list.length);
      if (key === shown) return;
      shown = key;
      chips.replaceChildren(...(list.length ? list.map((s) => {
        const c = el('button', 'cut-spk-chip', undefined, { type: 'button', 'data-speaker': s.id });
        c.append(dot(s.color), el('span', 'cut-spk-chip-name', nameOf(app, s.id)), el('span', 'cut-spk-chip-count', String(n.get(s.id))));
        c.title = tr('{name}: {n} words. Click to select them, double-click to rename.', { name: nameOf(app, s.id), n: n.get(s.id) });
        c.addEventListener('click', () => selectSpeaker(app, s.id));
        c.addEventListener('dblclick', () => rename(app, s.id).catch((err) => ui.report(err)));
        c.addEventListener('contextmenu', (e) => { e.preventDefault(); ui.menu(e.clientX, e.clientY, speakerMenu(app, s.id, null)); });
        return c;
      }) : [el('span', 'cut-spk-none muted', words.length ? tr('No speaker labels yet.') : '')]));
    }
    return { el: row, update };
  }

  // ---------- captions ----------
  const CAPTION_MODES = [['off', 'No speakers'], ['color', 'Speaker colors'], ['name', 'Speaker names'], ['both', 'Speaker colors and names']];
  const styleOf = (mode) => ({ speakerColor: mode === 'color' || mode === 'both', speakerName: mode === 'name' || mode === 'both' });
  const modeOf = (style) => (style?.speakerColor && style?.speakerName ? 'both' : style?.speakerColor ? 'color' : style?.speakerName ? 'name' : 'off');
  // The Auto Captions dialog's choice, when the project has speaker labels: {row, value() -> style patch} or null.
  function captionField(app) {
    if (!labels(app)?.list?.length) return null;
    let mode = ide.settings.get('cut.speakers.captions', 'color');
    if (!CAPTION_MODES.some(([v]) => v === mode)) mode = 'color';
    const s = ui.select({ options: CAPTION_MODES.map(([value, label]) => ({ value, label: tr(label) })), value: mode, cls: 'cut-spk-captions', onChange: (v) => { mode = v; ide.settings.set('cut.speakers.captions', v); } });
    return { row: ui.row(tr('Speakers'), s), value: () => styleOf(mode) };
  }
  // Captions of timeline words that never hold two speakers, each with its speaker. make(words) -> items.
  function captions(app, words, make, frame = 1) {
    const ids = wordSpeakers(app, words);
    if (!ids.some(Boolean)) return make(words);
    const runs = K.runsOf(words.map((w, i) => ({ ...w, speaker: ids[i] })));
    const items = runs.flatMap((r) => make(r.words.map(({ speaker, ...w }) => w)).map((it) => (r.speaker ? { ...it, speaker: r.speaker } : it)));
    items.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < items.length; i++) if (items[i].end > items[i + 1].start) items[i].end = Math.max(items[i].start + frame, items[i + 1].start);
    return items;
  }

  ui.speakers = {
    label, ensureReady, status, rename, reassign, wordSpeakers, captions, captionField, bar, paraLabel: labelOf,
    selectSpeaker, CAPTION_MODES, styleOf, modeOf,
    // Forgets the embeddings in memory (the cache on disk stays).
    forget: () => embeddings.clear(),
  };
})();
