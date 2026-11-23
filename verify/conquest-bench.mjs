// The speed of Nano Studio Conquest's simulation in plain Node (plan section 8, stage 0: a game day with 2,000
// divisions in under 200 ms at top speed). A generated 5,000 province map with 16 nations at war with every
// neighbour, 2,000 divisions, 40 islands held as colonies with garrisons, and sea control on (every nation has a
// navy). Each day a third of the divisions (id % 3 === 0) that stand still are sent into a neighbouring enemy
// province, or a neighbouring own one when there is none, and every 50th one to another nation's colony (by sea
// when the route says so). After a 10 day warm-up it times 30 days of tick.step(ctx, 24), prints ms per game day
// (median, range), how many divisions were moving or fighting, and the time each tick system took in a separate
// instrumented pass. Last, the AI's load: 2,000 orders.legal and 2,000 movement.path calls of moves to enemy
// provinces anywhere on the map, ms in total.
// Usage: node verify/conquest-bench.mjs [--runs 5]
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sim = (f) => require(`../renderer/features/conquest/sim/${f}`);
const G = sim('mapgen.js');
const ST = sim('state.js');
const T = sim('tick.js');
const O = sim('orders.js');
const M = sim('mapdata.js');
const MV = sim('movement.js');
const rules = JSON.parse(readFileSync(new URL('../renderer/features/conquest/data/units.json', import.meta.url), 'utf8'));
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 5;

function setup() {
  const { map, scenario } = G.generate({ seed: 1914, provinces: 5000, nations: 16, divisions: 2000, islands: 40 });
  const owner = {};
  for (const [tag, list] of Object.entries(scenario.owner)) for (const p of list) owner[p] = tag;
  const wars = new Set();
  for (const p of map.provinces) {
    if (!p || p.sea) continue;
    for (const q of p.adj) if (owner[q] && owner[q] !== owner[p.id]) wars.add([owner[p.id], owner[q]].sort().join('|'));
  }
  scenario.wars = [...wars].sort().map((k) => k.split('|'));
  return { map, scenario, rules, state: ST.create(map, scenario, rules, { seed: 1 }) };
}

function orders(ctx) {
  const { state, map, scenario } = ctx;
  const rel = M.relations(state);
  const colonies = scenario.armies.filter((a) => a.name.includes('Garrison')).map((a) => a.at[0]);
  let refused = 0;
  for (const d of state.divs) {
    if (d.id % 3 !== 0 || d.to !== null || map.provinces[d.prov].sea) continue;
    if (d.id % 50 === 0) {
      const at = colonies[(d.id / 50 + state.hour / 24) % colonies.length];
      if (state.prov.ctrl[at] !== d.nation && at !== d.prov && !O.apply(ctx, d.nation, { type: 'move', div: d.id, to: at }).ok) refused++;
      continue;
    }
    const adj = map.provinces[d.prov].adj.filter((q) => !map.provinces[q].sea);
    const enemy = adj.find((q) => M.hostile(rel, d.nation, state.prov.ctrl[q]));
    const target = enemy !== undefined ? enemy : adj[(state.hour / 24 + d.id) % adj.length];
    if (target !== undefined && !O.apply(ctx, d.nation, { type: 'move', div: d.id, to: target }).ok) refused++;
  }
  return refused;
}

function active(ctx) {
  const fighting = new Set();
  for (const b of ctx.state.battles) { for (const id of b.att) fighting.add(id); for (const id of b.def) fighting.add(id); }
  return ctx.state.divs.filter((d) => d.to !== null || fighting.has(d.id)).length;
}

function measure() {
  const ctx = setup();
  for (let day = 0; day < 10; day++) { orders(ctx); T.step(ctx, 24); }
  const days = [];
  let act = 0;
  let refused = 0;
  let atSea = 0;
  for (let day = 0; day < 30; day++) {
    refused += orders(ctx);
    act += active(ctx);
    const t = performance.now();
    T.step(ctx, 24);
    days.push(performance.now() - t);
    atSea = Math.max(atSea, ctx.state.divs.filter((d) => ctx.map.provinces[d.prov].sea).length);
  }
  const zones = ctx.map.provinces.filter((p) => p && p.sea);
  const held = zones.filter((p) => ctx.state.sea.ctrl[p.id] >= 0).length;
  const sunk = ctx.state.log.filter((e) => e.kind === 'sunk').length;
  return { ms: days.reduce((a, b) => a + b, 0) / days.length, active: act / 30, divs: ctx.state.divs.length, battles: ctx.state.battles.length, refused, zones: zones.length, held, atSea, sunk };
}

const all = [];
for (let i = 0; i < runs; i++) all.push(measure());
const ms = all.map((r) => r.ms).sort((a, b) => a - b);
const r0 = all[0];
console.log(`5000 provinces, ${r0.zones} sea zones (${r0.held} controlled at the end), ${r0.divs} divisions at the end, ${Math.round(r0.active)} moving or fighting per day on average, up to ${r0.atSea} at sea, ${r0.battles} battles open, ${r0.refused} refused orders`);
console.log(`ms per game day (24 ticks, mean of 30 days): median ${ms[ms.length >> 1].toFixed(1)}, range ${ms[0].toFixed(1)}-${ms[ms.length - 1].toFixed(1)} over ${runs} runs (target 200)`);

const ctx = setup();
for (let day = 0; day < 10; day++) { orders(ctx); T.step(ctx, 24); }
const spent = new Map();
for (const s of T.SYSTEMS) {
  const run = s.run;
  if (!run) continue;
  s.run = (...args) => { const t = performance.now(); run(...args); spent.set(s.name, (spent.get(s.name) || 0) + performance.now() - t); };
}
let total = 0;
for (let day = 0; day < 30; day++) { orders(ctx); const t = performance.now(); T.step(ctx, 24); total += performance.now() - t; }
total /= 30;
const parts = [...spent].map(([k, v]) => [k, v / 30]).sort((a, b) => b[1] - a[1]);
const sum = parts.reduce((a, [, v]) => a + v, 0);
console.log(`instrumented pass, ms per day: ${parts.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}, the rest (world index, layers) ${(total - sum).toFixed(2)}`);

{
  const { state } = ctx;
  const rel = M.relations(state);
  const N = ctx.map.provinces.length;
  const pairs = [];
  for (let i = 0; pairs.length < 2000 && i < 100000; i++) {
    const d = state.divs[(i * 7919) % state.divs.length];
    if (d.to !== null || ctx.map.provinces[d.prov].sea) continue;
    for (let t = 0; t < 50; t++) {
      const p = 1 + ((d.id * 104729 + i * 31 + t * 7) % (N - 1));
      if (!ctx.map.provinces[p].sea && M.hostile(rel, d.nation, state.prov.ctrl[p])) { pairs.push([d, p]); break; }
    }
  }
  const reasons = new Map();
  let found = 0;
  let t0 = performance.now();
  for (const [d, p] of pairs) {
    const r = O.legal(ctx, d.nation, { type: 'move', div: d.id, to: p });
    reasons.set(r.reason || 'ok', (reasons.get(r.reason || 'ok') || 0) + 1);
  }
  const tLegal = performance.now() - t0;
  M.touchRelations(state);
  t0 = performance.now();
  for (const [d, p] of pairs) if (MV.path(ctx, M.relations(state), d, p)) found++;
  const tPath = performance.now() - t0;
  t0 = performance.now();
  for (const [d, p] of pairs) { O.legal(ctx, d.nation, { type: 'move', div: d.id, to: p }); MV.path(ctx, M.relations(state), d, p); }
  const tPair = performance.now() - t0;
  console.log(`AI load: ${pairs.length} orders.legal + ${pairs.length} movement.path calls to enemy provinces, ${(tLegal + tPath).toFixed(0)} ms total with no kept answers (legal ${tLegal.toFixed(0)}, path ${tPath.toFixed(0)}; legal answers ${[...reasons].map(([k, v]) => `${k} ${v}`).join(', ')}; ${found} paths); legal then path of the same move: ${tPair.toFixed(0)} ms`);
}
