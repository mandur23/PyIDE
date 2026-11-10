// Export of Nano Studio Cut (docs/cut-architecture.md §9, features §15): renders every frame of a sequence (or of its
// In/Out range) with a compositor on an OffscreenCanvas at the preset's size, encodes it with VideoEncoder (the GPU's
// encoder first, the software one when the hardware cannot), mixes the sound with the audio engine and encodes AAC,
// muxes both with mp4write into the cut:writeOpen sink (the .part file is renamed when it is complete, deleted on
// cancel or failure), moves moov to the front (cut:faststart), then opens the file again and checks it: frame count,
// track lengths, first and last frame decode. Captions are burned in, written as SRT next to the file, or both.
// Also: the program frame as PNG, and the chapter markers as YouTube chapter text.
//
// AAC encoders put priming samples in front of the sound. The delay is measured once per configuration by encoding
// and decoding a noise burst, and the audio track is shifted by it, so mp4write's edit list hides the priming and
// beeps stay on their frames.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).export = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const mod = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const time = mod('time');
  const { TICKS } = time;

  const invoke = (...args) => {
    const api = globalThis.ide?.api;
    if (!api?.invoke) return Promise.reject(new Error('no IPC in this context'));
    return api.invoke(...args);
  };
  const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
  // Our errors carry a string code; a DOMException's numeric legacy code is not one.
  const codeOf = (err, fallback) => (typeof err?.code === 'string' && err.code ? err.code : fallback);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A view sent over IPC carries its whole buffer: send exact copies of parts.
  const whole = (b) => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice());

  // ---- pure helpers ------------------------------------------------------------------------------------------------

  const withExt = (path, ext) => String(path).replace(/(\.[^.\\/]*)?$/, () => `.${ext}`);
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  // A frame the decoder never gives (a codec or profile it takes but cannot decode) held the export, and a proxy job,
  // at 0 % with no word. Past this, it fails and names the video's codecs; a frame that comes later is closed.
  const FRAME_LIMIT_MS = 60000;
  function frameWithin(promise, ms, project, seq) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => {
        promise.then((f) => f?.close?.(), () => {});
        const used = new Set(seq.clips.map((c) => c.source?.media).filter(Boolean));
        const codecs = [...new Set(project.media.filter((m) => used.has(m.id) && m.video).map((m) => m.video.codec))].join(', ') || 'unknown';
        const t = globalThis.tr || ((s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]));
        reject(Object.assign(new Error(t('No video frame came from the decoder in {seconds} s (codec {codec}): this PC cannot decode the video. Convert it to H.264 and import it again.', { seconds: Math.round(ms / 1000), codec: codecs })), { code: 'decode' }));
      }, ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }
  // A source that stopped giving its picture or sound during the export (a drive unplugged, a file locked, a damaged
  // packet): the export stops, naming the clip and the sequence time, instead of writing a red frame or silence into a
  // file it calls done. Media that was offline when the export started (the dialog asked) is not a failure (`accepted`:
  // its ids). lost: [{clip, media, error}] -> an Error with code 'media', or null.
  function lostMedia(project, seq, t, lost, accepted, kind) {
    const bad = lost.filter((x) => !(x.media != null && accepted.has(x.media)));
    if (!bad.length) return null;
    const x = bad[0];
    const clip = x.clip != null ? findClip(project, x.clip) : project.media.some((m) => m.id === x.media) ? findClip(project, null, x.media) : null;
    const media = project.media.find((m) => m.id === (x.media ?? clip?.source?.media));
    const name = clip?.name || media?.name || String(x.clip ?? x.media ?? '?');
    const t2 = globalThis.tr || ((s2, v) => s2.replace(/\{(\w+)\}/g, (_, k) => v[k]));
    const params = { clip: name, time: time.timecode(t, seq.fps), error: x.error || 'unknown error' };
    const message = kind === 'sound'
      ? t2('The sound of {clip} could not be read at {time} ({error}), so the export was stopped.', params)
      : t2('The picture of {clip} could not be read at {time} ({error}), so the export was stopped.', params);
    return Object.assign(new Error(message), { code: 'media', info: { clip: clip?.id ?? x.clip ?? null, media: media?.id ?? x.media ?? null, t } });
  }
  // A clip by id, or the first one that uses a media, in any sequence (a nest's clips are in theirs).
  function findClip(project, id, mediaId) {
    for (const q of project.sequences) {
      const c = q.clips.find((x) => (id != null ? x.id === id : x.source?.media === mediaId));
      if (c) return c;
    }
    return null;
  }
  // The sound clips of one mix that are missing or whose source failed -> [{clip, media, error}] (lostMedia).
  function lostSound(m, failures) {
    const out = (m.missed || []).map((x) => ({ clip: x.clip, media: x.media, error: 'the sound is not read' }));
    for (const f of failures) out.push({ clip: null, media: f.media, error: f.error });
    // a failed source makes its clips missing too: the source's reason is the useful one
    for (const x of out) if (x.clip != null) { const f = failures.find((y) => y.media === x.media); if (f) x.error = f.error; }
    return out;
  }
  // The target was open in another program, so the finished file kept its .part name.
  const keptText = (path, part) => {
    const t = globalThis.tr || ((s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]));
    return t('{name} is open in another program, so it was not replaced. The finished export is kept as {part}: close that program and rename it, or export again.', { name: baseName(path), part });
  };
  // The SRT file next to an export: "<name>.srt", or "<name>.<lang>.srt" when the sequence has several caption tracks.
  function sidecarPath(path, lang, count = 1) {
    const base = String(path).replace(/\.[^.\\/]*$/, () => '');
    return count > 1 && lang ? `${base}.${lang}.srt` : `${base}.srt`;
  }

  // The frames of [from, to): count, the first frame's time, and the time and presentation time (from 0) of frame i.
  function framePlan(seq, from, to) {
    const fps = seq.fps;
    const first = time.frameAt(from, fps);
    const last = Math.max(first, Math.ceil(to / time.frameTicks(fps) - 1e-9));
    const t0 = time.frameStart(first, fps);
    return {
      count: last - first,
      first: t0,
      frame: time.frameTicks(fps),
      timeOf: (i) => time.frameStart(first + i, fps),
      ptsOf: (i) => time.frameStart(first + i, fps) - t0,
    };
  }

  // Captions of [in, out) moved to start at 0 and cut to the range (an item partly inside keeps the inside part).
  function captionsInRange(items, range) {
    if (!range) return items.map((x) => ({ ...x }));
    const out = [];
    for (const x of items) {
      const start = Math.max(x.start, range.in);
      const end = Math.min(x.end, range.out);
      if (end > start) out.push({ ...x, start: start - range.in, end: end - range.in });
    }
    return out;
  }
  const captionsAt = (items, t) => items.filter((x) => x.start <= t && t < x.end);

  // YouTube chapter lines from the sequence's chapter markers: "MM:SS name" (H:MM:SS when the last one is past an
  // hour). YouTube wants the first at 0:00: one is added named `firstName` when there is none there.
  function chapters(seq, { firstName = 'Intro', range = null } = {}) {
    const from = range?.in ?? 0;
    const to = range?.out ?? Infinity;
    const list = (seq.markers || []).filter((m) => m.kind === 'chapter' && m.t >= from && m.t < to)
      .map((m) => ({ t: m.t - from, name: String(m.name || '').trim() || '-' }))
      .sort((a, b) => a.t - b.t);
    if (!list.length) return '';
    if (Math.floor(list[0].t / TICKS) > 0) list.unshift({ t: 0, name: firstName });
    const hours = list.at(-1).t >= 3600 * TICKS;
    const p2 = (n) => String(n).padStart(2, '0');
    const fmt = (t) => {
      const s = Math.floor(t / TICKS);
      const mm = Math.floor(s / 60) % 60;
      return hours ? `${Math.floor(s / 3600)}:${p2(mm)}:${p2(s % 60)}` : `${p2(Math.floor(s / 60))}:${p2(s % 60)}`;
    };
    return list.map((c) => `${fmt(c.t)} ${c.name}`).join('\n');
  }
  // What keeps YouTube from showing the chapters: [English sentence for tr()].
  function chapterProblems(seq) {
    const list = (seq.markers || []).filter((m) => m.kind === 'chapter').sort((a, b) => a.t - b.t);
    const problems = [];
    if (list.length && list.length < 3) problems.push('YouTube shows chapters only when there are at least three.');
    for (let i = 1; i < list.length; i++) if (list[i].t - list[i - 1].t < 10 * TICKS) { problems.push('YouTube chapters must be at least 10 seconds long.'); break; }
    return problems;
  }

  // PSNR in dB of two RGBA images over R, G and B.
  function psnr(a, b) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; sum += d * d; }
      n += 3;
    }
    if (sum === 0) return Infinity;
    return 20 * Math.log10(255) - 10 * Math.log10(sum / n);
  }

  // ---- files -------------------------------------------------------------------------------------------------------

  // A cut:writeOpen sink as mp4write wants it: write(bytes, position) -> Promise, rejecting on a write error.
  async function openSink(path) {
    const o = await invoke('cut:writeOpen', path);
    if (!o || o.error) return { error: o?.error || 'cannot write the file', code: o?.code || 'io' };
    let bytes = 0;
    return {
      id: o.id,
      part: o.part,
      async write(data, position) {
        const r = await invoke('cut:writeAt', o.id, whole(data), position);
        if (!r || r.error) throw Object.assign(new Error(r?.error || 'write failed'), { code: r?.code || 'io' });
        bytes = Math.max(bytes, r.end || 0);
        return r;
      },
      close: (commit) => invoke('cut:writeClose', o.id, { commit }),
      get bytes() { return bytes; },
    };
  }

  // bytes (or text, written as UTF-8) -> {ok, path, bytes} | {ok: false, code, error}.
  async function saveBytes(path, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const sink = await openSink(path);
    if (sink.error) return fail(sink.code, sink.error);
    const STEP = 16 * 1024 * 1024;
    try {
      for (let i = 0; i < bytes.length; i += STEP) await sink.write(bytes.subarray(i, Math.min(bytes.length, i + STEP)));
    } catch (err) {
      await sink.close(false).catch(() => {});
      return fail(codeOf(err, 'io'), err.message);
    }
    const c = await sink.close(true);
    return c?.ok ? { ok: true, path: c.path, bytes: c.bytes } : fail(c?.code || 'io', c?.error || 'cannot write the file');
  }

  // ---- audio encoding ----------------------------------------------------------------------------------------------

  const AAC = 'mp4a.40.2';
  const delays = new Map();

  function aacEncoder({ rate, channels, bitrate, onChunk, onError }) {
    let description = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !description) {
          const d = meta.decoderConfig.description;
          description = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        onChunk({ data, us: chunk.timestamp, durUs: chunk.duration });
      },
      error: (e) => onError(e),
    });
    enc.configure({ codec: AAC, sampleRate: rate, numberOfChannels: channels, bitrate, aac: { format: 'aac' } });
    let sent = 0;
    return {
      enc,
      push(planes) {
        const n = planes[0].length;
        if (!n) return;
        const buf = new Float32Array(n * channels);
        for (let c = 0; c < channels; c++) buf.set(planes[Math.min(c, planes.length - 1)], c * n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((sent * 1e6) / rate), data: buf });
        enc.encode(ad);
        ad.close();
        sent += n;
      },
      get description() { return description; },
      get sent() { return sent; },
    };
  }

  // The samples between a sample going into the AAC encoder and coming out of AudioDecoder at the output's timestamp:
  // a pseudo-random burst is encoded and decoded, and the lag with the best correlation wins.
  async function aacDelay(rate = 48000, channels = 2, bitrate = 128000) {
    const key = `${rate}|${channels}|${bitrate}`;
    if (delays.has(key)) return delays.get(key);
    const p = (async () => {
      const N = Math.round(rate * 0.6);
      const at = Math.round(rate * 0.15);
      const len = 2048;
      const src = new Float32Array(N);
      let seed = 12345;
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        src[at + i] = ((seed / 0x7fffffff) * 2 - 1) * 0.5;
      }
      const chunks = [];
      let error = null;
      const e = aacEncoder({ rate, channels, bitrate, onChunk: (c) => chunks.push(c), onError: (x) => { error = x; } });
      e.push(Array.from({ length: channels }, () => src));
      await e.enc.flush();
      e.enc.close();
      if (error) throw error;
      const OFF = 8192;
      const out = new Float32Array(N + 2 * OFF);
      const dec = new AudioDecoder({
        output: (ad) => {
          try {
            const plane = new Float32Array(ad.numberOfFrames);
            ad.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
            const pos = Math.round((ad.timestamp * rate) / 1e6) + OFF;
            for (let i = 0; i < plane.length; i++) if (pos + i >= 0 && pos + i < out.length) out[pos + i] = plane[i];
          } finally { ad.close(); }
        },
        error: (x) => { error = x; },
      });
      dec.configure({ codec: AAC, sampleRate: rate, numberOfChannels: channels, description: e.description });
      for (const c of chunks) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: c.us, duration: c.durUs, data: c.data }));
      await dec.flush();
      dec.close();
      if (error) throw error;
      let best = 0;
      let bestScore = -Infinity;
      for (let lag = -2048; lag <= 6144; lag++) {
        let s = 0;
        for (let i = 0; i < len; i++) s += src[at + i] * out[at + i + lag + OFF];
        if (s > bestScore) { bestScore = s; best = lag; }
      }
      return best;
    })();
    delays.set(key, p);
    p.catch(() => delays.delete(key));
    return p;
  }

  // The bitrate to encode AAC at -> {bitrate, delay}: the one asked for, else the next lower one the encoder takes
  // (Windows' encoder has 96, 128, 160 and 192 kbps only). The delay measurement is the probe.
  const AAC_RATES = [320000, 256000, 192000, 160000, 128000, 96000];
  async function aacSetup(rate, channels, want) {
    let last = null;
    for (const bitrate of [want, ...AAC_RATES.filter((b) => b < want)]) {
      try { return { bitrate, delay: await aacDelay(rate, channels, bitrate) }; } catch (err) { last = err; }
    }
    throw last || new Error('no AAC encoder');
  }

  // Whole planes -> {chunks: [{data, timestamp, duration}] (ticks, priming before 0), description, delay, bitrate}.
  async function encodeAudio(planes, rate, { bitrate: want = 128000 } = {}) {
    const channels = planes.length;
    const { bitrate, delay } = await aacSetup(rate, channels, want);
    const chunks = [];
    let error = null;
    const tps = TICKS / rate;
    const e = aacEncoder({ rate, channels, bitrate, onError: (x) => { error = x; },
      onChunk: (c) => chunks.push({ data: c.data, timestamp: (Math.round((c.us * rate) / 1e6) - delay) * tps, duration: Math.round((c.durUs * rate) / 1e6) * tps }) });
    const STEP = rate;
    for (let i = 0; i < planes[0].length && !error; i += STEP) {
      e.push(planes.map((p) => p.subarray(i, Math.min(p.length, i + STEP))));
      while (e.enc.encodeQueueSize > 8 && !error) await sleep(1);
    }
    if (!error) await e.enc.flush().catch((x) => { error = error || x; });
    if (e.enc.state !== 'closed') e.enc.close();
    if (error) throw error;
    return { chunks, description: e.description, delay, bitrate };
  }

  // ---- video encoder -----------------------------------------------------------------------------------------------

  function videoConfig(settings, acceleration) {
    const v = settings.video;
    return {
      codec: v.codec, width: settings.width, height: settings.height, bitrate: v.bitrate,
      bitrateMode: v.mode === 'constant' ? 'constant' : 'variable',
      framerate: time.fpsValue(settings.fps), hardwareAcceleration: acceleration, latencyMode: 'quality',
      ...(v.family === 'hevc' ? { hevc: { format: 'hevc' } } : { avc: { format: 'avc' } }),
    };
  }

  // The encoders to try in order: [{config, hardware}]. hardware: 'auto' (the GPU's first), 'hardware', 'software'.
  async function encoderChoices(settings, hardware = 'auto') {
    const out = [];
    const tries = settings.video.family === 'hevc' ? ['prefer-hardware']
      : hardware === 'hardware' ? ['prefer-hardware'] : hardware === 'software' ? ['prefer-software'] : ['prefer-hardware', 'prefer-software'];
    for (const acc of tries) {
      const config = videoConfig(settings, acc);
      let ok = false;
      try { ok = !!(await VideoEncoder.isConfigSupported(config)).supported; } catch {}
      if (ok) out.push({ config, hardware: acc === 'prefer-hardware' });
    }
    return out;
  }

  // ---- the compositor ----------------------------------------------------------------------------------------------

  // A compositor at the export size; it burns in the caption track `burn` (an id or null). A compositor whose GPU work
  // fails would write black frames: the export stops instead, with the GPU's message.
  //
  // Chrome's encoders turn frames from CPU memory (the 2D back end's willReadFrequently canvas) into full-range YUV,
  // which most players show too dark; frames of a GPU canvas become the usual limited range. So a 2D back end's
  // picture is copied into a GPU canvas first.
  // `accepted` (a Set of media ids, or null for a single frame) makes a frame with a red "cannot be shown" picture of any
  // other media throw (lostMedia); a lost GPU device ends the export too.
  async function makeRenderer({ project, seqId, settings, burn, factory, backend, accepted = null, slated = null }) {
    const canvas = new OffscreenCanvas(settings.width, settings.height);
    const create = factory || mod('compositor')?.create;
    if (typeof create !== 'function') throw Object.assign(new Error('the compositor is not loaded'), { code: 'compositor' });
    const comp = await create(canvas, { width: settings.width, height: settings.height, ...(backend ? { backend } : {}) });
    const copy = comp.backend === 'webgpu' ? null : new OffscreenCanvas(settings.width, settings.height);
    const cg = copy?.getContext('2d', { alpha: false });
    let checked = false;
    return {
      backend: comp.backend,
      async frame(t, pts, duration) {
        const drawn = await comp.render(project, seqId, t, { quality: 1, captions: burn || null });
        if (accepted) {
          const seq = project.sequences.find((q) => q.id === seqId);
          const failed = drawn?.failed || [];
          const err = lostMedia(project, seq, t, failed, accepted, 'picture');
          if (err) throw err;
          for (const f of failed) slated?.add(f.clip);
        }
        if (!checked) {
          await comp.idle?.();
          checked = true;
        }
        this.check();
        const init = { timestamp: time.toMicros(pts), duration: time.toMicros(duration), alpha: 'discard' };
        if (copy) {
          cg.drawImage(canvas, 0, 0);
          return new VideoFrame(copy, init);
        }
        return typeof comp.videoFrame === 'function' ? comp.videoFrame(init) : new VideoFrame(canvas, init);
      },
      // GPU errors arrive after the work that caused them: looked at after every frame, and once the last is drawn.
      check() {
        if (comp.lost) throw Object.assign(new Error(`the GPU device was lost: ${comp.lost.message || comp.lost.reason || 'unknown reason'}`), { code: 'compositor' });
        if (comp.errors?.length) throw Object.assign(new Error(`the compositor failed: ${String(comp.errors[0]).split(/\r?\n/)[0]}`), { code: 'compositor' });
      },
      async done() {
        await comp.idle?.();
        this.check();
      },
      close() { (comp.destroy || comp.close)?.call(comp); },
    };
  }

  // ---- verification ------------------------------------------------------------------------------------------------

  // Decodes samples [from, to] of a video track -> the number of frames that came out (and the last one's pixels when
  // `pixels` is set).
  async function decodeRange(reader, track, from, to, { pixels = false } = {}) {
    const probe = mod('probe');
    const s = track.samples;
    let got = 0;
    let last = null;
    let error = null;
    const dec = new VideoDecoder({
      output: async (frame) => {
        got++;
        if (pixels && got === to - from + 1) {
          const rgba = new Uint8Array(frame.displayWidth * frame.displayHeight * 4);
          try { await frame.copyTo(rgba, { format: 'RGBA' }); last = rgba; } catch { last = null; }
        }
        frame.close();
      },
      error: (e) => { error = e; },
    });
    dec.configure({ codec: track.codec, codedWidth: track.width, codedHeight: track.height, ...(track.description ? { description: track.description } : {}) });
    const datas = await probe.readSamples(reader, track, from, to + 1);
    datas.forEach((d, k) => dec.decode(new EncodedVideoChunk({ type: s.key[from + k] ? 'key' : 'delta', timestamp: k, data: d })));
    await dec.flush().catch((e) => { error = error || e; });
    if (dec.state !== 'closed') dec.close();
    return { frames: got, error, pixels: last };
  }

  // Re-opens an exported file: { ok, frames, expectedFrames, duration, audioDuration, firstFrame, lastFrame, problems }.
  // A problem is {code, message (English, for tr()), params}.
  async function verifyFile(path, { video, frames, duration, audio }) {
    const ae = mod('audioengine');
    const probe = mod('probe');
    const problems = [];
    const out = { ok: false, frames: 0, expectedFrames: frames || 0, duration: 0, audioDuration: 0, firstFrame: false, lastFrame: false, problems };
    let reader;
    let source;
    try {
      reader = await ae.fileReader(path);
      source = await probe.open(reader, { name: path });
    } catch (err) {
      problems.push({ code: 'unreadable', message: 'The exported file cannot be read.', params: {} });
      return out;
    }
    if (source.error) {
      problems.push({ code: 'unreadable', message: 'The exported file cannot be read.', params: {} });
      return out;
    }
    const vt = source.tracks.find((t) => t.kind === 'video');
    const at = source.tracks.find((t) => t.kind === 'audio');
    const frameLen = video ? time.frameTicks(video.fps) : 0;
    if (video) {
      if (!vt) problems.push({ code: 'noVideo', message: 'The exported file has no video.', params: {} });
      else {
        const s = vt.samples;
        out.frames = s.count;
        let end = 0;
        let start = Infinity;
        for (let i = 0; i < s.count; i++) { end = Math.max(end, s.pts[i] + s.duration[i]); start = Math.min(start, s.pts[i]); }
        out.duration = s.count ? end - start : 0;
        if (s.count !== frames) problems.push({ code: 'frames', message: 'The file has {got} frames where {want} were expected.', params: { got: s.count, want: frames } });
        if (Math.abs(out.duration - duration) > frameLen / 2) problems.push({ code: 'duration', message: 'The video is {got} s long where {want} s was expected.', params: { got: +(out.duration / TICKS).toFixed(3), want: +(duration / TICKS).toFixed(3) } });
        if (s.count) {
          const first = await decodeRange(reader, vt, 0, 0);
          out.firstFrame = first.frames === 1 && !first.error;
          const lastIndex = s.order[s.count - 1];
          const k = probe.keyBefore(vt, lastIndex);
          const last = await decodeRange(reader, vt, k, s.count - 1);
          out.lastFrame = last.frames === s.count - k && !last.error;
          if (!out.firstFrame) problems.push({ code: 'firstFrame', message: 'The first frame does not decode.', params: {} });
          if (!out.lastFrame) problems.push({ code: 'lastFrame', message: 'The last frame does not decode.', params: {} });
        }
      }
    }
    if (audio) {
      if (!at) problems.push({ code: 'noAudio', message: 'The exported file has no sound.', params: {} });
      else {
        out.audioDuration = at.duration ?? 0;
        // Two AAC frames of slack: the encoder's last frame runs past the end.
        const slack = (2048 * TICKS) / (at.sampleRate || 48000);
        if (Math.abs(out.audioDuration - duration) > slack + frameLen) problems.push({ code: 'audioDuration', message: 'The sound is {got} s long where {want} s was expected.', params: { got: +(out.audioDuration / TICKS).toFixed(3), want: +(duration / TICKS).toFixed(3) } });
      }
    }
    out.ok = problems.length === 0;
    return out;
  }

  // ---- run ---------------------------------------------------------------------------------------------------------

  let measuredSpeed = null; // pixels a second of the last export
  try { measuredSpeed = Number(globalThis.localStorage?.getItem('cut.exportSpeed')) || null; } catch {}
  const speed = () => measuredSpeed;

  // Media of the sequence's clips whose files are missing: [{id, name, path}]; the export dialog warns about them.
  async function preflight(project, seqId, range = null) {
    const model = mod('model');
    const seq = project.sequences.find((s) => s.id === seqId);
    if (!seq) return { offline: [], empty: true };
    const from = range?.in ?? 0;
    const to = range?.out ?? model.sequenceDuration(seq);
    const used = new Map();
    // the media of the clips in [from, to), and of the clips a nest clip there shows (in its sequence's times)
    const gather = (s, a, b) => {
      for (const c of s.clips) {
        if (!c.enabled || model.clipEnd(c) <= a || c.start >= b) continue;
        const inner = model.nestOf(project, c);
        if (inner) {
          const [x, y] = model.sourceSpan(c, Math.max(a, c.start), Math.min(b, model.clipEnd(c)));
          gather(inner, x, y + 1);
          continue;
        }
        const m = model.mediaOf(project, c);
        if (m) used.set(m.id, m);
      }
    };
    gather(seq, from, to);
    const offline = [];
    for (const m of used.values()) {
      const st = await invoke('cut:stat', m.path).catch(() => ({ missing: true }));
      if (!st || st.missing || !st.isFile) offline.push({ id: m.id, name: m.name, path: m.path });
    }
    return { offline, empty: to <= from };
  }

  const cancelled = () => fail('cancelled', 'The export was cancelled.');

  // run({project, seqId, path, preset, range, captions, onProgress, signal, overrides, hardware, masterGain,
  //      captionTrack, verify, backend, gate}) -> {ok, path, bytes, seconds, speed, verified, encoder, sidecars} | {ok: false, code, error}
  // settings.audio null writes video only (proxies). gate: an async function awaited before each frame, which holds the
  // export while it has not resolved (a background job waiting while the player plays).
  async function run(opts) {
    const started = performance.now();
    const model = mod('model');
    const presets = mod('presets');
    const { project, seqId, onProgress, signal } = opts;
    const seq = project?.sequences.find((s) => s.id === seqId);
    if (!seq) return fail('noSequence', 'There is no such sequence.');
    const settings = opts.settings || presets.resolve(opts.preset || 'youtube-1080p', seq, opts.overrides || {});
    const problems = presets.validate(settings);
    if (problems.length) return fail('settings', problems[0]);
    const end = model.sequenceDuration(seq);
    const from = time.snap(Math.max(0, opts.range?.in ?? 0), seq.fps);
    const to = time.snap(opts.range?.out ?? end, seq.fps, { nearest: true });
    if (!(to > from)) return fail('empty', 'There is nothing to export in this range.');
    const path = withExt(opts.path, settings.ext);
    const captionMode = opts.captions || null;
    const burn = (captionMode === 'burn' || captionMode === 'both') && seq.captions?.length ? (opts.captionTrack || seq.captions[0].id) : null;
    const progress = (p) => { try { onProgress?.(p); } catch {} };

    // Media offline as the export starts: the dialog warned and asked, and it shows as the red "media offline" picture
    // with no sound. Anything else that cannot be shown or heard on the way stops the export (lostMedia).
    const offline = (await preflight(project, seq.id, { in: from, out: to }).catch(() => ({ offline: [] }))).offline;
    const accepted = new Set(offline.map((m) => m.id));
    let attempt = null;
    let choices = [null];
    if (settings.video) {
      choices = await encoderChoices(settings, opts.hardware || 'auto');
      if (!choices.length) return fail('noEncoder', settings.video.family === 'hevc' ? 'This PC has no HEVC encoder.' : 'This PC has no H.264 encoder for these settings.');
    }
    for (let i = 0; i < choices.length; i++) {
      attempt = await encodeOnce({ ...opts, project, seq, settings, from, to, path, burn, choice: choices[i], progress, signal, started, accepted });
      // A hardware encoder that fails on the way gets one more try in software.
      if (attempt.ok || attempt.code !== 'encode' || i === choices.length - 1) break;
    }
    if (!attempt.ok) return attempt;

    const sidecars = [];
    if ((captionMode === 'srt' || captionMode === 'both') && seq.captions?.length) {
      const srt = mod('srt');
      const range = { in: from, out: to };
      const tracks = seq.captions.filter((c) => c.items.length);
      const taken = new Set();
      for (const ct of tracks) {
        // Tracks are made in the UI's language, so two "ko" tracks are usual: the second gets a number, not the first's file.
        let file = sidecarPath(path, ct.lang, tracks.length);
        for (let n = 2; taken.has(file.toLowerCase()); n++) file = sidecarPath(path, `${ct.lang || 'captions'}-${n}`, 2);
        taken.add(file.toLowerCase());
        const r = await saveBytes(file, srt.write(mod('speakers').written(project, ct, captionsInRange(ct.items, range), globalThis.tr)));
        if (!r.ok) return fail(r.code, r.error, { path });
        sidecars.push(r.path);
      }
    }

    progress({ phase: 'finish', fraction: 1 });
    const fast = await invoke('cut:faststart', attempt.path).catch((err) => ({ error: err.message }));
    if (fast?.error) return fail('faststart', fast.error, { path: attempt.path });
    let verified = null;
    if (opts.verify !== false) {
      progress({ phase: 'verify', fraction: 1 });
      verified = await verifyFile(attempt.path, { video: settings.video ? { fps: seq.fps } : null, frames: attempt.frames, duration: to - from, audio: !!settings.audio });
      if (attempt.slated.length) {
        const names = attempt.slated.map((id) => findClip(project, id)?.name || id);
        verified.problems.push({ code: 'offline', message: '{n} clips use offline media: they show the red "media offline" picture and are silent ({names}).', params: { n: names.length, names: names.join(', ') } });
        verified.ok = false;
      }
    }
    const seconds = (performance.now() - started) / 1000;
    const media = (to - from) / TICKS;
    if (settings.video && attempt.encodeSeconds > 0) {
      measuredSpeed = (settings.width * settings.height * time.fpsValue(seq.fps) * media) / attempt.encodeSeconds;
      try { globalThis.localStorage?.setItem('cut.exportSpeed', String(Math.round(measuredSpeed))); } catch {}
    }
    const st = await invoke('cut:stat', attempt.path).catch(() => null);
    return {
      ok: true, path: attempt.path, bytes: st?.size ?? attempt.bytes, seconds, speed: media / Math.max(1e-6, seconds),
      frames: attempt.frames, range: { in: from, out: to }, verified, offline: attempt.slated, encoder: attempt.encoder, audioDelay: attempt.audioDelay, audioBitrate: attempt.audioBitrate, loudnessGain: attempt.loudnessGain, sidecars,
    };
  }

  async function encodeOnce(o) {
    const { project, seq, settings, from, to, path, progress, signal } = o;
    const accepted = o.accepted || new Set();
    const slated = new Set(); // clips of offline media drawn as the red picture or left silent
    const ae = mod('audioengine');
    const mp4write = mod('mp4write');
    if (signal?.aborted) return cancelled();
    const sink = await openSink(path);
    if (sink.error) return fail(sink.code, sink.error);
    let failure = null;
    let renderer = null;
    let venc = null;
    let aenc = null;
    const abort = async (result) => {
      try { if (venc && venc.state !== 'closed') venc.close(); } catch {}
      try { if (aenc && aenc.enc.state !== 'closed') aenc.enc.close(); } catch {}
      try { renderer?.close(); } catch {}
      await sink.close(false).catch(() => {});
      return result;
    };
    try {
      const plan = framePlan(seq, from, to);
      const frames = settings.video ? plan.count : 0;
      const duration = to - from;

      // Sound: the sources first (decoding may take a while), then mixed and encoded a second ahead of the picture.
      progress({ phase: 'audio', fraction: 0 });
      const rate = settings.audio?.rate || 48000;
      const tps = TICKS / rate;
      const mixer = settings.audio ? ae.createMixer({ rate, getAudio: o.getAudio }) : null;
      // The first minutes now; the rest as the mix gets there (mixLoaded), so a long range is never all in memory.
      if (mixer) {
        await mixer.load(project, seq.id, from, to);
        const err = lostMedia(project, seq, from, lostSound({}, mixer.failures()), accepted, 'sound');
        if (err) throw err;
      }
      if (signal?.aborted) return abort(cancelled());
      const { bitrate: audioBitrate, delay } = settings.audio ? await aacSetup(rate, settings.audio.channels, settings.audio.bitrate) : { bitrate: null, delay: 0 };
      const s0 = Math.round(from / tps);
      const sTotal = Math.round(duration / tps);
      let sDone = 0;
      let writer = null;
      const early = [];
      let vdesc = null;
      let vcolor = null;
      // A loudness target (LUFS) measures the mix first and turns it up or down to meet it, true peak kept under -1 dBTP.
      let loudnessGain = 0;
      if (ae && settings.audio && Number.isFinite(settings.loudness)) {
        const measured = await ae.measure(project, seq.id, from, to, { rate, masterGain: o.masterGain || 0, getAudio: o.getAudio, signal,
          onProgress: (fraction) => progress({ phase: 'audio', fraction }) });
        loudnessGain = ae.matchGain(measured, settings.loudness);
      }
      const masterGain = (o.masterGain || 0) + loudnessGain;
      aenc = ae && settings.audio ? aacEncoder({
        rate, channels: settings.audio.channels, bitrate: audioBitrate,
        onError: (e) => { failure = failure || Object.assign(e, { stage: 'audio' }); },
        onChunk: (c) => {
          const sample = { data: c.data, timestamp: (Math.round((c.us * rate) / 1e6) - delay) * tps, duration: Math.round((c.durUs * rate) / 1e6) * tps };
          if (writer) writer.addAudio(sample);
          else early.push({ kind: 'audio', sample });
        },
      }) : null;
      const pumpAudio = async (untilTicks) => {
        const until = Math.min(sTotal, Math.round(untilTicks / tps));
        // With no picture this loop is the whole export: it answers Cancel and reports progress itself (an hour of
        // audio-only ran to the end after Cancel, with the bar standing still).
        while (sDone < until && !failure && !signal?.aborted) {
          const n = Math.min(rate, until - sDone);
          const m = await mixer.mixLoaded(project, seq.id, s0 + sDone, n, { masterGain });
          // after mixLoaded every clip is read: one still missing, or a source that failed, is not in the file
          const lost = lostSound(m, mixer.failures());
          const err = lostMedia(project, seq, (s0 + sDone) * tps, lost, accepted, 'sound');
          if (err) throw err;
          for (const x of m.missed || []) slated.add(x.clip);
          aenc.push(m.out);
          sDone += n;
          while (aenc.enc.encodeQueueSize > 8 && !failure) await sleep(1);
          if (!settings.video && (sDone / rate) % 5 === 0) progress({ phase: 'audio', fraction: sDone / sTotal });
        }
      };

      const makeWriter = () => {
        writer = mp4write.create({
          video: settings.video ? { codec: settings.video.codec, width: settings.width, height: settings.height, description: vdesc, frameRate: seq.fps,
            colorSpace: vcolor || { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } } : null,
          audio: aenc ? { codec: AAC, sampleRate: rate, channels: settings.audio.channels, description: aenc.description } : null,
          sink,
        });
        for (const e of early.splice(0)) (e.kind === 'video' ? writer.addVideo(e.sample) : writer.addAudio(e.sample));
      };

      let encodeStart = performance.now();
      let lastWrite = Promise.resolve();
      if (settings.video) {
        renderer = await makeRenderer({ project, seqId: seq.id, settings, burn: o.burn, factory: o.compositor, backend: o.backend, accepted, slated });
        const ptsQueue = [];
        venc = new VideoEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig?.description && !vdesc) {
              const d = meta.decoderConfig.description;
              vdesc = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
            }
            if (meta?.decoderConfig?.colorSpace && !vcolor) vcolor = { ...meta.decoderConfig.colorSpace };
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const pts = ptsQueue.shift();
            const sample = { data, timestamp: pts, duration: plan.frame, key: chunk.type === 'key' };
            if (!writer && vdesc && (!aenc || aenc.description)) makeWriter();
            if (writer) lastWrite = writer.addVideo(sample);
            else early.push({ kind: 'video', sample });
          },
          error: (e) => { failure = failure || Object.assign(e, { stage: 'video' }); },
        });
        venc.configure(o.choice.config);
        encodeStart = performance.now();
        const keyEvery = settings.video.keyInterval;
        for (let i = 0; i < frames; i++) {
          if (o.gate) await o.gate();
          if (signal?.aborted) return abort(cancelled());
          if (failure) break;
          const pts = plan.ptsOf(i);
          if (aenc) await pumpAudio(pts + TICKS);
          const frame = await frameWithin(renderer.frame(plan.timeOf(i), pts, plan.frame), o.frameLimitMs ?? FRAME_LIMIT_MS, project, seq);
          ptsQueue.push(pts);
          venc.encode(frame, { keyFrame: i % keyEvery === 0 });
          frame.close();
          while (venc.encodeQueueSize > 3 && !failure) await new Promise((r) => { const tm = setTimeout(r, 20); venc.addEventListener('dequeue', () => { clearTimeout(tm); r(); }, { once: true }); });
          if (i % 30 === 29) await lastWrite;
          if (i % 5 === 0 || i === frames - 1) {
            const elapsed = (performance.now() - o.started) / 1000;
            const fraction = (i + 1) / frames;
            progress({ phase: 'video', done: i + 1, total: frames, fraction, elapsed, eta: fraction > 0 ? (elapsed / fraction) * (1 - fraction) : null, speed: (pts / TICKS) / Math.max(1e-6, (performance.now() - encodeStart) / 1000) });
          }
        }
        if (!failure) await venc.flush().catch((e) => { failure = failure || Object.assign(e, { stage: 'video' }); });
        if (!failure && !signal?.aborted) await renderer.done();
      }
      if (signal?.aborted) return abort(cancelled());
      if (aenc && !failure) {
        await pumpAudio(duration);
        if (signal?.aborted) return abort(cancelled());
        await aenc.enc.flush().catch((e) => { failure = failure || Object.assign(e, { stage: 'audio' }); });
      }
      if (failure) return abort(fail(failure.stage === 'video' ? 'encode' : 'audio', String(failure.message || failure), { hardware: o.choice?.hardware }));
      if (!writer) makeWriter();
      const encodeSeconds = (performance.now() - encodeStart) / 1000;
      venc?.close();
      aenc?.enc.close();
      renderer?.close();
      renderer = null;
      if (signal?.aborted) return abort(cancelled());
      await writer.finish();
      const closed = await sink.close(true);
      if (closed?.part) return fail('busy', keptText(path, closed.part), { part: closed.part });
      if (!closed?.ok) return fail(closed?.code || 'io', closed?.error || 'cannot write the file');
      return { ok: true, path: closed.path, bytes: closed.bytes, frames, encodeSeconds, slated: [...slated], audioDelay: aenc ? delay : null, audioBitrate: aenc ? audioBitrate : null, loudnessGain,
        encoder: settings.video ? { codec: settings.video.codec, hardware: !!o.choice.hardware } : null };
    } catch (err) {
      if (signal?.aborted) return abort(cancelled());
      return abort(fail(codeOf(err, 'encode'), String(err.message || err), err.info || {}));
    }
  }

  // ---- export frame ------------------------------------------------------------------------------------------------

  // The sequence frame at t as a PNG at the sequence's size -> {ok, path, bytes}. opts: {backend, compositor}.
  // The sequence's frame at t as PNG bytes, `width` pixels wide at most (the sequence's size when larger or not given),
  // with the captions of `captionTrack` burned in when one is named. -> {ok, bytes, width, height} | {ok: false, code, error}
  async function framePng(project, seqId, t, { width = null, captionTrack = null, compositor: factory, backend } = {}) {
    const seq = project.sequences.find((s) => s.id === seqId);
    if (!seq) return fail('noSequence', 'There is no such sequence.');
    const scale = width && width < seq.w ? width / seq.w : 1;
    const w = Math.max(2, Math.round(seq.w * scale));
    const h = Math.max(2, Math.round(seq.h * scale));
    let r = null;
    try {
      r = await makeRenderer({ project, seqId, settings: { width: w, height: h }, burn: captionTrack || null, factory, backend });
      const frame = await r.frame(time.snap(t, seq.fps), 0, time.frameTicks(seq.fps));
      const out = new OffscreenCanvas(w, h);
      out.getContext('2d').drawImage(frame, 0, 0, w, h);
      frame.close();
      const blob = await out.convertToBlob({ type: 'image/png' });
      return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
    } catch (err) {
      return fail('compositor', String(err?.message || err));
    } finally {
      try { r?.close(); } catch {}
    }
  }
  async function exportFrame(project, seqId, t, path, { compositor: factory, backend } = {}) {
    const r = await framePng(project, seqId, t, { compositor: factory, backend });
    if (!r.ok) return r;
    return saveBytes(withExt(path, 'png'), r.bytes);
  }

  return {
    run, exportFrame, framePng, chapters, chapterProblems, preflight, verifyFile, saveBytes, openSink, encodeAudio, aacDelay,
    framePlan, captionsInRange, captionsAt, sidecarPath, withExt, psnr, speed, decodeRange, lostMedia, lostSound,
  };
});
