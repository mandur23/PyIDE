// Opens any media file Cut imports (docs/cut-architecture.md §5): sniffs the first bytes, hands the file to the
// container reader (mp4read, mkvread, audioread) or recognizes an image, and returns a Source. open() never throws
// and never rejects: a file that cannot be used comes back with Source.error. Also the sample lookups every reader's
// tables share: sampleAtTime, keyBefore, readSample, readSamples.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).probe = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const codecs = need('codecs');
  const mp4read = need('mp4read');
  const mkvread = need('mkvread');
  const audioread = need('audioread');
  const { readRange, ascii, u16, u32, le16, le32 } = codecs;

  const empty = (container, error) => ({ container, duration: 0, tracks: [], skipped: [], image: null, error });

  // What the first bytes say: 'mp4' | 'mkv' | 'wav' | 'mp3' | 'aac' | an image mime | null.
  function sniff(b) {
    if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
      const major = ascii(b, 8, 4);
      if (major === 'avif' || major === 'avis') return 'image/avif';
      if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(major)) return 'heif';
      return 'mp4';
    }
    if (b.length >= 8 && ['moov', 'mdat', 'free', 'wide', 'skip', 'pnot'].includes(ascii(b, 4, 4))) return 'mp4';
    if (b.length >= 4 && u32(b, 0) === 0x1a45dfa3) return 'mkv';
    if (b.length >= 12 && ['RIFF', 'RF64', 'BW64'].includes(ascii(b, 0, 4)) && ascii(b, 8, 4) === 'WAVE') return 'wav';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
    if (b.length >= 8 && u32(b, 0) === 0x89504e47 && u32(b, 4) === 0x0d0a1a0a) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif';
    if (b.length >= 26 && ascii(b, 0, 2) === 'BM' && le32(b, 14) >= 12) return 'image/bmp';
    const audio = audioread.sniff(b);
    if (audio) return audio;
    return null;
  }

  async function imageSize(reader, mime, b) {
    try {
      if (mime === 'image/png' && b.length >= 24) return [u32(b, 16), u32(b, 20)];
      if (mime === 'image/gif' && b.length >= 10) return [le16(b, 6), le16(b, 8)];
      if (mime === 'image/bmp') return [Math.abs(le32(b, 18) | 0), Math.abs(le32(b, 22) | 0)];
      if (mime === 'image/webp' && b.length >= 30) {
        const kind = ascii(b, 12, 4);
        if (kind === 'VP8 ') return [le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff];
        if (kind === 'VP8L') {
          const v = le32(b, 21);
          return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1];
        }
        if (kind === 'VP8X') return [(b[24] | (b[25] << 8) | (b[26] << 16)) + 1, (b[27] | (b[28] << 8) | (b[29] << 16)) + 1];
      }
      if (mime === 'image/jpeg') {
        let p = 2;
        for (let i = 0; i < 512 && p + 4 <= reader.size; i++) {
          const h = await readRange(reader, p, 10);
          if (h.length < 4 || h[0] !== 0xff) return null;
          const marker = h[1];
          if (marker === 0xff) { p++; continue; }
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && h.length >= 9) return [u16(h, 7), u16(h, 5)];
          if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
          p += 2 + u16(h, 2);
        }
      }
    } catch { /* the engine decodes it anyway */ }
    return null;
  }

  // reader = { size, read(offset, length) -> Promise<Uint8Array> } -> Promise<Source>
  async function open(reader, { name } = {}) {
    void name;
    let head;
    try {
      if (!reader || !(reader.size >= 0) || typeof reader.read !== 'function') return empty(null, { code: 'damaged', detail: 'no reader' });
      if (reader.size < 4) return empty(null, { code: 'damaged', detail: 'the file is empty' });
      head = await readRange(reader, 0, 4096);
    } catch (err) {
      return empty(null, { code: 'damaged', detail: err?.detail || err?.message || String(err) });
    }
    const kind = sniff(head);
    if (!kind) return empty(null, { code: 'unsupported', detail: 'not a media file Cut can open' });
    if (kind === 'heif') return empty('image', { code: 'unsupported', detail: 'HEIF/HEIC images' });
    if (kind.startsWith('image/')) {
      const size = await imageSize(reader, kind, head);
      return { ...empty('image', null), image: { mime: kind, width: size?.[0] || 0, height: size?.[1] || 0 } };
    }
    const container = kind === 'id3' ? 'mp3' : kind;
    let source;
    try {
      if (kind === 'mp4') source = await mp4read.open(reader);
      else if (kind === 'mkv') source = await mkvread.open(reader);
      else source = await audioread.open(reader, kind);
    } catch (err) {
      const code = err && err.code && ['unsupported', 'damaged', 'hdr', 'noTracks'].includes(err.code) ? err.code : 'damaged';
      return empty(container, { code, detail: err?.detail || err?.message || String(err) });
    }
    if (!source.tracks.length && !source.error) {
      const codecsSkipped = source.skipped.filter((s) => s.reason !== 'empty').map((s) => s.codec);
      source.error = codecsSkipped.length
        ? { code: 'unsupported', detail: `unsupported codec: ${[...new Set(codecsSkipped)].join(', ')}` }
        : { code: 'noTracks', detail: 'no video or audio track' };
    }
    return source;
  }

  // ---- sample lookups ----------------------------------------------------------------------------------------------

  // The sample on screen at presentation time t: the last pts <= t (the first sample before the first pts), -1 if none.
  function sampleAtTime(track, t) {
    const s = track.samples;
    if (!s || !s.count) return -1;
    const { order, pts } = s;
    let lo = 0;
    let hi = s.count - 1;
    if (pts[order[0]] > t) return order[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[order[mid]] <= t) lo = mid;
      else hi = mid - 1;
    }
    return order[lo];
  }

  function keyIndex(s) {
    if (s.keys) return s.keys;
    let n = 0;
    for (let i = 0; i < s.count; i++) n += s.key[i];
    const keys = new Uint32Array(n);
    for (let i = 0, j = 0; i < s.count; i++) if (s.key[i]) keys[j++] = i;
    s.keys = keys;
    return keys;
  }
  // The last sync sample at or before `k` in decode order, or -1.
  function keyAtOrBefore(keys, k) {
    let lo = 0;
    let hi = keys.length - 1;
    if (hi < 0 || keys[0] > k) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (keys[mid] <= k) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  // The sync sample to start decoding from to reach sample `index`. A picture shown before its GOP's key frame (the
  // leading pictures of an open GOP) needs the GOP before. Audio with pre-roll (Opus) starts that much earlier.
  function keyBefore(track, index) {
    const s = track.samples;
    if (!s || !s.count) return -1;
    const i = Math.max(0, Math.min(s.count - 1, index));
    const keys = keyIndex(s);
    let k = keyAtOrBefore(keys, i);
    if (k < 0) return 0;
    while (k > 0 && s.pts[i] < s.pts[keys[k]]) k--;
    let start = keys[k];
    if (track.preRoll > 0) {
      const target = s.dts[start] - track.preRoll;
      while (start > 0 && s.dts[start] > target) start--;
      const kk = keyAtOrBefore(keys, start);
      if (kk >= 0) start = keys[kk];
    }
    return start;
  }

  async function readSample(reader, track, index) {
    const s = track.samples;
    if (!(index >= 0 && index < s.count)) throw new RangeError(`no sample ${index}`);
    const bytes = await readRange(reader, s.offset[index], s.size[index]);
    if (bytes.length !== s.size[index]) throw new codecs.FormatError('damaged', `sample ${index} is cut off`);
    return track.samplePrefix ? codecs.concat([track.samplePrefix, bytes]) : bytes;
  }
  // Samples from..to-1 (decode order, like slice) as an array of Uint8Array, reading neighbouring bytes together.
  const GAP = 256 * 1024;
  const SPAN = 16 * 1024 * 1024;
  async function readSamples(reader, track, from, to) {
    const s = track.samples;
    const a = Math.max(0, from);
    const b = Math.min(s.count, to);
    const out = [];
    let i = a;
    while (i < b) {
      const start = s.offset[i];
      let end = start + s.size[i];
      let j = i + 1;
      while (j < b) {
        const o = s.offset[j];
        if (o < start || o > end + GAP || Math.max(end, o + s.size[j]) - start > SPAN) break;
        end = Math.max(end, o + s.size[j]);
        j++;
      }
      const bytes = await readRange(reader, start, end - start);
      for (let k = i; k < j; k++) {
        const at = s.offset[k] - start;
        if (at + s.size[k] > bytes.length) throw new codecs.FormatError('damaged', `sample ${k} is cut off`);
        const piece = bytes.subarray(at, at + s.size[k]);
        out.push(track.samplePrefix ? codecs.concat([track.samplePrefix, piece]) : piece);
      }
      i = j;
    }
    return out;
  }

  return { open, sniff, sampleAtTime, keyBefore, readSample, readSamples };
});
