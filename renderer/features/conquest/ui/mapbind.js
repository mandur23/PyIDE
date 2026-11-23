// The map driven by the live game: Conquest.ui.mapbind(view, game, stage) -> { counterAt(sx, sy), setPreview(p),
// setExtraArrows(list), setTooltipExtra(text), refresh(), groups, warPairs, armyPairs, destroy() }. It colours provinces
// from the mirror (political by controller with occupied land tinted toward its owner; supply, weather and diplomacy
// from the daily arrays and the player's relations), tints sea zones by who controls them, writes the nations' names
// (game.nationName), draws the division counters grouped per province and side (own, allied, enemy, neutral; strength
// and organisation bars from the stack's means; the selected army's and divisions' frames in yellow; stacks of one
// nation and side merge when zoomed out, units.js), a battle marker at every battle (the player's side's hourly odds
// where its camp fights, as attacker or defender; neutral grey otherwise), the war front, the fronts and offensives of
// the player's armies (a planned offensive dashed, a launched one solid), and a hover tooltip (the province, or the
// battle marker or counter under the pointer, found on pointer moves at most every HIT_MS). It does its work on the
// game's coalesced 'tick' (at most once a frame) and redraws only what that tick changed; the border pairs are
// recomputed at most once per BORDER_MS.
// War front: warPairs = [[a, b]] with a land province its camp (own or allied) controls and b a land neighbour an enemy
// controls, drawn along their real edge (view.setBorderLines). An army's front (me.armies[].front) is drawn on the
// same edges: armyPairs = Map<army id, [[a, b]]>, the pairs whose a is in its front; in the army's colour
// (ui.armyColor, also the swatch in the army bar), the selected army's wider and on top; a front with no such edge
// (no enemy across it) falls back to the dashed line through its anchors. setPreview({ fronts, arrows, pairs }) draws a
// plan being drawn: pairs on the same edges, white and above the rest (its line has preview: true). counterAt answers
// a merged counter's largest stack and, in all, every stack it holds (the command screen selects them all).
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;

  const AMBER = '#f0b44c';
  const AMBER_DIM = '#b8955a';
  const RING = { own: '#f4f1e8', ally: '#7fb2ff', enemy: '#ff5a4a', neutral: '#3a3a3a', selected: '#ffd84a' };
  const SIDES = ['own', 'ally', 'enemy', 'neutral'];
  const WEATHER_COLORS = { clear: '#cdd6ae', rain: '#7fa3c4', mud: '#8c7050', snow: '#eef1f4', frost: '#a8c4dc' };
  const DIPLO = { self: AMBER, ally: '#5b8fd9', war: '#d0504a', access: '#7ab48c', neutral: '#a39f95', none: '#6f6c66' };
  const NEUTRAL = '#a39f95';
  const WAR_FRONT = '#d84a3a';
  const ARMY_COLORS = ['#f0b44c', '#5ec4d6', '#c792e0', '#93d36b', '#f08aa8', '#e9df6f', '#7ea8f2', '#f2a272'];
  const BORDER_MS = 250;
  ui.armyColor = (id) => ARMY_COLORS[((id | 0) % ARMY_COLORS.length + ARMY_COLORS.length) % ARMY_COLORS.length];

  // Supply 0 (cut off) red, rules.supply.low yellow, the capital's level green.
  function supplyColor(v, low, top) {
    const t = v <= 0 ? 0 : v < low ? 0.5 * v / low : 0.5 + 0.5 * Math.min(1, (v - low) / Math.max(1, top - low));
    const a = t < 0.5 ? [196, 64, 52] : [214, 186, 70];
    const b = t < 0.5 ? [214, 186, 70] : [86, 168, 92];
    const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    return `#${a.map((x, i) => Math.round(x + (b[i] - x) * k).toString(16).padStart(2, '0')).join('')}`;
  }

  // Per nation its home provinces for the map's names: its cores, or what it owns at the start when the scenario lists none.
  ui.homesOf = (scenario) => scenario.nations.map((n) => scenario.cores?.[n.tag] || scenario.owner?.[n.tag] || []);
  ui.sideOf = (game, nation) => {
    if (nation === game.player) return 'own';
    const n = game.nations[nation];
    if (!n) return 'neutral';
    return n.war ? 'enemy' : n.ally ? 'ally' : 'neutral';
  };

  ui.mapbind = (view, game, stage) => {
    const { map } = game;
    const N = map.provinces.length;
    const colors = game.scenario.nations.map((n) => n.color);
    let groups = [];
    let preview = { fronts: [], arrows: [], pairs: [] };
    let extra = [];
    let tipExtra = '';
    let warPairs = [];
    let armyPairs = new Map();
    let borderTimer = 0;
    const offs = [];

    const relColor = (c) => {
      if (c < 0) return DIPLO.none;
      if (c === game.player) return DIPLO.self;
      const n = game.nations[c];
      return !n ? DIPLO.neutral : n.war ? DIPLO.war : n.ally ? DIPLO.ally : n.access ? DIPLO.access : DIPLO.neutral;
    };
    const supplyRules = game.rules.supply || {};
    view.setModeColor('supply', (p, id) => {
      const c = game.prov.ctrl[id];
      if (c !== game.player && !(c >= 0 && game.nations[c]?.ally)) return NEUTRAL;
      return supplyColor(game.supply[id], supplyRules.low || 500, supplyRules.capital || 4000);
    });
    view.setModeColor('weather', (p, id) => WEATHER_COLORS[game.rules.weather[game.weather[id]]?.id] || NEUTRAL);
    view.setModeColor('diplomacy', (p, id) => relColor(game.prov.ctrl[id]));
    view.setSeaColor((id) => {
      const c = game.sea?.[id] ?? -1;
      if (c === -1) return null;
      if (c === -2) return ['#a070c0', 0.3];
      const side = ui.sideOf(game, c);
      return side === 'own' ? [AMBER, 0.32] : side === 'ally' ? ['#5b8fd9', 0.3] : side === 'enemy' ? ['#d0504a', 0.32] : ['#8a8a8a', 0.18];
    });
    view.setOwners(game.prov.owner, colors, game.prov.ctrl);
    view.setNames(game.scenario.nations.map((_, i) => game.nationName(i)), game.scenario.nations.map((n) => n.capital), ui.homesOf(game.scenario));

    function selectedSets() {
      const sel = game.selection;
      const divs = new Set(sel.divisions || []);
      return { army: sel.army, divs };
    }

    function rebuildCounters() {
      const byKey = new Map();
      const { army, divs } = selectedSets();
      for (const d of game.divs.values()) {
        const side = ui.sideOf(game, d.nation);
        const key = d.prov * 4 + SIDES.indexOf(side);
        let g = byKey.get(key);
        if (!g) { g = { prov: d.prov, side, divs: [], nations: new Map(), str: 0, org: 0, selected: false, own: side === 'own' }; byKey.set(key, g); }
        g.divs.push(d.id);
        g.nations.set(d.nation, (g.nations.get(d.nation) || 0) + 1);
        g.str += d.str;
        g.org += d.org;
        if ((army !== null && d.army === army && d.nation === game.player) || divs.has(d.id)) g.selected = true;
      }
      const perProv = new Map();
      for (const g of byKey.values()) {
        let best = -1;
        let most = 0;
        for (const [n, c] of g.nations) if (c > most) { most = c; best = n; }
        g.nation = best;
        if (!perProv.has(g.prov)) perProv.set(g.prov, []);
        perProv.get(g.prov).push(g);
      }
      const step = Conquest.view.COUNTER.W + 2 * Conquest.view.COUNTER.PAD + 2;
      for (const list of perProv.values()) {
        list.sort((a, b) => SIDES.indexOf(a.side) - SIDES.indexOf(b.side));
        list.forEach((g, i) => { g.dx = (i - (list.length - 1) / 2) * step; g.dy = 0; });
      }
      groups = [...byKey.values()];
      view.setUnits(groups.map((g) => ({ prov: g.prov, nation: g.nation, count: g.divs.length, color: colors[g.nation] || '#888888',
        ring: g.selected ? RING.selected : RING[g.side], str: g.str / g.divs.length / 1000, org: g.org / g.divs.length / 1000,
        key: `${g.side}:${g.nation}`, selected: g.selected, dx: g.dx, dy: g.dy })));
    }

    const camp = (c) => c >= 0 && (c === game.player || !!game.nations[c]?.ally);
    const hostile = (c) => c >= 0 && c !== game.player && !!game.nations[c]?.war;
    function rebuildPairs() {
      borderTimer = 0;
      const P = map.provinces;
      const ctrl = game.prov.ctrl;
      warPairs = [];
      for (let a = 1; a < N; a++) {
        if (P[a].sea || !camp(ctrl[a])) continue;
        for (const b of P[a].adj) if (!P[b].sea && hostile(ctrl[b])) warPairs.push([a, b]);
      }
      armyPairs = new Map();
      for (const army of game.me?.armies || []) {
        const pairs = [];
        for (const a of army.front || []) {
          if (!P[a] || P[a].sea || !camp(ctrl[a])) continue;
          for (const b of P[a].adj) if (!P[b].sea && hostile(ctrl[b])) pairs.push([a, b]);
        }
        armyPairs.set(army.id, pairs);
      }
      rebuildBorders();
    }
    function rebuildBorders() {
      const sel = game.selection.army;
      const lines = warPairs.length ? [{ pairs: warPairs, color: WAR_FRONT, width: 0.8 }] : [];
      const armies = [...armyPairs].filter(([, pairs]) => pairs.length).sort((x, y) => (x[0] === sel) - (y[0] === sel) || x[0] - y[0]);
      for (const [id, pairs] of armies) lines.push({ pairs, color: ui.armyColor(id), width: id === sel ? 1.7 : 1, army: id });
      if (preview.pairs.length) lines.push({ pairs: preview.pairs, color: '#ffffff', width: 1.9, preview: true });
      view.setBorderLines(lines);
    }
    const schedulePairs = () => { if (!borderTimer) borderTimer = setTimeout(rebuildPairs, BORDER_MS); };

    function rebuildLines() {
      const fronts = [];
      const arrows = [];
      const sel = game.selection.army;
      for (const a of game.me?.armies || []) {
        const on = a.id === sel;
        if (a.front && a.front.length >= 2 && !armyPairs.get(a.id)?.length) fronts.push({ provinces: a.front, color: ui.armyColor(a.id), width: on ? 1.4 : 1 });
        for (const o of a.offensives || []) {
          if (!o.path || o.path.length < 1) continue;
          const path = o.path.length >= 2 ? o.path : startOf(a, o.path);
          if (path.length < 2) continue;
          arrows.push({ path, color: on ? AMBER : AMBER_DIM, dashed: !o.on, width: on ? 1 : 0.75 });
        }
      }
      view.setFronts(fronts.concat(preview.fronts));
      view.setArrows(arrows.concat(extra, preview.arrows));
    }
    // A one-province offensive is drawn from the army's nearest division.
    function startOf(a, path) {
      const target = map.provinces[path[0]];
      let best = null;
      let bd = Infinity;
      for (const id of a.divs) {
        const d = game.divs.get(id);
        const p = d && map.provinces[d.prov];
        if (!p) continue;
        const dist = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
        if (dist < bd) { bd = dist; best = d.prov; }
      }
      return best && best !== path[0] ? [best, path[0]] : path;
    }

    function rebuildMarkers() {
      const out = [];
      for (const b of game.battles) {
        const odds = Math.max(0, Math.min(1000, b.odds | 0));
        const attacking = camp(b.side);
        const defending = camp(game.prov.ctrl[b.prov]);
        if (attacking === defending) out.push({ prov: b.prov, odds, mine: false });
        else out.push({ prov: b.prov, odds: attacking ? odds : 1000 - odds, mine: true });
      }
      view.setMarkers(out);
    }

    const tip = el('div', 'cq-tip');
    tip.hidden = true;
    stage.append(tip);
    // What is under the pointer besides the province: a battle marker, else a counter (hover only, HIT_MS apart).
    const HIT_MS = 60;
    let hit = null;
    let hitAt = -Infinity;
    let hitTimer = 0;
    function hitTest(e) {
      hitAt = performance.now();
      if (e.sx == null) return null;
      const m = view.markerAt(e.sx, e.sy);
      if (m) return { marker: m };
      const c = api.counterAt(e.sx, e.sy);
      return c ? { counter: c } : null;
    }
    function hoverLines(h) {
      if (h.marker) {
        const b = game.battles.find((x) => x.prov === h.marker.prov);
        if (!b) return null;
        const P = map.provinces[b.prov];
        return { kind: 'battle', data: { prov: b.prov, odds: b.odds }, lines: [tr('Battle for {province}', { province: P.name }),
          tr('{att} attacks {def}: {odds} an hour for the attackers', { att: game.nationName(b.side), def: game.nationName(game.prov.ctrl[b.prov]), odds: ui.text.percent(b.odds) }),
          tr('{h} hours fought', { h: b.hours }), tr('Click for details')] };
      }
      const list = h.counter.all;
      const ids = list.flatMap((g) => g.divs);
      let str = 0;
      let org = 0;
      const armies = new Set();
      for (const id of ids) { const d = game.divs.get(id); if (d) { str += d.str; org += d.org; if (d.army !== null && d.army !== undefined) armies.add(d.army); } }
      const n = ids.length || 1;
      const provs = new Set(list.map((g) => g.prov)).size;
      const g = list[0];
      const own = g.side === 'own';
      const names = own ? [...armies].map((a) => game.me?.armies.find((x) => x.id === a)?.name).filter(Boolean) : [];
      const lines = [tr('{nation}: {n} divisions', { nation: game.nationName(g.nation), n: ids.length }),
        tr('Mean strength {str}, organisation {org}', { str: ui.text.percent(str / n), org: ui.text.percent(org / n) }),
        own ? (names.length ? tr('Army: {names}', { names: names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '') }) : tr('In no army'))
          : armies.size ? tr('In {n} armies', { n: armies.size }) : tr('In no army')];
      if (list.length > 1) lines.push(tr('Merged counter: {n} stacks in {p} provinces; zoom in to see each', { n: list.length, p: provs }));
      return { kind: 'counter', data: { count: ids.length, str: Math.round(str / n), org: Math.round(org / n), merged: list.length, provinces: provs, nation: g.nation }, lines };
    }
    function showTip(e) {
      const { id, sx, sy } = e;
      const over = hit && sx != null ? hoverLines(hit) : null;
      if (over) {
        tip.replaceChildren(...over.lines.map((t, i) => el('div', i === 0 ? 'cq-tip-title' : 'cq-tip-line', t)));
        tip.dataset.kind = over.kind;
        for (const [k, v] of Object.entries(over.data)) tip.dataset[k] = String(v);
        return placeTip(sx, sy);
      }
      const p = id > 0 ? map.provinces[id] : null;
      if (!p || sx == null) { tip.hidden = true; return; }
      for (const k of Object.keys(tip.dataset)) delete tip.dataset[k];
      tip.dataset.kind = 'province';
      const lines = [p.name];
      if (!p.sea) {
        const o = game.prov.owner[id];
        const c = game.prov.ctrl[id];
        lines.push(o === c || c < 0 ? tr('Owner: {nation}', { nation: game.nationName(o) || tr('None') }) : tr('Held by {ctrl} (owner {owner})', { ctrl: game.nationName(c), owner: game.nationName(o) }));
        lines.push(`${ui.text.terrain(p.terrain)} · ${ui.text.weather(game.rules.weather[game.weather[id]]?.id)}`);
        lines.push(tr('Supply {n}', { n: game.supply[id] }));
      } else {
        const c = game.sea[id];
        lines.push(c >= 0 ? tr('Sea control: {nation}', { nation: game.nationName(c) }) : c === -2 ? tr('Sea control: contested') : tr('Sea control: nobody'));
      }
      if (tipExtra) lines.push(tipExtra);
      tip.replaceChildren(...lines.map((t, i) => el('div', i === 0 ? 'cq-tip-title' : 'cq-tip-line', t)));
      tip.firstChild.dataset.userText = '';
      placeTip(sx, sy);
    }
    function placeTip(sx, sy) {
      tip.hidden = false;
      const w = stage.clientWidth;
      const x = Math.min(sx + 16, w - tip.offsetWidth - 6);
      const y = Math.min(sy + 18, stage.clientHeight - tip.offsetHeight - 6);
      tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    }
    let lastHover = null;
    offs.push(view.on('hover', (e) => {
      lastHover = e;
      clearTimeout(hitTimer);
      const wait = HIT_MS - (performance.now() - hitAt);
      if (wait <= 0 || e.sx == null) hit = hitTest(e);
      else hitTimer = setTimeout(() => { if (lastHover === e) { hit = hitTest(e); showTip(e); } }, wait);
      showTip(e);
    }));

    function onTick(d) {
      if (d.provinces.size) {
        view.setOwners(game.prov.owner, colors, game.prov.ctrl);
        if (view.mode === 'diplomacy' || view.mode === 'supply') view.recolor([...d.provinces]);
      }
      if (d.nations && view.mode === 'diplomacy') view.recolor(null);
      if (d.supply && (view.mode === 'supply' || view.mode === 'weather')) view.recolor(null);
      if (d.sea) {
        const zones = [];
        for (let z = 1; z < N; z++) if (map.provinces[z].sea) zones.push(z);
        view.recolor(zones);
      }
      if (d.divs || d.nations) rebuildCounters();
      if (d.battles || d.provinces.size || d.nations) rebuildMarkers();
      if (d.provinces.size || d.nations || d.me) schedulePairs();
      if (d.me || d.divs) rebuildLines();
      if (lastHover && !tip.hidden && hit && (d.divs || d.battles)) showTip(lastHover); else if (lastHover && !tip.hidden && (d.day || d.provinces.has(lastHover.id))) showTip(lastHover);
    }
    offs.push(game.on('tick', onTick));
    offs.push(game.on('select', () => { rebuildCounters(); rebuildLines(); rebuildBorders(); }));

    rebuildCounters();
    rebuildPairs();
    rebuildLines();
    rebuildMarkers();

    const api = {
      // The stack under a CSS point: a merged counter answers its largest stack, with merged = how many it holds.
      counterAt(sx, sy) {
        const { W, H, PAD } = Conquest.view.COUNTER;
        const cam = view.camera;
        let best = null;
        let bd = Infinity;
        for (const c of view.counters()) {
          const p = map.provinces[c.prov];
          const [x0, y0] = cam.toScreen(p.x + 0.5, p.y + 0.5);
          const dx = Math.abs(sx - (x0 + c.dx));
          const dy = Math.abs(sy - (y0 + c.dy));
          if (dx <= W / 2 + PAD && dy <= H / 2 + PAD && dx + dy < bd) { bd = dx + dy; best = c; }
        }
        const g = best && groups[best.lead];
        return g && { prov: g.prov, side: g.side, nation: g.nation, divs: g.divs.slice(), merged: best.members.length, all: best.members.map((j) => groups[j]).filter(Boolean) };
      },
      get warPairs() { return warPairs; },
      get armyPairs() { return armyPairs; },
      // { fronts: [{ provinces, color }], arrows: [{ path, color, dashed }], pairs: [[a, b]] } drawn over the armies' plans.
      setPreview(p) { const had = preview.pairs.length; preview = { fronts: p?.fronts || [], arrows: p?.arrows || [], pairs: p?.pairs || [] }; rebuildLines(); if (had || preview.pairs.length) rebuildBorders(); },
      setExtraArrows(list) { extra = list || []; rebuildLines(); },
      setTooltipExtra(text) { tipExtra = text || ''; if (lastHover) showTip(lastHover); },
      refresh() { view.setOwners(game.prov.owner, colors, game.prov.ctrl); view.recolor(null); rebuildCounters(); rebuildPairs(); rebuildLines(); rebuildMarkers(); },
      get groups() { return groups; },
      destroy() {
        for (const off of offs) off();
        if (borderTimer) clearTimeout(borderTimer);
        clearTimeout(hitTimer);
        tip.remove();
        for (const m of ['supply', 'weather', 'diplomacy']) view.setModeColor(m, null);
        view.setSeaColor(null);
        view.setUnits([]);
        view.setFronts([]);
        view.setArrows([]);
        view.setMarkers([]);
        view.setBorderLines([]);
      },
    };
    return api;
  };
})();
