// The cost of Nano Studio Conquest's military AI (sim/ai/operations.js and general.js) inside the tick, in plain
// Node, on the engine bench's world: a generated 5,000 province map with 16 nations at war with every neighbour and
// 2,000 divisions, every nation run by the AI. After a 10 day warm-up it times 30 game days of tick.step(ctx, 24),
// with each AI layer's run timed on its own, and prints ms per game day for the layers together (median and range
// over runs; budget 60), the share of operations and general, the orders the AI gave and how many were refused, and
// the slowest single layer call (the work cap bounds it).
// Usage: node verify/conquest-ai-bench.mjs [--runs 3]
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sim = (f) => require(`../renderer/features/conquest/sim/${f}`);
const G = sim('mapgen.js');
const ST = sim('state.js');
const T = sim('tick.js');
const O = sim('orders.js');
sim('ai/operations.js');
sim('ai/general.js');
const rules = JSON.parse(readFileSync(new URL('../renderer/features/conquest/data/units.json', import.meta.url), 'utf8'));
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;

function setup() {
  const { map, scenario } = G.generate({ seed: 1914, provinces: 5000, nations: 16, divisions: 2000 });
  const owner = {};
  for (const [tag, list] of Object.entries(scenario.owner)) for (const p of list) owner[p] = tag;
  const wars = new Set();
  for (const p of map.provinces) {
    if (!p || p.sea) continue;
    for (const q of p.adj) if (owner[q] && owner[q] !== owner[p.id]) wars.add([owner[p.id], owner[q]].sort().join('|'));
  }
  scenario.wars = [...wars].sort().map((k) => k.split('|'));
  return { map, scenario, rules, state: ST.create(map, scenario, rules, { seed: 1, player: -1 }) };
}

const apply0 = O.apply;
let orders = 0;
let refused = 0;
O.apply = (ctx, n, o) => { const r = apply0(ctx, n, o); orders++; if (!r.ok) refused++; return r; };

const spent = new Map();
let slowest = { ms: 0, layer: '', hour: 0, nation: 0 };
for (const layer of T.LAYERS) {
  const run = layer.run;
  layer.run = (ctx, n) => {
    const t = performance.now();
    run(ctx, n);
    const ms = performance.now() - t;
    spent.set(layer.name, (spent.get(layer.name) || 0) + ms);
    if (ms > slowest.ms) slowest = { ms, layer: layer.name, hour: ctx.state.hour, nation: n };
  };
}

function measure() {
  const ctx = setup();
  for (let day = 0; day < 10; day++) T.step(ctx, 24);
  spent.clear();
  slowest = { ms: 0, layer: '', hour: 0, nation: 0 };
  orders = 0;
  refused = 0;
  let total = 0;
  for (let day = 0; day < 30; day++) { const t = performance.now(); T.step(ctx, 24); total += performance.now() - t; }
  const layers = [...spent].map(([k, v]) => [k, v / 30]);
  return { ai: layers.reduce((s, [, v]) => s + v, 0), layers, total: total / 30, orders: orders / 30, refused, slowest, divs: ctx.state.divs.length };
}

const all = [];
for (let i = 0; i < runs; i++) all.push(measure());
const ai = all.map((r) => r.ai).sort((a, b) => a - b);
const r0 = all[0];
console.log(`5000 provinces, 16 nations, ${r0.divs} divisions at the end; ${Math.round(r0.orders)} AI orders per game day, ${all.reduce((s, r) => s + r.refused, 0)} refused`);
console.log(`AI layers, ms per game day (mean of 30 days): median ${ai[ai.length >> 1].toFixed(1)}, range ${ai[0].toFixed(1)}-${ai[ai.length - 1].toFixed(1)} over ${runs} runs (budget 60)`);
console.log(`split: ${r0.layers.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}; whole tick with the AI ${r0.total.toFixed(1)} ms per day`);
console.log(`slowest single call: ${r0.slowest.layer} for nation ${r0.slowest.nation} at hour ${r0.slowest.hour}, ${r0.slowest.ms.toFixed(1)} ms`);
