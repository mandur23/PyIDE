// Text AI's pure half (docs/cut-architecture.md section 9): what Nano Studio Cut sends to Claude and what it does with
// the answers, tested in Node (verify/cut-ai-core.mjs). ui-ai.js asks main (cut:aiComplete, main/cut/ai.js), shows the
// results for review and makes the edits; nothing here talks to anything.
//
// Only text is ever sent: transcript words or caption text with their times, and clip, track and marker names. Every
// answer is JSON (in a fenced block or bare, parseJson) and is checked here before anything uses it; a bad answer is
// asked again once with the reason (retryPrompt), then shown as an error.
//
// - Captions: polish (spelling, spacing, punctuation; the times never change) and translate (a new track, the same
//   times), in chunks of CHUNK captions; lines broken again with the editor's caption rules (lineBreak).
// - YouTube metadata: titles, a description, chapters (fixed in code: 0:00 first, at least 3, 10 s or more each, inside
//   the video) and tags (500 characters at most).
// - Highlights: ranges inside the sequence, within the asked lengths, not overlapping; shortsEdits fits the video of
//   the 9:16 copy.
// - Edit commands: a plan of operations from a fixed whitelist (OPS), validated strictly, described for the preview
//   and turned into Cut.commands (planCommands) to be applied as one batch.
// Times are ticks (time.js) unless a name says seconds; the prompts and Claude's answers use seconds.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).ai = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const TICKS = () => need('time').TICKS;

  const LANGS = { ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Simplified Chinese', es: 'Spanish' };
  const MODELS = ['haiku', 'sonnet', 'opus'];
  const BUDGET = 30000; // characters of transcript in one prompt
  const CHUNK = 60; // captions per polish or translate request
  const TITLE_MAX = 100; // YouTube's limits
  const DESCRIPTION_MAX = 5000;
  const TAGS_MAX = 500;
  const CHAPTER_MIN = 10;

  const chars = (s) => [...String(s)].length;
  const cut = (s, n) => (chars(s) > n ? `${[...String(s)].slice(0, n - 1).join('')}…` : String(s));
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const sec1 = (ticks) => (ticks / TICKS()).toFixed(1);
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const fail = (error) => ({ error });

  // ---- clocks ------------------------------------------------------------------------------------------------------

  // Whole seconds as YouTube writes them: 0:00, 12:34, 1:02:03.
  function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds + 1e-6));
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
  }
  // Seconds with a tenth, for the previews: 0:10.0, 1:02.5.
  function clockFine(seconds) {
    const t = Math.max(0, Math.round(seconds * 10) / 10);
    const whole = Math.floor(t + 1e-9);
    return `${clock(whole)}.${Math.round((t - whole) * 10) % 10}`;
  }

  // ---- JSON from an answer -----------------------------------------------------------------------------------------

  // The JSON value of an answer: the first fenced block that parses, else the whole text, else the text from its first
  // { or [ to the last matching bracket. -> {value} | {error}
  function parseJson(text) {
    const s = String(text ?? '').trim();
    const tries = [];
    const fence = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g;
    let m;
    while ((m = fence.exec(s))) tries.push(m[1].trim());
    tries.push(s);
    // outside the fences: from the first { or [ to the last matching bracket
    for (const t of [s, s.replace(fence, ' ')]) {
      const first = t.search(/[[{]/);
      if (first < 0) continue;
      const last = t.lastIndexOf(t[first] === '{' ? '}' : ']');
      if (last > first) tries.push(t.slice(first, last + 1));
    }
    for (const t of tries) {
      if (!t) continue;
      try { return { value: JSON.parse(t) }; } catch {}
    }
    return fail('The answer has no JSON value.');
  }
  // The prompt again with why the last answer was refused.
  function retryPrompt(prompt, answer, error) {
    return `${prompt}\n\nYour previous answer could not be used: ${error}\nYour previous answer was:\n${cut(String(answer ?? ''), 4000)}\n\nAnswer again with only the corrected JSON, in the shape asked above.`;
  }

  // ---- transcripts ---------------------------------------------------------------------------------------------------

  // Words on the timeline (ticks) -> segments {start, end, text} of about a sentence, with the caption grouping rules.
  function segmentsFromWords(words, { frame = 1 } = {}) {
    const S = need('speech');
    return S.captions(words, { frame, maxChars: 120, maxLines: 1, maxDuration: 12, pause: 0.8, linger: 0, minDuration: 0 })
      .map((c) => ({ start: c.start, end: c.end, text: oneLine(c.text) }));
  }
  const segmentsFromCaptions = (items) => items.map((it) => ({ start: it.start, end: it.end, text: oneLine(it.text) })).filter((s) => s.text);

  // Segments as prompt lines "[start-end] text" (seconds) within `budget` characters. Over it, each line is cut to
  // `lineMax` characters, then evenly spaced lines are kept (the first and the last always), the same every time.
  // -> {text, trimmed, lines (all), kept}
  function condense(segments, { budget = BUDGET, lineMax = 200 } = {}) {
    const list = segments.filter((s) => oneLine(s.text));
    const line = (s, max) => `[${sec1(s.start)}-${sec1(s.end)}] ${cut(oneLine(s.text), max)}`;
    const size = (ls) => ls.reduce((n, l) => n + l.length + 1, 0);
    const full = list.map((s) => line(s, Infinity));
    if (size(full) <= budget) return { text: full.join('\n'), trimmed: false, lines: list.length, kept: list.length };
    const short = list.map((s) => line(s, lineMax));
    let picked = short;
    for (let keep = Math.max(2, Math.floor((budget / size(short)) * short.length)); size(picked) > budget && keep >= 1; keep--) {
      const at = new Set();
      for (let k = 0; k < keep; k++) at.add(keep === 1 ? 0 : Math.round((k * (short.length - 1)) / (keep - 1)));
      picked = [...at].sort((a, b) => a - b).map((i) => short[i]);
    }
    return { text: picked.join('\n'), trimmed: true, lines: list.length, kept: picked.length };
  }

  // ---- prompts -------------------------------------------------------------------------------------------------------

  const SYSTEM = [
    'You help a person edit a video in Nano Studio Cut, a video editor.',
    'You receive text only: transcripts or captions with their times in seconds, and clip, track and marker names.',
    'Reply with one JSON value in a ```json fenced block, exactly in the shape the request asks for, and nothing else.',
    'Never invent fields, operations or times outside what the request allows.',
  ].join('\n');
  const langName = (code) => (LANGS[code] ? `${LANGS[code]} (${code})` : 'the language of the captions');

  // lines: [{i, text}]
  function polishPrompt(lines, { lang } = {}) {
    return { system: SYSTEM, prompt: [
      'Task: polish captions',
      `Language: ${langName(lang)}`,
      'Fix the spelling, the spacing between words and the punctuation of each caption. Keep its meaning, wording and language:',
      'do not translate, rephrase, shorten, merge or split captions. Keep a line break (\\n) where the caption has one.',
      'Return every caption, also those that need no change, with its number i.',
      'Answer: {"lines": [{"i": 1, "text": "the polished caption"}]}',
      'Captions (JSON):',
      JSON.stringify(lines),
    ].join('\n') };
  }
  function translatePrompt(lines, { from, to }) {
    return { system: SYSTEM, prompt: [
      'Task: translate captions',
      `From: ${langName(from)}`,
      `Target language: ${langName(to)}`,
      'Translate each caption on its own into short, natural subtitle language. Keep names and numbers. One caption out for',
      'each caption in, with the same number i, none merged or split. No line breaks: the editor breaks the lines itself.',
      'Answer: {"lines": [{"i": 1, "text": "the translated caption"}]}',
      'Captions (JSON):',
      JSON.stringify(lines),
    ].join('\n') };
  }
  // The answer's text for every caption of `lines`. -> {value: Map(i -> text)} | {error}
  function validateLines(value, lines) {
    if (!isObj(value) || !Array.isArray(value.lines)) return fail('The answer must be an object with a "lines" list.');
    const want = new Map(lines.map((l) => [l.i, l.text]));
    const out = new Map();
    for (const l of value.lines) {
      if (!isObj(l) || !Number.isInteger(l.i) || typeof l.text !== 'string') return fail('Every line needs a number "i" and a string "text".');
      if (!want.has(l.i)) return fail(`There is no caption ${l.i}.`);
      if (out.has(l.i)) return fail(`Caption ${l.i} is given twice.`);
      const text = l.text.replace(/\r\n?/g, '\n').split('\n').map((x) => x.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
      if (!text) return fail(`Caption ${l.i} is empty.`);
      if (chars(text) > 4 * chars(want.get(l.i)) + 40) return fail(`Caption ${l.i} is much longer than the original.`);
      out.set(l.i, text);
    }
    const missing = lines.filter((l) => !out.has(l.i)).map((l) => l.i);
    if (missing.length) return fail(`Captions missing from the answer: ${missing.slice(0, 10).join(', ')}.`);
    return { value: out };
  }
  const chunks = (list, size = CHUNK) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

  // seq: {name, duration (ticks)}; transcript: condense() text; markers: [{t, name, kind}].
  function metadataPrompt({ name, duration, transcript, markers = [] }) {
    const seconds = duration / TICKS();
    const short = seconds < 3 * CHAPTER_MIN;
    return { system: SYSTEM, prompt: [
      'Task: YouTube metadata',
      `Video: ${JSON.stringify(oneLine(name))}, ${clock(seconds)} long (${seconds.toFixed(1)} s).`,
      'Write everything in the language the transcript is spoken in.',
      `Give 3 to 5 title options (at most ${TITLE_MAX} characters each), a description of 2 to 4 short paragraphs (no chapter list, no hashtags),`,
      short ? 'no chapters (the video is too short for them: "chapters": []),'
        : `chapters (start times in whole seconds: the first at 0, at least 3, each at least ${CHAPTER_MIN} s long including the last, inside the video, short titles),`,
      'and 5 to 15 tags (words or short phrases, no # signs).',
      'Answer: {"titles": ["..."], "description": "...", "chapters": [{"t": 0, "title": "..."}], "tags": ["..."]}',
      markers.length ? `Markers (seconds, kind, name):\n${markers.map((m) => `${sec1(m.t)} ${m.kind} ${JSON.stringify(oneLine(m.name))}`).join('\n')}` : 'Markers: none',
      'Transcript ([start-end] seconds, text):',
      transcript || '(no words)',
    ].join('\n') };
  }
  // Chapters as YouTube needs them, whatever came back: whole seconds, inside the video, sorted, the first at 0:00, each
  // at least CHAPTER_MIN s long (the last one too). -> {chapters: [{t (s), title}], fixed: [English notes]}
  function fixChapters(list, durationSeconds, { intro = 'Intro' } = {}) {
    const fixed = [];
    let ch = (Array.isArray(list) ? list : []).filter((c) => isObj(c) && fin(c.t) && typeof c.title === 'string' && oneLine(c.title))
      .map((c) => ({ t: Math.max(0, Math.floor(c.t)), title: cut(oneLine(c.title), TITLE_MAX) }));
    if (Array.isArray(list) && ch.length < list.length) fixed.push('Chapters without a time or a title were left out.');
    const inside = ch.filter((c) => c.t < durationSeconds);
    if (inside.length < ch.length) fixed.push('Chapters past the end were left out.');
    ch = inside.sort((a, b) => a.t - b.t);
    if (ch.length && ch[0].t > 0) {
      if (ch[0].t < CHAPTER_MIN) ch[0].t = 0;
      else ch.unshift({ t: 0, title: intro });
      fixed.push('The first chapter now starts at 0:00.');
    }
    const kept = [];
    for (const c of ch) if (!kept.length || c.t - kept[kept.length - 1].t >= CHAPTER_MIN) kept.push(c);
    while (kept.length > 1 && durationSeconds - kept[kept.length - 1].t < CHAPTER_MIN) kept.pop();
    if (kept.length < ch.length) fixed.push('Chapters less than 10 seconds long were left out.');
    return { chapters: kept, fixed };
  }
  function cleanTags(list) {
    const out = [];
    const seen = new Set();
    let total = 0;
    for (const t of Array.isArray(list) ? list : []) {
      if (typeof t !== 'string') continue;
      const tag = oneLine(t.replace(/^#+/, '').replace(/[,<>]/g, ' '));
      const key = tag.toLowerCase();
      if (!tag || seen.has(key) || chars(tag) > 100) continue;
      const add = chars(tag) + (out.length ? 1 : 0);
      if (total + add > TAGS_MAX) break;
      seen.add(key);
      out.push(tag);
      total += add;
    }
    return out;
  }
  // -> {value: {titles, description, chapters: [{t (s), title}], tags, fixed}} | {error}
  function validateMetadata(value, { duration, intro } = {}) {
    if (!isObj(value)) return fail('The answer must be an object.');
    const seconds = duration / TICKS();
    const titles = (Array.isArray(value.titles) ? value.titles : []).filter((t) => typeof t === 'string' && oneLine(t)).map((t) => cut(oneLine(t), TITLE_MAX));
    if (!titles.length) return fail('"titles" must be a list of title strings.');
    if (typeof value.description !== 'string' || !value.description.trim()) return fail('"description" must be a non-empty string.');
    if (!Array.isArray(value.chapters)) return fail('"chapters" must be a list.');
    if (!Array.isArray(value.tags)) return fail('"tags" must be a list of strings.');
    const { chapters, fixed } = fixChapters(value.chapters, seconds, { intro });
    const short = seconds < 3 * CHAPTER_MIN;
    if (!short && chapters.length < 3) return fail(`YouTube needs at least 3 chapters, each at least ${CHAPTER_MIN} s long; after removing the invalid ones ${chapters.length} remain.`);
    const description = value.description.replace(/\r\n?/g, '\n').trim().slice(0, DESCRIPTION_MAX);
    return { value: { titles: [...new Set(titles)].slice(0, 5), description, chapters: short ? [] : chapters, tags: cleanTags(value.tags), fixed } };
  }
  // "0:00 Intro" lines for the description.
  const chapterText = (chapters) => chapters.map((c) => `${clock(c.t)} ${c.title}`).join('\n');

  function highlightsPrompt({ duration, transcript, count, min, max }) {
    const seconds = duration / TICKS();
    return { system: SYSTEM, prompt: [
      'Task: highlights',
      `Pick up to ${count} of the most engaging, self-contained moments of this ${seconds.toFixed(1)} s video for vertical shorts.`,
      `Each one ${min} to ${max} seconds long, inside 0 to ${seconds.toFixed(1)} s, none overlapping another, ordered by start.`,
      'Start and end where a sentence starts and ends (use the transcript times). Titles short, in the transcript\'s language.',
      'Answer: {"highlights": [{"start": 12.0, "end": 41.5, "title": "...", "reason": "..."}]}',
      'Transcript ([start-end] seconds, text):',
      transcript || '(no words)',
    ].join('\n') };
  }
  // -> {value: [{start, end, title, reason}] (ticks on frames, by start)} | {error}
  function validateHighlights(value, { duration, count, min, max, frame = 1 }) {
    if (!isObj(value) || !Array.isArray(value.highlights)) return fail('The answer must be an object with a "highlights" list.');
    const T = TICKS();
    const list = value.highlights;
    if (!list.length) return fail('The "highlights" list is empty.');
    if (list.length > count) return fail(`Give at most ${count} highlights; the answer has ${list.length}.`);
    const out = [];
    for (const [k, h] of list.entries()) {
      const n = k + 1;
      if (!isObj(h) || !fin(h.start) || !fin(h.end)) return fail(`Highlight ${n} needs numbers "start" and "end" (seconds).`);
      if (h.start < -0.5 || h.end > duration / T + 0.5) return fail(`Highlight ${n} (${h.start}-${h.end} s) is outside the video (0-${(duration / T).toFixed(1)} s).`);
      const start = Math.max(0, Math.round((Math.max(0, h.start) * T) / frame) * frame);
      const end = Math.min(Math.floor(duration / frame) * frame, Math.round((h.end * T) / frame) * frame);
      const len = (end - start) / T;
      if (!(end > start)) return fail(`Highlight ${n} ends before it starts.`);
      if (len < min - 0.5 || len > max + 0.5) return fail(`Highlight ${n} is ${len.toFixed(1)} s long; each must be ${min} to ${max} s.`);
      out.push({ start, end, title: cut(oneLine(typeof h.title === 'string' ? h.title : ''), TITLE_MAX), reason: cut(oneLine(typeof h.reason === 'string' ? h.reason : ''), 300) });
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 1; i < out.length; i++) {
      if (out[i].start < out[i - 1].end) return fail(`Highlights overlap: ${sec1(out[i - 1].start)}-${sec1(out[i - 1].end)} s and ${sec1(out[i].start)}-${sec1(out[i].end)} s.`);
    }
    return { value: out };
  }

  // ---- shorts --------------------------------------------------------------------------------------------------------

  // What is left out of [0, duration) when `keep` (sorted, not overlapping) stays: the ranges to extract, latest first.
  function complement(keep, duration) {
    const gaps = [];
    let at = 0;
    for (const [a, b] of keep) {
      if (a > at) gaps.push([at, a]);
      at = Math.max(at, b);
    }
    if (duration > at) gaps.push([at, duration]);
    return gaps.reverse();
  }
  // The commands that fit or fill the video and image clips of `seq` (now W x H) centered: each clip's scale is
  // multiplied by what the chosen mode needs over the project's own fit, its position goes to the centre.
  function shortsEdits(project, seq, { mode = 'fill' } = {}) {
    const C = need('commands');
    const M = need('model');
    const fitScale = need('compositor').fitScale;
    const out = [];
    for (const c of seq.clips) {
      if (M.trackOf(seq, c.track)?.kind !== 'video') continue;
      const m = M.mediaOf(project, c);
      const w = m?.video?.w;
      const h = m?.video?.h;
      if (!(w > 0 && h > 0)) continue;
      const k = fitScale(w, h, seq.w, seq.h, mode) / fitScale(w, h, seq.w, seq.h, project.settings?.fit);
      const mul = (v) => (Array.isArray(v) ? v.map((x) => Math.round(x * k * 1000) / 1000) : Math.round(v * k * 1000) / 1000);
      out.push(C.setClip(seq.id, c.id, { props: { scale: mul(c.props.scale), position: [0, 0] } }, { linked: false }));
      if (c.keyframes.scale?.length) out.push(C.setKeyframes(seq.id, c.id, 'scale', c.keyframes.scale.map((x) => ({ ...x, v: mul(x.v) }))));
      if (c.keyframes.position?.length) out.push(C.setKeyframes(seq.id, c.id, 'position', null));
    }
    return out;
  }

  // ---- edit commands -------------------------------------------------------------------------------------------------

  // The whitelist: op -> its fields (a leading ? marks an optional one). Nothing else is ever run.
  const OPS = {
    cut: { from: 'time', to: 'time' },
    lift: { from: 'time', to: 'time' },
    split: { at: 'time' },
    marker: { at: 'time', name: '?name', kind: '?markerKind' },
    removeMarkers: { kind: 'removeKind' },
    clipVolume: { clips: 'clips', db: 'db' },
    trackVolume: { track: 'audioTrack', db: 'db' },
    masterGain: { db: 'db' },
    removeSilence: { longerThan: 'silenceLength', threshold: '?threshold' },
  };
  const CLIP_SETS = ['all', 'selected', 'dialogue', 'music', 'effects', 'ambience'];
  const MAX_OPS = 200;
  const DOCS = [
    '{"op": "cut", "from": s, "to": s}  ripple delete a time range from every track (later material moves up)',
    '{"op": "lift", "from": s, "to": s}  clear a time range on every track and leave a gap',
    '{"op": "split", "at": s}  add an edit (cut point) on every track',
    '{"op": "marker", "at": s, "name": "...", "kind": "comment" | "chapter"}  add a sequence marker',
    '{"op": "removeMarkers", "kind": "comment" | "chapter" | "beat" | "all"}  remove the sequence markers of that kind',
    '{"op": "clipVolume", "clips": "all" | "selected" | "dialogue" | "music" | "effects" | "ambience" | ["clip id", ...], "db": n}  change audio clips\' volume by n dB (negative is quieter); the words are clip roles',
    '{"op": "trackVolume", "track": "A1", "db": n}  change an audio track\'s volume by n dB',
    '{"op": "masterGain", "db": n}  change the sequence\'s master gain by n dB',
    '{"op": "removeSilence", "longerThan": s, "threshold": dB}  ripple delete stretches quieter than threshold (default -40 dB) lasting longer than longerThan seconds',
  ];

  // A summary of the sequence for the prompt: tracks, clips (at most maxClips), markers, the selection.
  function sequenceSummary(project, seq, { selection = [], maxClips = 150 } = {}) {
    const M = need('model');
    const T = TICKS();
    const fps = seq.fps[0] / seq.fps[1];
    const lines = [
      `Sequence: ${JSON.stringify(oneLine(seq.name))}, ${clock(M.sequenceDuration(seq) / T)} long (${sec1(M.sequenceDuration(seq))} s), ${Math.round(fps * 100) / 100} fps, master gain ${seq.masterGain || 0} dB`,
      `Tracks: ${seq.tracks.map((t) => `${t.id} ${t.kind}${t.name && t.name !== t.id ? ` ${JSON.stringify(oneLine(t.name))}` : ''}${t.kind === 'audio' ? ` volume ${t.volume || 0} dB` : ''}${t.locked ? ' locked' : ''}`).join('; ')}`,
    ];
    const clips = seq.clips.slice().sort((a, b) => a.start - b.start);
    lines.push(`Clips (id track start-end seconds name role${clips.length > maxClips ? `; the first ${maxClips} of ${clips.length}` : ''}):`);
    for (const c of clips.slice(0, maxClips)) {
      const name = oneLine(c.name || M.mediaOf(project, c)?.name || c.source?.generator || '');
      lines.push(`${c.id} ${c.track} ${sec1(c.start)}-${sec1(M.clipEnd(c))} ${JSON.stringify(cut(name, 60))}${c.role ? ` ${c.role}` : ''}${M.trackOf(seq, c.track)?.kind === 'audio' ? ` ${c.props.volume || 0} dB` : ''}`);
    }
    const sel = clips.filter((c) => selection.includes(c.id)).map((c) => c.id);
    lines.push(`Selected clips: ${sel.length ? sel.join(', ') : 'none'}`);
    lines.push(seq.markers.length ? `Markers (seconds kind name):\n${seq.markers.slice(0, 200).map((m) => `${sec1(m.t)} ${m.kind} ${JSON.stringify(cut(oneLine(m.name), 60))}`).join('\n')}` : 'Markers: none');
    return lines.join('\n');
  }
  function commandPrompt({ request, summary, transcript }) {
    return { system: SYSTEM, prompt: [
      'Task: edit command',
      `Request: ${oneLine(request)}`,
      summary,
      'Transcript ([start-end] seconds, text):',
      transcript || '(no transcript)',
      '',
      'Turn the request into a plan of operations. Only these operations exist:',
      ...DOCS,
      'All times are seconds on the timeline as it is now, before any operation of the plan runs; the editor keeps them right.',
      'Use only these operations and fields. When the request needs anything else, or is unclear, answer with no operations and',
      'say why in "message", in the language of the request.',
      'Answer: {"ops": [ ... ], "message": "optional short note"}',
    ].join('\n') };
  }

  // -> {value: {ops, message}} | {error}. ctx: {duration (ticks), tracks: [{id, kind}], clips: [ids], selection: [ids]}
  function validatePlan(value, { duration, tracks = [], clips = [], selection = [] } = {}) {
    if (!isObj(value) || !Array.isArray(value.ops)) return fail('The answer must be an object with an "ops" list.');
    if (value.message !== undefined && typeof value.message !== 'string') return fail('"message" must be a string.');
    for (const k of Object.keys(value)) if (k !== 'ops' && k !== 'message') return fail(`Unknown field "${k}".`);
    if (value.ops.length > MAX_OPS) return fail(`A plan has at most ${MAX_OPS} operations.`);
    const T = TICKS();
    const end = duration / T;
    const audio = new Set(tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
    const clipIds = new Set(clips);
    const ops = [];
    for (const [k, o] of value.ops.entries()) {
      const n = `Operation ${k + 1}`;
      if (!isObj(o) || typeof o.op !== 'string') return fail(`${n} must be an object with an "op".`);
      const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
      if (!own(OPS, o.op)) return fail(`${n}: "${o.op}" is not an allowed operation.`);
      const spec = OPS[o.op];
      for (const f of Object.keys(o)) if (f !== 'op' && !own(spec, f)) return fail(`${n} (${o.op}) has an unknown field "${f}".`);
      const v = { op: o.op };
      for (const [f, type0] of Object.entries(spec)) {
        const optional = type0.startsWith('?');
        const type = type0.replace(/^\?/, '');
        const x = o[f];
        if (x === undefined || x === null) {
          if (optional) continue;
          return fail(`${n} (${o.op}) needs "${f}".`);
        }
        switch (type) {
          case 'time':
            if (!fin(x)) return fail(`${n}: "${f}" must be a number of seconds.`);
            if (x < -0.05 || x > end + 0.5) return fail(`${n}: ${f} ${x} s is outside the sequence (0-${end.toFixed(1)} s).`);
            v[f] = Math.min(end, Math.max(0, x));
            break;
          case 'db':
            if (!fin(x) || Math.abs(x) > 40) return fail(`${n}: "db" must be a number from -40 to 40.`);
            v[f] = x;
            break;
          case 'name':
            if (typeof x !== 'string') return fail(`${n}: "name" must be a string.`);
            v[f] = cut(oneLine(x), TITLE_MAX);
            break;
          case 'markerKind':
            if (x !== 'comment' && x !== 'chapter') return fail(`${n}: a marker kind is "comment" or "chapter".`);
            v[f] = x;
            break;
          case 'removeKind':
            if (!['comment', 'chapter', 'beat', 'all'].includes(x)) return fail(`${n}: "kind" is "comment", "chapter", "beat" or "all".`);
            v[f] = x;
            break;
          case 'clips':
            if (typeof x === 'string') {
              if (!CLIP_SETS.includes(x)) return fail(`${n}: "clips" is one of ${CLIP_SETS.join(', ')} or a list of clip ids.`);
              if (x === 'selected' && !selection.length) return fail(`${n}: no clips are selected.`);
            } else if (Array.isArray(x)) {
              if (!x.length || x.length > 500 || !x.every((id) => typeof id === 'string' && clipIds.has(id))) return fail(`${n}: "clips" lists clip ids that do not exist.`);
            } else return fail(`${n}: "clips" must be a word or a list of clip ids.`);
            v[f] = Array.isArray(x) ? [...new Set(x)] : x;
            break;
          case 'audioTrack':
            if (typeof x !== 'string' || !audio.has(x)) return fail(`${n}: "${x}" is not an audio track of the sequence.`);
            v[f] = x;
            break;
          case 'silenceLength':
            if (!fin(x) || x < 0.1 || x > 60) return fail(`${n}: "longerThan" must be 0.1 to 60 seconds.`);
            v[f] = x;
            break;
          case 'threshold':
            if (!fin(x) || x < -90 || x > -5) return fail(`${n}: "threshold" must be -90 to -5 dB.`);
            v[f] = x;
            break;
          default:
            return fail(`${n}: "${f}" cannot be checked.`);
        }
      }
      if ((v.op === 'cut' || v.op === 'lift') && !(v.to - v.from >= 0.01)) return fail(`${n} (${v.op}): "to" must be after "from".`);
      ops.push(v);
    }
    return { value: { ops, message: typeof value.message === 'string' ? cut(oneLine(value.message), 500) : '' } };
  }

  // The audio clips an op's "clips" names (a video clip in a list or the selection brings its linked audio); never on a
  // locked track.
  function volumeClips(seq, which, selection = []) {
    const M = need('model');
    const kind = (c) => M.trackOf(seq, c.track)?.kind;
    const ok = (c) => kind(c) === 'audio' && !M.trackOf(seq, c.track)?.locked;
    let picked;
    if (which === 'all') picked = seq.clips.filter(ok);
    else if (which === 'selected' || Array.isArray(which)) {
      const ids = new Set(which === 'selected' ? selection : which);
      const set = new Set();
      for (const c of seq.clips.filter((x) => ids.has(x.id))) {
        if (ok(c)) set.add(c);
        for (const l of M.linkedClips(seq, c)) if (ok(l)) set.add(l);
      }
      picked = [...set];
    } else picked = seq.clips.filter((c) => ok(c) && c.role === which);
    return picked.sort((a, b) => a.start - b.start);
  }
  const clampDb = (v) => Math.max(-60, Math.min(24, Math.round(v * 10) / 10));

  // The plan as edit commands for one batch. silence[k]: {ranges (ticks), tracks} measured for ops[k] (removeSilence).
  // Gains first, then markers, edits and lifts, then every ripple delete from the latest back, so all the plan's times
  // stay those of the timeline before it.
  function planCommands(ops, { seq, selection = [], silence = [] } = {}) {
    const C = need('commands');
    const M = need('model');
    const T = TICKS();
    const f = need('time').frameTicks(seq.fps);
    const tk = (s) => Math.round((s * T) / f) * f;
    const out = [];
    let master = null;
    const trackVol = new Map();
    const clipVol = new Map();
    for (const o of ops) {
      if (o.op === 'masterGain') master = (master ?? (seq.masterGain || 0)) + o.db;
      if (o.op === 'trackVolume') trackVol.set(o.track, (trackVol.get(o.track) ?? (M.trackOf(seq, o.track)?.volume || 0)) + o.db);
      if (o.op === 'clipVolume') for (const c of volumeClips(seq, o.clips, selection)) clipVol.set(c.id, (clipVol.get(c.id) || 0) + o.db);
    }
    if (master !== null) out.push(C.setSequence(seq.id, { masterGain: clampDb(master) }));
    for (const [id, v] of trackVol) out.push(C.setTrack(seq.id, id, { volume: clampDb(v) }));
    for (const [id, d] of clipVol) {
      const c = seq.clips.find((x) => x.id === id);
      out.push(C.setClip(seq.id, id, { props: { volume: clampDb((c.props.volume || 0) + d) } }, { linked: false }));
      if (c.keyframes.volume?.length) out.push(C.setKeyframes(seq.id, id, 'volume', c.keyframes.volume.map((k) => ({ ...k, v: clampDb(k.v + d) }))));
    }
    const gone = new Set();
    for (const o of ops) {
      if (o.op !== 'removeMarkers') continue;
      for (const m of seq.markers) {
        if ((o.kind === 'all' || m.kind === o.kind) && !gone.has(m.id)) { gone.add(m.id); out.push(C.removeMarker(seq.id, m.id)); }
      }
    }
    for (const o of ops) {
      if (o.op === 'marker') out.push(C.addMarker(seq.id, { t: tk(o.at), name: o.name || '', kind: o.kind || 'comment', color: o.kind === 'chapter' ? 'blue' : 'green' }));
    }
    for (const o of ops) if (o.op === 'split') out.push(C.split(seq.id, tk(o.at)));
    for (const o of ops) if (o.op === 'lift' && tk(o.to) > tk(o.from)) out.push(C.lift(seq.id, tk(o.from), tk(o.to)));
    const ripples = [];
    ops.forEach((o, k) => {
      if (o.op === 'cut') ripples.push({ a: tk(o.from), b: tk(o.to), tracks: null });
      if (o.op === 'removeSilence') for (const [a, b] of silence[k]?.ranges || []) ripples.push({ a, b, tracks: silence[k].tracks });
    });
    // whole-track cuts that overlap join; the rest go latest first
    ripples.sort((x, y) => y.a - x.a || y.b - x.b);
    for (const r of ripples) if (r.b > r.a) out.push(C.extract(seq.id, r.a, r.b, r.tracks));
    return out;
  }

  // The plan in plain sentences for the preview: [{text (English, for tr), params}].
  function describePlan(ops, { seq, selection = [], silence = [] } = {}) {
    const T = TICKS();
    const db = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`;
    const VOLUME = {
      all: 'Change the volume of every audio clip by {db} dB ({n} clips)',
      selected: 'Change the volume of the selected clips by {db} dB ({n} clips)',
      dialogue: 'Change the volume of the dialogue clips by {db} dB ({n} clips)',
      music: 'Change the volume of the music clips by {db} dB ({n} clips)',
      effects: 'Change the volume of the sound effect clips by {db} dB ({n} clips)',
      ambience: 'Change the volume of the ambience clips by {db} dB ({n} clips)',
      list: 'Change the volume of {n} clips by {db} dB',
    };
    const MARKERS = { comment: 'Remove the comment markers ({n})', chapter: 'Remove the chapter markers ({n})', beat: 'Remove the beat markers ({n})', all: 'Remove every sequence marker ({n})' };
    return ops.map((o, k) => {
      switch (o.op) {
        case 'cut': return { text: 'Cut {from} – {to} ({len} s) from every track', params: { from: clockFine(o.from), to: clockFine(o.to), len: (o.to - o.from).toFixed(1) } };
        case 'lift': return { text: 'Lift {from} – {to} from every track, leaving a gap', params: { from: clockFine(o.from), to: clockFine(o.to) } };
        case 'split': return { text: 'Add an edit at {at} on every track', params: { at: clockFine(o.at) } };
        case 'marker': return { text: o.kind === 'chapter' ? 'Add a chapter marker at {at}: {name}' : 'Add a marker at {at}: {name}', params: { at: clockFine(o.at), name: o.name || '-' } };
        case 'removeMarkers': return { text: MARKERS[o.kind], params: { n: seq.markers.filter((m) => o.kind === 'all' || m.kind === o.kind).length } };
        case 'clipVolume': return { text: VOLUME[Array.isArray(o.clips) ? 'list' : o.clips], params: { db: db(o.db), n: volumeClips(seq, o.clips, selection).length } };
        case 'trackVolume': return { text: 'Change the volume of track {track} by {db} dB', params: { track: o.track, db: db(o.db) } };
        case 'masterGain': return { text: 'Change the master gain by {db} dB', params: { db: db(o.db) } };
        case 'removeSilence': {
          const r = silence[k]?.ranges || [];
          return { text: 'Remove silences longer than {s} s quieter than {threshold} dB ({n} cuts, {time} s)',
            params: { s: o.longerThan, threshold: o.threshold ?? -40, n: r.length, time: (r.reduce((x, [a, b]) => x + b - a, 0) / T).toFixed(1) } };
        }
        default: return { text: o.op, params: {} };
      }
    });
  }

  // ---- captions: line breaks and the before/after diff ---------------------------------------------------------------

  const CJK_LANGS = new Set(['ja', 'zh']);
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const CLOSING = /^[\p{Pe}\p{Pf}\p{Po}ー〜]$/u;
  // Japanese and Chinese "words" for line breaking: a character each, a run of Latin letters or digits kept whole, a
  // closing mark (。、！」…) never at the start of a line.
  function cjkTokens(text) {
    const out = [];
    for (const piece of text.match(/[A-Za-z0-9'’.%-]+|\s+|./gu) || []) {
      if (/^\s+$/.test(piece)) { if (out.length) out[out.length - 1] += ' '; continue; }
      if (out.length && CLOSING.test(piece)) out[out.length - 1] += piece;
      else out.push(piece);
    }
    return out;
  }
  function greedy(tokens, max, sep) {
    const lines = [];
    let cur = '';
    for (const t of tokens) {
      const next = cur ? `${cur}${sep}${t}` : t;
      if (cur && chars(next.trim()) > max) { lines.push(cur.trim()); cur = t; } else cur = next;
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines;
  }
  // A caption's text broken into lines by the editor's caption rules (Cut.speech): at most two balanced lines of 18
  // characters for Korean, 16 for Japanese and Chinese (no spaces between words), 42 otherwise; longer text wraps on.
  function lineBreak(text, lang, { maxChars = 0, maxLines = 2 } = {}) {
    const S = need('speech');
    const flat = oneLine(text);
    if (!flat) return '';
    const cjk = CJK_LANGS.has(lang) || (!LANGS[lang] && CJK.test(flat) && !S.isKorean(flat));
    const max = maxChars > 0 ? maxChars : lang === 'ko' || (!LANGS[lang] && S.isKorean(flat)) ? 18 : cjk ? 16 : 42;
    const sep = cjk ? '' : ' ';
    const tokens = cjk ? cjkTokens(flat) : flat.split(' ');
    const lines = S.layout(tokens, max, maxLines, sep) || greedy(tokens, max, sep);
    return lines.map((l) => l.trim()).join('\n');
  }
  // A polished caption keeps the original's line breaks when it still fits them; otherwise it is broken again.
  function keepLines(before, after, lang) {
    const want = String(before).split('\n').length;
    const lines = String(after).split('\n');
    const max = lang === 'ko' || (!LANGS[lang] && need('speech').isKorean(after)) ? 18 : CJK_LANGS.has(lang) ? 16 : 42;
    if (lines.length === want && lines.every((l) => chars(l) <= max)) return lines.join('\n');
    return lineBreak(after, lang);
  }
  // Characters of `a` and `b` as runs kept ('='), removed ('-') and added ('+'), from their longest common subsequence.
  function diffChars(a, b) {
    const x = [...String(a)];
    const y = [...String(b)];
    if (x.length * y.length > 250000) return [...(x.length ? [{ op: '-', s: a }] : []), ...(y.length ? [{ op: '+', s: b }] : [])];
    const n = x.length;
    const m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    const push = (op, s) => { const last = out[out.length - 1]; if (last && last.op === op) last.s += s; else out.push({ op, s }); };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { push('=', x[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) push('-', x[i++]); else push('+', y[j++]);
    }
    while (i < n) push('-', x[i++]);
    while (j < m) push('+', y[j++]);
    return out;
  }

  return {
    LANGS, MODELS, BUDGET, CHUNK, OPS, CHAPTER_MIN,
    clock, clockFine, parseJson, retryPrompt,
    segmentsFromWords, segmentsFromCaptions, condense,
    polishPrompt, translatePrompt, validateLines, chunks,
    metadataPrompt, fixChapters, cleanTags, validateMetadata, chapterText,
    highlightsPrompt, validateHighlights, complement, shortsEdits,
    sequenceSummary, commandPrompt, validatePlan, volumeClips, planCommands, describePlan,
    lineBreak, keepLines, cjkTokens, diffChars,
  };
});
