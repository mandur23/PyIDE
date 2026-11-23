// Nano Studio Conquest on the real 1914 world (renderer/features/conquest/data/world-1914 and data/units.json), every
// nation played by the AI (player -1), in plain Node with the sim files required in sim/modules.json order.
// Always (CI):
// - the scenario loads into state.create with nothing missing: every field the engine reads of a nation, an army, a
//   province entry and the scenario is present with the right type, and the state holds the scenario's own values
//   (manpower, navy, stock, lines, templates, bloc), not a default;
// - the first 60 days: the same hash every day on a second run, and a save written on day 30, read back and continued
//   gives the same hashes to day 60;
// - the July crisis: its declarations fire in order, Belgium is invaded (and Britain enters) once Germany and France
//   are at war however that war began, and by day 60 Austria-Hungary is at war with Serbia and Russia, Germany
//   with Russia, France and Belgium, and Britain with Germany, entered after Belgium was;
// - the AI gave no refused order;
// - on day 60 every army of a nation at war has a front, and no ready standing division of one (org 650, strength 400; not on a waypoint leg nor a
//   lone garrison of its capital, a hub or a factory province) is idle
//   more than IDLE_HOPS provinces from its army's front, where it also stood on day 58, while a path there over its camp's
//   land and through water its camp holds or nobody holds exists (the routes mil-common.send takes: an encircled
//   division, or one behind contested water, is not idle by choice);
// - ms per game day over those 60 days and the worst single hour.
// With CONQUEST_FULL=1 (this PC only): SEEDS games to an outcome, run in parallel child processes, one line each
// (outcome and date, who joined when, Russia, Serbia, men lost per major, the Western Front's phases, the Ottoman
// fronts' battles, far occupation, landings, the longest stillness) and the ms per game day around days 30, 300 and
// 1000 with the worst hour. The gates are the shape of a First World War, as a distribution over the seeds:
// every seed ends in one of the three ends of plan 3.9; no refused order; no nation at war with a land neighbour sits
// 90 days with no division moving or fighting (seen every hour, so a raid that marches and fights within a day counts);
// 1. length: 3/4 still fought on 1 July 1916, 3/4 ended by surrender or peace before 1920, the median end between
//    July 1917 and June 1919;
// 2. who wins: the Entente in more than half, the Central Powers or a peace with Germany keeping 19/20 of its 1914
//    home in at least 1/6;
// 3. the Western Front (France, Belgium and Luxembourg in Europe, Germany west of 9°E), in 30-day windows from the
//    day Germany and France went to war: movement (on day 75 Germany holds 2 or more of those provinces and has not
//    taken Paris) and a stall (12 windows in a row with under WEST_STALL changes of controller, STALL_BATTLES battles a
//    day sampled once a day, and the mean trench of both sides' divisions on the contact line STALL_DIG or more) in
//    more than half; movement again (WEST_STALL changes in one of the last four windows) in half of the games one
//    side breaks;
// 4. the East (European Russia, Germany east of 13°E, Galicia and Bukovina) changes more than the West during the
//    stall in more than half; Serbia falls in some and holds in others; the Caucasus, Mesopotamian and Palestine
//    fronts all see battle in more than half;
// 5. Russia leaves (the russian-collapse event, a collapse or a capitulation) in 2 or more and stays in 2 or more;
//    the USA enters in 3 or more, never before 1917; ITA, TUR, BUL and ROU each join in some games, never in the first
//    month of the war;
// 6. men lost (nation.casualties, as units.lose counts them) in every game past 1917: DEU AUT RUS FRA 2 to 12
//    million, GBR 1 to 6; every major's pool drawn on and none under 5,000 men in the first year;
// 7. no land passes against diplomacy.fits; at most FAR_MAX provinces held more than FAR land provinces from the
//    holder's 1914 land at the end; no great power's capital lost in the first 180 days of its war (from the day it
//    first met an enemy at its border, not restarted when contact is lost for a while); a landing on a
//    defended home coast of a great power in at most one game;
// 8. under BUDGET ms per game day at each sample, measured in one process running alone after the parallel games
//    (the longest of them, played again: the same seed gives the same game), since processes sharing the machine
//    slow each other down.
// Dates are in the game's 365-day calendar. Usage: node verify/conquest-1914.mjs   (CONQUEST_FULL=1 for the long
// section; CONQUEST_VERBOSE=1 prints every check and each game's western windows)
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const SIM = '../renderer/features/conquest/sim/';
const files = JSON.parse(readFileSync(new URL(`${SIM}modules.json`, import.meta.url), 'utf8')).filter((f) => f !== 'host.js' && f !== 'queries.js');
const sim = {};
for (const f of files) sim[f] = require(`${SIM}${f}`);
const ST = sim['state.js'];
const T = sim['tick.js'];
const H = sim['hash.js'];
const O = sim['orders.js'];
const SV = sim['save.js'];
const D = sim['diplomacy.js'];
const M = sim['mapdata.js'];
const MV = sim['movement.js'];
const load = (f) => JSON.parse(readFileSync(new URL(`../renderer/features/conquest/${f}`, import.meta.url), 'utf8'));
const map = load('data/world-1914/map.json');
const scenario = load('data/world-1914/scenario.json');
const rules = load('data/units.json');

const SEEDS = 12;
const BUDGET = 200;
const IDLE_HOPS = 6;
const WEST_STALL = 3;
const STALL_BATTLES = 0.3;
const STALL_DIG = 150;
const FAR_MAX = 20;
const DAY = 24;
const VERBOSE = !!process.env.CONQUEST_VERBOSE;
const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); else if (VERBOSE) console.log(`ok ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
const note = (text) => console.log(`   ${text}`);
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }

const refused = [];
const apply0 = O.apply;
O.apply = (ctx, n, o) => {
  const r = apply0(ctx, n, o);
  if (!r.ok) refused.push({ hour: ctx.state.hour, nation: ctx.state.nations[n].tag, order: o.type, action: o.action, reason: r.reason });
  return r;
};

const tags = new Map(scenario.nations.map((s, i) => [s.tag, i]));
const at = (tag) => tags.get(tag);
const newGame = (seed) => { const state = ST.create(map, scenario, rules, { seed, player: -1 }); return { map, scenario, rules, state }; };
// The game's own calendar (weather.js: 365-day years), so a date here is the one the screens show and the one
// scenario conditions such as dateAfter compare against.
const MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const dateOf = (hour) => {
  const s0 = ST.parseDate(scenario.start);
  const t = s0.doy + Math.trunc(hour / DAY);
  let doy = t % 365;
  let m = 0;
  while (doy >= MONTHS[m]) doy -= MONTHS[m++];
  return `${s0.year + Math.trunc(t / 365)}-${String(m + 1).padStart(2, '0')}-${String(doy + 1).padStart(2, '0')}`;
};
const war = (state, a, b) => D.atWar(state, at(a), at(b));
const Q = require(`${SIM}queries.js`);
const OPS = require(`${SIM}ai/operations.js`);
const MIL = require(`${SIM}ai/mil-common.js`);
// The staff's suggestion for the nation against the fronts operations.run gives its armies on a copy of the state.
// The staff splits the line among the armies that have divisions (an empty one waits in reserve), the operations AI
// among all of them, so the copy first loses the armies with no division.
function staffAgainstOps(ctx, tag) {
  const n = at(tag);
  const sug = Q.answer(ctx, 'suggestFronts', { nation: n });
  const copy = { map, scenario, rules, state: SV.read(SV.write(ctx.state)).state };
  for (const a of copy.state.nations[n].armies.slice()) if (!MIL.usable(copy, a).length) apply0(copy, n, { type: 'army', army: a.id, disband: true });
  OPS.run(copy, n);
  const sorted = (l) => S([...(l || [])].sort((x, y) => x - y));
  const differ = [];
  let armies = 0;
  let provinces = 0;
  for (const a of ctx.state.nations[n].armies) {
    if (!MIL.usable(ctx, a).length) continue;
    armies++;
    const want = copy.state.nations[n].armies.find((x) => x.id === a.id).front;
    const got = sug.find((s) => s.army === a.id);
    provinces += (want || []).length;
    if (got.kind !== 'front' || sorted(got.provinces) !== sorted(want)) differ.push({ army: a.name, staff: got.kind === 'front' ? got.provinces.map((p) => map.provinces[p].name) : 'reserve', ops: (want || []).map((p) => map.provinces[p].name) });
  }
  return { tag, armies, provinces, differ };
}

// One game day, hour by hour, timed: [ms of the day, worst hour].
function day(ctx) {
  let worst = 0;
  const t0 = performance.now();
  for (let h = 0; h < DAY; h++) { const t = performance.now(); T.step(ctx, 1); const x = performance.now() - t; if (x > worst) worst = x; }
  return [performance.now() - t0, worst];
}

const isInt = (x) => Number.isInteger(x);
const NATION = {
  tag: (x) => typeof x === 'string' && x.length === 3, name: (x) => typeof x === 'string' && !!x, color: (x) => /^#[0-9a-f]{6}$/i.test(x),
  capital: (x) => isInt(x) && x > 0 && x < map.provinces.length && !map.provinces[x].sea, bloc: (x) => x === null || x === 'entente' || x === 'central',
  major: (x) => typeof x === 'boolean', manpower: (x) => isInt(x) && x >= 0,
  personality: (x) => x && ['boldness', 'caution', 'loyalty', 'revanchism'].every((k) => isInt(x[k]) && x[k] >= 0 && x[k] <= 100),
  goals: (x) => Array.isArray(x) && x.length > 0 && x.every((g) => typeof g.id === 'string' && ['take', 'hold', 'defend', 'join'].includes(g.kind) && isInt(g.weight)),
  generals: (x) => Array.isArray(x) && x.every((g) => typeof g.name === 'string' && Object.prototype.hasOwnProperty.call(rules.generals, g.trait)),
  templates: (x) => Array.isArray(x) && x.length > 0 && x.every((t) => typeof t.id === 'string' && t.line.length && t.line.concat(t.support || []).every((b) => rules.branches.some((r) => r.id === b && !r.locked))),
  lines: (x) => Array.isArray(x) && x.every((l) => rules.items.some((i) => i.id === l.item && !i.unlock) && isInt(l.factories) && l.factories >= 0),
  navy: (x) => isInt(x) && x >= 0,
  stock: (x) => x && ['rifles', 'guns', 'heavy', 'mgs', 'shells', 'horses'].every((k) => isInt(x[k]) && x[k] >= 0),
};
const PROVINCE = { mil: isInt, civ: isInt, infra: isInt, hub: (x) => typeof x === 'boolean', coal: isInt, iron: isInt, oil: isInt };

const CHILD = !!process.env.CONQUEST_GAME || !!process.env.CONQUEST_PLAYER;
if (!CHILD) await section('the scenario loads as written', () => {
  for (const k of ['start', 'end', 'nations', 'owner', 'cores', 'provinces', 'armies', 'alliances', 'wars', 'events']) check(scenario[k] !== undefined, `scenario.${k} is present`);
  const bad = [];
  scenario.nations.forEach((s) => { for (const [k, ok] of Object.entries(NATION)) if (!ok(s[k])) bad.push(`${s.tag}.${k}`); });
  check(!bad.length, `every one of the ${scenario.nations.length} nations has the ${Object.keys(NATION).length} fields the engine reads, each well formed${bad.length ? `: ${bad.slice(0, 8)}` : ''}`);
  const badArmy = scenario.armies.filter((a) => {
    const s = scenario.nations[at(a.nation)];
    return !s || !s.templates.some((t) => t.id === a.template) || !(a.general === null || a.general === undefined || s.generals.some((g) => g.name === a.general)) ||
      !isInt(a.divisions) || a.divisions < 1 || !a.at.length || !a.at.every((p) => scenario.owner[a.nation].includes(p));
  });
  check(!badArmy.length, `every one of the ${scenario.armies.length} armies names its nation's template and general and stands on its own land${badArmy.length ? `: ${badArmy.map((a) => a.name).slice(0, 5)}` : ''}`);
  const badProv = Object.entries(scenario.provinces).filter(([id, p]) => map.provinces[+id].sea || Object.entries(p).some(([k, v]) => !PROVINCE[k] || !PROVINCE[k](v)));
  check(!badProv.length, `every province entry uses only ${Object.keys(PROVINCE).join(' ')} (absent = mil 0, civ 0, infra 2, no hub, no resources)`);
  const ctx = newGame(1);
  const { state } = ctx;
  const differ = [];
  scenario.nations.forEach((s, i) => {
    const n = state.nations[i];
    const stock = Object.fromEntries(Object.keys(s.stock).map((k) => [k, n.stock[k]]));
    if (n.manpower !== s.manpower || n.navy !== s.navy || n.bloc !== s.bloc || S(stock) !== S(s.stock) || S(n.lines.map((l) => [l.item, l.factories])) !== S(s.lines.map((l) => [l.item, l.factories])) || S(n.templates) !== S(s.templates.map((t) => ({ id: t.id, name: t.name, line: t.line, support: t.support || [] })))) differ.push(s.tag);
  });
  check(!differ.length, `the state holds each nation's own manpower, navy, bloc, stock, lines and templates, not a default${differ.length ? `: ${differ}` : ''}`);
  const divs = scenario.armies.reduce((s, a) => s + a.divisions, 0);
  eq(state.divs.length, divs, `the ${scenario.armies.length} armies field ${divs} divisions`);
  check(['offers', 'diplo', 'settings', 'firedAt'].every((k) => state[k]) && state.nations.every((n) => n.dip && n.ai), 'the diplomacy tables exist from hour 0');
});


// The armies of nations at war: each has a front; a standing division farther than IDLE_HOPS provinces from its
// army's front, with a path there, is idle.
function idle(ctx) {
  const { state } = ctx;
  const m = M.of(ctx);
  const rel = M.relations(state);
  const out = { noFront: [], idle: [] };
  // A lone division in its nation's capital, hub or factory province (mil 2 or more) is that province's garrison (general.js).
  const P = state.prov;
  const alone = (d) => !state.divs.some((o) => o !== d && o.nation === d.nation && o.prov === d.prov && o.to === null);
  const garrison = (d) => P.owner[d.prov] === d.nation && (d.prov === scenario.nations[d.nation].capital || (scenario.provinces[d.prov] || {}).hub || P.mil[d.prov] >= 2) && alone(d);
  state.nations.forEach((nat, n) => {
    if (!nat.alive || !D.enemies(state, n).length) return;
    const legs = new Map(nat.ai.legs || []);
    for (const a of nat.armies) {
      if (!a.divs.length) continue;
      if (!a.front || !a.front.length) { out.noFront.push(`${nat.tag} ${a.name}`); continue; }
      const dist = new Map(a.front.map((p) => [p, 0]));
      const queue = a.front.slice();
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i];
        if (dist.get(p) >= IDLE_HOPS) continue;
        for (const q of m.adj[p]) if (!m.sea[q] && !dist.has(q)) { dist.set(q, dist.get(p) + 1); queue.push(q); }
      }
      for (const id of a.divs) {
        const d = M.divById(state, id);
        if (!d || d.to !== null || d.manual || d.org < 650 || d.str < 400 || m.sea[d.prov] || dist.has(d.prov) || legs.has(d.id) || garrison(d)) continue;
        const route = MV.search(ctx, rel, d, a.front[0], { own: true }).path;
        if (route && route.every((p) => !m.sea[p] || state.sea.ctrl[p] === -1 || (state.sea.ctrl[p] >= 0 && M.camp(rel, n, state.sea.ctrl[p])))) out.idle.push(`${nat.tag} ${a.name} #${d.id} at ${map.provinces[d.prov].name}`);
      }
    }
  });
  return out;
}

const INVASION = ['schlieffen', 'belgium-violated', 'gbr-enters'];
const CRISIS = ['sarajevo', 'ultimatum', 'aut-declares-srb', 'rus-mobilises', 'deu-declares-rus', 'deu-declares-fra', 'schlieffen', 'belgium-violated', 'gbr-enters', 'aut-declares-rus'];

if (!CHILD) await section('the first 60 days', () => {
  const a = newGame(1);
  const hashes = [];
  let saved = null;
  let early = null;
  let belgian = -1;
  let staff = [];
  let ms = 0;
  let worst = 0;
  for (let d = 1; d <= 60; d++) {
    const [x, w] = day(a);
    ms += x;
    if (w > worst) worst = w;
    hashes.push(H.hash(a.state));
    if (d === 30) saved = SV.write(a.state);
    if (d === 50) staff = ['FRA', 'GBR', 'DEU', 'RUS', 'AUT'].map((tag) => staffAgainstOps(a, tag));
    if (d === 58) early = idle(a);
    if (belgian < 0 && D.enemies(a.state, at('DEU')).length && !war(a.state, 'DEU', 'BEL')) {
      const bel = new Set(scenario.owner.BEL);
      belgian = a.state.nations[at('DEU')].armies.filter((x) => (x.front || []).some((p) => map.provinces[p].adj.some((q) => bel.has(q)))).length;
    }
  }
  // The scenario has Germany declare war on Belgium a day after its war with France begins: on the days before, its
  // armies keep the Belgian border (operations.watched), or the Rhineland stands empty when the march begins.
  check(belgian >= 1, `while Germany is at war and has not yet declared on Belgium, ${belgian} of its armies keep a front on the Belgian border (at least 1)`);
  // The player's staff (queries.suggestFronts) gives a nation the fronts the operations AI gives it on the same state:
  // the shared line beside allies (France at Liège and Luxembourg), the capital guard and colonies facing home.
  check(staff.every((s) => s.armies > 0 && !s.differ.length), `on day 50 the staff's fronts equal the operations AI's for ${staff.map((s) => `${s.tag} (${s.armies} armies, ${s.provinces} provinces${s.differ.length ? `, differ: ${S(s.differ.slice(0, 2))}` : ''})`).join(', ')}, and asking changes nothing (hash checked below)`);
  const b = newGame(1);
  let same = true;
  for (let d = 1; d <= 60 && same; d++) { T.step(b, DAY); same = H.hash(b.state) === hashes[d - 1]; }
  check(same, 'a second run gives the same hash every day for 60 days');
  const r = SV.read(saved);
  check(r.ok, 'the day 30 save reads back');
  const c = { map, scenario, rules, state: r.state };
  let cont = H.hash(c.state) === hashes[29];
  for (let d = 31; d <= 60 && cont; d++) { T.step(c, DAY); cont = H.hash(c.state) === hashes[d - 1]; }
  check(cont, 'and continues with the same hashes to day 60');

  const { state } = a;
  const firedAt = (id) => (state.fired.includes(id) ? state.firedAt[state.fired.indexOf(id)] : -1);
  // The declarations fire in order (a refused one still fires); the march into Belgium follows the war with France
  // itself, which the alliances can bring a few days before Germany's own declaration.
  const chain = CRISIS.filter((id) => !INVASION.includes(id));
  const when = chain.map(firedAt);
  const inv = INVASION.map(firedAt);
  const deuFra = D.rel(state, at('DEU'), at('FRA')).since;
  check(when.every((h, i) => h >= 0 && (i === 0 || h >= when[i - 1])) && inv.every((h, i) => h >= 0 && h >= deuFra && (i === 0 || h >= inv[i - 1])),
    `the July crisis fires in order and Belgium is invaded once Germany and France are at war (${dateOf(deuFra)}): ${CRISIS.map((id) => `${id} ${firedAt(id) < 0 ? '-' : dateOf(firedAt(id))}`).join(', ')}`);
  const pairs = [['AUT', 'SRB'], ['DEU', 'RUS'], ['DEU', 'FRA'], ['GBR', 'DEU'], ['AUT', 'RUS'], ['BEL', 'DEU']];
  check(pairs.every(([x, y]) => war(state, x, y)), `by day 60 the core wars stand: ${pairs.map(([x, y]) => `${x}-${y} ${war(state, x, y) ? 'yes' : 'no'}`).join(', ')}`);
  const since = (x, y) => D.rel(state, at(x), at(y)).since;
  check(since('GBR', 'DEU') >= since('BEL', 'DEU'), `Britain entered after Belgium was attacked (${dateOf(since('BEL', 'DEU'))}, ${dateOf(since('GBR', 'DEU'))})`);
  check(!refused.length, `the AI gave no refused order in 60 days (${refused.length}${refused.length ? `: ${S(refused.slice(0, 3))}` : ''})`);
  const relA = M.relations(state);
  const strayed = [];
  state.nations.forEach((nat, n) => {
    for (const army of nat.armies) {
      if (!army.front || !army.front.length) continue;
      for (const off of army.offensives.filter((o) => o.on)) {
        const next = off.path.find((p) => M.hostile(relA, n, state.prov.ctrl[p]));
        if (next === undefined || !map.provinces[next].adj.some((q) => !map.provinces[q].sea && M.camp(relA, n, state.prov.ctrl[q]))) continue;
        const goal = new Set(army.front);
        let ring = [next];
        const seen = new Set(ring);
        let near = false;
        for (let h = 0; h <= 3 && !near; h++) {
          const nextRing = [];
          for (const p of ring) { if (goal.has(p)) near = true; for (const q of map.provinces[p].adj) if (!map.provinces[q].sea && !seen.has(q)) { seen.add(q); nextRing.push(q); } }
          ring = nextRing;
        }
        if (!near) strayed.push(`${nat.tag} ${army.name} toward ${map.provinces[next].name}`);
      }
    }
  });
  check(!strayed.length, `no army on day 60 carries an offensive over land more than 3 provinces from its own front (${strayed.length}${strayed.length ? `: ${strayed.slice(0, 4)}` : ''})`);
  const id = idle(a);
  const before = new Set(early.idle);
  id.idle = id.idle.filter((x) => before.has(x));
  check(!id.noFront.length, `every army of a nation at war has a front on day 60${id.noFront.length ? `: ${id.noFront.slice(0, 6)}` : ''}`);
  check(!id.idle.length, `no division stands idle more than ${IDLE_HOPS} provinces from its army's front with a path there (${id.idle.length}${id.idle.length ? `: ${id.idle.slice(0, 6)}` : ''})`);
  note(`${(ms / 60).toFixed(1)} ms per game day over the first 60 days, worst hour ${worst.toFixed(1)} ms, ${state.divs.length} divisions, ${state.battles.length} battles`);
  check(ms / 60 < BUDGET, `under ${BUDGET} ms per game day (${(ms / 60).toFixed(1)})`);
});

// ---- the long section: one game per child process ----
// What the page does for a player each game day: answers Austria's calls to arms, takes the decision the worker
// offers (the march through Belgium) and gives every army the staff's front (ui/eco-staff.js follow()).
const WEST_KEEP = 35;
function playerDay(ctx, n, seen) {
  const { state } = ctx;
  for (const o of state.offers.slice()) if (o.to === n && o.action === 'call-to-arms') O.apply(ctx, n, { type: 'diplo', action: 'accept', offer: o.id });
  const h = H.hash(state);
  const dec = Q.answer(ctx, 'decisions', {});
  seen.pure = seen.pure && H.hash(state) === h;
  for (const d of dec) {
    seen.asked.push({ id: d.id, wars: d.wars.map((i) => state.nations[i].tag), day: Math.trunc(state.hour / DAY) });
    for (const to of d.wars) O.apply(ctx, n, { type: 'diplo', action: 'declare-war', to });
  }
  if (!D.enemies(state, n).length) return;
  for (const p of Q.answer(ctx, 'suggestFronts', { nation: n })) {
    const army = state.nations[n].armies.find((x) => x.id === p.army);
    if (!army || !p.provinces.length || S([...(army.front || [])].sort((x, y) => x - y)) === S([...p.provinces].sort((x, y) => x - y))) continue;
    O.apply(ctx, n, { type: 'front', army: army.id, provinces: p.provinces });
  }
}

// A whole opening as a player Germany: playerDay each game day and this policy for the offensives, the one a careful
// player reads off the screen. An army with no offensive under way opens one into the hostile province next to its
// front where the screen's odds (the attackOdds query) are best, when they reach PLAYER_GO, one province further
// toward Paris when that is in France, Belgium or Luxembourg; an offensive whose next province shows odds under
// PLAYER_STOP three days running, or that has no hostile province left, is taken off. Returns the provinces of
// France, Belgium and Luxembourg Germany holds on days 30, 75 and 120 of its war with France.
const PLAYER_GO = 550;
const PLAYER_STOP = 400;
const PLAYER_DAYS = [30, 75, 120];
function playerGame(seed) {
  const deu = at('DEU');
  const ctx = { map, scenario, rules, state: ST.create(map, scenario, rules, { seed, player: deu }) };
  const { state } = ctx;
  const P = map.provinces;
  const foe = new Set(['FRA', 'BEL', 'LUX'].flatMap((t) => scenario.owner[t] || []).filter((p) => !P[p].sea && P[p].lat > 41 && P[p].lon > -6 && P[p].lon < 10));
  const paris = scenario.nations[at('FRA')].capital;
  const far = (p) => (P[p].x - P[paris].x) ** 2 + (P[p].y - P[paris].y) ** 2;
  const seen = { asked: [], pure: true };
  const bad = new Map();
  const held = {};
  let fra = -1;
  const offensives = () => {
    const rel = M.relations(state);
    const hostile = (p) => !P[p].sea && M.hostile(rel, deu, state.prov.ctrl[p]);
    for (const a of state.nations[deu].armies) {
      if (!a.divs.length || !a.front) continue;
      for (const o of a.offensives.slice()) {
        const next = o.path.find(hostile);
        let drop = next === undefined;
        if (!drop && o.on) {
          const odds = P[next].adj.some((q) => !P[q].sea && state.prov.ctrl[q] === deu) ? Q.answer(ctx, 'attackOdds', { army: a.id, prov: next }).odds : null;
          bad.set(o.id, odds === null || odds < PLAYER_STOP ? (bad.get(o.id) || 0) + 1 : 0);
          drop = bad.get(o.id) >= 3;
        }
        if (drop) O.apply(ctx, deu, { type: 'offensive', army: a.id, offensive: o.id, path: null });
      }
      if (a.offensives.some((o) => o.on)) continue;
      let best = null;
      for (const q of [...new Set(a.front.flatMap((p) => P[p].adj.filter(hostile)))].sort((x, y) => x - y)) {
        const odds = Q.answer(ctx, 'attackOdds', { army: a.id, prov: q }).odds;
        if (odds !== null && (!best || odds > best.odds)) best = { q, odds };
      }
      if (!best || best.odds < PLAYER_GO) continue;
      const path = [best.q];
      let next = 0;
      for (const r of P[best.q].adj) if (hostile(r) && (!next || far(r) < far(next))) next = r;
      if (next && foe.has(best.q)) path.push(next);
      const r = O.apply(ctx, deu, { type: 'offensive', army: a.id, path });
      if (r.ok) O.apply(ctx, deu, { type: 'launch', army: a.id, offensive: r.id, on: true });
    }
  };
  for (let d = 1; d <= 220; d++) {
    T.step(ctx, 1);
    playerDay(ctx, deu, seen);
    if (D.enemies(state, deu).length) offensives();
    T.step(ctx, DAY - 1);
    if (fra < 0 && war(state, 'DEU', 'FRA')) fra = d;
    if (fra > 0 && PLAYER_DAYS.includes(d - fra)) held[d - fra] = [...foe].filter((p) => state.prov.ctrl[p] === deu).length;
    if (fra > 0 && d - fra >= PLAYER_DAYS[PLAYER_DAYS.length - 1]) break;
  }
  return { seed, held, paris: state.prov.ctrl[paris] === deu, asked: seen.asked.length };
}

if (!CHILD) await section('a player Germany', () => {
  const deu = at('DEU');
  const ctx = { map, scenario, rules, state: ST.create(map, scenario, rules, { seed: 1, player: deu }) };
  const { state } = ctx;
  const own = new Map();
  for (const sc of scenario.nations) for (const p of scenario.owner[sc.tag] || []) own.set(p, sc.tag);
  const west = (p) => { const P = map.provinces[p]; const o = own.get(p); return !P.sea && ((['FRA', 'BEL', 'LUX'].includes(o) && P.lat > 41 && P.lon > -6 && P.lon < 10) || (o === 'DEU' && P.lon < 9 && P.lat > 46)); };
  const inWest = () => state.divs.filter((d) => d.nation === deu && west(d.prov)).length;
  const seen = { asked: [], pure: true };
  const start = inWest();
  let fra = -1;
  let rusOnly = -1;
  let after = -1;
  for (let d = 1; d <= 60 && after < 0; d++) {
    T.step(ctx, 1);
    playerDay(ctx, deu, seen);
    T.step(ctx, DAY - 1);
    if (rusOnly < 0 && war(state, 'DEU', 'RUS') && !war(state, 'DEU', 'FRA')) rusOnly = state.nations[deu].armies.filter((x) => (x.front || []).some((p) => map.provinces[p].adj.some((q) => own.get(q) === 'FRA'))).length;
    if (fra < 0 && war(state, 'DEU', 'FRA')) fra = d;
    if (fra > 0 && d === fra + 3) after = inWest();
  }
  // The event that marches an AI Germany into Belgium never fires for a player: the worker offers it as a decision.
  eq(seen.asked.map((x) => [x.id, x.wars]), [['schlieffen', ['BEL', 'LUX']]], 'a player Germany at war with France is offered the march through Belgium once, as a decision');
  check(seen.pure && !Q.answer(ctx, 'decisions', {}).length && war(state, 'DEU', 'BEL') && !state.fired.includes('schlieffen'), 'asking for decisions changes nothing, and once the wars are declared there is none left');
  // While the war is only in the East the border with France (Russia's ally) keeps its armies, and the armies that
  // stand in the West are the ones that hold it: three days into the war with France most of them are still there.
  check(rusOnly >= 3, `while Germany fights only Russia, ${rusOnly} of its armies keep a front on the French border (at least 3)`);
  check(after >= WEST_KEEP, `three days into the war with France ${after} of the ${start} German divisions deployed in the West still stand there (at least ${WEST_KEEP})`);
});

const MAJORS = ['GBR', 'FRA', 'RUS', 'DEU', 'AUT', 'ITA', 'TUR', 'USA', 'JPN'];
const JOINERS = ['ITA', 'TUR', 'BUL', 'ROU', 'USA'];
const POOLS = ['GBR', 'FRA', 'RUS', 'DEU', 'AUT'];
const FAR = 8;
const HAND = 3;
const WEST = 1;
const EAST = 2;
const FRONTS = { caucasus: 3, mesopotamia: 4, palestine: 5 };

// The theatres by 1914 owner and place: west (France, Belgium, Luxembourg in Europe and Germany west of 9°E), east
// (European Russia, Germany east of 13°E, Galicia and Bukovina), the Ottoman fronts (Caucasus, Mesopotamia, Palestine).
function theatres() {
  const r = new Uint8Array(map.provinces.length);
  const own = new Map();
  for (const s of scenario.nations) for (const p of scenario.owner[s.tag] || []) own.set(p, s.tag);
  for (let p = 1; p < map.provinces.length; p++) {
    const P = map.provinces[p];
    if (P.sea) continue;
    const o = own.get(p);
    const { lon, lat, iso } = P;
    if ((['FRA', 'BEL', 'LUX'].includes(o) && lat > 41 && lon > -6 && lon < 10) || (o === 'DEU' && lon < 9 && lat > 46)) r[p] = WEST;
    else if ((o === 'RUS' && lon < 42 && lat > 44 && lat < 60) || (o === 'DEU' && lon >= 13) || (o === 'AUT' && lat > 48.3 && lon > 18.5)) r[p] = EAST;
    else if ((o === 'TUR' || o === 'RUS') && lon > 38 && lon < 50 && lat > 37 && lat < 44.5) r[p] = FRONTS.caucasus;
    else if (iso === 'IRQ' || iso === 'KWT') r[p] = FRONTS.mesopotamia;
    else if (['ISR', 'PSE', 'JOR', 'LBN', 'SYR'].includes(iso) || (iso === 'EGY' && lon > 32 && lat > 29)) r[p] = FRONTS.palestine;
  }
  return r;
}

// Land hops from each nation's 1914 land (-1 out of reach).
function hops() {
  const N = map.provinces.length;
  return state0Owners().map((list) => {
    const d = new Int16Array(N).fill(-1);
    const q = list.slice();
    for (const p of q) d[p] = 0;
    for (let i = 0; i < q.length; i++) for (const r of map.provinces[q[i]].adj) if (!map.provinces[r].sea && d[r] < 0) { d[r] = d[q[i]] + 1; q.push(r); }
    return d;
  });
}
const state0Owners = () => scenario.nations.map((s) => scenario.owner[s.tag] || []);

function game(seed) {
  const ctx = newGame(seed);
  const { state } = ctx;
  const k = state.nations.length;
  const N = map.provinces.length;
  const region = theatres();
  const hop = hops();
  const F = D.facts(ctx);
  const sea = (p) => map.provinces[p].sea;
  const paris = scenario.nations[at('FRA')].capital;
  const caps = scenario.nations.map((s) => s.capital);
  const westFoe = scenario.owner.FRA.concat(scenario.owner.BEL, scenario.owner.LUX).filter((p) => region[p] === WEST);
  const ms = [];
  let worst = 0;
  const lastActive = new Array(k).fill(0);
  const warFrom = new Array(k).fill(-1);
  const firstWar = new Array(k).fill(-1);
  let stillest = { days: 0 };
  const joined = {};
  const lowest = state.nations.map((x) => x.manpower);
  const lowYear = state.nations.map((x) => x.manpower);
  const days = [];
  const landings = new Set();
  let landed = 0;
  const handFar = [];
  let capFirst = [];
  let westStart = -1;
  let srbFell = false;
  const srb = at('SRB');
  let deu75 = -1;
  let paris90 = false;
  let prevCtrl = Int16Array.from(state.prov.ctrl);
  let prevOwner = Int16Array.from(state.prov.owner);
  let d = 0;
  for (; d < 2100 && !state.diplo.outcome; d++) {
    let hoursMs = 0;
    const activeToday = new Uint8Array(k);
    for (let h = 0; h < DAY; h++) {
      const t = performance.now();
      T.step(ctx, 1);
      const x = performance.now() - t;
      hoursMs += x;
      if (x > worst) worst = x;
      // Activity is seen every hour: a raid that marches and fights within one day is a division moving and fighting.
      for (const dv of state.divs) if (dv.to !== null) activeToday[dv.nation] = 1;
      for (const b of state.battles) {
        activeToday[b.side] = 1;
        for (const id of b.def) { const dv = M.divById(state, id); if (dv) activeToday[dv.nation] = 1; }
      }
      for (const b of state.battles) {
        if (landings.has(b.id) || !b.from || !b.from.some(sea)) continue;
        landings.add(b.id);
        const o = state.prov.owner[b.prov];
        if (o >= 0 && o !== b.side && scenario.nations[o].major && F.core[o][b.prov] && b.def.length) landed++;
      }
    }
    ms.push(hoursMs);
    const rel = M.relations(state);
    const ctrl = state.prov.ctrl;
    const row = { w: 0, e: 0, bw: 0, be: 0, o: [0, 0, 0], dig: [0, 0, 0, 0] };
    for (let p = 1; p < N; p++) {
      if (sea(p)) continue;
      if (ctrl[p] !== prevCtrl[p]) {
        if (region[p] === WEST) row.w++; else if (region[p] === EAST) row.e++;
        const o = state.prov.owner[p];
        if (p === caps[o] && ctrl[p] >= 0 && rel.war[ctrl[p] * k + o] && scenario.nations[o].major && firstWar[o] >= 0 && d - firstWar[o] < 180) capFirst.push(`${map.provinces[p].name} ${dateOf(d * DAY)}`);
      }
      const to = state.prov.owner[p];
      if (to !== prevOwner[p] && to >= 0 && !D.fits(ctx, to, p)) handFar.push(`${state.nations[to].tag} ${map.provinces[p].name}`);
    }
    prevCtrl = Int16Array.from(ctrl);
    prevOwner = Int16Array.from(state.prov.owner);
    for (const b of state.battles) {
      if (region[b.prov] === WEST) row.bw++; else if (region[b.prov] === EAST) row.be++;
      for (const [i, r] of [FRONTS.caucasus, FRONTS.mesopotamia, FRONTS.palestine].entries()) if (region[b.prov] === r) row.o[i]++;
    }
    const deu = at('DEU');
    for (const dv of state.divs) {
      if (sea(dv.prov) || region[dv.prov] !== WEST || dv.to !== null) continue;
      const c = ctrl[dv.prov];
      if (!map.provinces[dv.prov].adj.some((q) => !sea(q) && ctrl[q] >= 0 && rel.war[c * k + ctrl[q]])) continue;
      const side = rel.ally[dv.nation * k + deu] ? 0 : 2;
      row.dig[side] += dv.dig; row.dig[side + 1]++;
    }
    days.push(row);
    const v = D.view(ctx);
    for (let n = 0; n < k; n++) {
      const nat = state.nations[n];
      const enemies = nat.alive ? D.enemies(state, n) : [];
      if (!enemies.some((e) => v.border[n * k + e] > 0)) { warFrom[n] = -1; continue; }
      if (warFrom[n] < 0) { warFrom[n] = d; lastActive[n] = d; }
      if (firstWar[n] < 0) firstWar[n] = d;
      if (activeToday[n]) lastActive[n] = d;
      if (!state.divs.some((x2) => x2.nation === n)) lastActive[n] = d;
      if (d - lastActive[n] > stillest.days) stillest = { days: d - lastActive[n], tag: nat.tag, date: dateOf(d * DAY) };
    }
    state.nations.forEach((x, i) => { if (x.manpower < lowest[i]) lowest[i] = x.manpower; if (d < 365 && x.manpower < lowYear[i]) lowYear[i] = x.manpower; });
    for (const t of JOINERS) if (!joined[t] && state.nations[at(t)].alive && D.enemies(state, at(t)).length) joined[t] = { date: dateOf(d * DAY), bloc: state.nations[at(t)].bloc };
    if (!state.nations[srb].alive || ctrl[caps[srb]] !== srb) srbFell = true;
    if (westStart < 0 && war(state, 'DEU', 'FRA')) westStart = d;
    if (westStart >= 0 && d - westStart < 90 && ctrl[paris] === deu) paris90 = true;
    if (westStart >= 0 && d - westStart === 75) deu75 = westFoe.filter((p) => ctrl[p] === deu).length;
  }
  // 30-day windows of the Western Front from the day Germany and France went to war.
  const bins = [];
  for (let s = Math.max(0, westStart); westStart >= 0 && s + 30 <= days.length; s += 30) {
    const b = { w: 0, e: 0, bw: 0, dig: [0, 0, 0, 0] };
    for (let i = s; i < s + 30; i++) { const r = days[i]; b.w += r.w; b.e += r.e; b.bw += r.bw; for (let j = 0; j < 4; j++) b.dig[j] += r.dig[j]; }
    bins.push({ w: b.w, e: b.e, bw: b.bw / 30, digC: b.dig[1] ? b.dig[0] / b.dig[1] : 0, digE: b.dig[3] ? b.dig[2] / b.dig[3] : 0 });
  }
  let stall = { len: 0, from: -1 };
  let run = 0;
  bins.forEach((b, i) => { const ok = i >= 2 && b.w < WEST_STALL && b.bw >= STALL_BATTLES && b.digC >= STALL_DIG && b.digE >= STALL_DIG; run = ok ? run + 1 : 0; if (run > stall.len) stall = { len: run, from: i - run + 1 }; });
  let eStall = 0;
  let wStall = 0;
  for (let i = stall.from; i >= 0 && i < stall.from + stall.len; i++) { eStall += bins[i].e; wStall += bins[i].w; }
  const o = D.outcome(ctx);
  const deu = at('DEU');
  const home = (scenario.cores.DEU || scenario.owner.DEU).filter((p) => scenario.owner.DEU.includes(p));
  let far = 0;
  for (let p = 1; p < N; p++) { const c = state.prov.ctrl[p]; if (!sea(p) && c >= 0 && (hop[c][p] < 0 || hop[c][p] > FAR)) far++; }
  const fronts = Object.keys(FRONTS).map((_, i) => days.reduce((s, r) => s + r.o[i], 0));
  return {
    seed, days: d, outcome: o ? o.kind : 'none', date: dateOf(o ? o.hour : d * DAY), bloc: o && o.bloc ? o.bloc : null,
    deuHome: state.nations[deu].alive && home.filter((p) => state.prov.owner[p] === deu).length * 20 >= home.length * 19,
    casualties: Object.fromEntries(MAJORS.map((t) => [t, state.nations[at(t)].casualties])),
    pools: Object.fromEntries(POOLS.map((t) => [t, { start: scenario.nations[at(t)].manpower, lowest: lowest[at(t)], year: lowYear[at(t)], end: state.nations[at(t)].manpower }])),
    joined, russia: state.fired.includes('russian-collapse') || state.nations[at('RUS')].dip.collapsed > 0 ? 'collapsed' : !state.nations[at('RUS')].alive ? 'capitulated' : 'stood',
    serbia: srbFell ? 'fell' : 'held',
    ms: { 30: avgAround(ms, 30), 300: avgAround(ms, 300), 1000: avgAround(ms, 1000) }, worst, refused: refused.length, firstRefused: refused[0] || null, stillest,
    early: deu75, paris90, stall, eStall, wStall, late: bins.slice(-4).reduce((s, b) => Math.max(s, b.w), 0), westMonths: bins.map((b) => b.w),
    bins: bins.map((b) => `${b.w}/${b.bw.toFixed(1)}/${Math.trunc(b.digC)}/${Math.trunc(b.digE)}`),
    fronts, far, handFar, landed, capFirst,
  };
}
const avgAround = (ms, from) => { const s = ms.slice(from - 5, from + 5); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };

if (CHILD) {
  process.send(process.env.CONQUEST_PLAYER ? playerGame(+process.env.CONQUEST_PLAYER) : game(+process.env.CONQUEST_GAME));
  process.exit(0);
}

if (process.env.CONQUEST_FULL && !CHILD) {
  await section('the long games', async () => {
    const me = fileURLToPath(import.meta.url);
    const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
    const games = await Promise.all(seeds.map((seed) => new Promise((resolve, reject) => {
      const child = fork(me, [], { env: { ...process.env, CONQUEST_GAME: String(seed) }, execArgv: ['--stack-size=4000'] });
      child.on('message', resolve);
      child.on('exit', (code) => { if (code) reject(new Error(`seed ${seed} exited ${code}`)); });
    })));
    const M1 = (x) => (x / 1e6).toFixed(1);
    for (const g of games) {
      note(`seed ${g.seed}: ${g.outcome} ${g.date}${g.bloc ? ` (${g.bloc} defeated)` : ''}; joined ${JOINERS.map((t) => `${t} ${g.joined[t] ? `${g.joined[t].date.slice(0, 7)}` : '-'}`).join(', ')}; Russia ${g.russia}; Serbia ${g.serbia}; casualties M ${MAJORS.map((t) => `${t} ${M1(g.casualties[t])}`).join(' ')}; west: day 75 ${g.early} held by DEU${g.paris90 ? ', Paris taken' : ''}, stall ${g.stall.len} months (east ${g.eStall} / west ${g.wStall}), last months ${g.late}; Ottoman fronts ${g.fronts.join('/')}; far ${g.far}; landings ${g.landed}; still ${g.stillest.days} ${g.stillest.tag || ''}`);
    }
    if (VERBOSE) for (const g of games) note(`seed ${g.seed} western windows (changes/battles a day/dig Central/dig Entente): ${g.bins.join(' ')}`);
    note('ms per game day around day 30 / 300 / 1000, worst hour (parallel processes, for reference):');
    for (const g of games) note(`  seed ${g.seed}: ${[30, 300, 1000].map((x) => (g.ms[x] === null ? '-' : g.ms[x].toFixed(1))).join(' / ')}; ${g.worst.toFixed(1)}`);
    const longest = games.reduce((a, g) => (g.days > a.days ? g : a), games[0]);
    const alone = await new Promise((resolve, reject) => {
      const child = fork(me, [], { env: { ...process.env, CONQUEST_GAME: String(longest.seed) }, execArgv: ['--stack-size=4000'] });
      child.on('message', resolve);
      child.on('exit', (code) => { if (code) reject(new Error(`speed seed ${longest.seed} exited ${code}`)); });
    });
    note(`ms per game day around day 30 / 300 / 1000, worst hour, seed ${alone.seed} alone: ${[30, 300, 1000].map((x) => (alone.ms[x] === null ? '-' : alone.ms[x].toFixed(1))).join(' / ')}; ${alone.worst.toFixed(1)}`);
    const n = games.length;
    const count = (f) => games.filter(f).length;
    const ends = games.filter((g) => ['bloc-defeated', 'general-peace'].includes(g.outcome) && g.date < '1920-01-01');
    const median = games.map((g) => g.date).sort()[Math.floor((n - 1) / 2)];
    check(games.every((g) => ['bloc-defeated', 'general-peace', 'end-date'].includes(g.outcome)), `every seed reaches an end of plan 3.9 (${games.map((g) => g.outcome).join(' ')})`);
    check(games.every((g) => !g.refused), `no refused order (${games.map((g) => g.refused).join(' ')}${games.find((g) => g.firstRefused) ? `: ${S(games.find((g) => g.firstRefused).firstRefused)}` : ''})`);
    check(games.every((g) => g.stillest.days < 90), `no nation at war with a land neighbour sits 90 days with no division moving or fighting (longest ${games.map((g) => `${g.stillest.days}${g.stillest.tag ? ` ${g.stillest.tag}` : ''}`).join(', ')})`);
    check(count((g) => g.date >= '1916-07-01') * 4 >= n * 3, `1. length: at least 3/4 of the games are still fought on 1 July 1916 (${count((g) => g.date >= '1916-07-01')}/${n})`);
    check(ends.length * 4 >= n * 3, `1. length: at least 3/4 end by surrender or peace before 1920 (${ends.length}/${n})`);
    check(median >= '1917-07-01' && median <= '1919-06-30', `1. length: the median end falls between July 1917 and June 1919 (${median})`);
    const entente = count((g) => g.outcome === 'bloc-defeated' && g.bloc === 'central');
    const other = count((g) => (g.outcome === 'bloc-defeated' && g.bloc === 'entente') || (g.outcome === 'general-peace' && g.deuHome));
    check(entente * 2 > n && other * 6 >= n, `2. who wins: the Entente in more than half (${entente}/${n}), the Central Powers or a peace with Germany keeping 19/20 of its 1914 home in at least 1/6 (${other}/${n})`);
    check(count((g) => g.early >= 2 && !g.paris90) * 2 > n, `3. west, movement: on day 75 of the war Germany holds 2 or more provinces of France, Belgium and Luxembourg and has not taken Paris in more than half (${games.map((g) => `${g.early}${g.paris90 ? 'P' : ''}`).join(' ')})`);
    check(count((g) => g.stall.len >= 12) * 2 > n, `3. west, stall: in more than half, 12 or more 30-day windows in a row with under ${WEST_STALL} changes of controller, ${STALL_BATTLES} battles a day and both sides dug in ${STALL_DIG} on the line (${games.map((g) => g.stall.len).join(' ')})`);
    // The same opening with Germany in a player's hands (playerGame): the staff's fronts, the march through Belgium
    // taken when it is offered, offensives where the screen's odds reach ${PLAYER_GO / 10}%.
    const players = await Promise.all(seeds.map((seed) => new Promise((resolve, reject) => {
      const child = fork(me, [], { env: { ...process.env, CONQUEST_PLAYER: String(seed) }, execArgv: ['--stack-size=4000'] });
      child.on('message', resolve);
      child.on('exit', (code) => { if (code) reject(new Error(`player seed ${seed} exited ${code}`)); });
    })));
    const med = (list) => { const x = [...list].sort((a, b) => a - b); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; };
    const line = (dd) => players.map((g) => g.held[dd] ?? '-').join(' ');
    check(med(players.map((g) => g.held[75] || 0)) >= med(games.map((g) => g.early)) && count((g, i) => (players[i].held[120] || 0) > 0) * 6 >= n * 5,
      `3. west, in a player's hands: a player Germany holds on day 75 no fewer provinces of France, Belgium and Luxembourg in the median than the AI's (${med(players.map((g) => g.held[75] || 0))} against ${med(games.map((g) => g.early))}) and still some on day 120 in 5 games of 6 (day 30: ${line(30)}; day 75: ${line(75)}; day 120: ${line(120)}; Paris taken in ${players.filter((g) => g.paris).length})`);
    const broken = games.filter((g) => g.outcome === 'bloc-defeated');
    check(broken.filter((g) => g.late >= WEST_STALL).length * 2 >= broken.length, `3. west, movement again: in at least half the games one side breaks, a window of the last four sees ${WEST_STALL} or more changes (${broken.map((g) => g.late).join(' ')})`);
    const stalled = games.filter((g) => g.stall.len > 0);
    check(stalled.filter((g) => g.eStall > g.wStall).length * 2 > stalled.length, `4. the east moves more than the west during the western stall in more than half (${stalled.map((g) => `${g.eStall}/${g.wStall}`).join(' ')})`);
    check(count((g) => g.serbia === 'fell') > 0 && count((g) => g.serbia === 'held') > 0, `4. Serbia falls in some games and holds in others (${games.map((g) => g.serbia).join(' ')})`);
    check(count((g) => g.fronts.every((x) => x > 0)) * 2 > n, `4. the Caucasus, Mesopotamian and Palestine fronts all see battle in more than half (${games.map((g) => g.fronts.join('/')).join(' ')})`);
    const out = count((g) => g.russia !== 'stood');
    check(out >= 2 && n - out >= 2, `5. Russia leaves the war in at least 2 and stays in at least 2 (${out}/${n} out)`);
    const usa = games.filter((g) => g.joined.USA);
    check(usa.length >= 3 && usa.every((g) => g.joined.USA.date >= '1917-01-01'), `5. the United States enter in at least 3, never before 1917 (${usa.map((g) => g.joined.USA.date).join(' ') || 'none'})`);
    check(['ITA', 'TUR', 'BUL', 'ROU'].every((t) => games.some((g) => g.joined[t]) && games.every((g) => !g.joined[t] || g.joined[t].date >= '1914-08-28')), `5. Italy, the Ottomans, Bulgaria and Romania each join in some games and never in the war's first month (${['ITA', 'TUR', 'BUL', 'ROU'].map((t) => `${t} ${count((g) => g.joined[t])} from ${games.map((g) => g.joined[t] && g.joined[t].date).filter(Boolean).sort()[0] || '-'}`).join(', ')})`);
    const long = games.filter((g) => g.date >= '1918-01-01');
    const band = (g) => ['DEU', 'AUT', 'RUS', 'FRA'].every((t) => g.casualties[t] >= 2e6 && g.casualties[t] <= 12e6) && g.casualties.GBR >= 1e6 && g.casualties.GBR <= 6e6;
    check(long.length > 0 && long.every(band), `6. men lost (nation.casualties, as units.lose counts them) in every game past 1917: DEU AUT RUS FRA 2 to 12 M, GBR 1 to 6 M (${long.map((g) => ['DEU', 'AUT', 'RUS', 'FRA', 'GBR'].map((t) => M1(g.casualties[t])).join('/')).join(' ') || 'no such game'})`);
    check(games.every((g) => POOLS.every((t) => g.pools[t].lowest < g.pools[t].start && g.pools[t].year > 5000)), `6. every major's manpower pool is drawn on and none runs dry in the first year (${games.map((g) => POOLS.filter((t) => !(g.pools[t].lowest < g.pools[t].start && g.pools[t].year > 5000)).join('+') || 'ok').join(' ')})`);
    check(games.every((g) => !g.handFar.length), `7. land passes at a peace or capitulation only by diplomacy.fits (a minor power: its cores, goals and land within ${HAND} provinces of its 1914 land) (${games.map((g) => g.handFar.length).join(' ')})`);
    check(games.every((g) => g.far <= FAR_MAX), `7. at the end at most ${FAR_MAX} provinces are held more than ${FAR} land provinces from the holder's 1914 land (${games.map((g) => g.far).join(' ')})`);
    check(games.every((g) => !g.capFirst.length), `7. no great power's capital falls in the first 180 days of its war (${games.map((g) => g.capFirst.join(', ') || '-').join(' | ')})`);
    check(count((g) => g.landed > 0) <= 1, `7. a landing against a defended home coast of a great power in at most one game (${games.map((g) => g.landed).join(' ')})`);
    for (const at2 of [30, 300, 1000]) {
      const x = alone.ms[at2];
      check(x !== null && x < BUDGET, `under ${BUDGET} ms per game day around day ${at2}, in one process (${x === null ? 'the game ended before' : x.toFixed(1)})`);
    }
  });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
