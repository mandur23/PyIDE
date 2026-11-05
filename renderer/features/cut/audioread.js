// Audio-only files -> a Source (docs/cut-architecture.md §5): MP3 (every frame header indexed, ID3v2 skipped, the
// Xing/Info/VBRI frame left out and LAME's gapless delay applied), WAV (RIFF, RF64 and BW64 with ds64; integer PCM
// 8/16/24/32 and float 32/64, WAVE_FORMAT_EXTENSIBLE) and ADTS AAC (the 7 or 9 byte headers stripped, an
// AudioSpecificConfig built from the first one). MP3 and ADTS are read front to back in large windows; after a
// damaged stretch the scan finds the next two frames in a row and goes on.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).audioread = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const codecs = NODE ? require('./codecs.js') : globalThis.Cut.codecs;
  const { fail, readRange, ascii, u32, le16, le32, le64, TableBuilder, AAC_RATES } = codecs;

  const WINDOW = 4 * 1024 * 1024;

  // ---- frame headers -----------------------------------------------------------------------------------------------

  const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  // An MPEG audio layer III frame header at b[i] -> { version: 1 | 2 | 2.5, rate, channels, size, samples } or null.
  function mp3Header(b, i) {
    if (i < 0 || i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const ver = (b[i + 1] >> 3) & 3;
    const layer = (b[i + 1] >> 1) & 3;
    if (ver === 1 || layer !== 1) return null;
    const br = b[i + 2] >> 4;
    const sr = (b[i + 2] >> 2) & 3;
    if (br === 0 || br === 15 || sr === 3) return null;
    const pad = (b[i + 2] >> 1) & 1;
    const mode = b[i + 3] >> 6;
    const version = ver === 3 ? 1 : ver === 2 ? 2 : 2.5;
    const rate = [44100, 48000, 32000][sr] / (version === 1 ? 1 : version === 2 ? 2 : 4);
    const kbps = (version === 1 ? MP3_KBPS_V1 : MP3_KBPS_V2)[br];
    const samples = version === 1 ? 1152 : 576;
    return { version, rate, channels: mode === 3 ? 1 : 2, size: Math.floor((samples / 8) * kbps * 1000 / rate) + pad, samples, kbps };
  }
  const sameMp3 = (a, b) => !!a && !!b && a.version === b.version && a.rate === b.rate;

  // An ADTS header at b[i] -> { objectType, rate, rateIndex, channels, size (whole frame), header, samples } or null.
  function adtsHeader(b, i) {
    if (i < 0 || i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
    const header = b[i + 1] & 1 ? 7 : 9;
    const profile = b[i + 2] >> 6;
    const rateIndex = (b[i + 2] >> 2) & 15;
    const channels = ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6);
    const size = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    if (rateIndex >= 13 || size <= header) return null;
    return { objectType: profile + 1, rateIndex, rate: AAC_RATES[rateIndex], channels, size, header, samples: ((b[i + 6] & 3) + 1) * 1024 };
  }
  const sameAdts = (a, b) => !!a && !!b && a.rateIndex === b.rateIndex && a.objectType === b.objectType && a.channels === b.channels;

  // 'id3' | 'mp3' | 'aac' | null for the first bytes of a file: two frames in a row (or one that starts the file).
  function sniff(b) {
    if (b.length >= 10 && ascii(b, 0, 3) === 'ID3') return 'id3';
    for (let i = 0; i + 7 <= Math.min(b.length, 4096); i++) {
      if (b[i] !== 0xff) continue;
      const a = adtsHeader(b, i);
      if (a && (sameAdts(adtsHeader(b, i + a.size), a) || (i === 0 && i + a.size + 7 > b.length))) return 'aac';
      const m = mp3Header(b, i);
      if (m && (sameMp3(mp3Header(b, i + m.size), m) || (i === 0 && i + m.size + 4 > b.length))) return 'mp3';
    }
    return null;
  }

  async function skipId3(reader, pos) {
    for (let i = 0; i < 16; i++) {
      const h = await readRange(reader, pos, 10);
      if (h.length < 10 || ascii(h, 0, 3) !== 'ID3') return pos;
      const size = ((h[6] & 127) << 21) | ((h[7] & 127) << 14) | ((h[8] & 127) << 7) | (h[9] & 127);
      pos += 10 + size + (h[5] & 0x10 ? 10 : 0);
    }
    return pos;
  }

  // Walks frames from `start`: onFrame(offset, header, bytes, at) for each; returns { damaged, truncated }.
  async function scanFrames(reader, start, parse, same, onFrame) {
    const size = reader.size;
    let win = new Uint8Array(0);
    let winPos = 0;
    const ensure = async (p, n) => {
      if (p >= winPos && p + n <= winPos + win.length) return;
      if (p >= winPos && winPos + win.length >= size && p < size) return;
      win = await readRange(reader, p, Math.max(n, WINDOW));
      winPos = p;
    };
    const headerAt = async (p) => { await ensure(p, 16); return parse(win, p - winPos); };
    const tagAt = async (p) => {
      await ensure(p, 8);
      const s = ascii(win, p - winPos, 3);
      return s === 'TAG' || s === 'APE' || s === 'ID3' || s === 'LYR';
    };
    const validAt = async (p, ref) => {
      const h = await headerAt(p);
      if (!h || (ref && !same(h, ref))) return null;
      const next = p + h.size;
      if (next > size) return null;
      if (next + 7 > size || (await tagAt(next))) return h;
      return same(await headerAt(next), h) ? h : null;
    };
    let p = start;
    let ref = null;
    let damaged = false;
    let truncated = false;
    while (p + 4 <= size) {
      let h = await headerAt(p);
      if (h && ref && !same(h, ref)) h = null;
      if (h && p + h.size > size) { truncated = true; break; }
      if (h && !ref) h = await validAt(p, null);
      if (h) {
        ref = ref || h;
        await ensure(p, h.size);
        onFrame(p, h, win, p - winPos);
        p += h.size;
        continue;
      }
      if (ref && (await tagAt(p))) break;
      let q = p + 1;
      let found = -1;
      while (q + 4 <= size) {
        await ensure(q, 4);
        const end = winPos + win.length - 3;
        let i = q - winPos;
        while (q < end && !(win[i] === 0xff && (win[i + 1] & 0xe0) === 0xe0)) { i++; q++; }
        if (q >= end) { if (winPos + win.length >= size) break; continue; }
        if (await validAt(q, ref)) { found = q; break; }
        q++;
      }
      if (found < 0) break;
      if (ref) damaged = true;
      p = found;
    }
    return { damaged, truncated };
  }

  // ---- MP3 ---------------------------------------------------------------------------------------------------------

  // The Xing/Info or VBRI header in the first frame: { frames, delay, padding } or null.
  function xingOf(b, at, h) {
    const side = h.version === 1 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
    const x = at + 4 + side;
    const tag = ascii(b, x, 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = u32(b, x + 4);
      let p = x + 8;
      const frames = flags & 1 ? u32(b, p) : null;
      if (flags & 1) p += 4;
      if (flags & 2) p += 4;
      if (flags & 4) p += 100;
      if (flags & 8) p += 4;
      let delay = 0;
      let padding = 0;
      if (p + 24 <= b.length && /^(LAME|Lavc|Lavf|GOGO)/.test(ascii(b, p, 4))) {
        delay = (b[p + 21] << 4) | (b[p + 22] >> 4);
        padding = ((b[p + 22] & 15) << 8) | b[p + 23];
      }
      return { frames, delay, padding };
    }
    if (ascii(b, at + 36, 4) === 'VBRI') return { frames: u32(b, at + 36 + 14), delay: 0, padding: 0 };
    return null;
  }

  async function openMp3(reader, start) {
    const tb = new TableBuilder(8192);
    let first = null;
    let xing = null;
    let frames = 0;
    const scan = await scanFrames(reader, start, mp3Header, sameMp3, (p, h, b, at) => {
      if (!first) {
        first = h;
        xing = xingOf(b, at, h);
        if (xing) return;
      }
      tb.push(p, h.size, frames * h.samples, frames * h.samples, h.samples, 1);
      frames++;
    });
    if (!first) fail('damaged', 'no MPEG audio frames');
    return audioSource('mp3', tb, first.rate, {
      codec: 'mp3', description: null, channels: first.channels,
      skip: xing && (xing.delay || xing.padding) ? xing.delay + 529 : 0, padding: xing ? xing.padding : 0,
      truncated: scan.truncated || (xing?.frames != null && xing.frames > frames + 1),
    });
  }

  // ---- ADTS --------------------------------------------------------------------------------------------------------

  async function openAdts(reader, start) {
    const tb = new TableBuilder(8192);
    let first = null;
    let at = 0;
    const scan = await scanFrames(reader, start, adtsHeader, sameAdts, (p, h) => {
      first = first || h;
      tb.push(p + h.header, h.size - h.header, at, at, h.samples, 1);
      at += h.samples;
    });
    if (!first) fail('damaged', 'no ADTS frames');
    if (!first.channels) fail('unsupported', 'ADTS with a program config element');
    const description = codecs.buildAudioSpecificConfig({ objectType: first.objectType, sampleRate: first.rate, channels: first.channels });
    return audioSource('aac', tb, first.rate, { codec: `mp4a.40.${first.objectType}`, description, channels: first.channels, truncated: scan.truncated });
  }

  // ---- WAV ---------------------------------------------------------------------------------------------------------

  async function openWav(reader) {
    const size = reader.size;
    const head = await readRange(reader, 0, 12);
    const riff = ascii(head, 0, 4);
    let pos = 12;
    let fmt = null;
    let data = null;
    let ds64 = null;
    for (let i = 0; i < 100000 && pos + 8 <= size; i++) {
      const c = await readRange(reader, pos, 8);
      const id = ascii(c, 0, 4);
      if (!/^[\x20-\x7e]{4}$/.test(id)) break;
      let len = le32(c, 4);
      if (id === 'ds64') {
        const d = await readRange(reader, pos + 8, Math.min(len, 28));
        if (d.length >= 24) ds64 = { data: le64(d, 8), samples: le64(d, 16) };
      } else if (id === 'fmt ') {
        fmt = await readRange(reader, pos + 8, Math.min(len, 64));
      } else if (id === 'data') {
        if (len === 0xffffffff) len = riff !== 'RIFF' && ds64 ? ds64.data : size - pos - 8;
        else if (len === 0 && pos + 8 < size) len = size - pos - 8;
        data = { at: pos + 8, len: Math.min(len, size - pos - 8), cut: len > size - pos - 8 };
        if (fmt) break;
      }
      pos += 8 + len + (len & 1);
    }
    if (!fmt || fmt.length < 16) fail('damaged', 'no fmt chunk');
    if (!data) fail('damaged', 'no data chunk');
    let tag = le16(fmt, 0);
    const channels = le16(fmt, 2);
    const rate = le32(fmt, 4);
    const align = le16(fmt, 12);
    let bits = le16(fmt, 14);
    if (tag === 0xfffe && fmt.length >= 26) tag = le16(fmt, 24);
    if (!channels || !rate || !align) fail('damaged', 'bad fmt chunk');
    if (align !== channels * (bits / 8)) bits = (align / channels) * 8;
    let codec = null;
    if (tag === 1) codec = { 8: 'pcm-u8', 16: 'pcm-s16', 24: 'pcm-s24', 32: 'pcm-s32' }[bits];
    else if (tag === 3) codec = { 32: 'pcm-f32', 64: 'pcm-f64' }[bits];
    if (!codec) fail('unsupported', `WAV format ${tag} with ${bits} bits`);
    const frames = Math.floor(data.len / align);
    const piece = Math.max(1, Math.min(rate, Math.floor((1 << 20) / align)));
    const tb = new TableBuilder(Math.ceil(frames / piece) + 1);
    for (let f = 0; f < frames; f += piece) {
      const k = Math.min(piece, frames - f);
      tb.push(data.at + f * align, k * align, f, f, k, 1);
    }
    return audioSource('wav', tb, rate, { codec, description: null, channels, truncated: data.cut });
  }

  // ---- shared ------------------------------------------------------------------------------------------------------

  // Sample-count times -> ticks; `skip` samples of encoder delay come off the front (gapless MP3).
  function audioSource(container, tb, rate, { codec, description, channels, skip = 0, padding = 0, truncated = false }) {
    const t = tb.done();
    const ticks = codecs.ticksPer(rate);
    let end = 0;
    for (let i = 0; i < t.count; i++) {
      t.dts[i] = ticks(t.dts[i] - skip);
      t.pts[i] = t.dts[i];
      end = t.pts[i] + (t.duration[i] = ticks(t.duration[i]));
    }
    const duration = Math.max(0, end - ticks(padding));
    const track = { id: 1, kind: 'audio', codec, description, sampleRate: rate, channels, samples: t, duration, truncated, preRoll: 0 };
    codecs.finishTrack(track);
    return { container, duration, tracks: t.count ? [track] : [], skipped: [], image: null, error: null };
  }

  // kind: 'wav' | 'mp3' | 'aac' | 'id3' (a tag first: what follows decides).
  async function open(reader, kind) {
    if (kind === 'wav') return openWav(reader);
    let start = 0;
    if (kind === 'id3') {
      start = await skipId3(reader, 0);
      kind = sniff(await readRange(reader, start, 4096));
      if (kind !== 'mp3' && kind !== 'aac') fail('unsupported', 'an ID3 tag without MPEG audio after it');
    }
    return kind === 'aac' ? openAdts(reader, start) : openMp3(reader, start);
  }

  return { open, sniff, mp3Header, adtsHeader, xingOf, skipId3 };
});
