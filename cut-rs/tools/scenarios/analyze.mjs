// Oracle scenarios for the beats and scenes of analyze.js: a spectral flux envelope streamed in blocks and every stage
// of the beat finder after it, and a scene detection over small frames with the ranks it asked for (sample buffers
// and pictures travel as base64 of their bytes).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'renderer', 'features', 'cut');
const A = require(path.join(CUT, 'analyze.js'));

const f32 = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

// The envelope of mono samples pushed `block` at a time, then each stage of A.beats on it.
export function beats(samples, rate, size, hop, block) {
  const x = f32(samples);
  const flux = A.createFlux(rate, { size, hop });
  for (let i = 0; i < x.length; i += block) flux.push(x.subarray(i, i + block));
  const env = flux.envelope();
  const strength = A.onsetStrength(env, flux.hopSeconds);
  const tempo = A.tempo(strength, flux.hopSeconds);
  const frames = A.trackBeats(strength, tempo.period);
  return { env, strength, tempo, frames, phase: A.barPhase(strength, frames), result: A.beats(flux, env) };
}

// Scene cuts among frames (each RGBA bytes of w x h) r0..r1 -> { cuts, asked (every rank histAt was called for) }.
export async function scenes(frames, w, h, r0, r1, threshold, step) {
  const asked = [];
  const cuts = await A.detectScenes(r0, r1, async (r) => { asked.push(r); return A.histogram(frames[r], w, h); }, { threshold, step });
  return { cuts, asked };
}

// Milliseconds for the flux of mono samples pushed in 10 s blocks and the beats of it (the best of `runs`).
export function timeBeats(samples, rate, runs) {
  const x = f32(samples);
  let best = Infinity;
  for (let k = 0; k < runs; k++) {
    const t0 = process.hrtime.bigint();
    const flux = A.createFlux(rate, { size: 1024, hop: 256 });
    for (let i = 0; i < x.length; i += rate * 10) flux.push(x.subarray(i, i + rate * 10));
    A.beats(flux, flux.envelope());
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}
