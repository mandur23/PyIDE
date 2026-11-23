// Nano Studio Conquest's simulation (renderer/features/conquest/sim, docs/conquest-architecture.md) in plain Node:
// - generated maps of 8, 200 and 5000 provinces: the same for the same seed, ids without gaps, adjacency symmetric,
//   one connected landmass, every land province owned once, rivers a symmetric subset of adjacency;
// - determinism: a 60 day war on a 200 province map with scripted orders from two nations gives the same hash on
//   every day twice; another seed gives other hashes; save, read and continue gives the same daily hashes;
// - illegal orders refused with their reason and the hash unchanged; legal() answers as apply() does;
// - combat odds: 10,000 seeded 1-v-1 battles per case within 1 point of combat.js's formula, and river, hills,
//   trenches and an unsupplied defender each moving it the documented way;
// - supply: a division cut off loses sup, org and strength and fights weaker; retaking the link restores it;
// - an 8 province war played by orders to a province changing controller; industry: lines, training, building;
// - host.js answering init, order, speed, save and unknown messages; sim/modules.json loading as page scripts
//   through globalThis.Conquest and giving the same hashes as Node (the same modules required on both sides);
// - the sea: port-to-port and beach voyages in the documented hours, a closed lane refused, a division sunk when its
//   zone turns hostile, straits, an island garrison supplied over a lane and cut off by sea control, landings
//   (10,000 battles against the formula), shells, blockade and resources, non-core yield, casualty accounting,
//   unlock dates, co-belligerents in one battle, and determinism and save/continue on a map with islands and
//   overseas colonies;
// - the defending line (at most combat.LINE defenders, a late reinforcement joining, the rest falling back when it
//   breaks), pursuit (a won battle takes a province not dug in within the hour, a dug-in one at the attackers' pace),
//   a move with own (over own land or sea, no-path, bad-order) and the province query's works, dug, trench and line;
// - the battle query: its factors, folded here, give each hour's b.odds for a plain attack and one across a river into
//   works, and the roles it reports are the divisions that fought that hour.
// Usage: node verify/conquest-engine.mjs
import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import vm from 'vm';

const require = createRequire(import.meta.url);
const SIM = new URL('../renderer/features/conquest/sim/', import.meta.url);
const sim = (f) => require(`../renderer/features/conquest/sim/${f}`);
const G = sim('mapgen.js');
const ST = sim('state.js');
const T = sim('tick.js');
const H = sim('hash.js');
const O = sim('orders.js');
const SV = sim('save.js');
const MV = sim('movement.js');
const CB = sim('combat.js');
const F = sim('fixed.js');
const HOST = sim('host.js');
const rules = JSON.parse(readFileSync(new URL('../renderer/features/conquest/data/units.json', import.meta.url), 'utf8'));

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); else if (process.env.CONQUEST_VERBOSE) console.log(`ok ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }

function borderPair(map, scenario) {
  const owner = {};
  for (const [tag, list] of Object.entries(scenario.owner)) for (const p of list) owner[p] = tag;
  const tags = scenario.nations.map((n) => n.tag);
  for (let a = 0; a < tags.length; a++) {
    for (let b = a + 1; b < tags.length; b++) {
      if (scenario.owner[tags[a]].some((p) => map.provinces[p].adj.some((q) => owner[q] === tags[b]))) return [a, b];
    }
  }
  return null;
}

function world(seed, provinces, nations) {
  const { map, scenario } = G.generate({ seed: 11, provinces, nations });
  const [a, b] = borderPair(map, scenario);
  scenario.wars = [[scenario.nations[a].tag, scenario.nations[b].tag]];
  const state = ST.create(map, scenario, rules, { seed, player: a });
  return { ctx: { map, scenario, rules, state }, a, b };
}

// The scripted orders of the determinism and save runs: a function of the day and the state only.
function script(ctx, day, a, b, answers) {
  const { state, scenario } = ctx;
  const capA = scenario.nations[a].capital;
  const capB = scenario.nations[b].capital;
  const say = (n, o) => answers.push(O.apply(ctx, n, o).ok);
  if (day === 0) {
    for (const d of state.divs) if (d.nation === a) say(a, { type: 'move', div: d.id, to: capB });
    for (const d of state.divs) if (d.nation === b && d.id % 2 === 0) say(b, { type: 'move', div: d.id, to: capA });
  }
  if (day === 3) {
    say(a, { type: 'train', template: 'inf14', count: 2, at: capA });
    say(b, { type: 'build', what: 'infra', province: capB });
    say(a, { type: 'line', item: 'rifles', factories: 1 });
  }
  if (day === 8) {
    say(a, { type: 'template', template: { id: 'inf15', name: 'Infantry 1915', line: ['inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'art', 'art', 'art', 'mg', 'mg', 'mg'], support: ['eng'] } });
    const army = state.nations[b].armies[0];
    if (army) {
      say(b, { type: 'front', army: army.id, provinces: [capB] });
      const r = O.apply(ctx, b, { type: 'offensive', army: army.id, path: [capA] });
      answers.push(r.ok);
      say(b, { type: 'launch', army: army.id, offensive: r.id, on: true });
    }
  }
  if (day % 7 === 6) {
    for (const d of state.divs) {
      if (d.nation !== a || d.to !== null) continue;
      const target = ctx.map.provinces[d.prov].adj.find((q) => !ctx.map.provinces[q].sea && state.prov.ctrl[q] === b);
      if (target) say(a, { type: 'move', div: d.id, to: target });
    }
    const idle = state.divs.find((d) => d.nation === b && d.to === null);
    if (idle) say(b, { type: 'halt', div: idle.id });
  }
}

function run(seed, days, from = null) {
  const w = from || world(seed, 200, 4);
  const hashes = [];
  const answers = [];
  const start = Math.floor(w.ctx.state.hour / 24);
  const changed = [];
  for (let day = start; day < days; day++) {
    script(w.ctx, day, w.a, w.b, answers);
    changed.push(...T.step(w.ctx, 24).provinces);
    hashes.push(H.hash(w.ctx.state));
  }
  return { ...w, hashes, answers, changed };
}

await section('maps', () => {
  for (const n of [8, 200, 5000]) {
    const one = G.generate({ seed: 5, provinces: n, nations: n < 20 ? 2 : 8 });
    const two = G.generate({ seed: 5, provinces: n, nations: n < 20 ? 2 : 8 });
    eq(H.hash(one), H.hash(two), `${n}: the same seed gives the same map and scenario`);
    check(H.hash(G.generate({ seed: 6, provinces: n, nations: 2 }).map) !== H.hash(one.map), `${n}: another seed gives another map`);
    const P = one.map.provinces;
    const land = P.filter((p) => p && !p.sea);
    eq(land.length, n, `${n}: as many land provinces as asked`);
    check(P.every((p, i) => (i === 0 ? p === null : p.id === i)), `${n}: ids are 1..N without gaps`);
    check(P.every((p) => !p || p.adj.every((q) => P[q] && P[q].adj.includes(p.id) && q !== p.id)), `${n}: adjacency symmetric`);
    check(land.every((p) => p.river.every((q) => p.adj.includes(q) && P[q].river.includes(p.id))), `${n}: rivers are a symmetric subset of adjacency`);
    const seen = new Set([land[0].id]);
    const queue = [land[0].id];
    for (let i = 0; i < queue.length; i++) for (const q of P[queue[i]].adj) if (!P[q].sea && !seen.has(q)) { seen.add(q); queue.push(q); }
    eq(seen.size, n, `${n}: one connected landmass`);
    const owned = Object.values(one.scenario.owner).flat().sort((x, y) => x - y);
    eq(owned, land.map((p) => p.id), `${n}: every land province owned exactly once`);
    eq(one.map.cells.length, P.length, `${n}: a cell list per province`);
    check(one.scenario.nations.every((s) => one.scenario.owner[s.tag].includes(s.capital)), `${n}: every capital is its nation's`);
    if (n === 5000) {
      const sizes = one.scenario.nations.map((s) => one.scenario.owner[s.tag].length);
      check(Math.max(...sizes) <= 3 * Math.min(...sizes), `5000: nation sizes within 3x of each other (${sizes})`);
      check(new Set(land.map((p) => p.terrain)).size >= 5 && new Set(land.map((p) => p.climate)).size >= 3, '5000: several terrains and climates');
    }
  }
});

await section('determinism', () => {
  const r1 = run(1, 60);
  const r2 = run(1, 60);
  eq(r1.hashes.length, 60, 'a hash for each of 60 days');
  eq(r1.hashes, r2.hashes, 'same seed and orders: the same hash on every day of 60');
  check(r1.answers.length > 20 && r1.answers.filter(Boolean).length > 20, `the script's orders were accepted (${r1.answers.filter(Boolean).length}/${r1.answers.length})`);
  check(r1.ctx.state.log.some((e) => e.kind === 'battle'), 'battles were fought');
  check(r1.changed.length > 0, `provinces changed controller (${r1.changed.length})`);
  check(r1.ctx.state.nations[r1.a].templates.some((t) => t.id === 'inf15'), 'the template order took effect');
  const r3 = run(2, 60);
  check(r3.hashes[59] !== r1.hashes[59] && r3.hashes.filter((h, i) => h !== r1.hashes[i]).length === 60, 'another seed: other hashes');
});

await section('save', () => {
  const full = run(1, 60);
  const half = run(1, 30);
  const text = SV.write(half.ctx.state);
  const back = SV.read(text);
  check(back.ok, 'a written save reads back');
  eq(H.hash(back.state), half.hashes[29], 'the read state has the hash of the written one');
  check(back.state.prov.owner instanceof Int16Array && back.state.prov.weather instanceof Uint8Array, 'province arrays are typed again');
  const cont = run(1, 60, { ctx: { ...half.ctx, state: back.state }, a: half.a, b: half.b });
  eq(half.hashes.concat(cont.hashes), full.hashes, 'save at day 30, read, continue: the same daily hashes as the uninterrupted run');
  eq(SV.read('{oops').reason, 'not-json', 'a broken file: not-json');
  eq(SV.read('{"format":"other","v":1}').reason, 'not-a-save', 'another JSON file: not-a-save');
  eq(SV.read(text.replace('"v":1,"state"', '"v":2,"state"')).reason, 'newer-version', 'a save of a later version: newer-version');
  const bad = JSON.parse(text);
  bad.state.divs[0].prov = 99999;
  eq(SV.read(JSON.stringify(bad)).reason, 'bad-state', 'a damaged state: bad-state');
});

await section('illegal orders', () => {
  const { ctx, a, b } = world(3, 200, 4);
  const { state, scenario, map } = ctx;
  O.apply(ctx, a, { type: 'template', template: { id: 'horse', name: 'Horse', line: Array(25).fill('cav') } });
  const capA = scenario.nations[a].capital;
  for (let i = 0; i < 4; i++) O.apply(ctx, a, { type: 'build', what: 'infra', province: capA });
  const third = [0, 1, 2, 3].find((n) => n !== a && n !== b);
  const mine = state.divs.find((d) => d.nation === a);
  const theirs = state.divs.find((d) => d.nation === b);
  const sea = map.provinces.find((p) => p && p.sea).id;
  const enemyLand = scenario.owner[scenario.nations[b].tag][0];
  const cases = [
    [{ type: 'move', div: theirs.id, to: capA }, 'not-yours', "moving another nation's division"],
    [{ type: 'move', div: mine.id, to: scenario.nations[third].capital }, 'no-path', 'a step to a neutral capital with no path'],
    [{ type: 'move', div: mine.id, to: sea }, 'sea', 'a move into a sea zone'],
    [{ type: 'move', div: mine.id, to: mine.prov }, 'already-there', 'a move to where it stands'],
    [{ type: 'move', div: 999999, to: capA }, 'no-such-division', 'a division that does not exist'],
    [{ type: 'move', div: mine.id, to: 999999 }, 'no-such-province', 'a province that does not exist'],
    [{ type: 'train', template: 'inf14', count: 50, at: capA }, 'no-manpower', 'training without manpower'],
    [{ type: 'train', template: 'horse', count: 1, at: capA }, 'no-equipment', 'training without equipment'],
    [{ type: 'train', template: 'inf14', count: 1, at: enemyLand }, 'bad-province', 'training in an enemy province'],
    [{ type: 'train', template: 'nope', count: 1, at: capA }, 'no-such-template', 'training an unknown template'],
    [{ type: 'template', template: { id: 'tk', name: 'Tanks', line: ['tank'] } }, 'locked-branch', 'a template with a locked branch'],
    [{ type: 'template', template: { id: 'x', name: 'X', line: ['inf', 'laser'] } }, 'unknown-branch', 'a template with an unknown branch'],
    [{ type: 'line', item: 'rifles', factories: 9999 }, 'not-enough-factories', 'a line with more factories than the nation has'],
    [{ type: 'line', item: 'cake', factories: 1 }, 'unknown-item', 'a line of an unknown item'],
    [{ type: 'build', what: 'infra', province: capA }, 'at-cap', 'building past the cap (queued builds count)'],
    [{ type: 'build', what: 'castle', province: capA }, 'unknown-building', 'an unknown building'],
    [{ type: 'build', what: 'mil', province: enemyLand }, 'bad-province', 'building in an enemy province'],
    [{ type: 'assign', div: mine.id, army: 424242 }, 'no-such-army', 'assigning to an army that does not exist'],
    [{ type: 'launch', army: state.nations[a].armies[0].id, offensive: 77, on: true }, 'no-such-offensive', 'launching an offensive that does not exist'],
    [{ type: 'diplo', action: 'war', to: 'N01' }, 'not-implemented', 'diplomacy before diplomacy.js'],
    [{ type: 'fly' }, 'unknown-order', 'an unknown order type'],
    [null, 'bad-order', 'not an order'],
  ];
  for (const [order, reason, label] of cases) {
    const before = H.hash(state);
    const legal = O.legal(ctx, a, order);
    const applied = O.apply(ctx, a, order);
    check(!applied.ok && applied.reason === reason && legal.reason === reason && H.hash(state) === before, `${label}: refused with ${reason}${applied.reason === reason ? '' : ` (got ${applied.reason})`}, state unchanged`);
  }
  eq(O.apply(ctx, 99, { type: 'halt', div: mine.id }).reason, 'no-such-nation', 'an order for a nation that does not exist');
  const before = H.hash(state);
  check(O.legal(ctx, a, { type: 'halt', div: mine.id }).ok && H.hash(state) === before, 'legal() of a good order changes nothing');
});

// Three provinces in a line, 1 (A) - 2 (B) - 3 (B), one inf14 division each side, A attacking 2 from 1.
function duel({ terrain = 'plains', river = false, sea = false, port = false } = {}) {
  const p = (id, adj, extra = {}) => ({ id, name: `P${id}`, sea: false, iso: 'T', x: id * 10, y: 0, lon: 0, lat: 50, area: 2500, terrain: 'plains', climate: 'temperate', coastal: false, port: false, adj, river: [], ...extra });
  const map = { v: 1, id: 't', name: 't', texture: { file: null, width: 40, height: 10 }, projection: { type: 'equirect', lon0: 0, lat0: 0, pxPerDeg: 1 }, straits: [],
    provinces: [null, p(1, sea ? [2, 4] : [2], { river: river ? [2] : [] }), p(2, sea ? [1, 3, 4] : [1, 3], { terrain, river: river ? [1] : [], coastal: sea, port }), p(3, [2])]
      .concat(sea ? [{ id: 4, name: 'Z4', sea: true, x: 0, y: 0, lon: 0, lat: 50, area: 2500, adj: [1, 2] }] : []) };
  const tpl = { id: 'inf14', name: 'Inf', line: ['inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'art', 'art', 'mg', 'mg'], support: ['eng', 'cav'] };
  const nation = (tag, capital) => ({ tag, name: tag, color: '#888888', capital, bloc: null, major: true, navy: 0, manpower: 1000000, personality: {}, goals: [], generals: [], templates: [tpl], lines: [] });
  const scenario = { v: 1, id: 't', map: 't', name: 't', start: '1914-06-28', end: '1920-01-01', nations: [nation('AAA', 1), nation('BBB', 3)],
    owner: { AAA: [1], BBB: [2, 3] }, cores: {}, provinces: {}, alliances: [], wars: [['AAA', 'BBB']], events: [],
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 1, at: [1] }, { nation: 'BBB', name: 'B', general: null, template: 'inf14', divisions: 1, at: [2] }] };
  return { map, scenario, rules, state: ST.create(map, scenario, rules, { seed: 99 }) };
}

function battles(ctx, count, { dig = 0, defSup = 1000, attSup = 1000, from = 1 } = {}) {
  const { state } = ctx;
  const [att, def] = state.divs;
  let won = 0;
  for (let k = 0; k < count; k++) {
    Object.assign(att, { prov: from, to: 2, eta: 1000, path: [], str: 1000, org: 1000, dig: 0, sup: attSup });
    Object.assign(def, { prov: 2, to: null, eta: 0, path: [], str: 1000, org: 1000, dig, sup: defSup });
    state.battles = [];
    for (const n of state.nations) n.stock.shells = 1000000;
    state.prov.weather.fill(0);
    const out = { provinces: [], divs: false, battles: false, events: [] };
    for (let h = 0; h < 200; h++) {
      const w = T.world(ctx);
      MV.hour(ctx, w, out);
      CB.hour(ctx, w, out);
      if (!state.battles.length) break;
    }
    if (def.prov !== 2 || def.str <= 0) won++;
  }
  return won / count;
}

// combat.js's formula, computed here from units.json alone.
function predict({ terrain = 'plains', river = false, dig = 0, defSup = 1000, attSup = 1000, from = 1, port = false, shells = true } = {}) {
  const B = Object.fromEntries(rules.branches.map((b) => [b.id, b]));
  const counts = { inf: 8000, art: 2000, mg: 2000, eng: rules.template.support, cav: rules.template.support };
  const C = rules.combat;
  const sum = (f) => Object.entries(counts).reduce((s, [b, c]) => s + F.mul(c, f(B[b])), 0);
  let base = 0;
  for (const [b, c] of Object.entries(counts)) {
    let red = 0;
    for (const [d, cd] of Object.entries(counts)) red += F.mul(cd, (rules.counters[d] || {})[b] || 0);
    const x = F.mul(F.mul(c, B[b].attack), 1000 - Math.min(C.counterCap, red));
    base += B[b].shells > 0 && !shells ? F.mul(x, C.noShells) : x;
  }
  base += sum((b) => b.breakthrough);
  const defence = sum((b) => b.defence);
  const siege = sum((b) => b.siege);
  const T0 = rules.terrain.find((t) => t.id === terrain);
  const supF = (s) => rules.supply.outOfSupply + F.mul(1000 - rules.supply.outOfSupply, s);
  const riverF = Math.min(1000, C.river + Math.min(C.riverCap, sum((b) => b.river)));
  const A = (str) => { let a = F.mul(base, str); a = F.mul(a, T0.attack); a = F.mul(a, 1000); if (river) a = F.mul(a, riverF); if (from === 4) a = F.mul(a, port ? rules.naval.landPort : rules.naval.landBeach); a = F.mul(a, supF(attSup)); return F.mul(a, 1000); };
  const D = (str) => { let d = F.mul(defence, str); d = F.mul(d, T0.defence); d = F.mul(d, 1000 + Math.trunc((C.dig * Math.max(0, dig - siege)) / 100)); return F.mul(d, supF(defSup)); };
  const org = Math.trunc((60 * 8 + 20 * 2 + 40 * 2) * 1000 / 12);
  const n = Math.ceil(1000 / Math.trunc((C.orgHit * C.orgRef) / org));
  const win = Array.from({ length: n + 1 }, () => new Float64Array(n + 1));
  for (let i = n; i >= 0; i--) {
    for (let j = n; j >= 0; j--) {
      if (i === n) { win[i][j] = 1; continue; }
      if (j === n) { win[i][j] = 0; continue; }
      const a = A(1000 - C.strLoser * j - C.strWinner * i);
      const d = D(1000 - C.strLoser * i - C.strWinner * j);
      const p = Math.trunc((a * 1000) / (a + d)) / 1000;
      win[i][j] = p * win[i + 1][j] + (1 - p) * win[i][j + 1];
    }
  }
  return win[0][0];
}

await section('combat odds', () => {
  const N = 10000;
  const cases = [
    ['plains, no river, no trenches, supplied', {}, {}, null],
    ['across a river', { river: true }, {}, -1],
    ['into hills', { terrain: 'hills' }, {}, -1],
    ['against trenches (dig 300)', {}, { dig: 300 }, -1],
    ['against an unsupplied defender', {}, { defSup: 0 }, 1],
    ['an unsupplied attacker', {}, { attSup: 0 }, -1],
    ['a landing from the sea at a port', { sea: true, port: true }, { from: 4 }, -1],
    ['a landing from the sea on a beach', { sea: true }, { from: 4 }, -1],
  ];
  const base = predict();
  const odds = {};
  for (const [label, mapOpts, fightOpts, dir] of cases) {
    const want = predict({ ...mapOpts, ...fightOpts });
    const got = battles(duel(mapOpts), N, fightOpts);
    check(Math.abs(got - want) <= 0.01, `${label}: ${N} battles won ${(got * 100).toFixed(2)}%, formula ${(want * 100).toFixed(2)}%`);
    if (dir !== null) check(dir * (want - base) > 0.02 && dir * (got - base) > 0.01, `${label}: moves the attacker's odds ${dir < 0 ? 'down' : 'up'} from ${(base * 100).toFixed(1)}% to ${(got * 100).toFixed(1)}%`);
    odds[label] = got;
  }
  check(odds['a landing from the sea on a beach'] < odds['a landing from the sea at a port'] - 0.01, `a landing on a beach (${(odds['a landing from the sea on a beach'] * 100).toFixed(1)}%) is worse than at a port (${(odds['a landing from the sea at a port'] * 100).toFixed(1)}%)`);
});

// 1 (A capital) - 2 - 3 - 4 - 5, all A's; 6 (B) touches 3. A divisions at 2 and 4, B's at 6.
function corridor() {
  const p = (id, adj) => ({ id, name: `P${id}`, sea: false, iso: 'T', x: id * 10, y: 0, lon: 0, lat: 50, area: 2500, terrain: 'plains', climate: 'arid', coastal: false, port: false, adj, river: [] });
  const map = { v: 1, id: 'c', name: 'c', texture: { file: null, width: 70, height: 10 }, projection: { type: 'equirect', lon0: 0, lat0: 0, pxPerDeg: 1 }, straits: [],
    provinces: [null, p(1, [2]), p(2, [1, 3]), p(3, [2, 4, 6]), p(4, [3, 5]), p(5, [4]), p(6, [3])] };
  const tpl = { id: 'inf14', name: 'Inf', line: ['inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'art', 'art', 'mg', 'mg'], support: ['eng', 'cav'] };
  const nation = (tag, capital) => ({ tag, name: tag, color: '#888888', capital, bloc: null, major: true, manpower: 1000000, personality: {}, goals: [], generals: [], templates: [tpl], lines: [] });
  const scenario = { v: 1, id: 'c', map: 'c', name: 'c', start: '1914-06-28', end: '1920-01-01', nations: [nation('AAA', 1), nation('BBB', 6)],
    owner: { AAA: [1, 2, 3, 4, 5], BBB: [6] }, cores: {}, provinces: {}, alliances: [], wars: [['AAA', 'BBB']], events: [],
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 2, at: [2, 4] }, { nation: 'BBB', name: 'B', general: null, template: 'inf14', divisions: 1, at: [6] }] };
  return { map, scenario, rules, state: ST.create(map, scenario, rules, { seed: 5 }) };
}

await section('supply', () => {
  const ctx = corridor();
  const { state } = ctx;
  const [guard, cut, raider] = state.divs;
  eq([guard.sup, cut.sup], [1000, 1000], 'both divisions supplied at the start');
  T.step(ctx, 24 * 3);
  const before = { org: cut.org, str: cut.str, power: CB.defencePower(ctx, cut, 4, 1000000) };
  check(O.apply(ctx, 1, { type: 'move', div: raider.id, to: 3 }).ok, 'the raider is ordered into the corridor');
  let h = 0;
  while (state.prov.ctrl[3] !== 1 && h++ < 200) T.step(ctx, 1);
  eq(state.prov.ctrl[3], 1, 'the raider takes the empty corridor province');
  T.step(ctx, 25 - (state.hour % 24));
  eq([state.prov.supply[4], cut.sup], [0, 0], 'the next supply day: province 4 and its division are cut off');
  T.step(ctx, 48);
  check(cut.org < before.org && cut.str < before.str, `cut off for two days: org ${before.org} -> ${cut.org}, strength ${before.str} -> ${cut.str}`);
  const weak = CB.defencePower(ctx, cut, 4, 1000000);
  check(weak < F.mul(before.power, 600), `it defends with ${weak} instead of ${before.power}`);
  check(O.apply(ctx, 1, { type: 'move', div: raider.id, to: 6 }).ok && O.apply(ctx, 0, { type: 'move', div: guard.id, to: 3 }).ok, 'the raider leaves and the guard moves to retake the link');
  h = 0;
  while (state.prov.ctrl[3] !== 0 && h++ < 200) T.step(ctx, 1);
  eq(state.prov.ctrl[3], 0, 'the guard retakes the corridor (back to its owner)');
  T.step(ctx, 25 - (state.hour % 24));
  check(cut.sup > 0 && state.prov.supply[4] > 0, `the next supply day: supplied again (sup ${cut.sup})`);
  const low = cut.org;
  T.step(ctx, 24);
  check(cut.org > low, `org recovers once supplied (${low} -> ${cut.org})`);
  T.step(ctx, 24 * 4);
  check(cut.str > before.str - 10 && CB.defencePower(ctx, cut, 4, 1000000) > weak, `strength is reinforced from stock (${cut.str}) and it defends with ${CB.defencePower(ctx, cut, 4, 1000000)} again`);
});

await section('war on 8 provinces', () => {
  const { map, scenario } = G.generate({ seed: 21, provinces: 8, nations: 2 });
  scenario.wars = [[scenario.nations[0].tag, scenario.nations[1].tag]];
  const ctx = { map, scenario, rules, state: ST.create(map, scenario, rules, { seed: 4 }) };
  const { state } = ctx;
  const capB = scenario.nations[1].capital;
  const taken = [];
  for (let day = 0; day < 60 && !taken.length; day++) {
    for (const d of state.divs) if (d.nation === 0 && d.to === null && d.prov !== capB) O.apply(ctx, 0, { type: 'move', div: d.id, to: capB });
    for (const p of T.step(ctx, 24).provinces) if (state.prov.ctrl[p] === 0 && state.prov.owner[p] === 1) taken.push(p);
  }
  check(taken.length > 0, `nation 0 takes a province of nation 1 by orders alone (${taken}, day ${Math.floor(state.hour / 24)})`);
  check(state.log.some((e) => e.kind === 'taken' && e.by === 0), 'the capture is in the log');
});

await section('industry', () => {
  const { ctx, a } = world(8, 200, 4);
  const { state, scenario } = ctx;
  const nat = state.nations[a];
  const capA = scenario.nations[a].capital;
  const rifles = nat.stock.rifles;
  const divs = state.divs.filter((d) => d.nation === a).length;
  const mp = nat.manpower;
  const r = O.apply(ctx, a, { type: 'train', template: 'inf14', count: 1, at: capA });
  check(r.ok && nat.manpower < mp && nat.stock.rifles < rifles, 'training pays manpower and rifles when ordered');
  const civ0 = state.prov.infra[capA];
  O.apply(ctx, a, { type: 'build', what: 'infra', province: capA });
  T.step(ctx, 24 * (rules.train.days - 1));
  eq(state.divs.filter((d) => d.nation === a).length, divs, `no new division before ${rules.train.days} days`);
  T.step(ctx, 48);
  eq(state.divs.filter((d) => d.nation === a).length, divs + 1, 'the division is ready after its training days');
  check(state.divs.some((d) => d.nation === a && d.prov === capA && d.army === null), 'at the province it was ordered at, outside any army');
  eq(state.prov.infra[capA], civ0 + 1, 'the queued infrastructure was built');
  check(nat.lines.every((l) => l.factories === 0 || l.eff > rules.industry.effStart), 'running lines gain efficiency');
  check(nat.stock.rifles > rifles - 1000, `the rifle line produced (${rifles} -> ${nat.stock.rifles})`);
});

await section('host', () => {
  const posted = [];
  const timers = [];
  const host = HOST.createHost((m) => posted.push(m), { set: (fn) => { timers.push(fn); return timers.length; }, clear: () => {} });
  const { map, scenario } = G.generate({ seed: 2, provinces: 30, nations: 2 });
  host.receive({ type: 'init', map, scenario, rules, seed: 3, player: 0 });
  eq(posted[0].type, 'ready', 'init answers ready');
  eq(posted[0].snapshot.hour, 0, 'with the state at hour 0');
  const d = host.ctx.state.divs.find((x) => x.nation === 0);
  host.receive({ type: 'order', id: 1, order: { type: 'halt', div: d.id } });
  eq([posted[1].type, posted[1].id, posted[1].ok], ['orderResult', 1, true], 'an order is answered by id');
  host.receive({ type: 'order', id: 2, order: { type: 'move', div: d.id, to: 999999 } });
  eq([posted[2].ok, posted[2].reason], [false, 'no-such-province'], 'a refused order carries its reason');
  host.receive({ type: 'speed', n: 5 });
  timers.shift()();
  const t = posted[3];
  check(t && t.type === 'tick' && t.hour === 6 && Array.isArray(t.provinces) && Array.isArray(t.nations), 'speed 5 runs a batch and posts a tick');
  host.receive({ type: 'speed', n: 0 });
  host.receive({ type: 'save', id: 9 });
  const saved = posted.find((m) => m.type === 'saved');
  check(saved && saved.id === 9 && SV.read(saved.text).ok, 'save answers the save text, which reads back');
  host.receive({ type: 'jump' });
  eq(posted[posted.length - 1].reason, 'unknown-message', 'an unknown message answers an error');
  host.receive({ type: 'init', save: '{nope' });
  eq(posted[posted.length - 1].reason, 'not-json', 'init from an unreadable save answers its reason');
});

const INF14 = { id: 'inf14', name: 'Inf', line: ['inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'art', 'art', 'mg', 'mg'], support: ['eng', 'cav'] };

// A small hand-made world: provs [{ id, adj, sea, port, area }] in id order, nations [{ tag, capital, navy }].
function mk({ provs, nations, owner, wars = [], alliances = [], provinces = {}, armies = [], straits = [], rx = rules, tpl = INF14, seed = 7 }) {
  const P = [null];
  for (const q of provs) {
    P.push(q.sea ? { id: q.id, name: `Z${q.id}`, sea: true, x: 0, y: 0, lon: 0, lat: 50, area: q.area || 40000, adj: q.adj }
      : { id: q.id, name: `P${q.id}`, sea: false, iso: 'T', x: q.id * 10, y: 0, lon: 0, lat: 50, area: 2500, terrain: 'plains', climate: 'arid', coastal: false, port: !!q.port, adj: q.adj, river: [] });
  }
  for (const p of P) if (p && !p.sea) p.coastal = p.adj.some((q) => P[q].sea);
  const map = { v: 1, id: 'h', name: 'h', texture: { file: null, width: 10, height: 10 }, projection: { type: 'equirect', lon0: 0, lat0: 0, pxPerDeg: 1 }, straits, provinces: P };
  const scenario = { v: 1, id: 'h', map: 'h', name: 'h', start: '1914-06-28', end: '1920-01-01',
    nations: nations.map((x) => ({ tag: x.tag, name: x.tag, color: '#888888', capital: x.capital, bloc: x.bloc || null, major: true, navy: x.navy | 0, manpower: x.manpower === undefined ? 1000000 : x.manpower, personality: {}, goals: [], generals: [], templates: [tpl], lines: x.lines || [] })),
    owner, cores: {}, provinces, alliances, wars, events: [], armies };
  return { map, scenario, rules: rx, state: ST.create(map, scenario, rx, { seed }) };
}

const setWar = (ctx, a, b, on) => { M.writeRel(ctx.state, ctx.state.nations[a].tag, ctx.state.nations[b].tag, { war: on }); };
// Runs exactly one daily update (hour % 24 === 0) and stops the hour after it.
const toNextDay = (ctx) => { do T.step(ctx, 1); while (ctx.state.hour % 24 !== 1); };
const sail = (area) => Math.max(1, Math.ceil(Math.trunc((Math.max(10, F.isqrt(area)) * 1000000) / rules.naval.speed) / 1000));

// 1 A capital port - 2 A beach - 9 A (strait to 2); zones 6 - 7 - 8; 3 A island port, 4 A island beach, 5 B port.
function archipelago(extra = {}) {
  return mk({
    provs: [{ id: 1, adj: [2, 6], port: true }, { id: 2, adj: [1, 6, 9] }, { id: 3, adj: [8], port: true }, { id: 4, adj: [8] }, { id: 5, adj: [7], port: true },
      { id: 6, sea: true, adj: [1, 2, 7, 9] }, { id: 7, sea: true, adj: [5, 6, 8] }, { id: 8, sea: true, adj: [3, 4, 7] }, { id: 9, adj: [2, 6] }],
    straits: [[2, 9]],
    nations: [{ tag: 'AAA', capital: 1, navy: 10 }, { tag: 'BBB', capital: 5, navy: 100 }],
    owner: { AAA: [1, 2, 3, 4, 9], BBB: [5] },
    armies: [{ nation: 'AAA', name: 'Home', general: null, template: 'inf14', divisions: 3, at: [1, 1, 2] }, { nation: 'AAA', name: 'Isle', general: null, template: 'inf14', divisions: 1, at: [3] }],
    ...extra,
  });
}

const M = sim('mapdata.js');
const U = sim('units.js');
const I = sim('industry.js');
const NV = sim('naval.js');

function hoursTo(ctx, d, target, limit = 400) {
  let h = 0;
  while (!(d.prov === target && d.to === null) && h < limit) { T.step(ctx, 1); h++; }
  return h;
}

await section('sea movement', () => {
  const ctx = archipelago();
  const { state } = ctx;
  const [d1, d2, d3] = state.divs;
  const Z = sail(40000);
  const NVr = rules.naval;
  check(O.apply(ctx, 0, { type: 'move', div: d1.id, to: 3 }).ok, 'a move to the island port is accepted');
  eq([d1.to, d1.path], [6, [7, 8, 3]], 'its path runs through the sea zones');
  let atSeaSeen = false;
  let h = 0;
  while (!(d1.prov === 3 && d1.to === null) && h < 400) {
    T.step(ctx, 1);
    h++;
    if (ctx.map.provinces[d1.prov].sea) atSeaSeen = true;
    if (d1.prov === 7 && h < 45) { const r = O.legal(ctx, 0, { type: 'halt', div: d1.id }); check(r.reason === 'at-sea', 'a division at sea cannot halt (at-sea)'); }
  }
  check(atSeaSeen, 'the division was in a sea zone on the way');
  eq(h, NVr.embarkPort + 3 * Z + NVr.disembarkPort, `port to port: embarkPort + 3 zones x ${Z} h + disembarkPort hours`);
  check(O.apply(ctx, 0, { type: 'move', div: d2.id, to: 4 }).ok, 'a move to the island beach is accepted');
  const beach = hoursTo(ctx, d2, 4);
  eq(beach, NVr.embarkPort + 3 * Z + NVr.disembarkBeach, 'port to beach: disembarkBeach instead of disembarkPort');
  check(beach > h, `the beach is slower (${beach} h against ${h} h)`);

  state.prov.weather.fill(0);
  check(O.apply(ctx, 0, { type: 'move', div: d3.id, to: 9 }).ok, 'a move across the strait is accepted');
  const land = Math.trunc((50 * 1000000) / 4000);
  const want = Math.ceil(Math.trunc((F.mul(land, rules.move.river) * 1000) / (1000 + 2 * rules.move.rail)) / 1000);
  eq([d3.to, d3.eta], [9, want], 'the strait is a land step with the river penalty (behind its own line: move.rail)');
  hoursTo(ctx, d3, 9);

  setWar(ctx, 0, 1, true);
  toNextDay(ctx);
  eq([7, 6, 8].map((z) => state.sea.ctrl[z]), [1, 1, 1], 'at war, the larger navy controls the zones (BBB)');
  const before = H.hash(state);
  eq(O.apply(ctx, 0, { type: 'move', div: d1.id, to: 1 }).reason, 'sea-lane-closed', 'a voyage through enemy-controlled zones: sea-lane-closed');
  eq(O.apply(ctx, 0, { type: 'move', div: d3.id, to: 2 }).reason, 'sea-lane-closed', 'the strait under an enemy-controlled zone is closed too');
  eq(H.hash(state), before, 'the refused orders changed nothing');

  const c2 = archipelago({ armies: [{ nation: 'AAA', name: 'Home', general: null, template: 'inf14', divisions: 1, at: [1] }] });
  const [e1] = c2.state.divs;
  O.apply(c2, 0, { type: 'move', div: e1.id, to: 3 });
  let k = 0;
  while (e1.prov !== 7 && k++ < 100) T.step(c2, 1);
  eq(e1.prov, 7, 'a second voyage reaches the middle zone');
  const cas = c2.state.nations[0].casualties;
  const men = F.mul(U.statsOf(c2, e1).manpower, e1.str);
  setWar(c2, 0, 1, true);
  toNextDay(c2);
  check(!c2.state.divs.includes(e1) && c2.state.log.some((x) => x.kind === 'sunk' && x.div === e1.id), 'the zone turning enemy-controlled mid-voyage sinks it (log sunk)');
  eq(c2.state.nations[0].casualties - cas, men, 'its men count as casualties');
});

await section('island supply', () => {
  const ctx = archipelago();
  const { state } = ctx;
  const g = state.divs[3];
  T.step(ctx, 1);
  eq([state.prov.supply[3], g.prov], [rules.naval.portCap, 3], 'the island port is supplied over the open lane, at the port capacity');
  check(g.sup > 0, `the garrison is supplied (sup ${g.sup})`);
  setWar(ctx, 0, 1, true);
  toNextDay(ctx);
  eq([state.sea.ctrl[8], state.prov.supply[3], g.sup], [1, 0, 0], 'the enemy navy takes the lane: the island is cut off');
  T.step(ctx, 48);
  check(g.org < 1000 && g.str < 1000, `cut off, the garrison wears down (org ${g.org}, str ${g.str})`);
  state.nations[1].navy = 0;
  toNextDay(ctx);
  eq(state.sea.ctrl[8], 0, 'with the enemy navy gone the lane is ours again');
  check(state.prov.supply[3] === rules.naval.portCap && g.sup > 0, `supply is restored (sup ${g.sup})`);
  const low = g.org;
  T.step(ctx, 24);
  check(g.org > low, `org recovers (${low} -> ${g.org})`);
});

// A: ports 1 (zone 9) and 7 (zone 11); D: port 3 (zone 9) with coal and iron; B: port 6 (zone 9); C neutral: ports 5 (zone 10) and 8 (zone 11).
function trade() {
  const line = [{ item: 'rifles', factories: 2 }];
  return mk({
    provs: [{ id: 1, adj: [2, 9], port: true }, { id: 2, adj: [1, 7] }, { id: 3, adj: [9], port: true }, { id: 4, adj: [5, 8] }, { id: 5, adj: [4, 10], port: true },
      { id: 6, adj: [9], port: true }, { id: 7, adj: [2, 11], port: true }, { id: 8, adj: [4, 11], port: true },
      { id: 9, sea: true, adj: [1, 3, 6, 10] }, { id: 10, sea: true, adj: [5, 9] }, { id: 11, sea: true, adj: [7, 8] }],
    nations: [{ tag: 'AAA', capital: 1, lines: line }, { tag: 'BBB', capital: 6, navy: 200 }, { tag: 'CCC', capital: 4 }, { tag: 'DDD', capital: 3, lines: line }],
    owner: { AAA: [1, 2, 7], BBB: [6], CCC: [4, 5, 8], DDD: [3] },
    provinces: { 1: { mil: 2 }, 3: { mil: 2, coal: 1, iron: 1 } },
  });
}

await section('blockade and resources', () => {
  const ctx = trade();
  const st = ctx.state;
  const A = st.nations[0];
  const D = st.nations[3];
  const points = (nat) => nat.lines[0].prog + nat.stock.rifles * 20;
  const day = (nat) => { const p0 = points(nat); const eff = nat.lines[0].eff; toNextDay(ctx); return { got: points(nat) - p0, eff }; };
  const want = (eff, R) => F.mul(Math.trunc((2 * eff * rules.industry.perFactory) / 1000), R);
  T.step(ctx, 1);
  eq([A.blockade, A.suff.coal, A.suff.iron, D.blockade, D.suff.coal], [0, 1000, 1000, 0, 1000], 'at peace: no blockade, imports cover what A lacks');
  let r = day(A);
  eq(r.got, want(r.eff, 1000), `A's rifle line at full output (${r.got} points a day)`);
  setWar(ctx, 0, 1, true);
  setWar(ctx, 3, 1, true);
  const dBefore = day(D);
  r = day(A);
  eq([st.sea.ctrl[9], st.sea.ctrl[10], st.sea.ctrl[11]], [1, 1, -1], 'BBB controls the zones near its port; the far zone is nobody\'s');
  eq(A.blockade, 500, 'A: one of its two lanes cut, blockade 500');
  const colonial = { ...ctx, scenario: { ...ctx.scenario, cores: { AAA: [1, 2], BBB: [6], CCC: [4, 5, 8], DDD: [3] } } };
  NV.daily(colonial, null);
  eq(A.blockade, 1000, 'with port 7 a colony, A counts only its home port, and that lane is cut: blockade 1000');
  NV.daily(ctx, null);
  const demand = 2 * 20;
  const half = Math.trunc((Math.trunc((demand * 500) / 1000) * 1000) / demand);
  eq([A.suff.coal, A.suff.iron], [half, half], `A's coal and iron sufficiency fall to ${half} (imports x (1000 - blockade) / 1000)`);
  eq(r.got, want(r.eff, half), `A's line output falls to ${r.got} points (x ${half} / 1000)`);
  eq(D.blockade, 1000, 'D: its only lane is cut, blockade 1000');
  eq([D.suff.coal, D.suff.iron], [1000, 1000], 'D mines its own coal and iron: sufficiency unchanged');
  const dAfter = day(D);
  eq(dAfter.got, want(dAfter.eff, 1000), 'D\'s line output unchanged under blockade');
  check(dBefore.got > 0, 'D produced before the war too');
  st.prov.ctrl[7] = 1;
  toNextDay(ctx);
  eq([A.blockade, A.suff.coal], [1000, 0], 'A loses its open port: blockade 1000 and no coal');
  r = day(A);
  eq(r.got, 0, 'no coal and iron, no rifles');
});

await section('shells and non-core provinces', () => {
  const ctx = duel();
  const { state } = ctx;
  const [att, def] = state.divs;
  Object.assign(att, { prov: 1, to: 2, eta: 1000, path: [] });
  const need = U.statsOf(ctx, att).shells;
  eq(need, 2 * rules.branches.find((b) => b.id === 'art').shells, 'an inf14 division fires 2 batteries x art.shells an hour');
  state.nations[0].stock.shells = 1000;
  const w = T.world(ctx);
  const out = { provinces: [], divs: false, battles: false, events: [] };
  MV.hour(ctx, w, out);
  CB.hour(ctx, w, out);
  eq(state.nations[0].stock.shells, 1000 - need, 'an hour of attack spends its shells');
  const full = state.battles[0].odds;
  state.nations[0].stock.shells = 0;
  Object.assign(att, { str: 1000, org: 1000 });
  Object.assign(def, { str: 1000, org: 1000 });
  state.battles[0].odds = 0;
  const w2 = T.world(ctx);
  CB.hour(ctx, w2, out);
  const starved = state.battles[0].odds;
  const A = (shells) => { const p = predict({ shells }); return p; };
  check(A(false) < A(true), 'the formula: artillery without shells lowers the win chance');
  const defC = U.statsOf(ctx, def).counts;
  const aFull = CB.attackPower(ctx, att, 2, defC, 1000);
  const aNo = CB.attackPower(ctx, att, 2, defC, rules.combat.noShells);
  const art = rules.branches.find((b) => b.id === 'art');
  const artPart = F.mul(F.mul(F.mul(F.mul(2000, art.attack), 1000), att.str), 1000);
  check(Math.abs((aFull - aNo) - (artPart - F.mul(artPart, rules.combat.noShells))) <= 3, `without shells the artillery attacks at ${rules.combat.noShells} permille (attack ${aFull} -> ${aNo})`);
  check(starved < full, `the hour's odds fall without shells (${full} -> ${starved} permille)`);

  const c = mk({
    provs: [{ id: 1, adj: [2] }, { id: 2, adj: [1, 3] }, { id: 3, adj: [2] }],
    nations: [{ tag: 'AAA', capital: 1 }, { tag: 'BBB', capital: 3 }],
    owner: { AAA: [1], BBB: [2, 3] }, wars: [['AAA', 'BBB']], provinces: { 2: { mil: 4 } },
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 1, at: [1] }],
  });
  const a = c.state.nations[0];
  T.step(c, 1);
  const mp0 = a.manpower;
  toNextDay(c);
  eq(a.manpower - mp0, rules.recruit.perProvince, 'one core province recruits recruit.perProvince men a day');
  eq(I.output(c, 0, 'mil'), 0, 'no military factories before');
  O.apply(c, 0, { type: 'move', div: c.state.divs[0].id, to: 2 });
  hoursTo(c, c.state.divs[0], 2);
  eq(c.state.prov.ctrl[2], 0, 'A takes the factory province');
  eq([I.factories(c.state, 0, 'mil'), I.output(c, 0, 'mil')], [4, Math.trunc((4 * rules.occupied.factories) / 1000)], `the non-core province yields ${rules.occupied.factories} permille of its 4 factories`);
  const mp1 = a.manpower;
  toNextDay(c);
  eq(a.manpower - mp1, Math.trunc((rules.recruit.perProvince * 1000 + rules.recruit.perProvince * rules.occupied.manpower) / 1000), `and ${rules.occupied.manpower} permille of its recruits`);
});

await section('casualties', () => {
  const tpl = { id: 'inf14', name: 'Nine', line: ['inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'art', 'art'], support: [] };
  const rx = { ...rules, recruit: { perProvince: 0 } };
  const { map, scenario } = G.generate({ seed: 11, provinces: 200, nations: 4 });
  for (const n of scenario.nations) { n.templates = [tpl]; n.manpower = 0; }
  const [a, b] = borderPair(map, scenario);
  scenario.wars = [[scenario.nations[a].tag, scenario.nations[b].tag]];
  const ctx = { map, scenario, rules: rx, state: ST.create(map, scenario, rx, { seed: 6 }) };
  const { state } = ctx;
  const per = U.stats(rx, tpl).manpower / 1000;
  eq(per, 9, 'the test template has 9 men per strength point');
  const start = state.divs.length;
  let monotone = true;
  let last = state.nations.map((n) => n.casualties);
  const answers = [];
  let disbanded = 0;
  for (let day = 0; day < 40; day++) {
    script(ctx, day, a, b, answers);
    for (let h = 0; h < 24; h++) {
      const alive = state.nations.map((n) => n.alive);
      const before = state.divs.map((d) => [d.nation, d.str]);
      T.step(ctx, 1);
      for (const [n, str] of before) if (alive[n] && !state.nations[n].alive) disbanded += 9 * str;
      const now = state.nations.map((n) => n.casualties);
      if (now.some((x, i) => x < last[i])) monotone = false;
      last = now;
    }
  }
  check(monotone, 'casualties never decrease, hour by hour, over 40 days of war');
  const trained = state.nations.reduce((s, n) => s + n.training.length, 0);
  const born = state.next.div - 1 - start;
  const removed = 9 * 1000 * (start + born) - state.divs.reduce((s, d) => s + 9 * d.str, 0) - disbanded;
  const total = state.nations.reduce((s, n) => s + n.casualties, 0);
  check(total > 0 && state.log.some((e) => e.kind === 'battle'), `the war cost men (${total})`);
  eq(total, removed, `casualties = 9 x strength lost, summed over every division ever fielded (${start + born}, ${trained} batches pending, ${disbanded / 9} strength disbanded by a capitulation)`);
});

await section('unlocks', () => {
  const { map, scenario } = G.generate({ seed: 4, provinces: 30, nations: 2 });
  scenario.provinces[scenario.nations[0].capital] = { ...(scenario.provinces[scenario.nations[0].capital] || {}), mil: 40 };
  for (const p of scenario.owner[scenario.nations[1].tag]) if (scenario.provinces[p]) scenario.provinces[p].mil = 0;
  scenario.provinces[scenario.nations[1].capital] = { ...(scenario.provinces[scenario.nations[1].capital] || {}), mil: 10 };
  const ctx = { map, scenario, rules, state: ST.create(map, scenario, rules, { seed: 1 }) };
  const { state } = ctx;
  const W = sim('weather.js');
  const tank = rules.unlocks.find((u) => u.branch === 'tank');
  const from = W.parse(tank.from);
  const start = W.parse(scenario.start);
  const days = (from.year - start.year) * 365 + from.doy - start.doy;
  const tpl = { type: 'template', template: { id: 'tk', name: 'Tanks', line: ['tank', 'inf'] } };
  eq(O.legal(ctx, 0, tpl).reason, 'locked-branch', 'tanks are locked at the start');
  eq(O.legal(ctx, 0, { type: 'line', item: 'tanks', factories: 1 }).reason, 'locked-item', 'so is the tank line');
  eq(O.legal(ctx, 0, { type: 'template', template: { id: 'ax', name: 'Air', line: ['air'] } }).reason, 'locked-branch', 'air is locked too');
  T.step(ctx, days * 24);
  check(!state.nations[0].unlocked.includes('tank'), `not on the day before ${tank.from} (day ${days - 1})`);
  T.step(ctx, 1);
  check(state.nations[0].unlocked.includes('tank') && state.log.some((e) => e.kind === 'unlocked' && e.branch === 'tank' && e.hour === days * 24), `tanks unlock on ${tank.from} (day ${days}) for the nation with ${I.output(ctx, 0, 'mil')} military factories`);
  check(!state.nations[1].unlocked.includes('tank'), `not for the one with ${I.output(ctx, 1, 'mil')}`);
  check(O.legal(ctx, 0, tpl).ok, 'a tank template is legal once unlocked');
  eq(O.legal(ctx, 0, { type: 'template', template: { id: 'ax', name: 'Air', line: ['air'] } }).reason, 'support-only', 'air goes in support only');
  check(O.legal(ctx, 0, { type: 'template', template: { id: 'ax', name: 'Air', line: ['inf'], support: ['air'] } }).ok, 'an air support company is legal');
});

await section('co-belligerents', () => {
  const ctx = mk({
    provs: [{ id: 1, adj: [2] }, { id: 2, adj: [1, 3, 4] }, { id: 3, adj: [2] }, { id: 4, adj: [2] }],
    nations: [{ tag: 'AAA', capital: 1 }, { tag: 'CCC', capital: 3 }, { tag: 'DDD', capital: 4 }],
    owner: { AAA: [1], CCC: [3], DDD: [2, 4] }, wars: [['AAA', 'DDD'], ['CCC', 'DDD']],
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 1, at: [1] }, { nation: 'CCC', name: 'C', general: null, template: 'inf14', divisions: 1, at: [3] },
      { nation: 'DDD', name: 'D', general: null, template: 'inf14', divisions: 2, at: [2] }],
  });
  const [da, dc] = ctx.state.divs;
  O.apply(ctx, 0, { type: 'move', div: da.id, to: 2 });
  O.apply(ctx, 1, { type: 'move', div: dc.id, to: 2 });
  T.step(ctx, 3);
  eq(ctx.state.battles.length, 1, 'one battle for the province');
  const b = ctx.state.battles[0];
  eq([b.side, [...b.att].sort((x, y) => x - y), b.from], [0, [da.id, dc.id], [1, 3]], 'AAA and CCC (not allies, both at war with DDD) attack on the same side, from two provinces');
});

await section('an org-0 garrison gives way', () => {
  const world2 = (owner) => mk({
    provs: [{ id: 1, adj: [2] }, { id: 2, adj: [1, 3, 4] }, { id: 3, adj: [2] }, { id: 4, adj: [2] }],
    nations: [{ tag: 'AAA', capital: 1 }, { tag: 'BBB', capital: 3 }],
    owner, wars: [['AAA', 'BBB']],
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 1, at: [1] }, { nation: 'BBB', name: 'B', general: null, template: 'inf14', divisions: 1, at: [2] }],
  });
  for (const [owner, want] of [[{ AAA: [1], BBB: [2, 3, 4] }, 'falls back'], [{ AAA: [1, 4], BBB: [2, 3] }, 'falls back to its only friendly neighbour']]) {
    const ctx = world2(owner);
    const [da, db] = ctx.state.divs;
    db.org = 0;
    O.apply(ctx, 0, { type: 'move', div: da.id, to: 2 });
    const h = hoursTo(ctx, da, 2, 200);
    check(h < 200 && ctx.state.prov.ctrl[2] === 0 && db.str > 0 && db.prov === 3, `a garrison at org 0 ${want} to 3 when attacked and the attacker walks in (${h} h, B at ${db.prov})`);
  }
  const ctx = world2({ AAA: [1, 3, 4], BBB: [2] });
  ctx.scenario.nations[1].capital = 2;
  const [da, db] = ctx.state.divs;
  db.org = 0;
  const cas = ctx.state.nations[1].casualties;
  O.apply(ctx, 0, { type: 'move', div: da.id, to: 2 });
  const h = hoursTo(ctx, da, 2, 200);
  check(h < 200 && ctx.state.prov.ctrl[2] === 0 && !ctx.state.divs.includes(db) && ctx.state.log.some((e) => e.kind === 'surrendered' && e.div === db.id), `with nowhere to go it surrenders (log 'surrendered') and the attacker walks in (${h} h)`);
  check(ctx.state.nations[1].casualties - cas === U.statsOf(ctx, da).manpower, 'its men count as casualties');
});

await section('orders the AI layers use', () => {
  const ctx = mk({
    provs: [{ id: 1, adj: [2] }, { id: 2, adj: [1, 3] }, { id: 3, adj: [2] }],
    nations: [{ tag: 'AAA', capital: 1, lines: [{ item: 'rifles', factories: 3 }] }, { tag: 'BBB', capital: 3 }],
    owner: { AAA: [1, 2], BBB: [3] }, provinces: { 1: { mil: 4 } },
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 2, at: [1] }],
  });
  ctx.scenario.nations[0].generals = [{ name: 'G One', trait: 'offence' }];
  const { state } = ctx;
  const [d1, d2] = state.divs;
  check(O.apply(ctx, 0, { type: 'move', div: d1.id, to: 2, by: 'general' }).ok && !d1.manual, "a move by: 'general' leaves manual alone");
  check(O.apply(ctx, 0, { type: 'halt', div: d1.id, by: 'general' }).ok && !d1.manual, "so does a halt by: 'general'");
  check(O.apply(ctx, 0, { type: 'move', div: d2.id, to: 2 }).ok && d2.manual, "a player's move still marks it manual");
  eq(O.legal(ctx, 0, { type: 'move', div: d1.id, to: 2, by: 'player2' }).reason, 'bad-order', 'an unknown by is refused');
  const army = state.nations[0].armies[0];
  const off = O.apply(ctx, 0, { type: 'offensive', army: army.id, path: [3] });
  check(off.ok && O.apply(ctx, 0, { type: 'offensive', army: army.id, offensive: off.id, path: null }).ok && army.offensives.length === 0, 'an offensive is removed with path null');
  eq(O.legal(ctx, 0, { type: 'offensive', army: army.id, offensive: off.id, path: null }).reason, 'no-such-offensive', 'removing it twice is refused');
  const made = O.apply(ctx, 0, { type: 'army', name: 'Second', general: 'G One' });
  check(made.ok && state.nations[0].armies.some((a) => a.id === made.id && a.general === 'G One' && a.divs.length === 0), 'a new army with a general of the nation');
  eq(O.legal(ctx, 0, { type: 'army', name: 'Third', general: 'G One' }).reason, 'general-busy', 'a general commands one army');
  eq(O.legal(ctx, 0, { type: 'army', name: 'Third', general: 'Nobody' }).reason, 'no-such-general', 'an unknown general is refused');
  eq(O.legal(ctx, 0, { type: 'army', name: '', general: null }).reason, 'bad-name', 'an army needs a name');
  check(O.apply(ctx, 0, { type: 'army', army: army.id, disband: true }).ok && !state.nations[0].armies.includes(army) && d1.army === null && d2.army === null, 'disbanding an army leaves its divisions in no army');
  eq(O.legal(ctx, 0, { type: 'army', army: army.id, disband: true }).reason, 'no-such-army', 'a disbanded army is gone');
  state.prov.mil[1] = 1;
  check(I.output(ctx, 0, 'mil') < 3 && O.apply(ctx, 0, { type: 'line', item: 'rifles', factories: 2 }).ok, 'a cut is legal while the lines are over the factories');
  eq(O.legal(ctx, 0, { type: 'line', item: 'guns', factories: 1 }).reason, 'not-enough-factories', 'a raise is not');
});

await section('sea determinism', () => {
  const runSea = (seed, days, from = null) => {
    let w = from;
    if (!w) {
      const { map, scenario } = G.generate({ seed: 17, provinces: 200, nations: 2, islands: 4 });
      scenario.wars = [[scenario.nations[0].tag, scenario.nations[1].tag]];
      w = { ctx: { map, scenario, rules, state: ST.create(map, scenario, rules, { seed }) } };
    }
    const { ctx } = w;
    const hashes = [];
    const seen = { sea: false, ctrl: false, landed: false };
    const colonies = ctx.scenario.armies.filter((x) => x.name.includes('Garrison')).map((x) => ({ nation: ctx.scenario.nations.findIndex((n) => n.tag === x.nation), at: x.at[0] }));
    for (let day = Math.floor(ctx.state.hour / 24); day < days; day++) {
      if (day % 10 === 0) {
        for (const d of ctx.state.divs) {
          if (d.to !== null || d.id % 4 !== 0) continue;
          const target = colonies[(d.id + day) % colonies.length].at;
          O.apply(ctx, d.nation, { type: 'move', div: d.id, to: target });
        }
      }
      for (let h = 0; h < 24; h += 6) {
        T.step(ctx, 6);
        if (ctx.state.divs.some((d) => ctx.map.provinces[d.prov].sea)) seen.sea = true;
      }
      if (ctx.state.sea.ctrl.some((c) => c >= 0)) seen.ctrl = true;
      hashes.push(H.hash(ctx.state));
    }
    seen.landed = ctx.state.divs.some((d) => colonies.some((c) => c.at === d.prov && c.nation !== d.nation)) || ctx.state.log.some((e) => e.kind === 'taken' && colonies.some((c) => c.at === e.prov));
    return { ...w, hashes, seen };
  };
  const g = G.generate({ seed: 17, provinces: 200, nations: 2, islands: 4 });
  const overseas = g.scenario.armies.filter((x) => x.name.includes('Garrison')).map((x) => x.at[0]).filter((p) => !g.map.straits.some(([a, b]) => a === p || b === p));
  check(overseas.length >= 2, `the map has ${overseas.length} overseas colonies`);
  const r1 = runSea(1, 40);
  const r2 = runSea(1, 40);
  eq(r1.hashes, r2.hashes, 'islands, sea control and voyages: the same hash on every day of 40');
  check(r1.seen.sea && r1.seen.ctrl, `divisions sailed and zones were controlled (${JSON.stringify(r1.seen)})`);
  const half = runSea(1, 20);
  const back = SV.read(SV.write(half.ctx.state));
  check(back.ok && back.state.sea.ctrl instanceof Int16Array, 'sea control saves and reads back typed');
  const cont = runSea(1, 40, { ctx: { ...half.ctx, state: back.state } });
  eq(half.hashes.concat(cont.hashes), r1.hashes, 'save at day 20, read, continue: the same daily hashes');
  const old = JSON.parse(SV.write(half.ctx.state));
  delete old.state.sea;
  for (const n of old.state.nations) { delete n.casualties; delete n.blockade; delete n.navy; delete n.suff; delete n.unlocked; }
  const up = SV.read(JSON.stringify(old));
  check(up.ok && up.state.sea.ctrl.length === half.ctx.state.sea.ctrl.length && up.state.nations.every((n) => n.casualties === 0 && Array.isArray(n.unlocked)), 'a save from before these fields reads with their defaults');
});

await section('path search', () => {
  const { ctx, a, b } = world(3, 200, 4);
  const d = ctx.state.divs.find((x) => x.nation === a);
  const far = ctx.scenario.nations[b].capital;
  check(O.legal(ctx, a, { type: 'move', div: d.id, to: far }).ok, 'a long move is legal with the default search cap');
  const tight = { ...ctx, rules: { ...rules, move: { ...rules.move, searchCap: 3 } } };
  eq(O.legal(tight, a, { type: 'move', div: d.id, to: far }).reason, 'too-far', 'past rules.move.searchCap settled provinces: too-far');
  const rel = M.relations(ctx.state);
  check(M.relations(ctx.state) === rel, 'relations are cached within the hour');
  setWar(ctx, a, b, false);
  check(M.relations(ctx.state) !== rel && !M.hostile(M.relations(ctx.state), a, b), 'touchRelations makes the next call see the change');
  const p1 = MV.path(ctx, M.relations(ctx.state), d, ctx.scenario.nations[a].capital);
  const p2 = MV.path(ctx, M.relations(ctx.state), d, ctx.scenario.nations[a].capital);
  eq(p1, p2, 'the reused buffers give the same path twice');
});

// 1 (A) - 2 (B) - 3 (B): A attacks 2 with `att` divisions against `def` in 2; `back` more of B's wait in 3.
function front({ att = 12, def = 8, back = 0 } = {}) {
  const armies = [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: att, at: [1] }, { nation: 'BBB', name: 'B', general: null, template: 'inf14', divisions: def, at: [2] }];
  if (back) armies.push({ nation: 'BBB', name: 'B2', general: null, template: 'inf14', divisions: back, at: [3] });
  const ctx = mk({ provs: [{ id: 1, adj: [2] }, { id: 2, adj: [1, 3] }, { id: 3, adj: [2] }], nations: [{ tag: 'AAA', capital: 1 }, { tag: 'BBB', capital: 3 }], owner: { AAA: [1], BBB: [2, 3] }, wars: [['AAA', 'BBB']], armies });
  for (const d of ctx.state.divs) if (d.nation === 0) O.apply(ctx, 0, { type: 'move', div: d.id, to: 2 });
  return ctx;
}

await section('the defending line', () => {
  const Q = sim('queries.js');
  const ctx = front();
  const { state } = ctx;
  const defenders = state.divs.filter((d) => d.nation === 1).map((d) => d.id);
  for (const d of state.divs) if (d.nation === 1) d.org = 200;
  let most = 0;
  let outside = true;
  let first = null;
  let shape = null;
  const fought = new Set();
  let h = 0;
  do {
    T.step(ctx, 1);
    const b = state.battles[0];
    if (!b) continue;
    const line = b.line || [];
    most = Math.max(most, line.length);
    if (!b.def.every((id) => line.includes(id))) outside = false;
    for (const id of b.def) fought.add(id);
    if (!first && b.hours > 0) {
      first = line.slice();
      const q = Q.answer(ctx, 'province', { id: 2 });
      shape = { line: q.battle.line, copy: q.battle.line !== b.line, lineMax: q.battle.lineMax, works: q.works, dug: q.dug, trench: q.trench };
    }
  } while ((state.battles.length || !first) && ++h < 400);
  const waiting = defenders.filter((id) => !first.includes(id));
  eq([most, waiting.length], [CB.LINE, 2], `eight defenders: ${CB.LINE} stand in the line, 2 wait outside it`);
  check(outside, 'only divisions of the line fight for the province');
  check(waiting.every((id) => !fought.has(id)), 'the two outside the line never fight, even as line members break (no refill past six)');
  const won = state.log.filter((e) => e.kind === 'battle' && e.prov === 2).pop();
  const rest = waiting.map((id) => M.divById(state, id));
  check(won && won.won === 'att' && rest.every((d) => d && d.prov === 3 && d.org > 0), `when the line breaks the two still able to fight fall back to 3 and the attackers win (${S({ won, rest: rest.map((d) => d && [d.prov, d.org]) })})`);
  T.step(ctx, 2);
  eq(state.prov.ctrl[2], 0, 'and province 2 changes hands');
  eq([shape.line, shape.copy, shape.lineMax, shape.dug, shape.trench], [first, true, CB.LINE, false, MV.TRENCH], "the province query gives the battle's line (a copy), lineMax, dug and the trench threshold");
  check(Number.isInteger(shape.works) && shape.works < MV.TRENCH, `and works, an integer, under ${MV.TRENCH} here (${shape.works})`);
  state.prov.works[2] = MV.TRENCH;
  eq(Q.answer(ctx, 'province', { id: 2 }).dug, true, `works of ${MV.TRENCH}: dug is true`);

  const late = front({ att: 12, def: 1, back: 2 });
  const ls = late.state;
  const [lone, ...reserve] = ls.divs.filter((d) => d.nation === 1);
  let k = 0;
  while (!(ls.battles.length && ls.battles[0].hours > 0) && k++ < 50) T.step(late, 1);
  eq(ls.battles[0] && ls.battles[0].line, [lone.id], 'a battle against one division: a line of one');
  for (const d of reserve) O.apply(late, 1, { type: 'move', div: d.id, to: 2 });
  let joined = false;
  let fights = false;
  for (k = 0; k < 200 && ls.battles.length; k++) {
    T.step(late, 1);
    const b = ls.battles[0];
    if (b && reserve.every((d) => (b.line || []).includes(d.id))) joined = true;
    if (b && b.def.some((id) => reserve.some((d) => d.id === id))) fights = true;
  }
  check(joined && fights, `reinforcements that arrive during the battle join a line that has held fewer than ${CB.LINE} and fight (joined ${joined}, fought ${fights})`);
});

await section('pursuit', () => {
  const got = {};
  for (const works of [0, MV.TRENCH]) {
    const ctx = front({ att: 1, def: 1 });
    const { state } = ctx;
    const [att, def] = state.divs;
    def.org = 30;
    state.prov.works[2] = works;
    let eta0 = null;
    let etaEnd = null;
    let end = -1;
    let taken = -1;
    for (let h = 1; h <= 200 && taken < 0; h++) {
      T.step(ctx, 1);
      if (state.battles.length && eta0 === null) eta0 = att.eta;
      if (eta0 !== null && end < 0 && !state.battles.length) { end = h; etaEnd = att.eta; }
      if (state.prov.ctrl[2] === 0) taken = h;
    }
    got[works] = { eta0, etaEnd, after: taken - end, works: state.prov.works[2] };
  }
  const [open, dug] = [got[0], got[MV.TRENCH]];
  check(open.eta0 > 1 && open.etaEnd <= 1 && open.after >= 0 && open.after <= 1, `won against a province not dug in: the attacker walks in within the hour (${S(open)})`);
  check(dug.eta0 > 1 && dug.etaEnd === dug.eta0 && dug.after === dug.eta0, `won against works of ${MV.TRENCH}: it keeps its eta and walks in at its own pace (${S(dug)})`);
});

await section('the battle query explains the odds', () => {
  const Q = sim('queries.js');
  // The query's own steps folded here: base × each permille in turn, per division; A = flank × Σ, odds as combat.js.
  const compose = (h) => {
    const fold = (steps) => steps.slice(1).reduce((v, s) => F.mul(v, s[1]), steps[0][1]);
    const A = F.mul(h.att.reduce((t, x) => t + fold(x.steps), 0), h.flank);
    const D = h.def.reduce((t, x) => t + fold(x.steps), 0);
    return A + D > 0 ? Math.trunc((A * 1000) / (A + D)) : 0;
  };
  for (const [label, mapOpts, dig] of [['a plain attack', {}, 0], ['an attack across a river into works', { river: true }, 400]]) {
    const ctx = duel(mapOpts);
    const { state } = ctx;
    const [att, def] = state.divs;
    Object.assign(att, { to: 2, eta: 1000, path: [] });
    def.dig = dig;
    state.prov.works[2] = dig;
    for (const n of state.nations) n.stock.shells = 1000000;
    const seen = [];
    for (let h = 0; h < 12 && seen.length < 6; h++) {
      T.step(ctx, 1);
      const b = state.battles[0];
      if (!b || !b.hours) continue;
      const q = Q.answer(ctx, 'battle', { prov: 2 });
      seen.push({ odds: b.odds, q: q.hour.odds, composed: compose(q.hour), keys: q.factors.att.map((f) => f.key).concat(q.factors.def.map((f) => `d:${f.key}`)) });
    }
    check(seen.length >= 3 && seen.every((x) => x.odds === x.q && x.odds === x.composed), `${label}: the battle query's factors compose to the battle's own odds every hour (${S(seen.map((x) => [x.odds, x.composed]))})`);
    const keys = seen[0]?.keys || [];
    if (mapOpts.river) check(keys.includes('river') && keys.includes('d:works') && keys.includes('d:siege'), `${label}: river, works and siege are among the factors (${S(keys)})`);
    else check(!keys.includes('river') && !keys.includes('d:works'), `${label}: no river or works factor (${S(keys)})`);
  }
  const ctx = front();
  const { state } = ctx;
  let roles = null;
  for (let h = 0; h < 200 && !roles; h++) {
    T.step(ctx, 1);
    const b = state.battles[0];
    if (!b || !b.hours) continue;
    const q = Q.answer(ctx, 'battle', { prov: b.prov });
    const fought = new Set(b.att.concat(b.def));
    const all = q.att.concat(q.def);
    if (all.some((d) => d.role === 'outside')) {
      roles = { ok: all.every((d) => (d.role === 'engaged') === fought.has(d.id)) && b.att.concat(b.def).every((id) => all.some((d) => d.id === id && d.role === 'engaged')),
        outside: q.def.filter((d) => d.role === 'outside').every((d) => !(b.line || []).includes(d.id)), waiting: all.some((d) => d.role === 'waiting'),
        width: [q.hour.width, b.att.length, b.def.length], counts: Object.fromEntries(['engaged', 'waiting', 'outside', 'broken'].map((r) => [r, all.filter((d) => d.role === r).length])) };
    }
  }
  check(roles && roles.ok && roles.outside && roles.waiting && roles.width[1] <= roles.width[0] && roles.width[2] <= roles.width[0],
    `the roles the query reports are who fought that hour: engaged exactly b.att and b.def, outside not in the line, within the width (${S(roles)})`);
  let threw = null;
  try { Q.answer(ctx, 'battle', { prov: 1 }); } catch (err) { threw = err.message; }
  eq(threw, 'no-battle', 'a province without a battle answers no-battle');
});

await section('a move over own land and sea only', () => {
  const road = mk({
    provs: [{ id: 1, adj: [2, 4] }, { id: 2, adj: [1, 3] }, { id: 3, adj: [2, 8] }, { id: 4, adj: [1, 5] }, { id: 5, adj: [4, 6] }, { id: 6, adj: [5, 7] }, { id: 7, adj: [6, 8] }, { id: 8, adj: [3, 7] }],
    nations: [{ tag: 'AAA', capital: 1 }, { tag: 'BBB', capital: 2 }], owner: { AAA: [1, 3, 4, 5, 6, 7, 8], BBB: [2] }, wars: [['AAA', 'BBB']],
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 1, at: [1] }],
  });
  const [d] = road.state.divs;
  const before = H.hash(road.state);
  for (const own of ['yes', 1, null]) eq(O.apply(road, 0, { type: 'move', div: d.id, to: 3, own }).reason, 'bad-order', `own ${S(own)} (not a boolean): bad-order`);
  eq(H.hash(road.state), before, 'the refused orders changed nothing');
  check(O.apply(road, 0, { type: 'move', div: d.id, to: 3 }).ok, 'a move to 3 without own is accepted');
  eq([d.to, d.path], [2, [3]], 'it takes the shorter way, across hostile 2');
  check(O.apply(road, 0, { type: 'move', div: d.id, to: 3, own: true }).ok, 'with own: true too');
  eq([d.to, d.path], [4, [5, 6, 7, 8, 3]], 'but the way round, over its own land');
  check(O.apply(road, 0, { type: 'move', div: d.id, to: 3, own: false }).ok && d.to === 2, 'own: false is the default way');

  const coast = mk({
    provs: [{ id: 1, adj: [2, 4], port: true }, { id: 2, adj: [1, 3] }, { id: 3, adj: [2, 4], port: true }, { id: 4, sea: true, adj: [1, 3] }],
    nations: [{ tag: 'AAA', capital: 1, navy: 10 }, { tag: 'BBB', capital: 2 }], owner: { AAA: [1, 3], BBB: [2] }, wars: [['AAA', 'BBB']],
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 1, at: [1] }],
  });
  const [s] = coast.state.divs;
  toNextDay(coast);
  check(O.apply(coast, 0, { type: 'move', div: s.id, to: 3 }).ok && s.to === 2, 'by default it marches across hostile 2 rather than sail');
  check(O.apply(coast, 0, { type: 'move', div: s.id, to: 3, own: true }).ok, 'with own: true the move is accepted');
  eq([s.to, s.path], [4, [3]], 'and it goes by sea');
  const sq = sim('queries.js').answer(coast, 'province', { id: 4 });
  eq([sq.works, sq.dug], [null, null], 'a sea zone has no works in the province query');

  const shut = mk({
    provs: [{ id: 1, adj: [2] }, { id: 2, adj: [1, 3] }, { id: 3, adj: [2] }],
    nations: [{ tag: 'AAA', capital: 1 }, { tag: 'BBB', capital: 2 }], owner: { AAA: [1, 3], BBB: [2] }, wars: [['AAA', 'BBB']],
    armies: [{ nation: 'AAA', name: 'A', general: null, template: 'inf14', divisions: 1, at: [1] }],
  });
  const [t] = shut.state.divs;
  eq(O.legal(shut, 0, { type: 'move', div: t.id, to: 3, own: true }).reason, 'no-path', 'with no way over own land or sea: no-path');
  check(O.legal(shut, 0, { type: 'move', div: t.id, to: 3 }).ok, 'while the way across hostile land is still legal without own');
});

await section('modules.json as page scripts', () => {
  const order = JSON.parse(readFileSync(new URL('modules.json', SIM), 'utf8'));
  const files = readdirSync(SIM, { recursive: true }).map((f) => String(f).split('\\').join('/')).filter((f) => f.endsWith('.js')).sort();
  eq([...order].sort(), files, 'modules.json lists every sim file');
  eq(order[order.length - 1], 'host.js', 'host.js is last');
  const page = vm.createContext({ require: () => { throw new Error('page require'); } });
  vm.runInContext('globalThis.self = globalThis;', page);
  for (const f of order) vm.runInContext(readFileSync(new URL(f, SIM), 'utf8'), page, { filename: f });
  page.input = JSON.stringify({ rules });
  const got = vm.runInContext(`(() => {
    const { rules } = JSON.parse(input);
    const g = Conquest.mapgen.generate({ seed: 9, provinces: 60, nations: 3 });
    g.scenario.wars = [[g.scenario.nations[0].tag, g.scenario.nations[1].tag], [g.scenario.nations[1].tag, g.scenario.nations[2].tag]];
    const ctx = { map: g.map, scenario: g.scenario, rules, state: Conquest.state.create(g.map, g.scenario, rules, { seed: 1 }) };
    for (const d of ctx.state.divs) Conquest.orders.apply(ctx, d.nation, { type: 'move', div: d.id, to: g.scenario.nations[(d.nation + 1) % 3].capital });
    const out = [];
    for (let i = 0; i < 10; i++) { Conquest.tick.step(ctx, 24); out.push(Conquest.hash.hash(ctx.state)); }
    return out;
  })()`, page);
  for (const f of order) require(`../renderer/features/conquest/sim/${f}`);
  const g = G.generate({ seed: 9, provinces: 60, nations: 3 });
  g.scenario.wars = [[g.scenario.nations[0].tag, g.scenario.nations[1].tag], [g.scenario.nations[1].tag, g.scenario.nations[2].tag]];
  const ctx = { map: g.map, scenario: g.scenario, rules, state: ST.create(g.map, g.scenario, rules, { seed: 1 }) };
  for (const d of ctx.state.divs) O.apply(ctx, d.nation, { type: 'move', div: d.id, to: g.scenario.nations[(d.nation + 1) % 3].capital });
  const want = [];
  for (let i = 0; i < 10; i++) { T.step(ctx, 24); want.push(H.hash(ctx.state)); }
  eq(Array.from(got), want, 'the sim loaded as page scripts gives the same daily hashes as in Node');
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
