// Pure Node (no window): Nano Studio Cut's container readers and writer (renderer/features/cut/codecs.js, mp4read.js,
// mkvread.js, audioread.js, probe.js, mp4write.js). Files written by mp4write are read back by probe and every table
// is compared; the boxes and elements the writer never makes (ctts v1, co64 past 4 GB, stz2, elst, fragments, QuickTime
// PCM, Matroska lacing and damage, MP3 Xing/VBRI, RF64...) are built byte by byte here. Truncated and damaged copies
// of every fixture must come back as values, never as a throw or a hang. A two-hour table is indexed against a clock.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dir = '../renderer/features/cut/';
const time = require(`${dir}time.js`);
const codecs = require(`${dir}codecs.js`);
const probe = require(`${dir}probe.js`);
const mp4write = require(`${dir}mp4write.js`);
const audioread = require(`${dir}audioread.js`);
const { TICKS } = time;

let passed = 0;
let failed = 0;
function check(ok, what) {
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${what}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
const arr = (t) => Array.from(t);
const sec = (s) => Math.round(s * TICKS);
// value / scale seconds in ticks, rounded half away from zero, in exact integers.
function units(v, scale) {
  const n = BigInt(Math.round(v)) * BigInt(TICKS);
  const d = BigInt(scale);
  const a = n < 0n ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return Number(n < 0n ? -q : q);
}

// ---- byte builders ---------------------------------------------------------------------------------------------------

function flat(parts) {
  const list = [];
  const walk = (p) => {
    if (p == null) return;
    if (typeof p === 'number') list.push(Uint8Array.of(p));
    else if (p instanceof Uint8Array) list.push(p);
    else if (Array.isArray(p)) {
      if (p.every((x) => typeof x === 'number')) list.push(Uint8Array.from(p));
      else p.forEach(walk);
    }
  };
  walk(parts);
  return codecs.concat(list);
}
const be16 = (v) => [(v >> 8) & 255, v & 255];
const be24 = (v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const be64 = (v) => [...be32(Math.floor(v / 4294967296)), ...be32(v >>> 0)];
const le16 = (v) => [v & 255, (v >> 8) & 255];
const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const le64 = (v) => [...le32(v >>> 0), ...le32(Math.floor(v / 4294967296))];
const text = (s) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n) => new Uint8Array(n);
const fill = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (seed * 131 + i * 7) & 255; return b; };
function box(type, ...parts) { const body = flat(parts); return flat([be32(body.length + 8), text(type), body]); }
const full = (type, v, flags, ...parts) => box(type, [v], be24(flags), ...parts);

// Bits MSB first, with Exp-Golomb, for hand-made SPS and frame headers.
class Bits {
  constructor() { this.a = []; }
  put(v, n) { for (let i = n - 1; i >= 0; i--) this.a.push(Math.floor(v / 2 ** i) & 1); return this; }
  ue(v) { const x = v + 1; let n = 0; while (2 ** (n + 1) <= x) n++; return this.put(0, n).put(x, n + 1); }
  se(v) { return this.ue(v <= 0 ? -2 * v : 2 * v - 1); }
  bytes(trailing = true) {
    const a = [...this.a];
    if (trailing) a.push(1);
    while (a.length % 8) a.push(0);
    const out = [];
    for (let i = 0; i < a.length; i += 8) out.push(a.slice(i, i + 8).reduce((x, y) => x * 2 + y, 0));
    return out;
  }
}
function escape(rbsp) {
  const out = [];
  let z = 0;
  for (const b of rbsp) {
    if (z >= 2 && b <= 3) { out.push(3); z = 0; }
    out.push(b);
    z = b === 0 ? z + 1 : 0;
  }
  return out;
}

// H.264 High 4.0, 1920x1080 (1088 cropped by 8), scaling lists, VUI: BT.709 and 30000/1001 timing.
function avcSps() {
  const b = new Bits().put(100, 8).put(0, 8).put(40, 8).ue(0).ue(1).ue(0).ue(0).put(0, 1).put(1, 1);
  for (let i = 0; i < 8; i++) {
    if (i === 0) { b.put(1, 1); for (let j = 0; j < 16; j++) b.se(j === 0 ? 2 : j === 1 ? -1 : 0); }
    else if (i === 6) { b.put(1, 1); for (let j = 0; j < 64; j++) b.se(0); }
    else b.put(0, 1);
  }
  b.ue(0).ue(0).ue(2).ue(4).put(0, 1).ue(119).ue(67).put(1, 1).put(1, 1).put(1, 1).ue(0).ue(0).ue(0).ue(4).put(1, 1);
  b.put(1, 1).put(1, 8).put(0, 1).put(1, 1).put(5, 3).put(0, 1).put(1, 1).put(1, 8).put(1, 8).put(1, 8).put(0, 1);
  b.put(1, 1).put(1001, 32).put(60000, 32).put(1, 1).put(0, 4);
  return Uint8Array.from([0x67, ...escape(b.bytes())]);
}
// HEVC Main 10 level 5.1, 3840x2160 (2176 cropped), scaling lists, two short-term RPS (one predicted), a long-term
// picture, VUI: BT.2020 PQ full range.
function hevcSps() {
  const b = new Bits().put(0, 4).put(0, 3).put(1, 1);
  b.put(0, 2).put(0, 1).put(2, 5).put(0x20000000, 32).put(0x90, 8);
  for (let i = 0; i < 5; i++) b.put(0, 8);
  b.put(153, 8);
  b.ue(0).ue(1).ue(3840).ue(2176).put(1, 1).ue(0).ue(0).ue(0).ue(8).ue(2).ue(2).ue(4).put(1, 1).ue(4).ue(2).ue(0);
  b.ue(0).ue(3).ue(0).ue(3).ue(0).ue(0);
  b.put(1, 1).put(1, 1);
  for (let size = 0; size < 4; size++) {
    for (let m = 0; m < 6; m += size === 3 ? 3 : 1) {
      if (size === 0 && m === 0) { b.put(1, 1); for (let k = 0; k < 16; k++) b.se(1); }
      else b.put(0, 1).ue(0);
    }
  }
  b.put(1, 1).put(1, 1).put(0, 1);
  b.ue(2);
  b.ue(2).ue(1).ue(0).put(1, 1).ue(1).put(1, 1).ue(0).put(0, 1);
  b.put(1, 1).put(0, 1).ue(0).put(1, 1).put(0, 1).put(1, 1).put(0, 1).put(0, 1).put(1, 1);
  b.put(1, 1).ue(1).put(77, 8).put(1, 1);
  b.put(1, 1).put(1, 1).put(1, 1);
  b.put(0, 1).put(0, 1).put(1, 1).put(5, 3).put(1, 1).put(1, 1).put(9, 8).put(16, 8).put(9, 8).put(0, 7);
  b.put(0, 1);
  return Uint8Array.from([0x42, 0x01, ...escape(b.bytes())]);
}
const PPS = Uint8Array.of(0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0);
const VPS = Uint8Array.of(0x40, 0x01, 0x0c, 0x01, 0xff, 0xff, 0x02, 0x20);
const HPPS = Uint8Array.of(0x44, 0x01, 0xc1, 0x72, 0xb4, 0x62, 0x40);
const ASC = Uint8Array.of(0x11, 0x90);
const opusHead = (pre = 312, ch = 2) => Uint8Array.from([...text('OpusHead'), 1, ch, ...le16(pre), ...le32(48000), 0, 0, 0]);
function vp9Key(profile, tenBit, w, h) {
  const b = new Bits().put(2, 2).put(profile & 1, 1).put(profile >> 1, 1);
  if (profile === 3) b.put(0, 1);
  b.put(0, 1).put(0, 1).put(1, 1).put(0, 1).put(0x498342, 24);
  if (profile >= 2) b.put(tenBit ? 0 : 1, 1);
  b.put(2, 3).put(0, 1);
  if (profile === 1 || profile === 3) b.put(1, 1).put(1, 1).put(0, 1);
  b.put(w - 1, 16).put(h - 1, 16);
  return Uint8Array.from(b.bytes(false));
}

function memSink() {
  let buf = new Uint8Array(1 << 16);
  let len = 0;
  return {
    writes: 0,
    async write(b, p) {
      this.writes++;
      const at = p ?? len;
      if (at + b.length > buf.length) {
        const n = new Uint8Array(Math.max(buf.length * 2, at + b.length));
        n.set(buf.subarray(0, len));
        buf = n;
      }
      buf.set(b, at);
      len = Math.max(len, at + b.length);
    },
    bytes: () => buf.slice(0, len),
  };
}
function counting(bytes) {
  const r = codecs.bufferReader(bytes);
  const c = { size: r.size, reads: 0, read(o, n) { c.reads++; return r.read(o, n); } };
  return c;
}
const reader = (b) => codecs.bufferReader(b);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);

// Top-level box list of an MP4 in memory: [{ type, at, size, hdr }].
function topBoxes(b) {
  const out = [];
  for (let p = 0; p + 8 <= b.length;) {
    let size = codecs.u32(b, p);
    let hdr = 8;
    if (size === 1) { size = codecs.u64(b, p + 8); hdr = 16; }
    out.push({ type: codecs.ascii(b, p + 4, 4), at: p, size, hdr });
    if (size < hdr) break;
    p += size;
  }
  return out;
}
function findBoxes(b, start, end, type, out = []) {
  const kids = require(`${dir}mp4read.js`).boxes(b, start, end);
  for (const k of kids) {
    if (k.type === type) out.push(k);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf'].includes(k.type)) findBoxes(b, k.start, k.end, type, out);
  }
  return out;
}

// ---- codecs ------------------------------------------------------------------------------------------------------

{
  check(eq(arr(codecs.unescapeRbsp(Uint8Array.of(0, 0, 3, 1, 5, 0, 0, 3, 0, 0, 3))), [0, 0, 1, 5, 0, 0, 0, 0]), 'emulation prevention bytes are removed');
  const sps = avcSps();
  const info = codecs.parseAvcSps(sps);
  check(info.profile === 100 && info.level === 40 && info.width === 1920 && info.height === 1080 && info.chromaFormat === 1 && info.bitDepthLuma === 8,
    `H.264 SPS: profile, level and the cropped size (${JSON.stringify(info)})`);
  check(eq(info.colorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }) && eq(info.timing, [30000, 1001]),
    `H.264 SPS VUI: color and timing (${JSON.stringify(info.colorSpace)} ${info.timing})`);
  const avcC = codecs.buildAvcC({ sps: [sps], pps: [PPS] });
  const parsed = codecs.parseAvcC(avcC);
  check(parsed.profile === 100 && parsed.level === 40 && parsed.lengthSize === 4 && same(parsed.sps[0], sps) && same(parsed.pps[0], PPS) && avcC.length === 6 + 2 + sps.length + 1 + 2 + PPS.length + 4,
    'avcC: build and parse back, with the High profile extension');
  check(codecs.avcCodecString(parsed) === 'avc1.640028' && codecs.avcCodecString(parsed, 'avc3') === 'avc3.640028', 'avc1 codec string');

  const hs = hevcSps();
  const h = codecs.parseHevcSps(hs);
  check(h.width === 3840 && h.height === 2160 && h.bitDepthLuma === 10 && h.profile === 2 && h.level === 153 && h.chromaFormat === 1,
    `HEVC SPS: size, bit depth, profile, level (${h.width}x${h.height} ${h.bitDepthLuma} ${h.profile} ${h.level})`);
  check(eq(h.colorSpace, { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: true }),
    `HEVC SPS VUI past scaling lists, predicted RPS and long-term pictures: BT.2020 PQ (${JSON.stringify(h.colorSpace)})`);
  const hvcC = codecs.buildHvcC({ vps: [VPS], sps: [hs], pps: [HPPS] });
  const hp = codecs.parseHvcC(hvcC);
  check(hp.profile === 2 && hp.level === 153 && hp.bitDepthLuma === 10 && hp.lengthSize === 4 && hp.arrays.length === 3 && same(hp.vps[0], VPS) && same(hp.sps[0], hs) && same(hp.pps[0], HPPS) && hp.arrays[1].complete === 1,
    'hvcC: build and parse back');
  check(codecs.hevcCodecString(hp) === 'hvc1.2.4.L153.90' && codecs.hevcCodecString(hp, 'hev1') === 'hev1.2.4.L153.90', `hvc1 codec string (${codecs.hevcCodecString(hp)})`);
  check(codecs.hevcCodecString({ profileSpace: 0, tier: 1, profile: 1, compat: 0x60000000, constraints: Uint8Array.of(0xb0, 0, 0, 0, 0, 0), level: 120 }) === 'hvc1.1.6.H120.B0',
    'hvc1 codec string: Main, high tier, reversed compatibility bits');

  check(eq(arr(codecs.buildAudioSpecificConfig({ objectType: 2, sampleRate: 48000, channels: 2 })), [0x11, 0x90])
    && eq(arr(codecs.buildAudioSpecificConfig({ objectType: 2, sampleRate: 44100, channels: 2 })), [0x12, 0x10]), 'AudioSpecificConfig for AAC-LC 48 and 44.1 kHz stereo');
  const asc = codecs.parseAudioSpecificConfig(Uint8Array.of(0x11, 0x90));
  check(asc.objectType === 2 && asc.sampleRate === 48000 && asc.channels === 2 && asc.frameLength === 1024 && codecs.aacCodecString(asc) === 'mp4a.40.2', 'AudioSpecificConfig parse');
  const he = codecs.parseAudioSpecificConfig(Uint8Array.from(new Bits().put(5, 5).put(6, 4).put(2, 4).put(3, 4).put(2, 5).put(0, 3).bytes(false)));
  check(he.objectType === 5 && he.sampleRate === 48000 && codecs.aacCodecString(he) === 'mp4a.40.5', 'HE-AAC with explicit SBR: output rate');
  const odd = codecs.parseAudioSpecificConfig(codecs.buildAudioSpecificConfig({ objectType: 2, sampleRate: 37800, channels: 1 }));
  check(odd.sampleRate === 37800 && odd.channels === 1, 'AudioSpecificConfig with an explicit sample rate');

  const head = opusHead(312, 2);
  const dops = codecs.dOpsFromOpusHead(head);
  check(eq(arr(dops), [0, 2, 1, 56, 0, 0, 0xbb, 0x80, 0, 0, 0]) && same(codecs.opusHeadFromDOps(dops), head), 'OpusHead <-> dOps');
  check(codecs.parseOpusHead(head).preSkip === 312, 'OpusHead pre-skip');

  const vp = codecs.parseVpcC(Uint8Array.of(0, 40, 0x82, 1, 1, 1, 0, 0), 1);
  check(codecs.vp9CodecString(vp) === 'vp09.00.40.08' && eq(vp.colorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }), 'vpcC -> vp09.00.40.08 and its color');
  const av = codecs.parseAv1C(Uint8Array.of(0x81, 0x08, 0x0c, 0x00));
  check(codecs.av1CodecString(av) === 'av01.0.08M.08', 'av1C -> av01.0.08M.08');
  check(codecs.av1CodecString(codecs.parseAv1C(Uint8Array.of(0x81, 0x2d, 0xc0, 0x00))) === 'av01.1.13H.10', 'av1C high tier 10-bit');
  const k = codecs.parseVp9Frame(vp9Key(2, true, 1280, 720));
  check(k && k.key && k.profile === 2 && k.bitDepth === 10 && k.width === 1280 && k.height === 720 && k.colorSpace?.matrix === 'bt709', `VP9 key frame header (${JSON.stringify(k)})`);
  check(codecs.vp9Level(1920, 1080, 30) === 40 && codecs.vp9Level(1280, 720, 30) === 31 && codecs.vp9Level(3840, 2160, 60) === 51, 'VP9 levels from size and rate');

  const pcm = codecs.pcmToFloat(Uint8Array.of(0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x40), 'pcm-s16', 2);
  check(pcm.length === 2 && pcm[0][0] === -1 && Math.abs(pcm[1][0] - 32767 / 32768) < 1e-7 && pcm[0][1] === 0 && pcm[1][1] === 0.5, 'PCM s16 to float, planar');
  const f32 = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
  check(eq(arr(codecs.pcmToFloat(f32, 'pcm-f32', 1)[0]), [0.25, -0.5]), 'PCM f32');
  check(codecs.pcmToFloat(Uint8Array.of(0x00, 0x00, 0x80), 'pcm-s24', 1)[0][0] === -1 && codecs.pcmToFloat(Uint8Array.of(0x80, 0x00, 0x00), 'pcm-s24be', 1)[0][0] === -1, 'PCM s24 little and big endian');
  check(codecs.pcmToFloat(Uint8Array.of(128, 0), 'pcm-u8', 1)[0][0] === 0 && codecs.pcmToFloat(Uint8Array.of(128, 0), 'pcm-u8', 1)[0][1] === -1, 'PCM u8');
  check(codecs.rescale(-1105, 44100) === -1105 * 5760000 && codecs.rescale(-1, 3) === -84672000000 && codecs.toScale(-6364800000, 44100) === -1105 && codecs.rescale(7, 1e7) === 177811,
    'sign-safe rescale (time.rescale rounds negative values up)');
  check(eq(codecs.colorFromCodes(9, 18, 9, 0), { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false }) && codecs.colorFromCodes(2, 2, 2, null) === null
    && eq(codecs.codesFromColor({ primaries: 'smpte170m', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true }), { primaries: 6, transfer: 13, matrix: 0, fullRange: true }), 'color code points <-> WebCodecs names');
}

// ---- mp4write -> probe round trips -------------------------------------------------------------------------------------

const FPS = [30000, 1001];
const FRAME = time.frameTicks(FPS);
const AAC = time.rescale(1024, 48000);
const avcC = codecs.buildAvcC({ sps: [avcSps()], pps: [PPS] });
const hvcC = codecs.buildHvcC({ vps: [VPS], sps: [hevcSps()], pps: [HPPS] });

// Video in decode order with B-frames: I P B B P B B ..., a key every 30 frames; pts start at 0.
function videoPlan(n, { negative = false, gop = 30 } = {}) {
  const out = [];
  for (let g = 0; g < n; g += gop) {
    const m = Math.min(gop, n - g);
    const order = [0];
    for (let p = 3; p <= m - 1 + 2; p += 3) {
      const P = Math.min(p, m - 1);
      if (!order.includes(P)) order.push(P);
      for (let b = p - 2; b < p && b < m; b++) if (!order.includes(b)) order.push(b);
    }
    for (let i = 0; i < m; i++) if (!order.includes(i)) order.push(i);
    for (const i of order) out.push(g + i);
  }
  return out.map((frame, k) => {
    const pts = frame * FRAME;
    const dts = (k - (negative ? 0 : 2)) * FRAME;
    return { data: fill(200 + ((k * 37) % 900), k), timestamp: pts, duration: FRAME, key: frame % gop === 0, compositionOffset: pts - dts, dts };
  });
}
function audioPlan(n, first = 0, step = AAC, size = (i) => 150 + (i % 40)) {
  return Array.from({ length: n }, (_, i) => ({ data: fill(size(i), 1000 + i), timestamp: first + i * step, duration: step }));
}
// Feeds samples in time order the way an export does.
async function writeFile({ video, audio, vcfg, acfg, timescale }) {
  const sink = memSink();
  const w = mp4write.create({ video: vcfg, audio: acfg, sink, timescale });
  let vi = 0;
  let ai = 0;
  const V = video || [];
  const A = audio || [];
  while (vi < V.length || ai < A.length) {
    if (vi < V.length && (ai >= A.length || V[vi].dts <= A[ai].timestamp)) await w.addVideo(V[vi++]);
    else await w.addAudio(A[ai++]);
  }
  const res = await w.finish();
  return { bytes: sink.bytes(), res, sink };
}
async function compareTrack(r, track, plan, label, { kind }) {
  const s = track.samples;
  check(s.count === plan.length, `${label}: ${plan.length} samples (${s.count})`);
  let bad = [];
  for (let i = 0; i < Math.min(s.count, plan.length); i++) {
    const p = plan[i];
    const dts = kind === 'video' ? p.dts : p.timestamp;
    if (s.size[i] !== p.data.length) bad.push(`size ${i}`);
    if (s.pts[i] !== p.timestamp) bad.push(`pts ${i}: ${s.pts[i]} != ${p.timestamp}`);
    if (s.dts[i] !== dts) bad.push(`dts ${i}: ${s.dts[i]} != ${dts}`);
    const dur = i + 1 < plan.length ? (kind === 'video' ? plan[i + 1].dts : plan[i + 1].timestamp) - dts : p.duration;
    if (s.duration[i] !== dur) bad.push(`duration ${i}: ${s.duration[i]} != ${dur}`);
    if (s.key[i] !== (kind === 'audio' || p.key ? 1 : 0)) bad.push(`key ${i}`);
    if (bad.length > 5) break;
  }
  check(!bad.length, `${label}: sizes, dts, pts, durations and sync flags match what was written (${bad.slice(0, 5).join('; ')})`);
  const sorted = plan.map((p, i) => [p.timestamp, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[1]);
  check(eq(arr(s.order), sorted), `${label}: presentation order`);
  const all = await probe.readSamples(r, track, 0, s.count);
  let wrong = -1;
  for (let i = 0; i < plan.length; i++) if (!all[i] || !same(all[i], plan[i].data)) { wrong = i; break; }
  check(wrong < 0, `${label}: every sample's bytes read back (first wrong ${wrong})`);
  const one = await probe.readSample(r, track, s.count - 1);
  check(same(one, plan[plan.length - 1].data), `${label}: readSample of the last sample`);
}

function chunkLayout(bytes, moov, src) {
  const mp4read = require(`${dir}mp4read.js`);
  const chunks = [];
  for (const [ti, trak] of findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'trak').entries()) {
    const stbl = findBoxes(bytes, trak.start, trak.end, 'stbl')[0];
    const kids = mp4read.boxes(bytes, stbl.start, stbl.end);
    const co = kids.find((x) => x.type === 'co64');
    const sc = kids.find((x) => x.type === 'stsc');
    const offsets = [];
    for (let i = 0, n = codecs.u32(bytes, co.start + 4); i < n; i++) offsets.push(codecs.u64(bytes, co.start + 8 + 8 * i));
    const entries = [];
    for (let i = 0, n = codecs.u32(bytes, sc.start + 4); i < n; i++) entries.push([codecs.u32(bytes, sc.start + 8 + 12 * i), codecs.u32(bytes, sc.start + 12 + 12 * i)]);
    const track = src.tracks[ti];
    let sample = 0;
    offsets.forEach((o, c) => {
      const per = entries.filter((e) => e[0] <= c + 1).pop()[1];
      chunks.push({ track: ti, offset: o, start: track.samples.dts[sample], end: track.samples.dts[sample + per - 1] + track.samples.duration[sample + per - 1], first: sample, per });
      sample += per;
    });
  }
  chunks.sort((x, y) => x.offset - y.offset);
  return chunks;
}

{
  // H.264 with B-frames (ctts v0, edit list for the delay) and AAC with priming before 0 (edit list media time).
  const video = videoPlan(90);
  const audio = audioPlan(143, -AAC * 2);
  const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
  const { bytes, res, sink } = await writeFile({
    video, audio,
    vcfg: { codec: 'avc1.640028', width: 1920, height: 1080, description: avcC, frameRate: FPS, colorSpace: color },
    acfg: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: ASC },
  });
  check(res.bytes === bytes.length, `finish() reports the file size (${res.bytes} / ${bytes.length})`);
  check(sink.writes < 20, `writes are batched (${sink.writes} sink writes)`);
  const top = topBoxes(bytes);
  check(eq(top.map((b) => b.type), ['ftyp', 'mdat', 'moov']), `ftyp, mdat, moov at the end (${top.map((b) => b.type)})`);
  const ftyp = bytes.subarray(top[0].at + 8, top[0].at + top[0].size);
  check(codecs.ascii(ftyp, 0, 4) === 'isom' && codecs.ascii(ftyp, 8, 16) === 'isomiso2avc1mp41', 'ftyp brands isom, iso2, avc1, mp41');
  check(codecs.u32(bytes, top[1].at) === 1 && top[1].hdr === 16 && top[1].size === top[2].at - top[1].at, `mdat has a 64-bit size patched to its length (${top[1].size})`);
  const moov = top[2];
  check(findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'co64').length === 2 && !findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'stco').length, 'chunk offsets are co64');
  const ctts = findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'ctts');
  check(ctts.length === 1 && bytes[ctts[0].start] === 0, 'ctts (version 0) only on the video track');
  check(findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'stss').length === 1, 'stss only on the video track');
  check(findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'elst').length === 2, 'edit lists for the B-frame delay and the audio priming');
  const moovText = Buffer.from(bytes.subarray(moov.at, moov.at + moov.size)).toString('latin1');
  const count = (t) => moovText.split(t).length - 1;
  check(count('colr') === 1 && count('btrt') === 2 && count('esds') === 1 && count('avcC') === 1, 'colr, btrt and esds in the sample entries');
  const r = reader(bytes);
  const src = await probe.open(r, { name: 'a.mp4' });
  check(src.error === null && src.container === 'mp4' && src.tracks.length === 2 && src.tracks[0].kind === 'video' && src.tracks[1].kind === 'audio', `the file opens: video then audio (${JSON.stringify(src.error)})`);
  const [v, a] = src.tracks;
  check(v.codec === 'avc1.640028' && same(v.description, avcC) && v.width === 1920 && v.height === 1080 && v.displayWidth === 1920 && v.displayHeight === 1080 && v.rotation === 0,
    'video: codec string, avcC, size, rotation');
  check(eq(v.colorSpace, color) && eq(v.frameRate, FPS) && v.vfr === false, `video: colr, nominal 29.97, constant rate (${JSON.stringify(v.frameRate)} ${v.vfr})`);
  check(a.codec === 'mp4a.40.2' && same(a.description, ASC) && a.sampleRate === 48000 && a.channels === 2, 'audio: codec string, AudioSpecificConfig, rate, channels');
  await compareTrack(r, v, video, 'H.264 with B-frames', { kind: 'video' });
  await compareTrack(r, a, audio, 'AAC starting before 0', { kind: 'audio' });
  check(src.duration === Math.max(90 * FRAME, audio[audio.length - 1].timestamp + AAC), `source duration (${src.duration})`);
  check(v.duration === 90 * FRAME && a.duration === audio[audio.length - 1].timestamp + AAC, 'track durations follow the edit lists');

  // Chunks: about half a second each, laid out in time order across the two tracks.
  const chunks = chunkLayout(bytes, moov, src);
  const long = chunks.filter((c) => c.end - c.start > sec(0.5) + FRAME);
  const backwards = chunks.filter((c, i) => i && c.start < chunks[i - 1].start - sec(0.5));
  check(chunks.filter((c) => c.track === 0).length >= 5 && chunks.filter((c) => c.track === 1).length >= 5 && !long.length && !backwards.length,
    `chunks of about half a second, in time order across tracks (${chunks.length} chunks, ${long.length} long, ${backwards.length} out of order)`);
  const offsetsOk = chunks.every((c) => src.tracks[c.track].samples.offset[c.first] === c.offset);
  check(offsetsOk, 'sample offsets start at their chunk offsets');

  // Lookups on the B-frame table.
  const t = v.samples;
  check(probe.sampleAtTime(v, 0) === t.order[0] && probe.sampleAtTime(v, -5) === t.order[0], 'sampleAtTime at and before the first frame');
  const f10 = t.order[10];
  check(probe.sampleAtTime(v, 10 * FRAME) === f10 && probe.sampleAtTime(v, 10 * FRAME + FRAME - 1) === f10 && probe.sampleAtTime(v, 11 * FRAME) === t.order[11], 'sampleAtTime: last pts <= t');
  check(probe.sampleAtTime(v, 1e15) === t.order[t.count - 1], 'sampleAtTime past the end: the last frame');
  const keyOk = Array.from({ length: t.count }, (_, i) => {
    const k = probe.keyBefore(v, i);
    if (!t.key[k] || k > i) return false;
    for (let j = k + 1; j <= i; j++) if (t.key[j]) return false;
    return true;
  }).every(Boolean);
  check(keyOk, 'keyBefore: the closest sync sample at or before, for every frame');
  const cr = counting(bytes);
  const run = await probe.readSamples(cr, v, 30, 45);
  check(run.length === 15 && run.every((x, i) => same(x, video[30 + i].data)) && cr.reads <= 3, `readSamples reads a run in few reads (${cr.reads})`);
  check((await probe.readSamples(r, v, 88, 200)).length === 2 && (await probe.readSamples(r, v, 5, 5)).length === 0, 'readSamples clamps and is half-open');
  let threw = false;
  try { await probe.readSample(r, v, t.count); } catch { threw = true; }
  check(threw, 'readSample of a missing index rejects');
}

{
  // Negative composition offsets (ctts v1), audio starting late (an empty edit), HEVC with color from the SPS.
  const video = videoPlan(60, { negative: true });
  const audio = audioPlan(60, sec(0.25));
  const { bytes } = await writeFile({
    video, audio,
    vcfg: { codec: 'hvc1.2.4.L153.90', width: 3840, height: 2160, description: hvcC, frameRate: FPS },
    acfg: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 },
  });
  const moov = topBoxes(bytes)[2];
  const ctts = findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'ctts');
  check(ctts.length === 1 && bytes[ctts[0].start] === 1, 'negative composition offsets give ctts version 1');
  const elst = findBoxes(bytes, moov.at + 8, moov.at + moov.size, 'elst');
  check(elst.length === 1 && codecs.u32(bytes, elst[0].start + 4) === 2 && codecs.i32(bytes, elst[0].start + 12) === -1, 'late audio gets an empty edit first');
  const r = reader(bytes);
  const src = await probe.open(r);
  const [v, a] = src.tracks;
  check(v.codec === 'hvc1.2.4.L153.90' && same(v.description, hvcC) && v.width === 3840 && v.bitDepth === 10, `HEVC track (${v.codec})`);
  check(v.colorSpace?.transfer === 'pq' && v.colorSpace?.primaries === 'bt2020', 'HEVC color comes from the SPS when there is no colr (PQ is listed, not refused)');
  check(src.error === null, 'an HDR track is not an error at the source level');
  check(!a.description || same(a.description, ASC), 'the writer builds the AudioSpecificConfig when none is given');
  await compareTrack(r, v, video, 'HEVC with negative offsets', { kind: 'video' });
  await compareTrack(r, a, audio, 'AAC starting at 0.25 s', { kind: 'audio' });
  check(probe.sampleAtTime(a, sec(0.1)) === 0 && a.samples.pts[0] === sec(0.25), 'audio before its first sample');
}

{
  // VFR (a screen recording), Opus audio, an M4A with audio only.
  const steps = [1, 1, 1, 2, 1, 1, 3, 1, 1, 1, 1, 2];
  let t = 0;
  const video = [];
  for (let i = 0; i < 120; i++) {
    const d = steps[i % steps.length] * time.frameTicks([60, 1]);
    video.push({ data: fill(50 + (i % 9), i), timestamp: t, duration: d, key: i % 60 === 0, dts: t });
    t += d;
  }
  const opus = audioPlan(100, 0, time.rescale(960, 48000), () => 80);
  const { bytes } = await writeFile({
    video, audio: opus,
    vcfg: { codec: 'avc1.640028', width: 1280, height: 720, description: avcC, frameRate: [60, 1] },
    acfg: { codec: 'opus', sampleRate: 48000, channels: 2, description: opusHead(312) },
  });
  const r = reader(bytes);
  const src = await probe.open(r);
  const [v, a] = src.tracks;
  check(v.vfr === true && eq(v.frameRate, [60, 1]), `VFR: flagged, nominal rate = the most common duration (${v.frameRate} ${v.vfr})`);
  await compareTrack(r, v, video, 'VFR video', { kind: 'video' });
  check(a.codec === 'opus' && same(a.description, opusHead(312)) && a.sampleRate === 48000 && a.channels === 2, 'Opus: dOps written and read back as OpusHead');
  await compareTrack(r, a, opus, 'Opus', { kind: 'audio' });
  check(probe.keyBefore(a, 50) <= 50 - 4 && probe.keyBefore(a, 50) >= 50 - 5 && probe.keyBefore(a, 2) === 0, `Opus decoding starts 80 ms early (${probe.keyBefore(a, 50)})`);

  const m4a = audioPlan(200);
  const only = await writeFile({ audio: m4a, acfg: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 1 } });
  const s2 = await probe.open(reader(only.bytes));
  check(s2.error === null && s2.tracks.length === 1 && s2.tracks[0].kind === 'audio' && s2.tracks[0].channels === 1, 'audio-only M4A');
  await compareTrack(reader(only.bytes), s2.tracks[0], m4a, 'M4A', { kind: 'audio' });
}

{
  // An export that hands over three seconds of video before any audio: the video waits so the chunks stay in time order.
  const video = videoPlan(90);
  const audio = audioPlan(140);
  const sink = memSink();
  const w = mp4write.create({ video: { codec: 'avc1.640028', width: 64, height: 64, description: avcC, frameRate: FPS }, audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 }, sink });
  for (const x of video) await w.addVideo(x);
  for (const x of audio) await w.addAudio(x);
  await w.finish();
  const bytes = sink.bytes();
  const src = await probe.open(reader(bytes));
  const chunks = chunkLayout(bytes, topBoxes(bytes)[2], src);
  const backwards = chunks.filter((c, i) => i && c.start < chunks[i - 1].start - sec(0.5));
  check(src.error === null && chunks.length > 10 && !backwards.length, `a track that arrives first waits for the other one (${backwards.length} chunks out of order)`);
  await compareTrack(reader(bytes), src.tracks[0], video, 'video handed over first', { kind: 'video' });
}

{
  // The writer refuses what it cannot write, and reports a failing sink.
  const sink = memSink();
  let msg = '';
  try { mp4write.create({ video: { codec: 'vp09.00.40.08', width: 10, height: 10, frameRate: [30, 1] }, sink }); } catch (err) { msg = err.message; }
  check(/vp09/.test(msg), 'mp4write refuses video codecs it does not write');
  try { mp4write.create({ video: { codec: 'avc1.640028', width: 10, height: 10, frameRate: [30, 1] }, sink }); msg = ''; } catch (err) { msg = err.message; }
  check(/description/.test(msg), 'mp4write needs the avcC');
  let n = 0;
  const broken = { async write() { if (++n > 1) throw new Error('disk full'); } };
  const w = mp4write.create({ video: { codec: 'avc1.640028', width: 16, height: 16, description: avcC, frameRate: [30, 1] }, sink: broken });
  let err = null;
  try {
    for (let i = 0; i < 40; i++) await w.addVideo({ data: fill(3 << 20, i), timestamp: i * time.frameTicks([30, 1]), duration: time.frameTicks([30, 1]), key: !i });
  } catch (e) { err = e; }
  check(err && /disk full/.test(err.message), 'a sink error stops the next addVideo');
  err = null;
  try { await w.finish(); } catch (e) { err = e; }
  check(err && /disk full/.test(err.message), 'a sink error rejects finish()');
  // An export adds samples from the encoder's callback without awaiting them: onError tells it at the failed write.
  let m = 0;
  const heard = [];
  const late = mp4write.create({ video: { codec: 'avc1.640028', width: 16, height: 16, description: avcC, frameRate: [30, 1] },
    sink: { async write() { if (++m > 2) throw new Error('disk full'); } }, onError: (e) => heard.push(e.message) });
  let added = 0;
  for (let i = 0; i < 40 && !late.error; i++) {
    try { late.addVideo({ data: fill(3 << 20, i), timestamp: i * time.frameTicks([30, 1]), duration: time.frameTicks([30, 1]), key: !i }); added++; } catch { break; }
    await new Promise((r) => setTimeout(r, 0));
  }
  check(JSON.stringify(heard) === JSON.stringify(["disk full"]) && late.error?.message === 'disk full' && added < 40, `onError hears the first refused write once, without awaiting the samples (${JSON.stringify(heard)}, ${added} added)`);
}

{
  // Past 4 GB: 70 samples of 64 MB through a sink that only keeps the small writes; read back through a sparse reader.
  const big = fill(64 << 20, 9);
  const small = [];
  let len = 0;
  const regions = [];
  const sink = {
    async write(b, p) {
      const at = p ?? len;
      if (b === big) regions.push(at);
      else small.push([at, b.slice()]);
      len = Math.max(len, at + b.length);
    },
  };
  const w = mp4write.create({ video: { codec: 'avc1.640028', width: 1920, height: 1080, description: avcC, frameRate: [30, 1] }, sink });
  const F = time.frameTicks([30, 1]);
  for (let i = 0; i < 70; i++) await w.addVideo({ data: big, timestamp: i * F, duration: F, key: i % 10 === 0 });
  const { bytes } = await w.finish();
  const sparse = {
    size: bytes,
    async read(off, n) {
      const out = new Uint8Array(Math.max(0, Math.min(n, bytes - off)));
      for (const at of regions) {
        const a = Math.max(off, at);
        const b = Math.min(off + out.length, at + big.length);
        if (a < b) out.set(big.subarray(a - at, b - at), a - off);
      }
      for (const [at, part] of small) {
        const a = Math.max(off, at);
        const b = Math.min(off + out.length, at + part.length);
        if (a < b) out.set(part.subarray(a - at, b - at), a - off);
      }
      return out;
    },
  };
  check(bytes > 4.5e9 && regions.length === 70, `a ${Math.round(bytes / 1e9 * 10) / 10} GB file is written without copying its samples`);
  const src = await probe.open(sparse);
  const v = src.tracks[0];
  check(src.error === null && v && v.samples.count === 70 && v.samples.offset[69] > 2 ** 32 && v.samples.offset[69] === regions[69], `co64 offsets past 4 GB (${v?.samples.offset[69]})`);
  const last = await probe.readSample(sparse, v, 69);
  check(same(last, big), 'the last 64 MB sample reads back from past 4 GB');
}

// ---- hand-made MP4 and MOV --------------------------------------------------------------------------------------------

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const ROT90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];
const mvhd = (ts, dur, next) => full('mvhd', 0, 0, be32(0), be32(0), be32(ts), be32(dur), be32(0x10000), be16(0x100), zeros(10), IDENTITY.map(be32), zeros(24), be32(next));
const tkhd = (id, dur, matrix = IDENTITY, w = 0, h = 0) => full('tkhd', 0, 3, be32(0), be32(0), be32(id), be32(0), be32(dur), zeros(8), be16(0), be16(0), be16(0), be16(0), matrix.map(be32), be32(w * 65536), be32(h * 65536));
const visual = (type, w, h, ...kids) => box(type, zeros(6), be16(1), zeros(16), be16(w), be16(h), be32(0x480000), be32(0x480000), be32(0), be16(1), zeros(32), be16(0x18), be16(0xffff), ...kids);
const sound = (type, ch, bits, rate, ...kids) => box(type, zeros(6), be16(1), zeros(8), be16(ch), be16(bits), be32(0), be32(rate * 65536), ...kids);
function esds(oti, asc, wide = false) {
  const len = (n) => (wide ? [0x80, 0x80, 0x80, n] : [n]);
  const dsi = asc ? [5, ...len(asc.length), ...asc] : [];
  const dc = [0x40 === oti ? 0x40 : oti, 0x15, 0, 0, 0, ...be32(128000), ...be32(128000), ...dsi];
  const es = [0, 1, 0, 4, ...len(dc.length), ...dc, 6, ...len(1), 2];
  return full('esds', 0, 0, 3, len(es.length), es);
}
function trak({ id, handler, timescale, entry, stts, ctts, cttsVersion = 0, stss, sizes, stz2, stsc, offsets, co64 = false, elst, matrix, wh = [0, 0] }) {
  const stbl = box('stbl',
    full('stsd', 0, 0, be32(1), entry),
    full('stts', 0, 0, be32(stts.length), stts.map(([n, d]) => [be32(n), be32(d)])),
    ctts ? full('ctts', cttsVersion, 0, be32(ctts.length), ctts.map(([n, o]) => [be32(n), be32(o)])) : null,
    stss ? full('stss', 0, 0, be32(stss.length), stss.map(be32)) : null,
    stz2 ? full('stz2', 0, 0, zeros(3), stz2, be32(sizes.length), stz2 === 4 ? sizes.reduce((acc, s, i) => (i & 1 ? (acc[acc.length - 1] |= s, acc) : (acc.push(s << 4), acc)), [])
      : stz2 === 8 ? sizes : sizes.map(be16))
      : Array.isArray(sizes) ? full('stsz', 0, 0, be32(0), be32(sizes.length), sizes.map(be32)) : full('stsz', 0, 0, be32(sizes.fixed), be32(sizes.count)),
    full('stsc', 0, 0, be32(stsc.length), stsc.map(([f, n]) => [be32(f), be32(n), be32(1)])),
    co64 ? full('co64', 0, 0, be32(offsets.length), offsets.map(be64)) : full('stco', 0, 0, be32(offsets.length), offsets.map(be32)));
  return box('trak',
    tkhd(id, 0, matrix, wh[0], wh[1]),
    elst ? box('edts', full('elst', 0, 0, be32(elst.length), elst.map(([d, m]) => [be32(d), be32(m), be16(1), be16(0)]))) : null,
    box('mdia', full('mdhd', 0, 0, be32(0), be32(0), be32(timescale), be32(0), be16(0x55c4), be16(0)),
      full('hdlr', 0, 0, be32(0), text(handler), zeros(12), 0),
      box('minf', handler === 'vide' ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4)), stbl)));
}
const ftyp = (major = 'isom') => box('ftyp', text(major), be32(0), text(major), text('mp41'));
// ftyp, then mdat holding `payload`, then moov from build(dataStart).
function mp4File(payload, build, major) {
  const f = ftyp(major);
  const start = f.length + 8;
  return flat([f, box('mdat', payload), build(start)]);
}

{
  // ctts v1, stss, stz2 (4, 8, 16 bit), stsc with several runs, an empty edit then a media-time edit, a 90 degree
  // matrix, pasp, colr; audio through an esds with four-byte descriptor lengths.
  for (const field of [4, 8, 16]) {
    const sizes = Array.from({ length: 10 }, (_, i) => (field === 4 ? 3 + i : field === 8 ? 100 + i * 9 : 300 + i * 40));
    const cto = [200, -100, 0, 300, 100, -100, 0, 200, 100, 0];
    const asizes = [21, 22, 23, 24, 25, 26];
    const vbytes = sizes.reduce((a, b) => a + b, 0);
    const payload = flat([sizes.map((s, i) => fill(s, i)), asizes.map((s, i) => fill(s, 50 + i))]);
    const bytes = mp4File(payload, (d) => {
      const chunk = [d, d + sizes.slice(0, 3).reduce((a, b) => a + b, 0), d + sizes.slice(0, 6).reduce((a, b) => a + b, 0)];
      return box('moov', mvhd(1000, 1000, 3),
        trak({ id: 1, handler: 'vide', timescale: 3000,
          entry: visual('avc1', 1440, 1080, box('avcC', avcC), box('pasp', be32(4), be32(3)), box('colr', text('nclx'), be16(9), be16(18), be16(9), 0)),
          stts: [[10, 100]], ctts: cto.map((o) => [1, o]), cttsVersion: 1, stss: [1, 6], sizes, stz2: field,
          stsc: [[1, 3], [3, 4]], offsets: chunk, co64: true, elst: [[500, -1], [200, 150]], matrix: ROT90, wh: [1920, 1080] }),
        trak({ id: 2, handler: 'soun', timescale: 44100, entry: sound('mp4a', 2, 16, 44100, esds(0x40, Uint8Array.of(0x12, 0x10), true)),
          stts: [[6, 1024]], sizes: asizes, stsc: [[1, 6]], offsets: [d + vbytes] }));
    });
    const r = reader(bytes);
    const src = await probe.open(r);
    const v = src.tracks[0];
    const label = `hand-made MP4 (stz2 ${field}-bit)`;
    check(src.error === null && v && v.samples.count === 10, `${label}: opens (${JSON.stringify(src.error)})`);
    if (!v) continue;
    check(arr(v.samples.size).join() === sizes.join(), `${label}: sample sizes`);
    const shift = sec(0.5) - units(150, 3000);
    check(arr(v.samples.dts).every((x, i) => x === units(i * 100, 3000) + shift), `${label}: dts after an empty edit and a media-time edit`);
    check(arr(v.samples.pts).every((x, i) => x === units(i * 100 + cto[i], 3000) + shift), `${label}: pts from ctts v1 (negative offsets)`);
    check(arr(v.samples.key).join('') === '1000010000', `${label}: sync samples from stss`);
    const okOffsets = await Promise.all(sizes.map(async (s, i) => same(await probe.readSample(r, v, i), fill(s, i))));
    check(okOffsets.every(Boolean), `${label}: offsets from stsc runs and co64`);
    check(v.rotation === 90 && v.width === 1440 && v.displayWidth === 1920 && v.displayHeight === 1080, `${label}: rotation 90 and pasp (${v.rotation} ${v.displayWidth}x${v.displayHeight})`);
    check(eq(v.colorSpace, { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false }), `${label}: colr nclx wins over the SPS`);
    check(v.duration === sec(0.5) + sec(0.2), `${label}: duration cut by the edit's segment (${v.duration})`);
    const a = src.tracks[1];
    check(a && a.codec === 'mp4a.40.2' && a.sampleRate === 44100 && same(a.description, Uint8Array.of(0x12, 0x10)) && a.samples.count === 6, `${label}: audio through a four-byte-length esds`);
  }
}

{
  // 3 GB offsets in a file with moov first: a 6 GB sparse file.
  const sizes = [1000, 2000, 3000];
  const offs = [3.2e9, 4.5e9 + 17, 5.9e9];
  const f = ftyp();
  const moovFor = () => box('moov', mvhd(1000, 100, 2), trak({ id: 1, handler: 'vide', timescale: 30, entry: visual('avc1', 64, 64, box('avcC', avcC)),
    stts: [[3, 1]], sizes, stsc: [[1, 1]], offsets: offs, co64: true }));
  const moov = moovFor();
  const head = flat([f, moov, be32(1), text('mdat'), be64(6e9 - f.length - moov.length)]);
  const pattern = (o) => (o * 31 + 7) % 251;
  const sparse = {
    size: 6e9,
    async read(off, n) {
      const out = new Uint8Array(Math.max(0, Math.min(n, 6e9 - off)));
      for (let i = 0; i < out.length; i++) out[i] = off + i < head.length ? head[off + i] : pattern(off + i);
      return out;
    },
  };
  const src = await probe.open(sparse);
  const v = src.tracks[0];
  check(src.error === null && v && arr(v.samples.offset).join() === offs.join(), `co64 offsets of 3 to 6 GB (${v && arr(v.samples.offset)})`);
  const s = v && (await probe.readSample(sparse, v, 1));
  check(s && s.length === 2000 && s.every((x, i) => x === pattern(offs[1] + i)), 'a sample at 4.5 GB reads its own bytes');
}

{
  // Fragmented MP4: trex defaults, tfhd default-base-is-moof and explicit base offsets, tfdt v0/v1, trun flags with
  // signed offsets, a second traf whose data follows the first one's.
  const avcEntry = visual('avc1', 320, 240, box('avcC', avcC));
  const emptyStbl = { stts: [], sizes: [], stsc: [], offsets: [] };
  const moov = box('moov', mvhd(1000, 0, 3),
    trak({ id: 1, handler: 'vide', timescale: 90000, entry: avcEntry, ...emptyStbl }),
    trak({ id: 2, handler: 'soun', timescale: 48000, entry: sound('mp4a', 2, 16, 48000, esds(0x40, ASC)), ...emptyStbl }),
    box('mvex', full('trex', 0, 0, be32(1), be32(1), be32(3000), be32(0), be32(0x10000)), full('trex', 0, 0, be32(2), be32(1), be32(1024), be32(30), be32(0x2000000))));
  const head = flat([ftyp('iso6'), moov]);
  const sizes1 = [100, 50, 60, 70, 80];
  const cto1 = [6000, 9000, -3000, 0, 3000];
  const data1 = flat(sizes1.map((s, i) => fill(s, 300 + i)));
  const moof1 = (dataOffset) => box('moof', full('mfhd', 0, 0, be32(1)), box('traf',
    full('tfhd', 0, 0x20008, be32(1), be32(3000)), full('tfdt', 1, 0, be64(0)),
    full('trun', 1, 0x1 | 0x4 | 0x200 | 0x800, be32(5), be32(dataOffset), be32(0x2000000), sizes1.map((s, i) => [be32(s), be32(cto1[i])]))));
  const m1len = moof1(0).length;
  const part1 = flat([moof1(m1len + 8), box('mdat', data1)]);
  const durs2 = [3000, 3000, 6000, 3000];
  const flags2 = [0x2000000, 0x10000, 0x10000, 0x10000];
  const data2v = flat(durs2.map((_, i) => fill(40, 400 + i)));
  const data2a = flat([0, 1, 2].map((i) => fill(30, 500 + i)));
  const moof2 = (base) => box('moof', full('mfhd', 0, 0, be32(2)),
    box('traf', full('tfhd', 0, 0x1 | 0x10 | 0x20, be32(1), be64(base), be32(40), be32(0x10000)), full('tfdt', 0, 0, be32(15000)),
      full('trun', 0, 0x100 | 0x400, be32(4), durs2.map((d, i) => [be32(d), be32(flags2[i])]))),
    box('traf', full('tfhd', 0, 0x8 | 0x10, be32(2), be32(1024), be32(30)), full('trun', 0, 0, be32(3))));
  const m2at = head.length + part1.length;
  const m2len = moof2(0).length;
  const bytes = flat([head, part1, moof2(m2at + m2len + 8), box('mdat', data2v, data2a)]);
  const r = reader(bytes);
  const src = await probe.open(r);
  const [v, a] = src.tracks;
  check(src.error === null && v && v.samples.count === 9 && a && a.samples.count === 3, `fragmented MP4 opens: 9 video and 3 audio samples (${v?.samples.count} ${a?.samples.count})`);
  if (v && a) {
    const dts = [0, 3000, 6000, 9000, 12000, 15000, 18000, 21000, 27000];
    const pts = dts.map((d, i) => d + (i < 5 ? cto1[i] : 0));
    check(arr(v.samples.dts).join() === dts.map((d) => units(d, 90000)).join() && arr(v.samples.pts).join() === pts.map((d) => units(d, 90000)).join(), 'fragments: dts from tfdt and durations, pts with signed trun offsets');
    check(arr(v.samples.key).join('') === '100001000', 'fragments: first-sample flags, per-sample flags and trex defaults');
    check(arr(v.samples.duration).join() === [3000, 3000, 3000, 3000, 3000, 3000, 3000, 6000, 3000].map((d) => units(d, 90000)).join(), 'fragments: default and per-sample durations');
    const vexp = [...sizes1.map((s, i) => fill(s, 300 + i)), ...durs2.map((_, i) => fill(40, 400 + i))];
    const vgot = await probe.readSamples(r, v, 0, 9);
    check(vgot.every((x, i) => same(x, vexp[i])), 'fragments: data offsets from the moof and from an explicit base');
    const agot = await probe.readSamples(r, a, 0, 3);
    check(agot.every((x, i) => same(x, fill(30, 500 + i))) && arr(a.samples.dts).join() === [0, 1024, 2048].map((d) => units(d, 48000)).join(),
      'fragments: a second traf continues after the first one\'s data');
  }
}

{
  // QuickTime PCM: sowt v1 (one PCM frame a "sample", stsz size 1), twos, lpcm v2 float, ipcm with pcmC; chunks become
  // pieces of at most a second.
  const qtV1 = (type, ch, bits, rate, ...kids) => box(type, zeros(6), be16(1), be16(1), be16(0), zeros(4), be16(ch), be16(bits), be16(0xfffe), be16(0), be32(rate * 65536),
    be32(1), be32(bits / 8), be32((bits / 8) * ch), be32(bits / 8), ...kids);
  const qtV2 = (type, ch, bits, rate, flags) => {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, rate);
    return box(type, zeros(6), be16(1), be16(2), be16(0), zeros(4), be16(3), be16(16), be16(0xfffe), be16(0), be32(0x10000),
      be32(72), new Uint8Array(dv.buffer), be32(ch), be32(0x7f000000), be32(bits), be32(flags), be32((bits / 8) * ch), be32(1));
  };
  const cases = [
    ['sowt v1', qtV1('sowt', 2, 16, 44100), 'pcm-s16', 4, 44100, 'qt  '],
    ['twos', sound('twos', 1, 16, 22050), 'pcm-s16be', 2, 22050, 'qt  '],
    ['lpcm v2 float', qtV2('lpcm', 2, 32, 96000, 1 | 2), 'pcm-f32be', 8, 96000, 'qt  '],
    ['ipcm 24-bit LE', sound('ipcm', 2, 24, 48000, full('pcmC', 0, 0, 1, 24)), 'pcm-s24', 6, 48000, 'isom'],
  ];
  for (const [label, entry, codec, bpf, rate, brand] of cases) {
    const chunkFrames = [Math.round(rate * 1.5), Math.round(rate * 0.3), Math.round(rate * 0.75)];
    const payload = flat(chunkFrames.map((n, i) => fill(n * bpf, 700 + i)));
    const bytes = mp4File(payload, (d) => {
      const offs = [d, d + chunkFrames[0] * bpf, d + (chunkFrames[0] + chunkFrames[1]) * bpf];
      const total = chunkFrames.reduce((x, y) => x + y, 0);
      return box('moov', mvhd(1000, 0, 2), trak({ id: 1, handler: 'soun', timescale: rate, entry,
        stts: [[total, 1]], sizes: { fixed: 1, count: total }, stsc: [[1, chunkFrames[0]], [2, chunkFrames[1]], [3, chunkFrames[2]]], offsets: offs }));
    }, brand);
    const r = reader(bytes);
    const src = await probe.open(r);
    const a = src.tracks[0];
    const total = chunkFrames.reduce((x, y) => x + y, 0);
    check(src.error === null && a && a.codec === codec && a.sampleRate === rate && src.container === (brand === 'qt  ' ? 'mov' : 'mp4'),
      `${label}: ${codec} at ${rate} Hz in ${brand === 'qt  ' ? 'mov' : 'mp4'} (${a?.codec} ${a?.sampleRate} ${src.container} ${JSON.stringify(src.error)})`);
    if (!a) continue;
    const s = a.samples;
    const frames = arr(s.size).map((x) => x / bpf);
    check(s.count === 4 && frames.every((x) => x <= rate) && frames.reduce((x, y) => x + y, 0) === total, `${label}: chunks cut into pieces of at most a second (${frames})`);
    check(arr(s.dts).every((x, i) => x === units(frames.slice(0, i).reduce((p, q) => p + q, 0), rate)) && s.duration[0] === units(frames[0], rate), `${label}: piece times`);
    const back = codecs.concat(await probe.readSamples(r, a, 0, s.count));
    check(same(back, payload), `${label}: the pieces cover the PCM bytes exactly`);
  }
}

{
  // Other sample entries: vp09/vpcC, av01/av1C, hev1, Opus/dOps, fLaC/dfLa, MP3 in MP4, and an unsupported codec.
  const one = (entry, handler = 'vide', ts = 30) => mp4File(fill(100, 1), (d) => box('moov', mvhd(1000, 0, 2),
    trak({ id: 1, handler, timescale: ts, entry, stts: [[1, handler === 'vide' ? 1 : 1024]], sizes: [100], stsc: [[1, 1]], offsets: [d] })));
  const open = async (b) => probe.open(reader(b));
  let s = await open(one(visual('vp09', 1920, 1080, full('vpcC', 1, 0, 0, 40, 0x82, 1, 1, 1, 0, 0))));
  check(s.tracks[0]?.codec === 'vp09.00.40.08' && s.tracks[0].description === null && s.tracks[0].colorSpace?.primaries === 'bt709', 'vp09 sample entry');
  s = await open(one(visual('av01', 1920, 1080, box('av1C', 0x81, 0x08, 0x0c, 0x00))));
  check(s.tracks[0]?.codec === 'av01.0.08M.08' && same(s.tracks[0].description, Uint8Array.of(0x81, 0x08, 0x0c, 0x00)), 'av01 sample entry');
  s = await open(one(visual('hev1', 3840, 2160, box('hvcC', hvcC))));
  check(s.tracks[0]?.codec === 'hev1.2.4.L153.90', 'hev1 sample entry');
  s = await open(one(sound('Opus', 2, 16, 48000, box('dOps', codecs.dOpsFromOpusHead(opusHead(120)))), 'soun', 48000));
  check(s.tracks[0]?.codec === 'opus' && codecs.parseOpusHead(s.tracks[0].description).preSkip === 120, 'Opus sample entry');
  const streaminfo = [0x80, 0, 0, 34, 0x10, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, ...be24((48000 << 4) | (1 << 1)), (15 << 4) | 0, 0, 0, 0x10, 0, ...zeros(16)];
  s = await open(one(sound('fLaC', 2, 16, 48000, full('dfLa', 0, 0, streaminfo)), 'soun', 48000));
  check(s.tracks[0]?.codec === 'flac' && codecs.ascii(s.tracks[0].description, 0, 4) === 'fLaC' && s.tracks[0].sampleRate === 48000 && s.tracks[0].channels === 2, `FLAC sample entry (${s.tracks[0]?.sampleRate} ${s.tracks[0]?.channels})`);
  s = await open(one(sound('mp4a', 2, 16, 44100, esds(0x6b, null)), 'soun', 44100));
  check(s.tracks[0]?.codec === 'mp3', 'MP3 in MP4');
  s = await open(one(sound('ac-3', 6, 16, 48000), 'soun', 48000));
  check(s.error?.code === 'unsupported' && /ac-3/.test(s.error.detail) && s.skipped.length === 1, `an AC-3 only file is unsupported, naming the codec (${JSON.stringify(s.error)})`);
  s = await open(flat([ftyp(), box('mdat', fill(5000, 1))]));
  check(s.error?.code === 'damaged' && /moov/.test(s.error.detail), 'an unfinished recording (no moov) is damaged');
  s = await open(flat([ftyp(), box('moov', mvhd(1000, 0, 1))]));
  check(s.error?.code === 'noTracks', 'a movie without tracks');
}

// ---- Matroska and WebM ----------------------------------------------------------------------------------------------

const MS = 254016000;
const E = {
  EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83,
  CodecID: 0x86, CodecPrivate: 0x63a2, DefaultDuration: 0x23e383, CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, Video: 0xe0, PixelWidth: 0xb0,
  PixelHeight: 0xba, DisplayWidth: 0x54b0, DisplayHeight: 0x54ba, DisplayUnit: 0x54b2, Colour: 0x55b0, Matrix: 0x55b1, Range: 0x55b9, Transfer: 0x55ba, Primaries: 0x55bb,
  Audio: 0xe1, Rate: 0xb5, Channels: 0x9f, BitDepth: 0x6264, ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7,
  CueClusterPosition: 0xf1, Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb, Void: 0xec,
};
function vsize(n) {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1) len++;
  const out = [];
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
const idBytes = (id) => { const out = []; let v = id; while (v > 0) { out.unshift(v & 255); v = Math.floor(v / 256); } return out; };
const el = (id, ...parts) => { const body = flat(parts); return flat([idBytes(id), vsize(body.length), body]); };
const elUnknown = (id, ...parts) => flat([idBytes(id), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], flat(parts)]);
const eu = (id, v) => { const b = []; let x = v; do { b.unshift(x & 255); x = Math.floor(x / 256); } while (x > 0); return el(id, b); };
const eu8 = (id, v) => el(id, be64(v));
const ef = (id, v) => { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v); return el(id, new Uint8Array(dv.buffer)); };
const es = (id, s) => el(id, text(s));
// A block body: track, relative time, flags, lacing ('xiph' | 'ebml' | 'fixed' | null), frames.
function blockBody(track, rel, flags, lacing, frames) {
  const head = [0x80 | track, ...be16(rel & 0xffff)];
  if (!lacing) return flat([head, flags, frames[0]]);
  const lace = { xiph: 1, ebml: 3, fixed: 2 }[lacing];
  const hdr = [frames.length - 1];
  if (lacing === 'xiph') for (const f of frames.slice(0, -1)) { let n = f.length; while (n >= 255) { hdr.push(255); n -= 255; } hdr.push(n); }
  if (lacing === 'ebml') {
    hdr.push(...vsize(frames[0].length));
    for (let i = 1; i < frames.length - 1; i++) {
      const diff = frames[i].length - frames[i - 1].length;
      if (Math.abs(diff) < 63) hdr.push(0x80 | (diff + 63));
      else { const raw = diff + 8191; hdr.push(0x40 | (raw >> 8), raw & 255); }
    }
  }
  return flat([head, flags | (lace << 1), hdr, frames]);
}
const simple = (track, rel, key, lacing, frames) => el(E.SimpleBlock, blockBody(track, rel, key ? 0x80 : 0, lacing, frames));
const group = (track, rel, lacing, frames, { ref = null, duration = null } = {}) => el(E.BlockGroup, el(E.Block, blockBody(track, rel, 0, lacing, frames)),
  ref != null ? el(E.ReferenceBlock, be16(ref & 0xffff)) : null, duration != null ? eu(E.BlockDuration, duration) : null);
const ebmlHeader = (doc) => el(E.EBML, eu(0x4286, 1), eu(0x42f7, 1), eu(0x42f2, 4), eu(0x42f3, 8), es(E.DocType, doc), eu(0x4287, 4), eu(0x4285, 2));
const trackEntry = (n, type, codec, ...rest) => el(E.TrackEntry, eu(E.TrackNumber, n), eu(0x73c5, n), eu(E.TrackType, type), es(E.CodecID, codec), ...rest);
const audioEl = (rate, ch, bits) => el(E.Audio, ef(E.Rate, rate), eu(E.Channels, ch), bits ? eu(E.BitDepth, bits) : null);

// WebM: VP9 (CodecPrivate features, Colour) + Opus (CodecDelay), Xiph/EBML/fixed lacing, a BlockGroup with
// ReferenceBlock, SeekHead -> Cues at the end.
function webm1({ corruptCluster2 = false } = {}) {
  const v = (i, n) => fill(n, 900 + i);
  const vframes = [];
  const aframes = [];
  const V = (rel, key, i, n, extra = null) => { const f = i === 0 ? flat([vp9Key(0, false, 1280, 720), v(i, n)]) : v(i, n); vframes.push(f); return extra ? extra(f) : simple(1, rel, key, null, [f]); };
  const A = (sizes, base) => { const fs = sizes.map((s, k) => fill(s, base + k)); aframes.push(...fs); return fs; };
  const c1 = el(E.Cluster, eu(E.Timestamp, 0), V(0, true, 0, 200), simple(2, 0, true, 'xiph', A([100, 300, 50], 10)), V(33, false, 1, 120),
    V(67, false, 2, 130, (f) => group(1, 67, null, [f], { ref: -33, duration: 33 })));
  const c2body = [eu(E.Timestamp, 100), V(0, true, 3, 210), simple(2, 0, true, 'ebml', A([200, 210, 190, 205], 20)), V(33, false, 4, 90)];
  let c2 = el(E.Cluster, ...c2body);
  if (corruptCluster2) c2 = flat([[0x00, 0x00, 0x00, 0x00], c2.subarray(4)]);
  const c3 = el(E.Cluster, eu(E.Timestamp, 200), group(2, 0, 'fixed', A([120, 120, 120], 30), { duration: 60 }), V(0, true, 5, 150));
  const info = el(E.Info, eu(E.TimestampScale, 1000000), ef(E.Duration, 260));
  const tracks = el(E.Tracks,
    trackEntry(1, 1, 'V_VP9', el(E.CodecPrivate, [1, 1, 0, 2, 1, 31, 3, 1, 8]),
      el(E.Video, eu(E.PixelWidth, 1280), eu(E.PixelHeight, 720), el(E.Colour, eu(E.Matrix, 1), eu(E.Range, 1), eu(E.Transfer, 1), eu(E.Primaries, 1)))),
    trackEntry(2, 2, 'A_OPUS', el(E.CodecPrivate, opusHead(312)), eu(E.CodecDelay, 6500000), eu(E.SeekPreRoll, 80000000), audioEl(48000, 2)));
  const seek = (cuesAt) => el(E.SeekHead, el(E.Seek, el(E.SeekID, idBytes(E.Cues)), eu8(E.SeekPosition, cuesAt)));
  const s0 = seek(0).length;
  const c1at = s0 + info.length + tracks.length;
  const c2at = c1at + c1.length;
  const c3at = c2at + c2.length;
  const cuesAt = c3at + c3.length;
  const cue = (t, at) => el(E.CuePoint, eu(E.CueTime, t), el(E.CueTrackPositions, eu(E.CueTrack, 1), eu(E.CueClusterPosition, at)));
  const cues = el(E.Cues, cue(0, c1at), cue(100, c2at), cue(200, c3at));
  const bytes = flat([ebmlHeader('webm'), el(E.Segment, seek(cuesAt), info, tracks, c1, c2, c3, cues)]);
  return { bytes, vframes, aframes };
}

{
  const { bytes, vframes, aframes } = webm1();
  const r = reader(bytes);
  const src = await probe.open(r);
  const [v, a] = src.tracks;
  check(src.error === null && src.container === 'webm' && v?.kind === 'video' && a?.kind === 'audio', `WebM opens (${JSON.stringify(src.error)})`);
  check(v.codec === 'vp09.00.31.08' && v.description === null && v.width === 1280 && v.height === 720 && eq(v.colorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }),
    `VP9 track: codec from CodecPrivate features, size, Colour (${v.codec})`);
  check(arr(v.samples.pts).join() === [0, 33, 67, 100, 133, 200].map((x) => x * MS).join() && arr(v.samples.dts).join() === arr(v.samples.pts).join(), 'VP9 times from cluster and block timestamps');
  check(arr(v.samples.key).join('') === '100101', 'key frames from SimpleBlock flags and ReferenceBlock');
  check(arr(v.samples.duration).join() === [33, 34, 33, 33, 67, 67].map((x) => x * MS).join() && v.vfr === true && eq(v.frameRate, [30, 1]), `video durations and nominal rate (${arr(v.samples.duration).map((x) => x / MS)} ${v.frameRate})`);
  const vb = await probe.readSamples(r, v, 0, v.samples.count);
  check(vb.length === vframes.length && vb.every((x, i) => same(x, vframes[i])), 'VP9 frames read back');
  const delay = 6.5 * MS;
  const apts = [0, 100 / 3, 200 / 3, 100, 125, 150, 175, 200, 220, 240].map((x) => Math.round(x * MS) - delay);
  check(a.codec === 'opus' && same(a.description, opusHead(312)) && a.sampleRate === 48000 && a.channels === 2 && a.samples.count === 10, `Opus track (${a.samples.count})`);
  check(arr(a.samples.pts).join() === apts.join(), `laced frames spread to the next block or by BlockDuration, CodecDelay subtracted (${arr(a.samples.pts).map((x) => (x + delay) / MS)})`);
  check(a.samples.duration[9] === 20 * MS && a.samples.duration[0] === apts[1] - apts[0], 'audio durations, the last from BlockDuration');
  const ab = await probe.readSamples(r, a, 0, a.samples.count);
  check(ab.every((x, i) => same(x, aframes[i])), 'Xiph, EBML and fixed laced frames read back');
  check(src.duration === 260 * MS, `duration: Info Duration when it is not longer than the blocks (${src.duration / MS})`);
  check(a.preRoll === 80 * MS && probe.keyBefore(a, 9) <= 6, 'Opus SeekPreRoll steps decoding back');

  const bad = webm1({ corruptCluster2: true });
  const s2 = await probe.open(reader(bad.bytes));
  check(s2.error === null && s2.damaged === true && arr(s2.tracks[0].samples.pts).join() === [0, 33, 67, 200].map((x) => x * MS).join(),
    `a broken Cluster is skipped to the next one from Cues (${s2.tracks[0] && arr(s2.tracks[0].samples.pts).map((x) => x / MS)})`);
}

// MediaRecorder style: Segment and Clusters of unknown size, no Cues, no Duration, VP9 without CodecPrivate.
function webm2({ corrupt = false } = {}) {
  const frames = [];
  const clusters = [];
  for (let c = 0; c < 3; c++) {
    const parts = [eu(E.Timestamp, c * 1000)];
    for (let i = 0; i < 30; i++) {
      const f = i === 0 ? flat([vp9Key(2, true, 640, 480), fill(300, c * 100 + i)]) : fill(100 + i, c * 100 + i);
      frames.push({ c, f, t: c * 1000 + Math.round(i * 1000 / 30) });
      parts.push(simple(1, Math.round(i * 1000 / 30), i === 0, null, [f]));
      if (i % 3 === 0) parts.push(simple(2, Math.round(i * 1000 / 30), true, null, [fill(60, 5000 + c * 100 + i)]));
    }
    let cl = elUnknown(E.Cluster, ...parts);
    if (corrupt && c === 1) {
      cl = cl.slice();
      const at = 12 + parts[0].length + parts[1].length + parts[2].length;
      cl.fill(0, at, at + 3);
    }
    clusters.push(cl);
  }
  const tracks = el(E.Tracks, trackEntry(1, 1, 'V_VP9', el(E.Video, eu(E.PixelWidth, 640), eu(E.PixelHeight, 480))),
    trackEntry(2, 2, 'A_OPUS', el(E.CodecPrivate, opusHead(312)), audioEl(48000, 1)));
  return { bytes: flat([ebmlHeader('webm'), elUnknown(E.Segment, el(E.Info, eu(E.TimestampScale, 1000000), es(0x4d80, 'Chrome')), tracks, ...clusters)]), frames };
}

{
  const { bytes, frames } = webm2();
  const src = await probe.open(reader(bytes));
  const [v, a] = src.tracks;
  check(src.error === null && v?.samples.count === 90 && a?.samples.count === 30, `unknown-size Segment and Clusters (${v?.samples.count} ${a?.samples.count})`);
  check(/^vp09\.02\.\d\d\.10$/.test(v.codec) && v.bitDepth === 10, `VP9 profile and bit depth from the first key frame (${v.codec})`);
  check(v.vfr === false && eq(v.frameRate, [30, 1]), `millisecond timestamps of a steady 30 fps (33, 33, 34 ms) are not VFR (${v.vfr} ${v.frameRate})`);
  check(arr(v.samples.pts).join() === frames.map((x) => x.t * MS).join() && v.samples.key[30] === 1 && v.samples.key[31] === 0, 'times across unknown-size clusters');
  check(src.duration === v.samples.pts[89] + v.samples.duration[89], 'duration measured from the blocks when Info has none');
  const vb = await probe.readSamples(reader(bytes), v, 0, 90);
  check(vb.every((x, i) => same(x, frames[i].f)), 'frames of unknown-size clusters read back');
  const bad = await probe.open(reader(webm2({ corrupt: true }).bytes));
  const bv = bad.tracks[0];
  check(bad.error === null && bad.damaged && bv.samples.count >= 60 && bv.samples.count < 90 && bv.samples.pts[bv.samples.count - 1] === frames[89].t * MS,
    `damage without Cues: the walk finds the next Cluster by its ID (${bv?.samples.count})`);
}

{
  // Matroska: AVC with B-frames (decode times = sorted presentation times), AAC with header stripping, 16-bit PCM.
  const ascTrack = el(E.ContentEncodings, el(E.ContentEncoding, el(E.ContentCompression, eu(E.ContentCompAlgo, 3), el(E.ContentCompSettings, [0xaa, 0xbb]))));
  const tracks = el(E.Tracks,
    trackEntry(1, 1, 'V_MPEG4/ISO/AVC', el(E.CodecPrivate, avcC), eu(E.DefaultDuration, 33000000), el(E.Video, eu(E.PixelWidth, 1920), eu(E.PixelHeight, 1080), eu(E.DisplayWidth, 16), eu(E.DisplayHeight, 9), eu(E.DisplayUnit, 3))),
    trackEntry(2, 2, 'A_AAC', el(E.CodecPrivate, ASC), ascTrack, audioEl(48000, 2)),
    trackEntry(3, 2, 'A_PCM/INT/LIT', audioEl(48000, 2, 16)),
    trackEntry(4, 17, 'S_TEXT/UTF8'));
  const vf = [0, 1, 2, 3].map((i) => fill(500 + i, 40 + i));
  const af = fill(300, 60);
  const pf = [fill(4800, 70), fill(4800, 71)];
  const cluster = el(E.Cluster, eu(E.Timestamp, 0), simple(1, 0, true, null, [vf[0]]), simple(2, 0, true, null, [af]), simple(3, 0, true, null, [pf[0]]),
    simple(1, 100, false, null, [vf[1]]), simple(1, 33, false, null, [vf[2]]), simple(3, 25, true, null, [pf[1]]), simple(1, 67, false, null, [vf[3]]), simple(4, 0, true, null, [text('hi')]));
  const bytes = flat([ebmlHeader('matroska'), el(E.Segment, el(E.Info, eu(E.TimestampScale, 1000000)), tracks, cluster)]);
  const r = reader(bytes);
  const src = await probe.open(r);
  const [v, a, p] = src.tracks;
  check(src.error === null && src.container === 'mkv' && src.tracks.length === 3, `Matroska with AVC, AAC, PCM (and a subtitle track left out) (${src.tracks.length})`);
  check(v.codec === 'avc1.640028' && same(v.description, avcC) && v.displayWidth === 1920 && v.displayHeight === 1080 && v.colorSpace?.transfer === 'bt709', 'AVC track: avcC, display aspect, color from the SPS');
  check(arr(v.samples.pts).join() === [0, 100, 33, 67].map((x) => x * MS).join() && arr(v.samples.dts).join() === [0, 33, 67, 100].map((x) => x * MS).join() && arr(v.samples.order).join() === '0,2,3,1',
    'B-frames: decode times are the sorted presentation times');
  check(v.samples.duration[1] === 33 * MS && v.samples.duration[3] === 33 * MS && v.samples.duration[2] === 34 * MS, 'the last frame lasts DefaultDuration');
  check(a.codec === 'mp4a.40.2' && same(await probe.readSample(r, a, 0), flat([[0xaa, 0xbb], af])) && same((await probe.readSamples(r, a, 0, 1))[0], flat([[0xaa, 0xbb], af])), 'header stripping: the stripped bytes are put back');
  check(p.codec === 'pcm-s16' && p.samples.count === 2 && p.samples.duration[0] === sec(0.025) && p.samples.pts[1] === 25 * MS, 'PCM durations from the block sizes');
  check(probe.keyBefore(v, 3) === 0, 'keyBefore on Matroska video');
}

{
  // Every Matroska codec ID of the contract, one block each, and one Cut cannot decode.
  const streaminfo = flat([text('fLaC'), [0x80, 0, 0, 34, 0x10, 0, 0x10, 0, 0, 0, 0, 0, 0, 0], be24((44100 << 4) | (1 << 1)), [(15 << 4) | 0, 0, 0, 0x10, 0], zeros(16)]);
  const list = [
    [1, 'V_VP8', null, 'vp8'],
    [1, 'V_AV1', Uint8Array.of(0x81, 0x08, 0x0c, 0x00), 'av01.0.08M.08'],
    [1, 'V_MPEGH/ISO/HEVC', hvcC, 'hvc1.2.4.L153.90'],
    [2, 'A_VORBIS', Uint8Array.of(2, 30, 10, 1, 2, 3), 'vorbis'],
    [2, 'A_FLAC', streaminfo, 'flac'],
    [2, 'A_MPEG/L3', null, 'mp3'],
    [2, 'A_PCM/FLOAT/IEEE', null, 'pcm-f32'],
    [2, 'A_PCM/INT/BIG', null, 'pcm-s24be'],
    [2, 'A_AAC/MPEG4/LC', null, 'mp4a.40.2'],
    [2, 'A_AC3', null, null],
  ];
  const tracks = el(E.Tracks, list.map(([type, id, priv], i) => trackEntry(i + 1, type, id, priv ? el(E.CodecPrivate, priv) : null,
    type === 1 ? el(E.Video, eu(E.PixelWidth, 320), eu(E.PixelHeight, 240)) : audioEl(44100, 2, id === 'A_PCM/FLOAT/IEEE' ? 32 : 24))));
  const cluster = el(E.Cluster, eu(E.Timestamp, 0), list.map((_, i) => simple(i + 1, 0, true, null, [fill(48, i)])));
  const src = await probe.open(reader(flat([ebmlHeader('matroska'), el(E.Segment, el(E.Info, eu(E.TimestampScale, 1000000)), tracks, cluster)])));
  const got = Object.fromEntries(src.tracks.map((t) => [t.id, t.codec]));
  const wrong = list.map(([, id, , codec], i) => (codec && got[i + 1] !== codec ? `${id} -> ${got[i + 1]}` : null)).filter(Boolean);
  check(!wrong.length && src.tracks.length === 9, `Matroska codec IDs to codec strings (${wrong.join(', ')})`);
  const flac = src.tracks.find((t) => t.codec === 'flac');
  const aac = src.tracks.find((t) => t.codec === 'mp4a.40.2');
  check(flac.sampleRate === 44100 && flac.channels === 2 && same(flac.description, streaminfo) && same(aac.description, Uint8Array.of(0x12, 0x10)), 'FLAC from STREAMINFO; AAC without CodecPrivate gets a built AudioSpecificConfig');
  check(src.skipped.length === 1 && src.skipped[0].codec === 'A_AC3', 'an AC-3 track is listed as skipped');
}

// ---- MP3, WAV, ADTS ------------------------------------------------------------------------------------------------------

function mp3Frame(i, { kbps = 128, rate = 44100, pad = 0, mono = false, version = 1 } = {}) {
  const brs = version === 1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const base = version === 1 ? [44100, 48000, 32000] : [22050, 24000, 16000];
  const size = Math.floor(((version === 1 ? 144 : 72) * kbps * 1000) / rate) + pad;
  const b = fill(size, i);
  b[0] = 0xff;
  b[1] = version === 1 ? 0xfb : 0xf3;
  b[2] = (brs.indexOf(kbps) << 4) | (base.indexOf(rate) << 2) | (pad << 1);
  b[3] = mono ? 0xc0 : 0x00;
  for (let k = 4; k < size; k++) if (b[k] === 0xff) b[k] = 0xfe;
  return b;
}
function id3(n) { const b = new Uint8Array(10 + n); b.set(text('ID3'), 0); b[3] = 4; b[6] = (n >> 21) & 127; b[7] = (n >> 14) & 127; b[8] = (n >> 7) & 127; b[9] = n & 127; return b; }

{
  const xing = mp3Frame(0);
  xing.fill(0, 4);
  xing.set([...text('Info'), 0, 0, 0, 15, ...be32(151), ...be32(0)], 36);
  xing.set(text('LAME3.100'), 36 + 120);
  xing.set([(576 >> 4) & 255, ((576 & 15) << 4) | (1000 >> 8), 1000 & 255], 36 + 120 + 21);
  const frames = [];
  for (let i = 0; i < 100; i++) frames.push(mp3Frame(i + 1, { pad: i % 3 === 0 ? 1 : 0 }));
  const junk = fill(37, 77);
  junk[3] = 0xff; junk[4] = 0xfb;
  for (let i = 0; i < 50; i++) frames.push(mp3Frame(200 + i, { pad: 0 }));
  const tagV1 = flat([text('TAG'), zeros(125)]);
  const bytes = flat([id3(1000), xing, frames.slice(0, 100), junk, frames.slice(100), tagV1]);
  const r = reader(bytes);
  const src = await probe.open(r);
  const t = src.tracks[0];
  check(src.error === null && src.container === 'mp3' && t?.codec === 'mp3' && t.sampleRate === 44100 && t.channels === 2, `MP3 after an ID3v2 tag (${JSON.stringify(src.error)} ${t?.codec})`);
  check(t.samples.count === 150, `the Info frame is left out, frames on both sides of a damaged stretch are kept (${t.samples.count})`);
  const got = await probe.readSamples(r, t, 0, t.samples.count);
  check(got.every((x, i) => same(x, frames[i])), 'MP3 frames: offsets and sizes (with padding)');
  const skip = 576 + 529;
  check(arr(t.samples.pts).every((x, i) => x === units(i * 1152 - skip, 44100)) && t.samples.duration[0] === units(1152, 44100), 'MP3 times with the LAME encoder delay taken off');
  check(t.duration === units(150 * 1152 - skip - 1000, 44100) && src.duration === t.duration, 'MP3 duration without delay and padding');

  const vbri = mp3Frame(0);
  vbri.fill(0, 4);
  vbri.set([...text('VBRI'), 0, 1, 0, 0, 0, 50, ...be32(20000), ...be32(40)], 36);
  const v2 = flat([vbri, Array.from({ length: 40 }, (_, i) => mp3Frame(i + 1, { version: 2, rate: 22050, kbps: 64, mono: true }))]);
  const s2 = await probe.open(reader(v2));
  check(s2.error?.code !== undefined || (s2.tracks[0]?.samples.count >= 39), 'MPEG-2 mono after a VBRI frame of another version');
  const m2 = flat(Array.from({ length: 40 }, (_, i) => mp3Frame(i + 1, { version: 2, rate: 22050, kbps: 64, mono: true })));
  const s3 = await probe.open(reader(m2));
  check(s3.tracks[0]?.samples.count === 40 && s3.tracks[0].sampleRate === 22050 && s3.tracks[0].channels === 1 && s3.tracks[0].samples.duration[0] === units(576, 22050), 'MPEG-2 layer III: 576 samples a frame, mono');
  const vb1 = flat([(() => { const f = mp3Frame(0); f.fill(0, 4); f.set([...text('VBRI'), 0, 1, 0, 0, 0, 50, ...be32(20000), ...be32(40)], 36); return f; })(), frames.slice(0, 40)]);
  const s4 = await probe.open(reader(vb1));
  check(s4.tracks[0]?.samples.count === 40 && s4.tracks[0].samples.pts[0] === 0, 'a VBRI frame is left out, without a delay');
  check(audioread.mp3Header(Uint8Array.of(0xff, 0xfb, 0xf0, 0), 0) === null && audioread.mp3Header(Uint8Array.of(0xff, 0xfd, 0x90, 0), 0) === null, 'bad bitrate and layer II headers are refused');
}

function wav({ riff = 'RIFF', tag = 1, ch = 2, rate = 48000, bits = 16, frames = 120000, ext = false, list = false, rf64 = false }) {
  const align = ch * (bits / 8);
  const data = fill(frames * align, 3);
  const fmt = ext
    ? flat([le16(0xfffe), le16(ch), le32(rate), le32(rate * align), le16(align), le16(bits), le16(22), le16(bits), le32(3), le16(tag), [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]])
    : flat([le16(tag), le16(ch), le32(rate), le32(rate * align), le16(align), le16(bits)]);
  const chunk = (id, b, size = b.length) => flat([text(id), le32(size), b, b.length & 1 ? 0 : []]);
  const parts = [];
  if (rf64) parts.push(chunk('ds64', flat([le64(0), le64(data.length), le64(frames), le32(0)])));
  parts.push(chunk('fmt ', fmt));
  if (list) parts.push(chunk('LIST', fill(13, 1)));
  parts.push(chunk('data', data, rf64 ? 0xffffffff : data.length));
  const body = flat(parts);
  return { bytes: flat([text(riff), le32(rf64 ? 0xffffffff : body.length + 4), text('WAVE'), body]), data, align };
}

{
  for (const [label, opts, codec] of [
    ['16-bit stereo', {}, 'pcm-s16'],
    ['24-bit mono after an odd chunk', { ch: 1, bits: 24, rate: 44100, frames: 50000, list: true }, 'pcm-s24'],
    ['32-bit int', { bits: 32, frames: 1000 }, 'pcm-s32'],
    ['8-bit', { bits: 8, ch: 1, frames: 8000, rate: 8000 }, 'pcm-u8'],
    ['float extensible', { tag: 3, bits: 32, ext: true, frames: 96000 }, 'pcm-f32'],
    ['RF64', { riff: 'RF64', rf64: true, frames: 70000 }, 'pcm-s16'],
  ]) {
    const { bytes, data, align } = wav(opts);
    const r = reader(bytes);
    const src = await probe.open(r);
    const t = src.tracks[0];
    const rate = opts.rate || 48000;
    const frames = opts.frames || 120000;
    check(src.error === null && src.container === 'wav' && t?.codec === codec && t.sampleRate === rate && t.channels === (opts.ch || 2), `WAV ${label}: ${codec} (${t?.codec} ${JSON.stringify(src.error)})`);
    if (!t) continue;
    const back = codecs.concat(await probe.readSamples(r, t, 0, t.samples.count));
    check(same(back, data) && arr(t.samples.size).every((s) => s % align === 0 && s / align <= rate), `WAV ${label}: pieces of at most a second cover the data chunk`);
    check(t.duration === units(frames, rate) && arr(t.samples.pts).every((x, i) => x === units(arr(t.samples.size).slice(0, i).reduce((p, q) => p + q, 0) / align, rate)), `WAV ${label}: times`);
  }
  const { bytes } = wav({ frames: 4 });
  const t = (await probe.open(reader(bytes))).tracks[0];
  const pcm = codecs.pcmToFloat(await probe.readSample(reader(bytes), t, 0), t.codec, t.channels);
  const d = new DataView(bytes.buffer, bytes.byteOffset + 44);
  check(pcm[0][0] === d.getInt16(0, true) / 32768 && pcm[1][3] === d.getInt16(14, true) / 32768, 'WAV samples decode with pcmToFloat');
  const mu = wav({ tag: 7, bits: 8 });
  check((await probe.open(reader(mu.bytes))).error?.code === 'unsupported', 'mu-law WAV is unsupported');
}

function adtsFrame(i, { crc = false, rateIndex = 3, ch = 2, payload = 200 + (i % 50) } = {}) {
  const hdr = crc ? 9 : 7;
  const len = hdr + payload;
  const b = new Uint8Array(len);
  b.set([0xff, crc ? 0xf0 : 0xf1, (1 << 6) | (rateIndex << 2) | (ch >> 2), ((ch & 3) << 6) | (len >> 11), (len >> 3) & 255, ((len & 7) << 5) | 0x1f, 0xfc]);
  const p = fill(payload, i);
  for (let k = 0; k < p.length; k++) if (p[k] === 0xff) p[k] = 0x7f;
  b.set(p, hdr);
  return { b, p };
}

{
  for (const crc of [false, true]) {
    const frames = Array.from({ length: 60 }, (_, i) => adtsFrame(i, { crc }));
    const bytes = flat([crc ? id3(20) : [], frames.map((f) => f.b)]);
    const r = reader(bytes);
    const src = await probe.open(r);
    const t = src.tracks[0];
    check(src.error === null && src.container === 'aac' && t?.codec === 'mp4a.40.2' && same(t.description, ASC) && t.sampleRate === 48000 && t.channels === 2,
      `ADTS${crc ? ' with CRC after ID3' : ''}: AAC-LC 48 kHz with a built AudioSpecificConfig (${t?.codec} ${JSON.stringify(src.error)})`);
    const got = await probe.readSamples(r, t, 0, t.samples.count);
    check(t.samples.count === 60 && got.every((x, i) => same(x, frames[i].p)) && t.samples.pts[59] === units(59 * 1024, 48000), `ADTS${crc ? ' with CRC' : ''}: headers stripped, 1024 samples a frame`);
  }
}

// ---- images and sniffing ------------------------------------------------------------------------------------------------

{
  const png = flat([[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), text('IHDR'), be32(640), be32(360), [8, 6, 0, 0, 0], zeros(20)]);
  const jpeg = flat([[0xff, 0xd8, 0xff, 0xe0], be16(16), text('JFIF'), zeros(10), [0xff, 0xe1], be16(5000), zeros(4998), [0xff, 0xc0], be16(17), 8, be16(1080), be16(1920), 3, zeros(9), [0xff, 0xd9]]);
  const gif = flat([text('GIF89a'), le16(320), le16(200), zeros(10)]);
  const bmp = flat([text('BM'), le32(100), zeros(4), le32(54), le32(40), le32(800), le32(-600 >>> 0), zeros(30)]);
  const webp = flat([text('RIFF'), le32(30), text('WEBP'), text('VP8X'), le32(10), zeros(4), [0x7f, 0x07, 0, 0x37, 0x04, 0], zeros(10)]);
  const avif = flat([box('ftyp', text('avif'), be32(0), text('avif'), text('mif1')), zeros(20)]);
  for (const [b, mime, w, h] of [[png, 'image/png', 640, 360], [jpeg, 'image/jpeg', 1920, 1080], [gif, 'image/gif', 320, 200], [bmp, 'image/bmp', 800, 600], [webp, 'image/webp', 1920, 1080], [avif, 'image/avif', 0, 0]]) {
    const s = await probe.open(reader(b));
    check(s.container === 'image' && s.error === null && s.tracks.length === 0 && s.image?.mime === mime && s.image.width === w && s.image.height === h, `${mime} (${JSON.stringify(s.image)})`);
  }
  const heic = await probe.open(reader(flat([box('ftyp', text('heic'), be32(0), text('mif1'), text('heic')), box('meta', zeros(30))])));
  check(heic.error?.code === 'unsupported' && /HEIF/.test(heic.error.detail), 'HEIC stills are unsupported, not damaged');
  const random = fill(10000, 5);
  check((await probe.open(reader(random))).error?.code === 'unsupported', 'random bytes are unsupported');
  check((await probe.open(reader(new Uint8Array(0)))).error?.code === 'damaged', 'an empty file is damaged');
  const throwing = { size: 1000, read: async () => { throw new Error('EIO'); } };
  check((await probe.open(throwing)).error?.code === 'damaged', 'a failing reader gives an error value');
  const ipcError = { size: 1000, read: async () => ({ error: 'ENOENT' }) };
  const ie = await probe.open(ipcError);
  check(ie.error?.code === 'damaged' && /ENOENT/.test(ie.error.detail), 'an IPC error object from the reader is reported');
}

// ---- damage: truncated and corrupted copies of every fixture --------------------------------------------------------------

{
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const fixtures = [
    ['mp4', (await writeFile({ video: videoPlan(60), audio: audioPlan(90), vcfg: { codec: 'avc1.640028', width: 64, height: 64, description: avcC, frameRate: FPS }, acfg: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 } })).bytes],
    ['webm', webm1().bytes],
    ['webm-live', webm2().bytes],
    ['mp3', flat([id3(100), Array.from({ length: 80 }, (_, i) => mp3Frame(i))])],
    ['wav', wav({ frames: 30000 }).bytes],
    ['adts', flat(Array.from({ length: 80 }, (_, i) => adtsFrame(i).b))],
  ];
  const codesOk = new Set(['unsupported', 'damaged', 'hdr', 'noTracks']);
  const problems = [];
  let runs = 0;
  const started = performance.now();
  for (const [name, bytes] of fixtures) {
    const variants = [];
    for (let k = 0; k < 40; k++) variants.push([`cut at ${Math.floor((bytes.length * k) / 40)}`, bytes.slice(0, Math.floor((bytes.length * k) / 40))]);
    for (let k = 0; k < 25; k++) variants.push([`cut at random`, bytes.slice(0, Math.floor(rand() * bytes.length))]);
    for (let k = 0; k < 60; k++) {
      const b = bytes.slice();
      const n = 1 + Math.floor(rand() * 16);
      const at = Math.floor(rand() * b.length);
      for (let j = 0; j < n; j++) b[Math.min(b.length - 1, at + Math.floor(rand() * 64))] = Math.floor(rand() * 256);
      variants.push([`corrupt near ${at}`, b]);
    }
    for (let k = 0; k < 10; k++) {
      const b = bytes.slice();
      const at = Math.floor(rand() * (b.length - 8));
      b.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], at);
      variants.push([`huge size near ${at}`, b]);
    }
    for (const [what, b] of variants) {
      runs++;
      let s;
      try {
        s = await withTimeout(probe.open(reader(b)), 5000);
      } catch (err) {
        problems.push(`${name} ${what}: ${err.message}`);
        continue;
      }
      if (!s || typeof s !== 'object' || !Array.isArray(s.tracks)) { problems.push(`${name} ${what}: not a Source`); continue; }
      if (s.error && !codesOk.has(s.error.code)) problems.push(`${name} ${what}: code ${s.error.code}`);
      if (!s.error && !s.tracks.length) problems.push(`${name} ${what}: no tracks and no error`);
      for (const t of s.tracks) {
        const x = t.samples;
        const lens = ['offset', 'size', 'dts', 'pts', 'duration', 'key', 'order'].every((k) => x[k].length === x.count);
        let fine = lens && x.count > 0 && Number.isFinite(t.duration);
        for (let i = 0; fine && i < x.count; i++) {
          if (!(x.offset[i] + x.size[i] <= b.length) || !Number.isFinite(x.pts[i]) || !Number.isFinite(x.dts[i]) || !(x.duration[i] >= 0)) fine = false;
          if (i && x.pts[x.order[i]] < x.pts[x.order[i - 1]]) fine = false;
        }
        if (!fine) { problems.push(`${name} ${what}: a bad table on track ${t.id}`); continue; }
        try {
          await probe.readSample(reader(b), t, 0);
          await probe.readSamples(reader(b), t, 0, x.count);
          probe.keyBefore(t, x.count - 1);
          probe.sampleAtTime(t, t.duration / 2);
        } catch (err) {
          problems.push(`${name} ${what}: reading samples: ${err.message}`);
        }
      }
    }
  }
  const ms = Math.round(performance.now() - started);
  check(!problems.length, `${runs} truncated and damaged files come back as values with usable tables (${problems.slice(0, 4).join(' | ')})`);
  check(ms < 60000, `the damaged files took ${ms} ms`);
}

// ---- performance -----------------------------------------------------------------------------------------------------

{
  // Two hours: 216,000 frames at 30 fps with B-frames, 337,500 AAC frames; tiny samples so the table is the work.
  const F = time.frameTicks([30, 1]);
  const sink = memSink();
  const w = mp4write.create({ video: { codec: 'avc1.640028', width: 1920, height: 1080, description: avcC, frameRate: [30, 1] }, audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 }, sink });
  const vData = Uint8Array.of(1, 2, 3);
  const aData = Uint8Array.of(4, 5);
  const N = 216000;
  const M = 337500;
  const reorder = [0, 3, 1, 2];
  let ai = 0;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    const g = k - (k % 4);
    const frame = g + reorder[k % 4];
    const pts = frame * F;
    const dts = (k - 1) * F;
    while (ai < M && ai * AAC <= dts) { w.addAudio({ data: aData, timestamp: ai * AAC, duration: AAC }); ai++; }
    w.addVideo({ data: vData, timestamp: pts, duration: F, key: k % 60 === 0, compositionOffset: pts - dts });
  }
  while (ai < M) { w.addAudio({ data: aData, timestamp: ai * AAC, duration: AAC }); ai++; }
  await w.finish();
  const writeMs = Math.round(performance.now() - t0);
  const bytes = sink.bytes();
  const r = reader(bytes);
  const t1 = performance.now();
  const src = await probe.open(r);
  const readMs = Math.round(performance.now() - t1);
  const [v, a] = src.tracks;
  check(v?.samples.count === N && a?.samples.count === M && Math.abs(src.duration - sec(7200)) < sec(0.1), `two hours indexed: ${v?.samples.count} frames, ${a?.samples.count} audio frames (${src.duration / TICKS} s)`);
  console.log(`two hours: indexed in ${readMs} ms, written in ${writeMs} ms`);
  check(readMs < 600, `indexing a two-hour, two-track MP4 takes ${readMs} ms (writing it took ${writeMs} ms)`);
  check(writeMs < 5000, `writing two hours of samples takes ${writeMs} ms`);
  const t2 = performance.now();
  let okLookups = true;
  for (let i = 0; i < 20000; i++) {
    const frame = Math.floor((i * 7919) % N);
    const s = probe.sampleAtTime(v, frame * F + 1);
    if (v.samples.pts[s] !== frame * F) { okLookups = false; break; }
    const k = probe.keyBefore(v, s);
    if (!v.samples.key[k]) { okLookups = false; break; }
  }
  const lookMs = Math.round(performance.now() - t2);
  check(okLookups && lookMs < 200, `20,000 sampleAtTime + keyBefore lookups on two hours take ${lookMs} ms`);
}

{
  // Open GOP: pictures after a key frame in decode order but shown before it need the GOP before.
  const t = codecs.newTable(8);
  const pts = [0, 3, 1, 2, 6, 4, 5, 7];
  const key = [1, 0, 0, 0, 1, 0, 0, 0];
  for (let i = 0; i < 8; i++) { t.pts[i] = pts[i]; t.dts[i] = i - 1; t.key[i] = key[i]; t.duration[i] = 1; t.size[i] = 1; t.offset[i] = i; }
  const track = codecs.finishTrack({ kind: 'video', samples: t });
  check(probe.keyBefore(track, 5) === 0 && probe.keyBefore(track, 6) === 0 && probe.keyBefore(track, 4) === 4 && probe.keyBefore(track, 7) === 4 && probe.keyBefore(track, 2) === 0,
    'keyBefore: leading pictures of an open GOP decode from the GOP before');
  check(probe.sampleAtTime(track, 4.5) === 5 && probe.sampleAtTime(track, 6) === 4, 'sampleAtTime over reordered pictures');
  check(probe.sampleAtTime({ samples: codecs.newTable(0) }, 0) === -1 && probe.keyBefore({ samples: codecs.newTable(0) }, 0) === -1, 'lookups on an empty table');
}

{
  // In the page: the scripts load in index.js order as plain scripts after Monaco's AMD loader, which makes `require`
  // a global function there. Each must still find the others on globalThis.Cut, and the readers must work.
  const fs = await import('fs');
  const vm = await import('vm');
  const loader = new URL('../node_modules/monaco-editor/min/vs/loader.js', import.meta.url);
  const page = { console, setTimeout, clearTimeout, navigator: { userAgent: 'x' }, document: { getElementsByTagName: () => [], currentScript: null }, location: { href: 'file:///x' }, Uint8Array, Buffer: undefined };
  page.window = page;
  page.self = page;
  page.globalThis = page;
  vm.createContext(page);
  vm.runInContext(fs.readFileSync(loader, 'utf8'), page, { filename: 'loader.js' });
  const broken = [];
  for (const f of ['time.js', 'codecs.js', 'mp4read.js', 'mkvread.js', 'audioread.js', 'probe.js', 'mp4write.js']) {
    try { vm.runInContext(fs.readFileSync(new URL(`${dir}${f}`, import.meta.url), 'utf8'), page, { filename: f }); } catch (err) { broken.push(`${f}: ${err.message}`); }
  }
  check(vm.runInContext('typeof require', page) === 'function' && !broken.length, `the format scripts load in the page next to Monaco's AMD require (${broken.join(' | ')})`);
  const Cut = vm.runInContext('globalThis.Cut', page);
  const { bytes } = wav({ frames: 48000 });
  const src = Cut?.probe ? await Cut.probe.open(Cut.codecs.bufferReader(bytes)) : null;
  check(src?.tracks[0]?.codec === 'pcm-s16' && src.tracks[0].samples.count === 1, 'Cut.probe works in the page');
}

const total = passed + failed;
console.log(`${passed}/${total} passed`);
process.exit(failed ? 1 : 0);
