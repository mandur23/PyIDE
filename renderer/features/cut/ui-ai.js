// Text AI in the editor (docs/cut-architecture.md section 10): Claude, through Claude Code on this PC (main/cut/ai.js),
// works on text only and every result is checked (Cut.ai) and reviewed before it becomes one undo step.
//
//   Polish Captions with Claude…      spelling, spacing and punctuation of a caption track (all of it, the In-Out range
//                                     or the selected caption), each changed line accepted or rejected; times unchanged
//   Translate Captions with Claude…   a new caption track in ko, en, ja, zh or es with the same times, lines broken again
//   YouTube Title, Description and Chapters…   from the transcript and the markers: titles, a description, chapters
//                                     (fixed in code for YouTube) and tags to copy; the chapters as markers on request
//   Highlights to Shorts…             N ranges picked by Claude, checked, reviewed, then a new 1080x1920 sequence of them
//   Edit Command… (Ctrl+J)            a request in plain words -> a plan of whitelisted operations, previewed, applied as
//                                     one undo step
//
// All of them are in the Automation menu; polish and translate also in the captions panel. The words come from the
// transcripts (ui-speech.js) when there are any, else from the shown caption track. Before the first request a notice
// says what is sent to Claude (Anthropic); the acknowledgement is the setting cut.ai.acknowledged. Without Claude Code
// (or signed out) a dialog explains how to install it and sign in.
(() => {
  const Cut = globalThis.Cut;
  const ui = Cut.ui;
  const AI = Cut.ai;
  const C = Cut.commands;
  const { el, button } = ui;
  const T = Cut.time.TICKS;
  const log = ide.logger('#cut');
  const invoke = (...args) => ide.api.invoke(...args);
  const model = () => Cut.model;
  const DEFAULTS = { 'cut.ai.model': 'sonnet', 'cut.ai.acknowledged': false };
  const setting = (k) => { const v = ide.settings.get(k, DEFAULTS[k]); return v === undefined || v === null ? DEFAULTS[k] : v; };
  const claudeModel = () => (AI.MODELS.includes(setting('cut.ai.model')) ? setting('cut.ai.model') : DEFAULTS['cut.ai.model']);
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });
  const LANG_LABELS = { ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese', es: 'Spanish' };
  const langOptions = () => Object.entries(LANG_LABELS).map(([value, label]) => ({ value, label: tr(label) }));
  const blurFields = (body) => { for (const n of body.querySelectorAll('input.cut-number-input')) n.blur(); };

  // main's progress: how many characters of the answer have arrived
  let onChars = null;
  ide.api.on('cut:aiProgress', (p) => onChars?.(p));

  // ---------- before a request: the notice, and Claude Code ----------
  // The first time: what goes to Claude. Resolves true once acknowledged (remembered in the settings).
  function acknowledged() {
    if (setting('cut.ai.acknowledged') === true) return Promise.resolve(true);
    return new Promise((resolve) => {
      let ok = false;
      const body = el('div', 'cut-form cut-ai-notice');
      body.append(
        el('div', 'dialog-message', tr('These features send text to Claude (Anthropic) through Claude Code on this PC: the transcript or the caption text, and clip, track and marker names with their times.')),
        el('div', 'cut-dialog-note', tr('No video, sound or file paths are sent. Claude Code uses your own Claude account.')),
      );
      ui.dialog({ title: tr('Claude'), id: 'cutAiNotice', body, width: 480, onClose: () => resolve(ok),
        buttons: [{ label: tr('Continue'), primary: true, run: () => { ok = true; ide.settings.set('cut.ai.acknowledged', true); } }, { label: tr('Cancel') }] });
    });
  }
  // Why Claude cannot answer, in plain words.
  function explain(code, detail = '') {
    const body = el('div', 'cut-form cut-ai-missing');
    body.dataset.code = code;
    if (code === 'auth') {
      body.append(
        el('div', 'dialog-message', tr('Claude Code is not signed in, or its sign-in has expired.')),
        el('div', 'cut-dialog-note', tr('Open a terminal (Windows Terminal or PowerShell), run claude, and sign in with your Claude account (type /login if it does not ask). Then try again.')),
      );
    } else if (code === 'quota') {
      body.append(
        el('div', 'dialog-message', tr('Your Claude account has reached its usage limit for now.')),
        el('div', 'cut-dialog-note', tr('The limit resets after a while (Claude Code says when). Try again later, or choose a smaller model in the settings.')),
      );
    } else {
      body.append(
        el('div', 'dialog-message', tr('Claude Code is not installed on this PC.')),
        el('div', 'cut-dialog-note', tr('These features use Claude Code, the command-line Claude app, signed in with your Claude account (Pro or Max, or an Anthropic Console account). Install it from claude.com/claude-code, run claude once in a terminal and sign in, then try again.')),
        el('div', 'cut-dialog-note', tr('Speech recognition and the other automation work without it.')),
      );
    }
    if (detail) body.appendChild(el('div', 'cut-dialog-note cut-ai-detail', detail));
    ui.dialog({ title: tr('Claude Code'), id: 'cutAiMissing', body, width: 500 });
  }
  function failed(err) {
    if (err.code === 'not-installed' || err.code === 'auth' || err.code === 'quota') { explain(err.code, err.code === 'quota' ? err.message : ''); return; }
    const text = err.code === 'timeout' ? tr('Claude did not answer in time. Try again, or ask for less at once.')
      : err.code === 'invalid' ? tr('Claude\'s answer could not be used, even when asked again: {error}', { error: err.message })
        : tr('Claude Code failed: {error}', { error: err.message });
    const body = el('div', 'cut-form cut-ai-error');
    body.dataset.code = err.code;
    body.append(el('div', 'dialog-message', text), el('div', 'cut-dialog-note', tr('Nothing was changed.')));
    ui.dialog({ title: tr('Claude'), id: 'cutAiError', body, width: 500 });
  }
  async function ready() {
    if (!(await acknowledged())) return false;
    const st = await invoke('cut:aiStatus').catch(() => null);
    if (!st?.installed) { explain('not-installed'); return false; }
    return true;
  }

  // ---------- asking ----------
  let requestSeq = 0;
  // One answer that validates, asked again once with the reason when it does not. Inside a task. -> the value; throws
  // an error with `claude` set when Claude Code fails or both answers are refused.
  async function ask(ctx, { task, system, prompt, validate, part = [0, 1], expect = 2000, label = '' }) {
    let p = prompt;
    let reason = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      await ctx.step();
      const request = `ai${++requestSeq}`;
      const stop = () => invoke('cut:aiCancel', request).catch(() => {});
      ctx.signal.addEventListener('abort', stop, { once: true });
      const show = (n) => ctx.progress(part[0] + (part[1] - part[0]) * Math.min(0.95, n / expect),
        `${label}${n ? tr('Claude is writing… {n} characters', { n }) : attempt ? tr('Asking Claude again…') : tr('Waiting for Claude…')}`);
      show(0);
      onChars = (e) => { if (e?.request === request) show(e.chars); };
      let r;
      try {
        r = await invoke('cut:aiComplete', { request, task, system, prompt: p, model: claudeModel() });
      } finally {
        ctx.signal.removeEventListener('abort', stop);
        onChars = null;
      }
      if (ctx.signal.aborted || r?.code === 'cancelled') throw cancelled();
      if (!r?.ok) throw Object.assign(new Error(r?.error || 'failed'), { code: r?.code || 'cli', claude: true });
      const parsed = AI.parseJson(r.text);
      const v = parsed.error ? parsed : validate(parsed.value);
      if (!v.error) { ctx.progress(part[1]); return v.value; }
      reason = v.error;
      log.warn(`claude ${task}: answer refused (${reason})`);
      p = AI.retryPrompt(prompt, r.text, reason);
    }
    throw Object.assign(new Error(reason), { code: 'invalid', claude: true });
  }
  // A Claude job in the automation's progress box (one at a time, Cancel). -> its result, or null (said already).
  async function job(app, title, fn) {
    if (!(await ready())) return null;
    let failure = null;
    const r = await ui.auto.task(app, title, async (ctx) => {
      try { return await fn(ctx); } catch (err) {
        if (!err?.claude) throw err;
        failure = err;
        return null;
      }
    });
    if (failure) failed(failure);
    return r;
  }

  // ---------- the words to send ----------
  // The sequence's words as segments: from the transcripts (ui-speech.js), else the shown caption track; with neither,
  // an offer to recognise the speech on this PC. -> {segments, source} | null
  async function sequenceText(app) {
    const seq = app.sequence;
    if (!seq) return null;
    const frame = Cut.time.frameTicks(seq.fps);
    const sp = ui.speech;
    const clips = sp ? sp.speechClips(app, { selected: false }) : [];
    const fromWords = () => {
      const s = app.sequence;
      const words = clips.length ? sp.timelineWords(app, clips.map((c) => s.clips.find((x) => x.id === c.id)).filter(Boolean)) : [];
      return words.length ? { segments: AI.segmentsFromWords(words, { frame }), source: 'transcript' } : null;
    };
    if (clips.length) await sp.loadCached?.(app).catch(() => false);
    const got = fromWords();
    if (got) return got;
    const track = ui.captions?.trackOf(app);
    if (track?.items.length) return { segments: AI.segmentsFromCaptions(track.items), source: 'captions' };
    if (!clips.length) { ui.toast(tr('The sequence has no words to work from: add captions, or clips with speech.')); return null; }
    const yes = await ui.confirm(tr('This needs the words of the sequence. Recognize its speech on this PC first?'), { title: tr('Claude'), ok: tr('Transcribe') });
    if (!yes || !(await sp.ensureReady())) return null;
    const r = await ui.auto.task(app, tr('Recognizing speech…'), (ctx) => sp.transcribe(app, clips, ctx));
    if (!r) return null;
    app.emit('transcripts', {});
    return fromWords() || (ui.toast(tr('No speech was recognized.')), null);
  }
  const trimmedNote = (c) => (c.trimmed ? tr('The transcript is long: an evenly shortened version ({kept} of {lines} lines) was sent.', { kept: c.kept, lines: c.lines }) : '');

  // ---------- captions: polish and translate ----------
  let lastCaption = null; // {track, id}: the caption last selected in the timeline
  const offs = [];
  function watchApp(app) {
    if (watchApp.app === app) return;
    watchApp.app = app;
    for (const off of offs.splice(0)) off();
    offs.push(app.on('captionSelection', (sel) => { lastCaption = sel || null; }), app.on('sequence', () => { lastCaption = null; }));
    // A shorts sequence that an undo took away: back to the sequence it came from.
    offs.push(app.on('project', () => {
      if (app.sequenceId && !app.sequence && shorts.has(app.sequenceId)) app.setSequence(shorts.get(app.sequenceId));
    }));
  }
  // index.js creates Cut.app in its own cutReady handler, which runs before this one
  ide.on('cutReady', async () => { await Cut.loaded; if (Cut.app) watchApp(Cut.app); });
  const inOut = (app) => (app.inOut?.in != null && app.inOut?.out != null && app.inOut.out > app.inOut.in ? [app.inOut.in, app.inOut.out] : null);
  // A track and which of its captions: the dialog's first rows.
  function captionChoice(app, { scopes = true } = {}) {
    const seq = app.sequence;
    const shown = ui.captions?.trackOf(app);
    const o = { track: shown?.id || seq.captions[0]?.id, scope: 'all' };
    const rows = [];
    if (seq.captions.length > 1) {
      rows.push(ui.row(tr('Caption track'), ui.select({ options: seq.captions.map((t) => ({ value: t.id, label: t.name })), value: o.track, cls: 'cut-ai-track', onChange: (v) => { o.track = v; } })));
    }
    if (scopes) {
      const range = inOut(app);
      const picked = lastCaption && seq.captions.find((t) => t.id === lastCaption.track)?.items.some((it) => it.id === lastCaption.id) ? lastCaption : null;
      const options = [{ value: 'all', label: tr('Every caption of the track') }];
      if (range) options.push({ value: 'range', label: tr('The captions from In to Out') });
      if (picked) options.push({ value: 'selected', label: tr('The selected caption') });
      if (range) o.scope = 'range';
      if (options.length > 1) rows.push(ui.row(tr('Captions'), ui.select({ options, value: o.scope, cls: 'cut-ai-scope', onChange: (v) => { o.scope = v; } })));
      o.items = () => {
        const t = seq.captions.find((x) => x.id === o.track);
        if (!t) return [];
        if (o.scope === 'range' && range) return t.items.filter((it) => it.start < range[1] && it.end > range[0]);
        if (o.scope === 'selected' && picked) return t.items.filter((it) => it.id === picked.id && t.id === picked.track);
        return t.items;
      };
    }
    return { o, rows };
  }
  const trackLang = (t) => (AI.LANGS[t?.lang] ? t.lang : (t?.items.some((it) => Cut.speech.isKorean(it.text)) ? 'ko' : null));

  async function polishCaptions(app) {
    watchApp(app);
    const seq = app.sequence;
    if (!seq?.captions.some((t) => t.items.length)) { ui.toast(tr('There are no captions to polish.')); return null; }
    const { o, rows } = captionChoice(app);
    const go = await new Promise((resolve) => {
      let ok = false;
      const body = el('div', 'cut-form cut-auto-form');
      body.append(el('div', 'cut-dialog-note', tr('Claude fixes spelling, spacing and punctuation; the times stay as they are. You review each change before it is applied.')), ...rows);
      ui.dialog({ title: tr('Polish Captions'), id: 'cutAiPolish', body, width: 460, onClose: () => resolve(ok),
        buttons: [{ label: tr('Polish'), primary: true, run: () => { ok = true; } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    const track = seq.captions.find((t) => t.id === o.track);
    const items = o.items();
    if (!items.length) { ui.toast(tr('There are no captions to polish.')); return null; }
    const lang = trackLang(track);
    const parts = AI.chunks(items.map((it, k) => ({ i: k + 1, text: it.text, id: it.id })));
    const result = await job(app, tr('Polishing captions with Claude…'), async (ctx) => {
      const out = new Map();
      for (const [k, part] of parts.entries()) {
        const lines = part.map(({ i, text }) => ({ i, text }));
        const q = AI.polishPrompt(lines, { lang });
        const got = await ask(ctx, { task: 'polish', ...q, validate: (v) => AI.validateLines(v, lines), part: [k / parts.length, (k + 1) / parts.length],
          expect: q.prompt.length * 0.6, label: parts.length > 1 ? `${tr('Part {i} of {n}', { i: k + 1, n: parts.length })} · ` : '' });
        for (const l of part) out.set(l.id, AI.keepLines(l.text, got.get(l.i), lang));
      }
      return out;
    });
    if (!result) return null;
    const changes = items.filter((it) => result.has(it.id) && result.get(it.id) !== it.text).map((it) => ({ id: it.id, start: it.start, before: it.text, after: result.get(it.id) }));
    if (!changes.length) { ui.toast(tr('Claude found nothing to fix.')); return { changed: 0 }; }
    return reviewPolish(app, track.id, changes);
  }
  // The before/after of each changed caption, marked character by character, accepted or rejected one by one.
  function diffView(before, after) {
    const del = el('div', 'cut-ai-before');
    const ins = el('div', 'cut-ai-after');
    for (const d of AI.diffChars(before, after)) {
      if (d.op !== '+') del.appendChild(d.op === '-' ? el('del', 'cut-ai-del', d.s) : document.createTextNode(d.s));
      if (d.op !== '-') ins.appendChild(d.op === '+' ? el('ins', 'cut-ai-ins', d.s) : document.createTextNode(d.s));
    }
    return [del, ins];
  }
  function reviewPolish(app, trackId, changes) {
    const fps = app.sequence.fps;
    const keep = new Set(changes.map((c) => c.id));
    const body = el('div', 'cut-form cut-ai-review');
    const count = el('div', 'cut-auto-summary cut-ai-count', '', { 'aria-live': 'polite' });
    const list = el('div', 'cut-ai-list cut-ai-polish-list');
    const boxes = [];
    for (const c of changes) {
      const row = el('label', 'cut-ai-row', undefined, { 'data-id': c.id });
      const box = el('input', 'cut-ai-check', undefined, { type: 'checkbox' });
      box.checked = true;
      box.addEventListener('change', () => { if (box.checked) keep.add(c.id); else keep.delete(c.id); show(); });
      boxes.push(box);
      const text = el('div', 'cut-ai-texts');
      text.append(el('span', 'cut-ai-time', Cut.time.timecode(c.start, fps)), ...diffView(c.before, c.after));
      row.append(box, text);
      list.appendChild(row);
    }
    const all = button({ label: tr('Select All'), cls: 'cut-ai-all', onClick: () => { for (const b of boxes) { b.checked = true; } changes.forEach((c) => keep.add(c.id)); show(); } });
    const none = button({ label: tr('Select None'), cls: 'cut-ai-none', onClick: () => { for (const b of boxes) { b.checked = false; } keep.clear(); show(); } });
    const bar = el('div', 'cut-ai-bar');
    bar.append(all, none, count);
    body.append(el('div', 'cut-dialog-note', tr('Uncheck the changes you do not want. The times do not change; applying is one undo step.')), bar, list);
    function show() {
      count.textContent = tr('{n} of {total} changes chosen', { n: keep.size, total: changes.length });
      count.dataset.chosen = String(keep.size);
    }
    show();
    return new Promise((resolve) => {
      let result = null;
      ui.dialog({ title: tr('Review Caption Changes'), id: 'cutAiPolishReview', body, width: 620, onClose: () => resolve(result),
        buttons: [
          { label: tr('Apply'), primary: true, run: () => {
            const seq = app.sequence;
            const items = seq.captions.find((t) => t.id === trackId)?.items || [];
            // Claude did not hear the speech: a caption's doubtful words stay doubtful
            const cmds = changes.filter((c) => keep.has(c.id) && items.some((it) => it.id === c.id))
              .map((c) => C.setCaption(seq.id, trackId, c.id, { text: c.after, doubt: items.find((it) => it.id === c.id).doubt ?? null }));
            if (!cmds.length) return;
            const r = ui.exec(app, C.batch('Polish Captions', cmds));
            if (r) { result = { changed: cmds.length }; ui.toast(tr('Captions polished: {n}.', { n: cmds.length })); }
          } },
          { label: tr('Cancel') },
        ] });
    });
  }

  async function translateCaptions(app) {
    watchApp(app);
    const seq = app.sequence;
    if (!seq?.captions.some((t) => t.items.length)) { ui.toast(tr('There are no captions to translate.')); return null; }
    const { o, rows } = captionChoice(app, { scopes: false });
    const from = trackLang(seq.captions.find((t) => t.id === o.track));
    o.to = from === 'ko' ? 'en' : 'ko';
    const go = await new Promise((resolve) => {
      let ok = false;
      const body = el('div', 'cut-form cut-auto-form');
      body.append(
        el('div', 'cut-dialog-note', tr('Claude translates every caption into a new caption track with the same times; the lines are broken again for the language.')),
        ...rows,
        ui.row(tr('Translate into'), ui.select({ options: langOptions(), value: o.to, cls: 'cut-ai-lang', onChange: (v) => { o.to = v; } })),
      );
      ui.dialog({ title: tr('Translate Captions'), id: 'cutAiTranslate', body, width: 460, onClose: () => resolve(ok),
        buttons: [{ label: tr('Translate'), primary: true, run: () => { ok = true; } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    const track = seq.captions.find((t) => t.id === o.track);
    const src = trackLang(track);
    const items = track.items.map((it, k) => ({ i: k + 1, text: it.text, it }));
    const parts = AI.chunks(items);
    const texts = await job(app, tr('Translating captions with Claude…'), async (ctx) => {
      const out = new Map();
      for (const [k, part] of parts.entries()) {
        const lines = part.map(({ i, text }) => ({ i, text }));
        const q = AI.translatePrompt(lines, { from: src, to: o.to });
        const got = await ask(ctx, { task: 'translate', ...q, validate: (v) => AI.validateLines(v, lines), part: [k / parts.length, (k + 1) / parts.length],
          expect: q.prompt.length * 0.7, label: parts.length > 1 ? `${tr('Part {i} of {n}', { i: k + 1, n: parts.length })} · ` : '' });
        for (const l of part) out.set(l.i, got.get(l.i));
      }
      return out;
    });
    if (!texts) return null;
    const s = app.sequence;
    const made = items.map(({ i, it }) => ({ start: it.start, end: it.end, text: AI.lineBreak(texts.get(i), o.to), ...(it.speaker ? { speaker: it.speaker } : {}) }));
    const name = `${track.name} (${tr(LANG_LABELS[o.to])})`;
    const r = ui.exec(app, C.batch('Translate Captions', [C.addCaptionTrack(s.id, { name, lang: o.to, style: track.style, syncLock: track.syncLock, items: made })]));
    if (!r) return null;
    ui.toast(tr('Translated captions: {n} in the track {name}.', { n: made.length, name }));
    return { count: made.length, name };
  }

  // ---------- YouTube metadata ----------
  async function youtubeMetadata(app) {
    watchApp(app);
    const seq = app.sequence;
    if (!seq) return null;
    const text = await sequenceText(app);
    if (!text) return null;
    const duration = Math.max(model().sequenceDuration(app.sequence), ...app.sequence.captions.flatMap((t) => t.items.map((it) => it.end)), 0);
    if (!duration) { ui.toast(tr('The sequence is empty.')); return null; }
    const condensed = AI.condense(text.segments);
    const q = AI.metadataPrompt({ name: app.sequence.name, duration, transcript: condensed.text, markers: app.sequence.markers });
    const intro = tr('Intro');
    const meta = await job(app, tr('Writing the YouTube description with Claude…'), (ctx) => ask(ctx, { task: 'metadata', ...q, validate: (v) => AI.validateMetadata(v, { duration, intro }), expect: 2500 }));
    if (!meta) return null;
    return showMetadata(app, meta, { duration, condensed, source: text.source });
  }
  async function copy(textOf, what) {
    try {
      await invoke('clipboard:writeText', textOf());
      ui.toast(tr('Copied: {what}.', { what }));
    } catch (err) { ui.report(err); }
  }
  function showMetadata(app, meta, { duration, condensed, source }) {
    const body = el('div', 'cut-form cut-ai-meta');
    const section = (title, ...content) => {
      const sec = el('div', 'cut-ai-section');
      sec.append(el('div', 'cut-ai-section-title', title), ...content);
      body.appendChild(sec);
      return sec;
    };
    const copyButton = (label, textOf, what, cls) => button({ label, cls: `cut-ai-copy ${cls || ''}`.trim(), onClick: () => copy(textOf, what) });
    const titles = el('div', 'cut-ai-titles');
    meta.titles.forEach((t, i) => {
      const row = el('div', 'cut-ai-title-row');
      row.append(el('span', 'cut-ai-title', t), copyButton(tr('Copy'), () => t, tr('The title'), `cut-ai-copy-title-${i}`));
      titles.appendChild(row);
    });
    section(tr('Titles'), titles);
    const desc = el('textarea', 'cut-ai-description', undefined, { rows: 7, spellcheck: 'false' });
    desc.value = meta.description;
    const chapters = AI.chapterText(meta.chapters);
    const descBar = el('div', 'cut-ai-bar');
    descBar.append(copyButton(tr('Copy'), () => desc.value, tr('The description'), 'cut-ai-copy-description'),
      copyButton(tr('Copy with Chapters'), () => (chapters ? `${desc.value.trim()}\n\n${chapters}` : desc.value), tr('The description'), 'cut-ai-copy-all'));
    section(tr('Description'), desc, descBar);
    const chapterList = el('pre', 'cut-ai-chapters', chapters || tr('No chapters: YouTube needs a video of at least 30 seconds for three chapters of 10 seconds.'));
    const chapterBar = el('div', 'cut-ai-bar');
    const notes = el('div', 'cut-dialog-note cut-ai-fixed', meta.fixed.length ? tr('Fixed for YouTube: {notes}', { notes: meta.fixed.map((n) => tr(n)).join(' ') }) : '');
    if (meta.chapters.length) {
      chapterBar.append(copyButton(tr('Copy'), () => chapters, tr('The chapters'), 'cut-ai-copy-chapters'),
        button({ label: tr('Add as Chapter Markers'), title: tr('Replaces the sequence\'s chapter markers (one undo step)'), cls: 'cut-ai-add-chapters', onClick: () => addChapters(app, meta.chapters) }));
    }
    section(tr('Chapters'), chapterList, notes, chapterBar);
    const tags = meta.tags.join(', ');
    const tagBar = el('div', 'cut-ai-bar');
    tagBar.append(el('span', 'cut-ai-tags', tags || '-'), copyButton(tr('Copy'), () => tags, tr('The tags'), 'cut-ai-copy-tags'));
    section(tr('Tags'), tagBar);
    const from = source === 'transcript' ? tr('Made from the transcript and the markers.') : tr('Made from the captions and the markers.');
    body.appendChild(el('div', 'cut-dialog-note cut-ai-source', [from, trimmedNote(condensed)].filter(Boolean).join(' ')));
    body.dataset.duration = String(duration / T);
    return new Promise((resolve) => {
      ui.dialog({ title: tr('YouTube Title, Description and Chapters'), id: 'cutAiMetadata', body, width: 640, onClose: () => resolve(meta), buttons: [{ label: tr('Close'), primary: true }] });
    });
  }
  function addChapters(app, chapters) {
    const seq = app.sequence;
    const f = Cut.time.frameTicks(seq.fps);
    const cmds = [
      ...seq.markers.filter((m) => m.kind === 'chapter').map((m) => C.removeMarker(seq.id, m.id)),
      ...chapters.map((c) => C.addMarker(seq.id, { t: Math.round((c.t * T) / f) * f, name: c.title, kind: 'chapter', color: 'blue' })),
    ];
    const r = ui.exec(app, C.batch('Add Chapter Markers', cmds));
    if (r) ui.toast(tr('Chapter markers added: {n}.', { n: chapters.length }));
    return r;
  }

  // ---------- highlights to shorts ----------
  const shorts = new Map(); // shorts sequence id -> the sequence it came from
  async function highlights(app) {
    watchApp(app);
    const seq = app.sequence;
    if (!seq || !seq.clips.length) { ui.toast(tr('The sequence is empty.')); return null; }
    const o = { count: 3, min: 15, max: 60, ...(ide.settings.get('cut.ai.highlights', null) || {}) };
    const go = await new Promise((resolve) => {
      let ok = false;
      const field = (key, opts) => ui.numberField({ value: o[key], ...opts, onChange: (v) => { o[key] = v; } });
      const body = el('div', 'cut-form cut-auto-form');
      body.append(
        el('div', 'cut-dialog-note', tr('Claude picks the best moments from the transcript. You review them, then they become a new 9:16 sequence (1080x1920).')),
        ui.row(tr('Number of highlights'), field('count', { min: 1, max: 10, step: 1, precision: 0, cls: 'cut-ai-count-field' })),
        ui.row(tr('Shortest'), field('min', { min: 3, max: 170, step: 1, precision: 0, unit: 's', cls: 'cut-ai-min' })),
        ui.row(tr('Longest'), field('max', { min: 5, max: 180, step: 1, precision: 0, unit: 's', cls: 'cut-ai-max' })),
      );
      ui.dialog({ title: tr('Highlights to Shorts'), id: 'cutAiHighlights', body, width: 460, onClose: () => resolve(ok),
        buttons: [{ label: tr('Find Highlights'), primary: true, run: () => {
          blurFields(body);
          if (o.max <= o.min) { ui.toast(tr('The longest must be longer than the shortest.')); return false; }
          ok = true;
          ide.settings.set('cut.ai.highlights', { count: o.count, min: o.min, max: o.max });
          return undefined;
        } }, { label: tr('Cancel') }] });
    });
    if (!go) return null;
    const text = await sequenceText(app);
    if (!text) return null;
    const s = app.sequence;
    const duration = model().sequenceDuration(s);
    const frame = Cut.time.frameTicks(s.fps);
    const condensed = AI.condense(text.segments);
    const q = AI.highlightsPrompt({ duration, transcript: condensed.text, count: o.count, min: o.min, max: o.max });
    const ranges = await job(app, tr('Finding highlights with Claude…'), (ctx) => ask(ctx, { task: 'highlights', ...q,
      validate: (v) => AI.validateHighlights(v, { duration, count: o.count, min: o.min, max: o.max, frame }), expect: 200 * o.count }));
    if (!ranges) return null;
    return reviewHighlights(app, ranges, condensed);
  }
  function reviewHighlights(app, ranges, condensed) {
    const fps = app.sequence.fps;
    const keep = new Set(ranges.map((_, i) => i));
    const o = { mode: ide.settings.get('cut.ai.shortsFit', 'fill') === 'fit' ? 'fit' : 'fill' };
    const body = el('div', 'cut-form cut-ai-review');
    const list = el('div', 'cut-ai-list cut-ai-highlight-list');
    const count = el('div', 'cut-auto-summary cut-ai-count', '', { 'aria-live': 'polite' });
    ranges.forEach((h, i) => {
      const row = el('label', 'cut-ai-row', undefined, { 'data-i': String(i) });
      const box = el('input', 'cut-ai-check', undefined, { type: 'checkbox' });
      box.checked = true;
      box.addEventListener('change', () => { if (box.checked) keep.add(i); else keep.delete(i); show(); });
      const texts = el('div', 'cut-ai-texts');
      texts.append(
        el('div', 'cut-ai-range', `${Cut.time.timecode(h.start, fps)} – ${Cut.time.timecode(h.end, fps)} · ${tr('{n} s', { n: ((h.end - h.start) / T).toFixed(1) })}`),
        el('div', 'cut-ai-title', h.title || tr('Highlight {n}', { n: i + 1 })),
      );
      if (h.reason) texts.appendChild(el('div', 'cut-ai-reason', h.reason));
      row.append(box, texts);
      list.appendChild(row);
    });
    const fit = ui.select({ options: [{ value: 'fill', label: tr('Fill the frame (crops the sides)') }, { value: 'fit', label: tr('Fit inside the frame (bars above and below)') }], value: o.mode, cls: 'cut-ai-fit', onChange: (v) => { o.mode = v; } });
    body.append(el('div', 'cut-dialog-note', tr('The chosen ranges go into a new 1080x1920 sequence in time order, with the captions. One undo step.')), list, ui.row(tr('Video'), fit), count);
    const note = trimmedNote(condensed);
    if (note) body.appendChild(el('div', 'cut-dialog-note', note));
    function show() {
      const total = ranges.filter((_, i) => keep.has(i)).reduce((n, h) => n + h.end - h.start, 0);
      count.textContent = tr('{n} highlights, {time} s', { n: keep.size, time: (total / T).toFixed(1) });
      count.dataset.chosen = String(keep.size);
    }
    show();
    return new Promise((resolve) => {
      let result = null;
      ui.dialog({ title: tr('Review Highlights'), id: 'cutAiHighlightsReview', body, width: 560, onClose: () => resolve(result),
        buttons: [
          { label: tr('Create Shorts Sequence'), primary: true, run: () => {
            const chosen = ranges.filter((_, i) => keep.has(i));
            if (!chosen.length) { ui.toast(tr('Choose at least one highlight.')); return false; }
            ide.settings.set('cut.ai.shortsFit', o.mode);
            result = createShorts(app, chosen, o.mode);
            return undefined;
          } },
          { label: tr('Cancel') },
        ] });
    });
  }
  // A copy of the sequence at 1080x1920 that keeps only the ranges (in time order), its video fitted or filling the
  // frame, centered; captions and markers follow the cuts. One undo step. -> {id, ranges} or null.
  function createShorts(app, ranges, mode) {
    const src = app.sequence;
    const keepRanges = ranges.map((h) => [h.start, h.end]).sort((a, b) => a[0] - b[0]);
    const h = app.history;
    let id = null;
    h.begin('Create Shorts Sequence');
    try {
      id = h.do(C.addSequence({ from: src.id, name: tr('{name} Shorts', { name: src.name }) })).id;
      const seqOf = () => app.project.sequences.find((s) => s.id === id);
      for (const t of seqOf().tracks) if (t.locked) h.do(C.setTrack(id, t.id, { locked: false }));
      for (const ct of seqOf().captions) if (!ct.syncLock) h.do(C.setCaptionTrack(id, ct.id, { syncLock: true }));
      h.do(C.setSequence(id, { w: 1080, h: 1920 }));
      const s = seqOf();
      const end = Math.max(model().sequenceDuration(s), ...s.captions.flatMap((t) => t.items.map((it) => it.end)), ...s.markers.map((m) => m.t + m.duration), 0);
      for (const [a, b] of AI.complement(keepRanges, end)) h.do(C.extract(id, a, b));
      for (const cmd of AI.shortsEdits(app.project, seqOf(), { mode })) h.do(cmd);
      h.commit();
    } catch (err) {
      h.cancel();
      ui.report(err);
      return null;
    }
    shorts.set(id, src.id);
    app.setSequence(id);
    ui.toast(tr('Shorts sequence created: {n} highlights.', { n: keepRanges.length }));
    return { id, ranges: keepRanges };
  }

  // ---------- edit commands ----------
  function planContext(app) {
    const seq = app.sequence;
    return { duration: model().sequenceDuration(seq), tracks: seq.tracks.map((t) => ({ id: t.id, kind: t.kind })), clips: seq.clips.map((c) => c.id),
      selection: [...app.selection].filter((id) => seq.clips.some((c) => c.id === id)) };
  }
  let lastRequest = '';
  async function editCommand(app) {
    watchApp(app);
    const seq = app.sequence;
    if (!seq || !seq.clips.length) { ui.toast(tr('The sequence is empty.')); return null; }
    const request = await new Promise((resolve) => {
      let value = null;
      const input = el('input', 'cut-ai-command-input', undefined, { type: 'text', spellcheck: 'false', placeholder: tr('e.g. cut the first 10 seconds') });
      input.value = lastRequest;
      const body = el('div', 'cut-form cut-ai-command');
      body.append(
        input,
        el('div', 'cut-dialog-note', tr('Say what to change, for example: remove all silences longer than 1 s · add a chapter marker at every topic · make the music 6 dB quieter · cut the first 10 seconds.')),
        el('div', 'cut-dialog-note', tr('Claude answers with a plan of simple edits (cut, lift, add edit, markers, volume, silence removal). You see the plan before anything changes.')),
      );
      ui.dialog({ title: tr('Edit Command'), id: 'cutAiCommand', body, width: 560, onClose: () => resolve(value),
        buttons: [{ label: tr('Ask Claude'), primary: true, run: () => {
          const v = input.value.trim();
          if (!v) return false;
          value = v;
          return undefined;
        } }, { label: tr('Cancel') }] });
      input.focus();
    });
    if (!request) return null;
    lastRequest = request;
    const s = app.sequence;
    const ctx0 = planContext(app);
    const frame = Cut.time.frameTicks(s.fps);
    // the transcript helps with "every chapter", "where they talk about…"; without one the plan works from the clips
    let transcript = '';
    let condensed = null;
    if (ui.speech) {
      const clips = ui.speech.speechClips(app, { selected: false });
      if (clips.length) {
        await ui.speech.loadCached?.(app).catch(() => false);
        const words = ui.speech.timelineWords(app, clips);
        if (words.length) condensed = AI.condense(AI.segmentsFromWords(words, { frame }), { budget: 12000 });
      }
    }
    if (!condensed) {
      const track = ui.captions?.trackOf(app);
      if (track?.items.length) condensed = AI.condense(AI.segmentsFromCaptions(track.items), { budget: 12000 });
    }
    if (condensed) transcript = condensed.text;
    const q = AI.commandPrompt({ request, summary: AI.sequenceSummary(app.project, s, { selection: ctx0.selection }), transcript });
    const plan = await job(app, tr('Planning the edit with Claude…'), (ctx) => ask(ctx, { task: 'command', ...q, validate: (v) => AI.validatePlan(v, ctx0), expect: 600 }));
    if (!plan) return null;
    if (!plan.ops.length) {
      const body = el('div', 'cut-form cut-ai-plan-empty');
      body.append(el('div', 'dialog-message', tr('Claude did not plan any edits for this request.')));
      if (plan.message) body.appendChild(el('div', 'cut-dialog-note cut-ai-message', plan.message));
      ui.dialog({ title: tr('Edit Command'), id: 'cutAiPlan', body, width: 500 });
      return { ops: [] };
    }
    // silence is measured here, on this PC, for each removeSilence of the plan
    const silence = [];
    for (const [k, op] of plan.ops.entries()) {
      if (op.op !== 'removeSilence') continue;
      const r = await ui.auto.silencePlan(app, { threshold: op.threshold ?? -40, minLength: op.longerThan, margin: 0.1 });
      if (!r) return null;
      silence[k] = r;
    }
    return previewPlan(app, request, plan, silence, condensed);
  }
  function previewPlan(app, request, plan, silence, condensed) {
    const seq = app.sequence;
    const selection = planContext(app).selection;
    const lines = AI.describePlan(plan.ops, { seq, selection, silence });
    const body = el('div', 'cut-form cut-ai-plan');
    body.appendChild(el('div', 'cut-ai-request', request));
    const list = el('ol', 'cut-ai-steps');
    for (const l of lines) list.appendChild(el('li', 'cut-ai-step', tr(l.text, l.params)));
    body.appendChild(list);
    if (plan.message) body.appendChild(el('div', 'cut-dialog-note cut-ai-message', plan.message));
    body.appendChild(el('div', 'cut-dialog-note', tr('Times are those of the timeline before the plan. Apply makes it one undo step.')));
    const note = condensed ? trimmedNote(condensed) : '';
    if (note) body.appendChild(el('div', 'cut-dialog-note', note));
    // the time the plan takes out, drawn on the timeline as Remove Silence draws it
    const f = Cut.time.frameTicks(seq.fps);
    const cuts = plan.ops.filter((o) => o.op === 'cut').map((o) => [Math.round((o.from * T) / f) * f, Math.round((o.to * T) / f) * f]);
    const quiet = silence.filter(Boolean);
    const gone = Cut.analyze.union([...cuts, ...quiet.flatMap((r) => r.ranges)]);
    if (gone.length) ui.timeline.setOverlay?.({ ranges: gone, tracks: cuts.length ? seq.tracks.filter((t) => !t.locked).map((t) => t.id) : [...new Set(quiet.flatMap((r) => r.changed || r.tracks))] });
    return new Promise((resolve) => {
      let result = null;
      ui.dialog({ title: tr('Edit Plan'), id: 'cutAiPlan', body, width: 560, onClose: () => { if (gone.length) ui.timeline.setOverlay?.(null); resolve(result); },
        buttons: [
          { label: tr('Apply'), primary: true, run: () => {
            // checked again against the sequence as it is now
            const again = AI.validatePlan(plan, planContext(app));
            if (again.error) { failed(Object.assign(new Error(again.error), { code: 'invalid' })); return; }
            const s = app.sequence;
            const cmds = AI.planCommands(again.value.ops, { seq: s, selection: planContext(app).selection, silence });
            if (!cmds.length) { ui.toast(tr('The plan changes nothing.')); return; }
            const r = ui.exec(app, C.batch('Edit Command', cmds));
            if (r) { result = { ops: plan.ops.length, commands: cmds.length }; app.select([]); ui.toast(tr('Edit applied: {n} steps.', { n: plan.ops.length })); }
          } },
          { label: tr('Cancel') },
        ] });
    });
  }

  // ---------- the settings page's section (ui-settings.js) ----------
  function settingsSection(host, ctx) {
    const sec = ctx.ui.section(host, tr('Claude (Text AI)'));
    sec.appendChild(ctx.ui.fieldRow(tr('Model:'), ctx.ui.selectInput('cut.ai.model', [['haiku', tr('Claude Haiku (fastest)')], ['sonnet', tr('Claude Sonnet')], ['opus', tr('Claude Opus (most capable, slowest)')]], DEFAULTS['cut.ai.model'])));
    sec.appendChild(ctx.ui.checkbox('cut.ai.acknowledged', tr('I know these features send text to Claude (Anthropic); do not show the notice')));
    const state = el('div', 'muted settings-note cut-ai-state', tr('Looking for Claude Code…'));
    sec.appendChild(state);
    sec.appendChild(el('div', 'muted settings-note', tr('Caption polish and translation, YouTube titles and chapters, highlights to shorts and edit commands send the transcript or caption text and clip and marker names to Claude through Claude Code. No video, sound or file paths are sent.')));
    invoke('cut:aiStatus').then((st) => {
      state.textContent = st?.installed ? tr('Claude Code is installed.') : tr('Claude Code is not installed: install it from claude.com/claude-code and sign in.');
      state.dataset.installed = String(!!st?.installed);
    }).catch(() => {});
  }

  ui.ai = { polishCaptions, translateCaptions, youtubeMetadata, highlights, editCommand, createShorts, addChapters, settingsSection, explain, model: claudeModel, defaults: DEFAULTS };
})();
