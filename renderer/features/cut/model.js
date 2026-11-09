// The project model of Nano Studio Cut (docs/cut-architecture.md section 6): the shape of a .ncut project, factories
// for its parts, validate() that every edit command must leave true, migrate() for files of older versions, and the
// time questions every module asks (how long a clip is, which clips are under t, which source time a timeline time
// shows). All times are ticks (time.js); a clip's keyframe and marker times count from the clip's start.
//
// Ids: media, bins, sequences, clips, transitions, markers, caption tracks and caption items share one id space per
// project (newId: prefix + project.nextId). Track ids (V1, A2...) are unique within their sequence, effect and text
// layer ids within their clip. A link id is shared by the clips that move and cut together; a link has two or more
// clips of one sequence.
//
// Still clips (an image, a generator, a freeze frame: source.freeze) show the same picture whatever the time, so
// trimming them only moves `out` and they can be any length. A freeze frame shows the frame at source time `in`.
//
// A nest clip (`source: { sequence }`, Premiere's nested sequence) shows and plays another sequence of the project:
// its in/out are times of that sequence, read through sourceTime like a media file's. Its source runs to the end of
// that sequence, which may get shorter after the clip was cut (the clip then shows nothing past it). No sequence
// nests itself, through any number of others.
//
// A remapped video clip (`remap`, Premiere's Time Remapping > Speed; remap.js) plays a speed curve: its length is the
// curve's `duration`, the source time at t is the curve's integral, and in/out are the lowest and highest source time
// the curve reaches over the clip (kept by the commands), so every source clamp and range still holds. Its `speed`
// is 1 and `reverse` false: the curve has both. `sampling` is Premiere's Time Interpolation: 'sample' shows the
// nearest frame, 'blend' mixes the two source frames around the time (Frame Blending).
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).model = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;
  const captionwords = () => (NODE ? require('./captionwords.js') : globalThis.Cut.captionwords);
  const lumetri = () => (NODE ? require('./lumetri.js') : globalThis.Cut.lumetri);
  const R = NODE ? require('./remap.js') : globalThis.Cut.remap;
  // Read when a clip has masks, so a page that loads model.js without masks.js still works.
  const masks = () => (NODE ? require('./masks.js') : globalThis.Cut.masks);

  // 2: nest clips (source.sequence). 3: time remapping (clip.remap) and frame sampling (clip.sampling). 4: masks
  // (clip.masks, effect.masks). An app that reads an older version would call such a project damaged, or play a
  // remapped clip at its old speed, or draw a masked clip whole; it says "newer" instead.
  const VERSION = 4;
  const SAMPLINGS = ['sample', 'blend'];
  const EASES = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut', 'bezier'];
  const GENERATORS = ['text', 'solid', 'adjustment'];
  const VIDEO_PROPS = ['position', 'scale', 'rotation', 'anchor', 'opacity', 'crop'];
  const AUDIO_PROPS = ['volume', 'pan'];
  const PROP_SHAPE = { position: 2, scale: 2, anchor: 2, crop: 4, rotation: 0, opacity: 0, volume: 0, pan: 0 };
  // 'beat' markers come from beat detection (ui-auto.js): drawn small, never chapters.
  const MARKER_KINDS = ['comment', 'chapter', 'beat'];
  // What a clip's sound is, for the automation (ducking lowers 'music' under 'dialogue'); null when not said.
  const ROLES = ['dialogue', 'music', 'effects', 'ambience'];
  const ALIGNS = ['center', 'start', 'end'];
  const ID_RE = /^([A-Za-z]+)(\d+)$/;

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  // A project's revision: a history (commands.js) counts every change of its project here. A symbol, so JSON (saving,
  // clone) leaves it out; a project no history edits has none. Caches of what a project holds key on it.
  const REVISION = Symbol.for('cut.revision');
  const revisionOf = (project) => (project && typeof project[REVISION] === 'number' ? project[REVISION] : null);

  function newId(project, prefix) {
    const id = `${prefix}${project.nextId}`;
    project.nextId += 1;
    return id;
  }

  function defaultSettings() {
    return {
      fit: 'fit', // clips of another size: 'fit' | 'fill' | 'original'
      stillDuration: 5 * time.TICKS,
      transitionDuration: time.TICKS,
      freezeDuration: 2 * time.TICKS,
    };
  }

  function createTrack(kind, id, opts = {}) {
    const base = { id, kind, name: opts.name ?? id, locked: false, syncLock: true, height: kind === 'video' ? 56 : 48 };
    return kind === 'video'
      ? { ...base, visible: true, ...opts, id, kind }
      : { ...base, mute: false, solo: false, volume: 0, pan: 0, ...opts, id, kind };
  }

  function createSequence(opts = {}) {
    const video = opts.videoTracks ?? 2;
    const audio = opts.audioTracks ?? 2;
    const tracks = [];
    for (let i = 1; i <= video; i++) tracks.push(createTrack('video', `V${i}`));
    for (let i = 1; i <= audio; i++) tracks.push(createTrack('audio', `A${i}`));
    return {
      id: opts.id ?? 's1',
      name: opts.name ?? 'Sequence 1',
      w: opts.w ?? 1920,
      h: opts.h ?? 1080,
      fps: opts.fps ? [opts.fps[0], opts.fps[1]] : [30, 1],
      rate: 48000,
      background: opts.background ?? '#000000',
      masterGain: opts.masterGain ?? 0, // dB on the mix, set by Match loudness
      tracks,
      clips: [],
      transitions: [],
      markers: [],
      captions: [],
    };
  }

  function createProject(opts = {}) {
    const project = { format: 'ncut', version: VERSION, settings: { ...defaultSettings(), ...(opts.settings || {}) }, media: [], bins: [], sequences: [], nextId: 1 };
    if (opts.sequence !== false) project.sequences.push(createSequence({ ...(opts.sequence || {}), id: newId(project, 's') }));
    return project;
  }

  function videoProps() {
    return { position: [0, 0], scale: [100, 100], rotation: 0, anchor: [0, 0], opacity: 100, crop: [0, 0, 0, 0] };
  }
  function audioProps() {
    return { volume: 0, pan: 0 };
  }

  function createTextLayer(opts = {}) {
    return {
      id: 'l1', text: 'Text', font: 'Malgun Gothic', size: 96, weight: 700, italic: false, tracking: 0, leading: 1.2,
      align: 'center', fill: '#ffffff', stroke: null, shadow: null, box: null, position: [0, 0], ...clone(opts),
    };
  }

  // `size` is in pixels of a picture whose shorter side is `ref` (1080) lines: captions keep their look at 720p, 4K and
  // 9:16. Tracks saved before `ref` existed held sequence pixels; migrate() converts them. `highlight` lights the word
  // being spoken (captions with word timings only) in `highlightColor`, as its text color or as a box behind it
  // (`highlightMode`: captionwords.MODES).
  function defaultCaptionStyle() {
    return {
      font: 'Malgun Gothic', size: 54, weight: 600, color: '#ffffff', background: '#00000099', position: 'bottom', margin: 8, ref: 1080,
      highlight: false, highlightColor: '#ffd23f', highlightMode: 'color',
    };
  }

  // A clip with every field; `kind` is the kind of the track it goes on.
  function createClip(kind, opts = {}) {
    return {
      id: opts.id, track: opts.track, start: opts.start ?? 0, in: opts.in ?? 0, out: opts.out ?? 0,
      source: clone(opts.source), speed: 1, reverse: false, enabled: true, link: null, group: null,
      name: opts.name ?? '', label: null, role: null, props: kind === 'audio' ? audioProps() : videoProps(),
      keyframes: {}, effects: [], fadeIn: 0, fadeOut: 0, remap: null, sampling: 'sample',
    };
  }

  const isGenerator = (clip) => !!clip.source && typeof clip.source.generator === 'string';
  const mediaOf = (project, clip) => (clip.source && clip.source.media != null ? project.media.find((m) => m.id === clip.source.media) || null : null);
  const isNest = (clip) => !!clip.source && typeof clip.source.sequence === 'string';
  // The sequence a nest clip shows, or null.
  const nestOf = (project, clip) => (isNest(clip) ? project.sequences.find((s) => s.id === clip.source.sequence) || null : null);
  // A clip whose picture does not change with time; its in/out bound nothing.
  function isStill(project, clip) {
    if (isGenerator(clip) || clip.source?.freeze) return true;
    const m = mediaOf(project, clip);
    return !!m && m.kind === 'image';
  }

  // (out - in) / speed, rounded to QUANTUM, the largest tick count every offered frame length is a multiple of
  // (8.3 microseconds). At speeds other than 1, in/out are not whole ticks and the division carries float error that
  // grows with the source time (about a tick at an hour and 25%); the rounding absorbs it so durations stay on frames.
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const QUANTUM = time.FRAME_RATES.map(time.frameTicks).reduce(gcd);
  const clipDuration = (clip) => (clip.remap ? clip.remap.duration : Math.round((clip.out - clip.in) / clip.speed / QUANTUM) * QUANTUM);
  const clipEnd = (clip) => clip.start + clipDuration(clip);

  function sequenceDuration(seq) {
    let end = 0;
    for (const c of seq.clips) end = Math.max(end, clipEnd(c));
    return end;
  }

  // How much source a clip's in/out may span: the media's duration, or for a nest clip its sequence's duration (never
  // less than what the clip already shows, since that sequence may have got shorter).
  function sourceLength(project, clip) {
    if (isNest(clip)) {
      const inner = nestOf(project, clip);
      return Math.max(inner ? sequenceDuration(inner) : 0, clip.out);
    }
    return mediaOf(project, clip)?.duration ?? 0;
  }
  // The ids of the sequences a sequence's nest clips show (directly).
  function nestedIds(seq) {
    const out = new Set();
    for (const c of seq?.clips || []) if (isNest(c)) out.add(c.source.sequence);
    return out;
  }
  // Whether sequence `fromId` shows sequence `toId`, itself or through nest clips any levels down.
  function reaches(project, fromId, toId) {
    const seen = new Set();
    const walk = (id) => {
      if (id === toId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const seq = project.sequences.find((s) => s.id === id);
      for (const next of nestedIds(seq)) if (walk(next)) return true;
      return false;
    };
    return walk(fromId);
  }
  // Whether a nest clip of `innerId` placed in `outerId` would make a sequence show itself.
  const nestLoop = (project, outerId, innerId) => reaches(project, innerId, outerId);
  // Where a sequence is nested: [{ seq, clips }] of the other sequences whose nest clips show it.
  function nestUses(project, seqId) {
    const out = [];
    for (const seq of project.sequences) {
      const clips = seq.clips.filter((c) => isNest(c) && c.source.sequence === seqId);
      if (clips.length) out.push({ seq, clips });
    }
    return out;
  }
  // What a nest clip of a sequence has: a picture (a clip on a video track) and sound (one on an audio track).
  function nestKinds(project, seqId) {
    const seq = project.sequences.find((s) => s.id === seqId);
    const kinds = new Map((seq?.tracks || []).map((t) => [t.id, t.kind]));
    const has = (k) => !!seq && seq.clips.some((c) => kinds.get(c.track) === k);
    return { video: has('video'), audio: has('audio') };
  }

  const trackOf = (seq, id) => seq.tracks.find((t) => t.id === id) || null;
  // The track's position among the tracks of its kind: V1 is 0, V2 is 1; A1 is 0.
  function trackIndex(seq, id) {
    const track = trackOf(seq, id);
    if (!track) return -1;
    return seq.tracks.filter((t) => t.kind === track.kind).indexOf(track);
  }

  // Enabled clips under t, V1 first (then V2...), and audio tracks after video ones in the same way.
  function clipsAt(seq, t, { kind } = {}) {
    const order = new Map();
    let v = 0;
    let a = 0;
    for (const tr of seq.tracks) order.set(tr.id, tr.kind === 'video' ? v++ : 100000 + a++);
    const kindOf = new Map(seq.tracks.map((tr) => [tr.id, tr.kind]));
    return seq.clips
      .filter((c) => c.enabled && c.start <= t && t < clipEnd(c) && (!kind || kindOf.get(c.track) === kind))
      .sort((x, y) => order.get(x.track) - order.get(y.track));
  }

  // The source time timeline time t shows. A reversed clip starts at its out point; a frame earlier than out (one tick)
  // so the decoder's "last sample at or before" lands inside the clip.
  function sourceTime(clip, t) {
    if (clip.source?.freeze) return clip.in;
    if (clip.remap) return Math.min(clip.out, Math.max(clip.in, R.sourceAt(clip.remap, t - clip.start)));
    const along = (t - clip.start) * clip.speed;
    if (clip.reverse) return Math.max(clip.in, clip.out - along - 1);
    return Math.min(clip.in + along, clip.out);
  }

  // The timeline time at which a clip shows source time src, the inverse of sourceTime: a reversed clip shows its out
  // point first, a remapped one the first time its curve reaches src. Outside what the clip shows it clamps to the
  // nearer edge; null for a freeze frame.
  function timelineTime(clip, src) {
    if (clip.source?.freeze) return null;
    const end = clipEnd(clip);
    if (clip.remap) {
      if (src <= clip.in) return clip.start + (R.clipTimeOf(clip.remap, clip.in) ?? 0);
      if (src >= clip.out) return clip.start + (R.clipTimeOf(clip.remap, clip.out) ?? clip.remap.duration);
      const x = R.clipTimeOf(clip.remap, src);
      return x === null ? null : Math.min(end, clip.start + x);
    }
    const along = clip.reverse ? clip.out - src : src - clip.in;
    return Math.min(end, Math.max(clip.start, clip.start + along / clip.speed));
  }
  // The lowest and highest source time a clip shows over timeline [a, b): what to decode ahead for that range.
  function sourceSpan(clip, a, b) {
    if (clip.remap && !clip.source?.freeze) {
      const [lo, hi] = R.bounds(clip.remap, Math.max(0, a - clip.start), Math.max(0, Math.min(clipDuration(clip), b - clip.start) - 1));
      return [Math.max(clip.in, lo - 1), Math.min(clip.out, hi)];
    }
    const x = sourceTime(clip, a);
    const y = sourceTime(clip, Math.max(a, b - 1));
    return [Math.min(x, y), Math.max(x, y)];
  }
  // How far, in timeline ticks, a clip's source lets it grow at its head and its tail (Infinity for a still).
  function sourceRoom(project, clip) {
    if (isStill(project, clip)) return { head: Infinity, tail: Infinity };
    const len = sourceLength(project, clip);
    if (clip.remap) {
      return { head: R.stay(clip.remap, 0, -1, -0.25, len + 0.25), tail: R.stay(clip.remap, clip.remap.duration, 1, -0.25, len + 0.25) };
    }
    const before = clip.in / clip.speed;
    const after = (len - clip.out) / clip.speed;
    return clip.reverse ? { head: Math.max(0, after), tail: Math.max(0, before) } : { head: Math.max(0, before), tail: Math.max(0, after) };
  }
  // The curve a clip plays as it is now: its remap, or its constant speed (and direction) as a curve without keys.
  function remapOf(clip) {
    if (clip.remap) return clip.remap;
    const d = clipDuration(clip);
    const v = (clip.out - clip.in) / d;
    return clip.reverse ? R.constant(clip.out, -v, d) : R.constant(clip.in, v, d);
  }

  function linkedClips(seq, clip) {
    if (!clip.link) return [];
    return seq.clips.filter((c) => c !== clip && c.link === clip.link);
  }

  // ---- validation ----

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const isInt = (x) => Number.isInteger(x);
  const isBool = (x) => typeof x === 'boolean';
  const isStr = (x) => typeof x === 'string';
  const isColor = (x) => isStr(x) && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(x);
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const isNumArr = (x, n) => Array.isArray(x) && x.length === n && x.every(isNum);
  const kfValue = (v) => isNum(v) || (Array.isArray(v) && v.length > 0 && v.every(isNum)) || isStr(v) || isBool(v);
  // A caption's doubt: the words of it speech recognition was unsure of, [{at: ticks from the caption's start, text,
  // p: Whisper's confidence 0-1}]. Auto Captions writes it; editing the caption's text drops it.
  const validDoubt = (d) => Array.isArray(d) && d.every((x) => isObj(x) && isInt(x.at) && x.at >= 0 && isStr(x.text) && isNum(x.p) && x.p >= 0 && x.p <= 1);
  // Speaker labels (Cut.speakers): {list: [{id, name, color}], turns: {mediaId: [[t0, t1, id]] source seconds, in
  // order and apart}, count: 0 for Auto or the fixed number asked for}. A media id without media is kept (the media
  // can come back with undo); a turn's speaker must be in the list.
  const SPEAKER_ID = /^sp\d+$/;
  function validateSpeakers(sp, err) {
    if (!isObj(sp) || !Array.isArray(sp.list) || !isObj(sp.turns) || !isInt(sp.count) || sp.count < 0 || sp.count > 10) return err('speakers: fields');
    const ids = new Set();
    for (const s of sp.list) {
      if (!isObj(s) || !isStr(s.id) || !SPEAKER_ID.test(s.id) || ids.has(s.id) || !isStr(s.name) || !isColor(s.color)) { err('speakers: list'); return; }
      ids.add(s.id);
    }
    for (const [media, turns] of Object.entries(sp.turns)) {
      if (!Array.isArray(turns)) { err(`speakers: turns of ${media}`); continue; }
      let last = -Infinity;
      for (const t of turns) {
        if (!Array.isArray(t) || t.length !== 3 || !isNum(t[0]) || !isNum(t[1]) || t[0] < last || t[1] <= t[0] || !ids.has(t[2])) { err(`speakers: turns of ${media}`); break; }
        last = t[1];
      }
    }
  }

  // Lumetri Color's LUTs (lumetri.js store()): { 'lut-<16 hex>': { name, title, size, min, max, data } }. An effect
  // may name a LUT that is not here (it is drawn without one).
  const LUT_ID = /^lut-[0-9a-f]{16}$/;
  function validateLuts(luts, err) {
    if (!isObj(luts)) return err('luts: not an object');
    for (const [id, e] of Object.entries(luts)) if (!LUT_ID.test(id) || !lumetri().validEntry(e)) err(`luts: ${id}`);
  }
  // The LUT ids the effects of a project name.
  function lutsInUse(project) {
    const used = new Set();
    for (const seq of project.sequences || []) for (const c of seq.clips || []) for (const e of c.effects || []) if (typeof e?.params?.lut === 'string' && e.params.lut) used.add(e.params.lut);
    return used;
  }

  // A sequence runs at one of the offered rates (features section 3); clipDuration's rounding relies on it.
  function validFps(fps) {
    return Array.isArray(fps) && fps.length === 2 && time.FRAME_RATES.some(([n, d]) => n === fps[0] && d === fps[1]);
  }

  // The prop paths keyframes may animate on this clip: a property, an effect parameter, or a text layer field.
  function validPropPath(clip, kind, prop) {
    if (!isStr(prop)) return false;
    const parts = prop.split('.');
    // `duck` (dB added to the volume) has keyframes only: Auto Ducking writes it, so running it again replaces its
    // dips instead of lowering the user's own volume curve a second time.
    if (parts.length === 1) return (kind === 'audio' ? [...AUDIO_PROPS, 'duck'] : VIDEO_PROPS).includes(prop);
    if (parts.length === 3 && parts[0] === 'effects') return !!parts[2] && parts[2] !== 'masks' && (clip.effects || []).some((e) => e.id === parts[1]);
    // a mask's Path, Feather, Opacity or Expansion (masks.js): of Opacity, or of an effect
    if (parts.length === 3 && parts[0] === 'masks') return kind === 'video' && masks().FIELDS.includes(parts[2]) && (clip.masks || []).some((m) => m?.id === parts[1]);
    if (parts.length === 5 && parts[0] === 'effects' && parts[2] === 'masks') return kind === 'video' && masks().FIELDS.includes(parts[4]) && ((clip.effects || []).find((e) => e.id === parts[1])?.masks || []).some((m) => m?.id === parts[3]);
    if (parts.length === 3 && parts[0] === 'layers') return !!parts[2] && (clip.source?.layers || []).some((l) => l.id === parts[1]);
    return false;
  }

  function validate(project) {
    const errors = [];
    const err = (msg) => { if (errors.length < 200) errors.push(msg); };
    if (!isObj(project)) return { ok: false, errors: ['the project is not an object'] };
    if (project.format !== 'ncut') err('format is not ncut');
    if (project.version !== VERSION) err(`version ${project.version} is not ${VERSION}`);
    if (!isObj(project.settings)) err('settings is not an object');
    if (!isInt(project.nextId) || project.nextId < 1) err('nextId is not a positive integer');
    for (const key of ['media', 'bins', 'sequences']) if (!Array.isArray(project[key])) { err(`${key} is not a list`); return { ok: false, errors }; }

    const ids = new Set();
    const claim = (id, what) => {
      if (!isStr(id) || !id) return err(`${what} has no id`);
      if (ids.has(id)) err(`id ${id} is used twice (${what})`);
      ids.add(id);
      const m = ID_RE.exec(id);
      if (m && Number(m[2]) >= project.nextId) err(`id ${id} is not below nextId ${project.nextId}`);
    };

    const mediaById = new Map();
    for (const m of project.media) {
      claim(m?.id, 'media');
      if (!isObj(m)) continue;
      mediaById.set(m.id, m);
      if (!isStr(m.path)) err(`media ${m.id}: path`);
      if (!isStr(m.name)) err(`media ${m.id}: name`);
      if (!['video', 'audio', 'image'].includes(m.kind)) err(`media ${m.id}: kind ${m.kind}`);
      if (!isNum(m.duration) || m.duration < 0) err(`media ${m.id}: duration`);
      if (m.video !== null && !(isObj(m.video) && isNum(m.video.w) && isNum(m.video.h))) err(`media ${m.id}: video`);
      if (m.audio !== null && !(isObj(m.audio) && isNum(m.audio.rate) && isNum(m.audio.channels))) err(`media ${m.id}: audio`);
      if (m.kind === 'video' && !m.video) err(`media ${m.id}: a video without a video stream`);
      if (m.kind === 'audio' && !m.audio) err(`media ${m.id}: audio without an audio stream`);
    }

    const seqIds = new Set(project.sequences.map((s) => s?.id));
    const binById = new Map();
    const inBin = new Set();
    for (const b of project.bins) {
      claim(b?.id, 'bin');
      if (!isObj(b)) continue;
      binById.set(b.id, b);
      if (!isStr(b.name)) err(`bin ${b.id}: name`);
      if (!Array.isArray(b.items)) { err(`bin ${b.id}: items`); continue; }
      for (const item of b.items) {
        if (!mediaById.has(item) && !seqIds.has(item)) err(`bin ${b.id}: item ${item} is not media or a sequence`);
        if (inBin.has(item)) err(`item ${item} is in two bins`);
        inBin.add(item);
      }
    }
    for (const b of binById.values()) {
      if (b.parent !== null && !binById.has(b.parent)) err(`bin ${b.id}: parent ${b.parent} missing`);
      const seen = new Set();
      for (let at = b; at && at.parent !== null; at = binById.get(at.parent)) {
        if (seen.has(at.id)) { err(`bin ${b.id}: its parents loop`); break; }
        seen.add(at.id);
      }
    }

    const linkSeq = new Map();
    const seqById = new Map(project.sequences.filter(isObj).map((s) => [s.id, s]));
    for (const seq of project.sequences) {
      claim(seq?.id, 'sequence');
      if (!isObj(seq)) continue;
      validateSequence(project, seq, mediaById, claim, err, linkSeq, seqById);
    }
    // No sequence shows itself through nest clips (a depth-first walk that finds a sequence on its own path).
    const state = new Map();
    const loops = (id) => {
      if (state.get(id) === 'open') return true;
      if (state.get(id) === 'done') return false;
      state.set(id, 'open');
      const seq = seqById.get(id);
      const found = Array.isArray(seq?.clips) && [...nestedIds({ clips: seq.clips.filter(isObj) })].some((next) => seqById.has(next) && loops(next));
      state.set(id, 'done');
      return found;
    };
    for (const id of seqById.keys()) if (loops(id)) { err(`sequence ${id} nests itself`); break; }
    if (project.speakers !== undefined) validateSpeakers(project.speakers, err);
    if (project.luts !== undefined) validateLuts(project.luts, err);
    return { ok: errors.length === 0, errors };
  }

  function validateSequence(project, seq, mediaById, claim, err, linkSeq, seqById) {
    const S = `sequence ${seq.id}`;
    if (!isStr(seq.name)) err(`${S}: name`);
    if (!isInt(seq.w) || !isInt(seq.h) || seq.w < 16 || seq.h < 16 || seq.w > 16384 || seq.h > 16384) err(`${S}: size`);
    if (!validFps(seq.fps)) { err(`${S}: fps`); return; }
    if (seq.rate !== 48000) err(`${S}: rate`);
    if (!isColor(seq.background)) err(`${S}: background`);
    if (!Number.isFinite(seq.masterGain)) err(`${S}: masterGain`);
    for (const key of ['tracks', 'clips', 'transitions', 'markers', 'captions']) if (!Array.isArray(seq[key])) { err(`${S}: ${key} is not a list`); return; }
    const f = time.frameTicks(seq.fps);
    const aligned = (t) => isInt(t) && t % f === 0;

    const tracks = new Map();
    for (const tr of seq.tracks) {
      if (!isObj(tr) || !isStr(tr.id) || !tr.id) { err(`${S}: a track has no id`); continue; }
      if (tracks.has(tr.id)) err(`${S}: track id ${tr.id} twice`);
      tracks.set(tr.id, tr);
      const T = `${S} track ${tr.id}`;
      if (tr.kind !== 'video' && tr.kind !== 'audio') err(`${T}: kind`);
      if (!isStr(tr.name)) err(`${T}: name`);
      for (const k of ['locked', 'syncLock']) if (!isBool(tr[k])) err(`${T}: ${k}`);
      if (!isNum(tr.height) || tr.height <= 0) err(`${T}: height`);
      if (tr.kind === 'video' && !isBool(tr.visible)) err(`${T}: visible`);
      if (tr.kind === 'audio') {
        for (const k of ['mute', 'solo']) if (!isBool(tr[k])) err(`${T}: ${k}`);
        if (!isNum(tr.volume)) err(`${T}: volume`);
        if (!isNum(tr.pan) || tr.pan < -100 || tr.pan > 100) err(`${T}: pan`);
      }
    }

    const byTrack = new Map();
    const links = new Map();
    for (const c of seq.clips) {
      claim(c?.id, `clip in ${seq.id}`);
      if (!isObj(c)) continue;
      const C = `${S} clip ${c.id}`;
      const tr = tracks.get(c.track);
      if (!tr) { err(`${C}: track ${c.track} missing`); continue; }
      if (!aligned(c.start) || c.start < 0) err(`${C}: start ${c.start} is not on a frame`);
      if (!isNum(c.in) || !isNum(c.out)) { err(`${C}: in/out`); continue; }
      if (!isNum(c.speed) || c.speed <= 0) { err(`${C}: speed`); continue; }
      if (c.remap !== null && !R.valid(c.remap, f)) { err(`${C}: remap`); continue; }
      const d = clipDuration(c);
      if (!aligned(d) || d < f) err(`${C}: duration ${d} is not a whole number of frames`);
      if (c.start + d > time.MAX_TICKS) err(`${C}: ends after the longest sequence`);
      for (const k of ['reverse', 'enabled']) if (!isBool(c[k])) err(`${C}: ${k}`);
      if (c.link !== null && !isStr(c.link)) err(`${C}: link`);
      if (c.group !== null && !isStr(c.group)) err(`${C}: group`);
      if (!isStr(c.name)) err(`${C}: name`);
      if (c.label !== null && !isStr(c.label)) err(`${C}: label`);
      if (c.role !== null && !ROLES.includes(c.role)) err(`${C}: role ${c.role}`);
      if (!isObj(c.source)) err(`${C}: source`);
      else if (isGenerator(c)) {
        if (!GENERATORS.includes(c.source.generator)) err(`${C}: generator ${c.source.generator}`);
        if (tr.kind !== 'video') err(`${C}: a generator on an audio track`);
        if (c.source.generator === 'text') {
          if (!Array.isArray(c.source.layers)) err(`${C}: text layers`);
          else {
            const lids = new Set();
            for (const l of c.source.layers) {
              if (!isObj(l) || !isStr(l.id) || lids.has(l.id)) err(`${C}: text layer id`);
              else lids.add(l.id);
              if (isObj(l) && (!isStr(l.text) || !isNum(l.size) || !isNumArr(l.position, 2))) err(`${C}: text layer ${l.id}`);
            }
          }
        }
        if (c.source.generator === 'solid' && !isColor(c.source.color)) err(`${C}: solid color`);
      } else if (c.source.sequence !== undefined) {
        if (!isNest(c) || c.source.media !== undefined || c.source.freeze !== undefined) err(`${C}: nest source`);
        else if (c.source.sequence === seq.id) err(`${C}: a nest of its own sequence`);
        else if (!seqById.has(c.source.sequence)) err(`${C}: sequence ${c.source.sequence} missing`);
        if (c.in < -0.5) err(`${C}: in ${c.in} before the nested sequence`);
      } else {
        const m = mediaById.get(c.source.media);
        if (!m) err(`${C}: media ${c.source.media} missing`);
        else {
          if (tr.kind === 'video' && !(m.video || m.kind === 'image')) err(`${C}: media without video on a video track`);
          if (tr.kind === 'audio' && !m.audio) err(`${C}: media without audio on an audio track`);
          if (c.source.freeze) {
            if (c.in < 0 || c.in > m.duration) err(`${C}: freeze time outside the media`);
          } else if (m.kind !== 'image' && (c.in < -0.5 || c.out > m.duration + 0.5)) err(`${C}: in/out ${c.in}..${c.out} outside the media (0..${m.duration})`);
        }
      }
      if (c.out <= c.in) err(`${C}: out is not after in`);
      if (c.remap !== null) {
        if (tr.kind !== 'video') err(`${C}: time remapping on an audio track`);
        if (isStill(project, c)) err(`${C}: time remapping on a still`);
        if (c.speed !== 1 || c.reverse !== false) err(`${C}: time remapping with a speed or reverse`);
        const [lo, hi] = R.range(c.remap);
        const tol = 0.5 + 1e-9 * Math.abs(hi);
        if (Math.abs(c.in - lo) > tol || Math.abs(c.out - hi) > tol) err(`${C}: in/out ${c.in}..${c.out} are not the remapped range ${lo}..${hi}`);
      }
      if (!SAMPLINGS.includes(c.sampling)) err(`${C}: sampling ${c.sampling}`);
      validateProps(c, tr.kind, C, err);
      if (!isObj(c.keyframes)) err(`${C}: keyframes`);
      else {
        for (const [prop, list] of Object.entries(c.keyframes)) {
          if (!validPropPath(c, tr.kind, prop)) err(`${C}: keyframes for unknown property ${prop}`);
          if (!Array.isArray(list) || !list.length) { err(`${C}: keyframes ${prop} is empty`); continue; }
          let last = -Infinity;
          for (const k of list) {
            if (!isObj(k) || !aligned(k.t)) err(`${C}: keyframe time ${k?.t} of ${prop}`);
            if (isObj(k) && k.t <= last) err(`${C}: keyframes of ${prop} are not in order`);
            if (isObj(k)) last = k.t;
            if (isObj(k) && !kfValue(k.v)) err(`${C}: keyframe value of ${prop}`);
            const mf = isObj(k) && (prop.startsWith('masks.') || prop.includes('.masks.')) ? masks().parsePath(prop) : null;
            if (mf && !masks().validField(mf.field, k.v)) err(`${C}: keyframe value of ${prop}`);
            if (isObj(k) && !EASES.includes(k.ease)) err(`${C}: keyframe ease ${k.ease}`);
            if (isObj(k) && k.ease === 'bezier' && !(isNumArr(k.h, 4) && k.h[0] >= 0 && k.h[0] <= 1 && k.h[2] >= 0 && k.h[2] <= 1)) err(`${C}: bezier handles`);
          }
        }
      }
      if (!Array.isArray(c.effects)) err(`${C}: effects`);
      else {
        const eids = new Set();
        for (const e of c.effects) {
          if (!isObj(e) || !isStr(e.id) || !e.id || eids.has(e.id)) { err(`${C}: effect id`); continue; }
          eids.add(e.id);
          if (!isStr(e.type) || !isBool(e.on) || !isObj(e.params)) err(`${C}: effect ${e.id}`);
        }
      }
      if (c.masks !== undefined || (Array.isArray(c.effects) && c.effects.some((e) => e?.masks !== undefined))) validateMasks(c, tr.kind, C, err);
      for (const k of ['fadeIn', 'fadeOut']) if (!(isInt(c[k]) && c[k] >= 0 && c[k] % f === 0)) err(`${C}: ${k}`);
      if (c.fadeIn + c.fadeOut > d) err(`${C}: fades are longer than the clip`);
      if (c.markers !== undefined) validateMarkers(c.markers, `${C} markers`, f, claim, err, true);
      if (!byTrack.has(c.track)) byTrack.set(c.track, []);
      byTrack.get(c.track).push(c);
      if (isStr(c.link)) {
        if (!links.has(c.link)) links.set(c.link, 0);
        links.set(c.link, links.get(c.link) + 1);
      }
    }
    for (const [id, n] of links) {
      if (n < 2) err(`${S}: link ${id} has one clip`);
      if (linkSeq.has(id)) err(`link ${id} is in two sequences`);
      linkSeq.set(id, seq.id);
    }
    const edges = new Map();
    for (const [tid, list] of byTrack) {
      list.sort((x, y) => x.start - y.start);
      const set = new Set();
      for (let i = 0; i < list.length; i++) {
        set.add(list[i].start);
        set.add(clipEnd(list[i]));
        if (i && clipEnd(list[i - 1]) > list[i].start) err(`${S}: clips ${list[i - 1].id} and ${list[i].id} overlap on ${tid}`);
      }
      edges.set(tid, set);
    }

    const at = new Set();
    for (const t of seq.transitions) {
      claim(t?.id, `transition in ${seq.id}`);
      if (!isObj(t)) continue;
      const X = `${S} transition ${t.id}`;
      if (!tracks.has(t.track)) err(`${X}: track ${t.track} missing`);
      if (!aligned(t.at)) err(`${X}: at`);
      else if (!edges.get(t.track)?.has(t.at)) err(`${X}: not on a clip edge`);
      if (!aligned(t.duration) || t.duration < f) err(`${X}: duration`);
      if (!isStr(t.type)) err(`${X}: type`);
      if (!ALIGNS.includes(t.align)) err(`${X}: align`);
      if (!isObj(t.params)) err(`${X}: params`);
      const key = `${t.track}@${t.at}`;
      if (at.has(key)) err(`${X}: two transitions at one point`);
      at.add(key);
    }
    validateMarkers(seq.markers, `${S} markers`, f, claim, err, false);
    for (const ct of seq.captions) {
      claim(ct?.id, `caption track in ${seq.id}`);
      if (!isObj(ct)) continue;
      const X = `${S} caption track ${ct.id}`;
      if (!isStr(ct.lang) || !isStr(ct.name) || !isObj(ct.style) || !isBool(ct.syncLock)) err(`${X}: fields`);
      if (!Array.isArray(ct.items)) { err(`${X}: items`); continue; }
      let last = -1;
      for (const it of ct.items) {
        claim(it?.id, `caption in ${ct.id}`);
        if (!isObj(it)) continue;
        if (!aligned(it.start) || !aligned(it.end) || it.start < 0 || it.end <= it.start) err(`${X}: caption ${it.id} times`);
        if (it.start < last) err(`${X}: captions are not in order`);
        last = it.start;
        if (!isStr(it.text)) err(`${X}: caption ${it.id} text`);
        if (it.doubt !== undefined && !validDoubt(it.doubt)) err(`${X}: caption ${it.id} doubt`);
        if (it.words !== undefined && !captionwords().valid(it.words, it.text)) err(`${X}: caption ${it.id} words`);
        if (it.speaker !== undefined && !(isStr(it.speaker) && SPEAKER_ID.test(it.speaker))) err(`${X}: caption ${it.id} speaker`);
      }
    }
  }

  // Masks (masks.js) on a video clip: Opacity's and its effects', ids unique across them, each list at most MAX_MASKS.
  function validateMasks(c, kind, C, err) {
    const M = masks();
    const seen = new Set();
    for (const { effectId, list } of M.lists(c)) {
      const holder = effectId ? c.effects.find((e) => e.id === effectId) : c;
      if (holder.masks === undefined) continue;
      const L = effectId ? `${C} effect ${effectId} masks` : `${C} masks`;
      if (kind !== 'video') { err(`${L}: masks on an audio track`); continue; }
      if (!Array.isArray(holder.masks) || !holder.masks.length || holder.masks.length > M.MAX_MASKS) { err(`${L}: not a list of 1 to ${M.MAX_MASKS}`); continue; }
      for (const m of list) {
        const why = M.problem(m);
        if (why) err(`${L}: mask ${m?.id}: ${why}`);
        else if (seen.has(m.id)) err(`${L}: mask id ${m.id} twice`);
        else seen.add(m.id);
      }
    }
  }
  function validateProps(c, kind, C, err) {
    if (!isObj(c.props)) return err(`${C}: props`);
    for (const [k, v] of Object.entries(c.props)) {
      if (!(kind === 'audio' ? AUDIO_PROPS : VIDEO_PROPS).includes(k)) { err(`${C}: unknown prop ${k}`); continue; }
      if (PROP_SHAPE[k] ? !isNumArr(v, PROP_SHAPE[k]) : !isNum(v)) err(`${C}: prop ${k}`);
    }
  }

  function validateMarkers(list, M, f, claim, err, inClip) {
    if (!Array.isArray(list)) return err(`${M}: not a list`);
    for (const m of list) {
      claim(m?.id, M);
      if (!isObj(m)) continue;
      const okT = isInt(m.t) && m.t % f === 0 && (inClip || m.t >= 0);
      if (!okT) err(`${M}: ${m.id} time`);
      if (!(isInt(m.duration) && m.duration >= 0 && m.duration % f === 0)) err(`${M}: ${m.id} duration`);
      if (!MARKER_KINDS.includes(m.kind)) err(`${M}: ${m.id} kind`);
      if (!isStr(m.name) || !isStr(m.note) || !isStr(m.color)) err(`${M}: ${m.id} fields`);
    }
  }

  // ---- reading files ----

  // Masks get the fields they lack; a mask whose path is not a path, a list that is not a list, and masks on an audio
  // track go (the clip draws without them), with their keyframes and the keyframes that are not values of their field.
  function migrateMasks(c, kind) {
    const M = masks();
    for (const holder of [c, ...c.effects]) {
      if (holder.masks === undefined) continue;
      const keep = kind === 'video' && Array.isArray(holder.masks) ? holder.masks.filter((m) => isObj(m)).map((m) => M.full(m)).filter((m) => M.valid(m)) : [];
      const ids = new Set();
      holder.masks = keep.filter((m) => !ids.has(m.id) && ids.add(m.id)).slice(0, M.MAX_MASKS);
      if (!holder.masks.length) delete holder.masks;
    }
    for (const [prop, list] of Object.entries(c.keyframes)) {
      const mf = M.parsePath(prop);
      if (!mf && !prop.startsWith('masks.') && !prop.includes('.masks.')) continue;
      const holder = mf && (mf.effectId ? c.effects.find((e) => e.id === mf.effectId) : c);
      if (!mf || !(holder?.masks || []).some((m) => m.id === mf.maskId)) { delete c.keyframes[prop]; continue; }
      const good = (list || []).filter((k) => M.validField(mf.field, k?.v));
      if (good.length) c.keyframes[prop] = good;
      else delete c.keyframes[prop];
    }
  }
  // Older or partial projects get every field validate() needs; a newer version is refused with a clear message.
  function migrate(json) {
    let p = typeof json === 'string' ? JSON.parse(json) : clone(json);
    if (!isObj(p) || p.format !== 'ncut') {
      const e = new Error('This is not a Nano Studio Cut project.');
      e.code = 'notProject';
      throw e;
    }
    if (!isInt(p.version) || p.version > VERSION) {
      const e = new Error('This project was saved by a newer version of Nano Studio Cut.');
      e.code = 'newer';
      e.detail = `format version ${p.version}, this app reads ${VERSION}`;
      throw e;
    }
    // 1 -> 2 added nest clips, 2 -> 3 time remapping and frame sampling, 3 -> 4 masks; an older file has none of them,
    // so it reads as it is with the defaults (no remap, frame sampling, no masks).
    p.version = VERSION;
    p.settings = { ...defaultSettings(), ...(isObj(p.settings) ? p.settings : {}) };
    p.media = Array.isArray(p.media) ? p.media : [];
    p.bins = Array.isArray(p.bins) ? p.bins : [];
    p.sequences = Array.isArray(p.sequences) ? p.sequences : [];
    for (const m of p.media) {
      m.name ??= String(m.path || '').split(/[\\/]/).pop();
      m.size ??= 0;
      m.mtime ??= 0;
      m.video ??= null;
      m.audio ??= null;
      m.interpret ??= null;
      if (typeof m.proxy === 'string') m.proxy = { path: m.proxy };
      m.proxy ??= null;
    }
    for (const b of p.bins) {
      b.parent ??= null;
      b.items ??= [];
    }
    for (const seq of p.sequences) {
      const base = createSequence({ id: seq.id, videoTracks: 0, audioTracks: 0 });
      for (const k of Object.keys(base)) seq[k] ??= base[k];
      seq.tracks = seq.tracks.map((tr) => ({ ...createTrack(tr.kind, tr.id), ...tr }));
      const kinds = new Map(seq.tracks.map((tr) => [tr.id, tr.kind]));
      for (const c of seq.clips) {
        const full = createClip(kinds.get(c.track) || 'video', { id: c.id, track: c.track, source: c.source });
        for (const k of Object.keys(full)) c[k] ??= full[k];
        if (c.role !== null && !ROLES.includes(c.role)) c.role = null;
        if (!SAMPLINGS.includes(c.sampling)) c.sampling = 'sample';
        c.props = { ...(kinds.get(c.track) === 'audio' ? audioProps() : videoProps()), ...c.props };
        for (const list of Object.values(c.keyframes)) for (const k of list) k.ease = EASES.includes(k.ease) ? k.ease : ({ in: 'easeIn', out: 'easeOut', inOut: 'easeInOut' }[k.ease] || 'linear');
        for (const e of c.effects) { e.on ??= true; e.params ??= {}; }
        if (c.masks !== undefined || c.effects.some((e) => e.masks !== undefined)) migrateMasks(c, kinds.get(c.track));
        for (const m of c.markers || []) { m.duration ??= 0; m.name ??= ''; m.note ??= ''; m.kind ??= 'comment'; m.color ??= 'green'; }
      }
      for (const t of seq.transitions) { t.align ??= 'center'; t.params ??= {}; }
      for (const m of seq.markers) {
        m.duration ??= 0; m.name ??= ''; m.note ??= ''; m.kind ??= 'comment'; m.color ??= 'green';
      }
      for (const ct of seq.captions) {
        if (ct.id == null && ct.track != null) { ct.id = ct.track; delete ct.track; }
        // A size chosen in sequence pixels keeps its look; the untouched default (54) takes the new meaning, which is
        // what it was meant to look like at every resolution.
        const short = Math.min(Number(seq.w) || 0, Number(seq.h) || 0);
        if (isObj(ct.style) && ct.style.ref == null && Number.isFinite(ct.style.size) && ct.style.size !== 54 && short > 0) {
          ct.style.size = Math.max(1, Math.round((ct.style.size * 1080) / short));
        }
        ct.lang ??= ''; ct.name ??= ct.lang || 'Captions'; ct.style = { ...defaultCaptionStyle(), ...(ct.style || {}) }; ct.syncLock ??= true; ct.items ??= [];
      }
      // Keyframe, marker and caption times written by hand or by another frame grid go to the nearest frame.
      if (validFps(seq.fps)) {
        const sn = (t) => time.snap(t, seq.fps, { nearest: true });
        const f = time.frameTicks(seq.fps);
        for (const c of seq.clips) {
          // A curve written by hand or by another tool that does not hold goes: the clip plays the source range it
          // had over its length at a constant speed. In/out follow a curve that holds.
          if (c.remap !== null && (!R.valid(c.remap, f) || kinds.get(c.track) !== 'video' || isStill(p, c))) {
            const len = Number.isInteger(c.remap?.duration) && c.remap.duration >= f && c.remap.duration % f === 0 ? c.remap.duration : Math.max(f, sn(c.out - c.in));
            const speed = (c.out - c.in) / len;
            c.remap = null;
            c.reverse = false;
            if (speed >= 0.01 && speed <= 100) c.speed = speed;
            else { c.speed = 1; c.out = c.in + len; }
          }
          if (c.remap) {
            [c.in, c.out] = R.range(c.remap);
            c.speed = 1;
            c.reverse = false;
          }
          for (const [prop, list] of Object.entries(c.keyframes)) {
            const byT = new Map();
            for (const k of list) byT.set(sn(k.t), { ...k, t: sn(k.t) });
            c.keyframes[prop] = [...byT.values()].sort((a, b) => a.t - b.t);
          }
          for (const m of c.markers || []) { m.t = sn(m.t); m.duration = sn(m.duration ?? 0); }
        }
        for (const m of seq.markers) { m.t = sn(m.t); m.duration = sn(m.duration); }
        for (const ct of seq.captions) {
          for (const it of ct.items) { it.start = sn(it.start); it.end = Math.max(it.start + f, sn(it.end)); }
          // word timings that no longer fit their text (written by hand or by another tool) are fitted again or dropped
          for (const it of ct.items) {
            if (it?.words === undefined) continue;
            const words = captionwords().realign(it.words, it.text, { frame: f, duration: it.end - it.start });
            if (words) it.words = words;
            else delete it.words;
          }
          ct.items.sort((a, b) => a.start - b.start);
        }
      }
    }
    // Ids written by hand or by another tool may lack a number newId would skip.
    let max = 0;
    const visit = (id) => { const m = ID_RE.exec(String(id)); if (m) max = Math.max(max, Number(m[2])); };
    p.media.forEach((m) => visit(m.id));
    p.bins.forEach((b) => visit(b.id));
    for (const seq of p.sequences) {
      visit(seq.id);
      for (const c of seq.clips) { visit(c.id); (c.markers || []).forEach((m) => visit(m.id)); }
      seq.transitions.forEach((t) => visit(t.id));
      seq.markers.forEach((m) => visit(m.id));
      for (const ct of seq.captions) { visit(ct.id); ct.items.forEach((it) => visit(it.id)); }
    }
    p.nextId = Math.max(isInt(p.nextId) ? p.nextId : 1, max + 1);
    // LUTs no effect names any more, and damaged ones (their effects draw without a LUT), are left behind.
    if (p.luts !== undefined) {
      const used = lutsInUse(p);
      const keep = isObj(p.luts) ? Object.entries(p.luts).filter(([id, e]) => used.has(id) && LUT_ID.test(id) && lumetri().validEntry(e)) : [];
      if (keep.length) p.luts = Object.fromEntries(keep);
      else delete p.luts;
    }
    return p;
  }

  return {
    VERSION, REVISION, revisionOf, QUANTUM, SAMPLINGS, EASES, GENERATORS, VIDEO_PROPS, AUDIO_PROPS, MARKER_KINDS, ROLES, ALIGNS,
    clone, newId, defaultSettings, createProject, createSequence, createTrack, createClip, createTextLayer, defaultCaptionStyle,
    videoProps, audioProps, validate, validPropPath, validFps, validDoubt, migrate, lutsInUse,
    clipDuration, clipEnd, sequenceDuration, clipsAt, sourceTime, timelineTime, sourceSpan, sourceRoom, remapOf, trackIndex, trackOf, linkedClips, mediaOf, isGenerator, isStill,
    isNest, nestOf, sourceLength, nestedIds, reaches, nestLoop, nestUses, nestKinds,
  };
});
