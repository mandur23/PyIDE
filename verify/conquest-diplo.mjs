// Nano Studio Conquest's diplomacy, events, fatigue, peace and nation AI with its memory (sim/diplomacy.js,
// sim/events.js, sim/ai/{nation,memory,personality}.js) in plain Node:
// - determinism with these systems on: two 200 day runs give the same daily hashes; save, read, continue too;
// - every diplo action: legal cases apply, illegal ones are refused with their reason and the hash unchanged;
// - a war declaration calls allies: a loyal one joins, a disloyal one with a grudge refuses (broke-promise);
// - memory changes judgment: a betrayal lowers trust and turns an accepted alliance offer into a refusal;
// - a lost core keeps a retake goal alive while a lost non-core province fades;
// - fatigue rises with casualties and lost cores; capitulation; collapse in some seeds and not others;
// - peace: a losing AI accepts fitting terms and refuses an absurd demand; provinces, war, truce;
// - events: every condition and effect kind, once, a three-step chain;
// - AI nations alone on 300 provinces reach an outcome, with no refused orders and no stuck nation;
// - evaluate() gives the score and factors the AI's answer records; cost per game day on 5000 provinces.
// Usage: node verify/conquest-diplo.mjs   (CONQUEST_VERBOSE=1 prints every check)
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);
const sim = (f) => require(`../renderer/features/conquest/sim/${f}`);
const G = sim('mapgen.js');
const ST = sim('state.js');
const T = sim('tick.js');
const H = sim('hash.js');
const O = sim('orders.js');
const SV = sim('save.js');
const D = sim('diplomacy.js');
const EV = sim('events.js');
const MEM = sim('ai/memory.js');
const PER = sim('ai/personality.js');
const NAI = sim('ai/nation.js');
const X = sim('ai/explain.js');
const rules = JSON.parse(readFileSync(new URL('../renderer/features/conquest/data/units.json', import.meta.url), 'utf8'));

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); else if (process.env.CONQUEST_VERBOSE) console.log(`ok ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }

const NATION_LAYER = T.LAYERS.find((l) => l.name === 'nation');
const layers = (on) => {
  const i = T.LAYERS.indexOf(NATION_LAYER);
  if (on && i < 0) T.addLayer(NATION_LAYER);
  if (!on && i >= 0) T.LAYERS.splice(i, 1);
};
let refused = [];
NAI.onRefused = (n, o, r) => refused.push({ n, o, reason: r.reason });

const tagIndex = (scenario) => new Map(scenario.nations.map((s, i) => [s.tag, i]));
const tagOf = (ctx, i) => ctx.state.nations[i].tag;
const land = (map) => map.provinces.filter((p) => p && !p.sea);

function bordering(map, scenario) {
  const owner = {};
  for (const [tag, list] of Object.entries(scenario.owner)) for (const p of list) owner[p] = tag;
  const idx = tagIndex(scenario);
  const k = scenario.nations.length;
  const b = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const p of land(map)) for (const q of p.adj) if (owner[q] && owner[q] !== owner[p.id]) b[idx.get(owner[p.id])][idx.get(owner[q])] = 1;
  return b;
}

// A generated world; `edit(scenario, map)` sets blocs, alliances, wars, goals, personalities before the state.
function world({ seed = 11, provinces = 200, nations = 4, edit, player = -1, stateSeed = 1 } = {}) {
  const { map, scenario } = G.generate({ seed, provinces, nations });
  if (edit) edit(scenario, map);
  const state = ST.create(map, scenario, rules, { seed: stateSeed, player });
  return { map, scenario, rules, state };
}

const say = (ctx, n, o) => O.apply(ctx, n, { type: 'diplo', ...o });

// Six nations, two blocs of three with two majors each, the two largest bloc members at war at the start.
function twoBlocs(scenario, map) {
  const tags = scenario.nations.map((s) => s.tag);
  const b = bordering(map, scenario);
  const cap = scenario.nations.map((s) => map.provinces[s.capital]);
  const order = tags.map((t, i) => i).sort((x, y) => cap[x].x - cap[y].x || x - y);
  const west = order.slice(0, 3);
  const east = order.slice(3);
  west.forEach((i, j) => { scenario.nations[i].bloc = 'entente'; scenario.nations[i].major = j < 2; });
  east.forEach((i, j) => { scenario.nations[i].bloc = 'central'; scenario.nations[i].major = j < 2; });
  for (const side of [west, east]) for (let x = 0; x < 3; x++) for (let y = x + 1; y < 3; y++) scenario.alliances.push([tags[side[x]], tags[side[y]]]);
  let pair = null;
  for (const w of west) for (const e of east) if (!pair && b[w][e]) pair = [w, e];
  scenario.wars = [[tags[pair[0]], tags[pair[1]]]];
  scenario.events = [{ id: 'opening', once: true, when: { atWar: tags[pair[0]] }, effects: [{ log: 'opening-shots' }] }];
}

function loadMilitary() {
  const ops = 'renderer/features/conquest/sim/ai/operations.js';
  if (!existsSync(new URL(`../${ops}`, import.meta.url))) return false;
  sim('ai/mil-common.js');
  sim('ai/operations.js');
  sim('ai/general.js');
  return true;
}

await section('personality', () => {
  const ctx = world({ seed: 3, provinces: 60, nations: 4, edit: (s) => { s.nations[0].personality = {}; s.nations[1].personality = { boldness: 90, caution: 10, loyalty: 50, revanchism: 50 }; } });
  const p0 = PER.of(ctx, 0);
  check(PER.GENERIC.some((g) => g.id === p0.id), `a nation without numbers gets a generic personality (${p0.id})`);
  eq(PER.of(ctx, 1).boldness, 90, 'a scenario personality is kept');
  check(PER.threshold(ctx, 1, 'war') < PER.threshold(ctx, 0, 'war') || p0.boldness >= 90, 'boldness lowers the war threshold');
  const ids = new Set();
  for (let s = 0; s < 40; s++) { const c = world({ seed: 3, provinces: 30, nations: 2, stateSeed: s, edit: (sc) => { sc.nations[0].personality = {}; } }); ids.add(PER.of(c, 0).id); }
  eq(ids.size, 4, 'the seed picks among all four generic personalities');
});

await section('determinism and save', () => {
  layers(true);
  const run = (days, from = null) => {
    const ctx = from || world({ seed: 7, provinces: 300, nations: 6, edit: (sc, map) => { twoBlocs(sc, map); sc.events.push({ id: 'escalation', once: true, when: { daysSince: ['opening', 10] }, effects: [{ declareWar: [sc.wars[0][1], sc.wars[0][0] === sc.nations[0].tag ? sc.nations[1].tag : sc.nations[0].tag] }] }); } });
    const hashes = [];
    for (let d = Math.trunc(ctx.state.hour / 24); d < days; d++) { T.step(ctx, 24); hashes.push(H.hash(ctx.state)); }
    return { ctx, hashes };
  };
  const a = run(200);
  const b = run(200);
  eq(a.hashes, b.hashes, 'two runs of 200 days: the same hash every day');
  const st = a.ctx.state;
  check(st.memory.some((l) => l.length > 0) && st.fired.includes('opening') && st.nations.some((n) => (n.ai.decisions || []).some((x) => x.layer === 'nation')), `the run has ledger entries (${st.memory.map((l) => l.length)}), fired events and nation decisions`);
  const half = run(100);
  const back = SV.read(SV.write(half.ctx.state));
  check(back.ok, 'the state with diplomacy reads back from a save');
  const cont = run(200, { ...half.ctx, state: back.state });
  eq(half.hashes.concat(cont.hashes), a.hashes, 'save at day 100, read, continue: the same daily hashes');
  check(S(cont.ctx.state.memory) === S(st.memory) && S(cont.ctx.state.offers) === S(st.offers) && S(cont.ctx.state.fired) === S(st.fired), 'memory, offers and fired events continue identically');
  layers(false);
});

await section('diplo actions', () => {
  layers(false);
  const ctx = world({ seed: 5, provinces: 120, nations: 5, edit: (s) => {
    s.nations[0].bloc = 'red'; s.nations[1].bloc = 'red';
    s.alliances = [[s.nations[0].tag, s.nations[1].tag], [s.nations[0].tag, s.nations[2].tag]];
  } });
  const { state } = ctx;
  const own = (n) => ctx.scenario.owner[tagOf(ctx, n)];
  T.step(ctx, 1);
  const refuse = (n, o, reason, label) => {
    const before = H.hash(state);
    const l = O.legal(ctx, n, { type: 'diplo', ...o });
    const r = say(ctx, n, o);
    check(!r.ok && r.reason === reason && l.reason === reason && H.hash(state) === before, `${label}: refused with ${reason}${r.reason === reason ? '' : ` (got ${r.reason})`}, state unchanged`);
  };
  refuse(0, { action: 'declare-war', to: 1 }, 'same-bloc', 'war on a bloc mate');
  refuse(0, { action: 'declare-war', to: 2 }, 'allied', 'war on an ally without leaving');
  refuse(0, { action: 'declare-war', to: 0 }, 'self', 'war on itself');
  refuse(0, { action: 'declare-war', to: 'ZZZ' }, 'no-such-nation', 'war on a nation that does not exist');
  refuse(0, { action: 'offer-peace', to: 3, terms: {} }, 'not-at-war', 'peace with a nation not at war');
  refuse(0, { action: 'accept', offer: 999 }, 'no-such-offer', 'accepting an offer that does not exist');
  refuse(0, { action: 'join-bloc', bloc: 'blue' }, 'in-bloc', 'joining a bloc while in one');
  refuse(3, { action: 'leave-bloc' }, 'no-bloc', 'leaving a bloc without one');
  refuse(3, { action: 'call-to-arms', to: 4, against: 0 }, 'not-at-war', 'a call to arms without a war');
  refuse(0, { action: 'break-alliance', to: 1 }, 'same-bloc', 'breaking a bloc alliance without leaving the bloc');
  refuse(3, { action: 'break-alliance', to: 4 }, 'not-allied', 'breaking an alliance that does not exist');
  refuse(0, { action: 'offer-alliance', to: 2 }, 'already-allied', 'offering an alliance to an ally');
  refuse(0, { action: 'mobilise', level: 2000 }, 'bad-count', 'mobilising past full');
  refuse(0, { action: 'fly' }, 'unknown-action', 'an unknown action');
  refuse(0, { action: 'join-bloc', bloc: 5 }, 'bad-order', 'a bloc that is not a name');

  check(say(ctx, 3, { action: 'declare-war', to: 4 }).ok && D.atWar(state, 3, 4), 'a legal declaration applies: 3 and 4 are at war');
  refuse(3, { action: 'declare-war', to: 4 }, 'already-at-war', 'declaring a war already fought');
  refuse(3, { action: 'ask-access', to: 4 }, 'at-war', 'asking access of an enemy');
  refuse(3, { action: 'offer-peace', to: 4, terms: { take: [own(3)[0]] } }, 'bad-terms', 'peace terms taking its own province');
  const r1 = say(ctx, 3, { action: 'offer-peace', to: 4, terms: { take: [own(4)[0]] } });
  check(r1.ok && r1.id > 0 && state.offers.some((o) => o.id === r1.id && o.from === 3 && o.to === 4 && o.action === 'offer-peace'), 'a peace offer waits in state.offers');
  refuse(3, { action: 'offer-peace', to: 4, terms: {} }, 'already-offered', 'a second peace offer while one waits');
  refuse(2, { action: 'accept', offer: r1.id }, 'no-such-offer', 'accepting an offer made to another nation');
  const given = own(4)[0];
  const a1 = say(ctx, 4, { action: 'accept', offer: r1.id });
  check(a1.ok && !D.atWar(state, 3, 4) && state.prov.owner[given] === 3 && state.prov.ctrl[given] === 3, 'accepting: the war ends and the named province changes hands');
  check(a1.provinces.includes(given) && !state.offers.length, 'the answer lists the changed provinces and the offer is gone');
  refuse(4, { action: 'declare-war', to: 3 }, 'truce', 'war during the truce');
  check(MEM.summary(ctx, 4).some((x) => x.nation === 3 && x.lines.some((l) => l.kind === 'attacked-us')), 'the attacked nation remembers it');

  const r2 = say(ctx, 3, { action: 'offer-alliance', to: 4 });
  check(r2.ok && say(ctx, 4, { action: 'accept', offer: r2.id }).ok && D.allied(state, 3, 4), 'an alliance offer accepted: allied');
  const r3 = say(ctx, 2, { action: 'ask-access', to: 3 });
  check(r3.ok && say(ctx, 3, { action: 'refuse', offer: r3.id }).ok && !D.rel(state, 2, 3).access && !state.offers.length, 'an access request refused: no access, offer gone');
  const r4 = say(ctx, 2, { action: 'ask-access', to: 3 });
  check(r4.ok && say(ctx, 3, { action: 'accept', offer: r4.id }).ok && D.rel(state, 2, 3).access, 'an access request accepted: access');
  check(say(ctx, 3, { action: 'break-alliance', to: 4 }).ok && !D.allied(state, 3, 4) && D.rel(state, 3, 4).brokeBy === 3, 'breaking an alliance records who broke it');
  check(say(ctx, 4, { action: 'join-bloc', bloc: 'red' }).ok && D.allied(state, 4, 0) && D.allied(state, 4, 1) && state.nations[4].bloc === 'red', 'joining a bloc allies the nation with every member');
  check(say(ctx, 4, { action: 'leave-bloc' }).ok && !D.allied(state, 4, 0) && state.nations[4].bloc === null, 'leaving the bloc ends those alliances');
  check(say(ctx, 2, { action: 'mobilise', level: 1000 }).ok && state.nations[2].dip.mobTarget === 1000, 'mobilise sets the target');
  T.step(ctx, 24 * 3);
  check(state.nations[2].mobilisation >= 100 && state.nations[2].mobilisation <= 1000, `mobilisation moves toward it (${state.nations[2].mobilisation})`);
  const before = H.hash(state);
  check(O.legal(ctx, 3, { type: 'diplo', action: 'declare-war', to: 2 }).ok && H.hash(state) === before, 'legal() of a good declaration changes nothing');
  const ev = D.evaluate(ctx, 2, 3, 'offer-alliance', {});
  check(Number.isInteger(ev.score) && Number.isInteger(ev.threshold) && typeof ev.accept === 'boolean' && /^reply-alliance-(yes|no)$/.test(ev.reply.key) && H.hash(state) === before, `evaluate answers ${ev.score} of ${ev.threshold} with a reply key and changes nothing`);
});

await section('mobilisation readiness', () => {
  layers(false);
  const ctx = world({ seed: 5, provinces: 120, nations: 4, edit: (s) => { s.nations[0].mob = { peace: 400, days: 10 }; s.wars = []; } });
  const { state } = ctx;
  const CB = sim('combat.js');
  eq([state.nations[0].ready, state.nations[1].ready], [400, 1000], 'readiness starts at the scenario peace level, full without one');
  const d = state.divs.find((x) => x.nation === 0);
  const prov = d.prov;
  const atk = CB.attackPower(ctx, d, prov, new Int32Array(rules.branches.length));
  const def = CB.defencePower(ctx, d, prov, 0);
  state.nations[0].ready = 1000;
  const atkFull = CB.attackPower(ctx, d, prov, new Int32Array(rules.branches.length));
  const defFull = CB.defencePower(ctx, d, prov, 0);
  state.nations[0].ready = 400;
  check(atk === Math.trunc((atkFull * 400) / 1000) && def === Math.trunc((defFull * 400) / 1000), `an unmobilised division fights at its nation's readiness (attack ${atk} of ${atkFull}, defence ${def} of ${defFull})`);
  T.step(ctx, 24 * 3);
  eq(state.nations[0].ready, 400, 'at peace and not mobilising, readiness stays at the peace level');
  check(say(ctx, 0, { action: 'mobilise', level: 1000 }).ok, 'mobilise ordered');
  T.step(ctx, 24 * 5);
  eq(state.nations[0].ready, 700, 'mobilising raises readiness by (1000 - peace) / days a day');
  T.step(ctx, 24 * 6);
  eq(state.nations[0].ready, 1000, 'and reaches full after mob.days');
  check(say(ctx, 0, { action: 'mobilise', level: 0 }).ok, 'demobilise ordered');
  T.step(ctx, 24 * 4);
  eq(state.nations[0].ready, 760, 'at peace a demobilising nation falls back toward its peace level');
  const s2 = SV.read(SV.write(state));
  delete s2.state.nations[0].ready;
  const old = { ...ctx, state: s2.state };
  const d2 = s2.state.divs.find((x) => x.nation === 0);
  const noField = CB.attackPower(old, d2, d2.prov, new Int32Array(rules.branches.length));
  s2.state.nations[0].ready = 1000;
  check(noField === CB.attackPower(old, d2, d2.prov, new Int32Array(rules.branches.length)), 'a save from before readiness fights at full weight');
  const w = world({ seed: 5, provinces: 120, nations: 4, edit: (s) => { s.nations[0].mob = { peace: 400, days: 10 }; s.wars = [[s.nations[0].tag, s.nations[1].tag]]; } });
  T.step(w, 24 * 2);
  eq(w.state.nations[0].ready, 520, 'a nation at war mobilises without an order');
});

await section('relations are fresh after every write', () => {
  const ctx = world({ edit: (s) => { s.wars = [[s.nations[0].tag, s.nations[1].tag]]; s.alliances = [[s.nations[2].tag, s.nations[3].tag]]; } });
  const M = sim('mapdata.js');
  const { state } = ctx;
  const k = state.nations.length;
  const fresh = () => { const r = M.relations(state); const keep = { war: r.war.slice(), ally: r.ally.slice(), access: r.access.slice() }; M.touchRelations(state); const r2 = M.relations(state); return S(keep) === S({ war: r2.war.slice(), ally: r2.ally.slice(), access: r2.access.slice() }); };
  const steps = [
    ['makePeace', () => D.makePeace(ctx, 0, 1, {})],
    ['declareWar', () => D.declareWar(ctx, 1, 2)],
    ['breakAlliance', () => D.breakAlliance(ctx, 2, 3, 2)],
    ['makeAlliance', () => D.makeAlliance(ctx, 0, 3)],
    ['joinBloc', () => D.joinBloc(ctx, 1, 'test')],
    ['collapse', () => D.collapse(ctx, 2, null)],
    ['capitulate', () => { D.declareWar(ctx, 0, 1); M.relations(state); D.capitulate(ctx, 1, null); }],
  ];
  for (const [name, fn] of steps) {
    M.relations(state);
    fn();
    check(fresh(), `relations(state) is current right after ${name}, inside the hour`);
  }
  check(M.relations(state).war[0 * k + 1] === 0, 'a capitulated nation is at war with nobody at once');
});

await section('calls to arms', () => {
  layers(false);
  const ctx = world({ seed: 13, provinces: 160, nations: 4, edit: (s) => {
    s.nations[1].bloc = 'b'; s.nations[2].bloc = 'b'; s.nations[3].bloc = 'b';
    s.alliances = [[s.nations[1].tag, s.nations[2].tag], [s.nations[1].tag, s.nations[3].tag], [s.nations[2].tag, s.nations[3].tag]];
    s.nations[2].personality = { boldness: 50, caution: 40, loyalty: 90, revanchism: 50 };
    s.nations[3].personality = { boldness: 50, caution: 60, loyalty: 10, revanchism: 50 };
  } });
  const { state } = ctx;
  MEM.record(ctx, 3, 1, 'broke-promise');
  MEM.record(ctx, 3, 1, 'attacked-us');
  check(say(ctx, 0, { action: 'declare-war', to: 1 }).ok, 'nation 0 declares war on nation 1');
  const calls = state.offers.filter((o) => o.action === 'call-to-arms' && o.from === 1).map((o) => o.to);
  eq(calls, [2, 3], 'the defender calls both of its allies');
  const ev2 = D.evaluate(ctx, 1, 2, 'call-to-arms', { against: 0 });
  const ev3 = D.evaluate(ctx, 1, 3, 'call-to-arms', { against: 0 });
  NAI.think(ctx, 2);
  NAI.think(ctx, 3);
  check(D.atWar(state, 2, 0), `the loyal ally joins the war (${ev2.score} of ${ev2.threshold})`);
  check(!D.atWar(state, 3, 0), `the disloyal ally with a grudge refuses (${ev3.score} of ${ev3.threshold})`);
  const ledger = state.memory[1];
  check(ledger.some((e) => e.about === 3 && e.kind === 'broke-promise'), "the caller's ledger gains broke-promise about the refuser");
  check(ledger.some((e) => e.about === 2 && e.kind === 'kept-promise'), "and kept-promise about the ally that came");
  const dec = X.recent(ctx, 3).find((x) => x.chosen.label === 'answer-refuse');
  const again = say(ctx, 1, { action: 'call-to-arms', to: 3, against: 0 });
  check(again.ok && state.offers.some((o) => o.id === again.id && o.action === 'call-to-arms' && o.terms.against === 0), 'a call to arms by order waits as an offer');
  eq(say(ctx, 1, { action: 'call-to-arms', to: 3, against: 0 }).reason, 'already-offered', 'a second call while one waits');
  eq(say(ctx, 1, { action: 'call-to-arms', to: 2, against: 0 }).reason, 'already-at-war', 'a call to an ally already in the war');
  check(dec && dec.factors.some((f) => f.label === 'loyalty' || f.label === 'memory-grudge'), `the refusal is explained (${dec && dec.factors.map((f) => `${f.label} ${f.delta}`)})`);
});

await section('memory changes judgment', () => {
  layers(false);
  const make = (betray) => {
    const ctx = world({ seed: 17, provinces: 150, nations: 3, edit: (s) => {
      s.alliances = [[s.nations[0].tag, s.nations[1].tag]];
      s.wars = [[s.nations[0].tag, s.nations[2].tag], [s.nations[1].tag, s.nations[2].tag]];
      s.nations[0].personality = { boldness: 50, caution: 50, loyalty: 60, revanchism: 50 };
    } });
    const { state } = ctx;
    T.step(ctx, 24 * 10);
    check(say(ctx, 1, { action: 'break-alliance', to: 0 }).ok, `${betray ? 'betrayal' : 'clean'} run: B ends the alliance with A`);
    if (betray) check(say(ctx, 1, { action: 'declare-war', to: 0 }).ok && state.log.some((e) => e.kind === 'war' && e.betrayal), 'betrayal run: and attacks A at once (logged as a betrayal)');
    T.step(ctx, 24 * 20);
    if (betray) D.makePeace(ctx, 1, 0, {});
    T.step(ctx, 24 * 30);
    const offer = say(ctx, 1, { action: 'offer-alliance', to: 0 });
    const ev = D.evaluate(ctx, 1, 0, 'offer-alliance', {});
    NAI.think(ctx, 0);
    const dec = X.recent(ctx, 0).find((x) => x.chosen.args && x.chosen.args.offer === offer.id);
    return { ctx, ev, dec, trust: MEM.trust(ctx, 0, 1), allied: D.allied(state, 0, 1) };
  };
  const clean = make(false);
  const bad = make(true);
  check(bad.trust < clean.trust, `A's trust in B: ${clean.trust} clean, ${bad.trust} after the betrayal`);
  check(clean.allied && clean.dec && clean.dec.chosen.label === 'answer-accept', `clean run: A accepts B's alliance offer (${clean.ev.score} of ${clean.ev.threshold})`);
  check(!bad.allied && bad.dec && bad.dec.chosen.label === 'answer-refuse', `betrayal run: A refuses it (${bad.ev.score} of ${bad.ev.threshold})`);
  check(bad.dec && bad.dec.factors.some((f) => ['betrayed-us', 'memory-trust', 'memory-grudge'].includes(f.label)), `the memory factor is in the explain record (${bad.dec && bad.dec.factors.map((f) => `${f.label} ${f.delta}`)})`);
  for (const [name, r] of [['clean', clean], ['betrayal', bad]]) {
    const accept = r.dec.options.find((o) => o.label === 'accept');
    const refuse = r.dec.options.find((o) => o.label === 'refuse');
    eq([accept.score, refuse.score, r.dec.factors], [r.ev.score, r.ev.threshold, r.ev.factors.slice(0, 3)], `${name} run: evaluate() gives the score, threshold and factors the answer records`);
  }
  const sum = MEM.summary(bad.ctx, 0).find((x) => x.nation === 1);
  check(sum && sum.lines[0].hour >= sum.lines[sum.lines.length - 1].hour && sum.lines.some((l) => l.kind === 'betrayal' && l.trust < 0), 'summary() lists the lines behind trust newest first');
});

await section('a lost core keeps a goal alive', () => {
  layers(false);
  let core = 0;
  let other = 0;
  const ctx = world({ seed: 19, provinces: 80, nations: 2, edit: (s, map) => {
    const a = s.owner[s.nations[0].tag];
    const bset = new Set(s.owner[s.nations[1].tag]);
    const border = a.filter((p) => p !== s.nations[0].capital && map.provinces[p].adj.some((q) => bset.has(q)));
    core = border[0];
    other = border[1];
    s.cores = { [s.nations[0].tag]: a.filter((p) => p !== other) };
    s.wars = [[s.nations[0].tag, s.nations[1].tag]];
    s.nations[0].personality = { boldness: 50, caution: 50, loyalty: 50, revanchism: 50 };
  } });
  const { state } = ctx;
  T.step(ctx, 24);
  state.prov.ctrl[core] = 1;
  state.prov.ctrl[other] = 1;
  T.step(ctx, 24);
  check(state.memory[0].some((e) => e.kind === 'took-our-core' && e.about === 1) && state.memory[0].some((e) => e.kind === 'took-our-land' && e.about === 1), 'the daily system writes took-our-core and took-our-land');
  D.makePeace(ctx, 1, 0, { take: [core, other] });
  check(state.prov.owner[core] === 1 && state.prov.owner[other] === 1, 'a peace cedes both to B');
  const w = () => {
    const g = NAI.goalsOf(ctx, 0, { feel: MEM.feelings(ctx, 0), amount: (b, k) => MEM.amount(ctx, 0, b, k) });
    const get = (id) => (g.find((x) => x.id === id) || { w: 0 }).w;
    return [get(`retake-core-${tagOf(ctx, 1)}`), get(`retake-land-${tagOf(ctx, 1)}`)];
  };
  NAI.think(ctx, 0);
  const [c0, l0] = w();
  T.step(ctx, 24 * 300);
  NAI.think(ctx, 0);
  const [c1, l1] = w();
  check(c0 > 0 && c1 * 10 >= c0 * 8, `the core retake weight stays high over 300 days (${c0} -> ${c1})`);
  check(l0 > 0 && l1 * 4 <= l0, `the non-core retake weight fades (${l0} -> ${l1})`);
  check(X.recent(ctx, 0).some((x) => x.chosen.label === 'goal-weight' && x.chosen.args.goal === `retake-land-${tagOf(ctx, 1)}` && x.chosen.args.to < x.chosen.args.from), 'the fall of the goal weight is recorded as a decision');
});

await section('fatigue, capitulation, collapse', () => {
  layers(false);
  const pair = (extra) => world({ seed: 23, provinces: 100, nations: 2, edit: (s) => { s.wars = [[s.nations[0].tag, s.nations[1].tag]]; if (extra) extra(s); } });
  const base = pair();
  const hurt = pair();
  T.step(base, 24); T.step(hurt, 24);
  for (let d = 0; d < 20; d++) { hurt.state.nations[0].casualties += 5000; T.step(base, 24); T.step(hurt, 24); }
  check(base.state.nations[0].fatigue > 0, `fatigue rises with each day of war (${base.state.nations[0].fatigue} after 21 days)`);
  check(hurt.state.nations[0].fatigue > base.state.nations[0].fatigue + 50, `and faster with casualties (${hurt.state.nations[0].fatigue} with 100,000 men lost)`);
  const cores = pair();
  const own0 = cores.scenario.owner[cores.state.nations[0].tag].filter((p) => p !== cores.scenario.nations[0].capital);
  for (const p of own0.slice(0, Math.trunc(own0.length / 2))) cores.state.prov.ctrl[p] = 1;
  const base2 = pair();
  T.step(cores, 24 * 20); T.step(base2, 24 * 20);
  check(cores.state.nations[0].fatigue > base2.state.nations[0].fatigue + 15, `lost cores raise it (${cores.state.nations[0].fatigue} vs ${base2.state.nations[0].fatigue})`);

  const small = pair();
  const s1 = small.state;
  const mine1 = small.scenario.owner[s1.nations[0].tag];
  const held1 = mine1.slice(0, Math.ceil(mine1.length * 0.6)).concat([small.scenario.nations[0].capital]);
  for (const p of held1) s1.prov.ctrl[p] = 1;
  s1.nations[0].fatigue = 700;
  const unfit = mine1.filter((p) => !D.fits(small, 1, p));
  T.step(small, 24);
  check(unfit.length > 0 && s1.nations[0].alive && s1.log.some((e) => e.kind === 'collapsed' && e.nation === 0) && !D.atWar(s1, 0, 1) && unfit.every((p) => s1.prov.owner[p] === 0) && held1.filter((p) => D.fits(small, 1, p)).every((p) => s1.prov.owner[p] === 1),
    `beaten by a minor power that may not take all its land (${unfit.length} provinces beyond its reach), a nation sues for peace instead: the fitting occupied land passes, it keeps the rest`);

  const wide = world({ seed: 7, provinces: 900, nations: 3, edit: (s) => { s.nations[0].major = true; } });
  const r0 = D.reach(wide, 0);
  const f0 = D.facts(wide);
  const others = (p) => f0.core[1][p] || f0.core[2][p];
  const near = wide.map.provinces.find((p) => p && !p.sea && others(p.id) && !f0.core[0][p.id] && r0[p.id] > D.TUNING.HAND_HOPS && r0[p.id] <= D.TUNING.MAJOR_HOPS);
  const far = wide.map.provinces.find((p) => p && !p.sea && others(p.id) && !f0.core[0][p.id] && !f0.goal[0][p.id] && r0[p.id] > D.TUNING.MAJOR_HOPS);
  check(near && far && D.fits(wide, 0, near.id) && !D.fits(wide, 0, far.id),
    `a great power may take another's core within ${D.TUNING.MAJOR_HOPS} provinces of its land (${near ? r0[near.id] : '-'} away) but not one ${far ? r0[far.id] : '-'} away`);

  const cap = pair((s) => { s.nations[1].major = true; });
  const s0 = cap.state;
  const mine = cap.scenario.owner[s0.nations[0].tag];
  for (const p of mine.slice(0, Math.ceil(mine.length * 0.6)).concat([cap.scenario.nations[0].capital])) s0.prov.ctrl[p] = 1;
  s0.nations[0].fatigue = 700;
  T.step(cap, 24);
  check(!s0.nations[0].alive, 'capital and most cores lost with fatigue 700 to a great power that may take all its land: the nation capitulates');
  check(!s0.divs.some((d) => d.nation === 0) && mine.every((p) => s0.prov.owner[p] === 1), 'its divisions are gone and its land passes to the occupier');
  check(s0.log.some((e) => e.kind === 'capitulated' && e.nation === 0) && D.outcome(cap) === null, 'logged; a two-nation game without blocs goes on');

  const SEEDS = 40;
  let fell = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const c = world({ seed: 23, provinces: 100, nations: 3, stateSeed: seed, edit: (s) => { s.wars = [[s.nations[0].tag, s.nations[1].tag], [s.nations[0].tag, s.nations[2].tag]]; s.nations[0].bloc = 'x'; } });
    for (let d = 0; d < 60 && !c.state.nations[0].dip?.collapsed; d++) { c.state.nations[0].fatigue = 850; T.step(c, 24); }
    if (c.state.nations[0].dip.collapsed) {
      fell++;
      if (fell === 1) {
        check(!D.enemies(c.state, 0).length && c.state.nations[0].bloc === null && D.weak(c.state, 0), 'a collapse makes peace with every enemy, leaves the bloc, weakens');
        eq(say(c, 0, { action: 'declare-war', to: 1 }).reason, 'weakened', 'a collapsed nation cannot declare war');
      }
    }
  }
  console.log(`collapse at fatigue 850 within 60 days: ${fell}/${SEEDS} seeds`);
  check(fell > 0 && fell < SEEDS, `the collapse fires in some seeds and not others (${fell}/${SEEDS})`);
});

await section('peace', () => {
  layers(false);
  const make = () => {
    const ctx = world({ seed: 29, provinces: 120, nations: 2, edit: (s) => {
      s.wars = [[s.nations[0].tag, s.nations[1].tag]];
      s.nations[1].personality = { boldness: 50, caution: 50, loyalty: 50, revanchism: 50 };
      s.nations[0].personality = { boldness: 50, caution: 50, loyalty: 50, revanchism: 50 };
    } });
    const { state, scenario, map } = ctx;
    const aSet = new Set(scenario.owner[state.nations[0].tag]);
    const front = scenario.owner[state.nations[1].tag].filter((p) => p !== scenario.nations[1].capital && map.provinces[p].adj.some((q) => aSet.has(q)));
    const held = front.slice(0, Math.max(2, Math.trunc(scenario.owner[state.nations[1].tag].length / 6)));
    for (const p of held) state.prov.ctrl[p] = 0;
    T.step(ctx, 24 * 40);
    state.nations[1].fatigue = 700;
    state.nations[0].fatigue = 500;
    return { ctx, held };
  };
  const { ctx, held } = make();
  const { state } = ctx;
  NAI.think(ctx, 0);
  const offer = state.offers.find((o) => o.action === 'offer-peace' && o.from === 0 && o.to === 1);
  check(offer && offer.terms.take.length > 0 && offer.terms.take.every((p) => held.includes(p)), `the winning AI offers peace keeping provinces it holds (${offer && offer.terms.take.length} of ${held.length})`);
  const ev = offer && D.evaluate(ctx, 0, 1, 'offer-peace', offer.terms);
  NAI.think(ctx, 1);
  check(offer && !D.atWar(state, 0, 1), `the losing AI accepts (${ev && ev.score} of ${ev && ev.threshold})`);
  check(offer && offer.terms.take.every((p) => state.prov.owner[p] === 0), 'the named provinces change hands');
  check(held.filter((p) => !offer.terms.take.includes(p)).every((p) => state.prov.ctrl[p] === 1), 'held provinces not named go back to their owner');
  eq(say(ctx, 1, { action: 'declare-war', to: 0 }).reason, 'truce', 'the truce blocks re-declaration');

  const absurd = make();
  const s2 = absurd.ctx.state;
  const all = absurd.ctx.scenario.owner[s2.nations[1].tag];
  const r = say(absurd.ctx, 0, { action: 'offer-peace', to: 1, terms: { take: all } });
  const ev2 = D.evaluate(absurd.ctx, 0, 1, 'offer-peace', { take: all });
  NAI.think(absurd.ctx, 1);
  check(r.ok && D.atWar(s2, 0, 1) && !s2.offers.some((o) => o.id === r.id), `an absurd demand (every province) is refused (${ev2.score} of ${ev2.threshold})`);
  const dec = X.recent(absurd.ctx, 1).find((x) => x.chosen.args && x.chosen.args.offer === r.id);
  check(dec && dec.factors[0].label === 'terms' && dec.chosen.args.reply === 'reply-peace-no', `the refusal names the terms (${dec && dec.factors.map((f) => `${f.label} ${f.delta}`)})`);
});

await section('events', () => {
  layers(false);
  const ctx = world({ seed: 31, provinces: 100, nations: 4, edit: (s) => { s.wars = [[s.nations[0].tag, s.nations[1].tag]]; s.alliances = [[s.nations[2].tag, s.nations[3].tag]]; s.nations[2].bloc = 'z'; } });
  const { state } = ctx;
  const [A, B, C, Dn] = state.nations.map((n) => n.tag);
  const capA = ctx.scenario.nations[0].capital;
  const t = (c) => EV.test(ctx, c);
  const cases = [
    [{ war: [A, B] }, { war: [A, C] }, 'war'],
    [{ atWar: A }, { atWar: C }, 'atWar'],
    [{ ally: [C, Dn] }, { ally: [A, C] }, 'ally'],
    [{ bloc: [C, 'z'] }, { bloc: [A, 'z'] }, 'bloc'],
    [{ bloc: [A, null] }, { bloc: [C, null] }, 'bloc null'],
    [{ controls: [A, [capA]] }, { controls: [B, [capA]] }, 'controls'],
    [{ controlsAny: [A, [capA, ctx.scenario.nations[1].capital]] }, { controlsAny: [C, [capA]] }, 'controlsAny'],
    [{ dateAfter: '1914-06-01' }, { dateAfter: '1915-01-01' }, 'dateAfter'],
    [{ all: [{ atWar: A }, { atWar: B }] }, { all: [{ atWar: A }, { atWar: C }] }, 'all'],
    [{ any: [{ atWar: C }, { atWar: B }] }, { any: [{ atWar: C }, { atWar: Dn }] }, 'any'],
    [{ not: { atWar: C } }, { not: { atWar: A } }, 'not'],
    [{ chance: 1000 }, { chance: 0 }, 'chance'],
  ];
  for (const [yes, no, label] of cases) check(t(yes) && !t(no), `condition ${label}: true and false cases`);
  state.nations[0].fatigue = 300;
  check(t({ fatigueAbove: [A, 200] }) && !t({ fatigueAbove: [A, 300] }), 'condition fatigueAbove: true and false cases');
  const rng = state.rng.slice();
  t({ all: [{ atWar: C }, { chance: 500 }] });
  eq(state.rng, rng, 'chance is not rolled when the rest of an all fails');

  ctx.scenario.events = [
    { id: 'one', once: true, when: { atWar: A }, effects: [{ log: 'first' }] },
    { id: 'two', once: true, when: { daysSince: ['one', 1] }, effects: [{ log: 'second' }, { mobilise: B }] },
    { id: 'three', once: true, when: { all: [{ fired: 'two' }, { daysSince: ['two', 2] }] }, effects: [{ log: 'third' }, { ally: [A, Dn] }] },
    { id: 'war', once: true, when: { fired: 'three' }, effects: [{ declareWar: [C, B] }] },
    { id: 'peace', once: true, when: { all: [{ fired: 'war' }, { war: [C, B] }] }, effects: [{ peace: [C, B] }] },
    { id: 'bloc', once: true, when: { fired: 'peace' }, effects: [{ joinBloc: [B, 'z'] }, { joinBloc: [C, null] }] },
    { id: 'fall', once: true, when: { fired: 'bloc' }, effects: [{ collapse: A }] },
    { id: 'never', once: true, when: { chance: 0 }, effects: [{ log: 'never' }] },
    { id: 'skip', once: true, skipIfPlayer: Dn, when: { atWar: A }, effects: [{ log: 'skipped' }] },
    { id: 'repeat', when: { dateAfter: '1914-01-01' }, every: 5, effects: [{ log: 'again' }] },
  ];
  state.player = 3;
  T.step(ctx, 24 * 12);
  const fired = state.fired.slice();
  const at = (id) => state.firedAt[state.fired.indexOf(id)];
  check(fired.indexOf('one') < fired.indexOf('two') && fired.indexOf('two') < fired.indexOf('three') && at('one') < at('two') && at('three') - at('two') >= 48, `a three-step chain fires in order (${['one', 'two', 'three'].map((id) => at(id) / 24)})`);
  eq(state.log.filter((e) => e.kind === 'event').map((e) => e.key).filter((k) => k !== 'again'), ['first', 'second', 'third'], 'log effects in order, each once');
  check(state.nations[1].mobilisation === 1000, 'effect mobilise');
  check(D.allied(state, 0, 3), 'effect ally');
  check(state.log.some((e) => e.kind === 'war' && e.a === 2 && e.b === 1), 'effect declareWar');
  check(fired.includes('peace') && !D.atWar(state, 2, 1), 'effect peace');
  check(state.nations[1].bloc === null || state.nations[1].bloc === 'z', 'effect joinBloc applied');
  check(fired.includes('bloc') && state.nations[2].bloc === null, 'effect joinBloc null leaves the bloc');
  check(fired.includes('fall') && state.nations[0].dip.collapsed > 0 && !D.atWar(state, 0, 1), 'effect collapse');
  check(!fired.includes('never') && !fired.includes('skip'), 'chance 0 never fires; skipIfPlayer holds while the player plays that tag');
  eq(fired.filter((x) => x === 'one').length, 1, 'a once event fires once');
  const again = state.log.filter((e) => e.key === 'again').length;
  check(again >= 2 && again <= 3, `a repeatable event fires again every 5 days while its condition holds (${again} in 12 days)`);
});

await section('AI nations reach an outcome', () => {
  const military = loadMilitary();
  layers(true);
  const SEEDS = 20;
  const outcomes = [];
  let stuck = 0;
  let worstGap = 0;
  refused = [];
  const finals = [];
  for (let seed = 1; seed <= SEEDS + 1; seed++) {
    const again = seed > SEEDS;
    const ctx = world({ seed: 100 + (again ? 1 : seed), provinces: 300, nations: 6, stateSeed: again ? 1 : seed, edit: twoBlocs });
    const { state } = ctx;
    const k = state.nations.length;
    const lastChange = new Array(k).fill(0);
    const sig = (n) => S([state.divs.filter((d) => d.nation === n).map((d) => d.prov), (state.nations[n].ai.decisions || []).map((x) => x.hour).pop(), state.nations[n].ai.strategy]);
    const busy = (n) => state.divs.some((d) => d.nation === n && d.to !== null) || state.battles.some((b) => b.side === n || b.def.some((id) => { const d = state.divs.find((x) => x.id === id); return d && d.nation === n; }));
    const prev = state.nations.map((_, n) => sig(n));
    let day = 0;
    for (; day < 2100 && !state.diplo?.outcome; day++) {
      T.step(ctx, 24);
      for (let n = 0; n < k; n++) {
        if (!state.nations[n].alive) continue;
        const s = sig(n);
        if (s !== prev[n] || busy(n) || !D.enemies(state, n).length) lastChange[n] = day;
        prev[n] = s;
        worstGap = Math.max(worstGap, day - lastChange[n]);
      }
    }
    const o = D.outcome(ctx);
    finals.push(H.hash(state));
    if (again) { eq(finals[SEEDS], finals[0], 'with the military layers too, seed 1 played again in the same process ends in the same state'); break; }
    outcomes.push(o ? `${o.kind}@${Math.trunc(o.hour / 24)}` : 'none');
    if (state.nations.some((n, i) => n.alive && D.enemies(state, i).length && day - lastChange[i] > 60)) stuck++;
    if (seed === 1) check(o && o.scores.length === k && o.scores.every((x) => Number.isInteger(x.total)), 'the outcome carries a score per nation');
  }
  const early = outcomes.filter((x) => x !== 'none' && !x.startsWith('end-date')).length;
  console.log(`outcomes (${military ? 'with operations.js and general.js' : 'nation layer only'}): ${outcomes.join(' ')}`);
  check(early >= 12, `a bloc defeated or a general peace before the end date in ${early}/${SEEDS} seeds (need 12)`);
  eq(refused.map((r) => `${r.o.type}/${r.o.action || ''}:${r.reason}`).slice(0, 5), [], 'the nation layer gave no refused orders');
  check(stuck === 0 && worstGap <= 60, `no nation at war stood still more than 60 days (longest ${worstGap})`);
  layers(false);
});

await section('cost per game day', () => {
  layers(true);
  const ctx = world({ seed: 41, provinces: 5000, nations: 12, edit: (s, map) => {
    const tags = s.nations.map((n) => n.tag);
    const b = bordering(map, s);
    tags.forEach((t, i) => { s.nations[i].bloc = i % 2 ? 'central' : 'entente'; });
    for (let i = 0; i < 12; i++) for (let j = i + 2; j < 12; j += 2) s.alliances.push([tags[i], tags[j]]);
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j += 2) if (b[i][j] && s.wars.length < 4) s.wars.push([tags[i], tags[j]]);
  } });
  const mine = ['diplomacy', 'events'].map((name) => T.SYSTEMS.find((x) => x.name === name));
  let spent = 0;
  const wrap = (o) => { const run = o.run; o.run = (...a) => { const t0 = performance.now(); try { return run(...a); } finally { spent += performance.now() - t0; } }; return run; };
  const saved = mine.map(wrap).concat([wrap(NATION_LAYER)]);
  T.step(ctx, 24 * 5);
  spent = 0;
  const DAYS = 20;
  T.step(ctx, 24 * DAYS);
  mine.forEach((o, i) => { o.run = saved[i]; });
  NATION_LAYER.run = saved[2];
  const ms = spent / DAYS;
  console.log(`diplomacy + events + nation AI: ${ms.toFixed(2)} ms per game day (5000 provinces, 12 nations, ${ctx.state.divs.length} divisions, ${D.enemies(ctx.state, 0).length} wars of nation 0)`);
  check(ms < 20, `under 20 ms per game day (${ms.toFixed(2)})`);
  layers(false);
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
