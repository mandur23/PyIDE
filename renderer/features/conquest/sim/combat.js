// Battles (plan 3.5). A battle is fought for one province P: its attackers are the divisions entering P (`to` = P)
// with org > 0 that join `side` (movement.joins: its camp, or co-belligerents not at war with it and at war with
// P's controller), its defenders the divisions in P hostile to `side` with org > 0 that stand in the battle's line.
// The line (b.line, division ids in id order) holds at most LINE divisions: while it has held fewer, defenders join
// it, the ones with the most org first, so a reinforcement that comes in later takes a free place; a member that
// breaks keeps its place, so one battle never fills the line past LINE. The other defenders wait outside it, and when
// no member of the line can fight any more they retreat (as a broken defender does, below) and the attackers win, so
// a province is held by its line and not by the depth of the stack behind it. Each hour only the width of
// each side fights (width(): combat.width, plus combat.widthFlank per direction of attack after the first; the ones
// with the most org, lowest index on a tie); the others wait behind and step in as the engaged ones break, so a
// deep line holds and a narrow one cannot be overwhelmed by numbers alone. movement.js opens it; every hour, in
// battle id order, one roll decides who wins the hour:
//
//   A = (1 + flank × (k - 1)) × Σ_att  attackVs(div, mean defender branch counts, shellF) × str × T.attack' × W.attack
//                                       × (crossing a river or strait ? min(1, river + Σ engineers' river) : 1)
//                                       × (from a sea zone ? (P a port ? naval.landPort : naval.landBeach) : 1) × S(sup) × O × Y
//   D = Σ_def  defence × str × T.defence × (1 + combat.dig × max(0, dig - siege) / 100 000) × S(sup) × G × Y
//   siege = the mean siege of the engaged attackers (artillery breaks trenches by its weight, not by the width)
//   p = A × 1000 / (A + D), truncated; the attackers win the hour when rng.int(1000) < p.
//
// Each factor is a fixed-point multiply (rounded toward zero) applied in that order, per division. k is the number
// of distinct provinces the attack comes from (flanking). T is P's terrain row, W P's weather row, S = supply.factor
// (outOfSupply at sup 0 to 1.0 at 1000). The general trait hook (trait(), mapdata.trait) gives O = offence.attack for
// an attacker under an offence general, G = defence.defence for a defender under a defence general, and a terrain
// general halves the attack lost to terrain: T.attack' = 1 - (1 - T.attack) × terrain.terrain. Y is the readiness of
// the division's nation (mapdata.ready, diplomacy.js: it rises from the scenario's peace level as the nation
// mobilises), so a nation still calling up its reservists fights at a fraction of its weight.
// Shells: before its roll each attacker, in index order, fires its division's shells (units.js) from its nation's
// stock; paid of need gives shellF = noShells + (1 - noShells) × paid / need (combat.noShells), 1.0 when it needs
// none. shellF multiplies only the attack of shell-using branches. The hour's p is kept as battle.odds (permille).
//
// The hour's losers each lose org combat.orgHit × combat.orgRef / their org stat and combat.strLoser strength; the
// winners lose combat.strWinner strength (units.lose, so the men count in nation.casualties). A defender at org 0
// retreats to the adjacent land province of its camp with no hostile division and the most supply (lowest id on a
// tie) and is destroyed when there is none; an attacker at org 0 stops moving (from the sea: movement.halt). The battle ends when either side is empty. A division at strength 0 is removed (tick.js).
// Pursuit: when the attackers win and P is not dug in (movement.dugIn: works under movement.TRENCH), every attacker
// still entering P has its eta cut to at most PURSUIT (1) hour, so it takes P before the defender can bring a fresh
// division in by rail; against a dug-in P the attackers walk in at their own pace.
//
// Because the damage of an hour depends only on who won it, a battle from full org is a race. With nA and nD the
// hours each side can lose (ceil(org / org loss)), and p(i, j) the roll threshold after the attackers won i and lost
// j hours (strengths 1000 - strLoser·j - strWinner·i and 1000 - strLoser·i - strWinner·j), the attackers win with
//   Win(i, j) = p(i, j)/1000 · Win(i + 1, j) + (1 - p(i, j)/1000) · Win(i, j + 1),  Win(nD, j) = 1,  Win(i, nA) = 0
// at Win(0, 0); for a constant p this is Σ_{j<nA} C(nD-1+j, j) p^nD (1-p)^j. verify/conquest-engine.mjs measures it.
// Each hour also keeps what it was fought with (lastHour(b): the engaged divisions' strength, supply, trenches and
// shells, the siege, the flank factor, who waited and who stood outside the line) outside the state, so the `battle`
// query can run attackPower and defencePower again with a record of every multiply and show why the odds are b.odds.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).combat = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;
  const R = NODE ? require('./rng.js') : globalThis.Conquest.rng;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const U = NODE ? require('./units.js') : globalThis.Conquest.units;
  const S = NODE ? require('./supply.js') : globalThis.Conquest.supply;
  const MV = NODE ? require('./movement.js') : globalThis.Conquest.movement;

  const LINE = 6;
  const PURSUIT = 1;
  const trait = (ctx, div) => M.trait(ctx, div);

  // With rec (a list), each multiply is also pushed onto it as [factor, permille] in the order applied, the start value
  // first as ['base', value]; queries.js `battle` folds them back into the same number.
  function attackPower(ctx, div, prov, defCounts, shellF = 1000, rec = null) {
    const { rules, state } = ctx;
    const m = M.of(ctx);
    const s = U.statsOf(ctx, div);
    const t = trait(ctx, div);
    const G = rules.generals;
    let tAtk = rules.terrain[m.terrain[prov]].attack;
    const tRaw = tAtk;
    if (t && G[t].terrain) tAtk = 1000 - F.mul(1000 - tAtk, G[t].terrain);
    const base = U.attackVs(rules, s, defCounts, shellF);
    if (rec) rec.push(['base', base], ['strength', div.str], ['terrain', tAtk, tRaw], ['weather', rules.weather[state.prov.weather[prov]].attack]);
    let a = F.mul(base, div.str);
    a = F.mul(a, tAtk);
    a = F.mul(a, rules.weather[state.prov.weather[prov]].attack);
    if (m.river[div.prov].includes(prov)) {
      const r = Math.min(1000, rules.combat.river + Math.min(rules.combat.riverCap, s.river));
      if (rec) rec.push(['river', r]);
      a = F.mul(a, r);
    }
    if (m.sea[div.prov]) {
      const l = m.port[prov] ? rules.naval.landPort : rules.naval.landBeach;
      if (rec) rec.push(['landing', l]);
      a = F.mul(a, l);
    }
    a = F.mul(a, S.factor(rules, div.sup));
    if (rec) rec.push(['supply', S.factor(rules, div.sup)]);
    if (t && G[t].attack) { a = F.mul(a, G[t].attack); if (rec) rec.push(['general', G[t].attack]); }
    if (rec) rec.push(['readiness', M.ready(state, div.nation)]);
    return F.mul(a, M.ready(state, div.nation));
  }

  function defencePower(ctx, div, prov, siege, rec = null) {
    const { rules } = ctx;
    const m = M.of(ctx);
    const s = U.statsOf(ctx, div);
    const t = trait(ctx, div);
    const works = 1000 + Math.trunc((rules.combat.dig * Math.max(0, div.dig - siege)) / 100);
    if (rec) rec.push(['base', s.defence], ['strength', div.str], ['terrain', rules.terrain[m.terrain[prov]].defence], ['works', works, 1000 + Math.trunc((rules.combat.dig * Math.max(0, div.dig)) / 100)]);
    let d = F.mul(s.defence, div.str);
    d = F.mul(d, rules.terrain[m.terrain[prov]].defence);
    d = F.mul(d, works);
    d = F.mul(d, S.factor(rules, div.sup));
    if (rec) rec.push(['supply', S.factor(rules, div.sup)]);
    if (t && rules.generals[t].defence) { d = F.mul(d, rules.generals[t].defence); if (rec) rec.push(['general', rules.generals[t].defence]); }
    if (rec) rec.push(['readiness', M.ready(ctx.state, div.nation)]);
    return F.mul(d, M.ready(ctx.state, div.nation));
  }

  // What each battle's last hour was fought with, for queries.js `battle`: kept beside the state (not in it, so the
  // hash and a save do not see it) and lost on load until the battle's next hour. Battle -> { hour, dirs, width, siege,
  // flank, defCounts, att: [{ id, nation, tpl, army, prov, str, sup, shellF }], def: [{ ..., dig }], waiting, outside }.
  const lastHours = new WeakMap();
  const lastHour = (b) => lastHours.get(b) || null;

  const orgLoss = (ctx, div) => Math.max(1, Math.trunc((ctx.rules.combat.orgHit * ctx.rules.combat.orgRef) / U.statsOf(ctx, div).org));

  function fire(ctx, d) {
    const need = U.statsOf(ctx, d).shells;
    if (need <= 0) return 1000;
    const stock = ctx.state.nations[d.nation].stock;
    const paid = Math.min(need, Math.max(0, stock.shells | 0));
    stock.shells -= paid;
    const no = ctx.rules.combat.noShells;
    return no + Math.trunc(((1000 - no) * paid) / need);
  }

  // How many divisions of each side a battle takes: combat.width, and combat.widthFlank more for each direction the
  // attack comes from after the first.
  const width = (rules, dirs) => rules.combat.width + rules.combat.widthFlank * Math.max(0, dirs - 1);
  // The `w` of these division indexes with the most org (lowest index on a tie), in index order.
  function engaged(divs, list, w) {
    if (list.length <= w) return list;
    return list.slice().sort((x, y) => divs[y].org - divs[x].org || x - y).slice(0, w).sort((x, y) => x - y);
  }

  // The battle is over. Won against a line not dug in (movement.dugIn), the attackers still entering P are there
  // within PURSUIT hours, before the defender can bring a fresh division in by rail.
  function end(ctx, w, b, att) {
    const divs = ctx.state.divs;
    if (att.length && !MV.dugIn(ctx.state, b.prov)) for (const i of att) if (divs[i].to === b.prov && divs[i].eta > PURSUIT) divs[i].eta = PURSUIT;
    MV.log(ctx, { kind: 'battle', prov: b.prov, won: att.length ? 'att' : 'def', hours: b.hours });
    return false;
  }

  function fight(ctx, w, b, out) {
    const { state, rules } = ctx;
    const C = rules.combat;
    const divs = state.divs;
    let att = [];
    let def = [];
    const ctrl = state.prov.ctrl[b.prov];
    for (let i = w.toHead[b.prov]; i >= 0; i = w.toNext[i]) { const d = divs[i]; if (d.str > 0 && d.org > 0 && MV.joins(w.rel, d.nation, b.side, ctrl)) att.push(i); }
    for (let i = w.provHead[b.prov]; i >= 0; i = w.provNext[i]) { const d = divs[i]; if (d.str > 0 && d.org > 0 && M.hostile(w.rel, d.nation, b.side)) def.push(i); }
    let rest = [];
    if (att.length && def.length) {
      if (!b.line) b.line = [];
      let line = new Set(b.line);
      if (b.line.length < LINE) {
        const join = engaged(divs, def.filter((i) => !line.has(divs[i].id)), LINE - b.line.length);
        if (join.length) { b.line = b.line.concat(join.map((i) => divs[i].id)).sort((x, y) => x - y); line = new Set(b.line); }
      }
      rest = def.filter((i) => !line.has(divs[i].id));
      def = def.filter((i) => line.has(divs[i].id));
      if (!def.length) { for (const i of rest) MV.retreat(ctx, w, divs[i]); out.divs = true; }
    }
    if (!att.length || !def.length) return end(ctx, w, b, att);
    const dirs = [];
    for (const i of att) if (!dirs.includes(divs[i].prov)) dirs.push(divs[i].prov);
    const fullAtt = att;
    const fullDef = def;
    att = engaged(divs, fullAtt, width(rules, dirs.length));
    def = engaged(divs, fullDef, width(rules, dirs.length));
    const nb = U.table(rules).nb;
    const defCounts = new Int32Array(nb);
    for (const i of def) { const c = U.statsOf(ctx, divs[i]).counts; for (let k = 0; k < nb; k++) defCounts[k] += c[k]; }
    for (let k = 0; k < nb; k++) defCounts[k] = Math.trunc(defCounts[k] / def.length);
    let siege = 0;
    const from = [];
    let A = 0;
    const seen = { hour: state.hour, dirs: dirs.slice(), width: width(rules, dirs.length), siege: 0, flank: 0, defCounts, att: [], def: [],
      waiting: fullAtt.concat(fullDef).filter((i) => !att.includes(i) && !def.includes(i)).map((i) => divs[i].id), outside: rest.map((i) => divs[i].id) };
    for (const i of att) {
      const d = divs[i];
      siege += U.statsOf(ctx, d).siege;
      if (!from.includes(d.prov)) from.push(d.prov);
      const shellF = fire(ctx, d);
      seen.att.push({ id: d.id, nation: d.nation, tpl: d.tpl, army: d.army, prov: d.prov, str: d.str, sup: d.sup, shellF });
      A += attackPower(ctx, d, b.prov, defCounts, shellF);
    }
    from.sort((x, y) => x - y);
    seen.flank = 1000 + C.flank * (from.length - 1);
    A = F.mul(A, seen.flank);
    let D = 0;
    siege = Math.trunc(siege / att.length);
    seen.siege = siege;
    for (const i of def) {
      const d = divs[i];
      seen.def.push({ id: d.id, nation: d.nation, tpl: d.tpl, army: d.army, prov: d.prov, str: d.str, sup: d.sup, dig: d.dig });
      D += defencePower(ctx, d, b.prov, siege);
    }
    lastHours.set(b, seen);
    const p = A + D > 0 ? Math.trunc((A * 1000) / (A + D)) : 0;
    const attWins = R.int(state.rng, 1000) < p;
    const losers = attWins ? def : att;
    const winners = attWins ? att : def;
    for (const i of winners) { U.lose(ctx, divs[i], C.strWinner); w.fought[i] = 1; }
    for (const i of losers) {
      const d = divs[i];
      w.fought[i] = 1;
      U.lose(ctx, d, C.strLoser);
      d.org = Math.max(0, d.org - orgLoss(ctx, d));
      if (d.org > 0 || d.str <= 0) continue;
      if (attWins) MV.retreat(ctx, w, d);
      else MV.halt(ctx, w.rel, d);
    }
    b.hours += 1;
    b.odds = p;
    b.from = from;
    b.att = att.map((i) => divs[i].id);
    b.def = def.map((i) => divs[i].id);
    out.divs = true;
    const alive = (list) => list.some((i) => divs[i].str > 0 && divs[i].org > 0 && (list === fullDef ? divs[i].prov === b.prov : divs[i].to === b.prov));
    if (alive(fullAtt) && alive(fullDef)) return true;
    if (!alive(fullAtt)) return end(ctx, w, b, []);
    for (const i of rest) if (divs[i].prov === b.prov) MV.retreat(ctx, w, divs[i]);
    return end(ctx, w, b, fullAtt.filter((i) => divs[i].str > 0 && divs[i].org > 0));
  }

  function hour(ctx, w, out) {
    const { state } = ctx;
    if (!state.battles.length) return;
    w.index();
    const keep = [];
    for (const b of state.battles) {
      if (fight(ctx, w, b, out)) keep.push(b);
      else out.battles = true;
    }
    if (keep.length !== state.battles.length) {
      state.battles = keep;
      w.battleAt.fill(0);
      keep.forEach((b, i) => { w.battleAt[b.prov] = i + 1; });
    }
  }

  return { hour, attackPower, defencePower, orgLoss, trait, fire, width, engaged, lastHour, LINE };
});
