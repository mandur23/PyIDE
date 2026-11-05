// Codec configuration records and the byte helpers the container readers (mp4read, mkvread, audioread) and the
// writer (mp4write) share: avcC and hvcC with their SPS (profile, level, size, color), vpcC, av1C, the VP9 frame
// header, AudioSpecificConfig, OpusHead/dOps, FLAC STREAMINFO, the WebCodecs codec strings of each, PCM to float, and
// the sample-table finishing every reader does (presentation order, sync samples, nominal frame rate, VFR).
// Loaded as Cut.codecs in the page and require()d by the Node tests.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).codecs = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;
  const { TICKS } = time;

  // ---- errors and reading --------------------------------------------------------------------------------------------

  class FormatError extends Error {
    constructor(code, detail) {
      super(detail);
      this.code = code;
      this.detail = detail;
    }
  }
  const fail = (code, detail) => { throw new FormatError(code, detail); };

  function asBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return fail('damaged', v && v.error ? `cannot read the file: ${v.error}` : 'cannot read the file');
  }
  // The app's reader takes at most 64 MB a call; bigger ranges go in parts.
  const MAX_READ = 32 * 1024 * 1024;
  async function readRange(reader, offset, length) {
    const start = Math.max(0, offset);
    const end = Math.min(reader.size, offset + length);
    if (!(end > start)) return new Uint8Array(0);
    const total = end - start;
    if (total <= MAX_READ) return asBytes(await reader.read(start, total));
    const out = new Uint8Array(total);
    let at = 0;
    while (at < total) {
      const part = asBytes(await reader.read(start + at, Math.min(MAX_READ, total - at)));
      if (!part.length) break;
      out.set(part.subarray(0, total - at), at);
      at += part.length;
    }
    return at >= total ? out : out.subarray(0, at);
  }
  // A reader over bytes in memory (tests, and data a reader already holds).
  function bufferReader(bytes) {
    const b = asBytes(bytes);
    return { size: b.length, read: async (offset, length) => b.subarray(offset, Math.min(b.length, offset + length)) };
  }

  const u16 = (b, i) => (b[i] << 8) | b[i + 1];
  const u24 = (b, i) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
  const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const i32 = (b, i) => (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
  const u64 = (b, i) => u32(b, i) * 4294967296 + u32(b, i + 4);
  const le16 = (b, i) => b[i] | (b[i + 1] << 8);
  const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const le64 = (b, i) => le32(b, i) + le32(b, i + 4) * 4294967296;
  const ascii = (b, i, n) => {
    let s = '';
    for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
    return s;
  };
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  // A growable big-endian byte buffer with ISO BMFF box helpers.
  class ByteWriter {
    constructor(n = 256) { this.buf = new Uint8Array(n); this.len = 0; }
    room(n) {
      if (this.len + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.len + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    u8(v) { this.room(1); this.buf[this.len++] = v & 255; return this; }
    u16(v) { this.room(2); this.buf[this.len++] = (v >> 8) & 255; this.buf[this.len++] = v & 255; return this; }
    u24(v) { this.u8(v >> 16); return this.u16(v & 0xffff); }
    u32(v) {
      this.room(4);
      const b = this.buf;
      b[this.len++] = (v >>> 24) & 255; b[this.len++] = (v >>> 16) & 255; b[this.len++] = (v >>> 8) & 255; b[this.len++] = v & 255;
      return this;
    }
    u64(v) { this.u32(Math.floor(v / 4294967296)); return this.u32(v >>> 0); }
    bytes(a) { this.room(a.length); this.buf.set(a, this.len); this.len += a.length; return this; }
    str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
    zeros(n) { this.room(n); this.buf.fill(0, this.len, this.len + n); this.len += n; return this; }
    box(type, fn) {
      const at = this.len;
      this.u32(0).str(type);
      fn(this);
      const size = this.len - at;
      this.buf[at] = size >>> 24; this.buf[at + 1] = (size >>> 16) & 255; this.buf[at + 2] = (size >>> 8) & 255; this.buf[at + 3] = size & 255;
      return this;
    }
    full(type, version, flags, fn) { return this.box(type, (w) => { w.u8(version).u24(flags); fn(w); }); }
    done() { return this.buf.slice(0, this.len); }
  }

  // Bits, most significant first, with the Exp-Golomb codes of H.264/HEVC.
  class BitReader {
    constructor(bytes, start = 0) { this.b = bytes; this.pos = start * 8; this.end = bytes.length * 8; }
    bit() {
      if (this.pos >= this.end) fail('damaged', 'a codec header ends early');
      const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      return v;
    }
    u(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
    skip(n) { this.pos += n; if (this.pos > this.end) fail('damaged', 'a codec header ends early'); }
    ue() {
      let zeros = 0;
      while (this.bit() === 0) if (++zeros > 31) fail('damaged', 'a codec header has a bad number');
      return zeros ? 2 ** zeros - 1 + this.u(zeros) : 0;
    }
    se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
    get left() { return this.end - this.pos; }
  }
  class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
    put(v, bits) {
      for (let i = bits - 1; i >= 0; i--) {
        this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1);
        if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
      }
      return this;
    }
    done() { if (this.n) this.bytes.push(this.cur << (8 - this.n)); this.cur = 0; this.n = 0; return Uint8Array.from(this.bytes); }
  }

  // NAL payload without emulation prevention bytes (00 00 03 -> 00 00).
  function unescapeRbsp(nal) {
    const out = new Uint8Array(nal.length);
    let n = 0;
    let zeros = 0;
    for (let i = 0; i < nal.length; i++) {
      const v = nal[i];
      if (zeros >= 2 && v === 3) { zeros = 0; continue; }
      out[n++] = v;
      zeros = v === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
  }

  // ---- color -----------------------------------------------------------------------------------------------------

  // ISO/IEC 23091-2 code points <-> the WebCodecs VideoColorSpace enums (others are left out: VideoColorSpace throws on them).
  const PRIMARIES = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
  const TRANSFER = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 14: 'bt709', 15: 'bt709', 16: 'pq', 18: 'hlg' };
  const MATRIX = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };
  const invert = (o) => Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [v, Number(k)]));
  const PRIMARIES_CODE = invert(PRIMARIES);
  const TRANSFER_CODE = { ...invert(TRANSFER), bt709: 1 };
  const MATRIX_CODE = invert(MATRIX);
  function colorFromCodes(primaries, transfer, matrix, fullRange) {
    const cs = {
      primaries: PRIMARIES[primaries] || null,
      transfer: TRANSFER[transfer] || null,
      matrix: MATRIX[matrix] || null,
      fullRange: fullRange == null ? null : !!fullRange,
    };
    return cs.primaries || cs.transfer || cs.matrix || cs.fullRange != null ? cs : null;
  }
  // Unknown values are 2 (unspecified).
  function codesFromColor(cs) {
    return {
      primaries: PRIMARIES_CODE[cs?.primaries] ?? 2,
      transfer: TRANSFER_CODE[cs?.transfer] ?? 2,
      matrix: MATRIX_CODE[cs?.matrix] ?? 2,
      fullRange: !!cs?.fullRange,
    };
  }
  // Fills the fields `base` leaves null from `extra` (the container's colr wins over the bitstream).
  function mergeColor(base, extra) {
    if (!base) return extra || null;
    if (!extra) return base;
    const out = { ...base };
    for (const k of ['primaries', 'transfer', 'matrix', 'fullRange']) if (out[k] == null) out[k] = extra[k] ?? null;
    return out;
  }

  const SAR = [null, [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11],
    [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];

  // ---- H.264 -----------------------------------------------------------------------------------------------------

  const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  function skipScalingList(r, size) {
    let last = 8;
    let next = 8;
    for (let j = 0; j < size; j++) {
      if (next !== 0) next = (last + r.se() + 256) % 256;
      last = next === 0 ? last : next;
    }
  }
  function readAvcVui(r, out) {
    if (r.bit()) {
      const idc = r.u(8);
      if (idc === 255) out.sar = [r.u(16), r.u(16)];
      else if (SAR[idc]) out.sar = SAR[idc];
    }
    if (r.bit()) r.bit();
    if (r.bit()) {
      r.u(3);
      const full = r.bit();
      out.colorSpace = r.bit() ? colorFromCodes(r.u(8), r.u(8), r.u(8), full) : colorFromCodes(0, 0, -1, full);
    }
    if (r.bit()) { r.ue(); r.ue(); }
    if (r.bit()) {
      const units = r.u(32);
      const scale = r.u(32);
      if (units && scale) out.timing = reduce(scale, units * 2);
    }
  }
  // A sequence parameter set NAL unit (with its one-byte header).
  function parseAvcSps(nal) {
    const r = new BitReader(unescapeRbsp(nal), 1);
    const profile = r.u(8);
    const constraints = r.u(8);
    const level = r.u(8);
    r.ue();
    let chromaFormat = 1;
    let separate = 0;
    let bitDepthLuma = 8;
    let bitDepthChroma = 8;
    if (HIGH_PROFILES.includes(profile)) {
      chromaFormat = r.ue();
      if (chromaFormat === 3) separate = r.bit();
      bitDepthLuma = r.ue() + 8;
      bitDepthChroma = r.ue() + 8;
      r.bit();
      if (r.bit()) for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.bit(); r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue();
    r.bit();
    const widthMbs = r.ue() + 1;
    const heightMaps = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    const crop = r.bit() ? [r.ue(), r.ue(), r.ue(), r.ue()] : [0, 0, 0, 0];
    const arrayType = separate ? 0 : chromaFormat;
    const cropX = arrayType === 1 || arrayType === 2 ? 2 : 1;
    const cropY = (arrayType === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const out = {
      profile, constraints, level, chromaFormat, bitDepthLuma, bitDepthChroma,
      width: widthMbs * 16 - cropX * (crop[0] + crop[1]),
      height: (2 - frameMbsOnly) * heightMaps * 16 - cropY * (crop[2] + crop[3]),
      interlaced: !frameMbsOnly, sar: [1, 1], colorSpace: null, timing: null,
    };
    try { if (r.left > 0 && r.bit()) readAvcVui(r, out); } catch { /* a cut VUI keeps what was read */ }
    return out;
  }
  function parseAvcC(bytes) {
    const b = asBytes(bytes);
    if (b.length < 7 || b[0] !== 1) fail('damaged', 'bad avcC');
    const out = { profile: b[1], compat: b[2], level: b[3], lengthSize: (b[4] & 3) + 1, sps: [], pps: [], info: null };
    let p = 6;
    for (let i = 0, n = b[5] & 31; i < n; i++) {
      const len = u16(b, p);
      if (p + 2 + len > b.length) fail('damaged', 'bad avcC');
      out.sps.push(b.slice(p + 2, p + 2 + len));
      p += 2 + len;
    }
    if (p < b.length) {
      for (let i = 0, n = b[p++]; i < n; i++) {
        const len = u16(b, p);
        if (p + 2 + len > b.length) fail('damaged', 'bad avcC');
        out.pps.push(b.slice(p + 2, p + 2 + len));
        p += 2 + len;
      }
    }
    if (out.sps.length) try { out.info = parseAvcSps(out.sps[0]); } catch { out.info = null; }
    return out;
  }
  function buildAvcC({ sps, pps, lengthSize = 4 }) {
    const w = new ByteWriter();
    const first = sps[0];
    w.u8(1).u8(first[1]).u8(first[2]).u8(first[3]).u8(0xfc | (lengthSize - 1)).u8(0xe0 | sps.length);
    for (const s of sps) w.u16(s.length).bytes(s);
    w.u8(pps.length);
    for (const s of pps) w.u16(s.length).bytes(s);
    if (HIGH_PROFILES.includes(first[1])) {
      let info = null;
      try { info = parseAvcSps(first); } catch { /* the extension is optional for readers */ }
      if (info) w.u8(0xfc | info.chromaFormat).u8(0xf8 | (info.bitDepthLuma - 8)).u8(0xf8 | (info.bitDepthChroma - 8)).u8(0);
    }
    return w.done();
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const dec2 = (n) => String(n).padStart(2, '0');
  function avcCodecString({ profile, compat, level }, entry = 'avc1') {
    return `${entry}.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
  }

  // ---- HEVC ------------------------------------------------------------------------------------------------------

  function readPtl(r, maxSubLayersMinus1) {
    const ptl = { profileSpace: r.u(2), tier: r.u(1), profile: r.u(5), compat: r.u(32), constraints: new Uint8Array(6), level: 0 };
    for (let i = 0; i < 6; i++) ptl.constraints[i] = r.u(8);
    ptl.level = r.u(8);
    const profilePresent = [];
    const levelPresent = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) { profilePresent.push(r.bit()); levelPresent.push(r.bit()); }
    if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      if (profilePresent[i]) r.skip(88);
      if (levelPresent[i]) r.skip(8);
    }
    return ptl;
  }
  function skipHevcScalingLists(r) {
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
        if (!r.bit()) r.ue();
        else {
          const coefs = Math.min(64, 1 << (4 + (sizeId << 1)));
          if (sizeId > 1) r.se();
          for (let i = 0; i < coefs; i++) r.se();
        }
      }
    }
  }
  function parseHevcSps(nal) {
    const r = new BitReader(unescapeRbsp(nal), 2);
    r.u(4);
    const maxSubLayersMinus1 = r.u(3);
    const temporalIdNesting = r.bit();
    const ptl = readPtl(r, maxSubLayersMinus1);
    r.ue();
    const chromaFormat = r.ue();
    if (chromaFormat === 3) r.bit();
    let width = r.ue();
    let height = r.ue();
    if (r.bit()) {
      const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
      const subH = chromaFormat === 1 ? 2 : 1;
      const [left, right, top, bottom] = [r.ue(), r.ue(), r.ue(), r.ue()];
      width -= subW * (left + right);
      height -= subH * (top + bottom);
    }
    const bitDepthLuma = r.ue() + 8;
    const bitDepthChroma = r.ue() + 8;
    const out = { ...ptl, maxSubLayersMinus1, temporalIdNesting, chromaFormat, bitDepthLuma, bitDepthChroma, width, height, sar: [1, 1], colorSpace: null };
    try {
      const pocBits = r.ue() + 4;
      const ordering = r.bit();
      for (let i = ordering ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) { r.ue(); r.ue(); r.ue(); }
      for (let i = 0; i < 6; i++) r.ue();
      if (r.bit() && r.bit()) skipHevcScalingLists(r);
      r.bit(); r.bit();
      if (r.bit()) { r.u(4); r.u(4); r.ue(); r.ue(); r.bit(); }
      const sets = r.ue();
      if (sets > 64) return out;
      const deltaPocs = [];
      for (let i = 0; i < sets; i++) {
        if (i !== 0 && r.bit()) {
          r.bit(); r.ue();
          let n = 0;
          for (let j = 0; j <= deltaPocs[i - 1]; j++) if (r.bit() || r.bit()) n++;
          deltaPocs.push(n);
        } else {
          const neg = r.ue();
          const pos = r.ue();
          if (neg + pos > 32) return out;
          for (let j = 0; j < neg + pos; j++) { r.ue(); r.bit(); }
          deltaPocs.push(neg + pos);
        }
      }
      if (r.bit()) {
        const lt = r.ue();
        for (let i = 0; i < lt; i++) { r.u(pocBits); r.bit(); }
      }
      r.bit(); r.bit();
      if (r.bit()) {
        if (r.bit()) {
          const idc = r.u(8);
          if (idc === 255) out.sar = [r.u(16), r.u(16)];
          else if (SAR[idc]) out.sar = SAR[idc];
        }
        if (r.bit()) r.bit();
        if (r.bit()) {
          r.u(3);
          const full = r.bit();
          out.colorSpace = r.bit() ? colorFromCodes(r.u(8), r.u(8), r.u(8), full) : colorFromCodes(0, 0, -1, full);
        }
      }
    } catch { /* the size and profile are known; color stays unknown */ }
    return out;
  }
  function parseHvcC(bytes) {
    const b = asBytes(bytes);
    if (b.length < 23) fail('damaged', 'bad hvcC');
    const out = {
      profileSpace: b[1] >> 6, tier: (b[1] >> 5) & 1, profile: b[1] & 31, compat: u32(b, 2), constraints: b.slice(6, 12),
      level: b[12], chromaFormat: b[16] & 3, bitDepthLuma: (b[17] & 7) + 8, bitDepthChroma: (b[18] & 7) + 8,
      lengthSize: (b[21] & 3) + 1, arrays: [], vps: [], sps: [], pps: [], info: null,
    };
    let p = 23;
    for (let i = 0, n = b[22]; i < n; i++) {
      if (p + 3 > b.length) fail('damaged', 'bad hvcC');
      const head = b[p];
      const type = head & 63;
      const count = u16(b, p + 1);
      p += 3;
      const nalus = [];
      for (let k = 0; k < count; k++) {
        const len = u16(b, p);
        if (p + 2 + len > b.length) fail('damaged', 'bad hvcC');
        nalus.push(b.slice(p + 2, p + 2 + len));
        p += 2 + len;
      }
      out.arrays.push({ type, complete: head >> 7, nalus });
      if (type === 32) out.vps.push(...nalus);
      else if (type === 33) out.sps.push(...nalus);
      else if (type === 34) out.pps.push(...nalus);
    }
    if (out.sps.length) try { out.info = parseHevcSps(out.sps[0]); } catch { out.info = null; }
    return out;
  }
  function buildHvcC({ vps = [], sps, pps = [], lengthSize = 4 }) {
    const info = parseHevcSps(sps[0]);
    const w = new ByteWriter();
    w.u8(1).u8((info.profileSpace << 6) | (info.tier << 5) | info.profile).u32(info.compat).bytes(info.constraints).u8(info.level);
    w.u16(0xf000).u8(0xfc).u8(0xfc | info.chromaFormat).u8(0xf8 | (info.bitDepthLuma - 8)).u8(0xf8 | (info.bitDepthChroma - 8));
    w.u16(0).u8(((info.maxSubLayersMinus1 + 1) << 3) | (info.temporalIdNesting << 2) | (lengthSize - 1));
    const arrays = [[32, vps], [33, sps], [34, pps]].filter(([, list]) => list.length);
    w.u8(arrays.length);
    for (const [type, list] of arrays) {
      w.u8(0x80 | type).u16(list.length);
      for (const n of list) w.u16(n.length).bytes(n);
    }
    return w.done();
  }
  function hevcCodecString(h, entry = 'hvc1') {
    let compat = 0;
    for (let i = 0; i < 32; i++) compat = compat * 2 + ((h.compat >>> i) & 1);
    const bytes = [...h.constraints];
    while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
    const tail = bytes.map((v) => `.${v.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    return `${entry}.${['', 'A', 'B', 'C'][h.profileSpace]}${h.profile}.${compat.toString(16).toUpperCase()}.${h.tier ? 'H' : 'L'}${h.level}${tail}`;
  }

  // ---- VP9 and AV1 -------------------------------------------------------------------------------------------------

  // VPCodecConfigurationRecord (the vpcC payload after its version and flags).
  function parseVpcC(bytes, version = 1) {
    const b = asBytes(bytes);
    if (b.length < 6) fail('damaged', 'bad vpcC');
    if (version === 0) {
      return { profile: b[0], level: b[1], bitDepth: b[2] >> 4, chromaSubsampling: b[3] >> 4, fullRange: !!(b[4] & 0x80), colorSpace: null };
    }
    const full = b[2] & 1;
    return {
      profile: b[0], level: b[1], bitDepth: b[2] >> 4, chromaSubsampling: (b[2] >> 1) & 7, fullRange: !!full,
      colorSpace: colorFromCodes(b[3], b[4], b[5], full),
    };
  }
  function vp9CodecString({ profile, level, bitDepth }) {
    return `vp09.${dec2(profile)}.${dec2(level || 10)}.${dec2(bitDepth || 8)}`;
  }
  // The VP9 levels by luma picture size and luma sample rate.
  const VP9_LEVELS = [[10, 36864, 829440], [11, 73728, 2764800], [20, 122880, 4608000], [21, 245760, 9216000],
    [30, 552960, 20736000], [31, 983040, 36864000], [40, 2228224, 83558400], [41, 2228224, 160432128],
    [50, 8912896, 311951360], [51, 8912896, 588251136], [52, 8912896, 1176502272], [60, 35651584, 1176502272],
    [61, 35651584, 2353004544], [62, 35651584, 4706009088]];
  function vp9Level(width, height, fps = 30) {
    const size = width * height;
    for (const [level, maxSize, maxRate] of VP9_LEVELS) if (size <= maxSize && size * fps <= maxRate) return level;
    return 62;
  }
  // The uncompressed header of a VP9 key frame: profile, bit depth, color and size.
  const VP9_COLOR = { 1: [6, 6, 6], 2: [1, 1, 1], 3: [6, 6, 6], 5: [9, 0, 9], 7: [1, 13, 0] };
  function parseVp9Frame(bytes) {
    const r = new BitReader(asBytes(bytes));
    if (r.u(2) !== 2) return null;
    const profile = r.bit() | (r.bit() << 1);
    if (profile === 3) r.bit();
    if (r.bit()) return null;
    if (r.bit() !== 0) return { profile, key: false };
    r.bit(); r.bit();
    if (r.u(24) !== 0x498342) return null;
    let bitDepth = 8;
    if (profile >= 2) bitDepth = r.bit() ? 12 : 10;
    const space = r.u(3);
    let fullRange = space === 7;
    let chromaSubsampling = 1;
    if (space !== 7) {
      fullRange = !!r.bit();
      if (profile === 1 || profile === 3) {
        const x = r.bit();
        const y = r.bit();
        chromaSubsampling = x && y ? 1 : x ? 2 : 3;
        r.bit();
      }
    } else if (profile === 1 || profile === 3) { chromaSubsampling = 3; r.bit(); }
    const width = r.u(16) + 1;
    const height = r.u(16) + 1;
    const codes = VP9_COLOR[space];
    return { profile, key: true, bitDepth, chromaSubsampling, fullRange, width, height, colorSpace: codes ? colorFromCodes(codes[0], codes[1], codes[2], fullRange) : colorFromCodes(0, 0, -1, fullRange) };
  }
  function parseAv1C(bytes) {
    const b = asBytes(bytes);
    if (b.length < 4 || !(b[0] & 0x80)) fail('damaged', 'bad av1C');
    const highBitDepth = (b[2] >> 6) & 1;
    const twelve = (b[2] >> 5) & 1;
    return {
      profile: b[1] >> 5, level: b[1] & 31, tier: b[2] >> 7, bitDepth: highBitDepth ? (twelve ? 12 : 10) : 8,
      monochrome: (b[2] >> 4) & 1, subsamplingX: (b[2] >> 3) & 1, subsamplingY: (b[2] >> 2) & 1, configObus: b.slice(4),
    };
  }
  function av1CodecString({ profile, level, tier, bitDepth }) {
    return `av01.${profile}.${dec2(level)}${tier ? 'H' : 'M'}.${dec2(bitDepth)}`;
  }

  // ---- audio -----------------------------------------------------------------------------------------------------

  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function parseAudioSpecificConfig(bytes) {
    const r = new BitReader(asBytes(bytes));
    const objectType = (() => { const t = r.u(5); return t === 31 ? 32 + r.u(6) : t; })();
    const rateIndex = r.u(4);
    let sampleRate = rateIndex === 15 ? r.u(24) : AAC_RATES[rateIndex];
    if (!sampleRate) fail('damaged', 'bad AudioSpecificConfig');
    const channelConfig = r.u(4);
    let core = objectType;
    if (objectType === 5 || objectType === 29) {
      const ext = r.u(4);
      sampleRate = ext === 15 ? r.u(24) : AAC_RATES[ext] || sampleRate;
      core = r.u(5);
    }
    let frameLength = 1024;
    if ([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].includes(core) && r.left > 0 && r.bit()) frameLength = 960;
    const channels = channelConfig === 7 ? 8 : channelConfig;
    return { objectType, sampleRate, channelConfig, channels, frameLength };
  }
  function buildAudioSpecificConfig({ objectType = 2, sampleRate, channels }) {
    const w = new BitWriter();
    w.put(objectType, 5);
    const index = AAC_RATES.indexOf(sampleRate);
    if (index >= 0) w.put(index, 4);
    else w.put(15, 4).put(sampleRate, 24);
    w.put(channels <= 6 ? channels : channels === 8 ? 7 : 0, 4).put(0, 3);
    return w.done();
  }
  const aacCodecString = ({ objectType }) => `mp4a.40.${objectType}`;

  // OpusHead (the Ogg/WebM header, little-endian, what WebCodecs takes) and dOps (its MP4 form, big-endian).
  function parseOpusHead(bytes) {
    const b = asBytes(bytes);
    if (b.length < 19 || ascii(b, 0, 8) !== 'OpusHead') fail('damaged', 'bad OpusHead');
    return { channels: b[9], preSkip: le16(b, 10), inputRate: le32(b, 12), gain: (le16(b, 16) << 16) >> 16, family: b[18], mapping: b.slice(19) };
  }
  function buildOpusHead({ channels = 2, preSkip = 0, inputRate = 48000, gain = 0, family = 0, mapping = null }) {
    const extra = family !== 0 && mapping ? mapping : new Uint8Array(0);
    const b = new Uint8Array(19 + extra.length);
    b.set([79, 112, 117, 115, 72, 101, 97, 100, 1, channels]);
    b[10] = preSkip & 255; b[11] = preSkip >> 8;
    for (let i = 0; i < 4; i++) b[12 + i] = (inputRate >>> (8 * i)) & 255;
    b[16] = gain & 255; b[17] = (gain >> 8) & 255; b[18] = family;
    b.set(extra, 19);
    return b;
  }
  function opusHeadFromDOps(bytes) {
    const b = asBytes(bytes);
    if (b.length < 11) fail('damaged', 'bad dOps');
    return buildOpusHead({ channels: b[1], preSkip: u16(b, 2), inputRate: u32(b, 4), gain: (u16(b, 8) << 16) >> 16, family: b[10], mapping: b.slice(11) });
  }
  function dOpsFromOpusHead(bytes) {
    const h = parseOpusHead(bytes);
    const w = new ByteWriter();
    w.u8(0).u8(h.channels).u16(h.preSkip).u32(h.inputRate).u16(h.gain & 0xffff).u8(h.family);
    if (h.family !== 0) w.bytes(h.mapping);
    return w.done();
  }
  // FLAC metadata blocks (dfLa payload, or a file's) -> STREAMINFO fields.
  function parseFlacStreamInfo(blocks) {
    const b = asBytes(blocks);
    let p = ascii(b, 0, 4) === 'fLaC' ? 4 : 0;
    while (p + 4 <= b.length) {
      const type = b[p] & 127;
      const len = u24(b, p + 1);
      if (type === 0 && len >= 18 && p + 4 + 18 <= b.length) {
        const s = p + 4;
        const sampleRate = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
        const channels = ((b[s + 12] >> 1) & 7) + 1;
        const bits = (((b[s + 12] & 1) << 4) | (b[s + 13] >> 4)) + 1;
        const total = (b[s + 13] & 15) * 4294967296 + u32(b, s + 14);
        return { sampleRate, channels, bits, totalSamples: total };
      }
      if (b[p] & 128) break;
      p += 4 + len;
    }
    return null;
  }

  // Interleaved PCM -> one Float32Array a channel. Codecs: pcm-u8, pcm-s8, pcm-s16, pcm-s24, pcm-s32, pcm-f32, pcm-f64,
  // little-endian, and the same with a `be` suffix (big-endian, from MOV and Matroska).
  function pcmFormat(codec) {
    const m = /^pcm-([usf])(8|16|24|32|64)(be)?$/.exec(codec || '');
    return m ? { type: m[1], bits: Number(m[2]), big: !!m[3], bytes: Number(m[2]) / 8 } : null;
  }
  function pcmToFloat(bytes, codec, channels) {
    const f = pcmFormat(codec);
    if (!f) fail('unsupported', `not PCM: ${codec}`);
    const b = asBytes(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const frames = Math.floor(b.length / (f.bytes * channels));
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    const le = !f.big;
    let p = 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++, p += f.bytes) {
        let v;
        if (f.type === 'f') v = f.bits === 32 ? dv.getFloat32(p, le) : dv.getFloat64(p, le);
        else if (f.bits === 8) v = f.type === 'u' ? (b[p] - 128) / 128 : ((b[p] << 24) >> 24) / 128;
        else if (f.bits === 16) v = dv.getInt16(p, le) / 32768;
        else if (f.bits === 24) {
          const x = le ? b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) : (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
          v = ((x << 8) >> 8) / 8388608;
        } else v = dv.getInt32(p, le) / 2147483648;
        out[c][i] = v;
      }
    }
    return out;
  }

  // ---- codec strings -----------------------------------------------------------------------------------------------

  // What a WebCodecs codec string says, for the writer: { family, entry, ...fields }.
  function parseCodecString(codec) {
    const s = String(codec || '');
    let m = /^(avc[13])\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
    if (m) return { family: 'avc', entry: m[1], profile: parseInt(m[2], 16), compat: parseInt(m[3], 16), level: parseInt(m[4], 16) };
    m = /^(hvc1|hev1)\./i.exec(s);
    if (m) return { family: 'hevc', entry: m[1] };
    m = /^vp09\.(\d+)\.(\d+)\.(\d+)/.exec(s);
    if (m) return { family: 'vp9', entry: 'vp09', profile: +m[1], level: +m[2], bitDepth: +m[3] };
    if (/^av01\./.test(s)) return { family: 'av1', entry: 'av01' };
    m = /^mp4a\.40\.(\d+)$/.exec(s);
    if (m) return { family: 'aac', entry: 'mp4a', objectType: +m[1] };
    if (s === 'opus') return { family: 'opus', entry: 'Opus' };
    return null;
  }
  // codecString('avc', avcC) / ('hevc', hvcC) / ('vp9', vpcC) / ('av1', av1C) / ('aac', asc) with the parsed records.
  function codecString(family, info, entry) {
    if (family === 'avc') return avcCodecString(info, entry);
    if (family === 'hevc') return hevcCodecString(info, entry);
    if (family === 'vp9') return vp9CodecString(info);
    if (family === 'av1') return av1CodecString(info);
    if (family === 'aac') return aacCodecString(info);
    return family;
  }

  // ---- sample tables -----------------------------------------------------------------------------------------------

  function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
  function reduce(num, den) { const g = gcd(num, den) || 1; return [num / g, den / g]; }

  function newTable(n) {
    return {
      count: n, offset: new Float64Array(n), size: new Uint32Array(n), dts: new Float64Array(n), pts: new Float64Array(n),
      duration: new Float64Array(n), key: new Uint8Array(n), order: null,
    };
  }
  // Appends samples one at a time; done() returns a SampleTable of the exact length.
  class TableBuilder {
    constructor(n = 1024) { this.t = newTable(Math.max(16, n)); this.n = 0; }
    push(offset, size, dts, pts, duration, key) {
      if (this.n === this.t.count) this.grow(this.t.count * 2);
      const t = this.t;
      const i = this.n++;
      t.offset[i] = offset; t.size[i] = size; t.dts[i] = dts; t.pts[i] = pts; t.duration[i] = duration; t.key[i] = key ? 1 : 0;
      return i;
    }
    grow(n) {
      const next = newTable(n);
      for (const k of ['offset', 'size', 'dts', 'pts', 'duration', 'key']) next[k].set(this.t[k].subarray(0, this.n));
      this.t = next;
    }
    done() {
      const t = newTable(this.n);
      for (const k of ['offset', 'size', 'dts', 'pts', 'duration', 'key']) t[k].set(this.t[k].subarray(0, this.n));
      return t;
    }
  }
  // Keeps the samples where keep(i) is true.
  function filterTable(t, keep) {
    let n = 0;
    for (let i = 0; i < t.count; i++) if (keep(i)) n++;
    if (n === t.count) return t;
    const out = newTable(n);
    for (let i = 0, j = 0; i < t.count; i++) {
      if (!keep(i)) continue;
      out.offset[j] = t.offset[i]; out.size[j] = t.size[i]; out.dts[j] = t.dts[i]; out.pts[j] = t.pts[i];
      out.duration[j] = t.duration[i]; out.key[j] = t.key[i];
      j++;
    }
    return out;
  }

  const STANDARD_RATES = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1], [60000, 1001], [60, 1],
    [90, 1], [100, 1], [120000, 1001], [120, 1], [144, 1], [240, 1], [15, 1], [12, 1], [10, 1], [8, 1], [5, 1], [1, 1]];
  function fpsFromTicks(ticks, tolerance = 0.002) {
    if (!(ticks > 0)) return [30, 1];
    const v = TICKS / ticks;
    let best = null;
    for (const r of STANDARD_RATES) {
      const d = Math.abs(r[0] / r[1] - v) / v;
      if (d <= tolerance && (!best || d < best.d)) best = { r, d };
    }
    if (best) return [...best.r];
    if (Number.isInteger(ticks) && TICKS % ticks === 0) return [TICKS / ticks, 1];
    return reduce(Math.round(v * 1000), 1000);
  }

  // Finishes a track's table: presentation order, the sync sample index, and for video the nominal frame rate (the
  // most common frame duration) and VFR. `quantum` is one unit of the container's clock in ticks: Matroska's
  // millisecond timestamps make a steady 29.97 look like 33, 33, 34 ms.
  function finishTrack(track, { quantum = 0 } = {}) {
    const t = track.samples;
    const n = t.count;
    let sorted = true;
    for (let i = 1; i < n && sorted; i++) if (t.pts[i] < t.pts[i - 1]) sorted = false;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    if (!sorted) {
      const pts = t.pts;
      order.sort((a, b) => pts[a] - pts[b] || a - b);
    }
    t.order = order;
    let keys = 0;
    for (let i = 0; i < n; i++) keys += t.key[i];
    const keyIndex = new Uint32Array(keys);
    for (let i = 0, j = 0; i < n; i++) if (t.key[i]) keyIndex[j++] = i;
    t.keys = keyIndex;
    if (track.kind !== 'video') return track;
    if (n < 2) {
      track.frameRate = fpsFromTicks(n ? t.duration[0] : 0);
      track.vfr = false;
      return track;
    }
    const counts = new Map();
    let mode = 0;
    let best = 0;
    for (let k = 0; k < n - 1; k++) {
      const d = Math.round(t.pts[order[k + 1]] - t.pts[order[k]]);
      const c = (counts.get(d) || 0) + 1;
      counts.set(d, c);
      if (c > best || (c === best && d < mode)) { best = c; mode = d; }
    }
    const tolerance = Math.max(mode * 0.01, quantum * 1.01);
    let vfr = false;
    for (const d of counts.keys()) if (Math.abs(d - mode) > tolerance) { vfr = true; break; }
    const mean = (t.pts[order[n - 1]] - t.pts[order[0]]) / (n - 1);
    const relative = Math.max(0.002, mode ? (quantum * 1.01) / mode : 0);
    track.frameRate = vfr ? fpsFromTicks(mode, relative) : fpsFromTicks(mean, relative);
    track.vfr = vfr;
    return track;
  }

  // time.rescale and time.toScale round half up only for values >= 0 (BigInt division truncates toward zero), and
  // container times go negative (priming, B-frame delay, encoder delay): these round symmetrically.
  const rescale = (v, scale) => (v < 0 ? -time.rescale(-v, scale) : time.rescale(v, scale));
  const toScale = (t, scale) => (t < 0 ? -time.toScale(-t, scale) : time.toScale(t, scale));
  // Ticks for a value in units of 1/scale: an exact multiply when the scale divides TICKS (every common rate does).
  function ticksPer(scale) {
    const k = TICKS / scale;
    return Number.isInteger(k) ? (v) => v * k : (v) => rescale(v, scale);
  }
  function unitsPer(scale) {
    const k = TICKS / scale;
    return Number.isInteger(k) ? (t) => Math.round(t / k) : (t) => toScale(t, scale);
  }

  return {
    FormatError, fail, asBytes, readRange, bufferReader, u16, u24, u32, i32, u64, le16, le32, le64, ascii, concat,
    ByteWriter, BitReader, BitWriter, unescapeRbsp,
    colorFromCodes, codesFromColor, mergeColor,
    parseAvcSps, parseAvcC, buildAvcC, avcCodecString,
    parseHevcSps, parseHvcC, buildHvcC, hevcCodecString,
    parseVpcC, vp9CodecString, vp9Level, parseVp9Frame, parseAv1C, av1CodecString,
    AAC_RATES, parseAudioSpecificConfig, buildAudioSpecificConfig, aacCodecString,
    parseOpusHead, buildOpusHead, opusHeadFromDOps, dOpsFromOpusHead, parseFlacStreamInfo,
    pcmFormat, pcmToFloat, parseCodecString, codecString,
    gcd, reduce, newTable, TableBuilder, filterTable, fpsFromTicks, finishTrack, rescale, toScale, ticksPer, unitsPer,
  };
});
