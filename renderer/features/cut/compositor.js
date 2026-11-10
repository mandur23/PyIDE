// The compositor of Nano Studio Cut (docs/cut-architecture.md section 8): draws the frame of a sequence at time t.
// Video tracks bottom to top (V1 first); each clip's picture (a decoded video frame, an image, a text clip's layers, a
// solid color) goes through its effects in its own frame, then is placed with crop, anchor, scale, rotation, position
// and opacity (keyframed values at t), transitions mix the two clips of an edit point, and captions are burned in on
// top when asked.
//
// WebGPU when the PC has an adapter: every intermediate picture is rgba16float, linear light, premultiplied alpha;
// sources are decoded from sRGB on upload and the result is encoded back to sRGB (Rec. 709 primaries) once, at the end.
// Without WebGPU (or with { backend: '2d' }) a Canvas 2D fallback draws the same layout: transforms, opacity, crop,
// text, the transitions, and colors through CSS filters (an approximation: not linear light).
//
// One plan step decides what is visible and is shared by both back ends. Each clip on screen gets its own frame source
// (decoder.js), so two clips of one file play as two independent streams; sources not used for a while are closed.
//
// A nest clip (model.js: source.sequence) is an item of kind 'nest' whose `layers` are the plan of its sequence at its
// source time (`srcT`), drawn into a transparent picture of that sequence's size fitted to this one (`w`, `h`); the
// clip's own effects, motion, opacity and keyframes then apply to that picture as to a video frame. Items of a nested
// plan carry `key` (the nest clips' ids above them, then their own), so a clip shown by two nest clips at once gets
// two frame sources, and `seqW`/`seqH`, the size of the sequence they are placed in.
//
// Masks (masks.js) work in the item's own frame, before its motion, so they follow it: an effect's masks mix the
// effect's output over its input after its last pass (outside them the effect is not there), and Opacity's masks
// multiply the picture after every effect (Premiere applies Opacity after the effects). The item carries them with
// their values at t: `masks` (Opacity's) and each effect's `masks`, null when none counts.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).compositor = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const tr = (s, v) => (typeof globalThis.tr === 'function' ? globalThis.tr(s, v) : s);

  // ---- the plan: what is on screen at t (pure, shared by both back ends) -------------------------------------------

  const ZERO4 = [0, 0, 0, 0];
  function fitScale(sw, sh, W, H, mode) {
    if (!(sw > 0 && sh > 0)) return 1;
    if (mode === 'original') return 1;
    return mode === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  }
  // [start, end) of a transition on the timeline.
  function transitionRange(x) {
    if (x.align === 'start') return [x.at, x.at + x.duration];
    if (x.align === 'end') return [x.at - x.duration, x.at];
    return [x.at - x.duration / 2, x.at + x.duration / 2];
  }
  // The source time of a clip at timeline time t, past its ends too (a transition shows the handles beyond in/out,
  // or holds the last frame there is).
  function extendedSourceTime(clip, t, duration) {
    if (clip.source?.freeze) return clip.in;
    if (clip.remap) return Math.max(0, Math.min(need('remap').sourceAt(clip.remap, t - clip.start), Math.max(0, duration - 1)));
    const along = (t - clip.start) * clip.speed;
    const v = clip.reverse ? clip.out - along - 1 : clip.in + along;
    return Math.max(0, Math.min(v, Math.max(0, duration - 1)));
  }

  // How much source a transition needs beyond what its clips have (ticks of timeline time): the timeline stripes such
  // a transition and the compositor repeats the last frame there is. { a: outgoing clip, b: incoming clip }.
  function missingHandles(project, seq, tn) {
    const model = need('model');
    const [ts, te] = transitionRange(tn);
    const clips = seq.clips.filter((c) => c.track === tn.track);
    const A = clips.find((c) => model.clipEnd(c) === tn.at);
    const B = clips.find((c) => c.start === tn.at);
    const short = (clip, t) => {
      const m = clip && model.mediaOf(project, clip);
      if (!m || m.kind === 'image' || clip.source?.freeze) return 0;
      if (clip.remap) {
        const R = need('remap');
        const v = R.value(clip.remap, t - clip.start);
        return Math.max(0, v - m.duration, -v) / (Math.abs(R.speedAt(clip.remap, t - clip.start)) || 1);
      }
      const along = (t - clip.start) * clip.speed;
      const v = clip.reverse ? clip.out - along : clip.in + along;
      return Math.max(0, v - m.duration, -v) / clip.speed;
    };
    return { a: A ? short(A, te) : 0, b: B ? short(B, ts) : 0 };
  }

  // Everything the back ends need to draw an item, values at t. kind: 'video' | 'image' | 'text' | 'solid' |
  // 'adjustment' | 'nest'. scope: the ids of the nest clips the item is drawn inside, each ending in '/'.
  function planItem(project, seq, clip, t, extended, scope = '') {
    const model = need('model');
    const kf = need('keyframes');
    const fx = need('effects');
    const local = t - clip.start;
    const media = model.mediaOf(project, clip);
    const p = clip.props || {};
    const prop = (name, fallback) => kf.propValue(clip, name, local, p[name] ?? fallback);
    const effects = [];
    for (const e of clip.effects || []) {
      if (e.on === false) continue;
      const def = fx.get(e.type);
      if (!def || def.kind !== 'video') continue;
      const params = {};
      for (const pd of def.params) params[pd.id] = kf.propValue(clip, `effects.${e.id}.${pd.id}`, local, e.params?.[pd.id] ?? pd.default);
      const resolved = fx.resolve(e.type, params);
      // What an effect reads from the project besides its parameters (Lumetri Color's LUT), as info.assets.
      const masks = e.masks?.length && def.masks !== false ? need('masks').at(clip, `effects.${e.id}.masks`, e.masks, local) : null;
      effects.push({ id: e.id, def, params: resolved, assets: def.assets ? def.assets(project, resolved) : null, masks });
    }
    let kind;
    let srcT = 0;
    let sequence = null;
    let layers = null;
    const nest = model.nestOf(project, clip);
    let blend = null;
    if (media) {
      kind = media.kind === 'image' ? 'image' : 'video';
      srcT = extended ? extendedSourceTime(clip, t, media.duration) : model.sourceTime(clip, t);
      if (kind === 'video') blend = blendOf(clip, media, srcT);
    } else if (nest) {
      kind = 'nest';
      srcT = extended ? extendedSourceTime(clip, t, model.sequenceDuration(nest)) : model.sourceTime(clip, t);
      sequence = nest;
      layers = plan(project, nest, srcT, `${scope}${clip.id}/`);
    } else kind = model.isNest(clip) ? 'empty' : clip.source?.generator || 'solid';
    return {
      clip, media, kind, local, srcT, blend, effects, sequence, layers, key: `${scope}${clip.id}`, seqW: seq.w, seqH: seq.h,
      position: prop('position', [0, 0]), scale: prop('scale', [100, 100]), rotation: prop('rotation', 0),
      anchor: prop('anchor', [0, 0]), opacity: prop('opacity', 100), crop: prop('crop', ZERO4),
      extend: effects.some((e) => e.def.layer?.extend),
      masks: clip.masks?.length ? need('masks').at(clip, 'masks', clip.masks, local) : null,
      // The clip-local frame, for effects whose look changes every frame (grain, glitch).
      // Not `frame`: fetchItem puts the decoded VideoFrame there, and grain and glitch on video then read NaN.
      frameIndex: seq.fps ? need('time').frameAt(local, seq.fps) : 0,
    };
  }

  // Frame Blending (clip.sampling 'blend', Premiere's Time Interpolation): a source time between two frames of the
  // file shows the next frame over the one before by how far it is along: { srcT: the next frame's time, w: 0..1 }.
  // Null on a frame (within a thousandth), for Frame Sampling, and for a file of no constant rate. A nest is drawn at
  // its time (its sequence has no frames to mix).
  function blendOf(clip, media, srcT) {
    if (clip.sampling !== 'blend' || !media.video?.fps || media.video.vfr) return null;
    const fd = need('time').frameTicks(media.video.fps);
    const k = Math.floor(srcT / fd + 1e-9);
    const w = srcT / fd - k;
    if (w < 1e-3 || w > 1 - 1e-3 || (k + 1) * fd >= media.duration) return null;
    return { srcT: (k + 1) * fd, w };
  }

  // The layers of a sequence at t, bottom first: { kind: 'clip', item } | { kind: 'transition', def, progress, a, b }.
  function plan(project, seq, t, scope = '') {
    const model = need('model');
    const fx = need('effects');
    const layers = [];
    for (const track of seq.tracks) {
      if (track.kind !== 'video' || track.visible === false) continue;
      const clips = seq.clips.filter((c) => c.track === track.id && c.enabled !== false);
      const tn = (seq.transitions || []).find((x) => {
        if (x.track !== track.id) return false;
        const [a, b] = transitionRange(x);
        return t >= a && t < b;
      });
      const def = tn && fx.get(tn.type);
      if (tn && def && def.kind === 'video') {
        const A = clips.find((c) => model.clipEnd(c) === tn.at) || null;
        const B = clips.find((c) => c.start === tn.at) || null;
        if (A || B) {
          const [a, b] = transitionRange(tn);
          layers.push({
            kind: 'transition', transition: tn, def, params: fx.resolve(tn.type, tn.params || {}), progress: Math.max(0, Math.min(1, (t - a) / (b - a))),
            a: A && planItem(project, seq, A, t, true, scope), b: B && planItem(project, seq, B, t, true, scope),
          });
          continue;
        }
      }
      const c = clips.find((x) => x.start <= t && t < model.clipEnd(x));
      if (c) layers.push({ kind: 'clip', item: planItem(project, seq, c, t, false, scope) });
    }
    return layers.filter((l) => (l.kind === 'clip' ? l.item.kind !== 'adjustment' && l.item.kind !== 'empty' : true));
  }

  // Caption tracks to burn in: opts.captions true = the first track, a track id, or a list of ids. `t` goes along at
  // the start of its frame, so the word lit while playing (any t inside a frame) is the one exported for that frame.
  function captionsAt(seq, t, which) {
    if (!which) return [];
    const tracks = seq.captions || [];
    const chosen = which === true ? tracks.slice(0, 1) : tracks.filter((c) => (Array.isArray(which) ? which.includes(c.id) : c.id === which));
    const ft = seq.fps ? need('time').snap(t, seq.fps) : t;
    return chosen.map((c) => ({ style: c.style, t: ft, items: (c.items || []).filter((it) => it.start <= t && t < it.end) })).filter((c) => c.items.length);
  }

  // A sequence that shows one media file at its own size, for the source monitor.
  function mediaSequence(project, mediaId) {
    const model = need('model');
    const m = project.media.find((x) => x.id === mediaId);
    const w = m?.video?.w || 1920;
    const h = m?.video?.h || 1080;
    const seq = model.createSequence({ id: '__source', w, h, fps: m?.video?.fps || [30, 1], videoTracks: 1, audioTracks: 0 });
    if (m && (m.video || m.kind === 'image')) {
      const clip = model.createClip('video', { id: `__source:${mediaId}`, track: 'V1', start: 0, in: 0, out: Math.max(m.duration || 0, need('time').TICKS * 3600), source: { media: mediaId } });
      seq.clips.push(clip);
    }
    return seq;
  }

  // ---- sources shared by both back ends ----------------------------------------------------------------------------

  // Frame sources per clip, LRU by the render that last used them.
  function sourcePool({ hardware }) {
    const pool = new Map(); // clipId|path -> { src, used, at }
    let tick = 0;
    // A paused monitor, or one whose project was replaced, renders no more, so the sweep by renders never comes: the
    // decoders it kept (a 4K one holds 8 hardware frames) made a proxy job six times slower. A source that neither the
    // last render nor the one under way used, for IDLE_MS, closes on a timer; the timer runs while the pool has any.
    const IDLE_MS = 3000;
    let timer = null;
    function idleCheck() {
      const now = performance.now();
      for (const [k, e] of pool) {
        if (e.used < tick - 1 && now - e.at > IDLE_MS) {
          e.src.close();
          pool.delete(k);
        }
      }
      if (!pool.size) { clearInterval(timer); timer = null; }
    }
    return {
      get(itemKey, opened) {
        const key = `${itemKey}|${opened.path}`;
        let e = pool.get(key);
        if (!e) {
          e = { src: need('decoder').createFrameSource(opened, opened.video, { hardware }), used: tick, at: 0 };
          pool.set(key, e);
        }
        e.used = tick;
        e.at = performance.now();
        if (!timer) { timer = setInterval(idleCheck, 1000); timer.unref?.(); }
        return e.src;
      },
      // Called once a render: closes sources unused for `idle` renders, and the oldest beyond `max`.
      sweep(idle = 120, max = 12) {
        tick++;
        const list = [...pool.entries()].sort((a, b) => a[1].used - b[1].used);
        for (const [k, e] of list) {
          if (tick - e.used > idle || pool.size > max) {
            e.src.close();
            pool.delete(k);
          }
        }
      },
      get size() { return pool.size; },
      stats: () => [...pool.values()].map((e) => e.src.stats()),
      close() {
        clearInterval(timer);
        timer = null;
        for (const e of pool.values()) e.src.close();
        pool.clear();
      },
    };
  }

  function newCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c;
  }
  // A red frame with a message, for media that is offline or cannot be decoded.
  function errorCanvas(W, H, k, message) {
    const c = newCanvas(Math.round(W * k), Math.round(H * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#c62828';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.max(10, Math.round(H * k * 0.06))}px "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, c.width / 2, c.height / 2);
    return c;
  }

  // Resolves what each item shows: a VideoFrame (to release), an ImageBitmap, a canvas, or a color. Returns the list
  // of frames to release once drawn; an item that cannot be shown becomes a red frame and is listed in ctx.failed
  // ({clip, name, media, missing, error}), so an export can tell a slate it was asked for from one it was not.
  async function fetchSources(project, seq, layers, ctx) {
    const media = need('media');
    const textrender = need('textrender');
    const frames = [];
    const items = [];
    const collect = (list) => {
      for (const l of list) {
        for (const it of l.kind === 'clip' ? [l.item] : [l.a, l.b]) {
          if (!it) continue;
          items.push(it);
          if (it.kind === 'nest') collect(it.layers);
        }
      }
    };
    collect(layers);
    const fail = (it, message, cause = null) => {
      ctx.failed?.push({ clip: it.clip?.id ?? null, name: it.clip?.name || '', media: it.clip?.source?.media ?? null, missing: cause?.code === 'missing', error: String(cause?.message || cause?.detail || message) });
      it.kind = 'error';
      it.canvas = errorCanvas(it.seqW, it.seqH, ctx.k, message);
      it.w = it.seqW;
      it.h = it.seqH;
    };
    await Promise.all(items.map((it) => fetchItem(it).catch((err) => fail(it, tr('Media Cannot Be Shown'), err))));
    async function fetchItem(it) {
      const W = it.seqW;
      const H = it.seqH;
      if (it.kind === 'solid') {
        it.color = need('effects').hexToLinear(it.clip.source?.color || '#ffffff');
        it.w = W;
        it.h = H;
        return;
      }
      if (it.kind === 'text') {
        const layersOf = it.clip.source?.layers || [];
        await textrender.prepare(layersOf);
        it.canvas = ctx.textCanvas(it, W, H);
        it.w = W;
        it.h = H;
        return;
      }
      if (it.kind === 'graphic') {
        const fonts = need('graphic').fontsOf(it.clip.source?.layers);
        if (fonts.length) await textrender.prepare(fonts);
        it.canvas = ctx.graphicCanvas(it, W, H);
        it.w = W;
        it.h = H;
        return;
      }
      if (it.kind === 'nest') {
        const fit = fitScale(it.sequence.w, it.sequence.h, W, H, project.settings?.fit);
        it.w = it.sequence.w * fit;
        it.h = it.sequence.h * fit;
        return;
      }
      let o = await media.open(project, it.clip.source.media, { proxy: !!ctx.proxy });
      if (o.error || (it.kind === 'video' && !o.video) || (it.kind === 'image' && !o.image)) return fail(it, o.error?.code === 'missing' ? tr('Media Offline') : tr('Media Cannot Be Shown'), o.error);
      const place = () => {
        const fit = fitScale(o.width, o.height, W, H, project.settings?.fit);
        it.w = o.width * fit;
        it.h = o.height * fit;
        it.rotation0 = o.rotation || 0;
      };
      place();
      if (it.kind === 'image') {
        it.bitmap = o.image;
        it.path = o.path;
        return;
      }
      let src = ctx.sources.get(it.key, o);
      let frame;
      try {
        frame = await src.frameAt(it.srcT);
      } catch (err) {
        // A proxy file that went away while open (the cache was cleared): the original plays instead.
        if (!o.proxy) throw err;
        media.forget(o.path);
        o = await media.open(project, it.clip.source.media, { proxy: false });
        if (o.error || !o.video) return fail(it, o.error?.code === 'missing' ? tr('Media Offline') : tr('Media Cannot Be Shown'), o.error);
        place();
        src = ctx.sources.get(it.key, o);
        frame = await src.frameAt(it.srcT);
      }
      const from = src;
      it.frame = frame;
      // Frame Blending's second frame, from the same stream (the next one after `frame`)
      const second = it.blend ? await from.frameAt(it.blend.srcT).catch(() => null) : null;
      it.frameB = second;
      it.release = () => { from.release(frame); if (second) from.release(second); };
      frames.push(it);
    }
    return frames;
  }
  const releaseAll = (items) => { for (const it of items) { try { it.release?.(); } catch {} it.release = null; } };

  // Text clip canvases, kept while the clip's layers and their values at t stay the same.
  function textCache() {
    const cache = new Map();
    return (it, W, H, k) => {
      const textrender = need('textrender');
      const layers = (it.clip.source?.layers || []).map((l) => textrender.resolveLayer(l, it.clip, it.local));
      const key = JSON.stringify([layers, k, W, H]);
      const hit = cache.get(it.key);
      if (hit && hit.key === key) return hit.canvas;
      const c = hit && hit.canvas.width === Math.round(W * k) && hit.canvas.height === Math.round(H * k) ? hit.canvas : newCanvas(Math.round(W * k), Math.round(H * k));
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      textrender.draw(ctx, layers, { w: W, h: H, scale: k });
      cache.set(it.key, { key, canvas: c });
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return c;
    };
  }
  // Graphic clip canvases (graphic.js), kept while the layers' values at t stay the same (particles move every frame).
  function graphicCache() {
    const cache = new Map();
    return (it, W, H, k) => {
      const graphic = need('graphic');
      const source = it.clip.source?.layers || [];
      const layers = source.map((l) => graphic.resolve(l, it.clip, it.local));
      const sec = it.local / need('time').TICKS;
      const key = JSON.stringify([layers, k, W, H, graphic.hasParticles(layers, sec) ? sec : 0]);
      const hit = cache.get(it.key);
      if (hit && hit.key === key) return hit.canvas;
      const c = hit && hit.canvas.width === Math.round(W * k) && hit.canvas.height === Math.round(H * k) ? hit.canvas : newCanvas(Math.round(W * k), Math.round(H * k));
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      try { graphic.draw(ctx, layers, { w: W, h: H, scale: k, t: sec }); } catch (err) { console.warn('a graphic clip failed to draw', err); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      cache.set(it.key, { key, canvas: c });
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return c;
    };
  }
  function drawOverlays(ctx, overlays, W, H, k) {
    for (const o of [].concat(overlays || [])) {
      if (typeof o === 'function') { o(ctx, { w: W, h: H, scale: k }); continue; }
      if (o !== 'safe') continue;
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1 / k;
      for (const f of [0.93, 0.9]) ctx.strokeRect((W * (1 - f)) / 2, (H * (1 - f)) / 2, W * f, H * f);
      ctx.restore();
    }
  }

  // ---- WebGPU back end ---------------------------------------------------------------------------------------------

  const SRGB_WGSL = /* wgsl */ `
fn toLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn toSrgb(c: vec3f) -> vec3f { return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)); }
// The source uv a display uv comes from, for a frame that must turn rot.x quarter turns clockwise to be upright.
fn turn(uv: vec2f, q: f32) -> vec2f {
  if (q > 2.5) { return vec2f(1.0 - uv.y, uv.x); }
  if (q > 1.5) { return vec2f(1.0 - uv.x, 1.0 - uv.y); }
  if (q > 0.5) { return vec2f(uv.y, 1.0 - uv.x); }
  return uv;
}
`;
  function shaders(fx) {
    const V = fx.wgsl.VERTEX;
    return {
      decodeExternal: /* wgsl */ `
struct DU { rot: vec4f };
@group(0) @binding(0) var ext: texture_external;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: DU;
${V}${SRGB_WGSL}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let c = textureSampleBaseClampToEdge(ext, samp, turn(v.uv, u.rot.x));
  // rot.y: the weight of a Frame Blending frame drawn over the one before (0: an opaque frame)
  let a = select(1.0, u.rot.y, u.rot.y > 0.0);
  return vec4f(toLinear(clamp(c.rgb, vec3f(0.0), vec3f(1.0))) * a, a);
}`,
      decodeImage: /* wgsl */ `
struct DU { rot: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: DU;
${V}${SRGB_WGSL}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(src, samp, turn(v.uv, u.rot.x), 0.0);
  return vec4f(toLinear(c.rgb) * c.a, c.a);
}`,
      composite: /* wgsl */ `
struct CU { frame: vec4f, rot: vec4f, layer: vec4f, crop: vec4f, misc: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: CU;
${V}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let D = v.uv * u.frame.xy - u.frame.xy * 0.5 - u.frame.zw;
  let R = vec2f(u.rot.x * D.x + u.rot.y * D.y, -u.rot.y * D.x + u.rot.x * D.y);
  let Q = R * u.rot.zw + u.layer.xy * 0.5 + u.layer.zw;
  var luv = Q / u.layer.xy;
  let lo = u.crop.xy;
  let hi = vec2f(1.0) - u.crop.zw;
  if (hi.x <= lo.x || hi.y <= lo.y) { return vec4f(0.0); }
  var cover = 1.0;
  if (u.misc.y > 0.5) {
    luv = clamp(luv, lo, hi);
  } else {
    let dl = (luv - lo) * u.layer.xy;
    let dh = (hi - luv) * u.layer.xy;
    cover = clamp(min(min(dl.x, dl.y), min(dh.x, dh.y)) * u.misc.z + 0.5, 0.0, 1.0);
    if (cover <= 0.0) { return vec4f(0.0); }
  }
  return textureSampleLevel(src, samp, luv, 0.0) * (u.misc.x * cover);
}`,
      final: /* wgsl */ `
struct OU { box: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: OU;
${V}${SRGB_WGSL}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  if (v.uv.x < u.box.x || v.uv.y < u.box.y || v.uv.x > u.box.z || v.uv.y > u.box.w) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let c = textureSampleLevel(src, samp, (v.uv - u.box.xy) / (u.box.zw - u.box.xy), 0.0);
  return vec4f(toSrgb(clamp(c.rgb, vec3f(0.0), vec3f(1.0))), 1.0);
}`,
      blit: /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
${V}
@fragment fn fs(v: VOut) -> @location(0) vec4f { return textureSampleLevel(src, samp, v.uv, 0.0); }`,
    };
  }

  const OVER = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
  const F16 = 'rgba16float';

  async function createGpu(canvas, opts) {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference: opts.powerPreference || 'high-performance' }).catch(() => null);
    if (!adapter) return null;
    const device = await adapter.requestDevice().catch(() => null);
    if (!device) return null;
    const fx = need('effects');
    const U = globalThis.GPUTextureUsage;
    const B = globalThis.GPUBufferUsage;
    const context = canvas ? canvas.getContext('webgpu') : null;
    if (canvas && !context) { device.destroy(); return null; }
    const canvasFormat = gpu.getPreferredCanvasFormat();
    if (context) context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    let lost = null;
    device.lost.then((info) => { lost = info; });
    const errors = [];
    device.addEventListener?.('uncapturederror', (e) => { if (errors.length < 20) errors.push(e.error?.message || String(e.error)); });
    const info = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : {};
    const maxDim = device.limits.maxTextureDimension2D || 8192;
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const src = shaders(fx);
    const pipes = new Map();
    function pipeline(key, code, format, blend) {
      const k = `${key}|${format}|${blend ? 'over' : 'copy'}`;
      let p = pipes.get(k);
      if (p) return p;
      const module = device.createShaderModule({ code });
      p = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format, ...(blend ? { blend } : {}) }] },
        primitive: { topology: 'triangle-list' },
      });
      pipes.set(k, p);
      return p;
    }

    // Textures by size and format, reused across frames (queue order makes reuse after submit safe).
    const free = new Map();
    const inUse = [];
    let frameNo = 0;
    function texture(w, h, format = F16, usage = U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC | U.COPY_DST) {
      const key = `${w}x${h}|${format}|${usage}`;
      const list = free.get(key);
      const t = list?.pop() || { tex: device.createTexture({ size: [w, h], format, usage }), key };
      t.used = frameNo;
      inUse.push(t);
      return t.tex;
    }
    function recycle() {
      for (const t of inUse.splice(0)) {
        if (!free.has(t.key)) free.set(t.key, []);
        free.get(t.key).push(t);
      }
      for (const [k, list] of free) {
        const keep = list.filter((t) => frameNo - t.used < 90);
        for (const t of list) if (!keep.includes(t)) t.tex.destroy();
        if (keep.length) free.set(k, keep); else free.delete(k);
      }
    }

    // Uniform slots of 256 bytes in one buffer, written once a frame.
    let ubuf = null;
    let ucap = 0;
    function uniforms(slots) {
      const need2 = Math.max(1, slots.length) * 256;
      if (need2 > ucap) {
        const old = ubuf;
        ucap = Math.max(need2, ucap * 2, 64 * 256);
        ubuf = device.createBuffer({ size: ucap, usage: B.UNIFORM | B.COPY_DST });
        if (old) device.queue.onSubmittedWorkDone().then(() => old.destroy());
      }
      const data = new Float32Array(need2 / 4);
      slots.forEach((s, i) => data.set(s.subarray ? s.subarray(0, 64) : s.slice(0, 64), i * 64));
      device.queue.writeBuffer(ubuf, 0, data);
      return (i) => ({ buffer: ubuf, offset: i * 256, size: 256 });
    }

    // The masks' data of a frame in one storage buffer, each list at a 256-byte offset.
    let sbuf = null;
    let scap = 0;
    function storage(lists) {
      const offsets = [];
      let at = 0;
      for (const l of lists) { offsets.push(at); at += Math.ceil(Math.max(16, l.byteLength) / 256) * 256; }
      if (at > scap) {
        const old = sbuf;
        scap = Math.max(at, scap * 2, 64 * 1024);
        sbuf = device.createBuffer({ size: scap, usage: B.STORAGE | B.COPY_DST });
        if (old) device.queue.onSubmittedWorkDone().then(() => old.destroy());
      }
      const data = new Float32Array(at / 4);
      lists.forEach((l, i) => data.set(l, offsets[i] / 4));
      device.queue.writeBuffer(sbuf, 0, data);
      return (i) => ({ buffer: sbuf, offset: offsets[i], size: Math.ceil(Math.max(16, lists[i].byteLength) / 16) * 16 });
    }

    // Images stay on the GPU while used (rgba8unorm, not premultiplied).
    const images = new Map();
    function imageTexture(it) {
      const key = it.path;
      let e = images.get(key);
      if (!e || e.bitmap !== it.bitmap) {
        e?.tex.destroy();
        const tex = device.createTexture({ size: [it.bitmap.width, it.bitmap.height], format: 'rgba8unorm', usage: U.TEXTURE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT });
        device.queue.copyExternalImageToTexture({ source: it.bitmap }, { texture: tex, premultipliedAlpha: false }, [it.bitmap.width, it.bitmap.height]);
        e = { tex, bitmap: it.bitmap };
        images.set(key, e);
        while (images.size > 32) {
          const [k, old] = images.entries().next().value;
          images.delete(k);
          old.tex.destroy();
        }
      } else {
        images.delete(key);
        images.set(key, e);
      }
      return e.tex;
    }
    function canvasTexture(c) {
      const tex = texture(c.width, c.height, 'rgba8unorm');
      device.queue.copyExternalImageToTexture({ source: c }, { texture: tex, premultipliedAlpha: false }, [c.width, c.height]);
      return tex;
    }

    // Tables an effect reads besides its input (gpu.bindings / gpu.textures: Lumetri Color's LUT and curves), rgba16float,
    // one texture per key while used; a binding the effect leaves empty gets a small dummy of its dimension.
    const tables = new Map(); // key -> { tex, used }
    const dummies = {};
    function dummy(dim) {
      if (!dummies[dim]) {
        const size = dim === '3d' ? [2, 2, 2] : [2, 1, 1];
        dummies[dim] = device.createTexture({ size, dimension: dim === '3d' ? '3d' : '2d', format: F16, usage: U.TEXTURE_BINDING | U.COPY_DST });
        device.queue.writeTexture({ texture: dummies[dim] }, new Uint16Array(size[0] * size[1] * size[2] * 4), { bytesPerRow: size[0] * 8, rowsPerImage: size[1] }, size);
      }
      return dummies[dim];
    }
    function effectTextures(g, params, finfo) {
      const specs = g.textures ? g.textures(params, finfo) || {} : {};
      return Object.entries(g.bindings).map(([b, dim]) => {
        const s = specs[b];
        if (!s) return [Number(b), dummy(dim)];
        let e = tables.get(s.key);
        if (!e) {
          const size = s.size.length === 3 ? s.size : [s.size[0], s.size[1], 1];
          const tex = device.createTexture({ size, dimension: s.dim === '3d' ? '3d' : '2d', format: F16, usage: U.TEXTURE_BINDING | U.COPY_DST });
          device.queue.writeTexture({ texture: tex }, s.data(), { bytesPerRow: size[0] * 8, rowsPerImage: size[1] }, size);
          e = { tex };
          tables.set(s.key, e);
        }
        e.used = frameNo;
        return [Number(b), e.tex];
      });
    }
    // After a submit: tables beyond the last 24 that this frame did not use go.
    function sweepTables() {
      for (const [k, e] of tables) {
        if (tables.size <= 24) break;
        if (e.used !== frameNo) { e.tex.destroy(); tables.delete(k); }
      }
    }

    // The Lumetri Scopes' counts (scopes.js) of what `out` shows now: a compute pass over the frame's box, its bins
    // copied to a buffer that is read back. One count at a time (null while one is under way).
    let scopeBuf = null;
    let scopeRead = null;
    let scopeU = null;
    let scopePipe = null;
    let scopeBusy = false;
    function scopes({ seqW, seqH, cols, size, budget }) {
      if (!out || scopeBusy) return null;
      const S = need('scopes');
      const L = S.layout(cols, size);
      const rect = S.frameRect(outW, outH, seqW, seqH);
      const step = S.stepFor(rect, budget);
      const bytes = L.total * 4;
      if (!scopeBuf || scopeBuf.size !== bytes) {
        scopeBuf?.destroy();
        scopeRead?.destroy();
        scopeBuf = device.createBuffer({ size: bytes, usage: B.STORAGE | B.COPY_SRC | B.COPY_DST });
        scopeRead = device.createBuffer({ size: bytes, usage: B.MAP_READ | B.COPY_DST });
      }
      if (!scopeU) scopeU = device.createBuffer({ size: 48, usage: B.UNIFORM | B.COPY_DST });
      if (!scopePipe) {
        const module = device.createShaderModule({ code: S.WGSL });
        scopePipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      }
      device.queue.writeBuffer(scopeU, 0, S.uniforms(rect, L, step));
      const enc = device.createCommandEncoder();
      enc.clearBuffer(scopeBuf);
      const [gx, gy] = S.dispatch(rect, step);
      if (gx > 0 && gy > 0) {
        const pass = enc.beginComputePass();
        pass.setPipeline(scopePipe);
        pass.setBindGroup(0, device.createBindGroup({ layout: scopePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: out.createView() }, { binding: 1, resource: { buffer: scopeBuf } }, { binding: 2, resource: { buffer: scopeU } }] }));
        pass.dispatchWorkgroups(gx, gy);
        pass.end();
      }
      enc.copyBufferToBuffer(scopeBuf, 0, scopeRead, 0, bytes);
      device.queue.submit([enc.finish()]);
      scopeBusy = true;
      const read = scopeRead;
      const meta = { layout: L, rect, step, width: outW, height: outH, backend: 'webgpu' };
      return read.mapAsync(GPUMapMode.READ).then(() => {
        const bins = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        return { bins, ...meta };
      }).finally(() => { scopeBusy = false; });
    }

    let out = null;
    let outW = 0;
    let outH = 0;
    let width = opts.width || canvas?.width || 1920;
    let height = opts.height || canvas?.height || 1080;
    if (canvas) { canvas.width = width; canvas.height = height; }

    // Builds and submits one frame. Everything from importing the frames to submit happens in one task: external
    // textures expire at the end of the task.
    function encodeFrame(seq, layers, captions, q, opts2, textCanvasFor) {
      const W = Math.max(1, Math.round(seq.w * q));
      const H = Math.max(1, Math.round(seq.h * q));
      const ops = [];
      const slots = [];
      const slot = (arr) => { slots.push(arr instanceof Float32Array ? arr : Float32Array.from(arr)); return slots.length - 1; };
      const mslots = [];
      const mslot = (arr) => { mslots.push(arr); return mslots.length - 1; };
      const fitDim = (w, h) => {
        let tw = Math.max(1, Math.round(w * q));
        let th = Math.max(1, Math.round(h * q));
        const s = Math.min(1, maxDim / tw, maxDim / th);
        if (s < 1) { tw = Math.max(1, Math.floor(tw * s)); th = Math.max(1, Math.floor(th * s)); }
        return [tw, th];
      };

      // An item's picture with its effects, as an rgba16float texture of its layer size (a nest's: its sequence's
      // layers drawn into it).
      function itemTexture(it) {
        const sized = it.kind === 'video' || it.kind === 'image' || it.kind === 'nest';
        const [tw, th] = sized ? fitDim(it.w, it.h) : [Math.max(1, Math.round(it.seqW * q)), Math.max(1, Math.round(it.seqH * q))];
        let cur = texture(tw, th);
        const rot = [((it.rotation0 || 0) / 90) % 4, 0, 0, 0];
        if (it.kind === 'video') {
          ops.push({ op: 'decodeExternal', frame: it.frame, out: cur, u: slot(rot) });
          if (it.frameB) ops.push({ op: 'decodeExternal', frame: it.frameB, out: cur, u: slot([rot[0], it.blend.w, 0, 0]), over: true });
        }
        else if (it.kind === 'image') ops.push({ op: 'decodeImage', src: imageTexture(it), out: cur, u: slot(rot) });
        else if (it.kind === 'nest') layersInto(it.layers, cur, tw, th, null);
        else if (it.kind === 'solid') {
          const c = it.color;
          ops.push({ op: 'clear', out: cur, color: { r: c[0] * c[3], g: c[1] * c[3], b: c[2] * c[3], a: c[3] } });
        } else ops.push({ op: 'decodeImage', src: canvasTexture(it.canvas), out: cur, u: slot([0, 0, 0, 0]) });
        const pxScale = tw / Math.max(1e-6, it.w);
        for (const e of it.effects) {
          const g = e.def.gpu;
          if (!g?.code) continue;
          const finfo = { width: tw, height: th, pxScale, quality: q, frame: it.frameIndex || 0, assets: e.assets };
          const passes = g.uniforms(e.params, finfo) || [];
          const orig = cur;
          const tex = passes.length && g.bindings ? effectTextures(g, e.params, finfo) : null;
          for (const pass of passes) {
            const next = texture(tw, th);
            const data = new Float32Array(20);
            data.set([tw, th, 1 / tw, 1 / th], 0);
            data.set(pass.slice(0, 16), 4);
            ops.push({ op: 'effect', type: e.def.type, code: g.code, src: cur, orig, out: next, u: slot(data), tex });
            cur = next;
          }
          if (e.masks && cur !== orig) cur = masked(cur, orig, e.masks, tw, th, pxScale, 1);
        }
        if (it.masks) cur = masked(cur, cur, it.masks, tw, th, pxScale, 0);
        return cur;
      }
      // A mask pass (masks.js): keep inside the masks, under (weight `under`: 1 an effect's input, 0 transparent)
      // outside.
      function masked(keep, underTex, masks, tw, th, pxScale, under) {
        const out = texture(tw, th);
        ops.push({ op: 'mask', keep, under: underTex, out, u: slot([tw, th, 1 / tw, 1 / th, under, 0, 0, 0]), data: mslot(need('masks').gpuData(masks, tw, th, pxScale)) });
        return out;
      }
      function placeUniforms(it) {
        const sx = (it.scale?.[0] ?? 100) / 100;
        const sy = (it.scale?.[1] ?? 100) / 100;
        const safe = (v) => (Math.abs(v) < 1e-6 ? (v < 0 ? -1e-6 : 1e-6) : v);
        const a = ((it.rotation || 0) * Math.PI) / 180;
        const crop = it.crop || ZERO4;
        // props.crop is [top, right, bottom, left]; the shader takes (left, top, right, bottom).
        return slot([
          it.seqW, it.seqH, it.position?.[0] || 0, it.position?.[1] || 0,
          Math.cos(a), Math.sin(a), 1 / safe(sx), 1 / safe(sy),
          it.w, it.h, it.anchor?.[0] || 0, it.anchor?.[1] || 0,
          (crop[3] || 0) / 100, (crop[0] || 0) / 100, (crop[1] || 0) / 100, (crop[2] || 0) / 100,
          Math.max(0, Math.min(1, (it.opacity ?? 100) / 100)), it.extend ? 1 : 0, Math.max(1e-6, Math.min(Math.abs(sx), Math.abs(sy))) * q, 0,
        ]);
      }

      // A sequence's layers over the target texture (tw x th): cleared to its background, or to transparent inside a nest.
      function layersInto(layers, target, tw, th, background) {
        const bg = background ? need('effects').hexToLinear(background) : null;
        ops.push({ op: 'clear', out: target, color: bg ? { r: bg[0], g: bg[1], b: bg[2], a: 1 } : { r: 0, g: 0, b: 0, a: 0 } });
        for (const l of layers) {
          if (l.kind === 'clip') {
            const tex = itemTexture(l.item);
            ops.push({ op: 'composite', src: tex, out: target, u: placeUniforms(l.item), blend: true });
            continue;
          }
          const ta = texture(tw, th);
          const tb = texture(tw, th);
          ops.push({ op: 'clear', out: ta, color: { r: 0, g: 0, b: 0, a: 0 } });
          ops.push({ op: 'clear', out: tb, color: { r: 0, g: 0, b: 0, a: 0 } });
          if (l.a) ops.push({ op: 'composite', src: itemTexture(l.a), out: ta, u: placeUniforms(l.a), blend: true });
          if (l.b) ops.push({ op: 'composite', src: itemTexture(l.b), out: tb, u: placeUniforms(l.b), blend: true });
          const data = new Float32Array(20);
          data.set([tw, th, 1 / tw, 1 / th], 0);
          data.set(l.def.gpu.uniforms(l.params, l.progress).slice(0, 16), 4);
          ops.push({ op: 'transition', type: l.def.type, code: l.def.gpu.code, a: ta, b: tb, out: target, u: slot(data) });
        }
      }

      const accum = texture(W, H);
      layersInto(layers, accum, W, H, seq.background || '#000000');
      if (captions.length || opts2.overlays) {
        const c = textCanvasFor(captions, opts2.overlays, W, H);
        const tex = itemTexture({ kind: 'canvas', canvas: c, effects: [], w: seq.w, h: seq.h, seqW: seq.w, seqH: seq.h });
        ops.push({ op: 'composite', src: tex, out: accum, u: placeUniforms({ w: seq.w, h: seq.h, seqW: seq.w, seqH: seq.h }), blend: true });
      }

      if (!out || outW !== width || outH !== height) {
        out?.destroy();
        out = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: U.RENDER_ATTACHMENT | U.COPY_SRC | U.TEXTURE_BINDING });
        outW = width;
        outH = height;
      }
      const fit = Math.min(width / seq.w, height / seq.h);
      const bw = (seq.w * fit) / width;
      const bh = (seq.h * fit) / height;
      const box = [(1 - bw) / 2, (1 - bh) / 2, (1 + bw) / 2, (1 + bh) / 2];
      ops.push({ op: 'final', src: accum, out, u: slot(box) });

      const uref = uniforms(slots);
      const mref = mslots.length ? storage(mslots) : null;
      const enc = device.createCommandEncoder();
      const view = (t) => t.createView();
      for (const o of ops) {
        if (o.op === 'clear') {
          enc.beginRenderPass({ colorAttachments: [{ view: view(o.out), loadOp: 'clear', storeOp: 'store', clearValue: o.color }] }).end();
          continue;
        }
        let p;
        let entries;
        let load = 'clear';
        if (o.op === 'decodeExternal') {
          p = pipeline('decodeExternal', src.decodeExternal, F16, o.over ? OVER : null);
          if (o.over) load = 'load';
          entries = [{ binding: 0, resource: device.importExternalTexture({ source: o.frame }) }, { binding: 1, resource: sampler }, { binding: 2, resource: uref(o.u) }];
        } else if (o.op === 'decodeImage') {
          p = pipeline('decodeImage', src.decodeImage, F16);
          entries = [{ binding: 0, resource: view(o.src) }, { binding: 1, resource: sampler }, { binding: 2, resource: uref(o.u) }];
        } else if (o.op === 'effect') {
          p = pipeline(`fx:${o.type}`, o.code, F16);
          entries = [{ binding: 0, resource: view(o.src) }, { binding: 1, resource: sampler }, { binding: 2, resource: uref(o.u) }, { binding: 3, resource: view(o.orig) }];
          if (o.tex) for (const [binding, t] of o.tex) entries.push({ binding, resource: view(t) });
        } else if (o.op === 'composite') {
          p = pipeline('composite', src.composite, F16, OVER);
          entries = [{ binding: 0, resource: view(o.src) }, { binding: 1, resource: sampler }, { binding: 2, resource: uref(o.u) }];
          load = 'load';
        } else if (o.op === 'transition') {
          p = pipeline(`tr:${o.type}`, o.code, F16, OVER);
          entries = [{ binding: 0, resource: view(o.a) }, { binding: 1, resource: view(o.b) }, { binding: 2, resource: sampler }, { binding: 3, resource: uref(o.u) }];
          load = 'load';
        } else if (o.op === 'mask') {
          p = pipeline('mask', need('masks').WGSL, F16);
          entries = [{ binding: 0, resource: view(o.keep) }, { binding: 1, resource: view(o.under) }, { binding: 2, resource: uref(o.u) }, { binding: 3, resource: mref(o.data) }];
        } else if (o.op === 'final') {
          p = pipeline('final', src.final, 'rgba8unorm');
          entries = [{ binding: 0, resource: view(o.src) }, { binding: 1, resource: sampler }, { binding: 2, resource: uref(o.u) }];
        }
        const bg2 = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries });
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: view(o.out), loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pass.setPipeline(p);
        pass.setBindGroup(0, bg2);
        pass.draw(3);
        pass.end();
      }
      if (context) {
        const p = pipeline('blit', src.blit, canvasFormat);
        const bg2 = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: out.createView() }, { binding: 1, resource: sampler }] });
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
        pass.setPipeline(p);
        pass.setBindGroup(0, bg2);
        pass.draw(3);
        pass.end();
      }
      device.queue.submit([enc.finish()]);
      sweepTables();
      frameNo++;
      recycle();
    }

    async function readPixels() {
      if (!out) return new Uint8Array(width * height * 4);
      const bpr = Math.ceil((outW * 4) / 256) * 256;
      const buf = device.createBuffer({ size: bpr * outH, usage: B.COPY_DST | B.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: out }, { buffer: buf, bytesPerRow: bpr }, [outW, outH]);
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const src2 = new Uint8Array(buf.getMappedRange());
      const res = new Uint8Array(outW * outH * 4);
      for (let y = 0; y < outH; y++) res.set(src2.subarray(y * bpr, y * bpr + outW * 4), y * outW * 4);
      buf.unmap();
      buf.destroy();
      return res;
    }

    return {
      backend: 'webgpu',
      info,
      device,
      errors,
      get lost() { return lost; },
      get width() { return width; },
      get height() { return height; },
      resize(w, h) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
        if (canvas) { canvas.width = width; canvas.height = height; }
      },
      encodeFrame,
      readPixels,
      scopes,
      done: () => device.queue.onSubmittedWorkDone(),
      destroy() {
        for (const list of free.values()) for (const t of list) t.tex.destroy();
        for (const t of inUse) t.tex.destroy();
        for (const e of images.values()) e.tex.destroy();
        for (const e of tables.values()) e.tex.destroy();
        for (const t of Object.values(dummies)) t.destroy();
        scopeBuf?.destroy();
        scopeRead?.destroy();
        scopeU?.destroy();
        out?.destroy();
        ubuf?.destroy();
        sbuf?.destroy();
        device.destroy();
      },
    };
  }

  // ---- Canvas 2D back end ------------------------------------------------------------------------------------------

  function create2d(canvas, opts) {
    const target = canvas || newCanvas(opts.width || 1920, opts.height || 1080);
    let width = opts.width || target.width || 1920;
    let height = opts.height || target.height || 1080;
    target.width = width;
    target.height = height;
    const ctx = target.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D context on this canvas');

    // An item's picture with the effects 2D can do, in a canvas of its layer size at scale k. An effect with masks is
    // drawn on its own and mixed over its input through the masks' coverage; Opacity's masks cut the result.
    function itemCanvas(it, k) {
      const lw = Math.max(1, Math.round(it.w * k));
      const lh = Math.max(1, Math.round(it.h * k));
      const hintOf = (e) => e.def.canvas2d?.(e.params, { width: lw, height: lh, pxScale: k, frame: it.frameIndex || 0 }) || {};
      let c;
      if (!it.effects.some((e) => e.masks)) c = paint(it, lw, lh, it.effects.map(hintOf));
      else {
        c = paint(it, lw, lh, []);
        for (const e of it.effects) {
          const h = hintOf(e);
          if (h.skip) continue;
          const next = paint({ kind: 'canvas', canvas: c }, lw, lh, [h]);
          c = e.masks ? mixThrough(c, next, e.masks, lw, lh, k) : next;
        }
      }
      if (it.masks) {
        const g = c.getContext('2d');
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(need('masks').canvasCoverage(it.masks, lw, lh, k, newCanvas), 0, 0);
        g.globalCompositeOperation = 'source-over';
      }
      return c;
    }
    // base outside the masks, top inside: top kept by the coverage plus base kept by its complement, added.
    function mixThrough(base, top, masks, lw, lh, k) {
      const cov = need('masks').canvasCoverage(masks, lw, lh, k, newCanvas);
      const out = newCanvas(lw, lh);
      const g = out.getContext('2d');
      g.drawImage(base, 0, 0);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(cov, 0, 0);
      const t = newCanvas(lw, lh);
      const tg = t.getContext('2d');
      tg.drawImage(top, 0, 0);
      tg.globalCompositeOperation = 'destination-in';
      tg.drawImage(cov, 0, 0);
      g.globalCompositeOperation = 'lighter';
      g.drawImage(t, 0, 0);
      g.globalCompositeOperation = 'source-over';
      return out;
    }
    // A picture (the item's source, or a canvas for one more effect) drawn with 2D hints into a new lw x lh canvas.
    function paint(it, lw, lh, hints) {
      const c = newCanvas(lw, lh);
      const g = c.getContext('2d');
      g.filter = hints.map((h) => h.filter).filter(Boolean).join(' ') || 'none';
      const flipX = hints.filter((h) => h.flipX).length % 2 === 1;
      const flipY = hints.filter((h) => h.flipY).length % 2 === 1;
      g.save();
      g.translate(lw / 2, lh / 2);
      g.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      const r = ((it.rotation0 || 0) * Math.PI) / 180;
      g.rotate(r);
      const turned = it.rotation0 === 90 || it.rotation0 === 270;
      const dw = turned ? lh : lw;
      const dh = turned ? lw : lh;
      if (it.kind === 'solid') {
        const [cr, cg, cb, ca] = it.color.map((v, i) => (i < 3 ? Math.round(need('effects').linearToSrgb(v) * 255) : v));
        g.fillStyle = `rgba(${cr},${cg},${cb},${ca})`;
        g.fillRect(-dw / 2, -dh / 2, dw, dh);
      } else {
        const source = it.kind === 'nest' ? nestCanvas(it, lw, lh) : it.frame || it.bitmap || it.canvas;
        if (source) g.drawImage(source, -dw / 2, -dh / 2, dw, dh);
        if (it.frameB) {
          g.globalAlpha = it.blend.w;
          g.drawImage(it.frameB, -dw / 2, -dh / 2, dw, dh);
          g.globalAlpha = 1;
        }
      }
      g.restore();
      g.filter = 'none';
      for (const h of hints) {
        if (h.mosaic) {
          const [bx, by] = h.mosaic;
          const small = newCanvas(bx, by);
          const sg = small.getContext('2d');
          sg.drawImage(c, 0, 0, bx, by);
          g.clearRect(0, 0, lw, lh);
          g.imageSmoothingEnabled = false;
          g.drawImage(small, 0, 0, lw, lh);
          g.imageSmoothingEnabled = true;
        }
        if (h.vignette) {
          const grad = g.createRadialGradient(lw / 2, lh / 2, Math.min(lw, lh) * 0.3, lw / 2, lh / 2, Math.hypot(lw, lh) / 2);
          const col = h.vignette < 0 ? '0,0,0' : '255,255,255';
          grad.addColorStop(0, `rgba(${col},0)`);
          grad.addColorStop(1, `rgba(${col},${Math.abs(h.vignette)})`);
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = grad;
          g.fillRect(0, 0, lw, lh);
          g.globalCompositeOperation = 'source-over';
        }
        if (h.crop) {
          const [t, rr, b, l] = h.crop.map((v) => v / 100);
          g.clearRect(0, 0, lw * l, lh);
          g.clearRect(lw * (1 - rr), 0, lw * rr, lh);
          g.clearRect(0, 0, lw, lh * t);
          g.clearRect(0, lh * (1 - b), lw, lh * b);
        }
      }
      return c;
    }
    // A nest's sequence drawn on a transparent canvas of lw x lh.
    function nestCanvas(it, lw, lh) {
      const c = newCanvas(lw, lh);
      const g = c.getContext('2d');
      const k = lw / it.sequence.w;
      g.setTransform(k, 0, 0, lh / it.sequence.h, 0, 0);
      drawLayers(g, it.sequence, it.layers, k, k);
      return c;
    }
    // Draws an item into a context whose transform maps sequence pixels.
    function place(g, it, k) {
      const lc = itemCanvas(it, k);
      const sx = (it.scale?.[0] ?? 100) / 100;
      const sy = (it.scale?.[1] ?? 100) / 100;
      const crop = (it.crop || ZERO4).map((v) => (v || 0) / 100);
      g.save();
      g.translate(it.seqW / 2 + (it.position?.[0] || 0), it.seqH / 2 + (it.position?.[1] || 0));
      g.rotate(((it.rotation || 0) * Math.PI) / 180);
      g.scale(sx, sy);
      g.translate(-it.w / 2 - (it.anchor?.[0] || 0), -it.h / 2 - (it.anchor?.[1] || 0));
      g.beginPath();
      g.rect(crop[3] * it.w, crop[0] * it.h, (1 - crop[3] - crop[1]) * it.w, (1 - crop[0] - crop[2]) * it.h);
      g.clip();
      g.globalAlpha *= Math.max(0, Math.min(1, (it.opacity ?? 100) / 100));
      g.drawImage(lc, 0, 0, it.w, it.h);
      g.restore();
    }
    function draw(seq, layers, captions, overlays, q) {
      const k = Math.min(width / seq.w, height / seq.h);
      const ox = (width - seq.w * k) / 2;
      const oy = (height - seq.h * k) / 2;
      const kq = k * q;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(k, 0, 0, k, ox, oy);
      ctx.fillStyle = seq.background || '#000000';
      ctx.fillRect(0, 0, seq.w, seq.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, seq.w, seq.h);
      ctx.clip();
      drawLayers(ctx, seq, layers, k, kq);
      ctx.restore();
      if (captions.length || overlays) {
        const c = newCanvas(Math.round(seq.w * k), Math.round(seq.h * k));
        const g = c.getContext('2d');
        for (const cap of captions) need('textrender').drawCaptions(g, cap.items, cap.style, { w: seq.w, h: seq.h, scale: k, t: cap.t });
        drawOverlays(g, overlays, seq.w, seq.h, k);
        ctx.drawImage(c, 0, 0, seq.w, seq.h);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // A sequence's layers into g, whose transform maps the sequence's pixels; k: g's pixels a sequence pixel, kq: the
    // items' (k at the playback quality).
    function drawLayers(g0, seq, layers, k, kq) {
      const frameCanvas = () => {
        const c = newCanvas(Math.round(seq.w * k), Math.round(seq.h * k));
        const g = c.getContext('2d');
        g.setTransform(k, 0, 0, k, 0, 0);
        return { c, g };
      };
      for (const l of layers) {
        if (l.kind === 'clip') { place(g0, l.item, kq); continue; }
        const A = frameCanvas();
        const B = frameCanvas();
        if (l.a) place(A.g, l.a, kq);
        if (l.b) place(B.g, l.b, kq);
        const p = l.progress;
        const M = frameCanvas();
        const m = M.g;
        m.setTransform(1, 0, 0, 1, 0, 0);
        const cw = M.c.width;
        const ch = M.c.height;
        const type = l.def.type;
        if (type === 'push') {
          const d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[l.params.direction] || [-1, 0];
          m.drawImage(A.c, d[0] * p * cw, d[1] * p * ch);
          m.drawImage(B.c, d[0] * (p - 1) * cw, d[1] * (p - 1) * ch);
        } else if (type === 'wipe') {
          m.drawImage(A.c, 0, 0);
          const e = Math.max(0, Math.min(1, p));
          m.save();
          m.beginPath();
          const dir = l.params.direction;
          if (dir === 'fromRight') m.rect(cw * (1 - e), 0, cw * e, ch);
          else if (dir === 'fromTop') m.rect(0, 0, cw, ch * e);
          else if (dir === 'fromBottom') m.rect(0, ch * (1 - e), cw, ch * e);
          else m.rect(0, 0, cw * e, ch);
          m.clip();
          m.clearRect(0, 0, cw, ch);
          m.drawImage(B.c, 0, 0);
          m.restore();
        } else {
          // dissolve and dips: an exact mix, drawn with 'lighter' (adds premultiplied values).
          const dip = type === 'dip.black' ? '#000000' : type === 'dip.white' ? '#ffffff' : null;
          const parts = !dip ? [[A.c, 1 - p], [B.c, p]] : p < 0.5 ? [[A.c, 1 - 2 * p], [dip, 2 * p]] : [[dip, 2 - 2 * p], [B.c, 2 * p - 1]];
          m.globalCompositeOperation = 'lighter';
          for (const [what, a] of parts) {
            m.globalAlpha = Math.max(0, Math.min(1, a));
            if (typeof what === 'string') { m.fillStyle = what; m.fillRect(0, 0, cw, ch); } else m.drawImage(what, 0, 0);
          }
          m.globalAlpha = 1;
          m.globalCompositeOperation = 'source-over';
        }
        g0.drawImage(M.c, 0, 0, seq.w, seq.h);
      }
    }
    return {
      backend: '2d',
      info: {},
      errors: [],
      get width() { return width; },
      get height() { return height; },
      resize(w, h) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
        target.width = width;
        target.height = height;
      },
      draw,
      async readPixels() { return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer.slice(0)); },
      done: () => Promise.resolve(),
      destroy() {},
      canvas: target,
    };
  }

  // ---- the compositor --------------------------------------------------------------------------------------------------

  // create(canvas, { width, height, backend: 'webgpu' | '2d', hardware }) -> Promise<Compositor>
  async function create(canvas, opts = {}) {
    let be = null;
    if (opts.backend !== '2d') be = await createGpu(canvas, opts).catch(() => null);
    if (!be) be = create2d(canvas, opts);
    const sources = sourcePool({ hardware: opts.hardware !== false });
    const texts = textCache();
    const graphics = graphicCache();
    let pending = Promise.resolve();
    let destroyed = false;
    let chain = Promise.resolve();
    const st = { renders: 0, lastMs: 0, layers: 0 };
    let shownSeq = null; // the size of the sequence the canvas shows, for the scopes

    // Captions and overlays share one full-frame canvas at the render size.
    let capCanvas = null;
    function captionCanvas(seq, captions, overlays, cw, ch) {
      if (!capCanvas || capCanvas.width !== cw || capCanvas.height !== ch) capCanvas = newCanvas(cw, ch);
      const g = capCanvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cw, ch);
      const k = cw / seq.w;
      for (const cap of captions) need('textrender').drawCaptions(g, cap.items, cap.style, { w: seq.w, h: seq.h, scale: k, t: cap.t });
      drawOverlays(g, overlays, seq.w, seq.h, k);
      return capCanvas;
    }

    async function renderSeq(project, seq, t, ropts = {}) {
      if (destroyed) throw new Error('the compositor is destroyed');
      const t0 = performance.now();
      const q = [1, 0.5, 0.25].includes(ropts.quality) ? ropts.quality : 1;
      const layers = plan(project, seq, t);
      // with the speaker's name and color where the track shows them
      const captions = need('speakers').decorate(project, captionsAt(seq, t, ropts.captions), globalThis.tr);
      const k = be.backend === 'webgpu' ? q : Math.min(be.width / seq.w, be.height / seq.h) * q;
      const failed = [];
      const ctx = { sources, k, proxy: !!ropts.proxy, failed, textCanvas: (it, W, H) => texts(it, W, H, k), graphicCanvas: (it, W, H) => graphics(it, W, H, k) };
      const frames = await fetchSources(project, seq, layers, ctx);
      try {
        if (destroyed) return { failed };
        if (be.backend === 'webgpu') {
          await textFontsReady(captions);
          be.encodeFrame(seq, layers, captions, q, ropts, (caps, overlays, W, H) => captionCanvas(seq, caps, overlays, W, H));
          // Frames go back to their decoders once the GPU has read them.
          const done = be.done().then(() => releaseAll(frames));
          pending = Promise.all([pending, done]);
        } else {
          await textFontsReady(captions);
          be.draw(seq, layers, captions, ropts.overlays, q);
          releaseAll(frames);
        }
      } catch (err) {
        releaseAll(frames);
        throw err;
      }
      sources.sweep();
      shownSeq = { w: seq.w, h: seq.h };
      st.renders++;
      st.layers = layers.length;
      st.lastMs = performance.now() - t0;
      return { failed };
    }
    const textFontsReady = (captions) => need('textrender').prepare(captions.map((c) => ({ font: c.style?.font, weight: c.style?.weight, italic: false })));
    // Renders run one after another: a monitor and an export never interleave their GPU work on one compositor.
    const serial = (fn) => {
      const p = chain.then(fn, fn);
      chain = p.catch(() => {});
      return p;
    };

    return {
      get backend() { return be.backend; },
      get info() { return be.info; },
      get width() { return be.width; },
      get height() { return be.height; },
      get errors() { return be.errors; },
      get lost() { return be.lost ?? null; },
      resize: (w, h) => be.resize(w, h),
      render(project, seqId, t, ropts) {
        const seq = project.sequences.find((s) => s.id === seqId);
        if (!seq) return Promise.reject(new Error(`no sequence ${seqId}`));
        return serial(() => renderSeq(project, seq, t, ropts));
      },
      renderSequence: (project, seq, t, ropts) => serial(() => renderSeq(project, seq, t, ropts)),
      // The source monitor: one media file at its own size, t in source time.
      renderMedia(project, mediaId, t, ropts) {
        return serial(() => renderSeq(project, mediaSequence(project, mediaId), Math.max(0, t), ropts));
      },
      // Starts decoding what the sequence shows between two times (the player calls it ahead of the playhead).
      prefetch(project, seqId, from, to, { proxy = false } = {}) {
        const seq = project.sequences.find((s) => s.id === seqId);
        if (!seq) return;
        const model = need('model');
        const media = need('media');
        // A nest clip's part of the range is the range of its sequence it shows, under the nest's key (fetchSources).
        const walk = (s, a, b, scope) => {
          for (const c of s.clips) {
            if (!c.enabled || c.source?.freeze) continue;
            const track = s.tracks.find((x) => x.id === c.track);
            if (!track || track.kind !== 'video' || track.visible === false) continue;
            const end = model.clipEnd(c);
            if (end <= a || c.start > b) continue;
            const [s0, s1] = model.sourceSpan(c, Math.max(a, c.start), Math.min(b + 1, end));
            const inner = model.nestOf(project, c);
            if (inner) { walk(inner, s0, s1, `${scope}${c.id}/`); continue; }
            if (c.source?.media == null) continue;
            media.open(project, c.source.media, { proxy }).then((o) => {
              if (destroyed || o.error || !o.video) return;
              sources.get(`${scope}${c.id}`, o).prefetch(s0, s1);
            }).catch(() => {});
          }
        };
        walk(seq, Math.min(from, to), Math.max(from, to), '');
      },
      readPixels: () => serial(() => be.readPixels()),
      // The Lumetri Scopes' counts of what the canvas shows now (Cut.scopes): the GPU counts with a compute pass, the
      // Canvas 2D back end on the CPU from its pixels; budget: about how many pixels to count (Cut.scopes.BUDGET). -> { bins, layout, rect, step, width, height, backend } | null
      // (nothing drawn yet, or a count still under way). It waits for the render in progress, not for the read back.
      async scopes({ cols = 256, size = 256, budget } = {}) {
        const S = need('scopes');
        const job = await serial(async () => {
          if (destroyed || !shownSeq) return null;
          if (be.scopes) return { p: be.scopes({ seqW: shownSeq.w, seqH: shownSeq.h, cols, size, budget }) };
          const px = await be.readPixels();
          const rect = S.frameRect(be.width, be.height, shownSeq.w, shownSeq.h);
          const step = S.stepFor(rect, budget);
          return { p: { ...S.analyze(px, be.width, be.height, rect, { cols, size, step }), rect, step, width: be.width, height: be.height, backend: '2d' } };
        });
        return job?.p ? job.p : null;
      },
      // A VideoFrame of what the canvas shows now (export).
      videoFrame(init) { return new VideoFrame(canvas || be.canvas, init); },
      // Resolves once every frame of earlier renders is back with its decoder.
      idle: () => chain.then(() => pending),
      stats: () => ({ ...st, backend: be.backend, sources: sources.size, decoders: sources.stats() }),
      destroy() {
        if (destroyed) return;
        destroyed = true;
        chain.then(() => pending).finally(() => {
          sources.close();
          be.destroy();
        });
      },
    };
  }

  return { create, plan, planItem, fitScale, transitionRange, extendedSourceTime, missingHandles, captionsAt, mediaSequence };
});
