// Media files for the engine of Nano Studio Cut: readers over IPC (cut:stat, cut:read: the renderer cannot read
// files itself), the opened media the decoder and the compositor share (the Source from probe, its video and audio
// tracks, the decoded bitmap of an image), and import: a path -> the Media entry commands.importMedia takes, or the
// reason it cannot be used (missing, unsupported codec, damaged, HDR).
//
// Media.video.w/h are the size the picture is shown at (pixel aspect and rotation applied); rotation is the clockwise
// turn the decoder's frames need. Opened values are cached per media path (and proxy); a relinked or changed file
// (another size or mtime) is opened again.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).media = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);

  const invoke = (...args) => {
    const api = globalThis.ide?.api;
    if (!api?.invoke) return Promise.reject(Object.assign(new Error('no IPC in this context'), { code: 'io' }));
    return api.invoke(...args);
  };
  const ioError = (r, fallback) => Object.assign(new Error(r?.error || fallback), { code: r?.code || 'io' });
  const nameOf = (p) => String(p).split(/[\\/]/).pop();

  // ---- readers -----------------------------------------------------------------------------------------------------

  // Container parsing makes many small reads (box and element headers); those are served from 256 KB blocks read once.
  const BLOCK = 256 * 1024;
  const SMALL = 64 * 1024;
  const BLOCKS_KEPT = 48;
  function ipcReader(path, size, readFn = (offset, length) => invoke('cut:read', path, offset, length)) {
    const blocks = new Map(); // index -> Promise<Uint8Array>
    let reads = 0;
    const fetch = async (offset, length) => {
      reads++;
      const r = await readFn(offset, length);
      if (!(r instanceof Uint8Array)) {
        if (r && ArrayBuffer.isView(r)) return new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
        throw ioError(r, 'cannot read the file');
      }
      return r;
    };
    const block = (i) => {
      let p = blocks.get(i);
      if (p) {
        blocks.delete(i);
        blocks.set(i, p);
        return p;
      }
      p = fetch(i * BLOCK, Math.min(BLOCK, size - i * BLOCK));
      p.catch(() => blocks.delete(i));
      blocks.set(i, p);
      while (blocks.size > BLOCKS_KEPT) blocks.delete(blocks.keys().next().value);
      return p;
    };
    return {
      path,
      size,
      get reads() { return reads; },
      async read(offset, length) {
        const start = Math.max(0, offset);
        const end = Math.min(size, offset + length);
        if (!(end > start)) return new Uint8Array(0);
        if (end - start > SMALL) return fetch(start, end - start);
        const a = Math.floor(start / BLOCK);
        const b = Math.floor((end - 1) / BLOCK);
        if (a === b) return (await block(a)).subarray(start - a * BLOCK, end - a * BLOCK);
        const [x, y] = await Promise.all([block(a), block(b)]);
        const out = new Uint8Array(end - start);
        const first = x.subarray(start - a * BLOCK);
        out.set(first, 0);
        out.set(y.subarray(0, end - b * BLOCK), first.length);
        return out;
      },
    };
  }

  async function stat(path) {
    const s = await invoke('cut:stat', path);
    if (!s || s.missing) return { missing: true, code: s?.code || 'missing', error: s?.error || 'the file is missing' };
    if (s.error) return { missing: true, code: s.code || 'io', error: s.error };
    return s;
  }
  // A reader over a file: { path, size, read(offset, length) -> Promise<Uint8Array> }. Rejects with code 'missing'.
  async function reader(path) {
    const s = await stat(path);
    if (s.missing || !s.isFile) throw Object.assign(new Error(s.error || 'not a file'), { code: s.code || 'missing' });
    return ipcReader(path, s.size);
  }

  // ---- what the engine can show --------------------------------------------------------------------------------------

  const HDR = new Set(['pq', 'hlg']);
  // The decoder config a video track needs, or null for codecs the reader cannot hand over.
  function videoConfig(track, hardware = 'no-preference') {
    const cfg = { codec: track.codec, codedWidth: track.width, codedHeight: track.height, hardwareAcceleration: hardware, optimizeForLatency: true };
    if (track.description) cfg.description = track.description;
    if (track.displayWidth && track.displayHeight) {
      cfg.displayAspectWidth = track.displayWidth;
      cfg.displayAspectHeight = track.displayHeight;
    }
    const cs = track.colorSpace;
    if (cs && (cs.primaries || cs.transfer || cs.matrix)) {
      cfg.colorSpace = {};
      for (const k of ['primaries', 'transfer', 'matrix']) if (cs[k]) cfg.colorSpace[k] = cs[k];
      if (cs.fullRange != null) cfg.colorSpace.fullRange = !!cs.fullRange;
    }
    return cfg;
  }
  function audioConfig(track) {
    const cfg = { codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels };
    if (track.description) cfg.description = track.description;
    return cfg;
  }
  async function supported(kind, cfg) {
    const C = kind === 'video' ? globalThis.VideoDecoder : globalThis.AudioDecoder;
    if (!C?.isConfigSupported) return false;
    try { return !!(await C.isConfigSupported(cfg)).supported; } catch { return false; }
  }
  // The upright size a video track is shown at: the display size (pixel aspect applied) turned by its rotation.
  function shownSize(track) {
    const w = track.displayWidth || track.width;
    const h = track.displayHeight || track.height;
    return track.rotation === 90 || track.rotation === 270 ? [h, w] : [w, h];
  }
  // Which tracks of a Source the editor uses, and why a file cannot be used: {video, audio, error}.
  async function usable(source) {
    if (source.error) return { video: null, audio: null, error: source.error };
    if (source.container === 'image') return { video: null, audio: null, error: null };
    const v = source.tracks.find((t) => t.kind === 'video') || null;
    const a = source.tracks.find((t) => t.kind === 'audio') || null;
    let video = null;
    let audio = null;
    let error = null;
    if (v) {
      if (v.colorSpace && HDR.has(v.colorSpace.transfer)) error = { code: 'hdr', detail: `HDR video (${v.colorSpace.transfer})` };
      else if (await supported('video', videoConfig(v))) video = v;
      else error = { code: 'unsupported', detail: `the video codec ${v.codec} cannot be decoded on this PC` };
    }
    if (a) {
      if (/^pcm-/.test(a.codec) || (await supported('audio', audioConfig(a)))) audio = a;
      else if (!video && !error) error = { code: 'unsupported', detail: `the audio codec ${a.codec} cannot be decoded on this PC` };
    }
    if (!video && !audio && !error) error = { code: 'noTracks', detail: 'no video or audio track' };
    // A file whose picture cannot be shown is refused even if its sound could be: the clip would be silently wrong.
    if (error && v && !video) return { video: null, audio: null, error };
    return { video, audio, error: video || audio ? null : error };
  }

  async function decodeImage(rd, mime) {
    const bytes = await need('codecs').readRange(rd, 0, rd.size);
    const blob = new Blob([bytes], { type: mime });
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  }

  // ---- opened media --------------------------------------------------------------------------------------------------

  const opened = new Map(); // key -> Promise<Opened>
  const KEEP = 64;
  const keyOf = (path, size, mtime) => `${path}|${size}|${mtime}`;

  // Opens one file: { path, size, mtime, reader, source, video, audio, image, width, height, rotation, duration,
  // error }. Never rejects; error.code is 'missing' for offline media.
  function openPath(path, { size, mtime } = {}) {
    const key = keyOf(path, size, mtime);
    const hit = opened.get(key);
    if (hit) {
      opened.delete(key);
      opened.set(key, hit);
      return hit;
    }
    const p = (async () => {
      const base = { path, size: 0, mtime: 0, reader: null, source: null, video: null, audio: null, image: null, width: 0, height: 0, rotation: 0, duration: 0, error: null };
      const s = await stat(path).catch((err) => ({ missing: true, code: 'io', error: err.message }));
      if (s.missing || !s.isFile) return { ...base, error: { code: s.code === 'missing' || !s.code ? 'missing' : s.code, detail: s.error || 'the file is missing' } };
      const rd = ipcReader(path, s.size);
      const source = await need('probe').open(rd, { name: nameOf(path) });
      const use = await usable(source);
      const out = { ...base, size: s.size, mtime: s.mtime, reader: rd, source, video: use.video, audio: use.audio, duration: source.duration || 0, error: use.error };
      if (!use.error && source.container === 'image') {
        try {
          out.image = await decodeImage(rd, source.image.mime);
          out.width = out.image.width;
          out.height = out.image.height;
        } catch (err) {
          out.error = { code: 'damaged', detail: `the image cannot be decoded: ${err?.message || err}` };
        }
      } else if (use.video) {
        [out.width, out.height] = shownSize(use.video);
        out.rotation = use.video.rotation || 0;
      }
      return out;
    })().catch((err) => ({ path, error: { code: 'damaged', detail: err?.message || String(err) }, video: null, audio: null, image: null, reader: null, source: null }));
    opened.set(key, p);
    p.then((o) => {
      // Offline media is checked again next time (the file may be back).
      if (o.error?.code === 'missing' || o.error?.code === 'io') setTimeout(() => { if (opened.get(key) === p) opened.delete(key); }, 2000);
    });
    while (opened.size > KEEP) {
      const [k, old] = opened.entries().next().value;
      opened.delete(k);
      old.then((o) => o.image?.close?.()).catch(() => {});
    }
    return p;
  }

  // The media entry of a project opened (the proxy file with { proxy: true } when it has one).
  function open(project, mediaId, { proxy = false } = {}) {
    const m = project.media.find((x) => x.id === mediaId);
    if (!m) return Promise.resolve({ path: null, error: { code: 'notFound', detail: `no media ${mediaId}` }, video: null, audio: null, image: null });
    const path = proxy && m.proxy?.path ? m.proxy.path : m.path;
    return openPath(path, path === m.path ? { size: m.size, mtime: m.mtime } : {}).then((o) => ({ ...o, mediaId, media: m, proxy: path !== m.path }));
  }
  // Drops cached opens of a path (all of them without one), after a relink or when the file was replaced.
  function forget(path) {
    for (const [k, p] of [...opened]) {
      if (path && !k.startsWith(`${path}|`)) continue;
      opened.delete(k);
      p.then((o) => o.image?.close?.()).catch(() => {});
    }
  }

  // ---- import ----------------------------------------------------------------------------------------------------------

  const fpsOf = (track) => (Array.isArray(track.frameRate) && track.frameRate[0] > 0 ? [track.frameRate[0], track.frameRate[1] || 1] : null);
  // Media entries for paths, in the same order: { path, name, kind, size, mtime, duration, video, audio } ready for
  // commands.importMedia, with `error: { code, detail }` instead for a file that cannot be used.
  async function importFiles(paths, { onProgress } = {}) {
    const list = [...paths];
    const out = new Array(list.length);
    let next = 0;
    let done = 0;
    const one = async (path) => {
      const name = nameOf(path);
      const o = await openPath(path);
      if (o.error) return { path, name, error: o.error };
      const base = { path, name, size: o.size, mtime: o.mtime, duration: o.duration, video: null, audio: null };
      if (o.source.container === 'image') return { ...base, kind: 'image', duration: 0, video: { w: o.width, h: o.height, fps: null, codec: o.source.image.mime, vfr: false, rotation: 0 } };
      if (o.video) base.video = { w: o.width, h: o.height, fps: fpsOf(o.video), codec: o.video.codec, vfr: !!o.video.vfr, rotation: o.rotation };
      if (o.audio) base.audio = { rate: o.audio.sampleRate, channels: o.audio.channels, codec: o.audio.codec };
      return { ...base, kind: o.video ? 'video' : 'audio' };
    };
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await one(list[i]).catch((err) => ({ path: list[i], name: nameOf(list[i]), error: { code: 'damaged', detail: err?.message || String(err) } }));
        done++;
        onProgress?.({ done, total: list.length, path: list[i] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    return out;
  }

  return { reader, ipcReader, stat, open, openPath, forget, importFiles, videoConfig, audioConfig, shownSize, usable };
});
