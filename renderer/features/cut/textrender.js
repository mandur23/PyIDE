// Text of Nano Studio Cut: draws a text clip's layers and burned-in captions into a Canvas 2D context (the compositor
// uploads the canvas as a texture), measures layers for the text panel and the monitor's handles, loads the fonts the
// layers name through cut:fonts / cut:fontData as FontFace objects (the exact face the file has, Korean included), and
// makes the motion presets (fade, rise, typewriter, in and out) as keyframes a person can edit afterwards.
//
// Coordinates are sequence pixels with the origin at the frame's center; `scale` is canvas pixels per sequence pixel
// (1/2 at half playback quality). A layer's position is the center of its block of lines; `align` places the lines
// inside the block. Besides the TextLayer fields (model.createTextLayer), a layer may be animated through keyframes on
// `layers.<id>.<field>` of its clip: every field, and two that only exist as keyframes, `opacity` (0..100) and
// `reveal` (the fraction of characters shown, for the typewriter).
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).textrender = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
  const time = need('time');

  const FALLBACK = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
  const quote = (family) => `"${String(family || '').replace(/["\\]/g, '')}"`;
  const fontString = (l, px) => `${l.italic ? 'italic ' : ''}${Math.round(l.weight || 400)} ${px}px ${l.font ? `${quote(l.font)}, ` : ''}${FALLBACK}`;
  const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const graphemes = (s) => (typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter().segment(s)].map((x) => x.segment) : Array.from(s));

  // The layer as it is at clip time t: keyframed fields replace the static ones.
  function resolveLayer(layer, clip, t) {
    const out = { opacity: 100, reveal: 1, ...layer };
    const kfs = clip?.keyframes;
    if (!kfs) return out;
    const prefix = `layers.${layer.id}.`;
    const valueAt = need('keyframes').valueAt;
    for (const [prop, list] of Object.entries(kfs)) {
      if (!prop.startsWith(prefix) || !list?.length) continue;
      out[prop.slice(prefix.length)] = valueAt(list, t, out[prop.slice(prefix.length)]);
    }
    return out;
  }

  let scratch = null;
  function scratchContext() {
    if (scratch) return scratch;
    if (typeof OffscreenCanvas === 'function') scratch = new OffscreenCanvas(4, 4).getContext('2d');
    else if (typeof document !== 'undefined') scratch = document.createElement('canvas').getContext('2d');
    return scratch;
  }

  // The block of lines a layer takes, in sequence pixels: lines with their widths, the line height, and the box
  // (with padding) centered on the layer's position. Without a canvas (Node) widths are estimated from the size.
  function measure(layer, ctx = scratchContext()) {
    const l = { opacity: 100, reveal: 1, ...layer };
    const size = Math.max(1, Number(l.size) || 1);
    const lineHeight = size * (Number(l.leading) || 1.2);
    const tracking = ((Number(l.tracking) || 0) / 1000) * size;
    const lines = String(l.text ?? '').split(/\r?\n/);
    const widths = lines.map((text) => {
      const n = graphemes(text).length;
      if (!ctx) return n * size * 0.6 + Math.max(0, n - 1) * tracking;
      ctx.font = fontString(l, size);
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${tracking}px`;
      const m = ctx.measureText(text);
      // letterSpacing adds the space after the last character too.
      return Math.max(0, m.width - (n && 'letterSpacing' in ctx ? tracking : 0));
    });
    const width = Math.max(0, ...widths);
    const height = lines.length * lineHeight;
    const pad = l.box ? Math.max(0, Number(l.box.padding) || 0) : 0;
    const [x, y] = Array.isArray(l.position) ? l.position : [0, 0];
    return {
      lines: lines.map((text, i) => ({ text, width: widths[i] })),
      width, height, lineHeight, size, tracking,
      box: { x: x - width / 2 - pad, y: y - height / 2 - pad, w: width + 2 * pad, h: height + 2 * pad },
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, rr);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  // Draws layers (first = bottom) at clip time t. opts: { w, h (the sequence size), t, clip, scale }.
  function draw(ctx, layers, { w, h, t = 0, clip = null, scale } = {}) {
    const k = scale ?? ctx.canvas.width / w;
    for (const raw of layers || []) {
      const l = resolveLayer(raw, clip, t);
      const alpha = Math.max(0, Math.min(1, numOr(l.opacity, 100) / 100));
      if (!(alpha > 0)) continue;
      const m = measure(l, ctx);
      const total = m.lines.reduce((n, x) => n + graphemes(x.text).length, 0);
      let left = Math.round(Math.max(0, Math.min(1, numOr(l.reveal, 1))) * total);
      ctx.save();
      ctx.setTransform(k, 0, 0, k, (w * k) / 2, (h * k) / 2);
      ctx.globalAlpha = alpha;
      if (l.box && l.box.color) {
        ctx.fillStyle = l.box.color;
        roundRect(ctx, m.box.x, m.box.y, m.box.w, m.box.h, Number(l.box.radius) || 0);
      }
      ctx.font = fontString(l, m.size);
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${m.tracking}px`;
      // Lines sit like CSS line boxes: the font's ascent + descent centered in each line, whatever the glyphs are.
      const fm = ctx.measureText('');
      const fa = fm.fontBoundingBoxAscent;
      const fd = fm.fontBoundingBoxDescent;
      const metrics = Number.isFinite(fa) && Number.isFinite(fd) && fa + fd > 0;
      ctx.textBaseline = metrics ? 'alphabetic' : 'middle';
      ctx.textAlign = 'left';
      ctx.lineJoin = 'round';
      const [px, py] = Array.isArray(l.position) ? l.position : [0, 0];
      const top = py - m.height / 2;
      const shadow = l.shadow && l.shadow.color ? l.shadow : null;
      const stroke = l.stroke && l.stroke.color && Number(l.stroke.width) > 0 ? l.stroke : null;
      m.lines.forEach((line, i) => {
        if (left <= 0) return;
        const chars = graphemes(line.text);
        const text = chars.length > left ? chars.slice(0, left).join('') : line.text;
        left -= chars.length;
        const x = l.align === 'left' ? px - m.width / 2 : l.align === 'right' ? px + m.width / 2 - line.width : px - line.width / 2;
        const y = metrics ? top + i * m.lineHeight + (m.lineHeight - fa - fd) / 2 + fa : top + (i + 0.5) * m.lineHeight;
        const passes = stroke ? ['stroke', 'fill'] : ['fill'];
        passes.forEach((pass, n) => {
          if (n === 0 && shadow) {
            ctx.shadowColor = shadow.color;
            ctx.shadowBlur = (Number(shadow.blur) || 0) * k;
            ctx.shadowOffsetX = (Number(shadow.x) || 0) * k;
            ctx.shadowOffsetY = (Number(shadow.y) || 0) * k;
          } else {
            ctx.shadowColor = 'transparent';
          }
          if (pass === 'stroke') {
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = Number(stroke.width) * 2;
            ctx.strokeText(text, x, y);
          } else {
            ctx.fillStyle = l.fill || '#ffffff';
            ctx.fillText(text, x, y);
          }
        });
      });
      ctx.restore();
    }
  }

  // Burned-in captions: the items under t in the track's style (model.defaultCaptionStyle): centered lines near the
  // bottom (or top), margin a percent of the height, each line on its own background box. The size scales with the
  // shorter side of the sequence over the style's `ref`.
  function drawCaptions(ctx, items, style = {}, { w, h, scale } = {}) {
    const k = scale ?? ctx.canvas.width / w;
    const s = { font: 'Malgun Gothic', size: 54, weight: 600, color: '#ffffff', background: '#00000099', position: 'bottom', margin: 8, ref: 1080, ...style };
    const lines = [];
    for (const it of items || []) for (const line of String(it.text ?? '').split(/\r?\n/)) lines.push(line);
    if (!lines.length) return;
    const size = Math.max(1, ((Number(s.size) || 54) * Math.min(w, h)) / (Number(s.ref) || 1080));
    const lh = size * 1.3;
    const pad = size * 0.25;
    const margin = ((Number(s.margin) || 0) / 100) * h;
    const blockH = lines.length * lh;
    const top = s.position === 'top' ? -h / 2 + margin : h / 2 - margin - blockH;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, (w * k) / 2, (h * k) / 2);
    ctx.font = fontString({ font: s.font, weight: s.weight, italic: !!s.italic }, size);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    lines.forEach((line, i) => {
      const y = top + (i + 0.5) * lh;
      const width = ctx.measureText(line).width;
      if (s.background) {
        ctx.fillStyle = s.background;
        ctx.fillRect(-width / 2 - pad, y - lh / 2, width + 2 * pad, lh);
      }
      ctx.fillStyle = s.color || '#ffffff';
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
  }

  // ---- fonts ---------------------------------------------------------------------------------------------------------

  const invoke = (...args) => globalThis.ide?.api?.invoke?.(...args);
  let listing = null;
  const faces = new Map(); // "family|weight|italic" -> Promise<boolean>
  async function fontList() {
    if (!listing) {
      listing = Promise.resolve(invoke('cut:fonts')).then((r) => (Array.isArray(r) ? r : [])).catch(() => []);
      listing.then((r) => { if (!r.length) setTimeout(() => { listing = null; }, 5000); });
    }
    return listing;
  }
  // The style of a family that best matches: the same slant, then the nearest weight (heavier first above 500).
  function pickStyle(styles, weight, italic) {
    const pool = styles.filter((s) => !!s.italic === !!italic);
    const list = pool.length ? pool : styles;
    return list.slice().sort((a, b) => {
      const da = Math.abs(a.weight - weight);
      const db = Math.abs(b.weight - weight);
      return da - db || (weight > 500 ? b.weight - a.weight : a.weight - b.weight);
    })[0] || null;
  }
  // Loads the face a layer names into document.fonts. Resolves true once it is there, false when there is no such font
  // (the canvas then falls back to the system and to Malgun Gothic).
  function loadFont(family, { weight = 400, italic = false } = {}) {
    if (!family || typeof FontFace !== 'function') return Promise.resolve(false);
    const key = `${String(family).toLowerCase()}|${weight}|${!!italic}`;
    if (faces.has(key)) return faces.get(key);
    const p = (async () => {
      const list = await fontList();
      const want = String(family).toLowerCase();
      const fam = list.find((f) => f.family.toLowerCase() === want || (f.localName && f.localName.toLowerCase() === want));
      if (!fam) return false;
      const style = pickStyle(fam.styles, weight, italic);
      if (!style) return false;
      const data = await invoke('cut:fontData', style.file, style.index || 0);
      if (!(data instanceof Uint8Array) || !data.length) return false;
      const face = new FontFace(family, data, { weight: String(style.weight), style: style.italic ? 'italic' : 'normal' });
      await face.load();
      (globalThis.document?.fonts || globalThis.fonts)?.add(face);
      return true;
    })().catch(() => false);
    faces.set(key, p);
    p.then((ok) => { if (!ok) setTimeout(() => faces.delete(key), 10000); });
    return p;
  }
  // Every font the layers (and caption styles) need, loaded before drawing: draw() is synchronous.
  function prepare(layers) {
    const wanted = new Map();
    for (const l of layers || []) if (l && l.font) wanted.set(`${l.font}|${l.weight}|${!!l.italic}`, l);
    return Promise.all([...wanted.values()].map((l) => loadFont(l.font, { weight: Number(l.weight) || 400, italic: !!l.italic }))).then((r) => r.every(Boolean));
  }

  // ---- motion presets ------------------------------------------------------------------------------------------------

  const PRESETS = [
    { id: 'fade', name: 'Fade' },
    { id: 'rise', name: 'Rise' },
    { id: 'typewriter', name: 'Typewriter' },
  ];
  // Keyframes of one preset: { [propPath]: [Keyframe] }. opts: { layer (the TextLayer), duration (the clip's length,
  // ticks), out (true: the disappearing variant at the clip's end), length (ticks; typewriter: per character when
  // `perChar` is given), frame (one frame's ticks, so the out variant reaches its end value on the last frame shown),
  // distance (rise, sequence pixels) }.
  function make(id, opts) {
    const l = opts.layer;
    const D = opts.duration;
    const frame = opts.frame || 0;
    const chars = graphemes(String(l.text ?? '').replace(/\r?\n/g, '')).length;
    let L = opts.length ?? (id === 'typewriter' ? Math.round((opts.perChar ?? time.TICKS / 20) * Math.max(1, chars)) : Math.round(time.TICKS / 2));
    L = Math.max(frame || 1, Math.min(L, D - frame));
    const a = opts.out ? Math.max(0, D - frame - L) : 0;
    const b = a + L;
    const span = (from, to, easeIn) => [{ t: a, v: from, ease: easeIn }, { t: b, v: to, ease: 'linear' }];
    const base = `layers.${l.id}.`;
    const pos = Array.isArray(l.position) ? l.position : [0, 0];
    const dist = opts.distance ?? Math.round((Number(l.size) || 96) * 0.6);
    const low = [pos[0], pos[1] + dist];
    const inOut = (show, hide) => (opts.out ? [show, hide] : [hide, show]);
    const ease = opts.out ? 'easeIn' : 'easeOut';
    if (id === 'fade') return { [`${base}opacity`]: span(...inOut(100, 0), ease) };
    if (id === 'rise') return { [`${base}opacity`]: span(...inOut(100, 0), ease), [`${base}position`]: span(...inOut(pos.slice(), low), ease) };
    if (id === 'typewriter') return { [`${base}reveal`]: span(...inOut(1, 0), 'linear') };
    throw new Error(`unknown motion preset ${id}`);
  }
  // The keyframe lists to store after adding a preset to a clip's layer: the preset's keyframes merged into the
  // clip's, replacing the ones inside the preset's span. Each entry goes to commands.setKeyframes(seq, clip, prop, list).
  function apply(clip, layerId, id, opts = {}) {
    const layer = (clip.source?.layers || []).find((x) => x.id === layerId);
    if (!layer) throw new Error(`no text layer ${layerId}`);
    const D = Math.round((clip.out - clip.in) / (clip.speed || 1));
    const made = make(id, { ...opts, layer, duration: opts.duration ?? D });
    const kf = need('keyframes');
    const out = {};
    for (const [prop, list] of Object.entries(made)) {
      const a = list[0].t;
      const b = list[list.length - 1].t;
      let merged = (clip.keyframes?.[prop] || []).filter((k) => k.t < a || k.t > b);
      for (const k of list) merged = kf.insert(merged, k);
      out[prop] = merged;
    }
    return out;
  }

  return { draw, drawCaptions, measure, resolveLayer, prepare, loadFont, fontList, fontString, animations: { list: () => PRESETS.slice(), make, apply } };
});
