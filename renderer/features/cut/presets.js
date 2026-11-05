// Export and sequence presets of Nano Studio Cut (features §15 and §3): what each export preset writes, the settings
// one resolves to for a sequence (size, codec string with the H.264/HEVC level that fits, bitrate for the frame rate,
// keyframe interval in frames), size and time estimates, and the sequence presets of the New Sequence dialog.
// A preset's `name` is English, shown through tr().
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).presets = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;

  // Bitrates are bits a second at up to 30 fps and above 30 fps.
  const EXPORT = [
    { id: 'youtube-1080p', name: 'YouTube 1080p', kind: 'video', ext: 'mp4', w: 1920, h: 1080,
      video: { codec: 'h264', bitrate: [10e6, 15e6], mode: 'variable', keySeconds: 2 }, audio: { bitrate: 192000 }, loudness: -14 },
    { id: 'youtube-4k', name: 'YouTube 4K', kind: 'video', ext: 'mp4', w: 3840, h: 2160,
      video: { codec: 'h264', bitrate: [40e6, 60e6], mode: 'variable', keySeconds: 2 }, audio: { bitrate: 192000 }, loudness: -14 },
    { id: 'shorts', name: 'Shorts and Reels', kind: 'video', ext: 'mp4', w: 1080, h: 1920,
      video: { codec: 'h264', bitrate: [10e6, 15e6], mode: 'variable', keySeconds: 2 }, audio: { bitrate: 192000 }, loudness: -14 },
    { id: '720p', name: '720p light', kind: 'video', ext: 'mp4', w: 1280, h: 720,
      video: { codec: 'h264', bitrate: [5e6, 7.5e6], mode: 'variable', keySeconds: 2 }, audio: { bitrate: 160000 }, loudness: -14 },
    { id: 'audio-m4a', name: 'Audio only (M4A)', kind: 'audio', ext: 'm4a', w: null, h: null,
      video: null, audio: { bitrate: 192000 }, loudness: -14 },
  ];
  const LOUDNESS = [{ id: 'youtube', name: 'YouTube', lufs: -14 }, { id: 'broadcast', name: 'Broadcast', lufs: -24 }];
  // AAC bitrates: the encoder WebCodecs uses on Windows (Media Foundation) takes 96, 128, 160 and 192 kbps only.
  const AUDIO_BITRATES = [128000, 160000, 192000];
  const AUDIO_RATE = 48000;

  const SEQUENCE = [
    { id: 'youtube-1080p30', name: 'YouTube 1080p30', w: 1920, h: 1080, fps: [30, 1] },
    { id: 'youtube-4k30', name: 'YouTube 4K30', w: 3840, h: 2160, fps: [30, 1] },
    { id: 'shorts', name: 'Shorts 1080x1920', w: 1080, h: 1920, fps: [30, 1] },
    { id: 'square', name: 'Square 1080x1080', w: 1080, h: 1080, fps: [30, 1] },
  ];

  const get = (id) => EXPORT.find((p) => p.id === id) || null;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // H.264 levels: [level_idc, max macroblocks a second, max frame size in macroblocks, max High-profile bitrate].
  const AVC_LEVELS = [
    [30, 40500, 1620, 12.5e6], [31, 108000, 3600, 17.5e6], [32, 216000, 5120, 25e6], [40, 245760, 8192, 25e6],
    [41, 245760, 8192, 62.5e6], [42, 522240, 8704, 62.5e6], [50, 589824, 22080, 168.75e6], [51, 983040, 36864, 300e6],
    [52, 2073600, 36864, 300e6], [60, 4177920, 139264, 300e6], [61, 8355840, 139264, 600e6], [62, 16711680, 139264, 1000e6],
  ];
  // The smallest level that holds the picture size, the macroblock rate and the bitrate; also the side limit
  // (a side of at most sqrt(8 * MaxFS) macroblocks).
  function avcLevel(w, h, fps, bitrate = 0) {
    const mbw = Math.ceil(w / 16);
    const mbh = Math.ceil(h / 16);
    const fs = mbw * mbh;
    const rate = fs * fps;
    for (const [idc, mbps, maxFs, maxBr] of AVC_LEVELS) {
      const side = Math.sqrt(8 * maxFs);
      if (fs <= maxFs && rate <= mbps && bitrate <= maxBr && mbw <= side && mbh <= side) return idc;
    }
    return 62;
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  // 'avc1.PPCCLL': High profile (100), no constraint flags.
  const avcCodec = (w, h, fps, bitrate) => `avc1.6400${hex2(avcLevel(w, h, fps, bitrate))}`;

  // HEVC Main tier levels: [level * 30, max luma picture size, max luma samples a second, max bitrate].
  const HEVC_LEVELS = [
    [90, 552960, 16588800, 6e6], [93, 983040, 33177600, 10e6], [120, 2228224, 66846720, 12e6], [123, 2228224, 133693440, 20e6],
    [150, 8912896, 267386880, 25e6], [153, 8912896, 534773760, 40e6], [156, 8912896, 1069547520, 60e6],
    [180, 35651584, 1069547520, 60e6], [183, 35651584, 2139095040, 120e6], [186, 35651584, 4278190080, 240e6],
  ];
  function hevcLevel(w, h, fps, bitrate = 0) {
    const ps = w * h;
    for (const [lv, maxPs, maxSr, maxBr] of HEVC_LEVELS) {
      const side = Math.sqrt(8 * maxPs);
      if (ps <= maxPs && ps * fps <= maxSr && bitrate <= maxBr && w <= side && h <= side) return lv;
    }
    return 186;
  }
  const hevcCodec = (w, h, fps, bitrate) => `hvc1.1.6.L${hevcLevel(w, h, fps, bitrate)}.B0`;

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const clampBitrate = (b) => AUDIO_BITRATES.reduce((best, v) => (Math.abs(v - b) < Math.abs(best - b) ? v : best), AUDIO_BITRATES[0]);

  // The concrete settings an export of `seq` with `preset` (an id or a preset object) uses. `overrides` takes the
  // export dialog's changes: {w, h, codec: 'h264' | 'hevc', bitrate, mode: 'constant' | 'variable', keySeconds,
  // audioBitrate, loudness}. The frame rate is always the sequence's.
  function resolve(preset, seq, overrides = {}) {
    const p = typeof preset === 'string' ? get(preset) : preset;
    if (!p) throw new Error(`no export preset ${preset}`);
    const fps = seq?.fps || [30, 1];
    const fpsV = time.fpsValue(fps);
    const o = overrides || {};
    let width = o.w || p.w || seq?.w || 1920;
    let height = o.h || p.h || seq?.h || 1080;
    width = even(width);
    height = even(height);
    const audio = {
      codec: 'mp4a.40.2', rate: AUDIO_RATE, channels: 2,
      bitrate: clampBitrate(o.audioBitrate || p.audio?.bitrate || 192000),
    };
    const out = { id: p.id, name: p.name, kind: p.kind, ext: p.ext, width, height, fps: [fps[0], fps[1]], video: null, audio,
      // an override of null means 'Do not change', so only a missing key falls back to the preset
      loudness: o.loudness !== undefined ? o.loudness : p.loudness ?? null };
    if (p.kind === 'video') {
      const family = o.codec || p.video.codec;
      const rates = p.video.bitrate;
      // A preset's bitrate is for its own size; another size gets the same bits per pixel.
      const base = Array.isArray(rates) ? (fpsV > 31 ? rates[1] : rates[0]) : rates;
      const scale = (width * height) / ((p.w || width) * (p.h || height));
      const bitrate = Math.round(o.bitrate || base * scale);
      const keySeconds = o.keySeconds || p.video.keySeconds || 2;
      out.video = {
        family,
        codec: family === 'hevc' ? hevcCodec(width, height, fpsV, bitrate) : avcCodec(width, height, fpsV, bitrate),
        bitrate,
        mode: o.mode || p.video.mode || 'variable',
        keyInterval: Math.max(1, Math.round(keySeconds * fpsV)),
      };
    }
    return out;
  }

  // Problems with settings a person typed: [English sentences for tr()].
  function validate(settings) {
    const errors = [];
    if (settings.kind === 'video') {
      const { width, height } = settings;
      if (!(width >= 16 && height >= 16 && width <= 8192 && height <= 8192)) errors.push('The size must be between 16 and 8192 pixels.');
      if (width % 2 || height % 2) errors.push('The width and height must be even.');
      if (!(settings.video?.bitrate >= 100000 && settings.video.bitrate <= 400e6)) errors.push('The video bitrate must be between 0.1 and 400 Mbps.');
    }
    if (!AUDIO_BITRATES.includes(settings.audio?.bitrate)) errors.push('The audio bitrate must be 128, 160 or 192 kbps.');
    return errors;
  }

  // Container bytes besides the samples: ftyp and mdat headers, moov with about 8 bytes of tables a video frame and
  // 4 an audio frame (1024 samples).
  function overhead(seconds, fps, video) {
    return 1024 + Math.ceil(seconds * ((video ? fps * 8 : 0) + (AUDIO_RATE / 1024) * 4));
  }
  // Bytes of an export of `durationTicks` with `preset` (an id, a preset or resolved settings).
  function estimate(preset, durationTicks, { fps = [30, 1] } = {}) {
    const s = typeof preset === 'string' || !preset?.audio?.codec ? resolve(preset, { fps }) : preset;
    const seconds = Math.max(0, durationTicks) / time.TICKS;
    const bps = (s.video ? s.video.bitrate : 0) + s.audio.bitrate;
    return Math.round((bps * seconds) / 8 + overhead(seconds, time.fpsValue(s.fps), !!s.video));
  }

  // Seconds an export will take on this PC: `speed` is pixels a second measured by an earlier export (export.js keeps
  // it: the default), else a guess for an ordinary GPU (1080p at about 3x realtime).
  const GUESS_PIXELS_PER_SECOND = 1920 * 1080 * 30 * 3;
  function estimateSeconds(preset, durationTicks, { fps = [30, 1], speed = globalThis.Cut?.export?.speed?.() } = {}) {
    const s = typeof preset === 'string' || !preset?.audio?.codec ? resolve(preset, { fps }) : preset;
    const seconds = Math.max(0, durationTicks) / time.TICKS;
    if (!s.video) return seconds / 200;
    const pixels = s.width * s.height * time.fpsValue(s.fps) * seconds;
    return pixels / (speed > 0 ? speed : GUESS_PIXELS_PER_SECOND);
  }

  // The sequence settings that fit a media item (a first clip dropped on an empty timeline): its size after rotation
  // and the offered frame rate nearest to its own.
  function sequenceFor(media) {
    const v = media?.video;
    if (!v) return { w: 1920, h: 1080, fps: [30, 1] };
    const turned = v.rotation === 90 || v.rotation === 270;
    const w = even(turned ? v.h : v.w);
    const h = even(turned ? v.w : v.h);
    const want = v.fps ? time.fpsValue(v.fps) : 30;
    let fps = [30, 1];
    let best = Infinity;
    for (const r of time.FRAME_RATES) {
      const d = Math.abs(time.fpsValue(r) - want);
      if (d < best - 1e-9) { best = d; fps = r; }
    }
    return { w, h, fps: [fps[0], fps[1]] };
  }

  return {
    EXPORT, SEQUENCE, LOUDNESS, AUDIO_BITRATES, AUDIO_RATE,
    list: () => EXPORT.map(clone), sequences: () => SEQUENCE.map(clone), get: (id) => (get(id) ? clone(get(id)) : null),
    resolve, validate, estimate, estimateSeconds, sequenceFor, avcLevel, avcCodec, hevcLevel, hevcCodec,
  };
});
