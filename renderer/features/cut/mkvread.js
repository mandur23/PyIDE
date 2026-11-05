// WebM and Matroska -> a Source (docs/cut-architecture.md §5). The EBML header, Info (TimestampScale, Duration),
// Tracks (CodecPrivate, video and audio settings, Colour, header stripping) and Cues are read whole; then every
// Cluster is walked for its SimpleBlocks and BlockGroups (Xiph, EBML and fixed lacing), in large windows when the
// blocks are small and with a jump per block when they are big. Clusters of unknown size (MediaRecorder writes them)
// end at the next level-1 element. After a damaged stretch the walk goes on at the next Cluster (from Cues, or by
// searching for its ID). Matroska stores presentation times only: decode times are the sorted presentation times.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).mkvread = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const codecs = NODE ? require('./codecs.js') : globalThis.Cut.codecs;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;
  const { fail, readRange, ascii, TableBuilder } = codecs;

  const ID = {
    EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab,
    SeekPosition: 0x53ac, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, Tracks: 0x1654ae6b,
    TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, DefaultDuration: 0x23e383,
    CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, DisplayWidth: 0x54b0,
    DisplayHeight: 0x54ba, DisplayUnit: 0x54b2, Colour: 0x55b0, MatrixCoefficients: 0x55b1, BitsPerChannel: 0x55b2,
    Range: 0x55b9, TransferCharacteristics: 0x55ba, Primaries: 0x55bb, Audio: 0xe1, SamplingFrequency: 0xb5,
    Channels: 0x9f, BitDepth: 0x6264, ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentEncodingType: 0x5033,
    ContentCompression: 0x5034, ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, Cues: 0x1c53bb6b,
    CuePoint: 0xbb, CueTrackPositions: 0xb7, CueClusterPosition: 0xf1, Cluster: 0x1f43b675, Timestamp: 0xe7,
    SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb,
    Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469, Void: 0xec, CRC32: 0xbf,
  };
  const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Cluster, ID.Tags, ID.Chapters, ID.Attachments]);
  const MAX_META = 64 * 1024 * 1024;

  // ---- EBML --------------------------------------------------------------------------------------------------------

  const vlen = (first) => (first ? Math.clz32(first) - 23 : 9);
  // An element header at b[i] -> { id, size (-1 = unknown), hdr } or null.
  function header(b, i) {
    if (i >= b.length) return null;
    const il = vlen(b[i]);
    if (il > 4 || i + il >= b.length) return null;
    let id = 0;
    for (let k = 0; k < il; k++) id = id * 256 + b[i + k];
    const s = i + il;
    const sl = vlen(b[s]);
    if (sl > 8 || s + sl > b.length) return null;
    let size = b[s] & (0xff >> sl);
    let ones = size === 0xff >> sl;
    for (let k = 1; k < sl; k++) { size = size * 256 + b[s + k]; ones = ones && b[s + k] === 255; }
    return { id, size: ones ? -1 : size, hdr: il + sl };
  }
  // The children of b[start, end): [{ id, start, end }].
  function elements(b, start, end) {
    const out = [];
    let p = start;
    while (p < end) {
      const h = header(b, p);
      if (!h || h.size < 0 || p + h.hdr + h.size > end) break;
      out.push({ id: h.id, start: p + h.hdr, end: p + h.hdr + h.size });
      p += h.hdr + h.size;
    }
    return out;
  }
  const uint = (b, e) => { let v = 0; for (let i = e.start; i < e.end; i++) v = v * 256 + b[i]; return v; };
  const float = (b, e) => {
    const dv = new DataView(b.buffer, b.byteOffset + e.start, e.end - e.start);
    return e.end - e.start === 4 ? dv.getFloat32(0) : e.end - e.start === 8 ? dv.getFloat64(0) : 0;
  };
  const str = (b, e) => ascii(b, e.start, e.end - e.start).replace(/\0+$/, '');
  function fields(b, e) {
    const m = new Map();
    for (const c of elements(b, e.start, e.end)) if (!m.has(c.id)) m.set(c.id, c);
    return m;
  }

  // ---- the head of the segment -------------------------------------------------------------------------------------

  async function readElement(reader, pos) {
    const h = header(await readRange(reader, pos, 12), 0);
    if (!h) return null;
    return { ...h, pos, data: pos + h.hdr };
  }
  async function readWhole(reader, el) {
    if (el.size < 0 || el.size > MAX_META) return null;
    const b = await readRange(reader, el.data, el.size);
    return b.length === el.size ? b : null;
  }

  function parseInfo(b) {
    const f = fields(b, { start: 0, end: b.length });
    return {
      scale: f.has(ID.TimestampScale) ? uint(b, f.get(ID.TimestampScale)) || 1000000 : 1000000,
      duration: f.has(ID.Duration) ? float(b, f.get(ID.Duration)) : null,
    };
  }

  function codecOf(codecId, priv, audio) {
    if (codecId === 'V_VP8') return { codec: 'vp8' };
    if (codecId === 'V_VP9') return { codec: 'vp9', vp9: priv };
    if (codecId === 'V_AV1') {
      if (!priv) fail('damaged', 'AV1 without CodecPrivate');
      const av1C = codecs.parseAv1C(priv);
      return { codec: codecs.av1CodecString(av1C), description: priv, bitDepth: av1C.bitDepth };
    }
    if (codecId === 'V_MPEG4/ISO/AVC') {
      if (!priv) fail('damaged', 'AVC without CodecPrivate');
      const avcC = codecs.parseAvcC(priv);
      return { codec: codecs.avcCodecString(avcC), description: priv, info: avcC.info };
    }
    if (codecId === 'V_MPEGH/ISO/HEVC') {
      if (!priv) fail('damaged', 'HEVC without CodecPrivate');
      const hvcC = codecs.parseHvcC(priv);
      return { codec: codecs.hevcCodecString(hvcC), description: priv, info: hvcC.info, bitDepth: hvcC.bitDepthLuma };
    }
    if (codecId === 'A_OPUS') {
      const head = priv ? codecs.parseOpusHead(priv) : null;
      return { codec: 'opus', description: priv, channels: head?.channels, sampleRate: 48000 };
    }
    if (codecId === 'A_VORBIS') {
      if (!priv) fail('damaged', 'Vorbis without CodecPrivate');
      return { codec: 'vorbis', description: priv };
    }
    if (codecId === 'A_FLAC') {
      const si = priv ? codecs.parseFlacStreamInfo(priv) : null;
      return { codec: 'flac', description: priv, sampleRate: si?.sampleRate, channels: si?.channels };
    }
    if (codecId === 'A_MPEG/L3') return { codec: 'mp3' };
    if (codecId.startsWith('A_AAC')) {
      if (priv && priv.length >= 2) {
        const asc = codecs.parseAudioSpecificConfig(priv);
        return { codec: codecs.aacCodecString(asc), description: priv, channels: asc.channels || undefined };
      }
      const objectType = /MAIN/.test(codecId) ? 1 : /SBR/.test(codecId) ? 5 : /LTP/.test(codecId) ? 4 : 2;
      const description = codecs.buildAudioSpecificConfig({ objectType, sampleRate: audio.rate, channels: audio.channels });
      return { codec: `mp4a.40.${objectType}`, description };
    }
    const pcm = /^A_PCM\/(INT\/LIT|INT\/BIG|FLOAT\/IEEE)$/.exec(codecId);
    if (pcm) {
      const bits = audio.bits || 16;
      const kind = pcm[1] === 'FLOAT/IEEE' ? 'f' : bits === 8 ? 'u' : 's';
      if (![8, 16, 24, 32, 64].includes(bits) || (kind === 'f' && bits < 32)) return null;
      return { codec: `pcm-${kind}${bits}${pcm[1] === 'INT/BIG' && bits > 8 ? 'be' : ''}`, pcm: (bits / 8) * (audio.channels || 1) };
    }
    return null;
  }

  function parseTracks(b) {
    const tracks = [];
    const skipped = [];
    for (const e of elements(b, 0, b.length)) {
      if (e.id !== ID.TrackEntry) continue;
      const f = fields(b, e);
      const number = f.has(ID.TrackNumber) ? uint(b, f.get(ID.TrackNumber)) : 0;
      const type = f.has(ID.TrackType) ? uint(b, f.get(ID.TrackType)) : 0;
      if (type !== 1 && type !== 2) continue;
      const kind = type === 1 ? 'video' : 'audio';
      const codecId = f.has(ID.CodecID) ? str(b, f.get(ID.CodecID)) : '';
      const priv = f.has(ID.CodecPrivate) ? b.slice(f.get(ID.CodecPrivate).start, f.get(ID.CodecPrivate).end) : null;
      const tr = { number, kind, codecId, defaultDuration: f.has(ID.DefaultDuration) ? uint(b, f.get(ID.DefaultDuration)) : 0,
        codecDelay: f.has(ID.CodecDelay) ? uint(b, f.get(ID.CodecDelay)) : 0, preRoll: f.has(ID.SeekPreRoll) ? uint(b, f.get(ID.SeekPreRoll)) : 0,
        prefix: null, video: null, audio: null };
      if (f.has(ID.ContentEncodings)) {
        for (const enc of elements(b, f.get(ID.ContentEncodings).start, f.get(ID.ContentEncodings).end)) {
          const ef = fields(b, enc);
          const encType = ef.has(ID.ContentEncodingType) ? uint(b, ef.get(ID.ContentEncodingType)) : 0;
          const comp = ef.get(ID.ContentCompression);
          const cf = comp ? fields(b, comp) : new Map();
          const algo = cf.has(ID.ContentCompAlgo) ? uint(b, cf.get(ID.ContentCompAlgo)) : 0;
          if (encType === 0 && algo === 3 && cf.has(ID.ContentCompSettings)) tr.prefix = b.slice(cf.get(ID.ContentCompSettings).start, cf.get(ID.ContentCompSettings).end);
          else tr.unsupported = encType === 1 ? 'encrypted' : `compressed (${algo})`;
        }
      }
      if (f.has(ID.Video)) {
        const v = fields(b, f.get(ID.Video));
        const g = (id, d = 0) => (v.has(id) ? uint(b, v.get(id)) : d);
        tr.video = { width: g(ID.PixelWidth), height: g(ID.PixelHeight), dw: g(ID.DisplayWidth), dh: g(ID.DisplayHeight), unit: g(ID.DisplayUnit), colorSpace: null };
        if (v.has(ID.Colour)) {
          const c = fields(b, v.get(ID.Colour));
          const cg = (id) => (c.has(id) ? uint(b, c.get(id)) : -1);
          const range = cg(ID.Range);
          tr.video.colorSpace = codecs.colorFromCodes(cg(ID.Primaries), cg(ID.TransferCharacteristics), cg(ID.MatrixCoefficients), range === 2 ? 1 : range === 1 ? 0 : null);
          if (cg(ID.BitsPerChannel) > 0) tr.video.bits = cg(ID.BitsPerChannel);
        }
      }
      const a = f.has(ID.Audio) ? fields(b, f.get(ID.Audio)) : new Map();
      tr.audio = { rate: a.has(ID.SamplingFrequency) ? float(b, a.get(ID.SamplingFrequency)) : 8000,
        channels: a.has(ID.Channels) ? uint(b, a.get(ID.Channels)) : 1, bits: a.has(ID.BitDepth) ? uint(b, a.get(ID.BitDepth)) : 0 };
      let c = null;
      try { c = tr.unsupported ? null : codecOf(codecId, priv, tr.audio); } catch (err) { tr.unsupported = err.detail || err.message; }
      if (!c || (kind === 'video') !== codecId.startsWith('V_')) {
        skipped.push({ id: number, kind, codec: codecId, reason: tr.unsupported || 'unsupported' });
        continue;
      }
      tr.c = c;
      tracks.push(tr);
    }
    return { tracks, skipped };
  }

  function parseSeekHead(b) {
    const out = new Map();
    for (const e of elements(b, 0, b.length)) {
      if (e.id !== ID.Seek) continue;
      const f = fields(b, e);
      if (f.has(ID.SeekID) && f.has(ID.SeekPosition)) out.set(uint(b, f.get(ID.SeekID)), uint(b, f.get(ID.SeekPosition)));
    }
    return out;
  }
  function parseCues(b) {
    const out = new Set();
    for (const e of elements(b, 0, b.length)) {
      if (e.id !== ID.CuePoint) continue;
      for (const c of elements(b, e.start, e.end)) {
        if (c.id !== ID.CueTrackPositions) continue;
        const f = fields(b, c);
        if (f.has(ID.CueClusterPosition)) out.add(uint(b, f.get(ID.CueClusterPosition)));
      }
    }
    return [...out].sort((x, y) => x - y);
  }

  // ---- clusters ----------------------------------------------------------------------------------------------------

  // Windowed reads over [0, end): large windows while blocks are small, a small read per element when they are big.
  function cursor(reader, end) {
    let buf = new Uint8Array(0);
    let at = 0;
    let blocks = 0;
    let blockBytes = 0;
    return {
      async view(p, n) {
        if (p < at || p + n > at + buf.length) {
          if (!(p >= at && at + buf.length >= end && p < end)) {
            const big = blocks > 8 && blockBytes / blocks > 256 * 1024;
            buf = await readRange(reader, p, Math.max(n, big ? 64 * 1024 : 1024 * 1024));
            at = p;
          }
        }
        return { b: buf, i: p - at };
      },
      block(size) { blocks++; blockBytes += size; },
    };
  }

  async function scanClusters(reader, segStart, segEnd, first, cues, byNumber) {
    const cur = cursor(reader, segEnd);
    let pos = first;
    let clusterTime = 0;
    let damaged = false;
    let resyncs = 0;
    const resync = async (from) => {
      damaged = true;
      if (++resyncs > 100000) return -1;
      const cue = cues.find((c) => segStart + c > from);
      let q = from;
      while (q + 4 <= segEnd) {
        const { b, i } = await cur.view(q, 4);
        const stop = Math.min(b.length - 3, i + (cue != null ? segStart + cue - q : b.length));
        for (let k = i; k < stop; k++) {
          if (b[k] === 0x1f && b[k + 1] === 0x43 && b[k + 2] === 0xb6 && b[k + 3] === 0x75) return q + (k - i);
        }
        const next = q + (stop - i);
        if (cue != null && next >= segStart + cue) return segStart + cue;
        if (next <= q) break;
        q = next;
      }
      return -1;
    };
    const addBlock = async (p, size, simple, groupKey, groupDuration) => {
      const head = async (n) => { const v = await cur.view(p, Math.min(size, n)); return v.b.subarray(v.i, v.i + Math.min(size, n)); };
      let b = await head(64);
      const sl = b.length ? vlen(b[0]) : 9;
      if (sl > 8 || b.length < sl + 3) return false;
      let number = b[0] & (0xff >> sl);
      for (let k = 1; k < sl; k++) number = number * 256 + b[k];
      const tr = byNumber.get(number);
      if (!tr) return true;
      const rel = ((b[sl] << 8) | b[sl + 1]) << 16 >> 16;
      const flags = b[sl + 2];
      const key = simple ? !!(flags & 0x80) : groupKey;
      const lacing = (flags >> 1) & 3;
      let hp = sl + 3;
      const t = clusterTime + rel;
      cur.block(size);
      if (lacing === 0) {
        tr.add(p + hp, size - hp, t, key, groupDuration, 0, 1);
        return true;
      }
      if (b.length < hp + 1) return false;
      const count = b[hp++] + 1;
      const sizes = [];
      const need = async (n) => { if (hp + n > b.length && b.length < size) b = await head(Math.max(b.length * 4, hp + n + 64)); return hp + n <= b.length; };
      if (lacing === 1) {
        for (let k = 0; k < count - 1; k++) {
          let s = 0;
          for (;;) {
            if (!(await need(1))) return false;
            const v = b[hp++];
            s += v;
            if (v !== 255) break;
          }
          sizes.push(s);
        }
      } else if (lacing === 3) {
        if (!(await need(8))) return false;
        let l = vlen(b[hp]);
        if (l > 8) return false;
        let s = b[hp] & (0xff >> l);
        for (let k = 1; k < l; k++) s = s * 256 + b[hp + k];
        hp += l;
        sizes.push(s);
        for (let k = 1; k < count - 1; k++) {
          if (!(await need(8))) return false;
          l = vlen(b[hp]);
          if (l > 8) return false;
          let raw = b[hp] & (0xff >> l);
          for (let j = 1; j < l; j++) raw = raw * 256 + b[hp + j];
          hp += l;
          s += raw - (2 ** (7 * l - 1) - 1);
          sizes.push(s);
        }
      }
      const data = size - hp;
      if (lacing === 2) for (let k = 0; k < count - 1; k++) sizes.push(Math.floor(data / count));
      const used = sizes.reduce((x, y) => x + y, 0);
      if (used > data || sizes.some((s) => s < 0)) return false;
      sizes.push(data - used);
      let off = p + hp;
      for (let k = 0; k < count; k++) {
        tr.add(off, sizes[k], t, key, groupDuration, k, count);
        off += sizes[k];
      }
      return true;
    };

    let inGroup = null;
    for (let steps = 0; pos < segEnd && steps < 50000000; steps++) {
      if (inGroup && pos >= inGroup.end) {
        await finishGroup(inGroup);
        inGroup = null;
      }
      const { b, i } = await cur.view(pos, 12);
      const h = header(b, i);
      const bad = !h || h.id < 0x80 || (h.size >= 0 && h.id !== ID.Cluster && pos + h.hdr + h.size > segEnd);
      if (bad || (h.size < 0 && h.id !== ID.Cluster)) {
        if (!bad && LEVEL1.has(h.id)) break;
        if (inGroup) await finishGroup(inGroup);
        inGroup = null;
        const next = await resync(pos + 1);
        if (next < 0) break;
        pos = next;
        continue;
      }
      const end = pos + h.hdr + h.size;
      if (h.id === ID.Cluster) {
        clusterTime = 0;
        pos += h.hdr;
        continue;
      }
      if (h.id === ID.Timestamp) {
        const v = await cur.view(pos + h.hdr, h.size);
        clusterTime = uint(v.b, { start: v.i, end: v.i + h.size });
      } else if (h.id === ID.SimpleBlock) {
        if (!(await addBlock(pos + h.hdr, h.size, true, true, null))) damaged = true;
      } else if (h.id === ID.BlockGroup) {
        inGroup = { end, block: null, key: true, duration: null };
        pos += h.hdr;
        continue;
      } else if (inGroup && h.id === ID.Block) {
        inGroup.block = { p: pos + h.hdr, size: h.size };
      } else if (inGroup && h.id === ID.ReferenceBlock) {
        inGroup.key = false;
      } else if (inGroup && h.id === ID.BlockDuration) {
        const v = await cur.view(pos + h.hdr, h.size);
        inGroup.duration = uint(v.b, { start: v.i, end: v.i + h.size });
      }
      pos = end;
    }
    if (inGroup) await finishGroup(inGroup);
    return { damaged };

    async function finishGroup(g) {
      if (g.block && !(await addBlock(g.block.p, g.block.size, false, g.key, g.duration))) damaged = true;
    }
  }

  // ---- tracks ------------------------------------------------------------------------------------------------------

  function trackState(tr) {
    const tb = new TableBuilder(4096);
    const laced = [];
    const durations = [];
    return {
      tr, tb, laced, durations,
      add(offset, size, t, key, blockDuration, k, count) {
        const i = tb.push(offset, size, 0, t, 0, tr.kind === 'audio' || key);
        durations[i] = blockDuration != null ? blockDuration / count : NaN;
        if (count > 1 && k === 0) laced.push([i, count]);
      },
    };
  }

  async function finishState(st, scale, reader) {
    const { tr, tb } = st;
    const t = tb.done();
    const n = t.count;
    const unit = (scale * time.TICKS) / 1e9;
    const toTicks = Number.isInteger(unit) ? (v) => Math.round(v * unit) : (v) => codecs.rescale(v * scale, 1e9);
    const defaultUnits = tr.defaultDuration ? tr.defaultDuration / scale : 0;
    // Laced frames share their block's time: spread them by the default duration, or evenly up to the next block.
    for (const [first, count] of st.laced) {
      const base = t.pts[first];
      let step = defaultUnits;
      if (!step) {
        const next = first + count < n ? t.pts[first + count] : NaN;
        step = next > base ? (next - base) / count : st.durations[first] || 0;
      }
      for (let k = 1; k < count && first + k < n; k++) t.pts[first + k] = base + k * step;
    }
    const delay = tr.codecDelay ? codecs.rescale(tr.codecDelay, 1e9) : 0;
    for (let i = 0; i < n; i++) t.pts[i] = toTicks(t.pts[i]) - delay;
    if (tr.kind === 'video') {
      const sorted = Float64Array.from(t.pts).sort();
      t.dts.set(sorted);
    } else t.dts.set(t.pts);
    const fallback = defaultUnits ? toTicks(defaultUnits) : 0;
    const ord = new Uint32Array(n);
    for (let i = 0; i < n; i++) ord[i] = i;
    if (tr.kind === 'video') ord.sort((a, b) => t.pts[a] - t.pts[b] || a - b);
    const rate = tr.c.sampleRate || Math.round(tr.audio.rate);
    for (let k = 0; k < n; k++) {
      const i = ord[k];
      let d;
      if (tr.c.pcm) d = codecs.rescale(Math.floor(t.size[i] / tr.c.pcm), rate);
      else if (k + 1 < n) d = t.pts[ord[k + 1]] - t.pts[i];
      else if (!Number.isNaN(st.durations[i])) d = toTicks(st.durations[i]);
      else d = fallback || (k ? t.duration[ord[k - 1]] : 0);
      t.duration[i] = Math.max(0, d);
    }
    let end = 0;
    for (let i = 0; i < n; i++) end = Math.max(end, t.pts[i] + t.duration[i]);
    const track = { id: tr.number, kind: tr.kind, codec: tr.c.codec, description: tr.c.description || null, samples: t, duration: end,
      truncated: false, preRoll: tr.preRoll ? codecs.rescale(tr.preRoll, 1e9) : tr.c.codec === 'opus' ? time.fromSeconds(0.08) : 0 };
    if (tr.prefix) track.samplePrefix = tr.prefix;
    if (tr.kind === 'video') {
      const v = tr.video || { width: 0, height: 0, dw: 0, dh: 0, unit: 0, colorSpace: null };
      track.width = v.width || tr.c.info?.width || 0;
      track.height = v.height || tr.c.info?.height || 0;
      if (v.dw && v.dh && v.unit === 3) {
        track.displayWidth = Math.round((track.height * v.dw) / v.dh);
        track.displayHeight = track.height;
      } else {
        track.displayWidth = v.unit === 0 && v.dw ? v.dw : track.width;
        track.displayHeight = v.unit === 0 && v.dh ? v.dh : track.height;
      }
      track.rotation = 0;
      track.colorSpace = codecs.mergeColor(v.colorSpace, tr.c.info?.colorSpace || null);
      track.bitDepth = tr.c.bitDepth || v.bits || tr.c.info?.bitDepthLuma || 8;
      if (tr.c.codec === 'vp9') await finishVp9(track, tr, reader);
    } else {
      track.sampleRate = rate;
      track.channels = tr.c.channels || tr.audio.channels;
    }
    codecs.finishTrack(track, { quantum: toTicks(1) });
    return track;
  }

  // VP9 has no configuration record in Matroska (CodecPrivate, when there, holds a few features): the profile and
  // bit depth come from the first key frame.
  async function finishVp9(track, tr, reader) {
    const feature = { profile: null, level: null, bitDepth: null };
    const p = tr.c.vp9;
    for (let i = 0; p && i + 2 < p.length; i += 2 + p[i + 1]) {
      const v = p[i + 2];
      if (p[i] === 1) feature.profile = v;
      else if (p[i] === 2) feature.level = v;
      else if (p[i] === 3) feature.bitDepth = v;
    }
    const s = track.samples;
    let k = 0;
    while (k < s.count - 1 && !s.key[k]) k++;
    let frame = null;
    if (s.count) {
      try {
        const bytes = await readRange(reader, s.offset[k], Math.min(s.size[k], 64));
        frame = codecs.parseVp9Frame(track.samplePrefix ? codecs.concat([track.samplePrefix, bytes]) : bytes);
      } catch { frame = null; }
    }
    const profile = feature.profile ?? frame?.profile ?? 0;
    const bitDepth = feature.bitDepth ?? frame?.bitDepth ?? 8;
    if (!track.width && frame?.width) { track.width = track.displayWidth = frame.width; track.height = track.displayHeight = frame.height; }
    const fps = s.count > 1 ? time.TICKS / Math.max(1, (s.pts[s.count - 1] - s.pts[0]) / (s.count - 1)) : 30;
    const level = feature.level ?? codecs.vp9Level(track.width, track.height, Number.isFinite(fps) ? fps : 30);
    track.codec = codecs.vp9CodecString({ profile, level, bitDepth });
    track.bitDepth = bitDepth;
    if (!track.colorSpace && frame?.colorSpace) track.colorSpace = frame.colorSpace;
  }

  // reader -> Source.
  async function open(reader) {
    const size = reader.size;
    const ebml = await readElement(reader, 0);
    if (!ebml || ebml.id !== ID.EBML || ebml.size < 0) fail('damaged', 'no EBML header');
    const eb = await readWhole(reader, ebml);
    if (!eb) fail('damaged', 'the EBML header is cut off');
    const ef = fields(eb, { start: 0, end: eb.length });
    const docType = ef.has(ID.DocType) ? str(eb, ef.get(ID.DocType)) : 'matroska';
    if (docType !== 'webm' && docType !== 'matroska') fail('unsupported', `EBML document ${docType}`);
    let pos = ebml.data + ebml.size;
    let seg = await readElement(reader, pos);
    for (let i = 0; seg && seg.id === ID.Void && i < 16; i++) seg = await readElement(reader, (pos = seg.data + seg.size));
    if (!seg || seg.id !== ID.Segment) fail('damaged', 'no Segment');
    const segStart = seg.data;
    const segEnd = seg.size < 0 ? size : Math.min(size, segStart + seg.size);
    let info = null;
    let tracksBytes = null;
    let seek = new Map();
    let cues = [];
    let firstCluster = -1;
    pos = segStart;
    for (let i = 0; pos < segEnd && i < 10000; i++) {
      const el = await readElement(reader, pos);
      if (!el || el.id < 0x80) break;
      if (el.id === ID.Cluster) { firstCluster = pos; break; }
      if (el.size < 0) break;
      if (el.id === ID.Info || el.id === ID.Tracks || el.id === ID.SeekHead || el.id === ID.Cues) {
        const b = await readWhole(reader, el);
        if (b && el.id === ID.Info) info = parseInfo(b);
        else if (b && el.id === ID.Tracks) tracksBytes = tracksBytes || b;
        else if (b && el.id === ID.SeekHead) for (const [k, v] of parseSeekHead(b)) if (!seek.has(k)) seek.set(k, v);
        else if (b && el.id === ID.Cues) cues = parseCues(b);
      }
      pos = el.data + el.size;
    }
    const fetch = async (id) => {
      if (!seek.has(id)) return null;
      const el = await readElement(reader, segStart + seek.get(id));
      return el && el.id === id ? readWhole(reader, el) : null;
    };
    if (!info) { const b = await fetch(ID.Info); if (b) info = parseInfo(b); }
    if (!tracksBytes) tracksBytes = await fetch(ID.Tracks);
    if (!cues.length) { const b = await fetch(ID.Cues); if (b) cues = parseCues(b); }
    if (!tracksBytes) fail('damaged', 'no Tracks');
    info = info || { scale: 1000000, duration: null };
    const { tracks: entries, skipped } = parseTracks(tracksBytes);
    const byNumber = new Map(entries.map((tr) => [tr.number, trackState(tr)]));
    if (firstCluster < 0) firstCluster = cues.length ? segStart + cues[0] : pos;
    let damaged = false;
    if (firstCluster < segEnd && byNumber.size) ({ damaged } = await scanClusters(reader, segStart, segEnd, firstCluster, cues, byNumber));
    const tracks = [];
    for (const st of byNumber.values()) {
      const track = await finishState(st, info.scale, reader);
      if (track.samples.count) tracks.push(track);
      else skipped.push({ id: track.id, kind: track.kind, codec: track.codec, reason: 'empty' });
    }
    tracks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
    const declared = info.duration ? codecs.rescale(info.duration * info.scale, 1e9) : 0;
    const measured = tracks.length ? Math.max(...tracks.map((t) => t.duration)) : 0;
    const duration = declared > 0 && measured > 0 ? Math.min(declared, measured) : measured;
    return { container: docType === 'webm' ? 'webm' : 'mkv', duration, tracks, skipped, damaged, image: null, error: null };
  }

  return { open, header, elements, ID };
});
