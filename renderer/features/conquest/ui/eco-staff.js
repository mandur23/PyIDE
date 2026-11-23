// The staff plans the player's fronts (plan 3.4): Conquest.ui.staff = { assign(armyIds, { force }), replanAll(),
// check(), follow(), isStaff(id), isReserve(id), isHand(id), enabled }. assign asks the worker's suggestFronts query (the
// operations AI's contact line and threat split, sim/queries.js) and gives each army its suggestion with an ordinary
// `front` order, then says so in a 'staff' alert ("The staff assigned 5 armies to the border with Germany"). With the
// conquest.staffFronts setting on (the default), check() runs when the game loads, when time starts, each game day and
// when a war involving the player begins: while the player is at war, every army with no front that the player has not
// planned by hand gets one, and each game day the staff's own armies are planned again, so their fronts follow the
// contact line as it moves (a front given once stood still while the enemy came round it); only an army's first
// front raises the alert. A front the player draws (any `front` order not sent from here) marks that army as the
// player's, and neither check() nor Replan All Fronts changes it again; Staff Front on that army (force) hands it back.
// Offensives are never touched. Which armies are the staff's lives in the game's meta (game.meta.staff = { auto,
// reserve, hand }: army ids), so it is saved with the game.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const log = ide.logger('#conquest');
  const game = Conquest.game;
  const shell = ui.shell;

  const mine = new WeakSet();
  let busy = null;

  const book = () => {
    if (!game.meta) game.meta = {};
    const s = game.meta.staff || (game.meta.staff = { auto: [], reserve: [], hand: [] });
    for (const k of ['auto', 'reserve', 'hand']) if (!Array.isArray(s[k])) s[k] = [];
    return s;
  };
  const drop = (list, id) => { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); };
  const add = (list, id) => { if (!list.includes(id)) list.push(id); };
  const enabled = () => ide.settings.get('conquest.staffFronts', true) !== false;
  const atWar = () => game.nations.some((n) => n.war && n.alive);
  const armies = () => game.me?.armies || [];

  async function assign(ids, { force = false, quiet = null } = {}) {
    if (!game.running) return [];
    if (busy) await busy;
    const s = book();
    const want = ids.filter((id) => armies().some((a) => a.id === id) && (force || !s.hand.includes(id)));
    if (!want.length) return [];
    let done;
    busy = new Promise((r) => { done = r; });
    try {
      let plan;
      try { plan = await game.query('suggestFronts', { armies: want }); } catch (err) { log.warn(`the staff could not plan: ${err.message}`); return []; }
      const given = [];
      for (const p of plan) {
        const a = armies().find((x) => x.id === p.army);
        if (!a || !p.provinces.length) continue;
        const same = a.front && a.front.length === p.provinces.length && a.front.every((x, i) => x === p.provinces[i]);
        if (!same) {
          const order = { type: 'front', army: a.id, provinces: p.provinces };
          mine.add(order);
          const r = await game.order(order);
          if (!r.ok) continue;
        }
        drop(s.hand, a.id);
        add(s.auto, a.id);
        if (p.kind === 'reserve') add(s.reserve, a.id); else drop(s.reserve, a.id);
        if (!same) given.push(p);
      }
      const news = quiet ? given.filter((p) => !quiet.has(p.army)) : given;
      if (news.length) tell(news);
      ui.command?.renderArmies();
      ui.events.emit('staffed', { armies: want, force });
      return given;
    } finally {
      busy = null;
      done();
    }
  }

  // One alert per enemy border, one for the reserve.
  function tell(given) {
    const byFoe = new Map();
    let reserve = 0;
    let at = 0;
    for (const p of given) {
      if (p.kind === 'reserve') { reserve++; continue; }
      const foe = p.against.length ? p.against[0] : -1;
      byFoe.set(foe, (byFoe.get(foe) || 0) + 1);
      at = at || p.provinces[0];
    }
    for (const [foe, n] of byFoe) {
      const nation = game.nationName(foe);
      const text = foe < 0 ? (n === 1 ? tr('The staff assigned an army to the front') : tr('The staff assigned {n} armies to the front', { n }))
        : n === 1 ? tr('The staff assigned an army to the border with {nation}', { nation }) : tr('The staff assigned {n} armies to the border with {nation}', { n, nation });
      shell.alert('staff', text, at, `staff-${foe}`);
    }
    if (reserve) {
      const cap = game.scenario.nations[game.player]?.capital || 0;
      const capital = game.map.provinces[cap]?.name || '?';
      shell.alert('staff', reserve === 1 ? tr('The staff holds an army in reserve near {capital}', { capital }) : tr('The staff holds {n} armies in reserve near {capital}', { n: reserve, capital }), cap, 'staff-reserve');
    }
  }

  function check() {
    if (!game.running || !enabled() || !atWar()) return Promise.resolve([]);
    const s = book();
    const ids = armies().filter((a) => !a.front && !s.hand.includes(a.id)).map((a) => a.id);
    return ids.length ? assign(ids) : Promise.resolve([]);
  }

  // The daily pass: armies with no front get one (with the alert), the staff's own are planned again without one.
  function follow() {
    if (!game.running || !enabled() || !atWar() || busy) return Promise.resolve([]);
    const s = book();
    const ids = armies().filter((a) => !s.hand.includes(a.id) && (!a.front || s.auto.includes(a.id))).map((a) => a.id);
    const had = new Set(armies().filter((a) => a.front && s.auto.includes(a.id)).map((a) => a.id));
    return ids.length ? assign(ids, { quiet: had }) : Promise.resolve([]);
  }

  function replanAll() {
    const s = book();
    return assign(armies().filter((a) => !s.hand.includes(a.id)).map((a) => a.id));
  }

  game.on('ordered', ({ order, result }) => {
    if (!result.ok || order?.type !== 'front' || mine.has(order)) return;
    const s = book();
    add(s.hand, order.army);
    drop(s.auto, order.army);
    drop(s.reserve, order.army);
  });
  game.on('speed', (n) => { if (n > 0) check(); });
  game.on('day', () => {
    const s = book();
    const alive = new Set(armies().map((a) => a.id));
    for (const k of ['auto', 'reserve', 'hand']) s[k] = s[k].filter((id) => alive.has(id));
    follow();
  });
  game.on('event', (e) => { if (e.kind === 'war' && (e.a === game.player || e.b === game.player)) check(); });
  ui.events.on('game', () => { book(); check(); });

  ui.staff = {
    assign, replanAll, check, follow,
    isStaff: (id) => book().auto.includes(id),
    isReserve: (id) => book().reserve.includes(id),
    isHand: (id) => book().hand.includes(id),
    get enabled() { return enabled(); },
    get busy() { return !!busy; },
  };
})();
