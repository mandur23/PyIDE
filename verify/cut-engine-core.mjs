// Nano Studio Cut's engine (renderer/features/cut: effects, textrender, media, decoder, compositor, player, thumbs) in
// plain Node: the parts that need no GPU, codec or canvas. Checks: the effect registry (every [1] effect and
// transition, parameters with ranges and defaults, resolve() clamping and keyframe-friendly values), each effect's CPU
// reference on known pixels against numbers worked out by hand (Rec. 709 luminance, gains, the contrast pivot, the
// white balance keeping gray, blur weights summing to one, mosaic blocks, the vignette's center and corners, crop),
// the transitions at their ends and midpoints, the constant power crossfade, the compositor's plan of a sequence
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
// Pixels are Float32Array: anything but an exact (0) tolerance allows float32 rounding.
const tol = (eps) => (eps === 0 ? 0 : Math.max(eps, 1e-6));
const near = (a, b, eps, label) => check(Math.abs(a - b) <= tol(eps), `${label} (${a} vs ${b})`);
const nearAll = (a, b, eps, label) => check(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol(eps)), `${label} (${S(a.map((x) => +x.toFixed(5)))} vs ${S(b.map((x) => +x.toFixed(5)))})`);
const SEC = time.TICKS;
const LUMA = [0.2126, 0.7152, 0.0722];

// ---- registry ----
const video = fx.list('video').map((d) => d.type);
const wantEffects = ['flip.horizontal', 'flip.vertical', 'crop', 'edge.extend', 'blur.gaussian', 'blur.directional', 'mosaic', 'color.bw', 'color.tint', 'color.brightnessContrast', 'color.basic', 'vignette'];
for (const t of wantEffects) check(video.includes(t), `video effect ${t} is registered`);
check(fx.list('audio').map((d) => d.type).join() === 'audio.gain,audio.fade', 'audio effects gain and fade');
const trTypes = fx.transitions().map((d) => d.type);
for (const t of ['dissolve', 'dip.black', 'dip.white', 'push', 'wipe', 'crossfade.power']) check(trTypes.includes(t), `transition ${t} is registered`);
check(fx.defaultTransition('video') === 'dissolve' && fx.defaultTransition('audio') === 'crossfade.power', 'default transitions');
for (const d of [...fx.list(), ...fx.transitions()]) {
  check(typeof d.name === 'string' && d.name && typeof d.category === 'string' && ['video', 'audio'].includes(d.kind), `${d.type}: name, category, kind`);
  for (const p of d.params) {
    const ok = p.id && p.name && ['number', 'angle', 'percent', 'color', 'bool', 'choice', 'point'].includes(p.type) && p.default !== undefined && typeof p.keyframable === 'boolean'
      && (!['number', 'angle', 'percent'].includes(p.type) || (p.min <= p.default && p.default <= p.max && p.step > 0))
      && (p.type !== 'choice' || p.choices.some(([id]) => id === p.default));
    check(ok, `${d.type}.${p.id}: a complete parameter`);
  }
  if (d.kind === 'video') {
    check(/fn (effect|transition)\(uv: vec2f\) -> vec4f/.test(d.gpu.code) && /@fragment fn fs/.test(d.gpu.code) && typeof d.gpu.uniforms === 'function', `${d.type}: WGSL and uniforms`);
    check(typeof d.cpu === 'function', `${d.type}: a CPU reference`);
  }
}
check(S(fx.defaults('color.basic')) === S({ temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, saturation: 100, vibrance: 0 }), 'color.basic defaults are the identity');
const r1 = fx.resolve('blur.gaussian', { blurriness: 9999, dimensions: 'sideways', repeat: 1, other: 3 });
check(r1.blurriness === 500 && r1.dimensions === 'both' && r1.repeat === true && !('other' in r1), `resolve clamps and validates (${S(r1)})`);
check(S(fx.resolve('vignette', { center: [10, -20] }).center) === '[10,-20]', 'resolve keeps a point');
check(fx.get('nope') === null && S(fx.defaults('nope')) === '{}', 'an unknown type');
check(fx.categories('video').includes('Color Correction') && fx.categories('video').includes('Dissolve'), 'categories of effects and transitions');
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
L = compositor.plan(h.project, seqOf(), SEC + SEC / 2);
check(L.length === 2 && L[0].item.clip.track === 'V1' && L[1].item.kind === 'text', 'plan: V1 under V2 (text)');
L = compositor.plan(h.project, seqOf(), 2 * SEC);
const tl = L.find((x) => x.kind === 'transition');
check(tl && tl.a.clip.id === p1.ids[0] && tl.b.clip.id === p2.ids[0], 'plan at the edit point: a dissolve from the first clip to the second');
near(tl.progress, 0.5, 1e-12, 'plan: a centered transition is half way at its edit point');
near(tl.a.srcT, 2 * SEC, 0, 'plan: the outgoing clip shows its handle past out');
near(tl.b.srcT, 10 * SEC, 0, 'plan: the incoming clip at its in point');
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
