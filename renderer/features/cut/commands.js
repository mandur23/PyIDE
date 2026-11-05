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
//   { linked: false } (Alt in the timeline).
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
  const time = req('time');
  const model = req('model');
  const keyframes = req('keyframes');
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

  function withLinked(c, clipIds, linked = true) {
    const set = new Set(ids(clipIds, 'clipIds').map((id) => clipOf(c, id)));
    if (linked) {
      const links = new Set([...set].map((x) => x.link).filter(Boolean));
      for (const x of c.seq.clips) if (x.link && links.has(x.link)) set.add(x);
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
  // The clip's head moves to ns; its end stays. The source side that is shown first (in, or out when reversed)
  // follows; a still clip only changes length.
  function setStart(c, clip, ns) {
    const d = ns - clip.start;
    if (!d) return;
    const nd = end(clip) - ns;
    if (still(c, clip) || clip.reverse) c.tx.set(clip, 'out', clip.in + nd * clip.speed);
    else c.tx.set(clip, 'in', clip.out - nd * clip.speed);
    c.tx.set(clip, 'start', ns);
    shiftKeys(c, clip, d);
    clampFades(c, clip, nd);
  }
  function setEnd(c, clip, ne) {
    const nd = ne - clip.start;
    if (nd === dur(clip)) return;
    if (still(c, clip) || !clip.reverse) c.tx.set(clip, 'out', clip.in + nd * clip.speed);
    else c.tx.set(clip, 'in', clip.out - nd * clip.speed);
    clampFades(c, clip, nd);
  }

  // How far the source lets the clip grow at its head and its tail, in whole timeline frames.
  function room(c, clip) {
    if (still(c, clip)) return { head: Infinity, tail: Infinity };
    const m = model.mediaOf(c.project, clip);
    const before = floorFrames(c, clip.in / clip.speed);
    const after = floorFrames(c, (m.duration - clip.out) / clip.speed);
    return clip.reverse ? { head: after, tail: before } : { head: before, tail: after };
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
    if (still(c, clip)) right.out = clip.in + rd * clip.speed;
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

  function captionsInsert(c, ct, p, L) {
    for (const it of [...ct.items]) {
      if (it.start >= p) c.tx.set(it, 'start', it.start + L);
      if (it.end > p) c.tx.set(it, 'end', it.end + L);
    }
    // A caption across p shows on both sides of the inserted time.
    for (const it of [...ct.items]) {
      if (it.start < p && it.end > p + L) {
        const piece = { id: nid(c, 'cap'), start: p + L, end: it.end, text: it.text };
        c.tx.set(it, 'end', p);
        insertSorted(c, ct.items, piece, 'start');
      }
    }
  }
  function captionsRemove(c, ct, a, b) {
    const L = b - a;
    const map = (x) => (x <= a ? x : x < b ? a : x - L);
    for (const it of [...ct.items]) {
      const s = map(it.start);
      const e = map(it.end);
      if (e <= s) removeFrom(c, ct.items, it);
      else {
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

  // After every command: links of one clip are cleared, transitions off every clip edge (or doubled) are removed.
  function normalize(project, tx) {
    for (const seq of project.sequences) {
      const count = new Map();
      for (const x of seq.clips) if (x.link) count.set(x.link, (count.get(x.link) || 0) + 1);
      for (const x of seq.clips) if (x.link && count.get(x.link) < 2) tx.set(x, 'link', null);
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
    if (s.generator === 'solid') return { generator: 'solid', color: typeof s.color === 'string' ? s.color : '#ffffff' };
    if (s.generator === 'adjustment') return { generator: 'adjustment' };
    return fail(`unknown source ${JSON.stringify(source)}`);
  }

  // Video and/or audio clips of one source at `at` (or ending at `endAt`), linked when both are placed.
  function placeClips(c, o) {
    const src = normSource(c, o.source);
    const media = src.media != null ? mediaById(c, src.media) : null;
    const hasV = !media || media.kind === 'image' || !!media.video;
    const hasA = !!media?.audio;
    const vId = hasV && o.video != null ? o.video : null;
    const aId = hasA && o.audio != null ? o.audio : null;
    if (!vId && !aId) fail('Choose a target track.', 'noTarget');
    if (vId && unlocked(c, vId).kind !== 'video') fail('There is no track there.', 'noTrack', vId);
    if (aId && unlocked(c, aId).kind !== 'audio') fail('There is no track there.', 'noTrack', aId);
    const isStillSrc = !media || media.kind === 'image';
    let sin;
    let d;
    if (isStillSrc) {
      sin = 0;
      const want = o.out != null && o.in != null ? num(o.out, 'out') - num(o.in, 'in') : o.out != null ? num(o.out, 'out') : c.project.settings.stillDuration;
      d = Math.max(c.f, frames(c, want));
    } else {
      sin = o.in == null ? 0 : at(c, o.in, 'in');
      const sout = Math.min(o.out == null ? media.duration : num(o.out, 'out'), media.duration);
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
    const name = typeof o.name === 'string' ? o.name : media ? media.name : { text: 'Text', solid: 'Color', adjustment: 'Adjustment' }[src.generator];
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
  // Project settings, and the saved text styles of the text panel ({ id, name, style }).
  const SETTINGS = { fit: ['fit', 'fill', 'original'], stillDuration: 'ticks', transitionDuration: 'ticks', freezeDuration: 'ticks', textStyles: 'list' };
  H.setSettings = (project, tx, cmd) => {
    for (const [k, v] of Object.entries(clone(cmd.patch || {}))) {
      const kind = SETTINGS[k];
      if (!kind) fail(`unknown project setting ${k}`);
      if (Array.isArray(kind) ? !kind.includes(v) : kind === 'ticks' ? !(Number.isInteger(v) && v > 0) : !Array.isArray(v)) fail(`project setting ${k} is not valid`);
      tx.set(project.settings, k, v);
    }
    return {};
  };
  H.relinkMedia = (project, tx, cmd) => {
    const c = projectContext(project, tx);
    const m = mediaById(c, cmd.id);
    const file = cmd.file || {};
    if (typeof file.path !== 'string') fail('relink needs a path');
    for (const k of ['path', 'size', 'mtime', 'duration']) if (file[k] !== undefined) tx.set(m, k, file[k]);
    for (const k of ['video', 'audio']) if (file[k] !== undefined) tx.set(m, k, clone(file[k]));
    if (m.proxy) tx.set(m, 'proxy', null);
    return {};
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
    for (const x of copy.clips) {
      x.id = nid(c, 'c');
      if (x.link) {
        if (!links.has(x.link)) links.set(x.link, nid(c, 'L'));
        x.link = links.get(x.link);
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
    removeFrom(c, project.sequences, seq);
    return {};
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
        if (!still(c2, x)) {
          const m = model.mediaOf(c.project, x);
          d = Math.min(d, Math.floor((x.reverse ? x.out : m.duration - x.in) / x.speed / f + 1e-9) * f);
          if (d < f) fail('The clip is too short.', 'tooShort', x.id);
        }
        plan.push([x, s, d]);
        prevEnd = s + d;
      }
    }
    tx.set(seq, 'fps', [fps[0], fps[1]]);
    for (const [x, s, d] of plan) {
      const rel = (t) => sn(x.start + t) - s;
      for (const [prop, list] of Object.entries(x.keyframes)) {
        const byT = new Map();
        for (const k of list) byT.set(rel(k.t), { ...k, t: rel(k.t) });
        tx.set(x.keyframes, prop, [...byT.values()].sort((a, b) => a.t - b.t));
      }
      if (x.markers) tx.set(x, 'markers', x.markers.map((m) => ({ ...m, t: rel(m.t), duration: sn(m.duration) })));
      if (still(c2, x) || !x.reverse) tx.set(x, 'out', x.in + d * x.speed);
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
        tx.set(it, 'start', s);
        tx.set(it, 'end', Math.max(s + f, sn(it.end)));
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
    const clips = withLinked(c, cmd.clipIds, o.linked !== false);
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
    const made = [];
    for (const x of src) {
      const kind = kindOfCopy(x);
      const track = lists[kind][target[kind] + indexOfCopy(x, kind) - base[kind]];
      if (!track) fail('There is no track there.', 'noTrack');
      if (track.locked) fail('The track is locked.', 'locked', track.id);
      const source = x.source?.freeze ? { ...normSource(c, x.source), freeze: true } : normSource(c, x.source);
      const clip = model.createClip(kind, { id: null, track: track.id, start: p + at(c, x.start - minStart), in: num(x.in, 'in'), out: num(x.out, 'out'), source });
      for (const k of ['speed', 'reverse', 'enabled', 'name', 'label', 'props', 'keyframes', 'effects', 'fadeIn', 'fadeOut']) if (x[k] !== undefined) clip[k] = x[k];
      if (x.markers) clip.markers = x.markers;
      if (x.link) {
        if (!links.has(x.link)) links.set(x.link, null);
        clip.link = x.link;
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
    for (const x of made) {
      x.id = nid(c, 'c');
      if (x.link) x.link = links.get(x.link);
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
    const clips = withLinked(c, cmd.clipIds, o.linked !== false);
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

  // clip settings
  const CLIP_FIELDS = ['props', 'speed', 'duration', 'ripple', 'reverse', 'enabled', 'name', 'label', 'fadeIn', 'fadeOut'];
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
    if (p.enabled !== undefined) tx.set(clip, 'enabled', !!p.enabled);
    if (p.reverse !== undefined) {
      const group = [clip, ...(linked ? model.linkedClips(c.seq, clip) : [])];
      for (const g of group) unlocked(c, g.track);
      for (const g of group) tx.set(g, 'reverse', !!p.reverse);
    }
    if (p.speed !== undefined && p.duration !== undefined) fail('give a speed or a duration');
    if (p.speed !== undefined) setSpeed(c, clip, num(p.speed, 'speed'), !!p.ripple, linked);
    // A duration sets the speed that shows the same source in that time (Speed/Duration with the length field).
    if (p.duration !== undefined) {
      const d = Math.max(c.f, frames(c, p.duration, 'duration'));
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
  function setSpeed(c, clip, speed, ripple, linked, wantDur) {
    if (speed < 0.01 || speed > 100) fail('Speed must be between 1% and 10000%.', 'speed');
    const group = [clip, ...(linked ? model.linkedClips(c.seq, clip).filter((x) => x.start === clip.start && end(x) === end(clip)) : [])];
    for (const g of group) unlocked(c, g.track);
    const old = dur(clip);
    const pos = end(clip);
    let nd = old;
    if (!still(c, clip)) {
      nd = wantDur ?? Math.max(c.f, Math.round((clip.out - clip.in) / speed / c.f) * c.f);
      for (const g of group) {
        const m = model.mediaOf(c.project, g);
        nd = Math.min(nd, floorFrames(c, (g.reverse ? g.out : m.duration - g.in) / speed));
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
      for (const [prop, list] of Object.entries(g.keyframes)) {
        const byT = new Map();
        for (const k of list) {
          const t = Math.round((k.t * ratio) / c.f) * c.f;
          byT.set(t, { ...k, t });
        }
        c.tx.set(g.keyframes, prop, [...byT.values()].sort((a, b) => a.t - b.t));
      }
      if (g.markers) c.tx.set(g, 'markers', g.markers.map((m) => ({ ...m, t: Math.round((m.t * ratio) / c.f) * c.f })));
      clampFades(c, g, nd);
    }
    if (ripple && L < 0) rippleRemove(c, tracks, pos + L, pos);
    for (const t of carried) {
      c.tx.set(t, 'at', clip.start + nd);
      append(c, c.seq.transitions, t);
    }
  }
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
  H.addTransition = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const o = clone(cmd.opts || {});
    unlocked(c, o.track);
    const p = at(c, o.at);
    if (!c.seq.clips.some((x) => x.track === o.track && (x.start === p || end(x) === p))) fail('Transitions go on an edit point or a clip end.', 'noEdge');
    if (typeof o.type !== 'string' || !o.type) fail('the transition has no type');
    const align = o.align ?? 'center';
    if (!model.ALIGNS.includes(align)) fail(`unknown alignment ${align}`);
    const d = Math.max(c.f, frames(c, o.duration ?? project.settings.transitionDuration, 'duration'));
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
    if (p.duration !== undefined) tx.set(t, 'duration', Math.max(c.f, frames(c, p.duration, 'duration')));
    if (p.align !== undefined) {
      if (!model.ALIGNS.includes(p.align)) fail(`unknown alignment ${p.align}`);
      tx.set(t, 'align', p.align);
    }
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
    if (!l) fail(`there is no text layer ${id}`, 'notFound');
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
      if (clip.source.generator !== 'text') fail('only a text clip has layers');
      const layers = normSource(c, { generator: 'text', layers: p.layers }).layers;
      for (const l of clip.source.layers) if (!layers.some((x) => x.id === l.id)) dropLayerKeys(c, clip, l.id);
      tx.set(clip.source, 'layers', layers);
    }
    return {};
  };
  const LAYER_FIELDS = Object.keys(model.createTextLayer()).filter((k) => k !== 'id');
  H.setLayer = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const layer = layerOf(generatorClip(c, cmd.clipId, 'text'), cmd.layerId);
    for (const [k, v] of Object.entries(clone(cmd.patch || {}))) {
      if (!LAYER_FIELDS.includes(k)) fail(`unknown text layer field ${k}`);
      tx.set(layer, k, v);
    }
    return {};
  };
  H.addLayer = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = generatorClip(c, cmd.clipId, 'text');
    let n = clip.source.layers.length + 1;
    while (clip.source.layers.some((l) => l.id === `l${n}`)) n++;
    const layer = model.createTextLayer({ ...clone(cmd.layer || {}), id: `l${n}` });
    const index = cmd.index == null ? clip.source.layers.length : Math.max(0, Math.min(clip.source.layers.length, cmd.index));
    tx.splice(clip.source.layers, index, 0, layer);
    return { id: layer.id };
  };
  H.removeLayer = (project, tx, cmd) => {
    const c = context(project, tx, cmd.seqId);
    const clip = generatorClip(c, cmd.clipId, 'text');
    const layer = layerOf(clip, cmd.layerId);
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
    return { start, end: e > start ? e : start + c.f, text: String(it.text ?? '') };
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
    for (const k of Object.keys(p)) if (!['start', 'end', 'text'].includes(k)) fail(`unknown caption field ${k}`);
    const next = captionItem(c, { start: p.start ?? it.start, end: p.end ?? it.end, text: p.text ?? it.text });
    tx.set(it, 'text', next.text);
    tx.set(it, 'end', next.end);
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
    removeCaption: 'Remove Caption', setProxy: 'Proxy', setSettings: 'Project Settings', paste: 'Paste', setGenerator: 'Graphic Settings',
    setLayer: 'Edit Text', addLayer: 'Add Layer', removeLayer: 'Remove Layer',
  };
  function label(cmd) {
    const o = cmd.opts || {};
    switch (cmd.type) {
      case 'place':
      case 'placeRange': return o.mode === 'insert' ? 'Insert' : 'Overwrite';
      case 'trim': return { ripple: 'Ripple Trim', roll: 'Roll Edit' }[o.mode] || 'Trim';
      case 'remove': return o.ripple ? 'Ripple Delete' : 'Delete';
      case 'move': return o.insert ? 'Insert Move' : 'Move';
      case 'addSequence': return o.from != null ? 'Duplicate Sequence' : 'New Sequence';
      case 'addGenerated': return o.source?.generator === 'text' ? 'Add Text' : 'Add Graphic';
      case 'setClip': return cmd.patch?.speed !== undefined || cmd.patch?.duration !== undefined ? 'Speed/Duration' : 'Clip Settings';
      case 'paste': return o.mode === 'insert' ? 'Paste Insert' : 'Paste';
      default: return LABELS[cmd.type] || cmd.type;
    }
  }
  const ALL_LABELS = [...new Set([...Object.values(LABELS), 'Insert', 'Ripple Trim', 'Roll Edit', 'Ripple Delete', 'Insert Move', 'Duplicate Sequence', 'Add Text', 'Speed/Duration', 'Paste Insert'])];

  // ---- history ----

  function apply(project, tx, cmd) {
    if (!cmd || typeof cmd !== 'object' || !H[cmd.type]) fail(`unknown command ${cmd && cmd.type}`);
    return H[cmd.type](project, tx, cmd);
  }

  function createHistory(project, { limit = 1000 } = {}) {
    const first = model.validate(project);
    if (!first.ok) fail('The project is damaged and cannot be edited.', 'damaged', first.errors.slice(0, 5).join('; '));
    let undoStack = [];
    let redoStack = [];
    let group = null;
    // Stands for "nothing left to undo"; when the oldest step is dropped it becomes that step, so `dirty` stays right.
    let base = {};
    let saved = base;
    const listeners = new Set();
    const top = () => (undoStack.length ? undoStack[undoStack.length - 1] : base);
    const emit = (reason) => {
      for (const fn of [...listeners]) {
        try { fn(reason); } catch (err) { (globalThis.ide?.logger?.('#cut') || console).error?.(`history listener: ${err?.stack || err}`); }
      }
    };
    const push = (entry) => {
      undoStack.push(entry);
      while (undoStack.length > limit) base = undoStack.shift();
    };

    const history = {
      get project() { return project; },
      get canUndo() { return undoStack.length > 0 || !!group?.ops.length; },
      get canRedo() { return !group && redoStack.length > 0; },
      get dirty() { return top() !== saved || !!group?.ops.length; },
      get grouping() { return !!group; },
      do(cmd) {
        const tx = recorder();
        let result;
        try {
          result = apply(project, tx, cmd);
          normalize(project, tx);
          const v = model.validate(project);
          if (!v.ok) fail('The edit would leave the project damaged.', 'invalidResult', v.errors.slice(0, 5).join('; '));
        } catch (err) {
          rollback(tx.ops);
          throw err;
        }
        if (!tx.ops.length) return result;
        redoStack = [];
        if (group) group.ops.push(...tx.ops);
        else push({ label: label(cmd), ops: tx.ops });
        emit('do');
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
        if (g.ops.length) push({ label: g.label, ops: g.ops });
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
      markSaved() {
        saved = top();
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
    link: (seqId, clipIds) => ({ type: 'link', seqId, clipIds }),
    unlink: (seqId, clipIds) => ({ type: 'unlink', seqId, clipIds }),
    addEffect: (seqId, clipId, effectType, index = null, params = {}) => ({ type: 'addEffect', seqId, clipId, effectType, index, params }),
    removeEffect: (seqId, clipId, effectId) => ({ type: 'removeEffect', seqId, clipId, effectId }),
    setEffect: (seqId, clipId, effectId, patch) => ({ type: 'setEffect', seqId, clipId, effectId, patch }),
    moveEffect: (seqId, clipId, effectId, index) => ({ type: 'moveEffect', seqId, clipId, effectId, index }),
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
    paste: (seqId, clips, opts = {}) => ({ type: 'paste', seqId, clips, opts }),
    setGenerator: (seqId, clipId, patch) => ({ type: 'setGenerator', seqId, clipId, patch }),
    setLayer: (seqId, clipId, layerId, patch) => ({ type: 'setLayer', seqId, clipId, layerId, patch }),
    addLayer: (seqId, clipId, layer = {}, index = null) => ({ type: 'addLayer', seqId, clipId, layer, index }),
    removeLayer: (seqId, clipId, layerId) => ({ type: 'removeLayer', seqId, clipId, layerId }),
  };

  return { ...commands, createHistory, label, LABELS: ALL_LABELS };
});
