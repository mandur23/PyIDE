// The MP4 writer of exports (docs/cut-architecture.md §5): ftyp, then one mdat streamed to the sink as samples come
// (its 64-bit size is patched at finish), then moov at the end with stts, ctts when there are composition offsets,
// stss, stsz, stsc, co64, an edit list when a track does not start at 0 (or has B-frame delay), colr, esds/dOps and
// btrt. Samples are grouped in chunks of about half a second, written in time order across the tracks so a player
// reading the file front to back does not seek back and forth. Faststart (moov first) is main's cut:faststart.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).mp4write = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;
  const codecs = NODE ? require('./codecs.js') : globalThis.Cut.codecs;
  const { ByteWriter } = codecs;

  const CHUNK = time.fromSeconds(0.5);
  const OUT_BYTES = 2 * 1024 * 1024;
  // A track that runs far ahead of the other is written anyway past this much buffered data.
  const MAX_PENDING = 64 * 1024 * 1024;
  const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  const U32 = 0xffffffff;

  class Column {
    constructor(Type, n = 1024) { this.Type = Type; this.a = new Type(n); this.n = 0; }
    push(v) {
      if (this.n === this.a.length) {
        const next = new this.Type(this.a.length * 2);
        next.set(this.a);
        this.a = next;
      }
      this.a[this.n++] = v;
    }
  }

  // A media timescale in which every frame lasts a whole number of units: 30 -> 30000 (1000 a frame), 30000/1001 -> 30000.
  function videoTimescale(fps) {
    if (!fps || !(fps[0] > 0) || !(fps[1] > 0)) return 90000;
    return fps[1] === 1 ? fps[0] * 1000 : fps[0];
  }

  function descriptor(w, tag, fn) {
    const inner = new ByteWriter();
    fn(inner);
    const body = inner.done();
    w.u8(tag);
    const len = body.length;
    const bytes = [];
    let v = len;
    do { bytes.unshift(v & 127); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < bytes.length; i++) w.u8(bytes[i] | (i < bytes.length - 1 ? 0x80 : 0));
    w.bytes(body);
  }

  // onError(err): the first write the sink refused, as it happens. The samples given after it are dropped and add()
  // throws, but the caller learns of it without waiting for finish (a full disk at 20 % rendered on to 100 %).
  function create({ video = null, audio = null, sink, timescale, onError } = {}) {
    if (!sink || typeof sink.write !== 'function') throw new TypeError('mp4write.create needs a sink with write(bytes, position)');
    if (!video && !audio) throw new TypeError('mp4write.create needs a video or an audio track');
    const tracks = [];
    if (video) {
      const info = codecs.parseCodecString(video.codec);
      if (!info || (info.family !== 'avc' && info.family !== 'hevc')) throw new Error(`mp4write cannot write video ${video.codec}`);
      if (!video.description) throw new Error('mp4write needs the video decoder description (avcC or hvcC)');
      tracks.push(newTrack('video', tracks.length + 1, { ...video, info }, timescale || videoTimescale(video.frameRate)));
    }
    if (audio) {
      const info = codecs.parseCodecString(audio.codec);
      if (!info || (info.family !== 'aac' && info.family !== 'opus')) throw new Error(`mp4write cannot write audio ${audio.codec}`);
      if (!(audio.sampleRate > 0) || !(audio.channels > 0)) throw new Error('mp4write needs the audio sample rate and channels');
      tracks.push(newTrack('audio', tracks.length + 1, { ...audio, info }, audio.sampleRate));
    }
    const vtrack = tracks.find((t) => t.kind === 'video');
    const atrack = tracks.find((t) => t.kind === 'audio');
    const movieScale = vtrack ? vtrack.timescale : atrack.timescale;

    let pos = 0;
    let out = [];
    let outBytes = 0;
    let chain = Promise.resolve();
    let error = null;
    let pendingBytes = 0;
    let finished = false;

    const queue = (bytes, position) => {
      chain = chain.then(() => (error ? null : sink.write(bytes, position))).catch((err) => {
        if (error) return;
        error = err;
        try { onError?.(err); } catch {}
      });
    };
    const flushOut = () => {
      if (!out.length) return;
      const bytes = out.length === 1 ? out[0] : codecs.concat(out);
      out = [];
      outBytes = 0;
      queue(bytes);
    };
    const emit = (bytes) => {
      if (bytes.length >= OUT_BYTES) {
        flushOut();
        queue(bytes);
      } else {
        out.push(bytes);
        outBytes += bytes.length;
        if (outBytes >= OUT_BYTES) flushOut();
      }
      pos += bytes.length;
    };

    const head = new ByteWriter();
    head.box('ftyp', (w) => w.str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41'));
    const mdatAt = head.len;
    head.u32(1).str('mdat').u64(0);
    emit(head.done());

    function add(t, s) {
      if (finished) throw new Error('mp4write: the file is finished');
      if (error) throw error;
      if (!s || !(s.data instanceof Uint8Array)) throw new TypeError('a sample needs data: Uint8Array');
      const cto = t.kind === 'video' && s.compositionOffset ? s.compositionOffset : 0;
      const ptsU = t.toUnits(s.timestamp);
      let dtsU = t.toUnits(s.timestamp - cto);
      if (dtsU <= t.lastDts) dtsU = t.lastDts + 1;
      const n = t.dts.n;
      if (n) t.dur.a[n - 1] = dtsU - t.lastDts;
      t.dts.push(dtsU);
      t.cto.push(ptsU - dtsU);
      t.dur.push(Math.max(0, t.toUnits(s.duration || 0)));
      t.size.push(s.data.length);
      t.key.push(t.kind === 'audio' || s.key ? 1 : 0);
      t.lastDts = dtsU;
      t.firstPts = Math.min(t.firstPts, s.timestamp);
      t.endPts = Math.max(t.endPts, s.timestamp + (s.duration || 0));
      const start = s.timestamp - cto;
      if (t.head === t.pending.length) t.pendingStart = start;
      t.pending.push({ data: s.data, start, end: start + (s.duration || 0) });
      t.pendingEnd = start + (s.duration || 0);
      t.addedEnd = t.pendingEnd;
      pendingBytes += s.data.length;
      pump(false);
      return chain;
    }

    function pump(final) {
      for (;;) {
        let best = null;
        for (const t of tracks) if (t.head < t.pending.length && (!best || t.pendingStart < best.pendingStart)) best = t;
        if (!best) return;
        if (!final && pendingBytes <= MAX_PENDING) {
          if (best.pendingEnd - best.pendingStart < CHUNK) return;
          for (const o of tracks) if (o !== best && o.head === o.pending.length && o.addedEnd < best.pendingStart) return;
        }
        writeChunk(best);
      }
    }

    function writeChunk(t) {
      const first = t.head;
      let i = first;
      const parts = [];
      let bytes = 0;
      while (i < t.pending.length && (i === first || t.pending[i - 1].end - t.pending[first].start < CHUNK)) {
        parts.push(t.pending[i].data);
        bytes += t.pending[i].data.length;
        t.pending[i].data = null;
        i++;
      }
      t.chunkOffset.push(pos);
      t.chunkCount.push(i - first);
      // Small samples are copied into the output buffer; big ones go to the sink as they are (the caller keeps them
      // unchanged until the promise addVideo/addAudio returned has settled).
      if (bytes < OUT_BYTES) emit(parts.length === 1 ? parts[0].slice() : codecs.concat(parts));
      else for (const p of parts) emit(p);
      pendingBytes -= bytes;
      t.head = i;
      if (t.head > 1024 && t.head * 2 > t.pending.length) {
        t.pending = t.pending.slice(t.head);
        t.head = 0;
      }
      if (t.head < t.pending.length) t.pendingStart = t.pending[t.head].start;
    }

    async function finish({ chapters } = {}) {
      if (finished) throw new Error('mp4write: finish was already called');
      if (error) throw error;
      void chapters; // MP4 chapter boxes are a later step (features §15 [2]).
      pump(true);
      flushOut();
      const mdatSize = pos - mdatAt;
      emit(buildMoov(tracks, movieScale));
      flushOut();
      const size = new ByteWriter();
      size.u64(mdatSize);
      queue(size.done(), mdatAt + 8);
      finished = true;
      await chain;
      if (error) throw error;
      return { bytes: pos };
    }

    return {
      addVideo(sample) {
        if (!vtrack) throw new Error('mp4write: no video track');
        return add(vtrack, sample);
      },
      addAudio(sample) {
        if (!atrack) throw new Error('mp4write: no audio track');
        return add(atrack, sample);
      },
      finish,
      get position() { return pos; },
      get error() { return error; },
    };
  }

  function newTrack(kind, id, cfg, timescale) {
    return {
      kind, id, cfg, timescale, toUnits: codecs.unitsPer(timescale),
      dts: new Column(Float64Array), cto: new Column(Float64Array), dur: new Column(Float64Array),
      size: new Column(Uint32Array), key: new Column(Uint8Array),
      chunkOffset: new Column(Float64Array, 256), chunkCount: new Column(Uint32Array, 256),
      lastDts: -Infinity, firstPts: Infinity, endPts: -Infinity, addedEnd: -Infinity,
      pending: [], head: 0, pendingStart: 0, pendingEnd: 0,
    };
  }

  // ---- moov --------------------------------------------------------------------------------------------------------

  function trackLayout(t, movieScale) {
    const n = t.dts.n;
    const base = n ? t.dts.a[0] : 0;
    let mediaDuration = 0;
    for (let i = 0; i < n; i++) mediaDuration += t.dur.a[i];
    const toMovie = codecs.unitsPer(movieScale);
    const start = n ? Math.max(0, t.firstPts) : 0;
    const mediaTime = n ? t.toUnits(start) - base : 0;
    const segment = n ? Math.max(0, toMovie(t.endPts - start)) : 0;
    const empty = toMovie(start);
    let bytes = 0;
    let maxSize = 0;
    for (let i = 0; i < n; i++) { bytes += t.size.a[i]; maxSize = Math.max(maxSize, t.size.a[i]); }
    // The busiest second, for btrt and esds.
    const perSecond = new Map();
    for (let i = 0; i < n; i++) {
      const s = Math.floor((t.dts.a[i] - base) / t.timescale);
      perSecond.set(s, (perSecond.get(s) || 0) + t.size.a[i]);
    }
    let peak = 0;
    for (const v of perSecond.values()) peak = Math.max(peak, v);
    const seconds = mediaDuration / t.timescale;
    return {
      n, mediaDuration, empty, mediaTime, segment, edit: empty > 0 || mediaTime !== 0, duration: empty + segment,
      maxSize, avgBitrate: seconds > 0 ? Math.min(U32, Math.round((bytes * 8) / seconds)) : 0, maxBitrate: Math.min(U32, peak * 8),
    };
  }

  function buildMoov(tracks, movieScale) {
    const w = new ByteWriter(1 << 16);
    const layouts = tracks.map((t) => trackLayout(t, movieScale));
    const movieDuration = Math.max(0, ...layouts.map((l) => l.duration));
    w.box('moov', () => {
      const v = movieDuration > U32 ? 1 : 0;
      w.full('mvhd', v, 0, () => {
        if (v) w.u64(0).u64(0).u32(movieScale).u64(movieDuration);
        else w.u32(0).u32(0).u32(movieScale).u32(movieDuration);
        w.u32(0x10000).u16(0x100).zeros(10);
        for (const m of MATRIX) w.u32(m);
        w.zeros(24).u32(tracks.length + 1);
      });
      tracks.forEach((t, i) => writeTrak(w, t, layouts[i]));
    });
    return w.done();
  }

  function writeTrak(w, t, L) {
    const video = t.kind === 'video';
    w.box('trak', () => {
      const tv = L.duration > U32 ? 1 : 0;
      w.full('tkhd', tv, 3, () => {
        if (tv) w.u64(0).u64(0).u32(t.id).u32(0).u64(L.duration);
        else w.u32(0).u32(0).u32(t.id).u32(0).u32(L.duration);
        w.zeros(8).u16(0).u16(0).u16(video ? 0 : 0x100).u16(0);
        for (const m of MATRIX) w.u32(m);
        w.u32(video ? t.cfg.width * 65536 : 0).u32(video ? t.cfg.height * 65536 : 0);
      });
      if (L.edit) {
        const ev = L.segment > U32 || L.empty > U32 || L.mediaTime > 0x7fffffff ? 1 : 0;
        w.box('edts', () => w.full('elst', ev, 0, () => {
          const entries = (L.empty > 0 ? 1 : 0) + 1;
          w.u32(entries);
          const entry = (dur, media) => {
            if (ev) w.u64(dur).u32(media < 0 ? U32 : Math.floor(media / 4294967296)).u32(media < 0 ? U32 : media >>> 0);
            else w.u32(dur).u32(media);
            w.u16(1).u16(0);
          };
          if (L.empty > 0) entry(L.empty, -1);
          entry(L.segment, L.mediaTime);
        }));
      }
      w.box('mdia', () => {
        const mv = L.mediaDuration > U32 ? 1 : 0;
        w.full('mdhd', mv, 0, () => {
          if (mv) w.u64(0).u64(0).u32(t.timescale).u64(L.mediaDuration);
          else w.u32(0).u32(0).u32(t.timescale).u32(L.mediaDuration);
          w.u16(0x55c4).u16(0);
        });
        w.full('hdlr', 0, 0, () => w.u32(0).str(video ? 'vide' : 'soun').zeros(12).str(video ? 'VideoHandler' : 'SoundHandler').u8(0));
        w.box('minf', () => {
          if (video) w.full('vmhd', 0, 1, () => w.zeros(8));
          else w.full('smhd', 0, 0, () => w.zeros(4));
          w.box('dinf', () => w.full('dref', 0, 0, () => { w.u32(1); w.full('url ', 0, 1, () => {}); }));
          w.box('stbl', () => writeStbl(w, t, L));
        });
      });
    });
  }

  function sampleEntry(w, t, L) {
    const c = t.cfg;
    const btrt = () => w.box('btrt', () => w.u32(L.maxSize).u32(L.maxBitrate).u32(L.avgBitrate));
    if (t.kind === 'video') {
      const fam = c.info.family;
      const entry = c.info.entry || (fam === 'avc' ? 'avc1' : 'hvc1');
      w.box(entry, () => {
        w.zeros(6).u16(1).zeros(16).u16(c.width).u16(c.height).u32(0x480000).u32(0x480000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff);
        w.box(fam === 'avc' ? 'avcC' : 'hvcC', () => w.bytes(codecs.asBytes(c.description)));
        if (c.colorSpace) {
          const k = codecs.codesFromColor(c.colorSpace);
          w.box('colr', () => w.str('nclx').u16(k.primaries).u16(k.transfer).u16(k.matrix).u8(k.fullRange ? 0x80 : 0));
        }
        btrt();
      });
      return;
    }
    const rateField = c.sampleRate <= 65535 ? c.sampleRate * 65536 : 0;
    if (c.info.family === 'opus') {
      w.box('Opus', () => {
        w.zeros(6).u16(1).zeros(8).u16(c.channels).u16(16).u32(0).u32(48000 * 65536);
        const dOps = c.description ? codecs.dOpsFromOpusHead(codecs.asBytes(c.description))
          : codecs.dOpsFromOpusHead(codecs.buildOpusHead({ channels: c.channels, inputRate: c.sampleRate }));
        w.box('dOps', () => w.bytes(dOps));
        btrt();
      });
      return;
    }
    const asc = c.description ? codecs.asBytes(c.description)
      : codecs.buildAudioSpecificConfig({ objectType: c.info.objectType, sampleRate: c.sampleRate, channels: c.channels });
    w.box('mp4a', () => {
      w.zeros(6).u16(1).zeros(8).u16(c.channels).u16(16).u32(0).u32(rateField);
      w.full('esds', 0, 0, () => descriptor(w, 3, (es) => {
        es.u16(0).u8(0);
        descriptor(es, 4, (dc) => {
          dc.u8(0x40).u8(0x15).u24(Math.min(0xffffff, L.maxSize)).u32(L.maxBitrate).u32(L.avgBitrate);
          descriptor(dc, 5, (d) => d.bytes(asc));
        });
        descriptor(es, 6, (sl) => sl.u8(2));
      }));
      btrt();
    });
  }

  function writeStbl(w, t, L) {
    const n = L.n;
    w.full('stsd', 0, 0, () => { w.u32(1); sampleEntry(w, t, L); });
    const runs = (values, count) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const v = values[i];
        if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
        else out.push([1, v]);
      }
      return out;
    };
    const stts = runs(t.dur.a, n);
    w.full('stts', 0, 0, () => { w.u32(stts.length); for (const [k, v] of stts) w.u32(k).u32(v); });
    let anyCto = false;
    let negative = false;
    for (let i = 0; i < n; i++) if (t.cto.a[i]) { anyCto = true; if (t.cto.a[i] < 0) negative = true; }
    if (anyCto) {
      const ctts = runs(t.cto.a, n);
      w.full('ctts', negative ? 1 : 0, 0, () => { w.u32(ctts.length); for (const [k, v] of ctts) w.u32(k).u32(v); });
    }
    if (t.kind === 'video') {
      let keys = 0;
      for (let i = 0; i < n; i++) keys += t.key.a[i];
      if (keys < n) w.full('stss', 0, 0, () => { w.u32(keys); for (let i = 0; i < n; i++) if (t.key.a[i]) w.u32(i + 1); });
    }
    let uniform = n > 0;
    for (let i = 1; i < n && uniform; i++) if (t.size.a[i] !== t.size.a[0]) uniform = false;
    w.full('stsz', 0, 0, () => {
      w.u32(uniform ? t.size.a[0] : 0).u32(n);
      if (!uniform) for (let i = 0; i < n; i++) w.u32(t.size.a[i]);
    });
    const chunks = t.chunkCount.n;
    const stsc = [];
    for (let c = 0; c < chunks; c++) {
      const k = t.chunkCount.a[c];
      if (!stsc.length || stsc[stsc.length - 1][1] !== k) stsc.push([c + 1, k]);
    }
    w.full('stsc', 0, 0, () => { w.u32(stsc.length); for (const [first, k] of stsc) w.u32(first).u32(k).u32(1); });
    w.full('co64', 0, 0, () => { w.u32(chunks); for (let c = 0; c < chunks; c++) w.u64(t.chunkOffset.a[c]); });
  }

  return { create, videoTimescale };
});
