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
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).model = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;

  const VERSION = 1;
  const EASES = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut', 'bezier'];
  const GENERATORS = ['text', 'solid', 'adjustment'];
  const VIDEO_PROPS = ['position', 'scale', 'rotation', 'anchor', 'opacity', 'crop'];
  const AUDIO_PROPS = ['volume', 'pan'];
  const PROP_SHAPE = { position: 2, scale: 2, anchor: 2, crop: 4, rotation: 0, opacity: 0, volume: 0, pan: 0 };
  const MARKER_KINDS = ['comment', 'chapter'];
  const ALIGNS = ['center', 'start', 'end'];
  const ID_RE = /^([A-Za-z]+)(\d+)$/;

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

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

  function defaultCaptionStyle() {
    return { font: 'Malgun Gothic', size: 54, weight: 600, color: '#ffffff', background: '#00000099', position: 'bottom', margin: 8 };
  }

  // A clip with every field; `kind` is the kind of the track it goes on.
  function createClip(kind, opts = {}) {
    return {
      id: opts.id, track: opts.track, start: opts.start ?? 0, in: opts.in ?? 0, out: opts.out ?? 0,
      source: clone(opts.source), speed: 1, reverse: false, enabled: true, link: null, group: null,
      name: opts.name ?? '', label: null, props: kind === 'audio' ? audioProps() : videoProps(),
      keyframes: {}, effects: [], fadeIn: 0, fadeOut: 0,
    };
  }

  const isGenerator = (clip) => !!clip.source && typeof clip.source.generator === 'string';
  const mediaOf = (project, clip) => (clip.source && clip.source.media != null ? project.media.find((m) => m.id === clip.source.media) || null : null);
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
  const clipDuration = (clip) => Math.round((clip.out - clip.in) / clip.speed / QUANTUM) * QUANTUM;
  const clipEnd = (clip) => clip.start + clipDuration(clip);

  function sequenceDuration(seq) {
    let end = 0;
    for (const c of seq.clips) end = Math.max(end, clipEnd(c));
    return end;
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
    const along = (t - clip.start) * clip.speed;
    if (clip.reverse) return Math.max(clip.in, clip.out - along - 1);
    return Math.min(clip.in + along, clip.out);
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

  // A sequence runs at one of the offered rates (features section 3); clipDuration's rounding relies on it.
  function validFps(fps) {
    return Array.isArray(fps) && fps.length === 2 && time.FRAME_RATES.some(([n, d]) => n === fps[0] && d === fps[1]);
  }

  // The prop paths keyframes may animate on this clip: a property, an effect parameter, or a text layer field.
  function validPropPath(clip, kind, prop) {
    if (!isStr(prop)) return false;
    const parts = prop.split('.');
    if (parts.length === 1) return (kind === 'audio' ? AUDIO_PROPS : VIDEO_PROPS).includes(prop);
    if (parts.length === 3 && parts[0] === 'effects') return !!parts[2] && (clip.effects || []).some((e) => e.id === parts[1]);
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
    for (const seq of project.sequences) {
      claim(seq?.id, 'sequence');
      if (!isObj(seq)) continue;
      validateSequence(project, seq, mediaById, claim, err, linkSeq);
    }
    return { ok: errors.length === 0, errors };
  }

  function validateSequence(project, seq, mediaById, claim, err, linkSeq) {
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
      const d = clipDuration(c);
      if (!aligned(d) || d < f) err(`${C}: duration ${d} is not a whole number of frames`);
      if (c.start + d > time.MAX_TICKS) err(`${C}: ends after the longest sequence`);
      for (const k of ['reverse', 'enabled']) if (!isBool(c[k])) err(`${C}: ${k}`);
      if (c.link !== null && !isStr(c.link)) err(`${C}: link`);
      if (c.group !== null && !isStr(c.group)) err(`${C}: group`);
      if (!isStr(c.name)) err(`${C}: name`);
      if (c.label !== null && !isStr(c.label)) err(`${C}: label`);
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
        c.props = { ...(kinds.get(c.track) === 'audio' ? audioProps() : videoProps()), ...c.props };
        for (const list of Object.values(c.keyframes)) for (const k of list) k.ease = EASES.includes(k.ease) ? k.ease : ({ in: 'easeIn', out: 'easeOut', inOut: 'easeInOut' }[k.ease] || 'linear');
        for (const e of c.effects) { e.on ??= true; e.params ??= {}; }
      }
      for (const t of seq.transitions) { t.align ??= 'center'; t.params ??= {}; }
      for (const m of seq.markers) {
        m.duration ??= 0; m.name ??= ''; m.note ??= ''; m.kind ??= 'comment'; m.color ??= 'green';
      }
      for (const ct of seq.captions) {
        if (ct.id == null && ct.track != null) { ct.id = ct.track; delete ct.track; }
        ct.lang ??= ''; ct.name ??= ct.lang || 'Captions'; ct.style = { ...defaultCaptionStyle(), ...(ct.style || {}) }; ct.syncLock ??= true; ct.items ??= [];
      }
      // Keyframe, marker and caption times written by hand or by another frame grid go to the nearest frame.
      if (validFps(seq.fps)) {
        const sn = (t) => time.snap(t, seq.fps, { nearest: true });
        const f = time.frameTicks(seq.fps);
        for (const c of seq.clips) {
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
    return p;
  }

  return {
    VERSION, QUANTUM, EASES, GENERATORS, VIDEO_PROPS, AUDIO_PROPS, MARKER_KINDS, ALIGNS,
    clone, newId, defaultSettings, createProject, createSequence, createTrack, createClip, createTextLayer, defaultCaptionStyle,
    videoProps, audioProps, validate, validPropPath, validFps, migrate,
    clipDuration, clipEnd, sequenceDuration, clipsAt, sourceTime, trackIndex, trackOf, linkedClips, mediaOf, isGenerator, isStill,
  };
});
