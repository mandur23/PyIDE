// Edit commands and the undo history of Nano Studio Cut (docs/cut-architecture.md section 6). A command is a plain
// object built by the helpers at the end of this file ({ type, seqId, ... }); history.do(command) applies it to the
// project, recording the inverse of every change it makes (set a field, delete a field, splice a list), so undo puts
// back exactly the previous JSON and redo replays the same changes. A command that throws, or whose result does not
// validate(), changes nothing.
//
// Editing rules every command follows:
// - Times are snapped to the sequence's frames: absolute times to the start of the frame they fall in, lengths and
//   deltas to the nearest whole frame.
// - Linked clips (the same `link`) move, trim, split, change speed and get removed together, unless the command says
//   { linked: false } (Alt in the timeline). Grouped clips (the same `group`) move and get removed together too, and
//   nothing else.
// - A ripple (insert, ripple delete, ripple trim, extract, Q/W, speed with ripple) applies the same time change to the
//   tracks it targets and to every sync-locked track: time inserted at p splits what crosses p and pushes the rest;
//   a range removed takes what is in it and pulls the rest. Locked tracks never change. Caption tracks with syncLock
//   do the same; sequence markers follow when every unlocked track does.
// - Transitions sit on a clip edge of their track; they follow the edge a command moves, and one left off any edge is
//   removed. A link left with one clip is cleared.
// Errors a person can cause throw an Error whose message is a fixed English sentence (shown through tr()) and a
// `code`; programming errors (unknown ids) say what was wrong.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).commands = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const req = (name, key) => (NODE ? require(`./${name}.js`) : globalThis.Cut[key || name]);
  const graphic = () => req('graphic');
  const time = req('time');
  const model = req('model');
  const keyframes = req('keyframes');
  const R = req('remap');
  const cw = () => req('captionwords');
  const { clipDuration: dur, clipEnd: end, clone } = model;

  function fail(message, code = 'invalid', detail) {
    const e = new Error(message);
    e.code = code;
    if (detail !== undefined) e.detail = detail;
    throw e;
  }

  // ---- recording changes ----

  function recorder() {
    const ops = [];
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    return {
      ops,
      set(obj, key, value) {
        const had = has(obj, key);
        const old = obj[key];
        if (had && old === value) return;
        obj[key] = value;
        ops.push({ undo() { if (had) obj[key] = old; else delete obj[key]; }, redo() { obj[key] = value; } });
      },
      // Undo puts the key back at its place among the others, so the JSON text comes back the same.
      del(obj, key) {
        if (!has(obj, key)) return;
        const index = Object.keys(obj).indexOf(key);
        const old = obj[key];
        delete obj[key];
        ops.push({
          undo() {
            const tail = Object.keys(obj).slice(index);
            const values = tail.map((k) => obj[k]);
            for (const k of tail) delete obj[k];
            obj[key] = old;
            tail.forEach((k, i) => { obj[k] = values[i]; });
          },
          redo() { delete obj[key]; },
        });
      },
      splice(arr, index, count, ...items) {
        const removed = arr.splice(index, count, ...items);
        ops.push({ undo() { arr.splice(index, items.length, ...removed); }, redo() { arr.splice(index, count, ...items); } });
        return removed;
      },
    };
  }
  const rollback = (ops) => { for (let i = ops.length - 1; i >= 0; i--) ops[i].undo(); };

  // ---- context and lookups ----

  function context(project, tx, seqId) {
    const seq = project.sequences.find((s) => s.id === seqId);
    if (!seq) fail(`there is no sequence ${seqId}`, 'notFound');
    return { project, tx, seq, fps: seq.fps, f: time.frameTicks(seq.fps), splitLinks: new Map() };
  }
  const projectContext = (project, tx) => ({ project, tx, seq: null, splitLinks: new Map() });

  function num(x, what) {
    if (typeof x !== 'number' || !Number.isFinite(x)) fail(`${what} is not a number`);
    return x;
  }
  const at = (c, t, what = 'time') => Math.max(0, time.snap(num(t, what), c.fps));
  const near = (c, t, what = 'time') => Math.max(0, time.snap(num(t, what), c.fps, { nearest: true }));
  const frames = (c, d, what = 'length') => Math.round(num(d, what) / c.f) * c.f;
  const floorFrames = (c, x) => (x === Infinity ? Infinity : Math.max(0, Math.floor(x / c.f + 1e-9) * c.f));

  function trackOf(c, id) {
    const t = c.seq.tracks.find((x) => x.id === id);
    if (!t) fail('There is no track there.', 'noTrack', id);
    return t;
  }
  function unlocked(c, id) {
    const t = trackOf(c, id);
    if (t.locked) fail('The track is locked.', 'locked', id);
    return t;
  }
  function clipOf(c, id) {
    const x = c.seq.clips.find((k) => k.id === id);
    if (!x) fail(`there is no clip ${id}`, 'notFound');
    return x;
  }
  function mediaById(c, id) {
    const m = c.project.media.find((x) => x.id === id);
    if (!m) fail(`there is no media ${id}`, 'notFound');
    return m;
  }
  function binOf(c, id) {
    const b = c.project.bins.find((x) => x.id === id);
    if (!b) fail(`there is no bin ${id}`, 'notFound');
    return b;
  }
  const clipsOn = (c, id) => c.seq.clips.filter((x) => x.track === id).sort((a, b) => a.start - b.start);
  const kindOf = (c, clip) => trackOf(c, clip.track).kind;
  const still = (c, clip) => model.isStill(c.project, clip);
  const ids = (list, what) => {
    if (!Array.isArray(list)) fail(`${what} is not a list`);
    return list;
  };

  function nid(c, prefix) {
    const id = `${prefix}${c.project.nextId}`;
    c.tx.set(c.project, 'nextId', c.project.nextId + 1);
    return id;
  }
  function removeFrom(c, arr, item) {
    const i = arr.indexOf(item);
    if (i >= 0) c.tx.splice(arr, i, 1);
  }
  const append = (c, arr, item) => c.tx.splice(arr, arr.length, 0, item);
  function insertSorted(c, arr, item, key) {
    let i = arr.length;
    while (i > 0 && arr[i - 1][key] > item[key]) i--;
    c.tx.splice(arr, i, 0, item);
  }

  // The clips and those linked to them; with groups, also the members of their groups (and what those link to).
  function withLinked(c, clipIds, linked = true, groups = false) {
    const set = new Set(ids(clipIds, 'clipIds').map((id) => clipOf(c, id)));
    if (!linked) return [...set];
    for (let size = -1; size !== set.size;) {
      size = set.size;
      const links = new Set([...set].map((x) => x.link).filter(Boolean));
      const grouped = new Set(groups ? [...set].map((x) => x.group).filter(Boolean) : []);
      for (const x of c.seq.clips) if ((x.link && links.has(x.link)) || (x.group && grouped.has(x.group))) set.add(x);
    }
    return [...set];
  }

  // ---- clip edits (every change recorded) ----

  // Keyframes and clip markers count from the clip's start; when the start moves by d over the same content, they
  // move by -d so they stay on their frames.
  function shiftKeys(c, clip, d) {
    if (!d) return;
    for (const [prop, list] of Object.entries(clip.keyframes)) c.tx.set(clip.keyframes, prop, list.map((k) => ({ ...k, t: k.t - d })));
    if (clip.markers?.length) c.tx.set(clip, 'markers', clip.markers.map((m) => ({ ...m, t: m.t - d })));
  }
  function clampFades(c, clip, d) {
    const fi = Math.min(clip.fadeIn, d);
    c.tx.set(clip, 'fadeIn', fi);
    c.tx.set(clip, 'fadeOut', Math.min(clip.fadeOut, d - fi));
  }
  // A remapped clip plays curve r (remap.js) from now on: in/out become the source range it reaches. A curve without
  // keys is a constant speed, so the clip turns back into one (Speed/Duration works on it again).
  function setCurve(c, clip, r) {
    const [lo, hi] = R.range(r);
    if (R.isConstant(r)) {
      if (clip.remap !== null) c.tx.set(clip, 'remap', null);
      c.tx.set(clip, 'speed', Math.abs(r.speeds[0]));
      c.tx.set(clip, 'reverse', r.speeds[0] < 0);
    } else {
      c.tx.set(clip, 'remap', r);
      c.tx.set(clip, 'speed', 1);
      c.tx.set(clip, 'reverse', false);
    }
    c.tx.set(clip, 'in', lo);
    c.tx.set(clip, 'out', hi);
  }
  // The clip's head moves to ns; its end stays. The source side that is shown first (in, or out when reversed)
  // follows; a still clip only changes length. A remapped clip's curve is seen from the new head.
  function setStart(c, clip, ns) {
    const d = ns - clip.start;
    if (!d) return;
    const nd = end(clip) - ns;
    if (clip.remap) setCurve(c, clip, R.shift(clip.remap, d));
    else if (still(c, clip) || clip.reverse) c.tx.set(clip, 'out', clip.in + nd * clip.speed);
    else c.tx.set(clip, 'in', clip.out - nd * clip.speed);
    c.tx.set(clip, 'start', ns);
    shiftKeys(c, clip, d);
    clampFades(c, clip, nd);
  }
  function setEnd(c, clip, ne) {
    const nd = ne - clip.start;
    if (nd === dur(clip)) return;
    if (clip.remap) setCurve(c, clip, R.withDuration(clip.remap, nd));
    else if (still(c, clip) || !clip.reverse) c.tx.set(clip, 'out', clip.in + nd * clip.speed);
    else c.tx.set(clip, 'in', clip.out - nd * clip.speed);
    clampFades(c, clip, nd);
  }

  // How far the source lets the clip grow at its head and its tail, in whole timeline frames.
  function room(c, clip) {
    const r = model.sourceRoom(c.project, clip);
    return { head: floorFrames(c, r.head), tail: floorFrames(c, r.tail) };
  }
  // The end of the clip before and the start of the clip after, on the same track (0 and Infinity when none).
  function neighbours(c, clip) {
    let prevEnd = 0;
    let nextStart = Infinity;
    const e = end(clip);
    for (const o of c.seq.clips) {
      if (o === clip || o.track !== clip.track) continue;
      const oe = end(o);
      if (oe <= clip.start && oe > prevEnd) prevEnd = oe;
      if (o.start >= e && o.start < nextStart) nextStart = o.start;
    }
    return { prevEnd, nextStart };
  }

  // A keyframe list cut at clip time off: the left part ends on the value at off, the right part starts on it (times
  // from the right piece's start). Linear and hold segments stay exact; an eased segment cut in two is close.
  function splitKeys(list, off) {
    const v = keyframes.valueAt(list, off);
    const before = list.filter((k) => k.t < off);
    const on = list.find((k) => k.t === off);
    const after = list.filter((k) => k.t > off);
    const left = before.slice();
    if (on) left.push(on);
    else if (after.length || !left.length) left.push({ t: off, v, ease: 'linear' });
    const right = [];
    if (on) right.push({ ...on, t: 0 });
    else if (before.length) {
      const p = before[before.length - 1];
      right.push(p.ease === 'bezier' ? { t: 0, v, ease: p.ease, h: p.h.slice() } : { t: 0, v, ease: p.ease });
    }
    for (const k of after) right.push({ ...k, t: k.t - off });
    return { left, right: clone(right) };
  }

  // Splits the clip at timeline time p (start < p < end): the clip keeps the left part and its id, a new clip after
  // it in the list takes the right part. Right parts of linked clips cut at the same time share a new link.
  function splitClip(c, clip, p) {
    const off = p - clip.start;
    const rd = dur(clip) - off;
    const right = clone(clip);
    right.id = nid(c, 'c');
    right.start = p;
    if (clip.remap) {
      // the right part plays the rest of the curve, a ramp across the cut included
      right.remap = R.shift(clip.remap, off);
      [right.in, right.out] = R.range(right.remap);
      if (R.isConstant(right.remap)) {
        right.speed = Math.abs(right.remap.speeds[0]);
        right.reverse = right.remap.speeds[0] < 0;
        right.remap = null;
      }
    } else if (still(c, clip)) right.out = clip.in + rd * clip.speed;
    else if (clip.reverse) right.out = clip.in + rd * clip.speed;
    else right.in = clip.out - rd * clip.speed;
    right.fadeIn = 0;
    right.fadeOut = Math.min(clip.fadeOut, rd);
    const leftKeys = {};
    right.keyframes = {};
    for (const [prop, list] of Object.entries(clip.keyframes)) {
      const s = splitKeys(list, off);
      leftKeys[prop] = s.left;
      right.keyframes[prop] = s.right;
    }
    if (clip.markers) right.markers = clone(clip.markers.filter((m) => m.t >= off).map((m) => ({ ...m, t: m.t - off })));
    if (clip.link) {
      const key = `${clip.link}@${p}`;
      if (!c.splitLinks.has(key)) c.splitLinks.set(key, nid(c, 'L'));
      right.link = c.splitLinks.get(key);
    }
    c.tx.splice(c.seq.clips, c.seq.clips.indexOf(clip) + 1, 0, right);
    c.tx.set(clip, 'fadeOut', 0);
    setEnd(c, clip, p);
    for (const [prop, list] of Object.entries(leftKeys)) c.tx.set(clip.keyframes, prop, list);
    if (clip.markers) c.tx.set(clip, 'markers', clip.markers.filter((m) => m.t < off));
    return right;
  }

  // Takes [a, b) off a track: clips inside go, clips across an end are trimmed, a clip across both is cut in two.
  function clearRange(c, trackId, a, b) {
    for (const clip of clipsOn(c, trackId)) {
      const s = clip.start;
      const e = end(clip);
      if (e <= a || s >= b) continue;
      if (s >= a && e <= b) removeFrom(c, c.seq.clips, clip);
      else if (s < a && e > b) {
        splitClip(c, clip, b);
        setEnd(c, clip, a);
      } else if (s < a) setEnd(c, clip, a);
      else setStart(c, clip, b);
    }
  }

  function insertTime(c, trackId, p, L) {
    for (const clip of clipsOn(c, trackId)) if (clip.start < p && end(clip) > p) splitClip(c, clip, p);
    for (const clip of [...c.seq.clips]) if (clip.track === trackId && clip.start >= p) c.tx.set(clip, 'start', clip.start + L);
    for (const t of c.seq.transitions) if (t.track === trackId && t.at >= p) c.tx.set(t, 'at', t.at + L);
  }
  function removeTime(c, trackId, a, b) {
    const L = b - a;
    clearRange(c, trackId, a, b);
    for (const t of [...c.seq.transitions]) if (t.track === trackId && t.at >= a && t.at <= b) removeFrom(c, c.seq.transitions, t);
    for (const clip of [...c.seq.clips]) if (clip.track === trackId && clip.start >= b) c.tx.set(clip, 'start', clip.start - L);
    for (const t of c.seq.transitions) if (t.track === trackId && t.at > b) c.tx.set(t, 'at', t.at - L);
  }

  // A caption's word timings and doubt moved with their sound by fn (a sequence time -> its new time; isEnd: a word's
  // end), for the caption now at [to, end); cut: the range a ripple took away, whose doubtful words are gone.
  // -> {words, doubt}, each only when there are some.
  function timed(it, to, end, fn, cut = null) {
    const out = {};
    if (it.words) out.words = cw().remap(it.words, it.start, to, fn);
    const heard = cut && it.doubt ? it.doubt.filter((d) => it.start + d.at < cut[0] || it.start + d.at >= cut[1]) : it.doubt;
    const doubt = heard && cw().remapDoubt(heard, it.start, to, fn, end - to);
    if (doubt?.length) out.doubt = doubt;
    return out;
  }
  function retime(tx, it, t) {
    if (t.words) tx.set(it, 'words', t.words);
    if (t.doubt) tx.set(it, 'doubt', t.doubt);
    else if (it.doubt !== undefined) tx.del(it, 'doubt');
  }

  function captionsInsert(c, ct, p, L) {
    const shift = (x, isEnd) => ((isEnd ? x > p : x >= p) ? x + L : x);
    const pieces = [];
    for (const it of [...ct.items]) {
      if (it.start < p) {
        // A caption across p shows on both sides of the inserted time. The words of each piece stay with their sound
        // (those from p on move by L); a doubtful word is marked on the piece that holds its start.
        if (it.end > p) pieces.push({ id: nid(c, 'cap'), start: p + L, end: it.end + L, text: it.text, ...timed(it, p + L, it.end + L, shift), ...(it.speaker ? { speaker: it.speaker } : {}) });
        retime(c.tx, it, timed(it, it.start, Math.min(it.end, p), shift));
        if (it.end > p) c.tx.set(it, 'end', p);
      } else {
        c.tx.set(it, 'start', it.start + L);
        c.tx.set(it, 'end', it.end + L);
      }
    }
    for (const piece of pieces) insertSorted(c, ct.items, piece, 'start');
  }
  function captionsRemove(c, ct, a, b) {
    const L = b - a;
    const map = (x) => (x <= a ? x : x < b ? a : x - L);
    for (const it of [...ct.items]) {
      const s = map(it.start);
      const e = map(it.end);
      if (e <= s) removeFrom(c, ct.items, it);
      else {
        retime(c.tx, it, timed(it, s, e, map, [a, b]));
        c.tx.set(it, 'start', s);
        c.tx.set(it, 'end', e);
      }
    }
  }
  function markersInsert(c, p, L) {
    for (const m of c.seq.markers) {
      if (m.t >= p) c.tx.set(m, 't', m.t + L);
      else if (m.t + m.duration > p) c.tx.set(m, 'duration', m.duration + L);
    }
  }
  function markersRemove(c, a, b) {
    const L = b - a;
    const map = (x) => (x <= a ? x : x < b ? a : x - L);
    for (const m of c.seq.markers) {
      const t = map(m.t);
      c.tx.set(m, 'duration', map(m.t + m.duration) - t);
      c.tx.set(m, 't', t);
    }
  }

  // The tracks a ripple changes: the unlocked tracks it targets and every unlocked sync-locked track.
  function rippleTracks(c, involved) {
    const set = new Set();
    for (const id of involved) if (!trackOf(c, id).locked) set.add(id);
    for (const t of c.seq.tracks) if (t.syncLock && !t.locked) set.add(t.id);
    return [...set];
  }
  const everyTrack = (c, list) => c.seq.tracks.every((t) => t.locked || list.includes(t.id));
  function rippleInsert(c, involved, p, L) {
    if (L <= 0) return;
    const list = rippleTracks(c, involved);
    for (const id of list) insertTime(c, id, p, L);
    for (const ct of c.seq.captions) if (ct.syncLock) captionsInsert(c, ct, p, L);
    if (everyTrack(c, list)) markersInsert(c, p, L);
  }
  function rippleRemove(c, involved, a, b) {
    if (b <= a) return;
    const list = rippleTracks(c, involved);
    for (const id of list) removeTime(c, id, a, b);
    for (const ct of c.seq.captions) if (ct.syncLock) captionsRemove(c, ct, a, b);
    if (everyTrack(c, list)) markersRemove(c, a, b);
  }

  // Joins overlapping or touching ranges.
  function mergeRanges(list) {
    const sorted = list.slice().sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of sorted) {
      if (out.length && r[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], r[1]);
      else out.push(r.slice());
    }
    return out;
  }

  // After every command: links and groups of one clip are cleared, transitions off every clip edge (or doubled) are
  // removed.
  function normalize(project, tx) {
    for (const seq of project.sequences) {
      for (const key of ['link', 'group']) {
        const count = new Map();
        for (const x of seq.clips) if (x[key]) count.set(x[key], (count.get(x[key]) || 0) + 1);
        for (const x of seq.clips) if (x[key] && count.get(x[key]) < 2) tx.set(x, key, null);
      }
      const edges = new Map();
      for (const x of seq.clips) {
        if (!edges.has(x.track)) edges.set(x.track, new Set());
        edges.get(x.track).add(x.start).add(end(x));
      }
      const seen = new Set();
      const drop = [];
      for (const t of seq.transitions) {
        const key = `${t.track}@${t.at}`;
        if (!edges.get(t.track)?.has(t.at) || seen.has(key)) drop.push(t);
        seen.add(key);
      }
      for (const t of drop) {
        const i = seq.transitions.indexOf(t);
        tx.splice(seq.transitions, i, 1);
      }
    }
  }

  // ---- sources ----

  function normSource(c, source) {
    if (!source || typeof source !== 'object') fail('the source is missing');
    const s = clone(source);
    if (s.media != null) {
      mediaById(c, s.media);
      return { media: s.media };
    }
    if (s.sequence != null) {
      if (!c.project.sequences.some((x) => x.id === s.sequence)) fail(`there is no sequence ${s.sequence}`, 'notFound');
      if (c.seq && model.nestLoop(c.project, c.seq.id, s.sequence)) fail('A sequence cannot be nested inside itself.', 'nestLoop');
      return { sequence: s.sequence };
    }
    if (s.generator === 'text') {
      const used = new Set();
      const layers = (Array.isArray(s.layers) && s.layers.length ? s.layers : [{}]).map((l, i) => {
        let id = typeof l.id === 'string' && l.id && !used.has(l.id) ? l.id : `l${i + 1}`;
        while (used.has(id)) id = `${id}_`;
        used.add(id);
        return model.createTextLayer({ ...l, id });
      });
      return { generator: 'text', layers };
    }
    if (s.generator === 'graphic') {
      const given = Array.isArray(s.layers) ? s.layers : [];
      if (!given.length) fail('a graphic needs one layer at least');
      const used = new Set(given.map((l) => l?.id).filter((id) => typeof id === 'string'));
      let n = 0;
      const layers = given.map((l) => {
        if (l && typeof l === 'object' && typeof l.id === 'string') return l;
        let id;
        do id = `g${++n}`; while (used.has(id));
        used.add(id);
        return { ...l, id };
      });
      const errors = graphic().validate(layers);
      if (errors.length) fail(`the graphic is not valid: ${errors.join('; ')}`, 'badGraphic');
      return { generator: 'graphic', layers: layers.map((l) => graphic().normalize(l)) };
    }
    if (s.generator === 'solid') return { generator: 'solid', color: typeof s.color === 'string' ? s.color : '#ffffff' };
    if (s.generator === 'adjustment') return { generator: 'adjustment' };
    return fail(`unknown source ${JSON.stringify(source)}`);
  }

  // Video and/or audio clips of one source at `at` (or ending at `endAt`), linked when both are placed.
  function placeClips(c, o) {
    const src = normSource(c, o.source);
    const media = src.media != null ? mediaById(c, src.media) : null;
    const nest = src.sequence != null ? c.project.sequences.find((x) => x.id === src.sequence) : null;
    const nestHas = nest ? model.nestKinds(c.project, nest.id) : null;
    if (nest && !nestHas.video && !nestHas.audio) fail('The sequence is empty.', 'emptySequence');
    const hasV = nest ? nestHas.video : !media || media.kind === 'image' || !!media.video;
    const hasA = nest ? nestHas.audio : !!media?.audio;
    const vId = hasV && o.video != null ? o.video : null;
    const aId = hasA && o.audio != null ? o.audio : null;
    if (!vId && !aId) fail('Choose a target track.', 'noTarget');
    if (vId && unlocked(c, vId).kind !== 'video') fail('There is no track there.', 'noTrack', vId);
    if (aId && unlocked(c, aId).kind !== 'audio') fail('There is no track there.', 'noTrack', aId);
    const isStillSrc = !nest && (!media || media.kind === 'image');
    const length = nest ? model.sequenceDuration(nest) : media?.duration;
    let sin;
    let d;
    if (isStillSrc) {
      sin = 0;
      const want = o.out != null && o.in != null ? num(o.out, 'out') - num(o.in, 'in') : o.out != null ? num(o.out, 'out') : c.project.settings.stillDuration;
      d = Math.max(c.f, frames(c, want));
    } else {
      sin = o.in == null ? 0 : at(c, o.in, 'in');
      const sout = Math.min(o.out == null ? length : num(o.out, 'out'), length);
      d = floorFrames(c, sout - sin);
      if (d < c.f) fail('The clip is too short.', 'tooShort');
    }
    const p = o.endAt != null ? at(c, o.endAt, 'endAt') - d : at(c, o.at ?? 0, 'at');
    if (p < 0) fail('The clip does not fit before the Out point.', 'noRoom');
    const targets = [vId, aId].filter(Boolean);
    if (o.mode === 'insert') rippleInsert(c, targets, p, d);
    else if (o.mode && o.mode !== 'overwrite') fail(`unknown mode ${o.mode}`);
    else for (const id of targets) clearRange(c, id, p, p + d);
    const link = vId && aId ? nid(c, 'L') : null;
    const made = [];
    // A nest clip has no name of its own: the timeline shows its sequence's name, which follows a rename.
    const name = typeof o.name === 'string' ? o.name : media ? media.name : nest ? '' : { text: 'Text', solid: 'Color', adjustment: 'Adjustment' }[src.generator];
    for (const [id, kind] of [[vId, 'video'], [aId, 'audio']]) {
      if (!id) continue;
      const clip = model.createClip(kind, { id: nid(c, 'c'), track: id, start: p, in: sin, out: sin + d, source: src, name });
      clip.link = link;
      append(c, c.seq.clips, clip);
      made.push(clip.id);
    }
    return { ids: made, at: p, duration: d };
  }

  // ---- commands ----

  const H = {};

  // media and bins
  H.importMedia = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const bin = cmd.binId != null ? binOf(c, cmd.binId) : null;
    const made = [];
    for (const m of ids(cmd.media, 'media')) {
      if (!m || typeof m.path !== 'string') fail('a media entry has no path');
      const entry = {
        id: nid(c, 'm'), path: m.path, name: typeof m.name === 'string' ? m.name : m.path.split(/[\\/]/).pop(), kind: m.kind,
        size: m.size ?? 0, mtime: m.mtime ?? 0, duration: m.duration ?? 0, video: clone(m.video ?? null), audio: clone(m.audio ?? null),
        interpret: null, proxy: null,
      };
      append(c, project.media, entry);
      if (bin) append(c, bin.items, entry.id);
      made.push(entry.id);
    }
    return { ids: made };
  };
  H.removeMedia = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const gone = new Set(ids(cmd.ids, 'ids'));
    for (const id of gone) mediaById(c, id);
    for (const seq of project.sequences) for (const x of [...seq.clips]) if (x.source?.media != null && gone.has(x.source.media)) removeFrom(c, seq.clips, x);
    for (const b of project.bins) for (const item of [...b.items]) if (gone.has(item)) removeFrom(c, b.items, item);
    for (const m of [...project.media]) if (gone.has(m.id)) removeFrom(c, project.media, m);
    return { ids: [...gone] };
  };
  H.setProxy = (project, tx, cmd) => {
    const m = mediaById(projectContext(project, tx), cmd.id);
    if (cmd.proxy != null && typeof cmd.proxy.path !== 'string') fail('a proxy needs a path');
    tx.set(m, 'proxy', cmd.proxy == null ? null : { path: cmd.proxy.path });
    return {};
  };
  // Project settings, the saved text styles of the text panel ({ id, name, style }), and speech recognition's word
  // list (names, products and terms Whisper is told of; ui-speech.js).
  const SETTINGS = { fit: ['fit', 'fill', 'original'], stillDuration: 'ticks', transitionDuration: 'ticks', freezeDuration: 'ticks', textStyles: 'list', speechTerms: 'terms' };
  const validTerms = (v) => Array.isArray(v) && v.length <= 200 && v.every((t) => typeof t === 'string' && t.trim() === t && t.length > 0 && t.length <= 100);
  H.setSettings = (project, tx, cmd) => {
    for (const [k, v] of Object.entries(clone(cmd.patch || {}))) {
      const kind = SETTINGS[k];
      if (!kind) fail(`unknown project setting ${k}`);
      const ok = Array.isArray(kind) ? kind.includes(v) : kind === 'ticks' ? Number.isInteger(v) && v > 0 : kind === 'terms' ? validTerms(v) : Array.isArray(v);
      if (!ok) fail(`project setting ${k} is not valid`);
      tx.set(project.settings, k, v);
    }
    return {};
  };
  // Speaker labels (Cut.speakers, model.validate): the patch's list, count and turns of each media (null: none) replace
  // those of before; `speakers: null` takes every label away. One undo step whatever it changes.
  H.setSpeakers = (project, tx, cmd) => {
    if (cmd.patch === null) { tx.del(project, 'speakers'); return {}; }
    const p = clone(cmd.patch || {});
    for (const k of Object.keys(p)) if (!['list', 'turns', 'count'].includes(k)) fail(`unknown speakers field ${k}`);
    const now = project.speakers || { list: [], turns: {}, count: 0 };
    const turns = { ...now.turns };
    for (const [media, list] of Object.entries(p.turns || {})) {
      if (list === null) delete turns[media];
      else turns[media] = list;
    }
    const next = { list: p.list ?? clone(now.list), turns, count: p.count ?? now.count };
    const bad = [];
    model.validate({ ...project, speakers: next }).errors.forEach((e) => { if (e.startsWith('speakers')) bad.push(e); });
    if (bad.length) fail('the speaker labels are not valid', 'invalid', bad.join('; '));
    tx.set(project, 'speakers', next);
    return {};
  };
  // A LUT for Lumetri Color's Look (lumetri.js store(): { id, entry }), kept in the project so it travels with it.
  // The same LUT again changes nothing; migrate drops the ones no effect names.
  H.addLut = (project, tx, cmd) => {
    const id = cmd.id;
    const entry = clone(cmd.entry);
    if (typeof id !== 'string' || model.validate({ ...project, luts: { [id]: entry } }).errors.some((e) => e.startsWith('luts'))) fail('the LUT is not valid', 'invalid');
    if (project.luts?.[id]) return { id };
    if (!project.luts) tx.set(project, 'luts', { [id]: entry });
    else tx.set(project.luts, id, entry);
    return { id };
  };
  H.relinkMedia = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const m = mediaById(c, cmd.id);
    const file = cmd.file || {};
    if (typeof file.path !== 'string') fail('relink needs a path');
    for (const k of ['path', 'size', 'mtime', 'duration']) if (file[k] !== undefined) tx.set(m, k, file[k]);
    for (const k of ['video', 'audio']) if (file[k] !== undefined) tx.set(m, k, clone(file[k]));
    if (m.proxy) tx.set(m, 'proxy', null);
    // A shorter file: the clips lose what they showed past its end, in whole frames; a clip with no frame left (or a
    // freeze frame or a remapped clip that reaches past it) goes. Linked clips of one source end alike.
    const trimmed = [];
    const removed = [];
    if (m.kind !== 'image') {
      const D = m.duration;
      for (const seq of project.sequences) {
        const sc = context(project, tx, seq.id);
        for (const clip of [...seq.clips]) {
          if (clip.source?.media !== m.id) continue;
          if (clip.source.freeze ? clip.in <= D : clip.out <= D + 0.5) continue;
          const keep = clip.remap || clip.source.freeze ? 0 : floorFrames(sc, (D - clip.in) / clip.speed);
          if (keep < sc.f) { removeFrom(sc, seq.clips, clip); removed.push(clip.id); continue; }
          if (clip.reverse) setStart(sc, clip, end(clip) - keep);
          else setEnd(sc, clip, clip.start + keep);
          trimmed.push(clip.id);
        }
      }
    }
    return { trimmed, removed };
  };
  H.addBin = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    if (cmd.parent != null) binOf(c, cmd.parent);
    const bin = { id: nid(c, 'b'), name: String(cmd.name ?? 'Bin'), parent: cmd.parent ?? null, items: [] };
    append(c, project.bins, bin);
    return { id: bin.id };
  };
  H.removeBin = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const bin = binOf(c, cmd.id);
    const parent = bin.parent != null ? binOf(c, bin.parent) : null;
    for (const b of project.bins) if (b.parent === bin.id) tx.set(b, 'parent', bin.parent);
    if (parent) for (const item of bin.items) append(c, parent.items, item);
    removeFrom(c, project.bins, bin);
    return {};
  };
  H.renameItem = (project, tx, cmd) => {
    const item = [...project.media, ...project.bins, ...project.sequences].find((x) => x.id === cmd.id);
    if (!item) fail(`there is no item ${cmd.id}`, 'notFound');
    tx.set(item, 'name', String(cmd.name ?? ''));
    return {};
  };
  H.moveToBin = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const target = cmd.binId != null ? binOf(c, cmd.binId) : null;
    for (const id of ids(cmd.ids, 'ids')) {
      const bin = project.bins.find((b) => b.id === id);
      if (bin) {
        for (let at2 = target; at2; at2 = at2.parent != null ? binOf(c, at2.parent) : null) if (at2 === bin) fail('A bin cannot go inside itself.', 'binLoop');
        tx.set(bin, 'parent', target ? target.id : null);
        continue;
      }
      if (!project.media.some((m) => m.id === id) && !project.sequences.some((s) => s.id === id)) fail(`there is no item ${id}`, 'notFound');
      for (const b of project.bins) if (b.items.includes(id)) removeFrom(c, b.items, id);
      if (target) append(c, target.items, id);
    }
    return {};
  };

  // sequences
  function duplicateSequence(c, src, name) {
    const copy = clone(src);
    copy.id = nid(c, 's');
    copy.name = name ?? `${src.name} Copy`;
    const links = new Map();
    const groups = new Map();
    for (const x of copy.clips) {
      x.id = nid(c, 'c');
      if (x.link) {
        if (!links.has(x.link)) links.set(x.link, nid(c, 'L'));
        x.link = links.get(x.link);
      }
      if (x.group) {
        if (!groups.has(x.group)) groups.set(x.group, nid(c, 'G'));
        x.group = groups.get(x.group);
      }
      for (const m of x.markers || []) m.id = nid(c, 'mk');
    }
    for (const t of copy.transitions) t.id = nid(c, 't');
    for (const m of copy.markers) m.id = nid(c, 'mk');
    for (const ct of copy.captions) {
      ct.id = nid(c, 'cc');
      for (const it of ct.items) it.id = nid(c, 'cap');
    }
    return copy;
  }
  H.addSequence = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const o = clone(cmd.opts || {});
    let seq;
    if (o.from != null) {
      const src = project.sequences.find((s) => s.id === o.from);
      if (!src) fail(`there is no sequence ${o.from}`, 'notFound');
      seq = duplicateSequence(c, src, o.name);
    } else {
      if (o.fps && !model.validFps(o.fps)) fail('That frame rate is not supported.', 'fps');
      seq = model.createSequence({ ...o, id: nid(c, 's'), name: o.name ?? `Sequence ${project.sequences.length + 1}` });
    }
    append(c, project.sequences, seq);
    if (o.binId != null) append(c, binOf(c, o.binId).items, seq.id);
    return { id: seq.id };
  };
  H.removeSequence = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const seq = project.sequences.find((s) => s.id === cmd.id);
    if (!seq) fail(`there is no sequence ${cmd.id}`, 'notFound');
    for (const b of project.bins) if (b.items.includes(seq.id)) removeFrom(c, b.items, seq.id);
    // Its nest clips in other sequences go with it, as a removed file's clips do.
    for (const use of model.nestUses(project, seq.id)) for (const x of use.clips) removeFrom(c, use.seq.clips, x);
    removeFrom(c, project.sequences, seq);
    return {};
  };
  // Clip > Nest (Premiere's): the clips, with what links to them and their groups, move into a new sequence of this
  // one's size, rate and tracks, keeping their tracks and their times from the earliest of them, with their keyframes,
  // markers and effects; a transition goes along when every clip at its edit point does. In their place one nest clip
  // spans them: its video on the lowest of their video tracks, its audio on the lowest of their audio tracks, linked,
  // overwriting whatever else lies there. The new sequence goes in the bin of this one. -> { id (the sequence), ids }
  H.nest = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const chosen = withLinked(c, ids(cmd.clipIds, 'clipIds'), o.linked !== false, true);
    if (!chosen.length) fail('Select the clips to nest.', 'noClips');
    for (const x of chosen) unlocked(c, x.track);
    const t0 = Math.min(...chosen.map((x) => x.start));
    const t1 = Math.max(...chosen.map(end));
    const tracksOf = (kind) => c.seq.tracks.filter((t) => t.kind === kind);
    const inner = model.createSequence({
      id: nid(c, 's'), name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Nested Sequence',
      w: c.seq.w, h: c.seq.h, fps: c.seq.fps, background: c.seq.background,
      videoTracks: tracksOf('video').length, audioTracks: tracksOf('audio').length,
    });
    // A track of this sequence -> the track at the same place among its kind in the new one.
    const innerTrack = (id) => {
      const t = trackOf(c, id);
      return tracksOf(t.kind).indexOf(t) + 1;
    };
    const letter = (id) => (kindOf(c, { track: id }) === 'video' ? 'V' : 'A');
    const moved = new Set(chosen);
    const carried = c.seq.transitions.filter((t) => {
      const at2 = c.seq.clips.filter((x) => x.track === t.track && (x.start === t.at || end(x) === t.at));
      return at2.length && at2.every((x) => moved.has(x));
    });
    for (const x of chosen) {
      const copy = clone(x);
      copy.track = `${letter(x.track)}${innerTrack(x.track)}`;
      copy.start = x.start - t0;
      // A link lives in one sequence: one that does not move whole (Alt) stays with the clips left behind.
      if (copy.link && c.seq.clips.some((y) => y.link === copy.link && !moved.has(y))) copy.link = null;
      inner.clips.push(copy);
    }
    for (const t of carried) inner.transitions.push({ ...clone(t), track: `${letter(t.track)}${innerTrack(t.track)}`, at: t.at - t0 });
    for (const x of chosen) removeFrom(c, c.seq.clips, x);
    for (const t of carried) removeFrom(c, c.seq.transitions, t);
    append(c, project.sequences, inner);
    const bin = project.bins.find((b) => b.items.includes(c.seq.id));
    if (bin) append(c, bin.items, inner.id);
    const lowest = (kind) => {
      const used = new Set(chosen.filter((x) => kindOf(c, x) === kind).map((x) => x.track));
      return tracksOf(kind).find((t) => used.has(t.id))?.id ?? null;
    };
    const vId = lowest('video');
    const aId = lowest('audio');
    // Each track plays inside as it did outside: hidden, muted and soloed as it was, its volume and pan less those of
    // the track the nest clip goes on (which apply to the nest clip), so a clip is not turned down twice.
    const land = trackOf(c, aId ?? tracksOf('audio')[0]?.id) || {};
    tracksOf('video').forEach((t, i) => { inner.tracks.filter((x) => x.kind === 'video')[i].visible = t.visible; });
    tracksOf('audio').forEach((t, i) => {
      const x = inner.tracks.filter((y) => y.kind === 'audio')[i];
      x.mute = t.mute;
      x.solo = t.solo;
      x.volume = (t.volume ?? 0) - (land.volume ?? 0);
      x.pan = Math.max(-100, Math.min(100, (t.pan ?? 0) - (land.pan ?? 0)));
    });
    for (const id of [vId, aId]) if (id) clearRange(c, id, t0, t1);
    const link = vId && aId ? nid(c, 'L') : null;
    const made = [];
    for (const [id, kind] of [[vId, 'video'], [aId, 'audio']]) {
      if (!id) continue;
      const clip = model.createClip(kind, { id: nid(c, 'c'), track: id, start: t0, in: 0, out: t1 - t0, source: { sequence: inner.id }, name: '' });
      clip.link = link;
      append(c, c.seq.clips, clip);
      made.push(clip.id);
    }
    return { id: inner.id, ids: made };
  };
  H.setSequence = (project, tx, cmd) => {
    const c = context(project, tx, cmd.id);
    const p = cmd.patch || {};
    for (const k of Object.keys(p)) if (!['name', 'w', 'h', 'fps', 'background', 'masterGain'].includes(k)) fail(`unknown sequence setting ${k}`);
    if (p.name !== undefined) tx.set(c.seq, 'name', String(p.name));
    for (const k of ['w', 'h']) {
      if (p[k] === undefined) continue;
      if (!Number.isInteger(p[k]) || p[k] < 16 || p[k] > 16384) fail('That frame size is not supported.', 'size');
      tx.set(c.seq, k, p[k]);
    }
    if (p.background !== undefined) tx.set(c.seq, 'background', String(p.background));
    if (p.masterGain !== undefined) {
      if (!Number.isFinite(p.masterGain)) fail('That gain is not valid.', 'gain');
      tx.set(c.seq, 'masterGain', p.masterGain);
    }
    if (p.fps !== undefined && (p.fps[0] !== c.seq.fps[0] || p.fps[1] !== c.seq.fps[1])) refps(c, p.fps);
    return {};
  };
  // Every time of the sequence moves to the nearest frame of the new rate. A clip keeps at least one frame and no more
  // source than it has; a clip that would then overlap the one before it on its track starts where that one ends.
  // Keyframes and clip markers keep their place in the timeline.
  function refps(c, fps) {
    if (!model.validFps(fps)) fail('That frame rate is not supported.', 'fps');
    const { tx, seq } = c;
    const f = time.frameTicks(fps);
    const sn = (t) => time.snap(t, fps, { nearest: true });
    const c2 = { ...c, fps, f };
    const plan = [];
    for (const tr of seq.tracks) {
      let prevEnd = 0;
      for (const x of clipsOn(c, tr.id)) {
        const s = Math.max(sn(x.start), prevEnd);
        let d = Math.max(f, sn(end(x)) - s);
        let curve = null;
        if (x.remap) {
          // the keys keep their place in the timeline, on the new frames; the length stays inside the source
          curve = R.refit(x.remap, (t) => sn(x.start + t) - s, f);
          const len = model.sourceLength(c.project, x);
          d = Math.min(d, Math.floor(R.stay(curve, 0, 1, -0.25, len + 0.25) / f + 1e-9) * f);
          if (d < f) fail('The clip is too short.', 'tooShort', x.id);
          curve.duration = d;
        } else if (!still(c2, x)) {
          d = Math.min(d, Math.floor((x.reverse ? x.out : model.sourceLength(c.project, x) - x.in) / x.speed / f + 1e-9) * f);
          if (d < f) fail('The clip is too short.', 'tooShort', x.id);
        }
        plan.push([x, s, d, curve]);
        prevEnd = s + d;
      }
    }
    tx.set(seq, 'fps', [fps[0], fps[1]]);
    for (const [x, s, d, curve] of plan) {
      const rel = (t) => sn(x.start + t) - s;
      for (const [prop, list] of Object.entries(x.keyframes)) {
        const byT = new Map();
        for (const k of list) byT.set(rel(k.t), { ...k, t: rel(k.t) });
        tx.set(x.keyframes, prop, [...byT.values()].sort((a, b) => a.t - b.t));
      }
      if (x.markers) tx.set(x, 'markers', x.markers.map((m) => ({ ...m, t: rel(m.t), duration: sn(m.duration) })));
      if (curve) setCurve(c2, x, curve);
      else if (still(c2, x) || !x.reverse) tx.set(x, 'out', x.in + d * x.speed);
      else tx.set(x, 'in', x.out - d * x.speed);
      tx.set(x, 'start', s);
      const fi = Math.min(sn(x.fadeIn), d);
      tx.set(x, 'fadeIn', fi);
      tx.set(x, 'fadeOut', Math.min(sn(x.fadeOut), d - fi));
    }
    for (const t of seq.transitions) {
      tx.set(t, 'at', sn(t.at));
      tx.set(t, 'duration', Math.max(f, sn(t.duration)));
    }
    for (const m of seq.markers) {
      tx.set(m, 't', sn(m.t));
      tx.set(m, 'duration', sn(m.duration));
    }
    for (const ct of seq.captions) {
      for (const it of ct.items) {
        const s = sn(it.start);
        const e = Math.max(s + f, sn(it.end));
        retime(tx, it, timed(it, s, e, sn));
        tx.set(it, 'start', s);
        tx.set(it, 'end', e);
      }
    }
  }

  // tracks
  H.addTrack = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    if (cmd.kind !== 'video' && cmd.kind !== 'audio') fail(`unknown track kind ${cmd.kind}`);
    const letter = cmd.kind === 'video' ? 'V' : 'A';
    let n = 1;
    while (c.seq.tracks.some((t) => t.id === `${letter}${n}`)) n++;
    const opts = clone(cmd.opts || {});
    const track = model.createTrack(cmd.kind, `${letter}${n}`, typeof opts.name === 'string' ? { name: opts.name } : {});
    const same = c.seq.tracks.filter((t) => t.kind === cmd.kind);
    const index = Math.max(0, Math.min(same.length, cmd.index ?? same.length));
    let pos;
    if (index < same.length) pos = c.seq.tracks.indexOf(same[index]);
    else if (same.length) pos = c.seq.tracks.indexOf(same[same.length - 1]) + 1;
    else pos = cmd.kind === 'video' ? 0 : c.seq.tracks.length;
    tx.splice(c.seq.tracks, pos, 0, track);
    return { id: track.id };
  };
  H.removeTrack = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const track = trackOf(c, cmd.trackId);
    for (const x of [...c.seq.clips]) if (x.track === track.id) removeFrom(c, c.seq.clips, x);
    for (const t of [...c.seq.transitions]) if (t.track === track.id) removeFrom(c, c.seq.transitions, t);
    removeFrom(c, c.seq.tracks, track);
    return {};
  };
  const TRACK_FIELDS = {
    common: { name: 'string', locked: 'boolean', syncLock: 'boolean', height: 'number' },
    video: { visible: 'boolean' },
    audio: { mute: 'boolean', solo: 'boolean', volume: 'number', pan: 'number' },
  };
  H.setTrack = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const track = trackOf(c, cmd.trackId);
    const allowed = { ...TRACK_FIELDS.common, ...TRACK_FIELDS[track.kind] };
    for (const [k, v] of Object.entries(cmd.patch || {})) {
      if (!allowed[k]) fail(`unknown track setting ${k}`);
      if (typeof v !== allowed[k] || (allowed[k] === 'number' && !Number.isFinite(v))) fail(`track setting ${k} is not a ${allowed[k]}`);
      tx.set(track, k, k === 'height' ? Math.max(16, Math.min(400, v)) : k === 'pan' ? Math.max(-100, Math.min(100, v)) : v);
    }
    return {};
  };

  // placing
  H.place = (project, tx, cmd) => placeClips(context(project, tx, cmd.seqId), cmd.opts || {});
  // Three-point edit: the source In/Out and the sequence In (or, with only a sequence Out, ending there); with only one
  // source point, the sequence In/Out gives the length.
  H.placeRange = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = { ...(cmd.opts || {}) };
    const r = o.range || {};
    if (o.in != null && o.out != null) {
      if (r.in != null) o.at = r.in;
      else if (r.out != null) o.endAt = r.out;
      else fail('Set an In or Out point in the sequence.', 'noRange');
    } else if (r.in != null && r.out != null) {
      const len = num(r.out, 'range out') - num(r.in, 'range in');
      if (len <= 0) fail('Set an In and an Out point.', 'noRange');
      if (o.out != null) o.in = Math.max(0, o.out - len);
      else {
        o.in = o.in ?? 0;
        o.out = o.in + len;
      }
      o.at = r.in;
    } else fail('Set an In and an Out point.', 'noRange');
    return placeClips(c, o);
  };

  // moving
  H.move = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const clips = withLinked(c, cmd.clipIds, o.linked !== false, true);
    if (!clips.length) return { ids: [], delta: 0 };
    for (const x of clips) unlocked(c, x.track);
    let d = frames(c, o.delta ?? 0, 'delta');
    const minStart = Math.min(...clips.map((x) => x.start));
    if (minStart + d < 0) d = -minStart;
    const td = o.trackDelta ?? 0;
    const tdOf = { video: typeof td === 'object' ? td.video ?? 0 : td, audio: typeof td === 'object' ? td.audio ?? 0 : td };
    const dest = new Map();
    for (const x of clips) {
      const tr = trackOf(c, x.track);
      const list = c.seq.tracks.filter((t) => t.kind === tr.kind);
      const i = list.indexOf(tr) + num(tdOf[tr.kind], 'trackDelta');
      if (!Number.isInteger(i) || i < 0 || i >= list.length) fail('There is no track there.', 'noTrack');
      if (list[i].locked) fail('The track is locked.', 'locked', list[i].id);
      dest.set(x, list[i].id);
    }
    if (!d && clips.every((x) => dest.get(x) === x.track)) return { ids: clips.map((x) => x.id), delta: 0 };
    const byTrack = new Map();
    for (const x of clips) {
      const id = dest.get(x);
      if (!byTrack.has(id)) byTrack.set(id, []);
      byTrack.get(id).push(x);
    }
    for (const list of byTrack.values()) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) if (end(list[i - 1]) > list[i].start) fail('Clips would overlap.', 'overlap');
    }
    const moved = new Set(clips);
    const carried = [];
    for (const t of c.seq.transitions) {
      const there = c.seq.clips.filter((x) => x.track === t.track && (x.start === t.at || end(x) === t.at));
      if (there.length && there.every((x) => moved.has(x))) {
        const to = new Set(there.map((x) => dest.get(x)));
        if (to.size === 1) carried.push({ t, track: [...to][0] });
      }
    }
    for (const { t } of carried) removeFrom(c, c.seq.transitions, t);
    for (const x of clips) removeFrom(c, c.seq.clips, x);
    if (o.insert) {
      const span = Math.max(...clips.map(end)) - minStart;
      rippleInsert(c, [...byTrack.keys()], minStart + d, span);
    } else for (const x of clips) clearRange(c, dest.get(x), x.start + d, end(x) + d);
    for (const x of clips) {
      tx.set(x, 'start', x.start + d);
      tx.set(x, 'track', dest.get(x));
      append(c, c.seq.clips, x);
    }
    for (const { t, track } of carried) {
      tx.set(t, 'at', t.at + d);
      tx.set(t, 'track', track);
      append(c, c.seq.transitions, t);
    }
    return { ids: clips.map((x) => x.id), delta: d };
  };

  // Pastes copied clips (Clip objects, as the timeline copied them) at `at`, keeping their spacing in time and between
  // tracks: the lowest copied video track lands on opts.video (else on its own track), the lowest audio one on
  // opts.audio. A clip's kind is its `kind` field, else that of its track in this sequence, else what its props say.
  // A clip copied in a sequence of another frame rate (the clipboard follows the sequence tabs): its length, fades,
  // keyframes and markers in this sequence's frames, the way a frame-rate change does (refps). Unchanged at the same
  // rate. A 31-frame clip from 30 fps pasted into 25 fps was refused as "would leave the project damaged".
  function fitToFrames(c, clip) {
    const sn = (t) => Math.round(t / c.f) * c.f;
    let d = Math.max(c.f, sn(model.clipDuration(clip)));
    if (clip.remap) {
      const curve = R.refit(clip.remap, sn, c.f);
      const len = model.sourceLength(c.project, clip);
      if (len) d = Math.min(d, Math.floor(R.stay(curve, 0, 1, -0.25, len + 0.25) / c.f + 1e-9) * c.f);
      if (d < c.f) fail('The clip is too short.', 'tooShort');
      clip.remap = { ...curve, duration: d };
      [clip.in, clip.out] = R.range(clip.remap);
      clip.speed = 1;
      clip.reverse = false;
    } else {
      if (!still(c, clip)) {
        const len = model.sourceLength(c.project, clip);
        if (len) d = Math.min(d, Math.floor((clip.reverse ? clip.out : len - clip.in) / clip.speed / c.f + 1e-9) * c.f);
        if (d < c.f) fail('The clip is too short.', 'tooShort');
      }
      if (still(c, clip) || !clip.reverse) clip.out = clip.in + d * clip.speed;
      else clip.in = clip.out - d * clip.speed;
    }
    clip.fadeIn = Math.min(sn(clip.fadeIn || 0), d);
    clip.fadeOut = Math.min(sn(clip.fadeOut || 0), d - clip.fadeIn);
    for (const [prop, list] of Object.entries(clip.keyframes || {})) {
      const byT = new Map();
      for (const k of list || []) byT.set(Math.min(d, sn(k.t)), { ...k, t: Math.min(d, sn(k.t)) });
      clip.keyframes[prop] = [...byT.values()].sort((a, b) => a.t - b.t);
    }
    if (clip.markers) clip.markers = clip.markers.map((m) => ({ ...m, t: sn(m.t), duration: sn(m.duration || 0) }));
  }
  H.paste = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const src = clone(ids(cmd.clips, 'clips'));
    if (!src.length) return { ids: [] };
    const p = at(c, o.at ?? 0);
    const minStart = Math.min(...src.map((x) => num(x.start, 'start')));
    const lists = { video: c.seq.tracks.filter((t) => t.kind === 'video'), audio: c.seq.tracks.filter((t) => t.kind === 'audio') };
    const kindOfCopy = (x) => x.kind ?? c.seq.tracks.find((t) => t.id === x.track)?.kind ?? (x.props && 'opacity' in x.props ? 'video' : 'audio');
    const indexOfCopy = (x, kind) => (Number.isInteger(x.trackIndex) ? x.trackIndex : Math.max(0, lists[kind].findIndex((t) => t.id === x.track)));
    const base = {};
    for (const x of src) {
      const kind = kindOfCopy(x);
      if (kind !== 'video' && kind !== 'audio') fail(`unknown clip kind ${kind}`);
      base[kind] = Math.min(base[kind] ?? Infinity, indexOfCopy(x, kind));
    }
    const target = {};
    for (const kind of Object.keys(base)) {
      if (o[kind] == null) target[kind] = base[kind];
      else {
        const t = trackOf(c, o[kind]);
        if (t.kind !== kind) fail('There is no track there.', 'noTrack', o[kind]);
        target[kind] = lists[kind].indexOf(t);
      }
    }
    const links = new Map();
    const groups = new Map();
    const made = [];
    for (const x of src) {
      const kind = kindOfCopy(x);
      const track = lists[kind][target[kind] + indexOfCopy(x, kind) - base[kind]];
      if (!track) fail('There is no track there.', 'noTrack');
      if (track.locked) fail('The track is locked.', 'locked', track.id);
      const source = x.source?.freeze ? { ...normSource(c, x.source), freeze: true } : normSource(c, x.source);
      const clip = model.createClip(kind, { id: null, track: track.id, start: p + at(c, x.start - minStart), in: num(x.in, 'in'), out: num(x.out, 'out'), source });
      for (const k of ['speed', 'reverse', 'enabled', 'name', 'label', 'props', 'keyframes', 'effects', 'fadeIn', 'fadeOut']) if (x[k] !== undefined) clip[k] = x[k];
      if (x.role !== undefined) clip.role = model.ROLES.includes(x.role) ? x.role : null;
      if (model.SAMPLINGS.includes(x.sampling)) clip.sampling = x.sampling;
      // a curve goes along on a video track (time remapping is video only)
      if (x.remap && kind === 'video' && !still(c, clip)) clip.remap = x.remap;
      if (x.markers) clip.markers = x.markers;
      if (Array.isArray(x.masks) && x.masks.length && kind === 'video') clip.masks = x.masks;
      fitToFrames(c, clip);
      if (x.link) {
        if (!links.has(x.link)) links.set(x.link, null);
        clip.link = x.link;
      }
      if (typeof x.group === 'string' && x.group) {
        if (!groups.has(x.group)) groups.set(x.group, null);
        clip.group = x.group;
      }
      made.push(clip);
    }
    const tracks = [...new Set(made.map((x) => x.track))];
    for (const id of tracks) {
      const list = made.filter((x) => x.track === id).sort((x, y) => x.start - y.start);
      for (let i = 1; i < list.length; i++) if (end(list[i - 1]) > list[i].start) fail('Clips would overlap.', 'overlap');
    }
    const span = Math.max(...made.map(end)) - p;
    if (o.mode === 'insert') rippleInsert(c, tracks, p, span);
    else for (const x of made) clearRange(c, x.track, x.start, end(x));
    for (const l of links.keys()) links.set(l, nid(c, 'L'));
    for (const g of groups.keys()) groups.set(g, nid(c, 'G'));
    for (const x of made) {
      x.id = nid(c, 'c');
      if (x.link) x.link = links.get(x.link);
      if (x.group) x.group = groups.get(x.group);
      for (const m of x.markers || []) m.id = nid(c, 'mk');
      append(c, c.seq.clips, x);
    }
    return { ids: made.map((x) => x.id) };
  };

  // trimming
  H.trim = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const clip = clipOf(c, cmd.clipId);
    const edge = o.edge;
    const mode = o.mode || 'normal';
    if (edge !== 'start' && edge !== 'end') fail(`unknown edge ${edge}`);
    if (!['normal', 'ripple', 'roll'].includes(mode)) fail(`unknown trim mode ${mode}`);
    const d = frames(c, o.delta ?? 0, 'delta');
    const pos = edge === 'start' ? clip.start : end(clip);
    const edgeOf = (x) => (edge === 'start' ? x.start : end(x));
    const group = [clip, ...(o.linked === false ? [] : model.linkedClips(c.seq, clip).filter((x) => edgeOf(x) === pos))];
    for (const g of group) unlocked(c, g.track);
    // The roll partner: the clip on the other side of the edit point, touching it.
    const partner = (g) => c.seq.clips.find((x) => x !== g && x.track === g.track && (edge === 'end' ? x.start === pos : end(x) === pos)) || null;

    let lo = -Infinity;
    let hi = Infinity;
    let loWhy = null;
    let hiWhy = null;
    const limit = (low, high, why) => {
      if (low > lo) { lo = low; loWhy = why; }
      if (high < hi) { hi = high; hiWhy = why; }
    };
    for (const g of group) {
      const r = room(c, g);
      const n = neighbours(c, g);
      const gd = dur(g);
      if (mode === 'roll') {
        const p = partner(g);
        // The partner's own source runs out as 'source'; the partner shrinking to one frame stops at 'neighbour'.
        if (edge === 'end') {
          limit(-(gd - c.f), Infinity, 'length');
          limit(-Infinity, r.tail, 'source');
          if (p) {
            limit(-room(c, p).head, Infinity, 'source');
            limit(-Infinity, dur(p) - c.f, 'neighbour');
          } else limit(-Infinity, n.nextStart - pos, 'neighbour');
        } else {
          limit(-Infinity, gd - c.f, 'length');
          limit(-r.head, Infinity, 'source');
          if (p) {
            limit(-Infinity, room(c, p).tail, 'source');
            limit(-(dur(p) - c.f), Infinity, 'neighbour');
          } else limit(n.prevEnd - pos, Infinity, 'neighbour');
        }
      } else if (edge === 'end') {
        limit(-(gd - c.f), Infinity, 'length');
        limit(-Infinity, r.tail, 'source');
        if (mode === 'normal') limit(-Infinity, n.nextStart - pos, 'neighbour');
      } else {
        limit(-Infinity, gd - c.f, 'length');
        limit(-r.head, Infinity, 'source');
        if (mode === 'normal') limit(n.prevEnd - pos, Infinity, 'neighbour');
      }
    }
    const applied = Math.min(Math.max(d, lo), hi);
    const clamped = applied === d ? null : d > hi ? hiWhy : loWhy;
    if (!applied) return { applied: 0, clamped };

    // Transitions on the trimmed edge go where the edge goes.
    const carried = c.seq.transitions.filter((t) => t.at === pos && group.some((g) => g.track === t.track));
    for (const t of carried) removeFrom(c, c.seq.transitions, t);
    const tracks = group.map((g) => g.track);
    if (mode === 'normal') {
      for (const g of group) (edge === 'end' ? setEnd : setStart)(c, g, pos + applied);
    } else if (mode === 'ripple') {
      if (edge === 'end') {
        if (applied > 0) {
          rippleInsert(c, tracks, pos, applied);
          for (const g of group) setEnd(c, g, pos + applied);
        } else {
          for (const g of group) setEnd(c, g, pos + applied);
          rippleRemove(c, tracks, pos + applied, pos);
        }
      } else if (applied > 0) {
        for (const g of group) setStart(c, g, pos + applied);
        rippleRemove(c, tracks, pos, pos + applied);
      } else {
        rippleInsert(c, tracks, pos, -applied);
        for (const g of group) setStart(c, g, pos);
      }
    } else {
      const partners = group.map(partner);
      group.forEach((g, i) => {
        const p = partners[i];
        if (edge === 'end') {
          if (p) setStart(c, p, pos + applied);
          setEnd(c, g, pos + applied);
        } else {
          if (p) setEnd(c, p, pos + applied);
          setStart(c, g, pos + applied);
        }
      });
    }
    const newPos = mode === 'ripple' && edge === 'start' ? pos : pos + applied;
    for (const t of carried) {
      tx.set(t, 'at', newPos);
      append(c, c.seq.transitions, t);
    }
    return { applied, clamped };
  };

  // The lowest and highest delta every limit allows, and the reason of the one a wanted delta runs into.
  function limits() {
    const r = { lo: -Infinity, hi: Infinity, loWhy: null, hiWhy: null };
    r.limit = (low, high, why) => {
      if (low > r.lo) { r.lo = low; r.loWhy = why; }
      if (high < r.hi) { r.hi = high; r.hiWhy = why; }
    };
    r.apply = (d) => {
      const applied = Math.min(Math.max(d, r.lo), r.hi);
      return { applied, clamped: applied === d ? null : d > r.hi ? r.hiWhy : r.loWhy };
    };
    return r;
  }
  // Transitions on these tracks at time p, taken off the list to be put back where the edit point goes.
  function liftTransitions(c, tracks, p) {
    const carried = c.seq.transitions.filter((t) => t.at === p && tracks.includes(t.track));
    for (const t of carried) removeFrom(c, c.seq.transitions, t);
    return carried;
  }
  function dropTransitions(c, carried, p) {
    for (const t of carried) {
      c.tx.set(t, 'at', p);
      append(c, c.seq.transitions, t);
    }
  }

  // Slip (Y): the clip keeps its place and length and shows another part of its source: in and out move by `delta`
  // timeline frames (later source for a positive delta), with the linked clips, up to the source's ends ('source').
  // Keyframes stay on the clip's frames.
  H.slip = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const clip = clipOf(c, cmd.clipId);
    if (still(c, clip)) fail('This clip has no source frames to slip.', 'still');
    const group = [clip, ...(o.linked === false ? [] : model.linkedClips(c.seq, clip).filter((x) => !still(c, x)))];
    for (const g of group) unlocked(c, g.track);
    const lim = limits();
    // a remapped clip slips its whole curve by the same source time as the timeline frames (its speeds vary)
    const per = (g) => (g.remap ? 1 : g.speed);
    for (const g of group) {
      lim.limit(-floorFrames(c, g.in / per(g)), floorFrames(c, (model.sourceLength(project, g) - g.out) / per(g)), 'source');
    }
    const r = lim.apply(frames(c, o.delta ?? 0, 'delta'));
    for (const g of group) {
      if (!r.applied) break;
      const sd = r.applied * per(g);
      if (g.remap) tx.set(g, 'remap', { ...g.remap, at: g.remap.at + sd });
      tx.set(g, 'in', g.in + sd);
      tx.set(g, 'out', g.out + sd);
    }
    return r;
  };

  // Slide (U): the clip, its content unchanged, moves by `delta`; the clip that ends where it starts and the one that
  // starts where it ends trim their touching ends with it, so the track's length stays. With no clip touching a side,
  // the clip slides into the gap there. Stops at the neighbours' sources ('source'), a neighbour of one frame
  // ('length') or the next clip beyond a gap ('neighbour'). Linked clips of the same span slide along.
  H.slide = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const clip = clipOf(c, cmd.clipId);
    const group = [clip, ...(o.linked === false ? [] : model.linkedClips(c.seq, clip).filter((x) => x.start === clip.start && end(x) === end(clip)))];
    for (const g of group) unlocked(c, g.track);
    const lim = limits();
    const plan = group.map((g) => {
      const s = g.start;
      const e = end(g);
      const prev = c.seq.clips.find((x) => x !== g && x.track === g.track && end(x) === s) || null;
      const next = c.seq.clips.find((x) => x !== g && x.track === g.track && x.start === e) || null;
      const n = neighbours(c, g);
      if (prev) {
        lim.limit(-(dur(prev) - c.f), Infinity, 'length');
        lim.limit(-Infinity, room(c, prev).tail, 'source');
      } else lim.limit(n.prevEnd - s, Infinity, 'neighbour');
      if (next) {
        lim.limit(-Infinity, dur(next) - c.f, 'length');
        lim.limit(-room(c, next).head, Infinity, 'source');
      } else lim.limit(-Infinity, n.nextStart - e, 'neighbour');
      return { g, s, e, prev, next };
    });
    const r = lim.apply(frames(c, o.delta ?? 0, 'delta'));
    if (!r.applied) return r;
    const tracks = group.map((g) => g.track);
    const atStart = liftTransitions(c, tracks, clip.start);
    const atEnd = liftTransitions(c, tracks, end(clip));
    for (const { g, s, e, prev, next } of plan) {
      if (prev) setEnd(c, prev, s + r.applied);
      if (next) setStart(c, next, e + r.applied);
      tx.set(g, 'start', s + r.applied);
    }
    dropTransitions(c, atStart, plan[0].s + r.applied);
    dropTransitions(c, atEnd, plan[0].e + r.applied);
    return r;
  };

  // Rate Stretch (R): an edge moves by `delta` and the clip's speed changes so the same source fills the new length
  // (in and out stay). Stops at the neighbour ('neighbour'), one frame ('length') and 1% to 10000% ('speed'). A still
  // has no speed: its edge is trimmed. Linked clips of the same span change with it.
  H.stretch = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const clip = clipOf(c, cmd.clipId);
    const edge = o.edge;
    if (edge !== 'start' && edge !== 'end') fail(`unknown edge ${edge}`);
    if (still(c, clip)) return H.trim(project, tx, { seqId: cmd.seqId, clipId: clip.id, opts: { edge, delta: o.delta, mode: 'normal', linked: o.linked } });
    const s0 = clip.start;
    const e0 = end(clip);
    const old = e0 - s0;
    const group = [clip, ...(o.linked === false ? [] : model.linkedClips(c.seq, clip).filter((x) => x.start === s0 && end(x) === e0 && !still(c, x)))];
    for (const g of group) unlocked(c, g.track);
    for (const g of group) if (g.remap) remapped();
    // limits on the new length, as a delta of the edge
    const sign = edge === 'end' ? 1 : -1;
    const lim = limits();
    const len = (lo, hi, why) => (sign > 0 ? lim.limit(lo - old, hi - old, why) : lim.limit(old - hi, old - lo, why));
    len(c.f, Infinity, 'length');
    for (const g of group) {
      const span = g.out - g.in;
      len(Math.max(c.f, Math.ceil(span / 100 / c.f - 1e-9) * c.f), floorFrames(c, span / 0.01), 'speed');
      const n = neighbours(c, g);
      len(-Infinity, edge === 'end' ? n.nextStart - s0 : e0 - n.prevEnd, 'neighbour');
    }
    const r = lim.apply(frames(c, o.delta ?? 0, 'delta'));
    if (!r.applied) return { ...r, speed: clip.speed };
    const nd = old + sign * r.applied;
    const carried = liftTransitions(c, group.map((g) => g.track), edge === 'end' ? e0 : s0);
    for (const g of group) {
      const speed = (g.out - g.in) / nd;
      const ratio = g.speed / speed;
      tx.set(g, 'speed', speed);
      if (edge === 'start') tx.set(g, 'start', e0 - nd);
      rescaleKeys(c, g, ratio);
      clampFades(c, g, nd);
    }
    dropTransitions(c, carried, edge === 'end' ? s0 + nd : e0 - nd);
    return { ...r, speed: clip.speed };
  };

  // Extend Edit (E): the edit point nearest t (not at t) among the given clips' edges, else among the clip edges on
  // the given tracks, moves to t: a roll where a clip touches it on the other side, else a trim of that end. One clip
  // per track at that point (the one ending there first). -> {at, applied, clamped}
  H.extendEdit = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const t = at(c, cmd.t);
    const linked = o.linked !== false;
    const open = (x) => !trackOf(c, x.track).locked;
    let clips;
    if (o.clipIds?.length) clips = ids(o.clipIds, 'clipIds').map((id) => clipOf(c, id)).filter(open);
    else {
      const tracks = (o.trackIds ?? c.seq.tracks.map((x) => x.id)).map((id) => trackOf(c, id)).filter((x) => !x.locked).map((x) => x.id);
      clips = c.seq.clips.filter((x) => tracks.includes(x.track));
    }
    const edges = clips.flatMap((x) => [{ clip: x, edge: 'end', pos: end(x) }, { clip: x, edge: 'start', pos: x.start }]);
    let p = null;
    for (const e of edges) if (e.pos !== t && (p === null || Math.abs(e.pos - t) < Math.abs(p - t))) p = e.pos;
    if (p === null) fail('There is no edit point here.', 'noEdit');
    const byTrack = new Map();
    for (const e of edges.filter((x) => x.pos === p).sort((x, y) => (x.edge === 'end' ? 0 : 1) - (y.edge === 'end' ? 0 : 1))) {
      if (!byTrack.has(e.clip.track)) byTrack.set(e.clip.track, e);
    }
    let first = null;
    let clamped = null;
    for (const { clip, edge } of byTrack.values()) {
      // A linked clip trimmed with an earlier one has already moved.
      if ((edge === 'end' ? end(clip) : clip.start) !== p) continue;
      const partner = c.seq.clips.some((x) => x !== clip && x.track === clip.track && (edge === 'end' ? x.start === p : end(x) === p));
      const r = H.trim(project, tx, { seqId: cmd.seqId, clipId: clip.id, opts: { edge, delta: t - p, mode: partner ? 'roll' : 'normal', linked } });
      if (first === null) first = r.applied;
      clamped = clamped || r.clamped;
    }
    return { at: p, applied: first ?? 0, clamped };
  };

  // cutting
  H.split = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const t = at(c, cmd.t);
    const linked = o.linked !== false;
    let clips;
    if (o.clipIds) {
      clips = withLinked(c, o.clipIds, linked);
      for (const x of clips) if (x.start < t && t < end(x) && o.clipIds.includes(x.id)) unlocked(c, x.track);
    } else {
      const tracks = new Set((o.trackIds && !o.allTracks ? o.trackIds.map((id) => trackOf(c, id)) : c.seq.tracks).filter((x) => !x.locked).map((x) => x.id));
      const under = c.seq.clips.filter((x) => tracks.has(x.track) && x.start < t && t < end(x));
      clips = linked ? withLinked(c, under.map((x) => x.id), true) : under;
    }
    clips = clips.filter((x) => x.start < t && t < end(x) && !trackOf(c, x.track).locked);
    return { ids: clips.map((x) => splitClip(c, x, t).id) };
  };
  H.remove = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const clips = withLinked(c, cmd.clipIds, o.linked !== false, true);
    for (const x of clips) unlocked(c, x.track);
    const ranges = mergeRanges(clips.map((x) => [x.start, end(x)]));
    const tracks = [...new Set(clips.map((x) => x.track))];
    for (const x of clips) removeFrom(c, c.seq.clips, x);
    if (o.ripple) for (const [a, b] of ranges.reverse()) rippleRemove(c, tracks, a, b);
    return { ids: clips.map((x) => x.id) };
  };
  // Q (before): removes from the edit point before t up to t; W (after): from t to the edit point after it. Edit points
  // are the clip edges on the targeted tracks.
  H.rippleToPlayhead = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    const t = at(c, cmd.t);
    if (cmd.side !== 'before' && cmd.side !== 'after') fail(`unknown side ${cmd.side}`);
    const tracks = (o.trackIds ?? c.seq.tracks.map((x) => x.id)).map((id) => trackOf(c, id)).filter((x) => !x.locked).map((x) => x.id);
    const on = c.seq.clips.filter((x) => tracks.includes(x.track));
    let a;
    let b;
    if (cmd.side === 'before') {
      a = -Infinity;
      for (const x of on) for (const e of [x.start, end(x)]) if (e < t && e > a) a = e;
      b = t;
    } else {
      b = Infinity;
      for (const x of on) for (const e of [x.start, end(x)]) if (e > t && e < b) b = e;
      a = t;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return { range: null };
    const involved = new Set(tracks);
    for (const x of on) if (x.start < b && end(x) > a) for (const l of model.linkedClips(c.seq, x)) involved.add(l.track);
    rippleRemove(c, [...involved], a, b);
    return { range: [a, b] };
  };
  H.closeGap = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    unlocked(c, cmd.trackId);
    const t = at(c, cmd.t);
    const list = clipsOn(c, cmd.trackId);
    if (list.some((x) => x.start <= t && t < end(x))) fail('There is no gap here.', 'noGap');
    const next = list.find((x) => x.start > t);
    if (!next) fail('There is no gap here.', 'noGap');
    const a = Math.max(0, ...list.filter((x) => end(x) <= t).map(end));
    const b = next.start;
    for (const id of rippleTracks(c, [cmd.trackId])) {
      if (id !== cmd.trackId && c.seq.clips.some((x) => x.track === id && x.start < b && end(x) > a)) fail('The gap cannot be closed: a sync-locked track has clips in it.', 'gapBlocked', id);
    }
    for (const ct of c.seq.captions) {
      if (ct.syncLock && ct.items.some((it) => it.start < b && it.end > a)) fail('The gap cannot be closed: a sync-locked track has clips in it.', 'gapBlocked', ct.id);
    }
    rippleRemove(c, [cmd.trackId], a, b);
    return { range: [a, b] };
  };
  function rangeTracks(c, cmd) {
    const a = at(c, cmd.in, 'in');
    const b = at(c, cmd.out, 'out');
    if (b <= a) fail('Set an In and an Out point.', 'noRange');
    const tracks = (cmd.trackIds ?? c.seq.tracks.map((x) => x.id)).map((id) => trackOf(c, id)).filter((x) => !x.locked).map((x) => x.id);
    return { a, b, tracks };
  }
  H.lift = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const { a, b, tracks } = rangeTracks(c, cmd);
    for (const id of tracks) clearRange(c, id, a, b);
    return { range: [a, b] };
  };
  H.extract = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const { a, b, tracks } = rangeTracks(c, cmd);
    for (const id of tracks) clearRange(c, id, a, b);
    rippleRemove(c, tracks, a, b);
    return { range: [a, b] };
  };

  // Speed/Duration, reverse and the Rate Stretch tool leave a remapped clip alone, as Premiere greys them out: its speed
  // is the Time Remapping curve's.
  const remapped = () => fail('This clip has Time Remapping. Change its speed with Time Remapping.', 'remap');

  // clip settings
  const CLIP_FIELDS = ['props', 'speed', 'duration', 'ripple', 'reverse', 'enabled', 'name', 'label', 'role', 'fadeIn', 'fadeOut', 'sampling'];
  function roleOf(x) {
    if (x !== null && !model.ROLES.includes(x)) fail(`unknown clip role ${x}`);
    return x;
  }
  H.setClip = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    const p = clone(cmd.patch || {});
    const linked = cmd.opts?.linked !== false;
    for (const k of Object.keys(p)) if (!CLIP_FIELDS.includes(k)) fail(`unknown clip setting ${k}`);
    const kind = kindOf(c, clip);
    unlocked(c, clip.track);
    if (p.props) {
      const allowed = kind === 'audio' ? model.AUDIO_PROPS : model.VIDEO_PROPS;
      for (const [k, v] of Object.entries(p.props)) {
        if (!allowed.includes(k)) fail(`unknown property ${k}`);
        tx.set(clip.props, k, v);
      }
    }
    if (p.name !== undefined) tx.set(clip, 'name', String(p.name));
    if (p.label !== undefined) tx.set(clip, 'label', p.label === null ? null : String(p.label));
    if (p.role !== undefined) tx.set(clip, 'role', roleOf(p.role));
    if (p.enabled !== undefined) tx.set(clip, 'enabled', !!p.enabled);
    if (p.sampling !== undefined) {
      if (!model.SAMPLINGS.includes(p.sampling)) fail(`unknown frame sampling ${p.sampling}`);
      tx.set(clip, 'sampling', p.sampling);
    }
    if (p.reverse !== undefined) {
      const group = [clip, ...(linked ? model.linkedClips(c.seq, clip) : [])];
      for (const g of group) unlocked(c, g.track);
      for (const g of group) if (g.remap && !!p.reverse !== g.reverse) remapped();
      for (const g of group) tx.set(g, 'reverse', !!p.reverse);
    }
    if (p.speed !== undefined && p.duration !== undefined) fail('give a speed or a duration');
    if (p.speed !== undefined) setSpeed(c, clip, num(p.speed, 'speed'), !!p.ripple, linked);
    // A duration sets the speed that shows the same source in that time (Speed/Duration with the length field).
    if (p.duration !== undefined) {
      const d = Math.max(c.f, frames(c, p.duration, 'duration'));
      if (clip.remap) remapped();
      if (still(c, clip)) setLength(c, clip, d, !!p.ripple, linked);
      else setSpeed(c, clip, (clip.out - clip.in) / d, !!p.ripple, linked, d);
    }
    for (const k of ['fadeIn', 'fadeOut']) {
      if (p[k] === undefined) continue;
      const v = Math.max(0, frames(c, p[k], k));
      const d = dur(clip);
      if (k === 'fadeIn') {
        tx.set(clip, 'fadeIn', Math.min(v, d));
        tx.set(clip, 'fadeOut', Math.min(clip.fadeOut, d - clip.fadeIn));
      } else tx.set(clip, 'fadeOut', Math.min(v, d - clip.fadeIn));
    }
    return {};
  };
  // Speed keeps the clip's start and the source span it shows, so its length changes; without ripple it cannot grow
  // into the next clip (it shows less source instead). Keyframes stay on their source frames.
  // A still's length is its end edge (a normal or ripple trim).
  function setLength(c, clip, d, ripple, linked) {
    H.trim(c.project, c.tx, { seqId: c.seq.id, clipId: clip.id, opts: { edge: 'end', delta: d - dur(clip), mode: ripple ? 'ripple' : 'normal', linked } });
  }
  // Keyframes and clip markers of a clip whose speed changed by `ratio` (old / new) stay on their source frames.
  function rescaleKeys(c, g, ratio) {
    for (const [prop, list] of Object.entries(g.keyframes)) {
      const byT = new Map();
      for (const k of list) {
        const t = Math.round((k.t * ratio) / c.f) * c.f;
        byT.set(t, { ...k, t });
      }
      c.tx.set(g.keyframes, prop, [...byT.values()].sort((a, b) => a.t - b.t));
    }
    if (g.markers) c.tx.set(g, 'markers', g.markers.map((m) => ({ ...m, t: Math.round((m.t * ratio) / c.f) * c.f })));
  }
  function setSpeed(c, clip, speed, ripple, linked, wantDur) {
    if (speed < 0.01 || speed > 100) fail('Speed must be between 1% and 10000%.', 'speed');
    const group = [clip, ...(linked ? model.linkedClips(c.seq, clip).filter((x) => x.start === clip.start && end(x) === end(clip)) : [])];
    for (const g of group) unlocked(c, g.track);
    for (const g of group) if (g.remap) remapped();
    const old = dur(clip);
    const pos = end(clip);
    let nd = old;
    if (!still(c, clip)) {
      nd = wantDur ?? Math.max(c.f, Math.round((clip.out - clip.in) / speed / c.f) * c.f);
      for (const g of group) {
        nd = Math.min(nd, floorFrames(c, (g.reverse ? g.out : model.sourceLength(c.project, g) - g.in) / speed));
      }
    }
    if (!ripple) for (const g of group) nd = Math.min(nd, floorFrames(c, neighbours(c, g).nextStart - g.start));
    if (nd < c.f) fail('The clip is too short.', 'tooShort');
    const L = nd - old;
    const tracks = group.map((g) => g.track);
    const carried = c.seq.transitions.filter((t) => t.at === pos && tracks.includes(t.track));
    for (const t of carried) removeFrom(c, c.seq.transitions, t);
    if (ripple && L > 0) rippleInsert(c, tracks, pos, L);
    for (const g of group) {
      const ratio = g.speed / speed;
      c.tx.set(g, 'speed', speed);
      if (still(c, g) || !g.reverse) c.tx.set(g, 'out', g.in + nd * speed);
      else c.tx.set(g, 'in', g.out - nd * speed);
      rescaleKeys(c, g, ratio);
      clampFades(c, g, nd);
    }
    if (ripple && L < 0) rippleRemove(c, tracks, pos + L, pos);
    for (const t of carried) {
      c.tx.set(t, 'at', clip.start + nd);
      append(c, c.seq.transitions, t);
    }
  }
  // Time Remapping (Premiere's Time Remapping > Speed): the clip plays curve `remap` (remap.js; frames of this
  // sequence) from now on, or with null a constant speed again (the speed at its start, the length kept as far as the
  // source goes). Only the video clip changes: its linked audio keeps its speed, as in Premiere. The clip keeps its
  // start; as in Premiere it does not push the clips after it: a longer curve grows the clip up to the next clip
  // ('neighbour') and the rest waits past the clip's end, the way source past an out point does. It also stops where
  // the curve leaves the source ('source'). A transition at the clip's end moves with it.
  // -> { duration, clamped: 'neighbour' | 'source' | null }
  H.setRemap = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    if (kindOf(c, clip) !== 'video') fail('Time Remapping is for video clips.', 'remap');
    if (still(c, clip)) fail('This clip has no source frames to remap.', 'still');
    const old = dur(clip);
    let r;
    if (cmd.remap == null) {
      if (!clip.remap) return { duration: old, clamped: null };
      const v = R.speedAt(clip.remap, 0) || 1;
      r = R.constant(clip.remap.at, Math.sign(v) * Math.min(R.MAX, Math.max(R.MIN, Math.abs(v))), old);
    } else {
      const x = cmd.remap;
      if (!x || typeof x !== 'object' || !Array.isArray(x.speeds) || !Array.isArray(x.keys)) fail('invalid time remapping');
      r = {
        at: num(x.at, 'at'),
        speeds: x.speeds.map((v) => num(v, 'speed')),
        keys: x.keys.map((k) => ({ t: Math.max(0, frames(c, k?.t, 'key time')), ramp: Math.max(0, frames(c, k?.ramp ?? 0, 'ramp')) })),
        duration: Math.max(c.f, frames(c, x.duration, 'duration')),
      };
      if (r.speeds.some((v) => Math.abs(v) > R.MAX + 1e-9)) fail('Speed must be between 1% and 10000%.', 'speed');
      if (!R.valid(r, c.f)) fail('invalid time remapping');
    }
    const len = model.sourceLength(project, clip);
    const s0 = R.value(r, 0);
    if (s0 < -0.5 || s0 > len + 0.5) fail('The source has no frames there.', 'source');
    const lim = limits();
    lim.limit(-Infinity, floorFrames(c, R.stay(r, 0, 1, -0.25, len + 0.25)), 'source');
    lim.limit(-Infinity, floorFrames(c, neighbours(c, clip).nextStart - clip.start), 'neighbour');
    const got = lim.apply(r.duration);
    if (got.applied < c.f) fail('The clip is too short.', 'tooShort');
    const carried = got.applied !== old ? liftTransitions(c, [clip.track], end(clip)) : [];
    setCurve(c, clip, R.withDuration(r, got.applied));
    clampFades(c, clip, got.applied);
    dropTransitions(c, carried, clip.start + got.applied);
    return { duration: got.applied, clamped: got.clamped };
  };
  H.setKeyframes = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    if (!model.validPropPath(clip, kindOf(c, clip), cmd.prop)) fail(`the clip has no property ${cmd.prop}`);
    const list = cmd.keyframes;
    if (list == null || (Array.isArray(list) && !list.length)) {
      tx.del(clip.keyframes, cmd.prop);
      return {};
    }
    const byT = new Map();
    for (const k of ids(list, 'keyframes')) {
      const ease = k.ease ?? 'linear';
      if (!model.EASES.includes(ease)) fail(`unknown ease ${ease}`);
      const t = frames(c, k.t, 'keyframe time');
      const kf = { t, v: clone(k.v), ease };
      if (ease === 'bezier') kf.h = ids(k.h, 'bezier handles').slice(0, 4);
      byT.set(t, kf);
    }
    tx.set(clip.keyframes, cmd.prop, [...byT.values()].sort((a, b) => a.t - b.t));
    return {};
  };
  H.link = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clips = [...new Set(ids(cmd.clipIds, 'clipIds').map((id) => clipOf(c, id)))];
    if (clips.length < 2) fail('Choose two or more clips to link.', 'linkOne');
    const link = nid(c, 'L');
    for (const x of clips) tx.set(x, 'link', link);
    return { link };
  };
  H.unlink = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    for (const id of ids(cmd.clipIds, 'clipIds')) tx.set(clipOf(c, id), 'link', null);
    return {};
  };
  // A group (Ctrl+G) moves and is removed as one (move and remove take every member, unless linked: false); unlike a
  // link it never trims, splits or changes speed together. A clip is in one group: grouping again makes a new one.
  H.group = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clips = [...new Set(ids(cmd.clipIds, 'clipIds').map((id) => clipOf(c, id)))];
    if (clips.length < 2) fail('Choose two or more clips to group.', 'groupOne');
    const group = nid(c, 'G');
    for (const x of clips) tx.set(x, 'group', group);
    return { group };
  };
  // Ungroup (Ctrl+Shift+G): the groups of the given clips, every member.
  H.ungroup = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const groups = new Set(ids(cmd.clipIds, 'clipIds').map((id) => clipOf(c, id).group).filter(Boolean));
    for (const x of c.seq.clips) if (x.group && groups.has(x.group)) tx.set(x, 'group', null);
    return { groups: [...groups] };
  };
  // What the clips' sound is (dialogue, music, effects, ambience or null), for the automation; linked clips too.
  H.setRole = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const role = roleOf(cmd.role ?? null);
    const clips = withLinked(c, cmd.clipIds, cmd.opts?.linked !== false);
    for (const x of clips) unlocked(c, x.track);
    for (const x of clips) tx.set(x, 'role', role);
    return { ids: clips.map((x) => x.id) };
  };
  // Audio clips take their sound from another media file whose time runs as theirs does (Isolate Voice's vocals): in,
  // out, speed, keyframes, effects, links and groups stay.
  H.replaceAudio = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const m = mediaById(c, cmd.mediaId);
    if (!m.audio) fail('The media has no sound.', 'noAudio');
    const clips = ids(cmd.clipIds, 'clipIds').map((id) => clipOf(c, id));
    for (const x of clips) {
      if (kindOf(c, x) !== 'audio' || x.source?.media == null) fail('Only audio clips of a media file can take another sound.', 'notAudio');
      unlocked(c, x.track);
      if (Math.max(x.in, x.out) > m.duration + 0.5) fail('The new sound is shorter than the clip.', 'tooShort');
    }
    for (const x of clips) tx.set(x, 'source', { media: m.id });
    return { ids: clips.map((x) => x.id) };
  };

  // effects
  function effectOf(c, clip, id) {
    const e = clip.effects.find((x) => x.id === id);
    if (!e) fail(`there is no effect ${id}`, 'notFound');
    return e;
  }
  H.addEffect = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    if (typeof cmd.effectType !== 'string' || !cmd.effectType) fail('the effect has no type');
    let n = 1;
    for (const e of clip.effects) {
      const m = /^e(\d+)$/.exec(e.id);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    const effect = { id: `e${n}`, type: cmd.effectType, on: true, params: clone(cmd.params || {}) };
    const index = cmd.index == null ? clip.effects.length : Math.max(0, Math.min(clip.effects.length, cmd.index));
    tx.splice(clip.effects, index, 0, effect);
    return { id: effect.id };
  };
  H.removeEffect = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    const e = effectOf(c, clip, cmd.effectId);
    for (const prop of Object.keys(clip.keyframes)) if (prop.startsWith(`effects.${e.id}.`)) tx.del(clip.keyframes, prop);
    removeFrom(c, clip.effects, e);
    return {};
  };
  H.setEffect = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    const e = effectOf(c, clip, cmd.effectId);
    const p = cmd.patch || {};
    if (p.on !== undefined) tx.set(e, 'on', !!p.on);
    for (const [k, v] of Object.entries(p.params || {})) {
      if (v === null || v === undefined) tx.del(e.params, k);
      else tx.set(e.params, k, clone(v));
    }
    return {};
  };
  // masks (masks.js): Opacity's (opts.effectId null) or an effect's, on a video clip
  function maskHolder(c, clip, effectId) {
    if (kindOf(c, clip) !== 'video') fail('Masks go on video clips.', 'notVideo');
    if (effectId == null) return clip;
    const e = effectOf(c, clip, effectId);
    const def = req('effects')?.get?.(e.type);
    if (!def || def.kind !== 'video' || def.masks === false) fail('This effect takes no masks.', 'noMasks');
    return e;
  }
  function maskOf(holder, id) {
    const m = (holder.masks || []).find((x) => x.id === id);
    if (!m) fail(`there is no mask ${id}`, 'notFound');
    return m;
  }
  H.addMask = (project, tx, cmd) => {
    const M = req('masks');
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    const holder = maskHolder(c, clip, cmd.opts?.effectId);
    if ((holder.masks || []).length >= M.MAX_MASKS) fail('There are as many masks as there can be.', 'tooMany');
    const mask = M.full({ ...clone(cmd.mask || {}), id: M.nextId(clip) });
    if (!M.valid(mask)) fail(`the mask is not valid: ${M.problem(mask)}`, 'invalid');
    if (holder.masks) append(c, holder.masks, mask);
    else tx.set(holder, 'masks', [mask]);
    return { id: mask.id };
  };
  H.setMask = (project, tx, cmd) => {
    const M = req('masks');
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    const m = maskOf(maskHolder(c, clip, cmd.opts?.effectId), cmd.maskId);
    const patch = cmd.patch || {};
    const next = { ...m };
    for (const k of ['mode', 'inverted', ...M.FIELDS]) if (patch[k] !== undefined) next[k] = clone(patch[k]);
    if (!M.valid(next)) fail(`the mask is not valid: ${M.problem(next)}`, 'invalid');
    for (const k of ['mode', 'inverted', ...M.FIELDS]) if (patch[k] !== undefined) tx.set(m, k, next[k]);
    return {};
  };
  H.removeMask = (project, tx, cmd) => {
    const M = req('masks');
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    const holder = maskHolder(c, clip, cmd.opts?.effectId);
    const m = maskOf(holder, cmd.maskId);
    const prefix = `${M.prefixOf(cmd.opts?.effectId)}.${m.id}.`;
    for (const prop of Object.keys(clip.keyframes)) if (prop.startsWith(prefix)) tx.del(clip.keyframes, prop);
    if (holder.masks.length === 1) tx.del(holder, 'masks');
    else removeFrom(c, holder.masks, m);
    return {};
  };
  H.moveEffect = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    unlocked(c, clip.track);
    const e = effectOf(c, clip, cmd.effectId);
    const to = Math.max(0, Math.min(clip.effects.length - 1, num(cmd.index, 'index')));
    if (clip.effects.indexOf(e) === to) return {};
    removeFrom(c, clip.effects, e);
    tx.splice(clip.effects, to, 0, e);
    return {};
  };

  // transitions
  function transitionOf(c, id) {
    const t = c.seq.transitions.find((x) => x.id === id);
    if (!t) fail(`there is no transition ${id}`, 'notFound');
    return t;
  }
  // The longest a transition at `at` with `align` may be without overlapping another on its track. Where two overlapped,
  // the compositor showed only the first in the list: a 4-frame clip between two 30-frame dissolves cut the first one
  // off at 17 %.
  function roomFor(c, track, at, align, except) {
    const [k1, k2] = align === 'start' ? [0, 1] : align === 'end' ? [1, 0] : [0.5, 0.5];
    let room = Infinity;
    for (const t of c.seq.transitions) {
      if (t.track !== track || t.id === except || t.at === at) continue;
      const [a, b] = [t.align === 'start' ? t.at : t.align === 'end' ? t.at - t.duration : t.at - t.duration / 2, t.align === 'start' ? t.at + t.duration : t.align === 'end' ? t.at : t.at + t.duration / 2];
      if (b <= at && k1) room = Math.min(room, (at - b) / k1);
      if (a >= at && k2) room = Math.min(room, (a - at) / k2);
      if (a < at && b > at) room = 0;
    }
    return room;
  }
  function fitTransition(c, track, at, align, d, except) {
    const room = roomFor(c, track, at, align, except);
    if (room === Infinity || d <= room) return d;
    const fit = Math.floor(room / c.f + 1e-9) * c.f;
    if (fit < c.f) fail('There is no room for a transition here: the transitions beside it reach this edit point.', 'noRoom');
    return fit;
  }
  H.addTransition = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = clone(cmd.opts || {});
    unlocked(c, o.track);
    const p = at(c, o.at);
    if (!c.seq.clips.some((x) => x.track === o.track && (x.start === p || end(x) === p))) fail('Transitions go on an edit point or a clip end.', 'noEdge');
    if (typeof o.type !== 'string' || !o.type) fail('the transition has no type');
    const align = o.align ?? 'center';
    if (!model.ALIGNS.includes(align)) fail(`unknown alignment ${align}`);
    const d = fitTransition(c, o.track, p, align, Math.max(c.f, frames(c, o.duration ?? project.settings.transitionDuration, 'duration')));
    for (const t of [...c.seq.transitions]) if (t.track === o.track && t.at === p) removeFrom(c, c.seq.transitions, t);
    const t = { id: nid(c, 't'), track: o.track, at: p, type: o.type, duration: d, align, params: o.params || {} };
    append(c, c.seq.transitions, t);
    return { id: t.id };
  };
  H.removeTransition = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const t = transitionOf(c, cmd.id);
    unlocked(c, t.track);
    removeFrom(c, c.seq.transitions, t);
    return {};
  };
  H.setTransition = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const t = transitionOf(c, cmd.id);
    unlocked(c, t.track);
    const p = cmd.patch || {};
    for (const k of Object.keys(p)) if (!['type', 'duration', 'align', 'params'].includes(k)) fail(`unknown transition setting ${k}`);
    if (p.type !== undefined) tx.set(t, 'type', String(p.type));
    if (p.align !== undefined && !model.ALIGNS.includes(p.align)) fail(`unknown alignment ${p.align}`);
    const align = p.align ?? t.align;
    if (p.duration !== undefined || p.align !== undefined) {
      const d = p.duration !== undefined ? Math.max(c.f, frames(c, p.duration, 'duration')) : t.duration;
      tx.set(t, 'duration', fitTransition(c, t.track, t.at, align, d, t.id));
    }
    if (p.align !== undefined) tx.set(t, 'align', p.align);
    for (const [k, v] of Object.entries(p.params || {})) {
      if (v === null || v === undefined) tx.del(t.params, k);
      else tx.set(t.params, k, clone(v));
    }
    return {};
  };

  // text, generators, freeze frame
  H.addGenerated = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = cmd.opts || {};
    if (!o.source || typeof o.source.generator !== 'string') fail('the source is not a generator');
    const d = o.duration ?? project.settings.stillDuration;
    const r = placeClips(c, { source: o.source, in: 0, out: d, at: o.at ?? 0, video: o.track, audio: null, mode: o.mode, name: o.name });
    return { id: r.ids[0] };
  };
  function generatorClip(c, id, kind) {
    const clip = clipOf(c, id);
    if (!model.isGenerator(clip) || (kind && clip.source.generator !== kind)) fail(`clip ${id} is not a ${kind || 'generator'} clip`);
    unlocked(c, clip.track);
    return clip;
  }
  function layerOf(clip, id) {
    const l = clip.source.layers.find((x) => x.id === id);
    if (!l) fail(`there is no layer ${id}`, 'notFound');
    return l;
  }
  const dropLayerKeys = (c, clip, id) => { for (const prop of Object.keys(clip.keyframes)) if (prop.startsWith(`layers.${id}.`)) c.tx.del(clip.keyframes, prop); };
  // A solid's color, or all the layers of a text clip at once.
  H.setGenerator = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = generatorClip(c, cmd.clipId);
    const p = clone(cmd.patch || {});
    for (const k of Object.keys(p)) if (!['color', 'layers'].includes(k)) fail(`unknown generator setting ${k}`);
    if (p.color !== undefined) {
      if (clip.source.generator !== 'solid') fail('only a solid has a color');
      tx.set(clip.source, 'color', String(p.color));
    }
    if (p.layers !== undefined) {
      if (clip.source.generator !== 'text' && clip.source.generator !== 'graphic') fail('only a text or graphic clip has layers');
      const layers = normSource(c, { generator: clip.source.generator, layers: p.layers }).layers;
      for (const l of clip.source.layers) if (!layers.some((x) => x.id === l.id)) dropLayerKeys(c, clip, l.id);
      tx.set(clip.source, 'layers', layers);
    }
    return {};
  };
  const LAYER_FIELDS = Object.keys(model.createTextLayer()).filter((k) => k !== 'id');
  H.setLayer = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = generatorClip(c, cmd.clipId);
    const layer = layerOf(clip, cmd.layerId);
    if (clip.source.generator === 'graphic') {
      const patch = clone(cmd.patch || {});
      if (patch.id !== undefined || (patch.kind !== undefined && patch.kind !== layer.kind)) fail('a layer keeps its id and kind');
      const next = clip.source.layers.map((l) => (l === layer ? { ...l, ...patch } : l));
      const errors = graphic().validate(next);
      if (errors.length) fail(`the graphic is not valid: ${errors.join('; ')}`, 'badGraphic');
      for (const [k, v] of Object.entries(patch)) if (k !== 'kind') tx.set(layer, k, v);
      return {};
    }
    if (clip.source.generator !== 'text') fail(`clip ${cmd.clipId} has no layers`);
    for (const [k, v] of Object.entries(clone(cmd.patch || {}))) {
      if (!LAYER_FIELDS.includes(k)) fail(`unknown text layer field ${k}`);
      tx.set(layer, k, v);
    }
    return {};
  };
  H.addLayer = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = generatorClip(c, cmd.clipId);
    if (clip.source.generator !== 'text' && clip.source.generator !== 'graphic') fail(`clip ${cmd.clipId} has no layers`);
    const index = cmd.index == null ? clip.source.layers.length : Math.max(0, Math.min(clip.source.layers.length, cmd.index));
    if (clip.source.generator === 'graphic') {
      const given = clone(cmd.layer || {});
      let id = typeof given.id === 'string' ? given.id : null;
      if (!id) { let n = clip.source.layers.length + 1; while (clip.source.layers.some((l) => l.id === `g${n}`)) n++; id = `g${n}`; }
      const next = [...clip.source.layers];
      next.splice(index, 0, { ...given, id });
      const errors = graphic().validate(next);
      if (errors.length) fail(`the graphic is not valid: ${errors.join('; ')}`, 'badGraphic');
      tx.splice(clip.source.layers, index, 0, graphic().normalize({ ...given, id }));
      return { id };
    }
    let n = clip.source.layers.length + 1;
    while (clip.source.layers.some((l) => l.id === `l${n}`)) n++;
    const layer = model.createTextLayer({ ...clone(cmd.layer || {}), id: `l${n}` });
    tx.splice(clip.source.layers, index, 0, layer);
    return { id: layer.id };
  };
  H.removeLayer = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = generatorClip(c, cmd.clipId);
    const layer = layerOf(clip, cmd.layerId);
    if (clip.source.generator === 'graphic') {
      const next = clip.source.layers.filter((l) => l !== layer);
      if (!next.length) fail('a graphic keeps one layer at least');
      if (next.some((l) => l.parent === layer.id)) fail(`layer ${layer.id} is the parent of other layers; remove or move them first`);
    } else if (clip.source.generator !== 'text') fail(`clip ${cmd.clipId} has no layers`);
    dropLayerKeys(c, clip, layer.id);
    removeFrom(c, clip.source.layers, layer);
    return {};
  };
  // Cuts the clip at t and puts a still of the frame at t there for `duration`, pushing the rest of the clip (and its
  // linked clips, and the sync-locked tracks) later.
  H.freezeFrame = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = clipOf(c, cmd.clipId);
    const media = model.mediaOf(project, clip);
    if (kindOf(c, clip) !== 'video' || !media || still(c, clip)) fail('This clip has no frame to freeze.', 'noFrame');
    unlocked(c, clip.track);
    const p = at(c, cmd.t);
    if (p < clip.start || p >= end(clip)) fail('The playhead is not on the clip.', 'notOnClip');
    const d = Math.max(c.f, frames(c, cmd.duration ?? project.settings.freezeDuration, 'duration'));
    const src = model.sourceTime(clip, p);
    const off = p - clip.start;
    const frozen = {};
    for (const [prop, list] of Object.entries(clip.keyframes)) frozen[prop] = [{ t: 0, v: keyframes.valueAt(list, off), ease: 'linear' }];
    const tracks = [clip.track, ...model.linkedClips(c.seq, clip).map((x) => x.track)];
    rippleInsert(c, tracks, p, d);
    const fz = model.createClip('video', { id: nid(c, 'c'), track: clip.track, start: p, in: src, out: src + d, source: { media: media.id, freeze: true }, name: clip.name });
    fz.label = clip.label;
    fz.enabled = clip.enabled;
    fz.props = clone(clip.props);
    fz.effects = clone(clip.effects);
    if (clip.masks) fz.masks = clone(clip.masks);
    fz.keyframes = clone(frozen);
    append(c, c.seq.clips, fz);
    return { id: fz.id };
  };

  // markers: sequence markers, or clip markers (opts.clipId) whose times count from the clip's start
  function markerOf(c, id) {
    const m = c.seq.markers.find((x) => x.id === id);
    if (m) return { m, list: c.seq.markers, clip: null };
    for (const x of c.seq.clips) {
      const cm = (x.markers || []).find((k) => k.id === id);
      if (cm) return { m: cm, list: x.markers, clip: x };
    }
    return fail(`there is no marker ${id}`, 'notFound');
  }
  function markerFields(c, src, base) {
    const out = {};
    if (src.duration !== undefined) out.duration = Math.max(0, frames(c, src.duration, 'duration'));
    for (const k of ['name', 'note', 'color']) if (src[k] !== undefined) out[k] = String(src[k]);
    if (src.kind !== undefined) {
      if (!model.MARKER_KINDS.includes(src.kind)) fail(`unknown marker kind ${src.kind}`);
      out.kind = src.kind;
    }
    return { ...base, ...out };
  }
  H.addMarker = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const src = clone(cmd.marker || {});
    const clip = cmd.opts?.clipId != null ? clipOf(c, cmd.opts.clipId) : null;
    const t = at(c, src.t ?? (clip ? clip.start : 0));
    const m = markerFields(c, src, { id: nid(c, 'mk'), t: clip ? t - clip.start : t, duration: 0, name: '', note: '', kind: 'comment', color: 'green' });
    if (clip) {
      if (!clip.markers) tx.set(clip, 'markers', []);
      insertSorted(c, clip.markers, m, 't');
    } else insertSorted(c, c.seq.markers, m, 't');
    return { id: m.id };
  };
  H.setMarker = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const { m, list, clip } = markerOf(c, cmd.id);
    const p = clone(cmd.patch || {});
    for (const k of Object.keys(p)) if (!['t', 'duration', 'name', 'note', 'kind', 'color'].includes(k)) fail(`unknown marker field ${k}`);
    const next = markerFields(c, p, {});
    for (const [k, v] of Object.entries(next)) tx.set(m, k, v);
    if (p.t !== undefined) {
      tx.set(m, 't', at(c, p.t) - (clip ? clip.start : 0));
      removeFrom(c, list, m);
      insertSorted(c, list, m, 't');
    }
    return {};
  };
  H.removeMarker = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const { m, list } = markerOf(c, cmd.id);
    removeFrom(c, list, m);
    return {};
  };

  // captions
  function captionTrackOf(c, id) {
    const ct = c.seq.captions.find((x) => x.id === id);
    if (!ct) fail(`there is no caption track ${id}`, 'notFound');
    return ct;
  }
  function captionItem(c, it) {
    if (!it || typeof it !== 'object') fail('a caption is not an object');
    const start = near(c, it.start, 'caption start');
    const e = near(c, it.end, 'caption end');
    const out = { start, end: e > start ? e : start + c.f, text: String(it.text ?? '') };
    if (it.doubt != null) {
      if (!model.validDoubt(it.doubt)) fail('a caption\'s doubt is not valid');
      if (it.doubt.length) out.doubt = clone(it.doubt);
    }
    // word timings fitted to the text: the words that match keep their time; none when they cannot be fitted
    if (it.words != null) {
      const words = cw().realign(it.words, out.text, { frame: c.f, duration: out.end - out.start });
      if (words) out.words = words;
    }
    // who says it (an id of project.speakers' list): its color and name when the track shows them
    if (it.speaker != null) {
      if (typeof it.speaker !== 'string' || !/^sp\d+$/.test(it.speaker)) fail('a caption\'s speaker is not valid');
      out.speaker = it.speaker;
    }
    return out;
  }
  H.addCaptionTrack = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = clone(cmd.opts || {});
    const ct = {
      id: nid(c, 'cc'), lang: String(o.lang ?? 'ko'), name: String(o.name ?? 'Captions'), style: { ...model.defaultCaptionStyle(), ...(o.style || {}) },
      syncLock: o.syncLock !== false, items: [],
    };
    for (const it of (o.items || []).map((x) => captionItem(c, x)).sort((a, b) => a.start - b.start)) ct.items.push({ id: nid(c, 'cap'), ...it });
    append(c, c.seq.captions, ct);
    return { id: ct.id };
  };
  H.setCaptionTrack = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const ct = captionTrackOf(c, cmd.trackId);
    const p = clone(cmd.patch || {});
    for (const k of Object.keys(p)) if (!['lang', 'name', 'style', 'syncLock'].includes(k)) fail(`unknown caption track setting ${k}`);
    if (p.lang !== undefined) tx.set(ct, 'lang', String(p.lang));
    if (p.name !== undefined) tx.set(ct, 'name', String(p.name));
    if (p.syncLock !== undefined) tx.set(ct, 'syncLock', !!p.syncLock);
    for (const [k, v] of Object.entries(p.style || {})) {
      if (v === null) tx.del(ct.style, k);
      else tx.set(ct.style, k, v);
    }
    return {};
  };
  H.removeCaptionTrack = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    removeFrom(c, c.seq.captions, captionTrackOf(c, cmd.trackId));
    return {};
  };
  H.setCaptions = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const ct = captionTrackOf(c, cmd.trackId);
    const items = ids(cmd.items, 'items').map((x) => captionItem(c, x)).sort((a, b) => a.start - b.start);
    tx.set(ct, 'items', items.map((it) => ({ id: nid(c, 'cap'), ...it })));
    return { ids: ct.items.map((it) => it.id) };
  };
  H.addCaption = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const ct = captionTrackOf(c, cmd.trackId);
    const it = { id: nid(c, 'cap'), ...captionItem(c, cmd.item) };
    insertSorted(c, ct.items, it, 'start');
    return { id: it.id };
  };
  function captionOf(c, ct, id) {
    const it = ct.items.find((x) => x.id === id);
    if (!it) fail(`there is no caption ${id}`, 'notFound');
    return it;
  }
  H.setCaption = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const ct = captionTrackOf(c, cmd.trackId);
    const it = captionOf(c, ct, cmd.itemId);
    const p = cmd.patch || {};
    for (const k of Object.keys(p)) if (!['start', 'end', 'text', 'doubt', 'words', 'speaker'].includes(k)) fail(`unknown caption field ${k}`);
    // A person who changed the text has heard it: the doubt goes, unless the patch says what it is (null: none).
    let doubt = p.doubt !== undefined ? p.doubt : p.text !== undefined && String(p.text) !== it.text ? null : it.doubt;
    // Word timings and doubt (unless the patch gives them): a caption moved (start and end by the same time) takes
    // them along; a trimmed start leaves them where they are spoken. captionItem fits the words to a changed text.
    let words = p.words !== undefined ? p.words : it.words;
    const s = near(c, p.start ?? it.start, 'caption start');
    const e = p.end !== undefined ? near(c, p.end, 'caption end') : it.end;
    if (s !== it.start && s - it.start !== e - it.end) {
      if (p.words === undefined && words) words = cw().remap(words, it.start, s, (x) => x);
      if (p.doubt === undefined && doubt) doubt = cw().remapDoubt(doubt, it.start, s, (x) => x, e - s);
    }
    const next = captionItem(c, { start: p.start ?? it.start, end: p.end ?? it.end, text: p.text ?? it.text, doubt, words, speaker: p.speaker !== undefined ? p.speaker : it.speaker });
    if (next.speaker) tx.set(it, 'speaker', next.speaker);
    else if (it.speaker !== undefined) tx.del(it, 'speaker');
    tx.set(it, 'text', next.text);
    tx.set(it, 'end', next.end);
    if (next.doubt) tx.set(it, 'doubt', next.doubt);
    else if (it.doubt !== undefined) tx.del(it, 'doubt');
    if (next.words) tx.set(it, 'words', next.words);
    else if (it.words !== undefined) tx.del(it, 'words');
    if (next.start !== it.start) {
      tx.set(it, 'start', next.start);
      removeFrom(c, ct.items, it);
      insertSorted(c, ct.items, it, 'start');
    }
    return {};
  };
  H.removeCaption = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const ct = captionTrackOf(c, cmd.trackId);
    removeFrom(c, ct.items, captionOf(c, ct, cmd.itemId));
    return {};
  };

  // ---- labels (English; the screen shows them through tr()) ----

  const LABELS = {
    importMedia: 'Import', removeMedia: 'Remove Media', relinkMedia: 'Relink Media', addBin: 'New Bin', removeBin: 'Delete Bin',
    renameItem: 'Rename', moveToBin: 'Move to Bin', addSequence: 'New Sequence', removeSequence: 'Delete Sequence',
    setSequence: 'Sequence Settings', addTrack: 'Add Track', removeTrack: 'Delete Track', setTrack: 'Track Settings',
    place: 'Overwrite', placeRange: 'Overwrite', move: 'Move', trim: 'Trim', split: 'Split', remove: 'Delete',
    rippleToPlayhead: 'Ripple Trim to Playhead', closeGap: 'Close Gap', lift: 'Lift', extract: 'Extract', setClip: 'Clip Settings',
    setKeyframes: 'Keyframes', link: 'Link', unlink: 'Unlink', addEffect: 'Add Effect', removeEffect: 'Remove Effect',
    setEffect: 'Effect Settings', moveEffect: 'Reorder Effects', addTransition: 'Add Transition', removeTransition: 'Remove Transition',
    setTransition: 'Transition Settings', addGenerated: 'Add Graphic', freezeFrame: 'Freeze Frame', addMarker: 'Add Marker',
    setMarker: 'Edit Marker', removeMarker: 'Remove Marker', addCaptionTrack: 'Add Caption Track', setCaptionTrack: 'Caption Track Settings',
    removeCaptionTrack: 'Delete Caption Track', setCaptions: 'Replace Captions', addCaption: 'Add Caption', setCaption: 'Edit Caption',
    removeCaption: 'Remove Caption', setProxy: 'Proxy', setSettings: 'Project Settings', setSpeakers: 'Speakers', addLut: 'Load LUT', paste: 'Paste', setGenerator: 'Graphic Settings',
    setLayer: 'Edit Text', addLayer: 'Add Layer', removeLayer: 'Remove Layer', setRole: 'Audio Role', replaceAudio: 'Replace Audio', batch: 'Edit',
    group: 'Group', ungroup: 'Ungroup', slip: 'Slip', slide: 'Slide', stretch: 'Rate Stretch', extendEdit: 'Extend Edit',
    nest: 'Nest', setRemap: 'Time Remapping', addMask: 'Add Mask', setMask: 'Mask', removeMask: 'Remove Mask',
  };
  // Labels the automation (ui-auto.js) gives its batches.
  const BATCH_LABELS = ['Remove Silence', 'Add Scene Markers', 'Split at Scene Changes', 'Add Beat Markers', 'Match Loudness', 'Match Clip Loudness', 'Auto Ducking', 'Auto Color'];
  function label(cmd) {
    const o = cmd.opts || {};
    switch (cmd.type) {
      case 'place':
      case 'placeRange': return o.mode === 'insert' ? 'Insert' : 'Overwrite';
      case 'trim': return { ripple: 'Ripple Trim', roll: 'Roll Edit' }[o.mode] || 'Trim';
      case 'remove': return o.ripple ? 'Ripple Delete' : 'Delete';
      case 'move': return o.insert ? 'Insert Move' : o.nudge ? 'Nudge' : 'Move';
      case 'addSequence': return o.from != null ? 'Duplicate Sequence' : 'New Sequence';
      case 'addGenerated': return o.source?.generator === 'text' ? 'Add Text' : 'Add Graphic';
      case 'setClip': return cmd.patch?.speed !== undefined || cmd.patch?.duration !== undefined ? 'Speed/Duration' : cmd.patch?.sampling !== undefined ? 'Time Interpolation' : 'Clip Settings';
      case 'paste': return o.mode === 'insert' ? 'Paste Insert' : 'Paste';
      case 'batch': return typeof cmd.label === 'string' && cmd.label ? cmd.label : 'Edit';
      default: return LABELS[cmd.type] || cmd.type;
    }
  }
  const ALL_LABELS = [...new Set([...Object.values(LABELS), 'Insert', 'Ripple Trim', 'Roll Edit', 'Ripple Delete', 'Insert Move', 'Duplicate Sequence', 'Add Text', 'Speed/Duration', 'Time Interpolation', 'Paste Insert', 'Nudge', ...BATCH_LABELS])];

  // ---- history ----

  function apply(project, tx, cmd) {
    if (!cmd || typeof cmd !== 'object' || !H[cmd.type]) fail(`unknown command ${cmd && cmd.type}`);
    return H[cmd.type](project, tx, cmd);
  }
  // Several commands as one step with one label (an automation's edits): they run in order on the same recording, so
  // one that fails takes back all of them; the project is checked once, after the last. -> {results: [...]}
  H.batch = (project, tx, cmd) => {
    const results = [];
    for (const sub of ids(cmd.commands, 'commands')) {
      if (sub?.type === 'batch') fail('a batch cannot hold a batch');
      results.push(apply(project, tx, sub));
    }
    return { results };
  };

  function createHistory(project, { limit = 1000 } = {}) {
    const first = model.validate(project);
    if (!first.ok) fail('The project is damaged and cannot be edited.', 'damaged', first.errors.slice(0, 5).join('; '));
    let undoStack = [];
    let redoStack = [];
    let group = null;
    // Stands for "nothing left to undo"; when the oldest step is dropped it becomes that step, so `dirty` stays right.
    let base = {};
    let saved = base;
    let amends = 0; // changes made by amend(), counted
    let savedAmends = 0;
    const listeners = new Set();
    const top = () => (undoStack.length ? undoStack[undoStack.length - 1] : base);
    project[model.REVISION] = 0;
    const emit = (reason) => {
      if (reason !== 'commit') project[model.REVISION] += 1;
      for (const fn of [...listeners]) {
        try { fn(reason); } catch (err) { (globalThis.ide?.logger?.('#cut') || console).error?.(`history listener: ${err?.stack || err}`); }
      }
    };
    const push = (entry) => {
      undoStack.push(entry);
      while (undoStack.length > limit) base = undoStack.shift();
    };
    const run = (cmd, tx) => {
      try {
        const result = apply(project, tx, cmd);
        normalize(project, tx);
        const v = model.validate(project);
        if (!v.ok) fail('The edit would leave the project damaged.', 'invalidResult', v.errors.slice(0, 5).join('; '));
        return result;
      } catch (err) {
        rollback(tx.ops);
        throw err;
      }
    };

    const history = {
      get project() { return project; },
      get canUndo() { return undoStack.length > 0 || !!group?.ops.length; },
      get canRedo() { return !group && redoStack.length > 0; },
      get dirty() { return top() !== saved || !!group?.ops.length || amends !== savedAmends; },
      get grouping() { return !!group; },
      do(cmd) {
        const tx = recorder();
        const result = run(cmd, tx);
        if (!tx.ops.length) return result;
        redoStack = [];
        if (group) group.ops.push(...tx.ops);
        else push({ label: label(cmd), ops: tx.ops });
        emit('do');
        return result;
      },
      // A change that is no edit of the person's (a background job linking the proxy it made): kept in the project and
      // saved with it, but no step, so it neither clears what can be redone nor lands between their steps. Only for
      // changes that no step undoes or redoes (Cut.commands.setProxy). -> the command's result
      amend(cmd) {
        const tx = recorder();
        const result = run(cmd, tx);
        if (!tx.ops.length) return result;
        amends += 1;
        emit('amend');
        return result;
      },
      undo() {
        if (group) history.commit(true);
        const entry = undoStack.pop();
        if (!entry) return false;
        rollback(entry.ops);
        redoStack.push(entry);
        emit('undo');
        return true;
      },
      redo() {
        if (group) history.commit(true);
        const entry = redoStack.pop();
        if (!entry) return false;
        for (const op of entry.ops) op.redo();
        undoStack.push(entry);
        emit('redo');
        return true;
      },
      // Groups the commands done until commit() into one undo step (a slider drag). Nested begin/commit pairs join
      // the outer group; cancel() takes back everything since the outer begin.
      begin(name) {
        if (group) group.depth++;
        else group = { label: String(name || 'Edit'), ops: [], depth: 1 };
      },
      commit(all = false) {
        if (!group) return;
        if (!all && --group.depth > 0) return;
        const g = group;
        group = null;
        // The project is as it was after the group's last do; only the list of steps changed.
        if (g.ops.length) { push({ label: g.label, ops: g.ops }); emit('commit'); }
      },
      cancel() {
        if (!group) return;
        const g = group;
        group = null;
        if (g.ops.length) {
          rollback(g.ops);
          emit('undo');
        }
      },
      // Undoes or redoes until `position` steps are done (list()'s first `position` entries), in one go: one change
      // event ('undo' or 'redo'). -> true when it moved.
      goTo(position) {
        if (group) history.commit(true);
        const target = Math.max(0, Math.min(undoStack.length + redoStack.length, Math.round(Number(position) || 0)));
        if (target === undoStack.length) return false;
        const reason = target < undoStack.length ? 'undo' : 'redo';
        while (undoStack.length > target) {
          const entry = undoStack.pop();
          rollback(entry.ops);
          redoStack.push(entry);
        }
        while (undoStack.length < target) {
          const entry = redoStack.pop();
          for (const op of entry.ops) op.redo();
          undoStack.push(entry);
        }
        emit(reason);
        return true;
      },
      // Joins the steps done after `position` into one step named `name` (an AI assistant's turn: each edit is a step
      // while the turn runs, then the turn is one). The project does not change; the list does ('commit'). -> true
      // when there was a step to name.
      squash(position, name) {
        if (group) history.commit(true);
        const from = Math.max(0, Math.min(undoStack.length, Math.round(Number(position) || 0)));
        if (from >= undoStack.length) return false;
        const parts = undoStack.splice(from);
        const entry = { label: String(name || 'Edit'), ops: parts.flatMap((e) => e.ops) };
        undoStack.push(entry);
        if (saved === parts[parts.length - 1]) saved = entry;
        emit('commit');
        return true;
      },
      // How many steps are done: the index in list() of the first step that can be redone.
      get position() { return undoStack.length; },
      // Oldest first: the steps that can be undone (done: true), then those that can be redone, next first.
      list() {
        return [...undoStack.map((e) => ({ label: e.label, done: true })), ...redoStack.slice().reverse().map((e) => ({ label: e.label, done: false }))];
      },
      onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      dispose() {
        listeners.clear();
        undoStack = [];
        redoStack = [];
        group = null;
      },
      serialize() {
        return JSON.stringify(project);
      },
      // The state serialize() gives now, for markSaved once that text is on disk: edits made while it is written stay
      // unsaved. A group with edits in it (a drag) may still be cancelled or go on, so that state is no step.
      mark() {
        return { entry: group?.ops.length ? {} : top(), amends };
      },
      markSaved(at = history.mark()) {
        saved = at.entry;
        savedAmends = at.amends;
      },
    };
    return history;
  }

  // ---- command builders: the API panels and tests call ----

  const commands = {
    importMedia: (media, binId = null) => ({ type: 'importMedia', media, binId }),
    removeMedia: (ids2) => ({ type: 'removeMedia', ids: ids2 }),
    relinkMedia: (id, file) => ({ type: 'relinkMedia', id, file }),
    addBin: (name, parent = null) => ({ type: 'addBin', name, parent }),
    removeBin: (id) => ({ type: 'removeBin', id }),
    renameItem: (id, name) => ({ type: 'renameItem', id, name }),
    moveToBin: (ids2, binId = null) => ({ type: 'moveToBin', ids: ids2, binId }),
    addSequence: (opts = {}) => ({ type: 'addSequence', opts }),
    removeSequence: (id) => ({ type: 'removeSequence', id }),
    setSequence: (id, patch) => ({ type: 'setSequence', id, patch }),
    addTrack: (seqId, kind, index = null, opts = {}) => ({ type: 'addTrack', seqId, kind, index, opts }),
    removeTrack: (seqId, trackId) => ({ type: 'removeTrack', seqId, trackId }),
    setTrack: (seqId, trackId, patch) => ({ type: 'setTrack', seqId, trackId, patch }),
    place: (seqId, opts) => ({ type: 'place', seqId, opts }),
    placeRange: (seqId, opts) => ({ type: 'placeRange', seqId, opts }),
    move: (seqId, clipIds, opts = {}) => ({ type: 'move', seqId, clipIds, opts }),
    trim: (seqId, clipId, opts) => ({ type: 'trim', seqId, clipId, opts }),
    split: (seqId, t, opts = {}) => ({ type: 'split', seqId, t, opts }),
    remove: (seqId, clipIds, opts = {}) => ({ type: 'remove', seqId, clipIds, opts }),
    rippleToPlayhead: (seqId, t, side, opts = {}) => ({ type: 'rippleToPlayhead', seqId, t, side, opts }),
    closeGap: (seqId, trackId, t) => ({ type: 'closeGap', seqId, trackId, t }),
    lift: (seqId, inT, outT, trackIds = null) => ({ type: 'lift', seqId, in: inT, out: outT, trackIds }),
    extract: (seqId, inT, outT, trackIds = null) => ({ type: 'extract', seqId, in: inT, out: outT, trackIds }),
    setClip: (seqId, clipId, patch, opts = {}) => ({ type: 'setClip', seqId, clipId, patch, opts }),
    setKeyframes: (seqId, clipId, prop, list) => ({ type: 'setKeyframes', seqId, clipId, prop, keyframes: list }),
    setRemap: (seqId, clipId, remap) => ({ type: 'setRemap', seqId, clipId, remap }),
    link: (seqId, clipIds) => ({ type: 'link', seqId, clipIds }),
    unlink: (seqId, clipIds) => ({ type: 'unlink', seqId, clipIds }),
    group: (seqId, clipIds) => ({ type: 'group', seqId, clipIds }),
    nest: (seqId, clipIds, opts = {}) => ({ type: 'nest', seqId, clipIds, opts }),
    ungroup: (seqId, clipIds) => ({ type: 'ungroup', seqId, clipIds }),
    slip: (seqId, clipId, opts = {}) => ({ type: 'slip', seqId, clipId, opts }),
    slide: (seqId, clipId, opts = {}) => ({ type: 'slide', seqId, clipId, opts }),
    stretch: (seqId, clipId, opts) => ({ type: 'stretch', seqId, clipId, opts }),
    extendEdit: (seqId, t, opts = {}) => ({ type: 'extendEdit', seqId, t, opts }),
    addEffect: (seqId, clipId, effectType, index = null, params = {}) => ({ type: 'addEffect', seqId, clipId, effectType, index, params }),
    removeEffect: (seqId, clipId, effectId) => ({ type: 'removeEffect', seqId, clipId, effectId }),
    setEffect: (seqId, clipId, effectId, patch) => ({ type: 'setEffect', seqId, clipId, effectId, patch }),
    moveEffect: (seqId, clipId, effectId, index) => ({ type: 'moveEffect', seqId, clipId, effectId, index }),
    addMask: (seqId, clipId, mask, opts = {}) => ({ type: 'addMask', seqId, clipId, mask, opts }),
    setMask: (seqId, clipId, maskId, patch, opts = {}) => ({ type: 'setMask', seqId, clipId, maskId, patch, opts }),
    removeMask: (seqId, clipId, maskId, opts = {}) => ({ type: 'removeMask', seqId, clipId, maskId, opts }),
    addTransition: (seqId, opts) => ({ type: 'addTransition', seqId, opts }),
    removeTransition: (seqId, id) => ({ type: 'removeTransition', seqId, id }),
    setTransition: (seqId, id, patch) => ({ type: 'setTransition', seqId, id, patch }),
    addGenerated: (seqId, opts) => ({ type: 'addGenerated', seqId, opts }),
    freezeFrame: (seqId, clipId, t, duration = null) => ({ type: 'freezeFrame', seqId, clipId, t, duration: duration ?? undefined }),
    addMarker: (seqId, marker, opts = {}) => ({ type: 'addMarker', seqId, marker, opts }),
    setMarker: (seqId, id, patch) => ({ type: 'setMarker', seqId, id, patch }),
    removeMarker: (seqId, id) => ({ type: 'removeMarker', seqId, id }),
    addCaptionTrack: (seqId, opts = {}) => ({ type: 'addCaptionTrack', seqId, opts }),
    setCaptionTrack: (seqId, trackId, patch) => ({ type: 'setCaptionTrack', seqId, trackId, patch }),
    removeCaptionTrack: (seqId, trackId) => ({ type: 'removeCaptionTrack', seqId, trackId }),
    setCaptions: (seqId, trackId, items) => ({ type: 'setCaptions', seqId, trackId, items }),
    addCaption: (seqId, trackId, item) => ({ type: 'addCaption', seqId, trackId, item }),
    setCaption: (seqId, trackId, itemId, patch) => ({ type: 'setCaption', seqId, trackId, itemId, patch }),
    removeCaption: (seqId, trackId, itemId) => ({ type: 'removeCaption', seqId, trackId, itemId }),
    setProxy: (id, proxy) => ({ type: 'setProxy', id, proxy }),
    setSettings: (patch) => ({ type: 'setSettings', patch }),
    setSpeakers: (patch) => ({ type: 'setSpeakers', patch }),
    addLut: ({ id, entry }) => ({ type: 'addLut', id, entry }),
    paste: (seqId, clips, opts = {}) => ({ type: 'paste', seqId, clips, opts }),
    setGenerator: (seqId, clipId, patch) => ({ type: 'setGenerator', seqId, clipId, patch }),
    setLayer: (seqId, clipId, layerId, patch) => ({ type: 'setLayer', seqId, clipId, layerId, patch }),
    addLayer: (seqId, clipId, layer = {}, index = null) => ({ type: 'addLayer', seqId, clipId, layer, index }),
    removeLayer: (seqId, clipId, layerId) => ({ type: 'removeLayer', seqId, clipId, layerId }),
    setRole: (seqId, clipIds, role, opts = {}) => ({ type: 'setRole', seqId, clipIds, role, opts }),
    replaceAudio: (seqId, clipIds, mediaId) => ({ type: 'replaceAudio', seqId, clipIds, mediaId }),
    batch: (label, list) => ({ type: 'batch', label, commands: list }),
  };

  return { ...commands, createHistory, label, LABELS: ALL_LABELS };
});
