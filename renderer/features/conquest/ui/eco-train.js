// Training divisions, shared by the production panel and the designer: Conquest.ui.train.form(root) -> { el,
// update(economy), setTemplate(id) } builds once a form (template, count, where they form: picked on the map with
// ui/eco-pick.js and the capital by default, the army they join) with the cost in manpower and each piece of equipment
// against what the nation has, the days it takes (rules.train.days), and Train, which sends { type: 'train', template,
// count, at }; a refusal shows its translated reason under the form. The simulation's train order has no army, so the
// divisions appear in no army; this file remembers what the player chose for each batch (game.meta.trainTo, saved with
// the game) and, once the batch has formed, gives its divisions to that army, or to a new army ({ type: 'army' })
// named "Reserve Army <n>", with `assign` orders.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const ui = (Conquest.ui = Conquest.ui || {});
  const tr = Conquest.ui.text.tr;
  const el = ide.util.el;
  const log = ide.logger('#conquest');
  const game = Conquest.game;
  const shell = ui.shell;

  const NEW = 'new';
  const forms = new Set();
  const trainTo = () => { if (!game.meta) game.meta = {}; return game.meta.trainTo || (game.meta.trainTo = {}); };
  const capital = () => game.scenario.nations[game.player]?.capital || 0;
  const held = (p) => game.prov.owner[p] === game.player && game.prov.ctrl[p] === game.player && !game.map.provinces[p].sea;

  function form(root) {
    const box = el('div', 'cq-train');
    const tpl = document.createElement('select');
    tpl.className = 'cq-select cq-train-template';
    const count = ui.eco.stepper({ value: 1, min: 1, max: game.rules.train.maxCount, cls: 'cq-train-count', onSet: (v) => { count.set(v); showCost(); } });
    const where = el('button', 'cq-btn cq-train-where');
    where.title = tr('Pick the province on the map where the divisions form');
    where.dataset.userText = '';
    const army = document.createElement('select');
    army.className = 'cq-select cq-train-army';
    const cost = el('div', 'cq-train-cost');
    const go = el('button', 'cq-btn primary cq-train-go', tr('Start Training'));
    const msg = el('div', 'cq-eco-msg cq-train-msg');
    const grid = el('div', 'cq-train-grid');
    const lab = (t, c) => { const l = el('label', 'cq-train-field'); l.append(el('span', 'cq-eco-label', t), c); return l; };
    grid.append(lab(tr('Division Template'), tpl), lab(tr('How Many'), count.el), lab(tr('Forms at'), where), lab(tr('Joins'), army));
    box.append(grid, cost, go, msg);
    root.append(box);
    const f = { el: box, at: 0, eco: null, seq: 0, stats: null };

    const setWhere = (p) => {
      f.at = p;
      where.textContent = p ? game.map.provinces[p].name : tr('Pick on the Map');
      where.dataset.province = String(p || 0);
    };
    where.onclick = async () => {
      const p = await ui.pick.start({
        title: tr('Pick where the divisions form: a province you own and hold.'),
        legal: (id) => (held(id) ? true : 'bad-province'),
        describe: () => tr('Divisions form here in {d} days', { d: game.rules.train.days }),
      });
      if (p) setWhere(p);
    };
    tpl.onchange = () => showCost();
    army.onchange = () => { f.armyPicked = true; };
    go.onclick = () => train();

    async function showCost() {
      const t = game.me?.templates.find((x) => x.id === tpl.value);
      const n = count.value;
      if (!t) { cost.replaceChildren(); go.disabled = true; return; }
      const seq = ++f.seq;
      let s;
      try { s = await ui.eco.statsOf(t); } catch { return; }
      if (seq !== f.seq) return;
      f.stats = s;
      const me = game.me;
      const rows = [];
      const line = (label, need, have) => {
        const r = el('div', `cq-cost-row ${need > have ? 'short' : ''}`);
        r.dataset.need = String(need);
        r.dataset.have = String(have);
        r.append(el('span', 'cq-eco-label', label), el('span', 'cq-eco-value', tr('{need} of {have}', { need: ui.text.number(need), have: ui.text.number(have) })));
        return r;
      };
      const mp = line(tr('Manpower'), s.manpower * n, me.manpower);
      mp.dataset.cost = 'manpower';
      rows.push(mp);
      game.rules.items.forEach((it, k) => {
        if (!s.equip[k]) return;
        const r = line(ui.text.item(it.id), s.equip[k] * n, me.stock[it.id] | 0);
        r.dataset.cost = it.id;
        rows.push(r);
      });
      rows.push(el('div', 'cq-cost-days', tr('Ready in {d} days', { d: game.rules.train.days })));
      cost.replaceChildren(...rows);
      // A short row is what the worker refuses (no-manpower, no-equipment): say so on the button instead.
      const short = rows.find((r) => r.classList?.contains('short'));
      go.disabled = !f.at || !!short;
      go.title = short ? ui.text.reason(short.dataset.cost === 'manpower' ? 'no-manpower' : 'no-equipment') : '';
    }

    async function train() {
      const t = tpl.value;
      const n = count.value;
      if (!t || !f.at) return;
      go.disabled = true;
      const minDiv = Math.max(0, ...game.divs.keys()) + 1;
      const r = await game.order({ type: 'train', template: t, count: n, at: f.at });
      go.disabled = false;
      msg.classList.toggle('bad', !r.ok);
      msg.textContent = r.ok ? tr('{n} divisions are training; they are ready in {d} days.', { n, d: game.rules.train.days }) : ui.text.reason(r.reason);
      if (r.ok && r.id !== null && r.id !== undefined) trainTo()[r.id] = { army: army.value === NEW ? NEW : army.value ? Number(army.value) : null, tpl: t, at: f.at, count: n, minDiv };
      showCost();
    }

    f.update = (eco) => {
      f.eco = eco || f.eco;
      const keep = tpl.value;
      const tpls = game.me?.templates || [];
      tpl.replaceChildren(...tpls.map((t) => { const o = el('option', null, t.name); o.value = t.id; return o; }));
      if (tpls.some((t) => t.id === keep)) tpl.value = keep;
      const ka = army.value;
      const opts = [el('option', null, tr('New reserve army')), el('option', null, tr('No army'))];
      opts[0].value = NEW;
      opts[1].value = '';
      for (const a of game.me?.armies || []) { const o = el('option', null, a.name); o.value = String(a.id); opts.push(o); }
      army.replaceChildren(...opts);
      army.value = f.armyPicked && [...army.options].some((o) => o.value === ka) ? ka : NEW;
      if (!f.at || !held(f.at)) setWhere(held(capital()) ? capital() : 0);
      showCost();
    };
    f.setTemplate = (id) => { tpl.value = id; showCost(); };
    forms.add(f);
    return f;
  }

  // Batches that formed: their divisions join the army chosen for them.
  let placing = false;
  async function place() {
    if (placing || !game.running || !game.me) return;
    const want = trainTo();
    const waiting = new Set(game.me.training.map((t) => t.id));
    const done = Object.keys(want).filter((id) => !waiting.has(Number(id)));
    if (!done.length) return;
    placing = true;
    try {
      for (const id of done) {
        const b = want[id];
        delete want[id];
        if (!b.army && b.army !== 0) continue;
        const divs = [...game.divs.values()].filter((d) => d.nation === game.player && d.army === null && d.tpl === b.tpl && d.id >= b.minDiv).sort((x, y) => x.id - y.id).slice(0, b.count);
        if (!divs.length) continue;
        let target = b.army;
        if (target === NEW) {
          const n = (game.me.armies || []).length + 1;
          const r = await game.order({ type: 'army', name: tr('Reserve Army {n}', { n }), general: null });
          if (!r.ok) { log.warn(`no reserve army: ${r.reason}`); continue; }
          target = r.id;
        }
        for (const d of divs) await game.order({ type: 'assign', div: d.id, army: target });
        const a = game.me.armies.find((x) => x.id === target);
        shell.alert('staff', tr('{n} new divisions joined {army}', { n: divs.length, army: a?.name || '?' }), divs[0].prov, 'trained');
      }
    } finally { placing = false; }
    ui.staff?.check();
  }
  game.on('day', () => { place(); });

  ui.train = { form, place, get forms() { return [...forms]; } };
})();
