// MP4 and MOV (ISO BMFF / QuickTime) -> a Source (docs/cut-architecture.md §5): the top-level boxes are walked with
// small reads (mdat is never read), moov and every moof are read whole and turned into per-track sample tables:
// stts, ctts v0/v1, stss, stsz/stz2, stsc, stco/co64, the first edit of elst, the tkhd matrix (rotation), colr and
// pasp, and fragmented files (mvex/trex, moof/traf/tfhd/tfdt/trun). Uncompressed PCM is indexed a chunk at a time
// (cut into pieces of at most a second), not a PCM frame at a time.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).mp4read = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const codecs = NODE ? require('./codecs.js') : globalThis.Cut.codecs;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;
  const { fail, readRange, u16, u32, i32, u64, ascii, TableBuilder } = codecs;

  const MAX_MOOV = 512 * 1024 * 1024;
  const MAX_MOOF = 64 * 1024 * 1024;
  const PRINTABLE = /^[\x20-\x7e]{4}$/;

  // The child boxes of b[start, end): [{ type, start (payload), end }]; a child that runs past its parent ends the list.
  function boxes(b, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(b, p);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = u64(b, p + 8);
        hdr = 16;
      } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type: ascii(b, p + 4, 4), start: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (b, box, type) => (box ? boxes(b, box.start, box.end).find((x) => x.type === type) || null : null);
  const all = (b, box, type) => (box ? boxes(b, box.start, box.end).filter((x) => x.type === type) : []);
  function dig(b, box, ...types) {
    let cur = box;
    for (const t of types) cur = child(b, cur, t);
    return cur;
  }

  // ---- top level -------------------------------------------------------------------------------------------------

  async function scanTop(reader) {
    const size = reader.size;
    const top = { ftyp: null, moov: null, moofs: [], damaged: null, mdat: false };
    let pos = 0;
    let ahead = null;
    for (let count = 0; pos + 8 <= size && count < 4000000; count++) {
      const h = ahead && ahead.pos === pos && ahead.bytes.length >= 16 ? ahead.bytes : await readRange(reader, pos, 16);
      ahead = null;
      if (h.length < 8) break;
      let boxSize = u32(h, 0);
      const type = ascii(h, 4, 4);
      let hdr = 8;
      if (boxSize === 1) {
        if (h.length < 16) break;
        boxSize = u64(h, 8);
        hdr = 16;
      } else if (boxSize === 0) boxSize = size - pos;
      if (!PRINTABLE.test(type) || boxSize < hdr) {
        if (!top.moov && !top.moofs.length) top.damaged = `no box at byte ${pos}`;
        break;
      }
      const end = pos + boxSize;
      if (type === 'moov') {
        if (end > size) { top.damaged = 'the moov box is cut off'; break; }
        if (boxSize > MAX_MOOV) fail('unsupported', 'the moov box is too big');
        if (!top.moov) top.moov = await readRange(reader, pos, boxSize);
      } else if (type === 'moof') {
        if (end > size) break;
        if (boxSize > MAX_MOOF) { top.damaged = 'a moof box is too big'; break; }
        const bytes = await readRange(reader, pos, boxSize + 16);
        top.moofs.push({ pos, bytes: bytes.subarray(0, boxSize) });
        ahead = { pos: end, bytes: bytes.subarray(boxSize) };
      } else if (type === 'ftyp' && !top.ftyp) {
        top.ftyp = await readRange(reader, pos, Math.min(boxSize, 4096));
      } else if (type === 'mdat') top.mdat = true;
      pos = end;
    }
    return top;
  }

  function brands(ftyp) {
    if (!ftyp || ftyp.length < 16) return { major: '', all: [] };
    const all = [ascii(ftyp, 8, 4)];
    for (let p = 16; p + 4 <= ftyp.length; p += 4) all.push(ascii(ftyp, p, 4));
    return { major: all[0], all };
  }

  // ---- sample entries ----------------------------------------------------------------------------------------------

  function readColr(b, box) {
    if (!box || box.end - box.start < 10) return null;
    const kind = ascii(b, box.start, 4);
    if (kind !== 'nclx' && kind !== 'nclc') return null;
    const p = box.start + 4;
    const full = kind === 'nclx' && box.end - box.start >= 11 ? b[p + 6] >> 7 : null;
    return codecs.colorFromCodes(u16(b, p), u16(b, p + 2), u16(b, p + 4), full);
  }

  function videoEntry(b, e) {
    const type = e.type;
    const out = { kind: 'video', width: u16(b, e.start + 24), height: u16(b, e.start + 26), sar: null, colorSpace: null, description: null };
    const kids = { start: e.start + 78, end: e.end };
    const info = (x) => {
      if (!x) return;
      if (!out.width || !out.height) { out.width = x.width; out.height = x.height; }
      if (x.sar && (x.sar[0] !== x.sar[1])) out.sar = x.sar;
      out.colorSpace = x.colorSpace;
      out.bitDepth = x.bitDepthLuma;
    };
    if (type === 'avc1' || type === 'avc3') {
      const box = child(b, kids, 'avcC');
      if (!box) fail('damaged', 'no avcC');
      out.description = b.slice(box.start, box.end);
      const avcC = codecs.parseAvcC(out.description);
      out.codec = codecs.avcCodecString(avcC, type);
      info(avcC.info);
    } else if (type === 'hvc1' || type === 'hev1') {
      const box = child(b, kids, 'hvcC');
      if (!box) fail('damaged', 'no hvcC');
      out.description = b.slice(box.start, box.end);
      const hvcC = codecs.parseHvcC(out.description);
      out.codec = codecs.hevcCodecString(hvcC, type);
      info(hvcC.info);
      out.bitDepth = hvcC.bitDepthLuma;
    } else if (type === 'vp09') {
      const box = child(b, kids, 'vpcC');
      if (!box) fail('damaged', 'no vpcC');
      const vpcC = codecs.parseVpcC(b.subarray(box.start + 4, box.end), b[box.start]);
      out.codec = codecs.vp9CodecString(vpcC);
      out.colorSpace = vpcC.colorSpace;
      out.bitDepth = vpcC.bitDepth;
    } else if (type === 'av01') {
      const box = child(b, kids, 'av1C');
      if (!box) fail('damaged', 'no av1C');
      out.description = b.slice(box.start, box.end);
      const av1C = codecs.parseAv1C(out.description);
      out.codec = codecs.av1CodecString(av1C);
      out.bitDepth = av1C.bitDepth;
    } else return null;
    out.colorSpace = codecs.mergeColor(readColr(b, child(b, kids, 'colr')), out.colorSpace);
    const pasp = child(b, kids, 'pasp');
    if (pasp && pasp.end - pasp.start >= 8) {
      const h = u32(b, pasp.start);
      const v = u32(b, pasp.start + 4);
      if (h && v) out.sar = [h, v];
    }
    return out;
  }

  // An ES_Descriptor (esds payload after version and flags) -> { oti, asc }.
  function readEsds(b, start, end) {
    let p = start;
    const tag = () => {
      if (p >= end) return null;
      const t = b[p++];
      let len = 0;
      for (let i = 0; i < 4 && p < end; i++) {
        const v = b[p++];
        len = len * 128 + (v & 127);
        if (!(v & 128)) break;
      }
      return { t, len, at: p };
    };
    const es = tag();
    if (!es || es.t !== 3) return null;
    p += 2;
    const flags = b[p++];
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + b[p];
    if (flags & 0x20) p += 2;
    const dc = tag();
    if (!dc || dc.t !== 4) return null;
    const oti = b[p];
    p += 13;
    const dsi = tag();
    const asc = dsi && dsi.t === 5 ? b.slice(dsi.at, Math.min(end, dsi.at + dsi.len)) : null;
    return { oti, asc };
  }
  function findDeep(b, box, type, depth = 0) {
    if (!box || depth > 3) return null;
    for (const k of boxes(b, box.start, box.end)) {
      if (k.type === type) return k;
      if (k.type === 'wave') {
        const inner = findDeep(b, k, type, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  }

  const PCM_TYPES = { sowt: ['s', false], twos: ['s', true], in24: ['s', true, 24], in32: ['s', true, 32], fl32: ['f', true, 32],
    fl64: ['f', true, 64], 'raw ': ['u', false, 8], ipcm: ['s', true], fpcm: ['f', true], lpcm: ['s', true] };
  function audioEntry(b, e, qt) {
    const type = e.type;
    const version = u16(b, e.start + 8);
    const out = { kind: 'audio', channels: u16(b, e.start + 16), sampleRate: u32(b, e.start + 24) / 65536, description: null };
    let bits = u16(b, e.start + 18);
    let kidsStart = e.start + 28;
    let lpcmFlags = 0;
    if (qt && version === 1) kidsStart += 16;
    else if (qt && version === 2) {
      const dv = new DataView(b.buffer, b.byteOffset + e.start + 32, 8);
      out.sampleRate = dv.getFloat64(0);
      out.channels = u32(b, e.start + 40);
      bits = u32(b, e.start + 48);
      lpcmFlags = u32(b, e.start + 52);
      kidsStart += 36;
    }
    const kids = { start: kidsStart, end: e.end };
    if (type === 'mp4a' || type === '.mp3' || type === 'ms\u0000U') {
      const box = findDeep(b, kids, 'esds');
      const es = box ? readEsds(b, box.start + 4, box.end) : null;
      if (type !== 'mp4a' || (es && (es.oti === 0x6b || es.oti === 0x69))) out.codec = 'mp3';
      else if (es && es.asc && [0x40, 0x66, 0x67, 0x68].includes(es.oti)) {
        const asc = codecs.parseAudioSpecificConfig(es.asc);
        out.codec = es.oti === 0x40 ? codecs.aacCodecString(asc) : `mp4a.${es.oti.toString(16)}`;
        out.description = es.asc;
        if (asc.channels) out.channels = asc.channels;
        if (!out.sampleRate) out.sampleRate = asc.sampleRate;
        out.frameLength = asc.frameLength;
      } else return null;
    } else if (type === 'Opus') {
      const box = child(b, kids, 'dOps');
      if (!box) fail('damaged', 'no dOps');
      out.description = codecs.opusHeadFromDOps(b.subarray(box.start, box.end));
      out.codec = 'opus';
      out.channels = b[box.start + 1];
      out.sampleRate = 48000;
    } else if (type === 'fLaC') {
      const box = child(b, kids, 'dfLa');
      if (!box) fail('damaged', 'no dfLa');
      out.description = codecs.concat([Uint8Array.of(0x66, 0x4c, 0x61, 0x43), b.subarray(box.start + 4, box.end)]);
      const si = codecs.parseFlacStreamInfo(out.description);
      out.codec = 'flac';
      if (si) { out.sampleRate = si.sampleRate; out.channels = si.channels; }
    } else if (PCM_TYPES[type]) {
      let [kind, big, size] = PCM_TYPES[type];
      if (size) bits = size;
      const pcmC = child(b, kids, 'pcmC');
      if (pcmC && pcmC.end - pcmC.start >= 6) { big = !(b[pcmC.start + 4] & 1); bits = b[pcmC.start + 5]; }
      const enda = findDeep(b, kids, 'enda');
      if (enda && enda.end - enda.start >= 2 && u16(b, enda.start) === 1) big = false;
      if (type === 'lpcm') {
        kind = lpcmFlags & 1 ? 'f' : lpcmFlags & 4 ? 's' : 'u';
        big = !!(lpcmFlags & 2);
      }
      if (bits === 8) { big = false; if (type === 'twos') kind = 's'; else if (type !== 'lpcm' && type !== 'ipcm') kind = 'u'; }
      if (![8, 16, 24, 32, 64].includes(bits) || (kind === 'f' && bits < 32)) return null;
      out.codec = `pcm-${kind}${bits}${big ? 'be' : ''}`;
      out.pcm = { bytes: (bits / 8) * out.channels };
    } else return null;
    return out;
  }

  // ---- sample tables -------------------------------------------------------------------------------------------------

  // Run-length tables (stts, ctts, stsc) read as cursors.
  function runs(b, box, entrySize) {
    if (!box) return { n: 0, at: () => 0 };
    const n = Math.min(u32(b, box.start + 4), Math.floor((box.end - box.start - 8) / entrySize));
    return { n, base: box.start + 8 };
  }

  function sampleSizes(b, stbl) {
    const stsz = child(b, stbl, 'stsz');
    if (stsz) {
      const fixed = u32(b, stsz.start + 4);
      const n = u32(b, stsz.start + 8);
      if (fixed) return { n, fixed, sizes: null };
      const have = Math.min(n, Math.floor((stsz.end - stsz.start - 12) / 4));
      const sizes = new Uint32Array(have);
      for (let i = 0, p = stsz.start + 12; i < have; i++, p += 4) sizes[i] = u32(b, p);
      return { n: have, fixed: 0, sizes };
    }
    const stz2 = child(b, stbl, 'stz2');
    if (!stz2) return { n: 0, fixed: 0, sizes: new Uint32Array(0) };
    const field = b[stz2.start + 7];
    const n = u32(b, stz2.start + 8);
    const p0 = stz2.start + 12;
    const have = Math.min(n, Math.floor(((stz2.end - p0) * 8) / (field || 8)));
    const sizes = new Uint32Array(have);
    for (let i = 0; i < have; i++) {
      if (field === 4) sizes[i] = i & 1 ? b[p0 + (i >> 1)] & 15 : b[p0 + (i >> 1)] >> 4;
      else if (field === 8) sizes[i] = b[p0 + i];
      else sizes[i] = u16(b, p0 + 2 * i);
    }
    return { n: have, fixed: 0, sizes };
  }

  function chunkOffsets(b, stbl) {
    const co64 = child(b, stbl, 'co64');
    const stco = co64 ? null : child(b, stbl, 'stco');
    const box = co64 || stco;
    if (!box) return new Float64Array(0);
    const step = co64 ? 8 : 4;
    const n = Math.min(u32(b, box.start + 4), Math.floor((box.end - box.start - 8) / step));
    const out = new Float64Array(n);
    for (let i = 0, p = box.start + 8; i < n; i++, p += step) out[i] = co64 ? u64(b, p) : u32(b, p);
    return out;
  }

  // Calls fn(chunkIndex, offset, samplesInChunk) for every chunk, from stsc.
  function eachChunk(b, stbl, offsets, fn) {
    const stsc = runs(b, child(b, stbl, 'stsc'), 12);
    for (let e = 0; e < stsc.n; e++) {
      const p = stsc.base + e * 12;
      const first = u32(b, p) - 1;
      const per = u32(b, p + 4);
      const next = e + 1 < stsc.n ? u32(b, p + 12) - 1 : offsets.length;
      for (let c = Math.max(0, first); c < Math.min(next, offsets.length); c++) if (fn(c, offsets[c], per) === false) return;
    }
  }

  // Sample i -> media-time units, as a cursor over stts.
  function sttsCursor(b, stbl) {
    const s = runs(b, child(b, stbl, 'stts'), 8);
    let e = -1;
    let left = 0;
    let delta = 0;
    const next = () => {
      while (left === 0 && e + 1 < s.n) {
        e++;
        left = u32(b, s.base + e * 8);
        delta = u32(b, s.base + e * 8 + 4);
      }
    };
    return {
      // The duration of the next `count` samples (the last delta repeats past the table's end).
      take(count) {
        let sum = 0;
        while (count > 0) {
          next();
          if (left === 0) return sum + count * delta;
          const k = Math.min(left, count);
          sum += k * delta;
          left -= k;
          count -= k;
        }
        return sum;
      },
      one() { next(); if (left > 0) left--; return delta; },
    };
  }

  function stblTable(b, stbl, entry, timescale) {
    const offsets = chunkOffsets(b, stbl);
    if (entry.pcm) return pcmTable(b, stbl, entry, timescale, offsets);
    const { n, fixed, sizes } = sampleSizes(b, stbl);
    const tb = new TableBuilder(n);
    const t = tb.t;
    let i = 0;
    eachChunk(b, stbl, offsets, (c, offset, per) => {
      for (let k = 0; k < per && i < n; k++, i++) {
        const size = fixed || sizes[i];
        tb.push(offset, size, 0, 0, 0, 1);
        offset += size;
      }
      return i < n;
    });
    const count = tb.n;
    const stts = sttsCursor(b, stbl);
    let dts = 0;
    for (let k = 0; k < count; k++) {
      const d = stts.one();
      t.dts[k] = dts;
      t.pts[k] = dts;
      t.duration[k] = d;
      dts += d;
    }
    const ctts = child(b, stbl, 'ctts');
    if (ctts) {
      const r = runs(b, ctts, 8);
      let k = 0;
      for (let e = 0; e < r.n && k < count; e++) {
        const m = u32(b, r.base + e * 8);
        const off = i32(b, r.base + e * 8 + 4);
        for (let j = 0; j < m && k < count; j++, k++) t.pts[k] += off;
      }
    }
    const stss = child(b, stbl, 'stss');
    if (stss) {
      t.key.fill(0, 0, count);
      const r = runs(b, stss, 4);
      for (let e = 0; e < r.n; e++) {
        const s = u32(b, r.base + e * 4) - 1;
        if (s >= 0 && s < count) t.key[s] = 1;
      }
    }
    return tb;
  }

  // PCM: one table entry per piece of a chunk, at most a second (or 1 MB) of frames.
  function pcmTable(b, stbl, entry, timescale, offsets) {
    const bpf = entry.pcm.bytes;
    const rate = Math.round(entry.sampleRate) || timescale;
    const piece = Math.max(1, Math.min(rate, Math.floor((1 << 20) / bpf)));
    const tb = new TableBuilder(offsets.length * 2);
    const stts = sttsCursor(b, stbl);
    const total = (() => { const s = sampleSizes(b, stbl); return s.n; })();
    let done = 0;
    let frame = 0;
    eachChunk(b, stbl, offsets, (c, offset, per) => {
      const count = total ? Math.min(per, total - done) : per;
      if (count <= 0) return false;
      done += count;
      const units = stts.take(count);
      let frames = timescale === rate ? units : Math.round((units * rate) / timescale);
      while (frames > 0) {
        const k = Math.min(piece, frames);
        tb.push(offset, k * bpf, frame, frame, k, 1);
        offset += k * bpf;
        frame += k;
        frames -= k;
      }
      return true;
    });
    tb.rate = rate;
    return tb;
  }

  // ---- fragments -------------------------------------------------------------------------------------------------

  function readFragments(moofs, byId) {
    for (const { pos, bytes: b } of moofs) {
      const moof = { start: 8, end: b.length };
      let prevEnd = pos;
      for (const traf of all(b, moof, 'traf')) {
        const tfhd = child(b, traf, 'tfhd');
        if (!tfhd) continue;
        const flags = u32(b, tfhd.start) & 0xffffff;
        const tr = byId.get(u32(b, tfhd.start + 4));
        if (!tr) continue;
        let p = tfhd.start + 8;
        let base = flags & 0x20000 ? pos : prevEnd;
        if (flags & 1) { base = u64(b, p); p += 8; }
        if (flags & 2) p += 4;
        const defDur = flags & 8 ? u32(b, (p += 4) - 4) : tr.trex.duration;
        const defSize = flags & 0x10 ? u32(b, (p += 4) - 4) : tr.trex.size;
        const defFlags = flags & 0x20 ? u32(b, (p += 4) - 4) : tr.trex.flags;
        const tfdt = child(b, traf, 'tfdt');
        if (tfdt) tr.nextDts = b[tfdt.start] === 1 ? u64(b, tfdt.start + 4) : u32(b, tfdt.start + 4);
        let dataAt = base;
        for (const trun of all(b, traf, 'trun')) {
          const tf = u32(b, trun.start) & 0xffffff;
          const count = u32(b, trun.start + 4);
          let q = trun.start + 8;
          if (tf & 1) { dataAt = base + i32(b, q); q += 4; }
          let firstFlags = null;
          if (tf & 4) { firstFlags = u32(b, q); q += 4; }
          const per = ((tf >> 8) & 1) + ((tf >> 9) & 1) + ((tf >> 10) & 1) + ((tf >> 11) & 1);
          if (q + count * per * 4 > trun.end) break;
          for (let i = 0; i < count; i++) {
            const dur = tf & 0x100 ? u32(b, (q += 4) - 4) : defDur;
            const size = tf & 0x200 ? u32(b, (q += 4) - 4) : defSize;
            let sflags = tf & 0x400 ? u32(b, (q += 4) - 4) : defFlags;
            const cto = tf & 0x800 ? i32(b, (q += 4) - 4) : 0;
            if (i === 0 && firstFlags !== null) sflags = firstFlags;
            const key = tr.kind === 'audio' || !(sflags & 0x10000);
            tr.table.push(dataAt, size, tr.nextDts, tr.nextDts + cto, dur, key);
            tr.nextDts += dur;
            dataAt += size;
          }
        }
        prevEnd = dataAt;
      }
    }
  }

  // ---- the movie -------------------------------------------------------------------------------------------------

  function rotationOf(b, tkhd) {
    const v1 = b[tkhd.start] === 1;
    const m = tkhd.start + (v1 ? 52 : 40);
    if (m + 36 > tkhd.end) return 0;
    const a = i32(b, m) / 65536;
    const c = i32(b, m + 4) / 65536;
    if (!a && !c) return 0;
    const deg = Math.round((Math.atan2(c, a) * 180) / Math.PI / 90) * 90;
    return ((deg % 360) + 360) % 360;
  }
  function editsOf(b, trak) {
    const elst = dig(b, trak, 'edts', 'elst');
    if (!elst) return null;
    const v1 = b[elst.start] === 1;
    const n = u32(b, elst.start + 4);
    const step = v1 ? 20 : 12;
    let empty = 0;
    for (let i = 0, p = elst.start + 8; i < n && p + step <= elst.end; i++, p += step) {
      const dur = v1 ? u64(b, p) : u32(b, p);
      const media = v1 ? i32(b, p + 8) * 4294967296 + u32(b, p + 12) : i32(b, p + 4);
      if (media === -1) { empty += dur; continue; }
      return { empty, media, segment: dur };
    }
    return empty ? { empty, media: 0, segment: 0 } : null;
  }

  function parseMovie(moov, moofs, fileSize, qt) {
    const b = moov;
    const root = { start: u32(b, 0) === 1 ? 16 : 8, end: b.length };
    const mvhd = child(b, root, 'mvhd');
    if (!mvhd) fail('damaged', 'no mvhd');
    const mv1 = b[mvhd.start] === 1;
    const movieScale = u32(b, mvhd.start + (mv1 ? 20 : 12)) || 1000;
    const movieDuration = mv1 ? u64(b, mvhd.start + 24) : u32(b, mvhd.start + 16);
    const trex = new Map();
    for (const box of all(b, child(b, root, 'mvex'), 'trex')) {
      trex.set(u32(b, box.start + 4), { duration: u32(b, box.start + 12), size: u32(b, box.start + 16), flags: u32(b, box.start + 20) });
    }
    const tracks = [];
    const skipped = [];
    const byId = new Map();
    for (const trak of all(b, root, 'trak')) {
      const tkhd = child(b, trak, 'tkhd');
      const mdia = child(b, trak, 'mdia');
      const mdhd = child(b, mdia, 'mdhd');
      const hdlr = child(b, mdia, 'hdlr');
      const stbl = dig(b, mdia, 'minf', 'stbl');
      if (!tkhd || !mdhd || !hdlr || !stbl) continue;
      const handler = ascii(b, hdlr.start + 8, 4);
      if (handler !== 'vide' && handler !== 'soun') continue;
      const tk1 = b[tkhd.start] === 1;
      const id = u32(b, tkhd.start + (tk1 ? 20 : 12));
      const timescale = u32(b, mdhd.start + (b[mdhd.start] === 1 ? 20 : 12));
      if (!timescale) continue;
      const stsd = child(b, stbl, 'stsd');
      const first = stsd ? boxes(b, stsd.start + 8, stsd.end)[0] : null;
      if (!first) continue;
      let entry;
      try {
        entry = handler === 'vide' ? videoEntry(b, first) : audioEntry(b, first, qt);
      } catch (err) {
        skipped.push({ id, kind: handler === 'vide' ? 'video' : 'audio', codec: first.type, reason: err.detail || err.message });
        continue;
      }
      if (!entry) { skipped.push({ id, kind: handler === 'vide' ? 'video' : 'audio', codec: first.type.trim(), reason: 'unsupported' }); continue; }
      const table = stblTable(b, stbl, entry, timescale);
      const tr = { id, kind: entry.kind, entry, timescale, table, trex: trex.get(id) || { duration: 0, size: 0, flags: 0 },
        nextDts: 0, edits: editsOf(b, trak), rotation: entry.kind === 'video' ? rotationOf(b, tkhd) : 0 };
      if (table.n) tr.nextDts = table.t.dts[table.n - 1] + table.t.duration[table.n - 1];
      if (entry.kind === 'video') {
        const p = tkhd.start + (tk1 ? 88 : 76);
        tr.tkhdSize = p + 8 <= tkhd.end ? [u32(b, p) / 65536, u32(b, p + 4) / 65536] : [0, 0];
      }
      tracks.push(tr);
      byId.set(id, tr);
    }
    readFragments(moofs, byId);
    return { tracks: tracks.map((tr) => finish(tr, movieScale, fileSize)).filter(Boolean), skipped, movieDuration: codecs.rescale(movieDuration, movieScale) };
  }

  // Media units -> ticks, edit list applied, samples past the end of the file dropped.
  function finish(tr, movieScale, fileSize) {
    const { entry } = tr;
    const scale = tr.table.rate || tr.timescale;
    const ticks = codecs.ticksPer(scale);
    let t = tr.table.done();
    let truncated = false;
    const keep = (i) => t.offset[i] + t.size[i] <= fileSize;
    const before = t.count;
    t = codecs.filterTable(t, keep);
    if (t.count < before) truncated = true;
    let shift = 0;
    let limit = null;
    if (tr.edits) {
      const empty = codecs.rescale(tr.edits.empty, movieScale);
      shift = empty - codecs.rescale(tr.edits.media, tr.timescale);
      if (tr.edits.segment > 0) limit = empty + codecs.rescale(tr.edits.segment, movieScale);
    }
    let end = 0;
    for (let i = 0; i < t.count; i++) {
      t.dts[i] = ticks(t.dts[i]) + shift;
      t.pts[i] = ticks(t.pts[i]) + shift;
      t.duration[i] = ticks(t.duration[i]);
      end = Math.max(end, t.pts[i] + t.duration[i]);
    }
    const track = {
      id: tr.id, kind: tr.kind, codec: entry.codec, description: entry.description || null, samples: t,
      duration: limit != null ? Math.min(limit, end) : end, truncated, preRoll: entry.codec === 'opus' ? time.fromSeconds(0.08) : 0,
    };
    if (tr.kind === 'video') {
      const sar = entry.sar;
      track.width = entry.width;
      track.height = entry.height;
      if (sar) {
        track.displayWidth = Math.round((entry.width * sar[0]) / sar[1]);
        track.displayHeight = entry.height;
      } else if (tr.tkhdSize[0] > 0 && tr.tkhdSize[1] > 0) {
        track.displayWidth = Math.round(tr.tkhdSize[0]);
        track.displayHeight = Math.round(tr.tkhdSize[1]);
      } else {
        track.displayWidth = entry.width;
        track.displayHeight = entry.height;
      }
      track.rotation = tr.rotation;
      track.colorSpace = entry.colorSpace || null;
      track.bitDepth = entry.bitDepth || 8;
    } else {
      track.sampleRate = Math.round(entry.sampleRate);
      track.channels = entry.channels;
    }
    codecs.finishTrack(track, { quantum: ticks(1) });
    return track;
  }

  // reader -> Source. Throws a FormatError (code, detail) for files that cannot be used; probe turns it into Source.error.
  async function open(reader) {
    const top = await scanTop(reader);
    if (!top.moov) fail('damaged', top.damaged || (top.mdat ? 'no moov box (the recording did not finish)' : 'no moov box'));
    const { major, all: list } = brands(top.ftyp);
    const qt = major === 'qt  ' || !top.ftyp;
    const movie = parseMovie(top.moov, top.moofs, reader.size, qt);
    const tracks = movie.tracks.filter((t) => t.samples.count > 0);
    tracks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
    for (const t of movie.tracks) if (!t.samples.count) movie.skipped.push({ id: t.id, kind: t.kind, codec: t.codec, reason: 'empty' });
    const duration = tracks.length ? Math.max(...tracks.map((t) => t.duration)) : movie.movieDuration;
    return { container: qt ? 'mov' : 'mp4', brands: list, duration, tracks, skipped: movie.skipped, image: null, error: null };
  }

  return { open, boxes, scanTop };
});
