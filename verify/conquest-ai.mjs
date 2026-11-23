// Nano Studio Conquest's military AI (renderer/features/conquest/sim/ai: operations.js, general.js, mil-common.js)
// in plain Node, on generated maps and on small hand-built grid maps:
// - determinism: three AI nations at war for 120 days give the same hash every day twice, and a save written on
//   day 60, read back and continued gives the same hashes;
// - no order the AI gives is refused, over every run in this file;
// - front coverage, on a game of three nations with 0.8 divisions per province, checked every day from day 6 at
//   hour 18 and again at hour 24 (a general's turn falls between): a contact province (the nation controls it, it
//   touches land of a nation at war with it, and it did at the previous check too) that is empty at hour 18 (no
//   division of the nation in it or bound for it, directly or as the target of a waypoint leg in nation.ai.legs)
//   while a spare division stands within 3 provinces over the nation's land is not still empty at hour 24 with that
//   same division still spare and within reach (it stood idle through the general's turn). A nation
//   has divisions to spare only while its ready divisions (below) are at least as many as its contact provinces;
//   otherwise some province must stay empty and the general picks which. A spare division means not manual, standing, not in a battle, org >= 650, strength >= 400, not in the nation's capital (its
//   garrison) nor alone in a rear hub or factory province (general.js keeps a garrison there), in a province off the
//   contact line or holding another standing division of the nation, and not next
//   to the province a launched offensive of its army attacks next (that is the strike group massing);
// - offensives: at 3:1 the stronger side takes the weaker one's capital within CAPITAL_DAYS on every seed; at 1:1
//   across a river on hills the line moves at most LINE_MOVES provinces in 90 days and both sides dig in; an attacker
//   whose supply is cut starts no battle from the second to the sixth day after the cut (the same run uncut does) and
//   calls its offensive off for supply;
// - strength: an AI nation gains ground against the same nation holding still in at least 19 of 20 seeds, and
//   against a naive one (every division walks at the nearest enemy province) in at least 14 of 20;
// - the player's plan: a scripted player that only gives front, offensive and launch orders gets its front covered
//   and its path advanced by the general layer, which never moves a manual division;
// - encirclement: on a grid map with a pocket joined to its homeland (two hubs and a capital far behind) by a
//   garrisoned one-province-wide corridor, the pocket's divisions lose all supply while their nation still holds its
//   capital and hubs (the AI cut the corridor or the pocket's mouth) within POCKET_DAYS in at least 4 of 5 seeds;
// - explain.recent answers an AI nation's planned offensive with its options and factors;
// - nation.ai.strategy (the nation layer's targets) decides: posture attack plans offensives, posture hold none;
// - tick.js runs its systems and layers in its own declared order: a 40 day game of four AI nations with every layer,
//   diplomacy and events gives the same hash whether the files are required in sim/modules.json order or reversed
//   (each in a fresh Node process);
// - a nation that starts with no army gets one from the operations layer (the 'army' order) and attacks with it, and an
//   army's offensives list stays short (the layer removes the offensives it calls off);
// - a colony next to an empty province of the enemy's core is on the army's front and gets divisions; one next to an
//   empty enemy colony is left quiet.
// Usage: node verify/conquest-ai.mjs   (CONQUEST_VERBOSE=1 prints every check and the measured numbers)
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const sim = (f) => require(`../renderer/features/conquest/sim/${f}`);
const G = sim('mapgen.js');
const ST = sim('state.js');
const T = sim('tick.js');
const H = sim('hash.js');
const O = sim('orders.js');
const M = sim('mapdata.js');
const SV = sim('save.js');
sim('ai/operations.js');
sim('ai/general.js');
const X = sim('ai/explain.js');
const rules = JSON.parse(readFileSync(new URL('../renderer/features/conquest/data/units.json', import.meta.url), 'utf8'));

const CAPITAL_DAYS = 120;
const LINE_MOVES = 8;
const POCKET_DAYS = 30;
const VERBOSE = !!process.env.CONQUEST_VERBOSE;

const S = JSON.stringify;
const results = [];
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); else if (VERBOSE) console.log(`ok ${label}`); };
const note = (text) => { if (VERBOSE) console.log(`   ${text}`); };
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }

const apply0 = O.apply;
let scripting = 0;
const refused = [];
const aiOrders = [];
O.apply = (ctx, n, o) => {
  const r = apply0(ctx, n, o);
  if (!scripting) { aiOrders.push({ n, o }); if (!r.ok) refused.push({ hour: ctx.state.hour, n, o, reason: r.reason }); }
  return r;
};
const script = (fn) => { scripting++; try { return fn(); } finally { scripting--; } };

const ctrlCount = (ctx, n) => ctx.state.prov.ctrl.filter((c) => c === n).length;
const PERS = { boldness: 70, caution: 50, loyalty: 50, revanchism: 50 };

function generated(seed, { provinces = 200, nations = 2, perArmy = null, player = -1, wars = null, density = 300 } = {}) {
  const { map, scenario } = G.generate({ seed, provinces, nations, divisions: Math.trunc((provinces * density) / 1000) });
  const tags = scenario.nations.map((x) => x.tag);
  scenario.wars = wars ? wars.map(([a, b]) => [tags[a], tags[b]]) : [[tags[0], tags[1]]];
  for (const x of scenario.nations) x.personality = { ...PERS };
  if (perArmy) for (const a of scenario.armies) a.divisions = perArmy(tags.indexOf(a.nation));
  return { map, scenario, rules, state: ST.create(map, scenario, rules, { seed, player }) };
}

// A W × H grid of land provinces, 4 neighbours each, infrastructure 5 (supply reaches about 18 provinces);
// owner(c, r) gives the nation index, terrain(c, r) and river(c, r, c2, r2) shape the map, hubs are [c, r].
function grid({ W, H, owner, terrain = () => 'plains', river = () => false, hubs = [], nations, armies, seed = 1, player = -1, core = null }) {
  const id = (c, r) => r * W + c + 1;
  const provinces = [null];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const adj = [];
      const riv = [];
      for (const [dc, dr] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const c2 = c + dc;
        const r2 = r + dr;
        if (c2 < 0 || r2 < 0 || c2 >= W || r2 >= H) continue;
        adj.push(id(c2, r2));
        if (river(c, r, c2, r2) || river(c2, r2, c, r)) riv.push(id(c2, r2));
      }
      adj.sort((a, b) => a - b);
      riv.sort((a, b) => a - b);
      provinces.push({ id: id(c, r), name: `G${c}-${r}`, sea: false, iso: 'GEN', x: 40 * c + 20, y: 40 * r + 20, lon: c, lat: -r, area: 2500, terrain: terrain(c, r), climate: 'temperate', coastal: false, port: false, adj, river: riv });
    }
  }
  const map = { v: 1, id: 'grid', name: 'Grid', texture: { file: null, width: 40 * W, height: 40 * H }, projection: { type: 'equirect', lon0: 0, lat0: 0, pxPerDeg: 40 }, provinces, cells: [], straits: [] };
  const tags = nations.map((x) => x.tag);
  const own = {};
  tags.forEach((t) => { own[t] = []; });
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) own[tags[owner(c, r)]].push(id(c, r));
  const tpl = { id: 'inf14', name: 'Infantry Division', line: ['inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'inf', 'art', 'art', 'mg', 'mg'], support: ['eng', 'cav'] };
  const scenario = {
    v: 1, id: 'grid', map: 'grid', name: 'Grid', start: '1914-06-28', end: '1920-01-01',
    nations: nations.map((x) => ({ tag: x.tag, name: x.tag, color: '#888888', capital: id(...x.capital), bloc: null, major: true, manpower: 400000, personality: { ...PERS, ...(x.personality || {}) }, goals: [], generals: [{ name: `${x.tag} General`, trait: x.trait || 'logistics' }], templates: [tpl], lines: [] })),
    owner: own, cores: core ? Object.fromEntries(tags.map((t, i) => [t, provinces.slice(1).filter((p) => core((p.id - 1) % W, Math.trunc((p.id - 1) / W)) === i).map((p) => p.id)])) : {}, provinces: Object.fromEntries(provinces.slice(1).map((p) => [p.id, { infra: 5, hub: hubs.some(([c, r]) => id(c, r) === p.id) }])),
    armies: armies.map((a) => ({ nation: tags[a.nation], name: a.name, general: `${tags[a.nation]} General`, template: 'inf14', divisions: a.divisions, at: a.at.map((x) => id(...x)) })),
    alliances: [], wars: [[tags[0], tags[1]]], events: [],
  };
  return { ctx: { map, scenario, rules, state: ST.create(map, scenario, rules, { seed, player }) }, id };
}

function contactLine(ctx, n) {
  const { map, state } = ctx;
  const rel = M.relations(state);
  const out = [];
  for (let p = 1; p < map.provinces.length; p++) {
    if (map.provinces[p].sea || state.prov.ctrl[p] !== n) continue;
    if (map.provinces[p].adj.some((q) => !map.provinces[q].sea && M.hostile(rel, n, state.prov.ctrl[q]))) out.push(p);
  }
  return out;
}

const destOf = (d) => (d.to === null ? d.prov : d.path.length ? d.path[d.path.length - 1] : d.to);

// The coverage rule of the header, for nation n; `before` is the previous day's contact line.
function coverage(ctx, n, before) {
  const { map, state } = ctx;
  const rel = M.relations(state);
  const line = contactLine(ctx, n);
  const onLine = new Set(line);
  const fighting = new Set();
  for (const b of state.battles) { for (const id of b.att) fighting.add(id); for (const id of b.def) fighting.add(id); }
  const covered = new Set((state.nations[n].ai.legs || []).map(([, p]) => p));
  const standing = new Map();
  for (const d of state.divs) {
    if (d.nation !== n) continue;
    covered.add(d.prov);
    covered.add(destOf(d));
    if (d.to === null) standing.set(d.prov, (standing.get(d.prov) || 0) + 1);
  }
  const massing = new Set();
  for (const a of state.nations[n].armies) {
    for (const off of a.offensives) {
      if (!off.on) continue;
      const t = off.path.find((p) => !M.camp(rel, n, state.prov.ctrl[p]));
      if (t) for (const q of map.provinces[t].adj) massing.add(`${a.id}:${q}`);
    }
  }
  const cap = ctx.scenario.nations[n].capital;
  // A lone division in a rear province that keeps a garrison (general.js: a hub or mil 2 or more of n's own) is not spare.
  const keep = (p) => state.prov.owner[p] === n && (M.facts(ctx).hub[p] || state.prov.mil[p] >= 2) && !onLine.has(p) && standing.get(p) === 1;
  const spare = (d) => d.nation === n && !d.manual && d.to === null && !fighting.has(d.id) && d.org >= 650 && d.str >= 400 && d.prov !== cap && !keep(d.prov) &&
    (!onLine.has(d.prov) || standing.get(d.prov) >= 2) && !(d.army !== null && massing.has(`${d.army}:${d.prov}`));
  const spareAt = new Map();
  let ready = 0;
  for (const d of state.divs) {
    if (d.nation === n && !d.manual && d.org >= 650 && d.str >= 400) ready++;
    if (spare(d)) spareAt.set(d.prov, (spareAt.get(d.prov) || []).concat([d.id]));
  }
  const bad = [];
  const live = ready >= line.length;
  for (const p of line) {
    if (!live || !before.has(p) || covered.has(p)) continue;
    const seen = new Set([p]);
    let ring = [p];
    const near = [];
    for (let h = 0; h < 3; h++) {
      const next = [];
      for (const x of ring) {
        for (const q of map.provinces[x].adj) {
          if (seen.has(q) || map.provinces[q].sea || state.prov.ctrl[q] !== n) continue;
          seen.add(q);
          if (spareAt.has(q)) near.push(...spareAt.get(q));
          next.push(q);
        }
      }
      ring = next;
    }
    if (near.length) bad.push({ p, spares: near });
  }
  return { bad, live, line: new Set(line), empty: new Set(line.filter((p) => !covered.has(p))) };
}

await section('determinism, coverage and no refusals with three AI nations', () => {
  const before = refused.length;
  const run = (save) => {
    const ctx = generated(21, { provinces: 300, nations: 3, wars: [[0, 1], [1, 2], [0, 2]] });
    const hashes = [];
    for (let day = 1; day <= 120; day++) {
      T.step(ctx, 24);
      hashes.push(H.hash(ctx.state));
      if (save && day === 60) {
        const back = SV.read(SV.write(ctx.state));
        check(back.ok, 'a save with the AI state reads back');
        ctx.state = back.state;
      }
    }
    return { hashes, ctx };
  };
  const a = run(false);
  const b = run(false);
  const c = run(true);
  check(S(a.hashes) === S(b.hashes), 'two 120 day runs with the AI give the same hash every day');
  check(S(a.hashes) === S(c.hashes), 'save on day 60, read and continue gives the same daily hashes');
  check(new Set(a.hashes).size > 100, 'the state keeps changing (the AI is acting)');
  const ctx = generated(21, { provinces: 300, nations: 3, wars: [[0, 1], [1, 2], [0, 2]], density: 800 });
  let live = 0;
  let prev = [0, 1, 2].map(() => new Set());
  const gaps = [];
  for (let day = 1; day <= 120; day++) {
    T.step(ctx, 18);
    const first = [0, 1, 2].map((n) => coverage(ctx, n, prev[n]));
    T.step(ctx, 6);
    prev = [0, 1, 2].map((n) => {
      const later = coverage(ctx, n, first[n].line);
      if (day >= 6 && first[n].live) live++;
      if (day >= 6) for (const g of first[n].bad) if (later.bad.some((x) => x.p === g.p && x.spares.some((s) => g.spares.includes(s)))) gaps.push(`${day}:${n}:${g.p}<${g.spares[0]}`);
      return later.line;
    });
  }
  note(`coverage checked on ${live} of ${115 * 3} nation-days (the others had fewer ready divisions than contact provinces)`);
  check(live >= 60, `the coverage check was live on at least 60 nation-days (${live})`);
  check(gaps.length === 0, `no contact province is left empty with a spare division within 3 provinces (${gaps.length}: ${gaps.slice(0, 8).join(' ')})`);
  const moved = [0, 1, 2].map((n) => ctrlCount(a.ctx, n));
  note(`provinces at day 120: ${moved.join(' ')}; AI orders ${aiOrders.length}`);
  check(refused.length === before, `no AI order refused in these runs (${refused.length - before}${refused.length > before ? `: ${S(refused[before])}` : ''})`);
});

await section('3:1 takes the capital', () => {
  const days = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const ctx = generated(seed, { perArmy: (n) => (n === 0 ? 22 : 7) });
    const cap = ctx.scenario.nations[1].capital;
    let day = 0;
    while (day < CAPITAL_DAYS && ctx.state.prov.ctrl[cap] !== 0) { T.step(ctx, 24); day++; }
    days.push(ctx.state.prov.ctrl[cap] === 0 ? day : -1);
  }
  note(`days to the capital at 44 against 14 divisions: ${days.join(' ')}`);
  check(days.every((d) => d > 0), `at 3:1 the capital falls within ${CAPITAL_DAYS} days on every seed (${days.join(' ')})`);
});

function riverLine(seed) {
  const W = 12;
  const Hh = 8;
  return grid({
    W, H: Hh, seed,
    owner: (c) => (c < 6 ? 0 : 1),
    terrain: (c) => (c === 5 || c === 6 ? 'hills' : 'plains'),
    river: (c, r, c2) => (c === 5 && c2 === 6),
    nations: [{ tag: 'AAA', capital: [0, 4] }, { tag: 'BBB', capital: [11, 3] }],
    armies: [
      { nation: 0, name: 'A1', divisions: 8, at: [[5, 0], [5, 1], [5, 2], [5, 3]] }, { nation: 0, name: 'A2', divisions: 8, at: [[5, 4], [5, 5], [5, 6], [5, 7]] },
      { nation: 1, name: 'B1', divisions: 8, at: [[6, 0], [6, 1], [6, 2], [6, 3]] }, { nation: 1, name: 'B2', divisions: 8, at: [[6, 4], [6, 5], [6, 6], [6, 7]] },
    ],
  });
}

await section('1:1 across a river on hills: the line holds and both sides dig in', () => {
  const moves = [];
  const digs = [];
  for (const seed of [1, 2, 3]) {
    const { ctx } = riverLine(seed);
    const start = ctrlCount(ctx, 0);
    for (let day = 0; day < 90; day++) T.step(ctx, 24);
    moves.push(Math.abs(ctrlCount(ctx, 0) - start));
    const dig = [0, 1].map((n) => {
      const line = new Set(contactLine(ctx, n));
      const ds = ctx.state.divs.filter((d) => d.nation === n && line.has(d.prov) && d.to === null);
      return ds.length ? Math.trunc(ds.reduce((s, d) => s + d.dig, 0) / ds.length) : 0;
    });
    digs.push(dig);
  }
  note(`net provinces moved: ${moves.join(' ')}; mean trench on the line (A, B): ${digs.map((d) => d.join('/')).join(' ')}`);
  check(moves.every((x) => x <= LINE_MOVES), `the line moves at most ${LINE_MOVES} provinces in 90 days (${moves.join(' ')})`);
  check(digs.every((d) => d[0] >= 300 && d[1] >= 300), `both sides are dug in on the line, mean trench >= 300 (${digs.map((d) => d.join('/')).join(' ')})`);
});

await section('an attacker whose supply is cut stops attacking', () => {
  const play = (cut) => {
    const { ctx } = grid({
      W: 10, H: 6, seed: 3,
      owner: (c) => (c < 5 ? 0 : 1),
      nations: [{ tag: 'AAA', capital: [0, 2], trait: 'offence' }, { tag: 'BBB', capital: [9, 2] }],
      armies: [{ nation: 0, name: 'A1', divisions: 20, at: [[4, 0], [4, 1], [4, 2], [4, 3], [4, 4], [4, 5]] }, { nation: 1, name: 'B1', divisions: 6, at: [[5, 0], [5, 2], [5, 4]] }],
    });
    const { state } = ctx;
    for (let day = 0; day < 4; day++) T.step(ctx, 24);
    const cap = ctx.scenario.nations[0].capital;
    if (cut) { state.prov.ctrl[cap] = 1; state.prov.owner[cap] = 0; }
    T.step(ctx, 24);
    const seen = new Set(state.battles.map((b) => b.id));
    let started = 0;
    for (let h = 0; h < 24 * 5; h++) {
      T.step(ctx, 1);
      for (const b of state.battles) if (!seen.has(b.id)) { seen.add(b.id); if (b.side === 0) started++; }
    }
    const calls = X.recent(ctx, 0).filter((d) => d.chosen.label === 'offensive-called-off').map((d) => d.chosen.args.reason);
    const planned = X.recent(ctx, 0).some((d) => d.chosen.label === 'offensive-toward');
    return { started, calls, planned, sup: Math.trunc(state.divs.filter((d) => d.nation === 0).reduce((s, d) => s + d.sup, 0) / state.divs.filter((d) => d.nation === 0).length) };
  };
  const cut = play(true);
  const free = play(false);
  note(`battles started by the attacker from day 2 to 6 after the cut: ${cut.started} (uncut ${free.started}); mean sup ${cut.sup} (uncut ${free.sup}); call-offs ${cut.calls.join(',')}`);
  check(free.planned && free.started > 0, 'uncut, the attacker plans an offensive and attacks in that window');
  check(cut.started === 0, `cut off, it starts no battle in that window (${cut.started})`);
  check(cut.calls.includes('supply'), `and calls its offensive off for supply (${cut.calls.join(',')})`);
});

function naive(ctx, n) {
  const { state, map } = ctx;
  const rel = M.relations(state);
  for (const d of state.divs) {
    if (d.nation !== n || d.to !== null) continue;
    const seen = new Set([d.prov]);
    let ring = [d.prov];
    let goal = 0;
    while (ring.length && !goal) {
      const next = [];
      for (const p of ring) {
        for (const x of map.provinces[p].adj) {
          if (seen.has(x) || map.provinces[x].sea) continue;
          seen.add(x);
          if (M.hostile(rel, n, state.prov.ctrl[x])) { goal = x; break; }
          next.push(x);
        }
        if (goal) break;
      }
      ring = next.sort((a, b) => a - b);
    }
    if (goal) script(() => O.apply(ctx, n, { type: 'move', div: d.id, to: goal }));
  }
}

await section('against no AI and against a naive AI', () => {
  const duel = (opponent) => {
    const gains = [];
    for (let seed = 1; seed <= 20; seed++) {
      const ctx = generated(seed, { player: 1, perArmy: () => 15 });
      const start = ctrlCount(ctx, 0);
      for (let day = 0; day < 90; day++) { if (opponent === 'naive') naive(ctx, 1); T.step(ctx, 24); }
      gains.push(ctrlCount(ctx, 0) - start);
    }
    return gains;
  };
  const hold = duel('hold');
  const rush = duel('naive');
  const wins = (g) => g.filter((x) => x > 0).length;
  note(`net provinces gained in 90 days, against holding still: ${hold.join(' ')}`);
  note(`against the naive AI: ${rush.join(' ')}`);
  check(wins(hold) >= 19, `the AI gains ground against the same nation holding still in >= 19 of 20 seeds (${wins(hold)})`);
  check(wins(rush) >= 14, `and against the naive AI in >= 14 of 20 seeds (${wins(rush)})`);
});

await section("the player's plan is carried out", () => {
  const ctx = generated(7, { player: 0, perArmy: (n) => (n === 0 ? 20 : 8) });
  const { state, map } = ctx;
  for (const d of state.divs) if (d.nation === 1) d.army = null;
  for (const a of state.nations[1].armies) a.divs = [];
  const [a1, a2] = state.nations[0].armies;
  const line = contactLine(ctx, 0);
  const cap = ctx.scenario.nations[1].capital;
  const start = line.find((p) => map.provinces[p].adj.some((q) => state.prov.ctrl[q] === 1));
  const prev = new Map([[start, 0]]);
  let ring = [start];
  while (ring.length && !prev.has(cap)) {
    const next = [];
    for (const p of ring) for (const q of map.provinces[p].adj) if (!prev.has(q) && !map.provinces[q].sea && state.prov.ctrl[q] === 1) { prev.set(q, p); next.push(q); }
    ring = next.sort((a, b) => a - b);
  }
  const path = [];
  for (let p = cap; p !== start; p = prev.get(p)) path.unshift(p);
  const manual = a1.divs.slice(0, 2);
  script(() => {
    check(O.apply(ctx, 0, { type: 'front', army: a1.id, provinces: line }).ok, 'the player draws a front');
    const r = O.apply(ctx, 0, { type: 'offensive', army: a2.id, path });
    check(r.ok, 'and an offensive');
    check(O.apply(ctx, 0, { type: 'launch', army: a2.id, offensive: r.id, on: true }).ok, 'and launches it');
    for (const id of manual) O.apply(ctx, 0, { type: 'halt', div: id });
  });
  const where = manual.map((id) => M.divById(state, id).prov);
  const firstOrder = aiOrders.length;
  let gaps = 0;
  for (let day = 1; day <= 40; day++) {
    T.step(ctx, 24);
    if (day >= 10) {
      const held = new Set(state.divs.filter((d) => d.nation === 0).map(destOf));
      const usable = a1.divs.length - manual.length;
      const covered = line.filter((p) => state.prov.ctrl[p] === 0 && held.has(p)).length;
      const want = Math.min(line.filter((p) => state.prov.ctrl[p] === 0).length, usable);
      if (covered < want) gaps++;
    }
  }
  const taken = path.filter((p) => state.prov.ctrl[p] === 0).length;
  note(`front ${line.length} provinces, ${a1.divs.length} divisions; offensive path ${path.length} provinces, ${taken} taken in 40 days`);
  check(gaps === 0, `from day 10 the front has a division on as many of its provinces as the army can cover (${gaps} days short)`);
  check(taken >= Math.min(3, path.length), `the general advances along the player's path (${taken} of ${path.length})`);
  check(manual.every((id, i) => M.divById(state, id).prov === where[i] && M.divById(state, id).to === null && M.divById(state, id).manual), 'manual divisions stay where the player left them');
  check(!aiOrders.slice(firstOrder).some((x) => manual.includes(x.o.div)), 'and no AI order names them');
});

await section('encirclement', () => {
  const corridor = (c, r) => r === 3 && c >= 5 && c <= 7;
  const bulb = (c, r) => c >= 2 && c <= 4 && r >= 2 && r <= 5;
  const cutDays = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const { ctx, id } = grid({
      W: 16, H: 8, seed, hubs: [[12, 1], [12, 6]],
      owner: (c, r) => (c >= 8 || corridor(c, r) || bulb(c, r) ? 1 : 0),
      nations: [{ tag: 'AAA', capital: [0, 7] }, { tag: 'BBB', capital: [15, 4] }],
      armies: [
        { nation: 0, name: 'A1', divisions: 12, at: [[5, 2], [6, 2], [7, 2], [5, 4], [6, 4], [7, 4]] },
        { nation: 0, name: 'A2', divisions: 12, at: [[1, 2], [1, 4], [3, 1], [3, 6], [7, 0], [7, 6]] },
        { nation: 0, name: 'A3', divisions: 12, at: [[7, 5], [7, 6], [7, 7], [6, 7], [1, 6], [0, 7]] },
        { nation: 1, name: 'B1', divisions: 6 + (seed % 2), at: [[2, 2], [3, 3], [4, 4], [3, 5]] },
        { nation: 1, name: 'B2', divisions: 6, at: [[8, 1], [8, 3], [8, 5], [8, 7]] },
        { nation: 1, name: 'B3', divisions: 3, at: [[5, 3], [6, 3], [7, 3]] },
      ],
    });
    const pocket = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 16; c++) if (bulb(c, r)) pocket.push(id(c, r));
    const inPocket = (d) => d.nation === 1 && pocket.includes(d.prov);
    check(ctx.state.divs.filter(inPocket).every((d) => d.sup > 0), `seed ${seed}: the pocket starts supplied`);
    let day = 0;
    while (day < POCKET_DAYS) {
      T.step(ctx, 24);
      day++;
      const trapped = ctx.state.divs.filter(inPocket);
      if (trapped.length && trapped.every((d) => d.sup === 0)) break;
      if (![[15, 4], [12, 1], [12, 6]].every(([c, r]) => ctx.state.prov.ctrl[id(c, r)] === 1)) break;
    }
    const trapped = ctx.state.divs.filter(inPocket);
    const neck = [[15, 4], [12, 1], [12, 6]].every(([c, r]) => ctx.state.prov.ctrl[id(c, r)] === 1);
    cutDays.push(neck && trapped.length && trapped.every((d) => d.sup === 0) ? day : -1);
  }
  const closed = cutDays.filter((d) => d > 0).length;
  note(`days until the pocket is cut off: ${cutDays.join(' ')}`);
  check(closed >= 4, `the AI cuts the pocket off within ${POCKET_DAYS} days in >= 4 of 5 seeds (${cutDays.join(' ')})`);
});

await section('explain', () => {
  const ctx = generated(5, { perArmy: (n) => (n === 0 ? 20 : 10) });
  for (let day = 0; day < 10; day++) T.step(ctx, 24);
  const plans = X.recent(ctx, 0).filter((d) => d.layer === 'operations' && d.chosen.label === 'offensive-toward');
  check(plans.length > 0, 'an AI nation that planned an offensive has it in explain.recent');
  const d = plans[0];
  check(d && d.options.length >= 1 && d.options.length <= 3 && d.options.every((o) => typeof o.label === 'string' && Number.isInteger(o.score)), 'with up to three scored options');
  check(d && d.factors.length === 3 && d.factors.every((f) => typeof f.label === 'string' && Number.isInteger(f.delta)), 'and the three factors that moved its score most');
  check(d && Number.isInteger(d.chosen.args.province) && Number.isInteger(d.chosen.args.army), 'naming the objective and the army');
});

await section("the nation layer's strategy is read", () => {
  const planned = (posture) => {
    const ctx = generated(5, { perArmy: (n) => (n === 0 ? 20 : 10) });
    ctx.state.nations[0].ai.strategy = { targets: [{ nation: 1, weight: 1000, posture }] };
    for (let day = 0; day < 10; day++) T.step(ctx, 24);
    return X.recent(ctx, 0).filter((d) => d.chosen.label === 'offensive-toward').length;
  };
  const attack = planned('attack');
  const hold = planned('hold');
  check(attack > 0 && hold === 0, `posture attack plans offensives (${attack}), posture hold plans none (${hold})`);
});

await section('the order of systems and layers does not depend on the order files load', () => {
  const dir = fileURLToPath(new URL('../renderer/features/conquest/sim/', import.meta.url));
  const files = JSON.parse(readFileSync(new URL('../renderer/features/conquest/sim/modules.json', import.meta.url), 'utf8')).filter((f) => f !== 'host.js' && f !== 'queries.js');
  const code = `const dir = process.argv[1]; const files = JSON.parse(process.argv[2]); const m = {};
    for (const f of files) m[f] = require(dir + f);
    const rules = require(dir + '../data/units.json');
    const { map, scenario } = m['mapgen.js'].generate({ seed: 21, provinces: 300, nations: 4, divisions: 90 });
    const t = scenario.nations.map((x) => x.tag);
    scenario.wars = [[t[0], t[1]], [t[2], t[3]]];
    const ctx = { map, scenario, rules, state: m['state.js'].create(map, scenario, rules, { seed: 4, player: -1 }) };
    const out = [];
    for (let d = 0; d < 40; d++) { m['tick.js'].step(ctx, 24); if (d % 10 === 9) out.push(m['hash.js'].hash(ctx.state)); }
    console.log(JSON.stringify({ hashes: out, layers: m['tick.js'].LAYERS.map((l) => l.name), systems: m['tick.js'].SYSTEMS.map((s) => s.name) }));`;
  const run = (list) => JSON.parse(execFileSync(process.execPath, ['-e', code, dir, JSON.stringify(list)], { encoding: 'utf8' }));
  const a = run(files);
  const b = run(files.slice().reverse());
  eq(a.layers, ['nation', 'operations', 'general'], 'layers run nation, operations, general');
  eq(b.systems, a.systems, 'the systems run in the same order either way');
  check(S(a.hashes) === S(b.hashes), `the same hashes with the files required in modules.json order and reversed (${a.hashes.join(' ')} / ${b.hashes.join(' ')})`);
});

await section('a nation without armies gets one; offensives do not pile up', () => {
  const ctx = generated(8, { perArmy: (n) => (n === 0 ? 24 : 10) });
  const nat = ctx.state.nations[0];
  for (const a of nat.armies.slice()) script(() => O.apply(ctx, 0, { type: 'army', army: a.id, disband: true }));
  check(nat.armies.length === 0 && ctx.state.divs.some((d) => d.nation === 0 && d.army === null), 'nation 0 starts with its divisions in no army');
  const taken0 = ctrlCount(ctx, 0);
  let most = 0;
  const attacks = new Set();
  for (let day = 0; day < 90; day++) {
    for (let h = 0; h < 24; h++) { T.step(ctx, 1); for (const b of ctx.state.battles) if (b.side === 0) attacks.add(b.id); }
    for (const nn of ctx.state.nations) for (const a of nn.armies) most = Math.max(most, a.offensives.length);
  }
  check(nat.armies.length > 0 && ctx.state.divs.filter((d) => d.nation === 0).every((d) => d.army !== null), `the operations layer made ${nat.armies.length} army and put every division in one`);
  check(attacks.size > 0, `and attacked with it (${attacks.size} battles; ${taken0} -> ${ctrlCount(ctx, 0)} provinces)`);
  check(most <= 3, `no army ever held more than 3 offensives (most ${most})`);
});

// AAA's home is columns 0-3, its colony columns 4-5; BBB holds columns 6-9 with no division anywhere. enemyCore:
// columns 6-9 are BBB's core (the colony faces the enemy's home), else only 8-9 are (it faces BBB's colony).
function colonyBorder(enemyCore) {
  return grid({
    W: 10, H: 3, seed: 2,
    owner: (c) => (c < 6 ? 0 : 1),
    core: (c) => (c < 4 ? 0 : c >= (enemyCore ? 6 : 8) ? 1 : -1),
    nations: [{ tag: 'AAA', capital: [0, 1] }, { tag: 'BBB', capital: [9, 1] }],
    armies: [{ nation: 0, name: 'A1', divisions: 6, at: [[1, 0], [1, 1], [1, 2]] }],
  });
}

await section('a colony facing the enemy home is a front', () => {
  const look = (enemyCore) => {
    const { ctx, id } = colonyBorder(enemyCore);
    const border = [0, 1, 2].map((r) => id(5, r));
    T.step(ctx, 24 * 2);
    const front = ctx.state.nations[0].armies[0].front || [];
    T.step(ctx, 24 * 8);
    const col = (p) => (p - 1) % 10;
    const sent = ctx.state.divs.filter((d) => d.nation === 0 && (col(d.prov) >= 5 || col(destOf(d)) >= 5)).length;
    return { onFront: border.filter((p) => front.includes(p)).length, front: front.length, sent };
  };
  const home = look(true);
  const quiet = look(false);
  note(`colony border on the front, divisions sent: facing the enemy home ${S(home)}, facing its colony ${S(quiet)}`);
  check(home.onFront === 3 && home.sent > 0, `a colony next to an empty enemy core is on the army's front and gets divisions (${S(home)})`);
  check(quiet.onFront === 0 && quiet.sent === 0, `a colony next to an empty enemy colony is still left quiet (${S(quiet)})`);
});

check(refused.length === 0, `no order the AI gave was refused in any run (${refused.length}${refused.length ? `: ${S(refused[0])}` : ''})`);

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
