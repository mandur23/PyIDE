// Nano Studio Cut's engine (renderer/features/cut: effects, textrender, media, decoder, compositor, player, thumbs) in
// plain Node: the parts that need no GPU, codec or canvas. Checks: the effect registry (every [1] effect and
// transition, parameters with ranges and defaults, resolve() clamping and keyframe-friendly values), each effect's CPU
// reference on known pixels against numbers worked out by hand (Rec. 709 luminance, gains, the contrast pivot, the
// white balance keeping gray, blur weights summing to one, mosaic blocks, the vignette's center and corners, crop;
// sharpen, glow, invert, hue shift, posterize, chromatic aberration, glitch, lens distortion, chroma key and film grain
// at chosen pixels, each leaving the picture alone at its neutral parameters, grain and glitch the same for a frame
// and different between frames), the 2D hints (a filter or an honest skip), the transitions at their ends and
// midpoints (slide, iris and cross zoom too), the constant power crossfade, the compositor's plan of a sequence
// (track order, transitions with their progress and handles, disabled clips and hidden tracks, keyframed props and
// effect parameters at t, captions), fit scales, the motion presets' keyframes, the caption word highlight standing
// out on every speaker color (a box for a line close to the highlight color), the reader's block cache, audio
// assembly with encoder priming, peaks and the dropped-frame count.
// Usage: node verify/cut-engine-core.mjs
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dir = '../renderer/features/cut/';
const time = require(`${dir}time.js`);
const model = require(`${dir}model.js`);
const kf = require(`${dir}keyframes.js`);
const C = require(`${dir}commands.js`);
const fx = require(`${dir}effects.js`);
const textrender = require(`${dir}textrender.js`);
const media = require(`${dir}media.js`);
const decoder = require(`${dir}decoder.js`);
const compositor = require(`${dir}compositor.js`);
const player = require(`${dir}player.js`);
const thumbs = require(`${dir}thumbs.js`);

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? "" : ` (got ${S(got)}, want ${S(want)})`}`);
// Pixels are Float32Array: anything but an exact (0) tolerance allows float32 rounding.
const tol = (eps) => (eps === 0 ? 0 : Math.max(eps, 1e-6));
const near = (a, b, eps, label) => check(Math.abs(a - b) <= tol(eps), `${label} (${a} vs ${b})`);
const nearAll = (a, b, eps, label) => check(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol(eps)), `${label} (${S(a.map((x) => +x.toFixed(5)))} vs ${S(b.map((x) => +x.toFixed(5)))})`);
const SEC = time.TICKS;
const LUMA = [0.2126, 0.7152, 0.0722];

// ---- registry ----
const video = fx.list('video').map((d) => d.type);
const wantEffects = ['flip.horizontal', 'flip.vertical', 'crop', 'edge.extend', 'blur.gaussian', 'blur.directional', 'mosaic', 'color.bw', 'color.tint', 'color.brightnessContrast', 'color.basic', 'vignette',
  'sharpen', 'glow', 'color.invert', 'color.hue', 'posterize', 'chromatic', 'glitch', 'distort.lens', 'key.chroma', 'noise.grain'];
for (const t of wantEffects) check(video.includes(t), `video effect ${t} is registered`);
check(fx.list('audio').map((d) => d.type).join() === 'audio.gain,audio.fade,audio.eq,audio.bass,audio.treble,audio.compressor,audio.limiter,audio.gate,audio.dehum', 'audio effects: gain, fade and the processors (audiofx.js)');
for (const d of fx.list('audio')) check(typeof d.gain === 'function' || !!require(`${dir}audiofx.js`).processors[d.dsp], `${d.type}: a gain or an audiofx processor`);
const trTypes = fx.transitions().map((d) => d.type);
for (const t of ['dissolve', 'dip.black', 'dip.white', 'push', 'wipe', 'slide', 'iris.round', 'zoom.cross', 'crossfade.power']) check(trTypes.includes(t), `transition ${t} is registered`);
check(fx.defaultTransition('video') === 'dissolve' && fx.defaultTransition('audio') === 'crossfade.power', 'default transitions');
for (const d of [...fx.list(), ...fx.transitions()]) {
  check(typeof d.name === 'string' && d.name && typeof d.category === 'string' && ['video', 'audio'].includes(d.kind), `${d.type}: name, category, kind`);
  for (const p of d.params) {
    const ok = p.id && p.name && ['number', 'angle', 'percent', 'color', 'bool', 'choice', 'point', 'curve', 'lut'].includes(p.type) && p.default !== undefined && typeof p.keyframable === 'boolean'
      && (!['number', 'angle', 'percent'].includes(p.type) || (p.min <= p.default && p.default <= p.max && p.step > 0))
      && (p.type !== 'choice' || p.choices.some(([id]) => id === p.default));
    check(ok, `${d.type}.${p.id}: a complete parameter`);
  }
  if (d.kind === 'video') {
    check(/fn (effect|transition)\(uv: vec2f\) -> vec4f/.test(d.gpu.code) && /@fragment fn fs/.test(d.gpu.code) && typeof d.gpu.uniforms === 'function', `${d.type}: WGSL and uniforms`);
    check(typeof d.cpu === 'function', `${d.type}: a CPU reference`);
  }
}
{
  // Lumetri Color: the basic correction's defaults as before, the other sections' neutral, and nothing to draw.
  const d = fx.defaults('color.basic');
  const basic = Object.fromEntries(['temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'saturation', 'vibrance'].map((k) => [k, d[k]]));
  check(S(basic) === S({ temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, saturation: 100, vibrance: 0 }), 'color.basic defaults are the identity');
  check(d.lut === '' && d.lutIntensity === 100 && ['curveMaster', 'curveRed', 'curveGreen', 'curveBlue'].every((k) => S(d[k]) === '[0,0,1,1]') && d.hslHueRange === 360 && d.hslMask === false,
    `Lumetri Color's creative, curves and HSL secondary defaults are neutral (${S(d)})`);
  check(fx.get('color.basic').gpu.uniforms(fx.resolve('color.basic', {}), { assets: { lut: null } }).length === 0, 'Lumetri Color at its defaults has no pass to run');
}
const r1 = fx.resolve('blur.gaussian', { blurriness: 9999, dimensions: 'sideways', repeat: 1, other: 3 });
check(r1.blurriness === 500 && r1.dimensions === 'both' && r1.repeat === true && !('other' in r1), `resolve clamps and validates (${S(r1)})`);
check(S(fx.resolve('vignette', { center: [10, -20] }).center) === '[10,-20]', 'resolve keeps a point');
check(fx.get('nope') === null && S(fx.defaults('nope')) === '{}', 'an unknown type');
check(fx.categories('video').includes('Color Correction') && fx.categories('video').includes('Dissolve'), 'categories of effects and transitions');
check(S(fx.categories('video')) === S(['Transform', 'Blur & Sharpen', 'Stylize', 'Color Correction', 'Distort', 'Keying', 'Noise & Grain', 'Dissolve', 'Slide', 'Wipe', 'Zoom']), `the effects panel's video categories, in order (${S(fx.categories('video'))})`);
// Every video effect says what the Canvas 2D back end does with it: something it can draw, or an honest skip.
for (const d of fx.list('video')) {
  const h = d.canvas2d?.(fx.defaults(d.type), { width: 64, height: 36, pxScale: 1, frame: 0 });
  check(h && typeof h === 'object' && (!h.skip || Object.keys(h).length === 1), `${d.type}: a 2D hint ${S(h)}`);
}
check(S(fx.list('video').filter((d) => d.canvas2d(fx.defaults(d.type), { width: 64, height: 36, pxScale: 1 }).skip).map((d) => d.type)) === S(['sharpen', 'glow', 'posterize', 'chromatic', 'glitch', 'distort.lens', 'key.chroma', 'noise.grain']), 'the effects 2D cannot draw say so');
check(fx.get('color.invert').canvas2d({ amount: 40 }).filter === 'invert(0.4)' && fx.get('color.hue').canvas2d({ hue: 90 }).filter === 'hue-rotate(90deg)', 'invert and hue shift have a CSS filter for 2D');
// Every uniform array fits the shader's 16 floats.
for (const d of fx.list('video')) {
  const passes = d.gpu.uniforms(fx.defaults(d.type), { width: 64, height: 36, pxScale: 1 });
  check(Array.isArray(passes) && passes.every((p) => p.length <= 16), `${d.type}: uniforms fit 16 floats`);
}

// ---- colors ----
near(fx.srgbToLinear(0.5), 0.21404, 1e-5, 'sRGB 0.5 -> linear');
near(fx.linearToSrgb(fx.srgbToLinear(0.7)), 0.7, 1e-12, 'sRGB round trip');
nearAll(fx.hexToLinear('#ff000080'), [1, 0, 0, 128 / 255], 1e-9, '#rrggbbaa -> linear');

// ---- CPU references on known pixels ----
const { image, pixel } = fx.cpu;
const info = (img) => ({ width: img.w, height: img.h, pxScale: 1 });
const run = (type, img, params = {}) => fx.get(type).cpu(img, fx.resolve(type, params), info(img));
// A 4x2 image: red, green, blue, white / gray 0.18, transparent, half-alpha red, black.
const sample = () => {
  const img = image(4, 2);
  [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 1, 1], [0.18, 0.18, 0.18, 1], [0, 0, 0, 0], [0.5, 0, 0, 0.5], [0, 0, 0, 1]].forEach((c, i) => img.data.set(c, i * 4));
  return img;
};
let out = run('flip.horizontal', sample());
nearAll(pixel(out, 0, 0), [1, 1, 1, 1], 1e-9, 'horizontal flip: white moves to the left');
out = run('flip.vertical', sample());
nearAll(pixel(out, 0, 0), [0.18, 0.18, 0.18, 1], 1e-9, 'vertical flip: gray moves up');
out = run('color.bw', sample());
nearAll(pixel(out, 0, 0), [0.2126, 0.2126, 0.2126, 1], 1e-9, 'black & white: red -> its Rec. 709 luminance');
nearAll(pixel(out, 1, 0), [0.7152, 0.7152, 0.7152, 1], 1e-9, 'black & white: green');
nearAll(pixel(out, 2, 1), [0.10630, 0.10630, 0.10630, 0.5], 1e-5, 'black & white: premultiplied half red keeps alpha');
out = run('color.tint', sample(), { black: '#000000', white: '#ff0000', amount: 100 });
nearAll(pixel(out, 3, 0), [1, 0, 0, 1], 1e-9, 'tint: white maps to the white color');
nearAll(pixel(out, 1, 0), [0.7152, 0, 0, 1], 1e-9, 'tint: green maps by its luminance');
out = run('color.tint', sample(), { white: '#ff0000', amount: 50 });
nearAll(pixel(out, 1, 0), [0.3576, 0.5, 0, 1], 1e-9, 'tint at 50% mixes half way');
out = run('color.brightnessContrast', sample(), { brightness: 50 });
nearAll(pixel(out, 4, 0).slice(0, 3), [0.36, 0.36, 0.36], 1e-9, 'brightness +50 is one stop (x2)');
out = run('color.brightnessContrast', sample(), { contrast: -100 });
nearAll(pixel(out, 0, 0), [0.18, 0, 0, 1], 1e-9, 'contrast -100: positive channels go to middle gray');
out = run('color.brightnessContrast', sample(), { contrast: 100 });
nearAll(pixel(out, 3, 0).slice(0, 3), [1 / 0.18, 1 / 0.18, 1 / 0.18].map((x) => 0.18 * x * x), 1e-9, 'contrast +100 squares around the pivot');
nearAll(pixel(out, 4, 0).slice(0, 3), [0.18, 0.18, 0.18], 1e-9, 'contrast keeps middle gray');

// color.basic
const basic = (params, rgb) => {
  const img = image(1, 1, [...rgb, 1]);
  return pixel(run('color.basic', img, params), 0, 0).slice(0, 3);
};
const rgb0 = [0.3, 0.5, 0.1];
nearAll(basic({}, rgb0), rgb0, 1e-12, 'basic: the defaults change nothing');
nearAll(basic({ exposure: 1 }, rgb0), rgb0.map((x) => x * 2), 1e-12, 'basic: +1 exposure doubles linear light');
nearAll(basic({ exposure: -2 }, rgb0), rgb0.map((x) => x / 4), 1e-12, 'basic: -2 exposure quarters');
const lum = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const y0 = lum(rgb0);
nearAll(basic({ saturation: 0 }, rgb0), [y0, y0, y0], 1e-12, 'basic: saturation 0 is the luminance gray');
nearAll(basic({ saturation: 200 }, rgb0), rgb0.map((x) => Math.max(0, y0 + (x - y0) * 2)), 1e-12, 'basic: saturation 200 doubles chroma');
const warm = basic({ temperature: 100 }, [0.18, 0.18, 0.18]);
check(warm[0] > warm[1] && warm[1] > warm[2], `basic: warm makes gray reddish (${S(warm)})`);
near(lum(warm), 0.18, 1e-12, 'basic: white balance keeps the luminance of gray');
nearAll(warm.map((x) => x / 0.18), [2 ** 0.5, 1, 2 ** -0.5].map((g) => g / (2 ** 0.5 * LUMA[0] + LUMA[1] + 2 ** -0.5 * LUMA[2])), 1e-12, 'basic: temperature 100 gains 2^(+-1/2), red and blue a stop apart, over their luminance');
const mag = basic({ tint: 100 }, [0.18, 0.18, 0.18]);
check(mag[1] < mag[0] && mag[1] < mag[2], 'basic: +tint takes green out (magenta)');
nearAll(basic({ contrast: 100 }, [0.36, 0.09, 0.18]), [0.72, 0.045, 0.18], 1e-12, 'basic: contrast +100 squares around 0.18');
const dark = basic({ shadows: 100 }, [0.02, 0.02, 0.02])[0] / 0.02;
const bright = basic({ shadows: 100 }, [0.6, 0.6, 0.6])[0] / 0.6;
check(dark > 1.2 && bright < dark && bright >= 1, `basic: shadows lift dark tones more than bright ones (${dark.toFixed(3)} > ${bright.toFixed(3)})`);
// Highlights at L = 2/3 add exactly 1/4 * 6.75 * (4/9) * (1/3) = 0.25 to L.
const yh = (2 / 3) ** 2.2;
near(lum(basic({ highlights: 100 }, [yh, yh, yh])), (2 / 3 + 0.25) ** 2.2, 1e-9, 'basic: highlights +100 adds a quarter at the highlight peak');
near(lum(basic({ blacks: 100 }, [0, 0, 0])), 0.25 ** 2.2, 1e-9, 'basic: blacks +100 lifts black to L = 1/4');
const hue = basic({ shadows: 60 }, rgb0);
near(hue[0] / hue[1], rgb0[0] / rgb0[1], 1e-9, 'basic: tone keeps the channel ratios (hue)');
const vg = basic({ vibrance: 100 }, [0.2, 0.18, 0.16]);
const vs = basic({ vibrance: 100 }, [0.9, 0.05, 0.05]);
check((vg[0] - vg[2]) / (0.04) > (vs[0] - vs[1]) / 0.85, 'basic: vibrance boosts dull colors more than saturated ones');

// The eyedropper's white balance makes the picked color neutral.
for (const picked of [[0.5, 0.4, 0.3], [0.2, 0.25, 0.4], [0.3, 0.2, 0.32]]) {
  const wb = fx.whiteBalance(picked);
  const fixed = basic(wb, picked);
  check(Math.max(...fixed) - Math.min(...fixed) < 0.01 * Math.max(...fixed), `white balance from ${S(picked)}: ${S(wb)} makes it gray (${S(fixed.map((x) => +x.toFixed(4)))})`);
}
check(S(fx.whiteBalance([0.3, 0.3, 0.3])) === '{"temperature":0,"tint":0}', 'white balance of a gray is zero');

// blur
const imp = image(9, 1);
imp.data.set([1, 1, 1, 1], 4 * 4);
out = run('blur.gaussian', imp, { blurriness: 3, dimensions: 'horizontal' });
const row = [...Array(9).keys()].map((x) => pixel(out, x, 0)[0]);
const ws = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((d) => Math.exp(-(d * d) / 2));
near(row[4], 1 / [-3, -2, -1, 0, 1, 2, 3].map((d) => Math.exp(-(d * d) / 2)).reduce((a, b) => a + b), 1e-9, 'gaussian: center weight of an impulse (sigma 1, 3 sigma reach)');
near(row[3], row[5], 1e-12, 'gaussian: symmetric');
near(row[4] / row[3], ws[4] / ws[3], 1e-9, 'gaussian: weights follow exp(-x^2 / 2 sigma^2)');
const flat = image(6, 4, [0.4, 0.2, 0.1, 1]);
out = run('blur.gaussian', flat, { blurriness: 6, repeat: true });
nearAll(pixel(out, 0, 0), [0.4, 0.2, 0.1, 1], 1e-9, 'gaussian with repeated edges keeps a flat image');
out = run('blur.gaussian', flat, { blurriness: 6, repeat: false });
check(pixel(out, 0, 0)[3] < 0.9 && pixel(out, 0, 0)[3] > 0.2, 'gaussian without repeat fades the edges to transparent');
out = run('blur.gaussian', flat, { blurriness: 0 });
check(out === flat, 'gaussian 0 is no pass');
check(fx.get('blur.gaussian').gpu.uniforms(fx.resolve('blur.gaussian', { blurriness: 30 }), { pxScale: 0.5 })[0][2] === 5, 'gaussian sigma scales with playback quality');
out = run('blur.directional', imp, { direction: 90, length: 4 });
nearAll([3, 4, 5].map((x) => pixel(out, x, 0)[0]), [0.2, 0.2, 0.2], 1e-9, 'directional 90 deg: an even average along x over 5 taps');
check(pixel(out, 1, 0)[0] === 0, 'directional: nothing beyond the length');
out = run('blur.directional', imp, { direction: 0, length: 4 });
check(pixel(out, 4, 0)[0] < 0.21 && pixel(out, 3, 0)[0] === 0, 'directional 0 deg blurs up and down only');

// mosaic
const grad = image(8, 4);
for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) grad.data.set([x / 7, y / 3, 0, 1], (y * 8 + x) * 4);
out = run('mosaic', grad, { horizontal: 2, vertical: 1 });
nearAll(pixel(out, 0, 0), pixel(out, 3, 3), 1e-12, 'mosaic: one color per block');
near(pixel(out, 0, 0)[0], (0 + 1 + 2 + 3) / 4 / 7, 1e-9, 'mosaic: the average of the block');
near(pixel(out, 0, 0)[1], 0.5, 1e-9, 'mosaic: average down the block');
out = run('mosaic', grad, { horizontal: 2, vertical: 1, sharp: true });
near(pixel(out, 1, 1)[0], 1.5 / 7, 1e-9, 'mosaic sharp: the block center sample');

// vignette
const gray = image(40, 20, [0.5, 0.5, 0.5, 1]);
out = run('vignette', gray, { amount: -100, midpoint: 50, feather: 20 });
nearAll(pixel(out, 20, 10), [0.5, 0.5, 0.5, 1], 1e-9, 'vignette leaves the center');
near(pixel(out, 0, 0)[0], 0, 1e-9, 'vignette -100 blackens the corners');
out = run('vignette', gray, { amount: 100, midpoint: 50, feather: 20 });
near(pixel(out, 0, 0)[0], 1, 1e-9, 'vignette +100 whitens the corners');
out = run('vignette', gray, { amount: -100, midpoint: 50, feather: 20, center: [10, 0] });
check(pixel(out, 39, 10)[0] > pixel(out, 0, 10)[0], 'vignette center moves the clear area');

// crop effect
out = run('crop', flat, { left: 50 });
check(pixel(out, 2, 0)[3] === 0 && pixel(out, 3, 0)[3] === 1, 'crop: the left half goes');
out = run('crop', flat, { left: 50, feather: 2 });
check(pixel(out, 3, 0)[3] > 0 && pixel(out, 3, 0)[3] < 1, 'crop: a feathered edge is partly transparent');

// ---- the new effects at chosen pixels ----
const enc = fx.linearToSrgb;
const dec = fx.srgbToLinear;
const runAt = (type, img, params, frame) => fx.get(type).cpu(img, fx.resolve(type, params), { ...info(img), frame });
// A w x h image from f(x, y) -> rgba.
const make = (w, h, f) => { const img = image(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(f(x, y), (y * w + x) * 4); return img; };
const noisy = make(12, 8, (x, y) => [((x * 37 + y * 11) % 17) / 16, ((x * 13 + y * 29) % 11) / 10, ((x * 7 + y * 5) % 13) / 12, 1]);
const sameImage = (a, b) => a.w === b.w && a.h === b.h && a.data.every((v, i) => Math.abs(v - b.data[i]) <= 1e-9);
// Each new effect leaves the picture alone at its neutral parameters, and asks the GPU for no pass there.
for (const [type, params] of [['sharpen', { amount: 0 }], ['glow', { intensity: 0 }], ['color.invert', { amount: 0 }], ['color.hue', { hue: 0 }], ['color.hue', { hue: 360 }], ['color.hue', { hue: -720 }],
  ['chromatic', { amount: 0 }], ['glitch', { amount: 0 }], ['glitch', { shift: 0 }], ['distort.lens', { curvature: 0 }], ['noise.grain', { amount: 0 }]]) {
  const p = fx.resolve(type, params);
  check(sameImage(fx.get(type).cpu(noisy, p, { ...info(noisy), frame: 3 }), noisy) && fx.get(type).gpu.uniforms(p, { ...info(noisy), frame: 3 }).length === 0, `${type} ${S(params)} changes nothing and needs no GPU pass`);
}
check(sameImage(run('key.chroma', noisy, { similarity: 0, smoothness: 0, spill: 0 }), noisy), 'chroma key with similarity, smoothness and spill at 0 keeps a picture without the key color');
const onSteps = () => make(4, 1, (x) => [[0, 0, 0, 1], [1, 1, 1, 1], [1, 0, 0, 1], [dec(0.5), dec(0.5), dec(0.5), 1]][x]);
check(sameImage(run('posterize', onSteps(), { levels: 3 }), onSteps()), 'posterize keeps colors already on its steps (3 levels: 0, 0.5, 1 in sRGB)');

// sharpen: an unsharp mask of a white impulse on 0.5 gray, radius 1 (sigma 1, three taps a side, edges repeated)
const sig = [-3, -2, -1, 0, 1, 2, 3].map((d) => Math.exp(-(d * d) / 2)).reduce((a, b) => a + b);
const spike = () => make(9, 9, (x, y) => (x === 4 && y === 4 ? [1, 1, 1, 1] : [0.5, 0.5, 0.5, 1]));
out = run('sharpen', spike(), { amount: 100, radius: 1 });
const bc = 0.5 + 0.5 / (sig * sig);
near(pixel(out, 4, 4)[0], 1 + (1 - bc), 1e-9, 'sharpen 100%: the impulse gains its difference from the blur');
const bn = 0.5 + (0.5 * Math.exp(-0.5)) / (sig * sig);
near(pixel(out, 5, 4)[1], 0.5 + (0.5 - bn), 1e-9, 'sharpen: the neighbor goes darker by its difference');
near(pixel(out, 4, 4)[3], 1, 0, 'sharpen keeps alpha');
out = run('sharpen', spike(), { amount: 250, radius: 1 });
near(pixel(out, 4, 4)[0], 1 + 2.5 * (1 - bc), 1e-9, 'sharpen 250%');
out = run('sharpen', spike(), { amount: 100, radius: 1, threshold: 200 });
nearAll(pixel(out, 4, 4), [1, 1, 1, 1], 0, `sharpen: a difference under the threshold (${((1 - bc) * 255).toFixed(1)} < 200) is left alone`);
check(sameImage(run('sharpen', image(6, 4, [0.3, 0.2, 0.1, 1]), { amount: 500, radius: 5 }), image(6, 4, [0.3, 0.2, 0.1, 1])), 'sharpen leaves a flat picture flat');
check(fx.get('sharpen').gpu.uniforms(fx.resolve('sharpen', { radius: 4 }), { pxScale: 0.5 })[0][2] === 2, 'sharpen radius scales with playback quality');

// glow: a white pixel on black, threshold 50 %, radius 3 (sigma 1)
const dot = (bg) => make(9, 9, (x, y) => (x === 4 && y === 4 ? [1, 1, 1, 1] : bg));
out = run('glow', dot([0, 0, 0, 1]), { threshold: 50, radius: 3, intensity: 100 });
near(pixel(out, 4, 4)[0], 1 + 1 / (sig * sig), 1e-9, 'glow adds the blurred bright part onto it');
near(pixel(out, 5, 4)[2], Math.exp(-0.5) / (sig * sig), 1e-9, 'glow: the neighbor lights by the Gaussian');
near(pixel(out, 5, 5)[1], Math.exp(-1) / (sig * sig), 1e-9, 'glow: the diagonal neighbor by both directions');
out = run('glow', dot([0, 0, 0, 1]), { threshold: 50, radius: 3, intensity: 200 });
near(pixel(out, 5, 4)[0], (2 * Math.exp(-0.5)) / (sig * sig), 1e-9, 'glow intensity 200% doubles it');
out = run('glow', dot([0, 0, 0, 0]), { threshold: 50, radius: 3 });
near(pixel(out, 5, 4)[3], Math.exp(-0.5) / (sig * sig), 1e-9, 'glow spreads alpha onto a transparent surround');
check(sameImage(run('glow', image(5, 5, [0.2, 0.2, 0.2, 1]), { threshold: 60 }), image(5, 5, [0.2, 0.2, 0.2, 1])), 'glow: nothing above the threshold, nothing changes');
check(fx.get('glow').gpu.uniforms(fx.defaults('glow'), { pxScale: 1 }).length === 3, 'glow is a bright pass and two blur passes');

// invert: in sRGB values
nearAll(pixel(run('color.invert', sample()), 0, 0), [0, 1, 1, 1], 1e-9, 'invert: red -> cyan');
nearAll(pixel(run('color.invert', sample()), 3, 0), [0, 0, 0, 1], 1e-9, 'invert: white -> black');
near(pixel(run('color.invert', image(1, 1, [dec(0.5), dec(0.5), dec(0.5), 1])), 0, 0)[0], dec(0.5), 1e-9, 'invert keeps sRGB middle gray');
nearAll(pixel(run('color.invert', sample()), 2, 1), [0, 0.5, 0.5, 0.5], 1e-9, 'invert: premultiplied half red -> half cyan');
near(pixel(run('color.invert', sample(), { amount: 50 }), 3, 0)[0], dec(0.5), 1e-9, 'invert 50%: white -> sRGB 0.5');
near(pixel(run('color.invert', image(1, 1, [0.18, 0.18, 0.18, 1])), 0, 0)[0], dec(1 - enc(0.18)), 1e-9, 'invert: 0.18 -> 1 - its sRGB value');

// hue shift: the CSS hue-rotate matrix on linear light
const s120 = Math.sin((120 * Math.PI) / 180);
nearAll(pixel(run('color.hue', sample(), { hue: 120 }), 0, 0), [0, 0.213 + 0.5 * 0.213 + s120 * 0.143, 0, 1], 1e-9, 'hue 120: red turns green (r and b clamp at 0)');
nearAll(pixel(run('color.hue', sample(), { hue: 90 }), 4, 0), [0.18, 0.18, 0.18, 1], 1e-9, 'hue shift keeps gray');
nearAll(pixel(run('color.hue', sample(), { hue: 480 }), 0, 0), pixel(run('color.hue', sample(), { hue: 120 }), 0, 0), 1e-9, 'hue 480 = 120');
const hc = pixel(run('color.hue', image(1, 1, [0.3, 0.2, 0.1, 1]), { hue: 45 }), 0, 0);
near(lum(hc), lum([0.3, 0.2, 0.1]), 1e-4, 'hue shift keeps the luminance (to the precision of the CSS matrix)');

// posterize: rounding sRGB values to even steps
out = run('posterize', make(3, 1, (x) => [[0.18, 0.18, 0.18, 1], [0.25, 0.25, 0.25, 1], [0.5, 0, 0, 0.5]][x]), { levels: 2 });
check(pixel(out, 0, 0)[0] === 0 && pixel(out, 1, 0)[0] === 1, `posterize 2 levels: sRGB ${enc(0.18).toFixed(3)} -> 0, ${enc(0.25).toFixed(3)} -> 1`);
nearAll(pixel(out, 2, 0), [0.5, 0, 0, 0.5], 1e-9, 'posterize works on the unpremultiplied color');
near(pixel(run('posterize', image(1, 1, [0.18, 0.18, 0.18, 1]), { levels: 5 }), 0, 0)[1], dec(0.5), 1e-9, 'posterize 5 levels: sRGB 0.461 -> 0.5');

// chromatic aberration: red from one side, blue from the other
const ramp = (w, h) => make(w, h, (x) => [x / (w - 1), x / (w - 1), x / (w - 1), 1]);
out = run('chromatic', ramp(8, 1), { amount: 1, mode: 'linear', direction: 90 });
nearAll(pixel(out, 3, 0), [4 / 7, 3 / 7, 2 / 7, 1], 1e-9, 'chromatic linear 90 deg, 1 px: red from the right, blue from the left');
nearAll(pixel(out, 7, 0), [1, 1, 6 / 7, 1], 1e-9, 'chromatic: edge pixels repeat');
out = run('chromatic', ramp(9, 9), { amount: 0.5 * Math.hypot(9, 9) * 0.5, mode: 'radial' });
nearAll(pixel(out, 4, 4), [0.5, 0.5, 0.5, 1], 1e-9, 'chromatic radial: nothing at the center');
nearAll(pixel(out, 6, 4), [7 / 8, 6 / 8, 5 / 8, 1], 1e-9, 'chromatic radial: the split grows with the distance from the center');
out = run('chromatic', ramp(8, 1), { amount: 1, mode: 'linear', direction: 0 });
nearAll(pixel(out, 3, 0), [3 / 7, 3 / 7, 3 / 7, 1], 1e-9, 'chromatic 0 deg on a one-row image moves up and down only');

// lens distortion: center + d (1 + k r^2), k = curvature / 200
const lensAt = (x, y, w, h, k) => {
  const d = [(x + 0.5) / w - 0.5, (y + 0.5) / h - 0.5];
  const f = 1 + (k * ((d[0] * w) ** 2 + (d[1] * h) ** 2)) / (0.25 * (w * w + h * h));
  return [0.5 + d[0] * f, 0.5 + d[1] * f];
};
out = run('distort.lens', ramp(9, 9), { curvature: -100 });
nearAll(pixel(out, 4, 4), [0.5, 0.5, 0.5, 1], 1e-9, 'lens: the center stays');
near(pixel(out, 8, 4)[0], (lensAt(8, 4, 9, 9, -0.5)[0] * 9 - 0.5) / 8, 1e-9, `lens -100 pinches: the edge pixel shows x = ${(lensAt(8, 4, 9, 9, -0.5)[0] * 9 - 0.5).toFixed(3)}`);
check(pixel(out, 8, 4)[0] < 1 && pixel(out, 0, 4)[0] > 0, 'lens: pincushion pulls the picture in from beyond the edges');
out = run('distort.lens', ramp(9, 9), { curvature: 100 });
nearAll(pixel(out, 8, 8), [0, 0, 0, 0], 0, `lens +100 bulges: the corner shows beyond the picture (u ${lensAt(8, 8, 9, 9, 0.5)[0].toFixed(3)}), transparent`);
near(pixel(run('distort.lens', ramp(9, 9), { curvature: 100, repeat: true }), 8, 8)[0], 1, 1e-9, 'lens: with repeated edges the corner is the edge pixel');

// chroma key: Rec. 709 Y'CbCr of the sRGB values, the CbCr distance to the key
const cbcrOf = (s) => { const y = s[0] * 0.2126 + s[1] * 0.7152 + s[2] * 0.0722; return [(s[2] - y) / 1.8556, (s[0] - y) / 1.5748]; };
const [kcb, kcr] = cbcrOf([0, 1, 0]);
out = run('key.chroma', sample());
nearAll(pixel(out, 1, 0), [0, 0, 0, 0], 1e-12, 'chroma key: the key green goes');
nearAll(pixel(out, 0, 0), [1, 0, 0, 1], 1e-9, 'chroma key: red stays');
nearAll(pixel(out, 3, 0), [1, 1, 1, 1], 1e-9, 'chroma key: white stays');
out = run('key.chroma', sample(), { similarity: 0, smoothness: 0, spill: 0 });
nearAll(pixel(out, 1, 0), [0, 0, 0, 0], 1e-12, 'chroma key: the key color goes even at similarity 0');
const kd = Math.hypot(kcb, kcr) - 0.5;
out = run('key.chroma', image(1, 1, [0.18, 0.18, 0.18, 1]), { similarity: 50, smoothness: 20, spill: 0 });
near(pixel(out, 0, 0)[3], (kd / 0.2) ** 1.5, 1e-9, `chroma key: gray at CbCr distance ${(kd + 0.5).toFixed(4)} with similarity 50%, smoothness 20% keeps (d / 0.2)^1.5 of its alpha`);
near(pixel(out, 0, 0)[0], 0.18 * (kd / 0.2) ** 1.5, 1e-9, 'chroma key output is premultiplied');
const leaf = [dec(0.3), dec(0.7), dec(0.25), 1];
const lr = pixel(run('key.chroma', image(1, 1, leaf), { similarity: 20, smoothness: 1, spill: 0 }), 0, 0);
const ls = pixel(run('key.chroma', image(1, 1, leaf), { similarity: 20, smoothness: 1, spill: 60 }), 0, 0);
const ld = Math.hypot(...cbcrOf([0.3, 0.7, 0.25]).map((v, i) => v - [kcb, kcr][i])) - 0.2;
const keepK = Math.min(1, ld / 0.6) ** 1.5;
const ly = 0.3 * 0.2126 + 0.7 * 0.7152 + 0.25 * 0.0722;
nearAll(lr, leaf, 1e-9, 'chroma key: a green outside similarity + smoothness stays without spill suppression');
near(ls[1], dec(ly + (0.7 - ly) * keepK), 1e-9, `chroma key spill: the green pulled toward its luma by ${(1 - keepK).toFixed(3)}`);
check(enc(ls[1]) - enc(ls[0]) < enc(lr[1]) - enc(lr[0]), 'chroma key spill suppression takes green out');
out = run('key.chroma', sample(), { output: 'matte' });
check(S(pixel(out, 1, 0)) === '[0,0,0,1]' && S(pixel(out, 0, 0)) === '[1,1,1,1]' && S(pixel(out, 5, 0)) === '[0,0,0,1]', 'chroma key Matte output: alpha as gray');

// film grain: value noise of the pixel and the frame, added to the sRGB value
const { hash3 } = fx.cpu;
let hs = 0;
let hmin = 1;
let hmax = 0;
for (let i = 0; i < 4096; i++) { const v = hash3(i % 64, i >> 6, 7); hs += v; hmin = Math.min(hmin, v); hmax = Math.max(hmax, v); }
check(Math.abs(hs / 4096 - 0.5) < 0.02 && hmin >= 0 && hmax < 1 && hmin < 0.01 && hmax > 0.99, `the hash is even in [0, 1) (mean ${(hs / 4096).toFixed(4)})`);
check(hash3(3, 4, 5) === hash3(3, 4, 5) && hash3(3, 4, 5) !== hash3(4, 3, 5) && hash3(-1, 0, 0) !== hash3(1, 0, 0), 'the hash depends on every argument and its order, negative ones too');
const mid = () => image(32, 32, [dec(0.5), dec(0.5), dec(0.5), 1]);
const g1 = runAt('noise.grain', mid(), { amount: 100 }, 5);
near(enc(pixel(g1, 3, 2)[0]), 0.5 + 0.3 * (hash3(3, 2, 20) * 2 - 1), 1e-6, 'grain at size 1, frame 5: pixel (3, 2) is its own lattice hash (z = 4 x frame), times 0.3');
const h4 = [hash3(0, 0, 20), hash3(1, 0, 20), hash3(0, 1, 20), hash3(1, 1, 20)];
near(enc(pixel(runAt('noise.grain', mid(), { amount: 100, size: 2 }, 5), 1, 1)[0]), 0.5 + 0.3 * (((h4[0] + h4[1] + h4[2] + h4[3]) / 4) * 2 - 1), 1e-6, 'grain at size 2: pixel (1, 1) is half way between four lattice hashes');
check(sameImage(runAt('noise.grain', mid(), { amount: 100 }, 5), g1), 'grain: the same frame gives the same grain');
check(!sameImage(runAt('noise.grain', mid(), { amount: 100 }, 6), g1), 'grain: the next frame gives other grain');
check(sameImage(runAt('noise.grain', mid(), { amount: 100, animated: false }, 6), runAt('noise.grain', mid(), { amount: 100, animated: false }, 40)), 'grain not animated: the same every frame');
const devs = [];
for (let i = 0; i < 32 * 32; i++) devs.push(enc(g1.data[i * 4]) - 0.5);
const dmean = devs.reduce((a, b) => a + b) / devs.length;
const dsd = Math.sqrt(devs.reduce((a, b) => a + (b - dmean) ** 2, 0) / devs.length);
check(Math.abs(dmean) < 0.02 && dsd > 0.05 && Math.max(...devs.map(Math.abs)) <= 0.3 + 1e-9, `grain 100%: mean ${dmean.toFixed(4)}, sd ${dsd.toFixed(3)}, within +-0.3 in sRGB`);
check([...Array(32 * 32).keys()].every((i) => g1.data[i * 4] === g1.data[i * 4 + 1] && g1.data[i * 4] === g1.data[i * 4 + 2]), 'grain without Color Grain is the same on every channel');
const gc = runAt('noise.grain', mid(), { amount: 100, color: true }, 5);
check(pixel(gc, 3, 3)[0] !== pixel(gc, 3, 3)[2] && pixel(gc, 3, 3)[0] === pixel(g1, 3, 3)[0], 'Color Grain: other noise in green and blue, red as in mono');
const roughness = (img) => { let s2 = 0; for (let y = 0; y < 32; y++) for (let x = 0; x < 31; x++) s2 += Math.abs(pixel(img, x + 1, y)[0] - pixel(img, x, y)[0]); return s2; };
const rough1 = roughness(g1);
const rough4 = roughness(runAt('noise.grain', mid(), { amount: 100, size: 4 }, 5));
check(rough4 < rough1 / 2, `bigger grain is smoother from pixel to pixel (size 4: ${rough4.toFixed(1)}, size 1: ${rough1.toFixed(1)})`);
nearAll(pixel(runAt('noise.grain', sample(), { amount: 100 }, 5), 1, 1), [0, 0, 0, 0], 0, 'grain leaves transparent pixels transparent');
check(fx.get('noise.grain').gpu.uniforms(fx.defaults('noise.grain'), { pxScale: 1, frame: 9 })[0][3] === 9 && fx.get('noise.grain').gpu.uniforms(fx.resolve('noise.grain', { animated: false }), { pxScale: 1, frame: 9 })[0][3] === 0, 'grain passes the frame to the shader, 0 when not animated');

// glitch: bands moved by a hash of the band and the frame (held for `hold` frames)
const gl = (frame, params) => runAt('glitch', ramp(64, 64), { amount: 100, shift: 16, bandHeight: 8, hold: 2, ...params }, frame);
const gl4 = gl(4);
const o0 = (hash3(0, 2, 2) * 2 - 1) * (16 / 64);
const fr = (x) => x - Math.floor(x);
const at64 = (u) => fx.cpu.tap(ramp(64, 64), fr(u), 3.5 / 64);
nearAll(pixel(gl4, 10, 3), [at64(10.5 / 64 + o0 * 1.3)[0], at64(10.5 / 64 + o0)[1], at64(10.5 / 64 + o0 * 0.7)[2], 1], 1e-9, `glitch frame 4 (step 2): band 0 moves by ${(o0 * 64).toFixed(2)} px, red 30% further, blue 30% less`);
check(sameImage(gl(5), gl4) && !sameImage(gl(6), gl4), 'glitch holds for 2 frames, then changes');
nearAll(pixel(gl4, 10, 3), pixel(gl4, 10, 7), 1e-12, 'glitch: a band moves as one');
let moved = 0;
const half = runAt('glitch', ramp(64, 64), { amount: 50, shift: 16, bandHeight: 1 }, 0);
for (let y = 0; y < 64; y++) if (Math.abs(pixel(half, 20, y)[1] - 20 / 63) > 1e-6) moved++;
check(moved > 18 && moved < 46, `glitch 50% moves about half the bands (${moved}/64)`);

// transitions
const A = image(4, 2, [1, 0, 0, 1]);
const B = image(4, 2, [0, 0, 1, 1]);
const trn = (type, p, params = {}) => fx.get(type).cpu(A, B, p, fx.resolve(type, params));
nearAll(pixel(trn('dissolve', 0.5), 1, 1), [0.5, 0, 0.5, 1], 1e-12, 'dissolve midpoint is the average');
nearAll(pixel(trn('dissolve', 0), 0, 0), [1, 0, 0, 1], 1e-12, 'dissolve starts with A');
nearAll(pixel(trn('dip.black', 0.5), 0, 0), [0, 0, 0, 1], 1e-12, 'dip to black is black half way');
nearAll(pixel(trn('dip.white', 0.5), 0, 0), [1, 1, 1, 1], 1e-12, 'dip to white is white half way');
nearAll(pixel(trn('dip.black', 0.75), 0, 0), [0, 0, 0.5, 1], 1e-12, 'dip to black: B comes up after the middle');
nearAll(pixel(trn('push', 0.5, { direction: 'left' }), 0, 0), [1, 0, 0, 1], 1e-12, 'push left half way: A on the left');
nearAll(pixel(trn('push', 0.5, { direction: 'left' }), 3, 0), [0, 0, 1, 1], 1e-12, 'push left half way: B on the right');
nearAll(pixel(trn('push', 1, { direction: 'up' }), 0, 0), [0, 0, 1, 1], 1e-12, 'push at its end is B');
const wipe = trn('wipe', 0.5, { direction: 'fromLeft' });
check(pixel(wipe, 0, 0)[2] === 1 && pixel(wipe, 3, 0)[0] === 1, 'wipe from left half way: B on the left, A on the right');
const wipeR = trn('wipe', 0.5, { direction: 'fromRight' });
check(pixel(wipeR, 3, 0)[2] === 1 && pixel(wipeR, 0, 0)[0] === 1, 'wipe from right');
check(pixel(trn('wipe', 0, { feather: 20 }), 0, 0)[0] === 1 && pixel(trn('wipe', 1, { feather: 20 }), 3, 0)[2] === 1, 'feathered wipe: A at 0, B at 1');
// slide: B slides in over A, which stays
nearAll(pixel(trn('slide', 0.5, { direction: 'left' }), 0, 0), [1, 0, 0, 1], 1e-12, 'slide left half way: A still on the left');
nearAll(pixel(trn('slide', 0.5, { direction: 'left' }), 3, 0), [0, 0, 1, 1], 1e-12, 'slide left half way: B in from the right');
nearAll(pixel(trn('slide', 0.2, { direction: 'down' }), 0, 0), [1, 0, 0, 1], 1e-12, 'slide down a fifth: B has not reached the first row yet');
nearAll(pixel(trn('slide', 0.6, { direction: 'down' }), 0, 1), [1, 0, 0, 1], 1e-12, 'slide down 60%: A still at the bottom');
nearAll(pixel(trn('slide', 0.6, { direction: 'down' }), 0, 0), [0, 0, 1, 1], 1e-12, 'slide down 60%: B in from the top over the top row');
check(pixel(trn('slide', 0, { direction: 'right' }), 3, 1)[0] === 1 && pixel(trn('slide', 1, { direction: 'right' }), 0, 0)[2] === 1, 'slide: A at 0, B at 1');
const ramp8 = image(8, 1);
for (let x = 0; x < 8; x++) ramp8.data.set([x / 7, 0, 0, 1], x * 4);
near(pixel(fx.get('slide').cpu(ramp8, ramp8, 0.5, fx.resolve('slide', { direction: 'left' })), 6, 0)[0], 2 / 7, 1e-9, 'slide left half way: B shows its own left half on the right (x 6 shows B at x 2)');
const halfB = image(4, 2, [0, 0, 0.5, 0.5]);
nearAll(pixel(fx.get('slide').cpu(A, halfB, 1, fx.resolve('slide', {})), 0, 0), [0.5, 0, 0.5, 1], 1e-12, 'slide: a half transparent B covers A by its alpha');
// iris round: a circle about the center; d is the distance over the distance to a corner
const irisD = (x, y) => Math.hypot(x + 0.5 - 2, y + 0.5 - 1) / Math.hypot(2, 1);
check(irisD(1, 0) < 0.5 && irisD(0, 0) > 0.5, `iris test points: ${irisD(1, 0).toFixed(3)} inside, ${irisD(0, 0).toFixed(3)} outside half`);
nearAll(pixel(trn('iris.round', 0.5), 1, 0), [0, 0, 1, 1], 1e-12, 'iris open half way: B inside the circle');
nearAll(pixel(trn('iris.round', 0.5), 0, 0), [1, 0, 0, 1], 1e-12, 'iris open half way: A outside');
nearAll(pixel(trn('iris.round', 0.5, { direction: 'close' }), 1, 0), [1, 0, 0, 1], 1e-12, 'iris close half way: A inside');
nearAll(pixel(trn('iris.round', 0.5, { direction: 'close' }), 0, 0), [0, 0, 1, 1], 1e-12, 'iris close half way: B outside');
for (const dir of ['open', 'close']) check(pixel(trn('iris.round', 0, { direction: dir }), 0, 0)[0] === 1 && pixel(trn('iris.round', 0, { direction: dir }), 1, 0)[0] === 1 && pixel(trn('iris.round', 1, { direction: dir }), 0, 0)[2] === 1 && pixel(trn('iris.round', 1, { direction: dir }), 1, 1)[2] === 1, `iris ${dir}: all A at 0, all B at 1`);
const fe = 0.4;
const e5 = 0.5 * (1 + fe) - fe;
near(pixel(trn('iris.round', 0.5, { feather: 40 }), 0, 0)[2], 1 - (() => { const t = Math.min(1, Math.max(0, (irisD(0, 0) - e5) / fe)); return t * t * (3 - 2 * t); })(), 1e-12, 'iris feather: a smoothstep across the edge');
// cross zoom: A zooms in, B zooms back to 100%, crossing with a smoothstep
nearAll(pixel(trn('zoom.cross', 0.5), 2, 1), [0.5, 0, 0.5, 1], 1e-12, 'cross zoom half way on flat pictures: the average');
nearAll(pixel(trn('zoom.cross', 0.25), 2, 1), [1 - 0.15625, 0, 0.15625, 1], 1e-12, 'cross zoom a quarter in: smoothstep(0.25) = 0.156 of B');
check(pixel(trn('zoom.cross', 0), 0, 0)[0] === 1 && pixel(trn('zoom.cross', 1), 3, 1)[2] === 1, 'cross zoom: A at 0, B at 1');
const zr = fx.get('zoom.cross').cpu(ramp8, image(8, 1, [0, 0, 0, 1]), 0.5, fx.resolve('zoom.cross', { zoom: 300 }));
near(pixel(zr, 7, 0)[0], 0.5 * (((0.5 + (7.5 / 8 - 0.5) / 2) * 8 - 0.5) / 7), 1e-9, 'cross zoom 300% half way: A at 200% about the center');
const g = fx.get('crossfade.power').gains;
near(g(0.5)[0] ** 2 + g(0.5)[1] ** 2, 1, 1e-12, 'constant power: the power sums to one');
check(S(g(0)) === '[1,0]' && Math.abs(g(1)[0]) < 1e-12 && g(1)[1] === 1, 'constant power ends');
near(fx.get('audio.gain').gain({ gain: -6 }), 10 ** (-6 / 20), 1e-12, 'audio gain dB');
near(fx.get('audio.fade').gain({ fadeIn: 2, fadeOut: 1, curve: 'linear' }, 1, 10), 0.5, 1e-12, 'audio fade in half way');
near(fx.get('audio.fade').gain({ fadeIn: 2, fadeOut: 1, curve: 'linear' }, 9.75, 10), 0.25, 1e-12, 'audio fade out');

// ---- the compositor's plan ----
const F = time.frameTicks([30, 1]);
near(compositor.fitScale(3840, 2160, 1920, 1080, 'fit'), 0.5, 0, 'fit 4K into 1080p');
near(compositor.fitScale(1080, 1920, 1920, 1080, 'fit'), 1080 / 1920, 0, 'fit a vertical clip by its height');
near(compositor.fitScale(1080, 1920, 1920, 1080, 'fill'), 1920 / 1080, 0, 'fill a vertical clip by its width');
near(compositor.fitScale(640, 480, 1920, 1080, 'original'), 1, 0, 'original size');
check(S(compositor.transitionRange({ at: 100, duration: 20, align: 'center' })) === '[90,110]', 'centered transition range');
check(S(compositor.transitionRange({ at: 100, duration: 20, align: 'start' })) === '[100,120]' && S(compositor.transitionRange({ at: 100, duration: 20, align: 'end' })) === '[80,100]', 'start and end aligned ranges');
const ext = { start: 30 * F, in: 60 * F, out: 90 * F, speed: 1, reverse: false, source: { media: 'm1' } };
near(compositor.extendedSourceTime(ext, 70 * F, 300 * F), 100 * F, 0, 'past the out point a transition uses the handle');
near(compositor.extendedSourceTime(ext, 0, 300 * F), 30 * F, 0, 'before the in point too');
near(compositor.extendedSourceTime({ ...ext, in: 0 }, 0, 300 * F), 0, 0, 'clamped at the source start (the first frame repeats)');
near(compositor.extendedSourceTime(ext, 500 * F, 300 * F), 300 * F - 1, 0, 'clamped at the source end');
near(compositor.extendedSourceTime({ ...ext, reverse: true }, 40 * F, 300 * F), 80 * F - 1, 0, 'reverse runs from out');

const VID = { w: 1920, h: 1080, fps: [30, 1], codec: 'avc1.640028', vfr: false, rotation: 0 };
const proj = model.createProject();
const h = C.createHistory(proj);
const sid = h.project.sequences[0].id;
const { ids: [m1] } = h.do(C.importMedia([{ path: 'D:/a.mp4', name: 'a.mp4', kind: 'video', duration: 60 * SEC, video: VID, audio: null }]));
const p1 = h.do(C.place(sid, { source: { media: m1 }, in: 0, out: 2 * SEC, at: 0, video: 'V1', audio: null }));
const p2 = h.do(C.place(sid, { source: { media: m1 }, in: 10 * SEC, out: 12 * SEC, at: 2 * SEC, video: 'V1', audio: null }));
const t1 = h.do(C.addGenerated(sid, { track: 'V2', at: SEC, duration: 2 * SEC, source: { generator: 'text', layers: [{ text: '안녕하세요' }] } }));
h.do(C.addTransition(sid, { track: 'V1', at: 2 * SEC, type: 'dissolve', duration: 10 * F, align: 'center' }));
h.do(C.setKeyframes(sid, p1.ids[0], 'opacity', [{ t: 0, v: 0, ease: 'linear' }, { t: SEC, v: 100, ease: 'linear' }]));
const { id: e1 } = h.do(C.addEffect(sid, p1.ids[0], 'blur.gaussian', null, { blurriness: 4 }));
h.do(C.setKeyframes(sid, p1.ids[0], `effects.${e1}.blurriness`, [{ t: 0, v: 0, ease: 'linear' }, { t: SEC, v: 20, ease: 'linear' }]));
const seqOf = () => h.project.sequences.find((s) => s.id === sid);
let L = compositor.plan(h.project, seqOf(), SEC / 2);
check(L.length === 1 && L[0].kind === 'clip' && L[0].item.clip.id === p1.ids[0], 'plan at 0.5 s: the first clip alone');
near(L[0].item.opacity, 50, 1e-9, 'plan: keyframed opacity at t');
near(L[0].item.effects[0].params.blurriness, 10, 1e-9, 'plan: keyframed effect parameter at t');
near(L[0].item.srcT, SEC / 2, 0, 'plan: source time');
check(L[0].item.frameIndex === 15 && compositor.plan(h.project, seqOf(), SEC / 2 + F / 2)[0].item.frameIndex === 15 && compositor.plan(h.project, seqOf(), SEC / 2 + F)[0].item.frameIndex === 16, 'plan: the clip-local frame (any time inside a frame gives that frame)');
L = compositor.plan(h.project, seqOf(), SEC + SEC / 2);
check(L.length === 2 && L[0].item.clip.track === 'V1' && L[1].item.kind === 'text', 'plan: V1 under V2 (text)');
L = compositor.plan(h.project, seqOf(), 2 * SEC);
const tl = L.find((x) => x.kind === 'transition');
check(tl && tl.a.clip.id === p1.ids[0] && tl.b.clip.id === p2.ids[0], 'plan at the edit point: a dissolve from the first clip to the second');
near(tl.progress, 0.5, 1e-12, 'plan: a centered transition is half way at its edit point');
near(tl.a.srcT, 2 * SEC, 0, 'plan: the outgoing clip shows its handle past out');
near(tl.b.srcT, 10 * SEC, 0, 'plan: the incoming clip at its in point');
check(tl.a.frameIndex === 60 && tl.b.frameIndex === 0, `plan: frames of the clips in a transition count from each clip's start (${tl.a.frameIndex}, ${tl.b.frameIndex})`);
L = compositor.plan(h.project, seqOf(), 2 * SEC - 5 * F);
near(L.find((x) => x.kind === 'transition').progress, 0, 1e-12, 'plan: the transition starts half its length before the edit');
near(L.find((x) => x.kind === 'transition').b.srcT, 10 * SEC - 5 * F, 0, 'plan: the incoming clip shows its frames before in');
const tn0 = seqOf().transitions[0];
check(S(compositor.missingHandles(h.project, seqOf(), tn0)) === '{"a":0,"b":0}', 'handles: both clips have source around the edit');
h.do(C.addTransition(sid, { track: 'V1', at: 0, type: 'dissolve', duration: 10 * F, align: 'center' }));
const tn1 = seqOf().transitions.find((x) => x.at === 0);
near(compositor.missingHandles(h.project, seqOf(), tn1).b, 5 * F, 0, 'handles: a transition centered on a clip starting at its source start lacks half its length');
h.undo();
h.do(C.setTrack(sid, 'V2', { visible: false }));
check(compositor.plan(h.project, seqOf(), SEC + SEC / 2).length === 1, 'plan: a hidden track draws nothing');
h.do(C.setClip(sid, p1.ids[0], { enabled: false }));
check(compositor.plan(h.project, seqOf(), SEC / 2).length === 0, 'plan: a disabled clip draws nothing');
h.undo();
h.undo();
h.do(C.setClip(sid, p2.ids[0], { reverse: true }));
L = compositor.plan(h.project, seqOf(), 3 * SEC);
near(L[0].item.srcT, model.sourceTime(seqOf().clips.find((c) => c.id === p2.ids[0]), 3 * SEC), 0, 'plan: a reversed clip uses model.sourceTime');
check(L[0].item.srcT > 10 * SEC && L[0].item.srcT < 12 * SEC, 'plan: reversed source time is inside the clip');
h.do(C.addCaptionTrack(sid, {}));
const ct = seqOf().captions[0].id;
h.do(C.setCaptions(sid, ct, [{ start: 0, end: SEC, text: '자막 하나' }, { start: SEC, end: 2 * SEC, text: 'two' }]));
check(S(compositor.captionsAt(seqOf(), SEC / 2, true).map((c) => c.items.map((i) => i.text))) === '[["자막 하나"]]', 'captions under t');
check(compositor.captionsAt(seqOf(), SEC / 2, null).length === 0 && compositor.captionsAt(seqOf(), 5 * SEC, true).length === 0, 'no captions unless asked, none past the last');
const ms = compositor.mediaSequence(h.project, m1);
check(ms.w === 1920 && ms.clips.length === 1 && compositor.plan(h.project, ms, 5 * SEC)[0].item.srcT === 5 * SEC, 'the source monitor sequence shows the media at source time');
check(model.validate(h.project).ok, 'the test project is valid');

// ---- the plan of a nest clip ----
{
  const ph = C.createHistory(model.createProject());
  const ps = ph.project.sequences[0].id;
  const { ids: [pm] } = ph.do(C.importMedia([{ path: 'D:/a.mp4', name: 'a.mp4', kind: 'video', duration: 60 * SEC, video: VID, audio: null }]));
  const q1 = ph.do(C.place(ps, { source: { media: pm }, in: 10 * SEC, out: 12 * SEC, at: SEC, video: 'V1', audio: null })).ids[0];
  const q2 = ph.do(C.addGenerated(ps, { track: 'V2', at: SEC, duration: SEC, source: { generator: 'text', layers: [{ text: 'in' }] } })).id;
  ph.do(C.setKeyframes(ps, q1, 'opacity', [{ t: 0, v: 20, ease: 'linear' }, { t: SEC, v: 80, ease: 'linear' }]));
  const flat = compositor.plan(ph.project, ph.project.sequences[0], SEC + SEC / 2);
  const { id: inner, ids: [n1] } = ph.do(C.nest(ps, [q1, q2], { name: 'Nested Sequence 1' }));
  const outer = () => ph.project.sequences.find((s) => s.id === ps);
  let N = compositor.plan(ph.project, outer(), SEC + SEC / 2);
  const it = N[0]?.item;
  check(N.length === 1 && it.kind === 'nest' && it.sequence.id === inner && it.srcT === SEC / 2, `plan: a nest clip is one item showing its sequence at its source time (${it?.kind}, ${it?.srcT / SEC} s)`);
  eq(it.layers.map((l) => [l.item.clip.id, l.item.kind, l.item.srcT, l.item.opacity, l.item.key, l.item.seqW]), flat.map((l) => [l.item.clip.id, l.item.kind, l.item.srcT, l.item.opacity, `${n1}/${l.item.clip.id}`, 1920]),
    'plan: its layers are the plan of the clips it holds, keyframes at the same frame, keyed under the nest clip');
  check([1920, 1080].join() === [it.seqW, it.seqH].join() && it.key === n1, 'plan: the nest item itself sits in the outer sequence');
  ph.do(C.setKeyframes(ps, n1, 'opacity', [{ t: 0, v: 0, ease: 'linear' }, { t: SEC, v: 100, ease: 'linear' }]));
  const { id: fxId } = ph.do(C.addEffect(ps, n1, 'blur.gaussian', null, { blurriness: 7 }));
  ph.do(C.setClip(ps, n1, { props: { scale: [50, 50], position: [100, -40] } }));
  N = compositor.plan(ph.project, outer(), SEC + SEC / 2);
  check(Math.abs(N[0].item.opacity - 50) < 1e-9 && N[0].item.effects[0]?.id === fxId && N[0].item.scale[0] === 50 && N[0].item.position[0] === 100, 'plan: the nest clip\'s own opacity keyframes, effects and motion are on the nest item');
  ph.do(C.trim(ps, n1, { edge: 'start', delta: SEC / 2 }));
  N = compositor.plan(ph.project, outer(), SEC + SEC / 2);
  check(N[0].item.srcT === SEC / 2 && N[0].item.layers[0].item.srcT === flat[0].item.srcT, 'plan: after a start trim the nest still shows the same inner frame at the same sequence time');
  ph.do(C.split(ps, SEC + SEC / 2 + 3 * F, { clipIds: [n1] }));
  N = compositor.plan(ph.project, outer(), SEC + SEC / 2 + 6 * F);
  check(N.length === 1 && N[0].item.clip.id !== n1 && N[0].item.srcT === SEC / 2 + 6 * F, 'plan: the right part of a razored nest clip continues the sequence where the cut was');
  ph.do(C.setClip(ps, n1, { reverse: true }));
  N = compositor.plan(ph.project, outer(), SEC + SEC / 2);
  check(N[0].item.kind === 'nest' && N[0].item.srcT === model.sourceTime(outer().clips.find((c) => c.id === n1), SEC + SEC / 2), 'plan: a reversed nest clip reads its sequence through model.sourceTime');
  const deep = ph.do(C.nest(ps, outer().clips.map((c) => c.id), { name: 'Nested Sequence 2' }));
  N = compositor.plan(ph.project, outer(), 2 * SEC);
  check(N[0].item.kind === 'nest' && N[0].item.layers[0].item.kind === 'nest' && N[0].item.layers[0].item.layers.length >= 1 && N[0].item.layers[0].item.layers[0].item.key.split('/').length === 3, 'plan: a nest inside a nest draws two levels down, keyed by both nest clips');
  check(model.validate(ph.project).ok && deep.ids.length === 1, 'the nest test project is valid');
}

// ---- the plan of a remapped clip (Time Remapping) and of a remapped nest ----
{
  const R = require(`${dir}remap.js`);
  const rh = C.createHistory(model.createProject());
  const rs = rh.project.sequences[0].id;
  const { ids: [rm] } = rh.do(C.importMedia([{ path: 'D:/a.mp4', name: 'a.mp4', kind: 'video', duration: 60 * SEC, video: VID, audio: null }]));
  const rv = rh.do(C.place(rs, { source: { media: rm }, in: 10 * SEC, out: 13 * SEC, at: SEC, video: 'V1', audio: null })).ids[0];
  const rc = () => rh.project.sequences[0].clips.find((c) => c.id === rv);
  // a key 1 s in; 50% after it with a 10-frame transition; a 6-frame hold at a second key
  let r = R.setSegmentSpeed(R.addKey(model.remapOf(rc()), SEC), 1, 0.5, F);
  r = R.splitKey(r, 0, 'right', 10 * F, F);
  r = R.insertFreeze(R.addKey(r, 2 * SEC), 1, 6 * F);
  rh.do(C.setRemap(rs, rv, r));
  const at = (t) => compositor.plan(rh.project, rh.project.sequences[0], t)[0]?.item;
  const want = (t) => model.sourceTime(rc(), t);
  eq([0, 29, 30, 35, 40, 59, 60, 63, 66, 70].map((k) => at(SEC + k * F).srcT), [0, 29, 30, 35, 40, 59, 60, 63, 66, 70].map((k) => want(SEC + k * F)), 'plan: a remapped clip\'s source time is the curve\'s at every point (before, through the transition, the hold)');
  near(at(SEC + 35 * F).srcT, 10 * SEC + 30 * F + 4.375 * F, 1e-6, 'plan: halfway through the transition the source is the speed\'s integral');
  check(at(SEC + 60 * F).srcT === at(SEC + 65 * F).srcT, 'plan: a hold shows one source time');
  eq([0, 35, 63, 70].map((k) => at(SEC + k * F).frameIndex), [0, 35, 63, 70], 'plan: frameIndex is still the clip-local frame (grain and glitch change through a hold)');
  near(compositor.extendedSourceTime(rc(), rc().start - 5 * F, 60 * SEC), 10 * SEC - 5 * F, 1e-6, 'a transition before a remapped clip reads its curve backward at the first speed');
  rh.do(C.setClip(rs, rv, { sampling: 'blend' }, { linked: false }));
  const half = at(SEC + 31 * F);
  check(half.blend && Math.abs(half.blend.w - (half.srcT / F - Math.floor(half.srcT / F))) < 1e-9 && half.blend.srcT === (Math.floor(half.srcT / F) + 1) * F, `plan: Frame Blending mixes the next source frame in by how far the time is past the one before (w ${half.blend?.w.toFixed(3)})`);
  check(at(SEC + 10 * F).blend === null, 'plan: on a frame there is nothing to blend');
  rh.do(C.setClip(rs, rv, { sampling: 'sample' }, { linked: false }));
  check(at(SEC + 31 * F).blend === null, 'plan: Frame Sampling (the default) shows the nearest frame alone');

  // the same curve on a nest clip of that clip's sequence: the nest reads its sequence along the curve
  const { id: inner, ids: [nn] } = rh.do(C.nest(rs, [rv], { name: 'N' }));
  const nc = () => rh.project.sequences[0].clips.find((c) => c.id === nn);
  rh.do(C.setRemap(rs, nn, R.insertReverse(R.addKey(model.remapOf(nc()), 20 * F), 0, 8 * F)));
  const nAt = (k) => compositor.plan(rh.project, rh.project.sequences[0], nc().start + k * F)[0]?.item;
  eq([10, 19, 20, 24, 28, 32, 36, 40].map((k) => Math.floor(Math.round(nAt(k).srcT) / F)), [10, 19, 19, 15, 12, 16, 20, 24], 'plan: a remapped nest clip plays its sequence back for 8 frames after the key, then forward');
  const deep = nAt(24).layers[0].item;
  check(nAt(24).kind === 'nest' && deep.clip.id === rv && deep.srcT === model.sourceTime(rh.project.sequences.find((s) => s.id === inner).clips[0], nAt(24).srcT), 'plan: inside, the nested clip shows its own curve at the time the nest reached');
  eq([24, 36].map((k) => nAt(k).frameIndex), [24, 36], 'plan: the nest item\'s frameIndex is its own clip frame');
  check(model.validate(rh.project).ok, 'the remap test project is valid');
}

// ---- text ----
const layer = model.createTextLayer({ id: 'l1', text: 'Hello\n세계', size: 100, leading: 1.5, position: [10, 20], box: { color: '#000000', padding: 10, radius: 4 } });
const m = textrender.measure(layer, null);
check(m.lines.length === 2 && m.lines[1].text === '세계', 'measure: lines');
near(m.height, 300, 1e-9, 'measure: height is lines x leading x size');
near(m.box.h, 320, 1e-9, 'measure: the box adds its padding');
near(m.box.y, 20 - 150 - 10, 1e-9, 'measure: the box is centered on the position');
check(textrender.fontString({ font: 'Malgun Gothic', weight: 700, italic: true }, 50).startsWith('italic 700 50px "Malgun Gothic"'), 'font string');
check(!textrender.fontString({ font: 'a"b' }, 10).includes('a"b'), 'font names are quoted safely');
const fade = textrender.animations.make('fade', { layer, duration: 3 * SEC });
check(S(Object.keys(fade)) === '["layers.l1.opacity"]' && fade['layers.l1.opacity'][0].v === 0 && fade['layers.l1.opacity'][1].v === 100 && fade['layers.l1.opacity'][1].t === SEC / 2, 'fade in: opacity 0 -> 100 over half a second');
check(fade['layers.l1.opacity'][0].ease === 'easeOut', 'fade in arrives slowly');
const fadeOut = textrender.animations.make('fade', { layer, duration: 3 * SEC, out: true, frame: F });
check(fadeOut['layers.l1.opacity'][1].t === 3 * SEC - F && fadeOut['layers.l1.opacity'][1].v === 0, 'fade out ends at 0 on the last frame');
const rise = textrender.animations.make('rise', { layer, duration: 3 * SEC, distance: 50 });
check(S(rise['layers.l1.position'].map((k) => k.v)) === '[[10,70],[10,20]]', 'rise comes up from below to the layer position');
const tw = textrender.animations.make('typewriter', { layer, duration: 10 * SEC, perChar: SEC / 10 });
check(tw['layers.l1.reveal'][1].t === SEC * 0.7 && tw['layers.l1.reveal'][1].v === 1, 'typewriter: one tenth of a second per character (7 characters)');
const clip = { in: 0, out: 3 * SEC, speed: 1, source: { generator: 'text', layers: [layer] }, keyframes: { 'layers.l1.opacity': [{ t: 2 * SEC, v: 40, ease: 'linear' }, { t: SEC / 4, v: 7, ease: 'linear' }] } };
const merged = textrender.animations.apply(clip, 'l1', 'fade', {});
check(S(merged['layers.l1.opacity'].map((k) => [k.t / SEC, k.v])) === '[[0,0],[0.5,100],[2,40]]', 'apply: replaces keyframes inside the span, keeps others');
const resolved = textrender.resolveLayer(layer, { keyframes: tw }, SEC * 0.35);
near(resolved.reveal, 0.5, 1e-9, 'resolveLayer: a keyframe-only field at t');
check(resolved.opacity === 100 && resolved.text === layer.text, 'resolveLayer: defaults and static fields');

// the lit word stands out on every speaker color: each fillText's and fill's color, from a recording context
function drawnCaption(item, style) {
  const ops = [];
  const noop = () => {};
  const ctx = { canvas: { width: 1920 }, fillStyle: '', font: '', save: noop, restore: noop, setTransform: noop, beginPath: noop, rect: noop, roundRect: noop, clip: noop, fillRect: noop,
    measureText: (s) => ({ width: s.length * 20 }), fillText() { ops.push(['text', this.fillStyle]); }, fill() { ops.push(['box', this.fillStyle]); } };
  textrender.drawCaptions(ctx, [item], { ...model.defaultCaptionStyle(), highlight: true, ...style }, { w: 1920, h: 1080, t: SEC / 4 });
  return ops;
}
const apart = (a, b) => {
  const [p, q] = [a, b].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const r = (p[0] + q[0]) / 2;
  return Math.sqrt((2 + r / 256) * (p[0] - q[0]) ** 2 + 4 * (p[1] - q[1]) ** 2 + (2 + (255 - r) / 256) * (p[2] - q[2]) ** 2);
};
const spoken = { start: 0, end: SEC, text: 'alpha beta', words: [{ t0: 0, t1: SEC / 2, text: 'alpha' }, { t0: SEC / 2, t1: SEC, text: 'beta' }] };
const boxedOn = [];
for (const c of ['#ffffff', ...require(`${dir}speakers.js`).PALETTE]) {
  const ops = drawnCaption({ ...spoken, color: c }, {});
  const [rest, lit] = ops.filter((o) => o[0] === 'text').map((o) => o[1]);
  const box = ops.find((o) => o[0] === 'box')?.[1];
  if (box) boxedOn.push(c);
  check(rest === c && apart(lit, c) >= 150 && (!box || apart(lit, box) >= 150), `a line in ${c} lights its word in ${lit}${box ? ` on a ${box} box` : ''}, apart from the line`);
}
check(S(boxedOn) === S(['#ffb74d', '#fff176']), `in color mode only the lines too close to the highlight get the box (${S(boxedOn)})`);
const own = drawnCaption({ ...spoken }, { color: '#ffd23f' });
check(own.some((o) => o[0] === 'box'), 'and so does a caption color the person chose close to the highlight');

// ---- reader block cache ----
const file = new Uint8Array(1_000_000).map((_, i) => (i * 7 + (i >> 9)) & 255);
let calls = 0;
const rd = media.ipcReader('x', file.length, async (o, l) => { calls++; return file.slice(o, o + l); });
let same = true;
for (let i = 0; i < 300; i++) {
  const o = Math.floor(Math.random() * (file.length - 10));
  const l = 1 + Math.floor(Math.random() * 40000);
  const got = await rd.read(o, l);
  const want = file.subarray(o, Math.min(file.length, o + l));
  if (got.length !== want.length || got.some((v, k) => v !== want[k])) { same = false; break; }
}
check(same, 'reader: random small reads match the file, also across block edges');
check(calls <= 8, `reader: small reads come from 256 KB blocks (${calls} IPC reads for 300)`);
const big = await rd.read(100, 200_000);
check(big.length === 200_000 && big[0] === file[100] && big[199_999] === file[200_099], 'reader: a large read goes straight through');
check((await rd.read(file.length - 5, 100)).length === 5 && (await rd.read(file.length + 5, 10)).length === 0, 'reader: reads end at the file end');
const bad = media.ipcReader('y', 100, async () => ({ error: 'no such file', code: 'missing' }));
let code = null;
try { await bad.read(0, 10); } catch (err) { code = err.code; }
check(code === 'missing', 'reader: an IPC error rejects with its code');
check(S(media.shownSize({ width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, rotation: 90 })) === '[1080,1920]', 'a rotated track is shown upright');
const cfg = media.videoConfig({ codec: 'avc1.640028', width: 1920, height: 1088, displayWidth: 1920, displayHeight: 1080, description: new Uint8Array([1]), colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } }, 'prefer-hardware');
check(cfg.hardwareAcceleration === 'prefer-hardware' && cfg.codedHeight === 1088 && cfg.displayAspectHeight === 1080 && cfg.colorSpace.matrix === 'bt709' && cfg.colorSpace.fullRange === false && cfg.optimizeForLatency, 'decoder config from a track');

// ---- audio assembly, peaks ----
const asm = decoder.assemble({ rate: 10, channels: 2, pieces: [{ at: -0.2, planes: [Float32Array.from([1, 2, 3, 4]), Float32Array.from([5, 6, 7, 8])] }, { at: 0.2, planes: [Float32Array.from([9, 9])] }] }, 0.5);
check(S([...asm.data[0]]) === '[3,4,9,9,0]' && S([...asm.data[1]]) === '[7,8,9,9,0]', `assemble: priming before 0 is dropped, a mono piece fills both channels (${S([...asm.data[0]])} ${S([...asm.data[1]])})`);
const pk = thumbs.computePeaks([Float32Array.from([0.1, -0.5, 0.2, 0.9, 0]), Float32Array.from([0, 0, -0.7, 0, 0.3])], 2);
check(S([...pk].map((x) => +x.toFixed(2))) === '[-0.5,0.1,-0.7,0.9,0,0.3]', 'peaks: min/max of every channel per block');
const noise = [0, 1].map((c) => Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i * 0.37 + c) * Math.cos(i * 0.011)));
const peakDirect = thumbs.computePeaks(noise, 12);
const peakMerged = thumbs.coarsen(thumbs.computePeaks(noise, 3), 4);
check(peakDirect.length === peakMerged.length && peakDirect.every((v, i) => v === peakMerged[i]), `peaks merged from 4 smaller blocks are the peaks of the larger block, the partial last one too (${peakDirect.length}, ${peakMerged.length})`);

// ---- dropped frames ----
check(player.droppedBetween(null, 5, 1) === 0 && player.droppedBetween(4, 5, 1) === 0 && player.droppedBetween(4, 7, 1) === 2, 'dropped: frames skipped at rate 1');
check(player.droppedBetween(4, 6, 2) === 0 && player.droppedBetween(4, 9, 2) === 3 && player.droppedBetween(10, 8, -2) === 0, 'dropped: a shuttle rate skips frames on purpose');
check(S(player.RATES) === S([-8, -4, -2, -1, -0.5, 0.5, 1, 2, 4, 8]), 'shuttle rates');

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
