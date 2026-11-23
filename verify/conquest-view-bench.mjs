// Stage 0 of docs/strategy-game-plan.md: how fast the Conquest map view draws. A generated 5,000-province map at the
// real texture size (8192x4096, or the largest the GPU takes) with 2,000 division counters (merge keys by nation, so
// zoomed out they merge as in the game and every change of zoom bucket reclusters), 40 nation names, the edges of 600
// border pairs and 120 battle markers on the overlay, driven for 10 seconds of
// continuous scripted zoom and pan per scene, in the real app window. Per run it prints the GPU ANGLE picked, the
// vsync-paced frame interval (median, 95th percentile, fps), the view's CPU time per frame, and the unthrottled cost
// of a frame (CPU and GPU, forced to finish by a pixel read), which says how far below the vsync limit the work is.
// Runs alternate the default GPU and --force_high_performance_gpu (Chromium's switch for the discrete GPU).
// node verify/conquest-view-bench.mjs [--rounds 3] [--seconds 10] [--gpu default|high|both] [--units 2000]
// [--layers names,borders,markers,merge] (the default is all four; a shorter list measures without the others). Port 9829.
import path from 'path';
import { launch, tempDir } from './lib.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const ROUNDS = Number(arg('rounds', 3));
const SECONDS = Number(arg('seconds', 10));
const UNITS = Number(arg('units', 2000));
const LAYERS = arg('layers', 'names,borders,markers,merge').split(',');
const GPUS = { both: ['default', 'high'], default: ['default'], high: ['high'] }[arg('gpu', 'both')];
const S = JSON.stringify;

const SETUP = () => `(async () => {
  const old = Conquest.app.view;
  const stage = document.querySelector('.cq-stage');
  old.destroy();
  const probe = document.createElement('canvas').getContext('webgl2');
  const max = probe.getParameter(probe.MAX_TEXTURE_SIZE);
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  const width = Math.min(8192, max);
  const height = width / 2;
  const t0 = performance.now();
  const gen = Conquest.view.synthetic({ seed: 5000, provinces: 5000, width, height, nations: 40, islands: 10 });
  const genMs = performance.now() - t0;
  const v = Conquest.view.create(stage, { map: gen.map, idSource: gen.idSource });
  await v.ready;
  v.setOwners(gen.owners, gen.colors);
  const land = gen.map.provinces.filter((p) => p && !p.sea);
  const units = [];
  for (let i = 0; i < ${UNITS}; i++) {
    const p = land[(i * 7919) % land.length];
    units.push({ prov: p.id, nation: gen.owners[p.id], count: 1 + (i % 9), color: gen.colors[gen.owners[p.id]], str: 0.4 + (i % 7) / 10, org: 0.3 + (i % 5) / 7, key: ${S(LAYERS.includes('merge'))} ? gen.owners[p.id] : null });
  }
  v.setUnits(units);
  if (${S(LAYERS.includes('names'))}) v.setNames(gen.colors.map((_, i) => (i % 5 === 4 ? '대한 제국 ' : 'Nation of ') + (i + 1)));
  const pairs = [];
  for (const p of land) for (const q of p.adj) if (q > p.id && !gen.map.provinces[q].sea && gen.owners[q] !== gen.owners[p.id]) pairs.push([p.id, q]);
  const t1 = performance.now();
  if (${S(LAYERS.includes('borders'))}) v.setBorderLines([{ pairs: pairs.slice(0, 600), color: '#d84a3a', width: 0.8 }]);
  const edgeMs = performance.now() - t1;
  if (${S(LAYERS.includes('markers'))}) v.setMarkers(land.slice(0, 120).map((p, i) => ({ prov: p.id, odds: (i * 97) % 1000, mine: i % 4 !== 0 })));
  v.setArrows(land.slice(0, 40).map((p, i) => ({ path: [p.id, ...p.adj.filter((a) => !gen.map.provinces[a].sea).slice(0, 2)], color: '#d33c2f' })).filter((a) => a.path.length >= 2));
  v.camera.fit();
  window.__bench = { v, gen };
  return { max, width, height, provinces: gen.map.provinces.length - 1, land: land.length, genMs: Math.round(genMs), edgeMs: Math.round(edgeMs), labels: v.labels.length, gpu: v.info.renderer, dpr: devicePixelRatio };
})()`;

// One scene: a camera path over time; 'world' keeps all 2,000 counters on screen, 'sweep' zooms in and pans across.
const SCENE = (scene, seconds) => `(async () => {
  const { v } = window.__bench; const c = v.camera; const W = v.map.texture.width; const H = v.map.texture.height;
  const fit = (c.fit(), c.scale);
  const at = (t) => {
    if (${S(scene)} === 'world') { c.zoomAt(c.w / 2, c.h / 2, (fit * (1.0 + 0.15 * (1 - Math.cos(t * 2.1)))) / c.scale); c.pan(Math.sin(t * 1.7) * 6, Math.cos(t * 1.3) * 4); }
    else c.centerOn(W * (0.5 + 0.35 * Math.sin(t * 0.37)), H * (0.5 + 0.3 * Math.sin(t * 0.53)), fit * (1.5 + 5 * (1 - Math.cos(t * 0.9)) / 2));
  };
  const counters = [];
  const cpu = [];
  const off = v.on('frame', (e) => { counters.push(e.counters); cpu.push(e.ms); });
  const stamps = [];
  await new Promise((resolve) => {
    let start = 0;
    const tick = (now) => {
      if (!start) start = now;
      stamps.push(now);
      at((now - start) / 1000);
      v.redraw();
      if (now - start < ${seconds} * 1000) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  off();
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  // Unthrottled: draw and wait for the GPU (a 1-pixel read) along the same path, 120 frames.
  const forced = [];
  const sums = new Set();
  for (let i = 0; i < 120; i++) {
    at(i * 0.083);
    const t0 = performance.now();
    const px = v.sample([[c.w / 2, c.h / 2]]);
    forced.push(performance.now() - t0);
    sums.add(px[0].join());
  }
  return { gaps, cpu, counters, forced, distinct: sums.size, canvas: [document.querySelector('.cq-map-gl').width, document.querySelector('.cq-map-gl').height] };
})()`;

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : NaN; };
const f1 = (x) => x.toFixed(1);
const f2 = (x) => x.toFixed(2);

const runs = [];
let port = 9829;
for (let round = 1; round <= ROUNDS; round++) {
  for (const gpu of GPUS) {
    const home = path.join(tempDir('conquest-bench'), 'Home');
    const ctx = await launch({ fixture: 'core', port, name: 'conquest-view-bench', mode: 'conquest', env: { PYIDE_CONQUEST_HOME: home },
      args: gpu === 'high' ? ['--force_high_performance_gpu'] : [] });
    try {
      await ctx.until('window.__conquestReady === true', 'the map', 60000);
      const setup = await ctx.js(SETUP());
      console.log(`round ${round} gpu=${gpu}: ${setup.gpu}; MAX_TEXTURE_SIZE ${setup.max}; map ${setup.width}x${setup.height}, ${setup.provinces} provinces (${setup.land} land), generated in ${setup.genMs} ms; 600 border edges in ${setup.edgeMs} ms (with the raster scan); ${setup.labels} labels; dpr ${setup.dpr}`);
      for (const scene of ['world', 'sweep']) {
        const r = await ctx.js(SCENE(scene, SECONDS));
        const row = {
          round, gpu, scene, renderer: setup.gpu, frames: r.gaps.length + 1,
          fps: (r.gaps.length / (r.gaps.reduce((a, b) => a + b, 0) / 1000)),
          gapMed: q(r.gaps, 0.5), gapP95: q(r.gaps, 0.95), gapMax: Math.max(...r.gaps),
          cpuMed: q(r.cpu, 0.5), cpuP95: q(r.cpu, 0.95),
          counters: q(r.counters, 0.5), viewFrames: r.counters.length,
          forcedMed: q(r.forced, 0.5), forcedP95: q(r.forced, 0.95), distinct: r.distinct,
        };
        runs.push(row);
        console.log(`  ${scene.padEnd(5)} ${f1(row.fps)} fps over ${row.frames} frames; interval median ${f2(row.gapMed)} ms, p95 ${f2(row.gapP95)} ms, max ${f1(row.gapMax)} ms at frame ${r.gaps.indexOf(row.gapMax)}; view CPU median ${f2(row.cpuMed)} ms, p95 ${f2(row.cpuP95)} ms; counters on screen median ${row.counters} in ${row.viewFrames} view frames; canvas ${r.canvas.join('x')}; unthrottled frame (draw + GPU finish) median ${f2(row.forcedMed)} ms, p95 ${f2(row.forcedP95)} ms (${row.distinct} distinct centre pixels in 120)`);
      }
      if (ctx.consoleErrors.length) console.log(`  renderer exceptions: ${ctx.consoleErrors.join(' | ')}`);
    } finally {
      ctx.close();
    }
  }
}

console.log('\nsummary (median of runs; range in brackets)');
for (const gpu of GPUS) {
  for (const scene of ['world', 'sweep']) {
    const rs = runs.filter((r) => r.gpu === gpu && r.scene === scene);
    if (!rs.length) continue;
    const span = (k, f = f2) => `${f(q(rs.map((r) => r[k]), 0.5))} [${f(Math.min(...rs.map((r) => r[k])))}..${f(Math.max(...rs.map((r) => r[k])))}]`;
    console.log(`${gpu.padEnd(7)} ${scene.padEnd(5)} ${rs[0].renderer}\n  fps ${span('fps', f1)}; interval median ${span('gapMed')} ms, p95 ${span('gapP95')} ms; view CPU median ${span('cpuMed')} ms, p95 ${span('cpuP95')} ms; unthrottled frame median ${span('forcedMed')} ms, p95 ${span('forcedP95')} ms; counters ${span('counters', String)}`);
  }
}
const all = runs.every((r) => r.fps >= 58 && r.gapP95 < 20);
console.log(`${all ? 'PASS' : 'FAIL'} 60 fps target (fps >= 58 and p95 interval < 20 ms in every run)`);
console.log(`${all ? 1 : 0}/1 passed`);
process.exit(all ? 0 : 1);
